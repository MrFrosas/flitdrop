import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClipboardText, linuxClipCandidates, readClipboard, resetLinuxClipTools, runClipTool, runLinux, writeClipboard } from '../src/clip.js'

describe('linuxClipCandidates', () => {
  it('prend xclip puis xsel sous X11, wl-clipboard en dernier recours', () => {
    expect(linuxClipCandidates('write', {}).map(([c]) => c)).toEqual(['xclip', 'xsel', 'wl-copy'])
    expect(linuxClipCandidates('read', {}).map(([c]) => c)).toEqual(['xclip', 'xsel', 'wl-paste'])
  })

  it('met wl-clipboard en premier sous Wayland', () => {
    const env = { WAYLAND_DISPLAY: 'wayland-0' }
    expect(linuxClipCandidates('write', env).map(([c]) => c)).toEqual(['wl-copy', 'xclip', 'xsel'])
    expect(linuxClipCandidates('read', env).map(([c]) => c)).toEqual(['wl-paste', 'xclip', 'xsel'])
  })

  it('lit sans saut de ligne ajouté par wl-paste', () => {
    const first = linuxClipCandidates('read', { WAYLAND_DISPLAY: 'w' })[0]
    expect(first?.[1]).toContain('--no-newline')
  })

  it('wl-paste ne demande que du texte (une image copiée ne passe jamais dans le tuyau)', () => {
    const first = linuxClipCandidates('read', { WAYLAND_DISPLAY: 'w' })[0]
    const args = first?.[1] ?? []
    expect(args[args.indexOf('--type') + 1]).toBe('text')
  })
})

describe('lecture qui ne répond pas', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.skipIf(process.platform === 'win32')('le programme est tué et la lecture échoue au lieu de bloquer', { timeout: 5000 }, async () => {
    const started = Date.now()
    await expect(runClipTool(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], undefined, 300)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('une écriture n’a pas de délai (xclip garde la sélection en fond)', async () => {
    await expect(runClipTool(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], 'x', 1)).resolves.toBe('')
  })

  it('lecture fournie par l’hôte qui ne répond jamais : rend vide après le délai', async () => {
    vi.useFakeTimers()
    const clip = createClipboardText({ read: () => new Promise<string>(() => {}), write: () => {} }, 1000)
    const p = clip.read()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toBe('')
  })
})

// Faux wl-paste et xclip dans le PATH : on vérifie qui est lancé sous Wayland.
describe.skipIf(process.platform === 'win32')('lecture sous Wayland', () => {
  const saved = { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
  let dir = ''
  let log = ''

  const tool = (name: string, body: string) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> "${log}"\n${body}\n`)
    fs.chmodSync(p, 0o755)
  }

  afterEach(() => {
    process.env.PATH = saved.PATH
    if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const setup = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-wl-'))
    log = path.join(dir, 'log')
    process.env.PATH = dir + path.delimiter + '/bin' + path.delimiter + '/usr/bin'
    process.env.WAYLAND_DISPLAY = 'wayland-test'
    resetLinuxClipTools()
  }

  it('aucun texte copié (image seule) : vide tout de suite, sans lancer xclip ni xsel', async () => {
    setup()
    tool('xclip', 'printf de-xclip')
    tool('xsel', 'printf de-xsel')
    // messages des différentes versions de wl-paste
    for (const msg of ['No selection', 'Nothing is copied', 'No suitable type of content copied']) {
      tool('wl-paste', `echo "${msg}" >&2\nexit 1`)
      expect(await runLinux('read')).toBe('')
    }
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['wl-paste', 'wl-paste', 'wl-paste'])
  })

  it('wl-paste en panne (compositeur sans accès) : xclip prend le relais, wl-paste mis de côté', async () => {
    setup()
    tool('wl-paste', 'echo "Failed to connect to a Wayland server" >&2\nexit 1')
    tool('xclip', 'printf de-xclip')
    tool('xsel', 'printf de-xsel')
    expect(await runLinux('read')).toBe('de-xclip')
    expect(await runLinux('read')).toBe('de-xclip')
    // wl-paste n'est pas relancé à chaque vérification
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['wl-paste', 'xclip', 'xclip'])
  })

  it('plus rien ne marche : wl-paste est retenté au passage suivant', async () => {
    setup()
    tool('wl-paste', 'echo "Failed to connect to a Wayland server" >&2\nexit 1')
    tool('xclip', 'exit 1')
    tool('xsel', 'exit 1')
    await expect(runLinux('read')).rejects.toThrow()
    tool('wl-paste', 'printf revenu')
    expect(await runLinux('read')).toBe('revenu')
  })

  it('texte copié : lu par wl-paste', async () => {
    setup()
    tool('wl-paste', 'printf bonjour')
    expect(await runLinux('read')).toBe('bonjour')
  })
})

// Aller-retour réel avec le presse-papiers du système. Désactivé par défaut pour
// ne jamais écraser le presse-papiers du poste de dev ; la CI Linux l'active
// (FLITDROP_CLIP_TEST=1, sous xvfb avec xclip). Le délai court attrape le
// blocage historique où l'écriture xclip ne rendait jamais la main.
describe.runIf(process.env.FLITDROP_CLIP_TEST === '1')('presse-papiers système', () => {
  it('écrit puis relit le même texte sans bloquer', { timeout: 8000 }, async () => {
    const text = `flitdrop-clip-${Date.now()} é à ü 🙂`
    await writeClipboard(text)
    expect(await readClipboard()).toBe(text)
  })
})
