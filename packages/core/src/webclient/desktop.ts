import { t as tr, tp, rtf, fmtBytes, resolveLang, langFrom, type Lang } from '../i18n.js'
import { applyI18n } from '../i18n-dom.js'
import { pairCodeState, fmtCountdown, firewallCheckDue, addVisibleMs } from './onboarding.js'
import { FIREWALL_CHECK_AFTER_MS } from '../constants.js'

// langue courante : détectée d'abord, puis alignée sur le réglage serveur.
let lang: Lang = langFrom(navigator.language)
const t = (key: string, params?: Record<string, string | number>) => tr(lang, key, params)
const fmtSize = (bytes: number) => fmtBytes(lang, bytes)

interface DevicePub {
  id: string
  name: string
  platform?: string
  status: 'pending' | 'active'
  createdAt: string
  lastSeenAt?: string
  shortcutToken: string
  /** ce téléphone voit le presse-papiers du PC (absent d'un coeur plus ancien) */
  clipShare?: boolean
}
interface HistEntry {
  id: string
  ts: string
  dir: 'in' | 'out'
  kind: 'file' | 'text' | 'clip'
  name?: string
  size?: number
  preview?: string
  deviceName?: string
  status: 'ok' | 'error' | 'progress'
  path?: string
  error?: string
}
interface OutboxEntry {
  id: string
  kind: 'text' | 'file'
  name?: string
  size?: number
  preview?: string
  createdAt: string
  downloads: Record<string, string>
  /** téléphones destinataires ; absent : tous */
  to?: string[]
}
interface ClipEntry {
  id: string
  ts: string
  text: string
  kind: 'text' | 'image'
  source: string
  image?: { thumb: string; w: number; h: number }
}
interface State {
  product: string
  version: string
  config: {
    deviceName: string
    downloadDir: string
    maxFileMB: number
    requireApproval: boolean
    clipboardAutoPush: boolean
    clipHistoryEnabled: boolean
    clipHistoryMaxItems: number
    clipHistoryMaxDays: number
    theme: 'system' | 'light' | 'dark'
    skin: 'auto' | 'apple' | 'windows'
    lang: 'auto' | 'fr' | 'en' | 'de'
    shortcutsEnabled: boolean
    autoUpdate: boolean
    basicStats: boolean
    telemetryConsent: boolean
    telemetryAsked: boolean
    basicNoticeShown: boolean
    /** la question du lancement à l'ouverture de session a reçu une réponse */
    autostartAsked?: boolean
    /** un premier transfert a réussi (fin du premier envoi guidé) */
    firstTransferDone?: boolean
    port: number
  }
  /** destinataire proposé quand plusieurs téléphones sont appairés ('all' ou un identifiant) */
  sendTo?: string
  /** lancement à l'ouverture de session ; null ou absent : hors app de bureau */
  autostart?: boolean | null
  /** carte de demande de note à montrer */
  rate?: boolean
  hostname: string
  /** pare-feu de Windows ; null ou absent : pas de vérification possible
   *  (Mac, Linux, ligne de commande, coeur plus ancien) */
  firewall?: {
    checking: boolean
    repairing: boolean
    problem: 'public' | 'rule' | null
    network: string | null
    repair: 'ok' | 'cancelled' | 'failed' | null
    fixed: boolean
  } | null
  /** signalé par l'app de bureau (absent d'un coeur plus ancien) */
  host?: { macUpdate: { version: string; reveal?: number } | null; loginItemNeedsApproval: boolean }
  ips: string[]
  devices: DevicePub[]
  history: HistEntry[]
  outbox: OutboxEntry[]
  clipHistory: ClipEntry[]
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let state: State | null = null
let currentPairingId: string | null = null
let currentPairUrl = ''
let currentDeviceId: string | null = null
// fenêtre d'appairage : codes montrés depuis l'ouverture (renouvelés
// compris), heure d'expiration du code affiché (horloge de cette page),
// téléphone appairé, guide montré
let pairIds = new Set<string>()
let pairExpiresAt = 0
let pairPaired = false
let pairGuide = false
let pairRenewedAt = 0
let pairRenewing = false
let pairTimer: ReturnType<typeof setTimeout> | undefined
// pare-feu : temps de QR visible depuis l'ouverture, dernier battement du
// compte à rebours, vérification déjà demandée pour cette ouverture
let pairVisibleMs = 0
let pairLastTick = 0
let pairFwAsked = false

// destinataire choisi dans « Envoyer » (plusieurs téléphones) : 'all' ou un
// identifiant. null : celui que propose le PC (le dernier utilisé).
let sendChoice: string | null = null
const progressCards = new Map<string, { li: HTMLLIElement; bar: HTMLSpanElement; sub: HTMLElement }>()

// ---------- utilitaires ----------

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch('/api/admin' + path, init)
  if (!r.ok) {
    // le serveur renvoie un CODE d'erreur stable, traduit ici (jamais de texte figé)
    const j = (await r.json().catch(() => ({}))) as { code?: string }
    throw new Error(j.code ? t('err.' + j.code) : t('err.generic', { status: r.status }))
  }
  return r.json() as Promise<T>
}

const postJSON = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Événement d'interface (accueil, historique…) confié au serveur LOCAL, qui
 *  décide selon le choix de la personne (détaillé uniquement). Jamais d'envoi
 *  direct vers internet depuis cette page. */
function uiEvent(event: string) {
  void postJSON('/telemetry/event', { event }).catch(() => {})
}

function toast(title: string, sub?: string) {
  const t = document.createElement('div')
  t.className = 'toastitem'
  const b = document.createElement('b')
  b.textContent = title
  t.appendChild(b)
  if (sub) {
    const s = document.createElement('small')
    s.textContent = sub
    t.appendChild(s)
  }
  $('toasts').appendChild(t)
  setTimeout(() => t.remove(), 4200)
}

const rel = (ts?: string): string => rtf(lang, ts)

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('common.copied'))
  } catch {
    toast(t('common.copyFailed'))
  }
}

// ---------- rendu ----------

const VIEW_KEYS: Record<string, string> = {
  radar: 'nav.radar',
  activity: 'nav.history',
  send: 'nav.send',
  clip: 'nav.clipboard',
  settings: 'nav.settings',
}

function switchView(view: string) {
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  for (const v of Object.keys(VIEW_KEYS)) $(`view-${v}`).classList.toggle('hidden', v !== view)
  if (view === 'activity') uiEvent('history_opened')
  $('viewTitle').textContent = VIEW_KEYS[view] ? t(VIEW_KEYS[view]!) : 'Flitdrop'
}

/** Silhouette d'appareil pour le radar, selon le type détecté à l'appairage. */
function deviceSvg(platform?: string): string {
  const s = 'fill="none" stroke="currentColor" stroke-width="1.5"'
  if (platform === 'ipad')
    return `<svg viewBox="0 0 24 24" width="26" height="26" ${s}><rect x="4" y="2.5" width="16" height="19" rx="2.2"/><circle cx="12" cy="19" r="0.7" fill="currentColor" stroke="none"/></svg>`
  if (platform === 'android')
    return `<svg viewBox="0 0 24 24" width="24" height="24" ${s}><rect x="6" y="2.5" width="12" height="19" rx="2.4"/><line x1="10" y1="18.6" x2="14" y2="18.6"/></svg>`
  if (platform === 'iphone')
    return `<svg viewBox="0 0 24 24" width="24" height="24" ${s}><rect x="6.5" y="2.5" width="11" height="19" rx="2.8"/><line x1="10.5" y1="5" x2="13.5" y2="5"/></svg>`
  // par défaut : téléphone générique
  return `<svg viewBox="0 0 24 24" width="24" height="24" ${s}><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><line x1="10.5" y1="18.8" x2="13.5" y2="18.8"/></svg>`
}

