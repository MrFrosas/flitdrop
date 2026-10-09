// Cloudflare Pages Function : POST /api/license/checkout-done { transaction_id, claim }
// Appelé par la page /pro (js/pro.js) quand Paddle.js annonce checkout.completed :
// le navigateur connaît alors l'id de la transaction. On lit CETTE transaction chez
// Paddle (un seul appel, par son id), on vérifie qu'elle porte le prix Pro et ce
// claim (customData), et on la note dans la base D1 (claim -> transaction, et
// l'empreinte du client). L'app la retrouve ensuite en O(1) à son prochain appel
// de /api/license/claim, qui revérifie tout chez Paddle avant de donner un jeton.
//   200 { ok: true }   toujours la même réponse, transaction trouvée ou pas : ce point
//                      d'entrée ne donne jamais de jeton et ne dit rien d'un achat
//   400 / 429 / 503    requête invalide / trop de requêtes / Paddle ou base indisponibles
// Seules les transactions payées (paid ou completed) sont notées : une fenêtre de
// paiement ouverte puis abandonnée ne peut rien écraser.
import { readLicenseEnv } from '../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, isHex32, hitAll } from '../../_lib/license/http.js'
import { createPaddle, getTransaction, isProForClaim, isTxnId, PaddleError } from '../../_lib/license/paddle.js'
import { openDb, bump, purchaseByClaim, recordPurchase } from '../../_lib/license/db.js'
import { customerHash } from '../../_lib/license/crypto.js'

const LOOKUPS_PER_MINUTE = 30 // appels Paddle de ce point d'entrée, tous isolats confondus
const PAID = new Set(['paid', 'completed'])

const ok = () => json({ ok: true })

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env, request)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const txnId = body && body.transaction_id
  const claim = body && body.claim
  if (!isTxnId(txnId) || !isHex32(claim)) return badRequest()

  // la page envoie au plus 3 fois par achat
  const wait = hitAll([
    [`cd:ip:${clientIp(request)}`, 10, 60_000],
    [`cd:c:${claim}`, 6, 60_000],
  ])
  if (wait) return tooMany(wait)

  try {
    const db = await openDb(cfg.db)
    const known = await purchaseByClaim(db, claim)
    if (known && known.txn_id === txnId) return ok() // déjà noté : rien à demander à Paddle
    if (!(await bump(db, 'cd:lookups', LOOKUPS_PER_MINUTE, 60))) return ok()

    const paddle = createPaddle(cfg)
    let txn
    try {
      txn = await getTransaction(paddle, txnId)
    } catch (err) {
      // id inconnu ou refusé par Paddle : même réponse que tout le reste
      if (err instanceof PaddleError && (err.status === 404 || err.status === 400)) return ok()
      throw err
    }
    if (isProForClaim(txn, cfg, claim) && PAID.has(txn.status)) {
      await recordPurchase(db, { claim, txnId: txn.id, customerId: txn.customer_id, status: txn.status, cus: await customerHash(txn.customer_id) })
    }
    return ok()
  } catch (err) {
    return failClosed('checkout-done', err)
  }
}
