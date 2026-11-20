import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { startServer, type RunningServer } from '../src/server.js'
import { PairCodes, normalizeCode, formatCode, MAX_FAILS } from '../src/codepair.js'
import { openJSON, sealJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Appairage par code à 6 chiffres : le téléphone (ici simulé avec la même
// bibliothèque X25519 que la page) obtient l'appairage chiffré ; le code ne
// sert qu'une fois ; un code faux ne donne rien.

let srv: RunningServer
let base = ''
let home = ''

const admin = (p: string, body: unknown = {}) =>
  fetch(base + '/api/admin' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': srv.adminToken },
    body: JSON.stringify(body),
  })

/** Ce que fait la page du téléphone (phone.ts, pairByCode). */
async function phoneClaim(code: string): Promise<{ status: number; pairing?: { id: string; keyB64: string; instanceId?: string } }> {
  const priv = x25519.utils.randomPrivateKey()
  const pub = b64u.enc(x25519.getPublicKey(priv))
  const r = await fetch(base + '/api/pair/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, pub }),
  })
  if (!r.ok) return { status: r.status }
  const j = (await r.json()) as { pub: string; p: string }
  const shared = x25519.getSharedSecret(priv, b64u.dec(j.pub))
  const label = new TextEncoder().encode(`flitdrop-codepair-v1|${normalizeCode(code)}|${pub}|${j.pub}|`)
  const buf = new Uint8Array(label.length + shared.length)
  buf.set(label, 0)
  buf.set(shared, label.length)
  return { status: r.status, pairing: openJSON(sha256(buf), j.p, 'wd1|codepair') }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-code-'))
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  srv = await startServer({ port: 0, home, quiet: true, disableClipboard: true })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv?.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('appairage par code à 6 chiffres', () => {
  it('le code donne l’appairage du QR code, chiffré ; il ne sert qu’une fois ; le téléphone dit bonjour', async () => {
    const res = (await (await admin('/pair/new')).json()) as { deviceId: string; url: string; code: string }
    expect(res.code).toMatch(/^\d{3} \d{3}$/)
    const [, frag] = res.url.split('#') as [string, string]
    const [id, keyB64, instanceId] = frag.split('.')
    const got = await phoneClaim(res.code)
    expect(got.status).toBe(200)
    expect(got.pairing).toEqual({ id, keyB64, instanceId })
    expect(id).toBe(res.deviceId)
    // déjà utilisé
    expect((await phoneClaim(res.code)).status).toBe(404)
    // l'appairage reçu marche : hello chiffré avec sa clé
    const aad = (p: string) => `wd1|${id}|${p}`
    const key = b64u.dec(keyB64 as string)
    const r = await fetch(base + '/api/phone/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id as string },
      body: JSON.stringify({ p: sealJSON(key, { deviceLabel: 'iPhone', platform: 'iphone', ts: Date.now(), jti: randomToken(9) }, aad('hello')) }),
    })
    expect(r.status).toBe(200)
    const hello = openJSON<{ instanceId: string }>(key, ((await r.json()) as { p: string }).p, aad('hello:res'))
    expect(hello.instanceId).toBe(instanceId)
  })

  it('appairé par le QR code : son code ne sert plus ; code faux, clé invalide refusés', async () => {
    const res = (await (await admin('/pair/new')).json()) as { url: string; code: string }
    const [id, k] = (res.url.split('#')[1] as string).split('.') as [string, string]
    const key = b64u.dec(k)
    const r = await fetch(base + '/api/phone/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: JSON.stringify({ p: sealJSON(key, { deviceLabel: 'Pixel', platform: 'android', ts: Date.now(), jti: randomToken(9) }, `wd1|${id}|hello`) }),
    })
    expect(r.status).toBe(200)
    expect((await phoneClaim(res.code)).status).toBe(404)
    const bad = await fetch(base + '/api/pair/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456', pub: 'pas une clé' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('codes (PairCodes)', () => {
  it('six chiffres, espaces et tirets acceptés ; affichage « 482 913 »', () => {
    expect(normalizeCode(' 482 913 ')).toBe('482913')
    expect(normalizeCode('482-913')).toBe('482913')
    expect(normalizeCode('48291')).toBe('')
    expect(normalizeCode('abcdef')).toBe('')
    expect(formatCode('482913')).toBe('482 913')
  })

  it('expire, s’oublie, et trop d’échecs effacent tous les codes', () => {
    let now = 1_000_000
    const codes = new PairCodes(() => now)
    const a = codes.issue('dev-a', 60_000)
    now += 61_000
    expect(codes.claim(a)).toBeNull()
    const b = codes.issue('dev-b', 60_000)
    codes.forget('dev-b')
    expect(codes.claim(b)).toBeNull()
    const c = codes.issue('dev-c', 60_000)
    for (let i = 0; i <= MAX_FAILS; i++) codes.claim(c === '000000' ? '000001' : '000000')
    expect(codes.size()).toBe(0)
    expect(codes.claim(c)).toBeNull()
    const d = codes.issue('dev-d', 60_000)
    expect(codes.claim(d)).toBe('dev-d')
  })
})
