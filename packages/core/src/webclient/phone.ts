import { b64uToBytes, seal, sealJSON, openJSON, open, jti } from './wdcrypto.js'
import { t as tr, tp, rtf, fmtBytes, resolveLang, langFrom, type Lang } from '../i18n.js'
import { applyI18n } from '../i18n-dom.js'
import { KeyedNodes, VersionedList, reconcile } from './lists.js'
import { afterExpiredCode, connectError, shouldSuggestInstall } from './onboarding.js'
import { CryptoPool, CryptoAuthError, type WorkerLike } from './cryptopool.js'
import { SpeedMeter, progressText } from './speed.js'
import { speedVerdict } from './speedverdict.js'
import { runPass, afterFailure, type Lanes } from './sendpass.js'
import type { PcLink } from '../wifi.js'

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
  hosts?: string[]
  // fonctions de ce PC (absent d'un PC plus ancien) : 'speedtest'
  features?: string[]
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
// un premier transfert a réussi depuis ce téléphone (l'icône d'accueil n'est
// proposée qu'après), et le bouton d'envoi a déjà été mis en avant une fois
const FIRST_OK_KEY = 'wd_first_ok'
const SEND_HINT_KEY = 'wd_send_hint'
// 8 Mo = taille de chunk du serveur (CHUNK_SIZE) : moitié moins d'allers-retours.
const SEND_CHUNK = 8 * 1024 * 1024
// nombre de chunks envoyés EN PARALLÈLE : sature le wifi au lieu d'attendre
// chaque accusé de réception (le débit passe de ~3 Mo/s à la vitesse de la ligne).
// Réduit à la volée quand le lien lâche (voir sendFile), rétabli ensuite.
const SEND_WINDOW = 4
// morceaux reçus du PC en cours de déchiffrement en même temps (4 Mo chacun)
const DL_INFLIGHT = 5
// le fichier reçu est rangé par tranches : la mémoire des morceaux est rendue
const DL_BLOB_BATCH = 64 * 1024 * 1024

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// Chiffrement des morceaux dans des Web Workers (WebAssembly), plusieurs à la
// fois, hors du fil de la page : sur iPhone, Safari exécute la page HTTP sans
// JIT et le chiffrement en JavaScript y plafonnait à 1-3 Mo/s en gelant
// l'écran. Même format exact : le PC ne voit aucune différence. Si les
// Workers ne démarrent pas, la page chiffre elle-même, comme avant.
const pool = new CryptoPool({
  create: () => {
    if (typeof Worker !== 'function') throw new Error('Worker indisponible')
    return new Worker('/s/cw.js') as unknown as WorkerLike
  },
  // iPhone : 6 coeurs (Safari en annonce parfois moins) ; ailleurs selon l'appareil
  size: Math.min(4, Math.max(isIOS() ? 4 : 2, navigator.hardwareConcurrency || 2)),
  fallback: { seal, open },
})

let pair: Pairing | null = null
let key: Uint8Array | null = null
let hello: HelloRes | null = null
let pollTimer: number | null = null
let sending = false
const downloadedIds = new Set<string>()
// la page vient d'arriver avec un code d'appairage neuf pour ce téléphone
// (QR scanné, lien collé), et l'appairage d'avant, à remettre si ce code a
// expiré (sinon un vieux QR scanné par erreur ferait perdre le bon)
let freshPairing = false
let previousPairing: string | null = null
// Android : proposition d'installation du navigateur, quand il en fait une
let installPrompt: { prompt: () => Promise<unknown>; userChoice?: Promise<{ outcome?: string }> } | null = null

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

/** Signale au PC un échec qu'il n'a pas pu voir lui-même (statistiques
 *  anonymes, comptées par le PC selon le choix fait sur le PC). Requête
 *  chiffrée comme les autres, vers le PC uniquement : le téléphone ne contacte
 *  jamais internet. Aucun nom de fichier, seulement une catégorie. */
function reportFail(direction: 'phone_to_pc' | 'pc_to_phone', mime: string | undefined, reason: string, itemId?: string) {
  if (!pair || !key) return
  const kind = (mime ?? '').startsWith('image/') ? 'photo' : 'file'
  const body: Record<string, unknown> = { event: 'transfer_fail', direction, kind, reason }
  if (itemId) body.itemId = itemId
  void post('/api/phone/report', 'report', body).catch(() => {})
}

