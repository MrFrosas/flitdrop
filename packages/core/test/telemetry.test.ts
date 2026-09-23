import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { Telemetry, EVENTS, COMMON_PROPS, scrub, isoWeek, isoMonth, dayBucket, localDay, platformFromUserAgent, type Envelope } from '../src/telemetry.js'

// Aucun appel réseau : fetch est remplacé par un enregistreur.
function recorder(status = 204) {
  const sent: Envelope[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return { sent, fetchImpl }
}

const homes: string[] = []
function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-tel-'))
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
})

function setup(
  opts: { basic?: boolean; full?: boolean; now?: () => number; status?: number; paired?: number; notice?: boolean; channel?: string } = {}
) {
  const home = tmpHome()
  const cfg = loadConfig(home)
  cfg.basicStats = opts.basic ?? true
  cfg.telemetryConsent = opts.full ?? false
  cfg.basicNoticeShown = opts.notice ?? true
  const rec = recorder(opts.status)
  const tel = new Telemetry(
    { home, cfg, pairedDevices: () => opts.paired ?? 0 },
    { version: '0.7.0', channel: opts.channel ?? 'dev', fetchImpl: rec.fetchImpl, now: opts.now, disabled: false, tickMs: 3_600_000 }
  )
  return { home, cfg, tel, sent: rec.sent }
}

const ENVELOPE_KEYS = new Set(['event', 'v', 'ts', 'tier', 'iid', 'props'])

function assertContract(env: Envelope) {
  for (const k of Object.keys(env)) expect(ENVELOPE_KEYS.has(k), `clé d'enveloppe ${k}`).toBe(true)
  const spec = EVENTS[env.event]
  expect(spec, `événement ${env.event}`).toBeTruthy()
  const allowed = new Set<string>([...COMMON_PROPS, ...spec!.props])
  for (const [k, v] of Object.entries(env.props)) {
    expect(allowed.has(k), `${env.event}.${k}`).toBe(true)
    expect(['string', 'number', 'boolean']).toContain(typeof v)
  }
  // l'identifiant n'existe QUE dans le niveau détaillé
  if (env.tier === 'basic') expect(env.iid).toBeUndefined()
  else expect(typeof env.iid).toBe('string')
}

