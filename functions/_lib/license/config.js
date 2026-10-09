// Licences Flitdrop Pro : lecture des variables d'environnement Cloudflare Pages.
// Ne lève jamais d'exception : un réglage absent ou mal formé coupe simplement le
// mode payant (enabled: false), et l'app garde alors son comportement d'aujourd'hui.
//
// Requis pour enabled: true (voir docs/licence.md) :
//   LICENSE_ENABLED = "1", PADDLE_ENV = "sandbox" | "production", PADDLE_API_KEY,
//   PADDLE_CLIENT_TOKEN, PADDLE_PRICE_ID, LICENSE_SIGNING_KEY, RESEND_API_KEY
// Facultatifs : PADDLE_EARLY_DISCOUNT_ID, LICENSE_LAUNCHED_AT

export const TRIAL_DAYS = 14
export const EARLY_DAYS = 30
export const DISPLAY_PRICE = { EUR: '5,99 €', USD: '$5.99', GBP: '£5.49' }

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
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

export function readLicenseEnv(env) {
  try {
    const paddleEnv = str(env, 'PADDLE_ENV')
    const apiKey = str(env, 'PADDLE_API_KEY')
    const clientToken = str(env, 'PADDLE_CLIENT_TOKEN')
    const priceId = str(env, 'PADDLE_PRICE_ID')
    const discount = str(env, 'PADDLE_EARLY_DISCOUNT_ID')
    const launched = str(env, 'LICENSE_LAUNCHED_AT')
    const signingKey = str(env, 'LICENSE_SIGNING_KEY')
    const resendKey = str(env, 'RESEND_API_KEY')

    const apiBase = API_BASE[paddleEnv] || null
    const signingKeyOk = decodeSigningKey(signingKey) !== null
    const launchedMs = launched ? Date.parse(launched) : NaN

    const enabled =
      env?.LICENSE_ENABLED === '1' &&
      apiBase !== null &&
      apiKey.length >= 16 &&
      /^[A-Za-z0-9_]+$/.test(clientToken) &&
      /^pri_[a-z0-9]+$/.test(priceId) &&
      signingKeyOk &&
      resendKey.length > 0 &&
      !mismatched(paddleEnv, apiKey, clientToken)

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
    }
  } catch {
    return { enabled: false }
  }
}

// Réponse publique de GET /api/license/config : jamais de secret, seulement ce que
// la page /pro et l'app doivent connaître (le jeton client Paddle est public par nature).
export function publicConfig(env) {
  const cfg = readLicenseEnv(env)
  const common = { trialDays: TRIAL_DAYS, earlyDays: EARLY_DAYS, displayPrice: DISPLAY_PRICE }
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
