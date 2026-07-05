// Cloudflare Pages Function — POST /api/contact
// Reçoit le formulaire de contact du site et l'envoie par e-mail via Resend.
// Le secret RESEND_API_KEY est configuré dans Pages → Settings → Environment variables
// (jamais dans le code ni dans la page). Le message part vers la boîte de Thomas,
// avec Reply-To = l'adresse du visiteur pour répondre en un clic.

const MAIL_TO = 'thomasbidault.tb@gmail.com'
const MAIL_FROM = 'Flitdrop <contact@flitdrop.com>' // domaine vérifié dans Resend
const MAX = { name: 120, email: 180, message: 5000 }

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

// évite l'injection d'en-têtes dans le sujet (CRLF)
const oneLine = (v) => v.replace(/[\r\n]+/g, ' ')

const escapeHtml = (v) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export async function onRequestPost({ request, env }) {
  if (!env || !env.RESEND_API_KEY) {
    return json({ ok: false, error: 'server_not_configured' }, 500)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400)
  }

  // honeypot : un vrai humain laisse ce champ vide ; les bots le remplissent
  if (clean(body.company, 200)) return json({ ok: true }) // on fait comme si tout allait bien

  const name = clean(body.name, MAX.name)
  const email = clean(body.email, MAX.email)
  const message = clean(body.message, MAX.message)

  if (!name || !email || !message) return json({ ok: false, error: 'missing_fields' }, 422)
  if (!looksLikeEmail(email)) return json({ ok: false, error: 'bad_email' }, 422)
  if (message.length < 3) return json({ ok: false, error: 'message_too_short' }, 422)

  const subject = oneLine(`Flitdrop — message de ${name}`).slice(0, 180)
  const text = `${message}\n\n— ${name} <${email}>`
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f">` +
    `<p style="white-space:pre-wrap;margin:0 0 18px">${escapeHtml(message)}</p>` +
    `<hr style="border:none;border-top:1px solid #e5e5ea;margin:18px 0">` +
    `<p style="margin:0;color:#6e6e73;font-size:13px">${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;` +
    ` · <span>flitdrop.com</span></p></div>`

  let res
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [MAIL_TO],
        reply_to: [email],
        subject,
        text,
        html,
      }),
    })
  } catch {
    return json({ ok: false, error: 'send_failed' }, 502)
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json()).message || ''
    } catch {}
    return json({ ok: false, error: 'send_failed', detail }, 502)
  }

  return json({ ok: true })
}

// GET / autres méthodes : 405 (onRequestPost gère déjà POST)
export async function onRequest({ request }) {
  if (request.method === 'POST') return
  return json({ ok: false, error: 'method_not_allowed' }, 405)
}