describe('télémétrie : niveaux', () => {
  it('rien du tout quand les deux interrupteurs sont coupés', async () => {
    const { tel, sent } = setup({ basic: false, full: false })
    tel.start()
    tel.pairingSuccess('iphone')
    tel.transferOk('phone_to_pc', 'photo', 5_000_000)
    tel.transferFail('phone_to_pc', 'file', 413, 'tooBig')
    tel.exception(new Error('boum'), 'server', true)
    tel.stop()
    await tel.flush()
    expect(sent).toHaveLength(0)
  })

  it('niveau de base : aucun identifiant, événements détaillés ignorés', async () => {
    const { tel, sent } = setup({ basic: true })
    tel.pairingSuccess('android')
    tel.track('welcome_shown')
    tel.track('phone_connect', { platform: 'ios' })
    tel.exception(new Error('boum'), 'server', true)
    await tel.flush()
    expect(sent.map((e) => e.event)).toEqual(['pairing_success'])
    const env = sent[0]!
    expect(env.tier).toBe('basic')
    expect(env.iid).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(tel['deps'].cfg.installId)
    expect(env.props).toMatchObject({ platform: 'android', first: true, channel: 'dev', days_since_install: 0 })
    assertContract(env)
  })

  it('niveau détaillé : installId présent, événements détaillés acceptés', async () => {
    const { tel, sent, cfg } = setup({ full: true, basic: false })
    tel.track('welcome_shown')
    tel.pairingSuccess('iphone')
    await tel.flush()
    expect(sent.map((e) => e.event)).toEqual(['welcome_shown', 'pairing_success'])
    for (const env of sent) {
      expect(env.tier).toBe('full')
      expect(env.iid).toBe(cfg.installId)
      assertContract(env)
    }
  })

  it('aucune enveloppe ne sort du contrat, même avec des clés en trop', async () => {
    const { tel, sent } = setup({ full: true })
    const junk = { deviceName: 'iPhone de Thomas', path: '/Users/thomas/secret.pdf', ip: '192.168.1.2', nested: 1 }
    for (const ev of Object.keys(EVENTS)) tel.track(ev, { ...junk, platform: 'ios', key: 'theme', choice: 'full' })
    tel.transferOk('pc_to_phone', 'text', 123)
    tel.transferFail('phone_to_pc', 'photo', 500, 'disk write /Users/thomas/x.jpg')
    await tel.flush()
    expect(sent.length).toBe(Object.keys(EVENTS).length + 2)
    for (const env of sent) {
      assertContract(env)
      const raw = JSON.stringify(env)
      expect(raw).not.toContain('Thomas')
      expect(raw).not.toContain('192.168')
      expect(raw).not.toContain('secret.pdf')
    }
    // texte : pas de tranche de taille ; raison réduite à une catégorie
    const ok = sent.find((e) => e.event === 'transfer_ok')!
    expect(ok.props.size).toBeUndefined()
    const fail = sent.find((e) => e.event === 'transfer_fail')!
    expect(String(fail.props.reason)).not.toMatch(/[/ ]/)
  })

  it('props communes : semaine ISO et jours exacts en détaillé seulement', async () => {
    const now = Date.parse('2026-09-23T10:00:00Z')
    const { tel, sent, cfg } = setup({ now: () => now, full: true })
    cfg.installedAt = '2026-09-20T10:00:00.000Z'
    tel.transferOk('phone_to_pc', 'file', 2 * 1024 * 1024)
    await tel.flush()
    expect(sent[0]!.props).toMatchObject({ install_week: '2026-W38', days_since_install: 3, size: '1-10MB', kind: 'file' })
    expect(['win', 'mac', 'linux']).toContain(sent[0]!.props.os)
    expect(isoWeek(Date.parse('2026-01-01T12:00:00Z'))).toBe('2026-W01')
    expect(isoWeek(Date.parse('2027-01-01T12:00:00Z'))).toBe('2026-W53')
  })

  it('niveau de base : ancienneté en tranches, la date d’installation ne relie pas deux événements', async () => {
    let now = Date.parse('2026-09-23T10:00:00Z')
    const { tel, sent, cfg } = setup({ now: () => now })
    cfg.installedAt = '2026-09-20T10:00:00.000Z'
    tel.transferOk('phone_to_pc', 'file', 10)
    now = Date.parse('2026-09-24T18:00:00Z')
    tel.transferOk('phone_to_pc', 'file', 10)
    await tel.flush()
    // 3 jours puis 4 jours : même tranche, même mois, rien qui permette de
    // retrouver le jour d'installation en soustrayant
    expect(sent.map((e) => [e.props.install_week, e.props.days_since_install])).toEqual([
      ['2026-09', 1],
      ['2026-09', 1],
    ])
    expect([0, 1, 7, 8, 30, 31, 400].map(dayBucket)).toEqual([0, 1, 1, 8, 8, 31, 31])
    expect(isoMonth(Date.parse('2026-12-31T23:00:00Z'))).toBe('2026-12')
  })
})

describe('télémétrie : actif du jour', () => {
  it('au plus une fois par jour local, et de nouveau le lendemain', async () => {
    let now = new Date(2026, 8, 23, 23, 50).getTime()
    const { tel, sent, cfg, home } = setup({ now: () => now, paired: 3 })
    tel.start()
    await tel.flush()
    tel.dailyCheck()
    await tel.flush()
    const daily = () => sent.filter((e) => e.event === 'app_daily_active')
    expect(daily()).toHaveLength(1)
    expect(daily()[0]!.props.paired_devices).toBe(2)
    expect(cfg.lastDailyActiveDay).toBe('2026-09-23')
    // persisté : un redémarrage le même jour ne renvoie rien
    expect(loadConfig(home).lastDailyActiveDay).toBe('2026-09-23')
    now = new Date(2026, 8, 24, 0, 5).getTime()
    tel.dailyCheck()
    await tel.flush()
    tel.dailyCheck()
    await tel.flush()
    expect(daily()).toHaveLength(2)
    expect(cfg.lastDailyActiveDay).toBe(localDay(now))
    tel.stop()
  })

  it('un envoi raté n’est pas marqué : retenté au passage suivant', async () => {
    const { tel, sent, cfg } = setup({ status: 503 })
    tel.dailyCheck()
    await tel.flush()
    expect(sent).toHaveLength(1)
    expect(cfg.lastDailyActiveDay).toBe('')
    tel.dailyCheck()
    await tel.flush()
    expect(sent).toHaveLength(2)
  })
})

