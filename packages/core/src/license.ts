// Flitdrop Pro : ce à quoi cette installation a droit (« plan »), et tout ce
// qui y mène : mode payant (interrupteur du serveur), essai de 14 jours,
// limite de 30 fichiers par jour, achat, restauration, renouvellement du
// jeton de licence. Côté Node uniquement : la page du téléphone peut être
// modifiée, la page du PC aussi ; seul ce module décide.
//
// Plans :
// - « off » : mode payant coupé (défaut, ou flitdrop.com jamais joint) :
//   EXACTEMENT le comportement d'avant Flitdrop Pro, tout est ouvert, aucune
//   interface Pro.
// - « trial » : 14 jours de Pro (installation existante : depuis la première
//   fois que l'app voit le mode payant ; installation neuve : depuis le
//   premier lancement).
// - « free » : gratuit pour toujours, 30 fichiers par jour local.
// - « pro » : jeton signé valide (Ed25519, clé publique embarquée), pour CET
//   ordinateur, jusqu'à son échéance + 7 jours hors ligne.
//
// Anti-copie (machine) : l'identifiant d'appareil est une empreinte de
// l'identifiant que le système donne à la machine (machineid.ts). Illisible :
// un identifiant aléatoire gardé dans la config (licenseFallbackId) le
// remplace ; il ne protège alors plus contre la copie de la config sur un
// autre PC où l'identifiant serait aussi illisible (cas rare, accepté).
//
// État de la licence (essai, compteur du jour, jeton, mode payant vu) :
// rangé dans config.licenseState avec une empreinte HMAC-SHA256 dont la clé
// vient de l'identifiant de la machine et d'une constante de l'app. Empreinte
// absente ou fausse (config retouchée à la main, copiée d'un autre PC) :
// l'essai est considéré terminé et le compteur du jour est au maximum. Rien
// d'autre ne se ferme : les fichiers dans la limite et toutes les fonctions
// gratuites marchent, et le lendemain repart d'un compteur neuf et valide.
// Le début de l'essai est aussi noté, signé, en dehors du dossier de config
// (machineid.ts) : effacer la config ne redonne pas un essai neuf.
//
// Réseau : configuration au lancement puis au plus une fois par jour (sur une
// minuterie qui existe déjà, voir server.ts), vérification d'un achat
// seulement pendant que la carte « en attente du paiement » est affichée,
// renouvellement du jeton une fois par jour quand il expire dans moins de
// 10 jours. Toujours avec un délai maximal, jamais bloquant, jamais d'erreur
// remontée à l'interface.
import crypto from 'node:crypto'
import { saveConfig, type Config, type LicenseStateStored } from './config.js'
import { localDay } from './telemetry.js'
import type { Lang } from './i18n.js'
import { LICENSE_PUBLIC_KEY_B64, PAID_MODE_BUILD_DEFAULT } from './license-key.js'
import { readMachineIdentifier, deviceIdFrom, defaultMarkStore, type MarkStore } from './machineid.js'

export const LICENSE_PUBLIC_KEY = LICENSE_PUBLIC_KEY_B64
export const LICENSE_CONFIG_URL = 'https://flitdrop.com/api/license/config'
export const FREE_DAILY_FILES = 30
export const FREE_CLIP_TEXTS = 20
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
export const OFFLINE_GRACE_MS = 7 * DAY_MS
export const RENEW_WITHIN_MS = 10 * DAY_MS
export const CLAIM_POLL_MAX_MS = 30 * 60_000
const CLAIM_MIN_GAP_MS = 4_000
const CLAIM_KEEP_MS = 48 * HOUR_MS
const NET_TIMEOUT_MS = 8_000
const MAX_BODY_CHARS = 64 * 1024
const DEFAULT_TRIAL_DAYS = 14
const DEFAULT_EARLY_DAYS = 30
const DEFAULT_PRICES: Record<string, string> = { EUR: '5,99 €', USD: '$5.99', GBP: '£5.49' }
// constante de l'app mêlée à l'identifiant de la machine pour la clé de
// l'empreinte de l'état (pas un secret absolu : elle est dans l'app ; elle
// rend une retouche à la main de config.json visible)
const STATE_SALT = 'wFFWh6YtojGZ-kIfVRC_i9xuAW_YB0GG'
// en-tête DER d'une clé publique Ed25519 (SubjectPublicKeyInfo) : suivi des
// 32 octets bruts, il donne une clé utilisable par node:crypto
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export type Plan = 'off' | 'trial' | 'free' | 'pro'
export type CardKind = 'limit' | 'trial' | 'waiting' | 'success' | 'used'
export type PromptWhere = 'limit' | 'trial'
export type CheckoutWhere = 'limit' | 'trial' | 'settings'

// ---------- configuration du serveur ----------

/** Configuration publique de /api/license/config, nettoyée. */
export interface RemoteConfig {
  enabled: boolean
  launchedAt: string | null
  /** le serveur a une remise de lancement (earlyDiscountId) */
  earlyDiscount: boolean
  trialDays: number
  earlyDays: number
  displayPrice: Record<string, string>
  /** prix de lancement affichés, s'ils sont fournis (sinon calculés) */
  displayPriceEarly: Record<string, string>
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const intIn = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

/** Prix affichables : devise en 3 lettres, texte court, sans balise. */
function priceMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Z]{3}$/.test(k) || typeof p !== 'string') continue
    const s = p.trim()
    if (s.length > 0 && s.length <= 24 && !/[<>\u0000-\u001f]/.test(s)) out[k] = s
    if (Object.keys(out).length >= 20) break
  }
  return out
}

