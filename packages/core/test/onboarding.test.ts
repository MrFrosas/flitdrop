import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { loadConfig, type Config } from '../src/config.js'
import { Telemetry, type Envelope } from '../src/telemetry.js'
import { RATE_AGAIN, RATE_FIRST, answerRating, countTransfer, ratingDue } from '../src/rating.js'
import { reviewUrl } from '../src/host.js'
import { PAIR_RENEW_BEFORE_MS, connectError, fmtCountdown, pairCodeState, shouldSuggestInstall } from '../src/webclient/onboarding.js'
import { sealJSON, openJSON, randomToken } from '../src/crypto.js'
import { b64u } from '../src/util.js'

// Premier usage : code d'appairage renouvelé et « code expiré », lancement à
// l'ouverture de session d'une installation neuve, premier envoi guidé,
// demande de note, statistiques du chemin de connexion.

const homes: string[] = []
function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-onb-'))
  homes.push(h)
  return h
}
afterAll(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
})

// ---------- règles pures ----------

describe('demande de note', () => {
  const cfg = () => loadConfig(tmpHome())

  it('due au 3e transfert réussi, pas avant', () => {
    const c = cfg()
    expect(ratingDue(c)).toBe(false)
    expect(countTransfer(c)).toEqual({ changed: true, due: false })
    expect(countTransfer(c)).toEqual({ changed: true, due: false })
    expect(countTransfer(c)).toEqual({ changed: true, due: true })
    expect(c.okTransfers).toBe(RATE_FIRST)
    expect(ratingDue(c)).toBe(true)
    // le compteur s'arrête tant que la carte attend une réponse
    expect(countTransfer(c)).toEqual({ changed: false, due: false })
    expect(c.okTransfers).toBe(RATE_FIRST)
  })

  it('« Noter » : plus jamais', () => {
    const c = cfg()
    for (let i = 0; i < RATE_FIRST; i++) countTransfer(c)
    expect(answerRating(c, 'rate')).toBe(true)
    expect(c.rateState).toBe('done')
    expect(ratingDue(c)).toBe(false)
    for (let i = 0; i < 100; i++) expect(countTransfer(c).changed).toBe(false)
    expect(ratingDue(c)).toBe(false)
  })

  it('« Plus tard » : une seule fois de plus, 20 transferts plus tard, puis plus jamais', () => {
    const c = cfg()
    for (let i = 0; i < RATE_FIRST; i++) countTransfer(c)
    expect(answerRating(c, 'later')).toBe(true)
    expect(c.rateState).toBe('later')
    expect(ratingDue(c)).toBe(false)
    for (let i = 1; i < RATE_AGAIN; i++) expect(countTransfer(c)).toEqual({ changed: true, due: false })
    expect(countTransfer(c)).toEqual({ changed: true, due: true })
    expect(c.okTransfers).toBe(RATE_FIRST + RATE_AGAIN)
    expect(answerRating(c, 'later')).toBe(true)
    expect(c.rateState).toBe('done')
    expect(ratingDue(c)).toBe(false)
    expect(countTransfer(c).changed).toBe(false)
  })

  it('réponse refusée quand la carte n’est pas due ou inconnue', () => {
    const c = cfg()
    expect(answerRating(c, 'rate')).toBe(false)
    expect(c.rateState).toBe('')
    for (let i = 0; i < RATE_FIRST; i++) countTransfer(c)
    expect(answerRating(c, 'jamais')).toBe(false)
    expect(ratingDue(c)).toBe(true)
  })

  it('page où laisser une note', () => {
    expect(reviewUrl('win32', 'store')).toBe('ms-windows-store://review/?ProductId=XPDCK4DDN3LK69')
    expect(reviewUrl('win32', 'nsis')).toBe('https://apps.microsoft.com/detail/XPDCK4DDN3LK69')
    expect(reviewUrl('darwin', 'dmg')).toBe('https://github.com/MrFrosas/flitdrop')
    expect(reviewUrl('linux', 'appimage')).toBe('https://github.com/MrFrosas/flitdrop')
    // le canal « store » ne vaut que sous Windows
    expect(reviewUrl('darwin', 'store')).toBe('https://github.com/MrFrosas/flitdrop')
  })
})

