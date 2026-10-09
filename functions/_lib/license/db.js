// Licences Flitdrop Pro : base Cloudflare D1 (SQLite), liée au projet Pages sous le
// nom LICENSE_DB. Paddle reste la source de vérité des achats, des clients, des
// remboursements et des rétrofacturations ; la base ne garde que ce que Paddle ne
// sait pas tenir de façon sûre :
//   - purchases : claim (empreinte de la page /pro) -> transaction Paddle, pour
//     retrouver un achat en un seul appel au lieu de balayer les transactions ;
//   - customers : empreinte « cus » du jeton -> id client Paddle (renouvellement en O(1)) ;
//   - devices : appareils autorisés par client (5 actifs au plus ; un appareil sorti
//     garde sa ligne avec evicted_at, preuve que son jeton ne se renouvelle plus) ;
//   - claim_devices : appareils débloqués par chaque claim (5 au plus, à vie) ;
//   - registrations : journal des nouvelles inscriptions (10 au plus par client sur
//     30 jours glissants) ;
//   - used_challenges : codes de restauration déjà utilisés (usage unique partout) ;
//   - counters : plafonds partagés entre isolats (par adresse e-mail, par jour) ;
//   - withdrawals : rétractations reçues par le formulaire de /refund, avec leur date
//     et leur heure de réception (preuve, gardée 3 ans) ;
//   - price_cache : prix localisé par pays (aperçu Paddle), gardé 6 heures.
//
// Règle d'écriture : jamais « lire puis écrire » en JavaScript. Chaque plafond tient
// dans une écriture conditionnelle d'une seule instruction (on lit meta.changes), ou
// dans un lot (batch) que D1 exécute d'un bloc, dans une seule transaction. Deux
// requêtes simultanées ne peuvent donc jamais dépasser un plafond.
//
// Les tables se créent toutes seules (CREATE TABLE IF NOT EXISTS, une fois par
// isolat) : aucune migration à lancer. Copie de référence : docs/licence-schema.sql.
import { state } from './state.js'
import { nowMs, nowSec } from './http.js'
import { randomHex } from './crypto.js'

