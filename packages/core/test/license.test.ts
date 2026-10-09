import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  License,
  verifyToken,
  tokenUsable,
  currencyFor,
  halfPrice,
  normalizeRestoreCode,
  plausibleEmail,
  monthFolder,
  photoDate,
  isMedia,
  nextLocalMidnight,
  sanitizeRemoteConfig,
  FREE_DAILY_FILES,
  type TokenPayload,
} from '../src/license.js'
import { deviceIdFrom, plausibleId, readMachineIdentifier, fileMarkStore, registryMarkStore, type MarkStore } from '../src/machineid.js'

// Paire de clés DE TEST : la clé publique est celle de src/license-key.ts tant
// que l'orchestrateur ne l'a pas remplacée ; les tests la passent toujours
// explicitement, ils ne dépendent donc pas de la clé embarquée.
const TEST_PUB = '/DuOo3uFrsEk2LTrypdMWZtYQITS1nUXLp8QK3vLmrg='
const TEST_PRIV = crypto.createPrivateKey({
  key: Buffer.from('MC4CAQAwBQYDK2VwBCIEIJC1x9+Rpcf7QqPLnKW4VLbii5eZpB4SxBdcrsSxkl/Q', 'base64'),
  format: 'der',
  type: 'pkcs8',
})
const OTHER_PRIV = crypto.generateKeyPairSync('ed25519').privateKey

const DAY = 86_400_000
const LAUNCH = '2026-11-01T00:00:00.000Z'
const MACHINE_A = '4c4c4544-0042-3510-8051-b4c04f4e4a32'
const MACHINE_B = '9f1e3a52-7d0c-4b8e-a1f2-3c4d5e6f7a8b'
const DEV_A = deviceIdFrom(MACHINE_A)

function sign(payload: Record<string, unknown>, key: crypto.KeyObject = TEST_PRIV): string {
  const p = Buffer.from(JSON.stringify(payload))
  return p.toString('base64url') + '.' + crypto.sign(null, p, key).toString('base64url')
}
const tokenFor = (dev: string, iatMs: number, days = 30, key?: crypto.KeyObject) =>
  sign({ v: 1, plan: 'pro', dev, cus: 'c'.repeat(32), iat: Math.floor(iatMs / 1000), exp: Math.floor(iatMs / 1000) + days * 86400 }, key)

function memMark(initial: string | null = null): MarkStore & { v: string | null } {
  const m = {
    v: initial,
    read: async () => m.v,
    write: async (x: string) => {
      m.v = x
      return true
    },
  }
  return m
}

type Route = (body: Record<string, unknown> | undefined) => { status: number; body?: unknown } | 'offline'
function fakeFetch(routes: Record<string, Route>) {
  const calls: { key: string; body?: Record<string, unknown> }[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const key = `${init?.method ?? 'GET'} ${u.pathname}`
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ key, body })
    const h = routes[key]
    const r = h ? h(body) : 'offline'
    if (r === 'offline') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }) as unknown as typeof fetch
  return { f, calls }
}

const configOn = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    enabled: true,
    env: 'sandbox',
    clientToken: 'test_x',
    priceId: 'pri_01m4gfwxvbg1jjgbp7rbxns9wa',
    earlyDiscountId: 'dsc_01m4gfz5p1h0p8rghvn1z36jjg',
    launchedAt: LAUNCH,
    trialDays: 14,
    earlyDays: 30,
    displayPrice: { EUR: '5,99 €', USD: '$5.99', GBP: '£5.49' },
    ...extra,
  },
})

let homes: string[] = []
const newHome = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-lic-'))
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true })
  homes = []
})

interface Rig {
  lic: License
  cfg: Config
  home: string
  events: { event: string; props?: Record<string, unknown> }[]
  changes: number
  opened: string[]
}

let clock = Date.parse('2026-11-05T10:00:00.000Z')
beforeEach(() => {
  clock = Date.parse('2026-11-05T10:00:00.000Z')
})

/** Licence active sur un dossier donné. `installedAt` : avant le lancement
 *  par défaut (installation existante). */