describe('code d’appairage affiché (page du PC)', () => {
  it('remplacé 30 s avant d’expirer, compte à rebours jusque-là', () => {
    const t0 = 1_000_000
    const expires = t0 + 180_000
    expect(pairCodeState(t0, expires)).toEqual({ renewNow: false, renewInMs: 150_000 })
    expect(pairCodeState(expires - PAIR_RENEW_BEFORE_MS - 1, expires).renewNow).toBe(false)
    expect(pairCodeState(expires - PAIR_RENEW_BEFORE_MS, expires)).toEqual({ renewNow: true, renewInMs: 0 })
    // fenêtre revenue bien après l'expiration : tout de suite
    expect(pairCodeState(expires + 600_000, expires).renewNow).toBe(true)
  })

  it('compte à rebours lisible', () => {
    expect(fmtCountdown(150_000)).toBe('2:30')
    expect(fmtCountdown(59_001)).toBe('1:00')
    expect(fmtCountdown(9_000)).toBe('0:09')
    expect(fmtCountdown(1)).toBe('0:01')
    expect(fmtCountdown(-5)).toBe('0:00')
  })
})

describe('erreur de connexion (page du téléphone)', () => {
  const base = { fresh: false, standalone: false }
  it('code expiré signalé par le PC', () => {
    expect(connectError({ ...base, status: 403, code: 'pairingExpired' })).toBe('expired')
  })
  it('code neuf inconnu du PC (PC redémarré) : expiré aussi, sauf depuis l’icône', () => {
    expect(connectError({ status: 403, code: 'deviceUnknown', fresh: true, standalone: false })).toBe('expired')
    expect(connectError({ status: 403, code: 'deviceUnknown', fresh: true, standalone: true })).toBe('revoked')
  })
  it('appairage déjà connu et refusé : téléphone retiré, comme avant', () => {
    expect(connectError({ ...base, status: 403, code: 'deviceUnknown' })).toBe('revoked')
    expect(connectError({ ...base, status: 403, code: 'authRefused', fresh: true })).toBe('revoked')
    expect(connectError({ ...base, status: 409, code: 'wrongPc' })).toBe('wrongPc')
    expect(connectError({ ...base })).toBe('notFound')
    expect(connectError({ ...base, status: 500 })).toBe('notFound')
  })
})

describe('icône d’écran d’accueil (page du téléphone)', () => {
  it('proposée seulement après un premier transfert réussi', () => {
    expect(shouldSuggestInstall({ standalone: false, dismissed: false, firstTransferDone: false })).toBe(false)
    expect(shouldSuggestInstall({ standalone: false, dismissed: false, firstTransferDone: true })).toBe(true)
    expect(shouldSuggestInstall({ standalone: true, dismissed: false, firstTransferDone: true })).toBe(false)
    expect(shouldSuggestInstall({ standalone: false, dismissed: true, firstTransferDone: true })).toBe(false)
  })
})

describe('configuration : question du lancement à l’ouverture de session', () => {
  it('installation neuve : pas encore posée', () => {
    expect(loadConfig(tmpHome()).autostartAsked).toBe(false)
  })
  it('installation existante (config sans ce réglage) : considérée comme répondue', () => {
    const home = tmpHome()
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ deviceName: 'TOUR', installId: 'i'.repeat(16) }))
    const cfg = loadConfig(home)
    expect(cfg.autostartAsked).toBe(true)
    expect(cfg.okTransfers).toBe(0)
    expect(cfg.rateState).toBe('')
  })
  it('réponse gardée d’un lancement à l’autre', () => {
    const home = tmpHome()
    expect(loadConfig(home).autostartAsked).toBe(false)
    // relancé sans avoir répondu : toujours à poser
    expect(loadConfig(home).autostartAsked).toBe(false)
    const cfg = loadConfig(home)
    cfg.autostartAsked = true
    cfg.rateState = 'later'
    cfg.rateLaterAt = 3
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg))
    const again = loadConfig(home)
    expect(again.autostartAsked).toBe(true)
    expect(again.rateState).toBe('later')
    expect(again.rateLaterAt).toBe(3)
  })
})

