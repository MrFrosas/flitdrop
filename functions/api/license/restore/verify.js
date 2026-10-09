// Cloudflare Pages Function : POST /api/license/restore/verify { email, code, challenge, device }
//   200 { token }                     bon code : l'appareil est inscrit (5 actifs au plus,
//                                     le moins récemment vu sort)
//   400 { error: "code" }             code faux, défi falsifié ou d'une autre adresse
//   400 { error: "expired" }          plus de 15 minutes, ou code déjà utilisé (partout :
//                                     la base D1 garde les codes utilisés)
//   400 { error: "nopurchase" }       bon code, mais plus d'achat valable (remboursé entre-temps)
//   403 { error: "too_many_devices" } plus de 10 nouveaux appareils en 30 jours pour cet achat
//   400 / 429 / 503                   requête invalide / trop d'essais / Paddle ou base indisponibles
// Code : casse, tirets et espaces ignorés. Comparaison à temps constant.
// Ordre des contrôles : le défi doit d'abord avoir été émis par ce serveur pour cette
// adresse (HMAC de l'en-tête) ; alors seulement on compte un essai sur son nonce
// (5 par défi, dans la base), puis on compare le code. Inventer des nonces ne donne
// donc aucun essai de plus.
import { readLicenseEnv } from '../../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, normalizeEmail, isHex32, hitAll, nowSec } from '../../../_lib/license/http.js'
import { createPaddle, purchaseForEmail } from '../../../_lib/license/paddle.js'
import { openDb, bumpKey, claimNonce, releaseNonce, rememberCustomer, registerDevice } from '../../../_lib/license/db.js'
import { signToken, deviceHash, customerHash, normalizeCode, readChallenge, challengeIssued, challengeCodeOk } from '../../../_lib/license/crypto.js'

const WINDOW = 15 * 60_000
const TRIES_PER_CHALLENGE = 5
const err400 = (error) => json({ error }, 400)

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env, request)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const email = normalizeEmail(body && body.email)
  const device = body && body.device
  if (!email || !isHex32(device) || typeof body.code !== 'string' || typeof body.challenge !== 'string') return badRequest()

  const wait = hitAll([
    [`rv:ip:${clientIp(request)}`, 20, WINDOW],
    [`rv:mail:${email}`, 10, WINDOW],
  ])
  if (wait) return tooMany(wait)

  let parsed
  try {
    parsed = readChallenge(body.challenge)
    if (!parsed || !(await challengeIssued(cfg, parsed, email))) return err400('code')
  } catch (err) {
    return failClosed('restore/verify', err)
  }
  if (parsed.x < nowSec()) return err400('expired')

  let db
  let nonceTaken = false
  try {
    db = await openDb(cfg.db)
    // essais comptés sur le nonce d'un défi authentique, pour tous les isolats
    if (!(await bumpKey(db, `rv:n:${parsed.n}`, TRIES_PER_CHALLENGE, parsed.x + 60))) return tooMany(Math.max(1, parsed.x - nowSec()))

    const code = normalizeCode(body.code)
    if (!code || !(await challengeCodeOk(cfg, parsed, email, code))) return err400('code')

    // usage unique, partout : la première requête qui prend le nonce gagne
    if (!(await claimNonce(db, parsed.n, parsed.x + 60))) return err400('expired')
    nonceTaken = true

    const customer = await purchaseForEmail(createPaddle(cfg), cfg, body.email, email)
    if (!customer) return err400('nopurchase')
    await rememberCustomer(db, await customerHash(customer.id), customer.id)
    const verdict = await registerDevice(db, { customerId: customer.id, device: await deviceHash(device) })
    if (verdict !== 'ok') return json({ error: verdict }, 403)

    const token = await signToken(cfg, { device, customerId: customer.id })
    nonceTaken = false // délivré : le code reste consommé
    return json({ token })
  } catch (err) {
    // panne passagère après avoir pris le code : il redevient utilisable
    if (nonceTaken && db) await releaseNonce(db, parsed.n)
    return failClosed('restore/verify', err)
  }
}
