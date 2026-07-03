import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import type { Device } from './pairing.js'
import { History } from './history.js'
import { Hub } from './events.js'
import { randomToken } from './crypto.js'
import { sanitizeFilename, reserveUniquePath } from './util.js'
import {
  CHUNK_SIZE,
  MAX_ACTIVE_TRANSFERS_PER_DEVICE,
  TRANSFER_IDLE_TIMEOUT_MS,
} from './constants.js'

export interface TransferMeta {
  name: string
  size: number
  mime?: string
  chunks: number
  chunkSize: number
}

export interface Transfer {
  id: string
  deviceId: string
  deviceName: string
  name: string
  size: number
  mime?: string
  chunks: number
  chunkSize: number
  received: number
  bytes: number
  tmpPath: string
  status: 'active' | 'done' | 'error'
  startedAt: number
  lastActivity: number
  historyId: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code = 400
  ) {
    super(message)
  }
}

export class TransferManager {
  private active = new Map<string, Transfer>()
  private handles = new Map<string, fs.promises.FileHandle>()
  private lastProgressPush = new Map<string, number>()
  /** Posé par le serveur quand la validation manuelle est activée. */
  approvalHook: ((info: { deviceName: string; name: string; size: number }) => Promise<boolean>) | null = null

  constructor(
    private getCfg: () => Config,
    private history: History,
    private hub: Hub
  ) {
    const timer = setInterval(() => this.sweep(), 60_000)
    timer.unref?.()
  }

  async init(device: Device, meta: TransferMeta): Promise<Transfer> {
    const cfg = this.getCfg()
    const size = Number(meta?.size)
    const chunkSize = Number(meta?.chunkSize)
    const chunks = Number(meta?.chunks)
    if (!Number.isInteger(size) || size <= 0) throw new ApiError('taille invalide')
    if (size > cfg.maxFileMB * 1024 * 1024) throw new ApiError(`fichier trop volumineux (limite ${cfg.maxFileMB} Mo)`, 413)
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > CHUNK_SIZE) throw new ApiError('chunkSize invalide')
    if (!Number.isInteger(chunks) || chunks !== Math.ceil(size / chunkSize)) throw new ApiError('découpage incohérent')

    let concurrent = 0
    for (const t of this.active.values()) if (t.deviceId === device.id && t.status === 'active') concurrent++
    if (concurrent >= MAX_ACTIVE_TRANSFERS_PER_DEVICE) throw new ApiError('trop de transferts simultanés', 429)

    const name = sanitizeFilename(meta?.name)

    if (cfg.requireApproval && this.approvalHook) {
      const ok = await this.approvalHook({ deviceName: device.name, name, size })
      if (!ok) throw new ApiError('transfert refusé sur le PC', 403)
    }

    const tmpDir = path.join(cfg.downloadDir, '.tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    const id = randomToken(9)
    const tmpPath = path.join(tmpDir, `${id}.part`)
    const handle = await fs.promises.open(tmpPath, 'w')

    const entry = this.history.add({
      dir: 'in',
      kind: 'file',
      name,
      size,
      deviceId: device.id,
      deviceName: device.name,
      status: 'progress',
    })

    const t: Transfer = {
      id,
      deviceId: device.id,
      deviceName: device.name,
      name,
      size,
      mime: typeof meta?.mime === 'string' ? meta.mime.slice(0, 100) : undefined,
      chunks,
      chunkSize,
      received: 0,
      bytes: 0,
      tmpPath,
      status: 'active',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      historyId: entry.id,
    }
    this.active.set(id, t)
    this.handles.set(id, handle)
    this.hub.broadcast('transfer-start', {
      id,
      name,
      size,
      deviceName: device.name,
    })
    return t
  }

  get(id: string): Transfer | undefined {
    return this.active.get(id)
  }

  async writeChunk(t: Transfer, index: number, plain: Uint8Array): Promise<void> {
    if (t.status !== 'active') throw new ApiError('transfert terminé')
    if (index !== t.received) throw new ApiError('ordre de chunks invalide')
    if (plain.length > t.chunkSize) throw new ApiError('chunk trop grand')
    if (t.bytes + plain.length > t.size) throw new ApiError('dépassement de la taille annoncée')
    const handle = this.handles.get(t.id)
    if (!handle) throw new ApiError('transfert introuvable', 404)
    try {
      await handle.write(plain, 0, plain.length, t.bytes)
    } catch (e) {
      await this.abort(t, 'erreur d’écriture disque')
      throw new ApiError('erreur d’écriture disque', 500)
    }
    t.bytes += plain.length
    t.received++
    t.lastActivity = Date.now()

    const last = this.lastProgressPush.get(t.id) ?? 0
    if (Date.now() - last > 400 || t.received === t.chunks) {
      this.lastProgressPush.set(t.id, Date.now())
      this.hub.broadcast('transfer-progress', { id: t.id, bytes: t.bytes, size: t.size })
    }
  }

  async finish(t: Transfer): Promise<string> {
    if (t.status !== 'active') throw new ApiError('transfert terminé')
    if (t.received !== t.chunks || t.bytes !== t.size) throw new ApiError('transfert incomplet')
    const handle = this.handles.get(t.id)
    if (handle) {
      await handle.sync().catch(() => {})
      await handle.close()
      this.handles.delete(t.id)
    }
    const cfg = this.getCfg()
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    // réservation atomique du nom final, puis on écrase le placeholder par le
    // fichier temp : deux transferts du même nom n'écrasent jamais le fichier
    // de l'autre (chacun obtient « nom », « nom (2) »…).
    const reserved = reserveUniquePath(cfg.downloadDir, t.name)
    fs.closeSync(reserved.fd)
    const finalPath = reserved.path
    await fs.promises.rename(t.tmpPath, finalPath)
    t.status = 'done'
    this.active.delete(t.id)
    this.lastProgressPush.delete(t.id)
    this.history.update(t.historyId, { status: 'ok', path: finalPath, name: path.basename(finalPath) })
    this.hub.broadcast('transfer-done', {
      id: t.id,
      name: path.basename(finalPath),
      size: t.size,
      path: finalPath,
      deviceName: t.deviceName,
    })
    return finalPath
  }

  async abort(t: Transfer, reason: string): Promise<void> {
    if (t.status !== 'active') return
    t.status = 'error'
    const handle = this.handles.get(t.id)
    if (handle) {
      await handle.close().catch(() => {})
      this.handles.delete(t.id)
    }
    fs.unlink(t.tmpPath, () => {})
    this.active.delete(t.id)
    this.lastProgressPush.delete(t.id)
    this.history.update(t.historyId, { status: 'error', error: reason })
    this.hub.broadcast('transfer-error', { id: t.id, name: t.name, reason })
  }

  private sweep(): void {
    const now = Date.now()
    for (const t of [...this.active.values()]) {
      if (now - t.lastActivity > TRANSFER_IDLE_TIMEOUT_MS) void this.abort(t, 'transfert expiré (inactivité)')
    }
  }

  async closeAll(): Promise<void> {
    for (const t of [...this.active.values()]) await this.abort(t, 'arrêt du serveur')
  }
}