function renderRadar() {
  if (!state) return
  const layer = $('deviceLayer')
  layer.innerHTML = ''
  const active = state.devices.filter((d) => d.status === 'active')
  $('radarEmpty').classList.toggle('hidden', active.length > 0)
  document.querySelector('.pcnode')?.classList.toggle('hidden', active.length === 0)
  const radar = $('radar')
  const size = radar.offsetWidth || 520
  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.36
  active.forEach((d, i) => {
    const angle = (-90 + (360 / active.length) * i) * (Math.PI / 180)
    const x = cx + radius * Math.cos(angle)
    const y = cy + radius * Math.sin(angle)
    const chip = document.createElement('div')
    const online = d.lastSeenAt ? Date.now() - Date.parse(d.lastSeenAt) < 30_000 : false
    chip.className = 'devchip' + (online ? ' online' : '')
    chip.style.left = `${x}px`
    chip.style.top = `${y}px`
    chip.style.animationDelay = `${i * 70}ms`
    const ava = document.createElement('div')
    ava.className = 'ava'
    ava.innerHTML = deviceSvg(d.platform)
    const nm = document.createElement('small')
    nm.textContent = d.name
    const seen = document.createElement('span')
    seen.className = 'seen'
    seen.textContent = online ? 'en ligne' : rel(d.lastSeenAt)
    chip.append(ava, nm, seen)
    chip.onclick = () => openDeviceModal(d.id)
    layer.appendChild(chip)
  })
}

function histIcon(e: HistEntry): { txt: string; cls: string } {
  if (e.status === 'error') return { txt: '!', cls: 'hicon err' }
  if (e.dir === 'out') return { txt: '↑', cls: 'hicon out' }
  if (e.kind === 'clip' || e.kind === 'text') return { txt: '✂', cls: 'hicon' }
  return { txt: '↓', cls: 'hicon' }
}

function renderHistory() {
  if (!state) return
  const list = $('historyList')
  list.innerHTML = ''
  $('histEmpty').classList.toggle('hidden', state.history.length > 0)
  for (const e of state.history.slice(0, 80)) {
    const li = document.createElement('li')
    const ic = histIcon(e)
    const icon = document.createElement('div')
    icon.className = ic.cls
    icon.textContent = ic.txt
    const main = document.createElement('div')
    main.className = 'hmain'
    const name = document.createElement('div')
    name.className = 'hname'
    name.textContent = e.kind === 'file' ? (e.name ?? t('hist.file')) : (e.preview ?? t('hist.text'))
    const sub = document.createElement('div')
    sub.className = 'hsub'
    const what = e.kind === 'file' ? fmtSize(e.size ?? 0) : e.kind === 'clip' ? t('hist.clip') : t('hist.text')
    const who = e.deviceName ? (e.dir === 'in' ? t('hist.from', { name: e.deviceName }) : t('hist.to', { name: e.deviceName })) : ''
    sub.textContent = [what, who, rel(e.ts), e.error ?? ''].filter(Boolean).join(' · ')
    main.append(name, sub)
    li.append(icon, main)
    if (e.dir === 'in' && e.kind === 'file' && e.status === 'ok') {
      const b = document.createElement('button')
      b.className = 'hbtn'
      b.textContent = t('hist.open')
      b.onclick = () => void postJSON('/open-folder', {}).catch(() => toast(t('common.copyFailed')))
      li.appendChild(b)
    }
    list.appendChild(li)
  }
}

const activePhones = (): DevicePub[] => (state ? state.devices.filter((d) => d.status === 'active') : [])

/** Destinataire des envois du PC : seulement avec plusieurs téléphones. Un
 *  seul téléphone (ou aucun) : rien à choisir, le PC décide comme avant. */
function sendTarget(): string | undefined {
  const active = activePhones()
  if (active.length < 2) return undefined
  if (sendChoice === 'all' || active.some((d) => d.id === sendChoice)) return sendChoice as string
  const proposed = state?.sendTo
  if (proposed === 'all' || active.some((d) => d.id === proposed)) return proposed
  return active[0]?.id
}

/** Nom du destinataire, pour les messages (« pour iPhone de Léa »). */
function sendTargetLabel(): string | undefined {
  const to = sendTarget()
  if (!to) return undefined
  if (to === 'all') return t('outbox.forAll')
  const d = activePhones().find((x) => x.id === to)
  return d ? t('outbox.for', { name: d.name }) : undefined
}

/** Choix du téléphone dans « Envoyer » : un bouton par téléphone et « Tous ».
 *  Caché avec un seul téléphone. */
function renderSendTo() {
  const box = $('sendTo')
  const active = activePhones()
  box.classList.toggle('hidden', active.length < 2)
  if (active.length < 2) return
  const current = sendTarget()
  const chips = $('sendToChips')
  chips.innerHTML = ''
  const add = (value: string, label: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip' + (current === value ? ' on' : '')
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', current === value ? 'true' : 'false')
    b.textContent = label
    b.onclick = () => {
      sendChoice = value
      renderSendTo()
    }
    chips.appendChild(b)
  }
  for (const d of active) add(d.id, d.name)
  add('all', t('send.toAll'))
}

/** « pour … » sous un élément en attente, quand plusieurs téléphones existent. */
function outboxTargetLabel(item: OutboxEntry): string | undefined {
  if (!state) return undefined
  const active = activePhones()
  if (!item.to) return active.length >= 2 ? t('outbox.forAll') : undefined
  if (active.length >= 2 && active.every((d) => item.to!.includes(d.id))) return t('outbox.forAll')
  const names = item.to.map((id) => state!.devices.find((d) => d.id === id)?.name).filter((n): n is string => !!n)
  return names.length ? t('outbox.for', { name: names.join(', ') }) : t('outbox.forRemoved')
}

function renderOutbox() {
  if (!state) return
  const list = $('outboxList')
  list.innerHTML = ''
  $('outboxEmpty').classList.toggle('hidden', state.outbox.length > 0)
  for (const item of state.outbox) {
    const li = document.createElement('li')
    const icon = document.createElement('div')
    icon.className = 'hicon out'
    icon.textContent = item.kind === 'text' ? '✂' : '↑'
    const main = document.createElement('div')
    main.className = 'hmain'
    const name = document.createElement('div')
    name.className = 'hname'
    name.textContent = item.kind === 'text' ? (item.preview ?? t('hist.text')) : (item.name ?? t('hist.file'))
    const sub = document.createElement('div')
    sub.className = 'hsub'
    const picked = Object.keys(item.downloads).length > 0
    const target = outboxTargetLabel(item)
    sub.textContent = [item.kind === 'file' ? fmtSize(item.size ?? 0) : t('hist.text'), target, picked ? t('outbox.downloaded') : t('outbox.waiting'), rel(item.createdAt)]
      .filter(Boolean)
      .join(' · ')
    main.append(name, sub)
    const del = document.createElement('button')
    del.className = 'hbtn x'
    del.textContent = '✕'
    del.title = 'Retirer'
    del.onclick = () => void postJSON(`/outbox/${item.id}/remove`, {}).then(refresh)
    li.append(icon, main, del)
    list.appendChild(li)
  }
}

