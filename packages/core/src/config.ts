import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, DEFAULT_MAX_FILE_MB } from './constants.js'
import { randomToken } from './crypto.js'

export interface Config {
  deviceName: string
  port: number
  downloadDir: string
  maxFileMB: number
  requireApproval: boolean
  adminToken: string
  // identité secrète unique de CE PC. Chaque appairage y est lié : un téléphone
  // appairé à ce PC ne peut pas être utilisé avec un autre PC, même sur le même
  // wifi. « Réinitialiser ce PC » la fait tourner pour invalider tous les
  // appairages d'un coup (utile quand on prête ou revend la machine).
  instanceId: string
  // le PC surveille son presse-papiers et le met à disposition des téléphones
  // dès qu'il change (sens PC vers téléphone, seul sens automatisable côté PC).
  clipboardAutoPush: boolean
  // historique local du presse-papiers (façon Paste) : tout ce qui est copié
  // sur le PC et reçu des téléphones, purgé automatiquement selon la rétention.
  clipHistoryEnabled: boolean
  clipHistoryMaxItems: number
  clipHistoryMaxDays: number
  // apparence de l'interface PC : suit l'OS, ou forcée claire/sombre.
  theme: 'system' | 'light' | 'dark'
  // style de l'interface : 'auto' suit l'OS réel (Apple sur Mac, Windows sur
  // Windows) ; on peut forcer l'un ou l'autre indépendamment du système.
  skin: 'auto' | 'apple' | 'windows'
  // consentement à l'envoi anonyme d'usage et d'erreurs (opt-in, décoché par défaut).
  telemetryConsent: boolean
}

export function flitdropHome(override?: string): string {
  const h = override || process.env.FLITDROP_HOME || path.join(os.homedir(), '.flitdrop')
  fs.mkdirSync(h, { recursive: true })
  return h
}

export function defaultDeviceName(): string {
  const raw = (os.hostname().split('.')[0] ?? '').replace(/[-_]+/g, ' ').trim()
  return raw.slice(0, 32) || 'Mon PC'
}

export function loadConfig(home: string): Config {
  const p = path.join(home, 'config.json')
  let stored: Partial<Config> = {}
  try {
    stored = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    // premier lancement
  }
  const cfg: Config = {
    deviceName: stored.deviceName || defaultDeviceName(),
    port: stored.port ?? DEFAULT_PORT,
    downloadDir:
      stored.downloadDir || process.env.FLITDROP_DOWNLOADS || path.join(os.homedir(), 'Downloads', 'Flitdrop'),
    maxFileMB: clampInt(stored.maxFileMB, 1, 128 * 1024, DEFAULT_MAX_FILE_MB),
    requireApproval: stored.requireApproval === true,
    adminToken: typeof stored.adminToken === 'string' && stored.adminToken.length >= 20 ? stored.adminToken : randomToken(24),
    instanceId: typeof stored.instanceId === 'string' && stored.instanceId.length >= 12 ? stored.instanceId : randomToken(12),
    clipboardAutoPush: stored.clipboardAutoPush === true,
    clipHistoryEnabled: stored.clipHistoryEnabled !== false,
    clipHistoryMaxItems: clampInt(stored.clipHistoryMaxItems, 10, 1000, 200),
    clipHistoryMaxDays: clampInt(stored.clipHistoryMaxDays, 1, 90, 7),
    theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
    skin: stored.skin === 'apple' || stored.skin === 'windows' ? stored.skin : 'auto',
    telemetryConsent: stored.telemetryConsent === true,
  }
  saveConfig(home, cfg)
  return cfg
}

export function saveConfig(home: string, cfg: Config): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2))
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
