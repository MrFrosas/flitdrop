// Worker Cloudflare pour la télémétrie Flitdrop (https://telemetry.flitdrop.com/e).
// Reçoit un évènement par requête, envoyé par la partie Node de l'app (serveur
// core ou processus principal Electron), le valide strictement puis :
//   1. l'écrit dans Analytics Engine si la liaison existe (interrogeable en SQL),
//   2. le recopie dans PostHog, projet « Flitdrop » sur le cloud EU.
//
// Déploiement et description complète des évènements : voir ../docs/telemetry.md
//
// Deux niveaux (champ "tier" de l'enveloppe) :
//   - "basic" : statistiques de fonctionnement anonymes, actives par défaut et
//     désactivables dans les Réglages. Aucun identifiant : chaque évènement part
//     avec un distinct_id aléatoire neuf et sans profil de personne.
//   - "full"  : seulement après accord explicite de l'utilisateur. Porte l'iid
//     (aléatoire local) ; distinct_id = hash stable de l'iid.
// Une enveloppe sans "tier" vient d'une version déjà publiée (0.5 à 0.6.3), qui
// n'envoyait que si l'utilisateur avait coché la case : on la traite en "full"
// (ancien format) pour que ces installations continuent de remonter.
//
// Confidentialité : jamais de contenu, de nom de fichier, de chemin, de nom
// d'appareil ni d'adresse IP. Le pays vient de Cloudflare (request.cf.country),
// l'IP du client n'est jamais transmise, et on demande à PostHog de ne pas
// géolocaliser le Worker ($ip nul, $geoip_disable).

// Clé PostHog PUBLIQUE (phc_, prévue pour être embarquée côté client, sans risque).
const POSTHOG_KEY = 'phc_urqVGgN2XuWcGdkBGagawWbaPRU88HxosDHQ9NXwkmWP'
const POSTHOG_ENDPOINT = 'https://eu.i.posthog.com/i/v0/e/'

// Taille maximale d'un corps de requête (un évènement fait quelques centaines d'octets,
// une exception avec sa pile tient sous 5 Ko).
const MAX_BODY = 16 * 1024

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
}

// --- Types de propriétés -----------------------------------------------------
// Chaque propriété autorisée a un type ; une valeur du mauvais type est ignorée.
const str = (max = 40) => ({ kind: 'str', max })
const oneOf = (...values) => ({ kind: 'enum', values: new Set(values) })
const COUNT = { kind: 'count' } // entier fini >= 0
const INT = { kind: 'int' } // entier fini
const BOOL = { kind: 'bool' }
const REASON = { kind: 'reason' } // catégorie d'erreur courte, nettoyée
const PAIRED = { kind: 'paired' } // 0, 1 ou 2 (2 = deux ou plus)

const DIRECTION = oneOf('phone_to_pc', 'pc_to_phone')
const KIND = oneOf('file', 'photo', 'text', 'clipboard')
const SIZE = oneOf('<1MB', '1-10MB', '10-100MB', '100MB-1GB', '>1GB')
const PLATFORM = oneOf('ios', 'android', 'other')

// Propriétés communes, acceptées sur tous les évènements des deux niveaux.
const COMMON_PROPS = {
  os: str(),
  arch: str(),
  channel: str(),
  locale: str(),
  install_week: str(),
  days_since_install: COUNT,
}

// Évènements du niveau "basic" (autorisés aussi en "full"), avec leurs propriétés.
const BASIC_EVENTS = {
  app_first_launch: {},
  app_updated: { from_version: str(16) },
  app_daily_active: { paired_devices: PAIRED, launches_today: COUNT },
  pairing_success: { platform: PLATFORM, first: BOOL },
  transfer_ok: { direction: DIRECTION, kind: KIND, size: SIZE, first: BOOL },
  transfer_fail: { direction: DIRECTION, kind: KIND, status: INT, reason: REASON },
  // évènement de contrôle après un déploiement (voir docs/telemetry.md)
  worker_deploy_test: {},
}

