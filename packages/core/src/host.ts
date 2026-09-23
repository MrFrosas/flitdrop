import fs from 'node:fs'
import path from 'node:path'
import type { TransferActivityState } from './activity.js'

// Petites briques de l'app de bureau (main.cjs) qui touchent au système :
// garder le PC éveillé pendant un transfert, nouvelle version sur Mac,
// lancement au démarrage sous Linux. Écrites ici, sans Electron, pour être
// testées ; main.cjs leur passe les vraies fonctions d'Electron.

// ---------- état du système montré dans la fenêtre ----------

/** Ce que l'app de bureau signale à la page du PC (GET /state, champ host). */
export interface HostState {
  /** Mac : une version plus récente est publiée (carte « Nouvelle version »). */
  macUpdate: { version: string } | null
  /** Mac : « Lancer au démarrage » attend l'accord de la personne dans les
   *  réglages de macOS. */
  loginItemNeedsApproval: boolean
}

/** Actions que la page peut demander à l'app de bureau (jamais d'adresse
 *  fournie par la page : l'app sait elle-même quoi ouvrir). */
export const HOST_ACTIONS = ['openMacUpdate', 'openLoginItems'] as const
export type HostAction = (typeof HOST_ACTIONS)[number]

// ---------- PC éveillé et progression sur l'icône ----------

/** Ce dont on se sert de powerSaveBlocker d'Electron. */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted?(id: number): boolean
}

export interface KeepAwakeOptions {
  blocker: PowerBlocker
  /** Progression sur l'icône (win.setProgressBar) : 0 à 1, 2 = en cours sans
   *  pourcentage connu, -1 = effacée. */
  setProgress: (value: number) => void
  /** Filet de sécurité : sans aucune nouvelle du coeur pendant ce délai, on
   *  rend la main au système même si « actif » n'est jamais retombé. */
  maxMs?: number
}

// 30 minutes sans nouvelle : le PC peut de nouveau se mettre en veille
export const KEEP_AWAKE_MAX_MS = 30 * 60 * 1000

/**
 * Empêche la mise en veille du PC tant qu'un transfert passe (événement
 * 'transfer' de core.activity) et affiche sa progression dans la barre des
 * tâches Windows ou le Dock. Aucune erreur du système ne remonte : au pire,
 * le PC se met en veille comme avant.
 */
export class TransferKeepAwake {
  private id: number | null = null
  private cap: ReturnType<typeof setTimeout> | null = null
  private shown = false
  private readonly maxMs: number

  constructor(private readonly o: KeepAwakeOptions) {
    this.maxMs = o.maxMs ?? KEEP_AWAKE_MAX_MS
  }

  /** Écouteur de l'événement 'transfer'. */
  update(state: TransferActivityState | null | undefined): void {
    if (!state || !state.active) {
      this.stop()
      return
    }
    this.hold()
    const p = state.progress
    this.progress(typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 2)
  }

  /** Tout rendre : fin de transfert, erreur, fermeture de l'app. */
  stop(): void {
    this.release()
    if (this.shown) this.progress(-1)
  }

  get holding(): boolean {
    return this.id !== null
  }

  private hold(): void {
    if (this.id === null) {
      try {
        this.id = this.o.blocker.start('prevent-app-suspension')
      } catch {
        this.id = null
      }
    }
    // chaque nouvelle du coeur repousse le filet de sécurité
    if (this.cap) clearTimeout(this.cap)
    this.cap = setTimeout(() => {
      this.cap = null
      this.release()
    }, this.maxMs)
    this.cap.unref?.()
  }

  private release(): void {
    if (this.cap) clearTimeout(this.cap)
    this.cap = null
    if (this.id === null) return
    const id = this.id
    this.id = null
    try {
      if (!this.o.blocker.isStarted || this.o.blocker.isStarted(id)) this.o.blocker.stop(id)
    } catch {
      // déjà rendu par le système
    }
  }

  private progress(value: number): void {
    try {
      this.o.setProgress(value)
      this.shown = value >= 0
    } catch {
      // fenêtre fermée ou système sans barre de progression
    }
  }
}

// ---------- nouvelle version sur Mac ----------

// L'app Mac n'est pas notarisée : electron-updater ne peut pas l'installer.
// On lit la dernière version publiée sur GitHub et on propose le bon .dmg.
export const MAC_RELEASE_API = 'https://api.github.com/repos/MrFrosas/flitdrop/releases/latest'
export const MAC_RELEASE_PAGE = 'https://github.com/MrFrosas/flitdrop/releases/latest'

