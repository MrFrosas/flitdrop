// Tests des licences Flitdrop Pro : node --test tools/license-tests/*.test.mjs
// Les Pages Functions sont appelées directement (fausse requête, faux env) ; Paddle et
// Resend sont simulés par fake-paddle.mjs. Clé Ed25519 de test tirée à chaque lancement.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createPublicKey, verify as edVerify, createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resetLicenseState } from '../../functions/_lib/license/state.js'
import { publicKeyBase64, normalizeCode, formatCode, newRestoreCode, CODE_ALPHABET } from '../../functions/_lib/license/crypto.js'
import { restoreEmail } from '../../functions/_lib/license/mail.js'
import * as configRoute from '../../functions/api/license/config.js'
import * as claimRoute from '../../functions/api/license/claim.js'
import * as renewRoute from '../../functions/api/license/renew.js'
import * as startRoute from '../../functions/api/license/restore/start.js'
import * as verifyRoute from '../../functions/api/license/restore/verify.js'
import { createWorld, installFetch, addCustomer, addTransaction, addAdjustment } from './fake-paddle.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// --- clés et environnement de test -------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const SIGNING = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const PUBLIC_B64 = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')
const OTHER_SIGNING = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')

const API_KEY = 'pdl_sdbx_apikey_TESTONLY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'
const RESEND_KEY = 're_TESTONLY_resend_secret'
const ENV = Object.freeze({
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

const hex32 = (seed) => createHash('sha256').update(String(seed)).digest('hex').slice(0, 32)
const devHash = (device) => createHash('sha256').update(device).digest('hex').slice(0, 32)
const cusHash = (id) => createHash('sha256').update(id).digest('hex').slice(0, 32)
const DEV = hex32('device-1')
const CLAIM = hex32('claim-1')

// --- harnais --------------------------------------------------------------------------

let world
let restoreFetch
let logs
let realConsoleError
let realNow

beforeEach(() => {
  resetLicenseState()
  world = createWorld()
  restoreFetch = installFetch(world)
  logs = []
  realConsoleError = console.error
  console.error = (...a) => logs.push(a.join(' '))
  realNow = Date.now
})
afterEach(() => {
  restoreFetch()
  console.error = realConsoleError
  Date.now = realNow
})

const shiftClock = (ms) => {
  const base = realNow()
  Date.now = () => base + ms
}

async function call(route, body, { method = 'POST', ip = '203.0.113.7', env = ENV, raw } = {}) {
  const waits = []
  const init = { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }
  if (method === 'POST') init.body = raw ?? JSON.stringify(body)
  const request = new Request('https://flitdrop.com/api/license/x', init)
  const res = await route.onRequest({ request, env, waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers }
}

function decodeToken(token) {
  const [p, s] = token.split('.')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(PUBLIC_B64, 'base64').toString('base64url') }, format: 'jwk' })
  const payloadBytes = Buffer.from(p, 'base64url')
  return { valid: edVerify(null, payloadBytes, key, Buffer.from(s, 'base64url')), payload: JSON.parse(payloadBytes.toString('utf8')) }
}

const paddleCalls = () => world.calls.filter((c) => c.host.endsWith('paddle.com'))

// change un caractère au milieu (jamais le dernier, dont des bits ne comptent pas)
const flipChar = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)

function buyer(email = 'ana@example.com', customData = null) {
  const customer = addCustomer(world, email, customData)
  const txn = addTransaction(world, { customer, claim: CLAIM })
  return { customer, txn }
}

function assertNoSecretLeak(...texts) {
  for (const t of [...texts, ...logs]) {
    assert.ok(!String(t).includes(API_KEY), 'clé Paddle divulguée')
    assert.ok(!String(t).includes(SIGNING), 'clé de signature divulguée')
    assert.ok(!String(t).includes(RESEND_KEY), 'clé Resend divulguée')
  }
}

// --- config ---------------------------------------------------------------------------

