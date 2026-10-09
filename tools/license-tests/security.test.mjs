// Tests de sécurité des licences : chaque attaque de la revue adversariale (preuves
// poc1 à poc4) rejouée ici doit échouer, plus les preuves de concurrence (plafonds
// tenus par la base D1 même sous 50 requêtes simultanées) et les bornes d'appels Paddle.
//   node --test tools/license-tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { resetLicenseState } from '../../functions/_lib/license/state.js'
import { readLicenseEnv } from '../../functions/_lib/license/config.js'
import { signToken, makeChallenge, newRestoreCode, formatCode } from '../../functions/_lib/license/crypto.js'
import { openDb } from '../../functions/_lib/license/db.js'
import { MAX_CALLS } from '../../functions/_lib/license/paddle.js'
import * as configRoute from '../../functions/api/license/config.js'
import * as claimRoute from '../../functions/api/license/claim.js'
import * as doneRoute from '../../functions/api/license/checkout-done.js'
import * as renewRoute from '../../functions/api/license/renew.js'
import * as startRoute from '../../functions/api/license/restore/start.js'
import * as verifyRoute from '../../functions/api/license/restore/verify.js'
import { addCustomer, addTransaction, addAdjustment } from './fake-paddle.mjs'
import {
  T, setup, teardown, shiftClock, call, decodeToken, paddleCalls, buyer, activeDevices, forgetInIsolateLimits,
  sandboxEnv, prodEnv, SANDBOX_KEY, PROD_KEY, PREVIEW_HOST, PROD_HOST,
  hex32, hex64, claimOf, DEV, SECRET, CLAIM,
} from './harness.mjs'

beforeEach(() => setup())
afterEach(() => teardown())

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// --- poc1 : achat sandbox gratuit -> jeton accepté par la production ---------------------

test('poc1 : un achat sandbox donne un jeton « sandbox », signé par la clé sandbox, inutilisable en production', async () => {
  buyer('pirate@example.com')
  const r = await call(claimRoute, { secret: SECRET, device: DEV }) // preview + sandbox, carte de test 4242
  assert.equal(r.status, 200)
  const sandboxToken = r.body.token
  assert.equal(decodeToken(sandboxToken, SANDBOX_KEY.public).payload.env, 'sandbox')
  // l'app publiée embarque la clé PUBLIQUE de production : la signature ne passe pas
  assert.equal(decodeToken(sandboxToken, PROD_KEY.public).valid, false)

  // production : le renouvellement refuse ce jeton, sans aucun appel Paddle
  const before = paddleCalls().length
  const renew = await call(renewRoute, { token: sandboxToken, device: DEV }, { env: prodEnv() })
  assert.deepEqual([renew.status, renew.body], [403, { error: 'revoked' }])
  assert.equal(paddleCalls().length, before)
})

test('poc1 : même avec la MÊME clé par erreur dans les deux environnements, la production refuse un jeton sandbox', async () => {
  buyer('pirate@example.com')
  const sandboxToken = (await call(claimRoute, { secret: SECRET, device: DEV }, { env: sandboxEnv({ LICENSE_SIGNING_KEY: PROD_KEY.signing }) })).body.token
  assert.ok(decodeToken(sandboxToken, PROD_KEY.public).valid, 'signature valable : seule la mention env le trahit')
  assert.equal(decodeToken(sandboxToken, PROD_KEY.public).payload.env, 'sandbox')
  const before = paddleCalls().length
  const renew = await call(renewRoute, { token: sandboxToken, device: DEV }, { env: prodEnv() })
  assert.deepEqual([renew.status, renew.body], [403, { error: 'revoked' }])
  assert.equal(paddleCalls().length, before)
})