function applyTheme(theme: 'system' | 'light' | 'dark') {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function renderSettings() {
  if (!state) return
  ;($('setTheme') as unknown as HTMLSelectElement).value = state.config.theme
  ;($('setSkin') as unknown as HTMLSelectElement).value = state.config.skin
  ;($('setLang') as unknown as HTMLSelectElement).value = state.config.lang
  ;($('setName') as unknown as HTMLInputElement).value = state.config.deviceName
  ;($('setDir') as unknown as HTMLInputElement).value = state.config.downloadDir
  ;($('setMax') as unknown as HTMLSelectElement).value = String(state.config.maxFileMB)
  ;($('setApproval') as unknown as HTMLInputElement).checked = state.config.requireApproval
  ;($('setClipboard') as unknown as HTMLInputElement).checked = state.config.clipboardAutoPush
  ;($('setShortcuts') as unknown as HTMLInputElement).checked = state.config.shortcutsEnabled
  ;($('setAutoUpdate') as unknown as HTMLInputElement).checked = state.config.autoUpdate
  ;($('setClipHistory') as unknown as HTMLInputElement).checked = state.config.clipHistoryEnabled
  ;($('setClipMax') as unknown as HTMLSelectElement).value = String(state.config.clipHistoryMaxItems)
  ;($('setClipDays') as unknown as HTMLSelectElement).value = String(state.config.clipHistoryMaxDays)
  ;($('setBasicStats') as unknown as HTMLInputElement).checked = state.config.basicStats || state.config.telemetryConsent
  ;($('setTelemetry') as unknown as HTMLInputElement).checked = state.config.telemetryConsent
  // réglage du système : seulement dans l'app de bureau
  const autostart = state.autostart
  $('setAutostartRow').classList.toggle('hidden', typeof autostart !== 'boolean')
  ;($('setAutostart') as unknown as HTMLInputElement).checked = autostart === true
  renderShortcutSection()
}

/** Classe un texte du presse-papiers pour un affichage riche façon Paste :
 *  lien, image, vidéo YouTube, e-mail, couleur, code, ou texte simple. */
interface ClipKind {
  kind: 'youtube' | 'image' | 'link' | 'email' | 'color' | 'code' | 'text'
  label: string
  icon: string
  domain?: string
  thumb?: string
}
function classifyClip(text: string): ClipKind {
  const t = text.trim()
  const yt = t.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^ ]*v=|youtu\.be\/)([\w-]{11})/i)
  if (yt) return { kind: 'youtube', label: tr(lang, 'clip.kind.youtube'), icon: '▶', domain: 'youtube.com', thumb: `https://i.ytimg.com/vi/${yt[1]}/mqdefault.jpg` }
  if (/^https?:\/\/\S+$/i.test(t) && !/\s/.test(t)) {
    let domain = t
    try {
      domain = new URL(t).hostname.replace(/^www\./, '')
    } catch {
      // garde le texte brut comme domaine
    }
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?\S*)?$/i.test(t)) return { kind: 'image', label: tr(lang, 'clip.kind.image'), icon: '▦', domain, thumb: t }
    return { kind: 'link', label: tr(lang, 'clip.kind.link'), icon: '🔗', domain }
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'email', label: tr(lang, 'clip.kind.email'), icon: '✉' }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t) || /^rgba?\([\d.,\s%/]+\)$/i.test(t)) return { kind: 'color', label: tr(lang, 'clip.kind.color'), icon: '●' }
  if (/[{};=()<>]/.test(t) && /\n/.test(t)) return { kind: 'code', label: tr(lang, 'clip.kind.code'), icon: '⟨⟩' }
  return { kind: 'text', label: tr(lang, 'clip.kind.text'), icon: '≡' }
}

let clipFilter = ''
function renderClipHistory() {
  if (!state) return
  const list = $('clipList')
  list.innerHTML = ''
  const enabled = state.config.clipHistoryEnabled
  const q = clipFilter.trim().toLowerCase()
  const items = state.clipHistory.filter((e) => !q || e.text.toLowerCase().includes(q))
  $('clipDisabled').classList.toggle('hidden', enabled)
  $('clipEmpty').classList.toggle('hidden', !enabled || items.length > 0 || q.length > 0)
  for (const e of items.slice(0, 200)) {
    const isImg = e.kind === 'image' && !!e.image
    const c = isImg ? { kind: 'image' as const, label: t('clip.kind.image'), icon: '▦', domain: undefined, thumb: e.image?.thumb } : classifyClip(e.text)
    const li = document.createElement('li')
    li.className = 'clip-item kind-' + c.kind

    // vignette (image copiée, miniature YouTube/image URL) ou pastille typée
    if (c.thumb) {
      const th = document.createElement('div')
      th.className = 'clip-thumb' + (isImg ? ' clip-thumb-img' : '')
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.src = c.thumb
      img.alt = c.label
      img.onerror = () => {
        th.classList.add('clip-thumb-fallback')
        th.textContent = c.icon
        img.remove()
      }
      th.appendChild(img)
      if (c.kind === 'youtube') {
        const play = document.createElement('span')
        play.className = 'clip-play'
        play.textContent = '▶'
        th.appendChild(play)
      }
      li.appendChild(th)
    } else {
      const badge = document.createElement('div')
      badge.className = 'clip-badge'
      if (c.kind === 'color') badge.style.background = e.text.trim()
      else badge.textContent = c.icon
      li.appendChild(badge)
    }

    const main = document.createElement('div')
    main.className = 'hmain'
    const txt = document.createElement('div')
    txt.className = 'clip-text'
    txt.textContent = e.text.length > 300 ? e.text.slice(0, 300) + '…' : e.text
    const sub = document.createElement('div')
    sub.className = 'hsub'
    const origin = e.source === 'pc' ? t('clip.copiedHere') : t('clip.received', { name: e.source })
    sub.textContent = [c.label + (c.domain ? ` · ${c.domain}` : ''), origin, rel(e.ts)].join(' · ')
    main.append(txt, sub)
    li.appendChild(main)

    if (!isImg && (c.kind === 'link' || c.kind === 'youtube' || c.kind === 'image')) {
      const open = document.createElement('button')
      open.className = 'hbtn'
      open.textContent = t('clip.open')
      open.onclick = () => void postJSON('/open-url', { url: e.text.trim() }).catch(() => toast(t('common.copyFailed')))
      li.appendChild(open)
    }
    const btnCopy = document.createElement('button')
    btnCopy.className = 'hbtn'
    btnCopy.textContent = t('clip.copy')
    btnCopy.onclick = () => void postJSON(`/cliphistory/${e.id}/copy`, {}).then(() => toast(t('common.copied'))).catch(() => toast(t('common.copyFailed')))
    const btnPhone = document.createElement('button')
    btnPhone.className = 'hbtn'
    btnPhone.textContent = t('clip.phone')
    btnPhone.title = t('clip.phoneTitle')
    btnPhone.onclick = () =>
      void postJSON(`/cliphistory/${e.id}/tophone`, { to: sendTarget() })
        .then(() => toast(t('clip.readyPhone'), [sendTargetLabel(), t('clip.recvTab')].filter(Boolean).join(' · ')))
        .catch(() => {})
    const del = document.createElement('button')
    del.className = 'hbtn x'
    del.textContent = '✕'
    del.title = 'Supprimer'
    del.onclick = () => void postJSON(`/cliphistory/${e.id}/remove`, {}).then(refresh)
    li.append(btnCopy, btnPhone, del)
    list.appendChild(li)
  }
}

