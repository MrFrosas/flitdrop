import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClipHistory } from '../src/cliphistory.js'
import type { Config } from '../src/config.js'

function cfgWith(maxItems: number, maxDays: number): Config {
  return {
    deviceName: 'test',
    port: 0,
    downloadDir: '/tmp',
    maxFileMB: 100,
    requireApproval: false,
    adminToken: 'x'.repeat(24),
    instanceId: 'x'.repeat(12),
    clipboardAutoPush: false,
    clipHistoryEnabled: true,
    clipHistoryMaxItems: maxItems,
    clipHistoryMaxDays: maxDays,
    theme: 'system',
    skin: 'auto',
    lang: 'auto',
    shortcutsEnabled: true,
    autoUpdate: true,
    basicStats: true,
    telemetryConsent: false,
    telemetryAsked: false,
    basicNoticeShown: false,
    installId: 'i'.repeat(16),
    installedAt: new Date().toISOString(),
    installChannel: '',
    lastVersion: '',
    firstPairingDone: false,
    firstTransferDone: false,
    lastDailyActiveDay: '',
    firstPhonePageDone: false,
  }
}

function freshHistory(): ClipHistory {
  return new ClipHistory(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ch-')))
}

describe('ClipHistory', () => {
  it('ajoute en tête et dédoublonne les copies consécutives identiques', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    expect(h.add('premier', 'pc', cfg)).not.toBeNull()
    expect(h.add('premier', 'pc', cfg)).toBeNull()
    expect(h.add('second', 'pc', cfg)).not.toBeNull()
    expect(h.list().map((e) => e.text)).toEqual(['second', 'premier'])
  })

  it('ignore le vide et tronque les textes énormes', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    expect(h.add('   ', 'pc', cfg)).toBeNull()
    const big = 'a'.repeat(200_000)
    const e = h.add(big, 'pc', cfg)
    expect(e).not.toBeNull()
    expect((e as { text: string }).text.length).toBe(100_000)
  })

  it('applique la rétention par nombre d’éléments', () => {
    const h = freshHistory()
    const cfg = cfgWith(10, 7)
    for (let i = 0; i < 25; i++) h.add(`texte ${i}`, 'pc', cfg)
    expect(h.size()).toBe(10)
    expect(h.list()[0]?.text).toBe('texte 24')
  })

  it('applique la rétention par âge', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    h.add('récent', 'pc', cfg)
    // injecte une entrée vieille de 8 jours via l'état interne
    const internal = h as unknown as { entries: { id: string; ts: string; text: string; source: string }[] }
    internal.entries.push({
      id: 'vieux1',
      ts: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
      text: 'trop vieux',
      source: 'pc',
    })
    h.purge(cfg)
    expect(h.list().map((e) => e.text)).toEqual(['récent'])
  })

  it('bump remonte une entrée en tête, remove et clear fonctionnent', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    h.add('a', 'pc', cfg)
    h.add('b', 'pc', cfg)
    const first = h.list()[1]
    expect(first?.text).toBe('a')
    h.bump(first!.id)
    expect(h.list()[0]?.text).toBe('a')
    expect(h.remove(first!.id)).toBe(true)
    expect(h.remove('inexistant')).toBe(false)
    h.clear()
    expect(h.size()).toBe(0)
  })
})

describe('ClipHistory : version de la liste (téléphone)', () => {
  it('change à chaque modification visible, jamais sans raison', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    const v0 = h.version
    h.add('a', 'pc', cfg)
    const v1 = h.version
    expect(v1).toBeGreaterThan(v0)
    // doublon refusé : la liste n'a pas changé
    h.add('a', 'pc', cfg)
    expect(h.version).toBe(v1)
    // purge sans rien retirer : pas de changement
    h.purge(cfg)
    expect(h.version).toBe(v1)
    h.add('b', 'pc', cfg)
    const v2 = h.version
    expect(v2).toBeGreaterThan(v1)
    const a = h.list()[1]!
    h.bump(a.id)
    const v3 = h.version
    expect(v3).toBeGreaterThan(v2)
    h.remove(a.id)
    const v4 = h.version
    expect(v4).toBeGreaterThan(v3)
    // purge par âge qui retire une entrée
    const internal = h as unknown as { entries: { id: string; ts: string; text: string; source: string }[] }
    internal.entries.push({ id: 'vieux', ts: new Date(Date.now() - 9 * 86_400_000).toISOString(), text: 'x', source: 'pc' })
    h.purge(cfg)
    const v5 = h.version
    expect(v5).toBeGreaterThan(v4)
    h.clear()
    expect(h.version).toBeGreaterThan(v5)
  })
})