describe('statistique du jour : lancement à l’ouverture de session', () => {
  const daily = async (autostart?: () => boolean | null) => {
    const home = tmpHome()
    const cfg = loadConfig(home)
    cfg.basicNoticeShown = true
    const sent: Envelope[] = []
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const tel = new Telemetry({ home, cfg, pairedDevices: () => 1, autostart }, { version: '0.7.0', channel: 'dev', fetchImpl, disabled: false, tickMs: 3_600_000 })
    tel.dailyCheck()
    await tel.flush()
    return sent.find((e) => e.event === 'app_daily_active')!
  }
  it('envoyée dans app_daily_active quand l’app la connaît', async () => {
    expect((await daily(() => true)).props.autostart).toBe(true)
    expect((await daily(() => false)).props.autostart).toBe(false)
  })
  it('absente hors app de bureau', async () => {
    expect('autostart' in (await daily(() => null)).props).toBe(false)
    expect('autostart' in (await daily()).props).toBe(false)
  })
})

// ---------- serveur réel ----------

interface Phone {
  id: string
  key: Uint8Array
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
}

let srv: RunningServer
let base = ''
let home = ''
let autostartOn = false
const autostartCalls: boolean[] = []
const actions: string[] = []
const sent: Envelope[] = []
const fetchImpl = (async (_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)))
  return new Response(null, { status: 204 })
}) as unknown as typeof fetch

const admin = (p: string, body?: unknown) =>
  fetch(base + '/api/admin' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': srv.adminToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
type StateRes = { autostart: boolean | null; rate: boolean; config: { autostartAsked: boolean; firstTransferDone: boolean } }
const state = async () => (await (await admin('/state')).json()) as StateRes

function phoneFrom(id: string, key: Uint8Array): Phone {
  const aad = (purpose: string) => `wd1|${id}|${purpose}`
  const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
    })
  return { id, key, post }
}
const codePhone = (url: string): Phone => {
  const [id, k] = (url.split('#')[1] as string).split('.') as [string, string]
  return phoneFrom(id, b64u.dec(k))
}
async function hello(p: Phone): Promise<Phone> {
  const r = await p.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone', platform: 'iphone' })
  expect(r.status).toBe(200)
  const dec = openJSON<{ newKey?: string }>(p.key, ((await r.json()) as { p: string }).p, `wd1|${p.id}|hello:res`)
  return dec.newKey ? phoneFrom(p.id, b64u.dec(dec.newKey)) : p
}
const newCode = async (renew?: boolean) =>
  (await (await admin('/pair/new', renew === undefined ? {} : { renew })).json()) as { deviceId: string; url: string; ttlMs: number }
const settle = async () => {
  await new Promise((r) => setTimeout(r, 30))
  await srv.telemetry.flush()
}
const events = (name: string) => sent.filter((e) => e.event === name)

beforeAll(async () => {
  home = tmpHome()
  process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
  srv = await startServer({
    port: 0,
    home,
    disableClipboard: true,
    quiet: true,
    telemetry: { version: '0.7.0', channel: 'dev', fetchImpl, disabled: false, tickMs: 3_600_000 },
    onHostAction: (a) => actions.push(a),
    autostart: {
      get: () => autostartOn,
      set: (on) => {
        autostartCalls.push(on)
        autostartOn = on
      },
    },
  })
  base = `http://127.0.0.1:${srv.port}`
  // l'annonce des statistiques de base a été vue
  await admin('/telemetry/notice', {})
  await settle()
})