test('config : coupé quand l’environnement manque, sans jamais lever', async () => {
  for (const env of [undefined, null, {}, { LICENSE_ENABLED: '1' }]) {
    const res = configRoute.onRequest({ request: new Request('https://flitdrop.com/api/license/config'), env })
    const r = { status: res.status, body: await res.json() }
    assert.equal(r.status, 200)
    assert.equal(r.body.enabled, false)
    assert.equal(r.body.clientToken, null)
    assert.equal(r.body.priceId, null)
    assert.equal(r.body.trialDays, 14)
  }
  const required = ['PADDLE_ENV', 'PADDLE_API_KEY', 'PADDLE_CLIENT_TOKEN', 'PADDLE_PRICE_ID', 'LICENSE_SIGNING_KEY', 'RESEND_API_KEY']
  for (const k of required) {
    const env = { ...ENV }
    delete env[k]
    assert.equal((await call(configRoute, null, { method: 'GET', env })).body.enabled, false, `${k} manquant`)
  }
  const broken = [
    { LICENSE_ENABLED: '0' },
    { LICENSE_ENABLED: 'true' },
    { PADDLE_ENV: 'live' },
    { LICENSE_SIGNING_KEY: 'pas-une-cle' },
    { LICENSE_SIGNING_KEY: Buffer.alloc(48).toString('base64') },
    { PADDLE_ENV: 'production' }, // clé et jeton client de sandbox avec l'environnement production
    { PADDLE_PRICE_ID: 'price-1' },
  ]
  for (const patch of broken) {
    assert.equal((await call(configRoute, null, { method: 'GET', env: { ...ENV, ...patch } })).body.enabled, false, JSON.stringify(patch))
  }
})

