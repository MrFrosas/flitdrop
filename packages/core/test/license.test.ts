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
  claimFromSecret,
  parseMark,
  FREE_DAILY_FILES,
  LICENSE_PUBLIC_KEY,
  SUPPORT_MAILTO,
  type TokenPayload,
} from '../src/license.js'
import { PAID_MODE_BUILD_DEFAULT } from '../src/license-key.js'
import { deviceIdFrom, plausibleId, readMachineIdentifier, fileMarkStore, registryMarkStore, MACHINE_READ_TIMEOUT_MS, type MarkStore } from '../src/machineid.js'

// Paire de clés DE TEST, propre aux tests (jamais la clé de production ni
// celle du bac à sable) : les tests passent toujours la clé publique
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
const tokenFor = (dev: string, iatMs: number, days = 30, key?: crypto.KeyObject, env: string | null = 'production') =>
  sign({ v: 1, ...(env === null ? {} : { env }), plan: 'pro', dev, cus: 'c'.repeat(32), iat: Math.floor(iatMs / 1000), exp: Math.floor(iatMs / 1000) + days * 86400 }, key)

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
  machine?: string | null | (() => Promise<string | null>)
  host?: string
  mark?: MarkStore
  routes?: Record<string, Route>
  installedAt?: string
  active?: boolean
  fetchImpl?: typeof fetch
  buildDefault?: boolean
  baseUrl?: string
  configUrl?: string
  tokenEnv?: 'production' | 'sandbox'
  retryMs?: number[]
  store?: boolean
  lastVersion?: string
} = {}): Promise<Rig> {
  const home = o.home ?? newHome()
  const cfg = loadConfig(home)
  if (o.installedAt !== undefined || !fs.existsSync(path.join(home, '.keep'))) {
    cfg.installedAt = o.installedAt ?? '2026-03-01T00:00:00.000Z'
    fs.writeFileSync(path.join(home, '.keep'), '')
  }
  if (o.lastVersion !== undefined) cfg.lastVersion = o.lastVersion
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
      baseUrl: o.baseUrl,
      configUrl: o.baseUrl ? o.configUrl : (o.configUrl ?? 'https://license.test/api/license/config'),
      fetchImpl: o.fetchImpl ?? fakeFetch(o.routes ?? { 'GET /api/license/config': () => configOn() }).f,
      now: () => clock,
      publicKey: TEST_PUB,
      tokenEnv: o.tokenEnv,
      systemLocale: 'fr-FR',
      machineId: typeof o.machine === 'function' ? o.machine : async () => (o.machine === undefined ? MACHINE_A : (o.machine as string | null)),
      hostFingerprint: () => o.host ?? 'host-a',
      machineRetryMs: o.retryMs ?? [],
      markStore: o.mark ?? memMark(),
      buildDefault: o.buildDefault ?? false,
      storeChannel: () => o.store === true,
    }
  )
  rigs.push(r.lic)
  await r.lic.ready
  return r
}
const rigs: License[] = []
afterEach(() => {
  for (const l of rigs) l.stop()
  rigs.length = 0
})

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
    expect(verifyToken(sign({ v: 1, env: 'production', plan: 'free', dev: DEV_A, cus: 'x', iat: 1, exp: 2 }), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
    expect(verifyToken(sign({ v: 2, env: 'production', plan: 'pro', dev: DEV_A, cus: 'x', iat: 1, exp: 2 }), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
  })
  it('autre appareil : refusé', () => {
    expect(verifyToken(tokenFor(deviceIdFrom(MACHINE_B), now), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'device' })
  })
  it('environnement : production attendu par défaut ; bac à sable ou sans env refusés', () => {
    expect(verifyToken(tokenFor(DEV_A, now), DEV_A, TEST_PUB).ok).toBe(true)
    expect(verifyToken(tokenFor(DEV_A, now, 30, undefined, 'sandbox'), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
    expect(verifyToken(tokenFor(DEV_A, now, 30, undefined, null), DEV_A, TEST_PUB)).toEqual({ ok: false, reason: 'payload' })
    expect(verifyToken(tokenFor(DEV_A, now, 30, undefined, 'staging'), DEV_A, TEST_PUB, 'sandbox')).toEqual({ ok: false, reason: 'payload' })
    // app de développement pointée sur le bac à sable : l'inverse
    expect(verifyToken(tokenFor(DEV_A, now, 30, undefined, 'sandbox'), DEV_A, TEST_PUB, 'sandbox').ok).toBe(true)
    expect(verifyToken(tokenFor(DEV_A, now), DEV_A, TEST_PUB, 'sandbox')).toEqual({ ok: false, reason: 'payload' })
  })
  it('l’app publiée embarque la clé de production', () => {
    expect(LICENSE_PUBLIC_KEY).toBe('TkGgVAzKlDgcwcU4bDpbeOE/mdjAe5260x+h4pOiXDc=')
    expect(Buffer.from(LICENSE_PUBLIC_KEY, 'base64')).toHaveLength(32)
    expect(PAID_MODE_BUILD_DEFAULT).toBe(false)
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
    expect(halfPrice('5,99 €')).toBe('3,00 €')
    expect(halfPrice('$5.99')).toBe('$3.00')
    expect(halfPrice('£5.49')).toBe('£2.75')
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
    expect(mark.v).toMatch(/^v2\.\d+\.\d+\.(\d{4}-\d{2}-\d{2}|0)\.\d+\.\d+\.[0-9a-f]{32}$/)
    expect(parseMark(DEV_A, mark.v)?.start).toBe(clock)
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
    const mark = memMark('v2.1700000000000.1700000000001.2026-11-05.30.1700000000000.' + '0'.repeat(32))
    const r = await rig({ mark })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.trialDaysLeft()).toBe(14)
  })

})

/** Attend qu'une condition devienne vraie (nouvelles lectures en arrière-plan). */
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise((res) => setTimeout(res, 5))
}

