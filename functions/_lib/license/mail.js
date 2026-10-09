// Licences Flitdrop Pro : e-mails envoyés par Resend (même compte et même
// expéditeur que functions/api/contact.js) : code de restauration, accusé de
// réception d'une rétractation et sa copie pour nous.
//
// Quota : l'offre gratuite de Resend donne 100 e-mails par jour, partagés avec le
// formulaire de contact. Les plafonds quotidiens (comptés dans la base D1, voir
// restore/start.js et functions/api/withdraw.js) en laissent toujours au moins 30
// au contact.
import { formatCode } from './crypto.js'

const MAIL_FROM = 'Flitdrop <contact@flitdrop.com>' // domaine vérifié dans Resend
// Boîte qui reçoit vraiment : la même que MAIL_TO de functions/api/contact.js (un test
// vérifie qu'elles restent identiques).
export const OWNER_ADDRESS = 'thomasbidault.tb@gmail.com'
// Adresse publique de contact (CGV, page /refund, mentions légales) : elle reçoit le
// courrier (redirection) ; les réponses à l'accusé de rétractation y arrivent.
export const CONTACT_ADDRESS = 'contact@flitdrop.com'

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
export async function sendEmail(resendKey, { to, replyTo, subject, text, html }) {
  const payload = { from: MAIL_FROM, to: [to], subject, text, html }
  if (replyTo) payload.reply_to = [replyTo]
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`resend ${res.status}`)
}

export async function sendRestoreEmail(cfg, to, lang, code) {
  await sendEmail(cfg.resendKey, { to, ...restoreEmail(lang, code) })
}

// --- rétractation -------------------------------------------------------------------
// La loi (directive 2023/2673, art. L221-21 et D221-5 du Code de la consommation,
// § 356a BGB) demande d'accuser réception d'une rétractation sans délai, sur un
// support durable : cet e-mail, avec la date et l'heure de réception (heure de Paris)
// et ce que la personne a envoyé.

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
}

// Dernier dimanche du mois (0 = janvier), à 1 h UTC : changement d'heure européen.
function lastSundayUtc(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0, 1))
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.getTime()
}

// Heure de Paris : UTC+1, et UTC+2 du dernier dimanche de mars au dernier dimanche
// d'octobre (1 h UTC). Calculé ici, sans dépendre des fuseaux du moteur JavaScript.
export function parisOffsetMinutes(ms) {
  const y = new Date(ms).getUTCFullYear()
  return ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9) ? 120 : 60
}

// « le 9 octobre 2026 à 16 h 03 (heure de Paris) », dans la langue demandée.
export function formatReceived(lang, sec) {
  const ms = sec * 1000
  const d = new Date(ms + parisOffsetMinutes(ms) * 60_000)
  const day = d.getUTCDate()
  const month = (MONTHS[lang] || MONTHS.en)[d.getUTCMonth()]
  const year = d.getUTCFullYear()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  if (lang === 'fr') return `le ${day} ${month} ${year} à ${hh} h ${mm} (heure de Paris)`
  if (lang === 'de') return `am ${day}. ${month} ${year} um ${hh}:${mm} Uhr (Pariser Zeit)`
  return `on ${day} ${month} ${year} at ${hh}:${mm} (Paris time)`
}

