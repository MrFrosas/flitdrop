import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeFilename, uniquePath, reserveUniquePath, humanSize, parseCookies } from '../src/util.js'

describe('sanitizeFilename', () => {
  it('supprime les chemins (traversée)', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('..\\..\\windows\\system32\\evil.exe')).toBe('evil.exe')
    expect(sanitizeFilename('/absolu/photo.jpg')).toBe('photo.jpg')
  })
  it('supprime les caractères interdits Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.png')).toBe('abcdefgh.png')
  })
  it('gère les noms réservés Windows', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFilename('aux')).toBe('_aux')
  })
  it('supprime points et espaces terminaux', () => {
    expect(sanitizeFilename('rapport. . .')).toBe('rapport')
  })
  it('borne la longueur en gardant l’extension', () => {
    const long = 'a'.repeat(300) + '.jpeg'
    const out = sanitizeFilename(long)
    expect(out.length).toBeLessThanOrEqual(150)
    expect(out.endsWith('.jpeg')).toBe(true)
  })
  it('fallback si vide', () => {
    expect(sanitizeFilename('')).toBe('fichier')
    expect(sanitizeFilename('....')).toBe('fichier')
    expect(sanitizeFilename(undefined)).toBe('fichier')
  })
  it('garde les accents et espaces internes', () => {
    expect(sanitizeFilename('photo de l’été 2026.HEIC')).toBe('photo de l’été 2026.HEIC')
  })
})

describe('uniquePath', () => {
  it('suffixe (2) si le fichier existe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-up-'))
    fs.writeFileSync(path.join(dir, 'x.txt'), 'a')
    expect(uniquePath(dir, 'x.txt')).toBe(path.join(dir, 'x (2).txt'))
    fs.writeFileSync(path.join(dir, 'x (2).txt'), 'b')
    expect(uniquePath(dir, 'x.txt')).toBe(path.join(dir, 'x (3).txt'))
  })
})

describe('reserveUniquePath', () => {
  it('réserve des chemins distincts et atomiques (anti-collision)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-res-'))
    const a = reserveUniquePath(dir, 'report.pdf')
    const b = reserveUniquePath(dir, 'report.pdf')
    const c = reserveUniquePath(dir, 'report.pdf')
    fs.closeSync(a.fd)
    fs.closeSync(b.fd)
    fs.closeSync(c.fd)
    const names = [a.path, b.path, c.path].map((p) => path.basename(p))
    // trois noms distincts, tous réellement créés sur disque
    expect(new Set(names).size).toBe(3)
    expect(names).toContain('report.pdf')
    expect(names).toContain('report (2).pdf')
    expect(names).toContain('report (3).pdf')
    for (const p of [a.path, b.path, c.path]) expect(fs.existsSync(p)).toBe(true)
  })
})

describe('humanSize', () => {
  it('formate en français', () => {
    expect(humanSize(0)).toBe('0 o')
    expect(humanSize(1536)).toBe('1.5 Ko')
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 Mo')
  })
})

describe('parseCookies', () => {
  it('parse les cookies', () => {
    expect(parseCookies('a=1; wd_admin=tok%20en')).toEqual({ a: '1', wd_admin: 'tok en' })
    expect(parseCookies(undefined)).toEqual({})
  })
})