/** PC « A » débloqué en Pro (par la restauration), sur ce dossier et cette marque. */
async function proUnlocked(home: string, mark: MarkStore, extra: Record<string, Route> = {}) {
  const tok = tokenFor(DEV_A, clock, 30)
  const net = fakeFetch({
    'GET /api/license/config': () => configOn(),
    'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
    'POST /api/license/restore/verify': () => ({ status: 200, body: { token: tok } }),
    ...extra,
  })
  const r = await rig({ home, mark, fetchImpl: net.f })
  await r.lic.refreshConfig()
  await r.lic.restoreStart('zoe@example.com')
  await r.lic.restoreVerify('ABCDEFGHJKMN')
  expect(r.lic.plan()).toBe('pro')
  await new Promise((res) => setTimeout(res, 0))
  return { r, tok, net }
}

describe('identifiant de la machine illisible un lancement (pas une copie)', () => {
  it('client Pro : reste Pro avec son identité gardée ; pas de renouvellement tant que ce n’est pas relu', async () => {
    const home = newHome()
    const mark = memMark()
    await proUnlocked(home, mark)
    const renew = fakeFetch({ 'POST /api/license/renew': () => ({ status: 200, body: { token: tokenFor(DEV_A, clock, 30) } }) })
    const lost = await rig({ home, mark, machine: null, fetchImpl: renew.f })
    expect(lost.lic.plan()).toBe('pro')
    expect(lost.lic.deviceId).toBe(DEV_A)
    expect(lost.lic.dailyLeft()).toBe(Infinity)
    expect(lost.cfg.licenseDeviceId).toBe(DEV_A)
    clock += 25 * DAY
    await lost.lic.maybeRenew()
    expect(renew.calls).toHaveLength(0)
    expect(lost.lic.plan()).toBe('pro')
    // relu au lancement suivant : tout redevient normal, renouvellement compris
    clock -= 25 * DAY
    const ok = await rig({ home, mark, routes: {} })
    expect(ok.lic.plan()).toBe('pro')
    expect(ok.cfg.licenseState?.mac).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gratuit : garde ses 30 fichiers, le compteur continue et revient intact', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    clock += 15 * DAY
    r.lic.countFiles(3)
    const lost = await rig({ home, mark, machine: null, routes: {} })
    expect(lost.lic.plan()).toBe('free')
    expect(lost.lic.dailyUsed()).toBe(3)
    expect(lost.lic.canStartFile(0)).toBe(true)
    lost.lic.countFiles(2)
    expect(lost.lic.dailyUsed()).toBe(5)
    const ok = await rig({ home, mark, routes: {} })
    expect(ok.lic.plan()).toBe('free')
    expect(ok.lic.dailyUsed()).toBe(5)
  })

  it('relu en arrière-plan quelques secondes après : identique, tout redevient normal', async () => {
    const home = newHome()
    const mark = memMark()
    await proUnlocked(home, mark)
    let reads = 0
    const lost = await rig({ home, mark, machine: async () => (reads++ === 0 ? null : MACHINE_A), retryMs: [5, 5], routes: {} })
    expect(lost.lic.plan()).toBe('pro')
    expect(lost.cfg.licenseState?.mac).toBe('')
    await until(() => lost.cfg.licenseState?.mac !== '')
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(lost.cfg.licenseState?.mac).toMatch(/^[0-9a-f]{64}$/)
    expect(lost.lic.plan()).toBe('pro')
    expect(lost.lic.deviceId).toBe(DEV_A)
  })

  it('relu DIFFÉRENT plus tard : c’est une copie, les limites se ferment à ce moment', async () => {
    const home = newHome()
    const mark = memMark()
    await proUnlocked(home, mark)
    let reads = 0
    const lost = await rig({ home, mark, machine: async () => (reads++ === 0 ? null : MACHINE_B), retryMs: [5], routes: {} })
    expect(lost.lic.plan()).toBe('pro')
    await until(() => lost.lic.deviceId !== DEV_A)
    expect(lost.lic.deviceId).toBe(deviceIdFrom(MACHINE_B))
    expect(lost.cfg.licenseDeviceId).toBe(deviceIdFrom(MACHINE_B))
    expect(lost.lic.plan()).toBe('free')
    expect(lost.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
    expect(lost.changes).toBeGreaterThan(0)
  })

  it('config copiée chez un autre compte ou un autre PC, identifiant illisible : rien de vérifiable, limites fermées, rien réécrit', async () => {
    const homeA = newHome()
    await proUnlocked(homeA, memMark())
    const homeB = newHome()
    fs.copyFileSync(path.join(homeA, 'config.json'), path.join(homeB, 'config.json'))
    const before = fs.readFileSync(path.join(homeB, 'config.json'), 'utf8')
    const rb = await rig({ home: homeB, machine: null, host: 'host-b', routes: {} })
    expect(rb.lic.plan()).toBe('free')
    expect(rb.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
    expect(rb.lic.canStartFile(0)).toBe(false)
    expect(rb.lic.checkout('settings').ok).toBe(false)
    rb.lic.countFiles(5)
    const after = JSON.parse(fs.readFileSync(path.join(homeB, 'config.json'), 'utf8'))
    expect(after.licenseState).toEqual(JSON.parse(before).licenseState)
  })

  it('lecture lente tolérée (8 s) ; marque absente et marque illisible distinguées', async () => {
    let timeout = 0
    const id = await readMachineIdentifier({
      platform: 'darwin',
      exec: async (_f, _a, ms) => {
        timeout = ms
        return '"IOPlatformUUID" = "4C4C4544-0042-3510-8051-B4C04F4E4A32"'
      },
    })
    expect(id).toBe(MACHINE_A)
    expect(timeout).toBe(MACHINE_READ_TIMEOUT_MS)
    expect(MACHINE_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(8000)
    // reg.exe : code 1 = valeur absente ; délai dépassé = illisible ce lancement
    expect(await registryMarkStore(async () => Promise.reject(Object.assign(new Error('absent'), { code: 1 }))).read()).toBeNull()
    await expect(registryMarkStore(async () => Promise.reject(Object.assign(new Error('lent'), { code: null, killed: true }))).read()).rejects.toThrow()
    // fichier : absent = null ; un dossier à sa place = illisible
    const dir = newHome()
    expect(await fileMarkStore(path.join(dir, 'absent', '.t')).read()).toBeNull()
    await expect(fileMarkStore(dir).read()).rejects.toThrow()
  })

  it('marque illisible ce lancement : rien n’y est écrit (un compteur plus haut n’est jamais écrasé)', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    clock += 15 * DAY
    r.lic.countFiles(20)
    await new Promise((res) => setTimeout(res, 0))
    const saved = mark.v
    const flaky: MarkStore = { read: async () => Promise.reject(new Error('lent')), write: mark.write }
    const r2 = await rig({ home, mark: flaky, routes: {} })
    r2.lic.countFiles(1)
    await new Promise((res) => setTimeout(res, 0))
    expect(mark.v).toBe(saved)
    expect(r2.lic.dailyUsed()).toBe(21)
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
    expect(r.lic.limitBody()).toMatchObject({ error: 'daily_limit', limit: 30, left: 0, price: '3,00 €' })
    expect(r.lic.state().earlyPrice).toBe('3,00 €')
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
    expect(r.lic.state().earlyPrice).toBe('3,00 €')
    expect(r.lic.checkout('settings').ok).toBe(true)
    expect(r.opened[0]).toMatch(/^https:\/\/license\.test\/pro\?claim=[0-9a-f]{32}&lang=fr&early=1$/)
    expect(r.events.find((e) => e.event === 'pro_checkout_opened')?.props).toEqual({ where: 'settings', early: true })
    expect(r.lic.card()).toBe('waiting')
    expect(await r.lic.claim(false)).toBe('pending')
    // espacées : pas plus d'une vraie demande toutes les 4 s
    expect(await r.lic.claim(false)).toBe('pending')
    expect(net.calls.filter((c) => c.key === 'POST /api/license/claim')).toHaveLength(1)
    // le serveur reçoit le SECRET (jamais le claim), le claim de l'adresse en
    // est l'empreinte ; le secret n'est nulle part dans l'adresse
    const sent = net.calls[1]?.body as { secret: string; device: string }
    expect(Object.keys(sent).sort()).toEqual(['device', 'secret'])
    expect(sent.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(sent.device).toBe(DEV_A)
    expect(claimFromSecret(sent.secret)).toBe(r.opened[0]!.match(/claim=([0-9a-f]{32})/)![1])
    expect(r.opened[0]).not.toContain(sent.secret)
    // gardé dans l'état signé tant que l'achat est en attente, jamais dans les statistiques
    expect(r.cfg.licenseState?.claimSecret).toBe(sent.secret)
    expect(JSON.stringify(r.events)).not.toContain(sent.secret)
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
    expect(r.cfg.licenseState?.claimSecret).toBe('')
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
  async function proRig(renew: () => { status: number; body?: unknown } | 'offline') {
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

  it('hors ligne, 429, 5xx, 403 sans « revoked », réponse illisible ou jeton refusé : jamais de retrait ; renouvelé dès que ça répond', async () => {
    const answers: ({ status: number; body?: unknown } | 'offline')[] = [
      'offline',
      { status: 429, body: { error: 'too_many' } },
      { status: 500 },
      { status: 502, body: 'x' },
      { status: 503, body: { error: 'unavailable' } },
      { status: 403, body: { error: 'too_many_devices' } },
      { status: 403, body: {} },
      { status: 200, body: { token: 'pas-un-jeton' } },
      { status: 200, body: { token: tokenFor(DEV_A, clock, 30, undefined, 'sandbox') } },
    ]
    let answer: { status: number; body?: unknown } | 'offline' = 'offline'
    const { r, tok } = await proRig(() => answer as { status: number; body?: unknown })
    clock += 25 * DAY
    for (const a of answers) {
      answer = a
      clock += DAY
      await r.lic.maybeRenew()
      expect(r.lic.plan(), JSON.stringify(a)).toBe('pro')
      expect(r.cfg.licenseState?.token).toBe(tok)
    }
    // encore valable jusqu'à exp + 7 jours, sans réseau
    expect(r.lic.plan()).toBe('pro')
    // le serveur répond de nouveau : renouvelé
    const fresh = tokenFor(DEV_A, clock, 30)
    answer = { status: 200, body: { token: fresh } }
    clock += DAY
    await r.lic.maybeRenew()
    expect(r.cfg.licenseState?.token).toBe(fresh)
    expect(r.lic.plan()).toBe('pro')
  })
})

/** Gratuit (essai fini) sur ce dossier et cette marque. */
async function freeRig(home: string, mark: MarkStore) {
  const r = await rig({ home, mark })
  await r.lic.refreshConfig()
  clock += 15 * DAY
  expect(r.lic.plan()).toBe('free')
  await new Promise((res) => setTimeout(res, 0))
  return r
}
const configFile = (home: string) => path.join(home, 'config.json')

describe('deuxième emplacement : rien ne revient en arrière', () => {
  it('ancienne copie de config.json remise le même jour : le compteur ne redescend pas', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await freeRig(home, mark)
    expect(r.lic.dailyUsed()).toBe(0)
    const backup = fs.readFileSync(configFile(home), 'utf8')
    for (let i = 0; i < 30; i++) r.lic.countFiles(1)
    expect(r.lic.canStartFile(0)).toBe(false)
    await new Promise((res) => setTimeout(res, 0))
    fs.writeFileSync(configFile(home), backup)
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.plan()).toBe('free')
    expect(r2.lic.dailyUsed()).toBe(30)
    expect(r2.lic.canStartFile(0)).toBe(false)
    // la config est remise à jour avec le compteur de la marque
    expect(JSON.parse(fs.readFileSync(configFile(home), 'utf8')).licenseState.dailyFiles.count).toBe(30)
    // le lendemain : compteur neuf, comme toujours
    clock += DAY
    expect(r2.lic.dailyUsed()).toBe(0)
  })

  it('marque écrite dès chaque fichier compté (fichier sur le disque, sans attendre)', async () => {
    const home = newHome()
    const markFile = path.join(newHome(), 'data', '.t')
    const store = fileMarkStore(markFile)
    const r = await freeRig(home, store)
    r.lic.countFiles(1)
    expect(parseMark(DEV_A, fs.readFileSync(markFile, 'utf8'))?.count).toBe(1)
    r.lic.countFiles(1)
    expect(parseMark(DEV_A, fs.readFileSync(markFile, 'utf8'))?.count).toBe(2)
  })

  it('marque effacée et ancienne config remise : limites fermées jusqu’à minuit seulement', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await freeRig(home, mark)
    const backup = fs.readFileSync(configFile(home), 'utf8')
    r.lic.countFiles(30)
    fs.writeFileSync(configFile(home), backup)
    mark.v = null
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
    expect(r2.lic.canStartFile(0)).toBe(false)
    clock += DAY
    expect(r2.lic.canStartFile(0)).toBe(true)
    // marque abîmée : pareil
    const r3 = await freeRig(newHome(), memMark())
    r3.lic.countFiles(1)
    const m3 = memMark('v2.abc')
    const r4 = await rig({ home: r3.home, mark: m3, routes: {} })
    expect(r4.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
  })

  it('premier lancement sans marque (installation neuve) : rien de fermé', async () => {
    const r = await rig({ mark: memMark(null) })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    clock += 15 * DAY
    expect(r.lic.dailyUsed()).toBe(0)
  })

  it('essai terminé (retouche) : une ancienne copie de la config ne le fait pas revenir', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.lic.plan()).toBe('trial')
    const backup = fs.readFileSync(configFile(home), 'utf8')
    const raw = JSON.parse(backup)
    raw.licenseState.trialEndsAt = '2099-01-01T00:00:00.000Z'
    fs.writeFileSync(configFile(home), JSON.stringify(raw))
    const tampered = await rig({ home, mark, routes: {} })
    expect(tampered.lic.plan()).toBe('free')
    await new Promise((res) => setTimeout(res, 0))
    fs.writeFileSync(configFile(home), backup)
    const restored = await rig({ home, mark, routes: {} })
    expect(restored.lic.plan()).toBe('free')
  })

  it('mode payant coupé : rien n’est écrit au deuxième emplacement', async () => {
    const mark = memMark()
    const r = await rig({ mark, routes: { 'GET /api/license/config': () => configOn({ enabled: false }) } })
    await r.lic.refreshConfig()
    r.lic.countFiles(5)
    r.lic.tick()
    clock += 2 * 3_600_000
    r.lic.tick()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.lic.plan()).toBe('off')
    expect(mark.v).toBeNull()
  })
})

describe('horloge', () => {
  it('un jour en avant : compteur neuf (accepté) ; puis retour en arrière : jamais un deuxième jour neuf', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await freeRig(home, mark)
    r.lic.countFiles(30)
    expect(r.lic.canStartFile(0)).toBe(false)
    clock += DAY
    expect(r.lic.dailyUsed()).toBe(0)
    r.lic.countFiles(30)
    clock -= DAY
    expect(r.lic.dailyUsed()).toBe(30)
    expect(r.lic.canStartFile(0)).toBe(false)
    clock -= 5 * DAY
    expect(r.lic.canStartFile(0)).toBe(false)
    // relancé, horloge toujours en arrière : pareil (marque et config)
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.dailyUsed()).toBe(30)
    // le vrai calendrier dépasse le jour le plus tardif vu : compteur neuf
    clock += 7 * DAY
    expect(r2.lic.dailyUsed()).toBe(0)
    expect(r2.lic.canStartFile(0)).toBe(true)
  })

  it('horloge reculée sans rien compter en avance : le reste du jour, pas plus', async () => {
    const r = await freeRig(newHome(), memMark())
    r.lic.countFiles(12)
    clock -= 3 * DAY
    expect(r.lic.dailyUsed()).toBe(12)
    expect(r.lic.dailyLeft()).toBe(18)
    r.lic.countFiles(18)
    expect(r.lic.canStartFile(0)).toBe(false)
  })

  it('horloge retenue en arrière : l’essai finit quand l’heure la plus tardive vue dépasse sa fin', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    clock += 14 * DAY + 2 * 3_600_000
    r.lic.tick()
    expect(r.lic.plan()).toBe('free')
    await new Promise((res) => setTimeout(res, 0))
    clock -= 10 * DAY
    expect(r.lic.plan()).toBe('free')
    const r2 = await rig({ home, mark, routes: {} })
    expect(r2.lic.plan()).toBe('free')
    // même avec une config d'avant (l'heure vue est aussi dans la marque)
    const raw = JSON.parse(fs.readFileSync(configFile(home), 'utf8'))
    raw.licenseState.seenAt = ''
    fs.writeFileSync(configFile(home), JSON.stringify(raw))
    const r3 = await rig({ home, mark, routes: {} })
    expect(r3.lic.plan()).toBe('free')
  })

  it('date donnée par flitdrop.com : l’essai ne dure pas plus que le vrai calendrier', async () => {
    let serverNow = clock
    const f = (async () =>
      new Response(JSON.stringify(configOn().body), { status: 200, headers: { date: new Date(serverNow).toUTCString() } })) as unknown as typeof fetch
    const r = await rig({ fetchImpl: f })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('trial')
    // l'horloge du PC est retenue, flitdrop.com donne la vraie date
    serverNow = clock + 15 * DAY
    clock += 2 * DAY
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('free')
  })
})