export const MAX_DEVICES = 5 // appareils actifs par client
export const MAX_CLAIM_DEVICES = 5 // appareils débloqués par un même claim, à vie
export const MAX_REGISTRATIONS = 10 // nouvelles inscriptions par client sur 30 jours
export const REGISTRATION_WINDOW_SEC = 30 * 86400

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS purchases (claim TEXT PRIMARY KEY, txn_id TEXT NOT NULL, customer_id TEXT NOT NULL, status TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS purchases_txn ON purchases (txn_id)`,
  `CREATE TABLE IF NOT EXISTS customers (cus TEXT PRIMARY KEY, customer_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (customer_id TEXT NOT NULL, device TEXT NOT NULL, claim TEXT, registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, evicted_at INTEGER, PRIMARY KEY (customer_id, device))`,
  `CREATE TABLE IF NOT EXISTS claim_devices (claim TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (claim, device))`,
  `CREATE TABLE IF NOT EXISTS registrations (rid TEXT PRIMARY KEY, customer_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS registrations_customer ON registrations (customer_id, at)`,
  `CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, order_ref TEXT, lang TEXT NOT NULL, ack_sent INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS price_cache (country TEXT PRIMARY KEY, currency TEXT NOT NULL, display TEXT NOT NULL, display_early TEXT NOT NULL, ok INTEGER NOT NULL, fetched_at INTEGER NOT NULL)`,
]

// Panne de la base : les points d'entrée répondent 503 (jamais de licence, jamais
// de retrait sur une erreur).
export class DbError extends Error {
  constructor(code) {
    super(`d1 ${code}`)
    this.name = 'DbError'
    this.code = code
  }
}

async function guard(promise, code) {
  try {
    return await promise
  } catch {
    throw new DbError(code)
  }
}

// Base prête (tables créées). Une seule fois par isolat ; un échec sera retenté.
export async function openDb(db) {
  if (!db) throw new DbError('missing')
  if (!state.schemaReady) {
    const p = db.batch(SCHEMA.map((sql) => db.prepare(sql)))
    state.schemaReady = p
    p.catch(() => {
      if (state.schemaReady === p) state.schemaReady = null
    })
  }
  await guard(state.schemaReady, 'schema')
  return db
}

// Ménage des lignes expirées, au plus une fois par heure et par isolat : compteurs et
// codes périmés, journal d'inscriptions de plus de 60 jours, rétractations de plus
// de 3 ans. Renvoie la promesse du ménage (ou null), à passer
// à waitUntil (ou à attendre si l'on est déjà après la réponse). Ne lève jamais.
export function cleanupLater(db, waitUntil) {
  if (nowMs() - state.lastCleanup < 3600_000) return null
  state.lastCleanup = nowMs()
  const t = nowSec()
  const job = db
    .batch([
      db.prepare('DELETE FROM counters WHERE expires_at < ?1').bind(t),
      db.prepare('DELETE FROM used_challenges WHERE expires_at < ?1').bind(t),
      db.prepare('DELETE FROM registrations WHERE at < ?1').bind(t - 60 * 86400),
      db.prepare('DELETE FROM withdrawals WHERE received_at < ?1').bind(t - 3 * 365 * 86400),
    ])
    .catch(() => console.error('license db: cleanup failed'))
  if (typeof waitUntil === 'function') waitUntil(job)
  return job
}

// --- plafonds partagés ----------------------------------------------------------------
// Une seule instruction : +1 seulement si on est sous le plafond. true = ça passe.
export async function bumpKey(db, key, max, expiresAt) {
  const r = await guard(
    db
      .prepare('INSERT INTO counters (key, n, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET n = n + 1 WHERE counters.n < ?3')
      .bind(key, expiresAt, max)
      .run(),
    'bump',
  )
  return !!(r && r.meta && r.meta.changes === 1)
}

// Fenêtre fixe : la clé porte le numéro de la fenêtre.
export function bump(db, name, max, windowSec) {
  const bucket = Math.floor(nowSec() / windowSec)
  return bumpKey(db, `${name}:${windowSec}:${bucket}`, max, (bucket + 1) * windowSec + 60)
}

// --- achats et clients ------------------------------------------------------------------

export async function purchaseByClaim(db, claim) {
  return guard(db.prepare('SELECT claim, txn_id, customer_id, status, revoked, checked_at FROM purchases WHERE claim = ?1').bind(claim).first(), 'purchase_read')
}

// Note l'achat de ce claim (et l'empreinte du client). Une transaction déjà notée
// pour ce claim n'est remplacée par une autre que si elle a été remboursée : une
// page /pro rouverte par quelqu'un d'autre avec le même claim ne peut rien écraser.
export async function recordPurchase(db, { claim, txnId, customerId, status, cus }) {
  const t = nowSec()
  await guard(
    db.batch([
      db
        .prepare(
          'INSERT INTO purchases (claim, txn_id, customer_id, status, revoked, created_at, checked_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5) ' +
            'ON CONFLICT (claim) DO UPDATE SET txn_id = excluded.txn_id, customer_id = excluded.customer_id, status = excluded.status, ' +
            'revoked = CASE WHEN purchases.txn_id = excluded.txn_id THEN purchases.revoked ELSE 0 END, checked_at = excluded.checked_at ' +
            'WHERE purchases.txn_id = excluded.txn_id OR purchases.revoked = 1',
        )
        .bind(claim, txnId, customerId, status, t),
      db.prepare('INSERT OR IGNORE INTO customers (cus, customer_id, created_at) VALUES (?1, ?2, ?3)').bind(cus, customerId, t),
    ]),
    'purchase_write',
  )
}

// Dernier état vu chez Paddle pour ce claim (sert de cache négatif partagé).
export async function markPurchase(db, claim, txnId, { status, revoked }) {
  await guard(
    db
      .prepare('UPDATE purchases SET status = ?1, revoked = ?2, checked_at = ?3 WHERE claim = ?4 AND txn_id = ?5')
      .bind(String(status).slice(0, 32), revoked ? 1 : 0, nowSec(), claim, txnId)
      .run(),
    'purchase_mark',
  )
}

export async function rememberCustomer(db, cus, customerId) {
  await guard(db.prepare('INSERT OR IGNORE INTO customers (cus, customer_id, created_at) VALUES (?1, ?2, ?3)').bind(cus, customerId, nowSec()).run(), 'customer_write')
}

export async function customerIdByCus(db, cus) {
  const row = await guard(db.prepare('SELECT customer_id FROM customers WHERE cus = ?1').bind(cus).first(), 'customer_read')
  return row && typeof row.customer_id === 'string' ? row.customer_id : null
}

// --- appareils --------------------------------------------------------------------------

// Inscrit l'appareil d (empreinte) chez le client, d'un seul bloc :
//   - déjà actif : simplement « vu maintenant » ;
//   - nouveau (ou sorti auparavant) : accepté si le client a eu moins de 10 nouvelles
//     inscriptions sur 30 jours ; au-delà de 5 actifs, le moins récemment vu sort ;
//   - avec claim (déblocage depuis la page /pro) : en plus, 5 appareils au plus par
//     claim, à vie.
// Renvoie 'ok' | 'claim_used' | 'too_many_devices'.
export async function registerDevice(db, { customerId, device, claim = null }) {
  const t = nowSec()
  const cutoff = t - REGISTRATION_WINDOW_SEC
  const rid = randomHex(16)
  const viaClaim = typeof claim === 'string'
  const stmts = []

  if (viaClaim) {
    // place du claim : prise seulement si l'appareil pourra vraiment être inscrit
    stmts.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO claim_devices (claim, device, at) SELECT ?1, ?2, ?3 ' +
            'WHERE (SELECT count(*) FROM claim_devices WHERE claim = ?1) < ?4 ' +
            'AND (EXISTS (SELECT 1 FROM devices WHERE customer_id = ?5 AND device = ?2 AND evicted_at IS NULL) ' +
            'OR (SELECT count(*) FROM registrations WHERE customer_id = ?5 AND at > ?6) < ?7)',
        )
        .bind(claim, device, t, MAX_CLAIM_DEVICES, customerId, cutoff, MAX_REGISTRATIONS),
    )
  }
  const claimCond = viaClaim ? ' AND EXISTS (SELECT 1 FROM claim_devices WHERE claim = ?7 AND device = ?3)' : ''
  const claimArgs = viaClaim ? [claim] : []

  // nouvel appareil : noté au journal sous le plafond mensuel (rid = cette requête)
  stmts.push(
    db
      .prepare(
        'INSERT INTO registrations (rid, customer_id, device, at) SELECT ?1, ?2, ?3, ?4 ' +
          'WHERE NOT EXISTS (SELECT 1 FROM devices WHERE customer_id = ?2 AND device = ?3 AND evicted_at IS NULL) ' +
          'AND (SELECT count(*) FROM registrations WHERE customer_id = ?2 AND at > ?5) < ?6' +
          claimCond,
      )
      .bind(rid, customerId, device, t, cutoff, MAX_REGISTRATIONS, ...claimArgs),
  )
  // inscrit ou réinscrit, seulement si le journal l'a accepté
  stmts.push(
    db
      .prepare(
        'INSERT INTO devices (customer_id, device, claim, registered_at, last_seen_at, evicted_at) ' +
          'SELECT ?1, ?2, ?3, ?4, ?4, NULL WHERE EXISTS (SELECT 1 FROM registrations WHERE rid = ?5) ' +
          'ON CONFLICT (customer_id, device) DO UPDATE SET claim = excluded.claim, registered_at = excluded.registered_at, ' +
          'last_seen_at = excluded.last_seen_at, evicted_at = NULL',
      )
      .bind(customerId, device, claim, t, rid),
  )
  // déjà actif : vu maintenant
  stmts.push(
    db
      .prepare('UPDATE devices SET last_seen_at = ?1 WHERE customer_id = ?2 AND device = ?3 AND evicted_at IS NULL' + claimCond.replace('?7', '?4'))
      .bind(t, customerId, device, ...claimArgs),
  )
  // au-delà de 5 actifs, le moins récemment vu sort (jamais celui de cette requête)
  stmts.push(
    db
      .prepare(
        'UPDATE devices SET evicted_at = ?1 WHERE customer_id = ?2 AND evicted_at IS NULL AND device NOT IN (' +
          'SELECT device FROM devices WHERE customer_id = ?2 AND evicted_at IS NULL ' +
          'ORDER BY (device = ?3) DESC, last_seen_at DESC, registered_at DESC, device LIMIT ?4)',
      )
      .bind(t, customerId, device, MAX_DEVICES),
  )
  // verdict, lu dans la même transaction
  stmts.push(
    db
      .prepare(
        'SELECT (SELECT count(*) FROM devices WHERE customer_id = ?1 AND device = ?2 AND evicted_at IS NULL) AS active, ' +
          '(SELECT count(*) FROM claim_devices WHERE claim = ?3 AND device = ?2) AS claimed, ' +
          '(SELECT count(*) FROM claim_devices WHERE claim = ?3) AS claim_count',
      )
      .bind(customerId, device, viaClaim ? claim : ''),
  )

  const results = await guard(db.batch(stmts), 'register')
  const verdict = results && results[results.length - 1] && Array.isArray(results[results.length - 1].results) ? results[results.length - 1].results[0] : null
  if (!verdict) throw new DbError('register_shape')
  if (viaClaim && Number(verdict.claimed) !== 1) return Number(verdict.claim_count) >= MAX_CLAIM_DEVICES ? 'claim_used' : 'too_many_devices'
  return Number(verdict.active) === 1 ? 'ok' : 'too_many_devices'
}

// 'active' | 'evicted' (sorti : définitif) | 'unknown' (aucune trace : pas une
// preuve, on ne retire rien)
export async function deviceState(db, customerId, device) {
  const row = await guard(db.prepare('SELECT evicted_at FROM devices WHERE customer_id = ?1 AND device = ?2').bind(customerId, device).first(), 'device_read')
  if (!row) return 'unknown'
  return row.evicted_at === null || row.evicted_at === undefined ? 'active' : 'evicted'
}

// « Vu maintenant » pour un appareil actif. false s'il vient d'être sorti.
export async function touchDevice(db, customerId, device) {
  const r = await guard(
    db.prepare('UPDATE devices SET last_seen_at = ?1 WHERE customer_id = ?2 AND device = ?3 AND evicted_at IS NULL').bind(nowSec(), customerId, device).run(),
    'device_touch',
  )
  return r && r.meta && r.meta.changes === 1
}

// --- codes de restauration ------------------------------------------------------------------

// Marque le nonce du défi comme utilisé. false s'il l'était déjà (sur n'importe quel isolat).
export async function claimNonce(db, nonce, expiresAt) {
  const r = await guard(db.prepare('INSERT OR IGNORE INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)').bind(nonce, expiresAt).run(), 'nonce_write')
  return r && r.meta && r.meta.changes === 1
}

// Panne passagère après coup (Paddle, base) : le code redevient utilisable.
export async function releaseNonce(db, nonce) {
  try {
    await db.prepare('DELETE FROM used_challenges WHERE nonce = ?1').bind(nonce).run()
  } catch {
    console.error('license db: nonce release failed')
  }
}

// --- rétractations ---------------------------------------------------------------------------

export async function recordWithdrawal(db, { id, receivedAt, name, email, orderRef, lang }) {
  await guard(
    db
      .prepare('INSERT INTO withdrawals (id, received_at, name, email, order_ref, lang, ack_sent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)')
      .bind(id, receivedAt, name, email, orderRef || null, lang)
      .run(),
    'withdrawal_write',
  )
}

export async function markWithdrawalAcknowledged(db, id) {
  await guard(db.prepare('UPDATE withdrawals SET ack_sent = 1 WHERE id = ?1').bind(id).run(), 'withdrawal_mark')
}

// --- prix localisé par pays ------------------------------------------------------------------

export async function cachedPrice(db, country) {
  return guard(db.prepare('SELECT currency, display, display_early, ok, fetched_at FROM price_cache WHERE country = ?1').bind(country).first(), 'price_read')
}

export async function storePrice(db, country, { currency, display, displayEarly, ok }) {
  await guard(
    db
      .prepare(
        'INSERT INTO price_cache (country, currency, display, display_early, ok, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
          'ON CONFLICT (country) DO UPDATE SET currency = excluded.currency, display = excluded.display, display_early = excluded.display_early, ok = excluded.ok, fetched_at = excluded.fetched_at',
      )
      .bind(country, currency, display, displayEarly, ok ? 1 : 0, nowSec())
      .run(),
    'price_write',
  )
}
