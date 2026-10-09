// Licences Flitdrop Pro : client de l'API Paddle Billing (v1) et règles d'achat.
//
// Règle d'or : on ne donne JAMAIS une licence sur une erreur. Toute réponse
// inattendue de Paddle (réseau, 4xx, 5xx, 429, forme bizarre, liste tronquée là où
// il fallait tout voir) lève une PaddleError, que les points d'entrée transforment
// en 503 « retente plus tard ». La clé d'API ne sort jamais : ni dans les journaux,
// ni dans les réponses, et elle n'est envoyée qu'à l'hôte Paddle configuré.
//
// Où vivent les données (aucune base chez nous) :
//   - transaction.custom_data.claim : le « claim » aléatoire de l'app, posé par la page /pro
//   - customer.custom_data.flitdrop_devices : [{ d, t }] appareils autorisés (5 au plus),
//       d = 32 premiers hexadécimaux du SHA-256 de l'identifiant d'appareil, t = date (s)
//   - customer.custom_data.flitdrop_claims : { txn_id: [d, ...] } appareils débloqués par
//       chaque achat via son claim (5 au plus par achat)
// Les autres clés de custom_data sont toujours conservées.
import { state } from './state.js'
import { nowMs, nowSec } from './http.js'
import { customerHash } from './crypto.js'

export const MAX_DEVICES = 5
export const MAX_CLAIM_DEVICES = 5
export const CLAIM_WINDOW_MS = 48 * 3600 * 1000

const BUDGET_MS = 9000 // temps total accordé à Paddle pour une requête de l'app
const CALL_MS = 4000 // temps maximal d'un appel
const PAGES = { claimScan: 10, customerTxns: 5, adjustments: 4, customerScan: 40, emailLookup: 1 }

