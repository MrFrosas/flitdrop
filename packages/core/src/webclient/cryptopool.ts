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
  /** attente avant de relancer des Workers après une perte (doublée à chaque
   *  nouvelle perte sans travail réussi entre deux, jusqu'à 8 fois) */
  retryMs?: number
}

/** Tag faux : données modifiées ou mauvaise clé. Rien n'a été déchiffré. */
export class CryptoAuthError extends Error {
  constructor() {
    super('decrypt')
  }
}

/** Le chiffrement n'a pas pu se faire (Worker perdu en plein travail avec
 *  un morceau qui n'existait plus que chez lui). Les données ne sont pas en
 *  cause : l'appelant refait ce morceau. */
export class CryptoPoolError extends Error {
  constructor() {
    super('crypto')
  }
}

interface Pending {
  id: number
  op: 'seal' | 'open'
  key: Uint8Array
  aad: string
  data: Uint8Array
  /** longueur d'origine (data est vidé quand son tampon part au Worker) */
  len: number
  /** la page garde son morceau pendant que le Worker travaille sur une
   *  copie. Toujours pour un déchiffrement (un téléchargement ne peut pas
   *  redemander un morceau au PC) ; pour un chiffrement, seulement quand des
   *  Workers viennent d'être perdus (sinon le tampon part sans copie). */
  kept: boolean
  resolve: (b: Uint8Array) => void
  reject: (e: Error) => void
}

interface Slot {
  w: WorkerLike
  ready: boolean
  inflight: Map<number, Pending>
  timer: ReturnType<typeof setTimeout> | null
}

// attentes successives avant de relancer des Workers perdus : au-delà de
// PAGE_AFTER pertes d'affilée (environ 15 s), la page fait le travail en
// attendant, pour que rien ne reste bloqué
const MAX_BACKOFF_STEPS = 3
const PAGE_AFTER = 4

