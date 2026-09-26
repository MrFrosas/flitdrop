// Verdict du test de vitesse, en mots simples : qui freine, le wifi ou le
// téléphone, et quoi faire. Pur (testé sous Node), le texte vient d'i18n.ts.
import { t, fmtBytes, type Lang } from '../i18n.js'
import type { PcLink } from '../wifi.js'
import { fmtDuration } from './speed.js'

export interface SpeedFacts {
  /** octets/s mesurés sur le réseau seul, du PC vers le téléphone et inversement */
  down: number
  up: number
  /** octets/s que ce téléphone chiffre (tous ses coeurs) */
  crypto: number
  /** le navigateur n'a pas de WebAssembly (mode Isolement d'iOS le plus souvent) */
  noWasm: boolean
  ios: boolean
  pc: PcLink | null
}

export type Limit = 'phone' | 'wifi' | 'none'

// en dessous, le wifi est vraiment lent pour un transfert de photos ou vidéos
const SLOW_NET = 8 * 1024 * 1024
// le téléphone freine s'il chiffre nettement moins vite que le réseau ne passe
const SLOW_CRYPTO = 15 * 1024 * 1024

export function speedLimit(f: SpeedFacts): Limit {
  const net = Math.min(f.down, f.up)
  if (f.crypto < SLOW_CRYPTO && f.crypto < net * 0.7) return 'phone'
  if (net < SLOW_NET) return 'wifi'
  return 'none'
}

export interface VerdictLine {
  text: string
  /** la phrase du verdict (mise en avant) */
  strong?: boolean
}

/** Lignes à afficher, dans l'ordre : mesures, verdict, conseils. */
export function speedVerdict(lang: Lang, f: SpeedFacts): VerdictLine[] {
  const mbs = (n: number) => fmtBytes(lang, n)
  const lines: VerdictLine[] = []
  const say = (key: string, params?: Record<string, string | number>, strong = false) =>
    lines.push(strong ? { text: t(lang, key, params), strong } : { text: t(lang, key, params) })
  say('st.net', { down: mbs(f.down), up: mbs(f.up) })
  say('st.crypto', { speed: mbs(f.crypto) })
  const pc = f.pc
  if (pc?.via === 'cable') say('st.pcCableInfo')
  else if (pc?.via === 'wifi' && pc.band)
    say('st.pcWifiInfo', { band: pc.band === '2.4' ? (lang === 'en' ? '2.4' : '2,4') : pc.band, mbps: pc.linkMbps ?? '?' })

  const limit = speedLimit(f)
  if (limit === 'phone') {
    say('st.limitPhone', { speed: mbs(f.crypto) }, true)
    if (f.noWasm && f.ios) say('st.lockdown')
    else say('st.phoneTip')
    return lines
  }
  if (limit === 'wifi') {
    say('st.limitWifi', undefined, true)
    if (pc?.via === 'wifi') {
      const weak = (pc.signalDbm !== undefined && pc.signalDbm < -70) || (pc.signalPct !== undefined && pc.signalPct < 50)
      if (pc.band === '2.4') say('st.pc24')
      else if (weak) say('st.pcWeak')
      else if (pc.linkMbps !== undefined && pc.linkMbps < 150) say('st.pcSlowLink', { mbps: pc.linkMbps })
      else say('st.pcCable')
    }
    say('st.phone5')
    return lines
  }
  const speed = Math.min(f.down, f.up, f.crypto)
  say('st.ok', { speed: mbs(speed), eta: fmtDuration(lang, (1024 * 1024 * 1024) / speed) }, true)
  return lines
}
