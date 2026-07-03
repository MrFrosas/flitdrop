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
