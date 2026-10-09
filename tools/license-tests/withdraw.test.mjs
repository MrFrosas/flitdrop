// Tests de la fonction de rétractation (POST /api/withdraw, formulaire de /refund#withdraw).
//   node --test tools/license-tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resetLicenseState } from '../../functions/_lib/license/state.js'
import { formatReceived, parisOffsetMinutes, withdrawalAckEmail, OWNER_ADDRESS } from '../../functions/_lib/license/mail.js'
import * as withdrawRoute from '../../functions/api/withdraw.js'
import { T, setup, teardown, shiftClock, call, sandboxEnv, RESEND_KEY } from './harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

beforeEach(() => setup())
afterEach(() => teardown())

const WITHDRAWAL = { name: 'Ana Martin', email: 'ana@example.com', order: 'txn_01abc', lang: 'fr' }
const mailsTo = (addr) => T.world.emails.filter((m) => m.body.to[0] === addr)

test('withdraw : réponse immédiate, rétractation notée avec son heure, accusé à l’adresse tapée et copie pour nous', async () => {
  const r = await call(withdrawRoute, WITHDRAWAL)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body), ['ok', 'receivedAt'])
  assert.ok(Math.abs(Date.parse(r.body.receivedAt) - Date.now()) < 5000)

  const rows = T.db.rows('SELECT name, email, order_ref, lang, ack_sent, received_at FROM withdrawals')
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], received_at: undefined }, { name: 'Ana Martin', email: 'ana@example.com', order_ref: 'txn_01abc', lang: 'fr', ack_sent: 1, received_at: undefined })

  const [ack] = mailsTo('ana@example.com')
  assert.equal(ack.body.from, 'Flitdrop <contact@flitdrop.com>')
  assert.equal(ack.headers.Authorization, `Bearer ${RESEND_KEY}`)
  assert.deepEqual(ack.body.reply_to, ['contact@flitdrop.com'], 'les réponses à l’accusé arrivent à contact@flitdrop.com')
  assert.ok(ack.body.text.includes('contact@flitdrop.com'))
  assert.match(ack.body.subject, /rétractation/)
  for (const part of ['Ana Martin', 'ana@example.com', 'txn_01abc', 'heure de Paris', 'Paddle', '14 jours', formatReceived('fr', rows[0].received_at)]) {
    assert.ok(ack.body.text.includes(part), part)
  }
  const [copy] = mailsTo(OWNER_ADDRESS)
  assert.deepEqual(copy.body.reply_to, ['ana@example.com'])
  assert.ok(copy.body.text.includes('Ana Martin') && copy.body.text.includes('Accusé de réception envoyé : oui'))
  assert.equal(T.world.emails.length, 2)
  assert.ok(!T.world.emails.some((m) => m.body.to[0] === 'contact@flitdrop.com'))
})

test('withdraw : accusé dans la langue de la page, heure de Paris (été et hiver)', async () => {
  // 9 octobre 2026, 14:03 UTC = 16:03 à Paris (heure d'été)
  const summer = Date.parse('2026-10-09T14:03:00Z') / 1000
  assert.equal(formatReceived('fr', summer), 'le 9 octobre 2026 à 16 h 03 (heure de Paris)')
  assert.equal(formatReceived('de', summer), 'am 9. Oktober 2026 um 16:03 Uhr (Pariser Zeit)')
  assert.equal(formatReceived('en', summer), 'on 9 October 2026 at 16:03 (Paris time)')
  // 15 janvier, 23:30 UTC = 16 janvier 00:30 à Paris (heure d'hiver)
  assert.equal(formatReceived('en', Date.parse('2026-01-15T23:30:00Z') / 1000), 'on 16 January 2026 at 00:30 (Paris time)')
  // changements d'heure : dernier dimanche de mars et d'octobre, 1 h UTC
  assert.equal(parisOffsetMinutes(Date.parse('2026-03-29T00:59:00Z')), 60)
  assert.equal(parisOffsetMinutes(Date.parse('2026-03-29T01:00:00Z')), 120)
  assert.equal(parisOffsetMinutes(Date.parse('2026-10-25T00:59:00Z')), 120)
  assert.equal(parisOffsetMinutes(Date.parse('2026-10-25T01:00:00Z')), 60)
  for (const [lang, expected] of [['de', 'Widerruf'], ['en', 'withdrawal'], ['es', 'withdrawal']]) {
    resetLicenseState()
    await call(withdrawRoute, { ...WITHDRAWAL, email: `${lang}@example.com`, lang }, { ip: `192.0.2.${lang.charCodeAt(0)}` })
    assert.ok(mailsTo(`${lang}@example.com`)[0].body.text.includes(expected), lang)
  }
  const m = withdrawalAckEmail('de', { receivedAt: summer, name: 'A', email: 'a@b.de', orderRef: '' })
  assert.ok(m.text.includes('nicht angegeben'))
  for (const lang of ['fr', 'de', 'en']) {
    const e = withdrawalAckEmail(lang, { receivedAt: summer, name: 'A', email: 'a@b.de', orderRef: 'x' })
    for (const s of [e.subject, e.text, e.html]) assert.ok(!/[\u2013\u2014]/.test(s), lang)
  }
})

