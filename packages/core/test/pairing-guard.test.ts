import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Appairage, ce que le serveur garantit lui-même (pas la page) :
// - un QR scanné mais pas encore « hello » n'ouvre rien d'autre que le hello
//   (une photo du QR, ou une page modifiée qui saute le hello, ne lit pas ce
//   qui attend le premier téléphone) ;
// - le même téléphone rescanné (données du navigateur effacées, « Oublier ce
//   PC ») garde le presse-papiers et ce qui l'attendait, comme en 0.6.6.

interface Phone {
  id: string
  post: (p: string, purpose: string, obj?: Record<string, unknown>) => Promise<Response>
  read: <T>(p: string, purpose: string, obj?: Record<string, unknown>) => Promise<T>
}

interface Harness {
  srv: RunningServer
  base: string
  clip: { text: string }
  admin: (p: string, body?: unknown) => Promise<Response>
  qr: () => Promise<Phone>
  pair: (label: string, platform: string) => Promise<Phone>
}

const running: Array<{ srv: RunningServer; home: string }> = []
afterAll(async () => {
  for (const r of running.splice(0)) {
    await r.srv.close()
    fs.rmSync(r.home, { recursive: true, force: true })
  }
  delete process.env.FLITDROP_DOWNLOADS
})

async function open(): Promise<Harness> {
  delete process.env.FLITDROP_NO_CLIP
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-guard-'))
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  const clip = { text: '' }
  const srv = await startServer({
    port: 0,
    home,
    quiet: true,
    manualClipboardPoll: true,
    clipboardText: { read: () => clip.text, write: (t) => void (clip.text = t) },
  })
  running.push({ srv, home })
  const base = `http://127.0.0.1:${srv.port}`
  const admin = (p: string, body?: unknown) =>
    fetch(base + '/api/admin' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-admin-token': srv.adminToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const phoneFrom = (id: string, key: Uint8Array): Phone => {
    const aad = (purpose: string) => `wd1|${id}|${purpose}`
    const post = (p: string, purpose: string, obj: Record<string, unknown> = {}) =>
      fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wd-device': id },
        body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
      })
    const read = async <T,>(p: string, purpose: string, obj: Record<string, unknown> = {}): Promise<T> => {
      const r = await post(p, purpose, obj)
      expect(r.status, p).toBe(200)
      return openJSON<T>(key, ((await r.json()) as { p: string }).p, aad(purpose + ':res'))
    }
    return { id, post, read }
  }
  // un QR code tout juste affiché, lu par qui l'a sous les yeux (id et clé)
  const qr = async (): Promise<Phone> => {
    const { url } = (await (await admin('/pair/new', {})).json()) as { url: string }
    const [id, k] = (url.split('#')[1] as string).split('.') as [string, string]
    return phoneFrom(id, b64u.dec(k))
  }
  const pair = async (label: string, platform: string): Promise<Phone> => {
    const first = await qr()
    const hello = await first.read<{ newKey?: string }>('/api/phone/hello', 'hello', { deviceLabel: label, platform })
    return hello.newKey ? phoneFrom(first.id, b64u.dec(hello.newKey)) : first
  }
  return { srv, base, clip, admin, qr, pair }
}

type OutboxRes = { items: { id: string; text?: string; name?: string }[] }
type StateRes = { devices: { id: string; clipShare?: boolean; status: string }[]; outbox: { id: string; to?: string[] }[] }
const texts = async (p: Phone) => (await p.read<OutboxRes>('/api/phone/outbox', 'outbox')).items.map((i) => i.text ?? i.name)
const state = async (h: Harness) => (await (await h.admin('/state')).json()) as StateRes

