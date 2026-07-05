// Worker Cloudflare pour la télémétrie Flitdrop.
// Reçoit des évènements anonymes (usage + types d'erreur, jamais de contenu) et :
//   1. les écrit dans Analytics Engine (interrogeable en SQL),
//   2. les recopie dans PostHog (même tableau de bord que le site : entonnoir
//      installé -> actif, interface prête à l'emploi).
//
// Déploiement : voir ../docs/telemetry.md
//
// Confidentialité : on ne stocke ni IP brute ni contenu. L'identifiant
// d'installation (iid) est un aléatoire généré côté client, non relié à une
// personne. Les tailles de fichier sont des tranches ("1-10MB"), pas des octets.

// Clé PostHog PUBLIQUE (phc_, prévue pour être embarquée côté client, sans risque).
const POSTHOG_KEY = 'phc_Bex8SoGTP3KQyVriFMzVChHugFgtkF6LYmjgJbYi6min'
const POSTHOG_ENDPOINT = 'https://us.i.posthog.com/capture/'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

// Seuls ces noms d'évènements sont traités ; tout le reste est ignoré (anti-abus).
const ALLOWED_EVENTS = new Set([
  'app_open',
  'phone_connect',
  'transfer_ok',
  'transfer_fail',
  'worker_deploy_test',
])

// Hash de chaine simple et deterministe (FNV-1a 32 bits) rendu en hex court.
// Sert a borner la cardinalite : on n'indexe jamais la valeur brute du client.
function stableHash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const ok = (status = 204) => new Response(null, { status, headers: CORS })

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/e') {
      return new Response('Flitdrop telemetry', { status: 404, headers: CORS })
    }
    let e
    try {
      e = await request.json()
    } catch {
      return new Response('bad json', { status: 400, headers: CORS })
    }
    // validation stricte : on ignore tout ce qui n'est pas attendu
    const iid = typeof e.iid === 'string' ? e.iid.slice(0, 40) : 'anon'
    const version = typeof e.v === 'string' ? e.v.slice(0, 16) : ''
    const event = typeof e.event === 'string' ? e.event.slice(0, 40) : 'unknown'
    // allowlist : on ignore proprement tout évènement non prévu (renvoie ok)
    if (!ALLOWED_EVENTS.has(event)) return ok(204)
    // identifiant borné : hash stable de l'iid (jamais la valeur brute du client)
    const iidHash = stableHash(iid)
    const props = e.props && typeof e.props === 'object' ? e.props : {}
    const os = String(props.os ?? props.platform ?? '').slice(0, 16)
    const status = String(props.status ?? '').slice(0, 16)
    const reason = String(props.reason ?? '').slice(0, 60)
    const size = String(props.size ?? '').slice(0, 16)
    const country = request.cf?.country ?? ''
    const ts = typeof e.ts === 'number' && isFinite(e.ts) ? e.ts : Date.now()

    // 1. Analytics Engine (SQL)
    if (env.FLITDROP_TELEMETRY) {
      env.FLITDROP_TELEMETRY.writeDataPoint({
        blobs: [event, os, version, status, reason, size, country],
        doubles: [1],
        indexes: [iidHash],
      })
    }

    // 2. Miroir PostHog (tableau de bord unifié avec le site). distinct_id =
    // hash de l'iid : entonnoirs par installation (installé -> actif -> ...),
    // cardinalité bornée et funnels stables.
    ctx.waitUntil(
      fetch(POSTHOG_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event,
          distinct_id: iidHash,
          timestamp: new Date(ts).toISOString(),
          properties: {
            source: 'desktop-app',
            $lib: 'flitdrop-telemetry-worker',
            app_version: version,
            os,
            ...(status ? { status } : {}),
            ...(reason ? { reason } : {}),
            ...(size ? { size } : {}),
            ...(country ? { country } : {}),
          },
        }),
      }).catch(() => {}),
    )

    return new Response('ok', { headers: CORS })
  },
}
