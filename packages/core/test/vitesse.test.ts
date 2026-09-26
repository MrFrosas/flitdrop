// Chemin rapide des transferts, de bout en bout avec le vrai serveur : chiffrement
// du téléphone dans les Workers (même code que cw.js), coupure en plein
// morceau puis reprise, compatibilité avec les anciennes pages et un PC resté
// sur l'ancien moteur, test de vitesse authentifié, politique de sécurité.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/server.js'
import { sealJSON, openJSON, randomToken, _setAeadEngine } from '../src/crypto.js'
import { makeCryptoRunner, type CryptoJob } from '../src/webclient/cryptojob.js'
import * as wd from '../src/webclient/wdcrypto.js'
import { b64u } from '../src/util.js'

let srv: RunningServer
let base = ''
let home = ''
let dl = ''
let port = 0

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

let features: string[] | undefined
async function pairPhone(): Promise<Phone> {
  const res = await fetch(base + '/api/admin/pair/new', { method: 'POST', headers: { 'x-admin-token': srv.adminToken } })
  const { url } = (await res.json()) as { url: string }
  const parts = (url.split('#')[1] as string).split('.')
  const phone = phoneFrom(parts[0]!, b64u.dec(parts[1]!))
  const hello = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone', platform: 'iphone' })
  const d = openJSON<{ newKey?: string; features?: string[] }>(phone.key, ((await hello.json()) as { p: string }).p, phone.aad('hello:res'))
  features = d.features
  return d.newKey ? phoneFrom(phone.id, b64u.dec(d.newKey)) : phone
}

// le Worker de chiffrement du téléphone, tel quel (WebAssembly)
const runner = makeCryptoRunner()
function workerSeal(key: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  const { reply } = runner.handle({ id: 1, op: 'seal', key, aad, buf: new Uint8Array(plain).buffer } as CryptoJob)
  if ('error' in reply || !('buf' in reply)) throw new Error('seal')
  return new Uint8Array(reply.buf)
}
function workerOpen(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  const { reply } = runner.handle({ id: 1, op: 'open', key, aad, buf: new Uint8Array(sealed).buffer } as CryptoJob)
  if ('error' in reply || !('buf' in reply)) throw new Error('open')
  return new Uint8Array(reply.buf)
}

async function init(phone: Phone, name: string, size: number, chunkSize: number) {
  const r = await phone.post('/api/phone/transfer/init', 'init', { meta: { name, size, chunkSize, chunks: Math.ceil(size / chunkSize) } })
  expect(r.status).toBe(200)
  return openJSON<{ transferId: string }>(phone.key, ((await r.json()) as { p: string }).p, phone.aad('init:res')).transferId
}

const postChunk = (phone: Phone, tid: string, n: number, body: Uint8Array) =>
  fetch(`${base}/api/phone/transfer/${tid}/chunk/${n}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id },
    body: body as unknown as BodyInit,
  })

/** Morceau coupé en plein vol : la moitié du corps, puis la connexion tombe. */
function cutChunk(phone: Phone, tid: string, n: number, body: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/phone/transfer/${tid}/chunk/${n}`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id, 'content-length': body.length },
    })
    req.on('error', () => resolve())
    req.write(body.subarray(0, body.length >> 1), () => setTimeout(() => (req.destroy(), resolve()), 50))
  })
}

async function download(phone: Phone, itemId: string, openFrame: (k: Uint8Array, s: Uint8Array, a: string) => Uint8Array) {
  const r = await phone.post(`/api/phone/outbox/${itemId}/download`, 'download', { itemId })
  expect(r.status).toBe(200)
  const buf = new Uint8Array(await r.arrayBuffer())
  const parts: Uint8Array[] = []
  for (let off = 0, i = 0; off < buf.length; i++) {
    const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0)
    parts.push(openFrame(phone.key, buf.subarray(off + 4, off + 4 + len), phone.aad('dl', `${itemId}|${i}`)))
    off += 4 + len
  }
  return Buffer.concat(parts)
}

