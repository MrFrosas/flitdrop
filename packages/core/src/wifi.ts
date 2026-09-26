// Comment le PC est relié au réseau (wifi 2,4 / 5 / 6 GHz, débit du lien,
// signal, ou câble), pour le test de vitesse du téléphone : dire en mots
// simples pourquoi un transfert est lent (« passe le PC en 5 GHz »).
// Lu UNE fois, à la demande (bouton « Tester la vitesse »), jamais en boucle :
// system_profiler prend quelques secondes sur un Mac. Rien n'est envoyé
// ailleurs qu'au téléphone appairé qui a demandé ; aucun nom de réseau.
import { execFile } from 'node:child_process'
import os from 'node:os'

export interface PcLink {
  /** comment le PC joint le téléphone : wifi, câble, ou inconnu */
  via: 'wifi' | 'cable' | 'unknown'
  band?: '2.4' | '5' | '6'
  /** débit du lien radio annoncé par le système (Mbit/s) */
  linkMbps?: number
  signalDbm?: number
  signalPct?: number
  /** norme (802.11ax…) */
  phy?: string
}

interface WifiFacts {
  iface?: string
  band?: '2.4' | '5' | '6'
  linkMbps?: number
  signalDbm?: number
  signalPct?: number
  phy?: string
}

const bandOfChannel = (ch: number, hint?: string): '2.4' | '5' | '6' | undefined => {
  if (hint && /6\s*GHz/i.test(hint)) return '6'
  if (hint && /5\s*GHz/i.test(hint)) return '5'
  if (hint && /2[.,]?4?\s*GHz/i.test(hint)) return '2.4'
  if (ch >= 1 && ch <= 14) return '2.4'
  if (ch >= 32 && ch <= 177) return '5'
  return undefined
}

/** macOS : sortie de `system_profiler SPAirPortDataType -json`. */
export function parseMacWifi(json: string): WifiFacts | null {
  let d: unknown
  try {
    d = JSON.parse(json)
  } catch {
    return null
  }
  const ifs = (d as { SPAirPortDataType?: { spairport_airport_interfaces?: Record<string, unknown>[] }[] })?.SPAirPortDataType?.[0]
    ?.spairport_airport_interfaces
  if (!Array.isArray(ifs)) return null
  for (const i of ifs) {
    const cur = i.spairport_current_network_information as Record<string, unknown> | undefined
    if (!cur || typeof cur.spairport_network_channel !== 'string') continue
    const chText = cur.spairport_network_channel
    const ch = parseInt(chText, 10)
    const out: WifiFacts = { iface: typeof i._name === 'string' ? i._name : undefined, band: bandOfChannel(ch, chText) }
    if (typeof cur.spairport_network_rate === 'number') out.linkMbps = cur.spairport_network_rate
    if (typeof cur.spairport_network_phymode === 'string') out.phy = cur.spairport_network_phymode
    const sig = typeof cur.spairport_signal_noise === 'string' ? /(-\d+)\s*dBm/.exec(cur.spairport_signal_noise) : null
    if (sig) out.signalDbm = Number(sig[1])
    return out
  }
  return null
}

/** Windows : sortie de `netsh wlan show interfaces`, dans la langue du
 *  système (on reconnaît les valeurs, pas les libellés traduits). */
export function parseNetsh(text: string): WifiFacts | null {
  const lines = text.split(/\r?\n/).map((l) => /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
  if (lines.length === 0) return null
  const out: WifiFacts = {}
  let channel = 0
  let bandHint = ''
  let connected = false
  let rx = 0
  let tx = 0
  for (const [, k, v] of lines as unknown as [string, string, string][]) {
    const key = k.toLowerCase()
    if (!out.iface && /^(name|nom)$/.test(key)) out.iface = v
    if (/^(connected|connecté|connecte|verbunden)$/i.test(v)) connected = true
    if (/^802\.11/.test(v)) out.phy = v
    if (/^\d+(?:[.,]\d+)?\s*GHz$/i.test(v)) bandHint = v
    if (/(channel|canal|kanal)/.test(key) && /^\d+$/.test(v)) channel = Number(v)
    if (/\(mb/i.test(key) && /^\d+(?:[.,]\d+)?$/.test(v)) {
      const n = Number(v.replace(',', '.'))
      if (/(receive|réception|reception|empfang)/.test(key)) rx = n
      else tx = n
    }
    if (/^\d{1,3}\s*%$/.test(v)) out.signalPct = parseInt(v, 10)
  }
  if (!connected && !channel) return null
  out.band = bandOfChannel(channel, bandHint)
  const rate = Math.max(rx, tx)
  if (rate > 0) out.linkMbps = rate
  return out
}

const run = (cmd: string, args: string[], timeoutMs: number): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    )
  })

async function readWifi(): Promise<WifiFacts | null> {
  if (process.platform === 'darwin') return parseMacWifi(await run('/usr/sbin/system_profiler', ['SPAirPortDataType', '-json'], 15_000))
  // Windows 11 24H2 peut exiger l'autorisation « position » pour ces infos :
  // sans elle, netsh échoue et on donne des conseils généraux
  if (process.platform === 'win32') return parseNetsh(await run('netsh', ['wlan', 'show', 'interfaces'], 8_000))
  return null
}

/** Nom de l'interface qui porte cette adresse locale (celle où arrive le téléphone). */
export function ifaceOfAddress(addr: string | undefined, ifs = os.networkInterfaces()): string | undefined {
  const a = (addr ?? '').replace(/^::ffff:/, '')
  if (!a) return undefined
  for (const [name, list] of Object.entries(ifs)) if (list?.some((x) => x.address === a)) return name
  return undefined
}

let cache: { at: number; facts: WifiFacts | null } | null = null
let inflight: Promise<WifiFacts | null> | null = null

/** Lien du PC vers le téléphone, pour l'adresse locale où le téléphone arrive. */
export async function pcLink(localAddress: string | undefined, read: () => Promise<WifiFacts | null> = readWifi): Promise<PcLink> {
  let facts: WifiFacts | null
  if (cache && Date.now() - cache.at < 60_000) facts = cache.facts
  else {
    inflight ??= read().catch(() => null)
    facts = await inflight
    inflight = null
    cache = { at: Date.now(), facts }
  }
  const iface = ifaceOfAddress(localAddress)
  if (!facts) return { via: 'unknown' }
  // le téléphone arrive par une autre interface que le wifi : câble (ou
  // partage de connexion par USB), le wifi du PC n'est pas en cause
  if (iface && facts.iface && iface !== facts.iface) return { via: 'cable' }
  const { iface: _i, ...rest } = facts
  return { via: 'wifi', ...rest }
}

/** Tests seulement. */
export function _resetPcLinkCache(): void {
  cache = null
  inflight = null
}
