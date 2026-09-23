import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual, createHash } from 'node:crypto'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Nettoie un nom de fichier fourni par un client : pas de chemin, pas de
 *  caractères interdits Windows, pas de noms réservés, longueur bornée. */
export function sanitizeFilename(input: unknown): string {
  let name = String(input ?? '')
  name = name.split(/[\\/]/).pop() ?? ''
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
  name = name.replace(/^\.+/, '').replace(/[. ]+$/g, '')
  if (WINDOWS_RESERVED.test(name)) name = '_' + name
  if (name.length > 150) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && dot > name.length - 12 ? name.slice(dot) : ''
    name = name.slice(0, 150 - ext.length) + ext
  }
  return name || 'fichier'
}

function nthCandidate(dir: string, name: string, i: number): string {
  if (i === 0) return path.join(dir, name)
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return path.join(dir, `${base} (${i + 1})${ext}`)
}

/** Chemin libre dans dir pour name, en suffixant " (2)", " (3)"… si besoin.
 *  Non atomique : à réserver seulement pour de l'affichage. Pour créer un
 *  fichier, préférer reserveUniquePath qui pose le fichier de façon exclusive. */
export function uniquePath(dir: string, name: string): string {
  for (let i = 0; i < 10000; i++) {
    const candidate = nthCandidate(dir, name, i)
    if (!fs.existsSync(candidate)) return candidate
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return path.join(dir, `${base}-${process.hrtime.bigint()}${ext}`)
}

/** Réserve atomiquement un chemin libre en créant le fichier en mode exclusif
 *  (O_CREAT|O_EXCL). Élimine la course entre « le nom est libre » et « je le
 *  crée » : deux écritures concurrentes du même nom obtiennent des noms
 *  distincts. Renvoie le chemin et un descripteur ouvert en écriture. */
export function reserveUniquePath(dir: string, name: string): { path: string; fd: number } {
  for (let i = 0; i < 10000; i++) {
    const candidate = nthCandidate(dir, name, i)
    try {
      const fd = fs.openSync(candidate, 'wx')
      return { path: candidate, fd }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const fallback = path.join(dir, `${base}-${process.hrtime.bigint()}${ext}`)
  return { path: fallback, fd: fs.openSync(fallback, 'wx') }
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** Interface réseau telle que la donne os.networkInterfaces(). */
export interface NetIface {
  address: string
  family: string | number
  internal: boolean
  mac?: string
}

// Cartes que le téléphone ne peut pas joindre : machines virtuelles, conteneurs,
// réseaux privés virtuels (VPN, Tailscale, ZeroTier, Hamachi, Radmin). Noms
// Unix (macOS, Linux) et noms Windows.
const VIRTUAL_NAME =
  /^(?:vmnet|vboxnet|docker|br-|veth|virbr|lxcbr|lxdbr|cni|flannel|cali|podman|kube|tun|tap|utun|ppp|ipsec|wg|tailscale|zt|ham|llw|awdl|anpi|gif|stf|feth|bridge0$)|virtualbox|vmware|hyper-v|default switch|\bwsl\b|hamachi|zerotier|tailscale|radmin|wireguard|openvpn|nordlynx|tap-windows|vpn|npcap|loopback/i
// commutateur Hyper-V : « vEthernet (Default Switch) » ou (WSL) sont virtuels
// (attrapés ci-dessus) ; un autre vEthernet peut porter la vraie carte (commutateur
// externe) : ni exclu, ni préféré
const HYPERV_NAME = /^vethernet\b/i
// fabricants de cartes virtuelles (début de l'adresse MAC) : VirtualBox,
// VMware, Parallels, Docker, carte TAP d'OpenVPN ; et adresse MAC nulle des
// tunnels (WireGuard, utun, tun), qu'aucune vraie carte ne porte
const VIRTUAL_MAC = /^(?:0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:1c:42|02:42:|00:ff:|00:00:00:00:00:00$)/i
const HYPERV_MAC = /^00:15:5d/i
// vraies cartes wifi ou filaires, par système
const PHYSICAL_NAME: Record<string, RegExp> = {
  darwin: /^en\d+$/,
  linux: /^(?:eth\d|en[opsx]?\w*|wl\w*|wlan\d)/,
  // noms Windows traduits : Wi-Fi, WLAN (allemand), Ethernet, anciens noms
  // « Connexion au réseau local » ; jamais ceux à astérisque (cartes Wi-Fi Direct)
  win32: /^(?:wi-?fi|wlan|ethernet|wireless|drahtlos|connexion (?:au )?r[ée]seau|lan-verbindung|local area connection)(?!.*\*)/i,
}

// adresses que le téléphone ne peut pas joindre : secours automatique
// (169.254), plage partagée des opérateurs utilisée par Tailscale (100.64/10),
// Hamachi (25/8)
const linkLocal = (ip: string) => ip.startsWith('169.254.')
const unreachable = (ip: string) => linkLocal(ip) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || ip.startsWith('25.')

/** Partage de connexion du PC en marche : c'est alors par là que le téléphone
 *  arrive (point d'accès mobile Windows, partage Internet du Mac, point d'accès
 *  de NetworkManager sous Linux). */
function isHotspot(ifname: string, ip: string, platform: string): boolean {
  if (platform === 'win32') return ip === '192.168.137.1'
  if (platform === 'darwin') return /^bridge1\d\d$/.test(ifname) && /^192\.168\.[2-9]\.1$/.test(ip)
  if (platform === 'linux') return /^10\.42\.\d+\.1$/.test(ip)
  return false
}

// ancien classement, gardé pour départager deux cartes du même rang
function legacyScore(ifname: string, ip: string): number {
  let score = 0
  if (ip.startsWith('192.168.')) score = 3
  else if (ip.startsWith('10.')) score = 2
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 1
  if (/^(vmnet|vboxnet|docker|br-|utun|tun|tap|llw|awdl)/i.test(ifname)) score -= 5
  return score
}

/** Rang d'une adresse : 3 partage de connexion du PC, 2 vraie carte wifi ou
 *  filaire, 1 inconnue, 0 injoignable par le téléphone (virtuelle, VPN). */
function rankOf(ifname: string, ip: string, mac: string, platform: string): number {
  if (unreachable(ip)) return 0
  if (isHotspot(ifname, ip, platform)) return 3
  if (VIRTUAL_NAME.test(ifname) || VIRTUAL_MAC.test(mac)) return 0
  if (HYPERV_NAME.test(ifname) || HYPERV_MAC.test(mac)) return 1
  const physical = PHYSICAL_NAME[platform]
  return physical && physical.test(ifname) ? 2 : 1
}

/** IPv4 locales, la meilleure d'abord (celle du QR code). On écarte les
 *  cartes virtuelles, les VPN et les adresses de secours, on préfère le
 *  partage de connexion du PC puis les vraies cartes wifi ou filaires, et
 *  l'ancien classement départage le reste. Les cartes écartées restent en fin
 *  de liste (adresses de secours du téléphone), sauf les adresses 169.254.
 *  Si tout est écarté, on rend exactement l'ancien classement : jamais de
 *  liste vide quand l'ancien calcul trouvait quelque chose. Aucune route par
 *  défaut consultée : un VPN la fausse. */
export function rankIPv4s(ifaces: Record<string, NetIface[] | undefined>, platform: string = process.platform): string[] {
  const all: { ip: string; rank: number; score: number; order: number }[] = []
  for (const [ifname, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue
      all.push({ ip: a.address, rank: rankOf(ifname, a.address, a.mac ?? '', platform), score: legacyScore(ifname, a.address), order: all.length })
    }
  }
  const legacy = [...all].sort((x, y) => y.score - x.score || x.order - y.order)
  if (!all.some((x) => x.rank > 0)) return legacy.map((x) => x.ip)
  const good = all.filter((x) => x.rank > 0).sort((x, y) => y.rank - x.rank || y.score - x.score || x.order - y.order)
  const rest = legacy.filter((x) => x.rank === 0 && !linkLocal(x.ip))
  return [...good, ...rest].map((x) => x.ip)
}

/** IPv4 locales de ce PC, la meilleure d'abord (voir rankIPv4s). */
export function localIPv4s(): string[] {
  return rankIPv4s(os.networkInterfaces() as Record<string, NetIface[] | undefined>)
}

export const b64u = {
  enc: (buf: Uint8Array): string => Buffer.from(buf).toString('base64url'),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url')),
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export function moduleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl))
}

export function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}
