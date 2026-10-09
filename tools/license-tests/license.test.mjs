// Tests des licences Flitdrop Pro : node --test tools/license-tests/*.test.mjs
// Les Pages Functions sont appelées directement (fausse requête, faux env) ; Paddle et
// Resend sont simulés par fake-paddle.mjs, la base D1 par d1-shim.mjs (node:sqlite).
// Clés Ed25519 de test tirées à chaque lancement (une par environnement).
// Les attaques de la revue de sécurité ont leurs propres tests : security.test.mjs.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resetLicenseState } from '../../functions/_lib/license/state.js'
import { publicKeyBase64, normalizeCode, formatCode, newRestoreCode, CODE_ALPHABET } from '../../functions/_lib/license/crypto.js'
import { restoreEmail } from '../../functions/_lib/license/mail.js'
import { SCHEMA } from '../../functions/_lib/license/db.js'
import * as configRoute from '../../functions/api/license/config.js'
import * as claimRoute from '../../functions/api/license/claim.js'
import * as doneRoute from '../../functions/api/license/checkout-done.js'
import * as renewRoute from '../../functions/api/license/renew.js'
import * as startRoute from '../../functions/api/license/restore/start.js'
import * as verifyRoute from '../../functions/api/license/restore/verify.js'
import { addCustomer, addTransaction, addAdjustment } from './fake-paddle.mjs'
import {
  T, setup, teardown, shiftClock, call, decodeToken, paddleCalls, flipChar, buyer, assertNoSecretLeak, activeDevices, allDevices,
  sandboxEnv, prodEnv, SANDBOX_ENV, SIGNING, PUBLIC_B64, OTHER_KEY, API_KEY, RESEND_KEY, PREVIEW_HOST,
  hex32, hex64, claimOf, devHash, cusHash, DEV, SECRET, CLAIM,
} from './harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

beforeEach(() => setup())
afterEach(() => teardown())

// --- config ---------------------------------------------------------------------------

test('config : coupé quand l’environnement manque, sans jamais lever', async () => {
  for (const env of [undefined, null, {}, { LICENSE_ENABLED: '1' }]) {
    const res = await configRoute.onRequest({ request: new Request(`https://${PREVIEW_HOST}/api/license/config`), env })
    const r = { status: res.status, body: await res.json() }
    assert.equal(r.status, 200)
    assert.equal(r.body.enabled, false)
    assert.equal(r.body.clientToken, null)
    assert.equal(r.body.priceId, null)
    assert.equal(r.body.trialDays, 14)
  }
  for (const k of ['PADDLE_ENV', 'PADDLE_API_KEY', 'LICENSE_SIGNING_KEY', 'LICENSE_DB']) {
    const env = sandboxEnv()
    delete env[k]
    assert.equal((await call(configRoute, null, { method: 'GET', env })).body.enabled, false, `${k} manquant`)
  }
  // en production, jeton client, prix et Resend sont requis (pas de valeur par défaut)
  for (const k of ['PADDLE_CLIENT_TOKEN', 'PADDLE_PRICE_ID', 'RESEND_API_KEY']) {
    const env = prodEnv()
    delete env[k]
    assert.equal((await call(configRoute, null, { method: 'GET', env })).body.enabled, false, `${k} manquant en production`)
  }
  const broken = [
    { LICENSE_ENABLED: '0' },
    { LICENSE_ENABLED: 'true' },
    { PADDLE_ENV: 'live' },
    { LICENSE_SIGNING_KEY: 'pas-une-cle' },
    { LICENSE_SIGNING_KEY: Buffer.alloc(48).toString('base64') },
    { PADDLE_PRICE_ID: 'price-1' },
    { LICENSE_DB: {} }, // liaison qui n'est pas une base D1
  ]
  for (const patch of broken) {
    assert.equal((await call(configRoute, null, { method: 'GET', env: sandboxEnv(patch) })).body.enabled, false, JSON.stringify(patch))
  }
  // clé et jeton client de sandbox avec l'environnement production
  assert.equal((await call(configRoute, null, { method: 'GET', env: sandboxEnv({ PADDLE_ENV: 'production' }), host: 'flitdrop.com' })).body.enabled, false)
})

