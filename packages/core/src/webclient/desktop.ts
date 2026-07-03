import { fmtSize } from './wdcrypto.js'

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
interface State {
  product: string
  version: string
  config: { deviceName: string; downloadDir: string; maxFileMB: number; requireApproval: boolean; clipboardAutoPush: boolean; port: number }
  hostname: string
  ips: string[]
  devices: DevicePub[]
  history: HistEntry[]
  outbox: OutboxEntry[]
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let state: State | null = null
let currentPairingId: string | null = null
let currentDeviceId: string | null = null
const progressCards = new Map<string, { li: HTMLLIElement; bar: HTMLSpanElement; sub: HTMLElement }>()

// ---------- utilitaires ----------

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch('/api/admin' + path, init)
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(j.error || `erreur ${r.status}`)
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

function rel(ts?: string): string {
  if (!ts) return 'jamais vu'
  const d = Date.now() - Date.parse(ts)
  if (d < 45_000) return 'à l’instant'
  if (d < 3_600_000) return `il y a ${Math.round(d / 60_000)} min`
  if (d < 86_400_000) return `il y a ${Math.round(d / 3_600_000)} h`
  return `il y a ${Math.round(d / 86_400_000)} j`
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copié ✓')
  } catch {
    toast('Impossible de copier')
  }
}

// ---------- rendu ----------

const VIEW_TITLES: Record<string, string> = {
  radar: 'Radar',
  activity: 'Historique',
  send: 'Envoyer vers le téléphone',
  settings: 'Réglages',
}

function switchView(view: string) {
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  for (const v of Object.keys(VIEW_TITLES)) $(`view-${v}`).classList.toggle('hidden', v !== view)
  $('viewTitle').textContent = VIEW_TITLES[view] ?? 'Flitdrop'
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
    ava.textContent = (d.name.trim()[0] ?? '?').toUpperCase()
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
    name.textContent = e.kind === 'file' ? (e.name ?? 'fichier') : (e.preview ?? 'texte')
    const sub = document.createElement('div')
    sub.className = 'hsub'
    const what = e.kind === 'file' ? fmtSize(e.size ?? 0) : e.kind === 'clip' ? 'presse-papiers' : 'texte'
    const who = e.deviceName ? (e.dir === 'in' ? `depuis ${e.deviceName}` : `vers ${e.deviceName}`) : ''
    sub.textContent = [what, who, rel(e.ts), e.error ?? ''].filter(Boolean).join(' · ')
    main.append(name, sub)
    li.append(icon, main)
    if (e.dir === 'in' && e.kind === 'file' && e.status === 'ok') {
      const b = document.createElement('button')
      b.className = 'hbtn'
      b.textContent = 'Ouvrir le dossier'
      b.onclick = () => void postJSON('/open-folder', {}).catch(() => toast('Impossible d’ouvrir le dossier'))
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
    name.textContent = item.kind === 'text' ? (item.preview ?? 'texte') : (item.name ?? 'fichier')
    const sub = document.createElement('div')
    sub.className = 'hsub'
    const picked = Object.keys(item.downloads).length > 0
    sub.textContent = [item.kind === 'file' ? fmtSize(item.size ?? 0) : 'texte', picked ? 'récupéré ✓' : 'en attente', rel(item.createdAt)].join(' · ')
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

function renderSettings() {
  if (!state) return
  ;($('setName') as unknown as HTMLInputElement).value = state.config.deviceName
  ;($('setDir') as unknown as HTMLInputElement).value = state.config.downloadDir
  ;($('setMax') as unknown as HTMLSelectElement).value = String(state.config.maxFileMB)
  ;($('setApproval') as unknown as HTMLInputElement).checked = state.config.requireApproval
  ;($('setClipboard') as unknown as HTMLInputElement).checked = state.config.clipboardAutoPush
  renderShortcutSection()
}

function renderShortcutSection() {
  if (!state) return
  const sel = $('shortcutDevice') as unknown as HTMLSelectElement
  const previous = currentDeviceId ?? sel.value
  sel.innerHTML = ''
  const active = state.devices.filter((d) => d.status === 'active')
  if (active.length === 0) {
    const opt = document.createElement('option')
    opt.textContent = 'Appaire d’abord un téléphone'
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
    { lbl: 'Envoyer des fichiers', url: `${base}/api/shortcut/upload?t=${dev.shortcutToken}` },
    { lbl: 'Coller sur le PC', url: `${base}/api/shortcut/text?t=${dev.shortcutToken}` },
    { lbl: 'Lire le presse-papiers du PC', url: `${base}/api/shortcut/clipboard?t=${dev.shortcutToken}` },
    { lbl: 'Secours si .local ne répond pas', url: `${ipBase}/api/shortcut/upload?t=${dev.shortcutToken}` },
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
    btn.textContent = 'Copier'
    btn.onclick = () => void copy(r.url)
    row.append(lbl, url, btn)
    box.appendChild(row)
  }
}

function renderAll() {
  if (!state) return
  $('pcNameHead').textContent = state.config.deviceName
  $('pcNodeName').textContent = state.config.deviceName
  $('netInfo').textContent = `${state.ips[0] ?? '127.0.0.1'}:${state.config.port}`
  $('versionTag').textContent = 'v' + state.version
  renderRadar()
  renderHistory()
  renderOutbox()
  renderSettings()
}

async function refresh() {
  state = await api<State>('/state')
  renderAll()
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
  sub.textContent = `Réception depuis ${d.deviceName}…`
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
  sub.textContent = `${fmtSize(d.size)} · depuis ${d.deviceName}`
  const btn = document.createElement('button')
  btn.className = 'hbtn'
  btn.textContent = 'Ouvrir le dossier'
  btn.onclick = () => void postJSON('/open-folder', {}).catch(() => toast('Impossible d’ouvrir le dossier'))
  li.append(head, sub, btn)
  progressCards.delete(d.id)
}

function feedText(d: { deviceName: string; mode: string; copied: boolean; text: string }) {
  const li = feedCardBase()
  const head = document.createElement('div')
  head.className = 'fhead'
  const name = document.createElement('div')
  name.className = 'fname'
  name.textContent = d.copied ? 'Texte copié dans ton presse-papiers ✓' : `Texte reçu de ${d.deviceName}`
  head.appendChild(name)
  const sub = document.createElement('div')
  sub.className = 'fsub'
  sub.textContent = `depuis ${d.deviceName}`
  const txt = document.createElement('div')
  txt.className = 'ftext'
  txt.textContent = d.text
  const btn = document.createElement('button')
  btn.className = 'hbtn'
  btn.textContent = 'Copier à nouveau'
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
          st.textContent = 'Téléphone connecté ✓'
          $('pairRenameRow').classList.remove('hidden')
          ;($('pairRenameInput') as unknown as HTMLInputElement).value = (data as { name?: string }).name ?? ''
        }
        toast('Nouvel appareil appairé', (data as { name?: string }).name)
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
        $('apprText').textContent = `${d.deviceName} veut envoyer « ${d.name} » (${fmtSize(d.size)}).`
        $('apprModal').classList.remove('hidden')
        break
      }
      case 'approval-expired':
        if (currentApprovalId === (data as { id?: string }).id) $('apprModal').classList.add('hidden')
        break
      case 'outbox-downloaded': {
        const d = data as { name?: string; deviceName?: string }
        toast('Récupéré sur le téléphone ✓', d.name ? `${d.name} · ${d.deviceName}` : d.deviceName)
        void refresh()
        break
      }
      case 'outbox-changed':
        void refresh()
        break
      case 'clip-autopushed':
        toast('Presse-papiers synchronisé ✓', (data as { preview?: string }).preview)
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
  $('devSeen').textContent = `Appairé ${rel(dev.createdAt)} · vu ${rel(dev.lastSeenAt)}. Les échanges avec cet appareil sont chiffrés de bout en bout.`
  ;($('devRenameInput') as unknown as HTMLInputElement).value = dev.name
  $('devModal').classList.remove('hidden')
}