export function sanitizeRemoteConfig(raw: unknown): RemoteConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean') return null
  return {
    enabled: r.enabled === true,
    launchedAt: isoOrNull(r.launchedAt),
    earlyDiscount: r.earlyDiscount === true || (typeof r.earlyDiscountId === 'string' && r.earlyDiscountId.length > 0),
    trialDays: intIn(r.trialDays, 0, 60, DEFAULT_TRIAL_DAYS),
    earlyDays: intIn(r.earlyDays, 0, 365, DEFAULT_EARLY_DAYS),
    displayPrice: priceMap(r.displayPrice),
    displayPriceEarly: priceMap(r.displayPriceEarly),
  }
}

// ---------- jeton de licence ----------

export interface TokenPayload {
  v: 1
  plan: 'pro'
  dev: string
  cus: string
  iat: number
  exp: number
}

export type TokenCheck = { ok: true; payload: TokenPayload } | { ok: false; reason: 'format' | 'signature' | 'payload' | 'device' }

const keyCache = new Map<string, crypto.KeyObject | null>()
function publicKeyObject(b64: string): crypto.KeyObject | null {
  if (keyCache.has(b64)) return keyCache.get(b64) ?? null
  let k: crypto.KeyObject | null = null
  try {
    const raw = Buffer.from(b64, 'base64')
    if (raw.length === 32) k = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  } catch {
    k = null
  }
  keyCache.set(b64, k)
  return k
}

/** Vérifie un jeton « base64url(JSON).base64url(signature Ed25519) » : forme,
 *  signature, contenu, et appareil (doit être CET ordinateur). L'échéance
 *  n'est pas vérifiée ici (voir tokenUsable). */
export function verifyToken(token: unknown, deviceId: string, publicKeyB64: string = LICENSE_PUBLIC_KEY): TokenCheck {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'format' }
  const [p, s] = token.split('.') as [string, string]
  const payloadBytes = Buffer.from(p, 'base64url')
  const sig = Buffer.from(s, 'base64url')
  const key = publicKeyObject(publicKeyB64)
  if (!key || sig.length !== 64) return { ok: false, reason: 'signature' }
  let good = false
  try {
    good = crypto.verify(null, payloadBytes, key, sig)
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'signature' }
  let j: Record<string, unknown>
  try {
    j = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'payload' }
  }
  if (
    !j ||
    j.v !== 1 ||
    j.plan !== 'pro' ||
    typeof j.dev !== 'string' ||
    !/^[0-9a-f]{32}$/.test(j.dev) ||
    typeof j.cus !== 'string' ||
    typeof j.iat !== 'number' ||
    typeof j.exp !== 'number' ||
    !Number.isFinite(j.iat) ||
    !Number.isFinite(j.exp) ||
    j.exp <= j.iat
  )
    return { ok: false, reason: 'payload' }
  if (j.dev !== deviceId) return { ok: false, reason: 'device' }
  return { ok: true, payload: j as unknown as TokenPayload }
}

/** Jeton encore valable : jusqu'à son échéance, plus 7 jours hors ligne. */
export function tokenUsable(p: TokenPayload, nowMs: number): boolean {
  return nowMs < p.exp * 1000 + OFFLINE_GRACE_MS
}

// ---------- prix ----------

// pays de la zone euro (et ceux qui l'utilisent) : prix en euros
const EURO_REGIONS = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'MC', 'SM', 'VA', 'AD', 'ME', 'XK'])

/** Devise affichée d'après la langue du système (« fr-FR », « en_GB »…). */
export function currencyFor(locale: string | undefined): string {
  const m = String(locale ?? '').replace(/_/g, '-').match(/^([A-Za-z]{2,3})(?:-[A-Za-z]{4})?(?:-([A-Za-z]{2}))?/)
  const lang = (m?.[1] ?? '').toLowerCase()
  const region = (m?.[2] ?? '').toUpperCase()
  if (region === 'GB') return 'GBP'
  if (region === 'US') return 'USD'
  if (EURO_REGIONS.has(region)) return 'EUR'
  if (lang === 'fr' || lang === 'de') return 'EUR'
  return 'USD'
}

/** Moitié d'un prix affiché, arrondie au centime inférieur, dans la même
 *  écriture (« 5,99 € » -> « 2,99 € », « $5.99 » -> « $2.99 »). */
export function halfPrice(display: string): string | null {
  const m = display.match(/(\d+)([.,])(\d{2})/)
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number(m[3])
  const half = Math.floor(cents / 2)
  return display.replace(m[0], `${Math.floor(half / 100)}${m[2]}${String(half % 100).padStart(2, '0')}`)
}

// ---------- dates, dossiers du mois ----------

/** Minuit local suivant : la limite du jour repart à zéro. */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** Dossier du mois, heure locale : « 2026-10 ». */
export function monthFolder(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|dng|raw|cr2|nef|arw|mov|mp4|m4v|avi|3gp|mkv|webm|hevc)$/i

