import { describe, expect, it } from 'vitest'
import { linuxClipCandidates, readClipboard, writeClipboard } from '../src/clip.js'

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
