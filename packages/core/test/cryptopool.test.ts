import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { CryptoPool, CryptoAuthError, type WorkerLike } from '../src/webclient/cryptopool.js'
import { makeCryptoRunner, type CryptoJob } from '../src/webclient/cryptojob.js'
import * as wd from '../src/webclient/wdcrypto.js'
import { seal as pcSeal, open as pcOpen } from '../src/crypto.js'

const rnd = (n: number) => new Uint8Array(randomBytes(n))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Web Worker simulé : même code que cw.js (cryptojob.ts), messages clonés et
// tampons transférés comme dans le navigateur (structuredClone + transfer).
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  terminated = false
  private runner: ReturnType<typeof makeCryptoRunner>
  private crash: boolean
  constructor(opts: { useWasm?: boolean; failStart?: boolean; crashOnJob?: boolean } = {}) {
    this.runner = makeCryptoRunner(opts.useWasm ?? true)
    setTimeout(() => {
      if (opts.failStart) this.onerror?.(new Error('script introuvable'))
      else this.onmessage?.({ data: { ready: true, engine: this.runner.engine } })
    }, 1)
    this.crash = !!opts.crashOnJob
  }
  postMessage(msg: unknown, transfer?: Transferable[]) {
    if (this.terminated) return
    const job = structuredClone(msg, { transfer: transfer as Transferable[] }) as CryptoJob
    setTimeout(() => {
      if (this.terminated) return
      if (this.crash) return this.onerror?.(new Error('plantage'))
      const { reply, transfer: tr } = this.runner.handle(job)
      this.onmessage?.({ data: structuredClone(reply, { transfer: tr }) })
    }, 1)
  }
  terminate() {
    this.terminated = true
  }
}

const fallback = { seal: wd.seal, open: wd.open }

describe('chiffrement du téléphone dans des Web Workers', () => {
  it('les morceaux chiffrés par les Workers (WebAssembly) s’ouvrent sur le PC, à l’octet près', async () => {
    const workers: FakeWorker[] = []
    const pool = new CryptoPool({ create: () => (workers.push(new FakeWorker()), workers.at(-1)!), size: 4, fallback })
    const key = rnd(32)
    const plains = [0, 1, 1000, 8 * 1024 * 1024, 65].map(rnd)
    const copies = plains.map((p) => p.slice())
    const sealed = await Promise.all(plains.map((p, i) => pool.seal(key, p, `wd1|dev|chunk|t|${i}`)))
    expect(pool.engine).toBe('wasm')
    expect(workers.length).toBe(4)
    // le clair est parti au Worker sans copie (tampon transféré)
    expect(plains[3]!.byteLength).toBe(0)
    sealed.forEach((s, i) => {
      expect(Buffer.from(pcOpen(key, s, `wd1|dev|chunk|t|${i}`)).equals(Buffer.from(copies[i]!))).toBe(true)
      // et la page d'avant (noble) aussi
      expect(Buffer.from(wd.open(key, s, `wd1|dev|chunk|t|${i}`)).equals(Buffer.from(copies[i]!))).toBe(true)
    })
    // nonce neuf à chaque morceau
    expect(new Set(sealed.map((s) => Buffer.from(s.subarray(0, 24)).toString('hex'))).size).toBe(sealed.length)
  })

  it('déchiffre les morceaux du PC, et refuse un morceau modifié ou déplacé', async () => {
    const pool = new CryptoPool({ create: () => new FakeWorker(), size: 3, fallback })
    const key = rnd(32)
    const frames = [5, 4 * 1024 * 1024, 77].map((n, i) => {
      const plain = rnd(n)
      return { plain, sealed: pcSeal(key, plain, `wd1|dev|dl|item|${i}`) }
    })
    const opened = await Promise.all(frames.map((f, i) => pool.open(key, f.sealed.slice(), `wd1|dev|dl|item|${i}`)))
    opened.forEach((o, i) => expect(Buffer.from(o).equals(Buffer.from(frames[i]!.plain))).toBe(true))
    const bad = frames[1]!.sealed.slice()
    bad[100] = bad[100]! ^ 1
    await expect(pool.open(key, bad, 'wd1|dev|dl|item|1')).rejects.toBeInstanceOf(CryptoAuthError)
    // bon morceau, mauvaise place dans le fichier (AAD du numéro 2)
    await expect(pool.open(key, frames[1]!.sealed.slice(), 'wd1|dev|dl|item|2')).rejects.toBeInstanceOf(CryptoAuthError)
  })

  it('sans WebAssembly (mode Isolement), les Workers chiffrent en JavaScript, même format', async () => {
    const pool = new CryptoPool({ create: () => new FakeWorker({ useWasm: false }), size: 2, fallback })
    const key = rnd(32)
    const p = rnd(3000)
    const s = await pool.seal(key, p.slice(), 'a')
    expect(pool.engine).toBe('js')
    expect(Buffer.from(pcOpen(key, s, 'a')).equals(Buffer.from(p))).toBe(true)
  })

  it('pas de Worker dans ce navigateur : la page chiffre elle-même, comme avant', async () => {
    const pool = new CryptoPool({
      create: () => {
        throw new Error('Worker indisponible')
      },
      size: 4,
      fallback,
    })
    const key = rnd(32)
    const p = rnd(500)
    const s = await pool.seal(key, p.slice(), 'a')
    expect(pool.engine).toBe('main')
    expect(Buffer.from(pcOpen(key, s, 'a')).equals(Buffer.from(p))).toBe(true)
    await expect(pool.open(key, s.slice(0, 50), 'a')).rejects.toBeInstanceOf(CryptoAuthError)
  })

  it('Workers qui ne démarrent pas (script refusé) : rien n’est perdu, la page prend le relais', async () => {
    const pool = new CryptoPool({ create: () => new FakeWorker({ failStart: true }), size: 4, fallback })
    const key = rnd(32)
    const plains = [rnd(10), rnd(20000)]
    const sealed = await Promise.all(plains.map((p) => pool.seal(key, p.slice(), 'a')))
    expect(pool.engine).toBe('main')
    sealed.forEach((s, i) => expect(Buffer.from(pcOpen(key, s, 'a')).equals(Buffer.from(plains[i]!))).toBe(true))
  })

  it('Worker qui plante en plein travail : ce morceau échoue (l’envoi le reprendra), les suivants passent', async () => {
    let n = 0
    const pool = new CryptoPool({ create: () => new FakeWorker({ crashOnJob: n++ === 0 }), size: 1, fallback })
    const key = rnd(32)
    await expect(pool.seal(key, rnd(10), 'a')).rejects.toThrow()
    const p = rnd(10)
    const s = await pool.seal(key, p.slice(), 'a')
    expect(Buffer.from(pcOpen(key, s, 'a')).equals(Buffer.from(p))).toBe(true)
  })

  it('au repos, les Workers sont arrêtés, et redémarrés au besoin', async () => {
    const workers: FakeWorker[] = []
    const pool = new CryptoPool({ create: () => (workers.push(new FakeWorker()), workers.at(-1)!), size: 2, fallback, idleMs: 30 })
    const key = rnd(32)
    await pool.seal(key, rnd(10), 'a')
    expect(workers.every((w) => !w.terminated)).toBe(true)
    await sleep(80)
    expect(workers.length).toBe(2)
    expect(workers.every((w) => w.terminated)).toBe(true)
    await pool.seal(key, rnd(10), 'a')
    expect(workers.length).toBe(4)
  })
})