test('config : réglages publics quand tout est là, aucun secret, prix de lancement à 50 %', async () => {
  const r = await call(configRoute, null, { method: 'GET' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, {
    enabled: true,
    env: 'sandbox',
    clientToken: SANDBOX_ENV.PADDLE_CLIENT_TOKEN,
    priceId: 'pri_pro',
    earlyDiscountId: 'dsc_early',
    launchedAt: '2026-10-15T00:00:00.000Z',
    trialDays: 14,
    earlyDays: 30,
    displayPrice: { EUR: '5,99 €', USD: '$5.99', GBP: '£5.49' },
    displayPriceEarly: { EUR: '2,99 €', USD: '$2.99', GBP: '£2.74' },
    // pays inconnu : prix de secours, sans appel à Paddle
    price: { currency: 'EUR', display: '5,99 €', displayEarly: '2,99 €' },
    storeEnabled: false,
  })
  assert.equal(paddleCalls().length, 0)
  assert.match(r.headers.get('cache-control'), /max-age=60/)
  assertNoSecretLeak(assert, r.text)
  const prod = await call(configRoute, null, { method: 'GET', env: prodEnv({ PADDLE_EARLY_DISCOUNT_ID: '', LICENSE_LAUNCHED_AT: 'bientôt' }) })
  assert.equal(prod.body.enabled, true)
  assert.equal(prod.body.env, 'production')
  assert.equal(prod.body.earlyDiscountId, null)
  assert.equal(prod.body.launchedAt, null)
  assert.equal((await call(configRoute, {}, { method: 'POST' })).status, 405)
})

test('config : la Preview n’a besoin que de LICENSE_ENABLED, PADDLE_ENV=sandbox et des secrets', async () => {
  const env = { LICENSE_ENABLED: '1', PADDLE_ENV: 'sandbox', PADDLE_API_KEY: API_KEY, LICENSE_SIGNING_KEY: SIGNING, LICENSE_DB: T.db }
  const r = await call(configRoute, null, { method: 'GET', env })
  assert.equal(r.body.enabled, true)
  assert.equal(r.body.clientToken, 'test_ecf2165ca0f01949c2dfe708311')
  assert.equal(r.body.priceId, 'pri_01m4gfwxvbg1jjgbp7rbxns9wa')
  assert.equal(r.body.earlyDiscountId, 'dsc_01m4gfz5p1h0p8rghvn1z36jjg')
  // les variables gardent la main
  assert.equal((await call(configRoute, null, { method: 'GET', env: { ...env, PADDLE_PRICE_ID: 'pri_other' } })).body.priceId, 'pri_other')
  // jamais de valeur par défaut en production
  const prod = { LICENSE_ENABLED: '1', PADDLE_ENV: 'production', PADDLE_API_KEY: 'pdl_live_' + 'x'.repeat(30), LICENSE_SIGNING_KEY: SIGNING, RESEND_API_KEY: 're_x', LICENSE_DB: T.db }
  const p = await call(configRoute, null, { method: 'GET', env: prod })
  assert.equal(p.body.enabled, false)
  assert.equal(p.body.clientToken, null)
})

test('endpoints POST : 503 disabled (à retenter) quand le mode payant est coupé, et 405 en GET', async () => {
  for (const route of [claimRoute, doneRoute, renewRoute, startRoute, verifyRoute]) {
    const off = await call(route, {}, { env: {} })
    assert.equal(off.status, 503)
    assert.equal(off.body.error, 'disabled')
    assert.ok(Number(off.headers.get('retry-after')) > 0)
    // base D1 absente : coupé aussi
    assert.equal((await call(route, {}, { env: sandboxEnv({ LICENSE_DB: undefined }) })).body.error, 'disabled')
    assert.equal((await call(route, null, { method: 'GET' })).status, 405)
  }
  assert.equal(paddleCalls().length, 0)
})

test('schéma : docs/licence-schema.sql est la copie exacte de celui du code, et se crée tout seul', async () => {
  const sql = readFileSync(join(ROOT, 'docs/licence-schema.sql'), 'utf8')
  const statements = sql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  assert.deepEqual(statements, SCHEMA.map((s) => s.replace(/\s+/g, ' ').trim()))
  // base vide : la première requête crée les tables, deux isolats de suite sans erreur
  buyer()
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
  resetLicenseState()
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
  const tables = T.db.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)
  assert.deepEqual(tables, ['claim_devices', 'counters', 'customers', 'devices', 'price_cache', 'purchases', 'registrations', 'used_challenges', 'withdrawals'])
})

test('config : prix localisé par pays, demandé par le serveur à Paddle, en cache 6 heures', async () => {
  const fr = await call(configRoute, null, { method: 'GET', country: 'FR' })
  assert.deepEqual(fr.body.price, { currency: 'EUR', display: '5,99 €', displayEarly: '2,99 €' })
  assert.deepEqual(T.world.previews, [{ country: 'FR', discount: null }, { country: 'FR', discount: 'dsc_early' }])
  assert.ok(paddleCalls().every((c) => c.url.endsWith('/pricing-preview') && c.method === 'POST'))
  assert.equal(fr.headers.get('cache-control'), 'private, max-age=60', 'le prix dépend du pays : jamais en cache partagé')
  const cases = { GB: ['GBP', '£5.49', '£2.74'], US: ['USD', '$5.99', '$2.99'], JP: ['JPY', '¥900', '¥450'] }
  for (const [country, [currency, display, displayEarly]] of Object.entries(cases)) {
    assert.deepEqual((await call(configRoute, null, { method: 'GET', country })).body.price, { currency, display, displayEarly }, country)
  }
  // en cache : plus aucun appel pendant 6 heures, sur n'importe quel isolat
  const before = paddleCalls().length
  resetLicenseState()
  assert.equal((await call(configRoute, null, { method: 'GET', country: 'FR' })).body.price.display, '5,99 €')
  assert.equal(paddleCalls().length, before)
  shiftClock(6 * 3600e3 + 1000)
  T.world.prices.pri_pro.EUR = 649
  assert.equal((await call(configRoute, null, { method: 'GET', country: 'FR' })).body.price.display, '6,49 €')
})

