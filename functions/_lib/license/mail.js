// Licences Flitdrop Pro : e-mail du code de restauration, envoyé par Resend
// (même compte et même expéditeur que functions/api/contact.js).
import { formatCode } from './crypto.js'

const MAIL_FROM = 'Flitdrop <contact@flitdrop.com>' // domaine vérifié dans Resend

const TEXTS = {
  fr: {
    subject: (c) => `Ton code Flitdrop : ${c}`,
    hello: 'Bonjour,',
    intro: 'Voici ton code pour retrouver Flitdrop Pro sur ton ordinateur :',
    use: 'Recopie-le dans Flitdrop. Il reste valable 15 minutes.',
    ignore: "Si tu n'as rien demandé, ignore ce message : ton achat ne change pas.",
  },
  de: {
    subject: (c) => `Dein Flitdrop-Code: ${c}`,
    hello: 'Hallo,',
    intro: 'hier ist dein Code, um Flitdrop Pro auf deinem Computer wiederherzustellen:',
    use: 'Gib ihn in Flitdrop ein. Er gilt 15 Minuten.',
    ignore: 'Falls du ihn nicht angefordert hast, ignoriere diese E-Mail einfach: An deinem Kauf ändert sich nichts.',
  },
  en: {
    subject: (c) => `Your Flitdrop code: ${c}`,
    hello: 'Hi,',
    intro: 'Here is your code to get Flitdrop Pro back on your computer:',
    use: 'Type it in Flitdrop. It works for 15 minutes.',
    ignore: 'If you did not ask for it, just ignore this e-mail: your purchase does not change.',
  },
}

export function restoreEmail(lang, code) {
  const t = TEXTS[lang] || TEXTS.en
  const shown = formatCode(code) // seulement [0-9A-Z-] : rien à échapper dans le HTML
  const text = `${t.hello}\n\n${t.intro}\n\n${shown}\n\n${t.use}\n\n${t.ignore}\n\nFlitdrop\nhttps://flitdrop.com`
  const p = 'margin:0 0 16px'
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f">` +
    `<p style="${p}">${t.hello}</p>` +
    `<p style="${p}">${t.intro}</p>` +
    `<p style="margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;font-weight:600;letter-spacing:3px">${shown}</p>` +
    `<p style="${p}">${t.use}</p>` +
    `<p style="margin:0 0 18px;color:#6e6e73">${t.ignore}</p>` +
    `<hr style="border:none;border-top:1px solid #e5e5ea;margin:18px 0">` +
    `<p style="margin:0;color:#6e6e73;font-size:13px">Flitdrop · flitdrop.com</p></div>`
  return { subject: t.subject(shown), text, html }
}

// Lève une exception en cas d'échec (l'appelant la journalise sans l'adresse).
export async function sendRestoreEmail(cfg, to, lang, code) {
  const { subject, text, html } = restoreEmail(lang, code)
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`resend ${res.status}`)
}
