import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u, localIPv4s } from '../src/util.js'
import { EVENTS, COMMON_PROPS, type Envelope } from '../src/telemetry.js'

// Serveur réel, télémétrie branchée sur un fetch enregistreur (aucun réseau) :
// on vérifie que chaque événement part UNE fois, au bon endroit, sans contenu.
let srv: RunningServer
let base = ''
let home = ''
const sent: Envelope[] = []
const fetchImpl = (async (_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)))
  return new Response(null, { status: 204 })
}) as unknown as typeof fetch

const admin = (p: string, body?: unknown) =>
  fetch(base + '/api/admin' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': srv.adminToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

interface Phone {
  id: string
  key: Uint8Array
  aad: (purpose: string, extra?: string) => string
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
}
function phoneFrom(id: string, key: Uint8Array): Phone {
  const aad = (purpose: string, extra = '') => `wd1|${id}|${purpose}${extra ? '|' + extra : ''}`
  const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
    })
  return { id, key, aad, post }
}
async function pairPhone(platform = 'iphone'): Promise<Phone> {
  const { url } = (await (await admin('/pair/new', {})).json()) as { url: string }
  const [id, k] = (url.split('#')[1] as string).split('.')
  const phone = phoneFrom(id as string, b64u.dec(k as string))
  const r = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone de Thomas', platform })
  const dec = openJSON<{ newKey?: string; telemetryConsent?: unknown }>(phone.key, ((await r.json()) as { p: string }).p, phone.aad('hello:res'))
  // le téléphone ne reçoit plus rien au sujet de la télémétrie
  expect(dec.telemetryConsent).toBeUndefined()
  return dec.newKey ? phoneFrom(phone.id, b64u.dec(dec.newKey)) : phone
}
const settle = async () => {
  await new Promise((r) => setTimeout(r, 30))
  await srv.telemetry.flush()
}
const events = (name: string) => sent.filter((e) => e.event === name)

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-telsrv-'))
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  srv = await startServer({
    port: 0,
    home,
    disableClipboard: true,
    telemetry: { version: '0.7.0', channel: 'dev', fetchImpl, disabled: false, tickMs: 3_600_000 },
  })
  base = `http://127.0.0.1:${srv.port}`
  await settle()
})

afterAll(async () => {
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
  fs.rmSync(home, { recursive: true, force: true })
})

