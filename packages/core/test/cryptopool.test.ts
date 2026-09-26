import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { CryptoPool, CryptoAuthError, CryptoPoolError, type WorkerLike } from '../src/webclient/cryptopool.js'
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
  private failJob: boolean
  jobs = 0
  constructor(opts: { useWasm?: boolean; failStart?: boolean; crashOnJob?: boolean; failJob?: boolean } = {}) {
    this.runner = makeCryptoRunner(opts.useWasm ?? true)
    setTimeout(() => {
      if (opts.failStart) this.onerror?.(new Error('script introuvable'))
      else this.onmessage?.({ data: { ready: true, engine: this.runner.engine } })
    }, 1)
    this.crash = !!opts.crashOnJob
    this.failJob = !!opts.failJob
  }
  postMessage(msg: unknown, transfer?: Transferable[]) {
    if (this.terminated) return
    const job = structuredClone(msg, { transfer: transfer as Transferable[] }) as CryptoJob
    setTimeout(() => {
      if (this.terminated) return
      this.jobs++
      if (this.crash) return this.onerror?.(new Error('plantage'))
      // échec dans le moteur (mémoire refusée) : même chemin que cryptojob.ts,
      // provoqué par une clé que le moteur refuse
      const { reply, transfer: tr } = this.runner.handle(this.failJob ? { ...job, key: new Uint8Array(1) } : job)
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

  it('Worker qui plante en plein travail : ce morceau échoue (l’envoi le relit), les suivants passent', async () => {
    let n = 0
    const pool = new CryptoPool({ create: () => new FakeWorker({ crashOnJob: n++ === 0 }), size: 1, fallback, retryMs: 10 })
    const key = rnd(32)
    await expect(pool.seal(key, rnd(10), 'a')).rejects.toBeInstanceOf(CryptoPoolError)
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

  it('coupure réseau pendant la relance des Workers : ils reviennent ensuite, la page ne reste pas en mode lent', async () => {
    const workers: FakeWorker[] = []
    let blipUntil = 0
    const pool = new CryptoPool({
      create: () => (workers.push(new FakeWorker({ failStart: Date.now() < blipUntil })), workers.at(-1)!),
      size: 4,
      fallback,
      idleMs: 20,
      retryMs: 15,
    })
    const key = rnd(32)
    await pool.seal(key, rnd(10), 'a')
    expect(pool.engine).toBe('wasm')
    await sleep(60)
    expect(workers.every((w) => w.terminated)).toBe(true)
    // le wifi revient à peine : cw.js ne se charge pas pendant 40 ms
    blipUntil = Date.now() + 40
    const p = rnd(5000)
    const s = await pool.seal(key, p.slice(), 'b')
    expect(Buffer.from(pcOpen(key, s, 'b')).equals(Buffer.from(p))).toBe(true)
    expect(pool.engine).toBe('wasm')
    // et encore plus tard, toujours dans les Workers
    for (let i = 0; i < 3; i++) await pool.seal(key, rnd(100), 'c')
    expect(pool.engine).toBe('wasm')
    // relances espacées, pas une boucle serrée
    expect(workers.length).toBeLessThan(40)
  })

  it('Workers qui plantent sans cesse : la page avance en attendant, sans jamais les abandonner pour de bon', async () => {
    let healthy = false
    const pool = new CryptoPool({ create: () => new FakeWorker({ crashOnJob: !healthy }), size: 2, fallback, retryMs: 5 })
    const key = rnd(32)
    // premier démarrage réussi, puis plantages en série : chaque morceau perdu
    // est signalé (l'envoi le relit), jamais un blocage
    const results: string[] = []
    for (let i = 0; i < 8; i++) {
      const p = rnd(1000)
      try {
        const s = await pool.seal(key, p.slice(), 'x')
        expect(Buffer.from(pcOpen(key, s, 'x')).equals(Buffer.from(p))).toBe(true)
        results.push('ok')
      } catch (e) {
        expect(e).toBeInstanceOf(CryptoPoolError)
        results.push('lost')
      }
    }
    // seul le tout premier morceau est perdu (l'envoi le relit) : ensuite la
    // page garde une copie et refait elle-même ce qu'un Worker perd
    expect(results).toEqual(['lost', ...Array(7).fill('ok')])
    // les Workers réparés sont repris aux relances suivantes (ceux qui
    // plantent encore sortent au premier travail)
    healthy = true
    for (let i = 0; i < 12 && pool.engine !== 'wasm'; i++) {
      await sleep(60)
      await pool.seal(key, rnd(100), 'y')
    }
    expect(pool.engine).toBe('wasm')
  })

  it('échec du moteur dans le Worker (mémoire refusée) : la page refait ce morceau, rien n’est perdu', async () => {
    const pool = new CryptoPool({ create: () => new FakeWorker({ failJob: true }), size: 2, fallback })
    const key = rnd(32)
    const p = rnd(300_000)
    const s = await pool.seal(key, p.slice(), 'seal')
    expect(Buffer.from(pcOpen(key, s, 'seal')).equals(Buffer.from(p))).toBe(true)
    const q = rnd(200_000)
    const o = await pool.open(key, pcSeal(key, q, 'open'), 'open')
    expect(Buffer.from(o).equals(Buffer.from(q))).toBe(true)
    // un vrai tag faux reste refusé
    const bad = pcSeal(key, q, 'open')
    bad[30] = bad[30]! ^ 1
    await expect(pool.open(key, bad, 'open')).rejects.toBeInstanceOf(CryptoAuthError)
  })

  it('Worker perdu en plein déchiffrement : la page déchiffre ce morceau (un téléchargement ne peut pas le redemander)', async () => {
    let n = 0
    const pool = new CryptoPool({ create: () => new FakeWorker({ crashOnJob: n++ === 0 }), size: 1, fallback, retryMs: 10 })
    const key = rnd(32)
    const frames = [rnd(100_000), rnd(50)]
    const sealed = frames.map((f, i) => pcSeal(key, f, `dl|${i}`))
    const opened = await Promise.all(sealed.map((s, i) => pool.open(key, s, `dl|${i}`)))
    opened.forEach((o, i) => expect(Buffer.from(o).equals(Buffer.from(frames[i]!))).toBe(true))
    // morceau modifié : toujours refusé, même quand c'est la page qui déchiffre
    const bad = sealed[0]!.slice()
    bad[40] = bad[40]! ^ 1
    n = 0
    const pool2 = new CryptoPool({ create: () => new FakeWorker({ crashOnJob: n++ === 0 }), size: 1, fallback, retryMs: 10 })
    await expect(pool2.open(key, bad, 'dl|0')).rejects.toBeInstanceOf(CryptoAuthError)
  })

  it('le Worker rend le morceau intact quand son moteur échoue', () => {
    const runner = makeCryptoRunner(true)
    const plain = rnd(1000)
    const buf = plain.slice().buffer
    const { reply, transfer } = runner.handle({ id: 7, op: 'seal', key: new Uint8Array(3), aad: 'a', buf } as CryptoJob)
    expect(reply).toMatchObject({ id: 7, error: 'fail' })
    expect(transfer).toEqual([buf])
    expect(Buffer.from(new Uint8Array((reply as { buf: ArrayBuffer }).buf)).equals(Buffer.from(plain))).toBe(true)
  })
})
