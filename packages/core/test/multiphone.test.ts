import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { DeviceStore } from '../src/pairing.js'
import { Outbox } from '../src/outbox.js'
import { sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Plusieurs téléphones sur UN PC : chacun ne voit que ce qui lui est destiné,
// et le presse-papiers du PC seulement si on le partage avec lui. Tout est
// appliqué par le serveur, pas par la page.

interface Phone {
  id: string
  key: Uint8Array
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
  read: <T>(p: string, purpose: string, obj?: Record<string, unknown>) => Promise<T>
}

let srv: RunningServer
let base = ''
let home = ''
let clipText = ''
let concealed = false

const admin = (p: string, init?: RequestInit) =>
  fetch(base + '/api/admin' + p, { ...init, headers: { ...(init?.headers ?? {}), 'x-admin-token': srv.adminToken } })
const adminJSON = (p: string, body: unknown) =>
  admin(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function phoneFrom(id: string, key: Uint8Array): Phone {
  const aad = (purpose: string) => `wd1|${id}|${purpose}`
  const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
    })
  const read = async <T,>(p: string, purpose: string, obj: Record<string, unknown> = {}): Promise<T> => {
    const r = await post(p, purpose, obj)
    expect(r.status).toBe(200)
    return openJSON<T>(key, ((await r.json()) as { p: string }).p, aad(purpose + ':res'))
  }
  return { id, key, post, read }
}

async function pairPhone(label: string): Promise<Phone> {
  const { url } = (await (await admin('/pair/new', { method: 'POST' })).json()) as { url: string }
  const [id, k] = (url.split('#')[1] as string).split('.') as [string, string]
  const first = phoneFrom(id, b64u.dec(k))
  const hello = await first.read<{ newKey?: string }>('/api/phone/hello', 'hello', { deviceLabel: label, platform: 'android' })
  return hello.newKey ? phoneFrom(id, b64u.dec(hello.newKey)) : first
}

type OutboxRes = { items: { id: string; kind: string; text?: string; name?: string }[] }
type ClipRes = { items: { id: string; text: string }[]; enabled: boolean; shared?: boolean }
type StateRes = { devices: { id: string; clipShare?: boolean }[]; sendTo: string; outbox: { id: string; to?: string[] }[] }

const texts = async (p: Phone) => (await p.read<OutboxRes>('/api/phone/outbox', 'outbox')).items.map((i) => i.text)
const state = async () => (await (await admin('/state')).json()) as StateRes

let a: Phone
let b: Phone

beforeAll(async () => {
  delete process.env.FLITDROP_NO_CLIP
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-multi-'))
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  srv = await startServer({
    port: 0,
    home,
    quiet: true,
    manualClipboardPoll: true,
    clipboardText: { read: () => clipText, write: (t) => void (clipText = t) },
    clipboardConcealed: () => concealed,
  })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
  fs.rmSync(home, { recursive: true, force: true })
})

describe('un seul téléphone : rien ne change', () => {
  it('le premier téléphone voit le presse-papiers du PC et tout ce qui est envoyé', async () => {
    a = await pairPhone('Téléphone A')
    const s = await state()
    expect(s.devices.find((d) => d.id === a.id)?.clipShare).toBe(true)
    await adminJSON('/outbox/text', { text: 'avant B' })
    expect(await texts(a)).toContain('avant B')
    // un seul téléphone : l'élément n'a pas de destinataire imposé
    expect((await state()).outbox.find((i) => i.to !== undefined)).toBeUndefined()
    await a.post('/api/phone/text', 'text', { text: 'copie depuis A', mode: 'clip' })
    const clip = await a.read<ClipRes>('/api/phone/cliphistory', 'cliphistory')
    expect(clip.shared).toBe(true)
    expect(clip.items.some((i) => i.text === 'copie depuis A')).toBe(true)
  })
})