/** Photo ou vidéo, d'après le type annoncé, sinon l'extension du nom. */
export function isMedia(mime: string | undefined, name: string | undefined): boolean {
  if (typeof mime === 'string' && /^(image|video)\//i.test(mime)) return true
  return typeof name === 'string' && MEDIA_EXT.test(name)
}

/** Date d'un fichier envoyée par le téléphone (lastModified, ms), si elle est
 *  plausible ; sinon la date d'arrivée. */
export function photoDate(lastModified: unknown, arrivalMs: number): number {
  const n = typeof lastModified === 'number' ? lastModified : NaN
  if (Number.isFinite(n) && n >= Date.UTC(2000, 0, 1) && n <= arrivalMs + DAY_MS) return n
  return arrivalMs
}

// ---------- état signé ----------

/** État de la licence couvert par l'empreinte. */
export interface LicenseState {
  /** dernier état connu de l'interrupteur du serveur */
  paidMode: boolean
  paidModeSeenAt: string
  trialStartAt: string
  /** '' : essai pas encore décidé ; une date passée : essai terminé */
  trialEndsAt: string
  dailyFiles: { day: string; count: number }
  token: string
}

const blankState = (paidMode: boolean): LicenseState => ({
  paidMode,
  paidModeSeenAt: '',
  trialStartAt: '',
  trialEndsAt: '',
  dailyFiles: { day: '', count: 0 },
  token: '',
})

export function stateKey(machine: string): Buffer {
  return crypto.createHash('sha256').update(`flitdrop-state-v1|${STATE_SALT}|${machine}`).digest()
}

export function stateMac(key: Buffer, deviceId: string, s: LicenseState): string {
  const body = JSON.stringify(['v1', deviceId, s.paidMode, s.paidModeSeenAt, s.trialStartAt, s.trialEndsAt, s.dailyFiles.day, s.dailyFiles.count, s.token])
  return crypto.createHmac('sha256', key).update(body).digest('hex')
}

/** Marque du début de l'essai dans le deuxième emplacement : « v1.<ms>.<empreinte> ». */
export function markValue(key: Buffer, deviceId: string, startMs: number): string {
  const mac = crypto.createHmac('sha256', key).update(`mark|${deviceId}|${startMs}`).digest('hex').slice(0, 32)
  return `v1.${startMs}.${mac}`
}

export function parseMark(key: Buffer, deviceId: string, v: string | null): number | null {
  const m = typeof v === 'string' ? v.match(/^v1\.(\d{10,15})\.([0-9a-f]{32})$/) : null
  if (!m) return null
  const ms = Number(m[1])
  const want = markValue(key, deviceId, ms)
  const a = Buffer.from(v as string)
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? ms : null
}

const macEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const validTs = (v: string): number | null => {
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

/** Adresse e-mail plausible (bornée). */
export function plausibleEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s.length < 6 || s.length > 254 || !/^[^\s@<>"]{1,64}@[^\s@<>"]{1,200}\.[A-Za-z]{2,}$/.test(s)) return null
  return s
}

/** Code de restauration : 12 caractères base32 Crockford, affiché
 *  XXXX-XXXX-XXXX, sans casse ni séparateurs ; O lu 0, I et L lus 1. Rendu
 *  sans tirets (le serveur fait la même lecture). */
export function normalizeRestoreCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null
  // comme le serveur : tout ce qui n'est ni chiffre ni lettre est ignoré
  const s = v.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(s) ? s : null
}

// ---------- module ----------

export interface LicenseOptions {
  /** licence active (app de bureau, ou adresse imposée en développement).
   *  Faux : plan « off » pour toujours, rien ne tourne, aucun réseau. */
  active: boolean
  configUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  publicKey?: string
  /** langue du système (devise affichée) */
  systemLocale?: string
  /** identifiant brut de la machine (tests) ; par défaut lu sur le système */
  machineId?: () => Promise<string | null>
  /** deuxième emplacement du début de l'essai */
  markStore?: MarkStore
  timeoutMs?: number
  /** mode payant quand flitdrop.com n'a jamais répondu (license-key.ts) */
  buildDefault?: boolean
}

export interface LicenseDeps {
  home: string
  cfg: Config
  /** statistiques (niveau de base) */
  track: (event: string, props?: Record<string, string | number | boolean>) => void
  /** le plan, la carte ou la limite du jour ont changé (interface, téléphones) */
  onChange: () => void
  lang: () => Lang
  /** ouvre une adresse dans le navigateur du système */
  openUrl: (url: string) => void
}

export interface ProState {
  plan: Plan
  trialDaysLeft?: number
  trialEndsAt?: string
  limit?: number
  used?: number
  left?: number
  resetAt?: string
  price?: string
  earlyPrice?: string
  earlyUntil?: string
  card?: CardKind | null
  waiting?: { since: string; polling: boolean } | null
  restoreEmail?: string | null
}

export interface Quota {
  limit: number
  used: number
  left: number
  resetAt: string
  price: string
}

type NetResult = { status: number; body: Record<string, unknown> } | null

export class License {
  readonly active: boolean
  /** résolu une fois l'identité de la machine lue (jamais en erreur) */
  readonly ready: Promise<void>
  private inited = false
  private deviceIdValue = ''
  private key: Buffer | null = null
  /** identifiant de la machine illisible ce lancement, alors que la config
   *  est liée à une machine : rien n'est réécrit, limites fermées en mémoire */
  private degraded = false
  private st: LicenseState
  private markStart: number | null = null
  private now: () => number
  private fetchImpl: typeof fetch | undefined
  private configUrl: string
  private tokenCache: { token: string; check: TokenCheck } | null = null
  private lastConfigAttempt = 0
  private waiting: { claim: string; since: number; where: CheckoutWhere; early: boolean } | null = null
  private claimInFlight: Promise<'unlocked' | 'pending' | 'offline' | 'used'> | null = null
  private lastClaimAt = 0
  private justUnlocked = false
  /** l'achat sert déjà sur 5 ordinateurs (403 claim_used) : on le dit, et
   *  « J'ai déjà acheté » reste le chemin */
  private claimUsed = false
  private restore: { email: string; challenge: string; at: number } | null = null
  private lastRestoreStart = 0
  private lastDay = ''
  private retrying = false

