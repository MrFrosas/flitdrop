// Tests du Worker de télémétrie : node --test telemetry-worker/worker.test.mjs
// On appelle directement fetch() du Worker avec une fausse requête, un faux
// env et un faux ctx ; l'appel sortant vers PostHog est intercepté.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.js'

const NEW_KEY = 'phc_urqVGgN2XuWcGdkBGagawWbaPRU88HxosDHQ9NXwkmWP'
const COMMON = { os: 'win', arch: 'x64', channel: 'nsis', locale: 'fr', install_week: '2026-W39', days_since_install: 3 }

let sent
let realFetch
beforeEach(() => {
  sent = []
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response('{}', { status: 200 })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function makeEnv() {
  const points = []
  return { points, env: { FLITDROP_TELEMETRY: { writeDataPoint: (p) => points.push(p) } } }
}

async function call(body, { country = 'FR', method = 'POST', path = '/e', env = {}, raw } = {}) {
  const waits = []
  const ctx = { waitUntil: (p) => waits.push(p) }
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (method === 'POST') init.body = raw ?? JSON.stringify(body)
  const req = new Request('https://telemetry.flitdrop.com' + path, init)
  req.cf = country ? { country } : undefined
  const res = await worker.fetch(req, env, ctx)
  await Promise.all(waits)
  return res
}

const env = (tier, event, props = {}, extra = {}) => ({ event, v: '0.7.0', ts: Date.now(), tier, props, ...extra })

test('basic : relayé vers PostHog EU sans identifiant ni profil', async () => {
  const res = await call(env('basic', 'app_daily_active', { ...COMMON, paired_devices: 5, launches_today: 2 }, { iid: 'should-be-ignored-123' }))
  assert.equal(res.status, 204)
  assert.equal(sent.length, 1)
  const { url, body } = sent[0]
  assert.equal(url, 'https://eu.i.posthog.com/i/v0/e/')
  assert.equal(body.api_key, NEW_KEY)
  assert.equal(body.event, 'app_daily_active')
  assert.match(body.distinct_id, /^[0-9a-f-]{36}$/)
  const p = body.properties
  assert.equal(p.$process_person_profile, false)
  assert.equal(p.$ip, null)
  assert.equal(p.$geoip_disable, true)
  assert.equal(p.source, 'desktop-app')
  assert.equal(p.app_version, '0.7.0')
  assert.equal(p.tier, 'basic')
  assert.equal(p.country, 'FR')
  assert.equal(p.paired_devices, 2)
  assert.equal(p.launches_today, 2)
  assert.equal(p.days_since_install, 3)
  assert.equal(p.install_week, '2026-W39')
  assert.ok(!JSON.stringify(body).includes('should-be-ignored'))
})

test('basic : deux évènements ont deux distinct_id différents', async () => {
  await call(env('basic', 'app_first_launch', COMMON))
  await call(env('basic', 'app_first_launch', COMMON))
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].body.distinct_id, sent[1].body.distinct_id)
})

test('basic : un évènement réservé à "full" est ignoré', async () => {
  for (const ev of ['welcome_shown', 'phone_connect', '$exception', 'telemetry_choice', 'app_open']) {
    const res = await call(env('basic', ev, { platform: 'ios' }))
    assert.equal(res.status, 204)
  }
  assert.equal(sent.length, 0)
})

test('full : distinct_id = hash stable de l\'iid, profil autorisé', async () => {
  await call(env('full', 'welcome_shown', COMMON, { iid: 'abc123-install' }))
  await call(env('full', 'transfer_ok', { direction: 'pc_to_phone', kind: 'photo', size: '1-10MB', first: true }, { iid: 'abc123-install' }))
  assert.equal(sent.length, 2)
  assert.equal(sent[0].body.distinct_id, sent[1].body.distinct_id)
  assert.match(sent[0].body.distinct_id, /^[0-9a-f]{8}$/)
  assert.equal(sent[0].body.properties.$process_person_profile, undefined)
  assert.equal(sent[1].body.properties.first, true)
  assert.equal(sent[1].body.properties.size, '1-10MB')
})