describe('un deuxième téléphone', () => {
  it('ne voit ni ce qui a été envoyé avant lui, ni le presse-papiers du PC', async () => {
    b = await pairPhone('Téléphone B')
    const s = await state()
    expect(s.devices.find((d) => d.id === b.id)?.clipShare).toBe(false)
    expect(await texts(b)).not.toContain('avant B')
    expect(await texts(a)).toContain('avant B')
    const clip = await b.read<ClipRes>('/api/phone/cliphistory', 'cliphistory')
    expect(clip).toMatchObject({ enabled: false, shared: false, items: [] })
  })

  it('ne peut pas demander une entrée du presse-papiers du PC', async () => {
    const clip = await a.read<ClipRes>('/api/phone/cliphistory', 'cliphistory')
    const entry = clip.items[0]!
    const r = await b.post(`/api/phone/cliphistory/${entry.id}/tophone`, 'clip-tophone', { entryId: entry.id })
    expect(r.status).toBe(403)
    expect(((await r.json()) as { code: string }).code).toBe('clipNotShared')
  })

  it('ni le lire par le Raccourci', async () => {
    const tokB = (await (await admin('/state')).json()) as { devices: { id: string; shortcutToken: string }[] }
    const devB = tokB.devices.find((d) => d.id === b.id)!
    const devA = tokB.devices.find((d) => d.id === a.id)!
    clipText = 'secret du PC'
    const rb = await fetch(`${base}/api/shortcut/clipboard?t=${devB.shortcutToken}`)
    expect(rb.status).toBe(403)
    expect(await rb.text()).not.toContain('secret du PC')
    const ra = await fetch(`${base}/api/shortcut/clipboard?t=${devA.shortcutToken}`)
    expect(ra.status).toBe(200)
    expect(await ra.text()).toBe('secret du PC')
  })

  it('le partage activé sur le PC lui ouvre l’historique, et se recoupe', async () => {
    const on = await adminJSON(`/device/${b.id}/clipshare`, { enabled: true })
    expect(on.status).toBe(200)
    const clip = await b.read<ClipRes>('/api/phone/cliphistory', 'cliphistory')
    expect(clip.shared).toBe(true)
    expect(clip.items.some((i) => i.text === 'copie depuis A')).toBe(true)
    await adminJSON(`/device/${b.id}/clipshare`, { enabled: false })
    const off = await b.read<ClipRes>('/api/phone/cliphistory', 'cliphistory', { since: 'x' })
    expect(off.items).toEqual([])
    expect((await adminJSON('/device/inconnu/clipshare', { enabled: true })).status).toBe(404)
    expect((await adminJSON(`/device/${b.id}/clipshare`, { enabled: 'oui' })).status).toBe(400)
  })
})

