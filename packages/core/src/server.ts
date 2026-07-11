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
  DEVICE_MAX_IDLE_MS,
} from './constants.js'
import { loadConfig, saveConfig, flitdropHome, clampInt, type Config } from './config.js'
import { DeviceStore, type Device } from './pairing.js'
import { History } from './history.js'
import { Outbox } from './outbox.js'
import { Hub } from './events.js'
import { TransferManager, ApiError } from './transfers.js'
import { NonceCache, open, seal, openFreshJSON, sealJSON, randomToken } from './crypto.js'
import { readClipboard, writeClipboard } from './clip.js'
import { ClipHistory } from './cliphistory.js'
import { saveMultipartFiles } from './uploads.js'
import { t as tr, resolveLang, langFrom, acceptLang } from './i18n.js'
import {
  b64u,
  isLoopback,
  localIPv4s,
  moduleDir,
  parseCookies,
  reserveUniquePath,
  sanitizeFilename,
  timingSafeEqualStr,
} from './util.js'

// ré-exporté pour l'app Electron (main.cjs) : tray, notifications, dialogue.
export { t, resolveLang, langFrom } from './i18n.js'

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

// Variante pour la page du PC (loopback + jeton) : autorise les miniatures https
// des aperçus de liens dans l'historique du presse-papiers.
const CSP_ADMIN = CSP.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https:")

export interface StartOptions {
  port?: number
  home?: string
  quiet?: boolean
  disableClipboard?: boolean
  // fourni par l'app de bureau (Electron) pour recopier une image de
  // l'historique dans le presse-papiers du système.
  writeImageToClipboard?: (png: Buffer) => void
}

