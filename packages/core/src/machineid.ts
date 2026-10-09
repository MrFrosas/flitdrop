// Identité de LA MACHINE pour Flitdrop Pro (license.ts) : l'identifiant que le
// système donne à cet ordinateur, lu une fois au lancement, puis gardé en
// mémoire. Il ne sort jamais de l'ordinateur tel quel : seule une empreinte
// (sha256, 32 caractères) part avec un achat. Sert aussi de clé à l'empreinte
// qui protège l'état de la licence (essai, compteur du jour).
//
// - Windows : MachineGuid (HKLM\SOFTWARE\Microsoft\Cryptography), via reg.exe
//   sans fenêtre.
// - macOS : IOPlatformUUID (ioreg).
// - Linux : /etc/machine-id, sinon /var/lib/dbus/machine-id.
// Illisible (système verrouillé, conteneur) : null, et license.ts se rabat
// sur un identifiant aléatoire gardé dans la config (voir là-bas).
//
// Deuxième emplacement de l'essai (anti-remise à zéro) : en dehors du dossier
// de config de Flitdrop. Windows : HKCU\Software\Flitdrop, valeur « t ».
// macOS et Linux : un petit fichier « .t » dans le dossier de données de
// l'app Electron, sinon ~/.local/share/flitdrop/.t.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<string>
export type ReadFn = (file: string) => Promise<string>

const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })

const defaultRead: ReadFn = (file) => fs.promises.readFile(file, 'utf8')

// outils du système par leur chemin complet, jamais par le PATH (un programme
// du même nom posé ailleurs ne peut pas répondre à leur place)
const REG_EXE = (): string => path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe')
const IOREG = '/usr/sbin/ioreg'

/** Identifiant plausible : assez long, sans caractère bizarre, pas une suite
 *  de zéros (certaines machines virtuelles rendent un identifiant vide). */
export function plausibleId(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  if (s.length < 8 || s.length > 200 || !/^[A-Za-z0-9-]+$/.test(s)) return null
  if (/^[0-]+$/.test(s)) return null
  return s.toLowerCase()
}

/** Lit l'identifiant de la machine. Jamais d'erreur : null si illisible. */
export async function readMachineIdentifier(
  o: { platform?: NodeJS.Platform; exec?: ExecFn; read?: ReadFn; timeoutMs?: number } = {}
): Promise<string | null> {
  const platform = o.platform ?? process.platform
  const exec = o.exec ?? defaultExec
  const read = o.read ?? defaultRead
  const timeoutMs = o.timeoutMs ?? 2500
  try {
    if (platform === 'win32') {
      const out = await exec(REG_EXE(), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], timeoutMs)
      return plausibleId(out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Za-z-]+)/)?.[1])
    }
    if (platform === 'darwin') {
      const out = await exec(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], timeoutMs)
      return plausibleId(out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1])
    }
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = plausibleId(await read(f))
        if (id) return id
      } catch {
        // fichier suivant
      }
    }
    return null
  } catch {
    return null
  }
}

/** Identifiant d'appareil de la licence : 32 premiers caractères hexadécimaux
 *  de sha256("flitdrop-device-v1:" + identifiant de la machine). */
export function deviceIdFrom(machine: string): string {
  return createHash('sha256').update('flitdrop-device-v1:' + machine).digest('hex').slice(0, 32)
}

/** Deuxième emplacement du début de l'essai. read : null si absent ou
 *  illisible ; write : false si impossible (jamais d'erreur). */
export interface MarkStore {
  read(): Promise<string | null>
  write(value: string): Promise<boolean>
}

const MARK_MAX = 200

/** Fichier « .t » (macOS, Linux, ou chemin imposé pour un lancement isolé). */
export function fileMarkStore(file: string): MarkStore {
  return {
    async read() {
      try {
        const v = (await fs.promises.readFile(file, 'utf8')).trim()
        return v.length > 0 && v.length <= MARK_MAX ? v : null
      } catch {
        return null
      }
    },
    async write(value) {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await fs.promises.writeFile(file, value, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
  }
}

/** Registre de Windows : HKCU\Software\Flitdrop, valeur « t » (texte). */
export function registryMarkStore(exec: ExecFn = defaultExec, timeoutMs = 2500): MarkStore {
  const KEY = 'HKCU\\Software\\Flitdrop'
  return {
    async read() {
      try {
        const out = await exec(REG_EXE(), ['query', KEY, '/v', 't'], timeoutMs)
        const v = out.match(/\bt\s+REG_SZ\s+(\S+)/)?.[1] ?? ''
        return v.length > 0 && v.length <= MARK_MAX ? v : null
      } catch {
        return null
      }
    },
    async write(value) {
      // valeur faite de chiffres, de lettres, de points : rien à échapper,
      // et passée en argument séparé (jamais interprétée par un shell)
      if (!/^[A-Za-z0-9._-]+$/.test(value)) return false
      try {
        await exec(REG_EXE(), ['add', KEY, '/v', 't', '/t', 'REG_SZ', '/d', value, '/f'], timeoutMs)
        return true
      } catch {
        return false
      }
    },
  }
}

/** Emplacement par défaut selon le système. `userDataDir` : dossier de
 *  données de l'app Electron (app.getPath('userData')). */
export function defaultMarkStore(o: { platform?: NodeJS.Platform; userDataDir?: string; homedir?: string } = {}): MarkStore {
  const platform = o.platform ?? process.platform
  if (platform === 'win32') return registryMarkStore()
  const dir = o.userDataDir || path.join(o.homedir ?? os.homedir(), '.local', 'share', 'flitdrop')
  return fileMarkStore(path.join(dir, '.t'))
}