describe('envoi du PC vers le téléphone choisi', () => {
  it('un texte pour A n’apparaît que chez A', async () => {
    const r = await adminJSON('/outbox/text', { text: 'pour A seulement', to: a.id })
    expect(r.status).toBe(200)
    expect(await texts(a)).toContain('pour A seulement')
    expect(await texts(b)).not.toContain('pour A seulement')
  })

  it('« Tous » va aux deux ; le dernier choix devient le défaut', async () => {
    await adminJSON('/outbox/text', { text: 'pour tous', to: 'all' })
    expect(await texts(a)).toContain('pour tous')
    expect(await texts(b)).toContain('pour tous')
    expect((await state()).sendTo).toBe('all')
    await adminJSON('/outbox/text', { text: 'pour B', to: b.id })
    expect((await state()).sendTo).toBe(b.id)
    // sans choix (clic droit « Envoyer vers », ligne de commande) : le dernier
    await adminJSON('/outbox/text', { text: 'sans choix' })
    expect(await texts(b)).toContain('sans choix')
    expect(await texts(a)).not.toContain('sans choix')
    expect(srv.cfg.lastSendTo).toBe(b.id)
  })

  it('un téléphone inconnu est refusé', async () => {
    const r = await adminJSON('/outbox/text', { text: 'x', to: 'inconnu' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { code: string }).code).toBe('deviceNotFound')
    const bad = await adminJSON('/outbox/text', { text: 'x', to: [a.id, 'inconnu'] })
    expect(bad.status).toBe(400)
  })

  it('un fichier pour A : B ne le voit pas et ne peut pas le télécharger', async () => {
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('contenu privé')]), 'prive.txt')
    const up = await admin(`/outbox/file?to=${a.id}`, { method: 'POST', body: fd })
    expect(up.status).toBe(200)
    const itemsA = (await a.read<OutboxRes>('/api/phone/outbox', 'outbox')).items
    const file = itemsA.find((i) => i.name === 'prive.txt')!
    expect(file).toBeDefined()
    const itemsB = (await b.read<OutboxRes>('/api/phone/outbox', 'outbox')).items
    expect(itemsB.some((i) => i.name === 'prive.txt')).toBe(false)
    const dl = await b.post(`/api/phone/outbox/${file.id}/download`, 'download', { itemId: file.id })
    expect(dl.status).toBe(404)
    const ok = await a.post(`/api/phone/outbox/${file.id}/download`, 'download', { itemId: file.id })
    expect(ok.status).toBe(200)
    await ok.arrayBuffer()
  })

  it('une image demandée depuis l’historique ne va qu’au téléphone qui la demande', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    srv.addClipboardImage(png, 'data:image/png;base64,AAAA', 1, 1)
    const clip = await a.read<ClipRes>('/api/phone/cliphistory', 'cliphistory')
    const img = clip.items[0]!
    const r = await a.post(`/api/phone/cliphistory/${img.id}/tophone`, 'clip-tophone', { entryId: img.id })
    expect(r.status).toBe(200)
    const s = await state()
    expect(s.outbox[0]?.to).toEqual([a.id])
    const itemsB = (await b.read<OutboxRes>('/api/phone/outbox', 'outbox')).items
    expect(itemsB.some((i) => i.id === s.outbox[0]?.id)).toBe(false)
  })
})

describe('clic droit « Envoyer vers » (sans choix à l’écran)', () => {
  it('va au téléphone choisi la dernière fois', async () => {
    await adminJSON('/outbox/text', { text: 'choix B', to: b.id })
    const f = path.join(home, 'photo-locale.jpg')
    fs.writeFileSync(f, 'jpeg')
    expect(await srv.addLocalFiles([f])).toBe(1)
    const namesB = (await b.read<OutboxRes>('/api/phone/outbox', 'outbox')).items.map((i) => i.name)
    const namesA = (await a.read<OutboxRes>('/api/phone/outbox', 'outbox')).items.map((i) => i.name)
    expect(namesB).toContain('photo-locale.jpg')
    expect(namesA).not.toContain('photo-locale.jpg')
  })
})

describe('envoi automatique du presse-papiers', () => {
  it('ne part qu’aux téléphones qui voient le presse-papiers du PC', async () => {
    srv.cfg.clipboardAutoPush = true
    clipText = 'copié pendant que B ne partage pas'
    expect(await srv.pollClipboard()).toBe(true)
    expect(await texts(a)).toContain('copié pendant que B ne partage pas')
    expect(await texts(b)).not.toContain('copié pendant que B ne partage pas')
  })

  it('personne n’y a droit : rien ne part', async () => {
    await adminJSON(`/device/${a.id}/clipshare`, { enabled: false })
    const before = (await state()).outbox.length
    clipText = 'copié sans aucun téléphone autorisé'
    await srv.pollClipboard()
    expect((await state()).outbox.length).toBe(before)
    await adminJSON(`/device/${a.id}/clipshare`, { enabled: true })
    srv.cfg.clipboardAutoPush = false
  })
})