afterAll(async () => {
  await srv.close()
  delete process.env.FLITDROP_DOWNLOADS
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lancement à l’ouverture de session (serveur)', () => {
  it('installation neuve : rien n’est changé avant la réponse', async () => {
    const st = await state()
    expect(st.autostart).toBe(false)
    expect(st.config.autostartAsked).toBe(false)
    expect(autostartCalls).toEqual([])
  })

  it('la réponse de l’écran d’accueil est appliquée et gardée', async () => {
    const r = await admin('/autostart', { enabled: true })
    expect(r.status).toBe(200)
    expect(autostartCalls).toEqual([true])
    const st = await state()
    expect(st.autostart).toBe(true)
    expect(st.config.autostartAsked).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).autostartAsked).toBe(true)
    // décoché dans les réglages ou le menu de l'icône
    expect(srv.setAutostart(false)).toBe(true)
    expect((await state()).autostart).toBe(false)
    expect((await admin('/autostart', { enabled: 'oui' })).status).toBe(400)
  })

  it('hors app de bureau : ni proposé ni réglable', async () => {
    const h = tmpHome()
    const other = await startServer({ port: 0, home: h, disableClipboard: true, quiet: true })
    try {
      const get = (p: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${other.port}/api/admin${p}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'x-admin-token': other.adminToken, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      const st = (await (await get('/state')).json()) as StateRes
      expect(st.autostart).toBeNull()
      // pas d'app de bureau : pas de carte de note non plus
      expect(st.rate).toBe(false)
      expect((await get('/autostart', { enabled: true })).status).toBe(400)
      expect(other.setAutostart(true)).toBe(false)
    } finally {
      await other.close()
    }
  })
})

describe('fenêtre d’appairage : statistiques du chemin de connexion', () => {
  it('ouverte puis fermée sans scan', async () => {
    sent.length = 0
    const code = await newCode()
    expect(code.ttlMs).toBe(3 * 60 * 1000)
    await admin('/pair/close', {})
    await settle()
    expect(events('qr_shown').map((e) => e.props.renewed)).toEqual([false])
    expect(events('pairing_view_closed').map((e) => e.props.scanned)).toEqual([false])
    for (const e of [...events('qr_shown'), ...events('pairing_view_closed')]) {
      expect(e.tier).toBe('basic')
      expect(e.iid).toBeUndefined()
    }
    await admin(`/device/${code.deviceId}/revoke`, {})
  })

  it('code renouvelé deux fois : qr_shown une seule fois, et l’ancien code reste valable', async () => {
    sent.length = 0
    const first = await newCode()
    const second = await newCode(true)
    await newCode(true)
    expect(second.deviceId).not.toBe(first.deviceId)
    await settle()
    expect(events('qr_shown').map((e) => e.props.renewed)).toEqual([true])
    // un téléphone qui avait scanné le premier code juste avant finit quand même
    const phone = await hello(codePhone(first.url))
    await admin('/pair/close', {})
    await settle()
    expect(events('qr_shown')).toHaveLength(1)
    expect(events('pairing_view_closed').map((e) => e.props.scanned)).toEqual([true])
    await admin(`/device/${phone.id}/revoke`, {})
  })

  it('scanné sans renouvellement : qr_shown compté au scan, sans renouvellement', async () => {
    sent.length = 0
    const code = await newCode()
    const phone = await hello(codePhone(code.url))
    await settle()
    expect(events('qr_shown').map((e) => e.props.renewed)).toEqual([false])
    await admin('/pair/close', {})
    await settle()
    expect(events('qr_shown')).toHaveLength(1)
    expect(events('pairing_view_closed').map((e) => e.props.scanned)).toEqual([true])
    await admin(`/device/${phone.id}/revoke`, {})
  })

  it('renouvellement arrivé après la fermeture : rien de plus', async () => {
    sent.length = 0
    await newCode(true)
    await admin('/pair/close', {})
    await settle()
    expect(events('qr_shown')).toHaveLength(0)
    expect(events('pairing_view_closed')).toHaveLength(0)
    expect(events('pair_qr_shown')).toHaveLength(0)
  })
})

