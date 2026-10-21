import { describe, it, expect } from 'vitest'
import { sameSiteOk, looksLikeFlitdropSecret } from '../src/server.js'
import { cleanDeviceName } from '../src/pairing.js'
import { systemOpener } from '../src/util.js'

describe('page du PC : rien d’un autre site local', () => {
  it('accepte la page de Flitdrop, refuse un autre port, un autre nom ou un autre site', () => {
    expect(sameSiteOk({ host: '127.0.0.1:47777', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:47777' })).toBe(true)
    expect(sameSiteOk({ host: '127.0.0.1:47777' })).toBe(true)
    expect(sameSiteOk({ host: '127.0.0.1:47777', 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:3000' })).toBe(false)
    expect(sameSiteOk({ host: '127.0.0.1:47777', origin: 'http://127.0.0.1:3000' })).toBe(false)
    expect(sameSiteOk({ host: 'evil.example:47777' })).toBe(false)
    expect(sameSiteOk({ host: '127.0.0.1:47777', 'sec-fetch-site': 'cross-site' })).toBe(false)
  })
})

describe('secrets copiés depuis Flitdrop', () => {
  it('lien d’appairage et adresse du Raccourci jamais gardés ; un lien ordinaire, si', () => {
    expect(looksLikeFlitdropSecret('http://192.168.1.20:47777/s/#abcdEFGH12.' + 'k'.repeat(43) + '.inst')).toBe(true)
    expect(looksLikeFlitdropSecret('http://mac.local:47777/api/shortcut/upload?t=' + 'x'.repeat(24))).toBe(true)
    expect(looksLikeFlitdropSecret('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false)
    expect(looksLikeFlitdropSecret('Rendez-vous 14h lundi')).toBe(false)
  })
})

describe('nom d’appareil donné par le téléphone', () => {
  it('sans caractères invisibles ni de sens d’écriture, « PC » réservé, 40 caractères', () => {
    expect(cleanDeviceName('iPhone\u202Ede Léa')).toBe('iPhonede Léa')
    expect(cleanDeviceName('  Pixel   8  ')).toBe('Pixel 8')
    expect(cleanDeviceName('pc')).toBe('')
    expect(cleanDeviceName('x'.repeat(80)).length).toBe(40)
  })
})

describe('ouvreur du système', () => {
  it('chemin absolu sous Windows et macOS', () => {
    expect(systemOpener('win32')).toBe('C:\\Windows\\explorer.exe')
    expect(systemOpener('darwin')).toBe('/usr/bin/open')
  })
})