describe('télémétrie : annonce des statistiques de base', () => {
  it('rien ne part avant l’affichage de l’annonce, puis lancement et actif du jour', async () => {
    const { tel, sent, cfg, home } = setup({ notice: false })
    tel.start()
    tel.pairingSuccess('iphone')
    tel.dailyCheck()
    await tel.flush()
    expect(sent).toHaveLength(0)
    expect(cfg.lastVersion).toBe('')
    tel.noticeShown()
    await tel.flush()
    tel.noticeShown() // signalée une 2e fois : rien de plus
    await tel.flush()
    tel.stop()
    expect(sent.map((e) => e.event).sort()).toEqual(['app_daily_active', 'app_first_launch'])
    expect(loadConfig(home).basicNoticeShown).toBe(true)
  })

  it('accord détaillé : pas d’attente (la personne a lu la question)', async () => {
    const { tel, sent } = setup({ notice: false, full: true })
    tel.start()
    await tel.flush()
    tel.stop()
    expect(sent.map((e) => e.event)).toContain('app_first_launch')
  })

  it('une réponse déjà donnée vaut annonce vue', () => {
    const home = tmpHome()
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adminToken: 'a'.repeat(32), telemetryAsked: true, installId: 'c'.repeat(16) }))
    expect(loadConfig(home).basicNoticeShown).toBe(true)
  })
})

describe('télémétrie : canal Microsoft Store', () => {
  it('« store » reste « store » après une mise à jour par l’installeur classique', async () => {
    const { tel, sent, home } = setup({ channel: 'store' })
    tel.pairingSuccess('android')
    await tel.flush()
    expect(sent[0]!.props.channel).toBe('store')
    const cfg = loadConfig(home)
    expect(cfg.installChannel).toBe('store')
    const rec = recorder()
    const tel2 = new Telemetry({ home, cfg, pairedDevices: () => 0 }, { version: '0.7.1', channel: 'nsis', fetchImpl: rec.fetchImpl, disabled: false })
    tel2.pairingSuccess('android')
    await tel2.flush()
    expect(rec.sent[0]!.props.channel).toBe('store')
    // une installation du site reste « nsis »
    const site = setup({ channel: 'nsis' })
    site.tel.pairingSuccess('ios')
    await site.tel.flush()
    expect(site.sent[0]!.props.channel).toBe('nsis')
  })
})