/** Confirme au PC qu'un de ses fichiers est arrivé entier et déchiffré : c'est
 *  seulement là que le PC compte la réussite (identifiant d'élément seul). */
function reportReceived(itemId: string) {
  if (!pair || !key) return
  void post('/api/phone/report', 'report', { event: 'transfer_ok', direction: 'pc_to_phone', itemId }).catch(() => {})
}

// codes d'erreur que la route de téléchargement du PC renvoie elle-même, après
// les avoir comptés. Tout autre refus (appareil refusé, trop de requêtes) vient
// d'avant cette route : c'est au téléphone de le signaler.
const DL_CODES_COUNTED = new Set(['itemNotFound', 'notAFile', 'fileGone'])

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
    notePairingSource(incoming)
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

/** Avant d'enregistrer un appairage arrivé par l'adresse ou collé : est-ce un
 *  code neuf pour ce téléphone ? On garde l'appairage d'avant au cas où. */
function notePairingSource(incoming: Pairing) {
  previousPairing = localStorage.getItem(PAIR_KEY)
  let prevId = ''
  try {
    prevId = (JSON.parse(previousPairing || 'null') as Pairing | null)?.id ?? ''
  } catch {
    prevId = ''
  }
  freshPairing = prevId !== incoming.id
}

/** Premier transfert réussi depuis ce téléphone : c'est seulement maintenant
 *  qu'on propose l'icône sur l'écran d'accueil. */
function markTransferOk() {
  if (localStorage.getItem(FIRST_OK_KEY) === '1') return
  localStorage.setItem(FIRST_OK_KEY, '1')
  maybeInstallBanner()
}

/** Juste après le premier appairage : le bouton d'envoi est mis en avant,
 *  une seule fois (quelques pulsations, puis plus rien). */
