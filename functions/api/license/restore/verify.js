// Cloudflare Pages Function : POST /api/license/restore/verify { email, code, challenge, device }
//   200 { token }                     bon code : l'appareil est inscrit (5 au plus, le plus ancien sort)
//   400 { error: "code" }             code faux ou défi falsifié
//   400 { error: "expired" }          plus de 15 minutes, ou code déjà utilisé ici
//   400 { error: "nopurchase" }       bon code, mais plus d'achat valable (remboursé entre-temps)
//   400 / 429 / 503                   requête invalide / trop d'essais / Paddle indisponible
// Code : casse, tirets et espaces ignorés. Comparaison à temps constant.
import { readLicenseEnv } from '../../../_lib/license/config.js'
import { json, methodNotAllowed, badRequest, tooMany, disabled, failClosed, readJsonBody, clientIp, normalizeEmail, isHex32, hit, hitAll, nowMs } from '../../../_lib/license/http.js'
import { createPaddle, purchaseForEmail, registerDevice, rememberCustomer } from '../../../_lib/license/paddle.js'
import { signToken, deviceHash, customerHash, normalizeCode, readChallenge, checkChallenge } from '../../../_lib/license/crypto.js'
import { state } from '../../../_lib/license/state.js'

const WINDOW = 15 * 60_000
const err400 = (error) => json({ error }, 400)

// Un code qui a servi n'est plus accepté par cet isolat (au mieux : sans base de
// données, un autre isolat l'accepterait encore jusqu'à son expiration).
function markUsed(nonce, expiresSec) {
  const t = nowMs()
  if (state.usedNonces.size > 5000) for (const [n, exp] of state.usedNonces) if (exp <= t) state.usedNonces.delete(n)
  if (state.usedNonces.size > 5000) state.usedNonces.clear()
  state.usedNonces.set(nonce, expiresSec * 1000)
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const cfg = readLicenseEnv(env)
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

  try {
    const parsed = readChallenge(body.challenge)
    if (!parsed) return err400('code')
    const tries = hit(`rv:n:${parsed.n}`, 5, WINDOW)
    if (tries) return tooMany(tries)

    const code = normalizeCode(body.code)
    if (parsed.x * 1000 < nowMs()) return err400('expired')
    if (!code) return err400('code')
    const verdict = await checkChallenge(cfg, parsed, email, code)
    if (verdict !== 'ok') return err400(verdict)
    if (state.usedNonces.has(parsed.n)) return err400('expired')

    const paddle = createPaddle(cfg)
    const customer = await purchaseForEmail(paddle, cfg, body.email, email)
    if (!customer) return err400('nopurchase')
    await registerDevice(paddle, customer, await deviceHash(device))
    markUsed(parsed.n, parsed.x)

    rememberCustomer(await customerHash(customer.id), customer.id)
    return json({ token: await signToken(cfg, { device, customerId: customer.id }) })
  } catch (err) {
    return failClosed('restore/verify', err)
  }
}
