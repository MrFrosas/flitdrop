// Cloudflare Pages Function : relais PostHog sur le même domaine, /ph/*
// Le site parle à PostHog via flitdrop.com/ph (api_host dans js/analytics.js) :
// les bloqueurs de publicité ne coupent plus la mesure et aucun domaine tiers
// n'apparaît dans le navigateur. Projet PostHog « Flitdrop », hébergé dans l'UE.
//   /ph/static/*               ->  eu-assets.i.posthog.com  (bibliothèque versionnée, mise en cache)
//   /ph/array/*                ->  eu-assets.i.posthog.com  (config distante : jamais mise en cache ici,
//                                   sinon un réglage changé dans PostHog, comme les replays, reste invisible)
//   tout le reste sous /ph/*   ->  eu.i.posthog.com         (événements, replays, drapeaux)
// Les cookies et l'en-tête Authorization ne sont jamais transmis, et aucun
// Set-Cookie ne revient au navigateur. L'adresse IP du visiteur est passée en
// X-Forwarded-For (sinon PostHog verrait celle de Cloudflare) : elle sert au
// comptage sans cookie (hachage côté serveur) et au pays, puis PostHog l'efface
// (réglage « anonymize IPs » du projet). Même origine : pas de CORS à gérer.

const API_HOST = 'eu.i.posthog.com'
const ASSET_HOST = 'eu-assets.i.posthog.com'

// en-têtes de réponse à ne pas relayer
const DROP_RESPONSE = ['set-cookie', 'alt-svc']

function cleanResponse(res) {
  const headers = new Headers(res.headers)
  for (const h of DROP_RESPONSE) headers.delete(h)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function retrieveAsset(request, pathWithSearch, waitUntil, cacheable) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  if (!cacheable) {
    const res = cleanResponse(await fetch(`https://${ASSET_HOST}${pathWithSearch}`, { method: request.method }))
    // « private » : le TTL navigateur de la zone Cloudflare (4 h) ne s'applique pas
    res.headers.set('Cache-Control', 'private, max-age=300')
    return res
  }
  const cache = caches.default
  const cached = await cache.match(request)
  if (cached) return cached
  const res = cleanResponse(await fetch(`https://${ASSET_HOST}${pathWithSearch}`, { method: request.method }))
  if (res.ok && request.method === 'GET') waitUntil(cache.put(request, res.clone()))
  return res
}

async function forwardRequest(request, pathWithSearch) {
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('authorization')
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '')
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const res = await fetch(`https://${API_HOST}${pathWithSearch}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : null,
    redirect: 'manual',
  })
  return cleanResponse(res)
}

export async function onRequest({ request, waitUntil }) {
  const url = new URL(request.url)
  // /ph/e/?ip=0 -> /e/?ip=0 ; /ph seul -> /
  const path = url.pathname.replace(/^\/ph(?=\/|$)/, '') || '/'
  const pathWithSearch = path + url.search
  try {
    if (path.startsWith('/static/') || path.startsWith('/array/'))
      return await retrieveAsset(request, pathWithSearch, waitUntil, path.startsWith('/static/'))
    return await forwardRequest(request, pathWithSearch)
  } catch {
    return new Response(null, { status: 502 })
  }
}