test('config : prix de secours sur toute erreur, sans jamais faire attendre ni échouer', async () => {
  T.world.fail = { status: 500 }
  const gb = await call(configRoute, null, { method: 'GET', country: 'GB' })
  assert.equal(gb.status, 200)
  assert.deepEqual(gb.body.price, { currency: 'GBP', display: '£5.49', displayEarly: '£2.74' })
  // échec gardé 10 minutes : Paddle n'est pas rappelé à chaque visite
  const before = paddleCalls().length
  await call(configRoute, null, { method: 'GET', country: 'GB' })
  assert.equal(paddleCalls().length, before)
  T.world.fail = null
  shiftClock(11 * 60e3)
  await call(configRoute, null, { method: 'GET', country: 'GB' })
  assert.ok(paddleCalls().length > before)
  // forme inattendue, base en panne, mode coupé : secours, et aucun appel quand c'est coupé
  T.db.ctl.fail = 1
  resetLicenseState()
  assert.equal((await call(configRoute, null, { method: 'GET', country: 'DE' })).body.price.display, '5,99 €')
  const calls = paddleCalls().length
  const off = await call(configRoute, null, { method: 'GET', country: 'US', env: sandboxEnv({ LICENSE_ENABLED: '0' }) })
  assert.deepEqual(off.body.price, { currency: 'USD', display: '$5.99', displayEarly: '$2.99' })
  assert.equal(paddleCalls().length, calls)
  for (const country of ['XX', 'T1', 'fr-FR', '']) {
    resetLicenseState()
    assert.equal((await call(configRoute, null, { method: 'GET', country })).body.price.currency, 'EUR', country)
  }
  assert.equal(paddleCalls().length, calls)
})

test('config : sans remise de lancement configurée, prix de lancement calculé (50 %) ; aperçus plafonnés', async () => {
  const prod = await call(configRoute, null, { method: 'GET', country: 'FR', env: prodEnv({ PADDLE_EARLY_DISCOUNT_ID: '' }) })
  assert.deepEqual(prod.body.price, { currency: 'EUR', display: '5,99 €', displayEarly: '2,99 €' })
  assert.equal(T.world.previews.length, 1, 'un seul aperçu sans remise')
  // 20 aperçus par minute pour tout le site
  const countries = ['AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AU', 'AW', 'AZ', 'BA', 'BB', 'BD', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BM', 'BN', 'BO', 'BR']
  for (const c of countries) await call(configRoute, null, { method: 'GET', country: c, env: prodEnv({ PADDLE_EARLY_DISCOUNT_ID: '' }) })
  assert.equal(T.world.previews.length, 20)
})

test('config : storeEnabled vrai seulement avec STORE_ENABLED = "1"', async () => {
  assert.equal((await call(configRoute, null, { method: 'GET' })).body.storeEnabled, false)
  assert.equal((await call(configRoute, null, { method: 'GET', env: sandboxEnv({ STORE_ENABLED: '1' }) })).body.storeEnabled, true)
  assert.equal((await call(configRoute, null, { method: 'GET', env: sandboxEnv({ STORE_ENABLED: 'true' }) })).body.storeEnabled, false)
  assert.equal((await call(configRoute, null, { method: 'GET', env: { STORE_ENABLED: '1' } })).body.storeEnabled, true, 'indépendant du mode payant')
})

// --- claim -----------------------------------------------------------------------------

test('claim : achat trouvé -> jeton signé (env compris), appareil inscrit dans la base, rien écrit chez Paddle', async () => {
  const { customer } = buyer()
  const r = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid, 'signature Ed25519 valide')
  assert.deepEqual(Object.keys(payload), ['v', 'env', 'plan', 'dev', 'cus', 'iat', 'exp'])
  assert.equal(payload.v, 1)
  assert.equal(payload.env, 'sandbox')
  assert.equal(payload.plan, 'pro')
  assert.equal(payload.dev, DEV)
  assert.equal(payload.cus, cusHash(customer.id))
  assert.equal(payload.exp - payload.iat, 30 * 86400)
  assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5)
  // base : empreinte de l'appareil seulement, index cus -> client
  assert.deepEqual(activeDevices(customer.id), [devHash(DEV)])
  assert.ok(!JSON.stringify(T.db.rows('SELECT * FROM devices')).includes(DEV), 'jamais l’identifiant brut')
  assert.deepEqual(T.db.rows('SELECT customer_id FROM customers WHERE cus = ?', cusHash(customer.id)), [{ customer_id: customer.id }])
  // Paddle : lecture seule
  assert.ok(paddleCalls().every((c) => c.method === 'GET'))
  assert.equal(customer.custom_data, null)
  const get = paddleCalls()[0]
  assert.equal(get.headers.Authorization, `Bearer ${API_KEY}`)
  assert.equal(get.headers['Paddle-Version'], '1')
  assert.ok(get.url.startsWith('https://sandbox-api.paddle.com/transactions?'))
  assert.match(get.url, /created_at\[GTE\]=\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\dZ/)
  assertNoSecretLeak(assert, r.text)
})

test('claim : clé publique dérivée côté serveur identique à celle de la paire', async () => {
  assert.equal(await publicKeyBase64(SIGNING), PUBLIC_B64)
})

test('claim : le claim seul (sans le secret) ne débloque rien', async () => {
  buyer()
  // l'ancien contrat { claim } et le claim passé comme secret sont refusés
  assert.equal((await call(claimRoute, { claim: CLAIM, device: DEV })).status, 400)
  assert.equal((await call(claimRoute, { secret: CLAIM, device: DEV })).status, 400)
  assert.equal((await call(claimRoute, { secret: CLAIM + CLAIM, device: DEV })).status, 202)
})