function hintSendOnce() {
  if (localStorage.getItem(SEND_HINT_KEY) === '1' || localStorage.getItem(FIRST_OK_KEY) === '1') return
  localStorage.setItem(SEND_HINT_KEY, '1')
  const btn = $('btnPick')
  btn.classList.add('hint')
  const stop = () => btn.classList.remove('hint')
  btn.addEventListener('animationend', stop, { once: true })
  btn.addEventListener('click', stop, { once: true })
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
    $('pcName').textContent = hello.desktopName
    $('statusDot').classList.remove('off')
    $('menuInfo').textContent = t('ph.menuInfo', { name: hello.desktopName })
    if (hello.hosts?.length) {
      const merged = [location.host, ...hello.hosts].filter((v, i, arr) => arr.indexOf(v) === i)
      localStorage.setItem(HOSTS_KEY, JSON.stringify(merged.slice(0, 6)))
    }
    updateManifestForPairing()
    show('main')
    // test de vitesse : seulement si ce PC sait y répondre
    $('btnSpeed').classList.toggle('hidden', !hello.features?.includes('speedtest'))
    // iPhone sans WebAssembly : presque toujours le mode Isolement, qui coupe
    // aussi le JIT. Les transferts y sont très lents : on le dit, avec la sortie.
    const slow = $('slowHint')
    slow.textContent = t('st.lockdown')
    slow.classList.toggle('hidden', !(isIOS() && typeof WebAssembly !== 'object'))
    startPolling()
    // appairage tout neuf (clé de session reçue) : le bouton d'envoi d'abord
    if (hello.newKey) hintSendOnce()
    freshPairing = false
    maybeInstallBanner()
  } catch (e) {
    const err = e as ApiFail
    const kind = connectError({ status: err.status, code: err.code, fresh: freshPairing, standalone: isStandalone() })
    // « Oublier ce PC » n'a pas de sens sur un code expiré : il effacerait
    // l'appairage d'avant, tout juste remis
    $('btnForget').classList.toggle('hidden', kind === 'expired')
    if (kind === 'expired') {
      // le PC a déjà remplacé ce code : on le dit, et l'appairage d'avant
      // (s'il y en avait un) redevient celui de ce téléphone, en mémoire
      // aussi : « Réessayer » repart avec lui, pas avec le code expiré
      $('errTitle').textContent = t('ph.err.expired')
      $('errMsg').textContent = t('ph.err.expiredMsg')
      $('altHosts').classList.add('hidden')
      const back = afterExpiredCode<Pairing>(previousPairing)
      if (back.pairing && previousPairing) localStorage.setItem(PAIR_KEY, previousPairing)
      else localStorage.removeItem(PAIR_KEY)
      pair = back.pairing
      key = pair ? b64uToBytes(pair.keyB64) : null
      freshPairing = false
      previousPairing = null
    } else if (kind === 'wrongPc') {
      $('errTitle').textContent = t('ph.err.wrongPc')
      $('errMsg').textContent = t('ph.err.wrongPcMsg')
      $('altHosts').classList.add('hidden')
    } else if (kind === 'revoked') {
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

/** Un morceau chiffré vers le PC. XMLHttpRequest plutôt que fetch : lui seul
 *  dit combien d'octets sont déjà partis, pour une barre et une vitesse qui
 *  bougent en continu (et plus seulement tous les 8 Mo). */
function postChunk(tid: string, n: number, sealed: Uint8Array, onSent: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/phone/transfer/${tid}/chunk/${n}`)
    x.setRequestHeader('content-type', 'application/octet-stream')
    x.setRequestHeader('x-wd-device', pair!.id)
    x.upload.onprogress = (e) => onSent(e.loaded)
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve()
      let j: { code?: string } = {}
      try {
        j = JSON.parse(x.responseText) as { code?: string }
      } catch {
        j = {}
      }
      reject(new ApiFail(j.code ? t('err.' + j.code) : t('err.generic', { status: x.status }), x.status, j.code))
    }
    // coupure réseau : statut 0, repris plus loin (jamais une erreur « dure »)
    x.onerror = x.onabort = x.ontimeout = () => reject(new ApiFail(t('ph.send.lostRetry'), 0))
    x.send(sealed as unknown as XMLHttpRequestBodyInit)
  })
}

async function sendChunk(tid: string, n: number, sealed: Uint8Array, onSent: (bytes: number) => void): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onSent(0)
      return await postChunk(tid, n, sealed, onSent)
    } catch (e) {
      lastErr = e
      if (e instanceof ApiFail && e.status && e.status !== 429 && e.status < 500) throw e
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
    reportFail('phone_to_pc', file.type, 'tooBig')
    return
  }
  const chunkSize = SEND_CHUNK
  const chunks = Math.ceil(file.size / chunkSize)
  let tid = ''
  // rafraîchit vitesse et temps restant même sans nouvel octet (lien bloqué)
  let ticker: number | undefined
  try {
    const init = await post<{ transferId: string }>('/api/phone/transfer/init', 'init', {
      meta: { name: file.name || fallbackName, size: file.size, mime: file.type || undefined, chunkSize, chunks },
    })
    tid = init.transferId
    const acked = new Set<number>()
    let sentBytes = 0
    let resumes = 0
    // octets déjà partis des morceaux en cours d'envoi (non encore confirmés)
    const moving = new Map<number, number>()
    const meter = new SpeedMeter()
    let lastPaint = 0
    // pendant une reprise, la ligne dit « Connexion perdue, reprise… »
    let pausing = false
    const paint = (force = false) => {
      const now = Date.now()
      if (pausing || (!force && now - lastPaint < 250)) return
      lastPaint = now
      let live = sentBytes
      for (const v of moving.values()) live += v
      live = Math.min(file.size, live)
      meter.add(live)
      ui.bar.style.width = Math.floor((live / file.size) * 100) + '%'
      ui.state.textContent = progressText(lang, live, file.size, meter.rate())
    }
    ticker = window.setInterval(() => paint(), 1000)

    // envoie un chunk : lecture, chiffrement dans un Worker (pendant que les
    // autres morceaux partent sur le réseau), envoi (sendChunk retente déjà 3×
    // les erreurs transitoires)
    const sendOne = async (n: number) => {
      const slice = file.slice(n * chunkSize, Math.min((n + 1) * chunkSize, file.size))
      const plain = new Uint8Array(await slice.arrayBuffer())
      const len = plain.length
      // `plain` part au Worker (sans copie) : ne plus s'en servir ensuite
      const sealed = await pool.seal(key!, plain, aad('chunk', `${tid}|${n}`))
      try {
        await sendChunk(tid, n, sealed, (bytes) => {
          moving.set(n, Math.min(len, bytes))
          paint()
        })
      } finally {
        moving.delete(n)
      }
      acked.add(n)
      sentBytes += len
      paint(true)
    }

    const isHard = (e: ApiFail) => !!e.status && e.status !== 429 && e.status < 500 && e.status !== 408

    // morceaux en route à la fois : moins quand le lien lâche (sendpass.ts)
    const lanes: Lanes = { lanes: SEND_WINDOW, okStreak: 0 }
    const toFail = (e: unknown) => (e instanceof ApiFail ? e : new ApiFail((e as Error)?.message || t('ph.send.lostRetry'), 0))

    // boucle reprenable : si le réseau coupe, on resynchronise avec le PC
    // (quels chunks lui manquent) et on repart, sans jamais renvoyer ce qui
    // est déjà arrivé.
    while (acked.size < chunks) {
      const before = acked.size
      const failures = await runPass(chunks, acked, lanes, SEND_WINDOW, sendOne, toFail)
      if (failures.length) {
        const hard = failures.find(isHard)
        if (hard) throw hard
        // des morceaux sont passés depuis la dernière coupure : on repart de zéro
        if (acked.size > before) resumes = 0
        if (resumes >= 30) throw failures[0]
        resumes++
        // lien qui lâche : moins de morceaux à la fois
        afterFailure(lanes)
        pausing = true
        ui.state.textContent = t('ph.send.lost')
        await new Promise((r) => setTimeout(r, Math.min(4000, 500 * 2 ** Math.min(resumes - 1, 3))))
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
        pausing = false
      }
    }
    await post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
    ui.bar.style.width = '100%'
    ui.li.classList.add('done')
    ui.state.textContent = t('ph.send.arrived', { name: hello?.desktopName ?? 'PC' })
    markTransferOk()
  } catch (e) {
    const err = e as ApiFail
    // le PC compte lui-même les échecs qu'il voit ; on ne signale que la coupure
    // avant le tout début du transfert, qu'il n'a jamais vue.
    if (!tid && !err.status) reportFail('phone_to_pc', file.type, 'network')
    ui.li.classList.add('err')
    ui.state.textContent = err.code === 'refused' ? t('ph.send.refused') : errText(err)
  } finally {
    clearInterval(ticker)
  }
}

async function sendFiles(files: FileList | File[]) {
  if (sending) return
  sending = true
  $('btnPick').setAttribute('disabled', '')
  const list = [...files]
  const summary = $('sendSummary')
  summary.classList.remove('hidden')
  // gros envoi : l'iPhone qui se verrouille met la page en pause
  const big = list.reduce((a, f) => a + f.size, 0) > 100 * 1024 * 1024
  let done = 0
  for (const f of list) {
    summary.innerHTML = t('ph.send.sending', { a: done + 1, b: list.length }) + (big ? '<br>' + t('ph.send.keepOn') : '')
    await sendFile(f)
    done++
  }
  summary.innerHTML = list.length > 1 ? t('ph.send.processed', { n: list.length }) : ''
  if (list.length === 1) summary.classList.add('hidden')
  sending = false
  $('btnPick').removeAttribute('disabled')
}

// ---------- réception ----------

// liste « Recevoir » : lignes gardées d'une relecture à l'autre (plus de
// clignotement, et la barre d'un téléchargement en cours ne disparaît plus)
const outboxList = new VersionedList<OutboxItem[]>()
const recvNodes = new KeyedNodes<HTMLLIElement>()
// téléchargements en cours : leur ligne n'est jamais recréée ni retirée
const downloading = new Set<string>()

function renderRecv(items: OutboxItem[]) {
  const badge = $('recvBadge')
  const fresh = items.filter((i) => !downloadedIds.has(i.id))
  badge.textContent = String(fresh.length)
  badge.classList.toggle('hidden', fresh.length === 0)
  $('recvEmpty').classList.toggle('hidden', items.length > 0)
  const nodes = recvNodes.sync(items, lang, recvLine, downloading)
  items.forEach((item, i) => nodes[i]?.classList.toggle('done', downloadedIds.has(item.id)))
  reconcile($('recvList'), nodes)
}

function recvLine(item: OutboxItem): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'qitem'
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
      markTransferOk()
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
  return li
}

async function downloadItem(item: OutboxItem, li: HTMLLIElement) {
  // un deuxième appui pendant le téléchargement ne relance rien
  if (downloading.has(item.id)) return
  downloading.add(item.id)
  try {
    await downloadInto(item, li)
  } finally {
    downloading.delete(item.id)
  }
}

async function downloadInto(item: OutboxItem, li: HTMLLIElement) {
  const bar = li.querySelector('.qbar') as HTMLElement
  const barFill = li.querySelector('.qbar span') as HTMLElement
  const state = li.querySelector('.qstate') as HTMLElement
  // nouvel essai après un échec : la ligne repart de zéro
  li.classList.remove('err')
  barFill.style.width = '0%'
  bar.classList.remove('hidden')
  state.classList.remove('hidden')
  state.textContent = t('ph.recv.downloading')
  let serverSaw = false
  let reason: 'network' | 'incomplete' | 'decrypt' | 'refused' | 'busy' = 'network'
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const r = await fetch(`/api/phone/outbox/${item.id}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
      body: envelope('download', { itemId: item.id }),
    })
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { code?: string }
      // réponse d'erreur de la route de téléchargement : le PC l'a déjà comptée
      if (typeof j.code === 'string' && DL_CODES_COUNTED.has(j.code)) serverSaw = true
      else reason = r.status === 401 || r.status === 403 ? 'refused' : r.status === 429 ? 'busy' : 'network'
    }
    if (!r.ok || !r.body) throw new Error(t('ph.recv.dlFailed'))
    reader = r.body.getReader()
    // file de morceaux réseau : on ne recopie JAMAIS tout l'accumulateur (l'ancien
    // code était en O(n²) et ramait sur les gros fichiers). peek/take sont en O(n).
    const queue: Uint8Array[] = []
    let queued = 0
    // morceaux déchiffrés, rangés en Blob par tranches de 64 Mo : la mémoire
    // des morceaux est rendue au fur et à mesure (avant : tout le fichier en
    // mémoire, puis une copie de plus au moment du Blob)
    let parts: Uint8Array[] = []
    let partsBytes = 0
    const blobs: Blob[] = []
    let frameIndex = 0
    let received = 0
    const total = item.size ?? 0
    const meter = new SpeedMeter()
    let lastPaint = 0
    // morceaux confiés aux Workers, dans l'ordre du fichier
    const opening: Promise<Uint8Array>[] = []
    const settle = async () => {
      const plain = await opening.shift()!
      parts.push(plain)
      partsBytes += plain.length
      received += plain.length
      if (partsBytes >= DL_BLOB_BATCH) {
        blobs.push(new Blob(parts as BlobPart[]))
        parts = []
        partsBytes = 0
      }
      const now = Date.now()
      if (total > 0 && now - lastPaint >= 250) {
        lastPaint = now
        meter.add(received)
        barFill.style.width = Math.floor((received / total) * 100) + '%'
        state.textContent = progressText(lang, received, total, meter.rate())
      }
    }
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
          // déchiffré dans un Worker pendant que les morceaux suivants arrivent ;
          // chaque morceau garde son numéro (AAD) : un morceau déplacé, rejoué
          // ou modifié est refusé
          const job = pool.open(key!, sealed, aad('dl', `${item.id}|${frameIndex}`))
          job.catch(() => {})
          opening.push(job)
          frameIndex++
          while (opening.length >= DL_INFLIGHT) await settle()
        }
      }
      if (done) break
    }
    while (opening.length > 0) await settle()
    if (total > 0 && received !== total) {
      reason = 'incomplete'
      throw new Error(t('ph.recv.incomplete'))
    }
    const blob = new Blob([...blobs, ...parts] as BlobPart[], { type: item.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    downloadedIds.add(item.id)
    reportReceived(item.id)
    markTransferOk()
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
    // plus la peine de laisser le PC envoyer la suite
    void reader?.cancel().catch(() => {})
    if (e instanceof CryptoAuthError) reason = 'decrypt'
    state.textContent = e instanceof CryptoAuthError ? t('ph.recv.dlFailed') : (e as Error).message || t('ph.recv.dlFailed')
    li.classList.add('err')
    if (!serverSaw) reportFail('pc_to_phone', item.mime, reason, item.id)
  }
}

