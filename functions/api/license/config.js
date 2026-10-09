// Cloudflare Pages Function : GET /api/license/config
// Dit à l'app et à la page /pro si le mode payant est allumé, et avec quels réglages
// publics Paddle (jeton client, prix, remise de lancement). Jamais de secret.
// Mode payant éteint (LICENSE_ENABLED différent de "1" ou réglage manquant) :
// enabled: false, et l'app garde son comportement d'aujourd'hui.
// Fonctionnement complet : docs/licence.md
import { publicConfig } from '../../_lib/license/config.js'
import { json, methodNotAllowed } from '../../_lib/license/http.js'

export function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  // cache court : un changement de réglage se voit en une minute
  return json(publicConfig(env), 200, { 'cache-control': 'public, max-age=60' })
}
