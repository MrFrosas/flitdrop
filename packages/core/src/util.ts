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

/** IPv4 locales, triées par probabilité d'être le bon réseau wifi. */
export function localIPv4s(): string[] {
  const out: { ip: string; score: number }[] = []
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      let score = 0
      if (a.address.startsWith('192.168.')) score = 3
      else if (a.address.startsWith('10.')) score = 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score = 1
      if (/^(vmnet|vboxnet|docker|br-|utun|tun|tap|llw|awdl)/i.test(ifname)) score -= 5
      out.push({ ip: a.address, score })
    }
  }
  return out.sort((x, y) => y.score - x.score).map((x) => x.ip)
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
