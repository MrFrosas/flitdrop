import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, DEFAULT_MAX_FILE_MB } from './constants.js'
import { randomToken } from './crypto.js'

export interface Config {
  deviceName: string
  port: number
  downloadDir: string
  maxFileMB: number
  requireApproval: boolean
  adminToken: string
  // identité secrète unique de CE PC. Chaque appairage y est lié : un téléphone
  // appairé à ce PC ne peut pas être utilisé avec un autre PC, même sur le même
  // wifi. « Réinitialiser ce PC » la fait tourner pour invalider tous les
  // appairages d'un coup (utile quand on prête ou revend la machine).
  instanceId: string
  // le PC surveille son presse-papiers et le met à disposition des téléphones
  // dès qu'il change (sens PC vers téléphone, seul sens automatisable côté PC).
  clipboardAutoPush: boolean
  // la personne l'a déjà coupé elle-même : un achat de Flitdrop Pro ne le
  // rallume jamais tout seul
  clipboardAutoPushOffByUser: boolean
  // historique local du presse-papiers (façon Paste) : tout ce qui est copié
  // sur le PC et reçu des téléphones, purgé automatiquement selon la rétention.
  clipHistoryEnabled: boolean
  clipHistoryMaxItems: number
  clipHistoryMaxDays: number
  // apparence de l'interface PC : suit l'OS, ou forcée claire/sombre.
  theme: 'system' | 'light' | 'dark'
  // style de l'interface : 'auto' suit l'OS réel (Apple sur Mac, Windows sur
  // Windows) ; on peut forcer l'un ou l'autre indépendamment du système.
  skin: 'auto' | 'apple' | 'windows'
  // langue de l'interface : 'auto' suit le système, sinon forcée.
  lang: 'auto' | 'fr' | 'en' | 'de'
  // partage direct via le Raccourci iOS. Pratique mais NON chiffré (jeton en
  // clair sur le réseau) : à désactiver sur un wifi public non fiable.
  shortcutsEnabled: boolean
  // mises à jour automatiques (téléchargées en arrière-plan, installées sur
  // proposition). Activé par défaut.
  autoUpdate: boolean
  // statistiques anonymes de base (lancement, appairage, transfert réussi ou
  // non), sans aucun identifiant. Actives par défaut, désactivables.
  basicStats: boolean
  // statistiques détaillées + rapports d'erreur, avec un identifiant
  // d'installation aléatoire : UNIQUEMENT après un « oui » explicite.
  telemetryConsent: boolean
  // la question « Aider à améliorer Flitdrop ? » a reçu une réponse.
  telemetryAsked: boolean
  // le texte qui annonce les statistiques de base a été affiché au moins une
  // fois (accueil, carte en haut de la fenêtre) ou la personne a fait un choix.
  // Avant, même les statistiques de base ne partent pas : une installation
  // mise à jour depuis une version où tout était décoché n'envoie rien tant
  // qu'elle n'a pas été prévenue.
  basicNoticeShown: boolean
  // identifiant aléatoire de CETTE installation, envoyé seulement avec les
  // statistiques détaillées (jamais avec les statistiques de base).
  installId: string
  // date de première installation (ISO). Pour une installation antérieure à
  // la télémétrie, la plus ancienne date fiable trouvée sur disque.
  installedAt: string
  // 'store' si cette installation vient du Microsoft Store (marqueur posé par
  // l'installeur du Store), '' sinon. Gardé après une mise à jour automatique.
  installChannel: string
  // dernière version lancée ('' = jamais lancée, 'unknown' = installation
  // antérieure à ce suivi : on enverra app_updated, pas app_first_launch).
  lastVersion: string
  firstPairingDone: boolean
  firstTransferDone: boolean
  // un téléphone a déjà ouvert la page Flitdrop de ce PC (statistique
  // « page ouverte », premier passage ou non)
  firstPhonePageDone: boolean
  // dernier jour local (AAAA-MM-JJ) où app_daily_active a été envoyé.
  lastDailyActiveDay: string
  // destinataire du dernier envoi fait depuis le PC quand plusieurs téléphones
  // sont appairés : 'all' ou l'identifiant d'un téléphone ('' = pas encore
  // choisi). Proposé par défaut au prochain envoi.
  lastSendTo: string
  // la question « Lancer Flitdrop à l'ouverture de ma session » (écran
  // d'accueil) a reçu une réponse. Faux seulement pour une installation neuve
  // (aucun config.json) : une installation existante garde son réglage.
  autostartAsked: boolean
  // transferts réussis comptés pour la demande de note, puis plus rien : le
  // compteur s'arrête dès que la carte est due (au plus 23 écritures en tout)
  okTransfers: number
  // demande de note : '' pas encore montrée ou sans réponse, 'later' reportée
  // une fois (« Plus tard »), 'done' plus jamais (« Noter », ou 2e « Plus tard »)
  rateState: '' | 'later' | 'done'
  // valeur de okTransfers au moment du premier « Plus tard »
  rateLaterAt: number
  // ---------- Flitdrop Pro (license.ts) ----------
  // identifiant d'appareil de la licence : empreinte de l'identifiant de la
  // machine (jamais l'identifiant lui-même). Différent de celui calculé au
  // lancement : config copiée d'un autre PC, son jeton est ignoré (sauf
  // identité de secours gardée pour son jeton sur cette machine, license.ts).
  licenseDeviceId: string
  // identifiant aléatoire de secours, seulement si celui de la machine était
  // illisible au premier lancement ('' sinon, et effacé dès que l'état passe
  // à l'identifiant de la machine)
  licenseFallbackId: string
  // état signé : essai, mode payant vu, compteur du jour, jeton (null : rien
  // encore). Retouché à la main : limites fermées (voir license.ts).
  licenseState: LicenseStateStored | null
  // dernière configuration publique reçue de flitdrop.com (affichage : prix,
  // offre de lancement), et sa date
  licenseConfig: Record<string, unknown> | null
  licenseConfigAt: string
  // dernier jour local où le renouvellement du jeton a été tenté
  licenseRenewDay: string
  // dernier jour local où « limite du jour atteinte » a été compté
  dailyLimitReportedDay: string
  // Pro : photos et vidéos reçues rangées dans un dossier par mois (AAAA-MM).
  // Allumé par défaut ; sans effet en gratuit ou mode payant coupé.
  sortPhotosByMonth: boolean
  // invitations Pro dans la fenêtre : au plus une par jour (jour, carte,
  // rangée par « Plus tard »), et combien de fois chacune a été montrée
  proPromptsShown: { day: string; kind: '' | 'limit' | 'trial' | 'welcome'; closed: boolean; limit: number; trial: number; welcome: number }
}

