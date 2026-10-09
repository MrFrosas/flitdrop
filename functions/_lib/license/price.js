// Licences Flitdrop Pro : prix affiché, localisé pour le pays du visiteur.
// La page /pro ne charge Paddle.js qu'au clic sur « Débloquer » (EDPB, lignes
// directrices 2/2023 : aucun appel à un tiers à la simple visite). Le prix vient donc
// de NOTRE serveur, qui demande l'aperçu de prix de Paddle (POST /pricing-preview)
// avec le seul code pays (request.cf.country, donné par Cloudflare), sans rien du
// visiteur. Cache par pays dans la base D1 : 6 heures, 10 minutes après une erreur.
// Toute erreur (Paddle, base, forme inattendue) donne le prix de secours fixe.
import { DISPLAY_PRICE, formatPrice, fallbackPrice, countryOf, EARLY_PERCENT } from './config.js'
import { createPaddle } from './paddle.js'
import { openDb, bump, cachedPrice, storePrice } from './db.js'
import { nowSec } from './http.js'

const TTL_OK_SEC = 6 * 3600
const TTL_FAIL_SEC = 10 * 60
const PREVIEWS_PER_MINUTE = 20 // aperçus Paddle, tous isolats confondus

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Nos trois devises s'écrivent comme sur le reste du site (5,99 €) ; les autres
// gardent l'écriture de Paddle.
function display(currency, minor, formatted) {
  if (currency in DISPLAY_PRICE && Number.isInteger(minor) && minor >= 0) return formatPrice(currency, minor)
  if (typeof formatted === 'string' && formatted.length > 0 && formatted.length <= 24 && !/[<>&"]/.test(formatted)) return formatted
  return null
}

async function preview(paddle, cfg, country, discountId) {
  const body = { items: [{ price_id: cfg.priceId, quantity: 1 }], address: { country_code: country } }
  if (discountId) body.discount_id = discountId
  const data = await paddle.post('/pricing-preview', body)
  const d = isObj(data.data) ? data.data : null
  const line = d && isObj(d.details) && Array.isArray(d.details.line_items) ? d.details.line_items[0] : null
  const currency = d && typeof d.currency_code === 'string' && /^[A-Z]{3}$/.test(d.currency_code) ? d.currency_code : null
  const minorText = line && isObj(line.totals) ? line.totals.total : null
  const minor = typeof minorText === 'string' && /^\d{1,9}$/.test(minorText) ? Number(minorText) : null
  const shown = currency ? display(currency, minor, line && isObj(line.formatted_totals) ? line.formatted_totals.total : null) : null
  if (!shown) throw new Error('pricing_preview_shape')
  return { currency, minor, display: shown }
}

const fromRow = (row) => ({ currency: row.currency, display: row.display, displayEarly: row.display_early })

async function fetchPrice(cfg, country) {
  const paddle = createPaddle(cfg, { budgetMs: 3000, maxCalls: 3 })
  const normal = await preview(paddle, cfg, country, null)
  let early = null
  if (cfg.earlyDiscountId) {
    const e = await preview(paddle, cfg, country, cfg.earlyDiscountId)
    if (e.currency === normal.currency) early = e.display
  }
  // sans remise configurée : même calcul que le tableau fixe (50 %)
  if (!early) early = normal.minor !== null && normal.currency in DISPLAY_PRICE ? formatPrice(normal.currency, Math.floor((normal.minor * (100 - EARLY_PERCENT)) / 100)) : normal.display
  return { currency: normal.currency, display: normal.display, displayEarly: early }
}

// { currency, display, displayEarly } : jamais d'exception, jamais d'attente au-delà de 3 s.
export async function localizedPrice(cfg, request) {
  const country = countryOf(request)
  if (!cfg.enabled || !country) return fallbackPrice(country)
  try {
    const db = await openDb(cfg.db)
    const row = await cachedPrice(db, country)
    if (row && nowSec() - Number(row.fetched_at) < (row.ok ? TTL_OK_SEC : TTL_FAIL_SEC)) return fromRow(row)
    if (!(await bump(db, 'price:previews', PREVIEWS_PER_MINUTE, 60))) return row && row.ok ? fromRow(row) : fallbackPrice(country)
    let price
    let ok = true
    try {
      price = await fetchPrice(cfg, country)
    } catch (err) {
      console.error('license price: preview failed (' + (err && err.name ? err.name : 'Error') + ')')
      price = fallbackPrice(country)
      ok = false
    }
    await storePrice(db, country, { ...price, ok })
    return price
  } catch {
    return fallbackPrice(country)
  }
}
