// Télémétrie minimale, anonyme et opt-in. N'envoie JAMAIS de contenu de fichier
// ni de presse-papiers : seulement des compteurs d'usage et des types d'erreur,
// pour détecter les pannes en conditions réelles. Silencieuse en cas d'échec.
//
// L'endpoint est le Worker Cloudflare de Flitdrop (voir docs/telemetry.md).
// Tant qu'il n'est pas déployé sur ce domaine, les envois échouent en silence.
const ENDPOINT = 'https://telemetry.flitdrop.com/e'
const IID_KEY = 'fd_iid'

let consent = false
let appVersion = ''

/** Identifiant d'installation anonyme et stable (aléatoire, non relié à l'user). */
function installId(): string {
  try {
    let id = localStorage.getItem(IID_KEY)
    if (!id) {
      id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).slice(0, 24)
      localStorage.setItem(IID_KEY, id)
    }
    return id
  } catch {
    return 'anon'
  }
}

export function initTelemetry(opts: { consent: boolean; version: string }) {
  consent = opts.consent === true
  appVersion = opts.version || ''
}

export function setTelemetryConsent(v: boolean) {
  consent = v
}

/** Envoie un évènement si l'utilisateur a consenti. `props` ne doit contenir
 *  que des métadonnées (types, compteurs), jamais de contenu utilisateur. */
export function track(event: string, props: Record<string, string | number> = {}): void {
  if (!consent) return
  const body = JSON.stringify({ iid: installId(), v: appVersion, event, props, ts: Date.now() })
  try {
    // sendBeacon survit à la fermeture de page ; fallback fetch keepalive
    if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    else void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {})
  } catch {
    // télémétrie non critique : jamais d'erreur remontée à l'utilisateur
  }
}

/** Bucket de taille pour ne jamais transmettre la taille exacte d'un fichier. */
export function sizeBucket(bytes: number): string {
  if (bytes < 1024 * 1024) return '<1MB'
  if (bytes < 10 * 1024 * 1024) return '1-10MB'
  if (bytes < 100 * 1024 * 1024) return '10-100MB'
  if (bytes < 1024 * 1024 * 1024) return '100MB-1GB'
  return '>1GB'
}