describe('télémétrie : premières fois et cycle de vie', () => {
  it('first=true une seule fois, et persisté', async () => {
    const { tel, sent, home } = setup()
    tel.pairingSuccess('iphone')
    tel.pairingSuccess('android')
    tel.transferOk('phone_to_pc', 'photo', 10)
    tel.transferOk('pc_to_phone', 'file', 10)
    await tel.flush()
    expect(sent.map((e) => e.props.first)).toEqual([true, false, true, false])
    const again = loadConfig(home)
    expect(again.firstPairingDone).toBe(true)
    expect(again.firstTransferDone).toBe(true)
  })

  it('nouvelle installation : app_first_launch une seule fois', async () => {
    const { tel, sent, home, cfg } = setup()
    tel.start()
    await tel.flush()
    tel.stop()
    expect(sent.map((e) => e.event)).toContain('app_first_launch')
    expect(sent.map((e) => e.event)).not.toContain('app_updated')
    expect(loadConfig(home).lastVersion).toBe('0.7.0')
    // relance de la même version : plus rien sur le cycle de vie
    const rec = recorder()
    const tel2 = new Telemetry({ home, cfg: loadConfig(home), pairedDevices: () => 0 }, { version: '0.7.0', channel: 'dev', fetchImpl: rec.fetchImpl, disabled: false })
    tel2.start()
    await tel2.flush()
    tel2.stop()
    expect(rec.sent.filter((e) => e.event === 'app_first_launch' || e.event === 'app_updated')).toHaveLength(0)
    expect(cfg.installId).toMatch(/^[A-Za-z0-9_-]{16,40}$/)
  })

  it('migration d’une ancienne installation : app_updated, jamais app_first_launch', async () => {
    const home = tmpHome()
    // config.json d'une version antérieure (sans aucun champ de suivi)
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ deviceName: 'PC de Thomas', port: 47777, adminToken: 'a'.repeat(32), instanceId: 'b'.repeat(16), telemetryConsent: false })
    )
    fs.writeFileSync(path.join(home, 'devices.json'), JSON.stringify([{ id: 'x', keyB64: 'k', status: 'active' }]))
    fs.writeFileSync(path.join(home, 'history.json'), JSON.stringify([{ id: 'h', status: 'ok' }]))
    const births = ['', 'config.json', 'devices.json', 'history.json']
      .map((f) => fs.statSync(path.join(home, f)).birthtimeMs)
      .filter((b) => b > Date.parse('2024-01-01'))
    const cfg = loadConfig(home)
    expect(cfg.telemetryAsked).toBe(false)
    expect(cfg.basicNoticeShown).toBe(false)
    expect(cfg.basicStats).toBe(true)
    expect(cfg.telemetryConsent).toBe(false)
    expect(cfg.lastVersion).toBe('unknown')
    expect(cfg.firstPairingDone).toBe(true)
    expect(cfg.firstTransferDone).toBe(true)
    expect(Date.parse(cfg.installedAt)).toBeLessThanOrEqual(Date.now())
    if (births.length) expect(Date.parse(cfg.installedAt)).toBe(new Date(Math.min(...births)).getTime())
    // les réglages existants sont conservés
    expect(cfg.deviceName).toBe('PC de Thomas')
    expect(cfg.adminToken).toBe('a'.repeat(32))

    const rec = recorder()
    const tel = new Telemetry({ home, cfg, pairedDevices: () => 1 }, { version: '0.7.0', channel: 'nsis', fetchImpl: rec.fetchImpl, disabled: false })
    tel.start()
    await tel.flush()
    // l'ancienne version promettait « décoché par défaut » : rien ne part
    // avant que l'annonce ait été affichée dans la fenêtre
    expect(rec.sent).toHaveLength(0)
    expect(loadConfig(home).lastVersion).toBe('unknown')
    tel.noticeShown()
    await tel.flush()
    tel.stop()
    const names = rec.sent.map((e) => e.event)
    expect(names).toContain('app_updated')
    expect(names).not.toContain('app_first_launch')
    expect(rec.sent.find((e) => e.event === 'app_updated')!.props.from_version).toBe('unknown')
    // une fois migrée, la config n'est plus « ancienne » au lancement suivant
    const reloaded = loadConfig(home)
    expect(reloaded.lastVersion).toBe('0.7.0')
    expect(reloaded.installId).toBe(cfg.installId)
    expect(reloaded.installedAt).toBe(cfg.installedAt)
  })

  it('désactivée par défaut sous test (variable d’environnement)', async () => {
    const home = tmpHome()
    const rec = recorder()
    const tel = new Telemetry({ home, cfg: loadConfig(home), pairedDevices: () => 0 }, { version: '1', channel: 'dev', fetchImpl: rec.fetchImpl })
    expect(tel.active).toBe(false)
    tel.start()
    tel.pairingSuccess('iphone')
    await tel.flush()
    expect(rec.sent).toHaveLength(0)
  })
})