// Évènements réservés au niveau "full" (ignorés si tier != "full").
const FULL_ONLY_EVENTS = {
  welcome_shown: {},
  welcome_pair_clicked: {},
  welcome_skipped: {},
  pair_qr_shown: {},
  pair_link_copied: {},
  phone_connect: { platform: PLATFORM },
  settings_changed: { key: str() },
  history_opened: {},
  telemetry_choice: { choice: oneOf('full', 'basic_only', 'none'), where: oneOf('welcome', 'prompt', 'settings') },
  // format attendu par le suivi d'erreurs de PostHog
  $exception: {
    $exception_type: str(),
    $exception_message: { kind: 'scrubbed', max: 300 },
    $exception_stack_trace_raw: { kind: 'scrubbed', max: 4000 },
    source: oneOf('main', 'server', 'desktop', 'phone'),
    handled: BOOL,
  },
}

// Ancien format (versions 0.5 à 0.6.3, sans "tier", envoyé seulement avec accord).
// Les transferts de ces versions partaient toujours du téléphone vers le PC.
const LEGACY_EVENTS = {
  app_open: { os: str() },
  phone_connect: { platform: str() },
  transfer_ok: { size: SIZE, resumes: COUNT },
  transfer_fail: { status: INT, reason: REASON },
}

// --- Outils ------------------------------------------------------------------