test('config : réglages publics quand tout est là, aucun secret', async () => {
  const r = await call(configRoute, null, { method: 'GET' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, {
    enabled: true,
    env: 'sandbox',
    clientToken: ENV.PADDLE_CLIENT_TOKEN,
    priceId: 'pri_pro',
    earlyDiscountId: 'dsc_early',
    launchedAt: '2026-10-15T00:00:00.000Z',
    trialDays: 14,
    earlyDays: 30,
    displayPrice: { EUR: '5,99 €', USD: '$5.99', GBP: '£5.49' },
  })
  assert.match(r.headers.get('cache-control'), /max-age=60/)
  assertNoSecretLeak(r.text)
  const noDiscount = await call(configRoute, null, { method: 'GET', env: { ...ENV, PADDLE_EARLY_DISCOUNT_ID: '', LICENSE_LAUNCHED_AT: 'bientôt' } })
  assert.equal(noDiscount.body.earlyDiscountId, null)
  assert.equal(noDiscount.body.launchedAt, null)
  assert.equal((await call(configRoute, {}, { method: 'POST' })).status, 405)
})

test('endpoints POST : 503 disabled quand le mode payant est coupé, et 405 en GET', async () => {
  for (const route of [claimRoute, renewRoute, startRoute, verifyRoute]) {
    assert.equal((await call(route, {}, { env: {} })).body.error, 'disabled')
    assert.equal((await call(route, null, { method: 'GET' })).status, 405)
  }
  assert.equal(paddleCalls().length, 0)
})

// --- claim -----------------------------------------------------------------------------

test('claim : achat trouvé -> jeton signé vérifiable avec la clé publique, appareil inscrit', async () => {
  const { customer } = buyer('ana@example.com', { note: 'garder', other: [1, 2] })
  const r = await call(claimRoute, { claim: CLAIM, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid, 'signature Ed25519 valide')
  assert.deepEqual(Object.keys(payload).sort(), ['cus', 'dev', 'exp', 'iat', 'plan', 'v'])
  assert.equal(payload.v, 1)
  assert.equal(payload.plan, 'pro')
  assert.equal(payload.dev, DEV)
  assert.equal(payload.cus, cusHash(customer.id))
  assert.equal(payload.exp - payload.iat, 30 * 86400)
  assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5)
  // registre chez Paddle : empreinte seulement, autres clés conservées
  assert.equal(customer.custom_data.note, 'garder')
  assert.deepEqual(customer.custom_data.other, [1, 2])
  assert.deepEqual(customer.custom_data.flitdrop_devices.map((x) => x.d), [devHash(DEV)])
  assert.ok(!JSON.stringify(customer.custom_data).includes(DEV), 'jamais l’identifiant brut')
  // en-têtes Paddle
  const get = paddleCalls()[0]
  assert.equal(get.headers.Authorization, `Bearer ${API_KEY}`)
  assert.equal(get.headers['Paddle-Version'], '1')
  assert.ok(get.url.startsWith('https://sandbox-api.paddle.com/transactions?'))
  assert.match(get.url, /status=completed/)
  assert.match(get.url, /created_at\[GTE\]=\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\dZ/)
  assertNoSecretLeak(r.text)
})

test('claim : clé publique dérivée côté serveur identique à celle de la paire', async () => {
  assert.equal(await publicKeyBase64(SIGNING), PUBLIC_B64)
})

test('claim : en attente sans achat, avec un autre prix, trop ancien ou pas encore terminé', async () => {
  assert.deepEqual((await call(claimRoute, { claim: CLAIM, device: DEV })).body, { pending: true })
  const customer = addCustomer(world, 'bob@example.com')
  addTransaction(world, { customer, claim: CLAIM, priceId: 'pri_other' })
  addTransaction(world, { customer, claim: CLAIM, createdAt: new Date(Date.now() - 49 * 3600e3).toISOString() })
  addTransaction(world, { customer, claim: CLAIM, status: 'paid' })
  addTransaction(world, { customer, claim: hex32('autre-claim') })
  resetLicenseState() // pas de cache de 3 s entre les deux appels
  const r = await call(claimRoute, { claim: CLAIM, device: DEV })
  assert.equal(r.status, 202)
  assert.deepEqual(r.body, { pending: true })
  assert.equal(customer.custom_data, null, 'rien inscrit')
})

test('claim : remboursé ou rétrofacturé -> en attente ; remboursement partiel ou en attente -> débloqué', async () => {
  const cases = [
    [{ action: 'refund', status: 'approved', type: 'full' }, 202],
    [{ action: 'refund', status: 'approved', type: 'partial', itemType: 'full' }, 202],
    [{ action: 'refund', status: 'approved', type: 'partial', itemType: 'partial', total: '599' }, 202],
    [{ action: 'chargeback', status: 'approved', type: 'full' }, 202],
    [{ action: 'refund', status: 'pending_approval', type: 'full' }, 200],
    [{ action: 'refund', status: 'rejected', type: 'full' }, 200],
    [{ action: 'refund', status: 'approved', type: 'partial', itemType: 'partial', total: '100' }, 200],
    [{ action: 'chargeback', status: 'reversed', type: 'full' }, 200],
    [{ action: 'chargeback_warning', status: 'approved', type: 'full' }, 200],
  ]
  for (const [adj, expected] of cases) {
    resetLicenseState()
    world.transactions = []
    world.adjustments = []
    const { txn } = buyer(`c${world.customers.length}@example.com`)
    addAdjustment(world, txn, adj)
    const r = await call(claimRoute, { claim: CLAIM, device: DEV })
    assert.equal(r.status, expected, JSON.stringify(adj))
    if (expected === 202) assert.equal(r.body.token, undefined)
  }
})

test('claim : un même achat débloque 5 appareils distincts au plus', async () => {
  const { customer, txn } = buyer()
  for (let i = 1; i <= 5; i++) {
    assert.equal((await call(claimRoute, { claim: CLAIM, device: hex32('dev' + i) }, { ip: `198.51.100.${i}` })).status, 200)
  }
  const sixth = await call(claimRoute, { claim: CLAIM, device: hex32('dev6') }, { ip: '198.51.100.6' })
  assert.equal(sixth.status, 403)
  assert.deepEqual(sixth.body, { error: 'claim_used' })
  assert.ok(!customer.custom_data.flitdrop_devices.some((x) => x.d === devHash(hex32('dev6'))))
  assert.equal(customer.custom_data.flitdrop_claims[txn.id].length, 5)
  // un appareil déjà passé par ce claim peut redemander son jeton
  assert.equal((await call(claimRoute, { claim: CLAIM, device: hex32('dev1') })).status, 200)
})

test('claim : 5 appareils déjà inscrits -> le plus ancien sort', async () => {
  const now = Math.floor(Date.now() / 1000)
  const old = [1, 2, 3, 4, 5].map((i) => ({ d: devHash(hex32('old' + i)), t: now - i * 1000 }))
  const { customer } = buyer('ana@example.com', { flitdrop_devices: old })
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 200)
  const ds = customer.custom_data.flitdrop_devices.map((x) => x.d)
  assert.equal(ds.length, 5)
  assert.ok(ds.includes(devHash(DEV)))
  assert.ok(!ds.includes(devHash(hex32('old5'))), 'le plus ancien (t le plus petit) est sorti')
  assert.ok(ds.includes(devHash(hex32('old1'))))
})

