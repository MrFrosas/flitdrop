// Cloudflare Pages Function : POST /api/license/renew { token, device }
// L'app renouvelle son jeton (30 jours) quand il expire dans moins de 10 jours.
//   200 { token }               achat toujours valable et appareil toujours actif
//   403 { error: "revoked" }    seulement sur une preuve : jeton invalide, d'un autre
//                               appareil ou d'un autre environnement (sandbox contre
//                               production), appareil sorti de la liste (un 6e inscrit
//                               ensuite), achats remboursés ou rétrofacturés
//   400 / 429                   requête invalide / trop de requêtes
//   503                         Paddle ou base indisponibles, ou état impossible à
//                               établir (client ou appareil inconnus de la base, aucun
//                               achat trouvé) : jamais un retrait. L'app garde son jeton
//                               jusqu'à l'expiration, puis « J'ai déjà acheté ».
// O(1) : l'empreinte « cus » du jeton donne l'id client Paddle par la base D1 (notée au
// déblocage), puis 2 à 4 appels Paddle (achats du client et leurs ajustements).
// Un jeton expiré reste accepté (jusqu'à un an) : tout est revérifié.
import { readLicenseEnv } from '../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, undetermined, failClosed, readJsonBody, clientIp, isHex32, hitAll, nowSec } from '../../_lib/license/http.js'
import { createPaddle, customerPurchaseState } from '../../_lib/license/paddle.js'
import { openDb, customerIdByCus, deviceState, touchDevice } from '../../_lib/license/db.js'
import { signToken, verifyToken, deviceHash } from '../../_lib/license/crypto.js'

const MAX_TOKEN_AGE_SEC = 365 * 86400
const revoked = () => json({ error: 'revoked' }, 403)

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env, request)
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
  if (!payload || payload.env !== cfg.paddleEnv || payload.dev !== device || payload.exp < nowSec() - MAX_TOKEN_AGE_SEC) return revoked()

  try {
    const db = await openDb(cfg.db)
    const customerId = await customerIdByCus(db, payload.cus)
    if (!customerId) return undetermined() // jamais de balayage des clients Paddle

    const d = await deviceHash(device)
    const st = await deviceState(db, customerId, d)
    if (st === 'evicted') return revoked()
    if (st !== 'active') return undetermined()

    const paddle = createPaddle(cfg)
    const purchase = await customerPurchaseState(paddle, cfg, customerId)
    if (purchase === 'revoked') return revoked()
    if (purchase !== 'valid') {
      console.error('license renew: no purchase found for a known customer')
      return undetermined()
    }

    // « vu maintenant » : un appareil qui sert ne devient pas « le moins récemment vu »
    if (!(await touchDevice(db, customerId, d))) return revoked()
    return json({ token: await signToken(cfg, { device, customerId }) })
  } catch (err) {
    return failClosed('renew', err)
  }
}