/** État de la licence tel qu'enregistré (voir LicenseState dans license.ts),
 *  avec son empreinte HMAC. */
export interface LicenseStateStored {
  paidMode: boolean
  paidModeSeenAt: string
  trialStartAt: string
  trialEndsAt: string
  dailyFiles: { day: string; count: number }
  token: string
  claimSecret: string
  claimAt: string
  seenAt: string
  markSeen: boolean
  legacy: boolean
  /** état créé sous une identité de secours : empreinte de la session */
  fallbackHost: string
  /** identité de secours gardée pour son jeton : empreinte de la machine */
  machineDev: string
  /** empreinte liée à la machine */
  mac: string
  /** empreinte liée à l'identité gardée et à la session (lancement où
   *  l'identifiant de la machine est illisible) */
  mac2: string
}

export function flitdropHome(override?: string): string {
  const h = override || process.env.FLITDROP_HOME || path.join(os.homedir(), '.flitdrop')
  // 0700 : dossier privé (clés, presse-papiers, jetons). Sans effet sur Windows.
  fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  // dossier créé par une version d'avant ce durcissement (0755, fichiers
  // 0644) : resserré à chaque démarrage, sinon un autre compte de
  // l'ordinateur pouvait lire le jeton de la page et les clés des téléphones
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(h, 0o700)
      for (const f of fs.readdirSync(h, { withFileTypes: true })) {
        if (f.isFile()) fs.chmodSync(path.join(h, f.name), 0o600)
        else if (f.isDirectory()) fs.chmodSync(path.join(h, f.name), 0o700)
      }
    } catch {
      // dossier d'un autre propriétaire (lancement avec sudo) : laissé tel quel
    }
  }
  return h
}

export function defaultDeviceName(): string {
  const raw = (os.hostname().split('.')[0] ?? '').replace(/[-_]+/g, ' ').trim()
  return raw.slice(0, 32) || 'Mon PC'
}

