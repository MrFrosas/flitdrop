// Vitesse réelle d'un transfert et temps restant, pour le téléphone et le PC.
// Mesurée sur les dernières secondes seulement : une pause (écran verrouillé,
// wifi coupé) ne fait plus chuter la vitesse affichée pour toute la suite,
// comme l'ancienne moyenne « octets depuis le début ».
import { t, fmtBytes, type Lang } from '../i18n.js'

export class SpeedMeter {
  // octets cumulés à chaque instant noté (ms)
  private samples: { at: number; total: number }[] = []

  constructor(
    private windowMs = 5000,
    private now: () => number = () => Date.now()
  ) {}

  /** Nouveau total d'octets passés (cumulé depuis le début). */
  add(total: number): void {
    const at = this.now()
    const last = this.samples[this.samples.length - 1]
    if (last && total < last.total) this.samples = [] // reprise : le compte repart
    this.samples.push({ at, total })
    // on garde un point juste avant la fenêtre pour mesurer toute sa durée
    while (this.samples.length > 2 && this.samples[1]!.at <= at - this.windowMs) this.samples.shift()
  }

  /** Octets par seconde sur la fenêtre, ou null tant qu'on n'a pas assez vu
   *  (moins d'une seconde) : on n'affiche pas un chiffre au hasard. */
  rate(): number | null {
    const now = this.now()
    if (this.samples.length < 2) return null
    const first = this.samples[0]!
    const last = this.samples[this.samples.length - 1]!
    // le temps écoulé depuis le dernier octet compte : un transfert bloqué
    // voit sa vitesse descendre au lieu de rester figée
    const span = Math.max(now, last.at) - first.at
    if (span < 1000) return null
    return Math.max(0, ((last.total - first.total) * 1000) / span)
  }
}

/** Secondes restantes, ou null si la vitesse est inconnue ou nulle. */
export function etaSeconds(remaining: number, rate: number | null): number | null {
  if (!rate || rate <= 0 || !Number.isFinite(rate)) return null
  return Math.max(0, remaining / rate)
}

/** « 45 s », « 3 min 20 s », « 1 h 05 min » (arrondi à ce qui compte). */
export function fmtDuration(lang: Lang, sec: number): string {
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return t(lang, 'dur.s', { s })
  if (s < 600) return t(lang, 'dur.ms', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
  if (s < 3600) return t(lang, 'dur.m', { m: Math.round(s / 60) })
  const m = Math.round(s / 60)
  return t(lang, 'dur.hm', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
}

/** « 42 % · 31,5 Mo/s · encore 12 s », ou « 42 % » tant que la vitesse n'est pas connue. */
export function progressText(lang: Lang, done: number, total: number, rate: number | null): string {
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0
  if (rate === null) return t(lang, 'xfer.pct', { pct })
  const eta = etaSeconds(Math.max(0, total - done), rate)
  const speed = fmtBytes(lang, rate)
  if (eta === null) return t(lang, 'xfer.speed', { pct, speed })
  return t(lang, 'xfer.speedEta', { pct, speed, eta: fmtDuration(lang, eta) })
}
