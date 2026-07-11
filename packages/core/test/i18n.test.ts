import { describe, it, expect } from 'vitest'
import { messages, LANGS, t, tp, fmtBytes } from '../src/i18n.js'

describe('i18n', () => {
  it('toutes les langues ont EXACTEMENT les mêmes clés (aucune traduction manquante)', () => {
    const enKeys = Object.keys(messages.en).sort()
    for (const lang of LANGS) {
      expect(Object.keys(messages[lang]).sort(), `clés ${lang}`).toEqual(enKeys)
    }
  })

  it('aucune valeur vide, dans toutes les langues', () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(messages[lang])) {
        expect(v, `${lang}.${k}`).toBeTruthy()
      }
    }
  })

  it('les placeholders {…} sont préservés dans chaque langue', () => {
    const ph = (s: string | undefined) => ((s || '').match(/\{\w+\}/g) || []).sort().join('|')
    for (const lang of LANGS) {
      for (const k of Object.keys(messages.en)) {
        expect(ph(messages[lang][k]), `${lang}.${k}`).toBe(ph(messages.en[k]))
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

  it('allemand disponible et cohérent', () => {
    expect(LANGS).toContain('de')
    expect(t('de', 'nav.settings')).toBe('Einstellungen')
    expect(t('de', 'set.langDe')).toBe('Deutsch')
    expect(fmtBytes('de', 2048)).toBe('2 KB')
    expect(tp('de', 'ph.text.count', 2)).toContain('2')
  })
})
