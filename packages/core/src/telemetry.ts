// Télémétrie de l'app de bureau, côté Node (jamais depuis le navigateur du
// téléphone). Deux niveaux :
// - « basic » : statistiques anonymes de fonctionnement, actives par défaut,
//   désactivables dans les réglages. AUCUN identifiant (ni installId, ni hash,
//   ni nom d'appareil) : chaque événement est isolé. L'ancienneté n'y figure
//   qu'en tranches (mois d'installation, 0 / 1-7 / 8-30 / 31+ jours), pour que
//   la date exacte d'installation ne serve pas de clé entre deux événements.
//   Rien ne part avant que la personne ait vu, au moins une fois, le texte qui
//   annonce ces statistiques (basicNoticeShown).
// - « full » : statistiques détaillées et rapports d'erreur, avec l'installId
//   aléatoire, UNIQUEMENT après un « oui » explicite (telemetryConsent).
// Si les deux sont coupés, rien ne part. Jamais de contenu de fichier, de nom
// de fichier, de presse-papiers, de nom d'appareil, de chemin ni d'adresse IP.
//
// Contrat partagé avec le Worker (telemetry-worker/worker.js) : enveloppe
// { event, v, ts, tier, iid?, props }, un événement par requête POST.
import os from 'node:os'
import { saveConfig, type Config } from './config.js'
import { resolveLang, langFrom, type Lang } from './i18n.js'

// Collecteur : Pages Function du site (functions/api/telemetry.js), déployée
// avec le site. Le Worker telemetry.flitdrop.com/e reste pour les versions < 0.6.4.
export const TELEMETRY_ENDPOINT = 'https://flitdrop.com/api/telemetry'

export type Tier = 'basic' | 'full'
type PropValue = string | number | boolean
export type Props = Record<string, PropValue>

export interface Envelope {
  event: string
  v: string
  ts: number
  tier: Tier
  iid?: string
  props: Props
}

// ---------- contrat : événements et clés autorisés ----------

export const COMMON_PROPS = ['os', 'arch', 'channel', 'locale', 'install_week', 'days_since_install'] as const

export const EVENTS: Record<string, { tier: Tier; props: readonly string[] }> = {
  app_first_launch: { tier: 'basic', props: [] },
  app_updated: { tier: 'basic', props: ['from_version'] },
  app_daily_active: { tier: 'basic', props: ['paired_devices', 'launches_today'] },
  pairing_success: { tier: 'basic', props: ['platform', 'first'] },
  phone_page_opened: { tier: 'basic', props: ['first', 'platform'] },
  transfer_ok: { tier: 'basic', props: ['direction', 'kind', 'size', 'first'] },
  transfer_fail: { tier: 'basic', props: ['direction', 'kind', 'status', 'reason'] },
  welcome_shown: { tier: 'full', props: [] },
  welcome_pair_clicked: { tier: 'full', props: [] },
  welcome_skipped: { tier: 'full', props: [] },
  pair_qr_shown: { tier: 'full', props: [] },
  pair_link_copied: { tier: 'full', props: [] },
  phone_connect: { tier: 'full', props: ['platform'] },
  settings_changed: { tier: 'full', props: ['key'] },
  history_opened: { tier: 'full', props: [] },
  telemetry_choice: { tier: 'full', props: ['choice', 'where'] },
  $exception: {
    tier: 'full',
    props: ['$exception_type', '$exception_message', '$exception_stack_trace_raw', 'source', 'handled'],
  },
}

/** Événements que l'interface du PC peut demander (endpoint admin local). */
export const UI_EVENTS = new Set([
  'welcome_shown',
  'welcome_pair_clicked',
  'welcome_skipped',
  'pair_qr_shown',
  'pair_link_copied',
  'history_opened',
])

const MAX_LEN: Record<string, number> = { $exception_message: 300, $exception_stack_trace_raw: 4000 }

export type Direction = 'phone_to_pc' | 'pc_to_phone'
export type Kind = 'file' | 'photo' | 'text' | 'clipboard'

