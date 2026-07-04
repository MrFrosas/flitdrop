import { b64uToBytes, seal, sealJSON, openJSON, open, jti } from './wdcrypto.js'
import { initTelemetry, track, sizeBucket } from './telemetry.js'
import { t as tr, tp, rtf, fmtBytes, resolveLang, langFrom, type Lang } from '../i18n.js'
import { applyI18n } from '../i18n-dom.js'

const LANG_KEY = 'wd_lang'
let lang: Lang = resolveLang(localStorage.getItem(LANG_KEY) || undefined, langFrom(navigator.language))
// raccourcis liés à la langue courante
const t = (key: string, params?: Record<string, string | number>) => tr(lang, key, params)
const fmtSize = (bytes: number) => fmtBytes(lang, bytes)

interface Pairing {
  id: string
  keyB64: string
  // identité du PC appairé (épinglée) : on refuse de dialoguer avec un autre PC.
  instanceId?: string
}
interface HelloRes {
  desktopName: string
  maxFileMB: number
  chunkSize: number
  requireApproval: boolean
  instanceId?: string
  // clé de session renvoyée au 1er hello : remplace la clé (éphémère) du QR.
  newKey?: string
  telemetryConsent?: boolean
  hosts?: string[]
}
interface OutboxItem {
  id: string
  kind: 'text' | 'file'
  name?: string
  size?: number
  mime?: string
  text?: string
  createdAt: string
}

const PAIR_KEY = 'wd_pair'
const HOSTS_KEY = 'wd_hosts'
const SKIN_KEY = 'wd_skin'
const THEME_KEY = 'wd_theme'
const INSTALL_KEY = 'wd_install_seen'
// 8 Mo = taille de chunk du serveur (CHUNK_SIZE) : moitié moins d'allers-retours.
const SEND_CHUNK = 8 * 1024 * 1024
// nombre de chunks envoyés EN PARALLÈLE : sature le wifi au lieu d'attendre
// chaque accusé de réception (le débit passe de ~3 Mo/s à la vitesse de la ligne).
const SEND_WINDOW = 4

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let pair: Pairing | null = null
let key: Uint8Array | null = null
let hello: HelloRes | null = null
let pollTimer: number | null = null
let sending = false
const downloadedIds = new Set<string>()

// ---------- helpers ----------

const aad = (purpose: string, extra = '') => `wd1|${pair!.id}|${purpose}${extra ? '|' + extra : ''}`

function envelope(purpose: string, obj: Record<string, unknown>): string {
  return JSON.stringify({ p: sealJSON(key!, { ...obj, ts: Date.now(), jti: jti() }, aad(purpose)) })
}

class ApiFail extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(msg)
  }
}

/** Texte d'erreur localisé : le serveur renvoie un CODE stable, traduit ici. */
function errText(e: unknown): string {
  const f = e as ApiFail
  if (f?.code) return t('err.' + f.code)
  if (f?.message === 'Failed to fetch') return t('ph.send.lostRetry')
  return f?.message || t('err.generic', { status: f?.status ?? 0 })
}

async function post<T>(path: string, purpose: string, obj: Record<string, unknown>): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
    body: envelope(purpose, obj),
  })
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new ApiFail(j.code ? t('err.' + j.code) : t('err.generic', { status: r.status }), r.status, j.code)
  }
  const j = (await r.json()) as { p?: string }
  return (j.p ? openJSON(key!, j.p, aad(purpose + ':res')) : j) as T
}

function show(screen: 'scan' | 'error' | 'main') {
  for (const s of ['scan', 'error', 'main']) $(`screen-${s}`).classList.toggle('hidden', s !== screen)
}

let toastTimer: number | null = null
function toast(msg: string) {
  const t = $('toast')
  t.textContent = msg
  t.classList.remove('hidden')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 3200)
}