describe('QR scanné, pas encore de hello', () => {
  it('ne lit rien de ce qui attend le premier téléphone : ni la file, ni un fichier, ni le presse-papiers', async () => {
    const h = await open()
    const a = await h.pair('Téléphone A', 'android')
    await h.admin('/outbox/text', { text: 'secret-for-A' })
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('contenu de A')]), 'pour-a.txt')
    await fetch(h.base + '/api/admin/outbox/file', { method: 'POST', body: fd, headers: { 'x-admin-token': h.srv.adminToken } })
    // presse-papiers du PC envoyé tout seul (un seul téléphone : sans destinataire)
    h.srv.cfg.clipboardAutoPush = true
    h.clip.text = 'copie-du-PC'
    expect(await h.srv.pollClipboard()).toBe(true)
    const itemsA = (await a.read<OutboxRes>('/api/phone/outbox', 'outbox')).items
    expect(itemsA.map((i) => i.text ?? i.name)).toEqual(expect.arrayContaining(['secret-for-A', 'pour-a.txt', 'copie-du-PC']))
    const file = itemsA.find((i) => i.name === 'pour-a.txt')!

    // nouveau QR : quelqu'un s'en sert AVANT le hello
    const spy = await h.qr()
    for (const [p, purpose, body] of [
      ['/api/phone/outbox', 'outbox', {}],
      [`/api/phone/outbox/${file.id}/download`, 'download', { itemId: file.id }],
      ['/api/phone/cliphistory', 'cliphistory', {}],
      ['/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId: file.id }],
      ['/api/phone/text', 'text', { text: 'intrus' }],
      ['/api/phone/transfer/init', 'init', { meta: { name: 'x.txt', size: 1, mime: 'text/plain' } }],
    ] as const) {
      const r = await spy.post(p, purpose, body)
      expect(r.status, p).toBe(403)
      const raw = await r.text()
      expect(raw, p).not.toContain('secret-for-A')
      expect(raw, p).not.toContain('contenu de A')
      expect(raw, p).not.toContain('copie-du-PC')
    }
    const status = await fetch(`${h.base}/api/phone/transfer/x/status`, { headers: { 'x-wd-device': spy.id } })
    expect(status.status).toBe(403)
    // rien n'a été reçu de sa part
    expect((await state(h)).devices.find((d) => d.id === spy.id)?.status).toBe('pending')

    // après son hello : c'est un autre téléphone, il ne voit pas le passé
    const hello = await spy.read<{ newKey?: string }>('/api/phone/hello', 'hello', { deviceLabel: 'Autre', platform: 'iphone' })
    expect(hello).toBeDefined()
    // A voit toujours tout
    expect(await texts(a)).toEqual(expect.arrayContaining(['secret-for-A', 'pour-a.txt', 'copie-du-PC']))
    h.srv.cfg.clipboardAutoPush = false
  })

  it('dès le nouveau QR, ce qui attend « tous » est réservé aux téléphones déjà appairés', async () => {
    const h = await open()
    const a = await h.pair('Téléphone A', 'android')
    await h.admin('/outbox/text', { text: 'avant le QR' })
    expect((await state(h)).outbox.every((i) => i.to === undefined)).toBe(true)
    await h.qr()
    const s = await state(h)
    expect(s.outbox.map((i) => i.to)).toEqual([[a.id]])
    expect(await texts(a)).toContain('avant le QR')
  })
})

describe('le même téléphone rescanné', () => {
  it('garde le presse-papiers du PC et ce qui attendait son ancien appairage', async () => {
    const h = await open()
    const old = await h.pair('iPhone', 'iphone')
    expect((await state(h)).devices.find((d) => d.id === old.id)?.clipShare).toBe(true)
    await h.admin('/outbox/text', { text: 'en attente' })
    // données du navigateur effacées : il rescanne, même nom, même système
    const again = await h.pair('iPhone', 'iphone')
    expect(again.id).not.toBe(old.id)
    const s = await state(h)
    expect(s.devices.find((d) => d.id === again.id)?.clipShare).toBe(true)
    expect(await texts(again)).toContain('en attente')
    const clip = await again.read<{ shared?: boolean }>('/api/phone/cliphistory', 'cliphistory')
    expect(clip.shared).toBe(true)
    // l'envoi automatique du presse-papiers lui parvient toujours
    h.srv.cfg.clipboardAutoPush = true
    h.clip.text = 'copié après le rescan'
    expect(await h.srv.pollClipboard()).toBe(true)
    expect(await texts(again)).toContain('copié après le rescan')
    h.srv.cfg.clipboardAutoPush = false

    // un vrai deuxième téléphone, lui, part sans rien
    const other = await h.pair('Pixel 8', 'android')
    expect((await state(h)).devices.find((d) => d.id === other.id)?.clipShare).toBe(false)
    expect(await texts(other)).not.toContain('en attente')
    expect(await texts(other)).not.toContain('copié après le rescan')
  })

  it('l’ancien appairage sans le presse-papiers : le nouveau non plus', async () => {
    const h = await open()
    const first = await h.pair('Téléphone A', 'android')
    const second = await h.pair('Pixel 8', 'android')
    expect((await state(h)).devices.find((d) => d.id === second.id)?.clipShare).toBe(false)
    const again = await h.pair('Pixel 8', 'android')
    expect((await state(h)).devices.find((d) => d.id === again.id)?.clipShare).toBe(false)
    expect((await state(h)).devices.find((d) => d.id === first.id)?.clipShare).toBe(true)
  })
})
