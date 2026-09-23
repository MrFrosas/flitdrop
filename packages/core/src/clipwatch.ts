import { createHash } from 'node:crypto'

// Surveillance UNIQUE du presse-papiers de l'app de bureau : une seule
// minuterie pour le texte (confié au coeur) et les images (lues par Electron).
// Écrite ici, sans dépendre d'Electron, pour être testée avec un faux
// presse-papiers ; main.cjs lui passe le vrai `clipboard` et `powerMonitor`.

/** Ce dont on se sert d'une NativeImage d'Electron. */
export interface WatchedImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
  toBitmap(): Buffer
  resize(opts: { width: number }): WatchedImage
  toDataURL(): string
}

/** Ce dont on se sert du module `clipboard` d'Electron. */
export interface WatchedClipboard {
  availableFormats(): string[]
  readBuffer(format: string): Buffer
  readImage(): WatchedImage
}

export interface ClipboardWatcherOptions {
  clipboard: WatchedClipboard
  platform?: NodeJS.Platform
  /** Vérification du texte (le coeur : pollClipboard). `true` : nouveau texte vu. */
  checkText: () => Promise<boolean | void> | boolean | void
  /** Lecture du texte par un programme externe (wl-paste sous Wayland) : on ne
   *  la lance pas quand le presse-papiers annonce des formats, mais aucun texte. */
  textNeedsTextFormat?: boolean
  /** Historique actif : on regarde aussi les images. */
  imagesEnabled: () => boolean
  /** Au moins une fonction presse-papiers active (historique ou envoi auto). */
  anyEnabled: () => boolean
  /** Nouvelle image copiée : PNG complet + miniature (data URL). */
  onImage: (png: Buffer, thumb: string, width: number, height: number) => void
  /** Secondes sans clavier ni souris (powerMonitor.getSystemIdleTime). */
  idleSeconds?: () => number
  /** Rythme normal, rythme après une minute sans activité, rythme en pause. */
  activeMs?: number
  idleMs?: number
  pausedMs?: number
  idleAfterSec?: number
  /** Image restée copiée sans aucune action : relecture complète au plus tard
   *  après ce délai (copies sans clavier : Universal Clipboard, bureau à distance). */
  imageRecheckMs?: number
  /** Une vérification du texte bloquée est abandonnée après ce délai. */
  checkTimeoutMs?: number
  /** Horloge (tests). */
  now?: () => number
}

/**
 * Noms bruts des images dans le presse-papiers de chaque système. On lit ces
 * octets tels quels (aucun décodage, aucun réencodage) pour savoir si l'image
 * a changé. macOS : une capture peut n'exister qu'en TIFF, d'où les deux noms.
 */
export function rawImageFormats(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['public.png', 'public.tiff']
  if (platform === 'win32') return ['PNG']
  return ['image/png']
}

const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

export class ClipboardWatcher {
  private readonly o: Required<Omit<ClipboardWatcherOptions, 'platform'>> & { platform: NodeJS.Platform }
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = true
  // deux causes de pause distinctes : sortir de veille derrière l'écran
  // verrouillé ne doit pas relancer le rythme normal
  private locked = false
  private suspended = false
  // empreinte de la dernière image vue : tant qu'elle ne change pas, on ne
  // décode ni ne réencode rien
  private lastImage = ''
  // formats annoncés et heure de la dernière lecture complète de l'image
  private lastFormats = ''
  private lastImageRead = Number.NEGATIVE_INFINITY