export function loadConfig(home: string): Config {
  const p = path.join(home, 'config.json')
  let stored: Partial<Config> = {}
  let existed = false
  try {
    stored = JSON.parse(fs.readFileSync(p, 'utf8'))
    existed = true
  } catch {
    // premier lancement
  }
  // migration : un config.json écrit par une version antérieure au suivi
  // d'installation n'a pas d'installId. Ce n'est PAS un nouvel utilisateur.
  const legacy = existed && typeof stored.installId !== 'string'
  const legacyHistory = legacy ? legacyUsage(home) : { paired: false, transferred: false }
  const cfg: Config = {
    deviceName: stored.deviceName || defaultDeviceName(),
    port: validPort(stored.port) ?? DEFAULT_PORT,
    downloadDir:
      stored.downloadDir || process.env.FLITDROP_DOWNLOADS || path.join(os.homedir(), 'Downloads', 'Flitdrop'),
    maxFileMB: clampInt(stored.maxFileMB, 1, 128 * 1024, DEFAULT_MAX_FILE_MB),
    requireApproval: stored.requireApproval === true,
    adminToken: typeof stored.adminToken === 'string' && stored.adminToken.length >= 20 ? stored.adminToken : randomToken(24),
    instanceId: typeof stored.instanceId === 'string' && stored.instanceId.length >= 12 ? stored.instanceId : randomToken(12),
    clipboardAutoPush: stored.clipboardAutoPush === true,
    clipboardAutoPushOffByUser: stored.clipboardAutoPushOffByUser === true,
    clipHistoryEnabled: stored.clipHistoryEnabled !== false,
    clipHistoryMaxItems: clampInt(stored.clipHistoryMaxItems, 10, 1000, 200),
    clipHistoryMaxDays: clampInt(stored.clipHistoryMaxDays, 1, 90, 7),
    theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
    skin: stored.skin === 'apple' || stored.skin === 'windows' ? stored.skin : 'auto',
    lang: stored.lang === 'fr' || stored.lang === 'en' || stored.lang === 'de' ? stored.lang : 'auto',
    shortcutsEnabled: stored.shortcutsEnabled !== false,
    autoUpdate: stored.autoUpdate !== false,
    basicStats: stored.basicStats !== false,
    telemetryConsent: stored.telemetryConsent === true,
    telemetryAsked: stored.telemetryAsked === true,
    basicNoticeShown: stored.basicNoticeShown === true || stored.telemetryAsked === true,
    installId:
      typeof stored.installId === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(stored.installId) ? stored.installId : randomToken(16),
    installedAt: validIso(stored.installedAt) ?? (legacy ? oldestKnownDate(home) : new Date().toISOString()),
    installChannel: stored.installChannel === 'store' ? 'store' : '',
    lastVersion: typeof stored.lastVersion === 'string' ? stored.lastVersion.slice(0, 16) : legacy ? 'unknown' : '',
    firstPairingDone: stored.firstPairingDone === true || legacyHistory.paired,
    firstTransferDone: stored.firstTransferDone === true || legacyHistory.transferred,
    lastDailyActiveDay: typeof stored.lastDailyActiveDay === 'string' ? stored.lastDailyActiveDay.slice(0, 10) : '',
    firstPhonePageDone: false,
    lastSendTo: typeof stored.lastSendTo === 'string' && /^(all|[A-Za-z0-9_-]{1,40})$/.test(stored.lastSendTo) ? stored.lastSendTo : '',
    // absent d'un config.json existant : installation d'avant cette question,
    // son réglage de démarrage reste tel quel (jamais changé en silence)
    autostartAsked: typeof stored.autostartAsked === 'boolean' ? stored.autostartAsked : existed,
    okTransfers: clampInt(stored.okTransfers, 0, 1_000_000, 0),
    rateState: stored.rateState === 'later' || stored.rateState === 'done' ? stored.rateState : '',
    rateLaterAt: clampInt(stored.rateLaterAt, 0, 1_000_000, 0),
    licenseDeviceId: typeof stored.licenseDeviceId === 'string' && /^[0-9a-f]{32}$/.test(stored.licenseDeviceId) ? stored.licenseDeviceId : '',
    licenseFallbackId: typeof stored.licenseFallbackId === 'string' && /^[0-9a-f]{32}$/.test(stored.licenseFallbackId) ? stored.licenseFallbackId : '',
    licenseState: licenseStateFrom(stored.licenseState),
    licenseConfig: stored.licenseConfig && typeof stored.licenseConfig === 'object' && !Array.isArray(stored.licenseConfig) ? stored.licenseConfig : null,
    licenseConfigAt: anyIso(stored.licenseConfigAt) ?? '',
    licenseRenewDay: typeof stored.licenseRenewDay === 'string' ? stored.licenseRenewDay.slice(0, 10) : '',
    dailyLimitReportedDay: typeof stored.dailyLimitReportedDay === 'string' ? stored.dailyLimitReportedDay.slice(0, 10) : '',
    sortPhotosByMonth: stored.sortPhotosByMonth !== false,
    proPromptsShown: promptsFrom(stored.proPromptsShown),
  }
  // migration : absent d'un config.json plus ancien. Une installation qui a
  // déjà appairé un téléphone ou transféré quelque chose a forcément vu la page
  // s'ouvrir sur un téléphone : ce ne sera pas une « première fois ».
  cfg.firstPhonePageDone = stored.firstPhonePageDone === true || cfg.firstPairingDone || cfg.firstTransferDone
  saveConfig(home, cfg)
  return cfg
}