export interface RunningServer {
  port: number
  adminToken: string
  cfg: Config
  home: string
  adminUrl: string
  /** Met des fichiers locaux à disposition des téléphones (clic-droit
   *  « Envoyer vers », glisser sur l'icône, ligne de commande). */
  addLocalFiles: (paths: string[]) => Promise<number>
  /** Enregistre une image copiée sur le PC dans l'historique du presse-papiers
   *  (appelé par l'app de bureau qui lit l'image via Electron). */
  addClipboardImage: (png: Buffer, thumb: string, w: number, h: number) => void
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
    if (++h.n > max) return res.status(429).json({ code: 'rateLimited' })
    next()
  }
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  if (opts.disableClipboard) process.env.FLITDROP_NO_CLIP = '1'
  const home = flitdropHome(opts.home)
  const cfg = loadConfig(home)
  if (opts.port !== undefined) cfg.port = opts.port

  const devices = new DeviceStore(home)
  // hygiène au démarrage : on oublie les appairages inactifs de longue date
  devices.pruneIdle(DEVICE_MAX_IDLE_MS)
  const history = new History(home)
  const outbox = new Outbox(home)
  const hub = new Hub()
  const nonces = new NonceCache()
  const transfers = new TransferManager(() => cfg, history, hub)
  const clipHistory = new ClipHistory(home)

  // ---------- surveillance du presse-papiers du PC ----------
  // Le seul sens réellement automatisable côté PC : on lit notre propre presse-
  // papiers (aucune restriction OS pour ça). Quand il change : on l'enregistre
  // dans l'historique local (si activé) et on le met à disposition des
  // téléphones (si la synchro est activée). `lastClip` sert d'anti-boucle : le
  // texte reçu d'un téléphone ne doit pas être renvoyé.
  let lastClip = ''
  // pour les images : l'app de bureau pousse les images copiées via
  // addClipboardImage. `lastImageHash` évite de ré-enregistrer une image qu'on
  // vient de recopier soi-même depuis l'historique.
  let lastImageHash = ''
  const imageHash = (png: Buffer): string => `${png.length}:${png.length > 64 ? png.subarray(0, 64).toString('hex') : png.toString('hex')}`
  readClipboard().then((t) => (lastClip = t)).catch(() => {})
  const clipTimer = setInterval(async () => {
    if (!cfg.clipboardAutoPush && !cfg.clipHistoryEnabled) return
    const text = await readClipboard().catch(() => '')
    if (!text || text === lastClip || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return
    lastClip = text
    if (cfg.clipHistoryEnabled && clipHistory.add(text, 'pc', cfg)) {
      hub.broadcast('cliphistory-changed', {})
    }
    if (cfg.clipboardAutoPush) {
      outbox.addText(text)
      hub.broadcast('outbox-changed', {})
      hub.broadcast('clip-autopushed', { preview: text.slice(0, 120) })
    }
  }, 1500)
  clipTimer.unref?.()
  // purge périodique de l'historique (rétention par âge)
  const clipPurgeTimer = setInterval(() => {
    if (clipHistory.size() > 0) clipHistory.purge(cfg)
  }, 10 * 60 * 1000)
  clipPurgeTimer.unref?.()
  // expire les QR d'appairage non scannés (fenêtre d'exploitation d'une photo
  // du QR minimale, indépendamment des clics sur « Appairer »)
  const pendingTimer = setInterval(() => devices.prunePending(PENDING_PAIRING_TTL_MS), 60 * 1000)
  pendingTimer.unref?.()

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

  // Langue des réponses en clair (Raccourci iOS, garde admin) : le réglage du PC,
  // sinon la langue de l'appareil/navigateur qui appelle. Les erreurs de l'API
  // JSON, elles, sont renvoyées en CODES et traduites côté client.
  const reqLang = (req: Request) => resolveLang(cfg.lang, acceptLang(req.headers['accept-language']))
  const st = (req: Request, key: string, params?: Record<string, string | number>) => tr(reqLang(req), key, params)

  const app = express()
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // La page du PC (loopback + jeton) affiche des miniatures d'aperçu de liens
    // (YouTube, images) dans l'historique du presse-papiers : on autorise donc
    // les images https, mais seulement là. La page téléphone reste stricte.
    res.setHeader('Content-Security-Policy', req.path.startsWith('/app') ? CSP_ADMIN : CSP)
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
    if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
    const envelope = (req.body as { p?: unknown })?.p
    if (typeof envelope !== 'string') return res.status(403).json({ code: 'authRefused' })
    // essaie la clé courante puis la clé de session en attente (fenêtre de
    // rotation) ; si c'est celle en attente qui ouvre, on la promeut (preuve
    // que le téléphone l'a bien adoptée) et on abandonne l'ancienne.
    for (const cand of devices.candidateKeys(dev.id)) {
      try {
        const payload = openFreshJSON<Record<string, unknown>>(cand.key, envelope, aad(dev.id, purpose), nonces)
        if (cand.pending) devices.promoteKey(dev.id)
        ;(req as Request & { wd: PhoneContext }).wd = { dev, key: cand.key, payload }
        return next()
      } catch {
        // clé suivante
      }
    }
    res.status(403).json({ code: 'authRefused' })
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
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).send(st(req, 'srv.loopbackOnly'))
    if (!adminOk(req)) return res.status(401).send(st(req, 'srv.adminBadLink'))
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
    const dev = id ? devices.get(id) : undefined
    if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
    // liaison au PC : un appairage créé sur une autre machine (instanceId
    // différent) est refusé, même s'il se présente sur le même wifi.
    if (dev.instanceId && dev.instanceId !== cfg.instanceId)
      return res.status(409).json({ code: 'wrongPc' })
    next()
  })

  app.post('/api/phone/hello', jsonSmall, phoneAuth('hello'), (req, res) => {
    const { dev, key, payload } = wd(req)
    const wasPending = devices.activate(dev.id, {
      name: typeof payload.deviceLabel === 'string' ? payload.deviceLabel : undefined,
      platform: typeof payload.platform === 'string' ? payload.platform : undefined,
    })
    // Au TOUT PREMIER hello on démarre une rotation « make-before-break » : une
    // clé de session est générée EN ATTENTE (l'ancienne reste valide) et renvoyée
    // chiffrée sous l'ancienne (`key`, que le téléphone possède). On la re-renvoie
    // à chaque hello tant qu'elle n'est pas confirmée : ainsi une réponse perdue
    // ne bloque jamais le téléphone, et une photo du QR cesse de valoir dès que le
    // vrai téléphone confirme (1re requête sous la nouvelle clé -> promotion).
    if (wasPending) devices.beginRotation(dev.id)
    const rotatedKey = devices.pendingKey(dev.id)
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
          // identité de CE PC : le téléphone l'épingle et refuse de dialoguer
          // avec un autre PC qui répondrait à la même adresse (wifi partagé).
          instanceId: cfg.instanceId,
          // clé de session (présente seulement au 1er hello) : le téléphone
          // remplace la clé du QR par celle-ci pour la suite.
          newKey: rotatedKey,
          telemetryConsent: cfg.telemetryConsent,
          // adresses de secours : si l'IP du PC change, la page sait où le
          // retrouver sans re-scanner le QR code.
          hosts: [
            ...localIPv4s().map((ip) => `${ip}:${actualPort}`),
            `${os.hostname().split('.')[0]}.local:${actualPort}`,
          ],
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
      res.status(err.code ?? 400).json({ code: err.key ?? 'internal' })
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
      if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
      const t = transfers.get(String(req.params.tid))
      if (!t || t.deviceId !== dev.id) return res.status(404).json({ code: 'transferNotFound' })
      const n = Number(req.params.n)
      if (!Number.isInteger(n) || n < 0 || n >= t.chunks) return res.status(400).json({ code: 'badIndex' })
      // ré-émission d'un chunk déjà écrit (reprise / envoi parallèle) : ack idempotent
      if (t.have.has(n)) return res.json({ received: t.received })
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'missingBody' })
      // même déchiffrement double-clé que phoneAuth (fenêtre de rotation).
      // req.body (Buffer) EST déjà un Uint8Array : pas de copie inutile de 8 Mo.
      let plain: Uint8Array | undefined
      for (const cand of devices.candidateKeys(dev.id)) {
        try {
          plain = open(cand.key, req.body, aad(dev.id, 'chunk', `${t.id}|${n}`))
          if (cand.pending) devices.promoteKey(dev.id)
          break
        } catch {
          // clé suivante
        }
      }
      if (!plain) return res.status(403).json({ code: 'badChunk' })
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
    if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id) return res.status(404).json({ code: 'transferNotFound' })
    // `have` = indices déjà reçus : le téléphone reprend en ne renvoyant QUE ce
    // qui manque (envoi parallèle, reprise après coupure), à l'octet près.
    res.json({ received: t.received, chunks: t.chunks, bytes: t.bytes, size: t.size, have: [...t.have] })
  })

  app.post('/api/phone/transfer/:tid/finish', jsonSmall, phoneAuth('finish'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id || payload.transferId !== t.id)
      return res.status(404).json({ code: 'transferNotFound' })
    try {
      const finalPath = await transfers.finish(t)
      devices.touch(dev.id)
      res.json({ p: sealJSON(key, { ok: true, name: path.basename(finalPath) }, aad(dev.id, 'finish:res')) })
    } catch (e) {
      const err = e as ApiError
      res.status(err.code ?? 400).json({ code: err.key ?? 'internal' })
    }
  })

  app.post('/api/phone/text', jsonText, phoneAuth('text'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
      return res.status(400).json({ code: 'textEmpty' })
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
    if (cfg.clipHistoryEnabled && clipHistory.add(text, dev.name, cfg)) {
      hub.broadcast('cliphistory-changed', {})
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

  // Historique du presse-papiers du PC, servi (chiffré) au téléphone appairé :
  // c'est ce qui fait la vraie synchro. La liaison instanceId garantit que seuls
  // TES appareils voient TON presse-papiers. Les miniatures suffisent à l'aperçu ;
  // le chemin disque n'est jamais exposé (clipHistory.list le retire déjà).
  app.post('/api/phone/cliphistory', jsonSmall, phoneAuth('cliphistory'), (req, res) => {
    const { dev, key } = wd(req)
    devices.touch(dev.id)
    res.json({
      p: sealJSON(
        key,
        { enabled: cfg.clipHistoryEnabled, items: cfg.clipHistoryEnabled ? clipHistory.list(200) : [] },
        aad(dev.id, 'cliphistory:res')
      ),
    })
  })

  // Envoie une entrée d'historique vers le téléphone (texte -> presse-papiers du
  // téléphone côté client ; image -> file d'attente pour la récupérer en fichier).
  app.post('/api/phone/cliphistory/:id/tophone', jsonSmall, phoneAuth('clip-tophone'), (req, res) => {
    const { dev, key, payload } = wd(req)
    const entry = clipHistory.get(String(req.params.id))
    if (!entry || payload.entryId !== entry.id) return res.status(404).json({ code: 'entryNotFound' })
    if (entry.kind === 'image' && entry.image) {
      const reserved = reserveUniquePath(outbox.dir, `image-${entry.id}.png`)
      fs.closeSync(reserved.fd)
      try {
        fs.copyFileSync(entry.image.path, reserved.path)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
      const st = fs.statSync(reserved.path)
      outbox.addFile(path.basename(reserved.path), reserved.path, st.size, 'image/png')
      hub.broadcast('outbox-changed', {})
    }
    res.json({ p: sealJSON(key, { ok: true, kind: entry.kind }, aad(dev.id, 'clip-tophone:res')) })
  })

  app.post('/api/phone/outbox/:id/download', jsonSmall, phoneAuth('download'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const item = outbox.get(String(req.params.id))
    if (!item || payload.itemId !== item.id) return res.status(404).json({ code: 'itemNotFound' })
    if (item.kind !== 'file' || !item.filePath) return res.status(400).json({ code: 'notAFile' })
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(item.filePath, { highWaterMark: 4 * 1024 * 1024 })
    } catch {
      return res.status(410).json({ code: 'fileGone' })
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
        // deux écritures (entête + charge) : évite un Buffer.concat/copie par frame
        res.write(len)
        const okWrite = res.write(sealed)
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

  const rlShortcut = rateLimit(60, 60_000)

  // Le partage par Raccourci est pratique mais NON chiffré (jeton et contenu en
  // clair sur le réseau). On peut le couper : sur un wifi public non fiable, ou
  // si on n'utilise pas cette fonctionnalité.
  app.use('/api/shortcut', (req, res, next) => {
    if (!cfg.shortcutsEnabled)
      return res.status(403).type('text/plain; charset=utf-8').send(st(req, 'srv.shortcutOff'))
    next()
  })

  const shortcutDevice = (req: Request): Device | undefined => {
    const token = String(req.query.t ?? '')
    if (token.length < 10) return undefined
    const dev = devices.byShortcutToken(token)
    // même liaison que l'API téléphone : un token lié à un autre PC est ignoré.
    if (dev && dev.instanceId && dev.instanceId !== cfg.instanceId) return undefined
    return dev
  }

  app.post('/api/shortcut/upload', rlShortcut, async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    try {
      const saved = await saveMultipartFiles(req, cfg.downloadDir, cfg.maxFileMB * 1024 * 1024)
      if (saved.length === 0) return res.status(400).type('text/plain; charset=utf-8').send(st(req, 'srv.scNoFile'))
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
        .send(total === 1 ? st(req, 'srv.scArrivedOne', { name: saved[0]?.name ?? '', pc: cfg.deviceName }) : st(req, 'srv.scArrivedMany', { n: total, pc: cfg.deviceName }))
    } catch (e) {
      const err = e as Error & { code?: number }
      res.status(err.code === 413 ? 413 : 400).type('text/plain; charset=utf-8').send(
        err.code === 413 ? st(req, 'srv.scTooBig', { mb: cfg.maxFileMB }) : st(req, 'srv.scFailed')
      )
    }
  })

  app.post('/api/shortcut/text', rlShortcut, express.text({ limit: '1mb', type: () => true }), async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) return res.status(400).type('text/plain; charset=utf-8').send(st(req, 'srv.scNothing'))
    const copied = await writeClipboard(text).then(
      () => true,
      () => false
    )
    history.add({ dir: 'in', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    hub.broadcast('text-received', { deviceName: dev.name, mode: 'clip', copied, text: text.slice(0, 32_000) })
    devices.touch(dev.id)
    res.type('text/plain; charset=utf-8').send(st(req, 'srv.scCopied', { pc: cfg.deviceName }))
  })

  app.get('/api/shortcut/clipboard', rlShortcut, async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    const text = await readClipboard().catch(() => '')
    history.add({ dir: 'out', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    devices.touch(dev.id)
    res.type('text/plain; charset=utf-8').send(text)
  })

  // ---------- API admin (interface du PC, loopback uniquement) ----------

  const admin = express.Router()
  admin.use((req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ code: 'localOnly' })
    if (!adminOk(req)) return res.status(401).json({ code: 'unauthorized' })
    next()
  })

  let actualPort = cfg.port
  const bestIp = () => localIPv4s()[0]
  // la clé et l'instanceId voyagent dans le FRAGMENT (#), jamais envoyé au réseau
  const pairUrl = (d: Device) => `http://${bestIp() ?? '127.0.0.1'}:${actualPort}/s/#${d.id}.${d.keyB64}.${cfg.instanceId}`

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
        clipHistoryEnabled: cfg.clipHistoryEnabled,
        clipHistoryMaxItems: cfg.clipHistoryMaxItems,
        clipHistoryMaxDays: cfg.clipHistoryMaxDays,
        theme: cfg.theme,
        skin: cfg.skin,
        lang: cfg.lang,
        shortcutsEnabled: cfg.shortcutsEnabled,
        autoUpdate: cfg.autoUpdate,
        telemetryConsent: cfg.telemetryConsent,
        port: actualPort,
      },
      hostname: os.hostname(),
      ips: localIPv4s(),
      devices: devices.listPublic(),
      history: history.list(),
      outbox: outbox.listAdmin(),
      clipHistory: clipHistory.list(),
    })
  })

  // ---------- historique du presse-papiers ----------

  admin.post('/cliphistory/:id/copy', async (req, res) => {
    const entry = clipHistory.get(String(req.params.id))
    if (!entry) return res.status(404).json({ code: 'entryNotFound' })
    if (entry.kind === 'image' && entry.image) {
      if (!opts.writeImageToClipboard) return res.status(400).json({ code: 'imgCopyUnavailable' })
      try {
        const png = fs.readFileSync(entry.image.path)
        opts.writeImageToClipboard(png)
        lastImageHash = imageHash(png)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
    } else {
      const ok = await writeClipboard(entry.text).then(
        () => true,
        () => false
      )
      if (!ok) return res.status(500).json({ code: 'clipWriteFailed' })
      lastClip = entry.text
    }
    clipHistory.bump(entry.id)
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/:id/tophone', (req, res) => {
    const entry = clipHistory.get(String(req.params.id))
    if (!entry) return res.status(404).json({ code: 'entryNotFound' })
    if (entry.kind === 'image' && entry.image) {
      const reserved = reserveUniquePath(outbox.dir, `image-${entry.id}.png`)
      fs.closeSync(reserved.fd)
      try {
        fs.copyFileSync(entry.image.path, reserved.path)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
      const st = fs.statSync(reserved.path)
      outbox.addFile(path.basename(reserved.path), reserved.path, st.size, 'image/png')
    } else {
      outbox.addText(entry.text)
    }
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/:id/remove', (req, res) => {
    if (!clipHistory.remove(String(req.params.id))) return res.status(404).json({ code: 'entryNotFound' })
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/clear', (_req, res) => {
    clipHistory.clear()
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  // « Réinitialiser ce PC » : oublie tous les appareils appairés, vide
  // l'historique du presse-papiers, la file d'envoi et l'historique des
  // transferts, puis fait tourner l'instanceId (invalide définitivement tout
  // appairage restant). Pratique quand on prête / revend la machine.
  admin.post('/reset', (_req, res) => {
    const removed = devices.clear()
    clipHistory.clear()
    outbox.clearAll()
    history.clear()
    cfg.instanceId = randomToken(12)
    saveConfig(home, cfg)
    hub.broadcast('device-revoked', { id: 'all' })
    hub.broadcast('cliphistory-changed', {})
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, removed })
  })

  admin.post('/pair/new', (_req, res) => {
    devices.prunePending(PENDING_PAIRING_TTL_MS)
    const d = devices.create(cfg.instanceId)
    res.json({ deviceId: d.id, url: pairUrl(d) })
  })

  admin.get('/pair/:id/qr.svg', async (req, res) => {
    const d = devices.get(String(req.params.id))
    if (!d || d.status !== 'pending') return res.status(404).json({ code: 'pairingNotFound' })
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
    if (!name.trim()) return res.status(400).json({ code: 'emptyName' })
    if (!devices.rename(String(req.params.id), name.trim())) return res.status(404).json({ code: 'deviceNotFound' })
    res.json({ ok: true })
  })

  admin.post('/device/:id/revoke', (req, res) => {
    if (!devices.revoke(String(req.params.id))) return res.status(404).json({ code: 'deviceNotFound' })
    hub.broadcast('device-revoked', { id: String(req.params.id) })
    res.json({ ok: true })
  })

  admin.post('/outbox/text', jsonText, (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return res.status(400).json({ code: 'textEmpty' })
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
      res.status(err.code === 413 ? 413 : 400).json({ code: err.code === 413 ? 'tooBig' : 'internal' })
    }
  })

  admin.post('/outbox/:id/remove', (req, res) => {
    if (!outbox.remove(String(req.params.id))) return res.status(404).json({ code: 'itemNotFound' })
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true })
  })

  admin.post('/clipboard/push', async (_req, res) => {
    const text = await readClipboard().catch(() => '')
    if (!text) return res.status(400).json({ code: 'clipboardEmpty' })
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

  admin.post('/open-url', jsonSmall, (req, res) => {
    const url = typeof (req.body as { url?: unknown })?.url === 'string' ? (req.body as { url: string }).url.trim() : ''
    // uniquement http(s) : on n'ouvre pas file:, javascript:, etc.
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) return res.status(400).json({ code: 'badLink' })
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    // le lien est passé en argument unique, jamais interprété par un shell
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
    res.json({ ok: true })
  })

  admin.post('/approve', jsonSmall, (req, res) => {
    const body = req.body as { id?: unknown; accept?: unknown }
    const cb = typeof body.id === 'string' ? pendingApprovals.get(body.id) : undefined
    if (!cb) return res.status(404).json({ code: 'requestExpired' })
    cb(body.accept === true)
    res.json({ ok: true })
  })

  admin.post('/settings', jsonSmall, (req, res) => {
    const body = req.body as Partial<Config>
    if (typeof body.deviceName === 'string' && body.deviceName.trim()) cfg.deviceName = body.deviceName.trim().slice(0, 40)
    if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
      const dir = body.downloadDir.trim()
      if (!path.isAbsolute(dir)) return res.status(400).json({ code: 'badFolderPath' })
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        return res.status(400).json({ code: 'cannotCreateFolder' })
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
    if (typeof body.clipHistoryEnabled === 'boolean') {
      cfg.clipHistoryEnabled = body.clipHistoryEnabled
      if (cfg.clipHistoryEnabled) readClipboard().then((t) => (lastClip = t)).catch(() => {})
    }
    if (body.clipHistoryMaxItems !== undefined) {
      cfg.clipHistoryMaxItems = clampInt(body.clipHistoryMaxItems, 10, 1000, cfg.clipHistoryMaxItems)
      clipHistory.purge(cfg)
    }
    if (body.clipHistoryMaxDays !== undefined) {
      cfg.clipHistoryMaxDays = clampInt(body.clipHistoryMaxDays, 1, 90, cfg.clipHistoryMaxDays)
      clipHistory.purge(cfg)
    }
    if (body.theme === 'system' || body.theme === 'light' || body.theme === 'dark') cfg.theme = body.theme
    if (body.skin === 'auto' || body.skin === 'apple' || body.skin === 'windows') cfg.skin = body.skin
    if (body.lang === 'auto' || body.lang === 'fr' || body.lang === 'en' || body.lang === 'de') cfg.lang = body.lang
    if (typeof body.shortcutsEnabled === 'boolean') cfg.shortcutsEnabled = body.shortcutsEnabled
    if (typeof body.autoUpdate === 'boolean') cfg.autoUpdate = body.autoUpdate
    if (typeof body.telemetryConsent === 'boolean') cfg.telemetryConsent = body.telemetryConsent
    saveConfig(home, cfg)
    hub.broadcast('settings-changed', {})
    res.json({ ok: true })
  })

  app.use('/api/admin', admin)

  // ---------- erreurs ----------

  app.use((_req, res) => res.status(404).json({ code: 'notFound' }))
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.destroy()
    res.status(err.status ?? 500).json({ code: 'internal' })
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

  // Écoute sur le port voulu, mais si un autre logiciel l'occupe déjà, on bascule
  // sur un port libre choisi par le système plutôt que de planter. L'app de
  // bureau et le CLI lisent le port réel, donc c'est transparent.
  const listenOn = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })

  try {
    await listenOn(cfg.port)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (!opts.quiet) console.warn(`Port ${cfg.port} occupé, bascule sur un port libre.`)
      await listenOn(0)
    } else {
      throw e
    }
  }
  actualPort = (server.address() as AddressInfo).port

  const adminUrl = `http://127.0.0.1:${actualPort}/app/?k=${encodeURIComponent(cfg.adminToken)}`

  const addLocalFiles = async (paths: string[]): Promise<number> => {
    let added = 0
    for (const p of paths) {
      try {
        const st = await fs.promises.stat(p)
        if (!st.isFile()) continue
        if (st.size > cfg.maxFileMB * 1024 * 1024) continue
        const safe = sanitizeFilename(path.basename(p))
        const reserved = reserveUniquePath(outbox.dir, safe)
        fs.closeSync(reserved.fd)
        await fs.promises.copyFile(p, reserved.path)
        outbox.addFile(path.basename(reserved.path), reserved.path, st.size)
        added++
      } catch {
        // fichier illisible : on passe au suivant
      }
    }
    if (added > 0) hub.broadcast('outbox-changed', {})
    return added
  }

  const addClipboardImage = (png: Buffer, thumb: string, w: number, h: number): void => {
    if (!cfg.clipHistoryEnabled || !png || png.length === 0) return
    const hash = imageHash(png)
    if (hash === lastImageHash) return // image qu'on vient de recopier soi-même
    lastImageHash = hash
    const entry = clipHistory.addImage(png, thumb, w, h, 'pc', cfg)
    if (entry) hub.broadcast('cliphistory-changed', {})
  }

  return {
    port: actualPort,
    adminToken: cfg.adminToken,
    cfg,
    home,
    adminUrl,
    addLocalFiles,
    addClipboardImage,
    close: async () => {
      clearInterval(clipTimer)
      clearInterval(clipPurgeTimer)
      clearInterval(pendingTimer)
      await transfers.closeAll()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