async function rig(o: {
  home?: string
  machine?: string | null
  mark?: MarkStore
  routes?: Record<string, Route>
  installedAt?: string
  active?: boolean
  fetchImpl?: typeof fetch
  buildDefault?: boolean
} = {}): Promise<Rig> {
  const home = o.home ?? newHome()
  const cfg = loadConfig(home)
  if (o.installedAt !== undefined || !fs.existsSync(path.join(home, '.keep'))) {
    cfg.installedAt = o.installedAt ?? '2026-03-01T00:00:00.000Z'
    fs.writeFileSync(path.join(home, '.keep'), '')
  }
  const r: Rig = { lic: null as unknown as License, cfg, home, events: [], changes: 0, opened: [] }
  r.lic = new License(
    {
      home,
      cfg,
      track: (event, props) => void r.events.push({ event, props }),
      onChange: () => void r.changes++,
      lang: () => 'fr',
      openUrl: (u) => void r.opened.push(u),
    },
    {
      active: o.active ?? true,
      configUrl: 'https://license.test/api/license/config',
      fetchImpl: o.fetchImpl ?? fakeFetch(o.routes ?? { 'GET /api/license/config': () => configOn() }).f,
      now: () => clock,
      publicKey: TEST_PUB,
      systemLocale: 'fr-FR',
      machineId: async () => (o.machine === undefined ? MACHINE_A : o.machine),
      markStore: o.mark ?? memMark(),
      buildDefault: o.buildDefault ?? false,
    }
  )
  await r.lic.ready
  return r
}