function renderShortcutSection() {
  if (!state) return
  const sel = $('shortcutDevice') as unknown as HTMLSelectElement
  const previous = currentDeviceId ?? sel.value
  sel.innerHTML = ''
  const active = state.devices.filter((d) => d.status === 'active')
  if (active.length === 0) {
    const opt = document.createElement('option')
    opt.textContent = t('sc.pairFirst')
    opt.value = ''
    sel.appendChild(opt)
    $('shortcutInfo').innerHTML = ''
    return
  }
  for (const d of active) {
    const opt = document.createElement('option')
    opt.value = d.id
    opt.textContent = d.name
    sel.appendChild(opt)
  }
  if (active.some((d) => d.id === previous)) sel.value = previous
  const dev = active.find((d) => d.id === sel.value) ?? active[0]
  if (!dev) return
  const host = state.hostname.replace(/\.local$/i, '')
  const base = `http://${host}.local:${state.config.port}`
  const ipBase = `http://${state.ips[0] ?? '127.0.0.1'}:${state.config.port}`
  const rows: { lbl: string; url: string }[] = [
    { lbl: t('sc.rowFiles'), url: `${base}/api/shortcut/upload?t=${dev.shortcutToken}` },
    { lbl: t('sc.rowText'), url: `${base}/api/shortcut/text?t=${dev.shortcutToken}` },
    { lbl: t('sc.rowClip'), url: `${base}/api/shortcut/clipboard?t=${dev.shortcutToken}` },
    { lbl: t('sc.rowFallback'), url: `${ipBase}/api/shortcut/upload?t=${dev.shortcutToken}` },
  ]
  const box = $('shortcutInfo')
  box.innerHTML = ''
  for (const r of rows) {
    const row = document.createElement('div')
    row.className = 'sc-row'
    const lbl = document.createElement('span')
    lbl.className = 'lbl'
    lbl.textContent = r.lbl
    const url = document.createElement('span')
    url.className = 'url'
    url.textContent = r.url
    const btn = document.createElement('button')
    btn.className = 'hbtn'
    btn.textContent = t('clip.copy')
    btn.onclick = () => void copy(r.url)
    row.append(lbl, url, btn)
    box.appendChild(row)
  }
}

function renderAll() {
  if (!state) return
  // aligne la langue sur le réglage serveur (auto -> langue du navigateur)
  const wanted = resolveLang(state.config.lang, langFrom(navigator.language))
  if (wanted !== lang) {
    lang = wanted
    applyI18n(lang)
  }
  applyTheme(state.config.theme)
  applyPlatformSkin(state.config.skin)
  $('pcNameHead').textContent = state.config.deviceName
  $('pcNodeName').textContent = state.config.deviceName
  $('netInfo').textContent = `${state.ips[0] ?? '127.0.0.1'}:${state.config.port}`
  $('versionTag').textContent = 'v' + state.version
  renderRadar()
  renderHistory()
  renderSendTo()
  renderOutbox()
  renderClipHistory()
  renderSettings()
  renderHost()
  renderGuide()
}

// ---------- premier envoi guidé ----------

/** Un téléphone appairé et rien encore échangé : une seule grande étape
 *  (carte du radar). Dans la fenêtre d'appairage qui vient de réussir, la
 *  même étape en grand, puis « ça marche » dès que le premier envoi arrive. */
function renderGuide() {
  if (!state) return
  // absent d'un coeur plus ancien : pas de guide
  const done = state.config.firstTransferDone !== false
  $('guideCard').classList.toggle('hidden', done || activePhones().length === 0)
  const next = $('pairNext')
  next.classList.toggle('hidden', !(pairPaired && pairGuide))
  next.classList.toggle('done', done)
  $('pairNextTitle').textContent = done ? t('guide.done') : t('guide.title')
  $('pairNextBody').textContent = done ? t('guide.doneBody') : t('guide.body')
}

// ---------- demande de note ----------

/** Petite carte après 3 transferts réussis (jamais par-dessus l'accueil ni
 *  en même temps que la question des statistiques). */
function renderRate() {
  const welcomeOpen = !$('welcomeModal').classList.contains('hidden')
  const consentShown = !$('consentCard').classList.contains('hidden')
  $('rateCard').classList.toggle('hidden', !state?.rate || welcomeOpen || consentShown)
}

async function answerRate(action: 'rate' | 'later') {
  $('rateCard').classList.add('hidden')
  if (state) state.rate = false
  try {
    await postJSON('/rate', { action })
    if (action === 'rate') toast(t('rate.thanks'))
  } catch {
    // déjà répondu ailleurs : la carte reste cachée
  }
  void refresh()
}

// Fenêtre cachée (barre des tâches, démarrage caché) : on ne redessine rien
// pour une page que personne ne voit. On le note et on rattrape d'un coup à la
// réapparition. Le tout premier chargement passe toujours (state encore vide).
let dirty = false
async function refresh() {
  if (document.hidden && state) {
    dirty = true
    return
  }
  dirty = false
  state = await api<State>('/state')
  renderAll()
  renderConsentCard()
  renderRate()
  wakeRadar()
}

// ---------- état du système (app de bureau) ----------

// « Plus tard » : la carte se cache pour cette version jusqu'au prochain
// lancement, ou jusqu'à une vérification demandée à la main (menu de l'icône)
let macUpdateLater = ''
const macUpdateKey = (upd: { version: string; reveal?: number } | null | undefined) => (upd ? `${upd.version}|${upd.reveal ?? 0}` : '')
function renderHost() {
  const host = state?.host
  const upd = host?.macUpdate ?? null
  $('macUpdateCard').classList.toggle('hidden', !upd || macUpdateKey(upd) === macUpdateLater)
  if (upd) $('macUpdateBody').textContent = t('macupd.body', { v: upd.version })
  $('loginApproval').classList.toggle('hidden', !host?.loginItemNeedsApproval)
  renderFirewall()
}

// ---------- pare-feu de Windows ----------

// « Plus tard » sur la carte du Radar : cachée jusqu'au prochain résultat
let fwLaterKey = ''
const fwKey = (f: NonNullable<State['firewall']>) => `${f.problem}|${f.repair}|${f.fixed}`

/** Carte « Windows bloque peut-être ton téléphone », sur le Radar et dans la
 *  fenêtre d'appairage : ce qui bloque, « Réparer », et les 3 étapes à faire
 *  soi-même. Rien sans vérification (Mac, Linux) ni problème trouvé. */
function renderFirewall() {
  const f = state?.firewall ?? null
  const busy = !!f && (f.checking || f.repairing)
  const show = !!f && (!!f.problem || f.fixed)
  for (const id of ['fwCard', 'pairFw']) {
    const root = $(id)
    const hidden = !show || (id === 'fwCard' && !!f && fwKey(f) === fwLaterKey)
    root.classList.toggle('hidden', hidden)
    if (hidden || !f) continue
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
    const fixed = f.fixed && !f.problem
    root.classList.toggle('fixed', fixed)
    q('.fw-title').textContent = fixed ? t('fw.titleFixed') : t('fw.title')
    q('.fw-body').textContent = fixed ? t('fw.bodyFixed') : t(f.problem === 'public' ? 'fw.body.public' : 'fw.body.rule')
    // ligne d'état : en cours, refusé, raté
    let status = ''
    if (f.repairing) status = t('fw.repairing')
    else if (f.checking) status = t('fw.checking')
    else if (f.problem && f.repair === 'cancelled') status = t('fw.cancelled')
    else if (f.problem && f.repair === 'failed') status = t('fw.failed')
    else if (f.problem && f.repair === 'ok') status = t('fw.notYet')
    const st = q('.fw-status')
    st.textContent = status
    st.classList.toggle('hidden', !status)
    const fix = q<HTMLButtonElement>('.fw-fix')
    fix.classList.toggle('hidden', fixed)
    fix.disabled = busy
    q('.fw-note').classList.toggle('hidden', fixed)
    const later = root.querySelector<HTMLButtonElement>('.fw-later')
    if (later) later.textContent = fixed ? t('fw.ok') : t('fw.later')
    const manual = q<HTMLDetailsElement>('.fw-manual')
    manual.classList.toggle('hidden', fixed)
    // les étapes suivent ce qui bloque : type de réseau, ou règle du pare-feu
    const kind = f.problem === 'public' ? 'pub' : 'rule'
    const steps = q('.fw-steps')
    if (steps.dataset.kind !== kind + lang) {
      steps.dataset.kind = kind + lang
      steps.innerHTML = [1, 2, 3].map((n) => `<li>${t(`fw.${kind}.step${n}`)}</li>`).join('')
    }
    // réparation refusée par Windows ou sans effet : les étapes s'ouvrent
    if (f.problem && !busy && (f.repair === 'failed' || f.repair === 'ok')) manual.open = true
    q<HTMLButtonElement>('.fw-again').disabled = busy
  }
}

