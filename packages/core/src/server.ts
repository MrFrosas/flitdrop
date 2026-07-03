import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import QRCode from 'qrcode'

import {
  PRODUCT_NAME,
  VERSION,
  PROTOCOL_TAG,
  CHUNK_SIZE,
  MAX_CHUNK_BODY,
  MAX_TEXT_BYTES,
  PENDING_PAIRING_TTL_MS,
} from './constants.js'
import { loadConfig, saveConfig, flitdropHome, clampInt, type Config } from './config.js'
import { DeviceStore, type Device } from './pairing.js'
import { History } from './history.js'
import { Outbox } from './outbox.js'
import { Hub } from './events.js'
import { TransferManager, ApiError } from './transfers.js'
import { NonceCache, open, seal, openFreshJSON, sealJSON, randomToken } from './crypto.js'
import { readClipboard, writeClipboard } from './clip.js'
import { saveMultipartFiles } from './uploads.js'
import { b64u, isLoopback, localIPv4s, moduleDir, parseCookies, timingSafeEqualStr } from './util.js'

const PUBLIC_DIR = path.join(moduleDir(import.meta.url), '..', 'public')
const ADMIN_COOKIE = 'wd_admin'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

export interface StartOptions {
  port?: number
  home?: string
  quiet?: boolean
  disableClipboard?: boolean
}

export interface RunningServer {
  port: number
  adminToken: string
  cfg: Config
  home: string
  adminUrl: string
  close: () => Promise<void>
}

interface PhoneContext {
  dev: Device
  key: Uint8Array
  payload: Record<string, unknown>
}

