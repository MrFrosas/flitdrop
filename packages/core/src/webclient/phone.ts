import { b64uToBytes, seal, sealJSON, openJSON, open, jti, fmtSize } from './wdcrypto.js'

interface Pairing {
  id: string
  keyB64: string
}
interface HelloRes {
  desktopName: string
  maxFileMB: number
  chunkSize: number
  requireApproval: boolean
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
const SEND_CHUNK = 4 * 1024 * 1024

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
    readonly status: number
  ) {
    super(msg)
  }
}

async function post<T>(path: string, purpose: string, obj: Record<string, unknown>): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
    body: envelope(purpose, obj),
  })
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string }
    throw new ApiFail(j.error || `erreur ${r.status}`, r.status)
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

/** Adapte l'apparence au système du téléphone : Apple (iOS/iPadOS) ou Android.
 *  Chaque OS reçoit sa police système, ses couleurs et ses formes natives. */
function applyOsSkin() {
  const { platform } = platformLabel()
  const os = platform === 'android' ? 'android' : platform === 'web' ? 'web' : 'apple'
  document.documentElement.setAttribute('data-os', os)
}

// ---------- appairage ----------

function loadPairing(): Pairing | null {
  const h = location.hash.slice(1)
  if (h && h.includes('.')) {
    const dot = h.indexOf('.')
    const p: Pairing = { id: h.slice(0, dot), keyB64: h.slice(dot + 1) }
    if (p.id.length >= 8 && p.keyB64.length >= 40) {
      localStorage.setItem(PAIR_KEY, JSON.stringify(p))
      history.replaceState(null, '', location.pathname)
      return p
    }
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
  title.textContent = 'Le PC a peut-être changé d’adresse. Essaie :'
  box.appendChild(title)
  for (const h of alts.slice(0, 4)) {
    const a = document.createElement('a')
    a.className = 'btn wide'
    a.textContent = `Se reconnecter via ${h.split(':')[0]}`
    a.href = `http://${h}/s/#${pair.id}.${pair.keyB64}`
    box.appendChild(a)
  }
}

async function connect() {
  const { platform, label } = platformLabel()
  try {
    hello = await post<HelloRes>('/api/phone/hello', 'hello', { deviceLabel: label, platform })
    $('pcName').textContent = hello.desktopName
    $('statusDot').classList.remove('off')
    $('menuInfo').textContent = `Ce téléphone est appairé à « ${hello.desktopName} ». Les envois sont chiffrés de bout en bout.`
    if (hello.hosts?.length) {
      const merged = [location.host, ...hello.hosts].filter((v, i, arr) => arr.indexOf(v) === i)
      localStorage.setItem(HOSTS_KEY, JSON.stringify(merged.slice(0, 6)))
    }
    show('main')
    startPolling()
  } catch (e) {
    const err = e as ApiFail
    if (err.status === 403) {
      $('errTitle').textContent = 'Appairage refusé'
      $('errMsg').textContent = 'Ce téléphone a été retiré sur le PC. Re-scanne un QR code pour le reconnecter.'
      $('altHosts').classList.add('hidden')
    } else {
      $('errTitle').textContent = 'PC introuvable'
      $('errMsg').textContent = 'Vérifie que Flitdrop est ouvert sur le PC et que ton téléphone est sur le même wifi.'
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
    <div class="qstate">En attente…</div>`
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
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      throw new ApiFail(j.error || `erreur ${r.status}`, r.status)
    } catch (e) {
      lastErr = e
      if (e instanceof ApiFail && e.status !== 429 && e.status < 500) throw e
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function transferStatus(tid: string): Promise<{ received: number; chunks: number } | null> {
  const r = await fetch(`/api/phone/transfer/${tid}/status`, { headers: { 'x-wd-device': pair!.id } })
  if (!r.ok) return null
  return (await r.json()) as { received: number; chunks: number }
}

async function sendFile(file: File): Promise<void> {
  const ui = queueItem(file.name || 'fichier', file.size)
  if (file.size === 0) {
    ui.li.classList.add('err')
    ui.state.textContent = 'Fichier vide, ignoré'
    return
  }
  const maxBytes = (hello?.maxFileMB ?? 8192) * 1024 * 1024
  if (file.size > maxBytes) {
    ui.li.classList.add('err')
    ui.state.textContent = `Trop volumineux (limite ${fmtSize(maxBytes)})`
    return
  }
  const chunkSize = SEND_CHUNK
  const chunks = Math.ceil(file.size / chunkSize)
  try {
    const init = await post<{ transferId: string }>('/api/phone/transfer/init', 'init', {
      meta: { name: file.name || 'fichier', size: file.size, mime: file.type || undefined, chunkSize, chunks },
    })
    const tid = init.transferId
    const started = Date.now()
    let n = 0
    let resumes = 0
    // boucle reprennable : si le réseau coupe (téléphone en veille, wifi perdu),
    // on demande au PC combien de morceaux il a reçus et on repart de là : sans
    // renvoyer ce qui est déjà arrivé.
    while (n < chunks) {
      try {
        const slice = file.slice(n * chunkSize, Math.min((n + 1) * chunkSize, file.size))
        const plain = new Uint8Array(await slice.arrayBuffer())
        const sealed = seal(key!, plain, aad('chunk', `${tid}|${n}`))
        await sendChunk(tid, n, sealed)
        n++
        const sent = Math.min(file.size, n * chunkSize)
        const pct = Math.round((sent / file.size) * 100)
        ui.bar.style.width = pct + '%'
        const speed = sent / Math.max(0.4, (Date.now() - started) / 1000)
        ui.state.textContent = `${pct} % · ${fmtSize(speed)}/s`
      } catch (e) {
        const err = e as ApiFail
        // erreur définitive (refus, transfert perdu) : on abandonne
        if (err.status && err.status !== 429 && err.status < 500 && err.status !== 408) throw e
        if (resumes >= 30) throw e
        resumes++
        ui.state.textContent = 'Connexion perdue, reprise…'
        await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * resumes)))
        // reprendre à l'octet près : on redemande la position au PC
        const st = await transferStatus(tid).catch(() => null)
        if (st) n = st.received
      }
    }
    await post(`/api/phone/transfer/${tid}/finish`, 'finish', { transferId: tid })
    ui.bar.style.width = '100%'
    ui.li.classList.add('done')
    ui.state.textContent = `Arrivé sur ${hello?.desktopName ?? 'le PC'} ✓`
  } catch (e) {
    const err = e as ApiFail
    ui.li.classList.add('err')
    ui.state.textContent =
      err.status === 403 && /refus/i.test(err.message)
        ? 'Refusé sur le PC'
        : err.message === 'Failed to fetch'
          ? 'Connexion perdue, réessaie'
          : err.message || 'Échec de l’envoi'
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
    summary.innerHTML = `Envoi <b>${done + 1}/${list.length}</b>…`
    await sendFile(f)
    done++
  }
  summary.innerHTML = list.length > 1 ? `<b>${list.length}</b> fichiers traités` : ''
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
        <div class="qhead"><div class="qicon">✂</div><div class="qname">Texte du PC</div>
        <button class="qbtn">Copier</button></div>
        <div class="rtext"></div>`
      ;(li.querySelector('.rtext') as HTMLElement).textContent = item.text ?? ''
      ;(li.querySelector('.qbtn') as HTMLButtonElement).onclick = () => {
        const ok = copyText(item.text ?? '')
        downloadedIds.add(item.id)
        li.classList.add('done')
        toast(ok ? 'Copié dans ton presse-papiers ✓' : 'Sélectionne le texte pour le copier')
      }
    } else {
      li.innerHTML = `
        <div class="qhead"><div class="qicon">↓</div><div class="qname"></div><div class="qsize"></div>
        <button class="qbtn">Ouvrir</button></div>
        <div class="qbar hidden"><span></span></div>
        <div class="qstate hidden"></div>`
      ;(li.querySelector('.qname') as HTMLElement).textContent = item.name ?? 'fichier'
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
  state.textContent = 'Téléchargement…'
  try {
    const r = await fetch(`/api/phone/outbox/${item.id}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': pair!.id },
      body: envelope('download', { itemId: item.id }),
    })
    if (!r.ok || !r.body) throw new Error('téléchargement impossible')
    const reader = r.body.getReader()
    let buf = new Uint8Array(0)
    const parts: Uint8Array[] = []
    let frameIndex = 0
    let received = 0
    const total = item.size ?? 0
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        const merged = new Uint8Array(buf.length + value.length)
        merged.set(buf, 0)
        merged.set(value, buf.length)
        buf = merged
        for (;;) {
          if (buf.length < 4) break
          const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0)
          if (buf.length < 4 + len) break
          const sealed = buf.subarray(4, 4 + len)
          const plain = open(key!, sealed, aad('dl', `${item.id}|${frameIndex}`))
          parts.push(plain)
          received += plain.length
          frameIndex++
          buf = buf.slice(4 + len)
          if (total > 0) {
            barFill.style.width = Math.round((received / total) * 100) + '%'
            state.textContent = `${Math.round((received / total) * 100)} %`
          }
        }
      }
      if (done) break
    }
    if (total > 0 && received !== total) throw new Error('transfert incomplet, réessaie')
    const blob = new Blob(parts as BlobPart[], { type: item.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    downloadedIds.add(item.id)
    li.classList.add('done')
    state.textContent = 'Reçu ✓'
    if ((item.mime ?? '').startsWith('image/')) {
      const img = $('imgPreview') as HTMLImageElement
      img.src = url
      $('imgModal').classList.remove('hidden')
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = item.name ?? 'fichier'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast('Fichier téléchargé ✓')
    }
  } catch (e) {
    state.textContent = (e as Error).message || 'Échec du téléchargement'
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

// ---------- interactions ----------

function initUI() {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      for (const p of ['send', 'text', 'recv']) $(`panel-${p}`).classList.toggle('hidden', p !== tab.dataset.tab)
      if (tab.dataset.tab === 'recv') void pollOutbox()
    }
  }

  const picker = $('filepick') as unknown as HTMLInputElement
  $('btnPick').onclick = () => picker.click()
  picker.onchange = () => {
    if (picker.files?.length) void sendFiles(picker.files)
    picker.value = ''
  }

  const txt = $('txtInput') as unknown as HTMLTextAreaElement
  txt.oninput = () => {
    const n = txt.value.length
    $('txtCount').textContent = n === 0 ? '0 caractère' : n === 1 ? '1 caractère' : `${n} caractères`
  }
  $('btnSendText').onclick = async () => {
    const value = txt.value.trim()
    if (!value) return
    const btn = $('btnSendText') as unknown as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Envoi…'
    try {
      await post('/api/phone/text', 'text', { text: value, mode: 'clip' })
      btn.textContent = 'Dans le presse-papiers du PC ✓'
      txt.value = ''
      txt.dispatchEvent(new Event('input'))
      setTimeout(() => {
        btn.textContent = 'Envoyer sur le PC'
        btn.disabled = false
      }, 2200)
    } catch (e) {
      btn.textContent = 'Envoyer sur le PC'
      btn.disabled = false
      toast((e as Error).message || 'Échec de l’envoi')
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
  $('btnInstall').onclick = () => {
    $('menuSheet').classList.add('hidden')
    const { platform } = platformLabel()
    $('installSteps').textContent =
      platform === 'iphone' || platform === 'ipad'
        ? 'Dans Safari : bouton Partager (le carré avec une flèche), puis « Sur l’écran d’accueil ». L’icône Flitdrop apparaît comme une app, connectée à ton PC, sans re-scanner le QR code.'
        : 'Dans Chrome : menu ⋮ en haut à droite, puis « Ajouter à l’écran d’accueil ». L’icône Flitdrop apparaît comme une app, connectée à ton PC, sans re-scanner le QR code.'
    $('installSheet').classList.remove('hidden')
  }
  $('installClose').onclick = () => $('installSheet').classList.add('hidden')
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

applyOsSkin()
initUI()
pair = loadPairing()
if (!pair) {
  show('scan')
} else {
  key = b64uToBytes(pair.keyB64)
  void connect()
}
