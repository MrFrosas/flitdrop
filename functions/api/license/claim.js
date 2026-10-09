// Cloudflare Pages Function : POST /api/license/claim { secret, device }
// L'app tire un secret (claimSecret, 64 hexadécimaux) qu'elle garde pour elle, et
// ouvre flitdrop.com/pro?claim=<32 premiers hex de sha256("flitdrop-claim-v1:" + secret)>.
// La page passe ce claim à Paddle (customData) puis, une fois payé, signale la
// transaction à /api/license/checkout-done. L'app interroge ici toutes les 5 s avec
// le SECRET : le serveur recalcule le claim, si bien qu'une adresse /pro qui fuiterait
// (historique, outil de mesure) ne débloque rien.
//   200 { token }                     achat Pro terminé (completed) portant ce claim,
//                                     ni remboursé ni rétrofacturé
//   202 { pending: true }             rien encore (pas payé, pas encore terminé, remboursé,
//                                     ou balayage de secours incomplet : jamais définitif)
//   403 { error: "claim_used" }       ce claim a déjà débloqué 5 appareils différents
//   403 { error: "too_many_devices" } plus de 10 nouveaux appareils en 30 jours pour cet achat
//   400 / 429 / 503                   requête invalide / trop de requêtes / Paddle ou base indisponibles
// Achat retrouvé en O(1) dans la base D1 (noté par checkout-done) ; sans ligne en base
// (page fermée trop tôt), balayage de secours des transactions des 48 dernières heures,
// plafonné pour tous les isolats ensemble.
import { readLicenseEnv } from '../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, isHex32, isHex64, hitAll, nowSec } from '../../_lib/license/http.js'
import { createPaddle, getTransaction, adjustmentsFor, transactionRevoked, isProForClaim, findClaimTransaction } from '../../_lib/license/paddle.js'
import { openDb, cleanupLater, bump, purchaseByClaim, recordPurchase, markPurchase, rememberCustomer, registerDevice } from '../../_lib/license/db.js'
import { signToken, deviceHash, customerHash, claimFromSecret } from '../../_lib/license/crypto.js'

const RECHECK_SEC = 4 // pas encore terminé : Paddle n'est pas réinterrogé avant 4 s (cache partagé)
const SCANS_PER_MINUTE = 10 // balayages de secours, tous isolats confondus

const pending = () => json({ pending: true }, 202)

// L'achat de ce claim, vérifié chez Paddle : { txn } ou null (en attente).
async function findPurchase(db, paddle, cfg, claim) {
  const row = await purchaseByClaim(db, claim)
  if (row) {
    const settled = row.status === 'completed' && !row.revoked
    if (!settled && nowSec() - Number(row.checked_at) < RECHECK_SEC) return null
    const txn = await getTransaction(paddle, row.txn_id)
    if (!isProForClaim(txn, cfg, claim) || txn.customer_id !== row.customer_id) {
      await markPurchase(db, claim, row.txn_id, { status: String(txn.status || 'unknown'), revoked: true })
      return null
    }
    // « completed » seulement : « paid » n'est pas encore l'état final chez Paddle
    if (txn.status !== 'completed') {
      await markPurchase(db, claim, row.txn_id, { status: String(txn.status || 'unknown'), revoked: false })
      return null
    }
    const adjustments = await adjustmentsFor(paddle, [txn.id])
    const revoked = transactionRevoked(txn, adjustments, cfg.priceId)
    if (revoked || !settled) await markPurchase(db, claim, row.txn_id, { status: 'completed', revoked })
    return revoked ? null : txn
  }

  // Secours : pas de ligne en base. Jamais plus de SCANS_PER_MINUTE balayages par
  // minute pour tout le site (un claim inventé ne peut pas faire marteler Paddle).
  const { txn } = await findClaimTransaction(paddle, cfg, claim, () => bump(db, 'claim:scan', SCANS_PER_MINUTE, 60))
  if (!txn) return null
  await recordPurchase(db, { claim, txnId: txn.id, customerId: txn.customer_id, status: 'completed', cus: await customerHash(txn.customer_id) })
  return txn
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env, request)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const secret = body && body.secret
  const device = body && body.device
  if (!isHex64(secret) || !isHex32(device)) return badRequest()
  const claim = await claimFromSecret(secret)

  // l'app interroge toutes les 5 s (12 par minute) : de la marge, pas plus
  const wait = hitAll([
    [`claim:ip:${clientIp(request)}`, 40, 60_000],
    [`claim:c:${claim}`, 20, 60_000],
  ])
  if (wait) return tooMany(wait)

  try {
    const db = await openDb(cfg.db)
    cleanupLater(db, waitUntil)
    const paddle = createPaddle(cfg)
    const txn = await findPurchase(db, paddle, cfg, claim)
    if (!txn) return pending()

    await rememberCustomer(db, await customerHash(txn.customer_id), txn.customer_id)
    const verdict = await registerDevice(db, { customerId: txn.customer_id, device: await deviceHash(device), claim })
    if (verdict !== 'ok') return json({ error: verdict }, 403)

    return json({ token: await signToken(cfg, { device, customerId: txn.customer_id }) })
  } catch (err) {
    return failClosed('claim', err)
  }
}
