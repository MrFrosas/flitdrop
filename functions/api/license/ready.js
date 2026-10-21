// Cloudflare Pages Function : GET /api/license/ready
// Contrôle des réglages AVANT d'ouvrir la vente : chaque réglage est-il présent, du bon
// environnement, et la clé d'API Paddle a-t-elle vraiment les droits dont le serveur a
// besoin ? Ne donne jamais une valeur, seulement un mot par réglage ; n'ouvre rien et ne
// dépend pas de LICENSE_ENABLED. Réponse gardée 5 minutes (cache du site) et 10 appels
// par minute et par adresse au plus : on ne peut pas s'en servir pour marteler Paddle.
//
// checks.* : "ok", "missing" (absent), "wrong_env" (valeur de l'autre environnement),
// "invalid" (mal formé), "wrong_key" (clé de signature qui n'est pas celle de l'app),
// "denied" (Paddle refuse : droit manquant), "not_found" (prix ou remise inconnus de
// ce compte Paddle), "unavailable" (Paddle injoignable, à refaire plus tard).
import { readLicenseEnv, hostAllowed, decodeSigningKey } from '../../_lib/license/config.js'
import { publicKeyBase64 } from '../../_lib/license/crypto.js'
import { createPaddle, PaddleError } from '../../_lib/license/paddle.js'
import { json, methodNotAllowed, tooMany, clientIp, hit } from '../../_lib/license/http.js'

// Clés publiques embarquées dans l'app (packages/core/src/license-key.ts) : la clé de
// signature de chaque environnement doit être l'une de celles-ci, sinon aucun jeton ne
// serait accepté par l'app.
export const APP_PUBLIC_KEYS = {
  production: 'TkGgVAzKlDgcwcU4bDpbeOE/mdjAe5260x+h4pOiXDc=',
  sandbox: 'BVtEu9aF0iGk3vIZavLb/vsDogisjIX+PAPvYOf1g0Q=',
}

const word = (err) => {
  if (!(err instanceof PaddleError)) return 'unavailable'
  if (err.status === 401 || err.status === 403) return 'denied'
  if (err.status === 404 || err.code === 'not_found' || err.code === 'invalid_field' || err.code === 'entity_not_found') return 'not_found'
  return 'unavailable'
}

async function paddleChecks(cfg, checks) {
  const paddle = createPaddle(cfg, { budgetMs: 8000, maxCalls: 6 })
  const probe = async (name, fn) => {
    try {
      await fn()
      checks[name] = 'ok'
    } catch (err) {
      checks[name] = word(err)
    }
  }
  // les trois lectures dont le serveur a besoin, une page d'un élément chacune
  await probe('paddleReadTransactions', () => paddle.get('/transactions?per_page=1'))
  await probe('paddleReadCustomers', () => paddle.get('/customers?per_page=1'))
  await probe('paddleReadAdjustments', () => paddle.get('/adjustments?per_page=1'))
  // le prix affiché, comme sur la page /pro (et la remise de lancement si elle est réglée)
  const body = { items: [{ price_id: cfg.priceId, quantity: 1 }], address: { country_code: 'FR' } }
  await probe('paddlePrice', () => paddle.post('/pricing-preview', body))
  if (cfg.earlyDiscountId) await probe('paddleDiscount', () => paddle.post('/pricing-preview', { ...body, discount_id: cfg.earlyDiscountId }))
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  const wait = hit('ready:' + clientIp(request), 10, 60_000)
  if (wait) return tooMany(wait)

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null
  const cacheKey = new Request(new URL('/api/license/ready', request.url).toString())
  if (cache) {
    const hitRes = await cache.match(cacheKey).catch(() => null)
    if (hitRes) return hitRes
  }

  const cfg = readLicenseEnv(env, request)
  const paddleEnv = env && typeof env.PADDLE_ENV === 'string' ? env.PADDLE_ENV.trim() : ''
  let host = null
  try {
    host = new URL(request.url).hostname.toLowerCase()
  } catch {}
  const sandbox = paddleEnv === 'sandbox'
  const checks = {}

  checks.paddleEnv = !cfg.apiBase ? (paddleEnv ? 'invalid' : 'missing') : hostAllowed(paddleEnv, host) ? 'ok' : 'wrong_env'

  const apiKey = cfg.apiKey || ''
  checks.paddleApiKey = !apiKey
    ? 'missing'
    : (apiKey.startsWith('pdl_sdbx_') && !sandbox) || (apiKey.startsWith('pdl_live_') && sandbox)
      ? 'wrong_env'
      : apiKey.length < 16
        ? 'invalid'
        : 'ok'

  const token = cfg.clientToken || ''
  checks.paddleClientToken = !token
    ? 'missing'
    : (token.startsWith('test_') && !sandbox) || (token.startsWith('live_') && sandbox)
      ? 'wrong_env'
      : /^[A-Za-z0-9_]+$/.test(token)
        ? 'ok'
        : 'invalid'

  checks.paddlePriceId = !cfg.priceId ? 'missing' : /^pri_[a-z0-9]+$/.test(cfg.priceId) ? 'ok' : 'invalid'
  checks.paddleEarlyDiscountId = cfg.earlyDiscountId ? 'ok' : 'missing'

  const signing = cfg.signingKey || ''
  if (!signing) checks.licenseSigningKey = 'missing'
  else if (decodeSigningKey(signing) === null) checks.licenseSigningKey = 'invalid'
  else {
    let pub = null
    try {
      pub = await publicKeyBase64(signing)
    } catch {}
    const expected = APP_PUBLIC_KEYS[sandbox ? 'sandbox' : 'production']
    checks.licenseSigningKey = !pub ? 'invalid' : pub === expected ? 'ok' : pub === APP_PUBLIC_KEYS[sandbox ? 'production' : 'sandbox'] ? 'wrong_env' : 'wrong_key'
  }

  checks.resendApiKey = cfg.resendKey ? 'ok' : 'missing'
  checks.database = cfg.db ? 'ok' : 'missing'

  // Paddle n'est interrogé que si la clé et le prix sont plausibles
  if (cfg.apiBase && checks.paddleApiKey === 'ok' && checks.paddlePriceId === 'ok') await paddleChecks(cfg, checks)

  const ready = Object.values(checks).every((v) => v === 'ok')
  const res = json(
    {
      ready,
      saleOpen: cfg.enabled === true,
      launchedAt: cfg.launchedAt || null,
      env: cfg.paddleEnv || null,
      checks,
    },
    200,
    { 'cache-control': 'public, max-age=300' },
  )
  if (cache) await cache.put(cacheKey, res.clone()).catch(() => {})
  return res
}