function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>()
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket.remoteAddress ?? '?'
    const now = Date.now()
    if (hits.size > 2000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    }
    let h = hits.get(ip)
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + windowMs }
      hits.set(ip, h)
    }
    if (++h.n > max) return res.status(429).json({ error: 'trop de requêtes, réessaie dans une minute' })
    next()
  }
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  if (opts.disableClipboard) process.env.FLITDROP_NO_CLIP = '1'
  const home = flitdropHome(opts.home)
  const cfg = loadConfig(home)
  if (opts.port !== undefined) cfg.port = opts.port

  const devices = new DeviceStore(home)
  const history = new History(home)
  const outbox = new Outbox(home)
  const hub = new Hub()
  const nonces = new NonceCache()
  const transfers = new TransferManager(() => cfg, history, hub)

  // ---------- surveillance du presse-papiers du PC (sens PC -> téléphone) ----------
  // Le seul sens réellement automatisable côté PC : on lit notre propre presse-
  // papiers (aucune restriction OS pour ça) et, quand il change, on le met à
  // disposition des téléphones. `lastClip` sert d'anti-boucle : le texte reçu
  // d'un téléphone (qu'on colle dans le presse-papiers) ne doit pas être renvoyé.
  let lastClip = ''
  readClipboard().then((t) => (lastClip = t)).catch(() => {})
  const clipTimer = setInterval(async () => {
    if (!cfg.clipboardAutoPush) return
    const text = await readClipboard().catch(() => '')
    if (!text || text === lastClip || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return
    lastClip = text
    outbox.addText(text)
    hub.broadcast('outbox-changed', {})
    hub.broadcast('clip-autopushed', { preview: text.slice(0, 120) })
  }, 1500)
  clipTimer.unref?.()

  const pendingApprovals = new Map<string, (ok: boolean) => void>()
  transfers.approvalHook = (info) =>
    new Promise<boolean>((resolve) => {
      const id = randomToken(6)
      pendingApprovals.set(id, (ok) => {
        pendingApprovals.delete(id)
        resolve(ok)
      })
      hub.broadcast('approval-request', { id, ...info })
      setTimeout(() => {
        const cb = pendingApprovals.get(id)
        if (cb) {
          pendingApprovals.delete(id)
          hub.broadcast('approval-expired', { id })
          resolve(false)
        }
      }, 60_000).unref?.()
    })

  const aad = (deviceId: string, purpose: string, extra = '') =>
    `${PROTOCOL_TAG}|${deviceId}|${purpose}${extra ? '|' + extra : ''}`

  const app = express()
  app.disable('x-powered-by')

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', CSP)
    next()
  })

  // ---------- authentification ----------

  const adminOk = (req: Request): boolean => {
    const cookie = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
    const q = typeof req.query.k === 'string' ? req.query.k : ''
    const h = typeof req.headers['x-admin-token'] === 'string' ? (req.headers['x-admin-token'] as string) : ''
    const tok = q || h || cookie || ''
    return tok.length > 0 && timingSafeEqualStr(tok, cfg.adminToken)
  }

  const phoneAuth = (purpose: string) => (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    const key = dev ? devices.key(dev.id) : undefined
    if (!dev || !key) return res.status(403).json({ error: 'appareil inconnu ou révoqué' })
    try {
      const envelope = (req.body as { p?: unknown })?.p
      if (typeof envelope !== 'string') throw new Error('enveloppe manquante')
      const payload = openFreshJSON<Record<string, unknown>>(key, envelope, aad(dev.id, purpose), nonces)
      ;(req as Request & { wd: PhoneContext }).wd = { dev, key, payload }
      next()
    } catch {
      res.status(403).json({ error: 'authentification refusée' })
    }
  }

  const wd = (req: Request): PhoneContext => (req as Request & { wd: PhoneContext }).wd

  // ---------- pages ----------

  app.get('/', (_req, res) => res.redirect('/s/'))

  app.use(
    '/s',
    express.static(path.join(PUBLIC_DIR, 'phone'), {
      index: 'index.html',
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '7d' }))

  const desktopGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).send('Interface accessible depuis ce PC uniquement.')
    if (!adminOk(req)) return res.status(401).send(`${PRODUCT_NAME} : lien invalide. Relance l’application pour obtenir le bon lien.`)
    if (typeof req.query.k === 'string' && req.query.k.length > 0) {
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(cfg.adminToken)}; HttpOnly; SameSite=Strict; Path=/`)
    }
    next()
  }
  app.use(
    '/app',
    desktopGuard,
    express.static(path.join(PUBLIC_DIR, 'desktop'), {
      index: 'index.html',
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  // ---------- API téléphone (enveloppes chiffrées) ----------

  const jsonSmall = express.json({ limit: '256kb' })
  // texte en clair borné à MAX_TEXT_BYTES (1 Mo) ; +chiffrement +base64 +JSON => ~2 Mo
  const jsonText = express.json({ limit: '2mb' })

  // Garde montée AVANT tout body-parser : on refuse un appareil inconnu et on
  // limite le débit sans jamais bufferiser le corps d'un attaquant non appairé.
  const phoneRate = rateLimit(240, 60_000)
  app.use('/api/phone', phoneRate, (req, res, next) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    if (!id || !devices.get(id)) return res.status(403).json({ error: 'appareil inconnu ou révoqué' })
    next()
  })

  app.post('/api/phone/hello', jsonSmall, phoneAuth('hello'), (req, res) => {
    const { dev, key, payload } = wd(req)
    const wasPending = devices.activate(dev.id, {
      name: typeof payload.deviceLabel === 'string' ? payload.deviceLabel : undefined,
      platform: typeof payload.platform === 'string' ? payload.platform : undefined,
    })
    const fresh = devices.get(dev.id)
    if (wasPending) hub.broadcast('device-paired', { id: dev.id, name: fresh?.name, platform: fresh?.platform })
    else hub.broadcast('device-online', { id: dev.id, name: fresh?.name })
    res.json({
      p: sealJSON(
        key,
        {
          desktopName: cfg.deviceName,
          maxFileMB: cfg.maxFileMB,
          chunkSize: CHUNK_SIZE,
          requireApproval: cfg.requireApproval,
          product: PRODUCT_NAME,
          version: VERSION,
        },
        aad(dev.id, 'hello:res')
      ),
    })
  })

  app.post('/api/phone/transfer/init', jsonSmall, phoneAuth('init'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    try {
      const t = await transfers.init(dev, payload.meta as never)
      res.json({ p: sealJSON(key, { transferId: t.id }, aad(dev.id, 'init:res')) })
    } catch (e) {
      const err = e as ApiError
      res.status(err.code ?? 400).json({ error: err.message })
    }
  })

  app.post(
    '/api/phone/transfer/:tid/chunk/:n',
    // l'appareil est déjà vérifié par la garde montée sur /api/phone (avant tout
    // buffering) : on ne lit pas 8 Mo pour un inconnu.
    express.raw({ type: () => true, limit: MAX_CHUNK_BODY }),
    async (req, res) => {
      const id = String(req.headers['x-wd-device'] ?? '')
      const dev = id ? devices.get(id) : undefined
      const key = dev ? devices.key(dev.id) : undefined
      if (!dev || !key) return res.status(403).json({ error: 'appareil inconnu ou révoqué' })
      const t = transfers.get(String(req.params.tid))
      if (!t || t.deviceId !== dev.id) return res.status(404).json({ error: 'transfert introuvable' })
      const n = Number(req.params.n)
      if (!Number.isInteger(n) || n < 0 || n >= t.chunks) return res.status(400).json({ error: 'index invalide' })
      // ré-émission d'un chunk déjà écrit (reprise après coupure) : ack idempotent
      if (n < t.received) return res.json({ received: t.received })
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'corps manquant' })
      let plain: Uint8Array
      try {
        plain = open(key, new Uint8Array(req.body), aad(dev.id, 'chunk', `${t.id}|${n}`))
      } catch {
        return res.status(403).json({ error: 'chunk corrompu ou clé invalide' })
      }
      try {
        await transfers.writeChunk(t, n, plain)
        res.json({ received: t.received })
      } catch (e) {
        const err = e as ApiError
        res.status(err.code ?? 400).json({ error: err.message })
      }
    }
  )

  // Statut d'un transfert : le téléphone interroge « combien de morceaux
  // as-tu reçus ? » pour reprendre exactement là où la coupure a eu lieu,
  // au lieu de renvoyer tout le fichier.
  app.get('/api/phone/transfer/:tid/status', (req, res) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    if (!dev) return res.status(403).json({ error: 'appareil inconnu ou révoqué' })
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id) return res.status(404).json({ error: 'transfert introuvable' })
    res.json({ received: t.received, chunks: t.chunks, bytes: t.bytes, size: t.size })
  })

  app.post('/api/phone/transfer/:tid/finish', jsonSmall, phoneAuth('finish'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id || payload.transferId !== t.id)
      return res.status(404).json({ error: 'transfert introuvable' })
    try {
      const finalPath = await transfers.finish(t)
      devices.touch(dev.id)
      res.json({ p: sealJSON(key, { ok: true, name: path.basename(finalPath) }, aad(dev.id, 'finish:res')) })
    } catch (e) {
      const err = e as ApiError
      res.status(err.code ?? 400).json({ error: err.message })
    }
  })

  app.post('/api/phone/text', jsonText, phoneAuth('text'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
      return res.status(400).json({ error: 'texte vide ou trop long' })
    const mode = payload.mode === 'message' ? 'message' : 'clip'
    let copied = false
    if (mode === 'clip') {
      copied = await writeClipboard(text).then(
        () => true,
        () => false
      )
      // anti-écho : ce texte vient du téléphone, le surveilleur ne doit pas le renvoyer
      if (copied) lastClip = text
    }
    history.add({
      dir: 'in',
      kind: mode === 'clip' ? 'clip' : 'text',
      preview: text.slice(0, 160),
      deviceId: dev.id,
      deviceName: dev.name,
      status: 'ok',
    })
    hub.broadcast('text-received', {
      deviceName: dev.name,
      mode,
      copied,
      text: text.length <= 32_000 ? text : text.slice(0, 32_000),
    })
    devices.touch(dev.id)
    res.json({ p: sealJSON(key, { ok: true, copied }, aad(dev.id, 'text:res')) })
  })

  app.post('/api/phone/outbox', jsonSmall, phoneAuth('outbox'), (req, res) => {
    const { dev, key } = wd(req)
    devices.touch(dev.id)
    res.json({
      p: sealJSON(key, { desktopName: cfg.deviceName, items: outbox.listForPhone() }, aad(dev.id, 'outbox:res')),
    })
  })

  app.post('/api/phone/outbox/:id/download', jsonSmall, phoneAuth('download'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const item = outbox.get(String(req.params.id))
    if (!item || payload.itemId !== item.id) return res.status(404).json({ error: 'élément introuvable' })
    if (item.kind !== 'file' || !item.filePath) return res.status(400).json({ error: 'pas un fichier' })
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(item.filePath, { highWaterMark: 4 * 1024 * 1024 })
    } catch {
      return res.status(410).json({ error: 'fichier plus disponible' })
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    // si le client se déconnecte (téléphone qui quitte le wifi, onglet fermé),
    // on détruit le flux disque immédiatement : sinon fuite de descripteur.
    let aborted = false
    const onClose = () => {
      aborted = true
      stream.destroy()
    }
    res.once('close', onClose)
    let index = 0
    try {
      for await (const chunk of stream) {
        if (aborted || res.writableEnded) break
        const sealed = seal(key, chunk as Buffer, aad(dev.id, 'dl', `${item.id}|${index}`))
        const len = Buffer.alloc(4)
        len.writeUInt32BE(sealed.length, 0)
        const okWrite = res.write(Buffer.concat([len, Buffer.from(sealed)]))
        if (!okWrite) {
          // attendre le drain, mais débloquer si la connexion se ferme
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
          })
        }
        index++
      }
      if (aborted) return
      res.end()
      outbox.markDownloaded(item.id, dev.id)
      history.add({
        dir: 'out',
        kind: 'file',
        name: item.name,
        size: item.size,
        deviceId: dev.id,
        deviceName: dev.name,
        status: 'ok',
      })
      hub.broadcast('outbox-downloaded', { itemId: item.id, name: item.name, deviceName: dev.name })
    } catch {
      if (!res.writableEnded) res.destroy()
    } finally {
      res.off('close', onClose)
      stream.destroy()
    }
  })

  // ---------- API Raccourci iOS (jeton simple, voir docs/raccourci-ios.md) ----------

  const rlShortcut = rateLimit(120, 60_000)

  const shortcutDevice = (req: Request): Device | undefined => {
    const token = String(req.query.t ?? '')
    if (token.length < 10) return undefined
    return devices.byShortcutToken(token)
  }

  app.post('/api/shortcut/upload', rlShortcut, async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send('Jeton invalide. Re-scanne le QR code Flitdrop sur ton PC.')
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    try {
      const saved = await saveMultipartFiles(req, cfg.downloadDir, cfg.maxFileMB * 1024 * 1024)
      if (saved.length === 0) return res.status(400).type('text/plain; charset=utf-8').send('Aucun fichier reçu.')
      for (const f of saved) {
        history.add({
          dir: 'in',
          kind: 'file',
          name: f.name,
          size: f.size,
          deviceId: dev.id,
          deviceName: dev.name,
          status: 'ok',
          path: f.path,
        })
        hub.broadcast('transfer-done', { id: randomToken(6), name: f.name, size: f.size, path: f.path, deviceName: dev.name })
      }
      devices.touch(dev.id)
      const total = saved.length
      res
        .type('text/plain; charset=utf-8')
        .send(total === 1 ? `« ${saved[0]?.name} » est arrivé sur ${cfg.deviceName} ✅` : `${total} fichiers sont arrivés sur ${cfg.deviceName} ✅`)
    } catch (e) {
      const err = e as Error & { code?: number }
      res.status(err.code === 413 ? 413 : 400).type('text/plain; charset=utf-8').send(
        err.code === 413 ? `Fichier trop volumineux (limite ${cfg.maxFileMB} Mo).` : 'Échec de la réception.'
      )
    }
  })

  app.post('/api/shortcut/text', rlShortcut, express.text({ limit: '1mb', type: () => true }), async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send('Jeton invalide.')
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) return res.status(400).type('text/plain; charset=utf-8').send('Rien à copier.')
    const copied = await writeClipboard(text).then(
      () => true,
      () => false
    )
    history.add({ dir: 'in', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    hub.broadcast('text-received', { deviceName: dev.name, mode: 'clip', copied, text: text.slice(0, 32_000) })
    devices.touch(dev.id)
    res.type('text/plain; charset=utf-8').send(`Copié sur ${cfg.deviceName} ✅`)
  })

  app.get('/api/shortcut/clipboard', rlShortcut, async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send('Jeton invalide.')
    const text = await readClipboard().catch(() => '')
    history.add({ dir: 'out', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    devices.touch(dev.id)
    res.type('text/plain; charset=utf-8').send(text)
  })

  // ---------- API admin (interface du PC, loopback uniquement) ----------

  const admin = express.Router()
  admin.use((req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ error: 'accès local uniquement' })
    if (!adminOk(req)) return res.status(401).json({ error: 'non autorisé' })
    next()
  })

  let actualPort = cfg.port
  const bestIp = () => localIPv4s()[0]
  const pairUrl = (d: Device) => `http://${bestIp() ?? '127.0.0.1'}:${actualPort}/s/#${d.id}.${d.keyB64}`

  admin.get('/state', (_req, res) => {
    res.json({
      product: PRODUCT_NAME,
      version: VERSION,
      config: {
        deviceName: cfg.deviceName,
        downloadDir: cfg.downloadDir,
        maxFileMB: cfg.maxFileMB,
        requireApproval: cfg.requireApproval,
        clipboardAutoPush: cfg.clipboardAutoPush,
        port: actualPort,
      },
      hostname: os.hostname(),
      ips: localIPv4s(),
      devices: devices.listPublic(),
      history: history.list(),
      outbox: outbox.listAdmin(),
    })
  })

  admin.post('/pair/new', (_req, res) => {
    devices.prunePending(PENDING_PAIRING_TTL_MS)
    const d = devices.create()
    res.json({ deviceId: d.id, url: pairUrl(d) })
  })

  admin.get('/pair/:id/qr.svg', async (req, res) => {
    const d = devices.get(String(req.params.id))
    if (!d || d.status !== 'pending') return res.status(404).json({ error: 'appairage introuvable' })
    const svg = await QRCode.toString(pairUrl(d), {
      type: 'svg',
      margin: 1,
      width: 560,
      errorCorrectionLevel: 'M',
      color: { dark: '#0d1220ff', light: '#ffffffff' },
    })
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-store')
    res.send(svg)
  })

  admin.post('/device/:id/rename', jsonSmall, (req, res) => {
    const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name : ''
    if (!name.trim()) return res.status(400).json({ error: 'nom vide' })
    if (!devices.rename(String(req.params.id), name.trim())) return res.status(404).json({ error: 'appareil introuvable' })
    res.json({ ok: true })
  })

  admin.post('/device/:id/revoke', (req, res) => {
    if (!devices.revoke(String(req.params.id))) return res.status(404).json({ error: 'appareil introuvable' })
    hub.broadcast('device-revoked', { id: String(req.params.id) })
    res.json({ ok: true })
  })

  admin.post('/outbox/text', jsonText, (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return res.status(400).json({ error: 'texte vide ou trop long' })
    const item = outbox.addText(text)
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, id: item.id })
  })

  admin.post('/outbox/file', async (req, res) => {
    try {
      const saved = await saveMultipartFiles(req, outbox.dir, cfg.maxFileMB * 1024 * 1024)
      const items = saved.map((f) => outbox.addFile(f.name, f.path, f.size, f.mime))
      hub.broadcast('outbox-changed', {})
      res.json({ ok: true, ids: items.map((i) => i.id) })
    } catch (e) {
      const err = e as Error & { code?: number }
      res.status(err.code === 413 ? 413 : 400).json({ error: err.message })
    }
  })

  admin.post('/outbox/:id/remove', (req, res) => {
    if (!outbox.remove(String(req.params.id))) return res.status(404).json({ error: 'élément introuvable' })
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true })
  })

  admin.post('/clipboard/push', async (_req, res) => {
    const text = await readClipboard().catch(() => '')
    if (!text) return res.status(400).json({ error: 'presse-papiers vide' })
    const item = outbox.addText(text.slice(0, MAX_TEXT_BYTES))
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, id: item.id, preview: text.slice(0, 120) })
  })

  admin.post('/open-folder', (_req, res) => {
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    spawn(cmd, [cfg.downloadDir], { detached: true, stdio: 'ignore' }).unref()
    res.json({ ok: true })
  })

  admin.post('/approve', jsonSmall, (req, res) => {
    const body = req.body as { id?: unknown; accept?: unknown }
    const cb = typeof body.id === 'string' ? pendingApprovals.get(body.id) : undefined
    if (!cb) return res.status(404).json({ error: 'demande expirée' })
    cb(body.accept === true)
    res.json({ ok: true })
  })

  admin.post('/settings', jsonSmall, (req, res) => {
    const body = req.body as Partial<Config>
    if (typeof body.deviceName === 'string' && body.deviceName.trim()) cfg.deviceName = body.deviceName.trim().slice(0, 40)
    if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
      const dir = body.downloadDir.trim()
      if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'chemin de dossier invalide' })
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        return res.status(400).json({ error: 'impossible de créer ce dossier' })
      }
      cfg.downloadDir = dir
    }
    if (body.maxFileMB !== undefined) cfg.maxFileMB = clampInt(body.maxFileMB, 1, 128 * 1024, cfg.maxFileMB)
    if (typeof body.requireApproval === 'boolean') cfg.requireApproval = body.requireApproval
    if (typeof body.clipboardAutoPush === 'boolean') {
      cfg.clipboardAutoPush = body.clipboardAutoPush
      // en (ré)activant, on prend l'état courant comme référence pour ne pas
      // pousser d'un coup le contenu déjà présent dans le presse-papiers.
      if (cfg.clipboardAutoPush) readClipboard().then((t) => (lastClip = t)).catch(() => {})
    }
    saveConfig(home, cfg)
    hub.broadcast('settings-changed', {})
    res.json({ ok: true })
  })

  app.use('/api/admin', admin)

  // ---------- erreurs ----------

  app.use((_req, res) => res.status(404).json({ error: 'introuvable' }))
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.destroy()
    res.status(err.status ?? 500).json({ error: err.status ? err.message : 'erreur interne' })
  })

  // ---------- HTTP + WebSocket ----------

  const server = http.createServer(app)
  server.maxRequestsPerSocket = 0
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    let ok = false
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const cookieTok = parseCookies(req.headers.cookie)[ADMIN_COOKIE] ?? ''
      const qTok = url.searchParams.get('k') ?? ''
      ok =
        isLoopback((socket as import('node:net').Socket).remoteAddress) &&
        url.pathname === '/ws/ui' &&
        [qTok, cookieTok].some((t) => t.length > 0 && timingSafeEqualStr(t, cfg.adminToken))
    } catch {
      ok = false
    }
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.add(ws))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '0.0.0.0', () => resolve())
  })
  actualPort = (server.address() as AddressInfo).port

  const adminUrl = `http://127.0.0.1:${actualPort}/app/?k=${encodeURIComponent(cfg.adminToken)}`

  return {
    port: actualPort,
    adminToken: cfg.adminToken,
    cfg,
    home,
    adminUrl,
    close: async () => {
      clearInterval(clipTimer)
      await transfers.closeAll()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