test('claim : entrées invalides -> 400 (identifiants en hexadécimal minuscule strict)', async () => {
  const bad = [
    { claim: CLAIM },
    { device: DEV },
    { claim: CLAIM.toUpperCase(), device: DEV },
    { claim: CLAIM, device: DEV.toUpperCase() },
    { claim: CLAIM + '0', device: DEV },
    { claim: CLAIM, device: 12 },
    [],
  ]
  for (const body of bad) assert.equal((await call(claimRoute, body)).status, 400, JSON.stringify(body))
  assert.equal((await call(claimRoute, null, { raw: '{pas du json' })).status, 400)
  assert.equal((await call(claimRoute, null, { raw: JSON.stringify({ claim: CLAIM, device: DEV, pad: 'x'.repeat(5000) }) })).status, 400)
  assert.equal(paddleCalls().length, 0)
})

test('claim : erreurs Paddle -> 503 rapide, jamais de jeton', async () => {
  buyer()
  for (const fail of [{ status: 500 }, { status: 401, code: 'authentication_malformed' }, { status: 403, code: 'forbidden' }, { network: true }]) {
    resetLicenseState()
    world.fail = { ...fail }
    const r = await call(claimRoute, { claim: CLAIM, device: DEV })
    assert.equal(r.status, 503, JSON.stringify(fail))
    assert.deepEqual(r.body, { error: 'unavailable' })
    assert.equal(r.headers.get('retry-after'), '60')
  }
  // Paddle lit la transaction mais l'écriture du registre n'est pas confirmée
  resetLicenseState()
  world.fail = null
  world.patchIgnored = true
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 503)
  assertNoSecretLeak()
  assert.ok(logs.length > 0 && logs.every((l) => l.startsWith('license ')))
})

test('claim : après un 429 de Paddle, plus aucun appel pendant la pause', async () => {
  buyer()
  world.fail = { status: 429, code: 'too_many_requests', headers: { 'retry-after': '60' }, times: 1 }
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 503)
  const before = paddleCalls().length
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 503)
  assert.equal(paddleCalls().length, before, 'Paddle n’est pas rappelé')
  shiftClock(61_000)
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 200)
})

test('claim : 5xx passager -> un seul nouvel essai puis succès', async () => {
  buyer()
  world.fail = { status: 502, times: 1 }
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 200)
})

test('claim : limite par adresse IP', async () => {
  let last
  for (let i = 0; i < 41; i++) last = await call(claimRoute, { claim: hex32('c' + i), device: DEV })
  assert.equal(last.status, 429)
  assert.equal(last.body.error, 'too_many')
  assert.ok(Number(last.headers.get('retry-after')) > 0)
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV }, { ip: '192.0.2.99' })).status, 202)
})

