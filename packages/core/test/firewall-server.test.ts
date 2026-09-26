import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { EVENTS, type Envelope } from '../src/telemetry.js'
import type { FirewallStatus, RepairResult } from '../src/firewall.js'
import { localIPv4s } from '../src/util.js'
import { addVisibleMs, firewallCheckDue } from '../src/webclient/onboarding.js'
import { FIREWALL_CHECK_AFTER_MS } from '../src/constants.js'

// Pare-feu de Windows côté serveur : vérification automatique une seule fois
// par ouverture de la fenêtre d'appairage (QR visible 45 s, aucun téléphone),
// réparation seulement sur « Réparer », carte effacée dès qu'un téléphone
// arrive, statistiques anonymes du niveau de base.

const homes: string[] = []
function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-fw-'))
  homes.push(h)
  return h
}

type FwState = {
  checking: boolean
  repairing: boolean
  problem: 'public' | 'rule' | null
  network: string | null
  blocker: 'blockAll' | 'managed' | null
  noRule: boolean
  publicToo: boolean
  repair: RepairResult | null
  fixed: boolean
} | null

interface Harness {
  srv: RunningServer
  admin: (p: string, body?: unknown) => Promise<Response>
  fw: () => Promise<FwState>
  checks: Array<string | undefined>
  repairs: number
  repairStatuses: FirewallStatus[]
  nextCheck: Array<FirewallStatus | null>
  nextRepair: RepairResult
  sent: Envelope[]
  settle: () => Promise<void>
}

const PUBLIC_BLOCKED: FirewallStatus = { network: 'public', blocked: true, allowed: false, problem: 'public', profiles: 4, noRule: false, blocker: null }
const FINE: FirewallStatus = { network: 'public', blocked: false, allowed: true, problem: null, profiles: 4, noRule: false, blocker: null }

