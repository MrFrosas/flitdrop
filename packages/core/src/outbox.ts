import fs from 'node:fs'
import path from 'node:path'
import { randomToken } from './crypto.js'
import { OUTBOX_MAX_ITEMS } from './constants.js'

export interface OutboxItem {
  id: string
  kind: 'text' | 'file'
  // pour un texte : tapé dans l'interface ('text') ou venu du presse-papiers
  // du PC ('clipboard'). Sert uniquement aux statistiques (type d'envoi).
  origin?: 'text' | 'clipboard'
  text?: string
  name?: string
  size?: number
  mime?: string
  filePath?: string
  createdAt: string
  downloads: Record<string, string>
  // téléphones qui voient cet élément. Absent : tous (un seul téléphone ou
  // aucun appairé au moment de l'envoi). Dès qu'un deuxième téléphone est
  // appairé, les éléments sans destinataire sont réservés aux téléphones
  // déjà là (restrictUntargeted) : le nouveau venu ne voit pas le passé.
  to?: string[]
}

/** File d'attente PC -> téléphone. Les fichiers sont copiés dans un dossier
 *  interne pour rester disponibles même si l'original bouge. */
export class Outbox {
  readonly dir: string
  private items: OutboxItem[] = []
  /** Augmente à chaque changement de la liste vue par les téléphones : le
   *  téléphone qui a déjà cette version reçoit « rien de neuf » en quelques
   *  octets au lieu de toute la liste. */
  version = 0

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

  addText(text: string, origin: 'text' | 'clipboard' = 'text', to?: string[]): OutboxItem {
    const item: OutboxItem = {
      id: randomToken(8),
      kind: 'text',
      origin,
      text,
      size: Buffer.byteLength(text, 'utf8'),
      createdAt: new Date().toISOString(),
      downloads: {},
    }
    if (to) item.to = [...to]
    this.items.unshift(item)
    this.prune()
    this.version++
    return item
  }

  fileTarget(id: string, safeName: string): string {
    return path.join(this.dir, `${id}_${safeName}`)
  }

  addFile(safeName: string, filePath: string, size: number, mime?: string, to?: string[]): OutboxItem {
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
    if (to) item.to = [...to]
    this.items.unshift(item)
    this.prune()
    this.version++
    return item
  }

  /** Cet élément est-il destiné à ce téléphone ? */
  visibleTo(item: OutboxItem, deviceId: string): boolean {
    return !item.to || item.to.includes(deviceId)
  }

  /** Un deuxième téléphone vient d'être appairé : ce qui était en attente
   *  pour « tous » reste réservé aux téléphones déjà appairés. */
  restrictUntargeted(deviceIds: string[]): void {
    let changed = false
    for (const item of this.items) {
      if (item.to) continue
      item.to = [...deviceIds]
      changed = true
    }
    if (changed) this.version++
  }

  /** Le même téléphone rescanné (nouvel appairage) : ce qui attendait son
   *  ancien appairage lui revient aussi. */
  shareTargets(fromIds: string[], deviceId: string): void {
    let changed = false
    for (const item of this.items) {
      if (!item.to || item.to.includes(deviceId) || !item.to.some((id) => fromIds.includes(id))) continue
      item.to.push(deviceId)
      changed = true
    }
    if (changed) this.version++
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
    this.version++
    return true
  }

  /** Vide toute la file et ses fichiers (« Réinitialiser ce PC »). */
  clearAll(): void {
    for (const item of this.items) {
      if (item.filePath && item.filePath.startsWith(this.dir)) fs.unlink(item.filePath, () => {})
    }
    this.items = []
    this.version++
  }

  /** Éléments bruts (usage interne au serveur, jamais renvoyés tels quels). */
  listRaw(): readonly OutboxItem[] {
    return this.items
  }

  /** Liste vue par UN téléphone : seulement ce qui lui est destiné. */
  listForPhone(deviceId: string) {
    return this.items.filter((i) => this.visibleTo(i, deviceId)).map((i) => ({
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
      to: i.to,
    }))
  }

  private prune(): void {
    while (this.items.length > OUTBOX_MAX_ITEMS) {
      const item = this.items.pop()
      if (item?.filePath && item.filePath.startsWith(this.dir)) fs.unlink(item.filePath, () => {})
    }
  }
}
