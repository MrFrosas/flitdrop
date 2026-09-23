import { EventEmitter } from 'node:events'

/** État diffusé par l'événement 'transfer' : un transfert est en cours (des
 *  octets passent, ou sont passés il y a moins de 30 s) et, quand on la
 *  connaît, la progression globale des transferts en cours (0 à 1). */
export interface TransferActivityState {
  active: boolean
  progress: number | null
}

// délai de calme après le dernier octet avant de déclarer « plus rien ne passe »
export const ACTIVITY_IDLE_MS = 30_000
// au plus 2 annonces de progression par seconde
export const ACTIVITY_THROTTLE_MS = 500

/** Activité des transferts, pour l'app de bureau : garder le PC éveillé
 *  pendant un transfert et afficher la progression sur l'icône. Couvre les
 *  trois sens : téléphone vers PC (morceaux, Raccourci iOS), PC vers téléphone
 *  (téléchargement) et les longs textes. Le coeur possède la minuterie : l'app
 *  n'a qu'à écouter 'transfer'. Aucune minuterie ne tourne au repos. */
export class TransferActivity extends EventEmitter {
  private entries = new Map<string, { done: number; total: number; at: number }>()
  private active = false
  private lastByte = 0
  private lastEmit = 0
  private lastSent: TransferActivityState | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private trailing: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private now: () => number = () => Date.now()) {
    super()
  }

  /** Des octets passent pour ce transfert (clé libre, unique par transfert) :
   *  `done` octets sur `total` (0 si la taille est inconnue). */
  update(key: string, done: number, total: number): void {
    if (this.closed) return
    this.entries.set(key, { done: Math.max(0, done), total: Math.max(0, total), at: this.now() })
    const was = this.active
    this.touch()
    if (was) this.emitSoon()
  }

  /** Des octets passent, sans information de progression (appelé à chaque
   *  paquet reçu : ne fait que noter l'heure, sauf au premier). */
  touch(): void {
    if (this.closed) return
    this.lastByte = this.now()
    if (this.active) return
    this.active = true
    this.armIdle(ACTIVITY_IDLE_MS)
    this.emitNow()
  }

  /** Transfert terminé (réussi, raté ou abandonné) : il sort du calcul de la
   *  progression. L'activité ne retombe qu'après 30 s sans aucun octet. */
  end(key: string): void {
    if (!this.entries.delete(key) || !this.active) return
    this.emitSoon()
  }

  /** Progression globale des transferts en cours dont la taille est connue.
   *  Un transfert muet depuis 30 s (téléphone parti sans finir) n'y compte
   *  plus : il ne fige pas la progression des autres. */
  progress(): number | null {
    const now = this.now()
    let done = 0
    let total = 0
    for (const [key, e] of this.entries) {
      if (now - e.at >= ACTIVITY_IDLE_MS) {
        this.entries.delete(key)
        continue
      }
      if (e.total <= 0) continue
      done += Math.min(e.done, e.total)
      total += e.total
    }
    return total > 0 ? Math.round((done / total) * 1000) / 1000 : null
  }

  state(): TransferActivityState {
    return { active: this.active, progress: this.active ? this.progress() : null }
  }

  close(): void {
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.trailing) clearTimeout(this.trailing)
    this.idleTimer = null
    this.trailing = null
    this.entries.clear()
    this.active = false
  }

  // Une seule minuterie de calme, réarmée seulement à son échéance (et pas à
  // chaque paquet de 64 Ko) : elle regarde l'heure du dernier octet.
  private armIdle(ms: number): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      const quiet = this.now() - this.lastByte
      if (quiet < ACTIVITY_IDLE_MS) return this.armIdle(ACTIVITY_IDLE_MS - quiet)
      this.active = false
      this.entries.clear()
      if (this.trailing) clearTimeout(this.trailing)
      this.trailing = null
      this.emitNow()
    }, ms)
    this.idleTimer.unref?.()
  }

  private emitSoon(): void {
    if (this.trailing) return
    const wait = this.lastEmit + ACTIVITY_THROTTLE_MS - this.now()
    if (wait <= 0) return this.emitNow()
    // envoi différé : le dernier état est toujours annoncé, jamais perdu
    this.trailing = setTimeout(() => {
      this.trailing = null
      if (this.active) this.emitNow()
    }, wait)
    this.trailing.unref?.()
  }

  private emitNow(): void {
    const s = this.state()
    if (this.lastSent && this.lastSent.active === s.active && this.lastSent.progress === s.progress) return
    this.lastSent = s
    this.lastEmit = this.now()
    try {
      this.emit('transfer', s)
    } catch {
      // un écouteur qui plante ne casse jamais un transfert
    }
  }
}
