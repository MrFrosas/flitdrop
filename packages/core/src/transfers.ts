import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import type { Device } from './pairing.js'
import { History } from './history.js'
import { Hub } from './events.js'
import { randomToken } from './crypto.js'
import type { TransferActivity } from './activity.js'
import { sanitizeFilename, reserveUniquePath } from './util.js'
import {
  CHUNK_SIZE,
  MAX_ACTIVE_TRANSFERS_PER_DEVICE,
  TRANSFER_IDLE_TIMEOUT_MS,
} from './constants.js'

// morceaux qu'un téléphone envoie à la fois (SEND_WINDOW de la page) : borne
// des octets en route comptés dans la progression
const MAX_INFLIGHT_CHUNKS = 4

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
  /** octets de morceaux en cours de réception (pas encore écrits) : la page
   *  du PC montre la progression et la vitesse sans attendre 8 Mo complets */
  inflight?: number
  /** adresses d'où au moins un morceau de ce transfert a été accepté
   *  (déchiffré) : seuls leurs octets en route comptent dans la progression,
   *  un corps forgé par un autre appareil du wifi ne fait rien bouger */
  trustedFrom?: Set<string>
  /** indices déjà écrits : permet un envoi PARALLÈLE (hors ordre) tout en
   *  restant idempotent et vérifiable à la reprise. */
  have: Set<number>
  tmpPath: string
  status: 'active' | 'done' | 'error'
  startedAt: number
  lastActivity: number
  historyId: string
  // statistiques : dernier code d'erreur vu (raison de l'échec si le transfert
  // expire ensuite) et échec déjà compté (un transfert = un seul échec compté).
  lastErrorKey?: string
  lastErrorStatus?: number
  failCounted?: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code = 400,
    // clé d'erreur stable, localisée côté client (i18n).
    readonly key = 'internal'
  ) {
    super(message)
  }
}

export class TransferManager {
  private active = new Map<string, Transfer>()
  private handles = new Map<string, fs.promises.FileHandle>()
  private lastProgressPush = new Map<string, number>()
  private lastProgressBytes = new Map<string, number>()
  /** Posé par le serveur quand la validation manuelle est activée. */
  approvalHook: ((info: { deviceName: string; name: string; size: number }) => Promise<boolean>) | null = null
  /** Posé par le serveur : un transfert a échoué (statistiques anonymes). */
  failureHook: ((t: Transfer, status: number, reason: string) => void) | null = null

  constructor(
    private getCfg: () => Config,
    private history: History,
    private hub: Hub,
    // activité des transferts (PC gardé éveillé, progression sur l'icône)
    private activity?: TransferActivity
  ) {
    const timer = setInterval(() => this.sweep(), 60_000)
    timer.unref?.()
  }

  async init(device: Device, meta: TransferMeta): Promise<Transfer> {
    const cfg = this.getCfg()
    const size = Number(meta?.size)
    const chunkSize = Number(meta?.chunkSize)
    const chunks = Number(meta?.chunks)
    if (!Number.isInteger(size) || size <= 0) throw new ApiError('taille invalide', 400, 'badSize')
    if (size > cfg.maxFileMB * 1024 * 1024) throw new ApiError(`fichier trop volumineux (limite ${cfg.maxFileMB} Mo)`, 413, 'tooBig')
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > CHUNK_SIZE) throw new ApiError('chunkSize invalide', 400, 'badChunkSize')
    if (!Number.isInteger(chunks) || chunks !== Math.ceil(size / chunkSize)) throw new ApiError('découpage incohérent', 400, 'badSplit')

    let concurrent = 0
    for (const t of this.active.values()) if (t.deviceId === device.id && t.status === 'active') concurrent++
    if (concurrent >= MAX_ACTIVE_TRANSFERS_PER_DEVICE) throw new ApiError('trop de transferts simultanés', 429, 'tooManyTransfers')

    const name = sanitizeFilename(meta?.name)

