import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'
import type { Config } from './config.js'

export interface ClipImage {
  /** fichier PNG complet sur le disque (~/.flitdrop/clipimg/<id>.png) */
  path: string
  /** miniature en data URL, pour l'aperçu dans l'historique */
  thumb: string
  w: number
  h: number
}

export interface ClipEntry {
  id: string
  ts: string
  /** texte pour une entrée texte, ou légende ("Image 1200×800") pour une image. */
  text: string
  kind: 'text' | 'image'
  /** 'pc' pour une copie locale, sinon le nom de l'appareil qui a envoyé. */
  source: string
  image?: ClipImage
}

// un élément d'historique reste un extrait de presse-papiers, pas un fichier :
// au-delà, on tronque pour garder le fichier d'historique léger et rapide.
const MAX_TEXT_CHARS = 100_000

/** Historique local du presse-papiers, façon Paste : stocké sur le PC
 *  uniquement (~/.flitdrop/cliphistory.json + clipimg/), jamais envoyé à un
 *  serveur, purgé automatiquement selon la rétention choisie. */
export class ClipHistory {
  private entries: ClipEntry[] = []
  private file: string
  readonly imgDir: string
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(home: string) {
    this.file = path.join(home, 'cliphistory.json')
    this.imgDir = path.join(home, 'clipimg')
    fs.mkdirSync(this.imgDir, { recursive: true, mode: 0o700 })
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ClipEntry[]
      if (Array.isArray(list)) {
        this.entries = list
          .filter((e) => e && typeof e.text === 'string')
          .map((e) => ({ ...e, kind: e.kind === 'image' ? ('image' as const) : ('text' as const) }))
      }
    } catch {
      // pas encore d'historique
    }
  }

  /** Ajoute une entrée texte (dédoublonne contre la plus récente) et purge. */
  add(text: string, source: string, cfg: Config): ClipEntry | null {
    const t = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
    if (!t.trim()) return null
    if (this.entries[0]?.kind === 'text' && this.entries[0]?.text === t) return null
    const entry: ClipEntry = { id: randomToken(6), ts: new Date().toISOString(), text: t, kind: 'text', source: source.slice(0, 40) }
    this.entries.unshift(entry)
    this.purge(cfg)
    this.persist()
    return entry
  }

  /** Ajoute une image copiée sur le PC. `png` est écrit sur le disque, `thumb`
   *  (data URL) sert d'aperçu. */
  addImage(png: Buffer, thumb: string, w: number, h: number, source: string, cfg: Config): ClipEntry | null {
    if (!png || png.length === 0) return null
    const id = randomToken(6)
    const file = path.join(this.imgDir, `${id}.png`)
    try {
      fs.writeFileSync(file, png, { mode: 0o600 })
    } catch {
      return null
    }
    const entry: ClipEntry = {
      id,
      ts: new Date().toISOString(),
      text: `Image ${w}×${h}`,
      kind: 'image',
      source: source.slice(0, 40),
      image: { path: file, thumb, w, h },
    }
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
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    this.entries = this.entries.filter((e) => e.id !== id)
    this.deleteImageFile(entry)
    this.persist()
    return true
  }

  clear(): void {
    for (const e of this.entries) this.deleteImageFile(e)
    this.entries = []
    this.persist()
  }

  purge(cfg: Config): void {
    const cutoff = Date.now() - cfg.clipHistoryMaxDays * 24 * 60 * 60 * 1000
    const kept: ClipEntry[] = []
    const dropped: ClipEntry[] = []
    for (const e of this.entries) {
      if (Date.parse(e.ts) >= cutoff && kept.length < cfg.clipHistoryMaxItems) kept.push(e)
      else dropped.push(e)
    }
    this.entries = kept
    for (const e of dropped) this.deleteImageFile(e)
  }

  private deleteImageFile(e: ClipEntry): void {
    if (e.kind === 'image' && e.image?.path && e.image.path.startsWith(this.imgDir)) {
      fs.unlink(e.image.path, () => {})
    }
  }

  /** Vue publique : sans le chemin disque (usage interne seulement). */
  list(n = 300): (Omit<ClipEntry, 'image'> & { image?: Omit<ClipImage, 'path'> })[] {
    return this.entries.slice(0, n).map((e) =>
      e.kind === 'image' && e.image
        ? { ...e, image: { thumb: e.image.thumb, w: e.image.w, h: e.image.h } }
        : e
    )
  }

  size(): number {
    return this.entries.length
  }

  private persist(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      // 0600 : l'historique du presse-papiers peut contenir des données sensibles
      fs.writeFile(this.file, JSON.stringify(this.entries), { mode: 0o600 }, () => {})
    }, 400)
  }
}