async function pollOutbox() {
  if (!hello || document.hidden) return
  try {
    const res = await post<{ items?: OutboxItem[]; unchanged?: boolean; v?: string }>('/api/phone/outbox', 'outbox', outboxList.request())
    const items = outboxList.accept(res, () => res.items ?? [])
    if (items) renderRecv(items)
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


// ---------- test de vitesse ----------
// Le réseau seul dans chaque sens (octets aléatoires, aucun fichier), puis la
// vitesse de chiffrement de ce téléphone, puis comment le PC est relié. Le
// verdict dit en mots simples qui freine et quoi faire (speedverdict.ts).

const SPEED_MS = 4000
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** octets/s du PC vers le téléphone, mesurés pendant ~4 s */
async function measureDown(): Promise<number> {
  const r = await fetch('/api/phone/speedtest/down', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
    body: envelope('speedtest-down', { bytes: 64 * 1024 * 1024 }),
  })
  if (!r.ok || !r.body) throw new Error('down ' + r.status)
  const reader = r.body.getReader()
  let got = 0
  let t0 = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (value) {
      // le chrono part au premier octet : l'attente de la réponse n'est pas du débit
      if (!t0) t0 = performance.now()
      else got += value.length
    }
    if (done) break
    if (t0 && performance.now() - t0 > SPEED_MS) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  const ms = performance.now() - t0
  if (!t0 || ms <= 0) throw new Error('down vide')
  return (got * 1000) / ms
}

/** octets/s du téléphone vers le PC : morceaux de 2 Mo, 3 à la fois, ~4 s */
async function measureUp(): Promise<number> {
  const PIECE = 2 * 1024 * 1024
  const body = new Uint8Array(PIECE)
  let sent = 0
  const t0 = performance.now()
  const lane = async () => {
    while (performance.now() - t0 < SPEED_MS && sent < 96 * 1024 * 1024) {
      const auth = sealJSON(key!, { bytes: PIECE, ts: Date.now(), jti: jti() }, aad('speedtest-up'))
      const r = await fetch('/api/phone/speedtest/up', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-wd-device': pair!.id, 'x-wd-auth': auth },
        body: body as unknown as BodyInit,
      })
      if (!r.ok) throw new Error('up ' + r.status)
      await r.arrayBuffer()
      sent += PIECE
    }
  }
  await Promise.all([lane(), lane(), lane()])
  return (sent * 1000) / (performance.now() - t0)
}

