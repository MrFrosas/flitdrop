-- Licences Flitdrop Pro : schéma de la base Cloudflare D1 (liaison LICENSE_DB).
-- Copie de référence : le serveur crée lui-même ces tables (instructions « IF NOT
-- EXISTS », une fois par isolat, functions/_lib/license/db.js) : aucune migration à
-- lancer. Un test vérifie que ce fichier reste identique au code.
-- Lire la base : npx wrangler d1 execute flitdrop-licences --remote --command "SELECT ..."

CREATE TABLE IF NOT EXISTS purchases (claim TEXT PRIMARY KEY, txn_id TEXT NOT NULL, customer_id TEXT NOT NULL, status TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS purchases_txn ON purchases (txn_id);

CREATE TABLE IF NOT EXISTS customers (cus TEXT PRIMARY KEY, customer_id TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS devices (customer_id TEXT NOT NULL, device TEXT NOT NULL, claim TEXT, registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, evicted_at INTEGER, PRIMARY KEY (customer_id, device));

CREATE TABLE IF NOT EXISTS claim_devices (claim TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (claim, device));

CREATE TABLE IF NOT EXISTS registrations (rid TEXT PRIMARY KEY, customer_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS registrations_customer ON registrations (customer_id, at);

CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, order_ref TEXT, lang TEXT NOT NULL, ack_sent INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS price_cache (country TEXT PRIMARY KEY, currency TEXT NOT NULL, display TEXT NOT NULL, display_early TEXT NOT NULL, ok INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
