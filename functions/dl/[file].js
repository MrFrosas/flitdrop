// Installeur Windows servi en direct : GET /dl/Flitdrop-Setup-<version>-store.exe
//
// Le Microsoft Store refuse une adresse de paquet qui redirige, et les fichiers
// des releases GitHub redirigent toujours (vers une adresse signée qui expire).
// Le dépôt flitdrop-dl (GitHub Pages) servait l'installeur sans redirection
// jusqu'à la 0.7.0, mais git refuse un fichier de plus de 100 Mo (0.7.1 : 110 Mo).
// Ici, le site suit la redirection lui-même et renvoie les octets de la release,
// identiques au fichier signé : un seul nom accepté, une seule source.
//
// « -store » dans le nom : l'installeur se range alors dans le canal « store »
// des statistiques (apps/desktop/build/installer.nsh).

const NAME = /^Flitdrop-Setup-(\d{1,3}\.\d{1,3}\.\d{1,3})(-store)?\.exe$/
const REPO = 'https://github.com/MrFrosas/flitdrop/releases/download'

export async function onRequest({ request, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const file = String(params.file || '')
  const m = NAME.exec(file)
  if (!m) return new Response('Not found', { status: 404 })
  const version = m[1]

  const headers = new Headers()
  const range = request.headers.get('range')
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.set('range', range)
  const upstream = await fetch(`${REPO}/v${version}/Flitdrop-Setup-${version}.exe`, {
    method: request.method,
    headers,
    redirect: 'follow',
  })
  if (upstream.status !== 200 && upstream.status !== 206) {
    return new Response('Not found', { status: upstream.status === 404 ? 404 : 502 })
  }

  const out = new Headers({
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${file}"`,
    'accept-ranges': 'bytes',
    // une version publiée ne change jamais
    'cache-control': 'public, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
  })
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out })
}
