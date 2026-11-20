import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { DeviceStore, cleanHw } from '../src/pairing.js'
import { sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Le même téléphone ne s'affiche qu'une fois sur le PC : un appairage neuf
// (QR rescanné, code tapé dans l'icône de l'écran d'accueil) remplace
// l'ancien, et un autre téléphone identique n'est jamais perdu.

let srv: RunningServer
let base = ''
let home = ''

const admin = (p: string, body?: unknown) =>
  fetch(base + '/api/admin' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': srv.adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

type Dev = { id: string; name: string; clipShare: boolean; shortcutToken: string }
const devicesNow = async () => ((await (await admin('/state')).json()) as { devices: Dev[] }).devices

async function hello(id: string, key: Uint8Array, extra: Record<string, unknown> = {}) {
  const aad = (p: string) => `wd1|${id}|${p}`
  const r = await fetch(base + '/api/phone/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wd-device': id },
    body: JSON.stringify({ p: sealJSON(key, { deviceLabel: 'iPhone', platform: 'iphone', hw: '393x852@3|18.1', ...extra, ts: Date.now(), jti: randomToken(9) }, aad('hello')) }),
  })
  expect(r.status).toBe(200)
  const res = openJSON<{ newKey?: string }>(key, ((await r.json()) as { p: string }).p, aad('hello:res'))
  return res.newKey ? b64u.dec(res.newKey) : key
}

async function newPairing() {
  const { url } = (await (await admin('/pair/new', {})).json()) as { url: string }
  const [id, k] = (url.split('#')[1] as string).split('.') as [string, string]
  return { id, key: b64u.dec(k) }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-same-'))
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  srv = await startServer({ port: 0, home, quiet: true, disableClipboard: true })
  base = `http://127.0.0.1:${srv.port}`
})

afterAll(async () => {
  await srv?.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('même téléphone rescanné', () => {
  it('avec la preuve de son ancien appairage : un seul téléphone, qui garde son nom et son Raccourci', async () => {
    const a = await newPairing()
    const aKey = await hello(a.id, a.key)
    expect((await admin(`/device/${a.id}/rename`, { name: 'iPhone de Léa' })).status).toBe(200)
    const before = (await devicesNow()).find((d) => d.id === a.id)!
    expect(before.clipShare).toBe(true)

    const b = await newPairing()
    const proof = sealJSON(aKey, { id: b.id, ts: Date.now(), jti: randomToken(9) }, `wd1|${a.id}|replace`)
    await hello(b.id, b.key, { prev: { id: a.id, proof } })
    const list = (await devicesNow()).filter((d) => d.id === a.id || d.id === b.id)
    expect(list.map((d) => d.id)).toEqual([b.id])
    expect(list[0]!.name).toBe('iPhone de Léa')
    expect(list[0]!.clipShare).toBe(true)
    expect(list[0]!.shortcutToken).toBe(before.shortcutToken)
  })

  it('preuve fausse (pas la clé de l’ancien) : l’ancien reste', async () => {
    const a = await newPairing()
    await hello(a.id, a.key, { hw: '1x1@1|1.0' })
    const b = await newPairing()
    const proof = sealJSON(new Uint8Array(32), { id: b.id, ts: Date.now(), jti: randomToken(9) }, `wd1|${a.id}|replace`)
    await hello(b.id, b.key, { hw: '1x1@1|1.0', prev: { id: a.id, proof } })
    const ids = (await devicesNow()).map((d) => d.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
  })
})

describe('anciens appairages du même modèle (DeviceStore)', () => {
  const aged = (dir: string, ids: string[]) => {
    const file = path.join(dir, 'devices.json')
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; createdAt: string; lastSeenAt?: string }[]
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    for (const d of list) if (ids.includes(d.id)) Object.assign(d, { createdAt: old, lastSeenAt: old })
    fs.writeFileSync(file, JSON.stringify(list))
  }

  it('silencieux et plus ancien : mis de côté ; il revient s’il dit bonjour (autre téléphone identique)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-twins-'))
    let store = new DeviceStore(dir)
    const a = store.create('pc')
    store.activate(a.id, { name: 'iPhone', platform: 'iphone', hw: '393x852@3|18.1' })
    aged(dir, [a.id])
    store = new DeviceStore(dir)
    const b = store.create('pc')
    store.activate(b.id, { name: 'iPhone', platform: 'iphone', hw: '393x852@3|18.1' })
    // autre modèle : jamais concerné
    const c = store.create('pc')
    store.activate(c.id, { name: 'iPhone', platform: 'iphone', hw: '430x932@3|18.1' })
    expect(store.retireTwins(b.id)).toEqual([a.id])
    expect(store.listPublic().map((d) => d.id)).not.toContain(a.id)
    expect(store.get(b.id)!.shortcutToken).toBe(store.get(a.id)!.shortcutToken)
    // l'ancien n'efface jamais le plus récent
    expect(store.retireTwins(a.id)).toEqual([])
    // il revient : les deux restent, plus jamais mis de côté
    expect(store.unretire(a.id)).toBe(true)
    expect(store.listPublic().map((d) => d.id)).toContain(a.id)
    expect(store.get(b.id)!.shortcutToken).not.toBe(store.get(a.id)!.shortcutToken)
    aged(dir, [a.id])
    store = new DeviceStore(dir)
    expect(store.retireTwins(b.id)).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('encore actif il y a moins de 10 minutes : gardé', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-twins-'))
    const store = new DeviceStore(dir)
    const a = store.create('pc')
    store.activate(a.id, { name: 'iPhone', platform: 'iphone', hw: '393x852@3|18.1' })
    const b = store.create('pc')
    store.activate(b.id, { name: 'iPhone', platform: 'iphone', hw: '393x852@3|18.1' })
    expect(store.retireTwins(b.id)).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('empreinte nettoyée', () => {
    expect(cleanHw('393x852@3|18.1')).toBe('393x852@3|18.1')
    expect(cleanHw('<script>"x"')).toBe('scriptx')
    expect(cleanHw(42)).toBe('')
  })
})