test('claim : le lien « next » de Paddle vers un autre hôte n’est jamais suivi', async () => {
  const customer = addCustomer(world, 'x@example.com')
  for (let i = 0; i < 31; i++) addTransaction(world, { customer, claim: hex32('t' + i) })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const res = await realFetch(input, init)
    const url = String(input)
    if (!url.includes('/transactions?')) return res
    const data = await res.json()
    data.meta.pagination.next = 'https://evil.example/transactions?after=x'
    return new Response(JSON.stringify(data), { status: 200 })
  }
  const r = await call(claimRoute, { claim: CLAIM, device: DEV })
  assert.equal(r.status, 503)
  assert.ok(!world.calls.some((c) => c.host === 'evil.example'))
})

// --- restauration ----------------------------------------------------------------------

const codeFromEmail = (mail) => mail.body.text.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/)[1]

test('restore/start : achat -> défi + e-mail avec un code XXXX-XXXX-XXXX, dans la langue demandée', async () => {
  const { customer } = buyer('Ana@Example.com')
  const r = await call(startRoute, { email: '  ana@example.COM ', lang: 'fr' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body), ['challenge'])
  assert.equal(world.emails.length, 1)
  const mail = world.emails[0]
  assert.equal(mail.body.from, 'Flitdrop <contact@flitdrop.com>')
  assert.deepEqual(mail.body.to, [customer.email], 'adresse enregistrée chez Paddle')
  assert.equal(mail.headers.Authorization, `Bearer ${RESEND_KEY}`)
  const code = codeFromEmail(mail)
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.ok(mail.body.subject.includes(code))
  assert.ok(mail.body.html.includes(code))
  assert.match(mail.body.text, /Voici ton code/)
  assert.ok(!r.text.includes(code.replace(/-/g, '')) && !r.text.includes(code), 'le code ne figure pas dans la réponse')
})

test('restore/start : sans achat (ou remboursé) -> même réponse, aucun e-mail', async () => {
  const withBuy = buyer('ana@example.com')
  const a = await call(startRoute, { email: 'ana@example.com', lang: 'en' })
  const b = await call(startRoute, { email: 'nobody@example.com', lang: 'en' })
  addAdjustment(world, withBuy.txn, { action: 'refund', status: 'approved', type: 'full' })
  const c = await call(startRoute, { email: 'ana@example.com', lang: 'en' }, { ip: '192.0.2.5' })
  for (const r of [a, b, c]) {
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body), ['challenge'])
    assert.equal(r.body.challenge.length, a.body.challenge.length)
  }
  assert.equal(world.emails.length, 1, 'un seul e-mail : celui de l’achat valable')
})

test('restore/start : limites par adresse e-mail et par IP', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call(startRoute, { email: 'ana@example.com' }, { ip: `192.0.2.${i}` })).status, 200)
  const r = await call(startRoute, { email: 'ANA@example.com' }, { ip: '192.0.2.50' })
  assert.equal(r.status, 429)
  assert.equal(r.body.error, 'too_many')
  for (let i = 0; i < 10; i++) assert.equal((await call(startRoute, { email: `p${i}@example.com` }, { ip: '198.51.100.1' })).status, 200)
  assert.equal((await call(startRoute, { email: 'p99@example.com' }, { ip: '198.51.100.1' })).status, 429)
})

test('restore/start : entrées invalides -> 400 ; Paddle en panne -> 503 sans e-mail', async () => {
  for (const email of [undefined, '', 'pas-une-adresse', 'a@b', 'a,b@example.com', 'x'.repeat(250) + '@example.com']) {
    assert.equal((await call(startRoute, { email })).status, 400, String(email))
  }
  buyer()
  world.fail = { status: 503 }
  const r = await call(startRoute, { email: 'ana@example.com' })
  assert.equal(r.status, 503)
  assert.equal(world.emails.length, 0)
})