async function firewallRepair() {
  try {
    await postJSON('/firewall/repair', {})
  } catch (e) {
    toast((e as Error).message)
  }
  void refresh()
}

async function firewallAgain() {
  try {
    await postJSON('/firewall/check', {})
  } catch (e) {
    toast((e as Error).message)
  }
  void refresh()
}

const hostAction = (action: 'openMacUpdate' | 'openLoginItems') =>
  postJSON('/host/action', { action }).catch((e) => toast((e as Error).message))

// Animations du radar : en pause quand la fenêtre est cachée ou n'a pas le
// focus, et au repos après trois pulsations sans rien de neuf. Une fenêtre
// visible qui pulse en continu coûte 15 à 20 % d'un cœur (mesuré sur Mac :
// toute la fenêtre, transparente et floutée, est redessinée à chaque image).
const RADAR_REST_MS = 11_000
let radarRestTimer: ReturnType<typeof setTimeout> | undefined
function wakeRadar() {
  const radar = document.querySelector('.radar')
  if (!radar) return
  radar.classList.remove('rest')
  clearTimeout(radarRestTimer)
  radarRestTimer = setTimeout(() => radar.classList.add('rest'), RADAR_REST_MS)
}
function syncVisibility() {
  document.documentElement.classList.toggle('paused', document.hidden || !document.hasFocus())
  // compte à rebours du code d'appairage : arrêté fenêtre cachée, repris ici
  tickPair()
  if (document.hidden) return
  if (dirty) void refresh()
  // les points « en ligne » dépendent de l'heure : on les remet à jour
  else renderRadar()
  wakeRadar()
}
syncVisibility()
document.addEventListener('visibilitychange', syncVisibility)
window.addEventListener('focus', syncVisibility)
window.addEventListener('blur', () => document.documentElement.classList.add('paused'))

// ---------- question « aider à améliorer » ----------

/** Carte en haut de la fenêtre (pas une fenêtre surgissante) pour les
 *  personnes qui n'ont jamais répondu, par ex. après une mise à jour. Masquée
 *  tant que l'écran d'accueil, qui pose la même question, est ouvert. */
function renderConsentCard() {
  const welcomePending = localStorage.getItem('fd_onboard') !== '1' || !$('welcomeModal').classList.contains('hidden')
  $('consentCard').classList.toggle('hidden', !state || state.config.telemetryAsked || welcomePending)
  noticeSeen()
}

/** Les statistiques de base ne partent qu'une fois leur annonce (carte ou
 *  accueil) réellement affichée, fenêtre visible : on le signale au serveur
 *  local, une seule fois. Fenêtre cachée (lancement à l'ouverture de session),
 *  on attend qu'elle apparaisse. */
let noticePosted = false
function noticeSeen() {
  if (noticePosted || !state || state.config.basicNoticeShown || document.visibilityState !== 'visible') return
  const card = !$('consentCard').classList.contains('hidden')
  const welcome = !$('welcomeModal').classList.contains('hidden') && !$('welcomeConsent').classList.contains('hidden')
  if (!card && !welcome) return
  noticePosted = true
  void postJSON('/telemetry/notice', {})
    .then(() => {
      if (state) state.config.basicNoticeShown = true
    })
    .catch(() => {
      noticePosted = false
    })
}
document.addEventListener('visibilitychange', noticeSeen)

// ancien identifiant d'installation gardé par la page (versions 0.5 à 0.6.3) :
// l'identifiant vit désormais dans la config du PC, celui-ci ne sert plus
try {
  localStorage.removeItem('fd_iid')
} catch {
  // stockage indisponible : rien à nettoyer
}

/** Page de confidentialité du site, ouverte dans le navigateur du système. */
function openPrivacy() {
  void postJSON('/open-url', { url: 'https://flitdrop.com/privacy' }).catch(() => toast(t('common.copyFailed')))
}

async function chooseTelemetry(choice: 'full' | 'basic_only' | 'none', where: 'welcome' | 'prompt' | 'settings') {
  await postJSON('/telemetry/choice', { choice, where })
  if (state) {
    state.config.telemetryAsked = true
    state.config.telemetryConsent = choice === 'full'
    state.config.basicStats = choice !== 'none'
  }
}

// ---------- flux temps réel ----------

function feedCardBase(): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'fcard'
  $('feedEmpty').classList.add('hidden')
  const list = $('feedList')
  list.prepend(li)
  while (list.children.length > 30) list.lastChild?.remove()
  return li
}

function feedTransferStart(d: { id: string; name: string; size: number; deviceName: string }) {
  const li = feedCardBase()
  const head = document.createElement('div')
  head.className = 'fhead'
  const name = document.createElement('div')
  name.className = 'fname'
  name.textContent = d.name
  head.appendChild(name)
  const sub = document.createElement('div')
  sub.className = 'fsub'
  sub.textContent = t('feed.receiving', { name: d.deviceName })
  const bar = document.createElement('div')
  bar.className = 'fbar'
  const fill = document.createElement('span')
  bar.appendChild(fill)
  li.append(head, sub, bar)
  progressCards.set(d.id, { li, bar: fill, sub })
}

function feedTransferDone(d: { id: string; name: string; size: number; deviceName: string }) {
  const found = progressCards.get(d.id)
  const li = found?.li ?? feedCardBase()
  li.innerHTML = ''
  li.classList.add('done')
  const head = document.createElement('div')
  head.className = 'fhead'
  const name = document.createElement('div')
  name.className = 'fname'
  name.textContent = `${d.name} ✓`
  head.appendChild(name)
  const sub = document.createElement('div')
  sub.className = 'fsub'
  sub.textContent = `${fmtSize(d.size)} · ${t('hist.from', { name: d.deviceName })}`
  const btn = document.createElement('button')
  btn.className = 'hbtn'
  btn.textContent = t('feed.openFolder')
  btn.onclick = () => void postJSON('/open-folder', {}).catch(() => toast(t('toast.openFolderFailed')))
  li.append(head, sub, btn)
  progressCards.delete(d.id)
}

