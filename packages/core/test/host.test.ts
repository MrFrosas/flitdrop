import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TransferKeepAwake,
  KEEP_AWAKE_MAX_MS,
  compareSemver,
  pickMacDmg,
  macUpdateFrom,
  macDownloadArch,
  checkMacUpdate,
  MacUpdateWatch,
  MAC_RELEASE_PAGE,
  linuxAutostartFile,
  linuxExecTarget,
  linuxAutostartEntry,
  desktopExecQuote,
  isLinuxAutostart,
  setLinuxAutostart,
  refreshLinuxAutostart,
  followRenamedAppImage,
  type PowerBlocker,
} from '../src/host.js'
import { TransferActivity, ACTIVITY_HEARTBEAT_MS } from '../src/activity.js'
import { startServer } from '../src/server.js'

afterEach(() => {
  vi.useRealTimers()
})

// ---------- PC éveillé ----------

function fakeBlocker() {
  const live = new Set<number>()
  let next = 1
  const calls = { start: 0, stop: 0 }
  const blocker: PowerBlocker = {
    start: (type) => {
      expect(type).toBe('prevent-app-suspension')
      calls.start++
      const id = next++
      live.add(id)
      return id
    },
    stop: (id) => {
      calls.stop++
      live.delete(id)
    },
    isStarted: (id) => live.has(id),
  }
  return { blocker, live, calls }
}

