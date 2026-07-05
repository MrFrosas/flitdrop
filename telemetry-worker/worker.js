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
        indexes: [iid],
      })
    }

    // 2. Miroir PostHog (tableau de bord unifié avec le site). distinct_id = iid
    // permet les entonnoirs par installation (installé -> actif -> ...).
    ctx.waitUntil(
      fetch(POSTHOG_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event,
          distinct_id: iid,
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
