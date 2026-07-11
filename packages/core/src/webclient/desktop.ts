import { initTelemetry, setTelemetryConsent, track } from './telemetry.js'
import { t as tr, tp, rtf, fmtBytes, resolveLang, langFrom, type Lang } from '../i18n.js'
import { applyI18n } from '../i18n-dom.js'

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
    telemetryConsent: boolean
    port: number
  }
  hostname: string
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
    sub.textContent = [item.kind === 'file' ? fmtSize(item.size ?? 0) : t('hist.text'), picked ? t('outbox.downloaded') : t('outbox.waiting'), rel(item.createdAt)].join(' · ')
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
  ;($('setTelemetry') as unknown as HTMLInputElement).checked = state.config.telemetryConsent
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
    btnPhone.onclick = () => void postJSON(`/cliphistory/${e.id}/tophone`, {}).then(() => toast(t('clip.readyPhone'), t('clip.recvTab'))).catch(() => {})
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
  renderOutbox()
  renderClipHistory()
  renderSettings()
}

let telemetryStarted = false
async function refresh() {
  state = await api<State>('/state')
  renderAll()
  if (!telemetryStarted && state) {
    telemetryStarted = true
    initTelemetry({ consent: state.config.telemetryConsent, version: state.version })
    const os = document.documentElement.getAttribute('data-platform') ?? 'win'
    track('app_open', { os })
  } else if (state) {
    setTelemetryConsent(state.config.telemetryConsent)
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
        if (currentPairingId && (data as { id?: string }).id === currentPairingId) {
          const st = $('pairState')
          st.classList.add('ok')
          st.textContent = t('pair.connected')
          $('pairRenameRow').classList.remove('hidden')
          ;($('pairRenameInput') as unknown as HTMLInputElement).value = (data as { name?: string }).name ?? ''
        }
        toast(t('toast.devicePaired'), (data as { name?: string }).name)
        void refresh()
        break
      }
      case 'device-online':
      case 'device-revoked':
      case 'settings-changed':
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
  $('devModal').classList.remove('hidden')
}

async function openPairModal() {
  const res = await api<{ deviceId: string; url: string }>('/pair/new', { method: 'POST' })
  currentPairingId = res.deviceId
  currentPairUrl = res.url
  ;($('qrImg') as unknown as HTMLImageElement).src = `/api/admin/pair/${res.deviceId}/qr.svg`
  $('pairUrlText').textContent = res.url.split('#')[0] + t('pair.orScan')
  const st = $('pairState')
  st.classList.remove('ok')
  st.innerHTML = '<span class="spin"></span>' + t('pair.waiting')
  $('pairRenameRow').classList.add('hidden')
  $('pairModal').classList.remove('hidden')
}

// ---------- interactions ----------

function initUI() {
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view ?? 'radar')
  })

  $('btnPair').onclick = () => void openPairModal()
  $('btnPair2').onclick = () => void openPairModal()
  $('btnPairCancel').onclick = () => {
    currentPairingId = null
    $('pairModal').classList.add('hidden')
  }
  $('btnCopyPairLink').onclick = async () => {
    if (!currentPairUrl) return
    try {
      await navigator.clipboard.writeText(currentPairUrl)
      toast(t('pair.linkCopied'), t('pair.linkCopiedHint'))
    } catch {
      toast(t('pair.copyFailed'))
    }
  }
  $('btnPairDone').onclick = async () => {
    const name = ($('pairRenameInput') as unknown as HTMLInputElement).value.trim()
    if (currentPairingId && name) await postJSON(`/device/${currentPairingId}/rename`, { name }).catch(() => {})
    currentPairingId = null
    $('pairModal').classList.add('hidden')
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
    await postJSON('/outbox/text', { text })
    ta.value = ''
    toast(t('toast.textQueued'), t('up.readyHint'))
    void refresh()
  }
  $('btnPushClip').onclick = async () => {
    try {
      const r = (await postJSON('/clipboard/push', {})) as { preview?: string }
      toast(t('toast.clipPushed'), r.preview)
      void refresh()
    } catch (e) {
      toast(t('clipboard.empty'), (e as Error).message)
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
  $('btnSavePrivacy').onclick = async () => {
    await postJSON('/settings', { telemetryConsent: ($('setTelemetry') as unknown as HTMLInputElement).checked })
    toast(t('help.savedPref'))
    void refresh()
  }

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
  setInterval(renderRadar, 30_000)
}

async function uploadOutbox(files: FileList) {
  const bar = $('upBar')
  const fill = $('upProgress')
  bar.classList.remove('hidden')
  const fd = new FormData()
  for (const f of files) fd.append('file', f, f.name)
  await new Promise<void>((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/admin/outbox/file')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + '%'
    }
    xhr.onload = () => {
      bar.classList.add('hidden')
      fill.style.width = '0%'
      if (xhr.status === 200) {
        toast(tp(lang, 'up.filesReady', files.length), t('up.readyHint'))
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
  if (localStorage.getItem('fd_onboard') === '1') return
  $('welcomeModal').classList.remove('hidden')
  $('btnWelcome').onclick = () => {
    localStorage.setItem('fd_onboard', '1')
    $('welcomeModal').classList.add('hidden')
    void openPairModal()
  }
  $('btnWelcomeSkip').onclick = () => {
    localStorage.setItem('fd_onboard', '1')
    $('welcomeModal').classList.add('hidden')
  }
}

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