describe('TransferKeepAwake', () => {
  it('un seul verrou pendant tout le transfert, rendu quand l’activité retombe', () => {
    const b = fakeBlocker()
    const bars: number[] = []
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: (v) => bars.push(v) })
    k.update({ active: true, progress: null })
    k.update({ active: true, progress: 0.25 })
    k.update({ active: true, progress: 0.5 })
    expect(b.calls.start).toBe(1)
    expect(b.live.size).toBe(1)
    expect(k.holding).toBe(true)
    k.update({ active: false, progress: null })
    expect(b.live.size).toBe(0)
    expect(k.holding).toBe(false)
    // taille inconnue : barre « en cours » (2), puis pourcentages, puis effacée
    expect(bars).toEqual([2, 0.25, 0.5, -1])
  })

  it('progression bornée entre 0 et 1', () => {
    const bars: number[] = []
    const k = new TransferKeepAwake({ blocker: fakeBlocker().blocker, setProgress: (v) => bars.push(v) })
    k.update({ active: true, progress: 1.7 })
    k.update({ active: true, progress: -3 })
    k.update({ active: true, progress: Number.NaN })
    expect(bars).toEqual([1, 0, 2])
  })

  it('filet de 30 minutes sans nouvelle : le PC peut de nouveau dormir', () => {
    vi.useFakeTimers()
    const b = fakeBlocker()
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: () => {} })
    k.update({ active: true, progress: 0.1 })
    vi.advanceTimersByTime(KEEP_AWAKE_MAX_MS - 1000)
    // une nouvelle repousse l'échéance
    k.update({ active: true, progress: 0.2 })
    vi.advanceTimersByTime(KEEP_AWAKE_MAX_MS - 1000)
    expect(b.live.size).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(b.live.size).toBe(0)
    // l'activité continue : on reprend un verrou
    k.update({ active: true, progress: 0.3 })
    expect(b.live.size).toBe(1)
    expect(b.calls.start).toBe(2)
    k.stop()
    expect(b.live.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('les erreurs du système ne remontent jamais', () => {
    const k = new TransferKeepAwake({
      blocker: {
        start: () => {
          throw new Error('refusé')
        },
        stop: () => {
          throw new Error('déjà rendu')
        },
      },
      setProgress: () => {
        throw new Error('fenêtre détruite')
      },
    })
    expect(() => k.update({ active: true, progress: 0.5 })).not.toThrow()
    expect(() => k.update({ active: false, progress: null })).not.toThrow()
    expect(() => k.stop()).not.toThrow()
    expect(() => k.update(undefined)).not.toThrow()
  })

  it('un verrou rendu par le système n’est pas rendu une deuxième fois', () => {
    const b = fakeBlocker()
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: () => {} })
    k.update({ active: true, progress: null })
    b.live.clear()
    k.stop()
    expect(b.calls.stop).toBe(0)
  })

  it('branché sur core.activity : verrou au premier octet, rendu 30 s après le dernier', () => {
    vi.useFakeTimers()
    const b = fakeBlocker()
    const bars: number[] = []
    const a = new TransferActivity()
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: (v) => bars.push(v) })
    a.on('transfer', (s) => k.update(s))
    a.update('up:1', 1_000, 4_000)
    expect(b.live.size).toBe(1)
    a.update('up:1', 4_000, 4_000)
    a.end('up:1')
    vi.advanceTimersByTime(29_000)
    expect(b.live.size).toBe(1)
    vi.advanceTimersByTime(2_000)
    expect(b.live.size).toBe(0)
    expect(bars.at(-1)).toBe(-1)
    a.close()
    k.stop()
  })

  it('fichier arrivé : la barre disparaît tout de suite, le PC reste éveillé 30 s', () => {
    vi.useFakeTimers()
    const b = fakeBlocker()
    const bars: number[] = []
    const a = new TransferActivity()
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: (v) => bars.push(v) })
    a.on('transfer', (s) => k.update(s))
    a.update('dl:1', 2_000, 4_000)
    a.update('dl:1', 4_000, 4_000)
    vi.advanceTimersByTime(600)
    expect(bars.at(-1)).toBe(1)
    a.end('dl:1')
    vi.advanceTimersByTime(600)
    // jamais la barre « en cours » (2) après l'arrivée
    expect(bars.at(-1)).toBe(-1)
    expect(bars).not.toContain(2)
    expect(k.holding).toBe(true)
    vi.advanceTimersByTime(31_000)
    expect(k.holding).toBe(false)
    a.close()
    k.stop()
  })

  it('taille inconnue : barre « en cours » ; ancien coeur sans `running` : comme avant', () => {
    const bars: number[] = []
    const k = new TransferKeepAwake({ blocker: fakeBlocker().blocker, setProgress: (v) => bars.push(v) })
    k.update({ active: true, progress: null, running: 1 })
    k.update({ active: true, progress: null })
    k.update({ active: true, progress: null, running: 0 })
    expect(bars).toEqual([2, 2, -1])
    expect(k.holding).toBe(true)
    k.stop()
  })

  it('transfert sans taille plus long que le filet de 30 minutes : le PC reste éveillé', () => {
    vi.useFakeTimers()
    const b = fakeBlocker()
    const bars: number[] = []
    const a = new TransferActivity()
    const k = new TransferKeepAwake({ blocker: b.blocker, setProgress: (v) => bars.push(v) })
    a.on('transfer', (s) => k.update(s))
    let got = 0
    for (let t = 0; t < KEEP_AWAKE_MAX_MS + 2 * ACTIVITY_HEARTBEAT_MS; t += 5_000) {
      got += 64 * 1024
      a.update('sc:1', got, 0)
      vi.advanceTimersByTime(5_000)
      expect(k.holding).toBe(true)
    }
    expect(b.calls.start).toBe(1)
    a.end('sc:1')
    vi.advanceTimersByTime(31_000)
    expect(k.holding).toBe(false)
    expect(bars.at(-1)).toBe(-1)
    a.close()
    k.stop()
  })

  it('filet de 30 minutes atteint : la barre part avec le verrou', () => {
    vi.useFakeTimers()
    const bars: number[] = []
    const k = new TransferKeepAwake({ blocker: fakeBlocker().blocker, setProgress: (v) => bars.push(v) })
    k.update({ active: true, progress: 0.4, running: 1 })
    vi.advanceTimersByTime(KEEP_AWAKE_MAX_MS + 1)
    expect(k.holding).toBe(false)
    expect(bars).toEqual([0.4, -1])
  })
})

// ---------- nouvelle version sur Mac ----------