/** Découpe « v1.2.3-beta.1 » en nombres ; null si ce n'est pas une version. */
function parseVersion(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/** Compare deux versions (semver) : négatif si a < b, 0 si égales, positif si
 *  a > b. Une préversion passe avant la version finale (1.0.0-beta < 1.0.0).
 *  Une version illisible compte comme la plus petite. */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!
    if (d !== 0) return d
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const xa = pa.pre.split('.')
  const xb = pb.pre.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const sa = xa[i]
    const sb = xb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    const na = /^\d+$/.test(sa)
    const nb = /^\d+$/.test(sb)
    if (na && nb) {
      const d = Number(sa) - Number(sb)
      if (d !== 0) return d
    } else if (na !== nb) {
      return na ? -1 : 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}

export interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

/** Le bon .dmg pour ce Mac : « -arm64.dmg » pour Apple Silicon, « -x64.dmg »
 *  pour Intel. null si la version n'en a pas (on ouvrira la page). */
export function pickMacDmg(assets: unknown, arch: string): string | null {
  if (!Array.isArray(assets)) return null
  const want = arch === 'arm64' ? 'arm64' : 'x64'
  for (const a of assets as ReleaseAsset[]) {
    const name = typeof a?.name === 'string' ? a.name : ''
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : ''
    if (!name.toLowerCase().endsWith(`-${want}.dmg`)) continue
    // seulement un lien GitHub en https : jamais n'importe quelle adresse
    if (/^https:\/\/github\.com\/MrFrosas\/flitdrop\/releases\/download\//.test(url)) return url
  }
  return null
}

export interface MacUpdate {
  version: string
  /** .dmg à ouvrir (ou la page de la version, sans .dmg pour ce Mac). */
  url: string
}

/** Lit la réponse de GitHub : une version plus récente que `current`, ou null
 *  (à jour, brouillon, préversion ou réponse illisible). */
export function macUpdateFrom(release: unknown, current: string, arch: string): MacUpdate | null {
  if (!release || typeof release !== 'object') return null
  const r = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown; html_url?: unknown }
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') return null
  const version = r.tag_name.trim().replace(/^v/, '')
  const parsed = parseVersion(version)
  if (!parsed || parsed.pre) return null
  if (compareSemver(version, current) <= 0) return null
  const page =
    typeof r.html_url === 'string' && /^https:\/\/github\.com\/MrFrosas\/flitdrop\/releases\//.test(r.html_url)
      ? r.html_url
      : MAC_RELEASE_PAGE
  return { version, url: pickMacDmg(r.assets, arch) ?? page }
}

/** Architecture à télécharger : un Mac Apple Silicon qui fait tourner la
 *  version Intel (Rosetta) doit recevoir la version Apple Silicon. */
export function macDownloadArch(processArch: string, underRosetta: boolean): 'arm64' | 'x64' {
  return processArch === 'arm64' || underRosetta ? 'arm64' : 'x64'
}

/** Une vérification auprès de GitHub. Ne lève jamais. `{ latest }` : la
 *  réponse a été lue (latest vaut null si l'app est à jour) ; null : GitHub
 *  injoignable ou réponse refusée, on réessaiera plus tard. */
export async function checkMacUpdate(opts: {
  current: string
  arch: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<{ latest: MacUpdate | null } | null> {
  const f = opts.fetch ?? fetch
  try {
    const res = await f(MAC_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Flitdrop' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    if (!res.ok) return null
    return { latest: macUpdateFrom(await res.json(), opts.current, opts.arch) }
  } catch {
    return null
  }
}

export const MAC_UPDATE_FIRST_MS = 10_000
export const MAC_UPDATE_EVERY_MS = 24 * 60 * 60 * 1000

/** Rythme des vérifications sur Mac : une fois 10 s après le lancement, puis
 *  une fois par jour, seulement si les mises à jour automatiques sont
 *  permises dans les réglages. Une vérification demandée à la main (menu de
 *  l'icône) passe toujours. */
export class MacUpdateWatch {
  private first: ReturnType<typeof setTimeout> | null = null
  private daily: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<{ latest: MacUpdate | null } | null> | null = null

  constructor(
    private readonly o: {
      check: () => Promise<{ latest: MacUpdate | null } | null>
      enabled: () => boolean
      /** Réponse lue : la version plus récente, ou null (à jour). */
      onResult: (latest: MacUpdate | null) => void
      firstMs?: number
      everyMs?: number
    }
  ) {}

  start(): void {
    if (this.first || this.daily) return
    const auto = () => {
      let ok = false
      try {
        ok = this.o.enabled()
      } catch {
        ok = false
      }
      if (ok) void this.checkNow()
    }
    this.first = setTimeout(() => {
      this.first = null
      auto()
    }, this.o.firstMs ?? MAC_UPDATE_FIRST_MS)
    this.first.unref?.()
    this.daily = setInterval(auto, this.o.everyMs ?? MAC_UPDATE_EVERY_MS)
    this.daily.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.daily) clearInterval(this.daily)
    this.first = null
    this.daily = null
  }

  /** Une vérification (une seule à la fois). */
  checkNow(): Promise<{ latest: MacUpdate | null } | null> {
    if (this.inflight) return this.inflight
    const run = (async () => {
      let res: { latest: MacUpdate | null } | null = null
      try {
        res = await this.o.check()
      } catch {
        res = null
      }
      if (res) {
        try {
          this.o.onResult(res.latest)
        } catch {
          // non critique
        }
      }
      return res
    })()
    this.inflight = run
    void run.finally(() => {
      this.inflight = null
    })
    return run
  }
}

// ---------- lancement au démarrage sous Linux ----------

// app.setLoginItemSettings ne fait rien sous Linux : on pose nous-mêmes le
// fichier de démarrage automatique (norme freedesktop, reconnue par GNOME,
// KDE, Xfce, Cinnamon…).

/** ~/.config/autostart/flitdrop.desktop (ou $XDG_CONFIG_HOME/autostart). */
export function linuxAutostartFile(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, '.config')
  return path.join(base, 'autostart', 'flitdrop.desktop')
}

/** Programme à lancer : l'AppImage quand l'app tourne depuis une AppImage
 *  (son chemin change à chaque mise à jour), sinon l'exécutable installé,
 *  en passant par le lanceur posé à côté (build/afterPack.cjs) s'il existe. */
export function linuxExecTarget(appImage: string | undefined, execPath: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (appImage && path.isAbsolute(appImage)) return appImage
  if (execPath.endsWith('-bin')) {
    const launcher = execPath.slice(0, -'-bin'.length)
    try {
      if (exists(launcher)) return launcher
    } catch {
      // lanceur illisible : l'exécutable lui-même
    }
  }
  return execPath
}

/** Guillemets de la norme Desktop Entry : \, ", ` et $ échappés, % doublé. */
export function desktopExecQuote(arg: string): string {
  return `"${arg.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`
}

/** Contenu du fichier de démarrage : Flitdrop démarre caché (--hidden). */
export function linuxAutostartEntry(execTarget: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Flitdrop',
    'Comment=Flitdrop',
    `Exec=${desktopExecQuote(execTarget)} --hidden`,
    'Icon=flitdrop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function isLinuxAutostart(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Pose ou retire le fichier. Rend l'état réel après coup. */
export function setLinuxAutostart(file: string, enabled: boolean, execTarget: string): boolean {
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, linuxAutostartEntry(execTarget), { mode: 0o644 })
    } else {
      fs.rmSync(file, { force: true })
    }
  } catch {
    // dossier en lecture seule : l'état réel est relu ci-dessous
  }
  return isLinuxAutostart(file)
}

/** Au lancement : si le démarrage automatique est posé, on corrige la seule
 *  ligne Exec quand le programme a changé de place (AppImage mise à jour sous
 *  un autre nom). Le reste du fichier, peut-être retouché à la main, est gardé.
 *  `true` : le fichier a été corrigé. */
export function refreshLinuxAutostart(file: string, execTarget: string): boolean {
  try {
    if (!isLinuxAutostart(file)) return false
    const text = fs.readFileSync(file, 'utf8')
    const want = `Exec=${desktopExecQuote(execTarget)} --hidden`
    const lines = text.split('\n')
    const i = lines.findIndex((l) => l.startsWith('Exec='))
    if (i === -1 || lines[i] === want) return false
    lines[i] = want
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o644 })
    return true
  } catch {
    return false
  }
}