/** Tranche de taille : on ne transmet jamais la taille exacte d'un fichier. */
export function sizeBucket(bytes: number): string {
  if (bytes < 1024 * 1024) return '<1MB'
  if (bytes < 10 * 1024 * 1024) return '1-10MB'
  if (bytes < 100 * 1024 * 1024) return '10-100MB'
  if (bytes < 1024 * 1024 * 1024) return '100MB-1GB'
  return '>1GB'
}

/** Fichier ou photo, d'après le seul type MIME (jamais le nom). */
export function kindOf(mime: string | undefined): Kind {
  return typeof mime === 'string' && /^image\//i.test(mime) ? 'photo' : 'file'
}

/** Plateforme du téléphone ramenée à trois valeurs. */
export function platformOf(p: string | undefined): 'ios' | 'android' | 'other' {
  if (p === 'iphone' || p === 'ipad' || p === 'ios') return 'ios'
  if (p === 'android') return 'android'
  return 'other'
}

/** Type de téléphone d'après l'en-tête User-Agent de la page (jamais gardé). */
export function platformFromUserAgent(ua: string | undefined): 'ios' | 'android' | 'other' {
  const s = typeof ua === 'string' ? ua : ''
  if (/iPhone|iPad|iPod/.test(s)) return 'ios'
  if (/Android/.test(s)) return 'android'
  return 'other'
}

// une même page de téléphone rechargée ou rouverte compte au plus une fois
// par tranche de 10 minutes
const PAGE_OPEN_DEDUPE_MS = 10 * 60 * 1000

// ---------- dates ----------