test('claim : en attente sans achat, avec un autre prix, trop ancien, pas encore terminé ou autre claim', async () => {
  assert.deepEqual((await call(claimRoute, { secret: SECRET, device: DEV })).body, { pending: true })
  const customer = addCustomer(T.world, 'bob@example.com')
  addTransaction(T.world, { customer, claim: CLAIM, priceId: 'pri_other' })
  addTransaction(T.world, { customer, claim: CLAIM, createdAt: new Date(Date.now() - 49 * 3600e3).toISOString() })
  addTransaction(T.world, { customer, claim: CLAIM, status: 'paid' })
  addTransaction(T.world, { customer, claim: hex32('autre-claim') })
  resetLicenseState() // pas de cache de 5 s entre les deux appels
  const r = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.equal(r.status, 202)
  assert.deepEqual(r.body, { pending: true })
  assert.deepEqual(T.db.rows('SELECT * FROM devices'), [], 'rien inscrit')
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
  let i = 0
  for (const [adj, expected] of cases) {
    // par le balayage de secours (base vide) puis par la base (checkout-done)
    for (const viaDone of [false, true]) {
      resetLicenseState()
      const secret = hex64('refund-case-' + i++)
      const { txn } = buyer(`c${i}@example.com`, { secret })
      addAdjustment(T.world, txn, adj)
      if (viaDone) assert.equal((await call(doneRoute, { transaction_id: txn.id, claim: claimOf(secret) })).status, 200)
      const r = await call(claimRoute, { secret, device: DEV })
      assert.equal(r.status, expected, JSON.stringify(adj) + (viaDone ? ' (base)' : ' (balayage)'))
      if (expected === 202) assert.equal(r.body.token, undefined)
    }
  }
})

test('claim : un même claim débloque 5 appareils distincts au plus', async () => {
  const { customer } = buyer()
  for (let i = 1; i <= 5; i++) {
    assert.equal((await call(claimRoute, { secret: SECRET, device: hex32('dev' + i) }, { ip: `198.51.100.${i}` })).status, 200)
  }
  const sixth = await call(claimRoute, { secret: SECRET, device: hex32('dev6') }, { ip: '198.51.100.6' })
  assert.equal(sixth.status, 403)
  assert.deepEqual(sixth.body, { error: 'claim_used' })
  assert.ok(!activeDevices(customer.id).includes(devHash(hex32('dev6'))))
  assert.equal(T.db.rows('SELECT count(*) AS n FROM claim_devices WHERE claim = ?', CLAIM)[0].n, 5)
  // un appareil déjà passé par ce claim peut redemander son jeton
  assert.equal((await call(claimRoute, { secret: SECRET, device: hex32('dev1') })).status, 200)
})

test('claim : 5 appareils déjà actifs -> le moins récemment vu sort', async () => {
  const { customer } = buyer()
  const now = Math.floor(Date.now() / 1000)
  // 5 appareils déjà actifs (inscrits par « J'ai déjà acheté »), vus à des dates différentes
  await call(claimRoute, { secret: hex64('amorce'), device: DEV }) // crée les tables
  for (let i = 1; i <= 5; i++) {
    T.db.sql('INSERT INTO devices (customer_id, device, claim, registered_at, last_seen_at, evicted_at) VALUES (?, ?, NULL, ?, ?, NULL)', customer.id, devHash(hex32('old' + i)), now - 90 * 86400, now - i * 1000)
  }
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
  const ds = activeDevices(customer.id)
  assert.equal(ds.length, 5)
  assert.ok(ds.includes(devHash(DEV)))
  assert.ok(!ds.includes(devHash(hex32('old5'))), 'le moins récemment vu est sorti')
  assert.ok(ds.includes(devHash(hex32('old1'))))
  const evicted = allDevices(customer.id).find((d) => d.device === devHash(hex32('old5')))
  assert.ok(evicted && evicted.evicted_at > 0, 'sa ligne reste, marquée sortie (preuve pour le renouvellement)')
})

test('claim : entrées invalides -> 400 (hexadécimal minuscule strict)', async () => {
  const bad = [
    { secret: SECRET },
    { device: DEV },
    { secret: SECRET.toUpperCase(), device: DEV },
    { secret: SECRET, device: DEV.toUpperCase() },
    { secret: SECRET + '0', device: DEV },
    { secret: SECRET.slice(1), device: DEV },
    { secret: SECRET, device: 12 },
    [],
  ]
  for (const body of bad) assert.equal((await call(claimRoute, body)).status, 400, JSON.stringify(body))
  assert.equal((await call(claimRoute, null, { raw: '{pas du json' })).status, 400)
  assert.equal((await call(claimRoute, null, { raw: JSON.stringify({ secret: SECRET, device: DEV, pad: 'x'.repeat(5000) }) })).status, 400)
  assert.equal(paddleCalls().length, 0)
})

test('claim : erreurs Paddle ou base -> 503 rapide, jamais de jeton', async () => {
  buyer()
  for (const fail of [{ status: 500 }, { status: 401, code: 'authentication_malformed' }, { status: 403, code: 'forbidden' }, { network: true }]) {
    resetLicenseState()
    T.world.fail = { ...fail }
    const r = await call(claimRoute, { secret: SECRET, device: DEV })
    assert.equal(r.status, 503, JSON.stringify(fail))
    assert.deepEqual(r.body, { error: 'unavailable' })
    assert.equal(r.headers.get('retry-after'), '60')
  }
  T.world.fail = null
  for (const n of [1, 2, 3, 5]) {
    resetLicenseState()
    T.db.ctl.fail = n
    const r = await call(claimRoute, { secret: SECRET, device: DEV })
    assert.equal(r.status, 503, `base en panne (${n} appels)`)
    assert.equal(r.body.token, undefined)
  }
  T.db.ctl.fail = 0
  assertNoSecretLeak(assert)
  assert.ok(T.logs.length > 0 && T.logs.every((l) => l.startsWith('license ')))
})

