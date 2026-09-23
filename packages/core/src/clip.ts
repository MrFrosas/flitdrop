import { spawn } from 'node:child_process'

function clipboardDisabled(): boolean {
  return process.env.FLITDROP_NO_CLIP === '1'
}

type ClipCmd = [cmd: string, args: string[]]

class ClipError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    // code de sortie : l'outil a bien démarré mais n'a rien rendu
    readonly exitCode?: number | null
  ) {
    super(message)
  }
}

/** Une lecture plus longue est abandonnée (programme tué) : l'app qui possède
 *  la sélection peut ne jamais répondre à xclip ou wl-paste. */
export const CLIP_READ_TIMEOUT_MS = 10_000

/**
 * Lance une commande presse-papiers.
 * - lecture : on capture stdout et on attend 'close' (tous les flux fermés).
 * - écriture : stdout/stderr IGNORÉS et on attend 'exit'. Sous Linux, xclip et
 *   wl-copy restent en arrière-plan pour « posséder » la sélection ; ce
 *   processus garde les flux hérités ouverts, donc attendre 'close' bloquerait
 *   indéfiniment alors que la copie est faite.
 */
export function runClipTool(
  cmd: string,
  args: string[],
  stdinText?: string,
  timeoutMs = CLIP_READ_TIMEOUT_MS
): Promise<string> {
  const writing = stdinText !== undefined
  return new Promise((resolve, reject) => {
    let p
    try {
      // windowsHide : pas de fenêtre console qui clignote sous Windows (PowerShell)
      p = spawn(cmd, args, { stdio: ['pipe', writing ? 'ignore' : 'pipe', 'ignore'], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    let out = ''
    if (!writing && p.stdout) {
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (d: string) => {
        if (out.length < 4 * 1024 * 1024) out += d
      })
    }
    let settled = false
    // lecture seulement : une écriture rend la main à 'exit', sans attendre
    const timer = writing
      ? undefined
      : setTimeout(() => {
          try {
            p.kill()
          } catch {
            // déjà terminé
          }
          done(new ClipError(`${cmd} ne répond pas`, 'ETIMEDOUT'))
        }, timeoutMs)
    timer?.unref?.()
    const done = (err: Error | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) reject(err)
      else resolve(out)
    }
    p.on('error', (e: NodeJS.ErrnoException) => done(new ClipError(e.message, e.code)))
    const finish = (code: number | null) =>
      done(code === 0 ? null : new ClipError(`${cmd} a retourné ${code}`, undefined, code))
    if (writing) p.on('exit', finish)
    else p.on('close', finish)
    // un stdin fermé côté enfant (EPIPE) ne doit pas faire planter le serveur
    p.stdin?.on('error', () => {})
    if (writing) p.stdin?.end(stdinText, 'utf8')
    else p.stdin?.end()
  })
}

/**
 * Outils presse-papiers Linux par ordre de préférence. Sous Wayland, wl-clipboard
 * en premier (xclip n'y voit que les fenêtres XWayland) ; sous X11, xclip puis
 * xsel. Exporté pour les tests.
 */
export function linuxClipCandidates(mode: 'read' | 'write', env: NodeJS.ProcessEnv = process.env): ClipCmd[] {
  // --type text : sans texte copié (image seule), wl-paste s'arrête aussitôt
  // au lieu de faire passer toute l'image dans le tuyau
  const wayland: ClipCmd[] =
    mode === 'write' ? [['wl-copy', []]] : [['wl-paste', ['--no-newline', '--type', 'text']]]
  const x11: ClipCmd[] =
    mode === 'write'
      ? [
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ]
      : [
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]
  return env.WAYLAND_DISPLAY ? [...wayland, ...x11] : [...x11, ...wayland]
}

// outils absents de la machine : on ne les relance pas (le lecteur tourne toutes les 1,5 s)
const missing = new Set<string>()

/** Exporté pour les tests. */
export async function runLinux(mode: 'read' | 'write', stdinText?: string): Promise<string> {
  let last: Error = new Error('aucun outil presse-papiers (installer wl-clipboard, xclip ou xsel)')
  for (const [cmd, args] of linuxClipCandidates(mode)) {
    if (missing.has(cmd)) continue
    try {
      return await runClipTool(cmd, args, stdinText)
    } catch (e) {
      if (e instanceof ClipError && e.code === 'ENOENT') missing.add(cmd)
      // wl-paste a démarré mais ne trouve aucun texte (vide, image seule) : on
      // s'arrête là, inutile de lancer xclip puis xsel à chaque vérification
      if (mode === 'read' && cmd === 'wl-paste' && e instanceof ClipError && typeof e.exitCode === 'number') return ''
      last = e as Error
    }
  }
  throw last
}

export async function writeClipboard(text: string): Promise<void> {
  if (clipboardDisabled()) return
  if (process.platform === 'darwin') {
    await runClipTool('pbcopy', [], text)
  } else if (process.platform === 'win32') {
    await runClipTool(
      'powershell',
      ['-NoProfile', '-Command', '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      text
    )
  } else {
    await runLinux('write', text)
  }
}

export async function readClipboard(): Promise<string> {
  if (clipboardDisabled()) return ''
  if (process.platform === 'darwin') {
    return runClipTool('pbpaste', [])
  } else if (process.platform === 'win32') {
    return runClipTool('powershell', [
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw',
    ])
  }
  return runLinux('read')
}

/**
 * Lecture et écriture du texte fournies par l'hôte. L'app de bureau passe celles
 * d'Electron (clipboard.readText / writeText) : appel natif dans le processus,
 * sans lancer pbpaste ou PowerShell à chaque vérification.
 */
export interface ClipboardTextBackend {
  read: () => string | Promise<string>
  write: (text: string) => void
}

export interface ClipboardText {
  read: () => Promise<string>
  write: (text: string) => Promise<void>
}

/**
 * Presse-papiers texte utilisé par le serveur. Avec un `backend` (app de bureau),
 * aucun processus n'est lancé ; sans lui (coeur seul en ligne de commande,
 * tests), on garde pbpaste, PowerShell ou xclip. FLITDROP_NO_CLIP coupe tout.
 */
export function createClipboardText(backend?: ClipboardTextBackend, timeoutMs = CLIP_READ_TIMEOUT_MS): ClipboardText {
  if (!backend) return { read: readClipboard, write: writeClipboard }
  return {
    read: async () => {
      if (clipboardDisabled()) return ''
      // une lecture qui ne répond jamais rend '' : la vérification suivante repart
      const text = await new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(''), timeoutMs)
        t.unref?.()
        Promise.resolve()
          .then(() => backend.read())
          .then(
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
      return typeof text === 'string' ? text : ''
    },
    write: async (text: string) => {
      if (clipboardDisabled()) return
      backend.write(text)
    },
  }
}