describe('ClipHistory : images en double', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('la même image (même empreinte) n’est pas ajoutée deux fois, même après un redémarrage', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ch-'))
    const cfg = cfgWith(200, 7)
    const h = new ClipHistory(home)
    expect(h.addImage(Buffer.from('png-1'), 'data:image/jpeg;base64,AA', 10, 10, 'pc', cfg, 'raw:a')).not.toBeNull()
    expect(h.addImage(Buffer.from('png-1-bis'), 'data:image/jpeg;base64,AA', 10, 10, 'pc', cfg, 'raw:a')).toBeNull()
    expect(h.size()).toBe(1)
    // l'empreinte ne sort jamais (ni vers la page, ni vers le téléphone)
    expect(JSON.stringify(h.list())).not.toContain('raw:a')
    await pause(600)
    // redémarrage : l'image encore copiée revient avec la même empreinte
    const h2 = new ClipHistory(home)
    const v = h2.version
    expect(h2.addImage(Buffer.from('png-1'), 'x', 10, 10, 'pc', cfg, 'raw:a')).toBeNull()
    expect(h2.size()).toBe(1)
    expect(h2.version).toBe(v)
    // une autre image passe
    expect(h2.addImage(Buffer.from('png-2'), 'x', 10, 10, 'pc', cfg, 'raw:b')).not.toBeNull()
    expect(h2.size()).toBe(2)
  })

  it('seule l’entrée la plus récente compte : une image recopiée plus tard revient en tête', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    h.addImage(Buffer.from('p1'), 'x', 1, 1, 'pc', cfg, 'raw:a')
    h.add('un texte', 'pc', cfg)
    expect(h.addImage(Buffer.from('p1'), 'x', 1, 1, 'pc', cfg, 'raw:a')).not.toBeNull()
    expect(h.size()).toBe(3)
  })

  it('entrée d’une version précédente (sans empreinte) : comparée au PNG enregistré, puis complétée', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ch-'))
    const cfg = cfgWith(200, 7)
    const h = new ClipHistory(home)
    // ancienne entrée : miniature PNG, pas d'empreinte
    const old = h.addImage(Buffer.from('ancien-png'), 'data:image/png;base64,AAAA', 20, 10, 'pc', cfg)
    expect(old?.image?.fp).toBeUndefined()
    const v = h.version
    // même PNG, mêmes dimensions : refusé, et l'empreinte est retenue
    expect(h.addImage(Buffer.from('ancien-png'), 'x', 20, 10, 'pc', cfg, 'raw:z')).toBeNull()
    expect(h.version).toBe(v)
    expect(h.addImage(Buffer.from('autre'), 'x', 20, 10, 'pc', cfg, 'raw:z')).toBeNull()
    // l'ancienne miniature PNG reste lisible telle quelle
    expect(h.list()[0]?.image?.thumb).toBe('data:image/png;base64,AAAA')
    // PNG différent : c'est une autre image
    expect(h.addImage(Buffer.from('nouveau-png'), 'x', 20, 10, 'pc', cfg, 'raw:y')).not.toBeNull()
    await pause(600)
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'cliphistory.json'), 'utf8')) as { image?: { fp?: string } }[]
    expect(saved.map((e) => e.image?.fp)).toEqual(['raw:y', 'raw:z'])
  })

  it('image recopiée depuis l’historique : l’entrée remontée retient la nouvelle empreinte', () => {
    const h = freshHistory()
    const cfg = cfgWith(200, 7)
    const a = h.addImage(Buffer.from('p1'), 'x', 1, 1, 'pc', cfg, 'raw:a')!
    h.addImage(Buffer.from('p2'), 'x', 1, 1, 'pc', cfg, 'raw:b')
    h.bump(a.id)
    h.adoptFingerprint('raw:a2')
    expect(h.addImage(Buffer.from('p1-relu'), 'x', 1, 1, 'pc', cfg, 'raw:a2')).toBeNull()
    expect(h.size()).toBe(2)
  })
})