function copyText(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

function platformLabel(): { platform: string; label: string } {
  const ua = navigator.userAgent
  if (/iPhone|iPod/.test(ua)) return { platform: 'iphone', label: 'iPhone' }
  if (/iPad/.test(ua)) return { platform: 'ipad', label: 'iPad' }
  if (/Android/.test(ua)) {
    const m = ua.match(/Android[^;]*;\s*([^;)]+)[;)]/)
    const model = m?.[1]?.trim()
    return { platform: 'android', label: model && model.length <= 24 ? model : 'Android' }
  }
  return { platform: 'web', label: 'Téléphone' }
}

/** Adapte l'apparence au système du téléphone (Apple ou Android), sauf si
 *  l'utilisateur a forcé un style dans le menu. Chaque OS reçoit sa police
 *  système, ses couleurs et ses formes natives. */
function applyOsSkin() {
  const stored = localStorage.getItem(SKIN_KEY)
  const { platform } = platformLabel()
  const auto = platform === 'android' ? 'android' : 'apple'
  const os = stored === 'apple' || stored === 'android' ? stored : auto
  document.documentElement.setAttribute('data-os', os)
}

/** Thème clair/sombre : 'system' suit le téléphone, sinon on force. */
function applyPhoneTheme() {
  const t = localStorage.getItem(THEME_KEY)
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
  else document.documentElement.removeAttribute('data-theme')
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

/** Une fois appairé, on réécrit le manifeste PWA pour que l'icône « écran
 *  d'accueil » se relance déjà appairée : le token part dans le fragment (#),
 *  jamais envoyé au réseau. Sans ça, la PWA rouvrait sur l'écran de scan. */
function updateManifestForPairing() {
  if (!pair) return
  const frag = `${pair.id}.${pair.keyB64}${pair.instanceId ? '.' + pair.instanceId : ''}`
  const manifest = {
    name: 'Flitdrop',
    short_name: 'Flitdrop',
    id: '/s/',
    start_url: `${location.origin}/s/#${frag}`,
    scope: `${location.origin}/s/`,
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: `${location.origin}/assets/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${location.origin}/assets/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' })
  const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null
  if (link) link.href = URL.createObjectURL(blob)
}

// ---------- appairage ----------

/** Décode un token d'appairage « id.cléB64[.instanceId] » (clé et instanceId
 *  restent dans le fragment/local, jamais envoyés en clair au réseau). */
function parseToken(raw: string): Pairing | null {
  const parts = (raw || '').trim().replace(/^#/, '').split('.')
  const [id, keyB64, instanceId] = parts
  if (id && keyB64 && id.length >= 8 && keyB64.length >= 40) {
    return instanceId ? { id, keyB64, instanceId } : { id, keyB64 }
  }
  return null
}

function loadPairing(): Pairing | null {
  // le token peut arriver dans le fragment (#, après un scan QR) ou en query
  // (?k=, quand le raccourci PWA relance l'app depuis l'écran d'accueil).
  const incoming = parseToken(location.hash.slice(1)) || parseToken(new URLSearchParams(location.search).get('k') || '')
  if (incoming) {
    localStorage.setItem(PAIR_KEY, JSON.stringify(incoming))
    history.replaceState(null, '', location.pathname)
    return incoming
  }
  try {
    const stored = JSON.parse(localStorage.getItem(PAIR_KEY) || 'null') as Pairing | null
    if (stored?.id && stored?.keyB64) return stored
  } catch {
    // ignorer
  }
  return null
}

function forget() {
  localStorage.removeItem(PAIR_KEY)
  location.reload()
}

/** Adresses de secours connues (mémorisées au dernier hello réussi). */
function knownHosts(): string[] {
  try {
    const h = JSON.parse(localStorage.getItem(HOSTS_KEY) || '[]') as string[]
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string' && /^[\w.-]+(:\d+)?$/.test(x)) : []
  } catch {
    return []
  }
}

/** Si l'IP du PC a changé, proposer les autres adresses connues : un tap et la
 *  clé suit dans le fragment d'URL (jamais envoyée au réseau), zéro re-scan. */
function renderAltHosts() {
  const box = $('altHosts')
  box.innerHTML = ''
  const current = location.host
  const alts = knownHosts().filter((h) => h !== current)
  if (!pair || alts.length === 0) return box.classList.add('hidden')
  box.classList.remove('hidden')
  const title = document.createElement('p')
  title.className = 'hint'
  title.textContent = t('ph.altHint')
  box.appendChild(title)
  for (const h of alts.slice(0, 4)) {
    const a = document.createElement('a')
    a.className = 'btn wide'
    a.textContent = t('ph.reconnectVia', { host: h.split(':')[0] ?? h })
    a.href = `http://${h}/s/#${pair.id}.${pair.keyB64}${pair.instanceId ? '.' + pair.instanceId : ''}`
    box.appendChild(a)
  }
}

async function connect() {
  const { platform, label } = platformLabel()
  try {
    hello = await post<HelloRes>('/api/phone/hello', 'hello', { deviceLabel: label, platform })
    // épinglage du PC : si on connaît déjà l'identité appairée, elle doit
    // correspondre ; sinon un AUTRE PC répond à cette adresse (wifi partagé,
    // IP recyclée) et on refuse plutôt que de mélanger les données.
    if (hello.instanceId) {
      if (pair!.instanceId && pair!.instanceId !== hello.instanceId) {
        $('errTitle').textContent = t('ph.err.notThisPc')
        $('errMsg').textContent = t('ph.err.notThisPcMsg')
        $('altHosts').classList.add('hidden')
        show('error')
        return
      }
      if (!pair!.instanceId) {
        pair!.instanceId = hello.instanceId
        localStorage.setItem(PAIR_KEY, JSON.stringify(pair))
      }
    }
    // rotation de clé : au 1er appairage, le PC renvoie une clé de session (la
    // réponse a été déchiffrée avec la clé du QR) ; on l'adopte pour la suite,
    // rendant une éventuelle photo du QR inutilisable.
    if (hello.newKey && pair) {
      pair.keyB64 = hello.newKey
      key = b64uToBytes(hello.newKey)
      localStorage.setItem(PAIR_KEY, JSON.stringify(pair))
    }
    initTelemetry({ consent: hello.telemetryConsent === true, version: '' })
    track('phone_connect', { platform })
    $('pcName').textContent = hello.desktopName
    $('statusDot').classList.remove('off')
    $('menuInfo').textContent = t('ph.menuInfo', { name: hello.desktopName })
    if (hello.hosts?.length) {
      const merged = [location.host, ...hello.hosts].filter((v, i, arr) => arr.indexOf(v) === i)
      localStorage.setItem(HOSTS_KEY, JSON.stringify(merged.slice(0, 6)))
    }
    updateManifestForPairing()
    show('main')
    startPolling()
    maybeInstallBanner()
  } catch (e) {
    const err = e as ApiFail
    if (err.status === 409) {
      $('errTitle').textContent = t('ph.err.wrongPc')
      $('errMsg').textContent = t('ph.err.wrongPcMsg')
      $('altHosts').classList.add('hidden')
    } else if (err.status === 403) {
      $('errTitle').textContent = t('ph.err.revoked')
      $('errMsg').textContent = t('ph.err.revokedMsg')
      $('altHosts').classList.add('hidden')
    } else {
      $('errTitle').textContent = t('ph.err.notFound')
      $('errMsg').textContent = t('ph.err.notFoundMsg')
      renderAltHosts()
    }
    show('error')
  }
}

// ---------- envoi de fichiers ----------

interface QueueUI {
  li: HTMLLIElement
  bar: HTMLSpanElement
  state: HTMLElement
}

function queueItem(name: string, size: number): QueueUI {
  const li = document.createElement('li')
  li.className = 'qitem'
  li.innerHTML = `
    <div class="qhead">
      <div class="qicon">↑</div>
      <div class="qname"></div>
      <div class="qsize"></div>
    </div>
    <div class="qbar"><span></span></div>
    <div class="qstate">${t('ph.send.queued')}</div>`
  ;(li.querySelector('.qname') as HTMLElement).textContent = name
  ;(li.querySelector('.qsize') as HTMLElement).textContent = fmtSize(size)
  $('sendQueue').prepend(li)
  return { li, bar: li.querySelector('.qbar span') as HTMLSpanElement, state: li.querySelector('.qstate') as HTMLElement }
}

async function sendChunk(tid: string, n: number, sealed: Uint8Array): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`/api/phone/transfer/${tid}/chunk/${n}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': pair!.id },
        body: sealed as unknown as BodyInit,
      })
      if (r.ok) return
      const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string }
      throw new ApiFail(j.code ? t('err.' + j.code) : t('err.generic', { status: r.status }), r.status, j.code)
    } catch (e) {
      lastErr = e
      if (e instanceof ApiFail && e.status !== 429 && e.status < 500) throw e
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function transferStatus(tid: string): Promise<{ received: number; chunks: number; have?: number[] } | null> {
  const r = await fetch(`/api/phone/transfer/${tid}/status`, { headers: { 'x-wd-device': pair!.id } })
  if (!r.ok) return null
  return (await r.json()) as { received: number; chunks: number; have?: number[] }
}

async function sendFile(file: File): Promise<void> {
  const fallbackName = t('hist.file')
  const ui = queueItem(file.name || fallbackName, file.size)
  if (file.size === 0) {
    ui.li.classList.add('err')
    ui.state.textContent = t('ph.send.empty')
    return
  }
  const maxBytes = (hello?.maxFileMB ?? 8192) * 1024 * 1024
  if (file.size > maxBytes) {
    ui.li.classList.add('err')
    ui.state.textContent = t('ph.send.tooBig', { size: fmtSize(maxBytes) })
    return
  }
  const chunkSize = SEND_CHUNK
  const chunks = Math.ceil(file.size / chunkSize)
  try {
    const init = await post<{ transferId: string }>('/api/phone/transfer/init', 'init', {
      meta: { name: file.name || fallbackName, size: file.size, mime: file.type || undefined, chunkSize, chunks },
    })
    const tid = init.transferId
    const started = Date.now()
    const acked = new Set<number>()
    let sentBytes = 0
    let resumes = 0

    // envoie un chunk (sendChunk retente déjà 3× les erreurs transitoires)
    const sendOne = async (n: number) => {
      const slice = file.slice(n * chunkSize, Math.min((n + 1) * chunkSize, file.size))
      const plain = new Uint8Array(await slice.arrayBuffer())
      const sealed = seal(key!, plain, aad('chunk', `${tid}|${n}`))
      await sendChunk(tid, n, sealed)
      acked.add(n)
      sentBytes += plain.length
      const pct = Math.round((sentBytes / file.size) * 100)
      ui.bar.style.width = pct + '%'
      const speed = sentBytes / Math.max(0.4, (Date.now() - started) / 1000)
      ui.state.textContent = t('ph.send.progress', { pct, speed: fmtSize(speed) })
    }

    const isHard = (e: ApiFail) => !!e.status && e.status !== 429 && e.status < 500 && e.status !== 408

    // boucle reprennable : à chaque passe on lance SEND_WINDOW envois EN PARALLÈLE
    // (les workers se partagent la file des chunks restants) ; si le réseau coupe,
    // on resynchronise avec le PC (quels chunks lui manquent) et on repart, sans
    // jamais renvoyer ce qui est déjà arrivé.
    while (acked.size < chunks) {
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const n = cursor++
          if (n >= chunks) return
          if (!acked.has(n)) await sendOne(n)
        }
      }
      const results = await Promise.allSettled(Array.from({ length: Math.min(SEND_WINDOW, chunks) }, worker))
      const failures = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason as ApiFail)
      if (failures.length) {
        const hard = failures.find(isHard)
        if (hard) throw hard
        if (resumes >= 30) throw failures[0]
        resumes++
        ui.state.textContent = t('ph.send.lost')
        await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * resumes)))
        // reprendre à l'octet près : le PC nous dit quels chunks il a déjà
        const st = await transferStatus(tid).catch(() => null)
        if (st?.have) {
          acked.clear()
          sentBytes = 0
          for (const i of st.have) {
            acked.add(i)
            sentBytes += i === chunks - 1 ? file.size - (chunks - 1) * chunkSize : chunkSize
          }
        }
      }
    }
    await post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
    ui.bar.style.width = '100%'
    ui.li.classList.add('done')
    ui.state.textContent = t('ph.send.arrived', { name: hello?.desktopName ?? 'PC' })
    track('transfer_ok', { size: sizeBucket(file.size), resumes })
  } catch (e) {
    const err = e as ApiFail
    track('transfer_fail', { status: err.status ?? 0, reason: (err.code || err.message || '').slice(0, 40) })
    ui.li.classList.add('err')
    ui.state.textContent = err.code === 'refused' ? t('ph.send.refused') : errText(err)
  }
}

async function sendFiles(files: FileList | File[]) {
  if (sending) return
  sending = true
  $('btnPick').setAttribute('disabled', '')
  const list = [...files]
  const summary = $('sendSummary')
  summary.classList.remove('hidden')
  let done = 0
  for (const f of list) {
    summary.innerHTML = t('ph.send.sending', { a: done + 1, b: list.length })
    await sendFile(f)
    done++
  }
  summary.innerHTML = list.length > 1 ? t('ph.send.processed', { n: list.length }) : ''
  if (list.length === 1) summary.classList.add('hidden')
  sending = false
  $('btnPick').removeAttribute('disabled')
}

// ---------- réception ----------

function renderRecv(items: OutboxItem[]) {
  const list = $('recvList')
  const badge = $('recvBadge')
  const fresh = items.filter((i) => !downloadedIds.has(i.id))
  badge.textContent = String(fresh.length)
  badge.classList.toggle('hidden', fresh.length === 0)
  $('recvEmpty').classList.toggle('hidden', items.length > 0)
  list.innerHTML = ''
  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'qitem' + (downloadedIds.has(item.id) ? ' done' : '')
    if (item.kind === 'text') {
      li.innerHTML = `
        <div class="qhead"><div class="qicon">✂</div><div class="qname">${t('ph.recv.textFrom')}</div>
        <button class="qbtn">${t('ph.recv.copy')}</button></div>
        <div class="rtext"></div>`
      ;(li.querySelector('.rtext') as HTMLElement).textContent = item.text ?? ''
      ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = () => {
        const ok = copyText(item.text ?? '')
        downloadedIds.add(item.id)
        li.classList.add('done')
        toast(ok ? t('ph.recv.copied') : t('ph.recv.selectCopy'))
      }
    } else {
      li.innerHTML = `
        <div class="qhead"><div class="qicon">↓</div><div class="qname"></div><div class="qsize"></div>
        <button class="qbtn">${t('ph.recv.open')}</button></div>
        <div class="qbar hidden"><span></span></div>
        <div class="qstate hidden"></div>`
      ;(li.querySelector('.qname') as HTMLElement).textContent = item.name ?? t('hist.file')
      ;(li.querySelector('.qsize') as HTMLElement).textContent = fmtSize(item.size ?? 0)
      ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = () => downloadItem(item, li)
    }
    list.appendChild(li)
  }
}

async function downloadItem(item: OutboxItem, li: HTMLLIElement) {
  const bar = li.querySelector('.qbar') as HTMLElement
  const barFill = li.querySelector('.qbar span') as HTMLElement
  const state = li.querySelector('.qstate') as HTMLElement
  bar.classList.remove('hidden')
  state.classList.remove('hidden')
  state.textContent = t('ph.recv.downloading')
  try {
    const r = await fetch(`/api/phone/outbox/${item.id}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
      body: envelope('download', { itemId: item.id }),
    })
    if (!r.ok || !r.body) throw new Error(t('ph.recv.dlFailed'))
    const reader = r.body.getReader()
    // file de morceaux réseau : on ne recopie JAMAIS tout l'accumulateur (l'ancien
    // code était en O(n²) et ramait sur les gros fichiers). peek/take sont en O(n).
    const queue: Uint8Array[] = []
    let queued = 0
    const parts: Uint8Array[] = []
    let frameIndex = 0
    let received = 0
    const total = item.size ?? 0
    // lit la longueur (4 o) en tête sans consommer, même si elle chevauche 2 morceaux
    const peekLen = (): number | null => {
      if (queued < 4) return null
      const b = new Uint8Array(4)
      let filled = 0
      let qi = 0
      let off = 0
      while (filled < 4) {
        const head = queue[qi]!
        const t = Math.min(head.length - off, 4 - filled)
        b.set(head.subarray(off, off + t), filled)
        filled += t
        off += t
        if (off >= head.length) {
          qi++
          off = 0
        }
      }
      return new DataView(b.buffer).getUint32(0)
    }
    // consomme et renvoie n octets de la file
    const take = (n: number): Uint8Array => {
      const out = new Uint8Array(n)
      let filled = 0
      while (filled < n) {
        const head = queue[0]!
        const t = Math.min(head.length, n - filled)
        out.set(head.subarray(0, t), filled)
        filled += t
        if (t === head.length) queue.shift()
        else queue[0] = head.subarray(t)
        queued -= t
      }
      return out
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        queue.push(value)
        queued += value.length
        for (;;) {
          const len = peekLen()
          if (len === null || queued < 4 + len) break
          take(4)
          const sealed = take(len)
          const plain = open(key!, sealed, aad('dl', `${item.id}|${frameIndex}`))
          parts.push(plain)
          received += plain.length
          frameIndex++
          if (total > 0) {
            barFill.style.width = Math.round((received / total) * 100) + '%'
            state.textContent = `${Math.round((received / total) * 100)} %`
          }
        }
      }
      if (done) break
    }
    if (total > 0 && received !== total) throw new Error(t('ph.recv.incomplete'))
    const blob = new Blob(parts as BlobPart[], { type: item.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    downloadedIds.add(item.id)
    li.classList.add('done')
    state.textContent = t('ph.recv.done')
    if ((item.mime ?? '').startsWith('image/')) {
      const img = $('imgPreview') as HTMLImageElement
      img.src = url
      $('imgModal').classList.remove('hidden')
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = item.name ?? t('hist.file')
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast(t('ph.recv.fileDone'))
    }
  } catch (e) {
    state.textContent = (e as Error).message || t('ph.recv.dlFailed')
    li.classList.add('err')
  }
}

