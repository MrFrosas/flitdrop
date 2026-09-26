// Groupe de Web Workers qui chiffrent et déchiffrent les morceaux pour la
// page du téléphone (voir cryptojob.ts). Avant : tout se faisait sur le fil
// de la page, un morceau après l'autre, et la page gelait plusieurs secondes
// par morceau sur un iPhone. Maintenant plusieurs morceaux se chiffrent en
// même temps, sur plusieurs coeurs, pendant que le réseau envoie les autres.
//
// Sûreté : un Worker ne reçoit un morceau qu'après avoir dit « prêt ». S'il
// ne démarre pas (navigateur ancien, Worker interdit), la page chiffre
// elle-même comme avant : jamais de blocage, jamais de format différent.
// Au repos, les Workers sont arrêtés (mémoire rendue, aucun coût).
import type { CryptoEngine, CryptoJob, CryptoReply } from './cryptojob.js'

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface MainThreadCrypto {
  seal(key: Uint8Array, plain: Uint8Array, aad: string): Uint8Array
  /** lève une erreur si le tag est faux */
  open(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array
}

export interface PoolOptions {
  /** crée un Worker (peut lever : pas de Worker dans ce navigateur) */
  create: () => WorkerLike
  size: number
  fallback: MainThreadCrypto
  /** arrêt des Workers après ce délai sans travail */
  idleMs?: number
  /** un Worker qui n'a pas dit « prêt » dans ce délai est abandonné */
  readyTimeoutMs?: number
}

/** Tag faux : données modifiées ou mauvaise clé. Rien n'a été déchiffré. */
export class CryptoAuthError extends Error {
  constructor() {
    super('decrypt')
  }
}

interface Pending {
  id: number
  op: 'seal' | 'open'
  key: Uint8Array
  aad: string
  data: Uint8Array
  resolve: (b: Uint8Array) => void
  reject: (e: Error) => void
}

interface Slot {
  w: WorkerLike
  ready: boolean
  inflight: Map<number, Pending>
  timer: ReturnType<typeof setTimeout> | null
}

export class CryptoPool {
  /** moteur des Workers ('main' : la page chiffre elle-même), null avant le premier démarrage */
  engine: CryptoEngine | 'main' | null = null
  private slots: Slot[] = []
  private queue: Pending[] = []
  private broken = false
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  // un Worker a déjà dit « prêt » : si les suivants plantent, on insiste
  private everReady = false
  // Workers perdus en route : au-delà de quelques-uns, la page chiffre elle-même
  private losses = 0

  constructor(private opts: PoolOptions) {}

  seal(key: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array> {
    return this.submit('seal', key, plain, aad)
  }

  /** Rejette avec CryptoAuthError si le morceau a été modifié en route. */
  open(key: Uint8Array, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
    return this.submit('open', key, sealed, aad)
  }

  /** Arrête tous les Workers (les travaux en attente passent sur la page). */
  close(): void {
    this.stopAll()
    this.broken = true
    this.engine = 'main'
    this.pump()
  }

  private submit(op: 'seal' | 'open', key: Uint8Array, data: Uint8Array, aad: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, key, aad, data, resolve, reject })
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      this.pump()
    })
  }

  private runOnPage(p: Pending) {
    try {
      p.resolve(p.op === 'seal' ? this.opts.fallback.seal(p.key, p.data, p.aad) : this.opts.fallback.open(p.key, p.data, p.aad))
    } catch {
      p.reject(p.op === 'open' ? new CryptoAuthError() : new Error('fail'))
    }
  }

  private pump(): void {
    if (this.broken) {
      const jobs = this.queue.splice(0)
      // un à un, en rendant la main entre deux : la page reste utilisable
      jobs.forEach((p, i) => setTimeout(() => this.runOnPage(p), i))
      return
    }
    // démarrage paresseux : aucun Worker tant qu'il n'y a rien à chiffrer
    while (this.slots.length < Math.max(1, this.opts.size) && this.queue.length > 0 && this.spawn()) {
      /* un de plus */
    }
    if (this.broken) return this.pump()
    for (;;) {
      const p = this.queue[0]
      if (!p) break
      let best: Slot | null = null
      for (const s of this.slots) if (s.ready && (!best || s.inflight.size < best.inflight.size)) best = s
      if (!best) break
      this.queue.shift()
      this.post(best, p)
    }
    this.armIdle()
  }

  private spawn(): boolean {
    let w: WorkerLike
    try {
      w = this.opts.create()
    } catch {
      if (!this.everReady && this.slots.length === 0) this.fail()
      return false
    }
    const slot: Slot = { w, ready: false, inflight: new Map(), timer: null }
    slot.timer = setTimeout(() => this.lose(slot), this.opts.readyTimeoutMs ?? 10_000)
    w.onmessage = (ev) => this.onReply(slot, ev.data as CryptoReply)
    w.onerror = () => this.lose(slot)
    this.slots.push(slot)
    return true
  }

  private onReply(slot: Slot, r: CryptoReply) {
    if ('ready' in r) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = null
      slot.ready = true
      this.everReady = true
      this.engine = r.engine
      return this.pump()
    }
    const p = slot.inflight.get(r.id)
    if (!p) return
    slot.inflight.delete(r.id)
    if ('error' in r) p.reject(r.error === 'auth' ? new CryptoAuthError() : new Error('fail'))
    else p.resolve(new Uint8Array(r.buf))
    this.pump()
  }

  private post(slot: Slot, p: Pending) {
    // le tampon part au Worker sans copie ; une vue partielle est d'abord recopiée
    const whole = p.data.byteOffset === 0 && p.data.byteLength === p.data.buffer.byteLength
    const buf = (whole ? p.data.buffer : new Uint8Array(p.data).buffer) as ArrayBuffer
    slot.inflight.set(p.id, p)
    const job: CryptoJob = { id: p.id, op: p.op, key: p.key, aad: p.aad, buf }
    try {
      slot.w.postMessage(job, [buf])
    } catch {
      // envoi refusé : rien n'est parti, le travail reste dans la file
      slot.inflight.delete(p.id)
      this.queue.unshift(p)
      this.lose(slot)
    }
  }

  /** Worker perdu (erreur, pas prêt à temps) : ses travaux en cours échouent
   *  (leurs tampons sont partis), la file continue sur les autres. */
  private lose(slot: Slot): void {
    const i = this.slots.indexOf(slot)
    if (i < 0) return
    this.slots.splice(i, 1)
    if (slot.timer) clearTimeout(slot.timer)
    try {
      slot.w.terminate()
    } catch {
      // déjà arrêté
    }
    for (const p of slot.inflight.values()) p.reject(new Error('fail'))
    slot.inflight.clear()
    // aucun Worker n'a jamais démarré, ou ils plantent sans cesse : la page
    // chiffre elle-même
    this.losses++
    if ((!this.everReady && this.slots.length === 0) || this.losses > 6) return this.fail()
    this.pump()
  }

  private fail(): void {
    this.broken = true
    this.engine = 'main'
    this.stopAll()
    this.pump()
  }

  private armIdle() {
    if (this.idleTimer || this.queue.length > 0 || this.slots.length === 0) return
    if (this.slots.some((s) => s.inflight.size > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.queue.length === 0 && this.slots.every((s) => s.inflight.size === 0)) this.stopAll()
    }, this.opts.idleMs ?? 20_000)
  }

  private stopAll() {
    for (const s of this.slots.splice(0)) {
      if (s.timer) clearTimeout(s.timer)
      try {
        s.w.terminate()
      } catch {
        // déjà arrêté
      }
      for (const p of s.inflight.values()) p.reject(new Error('fail'))
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