test('withdraw : trois champs seulement, jamais de motif ; entrées invalides -> 400', async () => {
  for (const body of [
    { email: 'ana@example.com' }, // nom manquant
    { name: 'Ana' }, // adresse manquante
    { name: 'Ana', email: 'pas-une-adresse' },
    { name: '   ', email: 'ana@example.com' },
    { name: 12, email: 'ana@example.com' },
    { name: 'Ana', email: 'ana@example.com', order: { x: 1 } },
    [],
  ]) {
    assert.equal((await call(withdrawRoute, body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await call(withdrawRoute, null, { raw: '{pas du json' })).status, 400)
  // un champ « message » ou « reason » envoyé quand même n'est ni noté ni recopié
  await call(withdrawRoute, { ...WITHDRAWAL, message: 'MOTIF-SECRET', reason: 'MOTIF-SECRET' })
  assert.ok(!JSON.stringify(T.db.rows('SELECT * FROM withdrawals')).includes('MOTIF-SECRET'))
  assert.ok(!T.world.emails.some((m) => JSON.stringify(m.body).includes('MOTIF-SECRET')))
  // numéro de commande facultatif ; HTML échappé ; une seule ligne
  resetLicenseState()
  await call(withdrawRoute, { name: '<b>Eve</b>\r\nBcc: x@y.z', email: 'eve@example.com', lang: 'en' }, { ip: '192.0.2.40' })
  const ack = mailsTo('eve@example.com')[0]
  assert.ok(ack.body.html.includes('&lt;b&gt;Eve&lt;/b&gt;') && !ack.body.html.includes('<b>Eve'))
  assert.ok(ack.body.text.includes('<b>Eve</b> Bcc: x@y.z'), 'retours à la ligne retirés')
  assert.ok(ack.body.text.includes('not given'))
})

test('withdraw : 2 accusés par jour et par adresse, la rétractation reste notée et nous parvient', async () => {
  for (let i = 0; i < 3; i++) {
    resetLicenseState()
    assert.equal((await call(withdrawRoute, WITHDRAWAL, { ip: `192.0.2.${i}` })).status, 200)
  }
  assert.equal(mailsTo('ana@example.com').length, 2)
  assert.equal(mailsTo(OWNER_ADDRESS).length, 3)
  assert.ok(mailsTo(OWNER_ADDRESS)[2].body.text.includes('Accusé de réception envoyé : non'))
  assert.deepEqual(T.db.rows('SELECT ack_sent FROM withdrawals ORDER BY received_at, ack_sent DESC').map((r) => r.ack_sent).sort(), [0, 1, 1])
  shiftClock(86400e3)
  resetLicenseState()
  await call(withdrawRoute, WITHDRAWAL, { ip: '192.0.2.9' })
  assert.equal(mailsTo('ana@example.com').length, 3, 'le lendemain, de nouveau')
})

test('withdraw : budget quotidien d’e-mails partagé, limite par IP, réponse toujours identique', async () => {
  const answers = new Set()
  for (let i = 0; i < 12; i++) {
    resetLicenseState()
    const r = await call(withdrawRoute, { ...WITHDRAWAL, email: `p${i}@example.com` }, { ip: `198.51.100.${i}` })
    assert.equal(r.status, 200)
    answers.add(Object.keys(r.body).join())
  }
  assert.equal(answers.size, 1)
  assert.equal(T.world.emails.length, 2 * withdrawRoute.WITHDRAW_LIMITS.mailedPerDay)
  assert.equal(T.db.rows('SELECT count(*) AS n FROM withdrawals')[0].n, 12, 'toutes notées')
  assert.ok(T.logs.some((l) => l.includes('daily e-mail budget')))
  resetLicenseState()
  let last
  for (let i = 0; i < 6; i++) last = await call(withdrawRoute, { ...WITHDRAWAL, email: `q${i}@example.com` }, { ip: '203.0.113.50' })
  assert.equal(last.status, 429)
  for (const l of T.logs) assert.ok(!l.includes('@example.com'), 'aucune adresse dans les journaux')
})

test('withdraw : marche mode payant coupé ; base ou Resend absents -> 503 (la page propose Paddle et l’e-mail)', async () => {
  assert.equal((await call(withdrawRoute, WITHDRAWAL, { env: { LICENSE_DB: T.db, RESEND_API_KEY: RESEND_KEY } })).status, 200)
  assert.equal(mailsTo('ana@example.com').length, 1)
  assert.equal((await call(withdrawRoute, WITHDRAWAL, { env: sandboxEnv({ LICENSE_DB: undefined }) })).status, 503)
  assert.equal((await call(withdrawRoute, WITHDRAWAL, { env: sandboxEnv({ RESEND_API_KEY: '' }) })).status, 503)
  assert.equal((await call(withdrawRoute, null, { method: 'GET' })).status, 405)
  // Resend en panne : la rétractation reste notée, la réponse ne change pas
  resetLicenseState()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => (String(input).includes('resend') ? new Response('{}', { status: 500 }) : realFetch(input, init))
  const r = await call(withdrawRoute, { ...WITHDRAWAL, email: 'down@example.com' }, { ip: '192.0.2.77' })
  globalThis.fetch = realFetch
  assert.equal(r.status, 200)
  assert.equal(T.db.rows("SELECT ack_sent FROM withdrawals WHERE email = 'down@example.com'")[0].ack_sent, 0)
})

test('withdraw : la copie part vers la même boîte que le formulaire de contact', () => {
  const contact = readFileSync(join(ROOT, 'functions/api/contact.js'), 'utf8')
  assert.equal(/const MAIL_TO = '([^']+)'/.exec(contact)[1], OWNER_ADDRESS)
})
