// Cloudflare Pages Function : POST /api/license/restore/start { email, lang }
// « J'ai déjà acheté » : envoie un code de 12 caractères (XXXX-XXXX-XXXX) par e-mail,
// SEULEMENT si cette adresse a un achat Pro valable chez Paddle.
//   200 { challenge }   toujours la même réponse, achat ou pas : la page ne révèle
//                       jamais si une adresse a acheté. Le défi est sans état (HMAC,
//                       15 minutes) ; le code n'est connu que de la boîte e-mail.
//   400 / 429 / 503     requête invalide / trop de demandes / Paddle indisponible
// L'envoi part après la réponse (waitUntil) : le temps de réponse ne trahit pas non
// plus l'existence d'un achat.
import { readLicenseEnv } from '../../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, normalizeEmail, normalizeLang, hitAll, nowMs } from '../../../_lib/license/http.js'
import { createPaddle, purchaseForEmail } from '../../../_lib/license/paddle.js'
import { newRestoreCode, makeChallenge } from '../../../_lib/license/crypto.js'
import { sendRestoreEmail } from '../../../_lib/license/mail.js'
import { state } from '../../../_lib/license/state.js'

const WINDOW = 15 * 60_000
const MAILS_PER_HOUR = 100 // plafond global par isolat, contre l'envoi en masse

function mailBudget() {
  const t = nowMs()
  if (state.mailsSent.reset <= t) state.mailsSent = { n: 0, reset: t + 3600_000 }
  return ++state.mailsSent.n <= MAILS_PER_HOUR
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env)
  if (!cfg.enabled) return disabled()

  const body = await readJsonBody(request)
  const email = normalizeEmail(body && body.email)
  if (!email) return badRequest()
  const lang = normalizeLang(body.lang)

  const wait = hitAll([
    [`rs:ip:${clientIp(request)}`, 10, WINDOW],
    [`rs:mail:${email}`, 3, WINDOW],
  ])
  if (wait) return tooMany(wait)

  try {
    const paddle = createPaddle(cfg)
    const customer = await purchaseForEmail(paddle, cfg, body.email, email)
    // un code est tiré même sans achat : le défi renvoyé a exactement la même forme
    const code = newRestoreCode()
    const challenge = await makeChallenge(cfg, email, code)

    if (customer && mailBudget()) {
      // l'adresse enregistrée chez Paddle, jamais une autre
      const sending = sendRestoreEmail(cfg, customer.email.trim(), lang, code).catch((err) =>
        console.error(`license restore: e-mail not sent (${err && err.message ? String(err.message).slice(0, 60) : 'error'})`),
      )
      if (typeof waitUntil === 'function') waitUntil(sending)
      else await sending
    }
    return json({ challenge })
  } catch (err) {
    return failClosed('restore/start', err)
  }
}