describe('compareSemver', () => {
  it('ordre des versions', () => {
    expect(compareSemver('0.6.6', '0.6.5')).toBeGreaterThan(0)
    expect(compareSemver('0.6.5', '0.6.6')).toBeLessThan(0)
    expect(compareSemver('0.6.10', '0.6.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareSemver('v0.6.6', '0.6.6')).toBe(0)
    expect(compareSemver('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareSemver('1.0.0+build.5', '1.0.0')).toBe(0)
    // illisible : toujours la plus petite
    expect(compareSemver('n’importe quoi', '0.0.1')).toBeLessThan(0)
    expect(compareSemver('0.0.1', '6.6')).toBeGreaterThan(0)
  })
})

const REL = 'https://github.com/MrFrosas/flitdrop/releases/download/v0.6.7/'
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/MrFrosas/flitdrop/releases/tag/${tag}`,
  assets: [
    { name: 'Flitdrop-Setup-0.6.7.exe', browser_download_url: REL + 'Flitdrop-Setup-0.6.7.exe' },
    { name: 'Flitdrop-0.6.7-arm64.dmg', browser_download_url: REL + 'Flitdrop-0.6.7-arm64.dmg' },
    { name: 'Flitdrop-0.6.7-x64.dmg', browser_download_url: REL + 'Flitdrop-0.6.7-x64.dmg' },
    { name: 'Flitdrop-0.6.7-x86_64.AppImage', browser_download_url: REL + 'Flitdrop-0.6.7-x86_64.AppImage' },
  ],
  ...extra,
})

describe('choix du .dmg', () => {
  it('Apple Silicon et Intel reçoivent chacun le leur', () => {
    const r = release('v0.6.7')
    expect(pickMacDmg(r.assets, 'arm64')).toBe(REL + 'Flitdrop-0.6.7-arm64.dmg')
    expect(pickMacDmg(r.assets, 'x64')).toBe(REL + 'Flitdrop-0.6.7-x64.dmg')
  })

  it('Rosetta : un Mac Apple Silicon qui fait tourner la version Intel reçoit la version Apple Silicon', () => {
    expect(macDownloadArch('x64', true)).toBe('arm64')
    expect(macDownloadArch('x64', false)).toBe('x64')
    expect(macDownloadArch('arm64', false)).toBe('arm64')
  })

  it('jamais une adresse hors des versions GitHub de Flitdrop', () => {
    expect(pickMacDmg([{ name: 'Flitdrop-0.6.7-arm64.dmg', browser_download_url: 'https://evil.example/x-arm64.dmg' }], 'arm64')).toBeNull()
    expect(pickMacDmg([{ name: 'Flitdrop-0.6.7-arm64.dmg', browser_download_url: 'http://github.com/MrFrosas/flitdrop/releases/download/a.dmg' }], 'arm64')).toBeNull()
    expect(pickMacDmg('pas une liste', 'arm64')).toBeNull()
    expect(pickMacDmg([null, 3, { name: 5 }], 'x64')).toBeNull()
  })

  it('une version plus récente est proposée, avec le bon .dmg', () => {
    expect(macUpdateFrom(release('v0.6.7'), '0.6.6', 'arm64')).toEqual({ version: '0.6.7', url: REL + 'Flitdrop-0.6.7-arm64.dmg' })
    expect(macUpdateFrom(release('0.6.7'), '0.6.6', 'x64')).toEqual({ version: '0.6.7', url: REL + 'Flitdrop-0.6.7-x64.dmg' })
  })

  it('à jour, plus ancienne, brouillon, préversion ou illisible : rien', () => {
    expect(macUpdateFrom(release('v0.6.6'), '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom(release('v0.6.5'), '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom(release('v0.6.7', { draft: true }), '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom(release('v0.6.7', { prerelease: true }), '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom(release('v0.7.0-beta.1'), '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom({ message: 'API rate limit exceeded' }, '0.6.6', 'arm64')).toBeNull()
    expect(macUpdateFrom(null, '0.6.6', 'arm64')).toBeNull()
  })

  it('version sans .dmg : la page de la version', () => {
    expect(macUpdateFrom(release('v0.6.7', { assets: [] }), '0.6.6', 'arm64')?.url).toBe(
      'https://github.com/MrFrosas/flitdrop/releases/tag/v0.6.7'
    )
    expect(macUpdateFrom(release('v0.6.7', { assets: [], html_url: 'https://evil.example/' }), '0.6.6', 'arm64')?.url).toBe(
      MAC_RELEASE_PAGE
    )
  })

  it('checkMacUpdate : lit GitHub, distingue « à jour » d’un échec', async () => {
    const ok = (body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.github.com/repos/MrFrosas/flitdrop/releases/latest')
        expect((init?.headers as Record<string, string>)['user-agent']).toBe('Flitdrop')
        return new Response(JSON.stringify(body), { status: 200 })
      }) as typeof fetch
    expect(await checkMacUpdate({ current: '0.6.6', arch: 'arm64', fetch: ok(release('v0.6.7')) })).toEqual({
      latest: { version: '0.6.7', url: REL + 'Flitdrop-0.6.7-arm64.dmg' },
    })
    expect(await checkMacUpdate({ current: '0.6.7', arch: 'arm64', fetch: ok(release('v0.6.7')) })).toEqual({ latest: null })
    const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch
    expect(await checkMacUpdate({ current: '0.6.6', arch: 'arm64', fetch: notFound })).toBeNull()
    const offline = (async () => {
      throw new Error('hors ligne')
    }) as typeof fetch
    expect(await checkMacUpdate({ current: '0.6.6', arch: 'arm64', fetch: offline })).toBeNull()
  })
})

describe('MacUpdateWatch', () => {
  it('une fois 10 s après le lancement, puis une fois par jour', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => ({ latest: { version: '0.6.7', url: REL } }))
    const seen: unknown[] = []
    const w = new MacUpdateWatch({ check, enabled: () => true, onResult: (l) => seen.push(l) })
    w.start()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(check).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(check).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ version: '0.6.7', url: REL }])
    await vi.advanceTimersByTimeAsync(23 * 3600_000)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(check).toHaveBeenCalledTimes(2)
    w.stop()
    await vi.advanceTimersByTimeAsync(48 * 3600_000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('mises à jour coupées dans les réglages : aucune vérification seule, la main passe toujours', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => ({ latest: null }))
    const w = new MacUpdateWatch({ check, enabled: () => false, onResult: () => {} })
    w.start()
    await vi.advanceTimersByTimeAsync(3 * 24 * 3600_000)
    expect(check).toHaveBeenCalledTimes(0)
    expect(await w.checkNow()).toEqual({ latest: null })
    expect(check).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('une seule vérification à la fois ; un échec ne change pas la carte', async () => {
    let resolve: (v: null) => void = () => {}
    const check = vi.fn(() => new Promise<null>((r) => (resolve = r)))
    const onResult = vi.fn()
    const w = new MacUpdateWatch({ check, enabled: () => true, onResult })
    const a = w.checkNow()
    const b = w.checkNow()
    expect(check).toHaveBeenCalledTimes(1)
    resolve(null)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(onResult).not.toHaveBeenCalled()
  })
})

describe('état du système dans la page du PC', () => {
  it('/state porte host, host-changed prévient la page, /host/action appelle l’app', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-host-'))
    const prevDl = process.env.FLITDROP_DOWNLOADS
    process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
    const actions: string[] = []
    const srv = await startServer({ port: 0, home, disableClipboard: true, quiet: true, onHostAction: (a) => actions.push(a) })
    try {
      const base = `http://127.0.0.1:${srv.port}/api/admin`
      const headers = { 'x-admin-token': srv.adminToken, 'content-type': 'application/json' }
      const state = async () => ((await (await fetch(base + '/state', { headers })).json()) as { host: unknown }).host
      expect(await state()).toEqual({ macUpdate: null, loginItemNeedsApproval: false })
      srv.setHost({ macUpdate: { version: '0.6.7' }, loginItemNeedsApproval: true })
      expect(await state()).toEqual({ macUpdate: { version: '0.6.7' }, loginItemNeedsApproval: true })
      // vérification à la main : la carte se remontre, même après « Plus tard »
      srv.setHost({ macUpdate: { version: '0.6.7' }, revealMacUpdate: true })
      expect(await state()).toEqual({ macUpdate: { version: '0.6.7', reveal: 1 }, loginItemNeedsApproval: true })
      // vérification automatique qui retrouve la même version : rien ne change
      srv.setHost({ macUpdate: { version: '0.6.7' } })
      expect(await state()).toEqual({ macUpdate: { version: '0.6.7', reveal: 1 }, loginItemNeedsApproval: true })
      srv.setHost({ revealMacUpdate: true })
      expect(await state()).toEqual({ macUpdate: { version: '0.6.7', reveal: 2 }, loginItemNeedsApproval: true })
      // version suivante : le compteur repart
      srv.setHost({ macUpdate: { version: '0.6.8' } })
      expect(await state()).toEqual({ macUpdate: { version: '0.6.8' }, loginItemNeedsApproval: true })
      const post = (body: unknown) => fetch(base + '/host/action', { method: 'POST', headers, body: JSON.stringify(body) })
      expect((await post({ action: 'openMacUpdate' })).status).toBe(200)
      expect((await post({ action: 'openLoginItems' })).status).toBe(200)
      // jamais une action ou une adresse inventée par la page
      expect((await post({ action: 'openUrl', url: 'https://evil.example' })).status).toBe(400)
      expect(actions).toEqual(['openMacUpdate', 'openLoginItems'])
      // sans jeton : refusé
      expect((await fetch(base + '/host/action', { method: 'POST' })).status).toBe(401)
    } finally {
      await srv.close()
      if (prevDl === undefined) delete process.env.FLITDROP_DOWNLOADS
      else process.env.FLITDROP_DOWNLOADS = prevDl
    }
  })
})

