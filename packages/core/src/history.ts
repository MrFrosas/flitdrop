import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'

export interface HistoryEntry {
  id: string
  ts: string
  dir: 'in' | 'out'
  kind: 'file' | 'text' | 'clip'
  name?: string
  size?: number
  preview?: string
  deviceId?: string
  deviceName?: string
  status: 'ok' | 'error' | 'progress'
  path?: string
  error?: string
}

export class History {
  private entries: HistoryEntry[] = []
  private file: string
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(home: string) {
    this.file = path.join(home, 'history.json')
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8')) as HistoryEntry[]
      if (Array.isArray(list)) this.entries = list.slice(0, 300)
    } catch {
      // pas d'historique
    }
  }

  add(e: Omit<HistoryEntry, 'id' | 'ts'>): HistoryEntry {
    const entry: HistoryEntry = { id: randomToken(6), ts: new Date().toISOString(), ...e }
    this.entries.unshift(entry)
    if (this.entries.length > 300) this.entries.length = 300
    this.persist()
    return entry
  }

  update(id: string, patch: Partial<HistoryEntry>): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return
    Object.assign(e, patch)
    this.persist()
  }

  list(n = 120): HistoryEntry[] {
    return this.entries.slice(0, n)
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  private persist(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      fs.writeFile(this.file, JSON.stringify(this.entries), { mode: 0o600 }, () => {})
    }, 400)
  }
}