/** octets/s que ce téléphone chiffre, avec tous ses Workers */
async function measureCrypto(): Promise<number> {
  const k = rand32()
  const PIECE = 4 * 1024 * 1024
  // mise en route (démarrage des Workers, compilation) hors chrono
  await Promise.all([0, 1, 2, 3].map(() => pool.seal(k, new Uint8Array(64 * 1024), 'speedtest')))
  let done = 0
  const t0 = performance.now()
  const lane = async () => {
    while (performance.now() - t0 < 2500 && done < 64 * 1024 * 1024) {
      await pool.seal(k, new Uint8Array(PIECE), 'speedtest')
      done += PIECE
    }
  }
  await Promise.all([lane(), lane(), lane(), lane()])
  return (done * 1000) / (performance.now() - t0)
}

function rand32(): Uint8Array {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return b
}

let speedRunning = false
async function runSpeedTest() {
  if (speedRunning || !hello) return
  speedRunning = true
  const out = $('speedResult')
  const btn = $('btnSpeedStart') as unknown as HTMLButtonElement
  btn.disabled = true
  const step = (key: string) => {
    out.innerHTML = ''
    const p = document.createElement('p')
    p.textContent = t(key)
    out.appendChild(p)
  }
  try {
    step('st.running.down')
    const down = await measureDown()
    await sleepMs(200)
    step('st.running.up')
    const up = await measureUp()
    step('st.running.crypto')
    const cryptoRate = await measureCrypto()
    step('st.running.pc')
    const pc = await post<{ link?: PcLink }>('/api/phone/speedtest/pc', 'speedtest-pc', {})
      .then((r) => r.link ?? null)
      .catch(() => null)
    const facts = { down, up, crypto: cryptoRate, noWasm: typeof WebAssembly !== 'object', ios: isIOS(), pc }
    out.innerHTML = ''
    for (const line of speedVerdict(lang, facts)) {
      const p = document.createElement('p')
      p.textContent = line.text
      if (line.strong) p.className = 'verdict'
      out.appendChild(p)
    }
    btn.textContent = t('st.again')
  } catch {
    step('st.failed')
  } finally {
    btn.disabled = false
    speedRunning = false
  }
}