  constructor(
    private deps: LicenseDeps,
    private o: LicenseOptions
  ) {
    this.active = o.active
    this.now = o.now ?? (() => Date.now())
    this.fetchImpl = o.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    this.configUrl = o.configUrl ?? LICENSE_CONFIG_URL
    this.st = blankState(false)
    this.ready = this.active ? this.init().catch(() => undefined) : Promise.resolve()
  }

  private get cfg(): Config {
    return this.deps.cfg
  }

  private save(): void {
    try {
      saveConfig(this.deps.home, this.cfg)
    } catch {
      // disque plein, droits : jamais d'erreur pour la licence
    }
  }

  /** Identifiant d'appareil (empreinte de la machine) ; '' avant init. */
  get deviceId(): string {
    return this.deviceIdValue
  }

  // ---------- identité de la machine et état ----------

  private async init(): Promise<void> {
    let machine: string | null = null
    try {
      machine = await (this.o.machineId ?? (() => readMachineIdentifier()))()
    } catch {
      machine = null
    }
    const fromMachine = !!machine
    if (!machine) {
      if (!/^[0-9a-f]{32}$/.test(this.cfg.licenseFallbackId)) {
        this.cfg.licenseFallbackId = crypto.randomBytes(16).toString('hex')
        this.save()
      }
      machine = 'fallback:' + this.cfg.licenseFallbackId
    }
    const dev = deviceIdFrom(machine)
    const stored = this.cfg.licenseDeviceId
    this.key = stateKey(machine)
    this.deviceIdValue = dev
    this.degraded = !fromMachine && stored !== '' && stored !== dev
    const mark = await this.markStore().read().catch(() => null)
    this.markStart = parseMark(this.key, dev, mark)
    this.loadState()
    this.inited = true
    this.lastDay = localDay(this.now())
  }

  private markStore(): MarkStore {
    return this.o.markStore ?? defaultMarkStore()
  }

  /** Lit et vérifie l'état signé (voir en tête du fichier). */
  private loadState(): void {
    const key = this.key!
    const dev = this.deviceIdValue
    const s = this.cfg.licenseState
    const now = this.now()
    const cachedOn = this.cfg.licenseConfig?.enabled === true
    const fallbackPaid = this.o.buildDefault ?? PAID_MODE_BUILD_DEFAULT
    let st: LicenseState
    let trusted = false
    if (s && !this.degraded && macEqual(s.mac, stateMac(key, dev, s))) {
      const { mac: _mac, ...rest } = s
      st = { ...rest, dailyFiles: { ...s.dailyFiles } }
      trusted = true
    } else if (!s && this.markStart === null && !cachedOn) {
      // installation neuve, ou mode payant jamais vu : état vierge
      st = blankState(fallbackPaid)
      trusted = true
    } else if (!s) {
      // état effacé (config supprimée, ou clé retirée à la main) alors que le
      // mode payant avait été vu : l'essai reprend à sa vraie date de début
      // (deuxième emplacement), jamais à zéro ; sans elle, il est terminé.
      // Le compteur du jour est au maximum, jusqu'à minuit seulement.
      const days = this.remote()?.trialDays ?? DEFAULT_TRIAL_DAYS
      const start = this.markStart
      st = {
        paidMode: true,
        paidModeSeenAt: new Date(start ?? now).toISOString(),
        trialStartAt: start !== null ? new Date(start).toISOString() : '',
        trialEndsAt: new Date(start !== null ? start + days * DAY_MS : now).toISOString(),
        dailyFiles: { day: localDay(now), count: FREE_DAILY_FILES },
        token: '',
      }
    } else {
      // retouché à la main, ou copié d'un autre PC : on ferme les limites
      // (essai terminé, compteur du jour au maximum), jamais le reste
      const prev = s
      const ends = validTs(prev.trialEndsAt)
      st = {
        paidMode: prev.paidMode === true || this.markStart !== null || cachedOn || fallbackPaid,
        paidModeSeenAt: validTs(prev.paidModeSeenAt) !== null ? prev.paidModeSeenAt : this.markStart !== null ? new Date(this.markStart).toISOString() : '',
        trialStartAt: this.markStart !== null ? new Date(this.markStart).toISOString() : validTs(prev.trialStartAt) !== null ? prev.trialStartAt : '',
        trialEndsAt: new Date(ends !== null ? Math.min(ends, now) : now).toISOString(),
        dailyFiles: { day: localDay(now), count: FREE_DAILY_FILES },
        token: typeof prev.token === 'string' ? prev.token : '',
      }
    }
    // début de l'essai : le plus ancien des deux emplacements
    if (trusted && this.markStart !== null) {
      const start = validTs(st.trialStartAt)
      if (start === null || this.markStart < start) {
        st.trialStartAt = new Date(this.markStart).toISOString()
        const days = this.remote()?.trialDays ?? DEFAULT_TRIAL_DAYS
        const capped = this.markStart + days * DAY_MS
        const ends = validTs(st.trialEndsAt)
        st.trialEndsAt = new Date(ends === null ? capped : Math.min(ends, capped)).toISOString()
        st.paidModeSeenAt ||= st.trialStartAt
      }
    }
    // jeton : seulement s'il est signé par nous et pour CETTE machine
    if (st.token && !this.degraded && !verifyToken(st.token, dev, this.pub()).ok) st.token = ''
    this.st = st
    if (this.degraded) return
    if (this.cfg.licenseDeviceId !== dev) this.cfg.licenseDeviceId = dev
    this.commit()
    // essai commencé sans marque valide ailleurs : on la (re)pose
    const start = validTs(st.trialStartAt)
    if (start !== null && (this.markStart === null || this.markStart > start)) void this.writeMark(start)
  }