    if (cfg.requireApproval && this.approvalHook) {
      const ok = await this.approvalHook({ deviceName: device.name, name, size })
      if (!ok) throw new ApiError('transfert refusé sur le PC', 403, 'refused')
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
      have: new Set<number>(),
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

  /** Longueur EXACTE attendue pour un chunk donné (le dernier est plus court).
   *  On la vérifie strictement : empêche un chunk qui déborde/chevauche un autre
   *  et toute triche sur la taille annoncée. */
  private expectedLen(t: Transfer, index: number): number {
    return index === t.chunks - 1 ? t.size - (t.chunks - 1) * t.chunkSize : t.chunkSize
  }

  /** `settle` est appelé juste avant que les octets du morceau comptent dans
   *  t.bytes (même tour de boucle) : ses octets en route sont retirés au même
   *  moment, la progression n'est jamais comptée deux fois ni en recul. */
  async writeChunk(t: Transfer, index: number, plain: Uint8Array, settle?: () => void): Promise<void> {
    if (t.status !== 'active') throw new ApiError('transfert terminé', 400, 'transferDone')
    if (!Number.isInteger(index) || index < 0 || index >= t.chunks) throw new ApiError('index invalide', 400, 'badIndex')
    // idempotent : un chunk déjà écrit (reprise, réémission) est acquitté sans réécriture
    if (t.have.has(index)) return
    if (plain.length !== this.expectedLen(t, index)) throw new ApiError('taille de chunk invalide', 400, 'badChunkSize')
    const handle = this.handles.get(t.id)
    if (!handle) throw new ApiError('transfert introuvable', 404, 'transferNotFound')
    // RÉSERVATION avant tout await : ferme la fenêtre TOCTOU. Une 2e requête
    // concurrente du même index (réémission, reprise) verra have.has(index)=true
    // et sortira tout de suite -> les octets ne sont comptés qu'UNE fois, sinon
    // t.bytes dépasserait t.size et finish() échouerait à jamais.
    t.have.add(index)
    try {
      // écriture POSITIONNELLE à l'offset du chunk : les chunks peuvent arriver
      // dans n'importe quel ordre (envoi parallèle), chacun à sa place.
      await handle.write(plain, 0, plain.length, index * t.chunkSize)
    } catch (e) {
      t.have.delete(index) // rollback : cet index n'a pas été écrit
      await this.abort(t, 'erreur d’écriture disque', 'diskWrite', 500)
      throw new ApiError('erreur d’écriture disque', 500, 'diskWrite')
    }
    settle?.()
    t.bytes += plain.length
    t.received = t.have.size
    t.lastActivity = Date.now()
    this.activity?.update(`up:${t.id}`, t.bytes, t.size)
    this.pushProgress(t, t.received === t.chunks)
  }

  /** Octets d'un morceau qui arrivent (positif) ou qui ne comptent plus
   *  (négatif : morceau écrit, refusé ou coupé). Renvoie ce qui a vraiment
   *  été compté : jamais plus que les morceaux qu'un téléphone envoie à la
   *  fois, ni plus que ce qui manque au fichier. */
  noteInflight(t: Transfer, delta: number): number {
    const cur = t.inflight ?? 0
    const cap = Math.min(MAX_INFLIGHT_CHUNKS * t.chunkSize, Math.max(0, t.size - t.bytes))
    const applied = delta > 0 ? Math.max(0, Math.min(delta, cap - cur)) : Math.max(-cur, delta)
    t.inflight = cur + applied
    if (applied > 0 && t.status === 'active') this.pushProgress(t, false)
    return applied
  }

  private pushProgress(t: Transfer, force: boolean) {
    const last = this.lastProgressPush.get(t.id) ?? 0
    if (!force && Date.now() - last <= 400) return
    this.lastProgressPush.set(t.id, Date.now())
    // jamais en recul : un morceau coupé en route retire ses octets, la barre
    // attend simplement que le vrai total la rattrape (sinon le PC effaçait sa
    // vitesse et sa barre reculait)
    const bytes = Math.max(this.lastProgressBytes.get(t.id) ?? 0, Math.min(t.size, t.bytes + (t.inflight ?? 0)))
    this.lastProgressBytes.set(t.id, bytes)
    this.hub.broadcast('transfer-progress', { id: t.id, bytes, size: t.size })
  }

  async finish(t: Transfer): Promise<string> {
    if (t.status !== 'active') throw new ApiError('transfert terminé', 400, 'transferDone')
    if (t.received !== t.chunks || t.bytes !== t.size) throw new ApiError('transfert incomplet', 400, 'transferIncomplete')
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
    this.lastProgressBytes.delete(t.id)
    this.activity?.end(`up:${t.id}`)
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

  /** Compte l'échec d'un transfert UNE seule fois, quel que soit le chemin
   *  (erreur au finish, puis expiration, par exemple). */
  reportFailure(t: Transfer, status: number, reason: string): void {
    if (t.failCounted) return
    t.failCounted = true
    try {
      this.failureHook?.(t, status, reason)
    } catch {
      // statistiques non critiques
    }
  }

  async abort(t: Transfer, reason: string, key?: string, status = 0): Promise<void> {
    if (t.status !== 'active') return
    t.status = 'error'
    // l'arrêt de l'app n'est pas un échec de transfert
    if (key !== 'shutdown') this.reportFailure(t, status || t.lastErrorStatus || 0, key ?? t.lastErrorKey ?? 'aborted')
    const handle = this.handles.get(t.id)
    if (handle) {
      await handle.close().catch(() => {})
      this.handles.delete(t.id)
    }
    fs.unlink(t.tmpPath, () => {})
    this.active.delete(t.id)
    this.lastProgressPush.delete(t.id)
    this.lastProgressBytes.delete(t.id)
    this.activity?.end(`up:${t.id}`)
    this.history.update(t.historyId, { status: 'error', error: reason })
    this.hub.broadcast('transfer-error', { id: t.id, name: t.name, reason })
  }

  private sweep(): void {
    const now = Date.now()
    for (const t of [...this.active.values()]) {
      if (now - t.lastActivity > TRANSFER_IDLE_TIMEOUT_MS)
        void this.abort(t, 'transfert expiré (inactivité)', t.lastErrorKey ?? 'expired', t.lastErrorStatus ?? 408)
    }
  }

  async closeAll(): Promise<void> {
    for (const t of [...this.active.values()]) await this.abort(t, 'arrêt du serveur', 'shutdown')
  }
}