describe('prix de lancement donnés par le serveur', () => {
  it('displayPriceEarly : affiché tel quel, jamais recalculé', async () => {
    const r = await rig({ routes: { 'GET /api/license/config': () => configOn({ displayPriceEarly: { EUR: '2,49 €', USD: '$2.49' } }) } })
    await r.lic.refreshConfig()
    expect(r.lic.state().earlyPrice).toBe('2,49 €')
    expect(r.lic.effectivePrice()).toBe('2,49 €')
    // pas de prix de lancement pour cette devise : aucun prix inventé
    const r2 = await rig({ routes: { 'GET /api/license/config': () => configOn({ displayPriceEarly: { USD: '$2.99' } }) } })
    await r2.lic.refreshConfig()
    expect(r2.lic.state().earlyPrice).toBeUndefined()
    expect(r2.lic.effectivePrice()).toBe('5,99 €')
    // aucun prix de lancement donné : moitié du prix affiché, comme avant
    const r3 = await rig()
    await r3.lic.refreshConfig()
    expect(r3.lic.state().earlyPrice).toBe('3,00 €')
  })
})

describe('trop d’ordinateurs, serveur indisponible', () => {
  it('achat : 403 too_many_devices, plus d’attente, carte calme avec le support, plan inchangé', async () => {
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status: 403, body: { error: 'too_many_devices' } }) })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    expect(await r.lic.claim(false)).toBe('devices')
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.card()).toBe('devices')
    expect(r.lic.state().waiting).toBeNull()
    expect(r.cfg.licenseState?.claimSecret).toBe('')
    // plus aucune vérification
    clock += 10_000
    expect(await r.lic.claim(false)).toBe('none')
    expect(net.calls.filter((c) => c.key === 'POST /api/license/claim')).toHaveLength(1)
    r.lic.contactSupport()
    expect(r.opened.at(-1)).toBe(SUPPORT_MAILTO)
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
  })

  it('restauration : 403 too_many_devices dit simplement, plan inchangé ; 503 : rien ne change', async () => {
    let verify: { status: number; body?: unknown } = { status: 403, body: { error: 'too_many_devices' } }
    const net = fakeFetch({
      'GET /api/license/config': () => configOn(),
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => verify,
    })
    const r = await rig({ fetchImpl: net.f })
    await r.lic.refreshConfig()
    await r.lic.restoreStart('zoe@example.com')
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'devices' })
    expect(r.lic.plan()).toBe('trial')
    verify = { status: 503, body: { error: 'unavailable' } }
    expect(await r.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'error' })
    expect(r.lic.plan()).toBe('trial')
  })

  it('achat payé pendant que l’app était fermée : la vérification au lancement envoie le secret gardé', async () => {
    const home = newHome()
    const r = await rig({ home })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    const secret = r.cfg.licenseState!.claimSecret
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const net = fakeFetch({ 'GET /api/license/config': () => configOn(), 'POST /api/license/claim': () => ({ status: 403, body: { error: 'too_many_devices' } }) })
    const r2 = await rig({ home, fetchImpl: net.f })
    r2.lic.start()
    await until(() => r2.lic.card() === 'devices')
    expect(net.calls.find((c) => c.key === 'POST /api/license/claim')?.body).toEqual({ secret, device: DEV_A })
    expect(r2.lic.plan()).toBe('trial')
  })
})