test('full sans iid valide : anonyme, sans profil', async () => {
  await call(env('full', 'history_opened', {}, { iid: 'anon' }))
  assert.equal(sent[0].body.properties.$process_person_profile, false)
})

test('tier inconnu ou évènement inconnu : ignoré', async () => {
  await call(env('premium', 'app_first_launch'))
  await call(env('basic', 'hack_me'))
  await call(env('full', 'hack_me', {}, { iid: 'abc123-install' }))
  assert.equal(sent.length, 0)
})

test('propriétés : clés inconnues retirées, types et valeurs contrôlés', async () => {
  await call(
    env('basic', 'transfer_ok', {
      ...COMMON,
      direction: 'sideways',
      kind: 'file',
      size: 123456,
      first: 'yes',
      file_name: 'secret.pdf',
      path: 'C:\\Users\\thomas\\a.txt',
      days_since_install: Infinity,
      os: 'x'.repeat(100),
      nested: { a: 1 },
    }),
  )
  const p = sent[0].body.properties
  assert.equal(p.kind, 'file')
  assert.equal(p.direction, undefined)
  assert.equal(p.size, undefined)
  assert.equal(p.first, undefined)
  assert.equal(p.file_name, undefined)
  assert.equal(p.path, undefined)
  assert.equal(p.nested, undefined)
  assert.equal(p.days_since_install, undefined)
  assert.equal(p.os.length, 40)
})

test('transfer_fail : raison nettoyée, status numérique', async () => {
  await call(env('basic', 'transfer_fail', { direction: 'phone_to_pc', kind: 'file', status: 507, reason: 'ENOSPC' }))
  await call(env('basic', 'transfer_fail', { direction: 'phone_to_pc', kind: 'file', status: '500', reason: "open 'C:\\Users\\thomas\\x.pdf'" }))
  await call(env('basic', 'transfer_fail', { direction: 'phone_to_pc', kind: 'file', status: NaN, reason: 'connect ECONNREFUSED 192.168.1.20' }))
  assert.equal(sent[0].body.properties.reason, 'ENOSPC')
  assert.equal(sent[0].body.properties.status, 507)
  assert.equal(sent[1].body.properties.reason, 'other')
  assert.equal(sent[1].body.properties.status, undefined)
  assert.equal(sent[2].body.properties.reason, 'other')
  assert.ok(!JSON.stringify(sent).includes('thomas'))
  assert.ok(!JSON.stringify(sent).includes('192.168'))
})

test('$exception : format PostHog, pile et message nettoyés et bornés', async () => {
  const stack =
    'Error: boom\n    at run (C:\\Users\\thomas\\AppData\\Local\\Flitdrop\\app.js:10:5)\n' +
    '    at x (/Users/thomas/dev/app.js:3:1)\n    at y (/home/marie/app.js:1:1)\n' +
    '    at fetch (http://192.168.1.5:8000/api?token=abc:4:2)\n' + 'z'.repeat(5000)
  await call(
    env(
      'full',
      '$exception',
      { $exception_type: 'TypeError', $exception_message: 'cannot read /Users/thomas/x from 10.0.0.2 ' + 'm'.repeat(400), $exception_stack_trace_raw: stack, source: 'server', handled: false },
      { iid: 'abc123-install' },
    ),
  )
  const p = sent[0].body.properties
  assert.equal(sent[0].body.event, '$exception')
  assert.equal(p.source, 'desktop-app')
  assert.equal(p.error_source, 'server')
  assert.equal(p.$exception_type, 'TypeError')
  assert.ok(p.$exception_message.length <= 300)
  assert.ok(p.$exception_stack_trace_raw.length <= 4000)
  assert.equal(p.$exception_list[0].type, 'TypeError')
  assert.equal(p.$exception_list[0].mechanism.handled, false)
  const all = JSON.stringify(p)
  for (const leak of ['thomas', 'marie', '192.168', '10.0.0.2', 'token=abc']) assert.ok(!all.includes(leak), leak)
  assert.ok(p.$exception_stack_trace_raw.includes('~\\AppData'))
  assert.ok(p.$exception_stack_trace_raw.includes('~/dev/app.js:3:1'))
})