async function startAndGetCode(email = 'ana@example.com', lang = 'en') {
  const r = await call(startRoute, { email, lang })
  return { challenge: r.body.challenge, code: codeFromEmail(world.emails.at(-1)) }
}

test('restore/verify : bon code -> jeton, appareil inscrit ; saisie souple (casse, espaces)', async () => {
  const { customer } = buyer()
  const { challenge, code } = await startAndGetCode()
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid)
  assert.equal(payload.dev, DEV)
  assert.equal(payload.cus, cusHash(customer.id))
  assert.ok(customer.custom_data.flitdrop_devices.some((x) => x.d === devHash(DEV)))

  resetLicenseState()
  const second = await startAndGetCode()
  const typed = second.code.toLowerCase().replace(/-/g, ' ')
  const DEV2 = hex32('device-2')
  assert.equal((await call(verifyRoute, { email: 'ANA@example.com', code: typed, challenge: second.challenge, device: DEV2 })).status, 200)
})

test('restore/verify : mauvais code, défi falsifié ou autre adresse -> 400 code', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  const wrong = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1)
  const tries = [
    { code: wrong, challenge },
    { code: '0000-0000-0000', challenge },
    { code: 'trop court', challenge },
    { code, challenge: 'n.importe.quoi' },
    { code, challenge: flipChar(challenge, challenge.indexOf('.') + 10) },
  ]
  // défi prolongé à la main : l'expiration est liée au HMAC
  const [head, tag] = challenge.split('.')
  const p = JSON.parse(Buffer.from(head, 'base64url').toString())
  p.x += 3600
  tries.push({ code, challenge: Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + tag })
  for (const t of tries) {
    resetLicenseState() // chaque essai sur un isolat neuf : la limite de 5 essais par défi a son propre test
    const r = await call(verifyRoute, { email: 'ana@example.com', device: DEV, ...t })
    assert.equal(r.status, 400, JSON.stringify(t))
    assert.deepEqual(r.body, { error: 'code' })
  }
  resetLicenseState()
  const other = await call(verifyRoute, { email: 'eve@example.com', code, challenge, device: DEV }, { ip: '192.0.2.77' })
  assert.deepEqual(other.body, { error: 'code' })
})

test('restore/verify : après 15 minutes -> 400 expired', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  shiftClock(15 * 60_000 + 2000)
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.deepEqual(r.body, { error: 'expired' })
})

test('restore/verify : remboursé entre-temps -> 400 nopurchase', async () => {
  const { txn } = buyer()
  const { challenge, code } = await startAndGetCode()
  addAdjustment(world, txn, { action: 'chargeback', status: 'approved', type: 'full' })
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.deepEqual(r.body, { error: 'nopurchase' })
})

test('restore/verify : un code ne sert qu’une fois ; 5 essais par défi', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  assert.equal((await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })).status, 200)
  assert.deepEqual((await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: hex32('x') })).body, { error: 'expired' })

  resetLicenseState()
  const fresh = await startAndGetCode()
  for (let i = 0; i < 5; i++) {
    const r = await call(verifyRoute, { email: 'ana@example.com', code: 'ZZZZ-ZZZZ-ZZZ' + i, challenge: fresh.challenge, device: DEV }, { ip: `192.0.2.${i}` })
    assert.equal(r.status, 400)
  }
  const sixth = await call(verifyRoute, { email: 'ana@example.com', code: fresh.code, challenge: fresh.challenge, device: DEV }, { ip: '192.0.2.200' })
  assert.equal(sixth.status, 429, 'même le bon code est refusé après 5 essais sur ce défi')
})

test('restore/verify : Paddle en panne -> 503, jamais de jeton', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  world.fail = { status: 500 }
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.equal(r.status, 503)
  assert.equal(r.body.token, undefined)
})