describe('racine des licences', () => {
  it('une seule racine pour la config, les achats et la page /pro', async () => {
    const urls: string[] = []
    const f = (async (u: string | URL, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${String(u)}`)
      if (String(u).endsWith('/api/license/config')) return new Response(JSON.stringify(configOn().body), { status: 200 })
      return new Response('{"pending":true}', { status: 202 })
    }) as unknown as typeof fetch
    const r = await rig({ baseUrl: 'https://preview.flitdrop.test', fetchImpl: f })
    await r.lic.refreshConfig()
    r.lic.checkout('settings')
    await r.lic.claim(true)
    await r.lic.restoreStart('zoe@example.com')
    expect(urls).toEqual([
      'GET https://preview.flitdrop.test/api/license/config',
      'POST https://preview.flitdrop.test/api/license/claim',
      'POST https://preview.flitdrop.test/api/license/restore/start',
    ])
    expect(r.opened[0]).toMatch(/^https:\/\/preview\.flitdrop\.test\/pro\?claim=[0-9a-f]{32}&lang=fr&early=1$/)
  })

  it('jetons du bac à sable seulement si l’app attend le bac à sable', async () => {
    const sandboxTok = tokenFor(DEV_A, clock, 30, undefined, 'sandbox')
    const routes = {
      'GET /api/license/config': () => configOn(),
      'POST /api/license/restore/start': () => ({ status: 200, body: { challenge: 'ch' } }),
      'POST /api/license/restore/verify': () => ({ status: 200, body: { token: sandboxTok } }),
    }
    const prod = await rig({ routes })
    await prod.lic.refreshConfig()
    await prod.lic.restoreStart('zoe@example.com')
    expect(await prod.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ error: 'error' })
    expect(prod.lic.plan()).toBe('trial')
    const sandbox = await rig({ routes, tokenEnv: 'sandbox' })
    await sandbox.lic.refreshConfig()
    await sandbox.lic.restoreStart('zoe@example.com')
    expect(await sandbox.lic.restoreVerify('ABCDEFGHJKMN')).toEqual({ ok: true })
    expect(sandbox.lic.plan()).toBe('pro')
  })
})

describe('Microsoft Store', () => {
  it('gratuit comme avant (« off ») tant que le serveur ne dit pas storeEnabled ; ensuite l’essai commence', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark, store: true })
    await r.lic.refreshConfig()
    expect(r.lic.plan()).toBe('off')
    expect(r.lic.card()).toBeNull()
    expect(r.lic.state()).toEqual({ plan: 'off' })
    expect(r.cfg.licenseState?.trialStartAt).toBe('')
    r.lic.countFiles(50)
    expect(r.lic.canStartFile(100)).toBe(true)
    expect(r.lic.fullFeatures()).toBe(true)
    await new Promise((res) => setTimeout(res, 0))
    expect(mark.v).toBeNull()
    // relancé hors ligne : toujours « off »
    const offline = await rig({ home, mark, store: true, routes: {} })
    expect(offline.lic.plan()).toBe('off')
    // même avec le mode payant par défaut d'une version publiée après le lancement
    const built = await rig({ store: true, routes: {}, buildDefault: true })
    expect(built.lic.plan()).toBe('off')
    // le serveur l'allume pour le Store : essai, comme ailleurs
    const on = await rig({ home, mark, store: true, routes: { 'GET /api/license/config': () => configOn({ storeEnabled: true }) } })
    await on.lic.refreshConfig()
    expect(on.lic.plan()).toBe('trial')
    expect(on.cfg.licenseState?.trialStartAt).toBe(new Date(clock).toISOString())
    // autre canal : storeEnabled n'y change rien
    const nsis = await rig()
    await nsis.lic.refreshConfig()
    expect(nsis.lic.plan()).toBe('trial')
  })
})

describe('installations d’avant Flitdrop Pro (legacy)', () => {
  it('version < 0.7.0 au premier lancement : notée une fois ; presse-papiers complet gratuit, limite du jour et dossiers par mois comme tout le monde', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark, lastVersion: '0.6.7' })
    await r.lic.refreshConfig()
    expect(r.cfg.licenseState?.legacy).toBe(true)
    expect(r.lic.plan()).toBe('trial')
    expect(r.lic.state().legacy).toBe(true)
    clock += 15 * DAY
    expect(r.lic.plan()).toBe('free')
    expect(r.lic.fullFeatures()).toBe(true)
    expect(r.lic.monthFolders()).toBe(false)
    expect(r.lic.limited()).toBe(true)
    r.lic.countFiles(30)
    expect(r.lic.canStartFile(0)).toBe(false)
    // la version notée ensuite ne change rien : décidé une fois
    const later = await rig({ home, mark, lastVersion: '0.7.0', routes: {} })
    expect(later.lic.fullFeatures()).toBe(true)
  })

  it('installation neuve ou config de 0.7.0 : le partage Pro d’aujourd’hui ; « unknown » (config très ancienne) : legacy', async () => {
    for (const [v, legacy] of [['', false], ['0.7.0', false], ['1.0.0', false], ['0.6.9', true], ['0.5.12', true], ['unknown', true]] as const) {
      const r = await rig({ lastVersion: v })
      await r.lic.refreshConfig()
      clock += 15 * DAY
      expect(r.lic.fullFeatures(), v).toBe(legacy)
      clock -= 15 * DAY
    }
  })

  it('legacy posé à la main dans la config : empreinte fausse, rien de gagné', async () => {
    const home = newHome()
    const mark = memMark()
    const r = await rig({ home, mark, lastVersion: '' })
    await r.lic.refreshConfig()
    clock += 15 * DAY
    const raw = JSON.parse(fs.readFileSync(configFile(home), 'utf8'))
    raw.licenseState.legacy = true
    fs.writeFileSync(configFile(home), JSON.stringify(raw))
    const r2 = await rig({ home, mark, lastVersion: '0.7.0', routes: {} })
    expect(r2.lic.fullFeatures()).toBe(false)
    expect(r2.lic.dailyUsed()).toBe(FREE_DAILY_FILES)
  })

  it('carte d’accueil pendant l’essai, une seule fois, sans statistique d’invitation', async () => {
    const r = await rig({ lastVersion: '0.6.7' })
    await r.lic.refreshConfig()
    expect(r.lic.card()).toBe('welcome')
    r.lic.promptSeen('welcome')
    expect(r.lic.card()).toBe('welcome')
    expect(r.events.filter((e) => e.event === 'pro_prompt_shown')).toHaveLength(0)
    r.lic.closeCard()
    expect(r.lic.card()).toBeNull()
    clock += DAY
    expect(r.lic.card()).toBeNull()
    // installation neuve : pas de carte d'accueil
    const fresh = await rig({ lastVersion: '' })
    await fresh.lic.refreshConfig()
    expect(fresh.lic.card()).toBeNull()
  })
})

describe('prix du pays de la personne', () => {
  it('price { currency, display, displayEarly } : utilisé partout, avant displayPrice et le calcul', async () => {
    const local = { currency: 'CHF', display: 'CHF 5.90', displayEarly: 'CHF 2.95' }
    const r = await rig({ routes: { 'GET /api/license/config': () => configOn({ price: local, displayPriceEarly: { EUR: '2,49 €' } }) } })
    await r.lic.refreshConfig()
    expect(r.lic.price()).toBe('CHF 5.90')
    expect(r.lic.state()).toMatchObject({ price: 'CHF 5.90', earlyPrice: 'CHF 2.95' })
    clock += 15 * DAY
    expect(r.lic.limitBody().price).toBe('CHF 2.95')
    expect(r.lic.quota()?.price).toBe('CHF 2.95')
    // sans prix de lancement local : displayPriceEarly de cette devise, sinon rien d'inventé
    const r2 = await rig({ routes: { 'GET /api/license/config': () => configOn({ price: { currency: 'CHF', display: 'CHF 5.90' }, displayPriceEarly: { EUR: '2,49 €' } }) } })
    await r2.lic.refreshConfig()
    expect(r2.lic.effectivePrice()).toBe('CHF 5.90')
    expect(r2.lic.state().earlyPrice).toBeUndefined()
    // aucun prix de lancement du tout : moitié du prix local (calcul d'avant)
    const r3 = await rig({ routes: { 'GET /api/license/config': () => configOn({ price: { currency: 'CAD', display: 'CA$8.49' } }) } })
    await r3.lic.refreshConfig()
    expect(r3.lic.effectivePrice()).toBe('CA$4.25')
    // forme fausse : ignorée
    const r4 = await rig({ routes: { 'GET /api/license/config': () => configOn({ price: { currency: 'chf', display: '<b>x</b>' } }) } })
    await r4.lic.refreshConfig()
    expect(r4.lic.price()).toBe('5,99 €')
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