/** Jour LOCAL au format AAAA-MM-JJ (le « jour actif » de la personne). */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Mois (« 2026-09 ») d'une date, en UTC : l'ancienneté du niveau de base. */
export function isoMonth(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Jours depuis l'installation ramenés à une tranche, notée par sa borne
 *  basse : 0 (jour même), 1 (1 à 7), 8 (8 à 30), 31 (31 et plus). */
export function dayBucket(days: number): number {
  if (!(days > 0)) return 0
  if (days <= 7) return 1
  if (days <= 30) return 8
  return 31
}

/** Semaine ISO 8601 (« 2026-W39 ») d'une date, en UTC. */
export function isoWeek(ms: number): string {
  const d = new Date(ms)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// ---------- nettoyage des erreurs ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// fichiers du code de Flitdrop dont on garde le nom dans une pile d'appels
const CODE_FILES = /^(?:flitdrop|cli|updater|main)\.cjs$|^app\.js$|^[\w-]+\.ts$/

/** Réduit un chemin à ce qui est utile au diagnostic SANS rien révéler :
 *  « app.asar/… » ou « core/flitdrop.cjs:12:3 » pour le code de l'app,
 *  « node_modules/paquet/… » pour une dépendance, sinon « <path> ». La partie
 *  gardée ne contient jamais d'espace : sinon ce n'est pas du code de l'app. */
function codePath(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const asar = norm.indexOf('app.asar')
  if (asar >= 0 && !/\s/.test(norm.slice(asar))) return norm.slice(asar)
  const nm = norm.lastIndexOf('/node_modules/')
  if (nm >= 0 && !/\s/.test(norm.slice(nm))) return norm.slice(nm + 1)
  const m = norm.match(/(?:^|\/)((?:core|public\/desktop|public\/phone|dist|src(?:\/webclient)?)\/([^/]+?))((?::\d+)*)$/)
  if (m?.[1] && m[2] && CODE_FILES.test(m[2])) return m[1] + (m[3] ?? '')
  return norm.startsWith('~') ? '~/<path>' : '<path>'
}

/** Retire d'un message ou d'une pile tout ce qui pourrait identifier la
 *  personne ou ses fichiers : dossier personnel (remplacé par ~), chemins hors
 *  code de l'app, requêtes et fragments d'URL (jetons, clés d'appairage),
 *  secrets connus, longues chaînes aléatoires, IP, e-mails, nom de la machine. */
export function scrub(input: string, opts: { secrets?: string[]; home?: string; host?: string } = {}): string {
  let s = String(input ?? '')
  for (const secret of opts.secrets ?? []) {
    if (secret && secret.length >= 6) s = s.split(secret).join('<secret>')
  }
  // requête et fragment d'URL : le jeton admin (?k=) et la clé d'appairage (#)
  s = s.replace(/(\b[a-z][\w+.-]*:\/\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*/gi, '$1')
  s = s.replace(/([?&](?:k|t|token|key|code|auth)=)[^\s&'"()<>]+/gi, '$1<secret>')
  s = s.replace(/\bfile:\/\/(?=\/|[A-Za-z]:)/gi, '')
  const home = opts.home ?? os.homedir()
  if (home && home.length > 1) {
    s = s.replace(new RegExp(esc(home), 'gi'), '~')
    s = s.replace(new RegExp(esc(home.replace(/\\/g, '/')), 'gi'), '~')
  }
  // chemins : on ne garde que ceux du code de l'app (app.asar, bundles), le reste
  // (fichiers, dossiers de la personne) devient <path>. D'abord les chemins
  // entre guillemets (qui peuvent contenir des espaces), puis les autres.
  s = s.replace(/(['"`])([^'"`\n]*[\\/][^'"`\n]*)\1/g, (_m, q: string, inner: string) =>
    /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(inner) ? q + codePath(inner) + q : q + inner + q
  )
  s = scrubBarePaths(s)
  const host = opts.host ?? os.hostname()
  if (host && host.length >= 4) s = s.replace(new RegExp(`\\b${esc(host.split('.')[0] ?? host)}\\b`, 'gi'), '<host>')
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
  s = s.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>')
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
  return s
}

// début d'un chemin absolu hors guillemets : C:\ , \\serveur, /, ~/
const PATH_START = /(?<![\w:/\\.~<-])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[^\s/<])|~[\\/](?!<))/g
// fin possible d'un chemin hors guillemets : fin de ligne, guillemet, chevron,
// parenthèse (sauf « (x86) » de Program Files), flèche « -> », ou espace suivi
// d'un autre chemin
const PATH_END = /\n|['"`<>]|\((?!x86\))|\)(?=\s|$|:)| -> |\s(?=(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/[^\s/<]))/g
// dernier mot à extension (« photo.jpg », « flitdrop.cjs:12:3 ») d'un nom
const EXT_TOKEN = /\.[A-Za-z0-9]{1,10}(?::\d+)*\b/g

/** Chemins hors guillemets. Un nom de fichier ou de dossier peut contenir des
 *  espaces (« Photo vacances.jpg », « USB Key », « Program Files ») : le chemin
 *  va donc jusqu'au dernier séparateur avant la fin possible, puis jusqu'au
 *  dernier mot à extension ; sans extension, jusqu'à cette fin. Mieux vaut
 *  effacer un peu trop de texte que laisser passer un morceau de nom. */
function scrubBarePaths(s: string): string {
  let out = ''
  let pos = 0
  PATH_START.lastIndex = 0
  for (let m = PATH_START.exec(s); m; m = PATH_START.exec(s)) {
    const start = m.index
    PATH_END.lastIndex = start + m[0].length
    const endMatch = PATH_END.exec(s)
    const limit = endMatch ? endMatch.index : s.length
    const seg = s.slice(start, limit)
    const lastSep = Math.max(seg.lastIndexOf('/'), seg.lastIndexOf('\\'))
    const tail = seg.slice(lastSep + 1)
    let cut = tail.replace(/\s+$/, '').length
    let ext: RegExpExecArray | null
    EXT_TOKEN.lastIndex = 0
    while ((ext = EXT_TOKEN.exec(tail))) cut = ext.index + ext[0].length
    const end = start + lastSep + 1 + cut
    out += s.slice(pos, start) + codePath(s.slice(start, end))
    pos = end
    PATH_START.lastIndex = Math.max(end, start + 1)
  }
  return out + s.slice(pos)
}

// ---------- module ----------

export interface TelemetryOptions {
  /** Version de l'app (package.json de l'app de bureau). */
  version: string
  /** Canal d'installation : nsis, store, dmg, appimage, deb, dev. « store »
   *  est mémorisé dans la config : une mise à jour automatique (installeur
   *  GitHub) ne le fait pas redevenir « nsis ». */
  channel: string
  /** Langue du système (app.getLocale() côté Electron). */
  systemLocale?: string
  endpoint?: string
  /** Injectables pour les tests. */
  fetchImpl?: typeof fetch
  now?: () => number
  /** Force l'activation malgré FLITDROP_NO_TELEMETRY / VITEST (tests). */
  disabled?: boolean
  /** Intervalle de vérification du changement de jour (ms). */
  tickMs?: number
}

export interface TelemetryDeps {
  home: string
  cfg: Config
  /** Nombre de téléphones appairés (0, 1, 2 et plus). */
  pairedDevices: () => number
}

const QUEUE_CAP = 50
const SEND_TIMEOUT_MS = 5000
const EXC_PER_HOUR = 20

interface Job {
  env: Envelope
  onSent?: () => void
}

export class Telemetry {
  readonly active: boolean
  private queue: Job[] = []
  private pumping: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private dailyInFlight = false
  private lifecycleInFlight = false
  private excTimes: number[] = []
  private excSeen = new Map<string, number>()
  private lastPhoneConnect = new Map<string, number>()
  // clé « adresse du téléphone|type » -> dernière ouverture comptée. En mémoire
  // seulement : jamais écrit sur le disque, jamais envoyé.
  private lastPageOpen = new Map<string, number>()
  private now: () => number
  private fetchImpl: typeof fetch | undefined

  constructor(
    private deps: TelemetryDeps,
    private opts: TelemetryOptions
  ) {
    const envOff = process.env.FLITDROP_NO_TELEMETRY === '1' || !!process.env.VITEST
    this.active = opts.disabled === undefined ? !envOff : !opts.disabled
    this.now = opts.now ?? (() => Date.now())
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  }

  private get cfg(): Config {
    return this.deps.cfg
  }

  /** Niveau effectif : full si consentement explicite, sinon basic si les
   *  statistiques de base sont actives, sinon rien. */
  tier(): Tier | null {
    if (this.cfg.telemetryConsent) return 'full'
    if (this.cfg.basicStats) return 'basic'
    return null
  }

  private save(): void {
    try {
      saveConfig(this.deps.home, this.cfg)
    } catch {
      // disque plein, droits : la télémétrie ne casse jamais l'app
    }
  }

  private locale(): Lang {
    return resolveLang(this.cfg.lang, langFrom(this.opts.systemLocale || Intl.DateTimeFormat().resolvedOptions().locale))
  }

  /** Canal effectif : une installation venue du Store reste « store » même
   *  après une mise à jour par l'installeur classique. */
  channel(): string {
    if (this.opts.channel === 'store' && this.cfg.installChannel !== 'store') {
      this.cfg.installChannel = 'store'
      this.save()
    }
    return this.cfg.installChannel === 'store' && this.opts.channel === 'nsis' ? 'store' : this.opts.channel
  }

  private commonProps(tier: Tier): Props {
    const now = this.now()
    const installed = Date.parse(this.cfg.installedAt)
    const since = Number.isFinite(installed) ? Math.max(0, Math.floor((now - installed) / 86_400_000)) : 0
    const at = Number.isFinite(installed) ? installed : now
    const osTag = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    return {
      os: osTag,
      arch: process.arch,
      channel: this.channel(),
      locale: this.locale(),
      // niveau de base : tranches seulement (voir en tête du fichier)
      install_week: tier === 'full' ? isoWeek(at) : isoMonth(at),
      days_since_install: tier === 'full' ? since : dayBucket(since),
    }
  }

  /** Construit l'enveloppe si l'événement est autorisé au niveau courant.
   *  Filtre les clés hors contrat et les valeurs non plates. */
  build(event: string, props: Props = {}): Envelope | null {
    const spec = EVENTS[event]
    const tier = this.tier()
    if (!spec || !tier) return null
    if (spec.tier === 'full' && tier !== 'full') return null
    // statistiques de base : jamais avant que leur annonce ait été affichée
    if (tier === 'basic' && !this.cfg.basicNoticeShown) return null
    const out: Props = {}
    for (const k of spec.props) {
      const v = props[k]
      if (v === undefined) continue
      if (typeof v === 'boolean') out[k] = v
      else if (typeof v === 'number') {
        if (Number.isFinite(v)) out[k] = v
      } else if (typeof v === 'string') out[k] = v.slice(0, MAX_LEN[k] ?? 40)
    }
    Object.assign(out, this.commonProps(tier))
    const env: Envelope = { event, v: this.opts.version.slice(0, 16), ts: this.now(), tier, props: out }
    // l'identifiant d'installation n'existe QUE dans le niveau détaillé
    if (tier === 'full') env.iid = this.cfg.installId.slice(0, 40)
    return env
  }

  /** Envoie un événement (file mémoire bornée, jamais bloquant, jamais d'erreur). */
  track(event: string, props: Props = {}, onSent?: () => void): boolean {
    if (!this.active) return false
    const env = this.build(event, props)
    if (!env) return false
    if (this.queue.length >= QUEUE_CAP) return false
    this.queue.push({ env, onSent })
    this.pump()
    return true
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = (async () => {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        const ok = await this.send(job.env)
        if (ok && job.onSent) {
          try {
            job.onSent()
          } catch {
            // ignore
          }
        }
      }
    })().finally(() => {
      this.pumping = null
    })
  }

  private async send(env: Envelope): Promise<boolean> {
    const f = this.fetchImpl
    if (!f) return false
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS)
    timer.unref?.()
    try {
      const r = await f(this.opts.endpoint ?? TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
        signal: ctrl.signal,
      })
      return r.ok
    } catch {
      // hors ligne, DNS, pare-feu : on abandonne cet événement, sans réessai
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Attend que la file soit vide (tests, fermeture propre). */
  async flush(): Promise<void> {
    while (this.pumping) await this.pumping
  }

  // ---------- cycle de vie ----------

  /** Au lancement : première installation ou mise à jour, puis actif du jour,
   *  et surveillance du changement de jour tant que l'app tourne. */
  start(): void {
    if (!this.active) return
    this.channel()
    this.lifecycle()
    this.dailyCheck()
    const tick = this.opts.tickMs ?? 5 * 60 * 1000
    this.timer = setInterval(() => this.dailyCheck(), tick)
    this.timer.unref?.()
  }

  /** Premier lancement ou mise à jour. Marqué seulement une fois ENVOYÉ :
   *  hors ligne, ou annonce pas encore affichée, on retente plus tard
   *  (toujours un seul événement reçu). */
  private lifecycle(): void {
    const version = this.opts.version.slice(0, 16)
    const last = this.cfg.lastVersion
    if (last === version || this.lifecycleInFlight) return
    const markSeen = () => {
      this.cfg.lastVersion = version
      this.save()
    }
    const event = last === '' ? 'app_first_launch' : 'app_updated'
    const props: Props = last === '' ? {} : { from_version: last }
    this.lifecycleInFlight = true
    if (this.track(event, props, markSeen)) {
      void this.flush().finally(() => {
        this.lifecycleInFlight = false
      })
      return
    }
    this.lifecycleInFlight = false
    // tout est coupé : rien ne partira, inutile de garder l'événement en attente
    if (this.tier() === null) markSeen()
  }

  /** L'interface a affiché (ou la personne a réglé) les statistiques : les
   *  événements retenus jusque-là (lancement, actif du jour) peuvent partir. */
  noticeShown(): void {
    if (!this.cfg.basicNoticeShown) {
      this.cfg.basicNoticeShown = true
      this.save()
    }
    if (!this.active) return
    this.lifecycle()
    this.dailyCheck()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** app_daily_active au plus une fois par jour local ; marqué une fois reçu
   *  par le serveur, sinon retenté au prochain passage (toutes les 5 min). */
  dailyCheck(): void {
    if (!this.active || this.dailyInFlight) return
    const today = localDay(this.now())
    if (this.cfg.lastDailyActiveDay === today) return
    const n = this.deps.pairedDevices()
    this.dailyInFlight = true
    const queued = this.track('app_daily_active', { paired_devices: n >= 2 ? 2 : n > 0 ? 1 : 0 }, () => {
      this.cfg.lastDailyActiveDay = today
      this.save()
    })
    if (!queued) {
      this.dailyInFlight = false
      return
    }
    void this.flush().finally(() => {
      this.dailyInFlight = false
    })
  }

  // ---------- événements métier ----------

  pairingSuccess(platform: string | undefined): void {
    const first = !this.cfg.firstPairingDone
    if (first) {
      this.cfg.firstPairingDone = true
      this.save()
    }
    this.track('pairing_success', { platform: platformOf(platform), first })
  }

  /** Téléphone déjà appairé qui se reconnecte (au plus une fois par heure). */
  phoneConnect(deviceId: string, platform: string | undefined): void {
    const now = this.now()
    const last = this.lastPhoneConnect.get(deviceId) ?? 0
    if (now - last < 60 * 60 * 1000) return
    this.lastPhoneConnect.set(deviceId, now)
    if (this.lastPhoneConnect.size > 200) this.lastPhoneConnect.clear()
    this.track('phone_connect', { platform: platformOf(platform) })
  }

  /** Un téléphone vient de charger la page Flitdrop servie par le PC (étape
   *  « QR scanné » du chemin de connexion, avant tout appairage). `client`
   *  sert seulement à ne pas recompter la même page (en mémoire). */
  phonePageOpened(client: string, userAgent: string | undefined): void {
    const now = this.now()
    const platform = platformFromUserAgent(userAgent)
    const k = `${client}|${platform}`
    const last = this.lastPageOpen.get(k)
    if (last !== undefined && now - last < PAGE_OPEN_DEDUPE_MS) return
    if (this.lastPageOpen.size >= 200) {
      for (const [key, ts] of this.lastPageOpen) if (now - ts >= PAGE_OPEN_DEDUPE_MS) this.lastPageOpen.delete(key)
      if (this.lastPageOpen.size >= 200) this.lastPageOpen.clear()
    }
    this.lastPageOpen.set(k, now)
    const first = !this.cfg.firstPhonePageDone
    if (first) {
      this.cfg.firstPhonePageDone = true
      this.save()
    }
    this.track('phone_page_opened', { first, platform })
  }

  transferOk(direction: Direction, kind: Kind, bytes?: number): void {
    const first = !this.cfg.firstTransferDone
    if (first) {
      this.cfg.firstTransferDone = true
      this.save()
    }
    const props: Props = { direction, kind, first }
    if ((kind === 'file' || kind === 'photo') && typeof bytes === 'number') props.size = sizeBucket(bytes)
    this.track('transfer_ok', props)
  }

  transferFail(direction: Direction, kind: Kind, status: number, reason: string): void {
    // catégorie courte uniquement (code d'erreur), jamais un message libre
    const r = String(reason || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'unknown'
    this.track('transfer_fail', { direction, kind, status: Number.isFinite(status) ? status : 0, reason: r })
  }

  /** Rapport d'erreur (niveau détaillé uniquement), nettoyé, dédoublonné et
   *  limité à 20 par heure. */
  exception(err: unknown, source: 'main' | 'server' | 'desktop' | 'phone', handled: boolean): void {
    if (!this.active || this.tier() !== 'full') return
    const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null
    const type = typeof e?.name === 'string' && e.name ? e.name : typeof err === 'string' ? 'Error' : 'UnknownError'
    const rawMsg = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : String(err)
    const rawStack = typeof e?.stack === 'string' ? e.stack : ''
    const scrubOpts = { secrets: [this.cfg.adminToken, this.cfg.instanceId, this.cfg.installId, this.cfg.deviceName] }
    const message = scrub(rawMsg, scrubOpts).slice(0, 300)
    const stack = scrub(rawStack, scrubOpts).slice(0, 4000)
    const now = this.now()
    const sig = `${source}|${type}|${message}`
    const seen = this.excSeen.get(sig)
    if (seen !== undefined && now - seen < 60 * 60 * 1000) return
    this.excTimes = this.excTimes.filter((t) => now - t < 60 * 60 * 1000)
    if (this.excTimes.length >= EXC_PER_HOUR) return
    this.excTimes.push(now)
    this.excSeen.set(sig, now)
    if (this.excSeen.size > 500) this.excSeen.clear()
    this.track('$exception', {
      $exception_type: scrub(type).slice(0, 40),
      $exception_message: message,
      $exception_stack_trace_raw: stack,
      source,
      handled,
    })
  }
}
