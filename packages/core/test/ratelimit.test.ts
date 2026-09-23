import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer, type RunningServer } from '../src/server.js'
import { seal, sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Serveur à part (un par bloc) : le compteur par adresse est partagé par tous
// les tests d'un même serveur, on veut une minute « propre ».
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

function useServer(): void {
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
}

/** Requêtes en boucle ; rend les statuts HTTP. */
async function hammer(n: number, make: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < n; i++) {
    const r = await make()
    statuses.push(r.status)
    await r.arrayBuffer()
  }
  return statuses
}

const chunkWithId = (id: string, tid = 'abc') =>
  fetch(`${base}/api/phone/transfer/${tid}/chunk/0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-wd-device': id },
    body: 'x',
  })

const statusWithId = (id: string, tid = 'abc') => fetch(`${base}/api/phone/transfer/${tid}/status`, { headers: { 'x-wd-device': id } })

// Une autre adresse que 127.0.0.1 pour joindre le serveur : l'adresse wifi de
// la machine, sinon 127.0.0.2 (Linux). Sans aucune, le test est sauté.
function lanIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return undefined
}
async function canBind(addr: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, addr, () => s.close(() => resolve(true)))
  })
}
const other: { host?: string; localAddress?: string } = {}
const lan = lanIPv4()
if (lan) other.host = lan
else if (await canBind('127.0.0.2')) {
  other.host = '127.0.0.1'
  other.localAddress = '127.0.0.2'
}
const otherAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })

function postFromOther(p: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: other.host, localAddress: other.localAddress, port: srv.port, path: p, method: 'POST', headers, agent: otherAgent },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('limite de débit des transferts', () => {
  useServer()

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

describe('identifiant du téléphone réutilisé depuis une autre adresse', () => {
  useServer()

  it.runIf(!!other.host)(
    'remplir le budget depuis une autre machine ne bloque pas le vrai téléphone',
    { timeout: 120_000 },
    async () => {
      const phone = await pairPhone()
      const data = crypto.randomBytes(128)
      const { status, tid } = await init(phone, 'apres.bin', data.length, 64)
      expect(status).toBe(200)
      // l'identifiant a été vu passer en clair sur le wifi
      let refused = 0
      for (let i = 0; i < 6010; i++) {
        const s = await postFromOther(
          '/api/phone/transfer/nexistepas/chunk/0',
          { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
          'x'
        )
        if (s === 429) refused++
      }
      // l'autre machine a bien vidé SON compteur...
      expect(refused).toBeGreaterThan(0)
      // ...mais le vrai téléphone continue d'envoyer
      const c0 = await chunk(phone, tid!, 0, data.subarray(0, 64))
      expect(c0.status).toBe(200)
      const c1 = await chunk(phone, tid!, 1, data.subarray(64))
      expect(c1.status).toBe(200)
      const fin = await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
      expect(fin.status).toBe(200)
    }
  )
})

describe('qui garde la limite stricte (240 par minute et par adresse)', () => {
  describe('téléphone appairé hors transferts', () => {
    useServer()
    it('file d’envoi : la 241e requête de la minute est refusée', { timeout: 30_000 }, async () => {
      const phone = await pairPhone() // hello : 1 requête
      const statuses = await hammer(245, () => phone.post('/api/phone/outbox', 'outbox', {}))
      expect(statuses.slice(0, 239).every((s) => s === 200)).toBe(true)
      expect(statuses.slice(239).every((s) => s === 429)).toBe(true)
    })
  })

  describe('statut d’un transfert (sans authentification)', () => {
    useServer()
    it('même avec l’identifiant d’un téléphone appairé', { timeout: 30_000 }, async () => {
      const phone = await pairPhone()
      const statuses = await hammer(245, () => statusWithId(phone.id))
      expect(statuses.slice(0, 239).every((s) => s === 404)).toBe(true)
      expect(statuses.at(-1)).toBe(429)
    })
  })

  describe('appareil en attente (QR affiché, jamais scanné)', () => {
    useServer()
    it('morceaux et statut refusés, puis limités', { timeout: 30_000 }, async () => {
      const res = await fetch(base + '/api/admin/pair/new', { method: 'POST', headers: { 'x-admin-token': srv.adminToken } })
      const { url } = (await res.json()) as { url: string }
      const id = (url.split('#')[1] as string).split('.')[0] as string
      const statuses = [...(await hammer(120, () => chunkWithId(id))), ...(await hammer(125, () => statusWithId(id)))]
      // jamais accepté ; refusé par la limite dès la 241e requête
      expect(statuses.every((s) => s !== 200)).toBe(true)
      expect(statuses.slice(0, 240).every((s) => s !== 429)).toBe(true)
      expect(statuses.slice(240).every((s) => s === 429)).toBe(true)
    })
  })

  describe('téléphone retiré', () => {
    useServer()
    it('morceaux et statut refusés (403), puis limités', { timeout: 30_000 }, async () => {
      const phone = await pairPhone()
      const { tid } = await init(phone, 'retire.bin', 64, 64)
      const rv = await fetch(`${base}/api/admin/device/${phone.id}/revoke`, { method: 'POST', headers: { 'x-admin-token': srv.adminToken } })
      expect(rv.status).toBe(200)
      const statuses = [...(await hammer(120, () => chunkWithId(phone.id, tid))), ...(await hammer(125, () => statusWithId(phone.id, tid)))]
      // hello et init comptent déjà : 238 requêtes passent la limite, toutes refusées
      expect(statuses.slice(0, 238).every((s) => s === 403)).toBe(true)
      expect(statuses.at(-1)).toBe(429)
    })
  })
})