const WITHDRAW_TEXTS = {
  fr: {
    subject: 'Votre rétractation de Flitdrop Pro est bien reçue',
    hello: 'Bonjour,',
    intro: (when) => `Nous avons bien reçu votre rétractation de votre achat de Flitdrop Pro, ${when}.`,
    yours: 'Ce que vous nous avez envoyé :',
    name: 'Nom et prénom',
    email: "Adresse e-mail utilisée pour l'achat",
    order: "Numéro de commande ou date d'achat",
    none: 'non indiqué',
    sep: ' : ',
    next: "Nous vous remboursons via Paddle sous 14 jours, sur le moyen de paiement utilisé. Vous n'avez rien d'autre à faire.",
    notYou: "Si vous n'avez rien envoyé, dites-le-nous à contact@flitdrop.com, ou répondez simplement à cet e-mail.",
  },
  de: {
    subject: 'Dein Widerruf für Flitdrop Pro ist eingegangen',
    hello: 'Hallo,',
    intro: (when) => `wir haben deinen Widerruf deines Kaufs von Flitdrop Pro ${when} erhalten.`,
    yours: 'Das hast du uns geschickt:',
    name: 'Vor- und Nachname',
    email: 'E-Mail-Adresse des Kaufs',
    order: 'Bestellnummer oder Kaufdatum',
    none: 'nicht angegeben',
    sep: ': ',
    next: 'Wir erstatten dir den Betrag über Paddle innerhalb von 14 Tagen auf das verwendete Zahlungsmittel. Du musst nichts weiter tun.',
    notYou: 'Falls du nichts gesendet hast, sag es uns unter contact@flitdrop.com oder antworte einfach auf diese E-Mail.',
  },
  en: {
    subject: 'Your withdrawal from Flitdrop Pro is received',
    hello: 'Hi,',
    intro: (when) => `We received your withdrawal from your purchase of Flitdrop Pro ${when}.`,
    yours: 'What you sent us:',
    name: 'Name and first name',
    email: 'E-mail address used for the purchase',
    order: 'Order number or date of purchase',
    none: 'not given',
    sep: ': ',
    next: 'We refund you through Paddle within 14 days, with the payment method you used. You have nothing else to do.',
    notYou: 'If you did not send this, tell us at contact@flitdrop.com, or simply reply to this e-mail.',
  },
}

const withdrawalLines = (t, w) => [
  [t.name, w.name],
  [t.email, w.email],
  [t.order, w.orderRef || t.none],
]

// Accusé de réception, à l'adresse TAPÉE (jamais une autre) ; « Répondre » écrit à
// contact@flitdrop.com.
export function withdrawalAckEmail(lang, w) {
  const l = WITHDRAW_TEXTS[lang] ? lang : 'en'
  const t = WITHDRAW_TEXTS[l]
  const intro = t.intro(formatReceived(l, w.receivedAt))
  const lines = withdrawalLines(t, w)
  const text =
    `${t.hello}\n\n${intro}\n\n${t.yours}\n` +
    lines.map(([k, v]) => k + t.sep + v).join('\n') +
    `\n\n${t.next}\n\n${t.notYou}\n\nFlitdrop\nhttps://flitdrop.com`
  const p = 'margin:0 0 16px'
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f">` +
    `<p style="${p}">${escapeHtml(t.hello)}</p>` +
    `<p style="${p}">${escapeHtml(intro)}</p>` +
    `<p style="margin:0 0 6px">${escapeHtml(t.yours)}</p>` +
    `<p style="${p};padding:10px 14px;background:#f5f5f7;border-radius:10px">` +
    lines.map(([k, v]) => `<strong>${escapeHtml(k)}</strong>${escapeHtml(t.sep)}${escapeHtml(v)}`).join('<br>') +
    `</p>` +
    `<p style="${p}">${escapeHtml(t.next)}</p>` +
    `<p style="margin:0 0 18px;color:#6e6e73">${escapeHtml(t.notYou)}</p>` +
    `<hr style="border:none;border-top:1px solid #e5e5ea;margin:18px 0">` +
    `<p style="margin:0;color:#6e6e73;font-size:13px">Flitdrop · flitdrop.com</p></div>`
  return { subject: t.subject, text, html, replyTo: CONTACT_ADDRESS }
}

// Copie pour nous, en français : « Répondre » écrit directement à la personne.
export function withdrawalCopyEmail(w) {
  const t = WITHDRAW_TEXTS.fr
  const lines = [
    ['Reçue', formatReceived('fr', w.receivedAt)],
    ...withdrawalLines(t, w),
    ['Langue', w.lang],
    ['Accusé de réception envoyé', w.acked ? 'oui' : 'non (plafond par adresse atteint ou envoi en échec)'],
    ['Référence', w.id],
  ]
  const intro = 'Rétractation Flitdrop Pro reçue par le formulaire de flitdrop.com/refund.'
  const todo = 'À rembourser dans Paddle (Transactions, la commande, Refund), sous 14 jours.'
  const text = `${intro}\n\n` + lines.map(([k, v]) => `${k} : ${v}`).join('\n') + `\n\n${todo}`
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f">` +
    `<p style="margin:0 0 16px">${intro}</p><p style="margin:0 0 16px">` +
    lines.map(([k, v]) => `<strong>${escapeHtml(k)} :</strong> ${escapeHtml(v)}`).join('<br>') +
    `</p><p style="margin:0">${todo}</p></div>`
  return { subject: `Rétractation Flitdrop Pro (${w.email})`, text, html }
}
