import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { TransferActivity, type TransferActivityState } from '../src/activity.js'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

function recorder(a: TransferActivity) {
  const seen: TransferActivityState[] = []
  a.on('transfer', (s: TransferActivityState) => seen.push(s))
  return seen
}

describe('activité des transferts (minuterie du coeur)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('au repos : aucune minuterie, aucun événement', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(seen).toEqual([])
    expect(a.state()).toEqual({ active: false, progress: null })
  })

  it('premier octet : actif tout de suite, avec la progression', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.update('up:1', 1_000, 4_000)
    expect(seen).toEqual([{ active: true, progress: 0.25 }])
  })

  it('octets sans taille connue : actif, progression null', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.touch()
    expect(seen).toEqual([{ active: true, progress: null }])
  })

  it('au plus 2 annonces par seconde, et la dernière valeur arrive toujours', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    const total = 10_000
    // un paquet toutes les 10 ms pendant 5 s
    for (let i = 1; i <= 500; i++) {
      a.update('dl:x', i * 20, total)
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(600)
    // 5 s : 1 annonce immédiate + 10 annonces espacées de 500 ms au plus
    expect(seen.length).toBeLessThanOrEqual(11)
    expect(seen.length).toBeGreaterThanOrEqual(9)
    expect(seen.at(-1)).toEqual({ active: true, progress: 1 })
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.progress!).toBeGreaterThanOrEqual(seen[i - 1]!.progress!)
  })

  it('inactif 30 s après le dernier octet, pas avant', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.update('up:1', 10, 100)
    vi.advanceTimersByTime(20_000)
    // encore des octets : le délai repart de là
    a.touch()
    vi.advanceTimersByTime(29_999)
    expect(a.state().active).toBe(true)
    expect(seen.at(-1)?.active).toBe(true)
    vi.advanceTimersByTime(1)
    expect(seen.at(-1)).toEqual({ active: false, progress: null })
    expect(a.state()).toEqual({ active: false, progress: null })
    // plus aucune minuterie une fois retombé au repos
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fin d’un transfert : il sort de la progression, l’activité reste 30 s', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.update('up:1', 50, 100)
    a.update('dl:2', 0, 100)
    vi.advanceTimersByTime(600)
    expect(seen.at(-1)).toEqual({ active: true, progress: 0.25 })
    a.end('up:1')
    vi.advanceTimersByTime(600)
    expect(seen.at(-1)).toEqual({ active: true, progress: 0 })
    a.end('dl:2')
    vi.advanceTimersByTime(600)
    expect(seen.at(-1)).toEqual({ active: true, progress: null })
    vi.advanceTimersByTime(30_000)
    expect(seen.at(-1)).toEqual({ active: false, progress: null })
  })

  it('un transfert muet depuis 30 s ne fige pas la progression des autres', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.update('up:abandon', 0, 1_000_000)
    for (let s = 0; s < 31; s++) {
      a.update('dl:vivant', s, 100)
      vi.advanceTimersByTime(1_000)
    }
    a.update('dl:vivant', 40, 100)
    vi.advanceTimersByTime(600)
    expect(seen.at(-1)).toEqual({ active: true, progress: 0.4 })
  })

  it('reprise après le repos : de nouveau actif', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.touch()
    vi.advanceTimersByTime(31_000)
    a.update('up:2', 1, 2)
    expect(seen.map((s) => s.active)).toEqual([true, false, true])
    expect(seen.at(-1)).toEqual({ active: true, progress: 0.5 })
  })

  it('fermeture : minuteries arrêtées, plus rien n’est annoncé', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    const seen = recorder(a)
    a.update('up:1', 1, 10)
    a.update('up:1', 2, 10)
    a.close()
    expect(vi.getTimerCount()).toBe(0)
    a.update('up:1', 3, 10)
    vi.advanceTimersByTime(60_000)
    expect(seen).toEqual([{ active: true, progress: 0.1 }])
  })

  it('un écouteur qui plante ne casse rien', () => {
    vi.useFakeTimers()
    const a = new TransferActivity()
    a.on('transfer', () => {
      throw new Error('écouteur cassé')
    })
    expect(() => a.update('up:1', 1, 2)).not.toThrow()
  })
})

// ---------- branché sur le vrai serveur ----------

let srv: RunningServer
let base = ''
let home = ''

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
async function pairPhone(): Promise<Phone> {
  const r = await fetch(base + '/api/admin/pair/new', { method: 'POST', headers: { 'x-admin-token': srv.adminToken } })
  const { url } = (await r.json()) as { url: string }
  const [id, k] = (url.split('#')[1] as string).split('.')
  const phone = phoneFrom(id as string, b64u.dec(k as string))
  const h = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'Pixel', platform: 'android' })
  const dec = openJSON<{ newKey?: string }>(phone.key, ((await h.json()) as { p: string }).p, phone.aad('hello:res'))
  return dec.newKey ? phoneFrom(phone.id, b64u.dec(dec.newKey)) : phone
}
const entries = () => [...(srv.activity as unknown as { entries: Map<string, unknown> }).entries.keys()]