  private pub(): string {
    return this.o.publicKey ?? LICENSE_PUBLIC_KEY
  }

  /** Signe et enregistre l'état (jamais en mode dégradé). */
  private commit(): void {
    if (this.degraded || !this.key) return
    const mac = stateMac(this.key, this.deviceIdValue, this.st)
    const stored: LicenseStateStored = { ...this.st, dailyFiles: { ...this.st.dailyFiles }, mac }
    this.cfg.licenseState = stored
    this.save()
  }

  private async writeMark(startMs: number): Promise<void> {
    if (!this.key || this.degraded) return
    const ok = await this.markStore()
      .write(markValue(this.key, this.deviceIdValue, startMs))
      .catch(() => false)
    if (ok) this.markStart = startMs
  }

  /** Identifiant de la machine illisible au lancement : on réessaie (minuterie
   *  existante, toutes les 10 minutes) ; relu, tout redevient normal. */
  private async retryMachine(): Promise<void> {
    if (this.retrying) return
    this.retrying = true
    try {
      const machine = await (this.o.machineId ?? (() => readMachineIdentifier()))().catch(() => null)
      if (machine && deviceIdFrom(machine) === this.cfg.licenseDeviceId) {
        const before = this.plan()
        await this.init()
        if (this.plan() !== before) this.changed()
      }
    } finally {
      this.retrying = false
    }
  }

  // ---------- configuration du serveur ----------

  private remote(): RemoteConfig | null {
    return sanitizeRemoteConfig(this.cfg.licenseConfig)
  }

  private apiUrl(p: string): string {
    return new URL(p, new URL('./', this.configUrl)).href
  }

