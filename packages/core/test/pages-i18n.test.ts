import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { messages, LANGS } from '../src/i18n.js'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('textes des pages', () => {
  for (const page of ['public/phone/index.html', 'public/desktop/index.html']) {
    it(`${page} : chaque data-i18n existe dans toutes les langues`, () => {
      const keys = [...read(page).matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]!)
      expect(keys.length).toBeGreaterThan(10)
      for (const lang of LANGS) for (const k of keys) expect(messages[lang][k], `${lang}.${k}`).toBeTruthy()
    })
  }

  it('pas de wifi en commun : la solution est proposée sur le téléphone (PC introuvable) et sur le PC (QR code)', () => {
    expect(read('public/phone/index.html')).toMatch(/id="errNoWifi"[^>]*data-i18n="ph\.err\.noWifi"/)
    expect(read('public/desktop/index.html')).toMatch(/id="pairNoWifi"[^>]*data-i18n="pair\.noWifi"/)
    // montrée seulement quand le PC ne répond pas, jamais sur un code expiré ou un autre PC
    expect(read('src/webclient/phone.ts')).toContain("$('errNoWifi').classList.toggle('hidden', kind !== 'notFound')")
    for (const lang of LANGS) {
      for (const k of ['ph.err.noWifi', 'pair.noWifi']) {
        const v = messages[lang][k]!
        expect(v, `${lang}.${k}`).toBeTruthy()
        expect(v, `${lang}.${k} sans tiret long`).not.toMatch(/[–—]/)
      }
    }
  })
})
