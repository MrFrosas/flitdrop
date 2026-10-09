// Cloudflare Pages Function : POST /api/license/restore/start { email, lang }
// « J'ai déjà acheté » : envoie un code de 12 caractères (XXXX-XXXX-XXXX) par e-mail,
// SEULEMENT si cette adresse a un achat Pro valable chez Paddle.
//   200 { challenge }   toujours la même réponse, achat ou pas, et TOUT DE SUITE : la
//                       recherche chez Paddle et l'envoi se font après la réponse
//                       (waitUntil). Ni le contenu ni le temps de réponse ne trahissent
//                       donc si une adresse a acheté. Le défi est sans état (HMAC,
//                       15 minutes) ; le code n'est connu que de la boîte e-mail.
//   400 / 429 / 503     requête invalide / trop de demandes depuis cette IP ou pour
//                       cette adresse sur ce serveur / mode payant coupé
// Plafonds partagés (base D1), silencieux (même réponse, simplement pas d'e-mail) :
// 5 codes par heure et 10 par jour pour une adresse, 20 recherches Paddle par minute
// pour tout le site, 50 e-mails de restauration par jour (quota Resend partagé avec le
// formulaire de contact).
import { readLicenseEnv } from '../../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, readJsonBody, clientIp, normalizeEmail, normalizeLang, hitAll } from '../../../_lib/license/http.js'
import { createPaddle, purchaseForEmail } from '../../../_lib/license/paddle.js'
import { openDb, cleanupLater, bump } from '../../../_lib/license/db.js'
import { newRestoreCode, makeChallenge, emailHash } from '../../../_lib/license/crypto.js'
import { sendRestoreEmail } from '../../../_lib/license/mail.js'

const WINDOW = 15 * 60_000
export const RESTORE_LIMITS = {
  perEmailHour: 5,
  perEmailDay: 10,
  lookupsPerMinute: 20, // recherches Paddle, tous isolats confondus
  mailsPerDay: 50, // e-mails de restauration par jour (quota Resend : 100, partagé)
}

const shortErr = (err) => (err && (err.code || err.message) ? String(err.code || err.message).slice(0, 60) : 'error')

// Tout ce qui dépend de l'existence d'un achat, après la réponse.
async function sendIfBuyer(cfg, { email, typed, lang, code }) {
  const db = await openDb(cfg.db)
  await cleanupLater(db)
  const eh = await emailHash(email)
  if (!(await bump(db, `rs:eh:${eh}`, RESTORE_LIMITS.perEmailHour, 3600))) return
  if (!(await bump(db, `rs:ed:${eh}`, RESTORE_LIMITS.perEmailDay, 86400))) return
  if (!(await bump(db, 'rs:lookups', RESTORE_LIMITS.lookupsPerMinute, 60))) return

  const customer = await purchaseForEmail(createPaddle(cfg), cfg, typed, email)
  if (!customer) return
  if (!cfg.resendKey) {
    console.error('license restore: e-mail not configured (RESEND_API_KEY)')
    return
  }
  if (!(await bump(db, 'mail:restore', RESTORE_LIMITS.mailsPerDay, 86400))) {
    console.error('license restore: daily e-mail budget reached')
    return
  }
  // l'adresse enregistrée chez Paddle, jamais une autre
  await sendRestoreEmail(cfg, customer.email.trim(), lang, code)
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env, request)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const email = normalizeEmail(body && body.email)
  if (!email) return badRequest()
  const lang = normalizeLang(body.lang)

  // premières limites, en mémoire : elles ne dépendent que du nombre de demandes
  const wait = hitAll([
    [`rs:ip:${clientIp(request)}`, 10, WINDOW],
    [`rs:mail:${email}`, 3, WINDOW],
  ])
  if (wait) return tooMany(wait)

  // un code est tiré dans tous les cas : le défi renvoyé a exactement la même forme
  const code = newRestoreCode()
  const challenge = await makeChallenge(cfg, email, code)

  const work = sendIfBuyer(cfg, { email, typed: body.email, lang, code }).catch((err) =>
    console.error(`license restore: no e-mail (${err && err.name ? err.name : 'Error'} ${shortErr(err)})`),
  )
  if (typeof waitUntil === 'function') waitUntil(work)
  return json({ challenge })
}