export class CryptoPool {
  /** moteur des Workers ('main' : la page chiffre elle-même), null avant le premier démarrage */
  engine: CryptoEngine | 'main' | null = null
  private slots: Slot[] = []
  private queue: Pending[] = []
  // la page chiffre elle-même pour de bon : aucun Worker n'a jamais démarré
  // dans ce navigateur (ou close())
  private broken = false
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  // un Worker a déjà dit « prêt » : les suivants qui plantent sont relancés
  // plus tard, jamais abandonnés pour de bon
  private everReady = false
  // pertes d'affilée sans travail réussi entre deux, et relance prévue
  private losses = 0
  private retryAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

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
    this.broken = true
    this.engine = 'main'
    this.stopAll()
    this.pump()
  }

  private submit(op: 'seal' | 'open', key: Uint8Array, data: Uint8Array, aad: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, key, aad, data, len: data.byteLength, kept: op === 'open', resolve, reject })
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      this.pump()
    })
  }

  private runOnPage(p: Pending, data: Uint8Array = p.data) {
    try {
      p.resolve(p.op === 'seal' ? this.opts.fallback.seal(p.key, data, p.aad) : this.opts.fallback.open(p.key, data, p.aad))
    } catch {
      p.reject(p.op === 'open' ? new CryptoAuthError() : new CryptoPoolError())
    }
  }

  /** Travaux confiés à la page, un à un, en rendant la main entre deux : la
   *  page reste utilisable. */
  private runQueueOnPage() {
    const jobs = this.queue.splice(0)
    if (jobs.length) this.engine = 'main'
    jobs.forEach((p, i) => setTimeout(() => this.runOnPage(p), i))
  }

  private pump(): void {
    if (this.broken) return this.runQueueOnPage()
    const now = Date.now()
    // démarrage paresseux : aucun Worker tant qu'il n'y a rien à chiffrer.
    // Après une perte, on attend avant d'en relancer (réseau qui revient,
    // mémoire rendue) au lieu de réessayer en boucle.
    if (now >= this.retryAt) {
      while (this.slots.length < Math.max(1, this.opts.size) && this.queue.length > 0 && this.spawn()) {
        /* un de plus */
      }
      if (this.broken) return this.runQueueOnPage()
    }
    // Workers perdus plusieurs fois d'affilée : la page fait le travail
    // jusqu'à la prochaine relance, pour que rien ne reste bloqué
    if (this.losses >= PAGE_AFTER && now < this.retryAt) {
      this.runQueueOnPage()
      return this.armIdle()
    }
    for (;;) {
      const p = this.queue[0]
      if (!p) break
      let best: Slot | null = null
      for (const s of this.slots) if (s.ready && (!best || s.inflight.size < best.inflight.size)) best = s
      if (!best) break
      this.queue.shift()
      this.post(best, p)
    }
    if (this.queue.length > 0 && now < this.retryAt && !this.slots.some((s) => !s.ready)) {
      // aucun Worker pour l'instant : on attend la relance (un seul
      // minuteur, posé seulement quand il y a du travail en attente)
      if (!this.retryTimer)
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.pump()
        }, this.retryAt - now)
    }
    this.armIdle()
  }

  private spawn(): boolean {
    let w: WorkerLike
    try {
      w = this.opts.create()
    } catch {
      // pas de Worker dans ce navigateur : la page chiffre elle-même, pour de
      // bon ; un Worker qui a déjà marché sera retenté plus tard
      if (!this.everReady && this.slots.length === 0) this.fail()
      else this.lost()
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
    // Worker déjà abandonné (message parti avant son arrêt) : ignoré
    if (!this.slots.includes(slot)) return
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
    if ('error' in r) {
      if (r.error === 'auth') p.reject(new CryptoAuthError())
      else {
        // le Worker n'a pas pu (mémoire, moteur) : la page refait ce morceau
        // avec le tampon qu'il a rendu, ou la copie qu'elle a gardée
        const data = r.buf ? new Uint8Array(r.buf) : this.stillHeld(p)
        if (data) setTimeout(() => this.runOnPage(p, data), 0)
        else p.reject(new CryptoPoolError())
      }
    } else {
      // un travail réussi : les pertes d'avant sont oubliées
      this.losses = 0
      this.retryAt = 0
      p.resolve(new Uint8Array(r.buf))
    }
    this.pump()
  }

  /** Données d'un travail encore disponibles sur la page, sinon null. */
  private stillHeld(p: Pending): Uint8Array | null {
    if (p.kept) return p.data
    return p.len === 0 ? new Uint8Array(0) : null
  }

  private post(slot: Slot, p: Pending) {
    // chiffrement : le tampon part au Worker sans copie (une vue partielle est
    // d'abord recopiée). Déchiffrement : le Worker reçoit une copie.
    if (p.op === 'seal') p.kept = this.losses > 0
    const whole = p.data.byteOffset === 0 && p.data.byteLength === p.data.buffer.byteLength
    const buf = (whole && !p.kept ? p.data.buffer : new Uint8Array(p.data).buffer) as ArrayBuffer
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

  /** Travaux d'un Worker perdu : ceux dont la page a encore les données sont
   *  refaits par la page, les autres échouent (l'envoi relit ce morceau). */
  private orphan(jobs: Iterable<Pending>) {
    for (const p of jobs) {
      const data = this.stillHeld(p)
      if (data) setTimeout(() => this.runOnPage(p, data), 0)
      else p.reject(new CryptoPoolError())
    }
  }

  /** Worker perdu (erreur, pas prêt à temps) : la file continue sur les
   *  autres, et on en relance un plus tard. */
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
    const jobs = [...slot.inflight.values()]
    slot.inflight.clear()
    this.orphan(jobs)
    // aucun Worker n'a jamais démarré dans ce navigateur : la page chiffre
    // elle-même, comme avant
    if (!this.everReady && this.slots.length === 0) return this.fail()
    this.lost()
    this.pump()
  }

  /** Une perte de plus : prochaine relance dans 1, 2, 4 puis 8 fois retryMs.
   *  Plusieurs Workers perdus ensemble (réseau coupé au démarrage) ne
   *  comptent qu'une fois. */
  private lost() {
    const now = Date.now()
    if (now < this.retryAt) return
    this.losses++
    this.retryAt = now + (this.opts.retryMs ?? 1000) * 2 ** Math.min(this.losses - 1, MAX_BACKOFF_STEPS)
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
      this.orphan(s.inflight.values())
      s.inflight.clear()
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