describe('activité des transferts sur le serveur', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-act-'))
    process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
    srv = await startServer({ port: 0, home, disableClipboard: true })
    base = `http://127.0.0.1:${srv.port}`
  })
  afterAll(async () => {
    await srv.close()
    delete process.env.FLITDROP_DOWNLOADS
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rien au repos, même quand le téléphone relit ses listes', async () => {
    const phone = await pairPhone()
    await phone.post('/api/phone/outbox', 'outbox', {})
    await phone.post('/api/phone/cliphistory', 'cliphistory', {})
    await phone.post('/api/phone/text', 'text', { text: 'court', mode: 'message' })
    expect(srv.activity.state()).toEqual({ active: false, progress: null })
  })

  it('envoi du téléphone vers le PC : actif dès le premier morceau, puis sorti du calcul', async () => {
    const phone = await pairPhone()
    const seen = recorder(srv.activity)
    const size = 1_500_000
    const chunkSize = 500_000
    const data = crypto.randomBytes(size)
    const initRes = await phone.post('/api/phone/transfer/init', 'init', { meta: { name: 'act.bin', size, chunkSize, chunks: 3 } })
    const { transferId } = openJSON<{ transferId: string }>(phone.key, ((await initRes.json()) as { p: string }).p, phone.aad('init:res'))
    // début du transfert (métadonnées) : pas encore d'octets de fichier
    expect(seen).toEqual([])
    for (let n = 0; n < 3; n++) {
      const sealed = seal(phone.key, data.subarray(n * chunkSize, (n + 1) * chunkSize), phone.aad('chunk', `${transferId}|${n}`))
      const r = await fetch(`${base}/api/phone/transfer/${transferId}/chunk/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
        body: sealed as unknown as BodyInit,
      })
      expect(r.status).toBe(200)
      if (n === 0) {
        expect(seen[0]?.active).toBe(true)
        expect(seen[0]?.progress).toBeGreaterThanOrEqual(0)
      }
    }
    await phone.post(`/api/phone/transfer/${transferId}/finish`, 'finish', { transferId })
    expect(entries()).not.toContain(`up:${transferId}`)
    await new Promise((r) => setTimeout(r, 600))
    expect(seen.at(-1)).toEqual({ active: true, progress: null })
    for (const s of seen) if (s.progress !== null) expect(s.progress).toBeLessThanOrEqual(1)
  })

  it('téléchargement du PC vers le téléphone et long texte : comptés, puis sortis du calcul', async () => {
    const phone = await pairPhone()
    const keys: string[] = []
    const real = srv.activity.update.bind(srv.activity)
    srv.activity.update = (k: string, d: number, t: number) => {
      keys.push(k)
      real(k, d, t)
    }
    try {
      const fd = new FormData()
      fd.append('file', new Blob([crypto.randomBytes(9_000_000)]), 'retour.bin')
      await fetch(base + '/api/admin/outbox/file', { method: 'POST', body: fd, headers: { 'x-admin-token': srv.adminToken } })
      const poll = await phone.post('/api/phone/outbox', 'outbox', {})
      const { items } = openJSON<{ items: { id: string; name?: string }[] }>(phone.key, ((await poll.json()) as { p: string }).p, phone.aad('outbox:res'))
      const file = items.find((i) => i.name === 'retour.bin')!
      const dl = await phone.post(`/api/phone/outbox/${file.id}/download`, 'download', { itemId: file.id })
      await dl.arrayBuffer()
      await phone.post('/api/phone/text', 'text', { text: 'long '.repeat(40_000), mode: 'message' })
      await phone.post('/api/phone/text', 'text', { text: 'court', mode: 'message' })
    } finally {
      srv.activity.update = real
    }
    // 9 Mo lus par blocs de 4 Mo : plusieurs étapes pour un seul téléchargement
    const dlKeys = keys.filter((k) => k.startsWith('dl:'))
    expect(dlKeys.length).toBeGreaterThanOrEqual(3)
    expect(new Set(dlKeys).size).toBe(1)
    // un seul texte long compté ; le court ne l'est pas
    expect(new Set(keys.filter((k) => k.startsWith('txt:'))).size).toBe(1)
    expect(entries().some((k) => k.startsWith('dl:') || k.startsWith('txt:'))).toBe(false)
    expect(srv.activity.state().active).toBe(true)
  })

  it('envoi par Raccourci iOS : compté, et le fichier arrive entier', async () => {
    const phone = await pairPhone()
    const st = await fetch(base + '/api/admin/state', { headers: { 'x-admin-token': srv.adminToken } })
    const token = ((await st.json()) as { devices: { id: string; shortcutToken: string }[] }).devices.find((d) => d.id === phone.id)!.shortcutToken
    const keys: string[] = []
    const real = srv.activity.update.bind(srv.activity)
    srv.activity.update = (k: string, d: number, t: number) => {
      keys.push(k)
      real(k, d, t)
    }
    const payload = crypto.randomBytes(3_000_000)
    try {
      const fd = new FormData()
      fd.append('file', new Blob([payload], { type: 'image/jpeg' }), 'IMG_7.JPG')
      const r = await fetch(`${base}/api/shortcut/upload?t=${token}`, { method: 'POST', body: fd })
      expect(r.status).toBe(200)
    } finally {
      srv.activity.update = real
    }
    // le suivi des octets ne fait rien perdre au lecteur du corps (busboy)
    const saved = fs.readFileSync(path.join(home, 'dl', 'IMG_7.JPG'))
    expect(Buffer.compare(saved, payload)).toBe(0)
    expect(keys.some((k) => k.startsWith('sc:'))).toBe(true)
    expect(entries().some((k) => k.startsWith('sc:'))).toBe(false)
  })
})
