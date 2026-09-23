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
