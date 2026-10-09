// Licences Flitdrop Pro : état en mémoire de l'isolat Cloudflare.
// Ce dossier n'est pas routé par Pages (aucun fichier n'exporte de onRequest) :
// ce sont des modules partagés, importés par functions/api/license/*.
//
// Tout ce qui vit ici est perdu au redémarrage de l'isolat et n'est jamais partagé
// entre deux régions : premières limites anti-abus (par IP), petits caches, pause
// après un refus de Paddle. Ce qui doit tenir entre isolats (appareils, codes déjà
// utilisés, plafonds par adresse et par jour) vit dans la base D1 (db.js).

export const state = {
  limits: new Map(), // clé de limite -> { n, reset }
  recentScan: null, // { key, at, promise } : dernier balayage des transactions récentes
  paddlePausedUntil: 0, // après un 429 de Paddle : plus aucun appel avant cette date (ms)
  keys: new Map(), // clés WebCrypto importées, par secret
  schemaReady: null, // promesse de création des tables D1 (une fois par isolat)
  lastCleanup: 0, // dernier ménage des lignes expirées de la base (ms)
}

// Pour les tests : repartir d'un isolat neuf.
export function resetLicenseState() {
  state.limits = new Map()
  state.recentScan = null
  state.paddlePausedUntil = 0
  state.keys.clear()
  state.schemaReady = null
  state.lastCleanup = 0
}