test('$exception : pile découpée en frames pour Error tracking (plus ancien en premier)', async () => {
  const stack =
    'TypeError: boom\n' +
    '    at handle (C:\\Users\\thomas\\AppData\\Local\\Programs\\Flitdrop\\resources\\app.asar\\core\\flitdrop.cjs:12:3)\n' +
    '    at new Server (/Users/thomas/dev/app.asar/core/flitdrop.cjs:40:9)\n' +
    '    at /Users/thomas/dev/app.asar/main.cjs:7:1\n' +
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n' +
    'send@http://192.168.1.5:8000/phone/app.js?t=1:88:14'
  await call(
    env('full', '$exception', { $exception_type: 'TypeError', $exception_message: 'boom', $exception_stack_trace_raw: stack, source: 'main', handled: true }, { iid: 'abc123-install' }),
  )
  const st = sent[0].body.properties.$exception_list[0].stacktrace
  assert.equal(st.type, 'raw')
  const frames = st.frames
  assert.equal(frames.length, 5)
  // la frame qui a planté (première ligne de la pile V8) arrive en dernier
  assert.equal(frames[4].function, 'handle')
  assert.equal(frames[4].filename, '~\\AppData\\Local\\Programs\\Flitdrop\\resources\\app.asar\\core\\flitdrop.cjs')
  assert.equal(frames[4].lineno, 12)
  assert.equal(frames[4].colno, 3)
  assert.equal(frames[4].platform, 'custom')
  assert.equal(frames[4].lang, 'javascript')
  assert.equal(frames[4].in_app, true)
  assert.equal(frames[4].resolved, true)
  assert.equal(frames[3].function, 'new Server')
  assert.equal(frames[2].function, '?')
  assert.equal(frames[2].filename, '~/dev/app.asar/main.cjs')
  assert.equal(frames[1].in_app, false)
  assert.equal(frames[0].function, 'send')
  assert.equal(frames[0].filename, 'http://[ip]:8000/phone/app.js')
  assert.equal(frames[0].lineno, 88)
  assert.ok(!JSON.stringify(frames).includes('thomas'))

  // au plus 50 frames, et pas de stacktrace si rien n'est lisible
  sent = []
  const long = 'Error: x\n' + Array.from({ length: 80 }, (_, i) => `    at f${i} (a.js:${i + 1}:1)`).join('\n')
  await call(env('full', '$exception', { $exception_type: 'Error', $exception_stack_trace_raw: long }, { iid: 'abc123-install' }))
  const many = sent[0].body.properties.$exception_list[0].stacktrace.frames
  assert.equal(many.length, 50)
  assert.equal(many[49].function, 'f0')
  sent = []
  await call(env('full', '$exception', { $exception_type: 'Error', $exception_stack_trace_raw: 'no frames here' }, { iid: 'abc123-install' }))
  assert.equal(sent[0].body.properties.$exception_list[0].stacktrace, undefined)
})

test('ancien format (sans tier) : relayé en "full" avec hash historique', async () => {
  await call({ iid: 'legacy-install-1', v: '0.6.3', event: 'app_open', props: { os: 'mac' }, ts: Date.now() })
  await call({ iid: 'legacy-install-1', v: '0.6.3', event: 'phone_connect', props: { platform: 'iphone' }, ts: Date.now() })
  await call({ iid: 'legacy-install-1', v: '0.6.3', event: 'transfer_ok', props: { size: '<1MB', resumes: 1 }, ts: Date.now() })
  await call({ iid: 'legacy-install-1', v: '0.6.3', event: 'transfer_fail', props: { status: 0, reason: 'Failed to fetch' }, ts: Date.now() })
  await call({ iid: 'legacy-install-1', v: '0.6.3', event: 'app_first_launch', props: {}, ts: Date.now() })
  assert.equal(sent.length, 4)
  // même valeur que l'ancien Worker (FNV-1a de l'iid) : les personnes existantes gardent leur id
  const ids = new Set(sent.map((s) => s.body.distinct_id))
  assert.equal(ids.size, 1)
  for (const s of sent) {
    assert.equal(s.body.properties.tier, 'full')
    assert.equal(s.body.properties.legacy, true)
    assert.equal(s.body.properties.$process_person_profile, undefined)
  }
  assert.equal(sent[0].body.event, 'app_open')
  assert.equal(sent[0].body.properties.os, 'mac')
  assert.equal(sent[1].body.properties.platform, 'ios')
  assert.equal(sent[2].body.properties.direction, 'phone_to_pc')
  assert.equal(sent[2].body.properties.resumes, 1)
  assert.equal(sent[3].body.properties.reason, 'Failed to fetch')
})

