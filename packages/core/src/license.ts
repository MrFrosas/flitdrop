// Flitdrop Pro : ce à quoi cette installation a droit (« plan »), et tout ce
// qui y mène : mode payant (interrupteur du serveur), essai de 14 jours,
// limite de 30 fichiers par jour, achat, restauration, renouvellement du
// jeton de licence. Côté Node uniquement : la page du téléphone peut être
// modifiée, la page du PC aussi ; seul ce module décide.
//
// Plans :
// - « off » : mode payant coupé (défaut, ou flitdrop.com jamais joint, ou
//   installation du Microsoft Store tant que le serveur ne dit pas
//   storeEnabled) : EXACTEMENT le comportement d'avant Flitdrop Pro, tout est
//   ouvert, aucune interface Pro.
// - « trial » : 14 jours de Pro (installation existante : depuis la première
//   fois que l'app voit le mode payant ; installation neuve : depuis le
//   premier lancement).
// - « free » : gratuit, 30 fichiers par jour local. Installation d'avant
//   Flitdrop Pro (config d'une version < 0.7.0 au premier lancement de
//   celle-ci, noté une fois dans l'état signé : legacy) : la synchro
//   automatique et tout l'historique du presse-papiers restent gratuits ;
//   seules la limite du jour et les dossiers par mois s'appliquent.
// - « pro » : jeton signé valide (Ed25519, clé publique embarquée), pour CET
//   ordinateur, jusqu'à son échéance + 7 jours hors ligne.
//
// Anti-copie (machine) : l'identifiant d'appareil est une empreinte de
// l'identifiant que le système donne à la machine (machineid.ts). Jamais lu
// sur cette installation : un identifiant aléatoire gardé dans la config
// (licenseFallbackId) le remplace ; il ne protège alors plus contre la copie
// de la config sur un autre PC où l'identifiant serait aussi illisible (cas
// rare, accepté).
//
// Lecture ratée CE lancement (commande lente au démarrage, ordinateur
// chargé) alors que la config est déjà liée à cette machine : ce n'est pas
// une copie. L'identité gardée (licenseDeviceId) sert pour la session, l'état
// signé et le jeton restent valables s'ils portent aussi une deuxième
// empreinte, liée à cette identité et à la session (compte, dossier
// personnel, processeur) ; la lecture est retentée en arrière-plan (5 s,
// 30 s, 2 min, puis toutes les 10 minutes). Relue et identique : tout
// redevient normal. Relue et DIFFÉRENTE : c'est une copie, les limites se
// ferment comme ci-dessous. Pendant une telle session, le jeton n'est pas
// renouvelé : une config copiée sur un PC qui cache son identifiant ne
// garderait Pro que jusqu'à l'échéance du jeton (+ 7 jours).
//
// État de la licence (essai, compteur du jour, jeton, mode payant vu, achat
// en attente) : rangé dans config.licenseState avec une empreinte
// HMAC-SHA256 dont la clé vient de l'identifiant de la machine et d'une
// constante de l'app. Empreinte absente ou fausse (config retouchée à la
// main, copiée d'un autre PC) : l'essai est considéré terminé et le compteur
// du jour est au maximum. Rien d'autre ne se ferme : les fichiers dans la
// limite et toutes les fonctions gratuites marchent, et le lendemain repart
// d'un compteur neuf et valide.
//
// Deuxième emplacement, signé, en dehors du dossier de config (machineid.ts) :
// début et fin de l'essai, compteur du jour le plus haut, heure la plus
// tardive vue. Effacer la config ne redonne pas un essai neuf ; remettre une
// ancienne copie de config.json ne fait ni redescendre le compteur du jour
// ni revenir un essai fini. Cette marque déjà écrite puis effacée ou abîmée :
// compteur du jour au maximum (jusqu'à minuit).
//
// Horloge : avancer d'un jour donne un compteur neuf (accepté), mais revenir
// en arrière garde le compteur du jour le plus tardif vu (jamais un deuxième
// jour neuf) ; l'essai se termine quand l'heure la plus tardive vue (horloge
// du PC, ou date donnée par flitdrop.com) dépasse sa fin.
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
import { readMachineIdentifier, deviceIdFrom, defaultMarkStore, hostFingerprint, type MarkStore } from './machineid.js'

export const LICENSE_PUBLIC_KEY = LICENSE_PUBLIC_KEY_B64
/** Racine des licences : /api/license/* et la page d'achat /pro. */
export const LICENSE_BASE_URL = 'https://flitdrop.com'
export const LICENSE_CONFIG_URL = LICENSE_BASE_URL + '/api/license/config'
/** Environnement des jetons : l'app publiée n'accepte que « production ». */
export type TokenEnv = 'production' | 'sandbox'
/** Écrire au support (achat utilisé sur trop d'ordinateurs). */
export const SUPPORT_MAILTO = 'mailto:contact@flitdrop.com?subject=Flitdrop%20Pro'
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
// identité de la machine illisible : nouvelles lectures après 5 s, 30 s,
// 2 min (puis la minuterie existante, toutes les 10 minutes)
const MACHINE_RETRY_MS = [5_000, 30_000, 120_000]
// constante de l'app mêlée à l'identifiant de la machine pour la clé de
// l'empreinte de l'état (pas un secret absolu : elle est dans l'app ; elle
// rend une retouche à la main de config.json visible)
const STATE_SALT = 'wFFWh6YtojGZ-kIfVRC_i9xuAW_YB0GG'
// en-tête DER d'une clé publique Ed25519 (SubjectPublicKeyInfo) : suivi des
// 32 octets bruts, il donne une clé utilisable par node:crypto
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export type Plan = 'off' | 'trial' | 'free' | 'pro'
export type CardKind = 'limit' | 'trial' | 'welcome' | 'waiting' | 'success' | 'used' | 'devices'
export type PromptWhere = 'limit' | 'trial' | 'welcome'
/** Premier lancement de cette version sur une config plus ancienne : noté
 *  une fois (legacy), voir en tête du fichier. */