// Hash de chaine simple et deterministe (FNV-1a 32 bits) rendu en hex court.
// Inchangé depuis la première version : une installation qui avait déjà donné
// son accord garde le même distinct_id dans PostHog.
function stableHash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Retire d'un texte d'erreur ce qui pourrait désigner une personne ou une machine :
// dossier personnel (remplacé par ~), chaines de requête, adresses e-mail et IP.
// Le client nettoie déjà ; on refait le travail ici par sécurité.
function scrub(text) {
  return text
    .replace(/[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s'"`)]+/gi, '~')
    .replace(/\/(?:Users|home)\/[^/\s'"`)]+/g, '~')
    .replace(/\?[^\s'"`):]*/g, '')
    // domaine sans "/" ni ":" : une frame Safari/Firefox "fn@http://..." n'est pas une adresse
    .replace(/[^\s@'"`<>()]+@[^\s@'"`<>()/:]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]')
}

// Catégorie d'erreur : un code court. Tout ce qui ressemble à un chemin, une
// adresse ou un message libre trop riche devient "other".
function cleanReason(v) {
  if (typeof v !== 'string') return undefined
  const s = scrub(v.trim()).slice(0, 40)
  if (!s) return undefined
  if (/[\\/@:'"`]/.test(s) || s.includes('[ip]') || s.includes('[email]') || s.startsWith('~')) return 'other'
  return s
}

function cleanValue(spec, v) {
  switch (spec.kind) {
    case 'str':
      return typeof v === 'string' && v ? v.slice(0, spec.max) : undefined
    case 'scrubbed':
      return typeof v === 'string' && v ? scrub(v).slice(0, spec.max) : undefined
    case 'enum':
      return spec.values.has(v) ? v : undefined
    case 'count':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
    case 'int':
      return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined
    case 'bool':
      return typeof v === 'boolean' ? v : undefined
    case 'reason':
      return cleanReason(v)
    case 'paired':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(2, Math.floor(v)) : undefined
    default:
      return undefined
  }
}

// Ne garde que les clés prévues pour cet évènement (plus les communes), au bon type.
function cleanProps(raw, allowed) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, spec] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = cleanValue(spec, raw[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

// Identifiant d'installation : aléatoire local, accepté seulement s'il en a la forme.
function cleanIid(v) {
  if (typeof v !== 'string') return null
  const s = v.slice(0, 40)
  if (s === 'anon' || !/^[A-Za-z0-9_-]{4,40}$/.test(s)) return null
  return s
}

function legacyPlatform(p) {
  if (p === 'iphone' || p === 'ipad' || p === 'ios') return 'ios'
  if (p === 'android') return 'android'
  return 'other'
}

// Transforme l'enveloppe reçue en évènement propre, ou null si elle doit être ignorée.
function normalize(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null
  const event = typeof e.event === 'string' ? e.event : ''
  const version = typeof e.v === 'string' ? e.v.slice(0, 16) : ''
  const now = Date.now()
  // horodatage du client, sauf s'il est absurde (dans le futur au-delà de 10 min)
  const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0 && e.ts < now + 10 * 60 * 1000 ? e.ts : now

  // ancien format : pas de "tier", évènements historiques uniquement
  if (!('tier' in e)) {
    const allowed = LEGACY_EVENTS[event]
    if (!allowed) return null
    const props = cleanProps(e.props, allowed)
    if (event === 'phone_connect') props.platform = legacyPlatform(e.props?.platform)
    if (event === 'transfer_ok' || event === 'transfer_fail') {
      props.direction = 'phone_to_pc'
      props.kind = 'file'
    }
    props.legacy = true
    return { event, version, ts, tier: 'full', iid: cleanIid(e.iid), props }
  }

  const tier = e.tier
  if (tier !== 'basic' && tier !== 'full') return null
  const specific = BASIC_EVENTS[event] ?? (tier === 'full' ? FULL_ONLY_EVENTS[event] : undefined)
  if (!specific) return null
  const props = cleanProps(e.props, { ...COMMON_PROPS, ...specific })
  // "basic" ne porte jamais d'identifiant, même si le client en envoie un
  const iid = tier === 'full' ? cleanIid(e.iid) : null
  return { event, version, ts, tier, iid, props }
}

// Découpe une pile déjà nettoyée en frames pour l'onglet Error tracking de
// PostHog, qui ne lit que $exception_list[].stacktrace.frames (la pile brute
// seule ne donne ni frames ni regroupement fin). Deux formats connus :
// V8 (Node, Electron, Chrome) "at fn (fichier:12:3)" ou "at fichier:12:3", et
// Safari/Firefox "fn@fichier:12:3". Les lignes illisibles sont ignorées.
const MAX_FRAMES = 50
const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\((.+?)(?::(\d+))?(?::(\d+))?\)|(.+?)(?::(\d+))?(?::(\d+))?)\s*$/
const GECKO_FRAME = /^\s*(.*?)@(.+?)(?::(\d+))?(?::(\d+))?\s*$/

function parseFrame(line) {
  let m = V8_FRAME.exec(line)
  let fn, file, lineno, colno
  if (m) {
    if (m[2] !== undefined) [fn, file, lineno, colno] = [m[1], m[2], m[3], m[4]]
    else [fn, file, lineno, colno] = [undefined, m[5], m[6], m[7]]
  } else if ((m = GECKO_FRAME.exec(line)) && !/\s/.test(m[2])) {
    ;[fn, file, lineno, colno] = [m[1], m[2], m[3], m[4]]
  } else {
    return null
  }
  const frame = {
    platform: 'custom',
    lang: 'javascript',
    function: (fn ?? '').trim().slice(0, 200) || '?',
    filename: file.trim().slice(0, 300),
    // code de Node ou d'Electron lui-même : pas le nôtre
    in_app: !/^(?:node:|internal[\\/]|electron[\\/]js2c|native$)|node_modules/.test(file.trim()),
    resolved: true,
  }
  if (lineno !== undefined) frame.lineno = Number(lineno)
  if (colno !== undefined) frame.colno = Number(colno)
  return frame
}

function stackFrames(stack) {
  if (typeof stack !== 'string' || !stack) return []
  const frames = []
  for (const line of stack.split('\n')) {
    const f = parseFrame(line)
    if (f) frames.push(f)
    if (frames.length >= MAX_FRAMES) break
  }
  // V8 et les navigateurs listent l'appel le plus récent en premier ; PostHog
  // attend l'ordre inverse (le plus ancien en premier, celui qui a planté en dernier)
  return frames.reverse()
}

function randomId() {
  return crypto.randomUUID()
}

const empty = (status = 204) => new Response(null, { status, headers: CORS })

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return empty(204)
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/e') {
      return new Response('Flitdrop telemetry', { status: 404, headers: CORS })
    }

    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY) return empty(413)
    let text
    try {
      text = await request.text()
    } catch {
      return empty(400)
    }
    if (text.length > MAX_BODY) return empty(413)
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      return new Response('bad json', { status: 400, headers: CORS })
    }

    const ev = normalize(raw)
    // évènement inconnu ou mal formé : ignoré proprement (le client n'a rien à corriger)
    if (!ev) return empty(204)

    const cf = request.cf ?? {}
    const country = typeof cf.country === 'string' && /^[A-Z0-9]{2}$/.test(cf.country) ? cf.country : ''

    // distinct_id : hash stable de l'iid en "full" ; sinon un aléatoire neuf par
    // évènement, sans profil de personne (impossible de relier deux évènements).
    const identified = ev.tier === 'full' && ev.iid !== null
    const distinctId = identified ? stableHash(ev.iid) : randomId()

    // 1. Analytics Engine (SQL), si la liaison est configurée. Les 7 premières
    // colonnes gardent l'ordre historique pour ne pas casser les requêtes existantes.
    if (env?.FLITDROP_TELEMETRY) {
      try {
        const p = ev.props
        env.FLITDROP_TELEMETRY.writeDataPoint({
          blobs: [
            ev.event,
            String(p.os ?? ''),
            ev.version,
            p.status === undefined ? '' : String(p.status),
            String(p.reason ?? ''),
            String(p.size ?? ''),
            country,
            ev.tier,
            String(p.direction ?? ''),
            String(p.kind ?? ''),
            String(p.channel ?? ''),
            String(p.locale ?? ''),
            String(p.install_week ?? ''),
          ],
          doubles: [1, typeof p.days_since_install === 'number' ? p.days_since_install : -1],
          indexes: [identified ? distinctId : ev.event],
        })
      } catch {
        // stockage secondaire : une erreur ici ne doit pas empêcher PostHog
      }
    }

    // 2. PostHog (projet EU). Le Worker appelle PostHog lui-même : l'IP du client
    // ne quitte jamais Cloudflare.
    const properties = {
      ...ev.props,
      source: 'desktop-app',
      app_version: ev.version,
      tier: ev.tier,
      $lib: 'flitdrop-telemetry-worker',
      $ip: null,
      $geoip_disable: true,
    }
    if (ev.event === '$exception') {
      // "source" reste "desktop-app" comme partout ; l'endroit où l'erreur est
      // née (main, server, desktop, phone) passe dans "error_source"
      if (ev.props.source !== undefined) properties.error_source = ev.props.source
      properties.$exception_level = 'error'
      const entry = {
        type: ev.props.$exception_type ?? 'Error',
        value: ev.props.$exception_message ?? '',
        mechanism: { handled: ev.props.handled === true, synthetic: false, type: 'generic' },
      }
      // la pile déjà nettoyée et bornée, découpée en frames
      const frames = stackFrames(ev.props.$exception_stack_trace_raw)
      if (frames.length) entry.stacktrace = { type: 'raw', frames }
      properties.$exception_list = [entry]
    }
    if (country) properties.country = country
    if (!identified) properties.$process_person_profile = false

    ctx.waitUntil(
      fetch(POSTHOG_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event: ev.event,
          distinct_id: distinctId,
          timestamp: new Date(ev.ts).toISOString(),
          properties,
        }),
      }).catch(() => {}),
    )

    return empty(204)
  },
}
