// Harnais commun des tests des licences : clés de test, environnements, faux Paddle,
// fausse base D1, appel direct des Pages Functions (fausse requête, faux env).
import { generateKeyPairSync, createPublicKey, verify as edVerify, createHash } from 'node:crypto'
import { resetLicenseState, state } from '../../functions/_lib/license/state.js'
import { createWorld, installFetch, addCustomer, addTransaction } from './fake-paddle.mjs'
import { createD1 } from './d1-shim.mjs'

// --- clés et environnements ----------------------------------------------------------

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    signing: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    public: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  }
}
// une clé par environnement, comme en vrai (docs/licence.md)
export const SANDBOX_KEY = pair()
export const PROD_KEY = pair()
export const OTHER_KEY = pair()
export const SIGNING = SANDBOX_KEY.signing
export const PUBLIC_B64 = SANDBOX_KEY.public

export const API_KEY = 'pdl_sdbx_apikey_TESTONLY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'
export const LIVE_API_KEY = 'pdl_live_apikey_TESTONLY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'
export const RESEND_KEY = 're_TESTONLY_resend_secret'

export const SANDBOX_ENV = Object.freeze({
  LICENSE_ENABLED: '1',
  PADDLE_ENV: 'sandbox',
  PADDLE_API_KEY: API_KEY,
  PADDLE_CLIENT_TOKEN: 'test_0123456789abcdef0123456789a',
  PADDLE_PRICE_ID: 'pri_pro',
  PADDLE_EARLY_DISCOUNT_ID: 'dsc_early',
  LICENSE_SIGNING_KEY: SIGNING,
  LICENSE_LAUNCHED_AT: '2026-10-15',
  RESEND_API_KEY: RESEND_KEY,
})
export const PROD_ENV = Object.freeze({
  ...SANDBOX_ENV,
  PADDLE_ENV: 'production',
  PADDLE_API_KEY: LIVE_API_KEY,
  PADDLE_CLIENT_TOKEN: 'live_0123456789abcdef0123456789a',
  LICENSE_SIGNING_KEY: PROD_KEY.signing,
})

export const PREVIEW_HOST = 'pro-server-fix.flitdrop.pages.dev'
export const PROD_HOST = 'flitdrop.com'

// --- identifiants --------------------------------------------------------------------

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
export const hex32 = (seed) => sha(seed).slice(0, 32)
export const hex64 = (seed) => sha('secret:' + seed)
export const claimOf = (secret) => sha('flitdrop-claim-v1:' + secret).slice(0, 32)
export const devHash = (device) => sha(device).slice(0, 32)
export const cusHash = (id) => sha(id).slice(0, 32)
export const DEV = hex32('device-1')
export const SECRET = hex64('claim-1')
export const CLAIM = claimOf(SECRET)

// --- monde de test -------------------------------------------------------------------

export const T = { world: null, db: null, logs: [], restoreFetch: null, realConsoleError: null, realNow: null }

export function setup({ paddleLatency = 0, dbLatency = 0 } = {}) {
  resetLicenseState()
  T.world = createWorld()
  T.restoreFetch = installFetch(T.world)
  if (paddleLatency) {
    const inner = globalThis.fetch
    globalThis.fetch = async (i, init) => {
      await new Promise((r) => setTimeout(r, paddleLatency * (0.5 + Math.random())))
      return inner(i, init)
    }
  }
  T.db = createD1({ latencyMs: dbLatency })
  T.logs = []
  T.realConsoleError = console.error
  console.error = (...a) => T.logs.push(a.join(' '))
  T.realNow = Date.now
}

export function teardown() {
  T.restoreFetch()
  console.error = T.realConsoleError
  Date.now = T.realNow
}

export const shiftClock = (ms) => {
  const base = T.realNow()
  Date.now = () => base + ms
}

// Chaque requête « sur son propre isolat » : les limites en mémoire ne retiennent
// rien, seules comptent celles de la base D1.
export function forgetInIsolateLimits() {
  state.limits = { get: () => undefined, set: () => {}, delete: () => {}, size: 0, keys: () => [][Symbol.iterator](), [Symbol.iterator]: () => [][Symbol.iterator]() }
}

export const sandboxEnv = (patch = {}) => ({ ...SANDBOX_ENV, LICENSE_DB: T.db, ...patch })
export const prodEnv = (patch = {}) => ({ ...PROD_ENV, LICENSE_DB: T.db, ...patch })

// Appelle une Pages Function. Par défaut : sandbox servie sur une adresse de preview,
// production sur flitdrop.com. deferWaits : rend la réponse sans attendre les tâches
// waitUntil (settle() les attend).
export async function call(route, body, { method = 'POST', ip = '203.0.113.7', env, raw, host, country, deferWaits = false } = {}) {
  const e = env === undefined ? sandboxEnv() : env
  const h = host || (e && e.PADDLE_ENV === 'production' ? PROD_HOST : PREVIEW_HOST)
  const waits = []
  const init = { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }
  if (method === 'POST') init.body = raw ?? JSON.stringify(body)
  const request = new Request(`https://${h}/api/license/x`, init)
  // pays du visiteur, comme request.cf.country chez Cloudflare
  if (country) Object.defineProperty(request, 'cf', { value: { country } })
  const t0 = performance.now()
  const res = await route.onRequest({ request, env: e, waitUntil: (p) => waits.push(p) })
  const ms = performance.now() - t0
  const settle = () => Promise.all(waits)
  if (!deferWaits) await settle()
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers, ms, settle, waits }
}

export function decodeToken(token, publicB64 = PUBLIC_B64) {
  const [p, s] = token.split('.')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicB64, 'base64').toString('base64url') }, format: 'jwk' })
  const payloadBytes = Buffer.from(p, 'base64url')
  return { valid: edVerify(null, payloadBytes, key, Buffer.from(s, 'base64url')), payload: JSON.parse(payloadBytes.toString('utf8')) }
}

export const paddleCalls = () => T.world.calls.filter((c) => c.host.endsWith('paddle.com'))

// change un caractère au milieu (jamais le dernier, dont des bits ne comptent pas)
export const flipChar = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)

export function buyer(email = 'ana@example.com', { secret = SECRET, status = 'completed', createdAt } = {}) {
  const customer = addCustomer(T.world, email)
  const txn = addTransaction(T.world, { customer, claim: claimOf(secret), status, createdAt })
  return { customer, txn }
}

export function assertNoSecretLeak(assert, ...texts) {
  for (const t of [...texts, ...T.logs]) {
    for (const secret of [API_KEY, LIVE_API_KEY, SANDBOX_KEY.signing, PROD_KEY.signing, RESEND_KEY]) {
      assert.ok(!String(t).includes(secret), 'secret divulgué')
    }
  }
}

// lignes de la base
export const activeDevices = (customerId) => T.db.rows('SELECT device FROM devices WHERE customer_id = ? AND evicted_at IS NULL', customerId).map((r) => r.device)
export const allDevices = (customerId) => T.db.rows('SELECT device, evicted_at, last_seen_at FROM devices WHERE customer_id = ?', customerId)