function openSpeedSheet() {
  $('menuSheet').classList.add('hidden')
  $('speedIntro').textContent = t('st.intro', { name: hello?.desktopName ?? 'PC' })
  $('speedSheet').classList.remove('hidden')
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
// `shared` faux : le PC ne partage pas son presse-papiers avec CE téléphone
// (plusieurs téléphones sur un PC). Absent d'un PC plus ancien : partagé.
const clipList = new VersionedList<{ items: ClipEntry[]; enabled: boolean; shared: boolean }>()
const clipNodes = new KeyedNodes<HTMLLIElement>()

const clipLabel = (e: ClipEntry) =>
  e.kind === 'image' && e.image
    ? `${e.text} · ${rtf(lang, e.ts)}`
    : `${e.source === 'pc' ? t('ph.clip.copiedPc') : t('ph.clip.receivedFrom', { name: e.source })} · ${rtf(lang, e.ts)}`

function renderClipHistory(items: ClipEntry[], enabled: boolean, shared = true) {
  $('clipNotShared').classList.toggle('hidden', shared)
  $('clipDisabled').classList.toggle('hidden', enabled || !shared)
  $('clipEmpty').classList.toggle('hidden', !enabled || items.length > 0)
  const shown = enabled ? items : []
  const nodes = clipNodes.sync(shown, lang, clipLine)
  shown.forEach((e, i) => {
    // seule l'heure relative (« il y a 2 min ») bouge sur une ligne gardée
    const label = nodes[i]?.querySelector('.qname') as HTMLElement | null
    const text = clipLabel(e)
    if (label && label.textContent !== text) label.textContent = text
  })
  reconcile($('clipList'), nodes)
}

function clipLine(e: ClipEntry): HTMLLIElement {
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
    ;(li.querySelector('.rtext') as HTMLElement).textContent = e.text
    ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = () => {
      const ok = copyText(e.text)
      toast(ok ? t('ph.recv.copied') : t('ph.recv.selectCopy'))
    }
  }
  return li
}

