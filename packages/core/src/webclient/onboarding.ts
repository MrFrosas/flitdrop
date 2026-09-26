// Petites règles du premier usage, partagées par les pages du PC et du
// téléphone. Sans DOM, pour être testées (test/onboarding.test.ts).

// ---------- code d'appairage (page du PC) ----------

/** Le code est remplacé 30 s avant d'expirer : un téléphone qui scanne au
 *  dernier moment a encore le temps de finir avec l'ancien. */
export const PAIR_RENEW_BEFORE_MS = 30_000

/** Où en est le code affiché : à remplacer maintenant, ou dans combien de
 *  temps (ms). */
export function pairCodeState(now: number, expiresAt: number): { renewNow: boolean; renewInMs: number } {
  const renewInMs = expiresAt - PAIR_RENEW_BEFORE_MS - now
  return renewInMs <= 0 ? { renewNow: true, renewInMs: 0 } : { renewNow: false, renewInMs }
}

/** Compte à rebours « 2:05 » (minutes:secondes, arrondi à la seconde du
 *  dessus pour ne jamais afficher 0:00 avant l'heure). */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---------- erreur de connexion (page du téléphone) ----------

export type ConnectError = 'expired' | 'revoked' | 'wrongPc' | 'notFound'

/** Message à montrer quand le premier échange avec le PC échoue.
 *  `fresh` : la page vient d'arriver avec un code d'appairage neuf (QR scanné
 *  ou lien collé) que ce téléphone n'avait pas encore. Un PC redémarré a
 *  oublié ses codes expirés : un code neuf refusé est alors aussi un code
 *  expiré, sauf depuis l'icône de l'écran d'accueil (appairage déjà fait). */
export function connectError(o: { status?: number; code?: string; fresh: boolean; standalone: boolean }): ConnectError {
  if (o.code === 'pairingExpired') return 'expired'
  if (o.status === 409) return 'wrongPc'
  if (o.status === 403) return o.code === 'deviceUnknown' && o.fresh && !o.standalone ? 'expired' : 'revoked'
  return 'notFound'
}

// ---------- icône d'écran d'accueil (page du téléphone) ----------

/** L'icône n'est proposée qu'après un premier transfert réussi, jamais dans
 *  l'app déjà installée, et plus après « ✕ ». */
export function shouldSuggestInstall(o: { standalone: boolean; dismissed: boolean; firstTransferDone: boolean }): boolean {
  return !o.standalone && !o.dismissed && o.firstTransferDone
}