  private async request(url: string, init: RequestInit): Promise<NetResult> {
    const f = this.fetchImpl
    if (!f) return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? NET_TIMEOUT_MS)
    timer.unref?.()
    try {
      const r = await f(url, { ...init, signal: ctrl.signal, redirect: 'error' })
      const text = await r.text()
      let body: Record<string, unknown> = {}
      if (text.length <= MAX_BODY_CHARS) {
        try {
          const j = JSON.parse(text) as unknown
          if (j && typeof j === 'object' && !Array.isArray(j)) body = j as Record<string, unknown>
        } catch {
          body = {}
        }
      }
      return { status: r.status, body }
    } catch {
      // hors ligne, DNS, délai dépassé : jamais d'erreur
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private post(p: string, body: Record<string, unknown>): Promise<NetResult> {
    return this.request(this.apiUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  /** Relit /api/license/config. Jamais d'erreur. */
  async refreshConfig(): Promise<void> {
    if (!this.active) return
    await this.ready
    this.lastConfigAttempt = this.now()
    const r = await this.request(this.configUrl, { method: 'GET', headers: { accept: 'application/json' } })
    if (!r || r.status !== 200) return
    const rc = sanitizeRemoteConfig(r.body)
    if (!rc) return
    const before = this.plan()
    const beforeCard = this.card()
    this.cfg.licenseConfig = rc as unknown as Record<string, unknown>
    this.cfg.licenseConfigAt = new Date(this.now()).toISOString()
    this.save()
    if (this.st.paidMode !== rc.enabled) {
      this.st.paidMode = rc.enabled
      this.commit()
    }
    this.startTrialIfNeeded()
    if (this.plan() !== before || this.card() !== beforeCard) this.changed()
  }

  /** Mode payant vu pour la première fois : l'essai commence (une fois). */
  private startTrialIfNeeded(): void {
    if (!this.inited || !this.st.paidMode || this.st.trialEndsAt) return
    const now = this.now()
    const remote = this.remote()
    const days = remote?.trialDays ?? DEFAULT_TRIAL_DAYS
    const installed = Date.parse(this.cfg.installedAt)
    const launched = remote?.launchedAt ? Date.parse(remote.launchedAt) : NaN
    // installation neuve (après le lancement du mode payant) : depuis son
    // premier lancement ; installation existante : depuis maintenant
    let start = Number.isFinite(launched) && Number.isFinite(installed) && installed >= launched && installed <= now ? installed : now
    if (this.markStart !== null && this.markStart < start) start = this.markStart
    this.st.paidModeSeenAt ||= new Date(now).toISOString()
    this.st.trialStartAt = new Date(start).toISOString()
    this.st.trialEndsAt = new Date(start + days * DAY_MS).toISOString()
    this.commit()
    if (this.markStart === null || this.markStart > start) void this.writeMark(start)
  }

  // ---------- plan ----------

  private tokenCheck(): TokenCheck | null {
    const tok = this.st.token
    if (!tok) return null
    if (this.tokenCache?.token !== tok) this.tokenCache = { token: tok, check: verifyToken(tok, this.deviceIdValue, this.pub()) }
    return this.tokenCache.check
  }

  plan(): Plan {
    if (!this.active || !this.inited || !this.st.paidMode) return 'off'
    const chk = this.tokenCheck()
    if (chk?.ok && tokenUsable(chk.payload, this.now())) return 'pro'
    const ends = validTs(this.st.trialEndsAt)
    if (ends !== null && this.now() < ends) return 'trial'
    return 'free'
  }

  /** Fonctions d'avant Flitdrop Pro réservées à Pro (synchro automatique du
   *  presse-papiers, historique complet) : ouvertes sauf en gratuit. */
  fullFeatures(): boolean {
    return this.plan() !== 'free'
  }

  /** Photos et vidéos rangées par mois : nouveauté Pro (essai ou Pro), et
   *  seulement si le réglage est allumé. Jamais en mode payant coupé. */
  monthFolders(): boolean {
    const p = this.plan()
    return (p === 'trial' || p === 'pro') && this.cfg.sortPhotosByMonth
  }

  trialDaysLeft(): number {
    const ends = validTs(this.st.trialEndsAt)
    return ends === null ? 0 : Math.max(0, Math.ceil((ends - this.now()) / DAY_MS))
  }

  // ---------- limite du jour ----------

  limited(): boolean {
    return this.plan() === 'free'
  }

  dailyUsed(): number {
    const d = this.st.dailyFiles
    return d.day === localDay(this.now()) ? d.count : 0
  }

  /** Fichiers encore possibles aujourd'hui (Infinity sans limite). */
  dailyLeft(): number {
    return this.limited() ? Math.max(0, FREE_DAILY_FILES - this.dailyUsed()) : Infinity
  }

  /** Un nouveau fichier peut-il commencer ? `inFlight` : fichiers déjà
   *  commencés et pas encore comptés (ils finiront quoi qu'il arrive). */
  canStartFile(inFlight = 0): boolean {
    return !this.limited() || this.dailyUsed() + Math.max(0, inFlight) < FREE_DAILY_FILES
  }

  /** Compte des fichiers arrivés ou envoyés (gratuit seulement). */
  countFiles(n = 1): void {
    if (!this.limited() || !(n > 0)) return
    const today = localDay(this.now())
    if (this.st.dailyFiles.day !== today) this.st.dailyFiles = { day: today, count: 0 }
    this.st.dailyFiles.count = Math.min(1_000_000, this.st.dailyFiles.count + Math.floor(n))
    this.commit()
    if (this.st.dailyFiles.count >= FREE_DAILY_FILES) this.limitReached()
  }

  /** Un fichier a été refusé par la limite. */
  noteRefused(): void {
    if (this.limited()) this.limitReached()
  }

  /** Limite atteinte : statistique et carte, une fois par jour. */
  private limitReached(): void {
    const today = localDay(this.now())
    if (this.cfg.dailyLimitReportedDay === today) return
    this.cfg.dailyLimitReportedDay = today
    this.save()
    this.deps.track('daily_limit_reached')
    this.changed()
  }

  price(): string {
    const remote = this.remote()
    const map = remote && Object.keys(remote.displayPrice).length > 0 ? remote.displayPrice : DEFAULT_PRICES
    const cur = currencyFor(this.o.systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale)
    return map[cur] ?? map.EUR ?? Object.values(map)[0] ?? DEFAULT_PRICES.EUR!
  }

  private earlyPrice(): string | null {
    const remote = this.remote()
    const cur = currencyFor(this.o.systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale)
    return remote?.displayPriceEarly[cur] ?? halfPrice(this.price())
  }

  /** Prix réellement proposé à CETTE installation (celui de lancement quand
   *  il s'applique) : le même sur le PC et sur le téléphone. */
  effectivePrice(): string {
    return (this.earlyUntil() !== null ? this.earlyPrice() : null) ?? this.price()
  }

  /** Fin de l'offre de lancement pour CETTE installation, ou null. */
  earlyUntil(): number | null {
    const remote = this.remote()
    if (!remote?.earlyDiscount || !remote.launchedAt) return null
    const launched = Date.parse(remote.launchedAt)
    const installed = Date.parse(this.cfg.installedAt)
    const until = launched + remote.earlyDays * DAY_MS
    if (!Number.isFinite(launched) || !Number.isFinite(installed) || installed >= launched || this.now() >= until) return null
    return until
  }

  /** Limite du jour vue par le téléphone ; null sans limite. */
  quota(): Quota | null {
    if (!this.limited()) return null
    const used = this.dailyUsed()
    return {
      limit: FREE_DAILY_FILES,
      used,
      left: Math.max(0, FREE_DAILY_FILES - used),
      resetAt: new Date(nextLocalMidnight(this.now())).toISOString(),
      price: this.effectivePrice(),
    }
  }

  /** Corps de la réponse de refus (402) : le téléphone garde le reste en attente. */
  limitBody(): { error: 'daily_limit'; limit: number; left: number; resetAt: string; price: string } {
    return {
      error: 'daily_limit',
      limit: FREE_DAILY_FILES,
      left: 0,
      resetAt: new Date(nextLocalMidnight(this.now())).toISOString(),
      price: this.effectivePrice(),
    }
  }

  // ---------- cartes de la fenêtre du PC ----------

  /** Carte à montrer en haut de la fenêtre, au plus une invitation par jour. */
  card(): CardKind | null {
    const plan = this.plan()
    if (plan === 'off') return null
    if (this.waiting && plan !== 'pro') return 'waiting'
    if (this.justUnlocked && plan === 'pro') return 'success'
    if (this.claimUsed && plan !== 'pro') return 'used'
    const p = this.cfg.proPromptsShown
    const today = localDay(this.now())
    const shownToday = p.day === today
    if (plan === 'free' && this.dailyUsed() >= FREE_DAILY_FILES) {
      if (!shownToday || (p.kind === 'limit' && !p.closed)) return 'limit'
    }
    if (plan === 'trial' && this.trialDaysLeft() <= 2) {
      if ((!shownToday && p.trial === 0) || (shownToday && p.kind === 'trial' && !p.closed)) return 'trial'
    }
    return null
  }

  /** La fenêtre (visible) a montré l'invitation : comptée une fois. */
  promptSeen(where: PromptWhere): void {
    if (this.card() !== where) return
    const p = this.cfg.proPromptsShown
    const today = localDay(this.now())
    if (p.day === today && p.kind === where) return
    this.cfg.proPromptsShown = {
      day: today,
      kind: where,
      closed: false,
      limit: p.limit + (where === 'limit' ? 1 : 0),
      trial: p.trial + (where === 'trial' ? 1 : 0),
    }
    this.save()
    this.deps.track('pro_prompt_shown', { where })
  }

  /** « Plus tard », « Super » : la carte se range (pas l'attente du paiement). */
  closeCard(): void {
    if (this.justUnlocked || this.claimUsed) {
      this.justUnlocked = false
      this.claimUsed = false
      return
    }
    const p = this.cfg.proPromptsShown
    if (p.day === localDay(this.now()) && !p.closed) {
      this.cfg.proPromptsShown = { ...p, closed: true }
      this.save()
    }
  }

  // ---------- achat ----------

  /** Ouvre la page d'achat (navigateur du système) et attend le paiement.
   *  `reopen` : même achat, page rouverte (pas recompté). */
  checkout(where: CheckoutWhere, reopen = false): { ok: boolean; url?: string } {
    const plan = this.plan()
    if (plan === 'off' || plan === 'pro' || this.degraded || !this.deviceIdValue) return { ok: false }
    if (reopen && !this.waiting) return { ok: false }
    const now = this.now()
    const early = this.earlyUntil() !== null
    this.claimUsed = false
    const claim = this.waiting?.claim ?? crypto.randomBytes(16).toString('hex')
    const origin = new URL(this.configUrl).origin
    const url = `${origin}/pro?claim=${claim}&lang=${this.deps.lang()}${early ? '&early=1' : ''}`
    if (!this.waiting) {
      this.waiting = { claim, since: now, where, early }
      this.cfg.licenseClaim = { claim, at: new Date(now).toISOString() }
      this.save()
    } else if (!reopen) {
      // nouveau clic après 30 minutes : la vérification automatique repart
      this.waiting.since = now
    }
    if (!reopen) this.deps.track('pro_checkout_opened', { where, early })
    try {
      this.deps.openUrl(url)
    } catch {
      // navigateur introuvable : la carte reste, « Rouvrir » est là
    }
    this.changed()
    return { ok: true, url }
  }

  /** Le paiement est-il arrivé ? Automatique (toutes les 5 s, carte visible,
   *  30 minutes au plus) ou « J'ai payé » (`manual`). */
  async claim(manual: boolean): Promise<'unlocked' | 'pending' | 'stopped' | 'offline' | 'used' | 'none'> {
    const w = this.waiting
    if (!w) return this.plan() === 'pro' ? 'unlocked' : 'none'
    const now = this.now()
    if (!manual && now - w.since > CLAIM_POLL_MAX_MS) return 'stopped'
    if (this.claimInFlight) return this.claimInFlight
    if (now - this.lastClaimAt < (manual ? 1000 : CLAIM_MIN_GAP_MS)) return 'pending'
    this.lastClaimAt = now
    this.claimInFlight = (async () => {
      const r = await this.post('claim', { claim: w.claim, device: this.deviceIdValue })
      if (!r) return 'offline' as const
      if (r.status === 200 && this.acceptToken(r.body.token, 'purchase')) return 'unlocked' as const
      if (r.status === 403 && r.body.error === 'claim_used') {
        this.claimWasUsed()
        return 'used' as const
      }
      // 202 en attente, 429 trop de demandes, 503 indisponible : on garde
      // l'état et on redemande plus tard
      return 'pending' as const
    })().finally(() => {
      this.claimInFlight = null
    })
    return this.claimInFlight
  }

  /** Achat déjà utilisé sur 5 ordinateurs : plus d'attente ni de
   *  vérification ; la carte l'explique et renvoie vers « J'ai déjà acheté ». */
  private claimWasUsed(): void {
    this.waiting = null
    this.cfg.licenseClaim = null
    this.save()
    this.claimUsed = true
    this.changed()
  }

  cancelCheckout(): void {
    if (!this.waiting) return
    this.waiting = null
    this.cfg.licenseClaim = null
    this.save()
    this.changed()
  }

  /** Jeton reçu (achat ou restauration) : gardé seulement s'il est signé par
   *  nous, pour CETTE machine, et encore valable. */
  private acceptToken(token: unknown, how: 'purchase' | 'restore'): boolean {
    if (this.degraded) return false
    const chk = verifyToken(token, this.deviceIdValue, this.pub())
    if (!chk.ok || !tokenUsable(chk.payload, this.now())) return false
    this.st.token = token as string
    this.commit()
    this.waiting = null
    this.restore = null
    this.cfg.licenseClaim = null
    this.save()
    this.justUnlocked = true
    this.deps.track('pro_unlocked', { how })
    this.changed()
    return true
  }

  // ---------- restauration ----------

  async restoreStart(email: unknown): Promise<{ ok: true } | { error: 'email' | 'offline' | 'busy' | 'error' }> {
    const mail = plausibleEmail(email)
    if (!mail) return { error: 'email' }
    if (!this.active || this.degraded || !this.deviceIdValue) return { error: 'offline' }
    const now = this.now()
    if (now - this.lastRestoreStart < 15_000) return { error: 'busy' }
    this.lastRestoreStart = now
    const r = await this.post('restore/start', { email: mail, lang: this.deps.lang() })
    if (!r) return { error: 'offline' }
    const ch = r.body.challenge
    if (r.status === 200 && typeof ch === 'string' && ch.length > 0 && ch.length <= 4096) {
      this.restore = { email: mail, challenge: ch, at: now }
      this.changed()
      return { ok: true }
    }
    return { error: r.status === 429 ? 'busy' : 'error' }
  }

  async restoreVerify(code: unknown): Promise<{ ok: true } | { error: 'code' | 'expired' | 'nopurchase' | 'offline' | 'busy' | 'nochallenge' | 'error' }> {
    const rs = this.restore
    if (!rs) return { error: 'nochallenge' }
    const c = normalizeRestoreCode(code)
    if (!c) return { error: 'code' }
    const r = await this.post('restore/verify', { email: rs.email, code: c, challenge: rs.challenge, device: this.deviceIdValue })
    if (!r) return { error: 'offline' }
    if (r.status === 200 && this.acceptToken(r.body.token, 'restore')) return { ok: true }
    const e = r.body.error
    if (r.status === 400 && (e === 'code' || e === 'expired' || e === 'nopurchase')) return { error: e }
    return { error: r.status === 429 ? 'busy' : 'error' }
  }

  /** « Changer d'adresse » : on repart de l'e-mail. */
  restoreReset(): void {
    if (!this.restore) return
    this.restore = null
    this.changed()
  }

  // ---------- renouvellement ----------

  /** Jeton qui expire dans moins de 10 jours : renouvelé, une fois par jour. */
  async maybeRenew(): Promise<void> {
    if (!this.active || this.degraded || !this.st.paidMode || !this.st.token) return
    const chk = this.tokenCheck()
    if (!chk?.ok) return
    const now = this.now()
    if (chk.payload.exp * 1000 - now > RENEW_WITHIN_MS) return
    const today = localDay(now)
    if (this.cfg.licenseRenewDay === today) return
    this.cfg.licenseRenewDay = today
    this.save()
    const r = await this.post('renew', { token: this.st.token, device: this.deviceIdValue })
    if (!r) return
    const before = this.plan()
    if (r.status === 200) {
      const fresh = verifyToken(r.body.token, this.deviceIdValue, this.pub())
      if (fresh.ok && fresh.payload.exp >= chk.payload.exp) {
        this.st.token = r.body.token as string
        this.commit()
      }
    } else if (r.status === 403 && r.body.error === 'revoked') {
      // remboursé, ou ordinateur retiré de la licence
      this.st.token = ''
      this.commit()
    }
    if (this.plan() !== before) this.changed()
  }

  // ---------- cycle de vie ----------

  /** Au lancement (après ready) : configuration, achat payé pendant que
   *  l'app était fermée, renouvellement. Rien ne bloque, rien ne lève. */
  start(): void {
    if (!this.active) return
    void (async () => {
      await this.ready
      await this.refreshConfig()
      await this.launchClaimCheck()
      await this.maybeRenew()
    })().catch(() => {})
  }

  /** Achat commencé lors d'un lancement précédent (moins de 48 h) : une
   *  seule vérification silencieuse, sans attente ni carte. */
  private async launchClaimCheck(): Promise<void> {
    const c = this.cfg.licenseClaim
    if (!c) return
    const at = Date.parse(c.at)
    if (!Number.isFinite(at) || this.now() - at > CLAIM_KEEP_MS || !/^[0-9a-f]{32}$/.test(c.claim)) {
      this.cfg.licenseClaim = null
      this.save()
      return
    }
    const plan = this.plan()
    if ((plan !== 'free' && plan !== 'trial') || this.degraded) return
    const r = await this.post('claim', { claim: c.claim, device: this.deviceIdValue })
    if (r && r.status === 200) this.acceptToken(r.body.token, 'purchase')
    else if (r && r.status === 403 && r.body.error === 'claim_used') this.claimWasUsed()
  }

  /** Appelé par une minuterie qui existe déjà (toutes les 10 minutes) :
   *  configuration au plus une fois par jour (une heure après un échec),
   *  renouvellement, changement de jour. Aucune minuterie à soi. */
  tick(): void {
    if (!this.active || !this.inited) return
    if (this.degraded) void this.retryMachine()
    const now = this.now()
    const okAt = Date.parse(this.cfg.licenseConfigAt) || 0
    if (now - okAt >= DAY_MS && now - this.lastConfigAttempt >= HOUR_MS) void this.refreshConfig()
    void this.maybeRenew()
    const today = localDay(now)
    if (today !== this.lastDay) {
      // minuit : nouveau compteur, peut-être une carte de fin d'essai
      this.lastDay = today
      this.changed()
    }
  }

  private changed(): void {
    try {
      this.deps.onChange()
    } catch {
      // l'interface relira l'état plus tard
    }
  }

  /** État pour la fenêtre du PC (/api/admin/state). */
  state(): ProState {
    const plan = this.plan()
    if (plan === 'off') return { plan }
    const now = this.now()
    const used = this.dailyUsed()
    const early = this.earlyUntil()
    const out: ProState = {
      plan,
      limit: FREE_DAILY_FILES,
      used,
      left: Math.max(0, FREE_DAILY_FILES - used),
      resetAt: new Date(nextLocalMidnight(now)).toISOString(),
      price: this.price(),
      card: this.card(),
      waiting: this.waiting ? { since: new Date(this.waiting.since).toISOString(), polling: now - this.waiting.since <= CLAIM_POLL_MAX_MS } : null,
      restoreEmail: this.restore?.email ?? null,
    }
    if (plan === 'trial') {
      out.trialDaysLeft = this.trialDaysLeft()
      out.trialEndsAt = this.st.trialEndsAt
    }
    if (early !== null) {
      const ep = this.earlyPrice()
      if (ep) {
        out.earlyPrice = ep
        out.earlyUntil = new Date(early).toISOString()
      }
    }
    return out
  }
}