async function pollClipHistory() {
  if (!hello || document.hidden) return
  try {
    const res = await post<{ items?: ClipEntry[]; enabled?: boolean; shared?: boolean; unchanged?: boolean; v?: string }>(
      '/api/phone/cliphistory',
      'cliphistory',
      clipList.request()
    )
    const got = clipList.accept(res, () => ({ items: res.items ?? [], enabled: res.enabled !== false, shared: res.shared !== false }))
    if (got) renderClipHistory(got.items, got.enabled, got.shared)
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
  const ok = shouldSuggestInstall({
    standalone: isStandalone(),
    dismissed: localStorage.getItem(INSTALL_KEY) === '1',
    firstTransferDone: localStorage.getItem(FIRST_OK_KEY) === '1',
  })
  if (ok) $('installBanner')?.classList.remove('hidden')
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
      markTransferOk()
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
    // plus d'appairage (code expiré sans appairage d'avant) : on rescanne
    if (!pair || !key) {
      if (isStandalone()) $('scanPaste')?.classList.remove('hidden')
      return
    }
    void connect()
  }
  $('btnForget').onclick = forget
  $('btnForget2').onclick = forget
  $('btnMenu').onclick = () => $('menuSheet').classList.remove('hidden')
  $('menuClose').onclick = () => $('menuSheet').classList.add('hidden')
  const openInstallSheet = () => {
    $('menuSheet').classList.add('hidden')
    $('installBanner')?.classList.add('hidden')
    // Android : le navigateur propose lui-même l'installation quand il le peut
    if (installPrompt) {
      const p = installPrompt
      installPrompt = null
      void p.prompt().catch(() => {})
      void p.userChoice?.then((c) => {
        if (c?.outcome === 'accepted') localStorage.setItem(INSTALL_KEY, '1')
      }).catch(() => {})
      return
    }
    const { platform } = platformLabel()
    $('installSteps').textContent =
      platform === 'iphone' || platform === 'ipad' ? t('ph.installSheet.ios') : t('ph.installSheet.android')
    $('installSheet').classList.remove('hidden')
  }
  $('btnInstall').onclick = openInstallSheet
  $('btnSpeed').onclick = openSpeedSheet
  $('btnSpeedStart').onclick = () => void runSpeedTest()
  $('speedClose').onclick = () => $('speedSheet').classList.add('hidden')
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
    // les lignes déjà affichées sont redessinées dans la nouvelle langue
    if (outboxList.data) renderRecv(outboxList.data)
    if (clipList.data) renderClipHistory(clipList.data.items, clipList.data.enabled, clipList.data.shared)
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
    notePairingSource(p)
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

  // Android (Chrome) : on garde la proposition d'installation pour le bouton
  // « Ajouter », proposé seulement après un premier transfert réussi
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault()
    installPrompt = ev as unknown as typeof installPrompt
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
