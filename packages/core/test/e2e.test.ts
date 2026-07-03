import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, open, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

let srv: RunningServer
let base = ''
let home = ''
let dl = ''

const adminHeaders = () => ({ 'x-admin-token': srv.adminToken })
const admin = (p: string, init?: RequestInit) =>
  fetch(base + '/api/admin' + p, { ...init, headers: { ...(init?.headers ?? {}), ...adminHeaders() } })

interface Phone {
  id: string
  key: Uint8Array
  aad: (purpose: string, extra?: string) => string
  envelope: (purpose: string, obj: Record<string, unknown>) => string
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
}

function makePhone(pairUrl: string): Phone {
  const frag = pairUrl.split('#')[1] as string
  const dot = frag.indexOf('.')
  const id = frag.slice(0, dot)
  const key = b64u.dec(frag.slice(dot + 1))
  const aad = (purpose: string, extra = '') => `wd1|${id}|${purpose}${extra ? '|' + extra : ''}`
  const envelope = (purpose: string, obj: Record<string, unknown>) =>
    JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) })
  const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: envelope(purpose, obj),
    })
  return { id, key, aad, envelope, post }
}

async function pairPhone(): Promise<Phone> {
  const res = await admin('/pair/new', { method: 'POST' })
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  const phone = makePhone(url)
  const hello = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone de test', platform: 'iphone' })
  expect(hello.status).toBe(200)
  const body = (await hello.json()) as { p: string }
  const decoded = openJSON<{ desktopName: string }>(phone.key, body.p, phone.aad('hello:res'))
  expect(decoded.desktopName.length).toBeGreaterThan(0)
  return phone
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-home-'))
  dl = path.join(home, 'dl')
  process.env.FLITDROP_DOWNLOADS = dl
  srv = await startServer({ port: 0, home, disableClipboard: true })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
})

describe('admin', () => {
  it('refuse sans jeton', async () => {
    const r = await fetch(base + '/api/admin/state')
    expect(r.status).toBe(401)
  })
  it('donne l’état avec jeton', async () => {
    const r = await admin('/state')
    expect(r.status).toBe(200)
    const s = (await r.json()) as { product: string }
    expect(s.product).toBe('Flitdrop')
  })
})

