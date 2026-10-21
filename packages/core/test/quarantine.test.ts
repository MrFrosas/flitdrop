import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { markFromOutside } from '../src/quarantine.js'

describe('fichier reçu marqué comme venu de l’extérieur', () => {
  it('macOS : drapeau de quarantaine posé ; jamais d’exception, même sur un fichier absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-q-'))
    const f = path.join(dir, 'programme.exe')
    fs.writeFileSync(f, 'x')
    await markFromOutside(f)
    if (process.platform === 'darwin') {
      const v = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', f]).toString()
      expect(v).toMatch(/^0081;[0-9a-f]+;Flitdrop;/)
    }
    // sous Windows (vérifié par le CI avant chaque release) : flux Zone.Identifier
    if (process.platform === 'win32') expect(fs.readFileSync(`${f}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3')
    await expect(markFromOutside(path.join(dir, 'absent.bin'))).resolves.toBeUndefined()
    await expect(markFromOutside(f, 'linux')).resolves.toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