async function pollOutbox() {
  if (!hello || document.hidden) return
  try {
    const res = await post<{ items: OutboxItem[] }>('/api/phone/outbox', 'outbox', {})
    renderRecv(res.items)
    $('statusDot').classList.remove('off')
  } catch {
    $('statusDot').classList.add('off')
  }
}

function startPolling() {
  void pollOutbox()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void pollOutbox(), 6000)
}

// ---------- historique du presse-papiers (synchro depuis le PC) ----------

interface ClipEntry {
  id: string
  ts: string
  text: string
  kind: 'text' | 'image'
  source: string
  image?: { thumb: string; w: number; h: number }
}

let clipTimer: number | null = null

function renderClipHistory(items: ClipEntry[], enabled: boolean) {
  const list = $('clipList')
  $('clipDisabled').classList.toggle('hidden', enabled)
  $('clipEmpty').classList.toggle('hidden', !enabled || items.length > 0)
  list.innerHTML = ''
  if (!enabled) return
  for (const e of items) {
    const li = document.createElement('li')
    li.className = 'qitem'
    if (e.kind === 'image' && e.image) {
      li.innerHTML = `
        <div class="qhead">
          <img class="clip-thumb-img" alt="">
          <div class="qname"></div>
          <button class="qbtn">${t('ph.clip.receive')}</button>
        </div>`
      const thumb = li.querySelector('.clip-thumb-img') as HTMLImageElement
      thumb.src = e.image.thumb
      ;(li.querySelector('.qname') as HTMLElement).textContent = `${e.text} · ${rtf(lang, e.ts)}`
      thumb.onclick = () => {
        const img = $('imgPreview') as HTMLImageElement
        img.src = e.image!.thumb
        $('imgModal').classList.remove('hidden')
      }
      ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = async () => {
        try {
          await post(`/api/phone/cliphistory/${e.id}/tophone`, 'clip-tophone', { entryId: e.id })
          toast(t('ph.clip.imgAvailable'))
        } catch {
          toast(t('ph.clip.imgFailed'))
        }
      }
    } else {
      li.innerHTML = `
        <div class="qhead"><div class="qicon">≡</div><div class="qname"></div>
        <button class="qbtn">${t('ph.clip.copy')}</button></div>
        <div class="rtext"></div>`
      ;(li.querySelector('.qname') as HTMLElement).textContent = `${e.source === 'pc' ? t('ph.clip.copiedPc') : t('ph.clip.receivedFrom', { name: e.source })} · ${rtf(lang, e.ts)}`
      ;(li.querySelector('.rtext') as HTMLElement).textContent = e.text
      ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = () => {
        const ok = copyText(e.text)
        toast(ok ? t('ph.recv.copied') : t('ph.recv.selectCopy'))
      }
    }
    list.appendChild(li)
  }
}

