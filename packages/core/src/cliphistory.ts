import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'
import type { Config } from './config.js'

export interface ClipEntry {
  id: string
  ts: string
  text: string
  /** 'pc' pour une copie locale, sinon le nom de l'appareil qui a envoyé. */
  source: string
}

// un élément d'historique reste un extrait de presse-papiers, pas un fichier :
// au-delà, on tronque pour garder le fichier d'historique léger et rapide.
const MAX_TEXT_CHARS = 100_000

/** Historique local du presse-papiers, façon Paste : stocké sur le PC
 *  uniquement (~/.flitdrop/cliphistory.json), jamais envoyé à un serveur,
 *  purgé automatiquement selon la rétention choisie. */
export class ClipHistory {
  private entries: ClipEntry[] = []
  private file: string
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(home: string) {
    this.file = path.join(home, 'cliphistory.json')
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ClipEntry[]
      if (Array.isArray(list)) this.entries = list.filter((e) => e && typeof e.text === 'string')
    } catch {
      // pas encore d'historique
    }
  }

  /** Ajoute une entrée (dédoublonne contre la plus récente) et purge. */
  add(text: string, source: string, cfg: Config): ClipEntry | null {
    const t = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
    if (!t.trim()) return null
    if (this.entries[0]?.text === t) return null
    const entry: ClipEntry = { id: randomToken(6), ts: new Date().toISOString(), text: t, source: source.slice(0, 40) }
    this.entries.unshift(entry)
    this.purge(cfg)
    this.persist()
    return entry
  }

  /** Remonte une entrée existante en tête (re-copie depuis l'historique). */
  bump(id: string): ClipEntry | null {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx === -1) return null
    const [entry] = this.entries.splice(idx, 1)
    if (!entry) return null
    entry.ts = new Date().toISOString()
    this.entries.unshift(entry)
    this.persist()
    return entry
  }

  get(id: string): ClipEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  remove(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length !== before) {
      this.persist()
      return true
    }
    return false
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  purge(cfg: Config): void {
    const cutoff = Date.now() - cfg.clipHistoryMaxDays * 24 * 60 * 60 * 1000
    this.entries = this.entries.filter((e) => Date.parse(e.ts) >= cutoff)
    if (this.entries.length > cfg.clipHistoryMaxItems) this.entries.length = cfg.clipHistoryMaxItems
  }

  list(n = 300): ClipEntry[] {
    return this.entries.slice(0, n)
  }

  size(): number {
    return this.entries.length
  }

  private persist(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      fs.writeFile(this.file, JSON.stringify(this.entries), () => {})
    }, 400)
  }
}