describe('jeton de licence (Ed25519)', () => {
  const now = Date.parse('2026-11-05T10:00:00Z')
  it('valide : signé par notre clé, pour cet appareil', () => {
    const chk = verifyToken(tokenFor(DEV_A, now), DEV_A, TEST_PUB)
    expect(chk.ok).toBe(true)
  })
  it('forgé : contenu modifié, autre clé, signature tronquée, forme fausse', () => {
    const good = tokenFor(DEV_A, now)
    const [p, sig] = good.split('.') as [string, string]
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>
    payload.exp = (payload.exp as number) + 10 * 365 * 86400
    const tampered = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig
    expect(verifyToken(tampered, DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyToken(tokenFor(DEV_A, now, 30, OTHER_PRIV), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyToken(p + '.' + sig.slice(0, 20), DEV_A, TEST_PUB).ok).toBe(false)
    for (const bad of ['', 'abc', 'a.b.c', 'x'.repeat(5000), null, 42]) expect(verifyToken(bad, DEV_A, TEST_PUB).ok).toBe(false)
    // plan autre que pro, version inconnue : refusés même bien signés
    expect(verifyToken(sign({ v: 1, plan: 'free', dev: DEV_A, cus: 'x', iat: 1, exp: 2 }), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
    expect(verifyToken(sign({ v: 2, plan: 'pro', dev: DEV_A, cus: 'x', iat: 1, exp: 2 }), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
  })
  it('autre appareil : refusé', () => {
    expect(verifyToken(tokenFor(deviceIdFrom(MACHINE_B), now), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'device' })
  })
  it('échéance : valable jusqu’à exp + 7 jours hors ligne', () => {
    const p = { v: 1, plan: 'pro', dev: DEV_A, cus: 'x', iat: 0, exp: Math.floor(now / 1000) } as TokenPayload
    expect(tokenUsable(p, now - 1000)).toBe(true)
    expect(tokenUsable(p, now + 6 * DAY)).toBe(true)
    expect(tokenUsable(p, now + 7 * DAY + 1000)).toBe(false)
  })
})

describe('petites fonctions', () => {
  it('devise d’après la région, sinon la langue', () => {
    expect(currencyFor('fr-FR')).toBe('EUR')
    expect(currencyFor('de_DE')).toBe('EUR')
    expect(currencyFor('en-GB')).toBe('GBP')
    expect(currencyFor('en-US')).toBe('USD')
    expect(currencyFor('fr')).toBe('EUR')
    expect(currencyFor('en')).toBe('USD')
    expect(currencyFor(undefined)).toBe('USD')
  })
  it('moitié d’un prix affiché, même écriture', () => {
    expect(halfPrice('5,99 €')).toBe('2,99 €')
    expect(halfPrice('$5.99')).toBe('$2.99')
    expect(halfPrice('£5.49')).toBe('£2.74')
    expect(halfPrice('gratuit')).toBeNull()
  })
  it('code de restauration : 12 caractères Crockford, casse, tirets, O/I/L', () => {
    expect(normalizeRestoreCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN')
    expect(normalizeRestoreCode('ABCD\u2013EFGH.JKMN')).toBe('ABCDEFGHJKMN')
    expect(normalizeRestoreCode(' 0O1I-L2Z3 4567 ')).toBe('001112Z34567')
    expect(normalizeRestoreCode('0o1i-l2z3-4567')).toBe('001112Z34567')
    expect(normalizeRestoreCode('ABCD-EFGH-JKMU')).toBeNull()
    expect(normalizeRestoreCode('12345678')).toBeNull()
    expect(normalizeRestoreCode(123)).toBeNull()
  })
  it('adresse e-mail plausible', () => {
    expect(plausibleEmail(' zoe@example.com ')).toBe('zoe@example.com')
    for (const bad of ['zoe', 'zoe@', '@example.com', 'a b@c.de', 'x'.repeat(300) + '@a.fr', 7]) expect(plausibleEmail(bad)).toBeNull()
  })
  it('dossier du mois, date plausible, photo ou vidéo', () => {
    expect(monthFolder(new Date(2025, 2, 15, 12).getTime())).toBe('2025-03')
    const arrival = Date.parse('2026-11-05T10:00:00Z')
    expect(photoDate(new Date(2025, 2, 15).getTime(), arrival)).toBe(new Date(2025, 2, 15).getTime())
    expect(photoDate(undefined, arrival)).toBe(arrival)
    expect(photoDate('2025-03-15', arrival)).toBe(arrival)
    expect(photoDate(0, arrival)).toBe(arrival)
    expect(photoDate(arrival + 5 * DAY, arrival)).toBe(arrival)
    expect(isMedia('image/heic', 'IMG_1.HEIC')).toBe(true)
    expect(isMedia('video/quicktime', 'a.mov')).toBe(true)
    expect(isMedia(undefined, 'IMG_2.JPG')).toBe(true)
    expect(isMedia('application/pdf', 'facture.pdf')).toBe(false)
  })
  it('minuit local suivant', () => {
    const t = new Date(2026, 10, 5, 23, 59).getTime()
    expect(nextLocalMidnight(t)).toBe(new Date(2026, 10, 6, 0, 0).getTime())
  })
  it('configuration du serveur nettoyée', () => {
    expect(sanitizeRemoteConfig(null)).toBeNull()
    expect(sanitizeRemoteConfig({ enabled: 'yes' })).toBeNull()
    const c = sanitizeRemoteConfig({ enabled: true, trialDays: 9999, displayPrice: { EUR: '5,99 €', usd: 'x', GBP: '<b>£</b>' }, earlyDiscountId: 'dsc_1' })!
    expect(c.trialDays).toBe(60)
    expect(c.displayPrice).toEqual({ EUR: '5,99 €' })
    expect(c.earlyDiscount).toBe(true)
  })
})

describe('identité de la machine', () => {
  it('Windows, macOS, Linux, et rien de plausible', async () => {
    const exec = (out: string) => async () => out
    expect(await readMachineIdentifier({ platform: 'win32', exec: exec('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4C4C4544-0042-3510-8051-B4C04F4E4A32\r\n') })).toBe(MACHINE_A)
    expect(await readMachineIdentifier({ platform: 'darwin', exec: exec('  "IOPlatformUUID" = "4C4C4544-0042-3510-8051-B4C04F4E4A32"\n') })).toBe(MACHINE_A)
    const read = async (f: string) => {
      if (f === '/etc/machine-id') throw new Error('absent')
      return 'b08dfa6083e7567a1921a715000001fb\n'
    }
    expect(await readMachineIdentifier({ platform: 'linux', read })).toBe('b08dfa6083e7567a1921a715000001fb')
    expect(await readMachineIdentifier({ platform: 'win32', exec: async () => { throw new Error('reg absent') } })).toBeNull()
    expect(await readMachineIdentifier({ platform: 'darwin', exec: exec('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"') })).toBeNull()
    expect(plausibleId('abc')).toBeNull()
    expect(deviceIdFrom(MACHINE_A)).toMatch(/^[0-9a-f]{32}$/)
    expect(deviceIdFrom(MACHINE_A)).not.toBe(deviceIdFrom(MACHINE_B))
  })
  it('deuxième emplacement : fichier, et registre sans shell', async () => {
    const f = path.join(newHome(), 'sub', '.t')
    const store = fileMarkStore(f)
    expect(await store.read()).toBeNull()
    expect(await store.write('v1.1.abc')).toBe(true)
    expect(await store.read()).toBe('v1.1.abc')
    const calls: string[][] = []
    const reg = registryMarkStore(async (file, args) => {
      calls.push([file, ...args])
      return 'HKEY_CURRENT_USER\\Software\\Flitdrop\r\n    t    REG_SZ    v1.123.abc\r\n'
    })
    expect(await reg.read()).toBe('v1.123.abc')
    expect(await reg.write('v1.123.abc')).toBe(true)
    expect(await reg.write('a b; rm -rf')).toBe(false)
    // reg.exe par son chemin complet (jamais par le PATH), valeur en argument séparé
    expect(calls[1]![0]).toMatch(/[\\/]System32[\\/]reg\.exe$/)
    expect(calls[1]!.slice(1)).toEqual(['add', 'HKCU\\Software\\Flitdrop', '/v', 't', '/t', 'REG_SZ', '/d', 'v1.123.abc', '/f'])
  })
})

describe('plan', () => {
  it('licence inactive (ligne de commande, tests) : « off », aucun réseau', async () => {
    const net = fakeFetch({ 'GET /api/license/config': () => configOn() })
    const r = await rig({ active: false, fetchImpl: net.f })
    await r.lic.refreshConfig()
    r.lic.start()
    r.lic.tick()
    expect(r.lic.plan()).toBe('off')
    expect(net.calls).toHaveLength(0)
    expect(r.lic.canStartFile(1000)).toBe(true)
    expect(r.lic.quota()).toBeNull()
    expect(r.lic.monthFolders()).toBe(false)
    expect(r.lic.fullFeatures()).toBe(true)
    expect(r.lic.state()).toEqual({ plan: 'off' })
  })

  it('configuration injoignable et jamais vue : « off », comme avant', async () => {
    const r = await rig({ routes: {} })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('off')
    r.lic.countFiles(100)
    expect(r.lic.dailyUsed()).toBe(0)
    expect(r.lic.canStartFile(0)).toBe(true)
    expect(r.lic.card()).toBeNull()
    expect(r.events).toHaveLength(0)
  })

  it('mode payant coupé par le serveur : « off »', async () => {
    const r = await rig({ routes: { 'GET /api/license/config': () => configOn({ enabled: false }) } })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('off')
  })

  it('installation existante : essai de 14 jours depuis la première fois que le mode payant est vu, puis gratuit', async () => {
    const mark = memMark()
    const r = await rig({ mark })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.trialDaysLeft()).toBe(14)
    expect(r.cfg.licenseState?.trialStartAt).toBe(new Date(clock).toISOString())
    // le début de l'essai est aussi noté, signé, ailleurs
    await new Promise((res) => setTimeout(res, 0))
    expect(mark.v).toMatch(/^v1\.\d+\.[0-9a-f]{32}$/)
    expect(r.lic.canStartFile(1000)).toBe(true)
    expect(r.lic.monthFolders()).toBe(true)
    clock += 14 * DAY + 1000
    expect(r.lic.plan()).toBe('free')
    expect(r.lic.monthFolders()).toBe(false)
    expect(r.lic.fullFeatures()).toBe(false)
  })

  it('installation neuve après le lancement : essai depuis son premier lancement', async () => {
    const installed = '2026-11-03T08:00:00.000Z'
    const r = await rig({ installedAt: installed })
    await r.lic.refreshConfig()
    expect(r.cfg.licenseState?.trialStartAt).toBe(installed)
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.trialDaysLeft()).toBe(12)
  })

  it('mode payant vu puis configuration injoignable : il reste actif (état signé), l’interrupteur du serveur le coupe', async () => {
    const home = newHome()
    let on = true
    const routes = { 'GET /api/license/config': () => (on ? configOn() : configOn({ enabled: false })) }
    const r = await rig({ home, routes })
    await r.lic.refreshConfig()
    clock += 20 * DAY
    expect(r.lic.plan()).toBe('free')
    // relancé hors ligne : toujours gratuit (jamais « off » par défaut de réseau)
    const r2 = await rig({ home, routes: {} })
    await r2.lic.refreshConfig()
    expect(r2.lic.plan()).toBe('free')
    on = false
    const r3 = await rig({ home, routes })
    await r3.lic.refreshConfig()
    expect(r3.lic.plan()).toBe('off')
  })

  it('jeton Pro : valide, puis hors ligne 7 jours de plus, puis gratuit', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    const tok = tokenFor(DEV_A, clock, 30)
    // jeton posé comme après un achat : via le parcours de restauration
    const net = fakeFetch({
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => ({ status: 200, body: { token: tok } }),
    })
    const r2 = await rig({ home: r.home, fetchImpl: net.f })
    expect(await r2.lic.restoreStart('zoe@example.com')).toEqual({ ok: true })
    expect(await r2.lic.restoreVerify('abcd-efgh-jkmn')).toEqual({ ok: true })
    expect(r2.lic.plan()).toBe('pro')
    expect(r2.events.map((e) => e.event)).toContain('pro_unlocked')
    expect(r2.events.find((e) => e.event === 'pro_unlocked')?.props).toEqual({ how: 'restore' })
    // la restauration envoie l'identifiant d'appareil lié à la machine, le code normalisé
    expect(net.calls[1]?.body).toMatchObject({ email: 'zoe@example.com', code: 'ABCDEFGHJKMN', challenge: 'ch', device: DEV_A })
    clock += 30 * DAY + 3 * DAY
    expect(r2.lic.plan()).toBe('pro')
    clock += 5 * DAY
    expect(r2.lic.plan()).toBe('free')
  })

  it('jeton forgé ou d’un autre appareil dans la config : ignoré', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    clock += 20 * DAY
    for (const bad of [tokenFor(DEV_A, clock, 30, OTHER_PRIV), tokenFor(deviceIdFrom(MACHINE_B), clock, 30)]) {
      const net = fakeFetch({
        'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
        'POST /api/license/restore/verify': () => ({ status: 200, body: { token: bad } }),
      })
      const r2 = await rig({ home: r.home, fetchImpl: net.f })
      await r2.lic.restoreStart('zoe@example.com')
      expect(await r2.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'error' })
      expect(r2.lic.plan()).toBe('free')
    }
  })
})

describe('état signé (anti-copie, anti-retouche)', () => {
  async function freeAt(home: string, mark: MarkStore, used: number) {
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    clock += 15 * DAY
    expect(r.lic.plan()).toBe('free')
    r.lic.countFiles(used)
    return r
  }

  it('config copiée sur un autre PC : jeton ignoré, essai terminé, compteur du jour au maximum, nouvel identifiant', async () => {
    const homeA = newHome()
    const r = await rig({ home: homeA })
    await r.lic.refreshConfig()
    const tok = tokenFor(DEV_A, clock, 30)
    const net = fakeFetch({
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => ({ status: 200, body: { token: tok } }),
    })
    const ra = await rig({ home: homeA, fetchImpl: net.f })
    await ra.lic.restoreStart('zoe@example.com')
    await ra.lic.restoreVerify('ABCDEFGHJKMN')
    expect(ra.lic.plan()).toBe('pro')
    // copie de ~/.flitdrop sur une autre machine
    const homeB = newHome()
    fs.copyFileSync(path.join(homeA, 'config.json'), path.join(homeB, 'config.json'))
    const rb = await rig({ home: homeB, machine: MACHINE_B, routes: {} })
    expect(rb.lic.deviceId).toBe(deviceIdFrom(MACHINE_B))
    expect(rb.cfg.licenseDeviceId).toBe(deviceIdFrom(MACHINE_B))
    expect(rb.cfg.licenseState?.token).toBe('')
    expect(rb.lic.plan()).toBe('free')
    expect(rb.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
    expect(rb.lic.canStartFile(0)).toBe(false)
    // le PC d'origine, lui, garde son Pro
    const back = await rig({ home: homeA, routes: {} })
    expect(back.lic.plan()).toBe('pro')
  })

  it('compteur retouché à la main : limite atteinte pour aujourd’hui, compteur neuf et valide le lendemain', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await freeAt(home, mark, 30)
    expect(r.lic.canStartFile(0)).toBe(false)
    const file = path.join(home, 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.licenseState.dailyFiles.count = 0
    fs.writeFileSync(file, JSON.stringify(raw))
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.plan()).toBe('free')
    expect(r2.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
    expect(r2.lic.canStartFile(0)).toBe(false)
    // les autres fonctions gratuites restent là
    expect(r2.lic.quota()?.left).toBe(0)
    clock += DAY
    expect(r2.lic.dailyUsed()).toBe(0)
    expect(r2.lic.canStartFile(0)).toBe(true)
    r2.lic.countFiles(1)
    const r3 = await rig({ home, mark, routes: {} })
    expect(r3.lic.dailyUsed()).toBe(1)
  })

  it('fin d’essai repoussée à la main : essai terminé', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    const file = path.join(home, 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.licenseState.trialEndsAt = '2099-01-01T00:00:00.000Z'
    fs.writeFileSync(file, JSON.stringify(raw))
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.plan()).toBe('free')
    // et ça ne revient pas en relançant
    const r3 = await rig({ home, mark, routes: { 'GET /api/license/config': () => configOn() } })
    await r3.lic.refreshConfig()
    expect(r3.lic.plan()).toBe('free')
  })

  it('config supprimée pendant l’essai : l’essai continue depuis sa vraie date (deuxième emplacement)', async () => {
    const mark = memMark()
    const home = newHome()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    await new Promise((res) => setTimeout(res, 0))
    const start = clock
    clock += 10 * DAY
    fs.rmSync(home, { recursive: true, force: true })
    // nouvelle installation : premier lancement maintenant, après le lancement du mode payant
    const fresh = await rig({ home: newHome(), mark, installedAt: new Date(clock).toISOString() })
    await fresh.lic.refreshConfig()
    expect(fresh.lic.plan()).toBe('trial')
    expect(fresh.lic.trialDaysLeft()).toBe(4)
    expect(fresh.cfg.licenseState?.trialStartAt).toBe(new Date(start).toISOString())
    clock += 5 * DAY
    expect(fresh.lic.plan()).toBe('free')
  })

  it('état retiré à la main de la config : essai depuis sa vraie date, compteur du jour au maximum', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await freeAt(home, mark, 3)
    await new Promise((res) => setTimeout(res, 0))
    const file = path.join(home, 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete raw.licenseState
    fs.writeFileSync(file, JSON.stringify(raw))
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.plan()).toBe('free')
    expect(r2.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
  })

  it('marque d’un autre PC ou fausse : ignorée', async () => {
    const mark = memMark('v1.1700000000000.' + '0'.repeat(32))
    const r = await rig({ mark })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.trialDaysLeft()).toBe(14)
  })

  it('identifiant de la machine illisible un lancement : rien n’est réécrit, Pro revient au lancement suivant', async () => {
    const home = newHome()
    const tok = tokenFor(DEV_A, clock, 30)
    const net = fakeFetch({
      'GET /api/license/config': () => configOn(),
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => ({ status: 200, body: { token: tok } }),
    })
    const r = await rig({ home, fetchImpl: net.f })
    await r.lic.refreshConfig()
    await r.lic.restoreStart('zoe@example.com')
    await r.lic.restoreVerify('ABCDEFGHJKMN')
    expect(r.lic.plan()).toBe('pro')
    const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8')
    const lost = await rig({ home, machine: null, routes: {} })
    expect(lost.lic.plan()).not.toBe('pro')
    lost.lic.countFiles(5)
    const after = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    expect(after.licenseState).toEqual(JSON.parse(before).licenseState)
    expect(after.licenseDeviceId).toBe(DEV_A)
    const ok = await rig({ home, routes: {} })
    expect(ok.lic.plan()).toBe('pro')
  })
})

describe('limite du jour', () => {
  it('29, 30, 31 ; fichiers commencés comptés ; minuit ; une seule statistique par jour', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    clock = Date.parse('2026-11-25T10:00:00.000Z')
    expect(r.lic.plan()).toBe('free')
    r.lic.countFiles(29)
    expect(r.lic.canStartFile(0)).toBe(true)
    // le 30e est commencé : un autre ne peut plus commencer
    expect(r.lic.canStartFile(1)).toBe(false)
    r.lic.countFiles(1)
    expect(r.lic.dailyUsed()).toBe(30)
    expect(r.lic.canStartFile(0)).toBe(false)
    // installation d'avant le lancement, dans les 30 jours : le téléphone
    // annonce le même prix de lancement que le PC
    expect(r.lic.limitBody()).toMatchObject({ error: 'daily_limit', limit: 30, left: 0, price: '2,99 €' })
    expect(r.lic.state().earlyPrice).toBe('2,99 €')
    clock = Date.parse('2026-12-02T10:00:00.000Z')
    expect(r.lic.limitBody().price).toBe('5,99 €')
    clock = Date.parse('2026-11-25T10:00:00.000Z')
    r.lic.noteRefused()
    r.lic.noteRefused()
    expect(r.events.filter((e) => e.event === 'daily_limit_reached')).toHaveLength(1)
    expect(r.lic.card()).toBe('limit')
    clock += DAY
    expect(r.lic.dailyUsed()).toBe(0)
    expect(r.lic.canStartFile(0)).toBe(true)
    expect(r.lic.quota()).toMatchObject({ limit: 30, used: 0, left: 30 })
    r.lic.countFiles(30)
    expect(r.events.filter((e) => e.event === 'daily_limit_reached')).toHaveLength(2)
  })

  it('essai et Pro : illimité, rien n’est compté', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    r.lic.countFiles(500)
    expect(r.lic.dailyUsed()).toBe(0)
    expect(r.lic.canStartFile(1000)).toBe(true)
    expect(r.lic.quota()).toBeNull()
  })
})

