import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'
import { deviceIdFrom, type MarkStore } from '../src/machineid.js'
import { t } from '../src/i18n.js'

// Flitdrop Pro côté serveur : limite du jour appliquée par le PC (jamais par
// la page du téléphone), dossiers par mois, presse-papiers, mode payant coupé.

const TEST_PUB = '/DuOo3uFrsEk2LTrypdMWZtYQITS1nUXLp8QK3vLmrg='
const TEST_PRIV = crypto.createPrivateKey({
  key: Buffer.from('MC4CAQAwBQYDK2VwBCIEIJC1x9+Rpcf7QqPLnKW4VLbii5eZpB4SxBdcrsSxkl/Q', 'base64'),
  format: 'der',
  type: 'pkcs8',
})
const MACHINE = 'c0ffee00-1234-4abc-8def-0123456789ab'
const DAY = 86_400_000

function tokenFor(dev: string, iatMs: number): string {
  const p = Buffer.from(JSON.stringify({ v: 1, plan: 'pro', dev, cus: 'c'.repeat(32), iat: Math.floor(iatMs / 1000), exp: Math.floor(iatMs / 1000) + 30 * 86400 }))
  return p.toString('base64url') + '.' + crypto.sign(null, p, TEST_PRIV).toString('base64url')
}

function memMark(): MarkStore {
  let v: string | null = null
  return { read: async () => v, write: async (x) => ((v = x), true) }
}

interface Phone {
  id: string
  key: Uint8Array
  aad: (purpose: string, extra?: string) => string
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
  read: <T>(p: string, purpose: string, obj?: Record<string, unknown>) => Promise<T>
}

interface Ctx {
  srv: RunningServer
  base: string
  home: string
  dl: string
  clip: { text: string }
  opened: string[]
  setClock: (ms: number) => void
  clock: () => number
  claimAnswer: { token?: string }
  admin: (p: string, init?: RequestInit) => Promise<Response>
  adminJSON: (p: string, body: unknown) => Promise<Response>
  state: () => Promise<Record<string, any>>
  pair: () => Promise<Phone>
}

