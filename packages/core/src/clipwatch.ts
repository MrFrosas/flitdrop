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
  /** Vérification du texte (le coeur : pollClipboard). */
  checkText: () => Promise<void> | void
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
  private paused = false
  // empreinte de la dernière image vue : tant qu'elle ne change pas, on ne
  // décode ni ne réencode rien
  private lastImage = ''

  constructor(opts: ClipboardWatcherOptions) {
    this.o = {
      platform: process.platform,
      idleSeconds: () => 0,
      activeMs: 1500,
      idleMs: 5000,
      // en pause (écran verrouillé), un coup d'oeil par minute quand même : si
      // le système oublie de signaler le déverrouillage, la synchro reprend seule
      pausedMs: 60_000,
      idleAfterSec: 60,
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

  /** Écran verrouillé ou mise en veille : on ne vérifie presque plus. */
  pause(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    if (!this.running) this.schedule(this.o.pausedMs)
  }

  /** Déverrouillage ou réveil : une vérification tout de suite, puis le rythme normal. */
  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    if (!this.running) this.schedule(0)
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Une vérification complète (texte puis image). Exposé pour les tests. */
  async tick(): Promise<void> {
    if (!this.o.anyEnabled()) return
    try {
      await this.o.checkText()
    } catch {
      // non critique : on réessaiera au prochain passage
    }
    if (this.o.imagesEnabled()) this.checkImage()
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
    } finally {
      this.running = false
    }
    this.schedule(this.nextDelay())
  }

  private nextDelay(): number {
    if (this.paused) return this.o.pausedMs
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
    let formats: string[] = []
    try {
      formats = cb.availableFormats()
    } catch {
      return null
    }
    if (!formats.some((f) => typeof f === 'string' && f.startsWith('image/'))) return null
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

  private checkImage(): void {
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
