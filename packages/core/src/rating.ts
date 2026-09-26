import type { Config } from './config.js'

// Demande de note sur le PC : une petite carte dans la fenêtre (jamais une
// fenêtre surgissante), après le 3e transfert réussi. « Noter » : plus jamais.
// « Plus tard » : une seule autre fois, 20 transferts réussis plus tard, puis
// plus jamais. Tout est gardé dans la config, rien ne part sur internet.

/** Transferts réussis avant la première demande. */
export const RATE_FIRST = 3
/** Transferts réussis de plus avant la seconde (et dernière) demande. */
export const RATE_AGAIN = 20

/** Nombre de transferts réussis à atteindre pour la demande en cours, ou
 *  null quand plus aucune demande n'est prévue. */
function rateTarget(cfg: Config): number | null {
  if (cfg.rateState === 'done') return null
  if (cfg.rateState === 'later') return cfg.rateLaterAt + RATE_AGAIN
  return RATE_FIRST
}

/** La carte « Flitdrop t'aide ? Laisse une note » est-elle à montrer ? */
export function ratingDue(cfg: Config): boolean {
  const target = rateTarget(cfg)
  return target !== null && cfg.okTransfers >= target
}

/** Un transfert de plus a réussi. Le compteur ne bouge que tant qu'une
 *  demande reste à venir, et s'arrête dès qu'elle est due : `changed` dit s'il
 *  faut enregistrer la config, `due` si la carte vient de devenir due. */
export function countTransfer(cfg: Config): { changed: boolean; due: boolean } {
  const target = rateTarget(cfg)
  if (target === null || cfg.okTransfers >= target) return { changed: false, due: false }
  cfg.okTransfers++
  return { changed: true, due: cfg.okTransfers >= target }
}

/** Réponse à la carte. Rend false pour une réponse inconnue ou quand la
 *  carte n'était pas due (rien ne change alors). */
export function answerRating(cfg: Config, action: unknown): boolean {
  if (!ratingDue(cfg)) return false
  if (action === 'rate') {
    cfg.rateState = 'done'
    return true
  }
  if (action === 'later') {
    if (cfg.rateState === 'later') {
      cfg.rateState = 'done'
    } else {
      cfg.rateState = 'later'
      cfg.rateLaterAt = cfg.okTransfers
    }
    return true
  }
  return false
}