describe('transfert téléphone -> PC', () => {
  it('appairage, envoi chiffré multi-chunks, nom hostile neutralisé', async () => {
    const phone = await pairPhone()
    const size = 3_500_000
    const data = crypto.randomBytes(size)
    const chunkSize = 1_000_000
    const chunks = Math.ceil(size / chunkSize)

    const initRes = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: '..\\..\\évil rapport*.pdf', size, mime: 'application/pdf', chunkSize, chunks },
    })
    expect(initRes.status).toBe(200)
    const initBody = (await initRes.json()) as { p: string }
    const { transferId } = openJSON<{ transferId: string }>(phone.key, initBody.p, phone.aad('init:res'))

    for (let n = 0; n < chunks; n++) {
      const slice = data.subarray(n * chunkSize, Math.min((n + 1) * chunkSize, size))
      const sealed = seal(phone.key, slice, phone.aad('chunk', `${transferId}|${n}`))
      const r = await fetch(`${base}/api/phone/transfer/${transferId}/chunk/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
        body: sealed as unknown as BodyInit,
      })
      expect(r.status).toBe(200)
    }

    const fin = await phone.post(`/api/phone/transfer/${transferId}/finish`, 'finish', { transferId })
    expect(fin.status).toBe(200)
    const finBody = (await fin.json()) as { p: string }
    const { name } = openJSON<{ name: string }>(phone.key, finBody.p, phone.aad('finish:res'))
    expect(name).toBe('évil rapport.pdf')

    const written = fs.readFileSync(path.join(dl, name))
    expect(written.length).toBe(size)
    expect(crypto.createHash('sha256').update(written).digest('hex')).toBe(
      crypto.createHash('sha256').update(data).digest('hex')
    )
  })

  it('reprend un transfert interrompu via l’endpoint de statut', async () => {
    const phone = await pairPhone()
    const size = 2_500_000
    const data = crypto.randomBytes(size)
    const chunkSize = 500_000
    const chunks = Math.ceil(size / chunkSize) // 5
    const initRes = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'reprise.bin', size, chunkSize, chunks },
    })
    const { transferId } = openJSON<{ transferId: string }>(
      phone.key,
      ((await initRes.json()) as { p: string }).p,
      phone.aad('init:res')
    )
    const sendChunk = (nn: number) => {
      const slice = data.subarray(nn * chunkSize, Math.min((nn + 1) * chunkSize, size))
      const sealed = seal(phone.key, slice, phone.aad('chunk', `${transferId}|${nn}`))
      return fetch(`${base}/api/phone/transfer/${transferId}/chunk/${nn}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
        body: sealed as unknown as BodyInit,
      })
    }
    expect((await sendChunk(0)).status).toBe(200)
    expect((await sendChunk(1)).status).toBe(200)
    // le téléphone « revient » et demande où il en est
    const st = await fetch(`${base}/api/phone/transfer/${transferId}/status`, { headers: { 'x-wd-device': phone.id } })
    expect(st.status).toBe(200)
    const { received } = (await st.json()) as { received: number }
    expect(received).toBe(2)
    for (let nn = received; nn < chunks; nn++) expect((await sendChunk(nn)).status).toBe(200)
    const fin = await phone.post(`/api/phone/transfer/${transferId}/finish`, 'finish', { transferId })
    expect(fin.status).toBe(200)
    const written = fs.readFileSync(path.join(dl, 'reprise.bin'))
    expect(Buffer.compare(written, data)).toBe(0)
  })

  it('accepte la ré-émission idempotente d’un chunk déjà reçu', async () => {
    const phone = await pairPhone()
    const data = crypto.randomBytes(600_000)
    const initRes = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'retry.bin', size: data.length, chunkSize: 500_000, chunks: 2 },
    })
    const { transferId } = openJSON<{ transferId: string }>(
      phone.key,
      ((await initRes.json()) as { p: string }).p,
      phone.aad('init:res')
    )
    const sealed0 = seal(phone.key, data.subarray(0, 500_000), phone.aad('chunk', `${transferId}|0`))
    const send = (body: Uint8Array, n: number) =>
      fetch(`${base}/api/phone/transfer/${transferId}/chunk/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
        body: body as unknown as BodyInit,
      })
    expect((await send(sealed0, 0)).status).toBe(200)
    // ré-émission du même chunk (reprise réseau) : ack sans double écriture
    const dup = await send(sealed0, 0)
    expect(dup.status).toBe(200)
    expect(((await dup.json()) as { received: number }).received).toBe(1)
    const sealed1 = seal(phone.key, data.subarray(500_000), phone.aad('chunk', `${transferId}|1`))
    expect((await send(sealed1, 1)).status).toBe(200)
    const fin = await phone.post(`/api/phone/transfer/${transferId}/finish`, 'finish', { transferId })
    expect(fin.status).toBe(200)
  })

  it('rejette un chunk altéré', async () => {
    const phone = await pairPhone()
    const initRes = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'tamper.bin', size: 100, chunkSize: 100, chunks: 1 },
    })
    const { transferId } = openJSON<{ transferId: string }>(
      phone.key,
      ((await initRes.json()) as { p: string }).p,
      phone.aad('init:res')
    )
    const sealed = seal(phone.key, crypto.randomBytes(100), phone.aad('chunk', `${transferId}|0`))
    sealed[40] = ((sealed[40] as number) ^ 0xff) & 0xff
    const r = await fetch(`${base}/api/phone/transfer/${transferId}/chunk/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
      body: sealed as unknown as BodyInit,
    })
    expect(r.status).toBe(403)
  })

  it('rejette le rejeu d’une enveloppe init', async () => {
    const phone = await pairPhone()
    const body = phone.envelope('init', { meta: { name: 'a.bin', size: 10, chunkSize: 10, chunks: 1 } })
    const send = () =>
      fetch(base + '/api/phone/transfer/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wd-device': phone.id },
        body,
      })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(403)
  })

  it('rejette un appareil inconnu et une taille excessive', async () => {
    const fake = await fetch(base + '/api/phone/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': 'inconnu123' },
      body: JSON.stringify({ p: 'xxxx' }),
    })
    expect(fake.status).toBe(403)

    const phone = await pairPhone()
    const tooBig = await phone.post('/api/phone/transfer/init', 'init', {
      meta: { name: 'big.bin', size: (srv.cfg.maxFileMB + 1) * 1024 * 1024, chunkSize: 1_000_000, chunks: 99999999 },
    })
    expect([400, 413]).toContain(tooBig.status)
  })
})

