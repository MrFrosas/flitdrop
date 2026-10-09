// Fausse base Cloudflare D1 pour les tests, sur node:sqlite (Node 22.5 et plus).
// Même interface que la liaison D1 des Pages Functions : prepare(sql).bind(...)
// .first() / .all() / .run(), et batch([...]) exécuté d'un bloc dans une transaction
// (comme D1). run() et batch() rendent meta.changes.
//
// Concurrence réaliste : chaque appel attend un délai aléatoire (latencyMs) AVANT de
// s'exécuter, comme un aller-retour vers D1. Une logique « lire puis écrire » en
// JavaScript se fait donc doubler par les requêtes simultanées, exactement comme en
// production ; une instruction ou un lot, eux, s'exécutent d'un seul tenant.
import { DatabaseSync } from 'node:sqlite'

export function createD1({ latencyMs = 0 } = {}) {
  const db = new DatabaseSync(':memory:')
  const ctl = {
    latencyMs,
    fail: 0, // nombre de prochains appels en échec (Infinity : tous)
    calls: 0, // appels reçus (instructions isolées et lots)
    statements: [], // SQL de chaque instruction exécutée
  }

  const delay = () => (ctl.latencyMs ? new Promise((r) => setTimeout(r, Math.random() * ctl.latencyMs)) : Promise.resolve())
  function maybeFail() {
    if (ctl.fail > 0) {
      ctl.fail--
      throw new Error('D1_ERROR: simulated outage')
    }
  }
  // D1 refuse undefined et convertit les booléens en entiers
  function value(v) {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined bind value')
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  }
  const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)

  function execOne(sql, params) {
    ctl.statements.push(sql)
    const st = db.prepare(sql)
    if (returnsRows(sql)) {
      const rows = st.all(...params).map((r) => ({ ...r }))
      return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } }
    }
    const r = st.run(...params)
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql
      this.params = params
    }
    bind(...params) {
      return new Statement(this.sql, params.map(value))
    }
    async run() {
      await delay()
      maybeFail()
      ctl.calls++
      return execOne(this.sql, this.params)
    }
    async all() {
      return this.run()
    }
    async first(column) {
      const r = await this.run()
      const row = r.results[0] ?? null
      if (column === undefined) return row
      return row ? row[column] ?? null : null
    }
  }

  return {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      await delay()
      maybeFail()
      ctl.calls++
      db.exec('BEGIN IMMEDIATE')
      try {
        const out = statements.map((s) => execOne(s.sql, s.params))
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    // pour les tests : lecture directe, synchrone
    rows: (sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r })),
    sql: (sql, ...params) => db.prepare(sql).run(...params),
    ctl,
  }
}
