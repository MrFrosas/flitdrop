import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'
import { OUTBOX_MAX_ITEMS } from './constants.js'

export interface OutboxItem {
  id: string
  kind: 'text' | 'file'
  text?: string
  name?: string
  size?: number
  mime?: string
  filePath?: string
  createdAt: string
  downloads: Record<string, string>
}

/** File d'attente PC -> téléphone. Les fichiers sont copiés dans un dossier
 *  interne pour rester disponibles même si l'original bouge. */
export class Outbox {
  readonly dir: string
  private items: OutboxItem[] = []

  constructor(home: string) {
    this.dir = path.join(home, 'outbox')
    fs.mkdirSync(this.dir, { recursive: true })
    // au démarrage, purge les fichiers orphelins d'une session précédente
    try {
      for (const f of fs.readdirSync(this.dir)) fs.unlink(path.join(this.dir, f), () => {})
    } catch {
      // rien à purger
    }
  }

  addText(text: string): OutboxItem {
    const item: OutboxItem = {
      id: randomToken(8),
      kind: 'text',
      text,
      size: Buffer.byteLength(text, 'utf8'),
      createdAt: new Date().toISOString(),
      downloads: {},
    }
    this.items.unshift(item)
    this.prune()
    return item
  }

  fileTarget(id: string, safeName: string): string {
    return path.join(this.dir, `${id}_${safeName}`)
  }

  addFile(safeName: string, filePath: string, size: number, mime?: string): OutboxItem {
    const item: OutboxItem = {
      id: randomToken(8),
      kind: 'file',
      name: safeName,
      filePath,
      size,
      mime,
      createdAt: new Date().toISOString(),
      downloads: {},
    }
    this.items.unshift(item)
    this.prune()
    return item
  }

  get(id: string): OutboxItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  markDownloaded(id: string, deviceId: string): void {
    const item = this.get(id)
    if (item) item.downloads[deviceId] = new Date().toISOString()
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx === -1) return false
    const [item] = this.items.splice(idx, 1)
    if (item?.filePath && item.filePath.startsWith(this.dir)) fs.unlink(item.filePath, () => {})
    return true
  }

  listForPhone() {
    return this.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      name: i.name,
      size: i.size,
      mime: i.mime,
      text: i.kind === 'text' ? i.text : undefined,
      createdAt: i.createdAt,
    }))
  }

  listAdmin() {
    return this.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      name: i.name,
      size: i.size,
      mime: i.mime,
      preview: i.kind === 'text' ? (i.text ?? '').slice(0, 120) : undefined,
      createdAt: i.createdAt,
      downloads: i.downloads,
    }))
  }

  private prune(): void {
    while (this.items.length > OUTBOX_MAX_ITEMS) {
      const item = this.items.pop()
      if (item?.filePath && item.filePath.startsWith(this.dir)) fs.unlink(item.filePath, () => {})
    }
  }
}