test('claim : après un 429 de Paddle, plus aucun appel pendant la pause', async () => {
  buyer()
  T.world.fail = { status: 429, code: 'too_many_requests', headers: { 'retry-after': '60' }, times: 1 }
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 503)
  const before = paddleCalls().length
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 503)
  assert.equal(paddleCalls().length, before, 'Paddle n’est pas rappelé')
  shiftClock(61_000)
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
})

test('claim : 5xx passager -> un seul nouvel essai puis succès', async () => {
  buyer()
  T.world.fail = { status: 502, times: 1 }
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
})

test('claim : limite par adresse IP', async () => {
  let last
  for (let i = 0; i < 41; i++) last = await call(claimRoute, { secret: hex64('c' + i), device: DEV })
  assert.equal(last.status, 429)
  assert.equal(last.body.error, 'too_many')
  assert.ok(Number(last.headers.get('retry-after')) > 0)
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV }, { ip: '192.0.2.99' })).status, 202)
})

test('claim : le lien « next » de Paddle vers un autre hôte n’est jamais suivi', async () => {
  const customer = addCustomer(T.world, 'x@example.com')
  for (let i = 0; i < 31; i++) addTransaction(T.world, { customer, claim: hex32('t' + i) })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const res = await realFetch(input, init)
    const url = String(input)
    if (!url.includes('/transactions?')) return res
    const data = await res.json()
    data.meta.pagination.next = 'https://evil.example/transactions?after=x'
    return new Response(JSON.stringify(data), { status: 200 })
  }
  const r = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.equal(r.status, 503)
  assert.ok(!T.world.calls.some((c) => c.host === 'evil.example'))
})

// --- checkout-done : achat noté depuis la page /pro ---------------------------------------

test('checkout-done : la transaction payée est notée ; claim la retrouve en 2 appels Paddle, sans balayage', async () => {
  const { customer, txn } = buyer('ana@example.com', { status: 'paid' })
  const d = await call(doneRoute, { transaction_id: txn.id, claim: CLAIM })
  assert.deepEqual([d.status, d.body], [200, { ok: true }])
  assert.equal(paddleCalls().length, 1)
  assert.ok(paddleCalls()[0].url.endsWith(`/transactions/${txn.id}`))
  assert.deepEqual(T.db.rows('SELECT claim, txn_id, customer_id, status FROM purchases'), [{ claim: CLAIM, txn_id: txn.id, customer_id: customer.id, status: 'paid' }])
  assert.equal(T.db.rows('SELECT customer_id FROM customers WHERE cus = ?', cusHash(customer.id))[0].customer_id, customer.id)

  // payée mais pas encore terminée : en attente, sans fausse alerte ; l'état vient
  // d'être lu chez Paddle, il n'est pas redemandé avant 4 s (cache négatif partagé)
  let before = paddleCalls().length
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 202)
  assert.equal(paddleCalls().length - before, 0)
  shiftClock(5000)
  before = paddleCalls().length
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 202)
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 202)
  assert.equal(paddleCalls().length - before, 1)

  txn.status = 'completed'
  shiftClock(10_000)
  const mark = paddleCalls().length
  const r = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.equal(r.status, 200)
  const used = paddleCalls().slice(mark)
  assert.equal(used.length, 2, 'la transaction par son id, puis ses ajustements')
  assert.ok(!used.some((c) => /\/transactions\?/.test(c.url)), 'aucun balayage')
})

test('checkout-done : réponse identique pour tout, rien de noté sans le bon claim, prix ou paiement', async () => {
  const { txn } = buyer()
  const ready = buyer('r@example.com', { secret: hex64('ready'), status: 'ready' }).txn
  const other = addTransaction(T.world, { customer: addCustomer(T.world, 'o@example.com'), claim: CLAIM, priceId: 'pri_other' })
  const answers = []
  for (const body of [
    { transaction_id: txn.id, claim: hex32('pas-le-bon') },
    { transaction_id: ready.id, claim: claimOf(hex64('ready')) },
    { transaction_id: other.id, claim: CLAIM },
    { transaction_id: 'txn_inexistante0000000000000', claim: CLAIM },
  ]) {
    const r = await call(doneRoute, body)
    answers.push(r.text)
    assert.equal(r.status, 200, JSON.stringify(body))
  }
  assert.equal(new Set(answers).size, 1, 'aucune différence observable')
  assert.deepEqual(T.db.rows('SELECT * FROM purchases'), [])
  assert.ok(!answers.some((a) => a.includes('token')))
  for (const body of [{ transaction_id: txn.id }, { claim: CLAIM }, { transaction_id: 'TXN_1', claim: CLAIM }, { transaction_id: 'txn_' + 'a'.repeat(80), claim: CLAIM }, { transaction_id: txn.id, claim: SECRET }]) {
    assert.equal((await call(doneRoute, body)).status, 400, JSON.stringify(body))
  }
})

