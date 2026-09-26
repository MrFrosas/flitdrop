import { describe, it, expect } from 'vitest'
import { runPass, afterFailure, type Lanes } from '../src/webclient/sendpass.js'

const tick = () => new Promise((r) => setTimeout(r, 1))

describe('envoi des morceaux, plusieurs à la fois', () => {
  it('envoie chaque morceau manquant une fois, jamais plus de 4 à la fois', async () => {
    const acked = new Set([2, 5])
    const sent: number[] = []
    let active = 0
    let peak = 0
    const st: Lanes = { lanes: 4, okStreak: 0 }
    const fails = await runPass(
      10,
      acked,
      st,
      4,
      async (n) => {
        active++
        peak = Math.max(peak, active)
        await tick()
        sent.push(n)
        acked.add(n)
        active--
      },
      (e) => e
    )
    expect(fails).toEqual([])
    expect(sent.sort((a, b) => a - b)).toEqual([0, 1, 3, 4, 6, 7, 8, 9])
    expect(peak).toBe(4)
  })

  it('à la première erreur : plus rien de neuf, on attend ceux en route et on rend l’erreur', async () => {
    const acked = new Set<number>()
    const started: number[] = []
    const fails = await runPass(
      20,
      acked,
      { lanes: 4, okStreak: 0 },
      4,
      async (n) => {
        started.push(n)
        await tick()
        if (n === 1) throw new Error('coupure')
        acked.add(n)
      },
      (e) => (e as Error).message
    )
    expect(fails).toEqual(['coupure'])
    expect(started.length).toBeLessThanOrEqual(5)
    expect(acked.has(1)).toBe(false)
  })

  it('lien qui lâche : moitié moins de voies, puis une de plus tous les 3 morceaux réussis', async () => {
    const st: Lanes = { lanes: 4, okStreak: 0 }
    afterFailure(st)
    expect(st.lanes).toBe(2)
    afterFailure(st)
    afterFailure(st)
    expect(st.lanes).toBe(1)
    const acked = new Set<number>()
    const seen: number[] = []
    await runPass(
      12,
      acked,
      st,
      4,
      async (n) => {
        seen.push(st.lanes)
        await tick()
        acked.add(n)
      },
      (e) => e
    )
    expect(seen[0]).toBe(1)
    expect(st.lanes).toBe(4)
  })

  it('wifi très lent (délai du PC dépassé à 4 voies) : le fichier finit par passer', async () => {
    // simulation : débit total partagé entre les morceaux en route ; un morceau
    // qui dépasse le délai est refusé (408) et doit repartir de zéro
    const CHUNKS = 6
    const LINK = 4 // unités de morceau par seconde... divisées par les voies
    const TIMEOUT = 2.5 // un morceau seul prend 1/LINK*4 = 1 s ; à 4 voies, 4 s
    const acked = new Set<number>()
    const st: Lanes = { lanes: 4, okStreak: 0 }
    let active = 0
    let passes = 0
    while (acked.size < CHUNKS && passes < 20) {
      passes++
      const fails = await runPass(
        CHUNKS,
        acked,
        st,
        4,
        async (n) => {
          active++
          const lanesNow = active
          await tick()
          active--
          const seconds = (lanesNow * 4) / LINK
          if (seconds > TIMEOUT) throw new Error('408')
          acked.add(n)
        },
        (e) => e
      )
      if (fails.length) afterFailure(st)
    }
    expect(acked.size).toBe(CHUNKS)
    expect(passes).toBeLessThan(6)
  })
})