async function harness(o: { firewall?: boolean; afterMs?: number } = {}): Promise<Harness> {
  const h = {
    checks: [] as Array<string | undefined>,
    repairs: 0,
    repairStatuses: [] as FirewallStatus[],
    nextCheck: [] as Array<FirewallStatus | null>,
    nextRepair: 'ok' as RepairResult,
    sent: [] as Envelope[],
  } as Harness
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    h.sent.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  h.srv = await startServer({
    port: 0,
    home: tmpHome(),
    disableClipboard: true,
    quiet: true,
    telemetry: { version: '0.7.0', channel: 'nsis', fetchImpl, disabled: false, tickMs: 3_600_000 },
    firewall:
      o.firewall === false
        ? undefined
        : {
            check: async (ip) => {
              h.checks.push(ip)
              return h.nextCheck.length ? (h.nextCheck.shift() ?? null) : PUBLIC_BLOCKED
            },
            repair: async (st) => {
              h.repairs++
              h.repairStatuses.push(st)
              return h.nextRepair
            },
            afterMs: o.afterMs ?? 0,
          },
  })
  const base = `http://127.0.0.1:${h.srv.port}`
  h.admin = (p, body) =>
    fetch(base + '/api/admin' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-admin-token': h.srv.adminToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  h.fw = async () => ((await (await h.admin('/state')).json()) as { firewall: FwState }).firewall
  h.settle = async () => {
    await new Promise((r) => setTimeout(r, 40))
    await h.srv.telemetry.flush()
  }
  // l'annonce des statistiques de base a été vue
  await h.admin('/telemetry/notice', {})
  await h.settle()
  return h
}

const running: Harness[] = []
afterAll(async () => {
  for (const h of running.splice(0)) await h.srv.close()
  for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
async function open(o?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(o)
  running.push(h)
  return h
}
const events = (h: Harness, name: string) => h.sent.filter((e) => e.event === name)
const started = async (r: Response) => ((await r.json()) as { started?: boolean }).started

describe('pare-feu : page du PC (règles pures)', () => {
  it('une seule vérification par ouverture, après 45 s de QR visible, sans téléphone appairé', () => {
    expect(FIREWALL_CHECK_AFTER_MS).toBe(45_000)
    const base = { visibleMs: 45_000, asked: false, paired: false, available: true, afterMs: FIREWALL_CHECK_AFTER_MS }
    expect(firewallCheckDue(base)).toBe(true)
    expect(firewallCheckDue({ ...base, visibleMs: 44_999 })).toBe(false)
    expect(firewallCheckDue({ ...base, asked: true })).toBe(false)
    expect(firewallCheckDue({ ...base, paired: true })).toBe(false)
    // Mac, Linux, ligne de commande : pas de vérification possible
    expect(firewallCheckDue({ ...base, available: false })).toBe(false)
  })

  it('temps visible : compté battement par battement, un long trou compte pour 2 s', () => {
    expect(addVisibleMs(0, 0, 1000)).toBe(0)
    expect(addVisibleMs(0, 1000, 2000)).toBe(1000)
    expect(addVisibleMs(5000, 1000, 1_000_000)).toBe(7000)
    expect(addVisibleMs(5000, 2000, 1000)).toBe(5000)
  })
})

describe('pare-feu : hors Windows', () => {
  it('rien n’est proposé ni lancé', async () => {
    const h = await open({ firewall: false })
    expect(await h.fw()).toBeNull()
    await h.admin('/pair/new', {})
    expect((await h.admin('/firewall/check', { auto: true })).status).toBe(400)
    expect((await h.admin('/firewall/repair', {})).status).toBe(400)
    await h.settle()
    expect(events(h, 'firewall_check')).toHaveLength(0)
  })
})

describe('pare-feu : vérification automatique', () => {
  it('refusée sans fenêtre d’appairage, ou avant 45 s', async () => {
    const h = await open({ afterMs: 60_000 })
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(false)
    await h.admin('/pair/new', {})
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(false)
    await h.settle()
    expect(h.checks).toEqual([])
    expect((await h.fw())!.problem).toBeNull()
  })

  it('une fois par ouverture, résultat montré, statistique anonyme envoyée', async () => {
    const h = await open()
    const { url } = (await (await h.admin('/pair/new', {})).json()) as { url: string }
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(true)
    await h.settle()
    // vérifiée pour l'adresse du QR code
    expect(h.checks).toEqual([new URL(url).hostname])
    expect(await h.fw()).toEqual({
      checking: false,
      repairing: false,
      problem: 'public',
      network: 'public',
      blocker: null,
      noRule: false,
      // réseau public : la règle couvrira aussi les réseaux publics, la carte le dit
      publicToo: true,
      repair: null,
      fixed: false,
    })
    // même ouverture : pas une deuxième fois
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(false)
    await h.settle()
    expect(h.checks).toHaveLength(1)
    const ev = events(h, 'firewall_check')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.tier).toBe('basic')
    expect(ev[0]!.iid).toBeUndefined()
    expect(ev[0]!.props).toMatchObject({ network: 'public', blocked: true, allowed: false })
    // rien d'autre que les propriétés du contrat
    const allowed = new Set(['os', 'arch', 'channel', 'locale', 'install_week', 'days_since_install', ...EVENTS.firewall_check!.props])
    for (const k of Object.keys(ev[0]!.props)) expect(allowed.has(k), k).toBe(true)
  })

  it('fenêtre rouverte dans les 10 minutes : pas de nouvelle vérification, la carte reste', async () => {
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    await h.admin('/pair/close', {})
    await h.admin('/pair/new', {})
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(false)
    await h.settle()
    expect(h.checks).toHaveLength(1)
    expect((await h.fw())!.problem).toBe('public')
  })

  it('vérification impossible (null) : rien de montré, rien d’envoyé', async () => {
    const h = await open()
    h.nextCheck.push(null)
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    expect((await h.fw())!.problem).toBeNull()
    expect(events(h, 'firewall_check')).toHaveLength(0)
  })

  it('« Vérifier à nouveau » : sans statistique, et « réglé » quand le blocage a disparu', async () => {
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    h.nextCheck.push(FINE)
    expect(await started(await h.admin('/firewall/check', {}))).toBe(true)
    await h.settle()
    expect(await h.fw()).toMatchObject({ problem: null, fixed: true })
    expect(events(h, 'firewall_check')).toHaveLength(1)
  })

  it('un téléphone joint le PC : plus de carte, et pas de vérification ensuite', async () => {
    const lan = localIPv4s().find((ip) => !ip.startsWith('169.254.'))
    if (!lan) return // machine sans réseau : couvert par les règles ci-dessus
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    expect((await h.fw())!.problem).toBe('public')
    await (await fetch(`http://${lan}:${h.srv.port}/s/`)).text()
    expect((await h.fw())!.problem).toBeNull()
    // nouvelle ouverture, page déjà ouverte par un téléphone : refusée
    await h.admin('/pair/close', {})
    await h.admin('/pair/new', {})
    await (await fetch(`http://${lan}:${h.srv.port}/s/`)).text()
    expect(await started(await h.admin('/firewall/check', { auto: true }))).toBe(false)
  })
})

describe('pare-feu : réparation', () => {
  it('refusée sans blocage trouvé : jamais de demande des droits administrateur', async () => {
    const h = await open()
    expect((await h.admin('/firewall/repair', {})).status).toBe(400)
    h.nextCheck.push(FINE)
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    expect((await h.admin('/firewall/repair', {})).status).toBe(400)
    expect(h.repairs).toBe(0)
  })

  it('« Réparer » réussi : nouvelle vérification, réglé, statistique du résultat', async () => {
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    h.nextCheck.push(FINE)
    expect(await started(await h.admin('/firewall/repair', {}))).toBe(true)
    await h.settle()
    expect(h.repairs).toBe(1)
    expect(h.checks).toHaveLength(2)
    expect(await h.fw()).toEqual({ checking: false, repairing: false, problem: null, network: 'public', blocker: null, noRule: false, publicToo: false, repair: 'ok', fixed: true })
    // la réparation a reçu la vérification qui l'a motivée (sa règle suit ce réseau)
    expect(h.repairStatuses).toEqual([PUBLIC_BLOCKED])
    const ev = events(h, 'firewall_repair')
    expect(ev.map((e) => e.props.result)).toEqual(['ok'])
    expect(ev[0]!.tier).toBe('basic')
    expect(ev[0]!.iid).toBeUndefined()
    // la vérification d'après la réparation n'est pas comptée
    expect(events(h, 'firewall_check')).toHaveLength(1)
  })

  it('accord refusé : la carte reste, sans nouvelle vérification ; réparé mais toujours bloqué : dit tel quel', async () => {
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    h.nextRepair = 'cancelled'
    await h.admin('/firewall/repair', {})
    await h.settle()
    expect(h.checks).toHaveLength(1)
    expect(await h.fw()).toMatchObject({ problem: 'public', repair: 'cancelled', fixed: false })
    h.nextRepair = 'ok'
    h.nextCheck.push(PUBLIC_BLOCKED)
    await h.admin('/firewall/repair', {})
    await h.settle()
    expect(await h.fw()).toMatchObject({ problem: 'public', repair: 'ok', fixed: false })
    expect(events(h, 'firewall_repair').map((e) => e.props.result)).toEqual(['cancelled', 'ok'])
    // « Vérifier à nouveau » : l'ancien résultat de réparation n'est plus montré
    h.nextCheck.push({ ...PUBLIC_BLOCKED, problem: 'rule' })
    await h.admin('/firewall/check', {})
    await h.settle()
    expect(await h.fw()).toMatchObject({ problem: 'rule', repair: null, fixed: false })
  })

  it('résultat inattendu de la réparation : « failed », jamais de plantage', async () => {
    const h = await open()
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    h.nextRepair = 'n’importe quoi' as RepairResult
    await h.admin('/firewall/repair', {})
    await h.settle()
    expect(await h.fw()).toMatchObject({ problem: 'public', repair: 'failed' })
    expect(events(h, 'firewall_repair').map((e) => e.props.result)).toEqual(['failed'])
  })
})

describe('pare-feu : quand une règle n’y peut rien', () => {
  it('« tout bloquer » ou pare-feu géré : pas de « Réparer », jamais de demande des droits', async () => {
    for (const blocker of ['blockAll', 'managed'] as const) {
      const h = await open()
      h.nextCheck.push({ network: 'private', blocked: false, allowed: true, problem: 'rule', profiles: 2, noRule: false, blocker })
      await h.admin('/pair/new', {})
      await h.admin('/firewall/check', { auto: true })
      await h.settle()
      expect(await h.fw()).toMatchObject({ problem: 'rule', network: 'private', blocker, publicToo: false })
      expect((await h.admin('/firewall/repair', {})).status).toBe(400)
      await h.settle()
      expect(h.repairs).toBe(0)
      expect(events(h, 'firewall_repair')).toHaveLength(0)
    }
  })

  it('réseau privé sans règle : la carte sait que Flitdrop n’est pas dans la liste, la règle reste privée', async () => {
    const h = await open()
    const st: FirewallStatus = { network: 'private', blocked: false, allowed: false, problem: 'rule', profiles: 2, noRule: true, blocker: null }
    h.nextCheck.push(st)
    await h.admin('/pair/new', {})
    await h.admin('/firewall/check', { auto: true })
    await h.settle()
    expect(await h.fw()).toMatchObject({ problem: 'rule', noRule: true, publicToo: false, blocker: null })
    h.nextRepair = 'cancelled'
    await h.admin('/firewall/repair', {})
    await h.settle()
    expect(h.repairStatuses).toEqual([st])
  })
})
