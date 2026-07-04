import { describe, it, expect } from 'vitest'
import { messages, t, tp, fmtBytes } from '../src/i18n.js'

describe('i18n', () => {
  it('en et fr ont EXACTEMENT les mêmes clés (aucune traduction manquante)', () => {
    const missingInFr = Object.keys(messages.en).filter((k) => !(k in messages.fr))
    const missingInEn = Object.keys(messages.fr).filter((k) => !(k in messages.en))
    expect(missingInFr).toEqual([])
    expect(missingInEn).toEqual([])
  })

  it('aucune valeur vide', () => {
    for (const lang of ['en', 'fr'] as const) {
      for (const [k, v] of Object.entries(messages[lang])) {
        expect(v, `${lang}.${k}`).toBeTruthy()
      }
    }
  })

  it('interpolation + repli sur la clé', () => {
    expect(t('en', 'appr.body', { name: 'X', file: 'a.jpg', size: '1 MB' })).toContain('X')
    expect(t('fr', 'nav.radar')).toBe('Radar')
    expect(t('en', 'cle.inexistante')).toBe('cle.inexistante')
  })

  it('pluriels (0 est singulier en français)', () => {
    expect(tp('en', 'ph.text.count', 1)).toBe('1 character')
    expect(tp('en', 'ph.text.count', 5)).toBe('5 characters')
    expect(tp('en', 'ph.text.count', 0)).toBe('0 characters')
    expect(tp('fr', 'ph.text.count', 0)).toBe('0 caractère')
    expect(tp('fr', 'ph.text.count', 2)).toBe('2 caractères')
    expect(tp('fr', 'up.filesReady', 3)).toContain('3')
  })

  it('tailles localisées', () => {
    expect(fmtBytes('en', 2048)).toBe('2 KB')
    expect(fmtBytes('fr', 2048)).toBe('2 Ko')
    expect(fmtBytes('en', 512)).toBe('512 B')
  })
})
