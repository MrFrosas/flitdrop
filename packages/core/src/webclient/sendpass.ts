// Envoi des morceaux d'un fichier, plusieurs à la fois (page du téléphone).
// Séparé de phone.ts pour être testé sous Node.
//
// Nombre de morceaux en route (« voies ») : jusqu'à `max` quand le lien tient.
// Après une coupure, la moitié : sur un wifi très lent, 4 morceaux de 8 Mo
// qui se partagent le débit n'arrivaient jamais au bout du délai du PC et
// repartaient de zéro sans fin. Trois morceaux réussis d'affilée rendent une
// voie, jusqu'à revenir à `max`.

export interface Lanes {
  lanes: number
  okStreak: number
}

/** Une passe : les morceaux pas encore confirmés, `st.lanes` à la fois, chacun
 *  remplacé dès qu'il est confirmé. À la première erreur on n'en lance plus,
 *  on attend ceux en route, et on rend les erreurs (vide : tout est passé). */
export function runPass<F>(
  chunks: number,
  acked: Set<number>,
  st: Lanes,
  max: number,
  sendOne: (n: number) => Promise<void>,
  toFail: (e: unknown) => F
): Promise<F[]> {
  return new Promise((resolve) => {
    const fails: F[] = []
    let cursor = 0
    let active = 0
    const launch = () => {
      while (active < st.lanes && fails.length === 0) {
        while (cursor < chunks && acked.has(cursor)) cursor++
        if (cursor >= chunks) break
        const n = cursor++
        active++
        sendOne(n)
          .then(
            () => {
              // le lien tient de nouveau : une voie de plus
              if (++st.okStreak >= 3 && st.lanes < max) {
                st.lanes++
                st.okStreak = 0
              }
            },
            (e: unknown) => {
              fails.push(toFail(e))
            }
          )
          .finally(() => {
            active--
            launch()
          })
      }
      if (active === 0) resolve(fails)
    }
    launch()
  })
}

/** Après une coupure : moitié moins de morceaux à la fois (au moins un). */
export function afterFailure(st: Lanes): void {
  st.lanes = Math.max(1, Math.ceil(st.lanes / 2))
  st.okStreak = 0
}