test('checkout-done : une transaction notée n’est jamais remplacée par une autre, sauf remboursée', async () => {
  const { txn } = buyer()
  assert.equal((await call(doneRoute, { transaction_id: txn.id, claim: CLAIM })).status, 200)
  // quelqu'un paie une autre transaction avec le même claim : la première reste
  const second = addTransaction(T.world, { customer: addCustomer(T.world, 'x@example.com'), claim: CLAIM })
  await call(doneRoute, { transaction_id: second.id, claim: CLAIM }, { ip: '192.0.2.2' })
  assert.equal(T.db.rows('SELECT txn_id FROM purchases')[0].txn_id, txn.id)
  // la même, renvoyée : aucun appel Paddle
  const before = paddleCalls().length
  await call(doneRoute, { transaction_id: txn.id, claim: CLAIM }, { ip: '192.0.2.3' })
  assert.equal(paddleCalls().length, before)
  // la première est remboursée (vu par claim) : la suivante peut prendre sa place
  addAdjustment(T.world, txn, { action: 'refund', status: 'approved', type: 'full' })
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 202)
  assert.equal(T.db.rows('SELECT revoked FROM purchases')[0].revoked, 1)
  await call(doneRoute, { transaction_id: second.id, claim: CLAIM }, { ip: '192.0.2.4' })
  assert.equal(T.db.rows('SELECT txn_id FROM purchases')[0].txn_id, second.id)
  shiftClock(5000)
  assert.equal((await call(claimRoute, { secret: SECRET, device: DEV })).status, 200)
})

test('checkout-done : limites par IP et par claim, budget global d’appels Paddle', async () => {
  let last
  for (let i = 0; i < 11; i++) last = await call(doneRoute, { transaction_id: `txn_x${i}`, claim: hex32('l' + i) })
  assert.equal(last.status, 429)
  for (let i = 0; i < 7; i++) last = await call(doneRoute, { transaction_id: `txn_y${i}`, claim: CLAIM }, { ip: `198.51.100.${i}` })
  assert.equal(last.status, 429)
  // 30 recherches par minute pour tout le site : au-delà, même réponse sans appel
  shiftClock(60_000) // minute suivante : le budget repart de zéro
  T.world.calls = []
  for (let i = 0; i < 40; i++) {
    resetLicenseState()
    assert.equal((await call(doneRoute, { transaction_id: `txn_z${i}`, claim: hex32('z' + i) }, { ip: `203.0.113.${i}` })).status, 200)
  }
  assert.equal(paddleCalls().length, 30)
})

// --- restauration ----------------------------------------------------------------------

const codeFromEmail = (mail) => mail.body.text.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/)[1]

test('restore/start : achat -> défi + e-mail avec un code XXXX-XXXX-XXXX, dans la langue demandée', async () => {
  const { customer } = buyer('Ana@Example.com')
  const r = await call(startRoute, { email: '  ana@example.COM ', lang: 'fr' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body), ['challenge'])
  assert.equal(T.world.emails.length, 1)
  const mail = T.world.emails[0]
  assert.equal(mail.body.from, 'Flitdrop <contact@flitdrop.com>')
  assert.deepEqual(mail.body.to, [customer.email], 'adresse enregistrée chez Paddle')
  assert.equal(mail.headers.Authorization, `Bearer ${RESEND_KEY}`)
  const code = codeFromEmail(mail)
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.ok(mail.body.subject.includes(code))
  assert.ok(mail.body.html.includes(code))
  assert.match(mail.body.text, /Voici ton code/)
  assert.ok(!r.text.includes(code.replace(/-/g, '')) && !r.text.includes(code), 'le code ne figure pas dans la réponse')
  // la base ne garde jamais l'adresse en clair
  assert.ok(!JSON.stringify(T.db.rows('SELECT * FROM counters')).includes('example'))
})

test('restore/start : sans achat (ou remboursé) -> même réponse, aucun e-mail', async () => {
  const withBuy = buyer('ana@example.com')
  const a = await call(startRoute, { email: 'ana@example.com', lang: 'en' })
  const b = await call(startRoute, { email: 'nobody@example.com', lang: 'en' })
  addAdjustment(T.world, withBuy.txn, { action: 'refund', status: 'approved', type: 'full' })
  const c = await call(startRoute, { email: 'ana@example.com', lang: 'en' }, { ip: '192.0.2.5' })
  for (const r of [a, b, c]) {
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body), ['challenge'])
    assert.equal(r.body.challenge.length, a.body.challenge.length)
  }
  assert.equal(T.world.emails.length, 1, 'un seul e-mail : celui de l’achat valable')
})

test('restore/start : limites en mémoire (429) par adresse e-mail et par IP', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call(startRoute, { email: 'ana@example.com' }, { ip: `192.0.2.${i}` })).status, 200)
  const r = await call(startRoute, { email: 'ANA@example.com' }, { ip: '192.0.2.50' })
  assert.equal(r.status, 429)
  assert.equal(r.body.error, 'too_many')
  for (let i = 0; i < 10; i++) assert.equal((await call(startRoute, { email: `p${i}@example.com` }, { ip: '198.51.100.1' })).status, 200)
  assert.equal((await call(startRoute, { email: 'p99@example.com' }, { ip: '198.51.100.1' })).status, 429)
})

