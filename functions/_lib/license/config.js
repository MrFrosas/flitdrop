// Licences Flitdrop Pro : lecture des variables d'environnement Cloudflare Pages.
// Ne lève jamais d'exception : un réglage absent ou mal formé coupe simplement le
// mode payant (enabled: false), et l'app garde alors son comportement d'aujourd'hui.
//
// Requis pour enabled: true (voir docs/licence.md) :
//   LICENSE_ENABLED = "1", PADDLE_ENV = "sandbox" | "production", PADDLE_API_KEY,
//   LICENSE_SIGNING_KEY, la base D1 liée sous le nom LICENSE_DB, et :
//   - en production : PADDLE_CLIENT_TOKEN, PADDLE_PRICE_ID, RESEND_API_KEY ;
//   - en sandbox : ces trois-là sont facultatifs (valeurs sandbox publiques par
//     défaut ci-dessous ; sans RESEND_API_KEY, aucun e-mail ne part).
// Facultatifs : PADDLE_EARLY_DISCOUNT_ID, LICENSE_LAUNCHED_AT
//
// Garde-fou d'environnement : la sandbox (carte de test gratuite) ne répond jamais
// sur flitdrop.com, et la production ne répond que sur flitdrop.com. Une erreur de
// réglage entre Production et Preview ne peut donc jamais fabriquer un jeton d'un
// environnement sur l'autre.

export const TRIAL_DAYS = 14
export const EARLY_DAYS = 30
export const EARLY_PERCENT = 50 // remise de lancement des premiers utilisateurs

// Prix de secours affichés quand Paddle.js ne donne pas le prix localisé, en
// centimes. Le prix réduit se calcule ici, d'un seul endroit, arrondi au centime
// le plus proche, moitié vers le haut, comme Paddle (5,99 € à -50 % = 3,00 €).
const PRICE_CENTS = { EUR: 599, USD: 599, GBP: 549 }

export function formatPrice(currency, cents) {
  const units = Math.floor(cents / 100)
  const rest = String(cents % 100).padStart(2, '0')
  if (currency === 'EUR') return `${units},${rest} €`
  if (currency === 'USD') return `$${units}.${rest}`
  if (currency === 'GBP') return `£${units}.${rest}`
  return null
}

function priceTable(percentOff) {
  const out = {}
  for (const [currency, cents] of Object.entries(PRICE_CENTS)) {
    out[currency] = formatPrice(currency, Math.round((cents * (100 - percentOff)) / 100))
  }
  return out
}

export const DISPLAY_PRICE = priceTable(0)
export const DISPLAY_PRICE_EARLY = priceTable(EARLY_PERCENT)

// Pays du visiteur donné par Cloudflare (request.cf.country), ou null (inconnu, Tor).
export function countryOf(request) {
  const c = request && request.cf && typeof request.cf.country === 'string' ? request.cf.country.toUpperCase() : ''
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null
}

// Prix de secours, sans Paddle : livre au Royaume-Uni, dollar aux États-Unis, euro ailleurs.
export function fallbackPrice(country) {
  const currency = country === 'GB' ? 'GBP' : country === 'US' ? 'USD' : 'EUR'
  return { currency, display: DISPLAY_PRICE[currency], displayEarly: DISPLAY_PRICE_EARLY[currency] }
}

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
}

// Seuls hôtes où la production répond (et où la sandbox ne répond jamais).
const PRODUCTION_HOSTS = new Set(['flitdrop.com', 'www.flitdrop.com'])

// Valeurs PUBLIQUES du compte Paddle sandbox (jeton côté client, prix, remise) :
// la Preview n'a ainsi besoin que des secrets. Jamais de valeur de production par
// défaut : la production vient seulement des variables d'environnement.
const SANDBOX_DEFAULTS = {
  PADDLE_CLIENT_TOKEN: 'test_ecf2165ca0f01949c2dfe708311',
  PADDLE_PRICE_ID: 'pri_01m4gfwxvbg1jjgbp7rbxns9wa',
  PADDLE_EARLY_DISCOUNT_ID: 'dsc_01m4gfz5p1h0p8rghvn1z36jjg',
}

// En-tête DER d'une clé privée Ed25519 au format PKCS8 (RFC 8410), suivi des 32 octets de la clé.
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]

const str = (env, key) => (env && typeof env[key] === 'string' ? env[key].trim() : '')

// LICENSE_SIGNING_KEY : PKCS8 DER en base64 (une ligne). Un PEM collé tel quel est accepté.
export function decodeSigningKey(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  const b64 = value.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  let bin
  try {
    bin = atob(b64)
  } catch {
    return null
  }
  if (bin.length !== 48) return null
  const der = new Uint8Array(48)
  for (let i = 0; i < 48; i++) der[i] = bin.charCodeAt(i)
  for (let i = 0; i < PKCS8_ED25519_PREFIX.length; i++) if (der[i] !== PKCS8_ED25519_PREFIX[i]) return null
  return der
}

