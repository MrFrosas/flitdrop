// Cloudflare Pages Function : POST /api/license/claim { claim, device }
// L'app ouvre flitdrop.com/pro?claim=<32 hex> ; la page passe ce claim à Paddle
// (customData) ; l'app interroge ici toutes les 5 s pendant le paiement.
//   200 { token }            achat Pro terminé de moins de 48 h portant ce claim
//   202 { pending: true }    rien encore (ou achat remboursé, ou autre prix)
//   403 { error: "claim_used" }  ce claim a déjà débloqué 5 appareils différents
//   400 / 429 / 503          requête invalide / trop de requêtes / Paddle indisponible
// L'appareil est inscrit chez le client Paddle (5 au plus, le plus ancien sort).
import { readLicenseEnv } from '../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, isHex32, hitAll } from '../../_lib/license/http.js'
import { createPaddle, findClaimTransaction, getCustomer, registerDevice, rememberCustomer } from '../../_lib/license/paddle.js'
import { signToken, deviceHash, customerHash } from '../../_lib/license/crypto.js'

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const claim = body && body.claim
  const device = body && body.device
  if (!isHex32(claim) || !isHex32(device)) return badRequest()

  // l'app interroge toutes les 5 s (12 par minute) : de la marge, pas plus
  const wait = hitAll([
    [`claim:ip:${clientIp(request)}`, 40, 60_000],
    [`claim:c:${claim}`, 20, 60_000],
  ])
  if (wait) return tooMany(wait)

  try {
    const paddle = createPaddle(cfg)
    const txn = await findClaimTransaction(paddle, cfg, claim)
    if (!txn) return json({ pending: true }, 202)

    const customer = await getCustomer(paddle, txn.customer_id)
    const { refused } = await registerDevice(paddle, customer, await deviceHash(device), { txnId: txn.id })
    if (refused) return json({ error: 'claim_used' }, 403)

    rememberCustomer(await customerHash(customer.id), customer.id)
    return json({ token: await signToken(cfg, { device, customerId: customer.id }) })
  } catch (err) {
    return failClosed('claim', err)
  }
}
