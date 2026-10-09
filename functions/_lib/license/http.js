// Licences Flitdrop Pro : réponses JSON, lecture bornée des requêtes, limites par isolat.
import { state } from './state.js'

export const nowMs = () => Date.now()
export const nowSec = () => Math.floor(Date.now() / 1000)

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

export const methodNotAllowed = (allow) => json({ error: 'method_not_allowed' }, 405, { allow })
export const badRequest = () => json({ error: 'bad_request' }, 400)
export const tooMany = (seconds) => json({ error: 'too_many' }, 429, { 'retry-after': String(Math.max(1, seconds)) })
// Paddle injoignable, lent ou en refus : on ne donne jamais rien, et on le dit vite
// avec un statut qu'on peut retenter. L'app garde alors son état actuel.
export const unavailable = () => json({ error: 'unavailable' }, 503, { 'retry-after': '60' })
// Mode payant coupé (LICENSE_ENABLED absent ou réglage manquant).
export const disabled = () => json({ error: 'disabled' }, 503)

// Échec côté Paddle ou imprévu : journal minimal (jamais de clé, d'adresse ni de
// jeton, seulement le type d'erreur), puis 503.
export function failClosed(where, err) {
  const status = err && Number.isFinite(err.status) ? err.status : ''
  const code = err && typeof err.code === 'string' ? err.code : ''
  const name = err && typeof err.name === 'string' ? err.name : 'Error'
  console.error(`license ${where}: ${name} ${status} ${code}`.trim())
  return unavailable()
}

// Un corps de requête légitime fait moins de 1 Ko : au-delà de 4 Ko, on refuse.
const MAX_BODY = 4096

// Lecture par morceaux, arrêtée dès 4 Ko : un corps énorme sans content-length
// n'est jamais chargé en entier.
async function readCapped(request) {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      try {
        await reader.cancel()
      } catch {}
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

export async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_BODY) return null
  let text
  try {
    text = await readCapped(request)
  } catch {
    return null
  }
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function clientIp(request) {
  return (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64)
}

// Identifiants opaques envoyés par l'app (claim, appareil) : 32 hexadécimaux minuscules.
export const isHex32 = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)

// Adresse e-mail : bornée, sans espace ni virgule (la virgule sépare les valeurs
// dans les filtres de l'API Paddle).
export function normalizeEmail(v) {
  if (typeof v !== 'string') return null
  const email = v.trim().toLowerCase()
  if (email.length < 3 || email.length > 254) return null
  if (!/^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/.test(email)) return null
  return email
}

export function normalizeLang(v) {
  const l = typeof v === 'string' ? v.slice(0, 2).toLowerCase() : ''
  return l === 'fr' || l === 'de' ? l : 'en'
}

// Limite à fenêtre fixe, en mémoire de l'isolat. Renvoie 0 si la requête passe,
// sinon le nombre de secondes à attendre.
const MAX_LIMIT_ENTRIES = 20000

export function hit(key, max, windowMs) {
  const t = nowMs()
  const limits = state.limits
  let entry = limits.get(key)
  if (!entry || entry.reset <= t) {
    entry = { n: 0, reset: t + windowMs }
    limits.delete(key)
    limits.set(key, entry)
  }
  entry.n++
  if (limits.size > MAX_LIMIT_ENTRIES) pruneLimits(t)
  return entry.n <= max ? 0 : Math.ceil((entry.reset - t) / 1000)
}

function pruneLimits(t) {
  for (const [k, e] of state.limits) if (e.reset <= t) state.limits.delete(k)
  // encore trop : on oublie les plus anciennes (ordre d'insertion de la Map)
  const excess = state.limits.size - Math.floor(MAX_LIMIT_ENTRIES * 0.8)
  if (excess > 0) {
    let i = 0
    for (const k of state.limits.keys()) {
      if (i++ >= excess) break
      state.limits.delete(k)
    }
  }
}

// Plusieurs limites d'un coup : toutes sont comptées, la plus longue attente gagne.
export function hitAll(rules) {
  let wait = 0
  for (const [key, max, windowMs] of rules) wait = Math.max(wait, hit(key, max, windowMs))
  return wait
}