function feedText(d: { deviceName: string; mode: string; copied: boolean; text: string }) {
  const li = feedCardBase()
  const head = document.createElement('div')
  head.className = 'fhead'
  const name = document.createElement('div')
  name.className = 'fname'
  name.textContent = d.copied ? t('feed.textCopied') + ' ✓' : t('clip.received', { name: d.deviceName })
  head.appendChild(name)
  const sub = document.createElement('div')
  sub.className = 'fsub'
  sub.textContent = t('hist.from', { name: d.deviceName })
  const txt = document.createElement('div')
  txt.className = 'ftext'
  txt.textContent = d.text
  const btn = document.createElement('button')
  btn.className = 'hbtn'
  btn.textContent = t('feed.copyAgain')
  btn.onclick = () => void copy(d.text)
  li.append(head, sub, txt, btn)
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws/ui`)
  ws.onmessage = (ev) => {
    let msg: { type: string; data: unknown }
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    const data = msg.data
    switch (msg.type) {
      case 'device-paired': {
        // le code scanné peut être l'un des codes renouvelés de cette fenêtre
        const pid = (data as { id?: string }).id
        if (pid && pairIds.has(pid) && isPairOpen()) {
          currentPairingId = pid
          pairPaired = true
          // premier téléphone et rien encore échangé : la prochaine étape en grand
          pairGuide = state?.config.firstTransferDone === false
          clearTimeout(pairTimer)
          $('pairHint').classList.add('hidden')
          $('pairScan').classList.add('hidden')
          $('pairCopy').classList.add('hidden')
          const st = $('pairState')
          st.classList.add('ok')
          st.textContent = t('pair.connected')
          $('pairRenameRow').classList.remove('hidden')
          ;($('pairRenameInput') as unknown as HTMLInputElement).value = (data as { name?: string }).name ?? ''
          renderGuide()
        }
        toast(t('toast.devicePaired'), (data as { name?: string }).name)
        void refresh()
        break
      }
      case 'device-online':
      case 'device-revoked':
      case 'settings-changed':
      case 'host-changed':
      // premier transfert réussi, demande de note due ou répondue
      case 'milestone':
        void refresh()
        break
      case 'transfer-start':
        feedTransferStart(data as { id: string; name: string; size: number; deviceName: string })
        break
      case 'transfer-progress': {
        const card = progressCards.get((data as { id: string }).id)
        if (card) {
          const { bytes, size } = data as { bytes: number; size: number }
          const pct = Math.min(100, Math.round((bytes / size) * 100))
          card.bar.style.width = pct + '%'
          card.sub.textContent = `${pct} % · ${fmtSize(bytes)} / ${fmtSize(size)}`
        }
        break
      }
      case 'transfer-done':
        feedTransferDone(data as { id: string; name: string; size: number; deviceName: string })
        void refresh()
        break
      case 'transfer-error': {
        const d = data as { id: string; name: string; reason: string }
        const card = progressCards.get(d.id)
        if (card) {
          card.li.classList.add('err')
          card.sub.textContent = d.reason
          progressCards.delete(d.id)
        }
        void refresh()
        break
      }
      case 'text-received':
        feedText(data as { deviceName: string; mode: string; copied: boolean; text: string })
        void refresh()
        break
      case 'approval-request': {
        const d = data as { id: string; deviceName: string; name: string; size: number }
        currentApprovalId = d.id
        $('apprText').textContent = t('appr.body', { name: d.deviceName, file: d.name, size: fmtSize(d.size) })
        $('apprModal').classList.remove('hidden')
        break
      }
      case 'approval-expired':
        if (currentApprovalId === (data as { id?: string }).id) $('apprModal').classList.add('hidden')
        break
      case 'outbox-downloaded': {
        const d = data as { name?: string; deviceName?: string }
        toast(t('toast.pickedUp'), d.name ? `${d.name} · ${d.deviceName}` : d.deviceName)
        void refresh()
        break
      }
      case 'outbox-changed':
        void refresh()
        break
      case 'clip-autopushed':
        toast(t('toast.clipSynced'), (data as { preview?: string }).preview)
        break
      case 'cliphistory-changed':
        void refresh()
        break
    }
  }
  ws.onclose = () => setTimeout(connectWS, 2500)
}

let currentApprovalId: string | null = null

// ---------- modales ----------

function openDeviceModal(id: string) {
  const dev = state?.devices.find((d) => d.id === id)
  if (!dev) return
  currentDeviceId = id
  $('devTitle').textContent = dev.name
  $('devSeen').textContent = t('device.pairedSeen', { paired: rel(dev.createdAt), seen: rel(dev.lastSeenAt) })
  ;($('devRenameInput') as unknown as HTMLInputElement).value = dev.name
  ;($('devClipShare') as unknown as HTMLInputElement).checked = dev.clipShare === true
  $('devModal').classList.remove('hidden')
}

// ---------- fenêtre d'appairage ----------

// déclaration de fonction : syncVisibility l'appelle dès le chargement
function isPairOpen(): boolean {
  return !$('pairModal').classList.contains('hidden')
}

/** Demande un code au PC et l'affiche. `renew` : remplace le code d'une
 *  fenêtre restée ouverte, avant qu'il expire. */
async function showPairCode(renew: boolean) {
  const res = (await postJSON('/pair/new', { renew })) as unknown as { deviceId: string; url: string; ttlMs?: number }
  pairIds.add(res.deviceId)
  currentPairingId = res.deviceId
  currentPairUrl = res.url
  pairExpiresAt = Date.now() + (typeof res.ttlMs === 'number' && res.ttlMs > 0 ? res.ttlMs : 3 * 60 * 1000)
  if (renew) pairRenewedAt = Date.now()
  ;($('qrImg') as unknown as HTMLImageElement).src = `/api/admin/pair/${res.deviceId}/qr.svg`
  $('pairUrlText').textContent = res.url.split('#')[0] + t('pair.orScan')
}

/** Une fois par seconde, seulement fenêtre d'appairage ouverte, téléphone
 *  pas encore appairé et page visible : compte à rebours, puis nouveau code
 *  30 s avant l'expiration de l'ancien. Rien ne tourne sinon (fenêtre
 *  fermée, réduite ou cachée) ; syncVisibility relance au retour. */
function tickPair() {
  clearTimeout(pairTimer)
  pairTimer = undefined
  if (!isPairOpen() || pairPaired || document.hidden || pairRenewing) {
    // le temps fenêtre cachée ou réduite ne compte pas pour le pare-feu
    pairLastTick = 0
    return
  }
  const now = Date.now()
  pairVisibleMs = addVisibleMs(pairVisibleMs, pairLastTick, now)
  pairLastTick = now
  // Windows : QR visible 45 s et toujours aucun téléphone. Une seule
  // vérification par ouverture ; le PC refuse si un téléphone a ouvert la page.
  if (firewallCheckDue({ visibleMs: pairVisibleMs, asked: pairFwAsked, paired: pairPaired, available: !!state?.firewall, afterMs: FIREWALL_CHECK_AFTER_MS })) {
    pairFwAsked = true
    void postJSON('/firewall/check', { auto: true }).catch(() => {})
  }
  const st = pairCodeState(now, pairExpiresAt)
  const el = $('pairRenew')
  if (st.renewNow) {
    pairRenewing = true
    void showPairCode(true)
      .then(() => {
        pairRenewing = false
        tickPair()
      })
      .catch(() => {
        // PC injoignable un instant : nouvel essai dans 5 s, pas plus souvent
        pairRenewing = false
        pairTimer = setTimeout(tickPair, 5000)
      })
    return
  }
  const fresh = now - pairRenewedAt < 5000
  el.classList.toggle('fresh', fresh)
  el.textContent = fresh ? t('pair.renewed') : t('pair.renewIn', { time: fmtCountdown(st.renewInMs) })
  pairTimer = setTimeout(tickPair, 1000)
}

async function openPairModal() {
  pairIds = new Set()
  pairPaired = false
  pairGuide = false
  pairRenewedAt = 0
  pairVisibleMs = 0
  pairLastTick = 0
  pairFwAsked = false
  await showPairCode(false)
  const st = $('pairState')
  st.classList.remove('ok')
  st.innerHTML = '<span class="spin"></span>' + t('pair.waiting')
  $('pairRenameRow').classList.add('hidden')
  $('pairHint').classList.remove('hidden')
  $('pairScan').classList.remove('hidden')
  $('pairCopy').classList.remove('hidden')
  $('pairNext').classList.add('hidden')
  $('pairRenew').textContent = ''
  $('pairModal').classList.remove('hidden')
  tickPair()
}

/** Ferme la fenêtre d'appairage (Fermer, Terminer) et le signale au PC. */
function closePairModal() {
  currentPairingId = null
  clearTimeout(pairTimer)
  pairTimer = undefined
  $('pairModal').classList.add('hidden')
  void postJSON('/pair/close', {}).catch(() => {})
}

// ---------- interactions ----------

function initUI() {
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view ?? 'radar')
  })

  $('btnPair').onclick = () => void openPairModal()
  $('btnPair2').onclick = () => void openPairModal()
  $('btnPairCancel').onclick = () => {
    closePairModal()
    void refresh()
  }
  $('btnCopyPairLink').onclick = async () => {
    if (!currentPairUrl) return
    try {
      await navigator.clipboard.writeText(currentPairUrl)
      uiEvent('pair_link_copied')
      toast(t('pair.linkCopied'), t('pair.linkCopiedHint'))
    } catch {
      toast(t('pair.copyFailed'))
    }
  }
  $('btnPairDone').onclick = async () => {
    const name = ($('pairRenameInput') as unknown as HTMLInputElement).value.trim()
    if (currentPairingId && name) await postJSON(`/device/${currentPairingId}/rename`, { name }).catch(() => {})
    closePairModal()
    void refresh()
  }

  $('btnDevClose').onclick = () => $('devModal').classList.add('hidden')
  $('btnDevRename').onclick = async () => {
    const name = ($('devRenameInput') as unknown as HTMLInputElement).value.trim()
    if (currentDeviceId && name) {
      await postJSON(`/device/${currentDeviceId}/rename`, { name })
      toast(t('toast.renamed'))
      $('devModal').classList.add('hidden')
      void refresh()
    }
  }
  $('btnDevRevoke').onclick = async () => {
    if (!currentDeviceId) return
    await postJSON(`/device/${currentDeviceId}/revoke`, {})
    toast(t('toast.removed'), t('toast.removedHint'))
    $('devModal').classList.add('hidden')
    void refresh()
  }
  // partage du presse-papiers du PC avec CE téléphone, appliqué aussitôt
  ;($('devClipShare') as unknown as HTMLInputElement).onchange = async () => {
    const box = $('devClipShare') as unknown as HTMLInputElement
    if (!currentDeviceId) return
    try {
      await postJSON(`/device/${currentDeviceId}/clipshare`, { enabled: box.checked })
      toast(t('set.saved'))
    } catch (e) {
      box.checked = !box.checked
      toast((e as Error).message)
    }
    void refresh()
  }
  // lancement à l'ouverture de session : réglage du système, appliqué aussitôt
  ;($('setAutostart') as unknown as HTMLInputElement).onchange = async () => {
    const box = $('setAutostart') as unknown as HTMLInputElement
    try {
      await postJSON('/autostart', { enabled: box.checked })
      toast(t('set.saved'))
    } catch (e) {
      box.checked = !box.checked
      toast(t('set.saveFailed'), (e as Error).message)
    }
    void refresh()
  }
  for (const id of ['fwCard', 'pairFw']) {
    const root = $(id)
    ;(root.querySelector('.fw-fix') as HTMLButtonElement).onclick = () => void firewallRepair()
    ;(root.querySelector('.fw-again') as HTMLButtonElement).onclick = () => void firewallAgain()
    const later = root.querySelector<HTMLButtonElement>('.fw-later')
    if (later)
      later.onclick = () => {
        if (state?.firewall) fwLaterKey = fwKey(state.firewall)
        renderFirewall()
      }
  }
  $('btnRate').onclick = () => void answerRate('rate')
  $('btnRateLater').onclick = () => void answerRate('later')
  $('btnDevShortcut').onclick = () => {
    $('devModal').classList.add('hidden')
    switchView('settings')
    renderShortcutSection()
  }

  $('btnAccept').onclick = () => {
    if (currentApprovalId) void postJSON('/approve', { id: currentApprovalId, accept: true })
    $('apprModal').classList.add('hidden')
  }
  $('btnRefuse').onclick = () => {
    if (currentApprovalId) void postJSON('/approve', { id: currentApprovalId, accept: false })
    $('apprModal').classList.add('hidden')
  }

  // envoi vers téléphone
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  $('dropzone').onclick = () => fileInput.click()
  fileInput.onchange = () => {
    if (fileInput.files?.length) void uploadOutbox(fileInput.files)
    fileInput.value = ''
  }
  let dragDepth = 0
  window.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragDepth++
    $('dropOverlay').classList.remove('hidden')
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) $('dropOverlay').classList.add('hidden')
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    $('dropOverlay').classList.add('hidden')
    if (e.dataTransfer?.files.length) {
      switchView('send')
      void uploadOutbox(e.dataTransfer.files)
    }
  })

  $('btnQueueText').onclick = async () => {
    const ta = $('outText') as unknown as HTMLTextAreaElement
    const text = ta.value.trim()
    if (!text) return
    await postJSON('/outbox/text', { text, to: sendTarget() })
    ta.value = ''
    toast(t('toast.textQueued'), sendTargetLabel() ?? t('up.readyHint'))
    void refresh()
  }
  $('btnPushClip').onclick = async () => {
    try {
      const r = (await postJSON('/clipboard/push', { to: sendTarget() })) as { preview?: string }
      toast(t('toast.clipPushed'), [sendTargetLabel(), r.preview].filter(Boolean).join(' · '))
      void refresh()
    } catch (e) {
      const msg = (e as Error).message
      toast(msg === t('err.clipboardConcealed') ? t('send.concealedTitle') : t('clipboard.empty'), msg)
    }
  }

  $('btnSaveSettings').onclick = async () => {
    try {
      await postJSON('/settings', {
        theme: ($('setTheme') as unknown as HTMLSelectElement).value,
        skin: ($('setSkin') as unknown as HTMLSelectElement).value,
        lang: ($('setLang') as unknown as HTMLSelectElement).value,
        deviceName: ($('setName') as unknown as HTMLInputElement).value,
        downloadDir: ($('setDir') as unknown as HTMLInputElement).value,
        maxFileMB: Number(($('setMax') as unknown as HTMLSelectElement).value),
        requireApproval: ($('setApproval') as unknown as HTMLInputElement).checked,
        clipboardAutoPush: ($('setClipboard') as unknown as HTMLInputElement).checked,
        shortcutsEnabled: ($('setShortcuts') as unknown as HTMLInputElement).checked,
        autoUpdate: ($('setAutoUpdate') as unknown as HTMLInputElement).checked,
        clipHistoryEnabled: ($('setClipHistory') as unknown as HTMLInputElement).checked,
        clipHistoryMaxItems: Number(($('setClipMax') as unknown as HTMLSelectElement).value),
        clipHistoryMaxDays: Number(($('setClipDays') as unknown as HTMLSelectElement).value),
      })
      toast(t('set.saved'))
      void refresh()
    } catch (e) {
      toast(t('set.saveFailed'), (e as Error).message)
    }
  }
  ;($('shortcutDevice') as unknown as HTMLSelectElement).onchange = () => {
    currentDeviceId = ($('shortcutDevice') as unknown as HTMLSelectElement).value
    renderShortcutSection()
  }

  ;($('setTheme') as unknown as HTMLSelectElement).onchange = (e) => {
    applyTheme((e.target as HTMLSelectElement).value as 'system' | 'light' | 'dark')
  }
  ;($('setSkin') as unknown as HTMLSelectElement).onchange = (e) => {
    applyPlatformSkin((e.target as HTMLSelectElement).value as 'auto' | 'apple' | 'windows')
  }
  // langue : bascule en direct ET persiste tout de suite (sinon renderAll/refresh
  // ré-alignent la langue sur state.config.lang et annulent le changement).
  ;($('setLang') as unknown as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value as 'auto' | 'fr' | 'en' | 'de'
    lang = resolveLang(v, langFrom(navigator.language))
    applyI18n(lang)
    if (state) {
      state.config.lang = v
      renderAll()
    }
    void postJSON('/settings', { lang: v }).catch(() => {})
  }
  $('btnResetPc').onclick = async () => {
    if (!confirm(t('reset.confirm'))) return
    try {
      await postJSON('/reset', {})
      toast(t('reset.done'), t('reset.doneHint'))
      void refresh()
    } catch (e) {
      toast(t('reset.failed'), (e as Error).message)
    }
  }

  const REPO = 'https://github.com/MrFrosas/flitdrop'
  const openIssue = (kind: 'bug' | 'idea') => {
    const title = kind === 'bug' ? t('help.issueBug') : t('help.issueIdea')
    const os = navigator.platform || ''
    const body = `\n\n---\n${t('help.version')} : v${state?.version ?? ''} · ${os}`
    void postJSON('/open-url', {
      url: `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
    }).catch(() => toast(t('common.copyFailed')))
  }
  $('btnReportBug').onclick = () => openIssue('bug')
  $('btnSuggest').onclick = () => openIssue('idea')
  // les deux niveaux sont liés : le détaillé inclut la base, couper la base
  // coupe aussi le détaillé
  const basicBox = $('setBasicStats') as unknown as HTMLInputElement
  const fullBox = $('setTelemetry') as unknown as HTMLInputElement
  basicBox.onchange = () => {
    if (!basicBox.checked) fullBox.checked = false
  }
  fullBox.onchange = () => {
    if (fullBox.checked) basicBox.checked = true
  }
  $('btnSavePrivacy').onclick = async () => {
    const choice = fullBox.checked ? 'full' : basicBox.checked ? 'basic_only' : 'none'
    try {
      await chooseTelemetry(choice, 'settings')
      toast(t('help.savedPref'))
    } catch (e) {
      toast(t('set.saveFailed'), (e as Error).message)
    }
    void refresh()
  }
  // la carte ne disparaît et « Choix enregistré » ne s'affiche qu'une fois le
  // choix réellement enregistré ; sinon la question reste posée
  const answerCard = (choice: 'full' | 'basic_only') => async () => {
    try {
      await chooseTelemetry(choice, 'prompt')
      $('consentCard').classList.add('hidden')
      toast(t('consent.saved'))
    } catch (e) {
      toast(t('set.saveFailed'), (e as Error).message)
    }
    void refresh()
  }
  $('btnMacUpdate').onclick = () => void hostAction('openMacUpdate')
  $('btnMacUpdateLater').onclick = () => {
    macUpdateLater = macUpdateKey(state?.host?.macUpdate)
    renderHost()
  }
  $('btnLoginItems').onclick = () => void hostAction('openLoginItems')
  $('btnConsentYes').onclick = answerCard('full')
  $('btnConsentNo').onclick = answerCard('basic_only')
  for (const b of document.querySelectorAll<HTMLElement>('[data-privacy-link]')) b.onclick = openPrivacy

  const clipSearch = $('clipSearch') as unknown as HTMLInputElement
  clipSearch.oninput = () => {
    clipFilter = clipSearch.value
    renderClipHistory()
  }
  $('btnClipClear').onclick = async () => {
    await postJSON('/cliphistory/clear', {})
    toast(t('toast.histCleared'))
    void refresh()
  }

  window.addEventListener('resize', renderRadar)
  setInterval(() => {
    if (!document.hidden) renderRadar()
  }, 30_000)
}

