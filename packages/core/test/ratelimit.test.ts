import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Serveur à part : le compteur par adresse est partagé par tous les tests d'un
// même serveur, on veut ici une minute « propre ».
let srv: RunningServer
let base = ''
let home = ''
let dl = ''

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
  const res = await fetch(base + '/api/admin/pair/new', { method: 'POST', headers: { 'x-admin-token': srv.adminToken } })
  const { url } = (await res.json()) as { url: string }
  const parts = (url.split('#')[1] as string).split('.')
  const phone = phoneFrom(parts[0] as string, b64u.dec(parts[1] as string))
  const hello = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone', platform: 'iphone' })
  const decoded = openJSON<{ newKey?: string }>(phone.key, ((await hello.json()) as { p: string }).p, phone.aad('hello:res'))
  return decoded.newKey ? phoneFrom(phone.id, b64u.dec(decoded.newKey)) : phone
}

async function init(phone: Phone, name: string, size: number, chunkSize: number): Promise<{ status: number; tid?: string }> {
  const r = await phone.post('/api/phone/transfer/init', 'init', {
    meta: { name, size, chunkSize, chunks: Math.ceil(size / chunkSize) },
  })
  if (r.status !== 200) return { status: r.status }
  const { transferId } = openJSON<{ transferId: string }>(phone.key, ((await r.json()) as { p: string }).p, phone.aad('init:res'))
  return { status: 200, tid: transferId }
}

function chunk(phone: Phone, tid: string, n: number, data: Buffer): Promise<Response> {
  return fetch(`${base}/api/phone/transfer/${tid}/chunk/${n}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
    body: seal(phone.key, data, phone.aad('chunk', `${tid}|${n}`)) as unknown as BodyInit,
  })
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-rate-'))
  dl = path.join(home, 'dl')
  process.env.FLITDROP_DOWNLOADS = dl
  srv = await startServer({ port: 0, home, disableClipboard: true, quiet: true })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
  fs.rmSync(home, { recursive: true, force: true })
})

describe('limite de débit des transferts', () => {
  it('un téléphone appairé envoie 300 morceaux dans la minute sans aucun refus', { timeout: 30_000 }, async () => {
    const phone = await pairPhone()
    const chunkSize = 64
    const data = crypto.randomBytes(300 * chunkSize)
    const { status, tid } = await init(phone, 'gros.bin', data.length, chunkSize)
    expect(status).toBe(200)
    const statuses: number[] = []
    for (let n = 0; n < 300; n++) {
      const r = await chunk(phone, tid!, n, data.subarray(n * chunkSize, (n + 1) * chunkSize))
      statuses.push(r.status)
      await r.arrayBuffer()
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(0)
    expect(statuses.every((s) => s === 200)).toBe(true)
    const st = await fetch(`${base}/api/phone/transfer/${tid}/status`, { headers: { 'x-wd-device': phone.id } })
    expect(st.status).toBe(200)
    const fin = await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
    expect(fin.status).toBe(200)
    expect(Buffer.compare(fs.readFileSync(path.join(dl, 'gros.bin')), data)).toBe(0)
  })

  it('un lot de 90 photos (début + morceau + fin, 270 requêtes) passe en entier', { timeout: 30_000 }, async () => {
    const phone = await pairPhone()
    let refused = 0
    for (let i = 0; i < 90; i++) {
      const data = crypto.randomBytes(200)
      const { status, tid } = await init(phone, `photo-${i}.jpg`, data.length, 1024)
      if (status === 429) refused++
      expect(status).toBe(200)
      const c = await chunk(phone, tid!, 0, data)
      if (c.status === 429) refused++
      expect(c.status).toBe(200)
      const fin = await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
      if (fin.status === 429) refused++
      expect(fin.status).toBe(200)
    }
    expect(refused).toBe(0)
  })

  it('un morceau pour un transfert inexistant est refusé avant la lecture du corps', async () => {
    const phone = await pairPhone()
    const r = await chunk(phone, 'nexistepas', 0, Buffer.alloc(10))
    expect(r.status).toBe(404)
  })

  it('un appareil inconnu garde la limite stricte (241e requête refusée)', { timeout: 30_000 }, async () => {
    const statuses: number[] = []
    for (let i = 0; i < 245; i++) {
      const r = await fetch(`${base}/api/phone/transfer/abc/chunk/0`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': 'inconnu' },
        body: 'x',
      })
      statuses.push(r.status)
      await r.arrayBuffer()
    }
    // les appairages des tests précédents (hello) comptent aussi dans cette limite
    expect(statuses.slice(0, 200).every((s) => s === 403)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})
