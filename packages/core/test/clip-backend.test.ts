import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Espion sur spawn : dans l'app de bureau, lire ou écrire le texte copié ne
// doit lancer AUCUN processus (pbpaste, PowerShell, xclip).
const spawned: string[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, ...rest: unknown[]) => {
      spawned.push(cmd)
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, ...rest)
    },
  }
})

const { createClipboardText } = await import('../src/clip.js')
const { startServer } = await import('../src/server.js')
type Srv = Awaited<ReturnType<typeof startServer>>

describe('presse-papiers fourni par l’hôte (Electron)', () => {
  it('lit et écrit sans lancer de processus', async () => {
    let value = 'bonjour'
    const clip = createClipboardText({ read: () => value, write: (t) => (value = t) })
    expect(await clip.read()).toBe('bonjour')
    await clip.write('salut')
    expect(value).toBe('salut')
    expect(spawned).toEqual([])
  })

  describe('serveur avec surveillance pilotée par l’app', () => {
    let srv: Srv
    let home = ''
    let clipText = ''
    const writes: string[] = []

    beforeAll(async () => {
      delete process.env.FLITDROP_NO_CLIP
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-clip-'))
      process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
      srv = await startServer({
        port: 0,
        home,
        quiet: true,
        manualClipboardPoll: true,
        clipboardText: {
          read: () => clipText,
          write: (t) => {
            writes.push(t)
            clipText = t
          },
        },
      })
    })

    afterAll(async () => {
      await srv.close()
      delete process.env.FLITDROP_DOWNLOADS
      fs.rmSync(home, { recursive: true, force: true })
    })

    const clipHistory = async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/admin/state`, { headers: { 'x-admin-token': srv.adminToken } })
      const s = (await r.json()) as { clipHistory?: Array<{ text?: string }> }
      return s.clipHistory ?? []
    }

    it('un texte copié sur le PC entre dans l’historique, sans aucun processus', async () => {
      clipText = 'copié sur le PC'
      await srv.pollClipboard()
      await srv.pollClipboard()
      const items = await clipHistory()
      expect(items.filter((i) => i.text === 'copié sur le PC')).toHaveLength(1)
      expect(spawned).toEqual([])
    })

    it('recopier une entrée passe par l’hôte et ne revient pas en double', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/admin/state`, { headers: { 'x-admin-token': srv.adminToken } })
      const s = (await r.json()) as { clipHistory: Array<{ id: string; text?: string }> }
      const entry = s.clipHistory.find((i) => i.text === 'copié sur le PC')
      expect(entry).toBeDefined()
      clipText = 'autre chose'
      await srv.pollClipboard()
      const copy = await fetch(`http://127.0.0.1:${srv.port}/api/admin/cliphistory/${entry!.id}/copy`, {
        method: 'POST',
        headers: { 'x-admin-token': srv.adminToken },
      })
      expect(copy.status).toBe(200)
      expect(writes).toContain('copié sur le PC')
      await srv.pollClipboard()
      const items = await clipHistory()
      expect(items.filter((i) => i.text === 'copié sur le PC')).toHaveLength(1)
      expect(spawned).toEqual([])
    })
  })
  describe('lecture qui ne répond jamais', () => {
    let srv: Srv
    let home = ''
    let hang = false
    let clipText = ''
    let settingsCalls = 0

    beforeAll(async () => {
      delete process.env.FLITDROP_NO_CLIP
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-clip-hang-'))
      process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
      srv = await startServer({
        port: 0,
        home,
        quiet: true,
        manualClipboardPoll: true,
        clipboardText: {
          read: () => (hang ? new Promise<string>(() => {}) : clipText),
          write: (t) => {
            clipText = t
          },
        },
        onSettingsChanged: () => settingsCalls++,
      })
    })

    afterAll(async () => {
      vi.useRealTimers()
      await srv.close()
      delete process.env.FLITDROP_DOWNLOADS
      fs.rmSync(home, { recursive: true, force: true })
    })

    it('n’arrête pas la synchro : la vérification suivante repart', async () => {
      hang = true
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const first = srv.pollClipboard()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await first).toBe(false)
      vi.useRealTimers()
      hang = false
      clipText = 'reprise après blocage'
      expect(await srv.pollClipboard()).toBe(true)
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/admin/state`, { headers: { 'x-admin-token': srv.adminToken } })
      const st = (await r.json()) as { clipHistory?: Array<{ text?: string }> }
      expect((st.clipHistory ?? []).some((i) => i.text === 'reprise après blocage')).toBe(true)
    })
    it('prévient l’app après un changement de réglage (réveil de la surveillance)', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/admin/settings`, {
        method: 'POST',
        headers: { 'x-admin-token': srv.adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({ clipboardAutoPush: true }),
      })
      expect(r.status).toBe(200)
      expect(settingsCalls).toBe(1)
    })
  })
})