describe('cartes (au plus une invitation par jour)', () => {
  it('limite atteinte : montrée, comptée une fois, rangée par « Plus tard », pas le jour même', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    clock += 20 * DAY
    r.lic.countFiles(30)
    expect(r.lic.card()).toBe('limit')
    r.lic.promptSeen('limit')
    r.lic.promptSeen('limit')
    expect(r.events.filter((e) => e.event === 'pro_prompt_shown')).toEqual([{ event: 'pro_prompt_shown', props: { where: 'limit' } }])
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
    clock += DAY
    expect(r.lic.card()).toBeNull()
    r.lic.countFiles(30)
    expect(r.lic.card()).toBe('limit')
  })

  it('fin d’essai : 2 jours avant, une seule fois', async () => {
    const r = await rig()
    await r.lic.refreshConfig()
    clock += 11 * DAY
    expect(r.lic.card()).toBeNull()
    clock += 1 * DAY + 1000
    expect(r.lic.trialDaysLeft()).toBe(2)
    expect(r.lic.card()).toBe('trial')
    r.lic.promptSeen('trial')
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
    clock += DAY
    expect(r.lic.card()).toBeNull()
  })
})

describe('achat', () => {
  it('page d’achat : adresse avec claim, langue, offre de lancement ; attente ; vérification jusqu’au jeton', async () => {
    let paid = false
    const tok = tokenFor(DEV_A, clock, 30)
    const net = fakeFetch({
      'GET /api/license/config': () => configOn(),
      'POST /api/license/claim': () => (paid ? { status: 200, body: { token: tok } } : { status: 202, body: { pending: true } }),
    })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    expect(r.lic.state().earlyPrice).toBe('2,99 €')
    expect(r.lic.checkout('settings').ok).toBe(true)
    expect(r.opened[0]).toMatch(/^https:\/\/license\.test\/pro\?claim=[0-9a-f]{32}&lang=fr&early=1$/)
    expect(r.events.find((e) => e.event === 'pro_checkout_opened')?.props).toEqual({ where: 'settings', early: true })
    expect(r.lic.card()).toBe('waiting')
    expect(await r.lic.claim(false)).toBe('pending')
    // espacées : pas plus d'une vraie demande toutes les 4 s
    expect(await r.lic.claim(false)).toBe('pending')
    expect(net.calls.filter((c) => c.key === 'POST /api/license/claim')).toHaveLength(1)
    expect(net.calls[1]?.body).toEqual({ claim: r.opened[0]!.match(/claim=([0-9a-f]{32})/)![1], device: DEV_A })
    paid = true
    clock += 5000
    expect(await r.lic.claim(false)).toBe('unlocked')
    expect(r.lic.plan()).toBe('pro')
    expect(r.lic.card()).toBe('success')
    expect(r.events.find((e) => e.event === 'pro_unlocked')?.props).toEqual({ how: 'purchase' })
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
  })

  it('30 minutes au plus en automatique ; « J’ai payé » marche toujours', async () => {
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status: 202 }) })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    r.lic.checkout('limit')
    clock += 31 * 60_000
    expect(await r.lic.claim(false)).toBe('stopped')
    expect(r.lic.state().waiting?.polling).toBe(false)
    expect(await r.lic.claim(true)).toBe('pending')
    r.lic.cancelCheckout()
    expect(r.lic.card()).toBeNull()
    expect(r.cfg.licenseClaim).toBeNull()
  })

  it('achat déjà utilisé sur 5 ordinateurs : plus d’attente, la carte renvoie vers « J’ai déjà acheté »', async () => {
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status: 403, body: { error: 'claim_used' } }) })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    expect(await r.lic.claim(false)).toBe('used')
    expect(r.lic.card()).toBe('used')
    expect(await r.lic.claim(false)).toBe('none')
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
  })

  it('serveur saturé ou indisponible : rien ne change', async () => {
    let status = 503
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status, body: { error: 'unavailable' } }) })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    expect(await r.lic.claim(true)).toBe('pending')
    status = 429
    clock += 5000
    expect(await r.lic.claim(true)).toBe('pending')
    expect(r.lic.card()).toBe('waiting')
  })

  it('achat payé pendant que l’app était fermée : débloqué au lancement suivant (une vérification)', async () => {
    const home = newHome()
    const tok = tokenFor(DEV_A, clock, 30)
    const r = await rig({ home })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status: 200, body: { token: tok } }) })
    const r2 = await rig({ home, fetchImpl: net.f })
    r2.lic.start()
    for (let i = 0; i < 50 && r2.lic.plan() !== 'pro'; i++) await new Promise((res) => setTimeout(res, 10))
    expect(r2.lic.plan()).toBe('pro')
    expect(net.calls.filter((c) => c.key === 'POST /api/license/claim')).toHaveLength(1)
  })

  it('pas d’achat en mode payant coupé ni déjà Pro', async () => {
    const r = await rig({ routes: {} })
    expect(r.lic.checkout('settings').ok).toBe(false)
    expect(r.opened).toHaveLength(0)
  })
})