test('restore/start : plafonds partagés silencieux (5 par heure, 10 par jour par adresse)', async () => {
  buyer('ana@example.com')
  const ask = async (i) => {
    resetLicenseState() // un autre isolat à chaque fois : seule la base retient
    const r = await call(startRoute, { email: 'ana@example.com' }, { ip: `192.0.2.${i}` })
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body), ['challenge'])
  }
  for (let i = 0; i < 7; i++) await ask(i)
  assert.equal(T.world.emails.length, 5, '5 codes par heure')
  shiftClock(3600e3)
  for (let i = 0; i < 7; i++) await ask(20 + i)
  assert.equal(T.world.emails.length, 10, '10 codes par jour')
  // Paddle n'est plus sollicité au-delà des plafonds
  const before = paddleCalls().length
  await ask(99)
  assert.equal(paddleCalls().length, before)
})

test('restore/start : budget quotidien d’e-mails (quota Resend partagé avec le formulaire de contact)', async () => {
  for (let i = 0; i < 52; i++) buyer(`b${i}@example.com`)
  for (let i = 0; i < 52; i++) {
    resetLicenseState()
    shiftClock(i * 4000) // au plus 20 recherches Paddle par minute pour tout le site
    await call(startRoute, { email: `b${i}@example.com` }, { ip: `198.51.100.${i}` })
  }
  assert.equal(T.world.emails.length, startRoute.RESTORE_LIMITS.mailsPerDay)
  assert.ok(T.logs.some((l) => l.includes('daily e-mail budget')))
})

test('restore/start : entrées invalides -> 400 ; Paddle en panne -> même réponse, sans e-mail', async () => {
  for (const email of [undefined, '', 'pas-une-adresse', 'a@b', 'a,b@example.com', 'x'.repeat(250) + '@example.com']) {
    assert.equal((await call(startRoute, { email })).status, 400, String(email))
  }
  buyer()
  T.world.fail = { status: 503 }
  const r = await call(startRoute, { email: 'ana@example.com' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body), ['challenge'])
  assert.equal(T.world.emails.length, 0)
})

test('restore/start : en sandbox sans RESEND_API_KEY, la restauration répond mais n’envoie rien', async () => {
  buyer()
  const r = await call(startRoute, { email: 'ana@example.com' }, { env: sandboxEnv({ RESEND_API_KEY: '' }) })
  assert.equal(r.status, 200)
  assert.equal(T.world.emails.length, 0)
  assert.ok(T.logs.some((l) => l.includes('RESEND_API_KEY')))
})

async function startAndGetCode(email = 'ana@example.com', lang = 'en', opts = {}) {
  const r = await call(startRoute, { email, lang }, opts)
  return { challenge: r.body.challenge, code: codeFromEmail(T.world.emails.at(-1)) }
}

test('restore/verify : bon code -> jeton, appareil inscrit ; saisie souple (casse, espaces)', async () => {
  const { customer } = buyer()
  const { challenge, code } = await startAndGetCode()
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid)
  assert.equal(payload.dev, DEV)
  assert.equal(payload.env, 'sandbox')
  assert.equal(payload.cus, cusHash(customer.id))
  assert.deepEqual(activeDevices(customer.id), [devHash(DEV)])
  assert.equal(T.db.rows('SELECT customer_id FROM customers WHERE cus = ?', cusHash(customer.id)).length, 1)

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
  const dot = challenge.indexOf('.')
  const tries = [
    { code: wrong, challenge },
    { code: '0000-0000-0000', challenge },
    { code: 'trop court', challenge },
    { code, challenge: 'n.importe.quoi' },
    { code, challenge: flipChar(challenge, dot + 10) }, // HMAC de l'en-tête
    { code, challenge: flipChar(challenge, dot + 60) }, // HMAC du code
  ]
  // défi prolongé à la main : l'expiration est liée au HMAC
  const [head, tag] = challenge.split('.')
  const p = JSON.parse(Buffer.from(head, 'base64url').toString())
  tries.push({ code, challenge: Buffer.from(JSON.stringify({ ...p, x: p.x + 3600 })).toString('base64url') + '.' + tag })
  for (const t of tries) {
    resetLicenseState()
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
  addAdjustment(T.world, txn, { action: 'chargeback', status: 'approved', type: 'full' })
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.deepEqual(r.body, { error: 'nopurchase' })
})

test('restore/verify : Paddle ou base en panne -> 503, jamais de jeton, et le code reste utilisable', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  T.world.fail = { status: 500 }
  const r = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })
  assert.equal(r.status, 503)
  assert.equal(r.body.token, undefined)
  T.world.fail = null
  assert.equal((await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })).status, 200)
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

async function claimedToken(device = DEV, secret = SECRET) {
  const r = await call(claimRoute, { secret, device })
  assert.equal(r.status, 200)
  return r.body.token
}

test('renew : achat valable et appareil actif -> nouveau jeton, en 2 appels Paddle', async () => {
  buyer()
  const token = await claimedToken()
  shiftClock(25 * 86400e3)
  resetLicenseState() // isolat neuf : rien en mémoire, tout vient de la base
  const before = paddleCalls().length
  const r = await call(renewRoute, { token, device: DEV })
  assert.equal(r.status, 200)
  const { valid, payload } = decodeToken(r.body.token)
  assert.ok(valid)
  assert.equal(payload.env, 'sandbox')
  assert.ok(payload.iat >= decodeToken(token).payload.iat + 25 * 86400 - 5)
  assert.equal(paddleCalls().length - before, 2, 'achats du client, puis leurs ajustements')
  assert.ok(!paddleCalls().slice(before).some((c) => c.url.includes('/customers')), 'jamais de balayage des clients')
})