test('codes de restauration : alphabet de Crockford, 60 bits, normalisation à la saisie', () => {
  assert.equal(CODE_ALPHABET.length, 32)
  assert.ok(!/[ILOU]/.test(CODE_ALPHABET))
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const c = newRestoreCode()
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{12}$/)
    seen.add(c)
  }
  assert.equal(seen.size, 2000)
  assert.equal(formatCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN')
  assert.equal(normalizeCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN')
  assert.equal(normalizeCode(' AbCd EfGh JkMn '), 'ABCDEFGHJKMN')
  assert.equal(normalizeCode('O0IL-0000-0000'), '0011' + '00000000')
  assert.equal(normalizeCode('ABCD-EFGH-JKMU'), null, 'U n’existe pas')
  assert.equal(normalizeCode('ABCD-EFGH-JKM'), null)
  assert.equal(normalizeCode('x'.repeat(41)), null)
})

test('e-mails de restauration : trois langues, sans tiret long ni demi-long', () => {
  const texts = { fr: 'Voici ton code', de: 'hier ist dein Code', en: 'Here is your code' }
  for (const [lang, expected] of Object.entries(texts)) {
    const m = restoreEmail(lang, 'ABCDEFGHJKMN')
    assert.ok(m.text.includes(expected), lang)
    assert.ok(m.text.includes('ABCD-EFGH-JKMN'))
    assert.ok(m.text.includes('15'))
    for (const s of [m.subject, m.text, m.html]) assert.ok(!/[\u2013\u2014]/.test(s), lang)
  }
  assert.ok(restoreEmail('es', 'ABCDEFGHJKMN').text.includes('Here is your code'))
})

// --- renouvellement --------------------------------------------------------------------

async function claimedToken(device = DEV) {
  const r = await call(claimRoute, { claim: CLAIM, device })
  assert.equal(r.status, 200)
  return r.body.token
}

test('renew : achat valable et appareil inscrit -> nouveau jeton', async () => {
  buyer()
  const token = await claimedToken()
  shiftClock(25 * 86400e3)
  const r = await call(renewRoute, { token, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid)
  assert.ok(payload.iat >= decodeToken(token).payload.iat + 25 * 86400 - 5)
})

test('renew : date de l’appareil rafraîchie (pas « le plus ancien » s’il sert encore)', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  const t0 = customer.custom_data.flitdrop_devices[0].t
  shiftClock(3 * 86400e3)
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 200)
  assert.ok(customer.custom_data.flitdrop_devices[0].t >= t0 + 3 * 86400 - 5)
})

test('renew : remboursé ou rétrofacturé après coup -> 403 revoked', async () => {
  for (const adj of [{ action: 'refund', status: 'approved', type: 'full' }, { action: 'chargeback', status: 'approved', type: 'full' }]) {
    resetLicenseState()
    world.transactions = []
    world.adjustments = []
    const { txn } = buyer(`r${world.customers.length}@example.com`)
    const token = await claimedToken()
    addAdjustment(world, txn, adj)
    const r = await call(renewRoute, { token, device: DEV })
    assert.equal(r.status, 403, adj.action)
    assert.deepEqual(r.body, { error: 'revoked' })
  }
})

test('renew : appareil sorti du registre (5 autres inscrits ensuite) -> 403 revoked', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  shiftClock(60_000)
  const others = [1, 2, 3, 4, 5].map((i) => ({ d: devHash(hex32('later' + i)), t: Math.floor(Date.now() / 1000) + i }))
  customer.custom_data = { ...customer.custom_data, flitdrop_devices: others }
  const r = await call(renewRoute, { token, device: DEV })
  assert.deepEqual(r.body, { error: 'revoked' })
  assert.equal(r.status, 403)
})