export const LEGACY_BEFORE = [0, 7, 0] as const
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
  /** prix du pays de la personne (aperçu Paddle), prioritaire s'il est là */
  price: { currency: string; display: string; displayEarly: string | null } | null
  /** mode payant aussi pour les installations du Microsoft Store */
  storeEnabled: boolean
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

/** Prix affichable : texte court, sans balise. */
function priceText(p: unknown): string | null {
  if (typeof p !== 'string') return null
  const s = p.trim()
  return s.length > 0 && s.length <= 24 && !/[<>\u0000-\u001f]/.test(s) ? s : null
}

/** Prix affichables : devise en 3 lettres, texte court, sans balise. */
function priceMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    const s = priceText(p)
    if (!/^[A-Z]{3}$/.test(k) || s === null) continue
    out[k] = s
    if (Object.keys(out).length >= 20) break
  }
  return out
}

/** Prix du pays de la personne : { currency, display, displayEarly }. */
function localPrice(v: unknown): RemoteConfig['price'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const display = priceText(r.display)
  if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency) || display === null) return null
  return { currency: r.currency, display, displayEarly: priceText(r.displayEarly) }
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
    price: localPrice(r.price),
    storeEnabled: r.storeEnabled === true,
  }
}

/** Version « a.b.c » d'avant Flitdrop Pro ? « unknown » : config plus
 *  ancienne que le suivi des versions ; '' : installation neuve. */
export function legacyVersion(v: string): boolean {
  if (v === 'unknown') return true
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return false
  const n = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) if (n[i] !== LEGACY_BEFORE[i]) return n[i]! < LEGACY_BEFORE[i]!
  return false
}

// ---------- jeton de licence ----------