test('poc1 : la sandbox ne répond jamais sur flitdrop.com, la production jamais ailleurs', async () => {
  const cases = [
    [sandboxEnv(), 'flitdrop.com', false],
    [sandboxEnv(), 'www.flitdrop.com', false],
    [sandboxEnv(), PREVIEW_HOST, true],
    [sandboxEnv(), 'localhost', true],
    [prodEnv(), 'flitdrop.com', true],
    [prodEnv(), 'www.flitdrop.com', true],
    [prodEnv(), PREVIEW_HOST, false],
    [prodEnv(), 'flitdrop.pages.dev', false],
    [prodEnv(), 'localhost', false],
  ]
  buyer()
  for (const [env, host, enabled] of cases) {
    resetLicenseState()
    const cfg = await call(configRoute, null, { method: 'GET', env, host })
    assert.equal(cfg.body.enabled, enabled, `${env.PADDLE_ENV} sur ${host}`)
    const claim = await call(claimRoute, { secret: SECRET, device: DEV }, { env, host })
    if (!enabled) assert.deepEqual([claim.status, claim.body.error], [503, 'disabled'], `${env.PADDLE_ENV} sur ${host}`)
  }
})

test('poc1 : un jeton dont le client est inconnu ne fait balayer aucun client Paddle (503, zéro appel)', async () => {
  for (let i = 0; i < 2000; i++) addCustomer(T.world, `p${i}@example.com`)
  const cfg = readLicenseEnv(prodEnv(), new Request(`https://${PROD_HOST}/`))
  const token = await signToken(cfg, { device: DEV, customerId: 'ctm_inconnu0000000000000000' })
  await openDb(T.db)
  for (let i = 0; i < 5; i++) {
    const r = await call(renewRoute, { token, device: DEV }, { env: prodEnv(), ip: `198.51.100.${i}` })
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'unavailable', 'pas un retrait : l’app garde son jeton')
  }
  assert.equal(paddleCalls().length, 0)
})

// --- poc2 : course sur le plafond de 5 appareils ------------------------------------------

test('le banc de test reproduit bien les courses : un « lire puis écrire » naïf dépasse le plafond', async () => {
  setup({ dbLatency: 15 })
  const db = await openDb(T.db)
  const naive = async (d) => {
    const n = (await db.prepare('SELECT count(*) AS n FROM claim_devices WHERE claim = ?1').bind(CLAIM).first()).n
    if (n >= 5) return false
    await db.prepare('INSERT INTO claim_devices (claim, device, at) VALUES (?1, ?2, 0)').bind(CLAIM, d).run()
    return true
  }
  const ok = (await Promise.all(Array.from({ length: 50 }, (_, i) => naive(hex32('n' + i))))).filter(Boolean).length
  assert.ok(ok > 5, `la base simulée laisse passer la course (${ok} > 5)`)
})

for (const n of [18, 50]) {
  test(`poc2 : ${n} claims simultanés sur un même achat -> 5 jetons au plus`, async () => {
    setup({ paddleLatency: 30, dbLatency: 15 })
    forgetInIsolateLimits() // pire cas : chaque requête sur son propre isolat
    const { customer, txn } = buyer('buyer@example.com')
    await call(doneRoute, { transaction_id: txn.id, claim: CLAIM }) // chemin rapide (base)
    const results = await Promise.all(Array.from({ length: n }, (_, i) => call(claimRoute, { secret: SECRET, device: hex32('race-dev-' + i) }, { ip: `198.51.100.${i}` })))
    const tokens = results.filter((r) => r.status === 200)
    assert.equal(tokens.length, 5, `${tokens.length} jetons`)
    assert.ok(results.every((r) => r.status === 200 || (r.status === 403 && r.body.error === 'claim_used')))
    assert.equal(T.db.rows('SELECT count(*) AS n FROM claim_devices WHERE claim = ?', CLAIM)[0].n, 5)
    assert.equal(activeDevices(customer.id).length, 5)
  })
}

test('poc2 : 50 claims simultanés par le balayage de secours (base vide) -> 5 jetons au plus', async () => {
  setup({ paddleLatency: 30, dbLatency: 15 })
  forgetInIsolateLimits()
  buyer('buyer@example.com')
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => call(claimRoute, { secret: SECRET, device: hex32('scan-dev-' + i) }, { ip: `198.51.100.${i}` })))
  assert.ok(results.filter((r) => r.status === 200).length <= 5)
  assert.equal(T.db.rows('SELECT count(*) AS n FROM claim_devices')[0].n, results.filter((r) => r.status === 200).length)
})