describe('télémétrie : page ouverte par un téléphone', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 17; Pixel 10) AppleWebKit/537.36 Chrome/154.0 Mobile Safari/537.36'

  it('type de téléphone ramené à ios, android ou other', () => {
    expect(platformFromUserAgent(IPHONE)).toBe('ios')
    expect(platformFromUserAgent('Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X)')).toBe('ios')
    expect(platformFromUserAgent(ANDROID)).toBe('android')
    expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other')
    expect(platformFromUserAgent(undefined)).toBe('other')
  })

  it('first=true la toute première fois seulement, persisté ; ni adresse ni navigateur envoyés', async () => {
    const { tel, sent, home } = setup()
    tel.phonePageOpened('192.168.1.23', IPHONE)
    tel.phonePageOpened('192.168.1.40', ANDROID)
    await tel.flush()
    expect(sent.map((e) => e.event)).toEqual(['phone_page_opened', 'phone_page_opened'])
    expect(sent.map((e) => e.props.first)).toEqual([true, false])
    expect(sent.map((e) => e.props.platform)).toEqual(['ios', 'android'])
    for (const e of sent) {
      expect(e.tier).toBe('basic')
      expect(e.iid).toBeUndefined()
      const raw = JSON.stringify(e)
      expect(raw).not.toContain('192.168')
      expect(raw).not.toContain('Mozilla')
      assertContract(e)
    }
    expect(loadConfig(home).firstPhonePageDone).toBe(true)
  })

  it('même téléphone : au plus une fois par tranche de 10 minutes, en mémoire seulement', async () => {
    let now = Date.parse('2026-09-23T10:00:00Z')
    const { tel, sent, home } = setup({ now: () => now })
    tel.phonePageOpened('192.168.1.23', IPHONE)
    now += 60_000
    tel.phonePageOpened('192.168.1.23', IPHONE)
    now += 8 * 60_000
    tel.phonePageOpened('192.168.1.23', IPHONE)
    // autre téléphone pendant ce temps : compté
    tel.phonePageOpened('192.168.1.24', IPHONE)
    now += 2 * 60_000
    tel.phonePageOpened('192.168.1.23', IPHONE)
    await tel.flush()
    expect(sent).toHaveLength(3)
    // rien d'autre que le drapeau de première fois n'est écrit sur le disque
    const onDisk = fs.readFileSync(path.join(home, 'config.json'), 'utf8')
    expect(onDisk).not.toContain('192.168.1.23')
  })

  it('beaucoup de téléphones : la mémoire reste bornée', async () => {
    let now = 0
    const { tel, sent } = setup({ now: () => now })
    for (let i = 0; i < 1000; i++) {
      now += 1
      tel.phonePageOpened(`10.0.${i >> 8}.${i & 255}`, ANDROID)
    }
    const seen = (tel as unknown as { lastPageOpen: Map<string, number> }).lastPageOpen
    expect(seen.size).toBeLessThanOrEqual(200)
    await tel.flush()
    expect(sent.length).toBeGreaterThan(0)
  })

  it('rien quand les statistiques de base sont coupées', async () => {
    const { tel, sent } = setup({ basic: false, full: false })
    tel.phonePageOpened('192.168.1.23', IPHONE)
    await tel.flush()
    expect(sent).toHaveLength(0)
  })

  it('rien avant l’affichage de l’annonce des statistiques', async () => {
    const { tel, sent } = setup({ basic: true, notice: false })
    tel.phonePageOpened('192.168.1.23', IPHONE)
    await tel.flush()
    expect(sent).toHaveLength(0)
  })

  it('migration : une installation qui a déjà appairé ne compte pas une « première fois »', () => {
    const home = tmpHome()
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ installId: 'abcdefghijklmnop', firstPairingDone: true, firstTransferDone: false })
    )
    expect(loadConfig(home).firstPhonePageDone).toBe(true)
    const fresh = tmpHome()
    fs.writeFileSync(path.join(fresh, 'config.json'), JSON.stringify({ installId: 'abcdefghijklmnop' }))
    expect(loadConfig(fresh).firstPhonePageDone).toBe(false)
    // valeur absurde : traitée comme absente
    const odd = tmpHome()
    fs.writeFileSync(path.join(odd, 'config.json'), JSON.stringify({ installId: 'abcdefghijklmnop', firstPhonePageDone: 'oui' }))
    expect(loadConfig(odd).firstPhonePageDone).toBe(false)
    expect(loadConfig(tmpHome()).firstPhonePageDone).toBe(false)
  })
})

