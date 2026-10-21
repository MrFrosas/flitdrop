// Contrôle des réglages avant l'ouverture de la vente : GET /api/license/ready
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import * as readyRoute from '../../functions/api/license/ready.js'
import { T, setup, teardown, call, paddleCalls, assertNoSecretLeak, prodEnv, sandboxEnv, API_KEY } from './harness.mjs'

beforeEach(() => setup())
afterEach(() => teardown())

const get = (env, opts = {}) => call(readyRoute, null, { method: 'GET', env, ...opts })

test('ready : chaque réglage contrôlé, droits Paddle vérifiés, aucune valeur rendue', async () => {
  const r = await get(prodEnv())
  assert.equal(r.status, 200)
  const c = r.body.checks
  for (const k of ['paddleEnv', 'paddleApiKey', 'paddleClientToken', 'paddlePriceId', 'paddleEarlyDiscountId', 'resendApiKey', 'database',
    'paddleReadTransactions', 'paddleReadCustomers', 'paddleReadAdjustments', 'paddlePrice', 'paddleDiscount']) {
    assert.equal(c[k], 'ok', k)
  }
  // clé de signature de test : valide mais ce n'est pas celle embarquée dans l'app
  assert.equal(c.licenseSigningKey, 'wrong_key')
  assert.equal(r.body.ready, false)
  assert.equal(r.body.saleOpen, true)
  assert.ok(paddleCalls().length <= 6)
  assertNoSecretLeak(assert, r.text)
})

test('ready : ne dépend pas de LICENSE_ENABLED et signale ce qui manque', async () => {
  const r = await get(prodEnv({ LICENSE_ENABLED: undefined, PADDLE_CLIENT_TOKEN: undefined, RESEND_API_KEY: undefined, PADDLE_EARLY_DISCOUNT_ID: undefined }))
  assert.equal(r.body.saleOpen, false)
  assert.equal(r.body.checks.paddleClientToken, 'missing')
  assert.equal(r.body.checks.resendApiKey, 'missing')
  assert.equal(r.body.checks.paddleEarlyDiscountId, 'missing')
  assert.equal(r.body.checks.paddleReadTransactions, 'ok')
  assert.equal(r.body.checks.paddleDiscount, undefined)
})

test('ready : valeurs de l’autre environnement repérées, sans appeler Paddle', async () => {
  const r = await get(prodEnv({ PADDLE_API_KEY: API_KEY, PADDLE_CLIENT_TOKEN: 'test_0123456789abcdef0123456789a' }))
  assert.equal(r.body.checks.paddleApiKey, 'wrong_env')
  assert.equal(r.body.checks.paddleClientToken, 'wrong_env')
  assert.equal(r.body.checks.paddleReadTransactions, undefined)
  assert.equal(paddleCalls().length, 0)
})

test('ready : la sandbox servie sur flitdrop.com et une clé illisible sont refusées', async () => {
  const r = await get(sandboxEnv({ LICENSE_SIGNING_KEY: 'pas-une-cle' }), { host: 'flitdrop.com' })
  assert.equal(r.body.checks.paddleEnv, 'wrong_env')
  assert.equal(r.body.checks.licenseSigningKey, 'invalid')
  assert.equal(r.body.ready, false)
})

test('ready : prix inconnu de Paddle et plafond de 10 appels par minute', async () => {
  const r = await get(prodEnv({ PADDLE_PRICE_ID: 'pri_inconnu' }))
  assert.equal(r.body.checks.paddlePrice, 'not_found')
  let last = null
  for (let i = 0; i < 10; i++) last = await get(prodEnv(), { ip: '198.51.100.9' })
  assert.equal(last.status, 200)
  const over = await get(prodEnv(), { ip: '198.51.100.9' })
  assert.equal(over.status, 429)
  assert.ok(T.logs.every((l) => !l.includes('pdl_')))
})
