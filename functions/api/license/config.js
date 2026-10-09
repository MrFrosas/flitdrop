// Cloudflare Pages Function : GET /api/license/config
// Dit à l'app et à la page /pro si le mode payant est allumé, et avec quels réglages
// publics Paddle (jeton client, prix, remise de lancement). Jamais de secret.
// Mode payant éteint (LICENSE_ENABLED différent de "1", réglage ou base D1 manquants,
// ou environnement servi sur le mauvais hôte : sandbox sur flitdrop.com, production
// ailleurs) : enabled: false, et l'app garde son comportement d'aujourd'hui.
// price = { currency, display, displayEarly } : prix localisé pour le pays du visiteur
// (aperçu Paddle demandé par notre serveur, en cache 6 h par pays) ; displayPrice et
// displayPriceEarly restent le tableau fixe de secours. storeEnabled : voir config.js.
// Fonctionnement complet : docs/licence.md
import { publicConfig, readLicenseEnv } from '../../_lib/license/config.js'
import { localizedPrice } from '../../_lib/license/price.js'
import { json, methodNotAllowed } from '../../_lib/license/http.js'

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  const price = await localizedPrice(readLicenseEnv(env, request), request)
  // cache court et privé : un changement de réglage se voit en une minute, et le prix
  // dépend du pays du visiteur (jamais partagé par un cache intermédiaire)
  return json(publicConfig(env, request, price), 200, { 'cache-control': 'private, max-age=60' })
}
