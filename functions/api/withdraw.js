// Cloudflare Pages Function : POST /api/withdraw { name, email, order?, lang }
// Fonction de rétractation exigée par la loi (directive 2023/2673 ; en France, art.
// L221-21 et D221-5 du Code de la consommation, en vigueur depuis le 19 juin 2026 ;
// en Allemagne, § 356a BGB), formulaire « Renoncer au contrat ici » de /refund#withdraw.
// Exactement trois champs, jamais de motif (la loi allemande interdit de le demander).
//   200 { ok: true, receivedAt }  toujours la même réponse pour une demande bien formée
//   400 / 429 / 503               requête invalide / trop de demandes depuis cette IP /
//                                 base D1 ou Resend absents (la page propose alors
//                                 Paddle et l'e-mail)
// Après la réponse (waitUntil) : la rétractation est notée dans la base D1 avec sa date
// et son heure de réception (preuve), un accusé de réception part vers l'adresse TAPÉE
// (les trois champs, « reçue le ... à ... (heure de Paris) », remboursement par Paddle
// sous 14 jours) et une copie vers notre boîte. Aucun remboursement automatique : la
// clé Paddle est en lecture seule, le remboursement se fait à la main dans Paddle.
// Marche même quand le mode payant est coupé : un achat passé se rétracte toujours.
// Anti-abus (l'accusé ne part qu'à l'adresse tapée, au plus 2 fois par jour : il ne
// peut pas servir à écrire en masse à quelqu'un) : 5 demandes par heure et par IP
// (mémoire), 2 accusés par jour et par adresse, 10 rétractations avec e-mails par jour
// pour tout le site (20 e-mails, quota Resend partagé), 200 notées par jour.
import { readMailEnv } from '../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, unavailable, readJsonBody, clientIp, normalizeEmail, normalizeLang, hitAll, nowSec } from '../_lib/license/http.js'
import { openDb, bump, recordWithdrawal, markWithdrawalAcknowledged } from '../_lib/license/db.js'
import { emailHash, randomHex } from '../_lib/license/crypto.js'
import { sendEmail, withdrawalAckEmail, withdrawalCopyEmail, OWNER_ADDRESS } from '../_lib/license/mail.js'

export const WITHDRAW_LIMITS = {
  perIpHour: 5,
  acksPerEmailDay: 2,
  mailedPerDay: 10, // rétractations qui déclenchent des e-mails (accusé + copie), tout le site
  recordedPerDay: 200, // rétractations notées en base, tout le site
}
const MAX_NAME = 120
const MAX_ORDER = 100

// Champ texte d'une ligne : caractères de contrôle retirés, espaces resserrés, borné.
// '' si absent, null si le type est faux.
function line(v, max) {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') return null
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

const errName = (err) => (err && err.name ? err.name : 'Error') + (err && err.code ? ' ' + String(err.code).slice(0, 40) : '')

async function handle(mcfg, w) {
  const db = await openDb(mcfg.db)
  if (!(await bump(db, 'wd:recorded', WITHDRAW_LIMITS.recordedPerDay, 86400))) {
    console.error('license withdraw: daily cap reached, not recorded')
    return
  }
  await recordWithdrawal(db, w)
  if (!(await bump(db, 'mail:withdraw', WITHDRAW_LIMITS.mailedPerDay, 86400))) {
    console.error('license withdraw: daily e-mail budget reached (withdrawal recorded)')
    return
  }
  w.acked = false
  if (await bump(db, `wd:ack:${await emailHash(w.email)}`, WITHDRAW_LIMITS.acksPerEmailDay, 86400)) {
    try {
      await sendEmail(mcfg.resendKey, { to: w.email, ...withdrawalAckEmail(w.lang, w) })
      w.acked = true
      await markWithdrawalAcknowledged(db, w.id)
    } catch (err) {
      console.error(`license withdraw: acknowledgement not sent (${errName(err)})`)
    }
  }
  await sendEmail(mcfg.resendKey, { to: OWNER_ADDRESS, replyTo: w.email, ...withdrawalCopyEmail(w) })
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const mcfg = readMailEnv(env)
  if (!mcfg.db || !mcfg.resendKey) return unavailable()

  const body = await readJsonBody(request)
  const email = normalizeEmail(body && body.email)
  const name = body ? line(body.name, MAX_NAME) : null
  const orderRef = body ? line(body.order, MAX_ORDER) : null
  if (!email || !name || orderRef === null) return badRequest()
  const lang = normalizeLang(body.lang)

  const wait = hitAll([[`wd:ip:${clientIp(request)}`, WITHDRAW_LIMITS.perIpHour, 3600_000]])
  if (wait) return tooMany(wait)

  const receivedAt = nowSec()
  const w = { id: randomHex(16), receivedAt, name, email, orderRef, lang }
  const work = handle(mcfg, w).catch((err) => console.error(`license withdraw: ${errName(err)}`))
  if (typeof waitUntil === 'function') waitUntil(work)
  return json({ ok: true, receivedAt: new Date(receivedAt * 1000).toISOString() })
}