export class PaddleError extends Error {
  constructor(status, code) {
    super(`paddle ${status} ${code || ''}`.trim())
    this.name = 'PaddleError'
    this.status = status
    this.code = code || ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function retryAfterSeconds(header) {
  const n = Number(header)
  if (Number.isFinite(n) && n > 0) return Math.min(n, 300)
  const date = Date.parse(header || '')
  if (Number.isFinite(date)) return Math.min(Math.max(1, Math.ceil((date - nowMs()) / 1000)), 300)
  return 60 // la doc Paddle : 60 s de blocage après un 429
}

// Chaîne de requête : les crochets des opérateurs (created_at[GTE]) restent tels quels,
// comme dans les exemples de la doc ; chaque valeur est encodée, les listes sont
// séparées par des virgules.
export function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${(Array.isArray(v) ? v : [v]).map((x) => encodeURIComponent(String(x))).join(',')}`)
    .join('&')
}

// Date RFC 3339 sans millisecondes, en UTC.
export const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function createPaddle(cfg, { budgetMs = BUDGET_MS } = {}) {
  const deadline = nowMs() + budgetMs
  const base = cfg.apiBase

  async function call(method, pathOrUrl, body) {
    if (nowMs() < state.paddlePausedUntil) throw new PaddleError(429, 'paused')
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : base + pathOrUrl
    // la clé ne part que vers l'hôte Paddle configuré (le lien « next » vient de Paddle)
    if (!url.startsWith(base + '/')) throw new PaddleError(0, 'foreign_url')

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - nowMs()
      if (remaining < 300) throw new PaddleError(0, 'timeout')
      let res
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Paddle-Version': '1',
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(Math.min(CALL_MS, remaining)),
        })
      } catch {
        if (attempt === 0 && deadline - nowMs() > 1500) {
          await sleep(150)
          continue
        }
        throw new PaddleError(0, 'network')
      }

      if (res.status === 429) {
        // Paddle bloque l'adresse 60 s : réessayer ne ferait que prolonger le blocage.
        state.paddlePausedUntil = nowMs() + retryAfterSeconds(res.headers.get('retry-after')) * 1000
        throw new PaddleError(429, 'too_many_requests')
      }
      if (res.status >= 500) {
        if (attempt === 0 && deadline - nowMs() > 1500) {
          await sleep(150)
          continue
        }
        throw new PaddleError(res.status, 'server_error')
      }
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) throw new PaddleError(res.status, data && data.error && typeof data.error.code === 'string' ? data.error.code.slice(0, 60) : '')
      if (!data || typeof data !== 'object') throw new PaddleError(res.status, 'bad_json')
      return data
    }
    throw new PaddleError(0, 'retries')
  }

  // Liste paginée : suit meta.pagination.next tant que has_more est vrai.
  // stop(item) permet de s'arrêter dès qu'on a trouvé. complete = tout a été vu.
  async function list(pathWithQuery, maxPages, stop) {
    const items = []
    let url = base + pathWithQuery
    for (let page = 1; ; page++) {
      const data = await call('GET', url)
      if (!Array.isArray(data.data)) throw new PaddleError(200, 'bad_shape')
      for (const item of data.data) {
        items.push(item)
        if (stop && (await stop(item))) return { items, complete: true, found: item }
      }
      const p = data.meta && data.meta.pagination
      if (!p || p.has_more !== true) return { items, complete: true, found: null }
      if (page >= maxPages || typeof p.next !== 'string') return { items, complete: false, found: null }
      url = p.next
    }
  }

  return {
    get: (path) => call('GET', path),
    patch: (path, body) => call('PATCH', path, body),
    list,
  }
}

// --- achats ----------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// Ids Paddle : préfixe + minuscules et chiffres. Vérifiés avant de servir de chemin
// d'URL ou de clé dans custom_data (un id inattendu ne doit rien contourner).
const isCustomerId = (v) => typeof v === 'string' && /^ctm_[a-z0-9]+$/.test(v)
const isTxnId = (v) => typeof v === 'string' && /^txn_[a-z0-9]+$/.test(v)

// La transaction contient-elle le prix Pro ? (items[].price.id d'après la doc,
// details.line_items[].price_id en secours)
export function hasProPrice(txn, priceId) {
  const items = Array.isArray(txn?.items) ? txn.items : []
  if (items.some((it) => isObj(it) && ((isObj(it.price) && it.price.id === priceId) || it.price_id === priceId))) return true
  const lines = Array.isArray(txn?.details?.line_items) ? txn.details.line_items : []
  return lines.some((l) => isObj(l) && l.price_id === priceId)
}

const toInt = (v) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

// Achat annulé ? Rétrofacturation (chargeback) non annulée par Paddle, ou
// remboursement approuvé qui couvre l'article Pro ou le montant total.
// Un remboursement en attente d'approbation ne retire rien (il peut être refusé).
export function transactionRevoked(txn, adjustments, priceId) {
  const mine = adjustments.filter((a) => isObj(a) && a.transaction_id === txn.id)
  if (mine.some((a) => a.action === 'chargeback' && a.status !== 'reversed' && a.status !== 'rejected')) return true

  const refunds = mine.filter((a) => a.action === 'refund' && a.status === 'approved')
  if (refunds.length === 0) return false
  const lines = Array.isArray(txn?.details?.line_items) ? txn.details.line_items : []
  const proItemIds = new Set(lines.filter((l) => isObj(l) && l.price_id === priceId && l.id).map((l) => l.id))
  for (const a of refunds) {
    if (a.type === 'full') return true
    const items = Array.isArray(a.items) ? a.items : []
    // article inconnu : on retire quand même (en cas de doute, on ne donne pas)
    if (items.some((i) => isObj(i) && i.type === 'full' && (proItemIds.size === 0 || proItemIds.has(i.item_id)))) return true
  }
  const total = toInt(txn?.details?.totals?.grand_total ?? txn?.details?.totals?.total)
  const refunded = refunds.reduce((sum, a) => sum + toInt(a?.totals?.total), 0)
  return total > 0 && refunded >= total
}

// Ajustements (remboursements, rétrofacturations) de ces transactions. Tous sont lus
// puis filtrés ici : on ne dépend pas d'un filtre « action » côté Paddle.
async function adjustmentsFor(paddle, txnIds) {
  const all = []
  for (let i = 0; i < txnIds.length; i += 20) {
    const ids = txnIds.slice(i, i + 20)
    const { items, complete } = await paddle.list(`/adjustments?${query({ transaction_id: ids, per_page: 50 })}`, PAGES.adjustments)
    // liste tronquée : impossible d'affirmer qu'il n'y a pas de remboursement
    if (!complete) throw new PaddleError(200, 'adjustments_truncated')
    all.push(...items)
  }
  return all
}

// Premier achat Pro valide parmi ces transactions, ou null.
async function firstValid(paddle, cfg, txns) {
  if (txns.length === 0) return null
  const adjustments = await adjustmentsFor(
    paddle,
    txns.map((t) => t.id),
  )
  return txns.find((t) => !transactionRevoked(t, adjustments, cfg.priceId)) || null
}

const isCompletedPro = (t, cfg) =>
  isObj(t) && t.status === 'completed' && isTxnId(t.id) && isCustomerId(t.customer_id) && hasProPrice(t, cfg.priceId)

// Transactions terminées des 48 dernières heures. Le résultat est partagé 3 s dans
// l'isolat : l'app interroge toutes les 5 s pendant le paiement, inutile de
// solliciter Paddle pour chaque appareil en attente.
async function recentCompleted(paddle, cfg) {
  const key = cfg.apiBase + '|' + cfg.priceId
  const s = state.recentScan
  if (s && s.key === key && nowMs() - s.at < 3000) return s.promise
  const since = rfc3339(nowMs() - CLAIM_WINDOW_MS)
  const promise = paddle
    .list(`/transactions?${query({ status: 'completed', 'created_at[GTE]': since, per_page: 30 })}`, PAGES.claimScan)
    .then((r) => r.items)
  state.recentScan = { key, at: nowMs(), promise }
  promise.catch(() => {
    if (state.recentScan && state.recentScan.promise === promise) state.recentScan = null
  })
  return promise
}

// Achat Pro terminé, de moins de 48 h, porteur de ce claim et non remboursé.
export async function findClaimTransaction(paddle, cfg, claim) {
  const items = await recentCompleted(paddle, cfg)
  const limit = nowMs() - CLAIM_WINDOW_MS
  const candidates = items.filter((t) => {
    if (!isCompletedPro(t, cfg)) return false
    const c = isObj(t.custom_data) ? t.custom_data.claim : null
    if (typeof c !== 'string' || c.toLowerCase() !== claim) return false
    const created = Date.parse(t.created_at || '')
    return Number.isFinite(created) && created >= limit
  })
  return firstValid(paddle, cfg, candidates)
}

// Le client a-t-il au moins un achat Pro terminé et non remboursé ?
export async function customerHasValidPurchase(paddle, cfg, customerId) {
  const { items, complete } = await paddle.list(
    `/transactions?${query({ customer_id: customerId, status: 'completed', per_page: 30 })}`,
    PAGES.customerTxns,
  )
  const txns = items.filter((t) => isCompletedPro(t, cfg) && t.customer_id === customerId)
  const valid = await firstValid(paddle, cfg, txns)
  if (valid) return true
  if (!complete) throw new PaddleError(200, 'transactions_truncated')
  return false
}

export async function getCustomer(paddle, customerId) {
  if (!isCustomerId(customerId)) throw new PaddleError(0, 'bad_customer_id')
  const data = await paddle.get(`/customers/${customerId}`)
  if (!isObj(data.data) || data.data.id !== customerId) throw new PaddleError(200, 'bad_shape')
  return data.data
}

// Client(s) de cette adresse qui ont un achat Pro valide. La doc ne dit pas si le
// filtre email de Paddle tient compte de la casse : on demande l'adresse telle que
// tapée et en minuscules, puis, sans résultat, la recherche plein texte de Paddle
// (id, nom, e-mail) ; dans tous les cas on ne garde ici que l'égalité exacte sans casse.
export async function purchaseForEmail(paddle, cfg, emailTyped, emailNorm) {
  const same = (c) => isObj(c) && isCustomerId(c.id) && typeof c.email === 'string' && c.email.trim().toLowerCase() === emailNorm
  const variants = [...new Set([emailNorm, typeof emailTyped === 'string' ? emailTyped.trim() : ''].filter(Boolean))]
  let customers = (await paddle.list(`/customers?${query({ email: variants, per_page: 50 })}`, PAGES.emailLookup)).items.filter(same)
  if (customers.length === 0 && emailNorm.length <= 100) {
    customers = (await paddle.list(`/customers?${query({ search: emailNorm, per_page: 50 })}`, PAGES.emailLookup)).items.filter(same)
  }
  for (const c of customers.slice(0, 3)) {
    if (await customerHasValidPurchase(paddle, cfg, c.id)) return c
  }
  return null
}

const CUS_CACHE_MAX = 20000

export function rememberCustomer(cus, customerId) {
  if (state.customerByCus.size >= CUS_CACHE_MAX) state.customerByCus.clear()
  state.customerByCus.set(cus, customerId)
}

// Retrouve le client Paddle à partir de l'empreinte « cus » du jeton. Une empreinte ne
// se renverse pas et Paddle ne filtre pas sur custom_data : on parcourt les clients
// (200 par page) en mémorisant les empreintes dans l'isolat. 40 pages = 8 000 clients ;
// au-delà, voir docs/licence.md (passer à un stockage KV).
export async function findCustomerByCus(paddle, cus) {
  const known = state.customerByCus.get(cus)
  if (known) {
    const c = await getCustomer(paddle, known)
    if ((await customerHash(c.id)) === cus) return c
  }
  const { found, complete } = await paddle.list(`/customers?${query({ per_page: 200 })}`, PAGES.customerScan, async (c) => {
    if (!isObj(c) || !isCustomerId(c.id)) return false
    const h = await customerHash(c.id)
    rememberCustomer(h, c.id)
    return h === cus
  })
  if (found) return found
  if (!complete) throw new PaddleError(200, 'customers_truncated')
  return null
}

// --- appareils -------------------------------------------------------------------

export function readDevices(customData) {
  const list = isObj(customData) && Array.isArray(customData.flitdrop_devices) ? customData.flitdrop_devices : []
  return list
    .filter((x) => isObj(x) && typeof x.d === 'string' && /^[0-9a-f]{32}$/.test(x.d) && Number.isFinite(x.t))
    .map((x) => ({ d: x.d, t: Math.floor(x.t) }))
}

function readClaims(customData) {
  const raw = isObj(customData) && isObj(customData.flitdrop_claims) ? customData.flitdrop_claims : {}
  const out = {}
  for (const [txn, list] of Object.entries(raw)) {
    if (!isTxnId(txn) || !Array.isArray(list)) continue
    out[txn] = [...new Set(list.filter((d) => typeof d === 'string' && /^[0-9a-f]{32}$/.test(d)))]
  }
  return out
}

// Ajoute ou rafraîchit un appareil ; au-delà de 5, le plus ancien (t le plus petit) sort.
export function withDevice(devices, d, t) {
  const next = devices.filter((x) => x.d !== d)
  next.push({ d, t })
  next.sort((a, b) => a.t - b.t)
  while (next.length > MAX_DEVICES) next.shift()
  return next
}

async function writeCustomData(paddle, customer, customData, mustContain) {
  const data = await paddle.patch(`/customers/${customer.id}`, { custom_data: customData })
  const saved = isObj(data.data) ? data.data.custom_data : null
  // écriture non confirmée : on ne délivre rien
  if (!readDevices(saved).some((x) => x.d === mustContain)) throw new PaddleError(200, 'write_unconfirmed')
  return saved
}

// Inscrit l'appareil chez le client. Avec txnId (déblocage par claim), refuse un
// 6e appareil distinct pour le même achat : { refused: true }.
export async function registerDevice(paddle, customer, d, { txnId } = {}) {
  const current = isObj(customer.custom_data) ? customer.custom_data : {}
  const next = { ...current, flitdrop_devices: withDevice(readDevices(current), d, nowSec()) }
  if (txnId) {
    const claims = readClaims(current)
    const used = claims[txnId] || []
    if (!used.includes(d)) {
      if (used.length >= MAX_CLAIM_DEVICES) return { refused: true }
      used.push(d)
    }
    delete claims[txnId]
    claims[txnId] = used // en dernier : les 10 achats les plus récents sont gardés
    const keys = Object.keys(claims)
    for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete claims[k]
    next.flitdrop_claims = claims
  }
  customer.custom_data = await writeCustomData(paddle, customer, next, d)
  return { refused: false }
}

// Renouvellement : l'appareil doit être inscrit. Sa date est rafraîchie au plus une
// fois par jour, pour qu'un appareil actif ne soit pas « le plus ancien ».
export function deviceRegistered(customer, d) {
  return readDevices(customer.custom_data).some((x) => x.d === d)
}

export async function touchDevice(paddle, customer, d) {
  const current = isObj(customer.custom_data) ? customer.custom_data : {}
  const devices = readDevices(current)
  const mine = devices.find((x) => x.d === d)
  if (!mine || nowSec() - mine.t < 86400) return
  const next = { ...current, flitdrop_devices: withDevice(devices, d, nowSec()) }
  customer.custom_data = await writeCustomData(paddle, customer, next, d)
}