// ---------- démarrage sous Linux ----------

describe('lancement au démarrage sous Linux', () => {
  it('emplacement du fichier', () => {
    expect(linuxAutostartFile({}, '/home/lea')).toBe('/home/lea/.config/autostart/flitdrop.desktop')
    expect(linuxAutostartFile({ XDG_CONFIG_HOME: '/data/cfg' }, '/home/lea')).toBe('/data/cfg/autostart/flitdrop.desktop')
    // XDG_CONFIG_HOME relatif : ignoré, comme le veut la norme
    expect(linuxAutostartFile({ XDG_CONFIG_HOME: 'cfg' }, '/home/lea')).toBe('/home/lea/.config/autostart/flitdrop.desktop')
  })

  it('programme lancé : l’AppImage, sinon le lanceur posé à côté, sinon l’exécutable', () => {
    expect(linuxExecTarget('/home/lea/Apps/Flitdrop-0.6.6-x86_64.AppImage', '/tmp/.mount_x/flitdrop-bin', () => true)).toBe(
      '/home/lea/Apps/Flitdrop-0.6.6-x86_64.AppImage'
    )
    expect(linuxExecTarget(undefined, '/opt/Flitdrop/flitdrop-bin', (p) => p === '/opt/Flitdrop/flitdrop')).toBe('/opt/Flitdrop/flitdrop')
    expect(linuxExecTarget(undefined, '/opt/Flitdrop/flitdrop-bin', () => false)).toBe('/opt/Flitdrop/flitdrop-bin')
    expect(linuxExecTarget('', '/opt/Flitdrop/flitdrop', () => true)).toBe('/opt/Flitdrop/flitdrop')
  })

  it('contenu du fichier : démarre caché', () => {
    expect(linuxAutostartEntry('/opt/Flitdrop/flitdrop')).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Flitdrop',
        'Comment=Flitdrop',
        'Exec="/opt/Flitdrop/flitdrop" --hidden',
        'Icon=flitdrop',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n')
    )
  })

  it('chemins avec espaces et caractères spéciaux correctement protégés', () => {
    expect(desktopExecQuote('/home/lea/Mes Apps/Flitdrop.AppImage')).toBe('"/home/lea/Mes Apps/Flitdrop.AppImage"')
    expect(desktopExecQuote('/a/"b"/$c/`d`/e\\f/100%')).toBe('"/a/\\"b\\"/\\$c/\\`d\\`/e\\\\f/100%%"')
  })

  it('pose, relit et retire le fichier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-autostart-'))
    const file = linuxAutostartFile({}, dir)
    expect(isLinuxAutostart(file)).toBe(false)
    expect(setLinuxAutostart(file, true, '/opt/Flitdrop/flitdrop')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(linuxAutostartEntry('/opt/Flitdrop/flitdrop'))
    expect(isLinuxAutostart(file)).toBe(true)
    expect(setLinuxAutostart(file, false, '/opt/Flitdrop/flitdrop')).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    // retirer un fichier absent : sans erreur
    expect(setLinuxAutostart(file, false, '/x')).toBe(false)
  })

  it('AppImage mise à jour sous un autre nom : seule la ligne Exec suit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-autostart-'))
    const file = linuxAutostartFile({}, dir)
    // rien à corriger quand le démarrage n'est pas posé
    expect(refreshLinuxAutostart(file, '/apps/Flitdrop-0.6.7.AppImage')).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    setLinuxAutostart(file, true, '/apps/Flitdrop-0.6.6.AppImage')
    // une retouche à la main est gardée
    fs.appendFileSync(file, 'X-GNOME-Autostart-Delay=10\n')
    expect(refreshLinuxAutostart(file, '/apps/Flitdrop-0.6.7.AppImage')).toBe(true)
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('Exec="/apps/Flitdrop-0.6.7.AppImage" --hidden')
    expect(text).not.toContain('0.6.6')
    expect(text).toContain('X-GNOME-Autostart-Delay=10')
    expect(refreshLinuxAutostart(file, '/apps/Flitdrop-0.6.7.AppImage')).toBe(false)
  })

  it('mise à jour installée à la fermeture : le démarrage suit la nouvelle AppImage avant la sortie', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-autostart-'))
    const file = linuxAutostartFile({}, dir)
    // pas de démarrage automatique : rien n'est créé
    expect(followRenamedAppImage(file, '/home/lea/Apps/Flitdrop-0.6.7-x86_64.AppImage')).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    setLinuxAutostart(file, true, '/home/lea/Apps/Flitdrop-0.6.6-x86_64.AppImage')
    // chemin reçu illisible : le fichier ne bouge pas
    for (const bad of [undefined, 42, '', 'Flitdrop-0.6.7.AppImage', '/a\0b']) expect(followRenamedAppImage(file, bad)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toContain('Flitdrop-0.6.6-x86_64.AppImage')
    expect(followRenamedAppImage(file, '/home/lea/Apps/Flitdrop-0.6.7-x86_64.AppImage')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec="/home/lea/Apps/Flitdrop-0.6.7-x86_64.AppImage" --hidden')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