export interface TokenPayload {
  v: 1
  env: TokenEnv
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
 *  signature, contenu, environnement (un jeton du bac à sable ne vaut rien
 *  dans l'app publiée), et appareil (doit être CET ordinateur). L'échéance
 *  n'est pas vérifiée ici (voir tokenUsable). */
export function verifyToken(token: unknown, deviceId: string, publicKeyB64: string = LICENSE_PUBLIC_KEY, env: TokenEnv = 'production'): TokenCheck {
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
    j.env !== env ||
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
  /** compteur du jour LE PLUS TARDIF vu (jamais un jour plus ancien) */
  dailyFiles: { day: string; count: number }
  token: string
  /** achat en attente : secret dont le claim est l'empreinte (64 hex, ne
   *  part que vers le serveur des licences), et sa date ; '' sinon */
  claimSecret: string
  claimAt: string
  /** heure la plus tardive vue sur ce PC (borne l'essai si l'horloge recule) */
  seenAt: string
  /** le deuxième emplacement a déjà été écrit ou lu sur ce PC */
  markSeen: boolean
  /** installation d'avant Flitdrop Pro (presse-papiers complet gratuit) */
  legacy: boolean
}

const blankState = (paidMode: boolean, legacy = false): LicenseState => ({
  paidMode,
  paidModeSeenAt: '',
  trialStartAt: '',
  trialEndsAt: '',
  dailyFiles: { day: '', count: 0 },
  token: '',
  claimSecret: '',
  claimAt: '',
  seenAt: '',
  markSeen: false,
  legacy,
})

export function stateKey(machine: string): Buffer {
  return crypto.createHash('sha256').update(`flitdrop-state-v1|${STATE_SALT}|${machine}`).digest()
}

/** Clé de la deuxième empreinte de l'état : identité gardée + session
 *  (machineid.ts, hostFingerprint). Calculable sans lire l'identifiant de la
 *  machine ; une config copiée chez un autre compte ou un autre PC ne la
 *  retrouve pas. */
export function sessionKey(deviceId: string, host: string): Buffer {
  return crypto.createHash('sha256').update(`flitdrop-state-v2|${STATE_SALT}|${deviceId}|${host}`).digest()
}

export function stateMac(key: Buffer, deviceId: string, s: LicenseState): string {
  const body = JSON.stringify([
    'v2',
    deviceId,
    s.paidMode,
    s.paidModeSeenAt,
    s.trialStartAt,
    s.trialEndsAt,
    s.dailyFiles.day,
    s.dailyFiles.count,
    s.token,
    s.claimSecret,
    s.claimAt,
    s.seenAt,
    s.markSeen,
    s.legacy,
  ])
  return crypto.createHmac('sha256', key).update(body).digest('hex')
}

/** Contenu du deuxième emplacement. Dates en ms (0 : aucune), jour local
 *  « AAAA-MM-JJ » ('' : aucun). */
export interface MarkData {
  start: number
  ends: number
  day: string
  count: number
  seen: number
}

const markKey = (deviceId: string): Buffer => crypto.createHash('sha256').update(`flitdrop-mark-v2|${STATE_SALT}|${deviceId}`).digest()

/** « v2.<début>.<fin>.<jour>.<compteur>.<vu>.<empreinte> » : seulement des
 *  chiffres, des lettres, des points et des tirets (registre de Windows). */
export function markValue(deviceId: string, m: MarkData): string {
  const body = `v2.${Math.max(0, Math.floor(m.start))}.${Math.max(0, Math.floor(m.ends))}.${m.day || '0'}.${Math.max(0, Math.floor(m.count))}.${Math.max(0, Math.floor(m.seen))}`
  const mac = crypto.createHmac('sha256', markKey(deviceId)).update(`mark|${deviceId}|${body}`).digest('hex').slice(0, 32)
  return `${body}.${mac}`
}

export function parseMark(deviceId: string, v: string | null): MarkData | null {
  const m = typeof v === 'string' ? v.match(/^v2\.(\d{1,15})\.(\d{1,15})\.(\d{4}-\d{2}-\d{2}|0)\.(\d{1,7})\.(\d{1,15})\.([0-9a-f]{32})$/) : null
  if (!m) return null
  const data: MarkData = { start: Number(m[1]), ends: Number(m[2]), day: m[3] === '0' ? '' : m[3]!, count: Number(m[4]), seen: Number(m[5]) }
  const want = markValue(deviceId, data)
  const a = Buffer.from(v as string)
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? data : null
}

/** Claim de la page d'achat : empreinte du secret gardé par l'app. Le claim
 *  seul (vu dans l'adresse, l'historique du navigateur, les statistiques de
 *  la page) ne débloque rien : le serveur demande le secret. */
export function claimFromSecret(secret: string): string {
  return crypto.createHash('sha256').update('flitdrop-claim-v1:' + secret).digest('hex').slice(0, 32)
}

/** Compteur du jour le plus tardif des deux (même jour : le plus haut). */
function laterDaily(a: { day: string; count: number }, b: { day: string; count: number }): { day: string; count: number } {
  if (!b.day) return { ...a }
  if (!a.day) return { ...b }
  if (a.day === b.day) return { day: a.day, count: Math.max(a.count, b.count) }
  return a.day > b.day ? { ...a } : { ...b }
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
  /** racine des licences (https://flitdrop.com par défaut) : /api/license/*
   *  et la page d'achat /pro */
  baseUrl?: string
  /** adresse de la configuration (ancien réglage) : la racine en est déduite */
  configUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  publicKey?: string
  /** environnement attendu des jetons (« production » par défaut) */
  tokenEnv?: TokenEnv
  /** langue du système (devise affichée) */
  systemLocale?: string
  /** identifiant brut de la machine (tests) ; par défaut lu sur le système */
  machineId?: () => Promise<string | null>
  /** empreinte de la session (tests) ; par défaut machineid.ts */
  hostFingerprint?: () => string
  /** deuxième emplacement (essai, compteur du jour, heure vue) */
  markStore?: MarkStore
  timeoutMs?: number
  /** délais des nouvelles lectures de l'identifiant de la machine (tests) */
  machineRetryMs?: number[]
  /** mode payant quand flitdrop.com n'a jamais répondu (license-key.ts) */
  buildDefault?: boolean
  /** installation du Microsoft Store (canal gardé dans la config) */
  storeChannel?: () => boolean
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
  /** Pro vient d'être débloqué (achat ou restauration) */
  unlocked?: (how: 'purchase' | 'restore') => void
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
  /** installation d'avant Flitdrop Pro : presse-papiers complet gratuit */
  legacy?: boolean
}

export interface Quota {
  limit: number
  used: number
  left: number
  resetAt: string
  price: string
}

type NetResult = { status: number; body: Record<string, unknown>; date: number | null } | null
type ClaimResult = 'unlocked' | 'pending' | 'offline' | 'used' | 'devices'

const SECRET_RE = /^[0-9a-f]{64}$/

/** Racine des licences, terminée par « / ». */
function licenseBase(o: { baseUrl?: string; configUrl?: string }): string {
  try {
    if (o.baseUrl) return new URL(o.baseUrl.replace(/\/*$/, '/')).href
    if (o.configUrl) return new URL('../../', o.configUrl).href
  } catch {
    // adresse illisible : la vraie
  }
  return LICENSE_BASE_URL + '/'
}

export class License {
  readonly active: boolean
  /** résolu une fois l'identité de la machine lue (jamais en erreur) */
  readonly ready: Promise<void>
  private inited = false
  private deviceIdValue = ''
  /** clé de l'empreinte liée à la machine (null : identifiant illisible ce lancement) */
  private key: Buffer | null = null
  /** clé de la deuxième empreinte : identité gardée + session */
  private key2: Buffer = Buffer.alloc(32)
  /** identifiant de la machine illisible ce lancement, config déjà liée à
   *  cette machine : l'identité gardée sert, la lecture est retentée */
  private unreadable = false
  /** ... et l'état gardé ne porte aucune empreinte valable pour cette
   *  session : rien n'est réécrit, limites fermées en mémoire */
  private degraded = false
  private st: LicenseState
  /** dernier contenu connu du deuxième emplacement */
  private mark: MarkData | null = null
  /** deuxième emplacement lu ce lancement : valable, absent, abîmé, ou
   *  illisible (alors rien n'y est écrit : on écraserait un compteur plus haut) */
  private markStatus: 'ok' | 'absent' | 'invalid' | 'unknown' = 'unknown'
  /** heure la plus tardive vue (ms), et celle déjà enregistrée */
  private seenMs = 0
  private seenSavedMs = 0
  private now: () => number
  private fetchImpl: typeof fetch | undefined
  private baseUrl: string
  private configUrl: string
  private tokenEnv: TokenEnv
  private store: MarkStore
  private tokenCache: { token: string; check: TokenCheck } | null = null
  private lastConfigAttempt = 0
  private waiting: { since: number; where: CheckoutWhere; early: boolean } | null = null
  private claimInFlight: Promise<ClaimResult> | null = null
  private lastClaimAt = 0
  private justUnlocked = false
  /** l'achat sert déjà sur 5 ordinateurs (403 claim_used) : on le dit, et
   *  « J'ai déjà acheté » reste le chemin */
  private claimUsed = false
  /** l'achat sert sur trop d'ordinateurs ce mois-ci (403 too_many_devices) :
   *  on le dit calmement, avec l'adresse du support ; le plan ne change pas */
  private tooManyDevices = false
  private restore: { email: string; challenge: string; at: number } | null = null
  private lastRestoreStart = 0
  private lastDay = ''
  private retrying = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryStep = 0
  private stopped = false
  /** version de la config au lancement (avant sa mise à jour par les
   *  statistiques) : décide une fois « legacy » */
  private readonly legacyAtLaunch: boolean

  constructor(
    private deps: LicenseDeps,
    private o: LicenseOptions
  ) {
    this.active = o.active
    this.now = o.now ?? (() => Date.now())
    this.fetchImpl = o.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    this.baseUrl = licenseBase(o)
    this.configUrl = o.configUrl ?? new URL('api/license/config', this.baseUrl).href
    this.tokenEnv = o.tokenEnv ?? 'production'
    this.store = o.markStore ?? defaultMarkStore()
    this.legacyAtLaunch = legacyVersion(deps.cfg.lastVersion)
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

  /** Arrêt (fermeture du serveur) : plus de nouvelle lecture programmée. */
  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  // ---------- identité de la machine et état ----------

  private async init(): Promise<void> {
    // les deux lectures en même temps (chacune 8 s au plus)
    const [machine, mark] = await Promise.all([this.readMachine(), this.readMark()])
    this.setup(machine, mark)
    this.inited = true
    this.lastDay = localDay(this.now())
    if (this.unreadable) this.scheduleRetry()
  }

  private async readMachine(): Promise<string | null> {
    try {
      return (await (this.o.machineId ?? (() => readMachineIdentifier()))()) || null
    } catch {
      return null
    }
  }

  private async readMark(): Promise<{ ok: boolean; v: string | null }> {
    try {
      return { ok: true, v: await this.store.read() }
    } catch {
      return { ok: false, v: null }
    }
  }

  /** Identité de l'appareil, clés, deuxième emplacement, puis l'état. */
  private setup(machine: string | null, mark: { ok: boolean; v: string | null }): void {
    const stored = this.cfg.licenseDeviceId
    const fb = this.cfg.licenseFallbackId
    const fbDev = /^[0-9a-f]{32}$/.test(fb) ? deviceIdFrom('fallback:' + fb) : ''
    this.unreadable = false
    this.degraded = false
    if (machine) {
      this.deviceIdValue = deviceIdFrom(machine)
      this.key = stateKey(machine)
    } else if (stored !== '' && stored !== fbDev) {
      // config déjà liée à CETTE machine (identifiant lu à un lancement
      // précédent), illisible cette fois : pas une copie, on garde l'identité
      this.unreadable = true
      this.deviceIdValue = stored
      this.key = null
    } else {
      // jamais lu sur cette installation : identifiant aléatoire gardé
      if (!fbDev) {
        this.cfg.licenseFallbackId = crypto.randomBytes(16).toString('hex')
        this.save()
      }
      const m = 'fallback:' + this.cfg.licenseFallbackId
      this.deviceIdValue = deviceIdFrom(m)
      this.key = stateKey(m)
    }
    this.key2 = sessionKey(this.deviceIdValue, (this.o.hostFingerprint ?? hostFingerprint)())
    this.mark = null
    if (!mark.ok) this.markStatus = 'unknown'
    else if (mark.v === null) this.markStatus = 'absent'
    else {
      this.mark = parseMark(this.deviceIdValue, mark.v)
      this.markStatus = this.mark ? 'ok' : 'invalid'
    }
    this.tokenCache = null
    this.loadState()
  }

  /** Lit et vérifie l'état signé, puis le confronte au deuxième emplacement
   *  (voir en tête du fichier). */
  private loadState(): void {
    const dev = this.deviceIdValue
    const s = this.cfg.licenseState
    const now = this.now()
    const today = localDay(now)
    const remote = this.remote()
    const cachedOn = !!remote && this.paidFrom(remote)
    // Microsoft Store : jamais payant par défaut, seulement sur storeEnabled
    const fallbackPaid = (this.o.buildDefault ?? PAID_MODE_BUILD_DEFAULT) && !this.storeChannel()
    const days = remote?.trialDays ?? DEFAULT_TRIAL_DAYS
    const m = this.mark
    const markStart = m && m.start > 0 ? m.start : null
    // empreinte liée à la machine, ou deuxième empreinte (écrite pendant un
    // lancement où l'identifiant était illisible, sur cette même session)
    const valid = !!s && ((!!this.key && macEqual(s.mac, stateMac(this.key, dev, s))) || macEqual(s.mac2, stateMac(this.key2, dev, s)))
    // illisible ce lancement et rien de vérifiable : comme une copie, en
    // mémoire seulement (rien n'est réécrit), jusqu'à la prochaine lecture
    this.degraded = this.unreadable && !!s && !valid
    let st: LicenseState
    let closeLimits = false
    if (s && valid) {
      const { mac: _mac, mac2: _mac2, ...rest } = s
      st = { ...rest, dailyFiles: { ...s.dailyFiles } }
      if (!SECRET_RE.test(st.claimSecret)) {
        st.claimSecret = ''
        st.claimAt = ''
      }
      // marque déjà écrite sur ce PC, puis effacée ou abîmée : une ancienne
      // config remise avec la marque retirée ne fait pas redescendre le compteur
      if (st.markSeen && (this.markStatus === 'absent' || this.markStatus === 'invalid')) closeLimits = true
    } else if (!s && !m && !cachedOn) {
      // installation neuve, ou mode payant jamais vu : état vierge (premier
      // lancement de cette version : installation d'avant Flitdrop Pro ?)
      st = blankState(fallbackPaid, this.legacyAtLaunch)
    } else if (!s) {
      // état effacé (config supprimée, ou clé retirée à la main) alors que le
      // mode payant avait été vu : l'essai reprend à sa vraie date de début
      // (deuxième emplacement), jamais à zéro ; sans elle, il est terminé.
      // Le compteur du jour est au maximum, jusqu'à minuit seulement.
      st = {
        ...blankState(true, this.legacyAtLaunch),
        paidModeSeenAt: new Date(markStart ?? now).toISOString(),
        trialStartAt: markStart !== null ? new Date(markStart).toISOString() : '',
        trialEndsAt: new Date(markStart !== null ? markStart + days * DAY_MS : now).toISOString(),
      }
      closeLimits = true
    } else {
      // retouché à la main, ou copié d'un autre PC : on ferme les limites
      // (essai terminé, compteur du jour au maximum), jamais le reste
      const prev = s
      const ends = validTs(prev.trialEndsAt)
      st = {
        ...blankState(prev.paidMode === true || markStart !== null || cachedOn || fallbackPaid, this.legacyAtLaunch),
        paidModeSeenAt: validTs(prev.paidModeSeenAt) !== null ? prev.paidModeSeenAt : markStart !== null ? new Date(markStart).toISOString() : '',
        trialStartAt: markStart !== null ? new Date(markStart).toISOString() : validTs(prev.trialStartAt) !== null ? prev.trialStartAt : '',
        trialEndsAt: new Date(ends !== null ? Math.min(ends, now) : now).toISOString(),
        token: typeof prev.token === 'string' ? prev.token : '',
        seenAt: validTs(prev.seenAt) !== null ? prev.seenAt : '',
        markSeen: prev.markSeen === true,
      }
      closeLimits = true
    }
    if (m) {
      // début de l'essai : le plus ancien des deux emplacements
      if (markStart !== null) {
        const start = validTs(st.trialStartAt)
        if (start === null || markStart < start) {
          st.trialStartAt = new Date(markStart).toISOString()
          const capped = markStart + days * DAY_MS
          const ends = validTs(st.trialEndsAt)
          st.trialEndsAt = new Date(ends === null ? capped : Math.min(ends, capped)).toISOString()
          st.paidModeSeenAt ||= st.trialStartAt
        }
      }
      // fin de l'essai : la plus proche (une ancienne config ne fait pas
      // revenir un essai terminé)
      if (m.ends > 0) {
        const ends = validTs(st.trialEndsAt)
        if (ends === null || m.ends < ends) st.trialEndsAt = new Date(m.ends).toISOString()
      }
      // compteur du jour : jamais plus bas que la marque, jamais un jour plus ancien
      st.dailyFiles = laterDaily(st.dailyFiles, { day: m.day, count: m.count })
    }
    if (closeLimits) {
      // compteur au maximum pour le jour le plus tardif vu (minuit le libère)
      const d = st.dailyFiles
      const day = d.day > today ? d.day : today
      st.dailyFiles = { day, count: Math.max(FREE_DAILY_FILES, day === d.day ? d.count : 0) }
    }
    if (this.markStatus === 'ok') st.markSeen = true
    this.seenMs = Math.max(validTs(st.seenAt) ?? 0, m?.seen ?? 0)
    // jeton : seulement s'il est signé par nous, pour CETTE machine et le bon
    // environnement (en mode dégradé il est gardé, mais ne compte pas)
    if (st.token && !this.degraded && !verifyToken(st.token, dev, this.pub(), this.tokenEnv).ok) st.token = ''
    this.st = st
    if (this.degraded) return
    if (!this.unreadable && this.cfg.licenseDeviceId !== dev) this.cfg.licenseDeviceId = dev
    this.commit()
    // deuxième emplacement à jour (mode payant seulement)
    if (this.markOutdated()) this.writeMark()
  }

  private pub(): string {
    return this.o.publicKey ?? LICENSE_PUBLIC_KEY
  }

  /** Signe et enregistre l'état (jamais en mode dégradé). Identifiant de la
   *  machine illisible ce lancement : seule la deuxième empreinte est posée. */
  private commit(): void {
    if (this.degraded || !this.deviceIdValue) return
    const dev = this.deviceIdValue
    const mac = this.key ? stateMac(this.key, dev, this.st) : ''
    const mac2 = stateMac(this.key2, dev, this.st)
    const stored: LicenseStateStored = { ...this.st, dailyFiles: { ...this.st.dailyFiles }, mac, mac2 }
    this.cfg.licenseState = stored
    this.seenSavedMs = validTs(this.st.seenAt) ?? 0
    this.save()
  }

  /** Heure la plus tardive vue, notée dans l'état (à enregistrer ensuite). */
  private touchSeen(): void {
    this.seenMs = Math.max(this.seenMs, this.now())
    this.st.seenAt = new Date(this.seenMs).toISOString()
  }

  private markData(): MarkData {
    const st = this.st
    return {
      start: validTs(st.trialStartAt) ?? 0,
      ends: validTs(st.trialEndsAt) ?? 0,
      day: st.dailyFiles.day,
      count: Math.min(9_999_999, Math.max(0, Math.floor(st.dailyFiles.count))),
      seen: Math.max(0, this.seenMs),
    }
  }

  private markOutdated(): boolean {
    if (!this.st.paidMode || this.markStatus === 'unknown' || this.degraded) return false
    const m = this.mark
    const d = this.markData()
    return !m || this.markStatus !== 'ok' || m.start !== d.start || m.ends !== d.ends || m.day !== d.day || m.count !== d.count || d.seen - m.seen >= HOUR_MS
  }

  /** Met le deuxième emplacement à jour : en mode payant seulement, jamais en
   *  mode dégradé ni sur une marque illisible ce lancement (on écraserait un
   *  compteur plus haut). Écrit dès l'appel, sans file d'attente : le fichier
   *  (macOS, Linux) de façon synchrone, le registre (Windows) par reg.exe
   *  lancé tout de suite ; un arrêt brutal ne perd au pire que le dernier
   *  fichier compté dans la marque (la config, elle, l'a). */
  private writeMark(): void {
    if (!this.st.paidMode || this.markStatus === 'unknown' || this.degraded || !this.deviceIdValue) return
    const data = this.markData()
    this.mark = data
    const v = markValue(this.deviceIdValue, data)
    if (this.store.writeSync) {
      let ok = false
      try {
        ok = this.store.writeSync(v)
      } catch {
        ok = false
      }
      this.markWritten(ok)
      return
    }
    this.store.write(v).then(
      (ok) => this.markWritten(ok),
      () => {}
    )
  }

  /** Première écriture confirmée : la marque existe désormais sur ce PC. */
  private markWritten(ok: boolean): void {
    if (!ok || this.markStatus === 'ok') return
    this.markStatus = 'ok'
    if (!this.st.markSeen && !this.degraded) {
      this.st.markSeen = true
      this.commit()
    }
  }

  /** Nouvelle lecture de l'identifiant, programmée (5 s, 30 s, 2 min), puis
   *  la minuterie existante (tick) prend le relais. */
  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped || !this.unreadable) return
    const delays = this.o.machineRetryMs ?? MACHINE_RETRY_MS
    const delay = delays[this.retryStep]
    if (delay === undefined) return
    this.retryStep++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.retryMachine().then(() => this.scheduleRetry())
    }, delay)
    this.retryTimer.unref?.()
  }

  /** Identifiant de la machine illisible au lancement : relu. Identique :
   *  tout redevient normal. Différent : c'est une copie, les limites se
   *  ferment à ce moment (comme au lancement). */
  private async retryMachine(): Promise<void> {
    if (this.retrying || !this.unreadable || this.stopped) return
    this.retrying = true
    try {
      const machine = await this.readMachine()
      if (!machine || this.stopped) return
      const mark = await this.readMark()
      const before = this.plan()
      const beforeCard = this.card()
      this.setup(machine, mark)
      if (this.plan() !== before || this.card() !== beforeCard) this.changed()
    } finally {
      this.retrying = false
    }
  }

  // ---------- configuration du serveur ----------

  private remote(): RemoteConfig | null {
    return sanitizeRemoteConfig(this.cfg.licenseConfig)
  }

  private apiUrl(p: string): string {
    return new URL('api/license/' + p, this.baseUrl).href
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
      let date: number | null = null
      try {
        const d = Date.parse(r.headers?.get?.('date') ?? '')
        date = Number.isFinite(d) && d > Date.UTC(2020, 0, 1) && d < Date.UTC(2100, 0, 1) ? d : null
      } catch {
        date = null
      }
      return { status: r.status, body, date }
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
    let dirty = false
    const on = this.paidFrom(rc)
    if (this.st.paidMode !== on) {
      this.st.paidMode = on
      dirty = true
    }
    // date donnée par flitdrop.com : borne l'essai même si l'horloge du PC
    // est retenue en arrière
    if (r.date !== null && r.date > this.seenMs) {
      this.seenMs = r.date
      if (this.st.paidMode && r.date - this.seenSavedMs >= HOUR_MS) {
        this.st.seenAt = new Date(r.date).toISOString()
        dirty = true
      }
    }
    if (dirty) {
      this.commit()
      this.writeMark()
    }
    this.startTrialIfNeeded()
    if (this.plan() !== before || this.card() !== beforeCard) this.changed()
  }

  private storeChannel(): boolean {
    try {
      return this.o.storeChannel?.() === true
    } catch {
      return false
    }
  }

  /** Mode payant pour CETTE installation : interrupteur du serveur, et pour
   *  le Microsoft Store, storeEnabled en plus (absent : gratuit, comme avant). */
  private paidFrom(rc: RemoteConfig): boolean {
    return rc.enabled && (!this.storeChannel() || rc.storeEnabled)
  }

  /** Mode payant vu pour la première fois : l'essai commence (une fois). */
  private startTrialIfNeeded(): void {
    if (!this.inited || !this.st.paidMode || this.st.trialEndsAt || this.degraded) return
    const now = this.now()
    const remote = this.remote()
    const days = remote?.trialDays ?? DEFAULT_TRIAL_DAYS
    const installed = Date.parse(this.cfg.installedAt)
    const launched = remote?.launchedAt ? Date.parse(remote.launchedAt) : NaN
    // installation neuve (après le lancement du mode payant) : depuis son
    // premier lancement ; installation existante : depuis maintenant
    let start = Number.isFinite(launched) && Number.isFinite(installed) && installed >= launched && installed <= now ? installed : now
    if (this.mark && this.mark.start > 0 && this.mark.start < start) start = this.mark.start
    this.st.paidModeSeenAt ||= new Date(now).toISOString()
    this.st.trialStartAt = new Date(start).toISOString()
    this.st.trialEndsAt = new Date(start + days * DAY_MS).toISOString()
    this.touchSeen()
    this.commit()
    this.writeMark()
  }

  // ---------- plan ----------

  private tokenCheck(): TokenCheck | null {
    const tok = this.st.token
    // mode dégradé : l'état n'est pas vérifiable, son jeton ne compte pas
    if (!tok || this.degraded) return null
    if (this.tokenCache?.token !== tok) this.tokenCache = { token: tok, check: verifyToken(tok, this.deviceIdValue, this.pub(), this.tokenEnv) }
    return this.tokenCache.check
  }

  /** Heure de référence de l'essai : jamais avant la plus tardive vue. */
  private latestNow(): number {
    return Math.max(this.now(), this.seenMs)
  }

  plan(): Plan {
    if (!this.active || !this.inited || !this.st.paidMode) return 'off'
    // Microsoft Store : comme avant tant que le serveur ne l'allume pas
    if (this.storeChannel() && this.remote()?.storeEnabled !== true) return 'off'
    const chk = this.tokenCheck()
    if (chk?.ok && tokenUsable(chk.payload, this.now())) return 'pro'
    const ends = validTs(this.st.trialEndsAt)
    if (ends !== null && this.latestNow() < ends) return 'trial'
    return 'free'
  }

  /** Fonctions d'avant Flitdrop Pro réservées à Pro (synchro automatique du
   *  presse-papiers, historique complet) : ouvertes sauf en gratuit, et
   *  toujours pour une installation d'avant Flitdrop Pro. */
  fullFeatures(): boolean {
    return this.plan() !== 'free' || this.st.legacy
  }

  /** Photos et vidéos rangées par mois : nouveauté Pro (essai ou Pro), et
   *  seulement si le réglage est allumé. Jamais en mode payant coupé. */
  monthFolders(): boolean {
    const p = this.plan()
    return (p === 'trial' || p === 'pro') && this.cfg.sortPhotosByMonth
  }

  trialDaysLeft(): number {
    const ends = validTs(this.st.trialEndsAt)
    return ends === null ? 0 : Math.max(0, Math.ceil((ends - this.latestNow()) / DAY_MS))
  }

  // ---------- limite du jour ----------

  limited(): boolean {
    return this.plan() === 'free'
  }

  /** Fichiers comptés aujourd'hui. Horloge reculée (jour plus ancien que le
   *  dernier compté) : le compteur de ce dernier jour, jamais un jour neuf. */
  dailyUsed(): number {
    const d = this.st.dailyFiles
    if (!d.day) return 0
    return localDay(this.now()) <= d.day ? d.count : 0
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

  /** Compte des fichiers arrivés ou envoyés (gratuit seulement), aussi dans
   *  le deuxième emplacement. */
  countFiles(n = 1): void {
    if (!this.limited() || !(n > 0)) return
    const today = localDay(this.now())
    const d = this.st.dailyFiles
    // nouveau jour ; horloge reculée : le compteur du dernier jour continue
    if (!d.day || today > d.day) this.st.dailyFiles = { day: today, count: 0 }
    this.st.dailyFiles.count = Math.min(1_000_000, this.st.dailyFiles.count + Math.floor(n))
    this.touchSeen()
    this.commit()
    this.writeMark()
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

  private currency(): string {
    return currencyFor(this.o.systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale)
  }

  /** Prix affichés : ceux du serveur, sinon ceux de l'app. */
  private priceMapShown(): Record<string, string> {
    const remote = this.remote()
    return remote && Object.keys(remote.displayPrice).length > 0 ? remote.displayPrice : DEFAULT_PRICES
  }

  /** Devise du prix affiché : celle du système si le prix existe, sinon l'euro. */
  private priceKey(map: Record<string, string>): string {
    const cur = this.currency()
    if (map[cur]) return cur
    if (map.EUR) return 'EUR'
    return Object.keys(map)[0] ?? 'EUR'
  }

  /** Prix affiché partout (bouton, cartes, téléphone) : celui du pays de la
   *  personne s'il est donné, sinon celui de la devise devinée par la langue
   *  du système. */
  price(): string {
    const local = this.remote()?.price
    if (local) return local.display
    const map = this.priceMapShown()
    return map[this.priceKey(map)] ?? DEFAULT_PRICES.EUR!
  }

  /** Prix de lancement : celui que donne le serveur (pays de la personne,
   *  sinon displayPriceEarly dans la devise du prix affiché) ; calculé
   *  (moitié) seulement si le serveur n'en donne aucun. Jamais un prix
   *  inventé quand le serveur en donne. */
  private earlyPrice(): string | null {
    const remote = this.remote()
    const local = remote?.price
    if (local?.displayEarly) return local.displayEarly
    const early = remote?.displayPriceEarly ?? {}
    if (Object.keys(early).length > 0) return early[local ? local.currency : this.priceKey(this.priceMapShown())] ?? null
    return halfPrice(this.price())
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
    if (this.tooManyDevices && plan !== 'pro') return 'devices'
    const p = this.cfg.proPromptsShown
    const today = localDay(this.now())
    const shownToday = p.day === today
    if (plan === 'free' && this.dailyUsed() >= FREE_DAILY_FILES) {
      if (!shownToday || (p.kind === 'limit' && !p.closed)) return 'limit'
    }
    // installation d'avant Flitdrop Pro : le début de l'essai expliqué, une fois
    if (plan === 'trial' && this.st.legacy) {
      if ((!shownToday && p.welcome === 0) || (shownToday && p.kind === 'welcome' && !p.closed)) return 'welcome'
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
      welcome: p.welcome + (where === 'welcome' ? 1 : 0),
    }
    this.save()
    // la carte d'accueil n'est pas une invitation à acheter : pas de statistique
    if (where !== 'welcome') this.deps.track('pro_prompt_shown', { where })
  }

  /** « Plus tard », « Super » : la carte se range (pas l'attente du paiement). */
  closeCard(): void {
    if (this.justUnlocked || this.claimUsed || this.tooManyDevices) {
      this.justUnlocked = false
      this.claimUsed = false
      this.tooManyDevices = false
      return
    }
    const p = this.cfg.proPromptsShown
    if (p.day === localDay(this.now()) && !p.closed) {
      this.cfg.proPromptsShown = { ...p, closed: true }
      this.save()
    }
  }

  /** « Nous écrire » : la messagerie du système, vers l'adresse du support
   *  (adresse fixe, jamais reçue de la page). */
  contactSupport(): void {
    try {
      this.deps.openUrl(SUPPORT_MAILTO)
    } catch {
      // pas de messagerie : l'adresse est écrite dans la carte
    }
  }

  // ---------- achat ----------

  /** Achat en attente oublié (payé, annulé, refusé) : le secret part. */
  private clearClaim(): void {
    if (!this.st.claimSecret && !this.st.claimAt) return
    this.st.claimSecret = ''
    this.st.claimAt = ''
    this.commit()
  }

  /** Ouvre la page d'achat (navigateur du système) et attend le paiement.
   *  `reopen` : même achat, page rouverte (pas recompté). L'adresse ne porte
   *  que le claim, empreinte d'un secret qui reste dans l'app. */
  checkout(where: CheckoutWhere, reopen = false): { ok: boolean; url?: string } {
    const plan = this.plan()
    if (plan === 'off' || plan === 'pro' || this.degraded || !this.deviceIdValue) return { ok: false }
    if (reopen && !this.waiting) return { ok: false }
    const now = this.now()
    const early = this.earlyUntil() !== null
    this.claimUsed = false
    this.tooManyDevices = false
    // même achat tant qu'il a moins de 48 h (page déjà payée, puis recliquée)
    const at = Date.parse(this.st.claimAt)
    if (!SECRET_RE.test(this.st.claimSecret) || !Number.isFinite(at) || now - at > CLAIM_KEEP_MS) {
      this.st.claimSecret = crypto.randomBytes(32).toString('hex')
      this.st.claimAt = new Date(now).toISOString()
      this.commit()
    }
    const claim = claimFromSecret(this.st.claimSecret)
    const url = `${new URL('pro', this.baseUrl).href}?claim=${claim}&lang=${this.deps.lang()}${early ? '&early=1' : ''}`
    if (!this.waiting) this.waiting = { since: now, where, early }
    else if (!reopen) {
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
   *  30 minutes au plus) ou « J'ai payé » (`manual`). Le secret part vers le
   *  serveur des licences, et nulle part ailleurs. */
  async claim(manual: boolean): Promise<ClaimResult | 'stopped' | 'none'> {
    const w = this.waiting
    if (!w || !SECRET_RE.test(this.st.claimSecret)) return this.plan() === 'pro' ? 'unlocked' : 'none'
    const now = this.now()
    if (!manual && now - w.since > CLAIM_POLL_MAX_MS) return 'stopped'
    if (this.claimInFlight) return this.claimInFlight
    if (now - this.lastClaimAt < (manual ? 1000 : CLAIM_MIN_GAP_MS)) return 'pending'
    this.lastClaimAt = now
    const secret = this.st.claimSecret
    this.claimInFlight = (async (): Promise<ClaimResult> => {
      const r = await this.post('claim', { secret, device: this.deviceIdValue })
      if (!r) return 'offline'
      if (r.status === 200 && this.acceptToken(r.body.token, 'purchase')) return 'unlocked'
      const refused = this.claimRefused(r)
      if (refused) return refused
      // 202 en attente, 429 trop de demandes, 503 indisponible : on garde
      // l'état et on redemande plus tard
      return 'pending'
    })().finally(() => {
      this.claimInFlight = null
    })
    return this.claimInFlight
  }

  /** Refus définitifs du serveur pour cet achat : plus d'attente ni de
   *  vérification, le plan ne change pas, la carte l'explique. */
  private claimRefused(r: { status: number; body: Record<string, unknown> }): 'used' | 'devices' | null {
    if (r.status !== 403) return null
    if (r.body.error === 'claim_used') {
      // déjà utilisé sur 5 ordinateurs : « J'ai déjà acheté » reste le chemin
      this.endWaiting()
      this.claimUsed = true
      this.changed()
      return 'used'
    }
    if (r.body.error === 'too_many_devices') {
      // trop d'ordinateurs ce mois-ci : le support s'en occupe
      this.endWaiting()
      this.tooManyDevices = true
      this.changed()
      return 'devices'
    }
    return null
  }

  private endWaiting(): void {
    this.waiting = null
    this.clearClaim()
  }

  cancelCheckout(): void {
    if (!this.waiting) return
    this.endWaiting()
    this.changed()
  }

  /** Jeton reçu (achat ou restauration) : gardé seulement s'il est signé par
   *  nous, pour CETTE machine, du bon environnement, et encore valable. */
  private acceptToken(token: unknown, how: 'purchase' | 'restore'): boolean {
    if (this.degraded) return false
    const chk = verifyToken(token, this.deviceIdValue, this.pub(), this.tokenEnv)
    if (!chk.ok || !tokenUsable(chk.payload, this.now())) return false
    this.st.token = token as string
    this.st.claimSecret = ''
    this.st.claimAt = ''
    this.commit()
    this.waiting = null
    this.restore = null
    this.claimUsed = false
    this.tooManyDevices = false
    this.justUnlocked = true
    this.deps.track('pro_unlocked', { how })
    try {
      this.deps.unlocked?.(how)
    } catch {
      // réglages non critiques
    }
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

  async restoreVerify(code: unknown): Promise<{ ok: true } | { error: 'code' | 'expired' | 'nopurchase' | 'devices' | 'offline' | 'busy' | 'nochallenge' | 'error' }> {
    const rs = this.restore
    if (!rs) return { error: 'nochallenge' }
    const c = normalizeRestoreCode(code)
    if (!c) return { error: 'code' }
    const r = await this.post('restore/verify', { email: rs.email, code: c, challenge: rs.challenge, device: this.deviceIdValue })
    if (!r) return { error: 'offline' }
    if (r.status === 200 && this.acceptToken(r.body.token, 'restore')) return { ok: true }
    const e = r.body.error
    if (r.status === 400 && (e === 'code' || e === 'expired' || e === 'nopurchase')) return { error: e }
    // achat utilisé sur trop d'ordinateurs ce mois-ci : le plan ne change pas
    if (r.status === 403 && e === 'too_many_devices') return { error: 'devices' }
    return { error: r.status === 429 ? 'busy' : 'error' }
  }

  /** « Changer d'adresse » : on repart de l'e-mail. */
  restoreReset(): void {
    if (!this.restore) return
    this.restore = null
    this.changed()
  }

  // ---------- renouvellement ----------

  /** Jeton qui expire dans moins de 10 jours : renouvelé, une fois par jour.
   *  Seul un refus explicite (403 revoked) retire le jeton : hors ligne,
   *  429, 5xx ou réponse inattendue, il reste tel quel jusqu'à son échéance
   *  + 7 jours. Pas pendant une session où l'identifiant de la machine est
   *  illisible (une config copiée ne se prolonge pas ainsi). */
  async maybeRenew(): Promise<void> {
    if (!this.active || this.degraded || this.unreadable || !this.st.paidMode || !this.st.token) return
    const chk = this.tokenCheck()
    if (!chk?.ok) return
    const now = this.now()
    if (chk.payload.exp * 1000 - now > RENEW_WITHIN_MS) return
    const today = localDay(now)
    if (this.cfg.licenseRenewDay === today) return
    this.cfg.licenseRenewDay = today
    this.save()
    const sent = this.st.token
    const r = await this.post('renew', { token: sent, device: this.deviceIdValue })
    if (!r || this.st.token !== sent) return
    const before = this.plan()
    if (r.status === 200) {
      const fresh = verifyToken(r.body.token, this.deviceIdValue, this.pub(), this.tokenEnv)
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
    const secret = this.st.claimSecret
    if (!secret) return
    const at = Date.parse(this.st.claimAt)
    if (!SECRET_RE.test(secret) || !Number.isFinite(at) || this.now() - at > CLAIM_KEEP_MS) {
      this.clearClaim()
      return
    }
    const plan = this.plan()
    if ((plan !== 'free' && plan !== 'trial') || this.degraded) return
    const r = await this.post('claim', { secret, device: this.deviceIdValue })
    if (r && r.status === 200) this.acceptToken(r.body.token, 'purchase')
    else if (r) this.claimRefused(r)
  }

  /** Appelé par une minuterie qui existe déjà (toutes les 10 minutes) :
   *  configuration au plus une fois par jour (une heure après un échec),
   *  renouvellement, heure vue, changement de jour, et nouvelle lecture de
   *  l'identifiant de la machine s'il était illisible. Aucune minuterie à soi. */
  tick(): void {
    if (!this.active || !this.inited) return
    if (this.unreadable) void this.retryMachine()
    const now = this.now()
    const okAt = Date.parse(this.cfg.licenseConfigAt) || 0
    if (now - okAt >= DAY_MS && now - this.lastConfigAttempt >= HOUR_MS) void this.refreshConfig()
    void this.maybeRenew()
    // heure la plus tardive vue : enregistrée au plus une fois par heure
    if (this.st.paidMode && !this.degraded && Math.max(now, this.seenMs) - this.seenSavedMs >= HOUR_MS) {
      this.touchSeen()
      this.commit()
      this.writeMark()
    }
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
    if (this.st.legacy) out.legacy = true
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