test('renew : date de l’appareil rafraîchie (pas « le moins récemment vu » s’il sert encore)', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  const t0 = allDevices(customer.id)[0].last_seen_at
  shiftClock(3 * 86400e3)
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 200)
  assert.ok(allDevices(customer.id)[0].last_seen_at >= t0 + 3 * 86400 - 5)
})

test('renew : remboursé ou rétrofacturé après coup -> 403 revoked', async () => {
  let i = 0
  for (const adj of [{ action: 'refund', status: 'approved', type: 'full' }, { action: 'chargeback', status: 'approved', type: 'full' }]) {
    resetLicenseState()
    const secret = hex64('renew-refund-' + i++)
    const { txn } = buyer(`r${i}@example.com`, { secret })
    const token = await claimedToken(DEV, secret)
    addAdjustment(T.world, txn, adj)
    const r = await call(renewRoute, { token, device: DEV })
    assert.equal(r.status, 403, adj.action)
    assert.deepEqual(r.body, { error: 'revoked' })
  }
})

test('renew : appareil sorti (5 autres inscrits ensuite) -> 403 revoked, sans appel Paddle', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  T.db.sql('UPDATE devices SET evicted_at = ? WHERE customer_id = ?', Math.floor(Date.now() / 1000), customer.id)
  const before = paddleCalls().length
  const r = await call(renewRoute, { token, device: DEV })
  assert.deepEqual(r.body, { error: 'revoked' })
  assert.equal(r.status, 403)
  assert.equal(paddleCalls().length, before)
})

test('renew : jeton falsifié, d’une autre clé ou d’un autre appareil -> 403 revoked', async () => {
  buyer()
  const token = await claimedToken()
  const [p, s] = token.split('.')
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  const forged = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 9e6 })).toString('base64url') + '.' + s
  const otherKey = (await call(claimRoute, { secret: SECRET, device: DEV }, { env: sandboxEnv({ LICENSE_SIGNING_KEY: OTHER_KEY.signing }), ip: '192.0.2.9' })).body.token
  const noEnv = Buffer.from(JSON.stringify({ ...payload, env: undefined })).toString('base64url') + '.' + s
  for (const [t, device] of [
    [forged, DEV],
    [otherKey, DEV],
    [noEnv, DEV],
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
  await claimedToken(DEV2)
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

test('renew : jamais de retrait sur un doute (client ou appareil inconnus, aucun achat trouvé, pannes)', async () => {
  const { customer } = buyer()
  const token = await claimedToken()
  // Paddle en panne
  T.world.fail = { status: 500 }
  const down = await call(renewRoute, { token, device: DEV })
  assert.equal(down.status, 503)
  assert.equal(down.body.token, undefined)
  T.world.fail = null
  // base en panne
  resetLicenseState()
  T.db.ctl.fail = 1
  assert.equal((await call(renewRoute, { token, device: DEV })).status, 503)
  // prix changé par erreur dans les réglages : aucun achat Pro trouvé, ce n'est pas une preuve
  resetLicenseState()
  const changed = await call(renewRoute, { token, device: DEV }, { env: sandboxEnv({ PADDLE_PRICE_ID: 'pri_nouveau' }) })
  assert.equal(changed.status, 503)
  assert.equal(changed.body.error, 'unavailable')
  // appareil absent de la base (aucune trace) : 503, pas 403
  T.db.sql('DELETE FROM devices')
  const unknownDevice = await call(renewRoute, { token, device: DEV })
  assert.equal(unknownDevice.status, 503)
  // client absent de la base : 503, sans aucun appel Paddle
  T.db.sql('DELETE FROM customers')
  const before = paddleCalls().length
  const unknownCus = await call(renewRoute, { token, device: DEV })
  assert.equal(unknownCus.status, 503)
  assert.equal(paddleCalls().length, before)
  assert.ok(customer)
})

// --- divers ---------------------------------------------------------------------------

test('aucune réponse ni journal ne contient de secret ni d’adresse', async () => {
  buyer()
  const outs = []
  outs.push((await call(claimRoute, { secret: SECRET, device: DEV })).text)
  T.world.fail = { status: 401, code: 'authentication_malformed' }
  resetLicenseState()
  outs.push((await call(claimRoute, { secret: SECRET, device: DEV })).text)
  outs.push((await call(startRoute, { email: 'ana@example.com' })).text)
  assertNoSecretLeak(assert, ...outs)
  for (const l of T.logs) assert.ok(!l.includes('ana@example.com'), 'pas d’adresse dans les journaux')
  for (const l of T.logs) assert.ok(!l.includes(SECRET), 'pas de secret de claim dans les journaux')
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
    join(ROOT, 'functions/api/withdraw.js'),
    join(ROOT, 'tools/license-keygen.mjs'),
    join(ROOT, 'docs/licence.md'),
    join(ROOT, 'docs/licence-schema.sql'),
    join(ROOT, 'site/js/pro.js'),
    join(ROOT, 'site/js/analytics.js'),
    join(ROOT, 'site/refund.html'),
  ]
  for (const f of files) assert.ok(!/[\u2013\u2014]/.test(readFileSync(f, 'utf8')), f)
  for (const f of walk(join(ROOT, 'functions/_lib/license'))) {
    assert.ok(!/export\s+(async\s+)?function\s+onRequest|export\s+(const|let)\s+onRequest/.test(readFileSync(f, 'utf8')), f)
  }
})