async function pollClipHistory() {
  if (!hello || document.hidden) return
  try {
    const res = await post<{ items: ClipEntry[]; enabled: boolean }>('/api/phone/cliphistory', 'cliphistory', {})
    renderClipHistory(res.items, res.enabled)
  } catch {
    // silencieux : l'onglet « Recevoir » signale déjà l'état de connexion
  }
}

function startClipPolling() {
  void pollClipHistory()
  if (clipTimer) clearInterval(clipTimer)
  clipTimer = window.setInterval(() => void pollClipHistory(), 5000)
}

function stopClipPolling() {
  if (clipTimer) {
    clearInterval(clipTimer)
    clipTimer = null
  }
}

function maybeInstallBanner() {
  if (isStandalone() || localStorage.getItem(INSTALL_KEY) === '1') return
  $('installBanner')?.classList.remove('hidden')
}

// ---------- interactions ----------

function initUI() {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      const which = tab.dataset.tab
      for (const p of ['send', 'text', 'recv', 'clip']) $(`panel-${p}`).classList.toggle('hidden', p !== which)
      if (which === 'recv') void pollOutbox()
      if (which === 'clip') startClipPolling()
      else stopClipPolling()
    }
  }

  const picker = $('filepick') as unknown as HTMLInputElement
  $('btnPick').onclick = () => picker.click()
  picker.onchange = () => {
    if (picker.files?.length) void sendFiles(picker.files)
    picker.value = ''
  }

  const txt = $('txtInput') as unknown as HTMLTextAreaElement
  const updateTxtCount = () => {
    $('txtCount').textContent = tp(lang, 'ph.text.count', txt.value.length)
  }
  txt.oninput = updateTxtCount
  updateTxtCount()
  $('btnSendText').onclick = async () => {
    const value = txt.value.trim()
    if (!value) return
    const btn = $('btnSendText') as unknown as HTMLButtonElement
    btn.disabled = true
    btn.textContent = t('ph.text.sending')
    try {
      await post('/api/phone/text', 'text', { text: value, mode: 'clip' })
      btn.textContent = t('ph.text.done')
      txt.value = ''
      updateTxtCount()
      setTimeout(() => {
        btn.textContent = t('ph.text.btn')
        btn.disabled = false
      }, 2200)
    } catch (e) {
      btn.textContent = t('ph.text.btn')
      btn.disabled = false
      toast(errText(e))
    }
  }

  $('btnRetry').onclick = () => {
    show('scan')
    void connect()
  }
  $('btnForget').onclick = forget
  $('btnForget2').onclick = forget
  $('btnMenu').onclick = () => $('menuSheet').classList.remove('hidden')
  $('menuClose').onclick = () => $('menuSheet').classList.add('hidden')
  const openInstallSheet = () => {
    $('menuSheet').classList.add('hidden')
    $('installBanner')?.classList.add('hidden')
    const { platform } = platformLabel()
    $('installSteps').textContent =
      platform === 'iphone' || platform === 'ipad' ? t('ph.installSheet.ios') : t('ph.installSheet.android')
    $('installSheet').classList.remove('hidden')
  }
  $('btnInstall').onclick = openInstallSheet
  $('installClose').onclick = () => $('installSheet').classList.add('hidden')

  // bannière « ajouter à l'écran d'accueil » (affichée une fois après appairage)
  $('bannerInstall').onclick = openInstallSheet
  $('bannerClose').onclick = () => {
    localStorage.setItem(INSTALL_KEY, '1')
    $('installBanner').classList.add('hidden')
  }

  // apparence : style (Auto/Apple/Android) + thème (Système/Clair/Sombre)
  const skinSel = $('setPhoneSkin') as unknown as HTMLSelectElement
  skinSel.value = localStorage.getItem(SKIN_KEY) || 'auto'
  skinSel.onchange = () => {
    if (skinSel.value === 'auto') localStorage.removeItem(SKIN_KEY)
    else localStorage.setItem(SKIN_KEY, skinSel.value)
    applyOsSkin()
  }
  const themeSel = $('setPhoneTheme') as unknown as HTMLSelectElement
  themeSel.value = localStorage.getItem(THEME_KEY) || 'system'
  themeSel.onchange = () => {
    if (themeSel.value === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, themeSel.value)
    applyPhoneTheme()
  }
  // langue : Auto / Français / English, bascule en direct
  const langSel = $('setPhoneLang') as unknown as HTMLSelectElement
  langSel.value = localStorage.getItem(LANG_KEY) || 'auto'
  langSel.onchange = () => {
    if (langSel.value === 'auto') localStorage.removeItem(LANG_KEY)
    else localStorage.setItem(LANG_KEY, langSel.value)
    lang = resolveLang(localStorage.getItem(LANG_KEY) || undefined, langFrom(navigator.language))
    applyI18n(lang)
    updateTxtCount()
    if (hello) $('menuInfo').textContent = t('ph.menuInfo', { name: hello.desktopName })
  }

  // collage manuel d'un lien d'appairage : secours si on est bloqué dans la PWA
  // (écran d'accueil) sans pouvoir scanner de QR code.
  $('btnPastePair').onclick = () => {
    const raw = ($('pastePairInput') as unknown as HTMLInputElement).value
    const p = parseToken(raw)
    if (!p) {
      toast(t('ph.paste.invalid'))
      return
    }
    pair = p
    localStorage.setItem(PAIR_KEY, JSON.stringify(p))
    key = b64uToBytes(p.keyB64)
    show('scan')
    void connect()
  }
  $('btnCloseImg').onclick = () => {
    const img = $('imgPreview') as HTMLImageElement
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
    img.src = ''
    $('imgModal').classList.add('hidden')
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hello) void pollOutbox()
  })
}

// ---------- démarrage ----------

applyI18n(lang)
applyOsSkin()
applyPhoneTheme()
initUI()
pair = loadPairing()
if (!pair) {
  // relancée depuis l'écran d'accueil sans appairage mémorisé : on propose le
  // collage du lien plutôt que de laisser l'utilisateur bloqué sur le scan.
  if (isStandalone()) $('scanPaste')?.classList.remove('hidden')
  show('scan')
} else {
  key = b64uToBytes(pair.keyB64)
  void connect()
}