describe('texte -> presse-papiers', () => {
  it('reçoit un texte chiffré', async () => {
    const phone = await pairPhone()
    const r = await phone.post('/api/phone/text', 'text', { text: 'code wifi: été-2026', mode: 'clip' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { p: string }
    const res = openJSON<{ ok: boolean }>(phone.key, body.p, phone.aad('text:res'))
    expect(res.ok).toBe(true)
  })
})

describe('raccourci iOS (jeton)', () => {
  it('upload multipart avec jeton valide, refus sinon', async () => {
    const phone = await pairPhone()
    const state = (await (await admin('/state')).json()) as { devices: { id: string; shortcutToken: string }[] }
    const token = state.devices.find((d) => d.id === phone.id)?.shortcutToken as string

    const fd = new FormData()
    const payload = crypto.randomBytes(20_000)
    fd.append('file', new Blob([payload], { type: 'image/jpeg' }), 'IMG_0042.JPG')
    const ok = await fetch(`${base}/api/shortcut/upload?t=${token}`, { method: 'POST', body: fd })
    expect(ok.status).toBe(200)
    const saved = fs.readFileSync(path.join(dl, 'IMG_0042.JPG'))
    expect(Buffer.compare(saved, payload)).toBe(0)

    const bad = await fetch(`${base}/api/shortcut/upload?t=jetonbidon12345`, { method: 'POST', body: fd })
    expect(bad.status).toBe(401)
  })

  it('texte via raccourci', async () => {
    const phone = await pairPhone()
    const state = (await (await admin('/state')).json()) as { devices: { id: string; shortcutToken: string }[] }
    const token = state.devices.find((d) => d.id === phone.id)?.shortcutToken as string
    const r = await fetch(`${base}/api/shortcut/text?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'coucou depuis le raccourci',
    })
    expect(r.status).toBe(200)
  })
})

describe('PC -> téléphone (outbox)', () => {
  it('texte mis à disposition puis vu par le téléphone', async () => {
    const phone = await pairPhone()
    const add = await admin('/outbox/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'lien: https://exemple.fr' }),
    })
    expect(add.status).toBe(200)
    const poll = await phone.post('/api/phone/outbox', 'outbox', {})
    expect(poll.status).toBe(200)
    const body = (await poll.json()) as { p: string }
    const { items } = openJSON<{ items: { kind: string; text?: string }[] }>(phone.key, body.p, phone.aad('outbox:res'))
    expect(items.some((i) => i.kind === 'text' && i.text === 'lien: https://exemple.fr')).toBe(true)
  })

  it('fichier téléchargé en frames chiffrées, intègre', async () => {
    const phone = await pairPhone()
    const payload = crypto.randomBytes(9_000_000)
    const fd = new FormData()
    fd.append('file', new Blob([payload]), 'video.mp4')
    const up = await admin('/outbox/file', { method: 'POST', body: fd })
    expect(up.status).toBe(200)

    const poll = await phone.post('/api/phone/outbox', 'outbox', {})
    const { items } = openJSON<{ items: { id: string; kind: string; name?: string; size?: number }[] }>(
      phone.key,
      ((await poll.json()) as { p: string }).p,
      phone.aad('outbox:res')
    )
    const file = items.find((i) => i.kind === 'file' && i.name === 'video.mp4')
    expect(file).toBeDefined()

    const dlRes = await phone.post(`/api/phone/outbox/${file!.id}/download`, 'download', { itemId: file!.id })
    expect(dlRes.status).toBe(200)
    const raw = new Uint8Array(await dlRes.arrayBuffer())
    const parts: Uint8Array[] = []
    let off = 0
    let frame = 0
    while (off < raw.length) {
      const len = new DataView(raw.buffer, raw.byteOffset + off, 4).getUint32(0)
      const sealed = raw.subarray(off + 4, off + 4 + len)
      parts.push(open(phone.key, sealed, phone.aad('dl', `${file!.id}|${frame}`)))
      off += 4 + len
      frame++
    }
    const joined = Buffer.concat(parts.map((p) => Buffer.from(p)))
    expect(joined.length).toBe(payload.length)
    expect(Buffer.compare(joined, payload)).toBe(0)
  })
})