async function uploadOutbox(files: FileList) {
  const bar = $('upBar')
  const fill = $('upProgress')
  bar.classList.remove('hidden')
  const fd = new FormData()
  for (const f of files) fd.append('file', f, f.name)
  await new Promise<void>((resolve) => {
    const xhr = new XMLHttpRequest()
    const to = sendTarget()
    xhr.open('POST', '/api/admin/outbox/file' + (to ? `?to=${encodeURIComponent(to)}` : ''))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + '%'
    }
    xhr.onload = () => {
      bar.classList.add('hidden')
      fill.style.width = '0%'
      if (xhr.status === 200) {
        toast(tp(lang, 'up.filesReady', files.length), sendTargetLabel() ?? t('up.readyHint'))
      } else {
        toast(t('up.failed'), `code ${xhr.status}`)
      }
      void refresh()
      resolve()
    }
    xhr.onerror = () => {
      bar.classList.add('hidden')
      toast('Échec de l’envoi')
      resolve()
    }
    xhr.send(fd)
  })
}

// ---------- démarrage ----------

function maybeWelcome() {
  // nouvelle installation (aucun réglage enregistré) dans l'app de bureau :
  // la question du lancement à l'ouverture de session, cochée par défaut,
  // n'est appliquée qu'au moment où la personne continue
  const autostartOffer = typeof state?.autostart === 'boolean' && state.config.autostartAsked === false
  if (localStorage.getItem('fd_onboard') === '1' && !autostartOffer) return
  $('welcomeModal').classList.remove('hidden')
  $('welcomeAutostart').classList.toggle('hidden', !autostartOffer)
  renderConsentCard()
  renderRate()
  // la question n'est posée qu'une fois : déjà répondue, on ne la remontre pas
  const asked = state?.config.telemetryAsked === true
  $('welcomeConsent').classList.toggle('hidden', asked)
  // welcome_shown est un événement détaillé : sans accord il est ignoré par le
  // serveur, on le renvoie donc au moment où la personne dit oui.
  uiEvent('welcome_shown')
  noticeSeen()
  const answer = (choice: 'full' | 'basic_only') => async () => {
    try {
      await chooseTelemetry(choice, 'welcome')
    } catch (e) {
      // pas enregistré : la question reste affichée, on peut réessayer
      toast(t('set.saveFailed'), (e as Error).message)
      return
    }
    $('welcomeConsent').classList.add('hidden')
    $('welcomeConsentDone').classList.remove('hidden')
    if (choice === 'full') uiEvent('welcome_shown')
  }
  $('btnConsentYesW').onclick = answer('full')
  $('btnConsentNoW').onclick = answer('basic_only')
  const close = () => {
    localStorage.setItem('fd_onboard', '1')
    $('welcomeModal').classList.add('hidden')
    if (autostartOffer) {
      const enabled = ($('welcomeAutostartBox') as unknown as HTMLInputElement).checked
      if (state) state.config.autostartAsked = true
      void postJSON('/autostart', { enabled })
        .catch(() => {})
        .then(() => refresh())
    }
    // pas de réponse dans l'accueil : la carte reprend la question, une fois
    renderConsentCard()
    renderRate()
  }
  $('btnWelcome').onclick = () => {
    uiEvent('welcome_pair_clicked')
    close()
    void openPairModal()
  }
  $('btnWelcomeSkip').onclick = () => {
    uiEvent('welcome_skipped')
    close()
  }
}