async function openPairModal() {
  const res = await api<{ deviceId: string; url: string }>('/pair/new', { method: 'POST' })
  currentPairingId = res.deviceId
  ;($('qrImg') as unknown as HTMLImageElement).src = `/api/admin/pair/${res.deviceId}/qr.svg`
  $('pairUrlText').textContent = res.url.split('#')[0] + '  (ou scanne le QR code)'
  const st = $('pairState')
  st.classList.remove('ok')
  st.innerHTML = '<span class="spin"></span>En attente du scan…'
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
      toast('Appareil renommé ✓')
      $('devModal').classList.add('hidden')
      void refresh()
    }
  }
  $('btnDevRevoke').onclick = async () => {
    if (!currentDeviceId) return
    await postJSON(`/device/${currentDeviceId}/revoke`, {})
    toast('Appareil retiré', 'Il ne peut plus rien envoyer vers ce PC.')
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
    toast('Texte mis à disposition ✓', 'Onglet « Recevoir » sur le téléphone.')
    void refresh()
  }
  $('btnPushClip').onclick = async () => {
    try {
      const r = (await postJSON('/clipboard/push', {})) as { preview?: string }
      toast('Presse-papiers envoyé ✓', r.preview)
      void refresh()
    } catch (e) {
      toast('Presse-papiers vide', (e as Error).message)
    }
  }

  $('btnSaveSettings').onclick = async () => {
    try {
      await postJSON('/settings', {
        deviceName: ($('setName') as unknown as HTMLInputElement).value,
        downloadDir: ($('setDir') as unknown as HTMLInputElement).value,
        maxFileMB: Number(($('setMax') as unknown as HTMLSelectElement).value),
        requireApproval: ($('setApproval') as unknown as HTMLInputElement).checked,
        clipboardAutoPush: ($('setClipboard') as unknown as HTMLInputElement).checked,
      })
      toast('Réglages enregistrés ✓')
      void refresh()
    } catch (e) {
      toast('Réglage refusé', (e as Error).message)
    }
  }
  ;($('shortcutDevice') as unknown as HTMLSelectElement).onchange = () => {
    currentDeviceId = ($('shortcutDevice') as unknown as HTMLSelectElement).value
    renderShortcutSection()
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
        toast(files.length > 1 ? `${files.length} fichiers prêts ✓` : 'Fichier prêt ✓', 'Onglet « Recevoir » sur le téléphone.')
      } else {
        toast('Échec de l’envoi', `code ${xhr.status}`)
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

initUI()
history.replaceState(null, '', location.pathname)
void refresh().then(() => {
  connectWS()
  maybeWelcome()
})