describe('télémétrie branchée sur le serveur', () => {
  it('au démarrage : rien tant que l’annonce n’a pas été affichée, puis premier lancement et actif du jour', async () => {
    expect(sent).toHaveLength(0)
    expect(((await (await admin('/state')).json()) as { config: Record<string, unknown> }).config.basicNoticeShown).toBe(false)
    expect((await admin('/telemetry/notice', {})).status).toBe(200)
    await settle()
    // signalée deux fois (fenêtre ré-affichée) : rien de plus
    await admin('/telemetry/notice', {})
    await settle()
    expect(events('app_first_launch')).toHaveLength(1)
    expect(events('app_daily_active')).toHaveLength(1)
    for (const e of sent) expect(e.iid).toBeUndefined()
    expect(((await (await admin('/state')).json()) as { config: Record<string, unknown> }).config.basicNoticeShown).toBe(true)
  })

  it('page du téléphone ouverte : comptée par le PC, pas pour ses fichiers ni depuis le PC lui-même', async () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
    // le PC lui-même (127.0.0.1) : pas un téléphone
    expect((await fetch(base + '/s/', { headers: { 'user-agent': IPHONE } })).status).toBe(200)
    await settle()
    expect(events('phone_page_opened')).toHaveLength(0)
    // un téléphone sur le wifi : une adresse du PC autre que 127.0.0.1
    const lan = localIPv4s().find((ip) => !ip.startsWith('169.254.'))
    if (!lan) return // machine sans réseau : le reste est couvert par les tests unitaires
    const phoneBase = `http://${lan}:${srv.port}`
    // aucun QR affiché : un téléphone déjà appairé qui rouvre son icône ou
    // recharge la page n'est pas compté
    await (await fetch(phoneBase + '/s/', { headers: { 'user-agent': IPHONE } })).text()
    await settle()
    expect(events('phone_page_opened')).toHaveLength(0)
    // un QR attend d'être scanné : la page ouverte est comptée
    const { deviceId } = (await (await admin('/pair/new', {})).json()) as { deviceId: string }
    const page = await fetch(phoneBase + '/s/', { headers: { 'user-agent': IPHONE } })
    expect(page.status).toBe(200)
    await page.text()
    // fichiers de la page, rechargement : rien de plus
    await (await fetch(phoneBase + '/s/app.js', { headers: { 'user-agent': IPHONE } })).text()
    await (await fetch(phoneBase + '/s/index.html', { headers: { 'user-agent': IPHONE } })).text()
    await settle()
    const opened = events('phone_page_opened')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.props).toMatchObject({ first: true, platform: 'ios' })
    expect(opened[0]!.tier).toBe('basic')
    expect(JSON.stringify(opened[0])).not.toContain(lan)
    await admin(`/device/${deviceId}/revoke`, {})
  })

  it('état : la question n’a pas encore été posée', async () => {
    const st = (await (await admin('/state')).json()) as { config: Record<string, unknown> }
    expect(st.config.basicStats).toBe(true)
    expect(st.config.telemetryConsent).toBe(false)
    expect(st.config.telemetryAsked).toBe(false)
  })

  it('appairage compté une fois, transferts réussis et ratés comptés côté PC', async () => {
    const phone = await pairPhone('iphone')
    // un 2e hello (autre onglet, rechargement) ne recompte pas l'appairage
    await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'x', platform: 'iphone' })
    await settle()
    const pairs = events('pairing_success')
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.props).toMatchObject({ platform: 'ios', first: true })

    // texte téléphone -> presse-papiers du PC
    expect((await phone.post('/api/phone/text', 'text', { text: 'secret du presse-papiers', mode: 'clip' })).status).toBe(200)

    // photo téléphone -> PC
    const data = new Uint8Array(1500).fill(7)
    const init = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'Vacances de Thomas.jpg', size: data.length, mime: 'image/jpeg', chunkSize: 1000, chunks: 2 },
    })
    const { transferId } = openJSON<{ transferId: string }>(phone.key, ((await init.json()) as { p: string }).p, phone.aad('init:res'))
    for (let n = 0; n < 2; n++) {
      const slice = data.subarray(n * 1000, Math.min((n + 1) * 1000, data.length))
      const r = await fetch(`${base}/api/phone/transfer/${transferId}/chunk/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
        body: seal(phone.key, slice, phone.aad('chunk', `${transferId}|${n}`)) as unknown as BodyInit,
      })
      expect(r.status).toBe(200)
    }
    expect((await phone.post(`/api/phone/transfer/${transferId}/finish`, 'finish', { transferId })).status).toBe(200)

    // refusé : trop gros
    const big = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'film.mov', size: 10 * 1024 ** 4, mime: 'video/quicktime', chunkSize: 8 * 1024 * 1024, chunks: Math.ceil((10 * 1024 ** 4) / (8 * 1024 * 1024)) },
    })
    expect(big.status).toBe(413)

    // échec que seul le téléphone voit, signalé au PC (jamais à internet)
    expect((await phone.post('/api/phone/report', 'report', { event: 'transfer_fail', direction: 'pc_to_phone', kind: 'photo', reason: 'incomplete' })).status).toBe(200)
    // valeur hors liste : ignorée
    await phone.post('/api/phone/report', 'report', { event: 'transfer_fail', direction: 'pc_to_phone', kind: 'file', reason: '/Users/thomas/a.pdf' })

    // texte PC -> téléphone : compté une fois, même si le téléphone relit la file
    await admin('/outbox/text', { text: 'code wifi' })
    await phone.post('/api/phone/outbox', 'outbox', {})
    await phone.post('/api/phone/outbox', 'outbox', {})
    await settle()

    // fichiers PC -> téléphone : réussite comptée sur confirmation du téléphone
    const src = path.join(home, 'src')
    fs.mkdirSync(src, { recursive: true })
    for (const n of ['a.bin', 'b.bin', 'c.bin']) fs.writeFileSync(path.join(src, n), Buffer.alloc(2000, 1))
    expect(await srv.addLocalFiles(['a.bin', 'b.bin', 'c.bin'].map((n) => path.join(src, n)))).toBe(3)
    const poll = await phone.post('/api/phone/outbox', 'outbox', {})
    const { items } = openJSON<{ items: { id: string; kind: string; name?: string }[] }>(phone.key, ((await poll.json()) as { p: string }).p, phone.aad('outbox:res'))
    const idOf = (name: string) => items.find((i) => i.kind === 'file' && i.name === name)!.id
    const download = async (id: string) => {
      const r = await phone.post(`/api/phone/outbox/${id}/download`, 'download', { itemId: id })
      await r.arrayBuffer()
      return r.status
    }
    // a : reçu et confirmé (une confirmation en double ne recompte pas)
    expect(await download(idOf('a.bin'))).toBe(200)
    await settle()
    expect(events('transfer_ok').filter((e) => e.props.direction === 'pc_to_phone' && e.props.kind === 'file')).toHaveLength(0)
    await phone.post('/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId: idOf('a.bin') })
    await phone.post('/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId: idOf('a.bin') })
    // b : envoyé par le PC mais illisible sur le téléphone : un échec, jamais une réussite
    expect(await download(idOf('b.bin'))).toBe(200)
    await phone.post('/api/phone/report', 'report', { event: 'transfer_fail', direction: 'pc_to_phone', kind: 'file', reason: 'decrypt', itemId: idOf('b.bin') })
    await phone.post('/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId: idOf('b.bin') })
    // c : fichier disparu du disque avant le téléchargement
    fs.rmSync(path.join(home, 'outbox'), { recursive: true, force: true })
    expect(await download(idOf('c.bin'))).toBe(410)
    // confirmation d'un élément jamais téléchargé : ignorée
    await phone.post('/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId: 'inconnu' })
    await settle()

    const oks = events('transfer_ok').map((e) => e.props)
    expect(oks).toEqual([
      expect.objectContaining({ direction: 'phone_to_pc', kind: 'clipboard', first: true }),
      expect.objectContaining({ direction: 'phone_to_pc', kind: 'photo', size: '<1MB', first: false }),
      expect.objectContaining({ direction: 'pc_to_phone', kind: 'text', first: false }),
      expect.objectContaining({ direction: 'pc_to_phone', kind: 'file', size: '<1MB', first: false }),
    ])
    const fails = events('transfer_fail').map((e) => e.props)
    expect(fails).toEqual([
      expect.objectContaining({ direction: 'phone_to_pc', kind: 'file', status: 413, reason: 'tooBig' }),
      expect.objectContaining({ direction: 'pc_to_phone', kind: 'photo', status: 0, reason: 'incomplete' }),
      expect.objectContaining({ direction: 'pc_to_phone', kind: 'file', status: 0, reason: 'decrypt' }),
      expect.objectContaining({ direction: 'pc_to_phone', kind: 'file', status: 410, reason: 'fileGone' }),
    ])
    const raw = JSON.stringify(sent)
    expect(raw).not.toContain('Thomas')
    expect(raw).not.toContain('Vacances')
    expect(raw).not.toContain('secret du presse')
    expect(raw).not.toContain('code wifi')
  })

  it('événements d’interface et erreurs : ignorés tant que la personne n’a pas dit oui', async () => {
    const before = sent.length
    await admin('/telemetry/event', { event: 'welcome_shown' })
    await admin('/telemetry/event', { event: '$exception', error: { type: 'TypeError', message: 'x is undefined', stack: '' } })
    await admin('/telemetry/event', { event: 'app_first_launch' }) // pas un événement d'interface
    await settle()
    expect(sent.length).toBe(before)
  })

  it('« Oui, partager » : choix enregistré, événements détaillés avec identifiant', async () => {
    expect((await admin('/telemetry/choice', { choice: 'full', where: 'welcome' })).status).toBe(200)
    await admin('/telemetry/event', { event: 'welcome_shown' })
    await admin('/telemetry/event', {
      event: '$exception',
      error: { type: 'TypeError', message: `boom in ${os.homedir()}/Documents/perso.txt`, stack: 'at f (http://127.0.0.1:1/app/app.js?k=abc:1:2)' },
    })
    await settle()
    const choice = events('telemetry_choice')
    expect(choice).toHaveLength(1)
    expect(choice[0]!.props).toMatchObject({ choice: 'full', where: 'welcome' })
    expect(choice[0]!.iid).toBeTruthy()
    expect(events('welcome_shown')).toHaveLength(1)
    const exc = events('$exception')
    expect(exc).toHaveLength(1)
    expect(exc[0]!.props.source).toBe('desktop')
    expect(JSON.stringify(exc[0])).not.toContain(os.homedir())
    expect(JSON.stringify(exc[0])).not.toContain('perso.txt')
    expect(JSON.stringify(exc[0])).not.toContain('k=abc')
    const st = (await (await admin('/state')).json()) as { config: Record<string, unknown> }
    expect(st.config).toMatchObject({ telemetryAsked: true, telemetryConsent: true, basicStats: true })

    // réglage modifié : seul son NOM remonte
    await admin('/settings', { theme: 'dark' })
    await settle()
    expect(events('settings_changed').map((e) => e.props.key)).toEqual(['theme'])
  })

  it('tout couper : plus rien ne part', async () => {
    // couper la base par les réglages coupe aussi le détaillé
    expect((await admin('/settings', { basicStats: false })).status).toBe(200)
    const cut = (await (await admin('/state')).json()) as { config: Record<string, unknown> }
    expect(cut.config).toMatchObject({ telemetryConsent: false, basicStats: false })
    await admin('/telemetry/choice', { choice: 'none', where: 'settings' })
    await settle()
    const before = sent.length
    const phone = await pairPhone('android')
    await phone.post('/api/phone/text', 'text', { text: 'x', mode: 'message' })
    await admin('/telemetry/event', { event: 'history_opened' })
    // page ouverte par un autre téléphone (Android) : rien non plus
    const lan = localIPv4s().find((ip) => !ip.startsWith('169.254.'))
    if (lan) await (await fetch(`http://${lan}:${srv.port}/s/`, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 17)' } })).text()
    await settle()
    expect(sent.length).toBe(before)
    const st = (await (await admin('/state')).json()) as { config: Record<string, unknown> }
    expect(st.config).toMatchObject({ telemetryAsked: true, telemetryConsent: false, basicStats: false })
  })

  it('toutes les enveloppes respectent le contrat', () => {
    expect(sent.length).toBeGreaterThan(5)
    for (const env of sent) {
      expect(Object.keys(env).every((k) => ['event', 'v', 'ts', 'tier', 'iid', 'props'].includes(k))).toBe(true)
      const allowed = new Set<string>([...COMMON_PROPS, ...(EVENTS[env.event]?.props ?? [])])
      for (const k of Object.keys(env.props)) expect(allowed.has(k), `${env.event}.${k}`).toBe(true)
      if (env.tier === 'basic') expect(env.iid).toBeUndefined()
    }
  })
})