// ---------- rapports d'erreur de la page ----------

/** Erreurs de cette page remontées au serveur local, qui les nettoie, les
 *  limite et ne les transmet qu'avec l'accord « statistiques détaillées ». */
function reportPageError(err: unknown) {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null
  const error = {
    type: typeof e?.name === 'string' ? e.name : 'Error',
    message: typeof e?.message === 'string' ? e.message : String(err ?? ''),
    stack: typeof e?.stack === 'string' ? e.stack : '',
  }
  void postJSON('/telemetry/event', { event: '$exception', error }).catch(() => {})
}
window.addEventListener('error', (ev) => reportPageError(ev.error ?? ev.message))
window.addEventListener('unhandledrejection', (ev) => reportPageError(ev.reason))

// OS hôte réel (transmis par l'app de bureau via ?os=, ou détecté dans le
// navigateur en dev). Sert de valeur par défaut pour le style « Automatique ».
let hostOs: 'mac' | 'win' = 'win'
function detectHostOs() {
  const param = new URLSearchParams(location.search).get('os')
  hostOs = (param ? param === 'mac' : /Mac/i.test(navigator.platform)) ? 'mac' : 'win'
}

/** Applique le style : 'auto' suit l'OS réel (mac = macOS, win = Windows 11),
 *  ou on force Apple/Windows quel que soit le système. */
function applyPlatformSkin(skin: 'auto' | 'apple' | 'windows' = 'auto') {
  const resolved = skin === 'apple' ? 'mac' : skin === 'windows' ? 'win' : hostOs
  document.documentElement.setAttribute('data-platform', resolved)
}

detectHostOs()
applyI18n(lang)
applyPlatformSkin()
initUI()
history.replaceState(null, '', location.pathname)
void refresh().then(() => {
  connectWS()
  maybeWelcome()
})