describe('code expiré scanné', () => {
  it('le téléphone apprend que le code a expiré, compté une fois', async () => {
    sent.length = 0
    const old = await newCode()
    // 4 minutes plus tard, un nouveau code est demandé : l'ancien est oublié
    const later = Date.now() + 4 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await newCode()
    vi.restoreAllMocks()
    const phone = codePhone(old.url)
    for (let i = 0; i < 2; i++) {
      const r = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'iPhone', platform: 'iphone' })
      expect(r.status).toBe(403)
      expect(((await r.json()) as { code: string }).code).toBe('pairingExpired')
    }
    await settle()
    const expired = events('qr_expired_scan')
    expect(expired).toHaveLength(1)
    expect(expired[0]!.tier).toBe('basic')
    expect(JSON.stringify(expired[0])).not.toContain(old.deviceId)
    // un identifiant jamais vu reste « appareil inconnu »
    const stranger = phoneFrom('abcdefghijkl', b64u.dec(old.url.split('#')[1]!.split('.')[1]!))
    const r = await stranger.post('/api/phone/hello', 'hello', {})
    expect(((await r.json()) as { code: string }).code).toBe('deviceUnknown')
    await admin('/pair/close', {})
  })
})

describe('premier envoi guidé et demande de note', () => {
  let phone: Phone
  const sendText = async () => {
    const r = await phone.post('/api/phone/text', 'text', { text: 'bonjour', mode: 'message' })
    expect(r.status).toBe(200)
  }

  it('premier transfert : le guide disparaît', async () => {
    const code = await newCode()
    phone = await hello(codePhone(code.url))
    await admin('/pair/close', {})
    expect((await state()).config.firstTransferDone).toBe(false)
    await sendText()
    expect((await state()).config.firstTransferDone).toBe(true)
  })

  it('carte due au 3e transfert réussi, « Plus tard » la reporte de 20 transferts, une seule fois', async () => {
    expect((await state()).rate).toBe(false)
    await sendText()
    expect((await state()).rate).toBe(false)
    await sendText()
    expect((await state()).rate).toBe(true)
    expect((await admin('/rate', { action: 'later' })).status).toBe(200)
    expect((await state()).rate).toBe(false)
    for (let i = 1; i < RATE_AGAIN; i++) await sendText()
    expect((await state()).rate).toBe(false)
    await sendText()
    expect((await state()).rate).toBe(true)
    expect((await admin('/rate', { action: 'later' })).status).toBe(200)
    for (let i = 0; i < 25; i++) await sendText()
    expect((await state()).rate).toBe(false)
    expect(actions).not.toContain('openReview')
    // compteur arrêté : plus rien n'est écrit
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).okTransfers).toBe(RATE_FIRST + RATE_AGAIN)
  })

  it('« Noter » ouvre la page choisie par l’app, puis plus jamais', async () => {
    const cfg: Config = srv.cfg
    cfg.rateState = ''
    cfg.okTransfers = 0
    for (let i = 0; i < RATE_FIRST; i++) await sendText()
    expect((await state()).rate).toBe(true)
    expect((await admin('/rate', { action: 'rate' })).status).toBe(200)
    expect(actions).toEqual(['openReview'])
    for (let i = 0; i < 30; i++) await sendText()
    expect((await state()).rate).toBe(false)
    // plus de carte : une réponse de plus est refusée
    expect((await admin('/rate', { action: 'rate' })).status).toBe(400)
    expect(actions).toEqual(['openReview'])
  })
})