describe('restauration', () => {
  it('erreurs du serveur traduites en codes simples, réseau absent', async () => {
    let verify: { status: number; body?: unknown } | 'offline' = { status: 400, body: { error: 'code' } }
    const net = fakeFetch({
      'GET /api/license/config': () => configOn(),
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => verify,
    })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'nochallenge' })
    expect(await r.lic.restoreStart('pas-une-adresse')).toEqual({ error: 'email' })
    expect(await r.lic.restoreStart('zoe@example.com')).toEqual({ ok: true })
    expect(r.lic.state().restoreEmail).toBe('zoe@example.com')
    expect(await r.lic.restoreStart('zoe@example.com')).toEqual({ error: 'busy' })
    expect(await r.lic.restoreVerify('1234')).toEqual({ error: 'code' })
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'code' })
    verify = { status: 400, body: { error: 'expired' } }
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'expired' })
    verify = { status: 400, body: { error: 'nopurchase' } }
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'nopurchase' })
    verify = { status: 429, body: { error: 'too_many' } }
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'busy' })
    verify = 'offline'
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'offline' })
    expect(r.lic.plan()).toBe('trial')
  })
})

describe('renouvellement', () => {
  async function proRig(renew: () => { status: number; body?: unknown }) {
    const tok = tokenFor(DEV_A, clock, 30)
    const net = fakeFetch({
      'GET /api/license/config': () => configOn(),
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => ({ status: 200, body: { token: tok } }),
      'POST /api/license/renew': renew,
    })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    await r.lic.restoreStart('zoe@example.com')
    await r.lic.restoreVerify('ABCDEFGHJKMN')
    return { r, net, tok }
  }

  it('dans les 10 derniers jours, une fois par jour ; nouveau jeton gardé', async () => {
    let fresh = ''
    const { r, net } = await proRig(() => ({ status: 200, body: { token: fresh } }))
    await r.lic.maybeRenew()
    expect(net.calls.filter((c) => c.key === 'POST /api/license/renew')).toHaveLength(0)
    clock += 25 * DAY
    fresh = tokenFor(DEV_A, clock, 30)
    await r.lic.maybeRenew()
    await r.lic.maybeRenew()
    expect(net.calls.filter((c) => c.key === 'POST /api/license/renew')).toHaveLength(1)
    expect(r.cfg.licenseState?.token).toBe(fresh)
    // l'ancien jeton aurait cessé de valoir à J+37 ; le nouveau vaut encore
    clock += 30 * DAY
    expect(r.lic.plan()).toBe('pro')
  })

  it('révoqué (remboursé) : le jeton part ; serveur indisponible : jamais de retrait', async () => {
    let answer = { status: 503, body: { error: 'unavailable' } as unknown }
    const { r } = await proRig(() => answer)
    clock += 25 * DAY
    await r.lic.maybeRenew()
    expect(r.lic.plan()).toBe('pro')
    answer = { status: 403, body: { error: 'revoked' } }
    clock += DAY
    await r.lic.maybeRenew()
    expect(r.lic.plan()).toBe('free')
    expect(r.cfg.licenseState?.token).toBe('')
  })
})

describe('aucune minuterie à soi', () => {
  it('license.ts et machineid.ts ne lancent jamais setInterval', () => {
    for (const f of ['src/license.ts', 'src/machineid.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      expect(src, f).not.toMatch(/setInterval\s*\(/)
    }
  })
})