/** État de licence lu tel quel (types seulement) : la moindre valeur
 *  changée casse son empreinte, vérifiée par license.ts. Jamais corrigé ici,
 *  sinon un état légitime deviendrait faux. */
function licenseStateFrom(v: unknown): LicenseStateStored | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const s = v as Record<string, unknown>
  const d = (s.dailyFiles && typeof s.dailyFiles === 'object' ? s.dailyFiles : {}) as Record<string, unknown>
  const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '')
  return {
    paidMode: s.paidMode === true,
    paidModeSeenAt: str(s.paidModeSeenAt, 40),
    trialStartAt: str(s.trialStartAt, 40),
    trialEndsAt: str(s.trialEndsAt, 40),
    dailyFiles: { day: str(d.day, 10), count: typeof d.count === 'number' && Number.isFinite(d.count) ? d.count : 0 },
    token: str(s.token, 4096),
    claimSecret: str(s.claimSecret, 64),
    claimAt: str(s.claimAt, 40),
    seenAt: str(s.seenAt, 40),
    markSeen: s.markSeen === true,
    legacy: s.legacy === true,
    fallbackHost: str(s.fallbackHost, 64),
    machineDev: str(s.machineDev, 64),
    mac: str(s.mac, 64),
    mac2: str(s.mac2, 64),
  }
}

function promptsFrom(v: unknown): Config['proPromptsShown'] {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    day: typeof p.day === 'string' ? p.day.slice(0, 10) : '',
    kind: p.kind === 'limit' || p.kind === 'trial' || p.kind === 'welcome' ? p.kind : '',
    closed: p.closed === true,
    limit: clampInt(p.limit, 0, 1_000_000, 0),
    trial: clampInt(p.trial, 0, 1_000_000, 0),
    welcome: clampInt(p.welcome, 0, 1_000_000, 0),
  }
}

export function saveConfig(home: string, cfg: Config): void {
  // 0600 : contient le jeton admin et l'instanceId.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

function validIso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > MIN_PLAUSIBLE_MS && ms <= Date.now() + 86_400_000 ? new Date(ms).toISOString() : undefined
}

/** Date ISO lisible, sans borne (dates de la licence : l'horloge du PC peut
 *  avoir changé entre deux lancements, license.ts juge lui-même). */
function anyIso(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

// avant 2024 : aucune installation de Flitdrop n'existait, une date plus
// ancienne est un horodatage absent (0) ou faux.
const MIN_PLAUSIBLE_MS = Date.parse('2024-01-01T00:00:00Z')

/** Plus ancienne date de création fiable des fichiers de Flitdrop : sert de
 *  date d'installation pour une installation antérieure à ce suivi. La date de
 *  création (birthtime) survit aux réécritures de config.json ; mtime non. */
function oldestKnownDate(home: string): string {
  const now = Date.now()
  let best = now
  for (const f of ['', 'config.json', 'devices.json', 'history.json']) {
    try {
      const st = fs.statSync(path.join(home, f))
      const b = st.birthtimeMs
      if (b > MIN_PLAUSIBLE_MS && b < best) best = b
    } catch {
      // fichier absent : on passe
    }
  }
  return new Date(best).toISOString()
}

/** Pour une installation antérieure : a-t-elle déjà appairé un téléphone ou
 *  réussi un transfert ? Évite de compter comme « premier » un événement qui
 *  ne l'est pas. On ne lit que des statuts, jamais de contenu. */
function legacyUsage(home: string): { paired: boolean; transferred: boolean } {
  const read = (f: string): unknown[] => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'))
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  const history = read('history.json') as { status?: string }[]
  const devices = read('devices.json') as { status?: string }[]
  const transferred = history.some((e) => e && e.status === 'ok')
  return { paired: transferred || devices.some((d) => d && d.status === 'active'), transferred }
}

function validPort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536 ? v : undefined
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