describe('télémétrie : rapports d’erreur', () => {
  it('nettoie chemins, jetons, requêtes, IP et noms de fichiers', () => {
    const home = '/Users/thomas'
    const input = [
      "ENOENT: no such file or directory, open '/Users/thomas/Downloads/Flitdrop/Relevé bancaire.pdf'",
      'fetch http://192.168.1.20:47777/app/?k=SECRETADMINTOKEN123456789 failed',
      'pair http://10.0.0.2:47777/s/#dev123.keykeykeykeykeykeykeykey.inst',
      'at Object.x (/Users/thomas/Downloads/flitdrop-app/apps/desktop/core/flitdrop.cjs:120:7)',
      'at y (C:\\Users\\Bob\\AppData\\Local\\Programs\\flitdrop\\resources\\app.asar\\main.cjs:10:5)',
      'at z (/home/alice/Documents/projet-secret/notes.txt)',
      'mail bob@example.com token abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n')
    const out = scrub(input, { home, host: 'MacBook-de-Thomas', secrets: ['SECRETADMINTOKEN123456789'] })
    expect(out).not.toMatch(/thomas/i)
    expect(out).not.toMatch(/Bob|alice/)
    expect(out).not.toContain('Relevé')
    expect(out).not.toContain('projet-secret')
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('keykey')
    expect(out).not.toContain('192.168')
    expect(out).not.toContain('10.0.0.2')
    expect(out).not.toContain('example.com')
    expect(out).not.toContain('?k=')
    expect(out).toContain('core/flitdrop.cjs:120:7')
    expect(out).toContain('app.asar/main.cjs:10:5')
    expect(out).toContain('~')
  })

  it('chemins sans guillemets contenant des espaces : aucun morceau de nom ne sort', () => {
    const opts = { home: 'C:\\Users\\Jean Dupont', host: 'PC-JEAN' }
    const cases: [string, string[], string[]][] = [
      [
        'rename C:\\Users\\Jean Dupont\\AppData\\Local\\x.part -> C:\\Users\\Jean Dupont\\Downloads\\Photo vacances.jpg',
        ['vacances', 'Photo', 'Jean', 'x.part'],
        ['rename ', ' -> '],
      ],
      ['D:\\Photos Famille\\anniv maman.jpg not found', ['Famille', 'anniv', 'maman'], ['not found']],
      ['Cannot read /Volumes/USB Key/secret.docx', ['Key', 'secret', 'USB'], ['Cannot read ']],
      ['/Users/jean/Desktop/rapport final.pdf', ['rapport', 'final', 'jean'], []],
      ['Unknown file: /home/jean/Mes Documents/devis client', ['Documents', 'devis', 'client', 'jean'], ['Unknown file: ']],
      [
        'at x (C:\\Program Files\\Flitdrop\\resources\\app.asar\\core\\flitdrop.cjs:12:3)',
        [],
        ['app.asar/core/flitdrop.cjs:12:3'],
      ],
      ['C:\\Program Files (x86)\\Flitdrop\\resources\\app.asar\\core\\flitdrop.cjs:1:2', ['x86', 'Program'], ['app.asar/core/flitdrop.cjs:1:2']],
      [
        'at C:\\Program Files\\F\\resources\\app.asar\\core\\x.cjs:1:2 while opening D:\\Photos Famille\\anniv maman.jpg',
        ['Famille', 'anniv', 'maman'],
        ['app.asar/core/x.cjs:1:2'],
      ],
    ]
    for (const [input, gone, kept] of cases) {
      const out = scrub(input, opts)
      for (const g of gone) expect(out, `${input} -> ${out}`).not.toContain(g)
      for (const k of kept) expect(out, `${input} -> ${out}`).toContain(k)
    }
    // du texte ordinaire avec des barres n'est pas touché
    expect(scrub('read/write 1/2 ok', opts)).toBe('read/write 1/2 ok')
  })

  it('niveau détaillé seulement, dédoublonné, 20 par heure au plus', async () => {
    const base = setup({ basic: true })
    base.tel.exception(new Error('x'), 'server', true)
    await base.tel.flush()
    expect(base.sent).toHaveLength(0)

    const { tel, sent, cfg } = setup({ full: true })
    const e = new Error(`échec pour ${cfg.adminToken} dans ${os.homedir()}/Documents/a.txt`)
    tel.exception(e, 'main', false)
    tel.exception(e, 'main', false) // doublon ignoré
    for (let i = 0; i < 30; i++) tel.exception(new Error(`erreur ${i}`), 'desktop', false)
    await tel.flush()
    expect(sent).toHaveLength(20)
    const first = sent[0]!
    assertContract(first)
    expect(first.event).toBe('$exception')
    expect(first.props.source).toBe('main')
    expect(first.props.handled).toBe(false)
    expect(String(first.props.$exception_message)).not.toContain(cfg.adminToken)
    expect(String(first.props.$exception_message)).not.toContain(os.homedir())
    expect(String(first.props.$exception_message)).not.toContain('a.txt')
    expect(String(first.props.$exception_message).length).toBeLessThanOrEqual(300)
    expect(String(first.props.$exception_stack_trace_raw).length).toBeLessThanOrEqual(4000)
  })
})

