// Cloudflare Pages Function : POST /api/license/renew { token, device }
// L'app renouvelle son jeton (30 jours) quand il expire dans moins de 10 jours.
//   200 { token }               achat toujours valable et appareil toujours inscrit
//   403 { error: "revoked" }    jeton invalide ou d'un autre appareil, appareil sorti de la
//                               liste (6e appareil inscrit ailleurs), achat remboursé ou
//                               rétrofacturé
//   400 / 429 / 503             requête invalide / trop de requêtes / Paddle indisponible :
//                               l'app garde alors son jeton actuel et réessaie plus tard
// Un jeton expiré reste accepté (jusqu'à un an) : tout est revérifié chez Paddle.
import { readLicenseEnv } from '../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, isHex32, hitAll, nowSec } from '../../_lib/license/http.js'
import { createPaddle, findCustomerByCus, deviceRegistered, customerHasValidPurchase, touchDevice, rememberCustomer } from '../../_lib/license/paddle.js'
import { signToken, verifyToken, deviceHash } from '../../_lib/license/crypto.js'

const MAX_TOKEN_AGE_SEC = 365 * 86400
const revoked = () => json({ error: 'revoked' }, 403)

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const token = body && body.token
  const device = body && body.device
  if (typeof token !== 'string' || token.length > 2048 || !isHex32(device)) return badRequest()

  const wait = hitAll([
    [`renew:ip:${clientIp(request)}`, 60, 3600_000],
    [`renew:dev:${device}`, 10, 3600_000],
  ])
  if (wait) return tooMany(wait)

  let payload
  try {
    payload = await verifyToken(cfg, token)
  } catch (err) {
    return failClosed('renew', err)
  }
  if (!payload || payload.dev !== device || payload.exp < nowSec() - MAX_TOKEN_AGE_SEC) return revoked()

  try {
    const paddle = createPaddle(cfg)
    const customer = await findCustomerByCus(paddle, payload.cus)
    if (!customer) return revoked()
    rememberCustomer(payload.cus, customer.id)

    const d = await deviceHash(device)
    if (!deviceRegistered(customer, d)) return revoked()
    if (!(await customerHasValidPurchase(paddle, cfg, customer.id))) return revoked()

    await touchDevice(paddle, customer, d)
    return json({ token: await signToken(cfg, { device, customerId: customer.id }) })
  } catch (err) {
    return failClosed('renew', err)
  }
}