  constructor(opts: ClipboardWatcherOptions) {
    this.o = {
      platform: process.platform,
      idleSeconds: () => 0,
      activeMs: 1500,
      idleMs: 5000,
      // en pause (écran verrouillé, veille, tout coupé), un coup d'oeil par
      // minute quand même : si le système oublie de signaler le déverrouillage,
      // la synchro reprend seule
      pausedMs: 60_000,
      idleAfterSec: 60,
      imageRecheckMs: 30_000,
      checkTimeoutMs: 15_000,
      textNeedsTextFormat: false,
      now: () => Date.now(),
      ...opts,
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(this.o.activeMs)
  }

  /** Arrêt définitif (fermeture de l'app). */
  stop(): void {
    this.stopped = true
    this.clear()
  }

  /** Écran verrouillé : on ne vérifie presque plus. */
  lock(): void {
    if (this.stopped || this.locked) return
    const was = this.paused
    this.locked = true
    if (!was && !this.running) this.schedule(this.o.pausedMs)
  }

  /** Déverrouillage : une vérification tout de suite, sauf si l'ordinateur dort encore. */
  unlock(): void {
    if (this.stopped || !this.locked) return
    this.locked = false
    if (!this.paused && !this.running) this.schedule(0)
  }

  /** Mise en veille : on ne vérifie presque plus. */
  suspend(): void {
    if (this.stopped || this.suspended) return
    const was = this.paused
    this.suspended = true
    if (!was && !this.running) this.schedule(this.o.pausedMs)
  }

  /** Réveil : une vérification tout de suite, sauf derrière l'écran verrouillé
   *  (réveil de maintenance, couvercle ouvert sans déverrouiller). */
  wake(): void {
    if (this.stopped || !this.suspended) return
    this.suspended = false
    if (!this.paused && !this.running) this.schedule(0)
  }

  /** Un réglage vient de changer : on vérifie tout de suite (l'app ralentit
   *  quand les deux fonctions presse-papiers sont coupées). */
  poke(): void {
    if (this.stopped || this.paused || this.running) return
    this.schedule(0)
  }

  get isPaused(): boolean {
    return this.paused
  }

  private get paused(): boolean {
    return this.locked || this.suspended
  }

  /** Une vérification complète (texte puis image). Exposé pour les tests. */
  async tick(): Promise<void> {
    if (!this.o.anyEnabled()) return
    let textChanged = false
    try {
      if (this.shouldReadText()) textChanged = (await this.withTimeout(this.o.checkText())) === true
    } catch {
      // non critique : on réessaiera au prochain passage
    }
    try {
      if (this.o.imagesEnabled()) this.checkImage(textChanged)
    } catch {
      // image illisible ou trop grosse : on réessaiera à la prochaine copie
    }
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.clear()
    if (this.stopped) return
    this.timer = setTimeout(() => void this.run(), ms)
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    this.timer = null
    this.running = true
    try {
      await this.tick()
    } catch {
      // une erreur imprévue ne doit jamais arrêter la seule minuterie
    } finally {
      this.running = false
      this.schedule(this.nextDelay())
    }
  }

  /** Une vérification du texte qui ne répond pas ne bloque pas la suivante. */
  private withTimeout<T>(p: Promise<T> | T): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const t = setTimeout(() => resolve(undefined), this.o.checkTimeoutMs)
      t.unref?.()
      Promise.resolve(p).then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        }
      )
    })
  }

  private formats(): string[] | null {
    try {
      const f = this.o.clipboard.availableFormats()
      return Array.isArray(f) ? f.filter((x) => typeof x === 'string') : null
    } catch {
      return null
    }
  }

  /** Sans lecture externe coûteuse, on lit toujours. Sinon on saute la lecture
   *  quand le presse-papiers annonce des formats sans aucun texte (image seule). */
  private shouldReadText(): boolean {
    if (!this.o.textNeedsTextFormat) return true
    const f = this.formats()
    if (!f || f.length === 0) return true // inconnu : on lit
    return f.some((x) => /^text\/plain/i.test(x) || x === 'UTF8_STRING' || x === 'STRING' || x === 'TEXT')
  }

  private nextDelay(): number {
    if (this.paused) return this.o.pausedMs
    try {
      // tout est coupé : un coup d'oeil par minute, poke() réveille au réglage
      if (!this.o.anyEnabled()) return this.o.pausedMs
    } catch {
      // inconnu : rythme normal
    }
    let idle = 0
    try {
      idle = this.o.idleSeconds()
    } catch {
      // inconnu (certaines sessions Wayland) : rythme normal
    }
    // personne au clavier depuis une minute : on ralentit. Copier demande une
    // action, qui remet ce compteur à zéro : le rythme normal revient aussitôt.
    return idle >= this.o.idleAfterSec ? this.o.idleMs : this.o.activeMs
  }

  /**
   * Empreinte bon marché de l'image copiée, sans réencodage. `null` : pas
   * d'image. Sans octets bruts lisibles (certaines apps Windows ne posent qu'un
   * bitmap), on lit l'image et on hache ses pixels bruts : toujours aucun
   * réencodage PNG, et on ne perd jamais une image.
   */
  private fingerprint(): { fp: string; img?: WatchedImage } | null {
    const cb = this.o.clipboard
    for (const name of rawImageFormats(this.o.platform)) {
      try {
        const raw = cb.readBuffer(name)
        if (raw && raw.length > 0) return { fp: `raw:${name}:${raw.length}:${sha1(raw)}` }
      } catch {
        // format absent : suivant
      }
    }
    let img: WatchedImage
    try {
      img = cb.readImage()
    } catch {
      return null
    }
    if (!img || img.isEmpty()) return null
    const size = img.getSize()
    return { fp: `bmp:${size.width}x${size.height}:${sha1(img.toBitmap())}`, img }
  }

  /**
   * Faut-il relire l'image en entier ? Une capture TIFF ou un bitmap Windows
   * pèse 30 à 60 Mo : la lire et la hacher à chaque passage coûterait cher.
   * On ne le fait que sur un signal bon marché : formats annoncés différents,
   * clavier ou souris utilisés depuis la dernière lecture (copier demande une
   * touche ou un clic, Impr écran compris), nouveau texte vu, ou 30 s écoulées
   * (copies faites sans action locale). Sans mesure d'inactivité : à chaque fois.
   */
  private needsFullRead(key: string, textChanged: boolean): boolean {
    if (key !== this.lastFormats || textChanged) return true
    const since = (this.o.now() - this.lastImageRead) / 1000
    if (since * 1000 >= this.o.imageRecheckMs || since < 0) return true
    let idle: number
    try {
      idle = this.o.idleSeconds()
    } catch {
      return true
    }
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) return true
    return idle <= since + 1
  }

  private checkImage(textChanged: boolean): void {
    const formats = this.formats()
    if (!formats) return
    const key = formats.join('|')
    if (!formats.some((f) => f.startsWith('image/'))) {
      this.lastFormats = key
      return
    }
    if (!this.needsFullRead(key, textChanged)) return
    this.lastFormats = key
    this.lastImageRead = this.o.now()
    const seen = this.fingerprint()
    if (!seen || seen.fp === this.lastImage) return
    let img = seen.img
    if (!img) {
      try {
        img = this.o.clipboard.readImage()
      } catch {
        return
      }
    }
    if (!img || img.isEmpty()) return
    this.lastImage = seen.fp
    // l'image a vraiment changé : c'est le seul moment où l'on encode
    const size = img.getSize()
    const png = img.toPNG()
    // miniature 256px de large max pour l'aperçu
    const thumbImg = size.width > 256 ? img.resize({ width: 256 }) : img
    try {
      this.o.onImage(png, thumbImg.toDataURL(), size.width, size.height)
    } catch {
      // non critique
    }
  }
}