// --- poc3 : oracle de temps de restore/start ------------------------------------------------

test('poc3 : restore/start répond sans attendre Paddle (même réponse, même temps, achat ou pas)', async () => {
  // Paddle bloqué : la réponse arrive quand même, avant toute recherche
  buyer('buyer@example.com')
  let open
  const gate = new Promise((r) => (open = r))
  const inner = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input.url || input)).hostname.endsWith('paddle.com')) await gate
    return inner(input, init)
  }
  const a = await call(startRoute, { email: 'buyer@example.com' }, { deferWaits: true, ip: '203.0.113.1' })
  const b = await call(startRoute, { email: 'ghost@example.com' }, { deferWaits: true, ip: '203.0.113.2' })
  assert.deepEqual([a.status, b.status], [200, 200])
  assert.deepEqual(Object.keys(a.body), ['challenge'])
  assert.equal(a.body.challenge.length, b.body.challenge.length)
  assert.equal(T.world.emails.length, 0, 'rien n’est encore parti')
  open()
  await a.settle()
  await b.settle()
  assert.equal(T.world.emails.length, 1, 'l’e-mail part après la réponse, pour l’acheteur seulement')
  globalThis.fetch = inner
})

test('poc3 : avec 120 ms par appel Paddle, aucun écart de temps entre adresse acheteuse et inconnue', async () => {
  const sample = async (email, prep) => {
    const xs = []
    for (let i = 0; i < 5; i++) {
      setup({ paddleLatency: 120 })
      prep()
      const r = await call(startRoute, { email }, { ip: `203.0.113.${i + 10}` })
      xs.push(r.ms)
      teardown()
    }
    return median(xs)
  }
  const unknown = await sample('ghost@example.com', () => {})
  const known = await sample('buyer@example.com', () => buyer('buyer@example.com'))
  setup()
  assert.ok(unknown < 60 && known < 60, `réponses immédiates (${Math.round(unknown)} ms, ${Math.round(known)} ms)`)
  assert.ok(Math.abs(known - unknown) < 40, `écart ${Math.round(known - unknown)} ms`)
})

// --- poc4 : acheteur au-delà de la 10e page du balayage -------------------------------------

test('poc4 : 320 achats récents, l’acheteur en dernière page : débloqué grâce à checkout-done', async () => {
  for (let i = 0; i < 320; i++) {
    const c = addCustomer(T.world, `other${i}@example.com`)
    addTransaction(T.world, { customer: c, claim: hex32('noise' + i) })
  }
  const late = addCustomer(T.world, 'late-buyer@example.com')
  const t = addTransaction(T.world, { customer: late, claim: CLAIM })
  t.id = 'txn_' + '0'.repeat(26) // id le plus petit : trié en dernier
  // sans la page /pro (fermée trop tôt) : jamais un échec définitif, seulement « en attente »
  const early = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.deepEqual([early.status, early.body], [202, { pending: true }])
  assert.ok(paddleCalls().length <= MAX_CALLS)
  // la page /pro signale la transaction : retrouvée en O(1)
  assert.equal((await call(doneRoute, { transaction_id: t.id, claim: CLAIM })).status, 200)
  const before = paddleCalls().length
  const r = await call(claimRoute, { secret: SECRET, device: DEV })
  assert.equal(r.status, 200)
  assert.equal(paddleCalls().length - before, 2)
})

// --- restauration : usage unique, essais, plafonds -------------------------------------------

async function startAndGetCode(email = 'ana@example.com') {
  const r = await call(startRoute, { email }, { ip: '192.0.2.200' })
  const mail = T.world.emails.at(-1)
  return { challenge: r.body.challenge, code: mail.body.text.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/)[1] }
}

test('restore/verify : un code ne sert qu’une fois, même sur un autre isolat', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  assert.equal((await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV })).status, 200)
  resetLicenseState() // autre isolat : sa mémoire ne sait rien
  const again = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: hex32('x') }, { ip: '192.0.2.8' })
  assert.deepEqual(again.body, { error: 'expired' })
})