// Une clé ou un jeton visiblement de l'autre environnement (sandbox contre production)
// ferait échouer chaque appel : on préfère couper le mode payant.
function mismatched(paddleEnv, apiKey, clientToken) {
  const sandbox = paddleEnv === 'sandbox'
  if (apiKey.startsWith('pdl_sdbx_') && !sandbox) return true
  if (apiKey.startsWith('pdl_live_') && sandbox) return true
  if (clientToken.startsWith('test_') && !sandbox) return true
  if (clientToken.startsWith('live_') && sandbox) return true
  return false
}

// Base D1 liée au projet Pages (Settings, Bindings) sous le nom LICENSE_DB.
export function licenseDb(env) {
  const db = env && env.LICENSE_DB
  return db && typeof db.prepare === 'function' && typeof db.batch === 'function' ? db : null
}

function hostOf(request) {
  try {
    return new URL(request.url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// La production ne répond que sur flitdrop.com ; la sandbox partout ailleurs
// (adresses de preview *.pages.dev, localhost), jamais sur flitdrop.com.
export function hostAllowed(paddleEnv, host) {
  if (!host) return false
  if (paddleEnv === 'production') return PRODUCTION_HOSTS.has(host)
  if (paddleEnv === 'sandbox') return !PRODUCTION_HOSTS.has(host)
  return false
}

export function readLicenseEnv(env, request) {
  try {
    const paddleEnv = str(env, 'PADDLE_ENV')
    const defaults = paddleEnv === 'sandbox' ? SANDBOX_DEFAULTS : {}
    const pick = (key) => str(env, key) || defaults[key] || ''
    const apiKey = str(env, 'PADDLE_API_KEY')
    const clientToken = pick('PADDLE_CLIENT_TOKEN')
    const priceId = pick('PADDLE_PRICE_ID')
    const discount = pick('PADDLE_EARLY_DISCOUNT_ID')
    const launched = str(env, 'LICENSE_LAUNCHED_AT')
    const signingKey = str(env, 'LICENSE_SIGNING_KEY')
    const resendKey = str(env, 'RESEND_API_KEY')
    const db = licenseDb(env)

    const apiBase = API_BASE[paddleEnv] || null
    const signingKeyOk = decodeSigningKey(signingKey) !== null
    const launchedMs = launched ? Date.parse(launched) : NaN
    // en production, la restauration par e-mail est indispensable : Resend est requis
    const resendOk = resendKey.length > 0 || paddleEnv === 'sandbox'

    const enabled =
      env?.LICENSE_ENABLED === '1' &&
      apiBase !== null &&
      apiKey.length >= 16 &&
      /^[A-Za-z0-9_]+$/.test(clientToken) &&
      /^pri_[a-z0-9]+$/.test(priceId) &&
      signingKeyOk &&
      resendOk &&
      db !== null &&
      !mismatched(paddleEnv, apiKey, clientToken) &&
      hostAllowed(paddleEnv, request ? hostOf(request) : null)

    return {
      enabled,
      paddleEnv: apiBase ? paddleEnv : null,
      apiBase,
      apiKey,
      clientToken,
      priceId,
      earlyDiscountId: /^dsc_[a-z0-9]+$/.test(discount) ? discount : null,
      launchedAt: Number.isFinite(launchedMs) ? new Date(launchedMs).toISOString() : null,
      signingKey,
      resendKey,
      db,
    }
  } catch {
    return { enabled: false }
  }
}

// Réponse publique de GET /api/license/config : jamais de secret, seulement ce que
// la page /pro et l'app doivent connaître (le jeton client Paddle est public par nature).
// price : prix localisé pour le pays du visiteur (voir price.js), ou celui de secours.
// storeEnabled : l'achat est-il ouvert aux installations Microsoft Store (STORE_ENABLED
// = "1") ? Sinon l'app du Store reste gratuite et sans limite, tant que sa fiche ne
// déclare pas l'achat intégré.
export function publicConfig(env, request, price) {
  const cfg = readLicenseEnv(env, request)
  const common = {
    trialDays: TRIAL_DAYS,
    earlyDays: EARLY_DAYS,
    displayPrice: DISPLAY_PRICE,
    displayPriceEarly: DISPLAY_PRICE_EARLY,
    price: price || fallbackPrice(countryOf(request)),
    storeEnabled: !!env && env.STORE_ENABLED === '1',
  }
  if (!cfg.enabled) {
    return {
      enabled: false,
      env: null,
      clientToken: null,
      priceId: null,
      earlyDiscountId: null,
      launchedAt: null,
      ...common,
    }
  }
  return {
    enabled: true,
    env: cfg.paddleEnv,
    clientToken: cfg.clientToken,
    priceId: cfg.priceId,
    earlyDiscountId: cfg.earlyDiscountId,
    launchedAt: cfg.launchedAt,
    ...common,
  }
}

// Rétractations (functions/api/withdraw.js) : elles doivent marcher même quand le
// mode payant est coupé (un achat passé se rétracte toujours). Il faut seulement la
// base D1 (limites, trace datée) et Resend.
export function readMailEnv(env) {
  return { db: licenseDb(env), resendKey: str(env, 'RESEND_API_KEY') }
}