test('hash historique identique à l\'ancien Worker', async () => {
  // valeur calculée avec la fonction stableHash de la version précédente du Worker
  const fnv = (str) => {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  await call({ iid: 'd2c1-0a9f-4b7e-9c11-abcd', v: '0.6.1', event: 'app_open', props: {} })
  assert.equal(sent[0].body.distinct_id, fnv('d2c1-0a9f-4b7e-9c11-abcd'))
})

test('Analytics Engine : écrit si la liaison existe, colonnes historiques en tête', async () => {
  const { env: e, points } = makeEnv()
  await call(env('basic', 'transfer_fail', { ...COMMON, direction: 'phone_to_pc', kind: 'file', status: 413, reason: 'too_big' }), { env: e })
  assert.equal(points.length, 1)
  const [event, os, version, status, reason, size, country, tier] = points[0].blobs
  assert.deepEqual([event, os, version, status, reason, size, country, tier], ['transfer_fail', 'win', '0.7.0', '413', 'too_big', '', 'FR', 'basic'])
  assert.deepEqual(points[0].indexes, ['transfer_fail'])
  assert.equal(points[0].doubles[1], 3)
})

test('Analytics Engine en panne : PostHog reçoit quand même', async () => {
  const e = { FLITDROP_TELEMETRY: { writeDataPoint: () => { throw new Error('down') } } }
  const res = await call(env('basic', 'app_first_launch', COMMON), { env: e })
  assert.equal(res.status, 204)
  assert.equal(sent.length, 1)
})

test('pays : seulement un code pays valide, jamais d\'IP', async () => {
  await call(env('basic', 'app_first_launch'), { country: 'fr-evil' })
  await call(env('basic', 'app_first_launch'), { country: '' })
  assert.equal(sent[0].body.properties.country, undefined)
  assert.equal(sent[1].body.properties.country, undefined)
  assert.equal(sent[0].body.properties.$ip, null)
})

test('horodatage : ts du client, ou maintenant si absurde', async () => {
  const past = Date.UTC(2026, 8, 20, 10, 0, 0)
  await call(env('basic', 'app_first_launch', {}, { ts: past }))
  await call(env('basic', 'app_first_launch', {}, { ts: Date.now() + 86400000 }))
  await call(env('basic', 'app_first_launch', {}, { ts: 'hier' }))
  assert.equal(sent[0].body.timestamp, new Date(past).toISOString())
  for (const s of sent.slice(1)) assert.ok(Math.abs(Date.parse(s.body.timestamp) - Date.now()) < 5000)
})

test('HTTP : CORS, méthodes, chemin, JSON invalide, taille', async () => {
  const opt = await call(null, { method: 'OPTIONS' })
  assert.equal(opt.status, 204)
  assert.equal(opt.headers.get('access-control-allow-origin'), '*')
  assert.equal(opt.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal((await call(null, { method: 'GET' })).status, 404)
  assert.equal((await call(env('basic', 'app_first_launch'), { path: '/x' })).status, 404)
  assert.equal((await call(null, { raw: '{not json' })).status, 400)
  const big = env('basic', 'app_first_launch', { os: 'x'.repeat(20000) })
  assert.equal((await call(big)).status, 413)
  assert.equal((await call(null, { raw: '[1,2]' })).status, 204)
  assert.equal((await call(null, { raw: 'null' })).status, 204)
  assert.equal(sent.length, 0)
})

test('aucune trace de l\'ancien projet PostHog US', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('phc_' + 'Bex8'))
  assert.ok(!src.includes('us.i.' + 'posthog.com'))
  assert.ok(!/[\u2013\u2014]/.test(src))
})