async function putOutbox(name: string, data: Buffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)]), name)
  const r = await fetch(base + '/api/admin/outbox/file', { method: 'POST', headers: { 'x-admin-token': srv.adminToken }, body: form })
  expect(r.status).toBe(200)
  const st = (await (await fetch(base + '/api/admin/state', { headers: { 'x-admin-token': srv.adminToken } })).json()) as {
    outbox: { id: string; name?: string }[]
  }
  return st.outbox.find((o) => o.name === name)!.id
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-vitesse-'))
  dl = path.join(home, 'dl')
  process.env.FLITDROP_DOWNLOADS = dl
  srv = await startServer({
    port: 0,
    home,
    disableClipboard: true,
    pcLink: async () => ({ via: 'wifi', band: '5', linkMbps: 866, signalDbm: -55 }),
  })
  port = srv.port
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  _setAeadEngine(null)
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
})

describe('envoi du téléphone chiffré par les Workers', () => {
  it('coupure en plein morceau, reprise sur ce qui manque : fichier intact, progression du PC jamais au-delà du fichier', async () => {
    const phone = await pairPhone()
    // la page du PC reçoit la progression, octets en route compris
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?k=${srv.adminToken}`)
    const progress: { bytes: number; size: number }[] = []
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m)) as { type: string; data: { bytes: number; size: number } }
      if (msg.type === 'transfer-progress') progress.push(msg.data)
    })
    await new Promise((r) => ws.once('open', r))

    const chunkSize = 1024 * 1024
    const size = 5 * chunkSize + 12345
    const data = crypto.randomBytes(size)
    const tid = await init(phone, 'video.mov', size, chunkSize)
    const chunks = Math.ceil(size / chunkSize)
    const sealedOf = (n: number) => workerSeal(phone.key, data.subarray(n * chunkSize, Math.min(size, (n + 1) * chunkSize)), phone.aad('chunk', `${tid}|${n}`))
    // morceaux 0, 2, 4 arrivent ; 1 est coupé au milieu ; 3 et 5 pas encore partis
    for (const n of [0, 2, 4]) expect((await postChunk(phone, tid, n, sealedOf(n))).status).toBe(200)
    await cutChunk(phone, tid, 1, sealedOf(1))
    const st = (await (await fetch(`${base}/api/phone/transfer/${tid}/status`, { headers: { 'x-wd-device': phone.id } })).json()) as { have: number[] }
    expect(st.have.sort()).toEqual([0, 2, 4])
    for (let n = 0; n < chunks; n++) if (!st.have.includes(n)) expect((await postChunk(phone, tid, n, sealedOf(n))).status).toBe(200)
    const fin = await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
    expect(fin.status).toBe(200)
    const name = openJSON<{ name: string }>(phone.key, ((await fin.json()) as { p: string }).p, phone.aad('finish:res')).name
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(dl, name))).digest('hex')).toBe(
      crypto.createHash('sha256').update(data).digest('hex')
    )
    ws.close()
    expect(progress.length).toBeGreaterThan(0)
    for (const p of progress) expect(p.bytes).toBeLessThanOrEqual(size)
    expect(progress.at(-1)!.bytes).toBe(size)
  })

  it('un morceau modifié est refusé, même chiffré par le Worker', async () => {
    const phone = await pairPhone()
    const tid = await init(phone, 'a.bin', 1000, 1000)
    const sealed = workerSeal(phone.key, crypto.randomBytes(1000), phone.aad('chunk', `${tid}|0`))
    sealed[500] = sealed[500]! ^ 1
    expect((await postChunk(phone, tid, 0, sealed)).status).toBe(403)
  })
})

/** Corps envoyé en plusieurs fois, avec des pauses (téléphone sur un wifi
 *  lent), depuis `host` : 127.0.0.1 ou l'adresse du Mac sur le réseau. */
function slowChunk(phone: Phone, tid: string, n: number, body: Uint8Array, opts: { host?: string; pieces?: number; pauseMs?: number; cut?: boolean } = {}): Promise<number> {
  const pieces = opts.pieces ?? 4
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        path: `/api/phone/transfer/${tid}/chunk/${n}`,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id, 'content-length': body.length },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', () => resolve(0))
    const step = Math.ceil(body.length / pieces)
    let i = 0
    const next = () => {
      if (opts.cut && i === pieces - 1) return setTimeout(() => (req.destroy(), resolve(0)), opts.pauseMs ?? 450)
      if (i >= pieces) return req.end()
      const part = body.subarray(i * step, Math.min(body.length, (i + 1) * step))
      i++
      req.write(part, () => setTimeout(next, opts.pauseMs ?? 450))
    }
    next()
  })
}

async function watchProgress(): Promise<{ ws: WebSocket; events: { type: string; data: Record<string, unknown> }[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?k=${srv.adminToken}`)
  const events: { type: string; data: Record<string, unknown> }[] = []
  ws.on('message', (m) => events.push(JSON.parse(String(m)) as { type: string; data: Record<string, unknown> }))
  await new Promise((r) => ws.once('open', r))
  return { ws, events }
}

const lanIp = (() => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return null
})()

describe('progression du PC pendant un envoi du téléphone', () => {
  it('un corps forgé (identifiants vus en clair sur le wifi) ne fait pas bouger la barre du PC', async () => {
    const phone = await pairPhone()
    const chunkSize = 1024 * 1024
    const size = 3 * chunkSize
    const data = crypto.randomBytes(size)
    const tid = await init(phone, 'forge.bin', size, chunkSize)
    const { ws, events } = await watchProgress()
    const progress = () => events.filter((e) => e.type === 'transfer-progress' && e.data.id === tid).map((e) => e.data.bytes as number)
    // aucun morceau accepté : un corps de n'importe qui ne compte pas, même
    // envoyé lentement et à plusieurs
    const junk = crypto.randomBytes(chunkSize + 40)
    const st = await Promise.all([0, 1, 2].map((n) => slowChunk(phone, tid, n, junk, { pieces: 3 })))
    expect(st).toEqual([403, 403, 403])
    expect(progress().filter((b) => b > 0)).toEqual([])
    // le vrai téléphone envoie le morceau 0 depuis 127.0.0.1
    const sealed0 = workerSeal(phone.key, data.subarray(0, chunkSize), phone.aad('chunk', `${tid}|0`))
    expect((await postChunk(phone, tid, 0, sealed0)).status).toBe(200)
    const after0 = Math.max(0, ...progress())
    expect(after0).toBe(chunkSize)
    // un autre appareil du wifi (autre adresse) forge le morceau 1, et le même
    // téléphone renvoie un morceau déjà reçu : rien au-delà du vrai total
    if (lanIp) expect(await slowChunk(phone, tid, 1, junk, { host: lanIp, pieces: 3 })).toBe(403)
    expect(await slowChunk(phone, tid, 0, sealed0, { pieces: 3 })).toBe(200)
    expect(Math.max(0, ...progress())).toBe(chunkSize)
    ws.close()
  })

  it('la barre du PC avance pendant qu’un morceau arrive, et ne recule jamais (morceau coupé, morceaux en parallèle)', async () => {
    const phone = await pairPhone()
    const chunkSize = 1024 * 1024
    const size = 5 * chunkSize
    const data = crypto.randomBytes(size)
    const tid = await init(phone, 'mono.bin', size, chunkSize)
    const sealedOf = (n: number) => workerSeal(phone.key, data.subarray(n * chunkSize, (n + 1) * chunkSize), phone.aad('chunk', `${tid}|${n}`))
    const { ws, events } = await watchProgress()
    expect((await postChunk(phone, tid, 0, sealedOf(0))).status).toBe(200)
    // en même temps : 1 arrive lentement, 2 est coupé aux trois quarts (ses
    // octets en route ne comptent plus, alors qu'ils avaient été montrés)
    const [s1] = await Promise.all([
      slowChunk(phone, tid, 1, sealedOf(1), { pieces: 6, pauseMs: 450 }),
      slowChunk(phone, tid, 2, sealedOf(2), { pieces: 4, pauseMs: 300, cut: true }),
    ])
    expect(s1).toBe(200)
    for (const n of [2, 3, 4]) expect((await postChunk(phone, tid, n, sealedOf(n))).status).toBe(200)
    expect((await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })).status).toBe(200)
    ws.close()
    const bytes = events.filter((e) => e.type === 'transfer-progress' && e.data.id === tid).map((e) => e.data.bytes as number)
    // des octets en route ont été montrés (pas seulement des morceaux entiers)
    expect(bytes.some((b) => b % chunkSize !== 0)).toBe(true)
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]!).toBeGreaterThanOrEqual(bytes[i - 1]!)
    expect(bytes.at(-1)).toBe(size)
  })

  it('téléchargement interrompu par le téléphone : le PC retire sa ligne de progression', async () => {
    const phone = await pairPhone()
    const id = await putOutbox('coupe.bin', crypto.randomBytes(48 * 1024 * 1024))
    const { ws, events } = await watchProgress()
    const ac = new AbortController()
    const r = await fetch(base + `/api/phone/outbox/${id}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': phone.id },
      body: JSON.stringify({ p: sealJSON(phone.key, { itemId: id, ts: Date.now(), jti: randomToken(9) }, phone.aad('download')) }),
      signal: ac.signal,
    })
    const reader = r.body!.getReader()
    await reader.read()
    ac.abort()
    await reader.read().catch(() => {})
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'outbox-progress' && e.data.ended); i++) await new Promise((res) => setTimeout(res, 50))
    ws.close()
    const mine = events.filter((e) => e.type === 'outbox-progress' && e.data.itemId === id)
    expect(mine.some((e) => typeof e.data.bytes === 'number')).toBe(true)
    expect(mine.at(-1)!.data.ended).toBe(true)
    expect(events.some((e) => e.type === 'outbox-downloaded' && e.data.itemId === id)).toBe(false)
  })
})

describe('compatibilité : anciennes pages, PC resté sur l’ancien moteur', () => {
  it('ancienne page (noble sur le fil de la page) vers ce PC, et ce PC vers l’ancienne page', async () => {
    const phone = await pairPhone()
    const data = crypto.randomBytes(2 * 1024 * 1024 + 7)
    const tid = await init(phone, 'old.bin', data.length, 8 * 1024 * 1024)
    expect((await postChunk(phone, tid, 0, wd.seal(phone.key, data, phone.aad('chunk', `${tid}|0`)))).status).toBe(200)
    expect((await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })).status).toBe(200)
    const big = crypto.randomBytes(9 * 1024 * 1024 + 3)
    const id = await putOutbox('old-dl.bin', big)
    expect((await download(phone, id, wd.open)).equals(big)).toBe(true)
  })

  it('nouvelle page (Workers WebAssembly) avec un PC sur l’ancien moteur (noble), dans les deux sens', async () => {
    _setAeadEngine('noble')
    try {
      const phone = await pairPhone()
      const data = crypto.randomBytes(3 * 1024 * 1024)
      const tid = await init(phone, 'new.bin', data.length, 8 * 1024 * 1024)
      expect((await postChunk(phone, tid, 0, workerSeal(phone.key, data, phone.aad('chunk', `${tid}|0`)))).status).toBe(200)
      expect((await phone.post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })).status).toBe(200)
      const big = crypto.randomBytes(5 * 1024 * 1024 + 1)
      const id = await putOutbox('new-dl.bin', big)
      expect((await download(phone, id, workerOpen)).equals(big)).toBe(true)
    } finally {
      _setAeadEngine(null)
    }
  })
})

describe('test de vitesse', () => {
  it('le PC annonce la fonction au hello', async () => {
    await pairPhone()
    expect(features).toContain('speedtest')
  })

  it('PC vers téléphone : la taille demandée, bornée, et seulement pour un téléphone appairé', async () => {
    const phone = await pairPhone()
    const r = await phone.post('/api/phone/speedtest/down', 'speedtest-down', { bytes: 3 * 1024 * 1024 + 5 })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-length')).toBe(String(3 * 1024 * 1024 + 5))
    expect((await r.arrayBuffer()).byteLength).toBe(3 * 1024 * 1024 + 5)
    const huge = await phone.post('/api/phone/speedtest/down', 'speedtest-down', { bytes: 10 * 1024 * 1024 * 1024 })
    expect(huge.headers.get('content-length')).toBe(String(64 * 1024 * 1024))
    await huge.body?.cancel()
    // enveloppe d'un autre usage : refusée
    const wrong = await phone.post('/api/phone/speedtest/down', 'download', { bytes: 1024 })
    expect(wrong.status).toBe(403)
    const unknown = await fetch(base + '/api/phone/speedtest/down', { method: 'POST', headers: { 'x-wd-device': 'inconnu' } })
    expect(unknown.status).toBe(403)
  })

  it('téléphone vers PC : enveloppe vérifiée avant le corps, rejeu et taille fausse refusés', async () => {
    const phone = await pairPhone()
    const body = crypto.randomBytes(2 * 1024 * 1024)
    const auth = (bytes: number, purpose = 'speedtest-up') => sealJSON(phone.key, { bytes, ts: Date.now(), jti: randomToken(9) }, phone.aad(purpose))
    const send = (a: string | null, b: Uint8Array = body) =>
      fetch(base + '/api/phone/speedtest/up', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': phone.id, ...(a ? { 'x-wd-auth': a } : {}) },
        body: b as unknown as BodyInit,
      })
    const good = auth(body.length)
    const ok = await send(good)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { received: number }).received).toBe(body.length)
    expect((await send(good)).status).toBe(403) // rejeu
    expect((await send(null)).status).toBe(403)
    expect((await send(auth(body.length, 'speedtest-down'))).status).toBe(403)
    expect((await send(auth(123))).status).toBe(400)
    const tooBig = crypto.randomBytes(8 * 1024 * 1024 + 1)
    expect((await send(auth(tooBig.length), tooBig)).status).toBe(400)
  })

  it('comment le PC est relié : réponse chiffrée pour ce téléphone', async () => {
    const phone = await pairPhone()
    const r = await phone.post('/api/phone/speedtest/pc', 'speedtest-pc', {})
    expect(r.status).toBe(200)
    const d = openJSON<{ link: { via: string; band?: string } }>(phone.key, ((await r.json()) as { p: string }).p, phone.aad('speedtest-pc:res'))
    expect(d.link).toEqual({ via: 'wifi', band: '5', linkMbps: 866, signalDbm: -55 })
  })
})

describe('politique de sécurité de la page du téléphone', () => {
  it('seul le Worker de chiffrement peut compiler du WebAssembly ; la page reste stricte', async () => {
    const page = await fetch(base + '/s/')
    expect(page.headers.get('content-security-policy')).not.toMatch(/wasm-unsafe-eval|unsafe-eval'/)
    const worker = await fetch(base + '/s/cw.js')
    expect(worker.status).toBe(200)
    const csp = worker.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/)
    expect(csp).not.toMatch(/'unsafe-eval'/)
    expect(await worker.text()).toMatch(/AGFzbQ/) // le module WebAssembly est bien dedans
  })

  it('les connexions restent ouvertes assez longtemps pour les relances du téléphone', async () => {
    const r = await fetch(base + '/s/', { headers: { connection: 'keep-alive' } })
    await r.text()
    expect(r.headers.get('keep-alive') ?? '').toMatch(/timeout=65/)
  })
})
