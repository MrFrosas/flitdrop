// Cloudflare Pages Function : POST /api/telemetry
// Collecteur des statistiques de l'app (versions 0.6.4 et plus), déployé avec le
// site à chaque push sur main. Même code que le Worker telemetry.flitdrop.com
// (telemetry-worker/worker.js), qui reste en place pour les anciennes versions :
// validation stricte par niveau, jamais d'adresse IP, relais vers PostHog (UE).
import collector from '../../telemetry-worker/worker.js'

export function onRequest({ request, env, waitUntil }) {
  return collector.fetch(request, env, { waitUntil })
}
