// Licences Flitdrop Pro : état en mémoire de l'isolat Cloudflare.
// Ce dossier n'est pas routé par Pages (aucun fichier n'exporte de onRequest) :
// ce sont des modules partagés, importés par functions/api/license/*.
//
// Tout ce qui vit ici est perdu au redémarrage de l'isolat et n'est jamais partagé
// entre deux régions : limites anti-abus, petits caches, pause après un refus de
// Paddle. Rien d'essentiel n'en dépend, tout se reconstruit depuis Paddle.

export const state = {
  limits: new Map(), // clé de limite -> { n, reset }
  customerByCus: new Map(), // empreinte « cus » du jeton -> id client Paddle (ctm_...)
  recentScan: null, // { key, at, promise } : dernier balayage des transactions récentes
  usedNonces: new Map(), // défi de restauration déjà utilisé -> expiration (ms)
  paddlePausedUntil: 0, // après un 429 de Paddle : plus aucun appel avant cette date (ms)
  keys: new Map(), // clés WebCrypto importées, par secret
  mailsSent: { n: 0, reset: 0 }, // plafond global d'e-mails de restauration par isolat
}

// Pour les tests : repartir d'un isolat neuf.
export function resetLicenseState() {
  state.limits.clear()
  state.customerByCus.clear()
  state.recentScan = null
  state.usedNonces.clear()
  state.paddlePausedUntil = 0
  state.keys.clear()
  state.mailsSent = { n: 0, reset: 0 }
}