test('restore/verify : 50 vérifications simultanées du même code -> un seul jeton', async () => {
  setup({ paddleLatency: 20, dbLatency: 10 })
  forgetInIsolateLimits()
  buyer()
  const { challenge, code } = await startAndGetCode()
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => call(verifyRoute, { email: 'ana@example.com', code, challenge, device: hex32('same-code-' + i) }, { ip: `198.51.100.${i}` })),
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1)
})

test('restore/verify : 50 restaurations simultanées (codes distincts) -> 10 jetons au plus, 5 appareils actifs', async () => {
  setup({ paddleLatency: 20, dbLatency: 10 })
  forgetInIsolateLimits()
  const { customer } = buyer()
  const cfg = readLicenseEnv(sandboxEnv(), new Request(`https://${PREVIEW_HOST}/`))
  const attempts = await Promise.all(
    Array.from({ length: 50 }, async (_, i) => {
      const code = newRestoreCode()
      return { code: formatCode(code), challenge: await makeChallenge(cfg, 'ana@example.com', code), device: hex32('restore-' + i) }
    }),
  )
  const results = await Promise.all(attempts.map((a, i) => call(verifyRoute, { email: 'ana@example.com', ...a }, { ip: `198.51.100.${i}` })))
  const ok = results.filter((r) => r.status === 200).length
  assert.equal(ok, 10, `${ok} jetons`)
  assert.ok(results.every((r) => r.status === 200 || (r.status === 403 && r.body.error === 'too_many_devices')))
  assert.equal(activeDevices(customer.id).length, 5)
})

test('inscriptions : 10 nouveaux appareils par client sur 30 jours glissants, puis « too_many_devices »', async () => {
  const { customer, txn } = buyer()
  await call(doneRoute, { transaction_id: txn.id, claim: CLAIM }) // achat noté : le claim marche aussi après 48 h
  const cfg = readLicenseEnv(sandboxEnv(), new Request(`https://${PREVIEW_HOST}/`))
  const restore = async (seed, ip) => {
    resetLicenseState()
    const code = newRestoreCode()
    const challenge = await makeChallenge(cfg, 'ana@example.com', code)
    return call(verifyRoute, { email: 'ana@example.com', code, challenge, device: hex32(seed) }, { ip })
  }
  for (let i = 0; i < 10; i++) {
    shiftClock(i * 86400e3)
    assert.equal((await restore('d' + i, `192.0.2.${i}`)).status, 200)
  }
  shiftClock(10 * 86400e3)
  const refused = await restore('d10', '192.0.2.50')
  assert.deepEqual([refused.status, refused.body], [403, { error: 'too_many_devices' }])
  // un appareil encore actif se restaure toujours (pas une nouvelle inscription)
  assert.equal((await restore('d9', '192.0.2.51')).status, 200)
  // le claim est soumis au même plafond
  const viaClaim = await call(claimRoute, { secret: SECRET, device: hex32('d11') }, { ip: '192.0.2.52' })
  assert.deepEqual([viaClaim.status, viaClaim.body], [403, { error: 'too_many_devices' }])
  // 30 jours après la première inscription, une place se libère
  shiftClock(30 * 86400e3 + 3600e3)
  assert.equal((await restore('d10', '192.0.2.53')).status, 200)
  assert.equal(activeDevices(customer.id).length, 5)
})

test('restore/verify : les essais se comptent sur le nonce d’un défi authentique, pour tous les isolats', async () => {
  buyer()
  const { challenge, code } = await startAndGetCode()
  // nonces inventés : refusés avant tout comptage (aucun essai gagné)
  const [head, tag] = challenge.split('.')
  const p = JSON.parse(Buffer.from(head, 'base64url').toString())
  for (let i = 0; i < 20; i++) {
    resetLicenseState()
    const forged = Buffer.from(JSON.stringify({ ...p, n: hex32('n' + i) })).toString('base64url') + '.' + tag
    assert.deepEqual((await call(verifyRoute, { email: 'ana@example.com', code, challenge: forged, device: DEV }, { ip: `192.0.2.${i}` })).body, { error: 'code' })
  }
  assert.equal(T.db.rows("SELECT count(*) AS n FROM counters WHERE key LIKE 'rv:n:%'")[0].n, 0)
  // 5 mauvais essais répartis sur 5 isolats, puis le bon code : refusé
  for (let i = 0; i < 5; i++) {
    resetLicenseState()
    assert.equal((await call(verifyRoute, { email: 'ana@example.com', code: 'ZZZZ-ZZZZ-ZZZ' + i, challenge, device: DEV }, { ip: `198.51.100.${i}` })).status, 400)
  }
  resetLicenseState()
  const sixth = await call(verifyRoute, { email: 'ana@example.com', code, challenge, device: DEV }, { ip: '198.51.100.99' })
  assert.equal(sixth.status, 429, 'même le bon code est refusé après 5 essais sur ce défi')
})