describe('mot de passe marqué par un gestionnaire', () => {
  it('« Envoyer mon presse-papiers » et le Raccourci ne l’envoient pas', async () => {
    concealed = true
    clipText = 'motdepasse123'
    const r = await adminJSON('/clipboard/push', { to: a.id })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { code: string }).code).toBe('clipboardConcealed')
    const devs = (await (await admin('/state')).json()) as { devices: { id: string; shortcutToken: string }[]; history: { preview?: string }[] }
    const tok = devs.devices.find((d) => d.id === a.id)!.shortcutToken
    const sc = await fetch(`${base}/api/shortcut/clipboard?t=${tok}`)
    expect(sc.status).toBe(200)
    expect(await sc.text()).toBe('')
    const after = (await (await admin('/state')).json()) as { history: { preview?: string }[] }
    expect(after.history.some((h) => h.preview === 'motdepasse123')).toBe(false)
    concealed = false
  })
})

describe('appairages d’avant le partage par téléphone', () => {
  it('tous les téléphones déjà appairés gardent le presse-papiers (ils le voyaient tous)', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-mig-'))
    const dev = (id: string, createdAt: string, status = 'active', lastSeenAt?: string) => ({
      id,
      name: id,
      keyB64: b64u.enc(new Uint8Array(32)),
      shortcutToken: randomToken(18),
      status,
      createdAt,
      lastSeenAt,
    })
    // « premier » : une trace morte du même téléphone, rescanné depuis ;
    // « deuxieme » : le téléphone vraiment utilisé. Il ne perd rien.
    fs.writeFileSync(
      path.join(h, 'devices.json'),
      JSON.stringify([
        dev('deuxieme', '2026-05-02T10:00:00Z', 'active', '2026-09-25T10:00:00Z'),
        dev('premier', '2026-04-01T10:00:00Z', 'active', '2026-04-02T10:00:00Z'),
        dev('attente', '2026-01-01T10:00:00Z', 'pending'),
      ])
    )
    const store = new DeviceStore(h)
    expect(store.clipShared('deuxieme')).toBe(true)
    expect(store.clipShared('premier')).toBe(true)
    // un QR jamais scanné n'a rien
    expect(store.clipShared('attente')).toBe(false)
    // écrit sur le disque : le choix ne bouge plus au lancement suivant
    const again = new DeviceStore(h)
    expect(again.clipShared('premier')).toBe(true)
    expect(again.clipShared('deuxieme')).toBe(true)
    // un réglage déjà fait n'est jamais écrasé
    again.setClipShare('premier', false)
    expect(new DeviceStore(h).clipShared('premier')).toBe(false)
    expect(new DeviceStore(h).clipShared('deuxieme')).toBe(true)
    // un téléphone appairé après la mise à jour part sans (il y en a déjà)
    const fresh = again.create()
    again.activate(fresh.id, { name: 'Pixel 8', platform: 'android' })
    expect(again.clipShared(fresh.id)).toBe(false)
    fs.rmSync(h, { recursive: true, force: true })
  })

  it('file d’envoi : un deuxième téléphone réserve le passé aux premiers', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ob-'))
    const box = new Outbox(h)
    const old = box.addText('ancien')
    const v = box.version
    box.restrictUntargeted(['A'])
    expect(box.version).toBeGreaterThan(v)
    expect(box.visibleTo(old, 'A')).toBe(true)
    expect(box.visibleTo(old, 'B')).toBe(false)
    expect(box.listForPhone('B')).toEqual([])
    fs.rmSync(h, { recursive: true, force: true })
  })

  it('file d’envoi : le même téléphone rescanné retrouve ce qui attendait son ancien appairage', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ob-'))
    const box = new Outbox(h)
    const forA = box.addText('pour A', 'text', ['A'])
    const forB = box.addText('pour B', 'text', ['B'])
    const all = box.addText('pour tous')
    const v = box.version
    box.shareTargets(['A'], 'A2')
    expect(box.version).toBeGreaterThan(v)
    expect(box.visibleTo(forA, 'A2')).toBe(true)
    expect(box.visibleTo(forB, 'A2')).toBe(false)
    expect(all.to).toBeUndefined()
    // deux fois : pas de doublon, pas de changement annoncé
    const v2 = box.version
    box.shareTargets(['A'], 'A2')
    expect(forA.to).toEqual(['A', 'A2'])
    expect(box.version).toBe(v2)
    fs.rmSync(h, { recursive: true, force: true })
  })
})