test('renew : jeton falsifié, d’une autre clé ou d’un autre appareil -> 403 revoked', async () => {
  buyer()
  const token = await claimedToken()
  const [p, s] = token.split('.')
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  const forged = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 9e6 })).toString('base64url') + '.' + s
  const otherKey = (await call(claimRoute, { claim: CLAIM, device: DEV }, { env: { ...ENV, LICENSE_SIGNING_KEY: OTHER_SIGNING }, ip: '192.0.2.9' })).body.token
  for (const [t, device] of [
    [forged, DEV],
    [otherKey, DEV],
    [token, hex32('autre-machine')],
    [p + '.' + flipChar(s, 20), DEV],
    ['abc', DEV],
  ]) {
    const r = await call(renewRoute, { token: t, device })
    assert.equal(r.status, 403)
    assert.deepEqual(r.body, { error: 'revoked' })
  }
  assert.equal((await call(renewRoute, { token, device: DEV.toUpperCase() })).status, 400)
})

test('renew : jeton d’un appareil présenté par un autre appareil inscrit -> 403 revoked', async () => {
  buyer()
  const token = await claimedToken(DEV)
  const DEV2 = hex32('device-2')
  await claimedToken(DEV2) // les deux appareils sont dans le registre
  const r = await call(renewRoute, { token, device: DEV2 })
  assert.equal(r.status, 403)
  assert.deepEqual(r.body, { error: 'revoked' })
})

test('renew : jeton expiré depuis peu accepté (tout est revérifié), trop vieux refusé', async () => {
  buyer()
  const token = await claimedToken()
  shiftClock(45 * 86400e3)
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 200)
  shiftClock(400 * 86400e3)
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 403)
})

test('renew : client retrouvé par balayage paginé dans un isolat neuf', async () => {
  for (let i = 0; i < 450; i++) addCustomer(world, `filler${i}@example.com`)
  const { customer } = buyer()
  // l'acheteur a le plus petit id (le plus ancien) : dernière page du balayage
  customer.id = 'ctm_' + '0'.repeat(25) + '0'
  world.transactions[0].customer_id = customer.id
  const token = await claimedToken()
  resetLicenseState()
  const before = paddleCalls().length
  const r = await call(renewRoute, { token, device: DEV })
  assert.equal(r.status, 200)
  const scans = paddleCalls().slice(before).filter((c) => c.url.includes('/customers?'))
  assert.equal(scans.length, 3, '450 + 1 clients à 200 par page')
})

test('renew : client introuvable -> 403 ; Paddle en panne -> 503 et l’app garde son jeton', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  world.fail = { status: 500 }
  const down = await call(renewRoute, { token, device: DEV })
  assert.equal(down.status, 503)
  assert.equal(down.body.token, undefined)
  world.fail = null
  resetLicenseState()
  customer.status = 'archived'
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 403)
})

// --- divers ---------------------------------------------------------------------------

test('aucune réponse ni journal ne contient de secret', async () => {
  buyer()
  const outs = []
  outs.push((await call(claimRoute, { claim: CLAIM, device: DEV })).text)
  world.fail = { status: 401, code: 'authentication_malformed' }
  resetLicenseState()
  outs.push((await call(claimRoute, { claim: CLAIM, device: DEV })).text)
  outs.push((await call(startRoute, { email: 'ana@example.com' })).text)
  assertNoSecretLeak(...outs)
  for (const l of logs) assert.ok(!l.includes('ana@example.com'), 'pas d’adresse dans les journaux')
})

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

test('fichiers : aucun tiret long, et rien dans functions/_lib n’est routé par Pages', () => {
  const files = [
    ...walk(join(ROOT, 'functions/api/license')),
    ...walk(join(ROOT, 'functions/_lib/license')),
    ...walk(join(ROOT, 'tools/license-tests')),
    join(ROOT, 'tools/license-keygen.mjs'),
    join(ROOT, 'docs/licence.md'),
  ]
  for (const f of files) assert.ok(!/[\u2013\u2014]/.test(readFileSync(f, 'utf8')), f)
  for (const f of walk(join(ROOT, 'functions/_lib/license'))) {
    assert.ok(!/export\s+(async\s+)?function\s+onRequest|export\s+(const|let)\s+onRequest/.test(readFileSync(f, 'utf8')), f)
  }
})