async function boot(o: { license?: 'on' | 'unreachable' | 'none' } = {}): Promise<Ctx> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-pro-'))
  const dl = path.join(home, 'dl')
  // installation existante (avant le lancement du mode payant)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ installId: 'i'.repeat(16), installedAt: '2026-03-01T00:00:00.000Z', downloadDir: dl, lastVersion: '0.6.7' }))
  let now = Date.parse('2026-11-05T10:00:00.000Z')
  const clip = { text: '' }
  const opened: string[] = []
  const claimAnswer: { token?: string } = {}
  const mode = o.license ?? 'on'
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (mode === 'unreachable') throw new TypeError('fetch failed')
    const u = new URL(String(url))
    if (u.pathname === '/api/license/config')
      return new Response(
        JSON.stringify({ enabled: true, launchedAt: '2026-11-01T00:00:00.000Z', trialDays: 14, earlyDays: 30, displayPrice: { EUR: '5,99 €', USD: '$5.99' } }),
        { status: 200 }
      )
    if (u.pathname === '/api/license/claim') {
      void init
      return claimAnswer.token ? new Response(JSON.stringify({ token: claimAnswer.token }), { status: 200 }) : new Response('{"pending":true}', { status: 202 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  delete process.env.FLITDROP_NO_CLIP
  const srv = await startServer({
    port: 0,
    home,
    quiet: true,
    manualClipboardPoll: true,
    clipboardText: { read: () => clip.text, write: (x) => void (clip.text = x) },
    openExternal: (url) => void opened.push(url),
    license:
      mode === 'none'
        ? undefined
        : {
            configUrl: 'https://license.test/api/license/config',
            fetchImpl,
            now: () => now,
            publicKey: TEST_PUB,
            machineId: async () => MACHINE,
            markStore: memMark(),
            systemLocale: 'fr-FR',
          },
  })
  if (mode !== 'none') await srv.license.refreshConfig()
  const base = `http://127.0.0.1:${srv.port}`
  const admin = (p: string, init?: RequestInit) => fetch(base + '/api/admin' + p, { ...init, headers: { ...(init?.headers ?? {}), 'x-admin-token': srv.adminToken } })
  const adminJSON = (p: string, body: unknown) =>
    admin(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const phoneFrom = (id: string, key: Uint8Array): Phone => {
    const aad = (purpose: string, extra = '') => `wd1|${id}|${purpose}${extra ? '|' + extra : ''}`
    const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
      fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wd-device': id },
        body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
      })
    const read = async <T>(p: string, purpose: string, obj: Record<string, unknown> = {}) => {
      const r = await post(p, purpose, obj)
      expect(r.status).toBe(200)
      return openJSON<T>(key, ((await r.json()) as { p: string }).p, aad(purpose + ':res'))
    }
    return { id, key, aad, post, read }
  }
  const pair = async (): Promise<Phone> => {
    const { url } = (await (await adminJSON('/pair/new', {})).json()) as { url: string }
    const [id, k] = url.split('#')[1]!.split('.') as [string, string]
    const first = phoneFrom(id, b64u.dec(k))
    const hello = await first.read<{ newKey?: string }>('/api/phone/hello', 'hello', { deviceLabel: 'iPhone', platform: 'iphone' })
    return hello.newKey ? phoneFrom(id, b64u.dec(hello.newKey)) : first
  }
  return {
    srv,
    base,
    home,
    dl,
    clip,
    opened,
    setClock: (ms) => void (now = ms),
    clock: () => now,
    claimAnswer,
    admin,
    adminJSON,
    state: async () => (await (await admin('/state')).json()) as Record<string, any>,
    pair,
  }
}

async function shutdown(c: Ctx) {
  await c.srv.close()
  fs.rmSync(c.home, { recursive: true, force: true })
}

/** Début d'un envoi de 16 octets (un morceau). */
async function init(p: Phone, name: string, o: { mime?: string; lastModified?: number } = {}) {
  const meta: Record<string, unknown> = { name, size: 16, mime: o.mime ?? 'application/octet-stream', chunkSize: 16, chunks: 1 }
  if (o.lastModified !== undefined) meta.lastModified = o.lastModified
  const r = await p.post('/api/phone/transfer/init', 'init', { meta })
  if (r.status !== 200) return { status: r.status, body: (await r.json()) as Record<string, unknown>, tid: '' }
  const { transferId } = openJSON<{ transferId: string }>(p.key, ((await r.json()) as { p: string }).p, p.aad('init:res'))
  return { status: 200, body: {}, tid: transferId }
}

async function finish(c: Ctx, p: Phone, tid: string) {
  const sealed = seal(p.key, crypto.randomBytes(16), p.aad('chunk', `${tid}|0`))
  const ch = await fetch(`${c.base}/api/phone/transfer/${tid}/chunk/0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-wd-device': p.id },
    body: sealed as unknown as BodyInit,
  })
  expect(ch.status).toBe(200)
  const fin = await p.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
  expect(fin.status).toBe(200)
  return openJSON<{ name: string }>(p.key, ((await fin.json()) as { p: string }).p, p.aad('finish:res')).name
}

async function send(c: Ctx, p: Phone, name: string, o: { mime?: string; lastModified?: number } = {}) {
  const i = await init(p, name, o)
  expect(i.status).toBe(200)
  return finish(c, p, i.tid)
}

const outbox = (p: Phone) => p.read<{ quota?: { limit: number; used: number; left: number; resetAt: string; price: string } }>('/api/phone/outbox', 'outbox')

describe('mode payant coupé (pas de licence) : comme avant', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await boot({ license: 'none' })
  })
  afterAll(() => shutdown(c))

  it('aucune limite, aucun dossier par mois, rien de Pro dans l’état ni pour le téléphone', async () => {
    const phone = await c.pair()
    for (let i = 0; i < 32; i++) await send(c, phone, `f${i}.bin`)
    const name = await send(c, phone, 'photo.jpg', { mime: 'image/jpeg', lastModified: new Date(2025, 2, 15).getTime() })
    expect(fs.existsSync(path.join(c.dl, name))).toBe(true)
    expect((await outbox(phone)).quota).toBeUndefined()
    const s = await c.state()
    expect(s.pro).toEqual({ plan: 'off' })
    c.srv.cfg.clipboardAutoPush = true
    c.clip.text = 'copié sur le PC'
    await c.srv.pollClipboard()
    expect(s.outbox.length + 1).toBe((await c.state()).outbox.length)
  })
})

describe('configuration injoignable : plan « off », tout reste ouvert', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await boot({ license: 'unreachable' })
  })
  afterAll(() => shutdown(c))

  it('aucune limite ni carte', async () => {
    const phone = await c.pair()
    for (let i = 0; i < 31; i++) await send(c, phone, `g${i}.bin`)
    expect((await c.state()).pro).toEqual({ plan: 'off' })
    expect((await outbox(phone)).quota).toBeUndefined()
  })
})

describe('essai puis gratuit : limite du jour appliquée par le PC', () => {
  let c: Ctx
  let phone: Phone
  const tracked: string[] = []
  beforeAll(async () => {
    c = await boot()
    const orig = c.srv.telemetry.track.bind(c.srv.telemetry)
    c.srv.telemetry.track = (event, props, cb) => {
      tracked.push(event)
      return orig(event, props, cb)
    }
    phone = await c.pair()
  })
  afterAll(() => shutdown(c))

  it('essai : illimité, photos rangées par mois (date du téléphone, sinon arrivée)', async () => {
    expect((await c.state()).pro.plan).toBe('trial')
    for (let i = 0; i < 31; i++) await send(c, phone, `t${i}.bin`)
    const march = new Date(2025, 2, 15, 12).getTime()
    const n1 = await send(c, phone, 'IMG_0001.HEIC', { mime: 'image/heic', lastModified: march })
    expect(fs.existsSync(path.join(c.dl, '2025-03', n1))).toBe(true)
    const n2 = await send(c, phone, 'clip.mov', { mime: 'video/quicktime' })
    const d = new Date()
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    expect(fs.existsSync(path.join(c.dl, month, n2))).toBe(true)
    // un document reste à la racine du dossier de réception
    const n3 = await send(c, phone, 'facture.pdf', { mime: 'application/pdf', lastModified: march })
    expect(fs.existsSync(path.join(c.dl, n3))).toBe(true)
    // réglage coupé : plus de dossier par mois
    expect((await c.adminJSON('/settings', { sortPhotosByMonth: false })).status).toBe(200)
    const n4 = await send(c, phone, 'IMG_0002.JPG', { mime: 'image/jpeg', lastModified: march })
    expect(fs.existsSync(path.join(c.dl, n4))).toBe(true)
    expect((await c.adminJSON('/settings', { sortPhotosByMonth: true })).status).toBe(200)
  })

  it('gratuit : 29, 30 (commencé, finit toujours), 31 refusé au départ', async () => {
    c.setClock(c.clock() + 15 * DAY)
    const s0 = await c.state()
    expect(s0.pro.plan).toBe('free')
    expect(s0.pro.used).toBe(0)
    for (let i = 0; i < 29; i++) await send(c, phone, `free${i}.bin`)
    expect((await outbox(phone)).quota).toMatchObject({ limit: 30, used: 29, left: 1, price: '5,99 €' })
    const thirtieth = await init(phone, 'free29.bin')
    expect(thirtieth.status).toBe(200)
    const refused = await init(phone, 'free30.bin')
    expect(refused.status).toBe(402)
    expect(refused.body).toMatchObject({ error: 'daily_limit', limit: 30, left: 0, price: '5,99 €' })
    // un transfert déjà commencé finit
    await finish(c, phone, thirtieth.tid)
    const again = await init(phone, 'free31.bin')
    expect(again.status).toBe(402)
    expect((await outbox(phone)).quota).toMatchObject({ used: 30, left: 0 })
    // rien n'a été créé pour les refus (ni fichier temporaire, ni ligne d'historique)
    const s = await c.state()
    expect(s.history.some((h: { name?: string }) => h.name === 'free30.bin' || h.name === 'free31.bin')).toBe(false)
    expect(s.pro.card).toBe('limit')
    expect(tracked.filter((e) => e === 'daily_limit_reached')).toHaveLength(1)
  })

  it('une ancienne page du téléphone reçoit un refus lisible (pas de code inconnu)', async () => {
    const r = await phone.post('/api/phone/transfer/init', 'init', { meta: { name: 'x.bin', size: 16, chunkSize: 16, chunks: 1 } })
    expect(r.status).toBe(402)
    const j = (await r.json()) as { code?: string; error?: string }
    expect(j.code).toBeUndefined()
    expect(j.error).toBe('daily_limit')
    // ce que montre une page d'avant Flitdrop Pro (phone.ts, post) : « Erreur 402 »
    const oldPageText = j.code ? t('fr', 'err.' + j.code) : t('fr', 'err.generic', { status: r.status })
    expect(oldPageText).toBe('Erreur 402')
  })

  it('textes et presse-papiers ne comptent pas', async () => {
    const r = await phone.post('/api/phone/text', 'text', { text: 'un lien', mode: 'message' })
    expect(r.status).toBe(200)
    expect((await c.adminJSON('/outbox/text', { text: 'du PC' })).status).toBe(200)
    c.clip.text = 'copié'
    expect((await c.admin('/clipboard/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  })

  it('PC vers téléphone : les fichiers comptent aussi, refusés avant d’être lus', async () => {
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('abc')]), 'doc.txt')
    const r = await c.admin('/outbox/file', { method: 'POST', body: fd })
    expect(r.status).toBe(402)
    expect(((await r.json()) as { code?: string }).code).toBe('dailyLimit')
    const local = path.join(c.home, 'local.txt')
    fs.writeFileSync(local, 'x')
    expect(await c.srv.addLocalFiles([local])).toBe(0)
  })

  it('Raccourci iOS : refusé au départ, message en clair', async () => {
    const s = await c.state()
    const tok = s.devices.find((d: { id: string }) => d.id === phone.id).shortcutToken as string
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('abc')]), 'p.jpg')
    const r = await fetch(`${c.base}/api/shortcut/upload?t=${tok}`, { method: 'POST', body: fd, headers: { 'accept-language': 'fr' } })
    expect(r.status).toBe(402)
    expect(await r.text()).toContain('Limite du jour atteinte')
  })

  it('gratuit : pas de dossier par mois, pas de synchro automatique, historique limité aux 20 derniers textes', async () => {
    c.setClock(c.clock() + DAY)
    const march = new Date(2025, 2, 15, 12).getTime()
    const n = await send(c, phone, 'IMG_0003.JPG', { mime: 'image/jpeg', lastModified: march })
    expect(fs.existsSync(path.join(c.dl, n))).toBe(true)
    c.srv.cfg.clipboardAutoPush = true
    const before = (await c.state()).outbox.length
    c.clip.text = 'copié en gratuit'
    expect(await c.srv.pollClipboard()).toBe(true)
    const s = await c.state()
    expect(s.outbox.length).toBe(before)
    // gardé dans l'historique local, simplement pas envoyé tout seul
    expect(s.clipHistory.some((e: { text: string }) => e.text === 'copié en gratuit')).toBe(true)
    for (let i = 0; i < 25; i++) {
      c.clip.text = `texte ${i}`
      await c.srv.pollClipboard()
    }
    const s2 = await c.state()
    expect(s2.clipHistory).toHaveLength(20)
    expect(s2.clipHidden).toBeGreaterThan(0)
    const phoneList = await phone.read<{ items: unknown[] }>('/api/phone/cliphistory', 'cliphistory')
    expect(phoneList.items).toHaveLength(20)
    // une entrée cachée ne peut pas être demandée par son identifiant
    await new Promise((r) => setTimeout(r, 600))
    const visible = new Set(s2.clipHistory.map((e: { id: string }) => e.id))
    const stored = JSON.parse(fs.readFileSync(path.join(c.home, 'cliphistory.json'), 'utf8')) as { id: string }[]
    const hiddenId = stored.map((e) => e.id).find((id) => !visible.has(id))
    expect(hiddenId).toBeTruthy()
    expect((await c.admin(`/cliphistory/${hiddenId}/copy`, { method: 'POST' })).status).toBe(404)
  })

  it('minuit : compteur neuf', async () => {
    const q = (await outbox(phone)).quota!
    expect(q.used).toBe(1)
    expect(q.left).toBe(29)
  })

  it('Pro débloqué par l’achat : illimité, le téléphone voit la limite levée, tout se rouvre', async () => {
    for (let i = 0; i < 29; i++) await send(c, phone, `day2-${i}.bin`)
    expect((await init(phone, 'blocked.bin')).status).toBe(402)
    expect((await c.adminJSON('/pro/checkout', { where: 'limit' })).status).toBe(200)
    expect(c.opened[0]).toMatch(/^https:\/\/license\.test\/pro\?claim=[0-9a-f]{32}&lang=(fr|en|de)$/)
    expect((await c.state()).pro.card).toBe('waiting')
    let r = (await (await c.adminJSON('/pro/claim', { manual: true })).json()) as { status: string }
    expect(r.status).toBe('pending')
    c.claimAnswer.token = tokenFor(deviceIdFrom(MACHINE), c.clock())
    c.setClock(c.clock() + 2000)
    r = (await (await c.adminJSON('/pro/claim', { manual: true })).json()) as { status: string }
    expect(r.status).toBe('unlocked')
    const s = await c.state()
    expect(s.pro.plan).toBe('pro')
    expect(s.pro.card).toBe('success')
    // le téléphone ne reçoit plus de limite : ses fichiers en attente repartent
    expect((await outbox(phone)).quota).toBeUndefined()
    for (let i = 0; i < 3; i++) await send(c, phone, `unlocked-${i}.bin`)
    const march = new Date(2025, 2, 15, 12).getTime()
    const n = await send(c, phone, 'IMG_0004.JPG', { mime: 'image/jpeg', lastModified: march })
    expect(fs.existsSync(path.join(c.dl, '2025-03', n))).toBe(true)
    const before = (await c.state()).outbox.length
    c.clip.text = 'copié en Pro'
    await c.srv.pollClipboard()
    expect((await c.state()).outbox.length).toBe(before + 1)
    expect((await c.state()).clipHidden).toBe(0)
    expect(tracked).toContain('pro_unlocked')
    expect(tracked).toContain('pro_checkout_opened')
  })
})

describe('aucune nouvelle minuterie', () => {
  it('le même nombre de setInterval, licence active ou non', async () => {
    const count = async (license: 'on' | 'none') => {
      const spy = vi.spyOn(globalThis, 'setInterval')
      const c = await boot({ license })
      const n = spy.mock.calls.length
      spy.mockRestore()
      await shutdown(c)
      return n
    }
    const off = await count('none')
    const on = await count('on')
    expect(on).toBe(off)
  })
})