// --- bornes d'appels Paddle --------------------------------------------------------------------

test('Paddle : nombre d’appels borné et petit pour chaque point d’entrée, même avec des données hostiles', async () => {
  // 30 clients avec la même adresse (casse variée), 70 achats chacun, des ajustements partout
  for (let i = 0; i < 30; i++) {
    const c = addCustomer(T.world, i % 2 ? 'HOSTILE@example.com' : 'hostile@example.com')
    for (let j = 0; j < 70; j++) {
      const t = addTransaction(T.world, { customer: c, claim: hex32(`h${i}-${j}`) })
      addAdjustment(T.world, t, { action: 'refund', status: 'approved', type: 'full' })
    }
  }
  const count = async (fn) => {
    resetLicenseState()
    const before = paddleCalls().length
    await fn()
    return paddleCalls().length - before
  }
  const start = await count(() => call(startRoute, { email: 'hostile@example.com' }))
  assert.ok(start <= 10, `restore/start : ${start} appels`)
  const scan = await count(() => call(claimRoute, { secret: hex64('inconnu'), device: DEV }))
  assert.ok(scan <= 12, `claim (balayage) : ${scan} appels`)
  const done = await count(() => call(doneRoute, { transaction_id: T.world.transactions[0].id, claim: hex32('h0-0') }))
  assert.ok(done <= 1, `checkout-done : ${done} appel`)
  for (const n of [start, scan, done]) assert.ok(n <= MAX_CALLS)
})

test('Paddle : des requêtes anonymes en rafale ne peuvent pas déclencher de 429 (budgets partagés)', async () => {
  // 200 claims aux secrets inventés, chacun « sur son propre isolat », en une minute
  for (let i = 0; i < 200; i++) {
    resetLicenseState()
    await call(claimRoute, { secret: hex64('flood' + i), device: DEV }, { ip: `10.0.${i >> 8}.${i & 255}` })
  }
  const claimCalls = paddleCalls().length
  assert.ok(claimCalls <= 10, `${claimCalls} appels pour 200 claims inventés`)
  // 200 demandes de code pour des adresses inventées
  for (let i = 0; i < 200; i++) {
    resetLicenseState()
    await call(startRoute, { email: `flood${i}@example.com` }, { ip: `10.1.${i >> 8}.${i & 255}` })
  }
  const startCalls = paddleCalls().length - claimCalls
  assert.ok(startCalls <= 2 * startRoute.RESTORE_LIMITS.lookupsPerMinute, `${startCalls} appels pour 200 adresses inventées`)
  // 200 checkout-done aux transactions inventées
  for (let i = 0; i < 200; i++) {
    resetLicenseState()
    await call(doneRoute, { transaction_id: `txn_flood${i}`, claim: hex32('f' + i) }, { ip: `10.2.${i >> 8}.${i & 255}` })
  }
  const doneCalls = paddleCalls().length - claimCalls - startCalls
  assert.ok(doneCalls <= 30, `${doneCalls} appels pour 200 transactions inventées`)
  // un claim authentique passe quand même par la base, sans balayage
  const { txn } = buyer('real@example.com', { secret: hex64('real') })
  shiftClock(61_000)
  resetLicenseState()
  await call(doneRoute, { transaction_id: txn.id, claim: claimOf(hex64('real')) }, { ip: '192.0.2.1' })
  assert.equal((await call(claimRoute, { secret: hex64('real'), device: DEV }, { ip: '192.0.2.1' })).status, 200)
})
