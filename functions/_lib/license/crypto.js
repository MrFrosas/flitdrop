// Licences Flitdrop Pro : jetons signés Ed25519 et défis de restauration (WebCrypto,
// identique dans Cloudflare Workers et dans Node pour les tests).
//
// Jeton : base64url(JSON du contenu) + "." + base64url(signature Ed25519 des octets
// UTF-8 de ce JSON). Contenu : { v: 1, env, plan: "pro", dev, cus, iat, exp }, où
// env vaut "production" ou "sandbox" (PADDLE_ENV) : l'app publiée refuse tout jeton
// qui n'est pas de production, et chaque environnement a sa propre clé de signature.
// L'app embarque la clé PUBLIQUE ; la clé privée (LICENSE_SIGNING_KEY) ne quitte
// jamais les secrets Cloudflare.
import { decodeSigningKey } from './config.js'
import { state } from './state.js'
import { nowSec } from './http.js'

export const TOKEN_DAYS = 30
const enc = new TextEncoder()
const dec = new TextDecoder()

// --- encodages -----------------------------------------------------------------

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  let bin
  try {
    bin = atob(b64)
  } catch {
    return null
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toHex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0')
  return s
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

// Empreintes stockées dans la base D1 et dans le jeton : 32 premiers hexadécimaux du SHA-256.
export const deviceHash = async (device) => (await sha256Hex(device)).slice(0, 32)
export const customerHash = async (customerId) => (await sha256Hex(customerId)).slice(0, 32)
// Adresse e-mail dans les compteurs anti-abus de la base : jamais en clair.
export const emailHash = async (email) => (await sha256Hex('flitdrop-email-v1:' + email)).slice(0, 32)

// Le claim de la page /pro n'est que l'empreinte du secret que l'app garde pour elle
// (claimSecret, 64 hexadécimaux, envoyé seulement à POST /api/license/claim). Une
// adresse /pro?claim=... qui fuiterait (historique, outil de mesure) ne permet donc
// de rien débloquer.
export const claimFromSecret = async (secret) => (await sha256Hex('flitdrop-claim-v1:' + secret)).slice(0, 32)

// Comparaison à temps constant (longueurs égales exigées).
export function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

// --- clés ----------------------------------------------------------------------

const ED = { name: 'Ed25519' }
// Ancien nom propre à Cloudflare, gardé en secours si un runtime refusait le nom standard.
const ED_LEGACY = { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }

async function loadKeys(signingKey) {
  const cached = state.keys.get(signingKey)
  if (cached) return cached
  const der = decodeSigningKey(signingKey)
  if (!der) throw new Error('signing_key_invalid')

  let alg = ED
  let priv
  try {
    priv = await crypto.subtle.importKey('pkcs8', der, ED, true, ['sign'])
  } catch {
    alg = ED_LEGACY
    priv = await crypto.subtle.importKey('pkcs8', der, ED_LEGACY, true, ['sign'])
  }
  // La clé publique se lit dans l'export JWK de la clé privée (champ x).
  let pub = null
  try {
    const jwk = await crypto.subtle.exportKey('jwk', priv)
    pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, alg, true, ['verify'])
  } catch {
    pub = null // vérification par re-signature (Ed25519 est déterministe), voir verifyToken
  }

  // Clé HMAC des défis de restauration, dérivée (HKDF) de la clé de signature :
  // un seul secret à gérer, et deux usages séparés par le libellé.
  const ikm = await crypto.subtle.importKey('raw', der, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('flitdrop-license'), info: enc.encode('restore-challenge-v1') },
    ikm,
    256,
  )
  const hmac = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

  const keys = { alg, priv, pub, hmac }
  state.keys.set(signingKey, keys)
  return keys
}

// Clé publique brute (32 octets) en base64 : celle que l'app doit embarquer.
export async function publicKeyBase64(signingKey) {
  const { priv } = await loadKeys(signingKey)
  const jwk = await crypto.subtle.exportKey('jwk', priv)
  const raw = b64urlDecode(jwk.x)
  return btoa(String.fromCharCode(...raw))
}

// --- jetons --------------------------------------------------------------------

export async function signToken(cfg, { device, customerId }) {
  const { alg, priv } = await loadKeys(cfg.signingKey)
  const iat = nowSec()
  if (cfg.paddleEnv !== 'production' && cfg.paddleEnv !== 'sandbox') throw new Error('env_invalid')
  const payload = {
    v: 1,
    env: cfg.paddleEnv,
    plan: 'pro',
    dev: device,
    cus: await customerHash(customerId),
    iat,
    exp: iat + TOKEN_DAYS * 86400,
  }
  const bytes = enc.encode(JSON.stringify(payload))
  const sig = new Uint8Array(await crypto.subtle.sign(alg, priv, bytes))
  return b64urlEncode(bytes) + '.' + b64urlEncode(sig)
}

// Renvoie le contenu si la signature est bonne et la forme exacte, sinon null.
// L'expiration n'est PAS vérifiée ici (le renouvellement accepte un jeton expiré,
// puisqu'il revérifie l'achat chez Paddle et l'appareil dans la base). L'environnement
// est lu, pas comparé : c'est à l'appelant de refuser un jeton d'un autre environnement.
export async function verifyToken(cfg, token) {
  if (typeof token !== 'string' || token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const bytes = b64urlDecode(parts[0])
  const sig = b64urlDecode(parts[1])
  if (!bytes || !sig || bytes.length === 0 || bytes.length > 1024 || sig.length !== 64) return null

  const { alg, priv, pub } = await loadKeys(cfg.signingKey)
  let ok = false
  try {
    if (pub) ok = await crypto.subtle.verify(alg, pub, sig, bytes)
    else ok = constantTimeEqual(new Uint8Array(await crypto.subtle.sign(alg, priv, bytes)), sig)
  } catch {
    ok = false
  }
  if (!ok) return null

  let p
  try {
    p = JSON.parse(dec.decode(bytes))
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  if (p.v !== 1 || p.plan !== 'pro') return null
  if (p.env !== 'production' && p.env !== 'sandbox') return null
  if (typeof p.dev !== 'string' || !/^[0-9a-f]{32}$/.test(p.dev)) return null
  if (typeof p.cus !== 'string' || !/^[0-9a-f]{32}$/.test(p.cus)) return null
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat) return null
  return p
}

// --- codes de restauration ------------------------------------------------------
// 12 caractères en base32 de Crockford (sans I, L, O ni U), affichés XXXX-XXXX-XXXX :
// 60 bits, hors de portée d'un essai à l'aveugle. À la saisie : casse ignorée,
// tirets et espaces ignorés, O lu comme 0, I et L lus comme 1 (règle de Crockford).

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_TTL_SEC = 15 * 60

export function newRestoreCode() {
  // 256 est un multiple de 32 : « octet & 31 » ne biaise aucun caractère.
  const r = crypto.getRandomValues(new Uint8Array(12))
  let code = ''
  for (let i = 0; i < 12; i++) code += CODE_ALPHABET[r[i] & 31]
  return code
}

export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`

export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 40) return null
  // tout ce qui n'est ni chiffre ni lettre (tirets de toute sorte, espaces) est ignoré
  const c = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c) ? c : null
}

// Défi sans état : base64url({ v: 2, x: expiration, n: nonce }) + "." + base64url(tag),
// où tag (64 octets) = HMAC de l'en-tête (32 premiers octets) puis HMAC du code
// (32 octets suivants), avec une clé dérivée de LICENSE_SIGNING_KEY.
//   - le premier lie l'adresse e-mail, l'expiration et le nonce, sans le code : le
//     serveur sait ainsi qu'il a bien émis ce défi avant de compter les essais sur son
//     nonce (inventer des nonces ne donne aucun essai de plus) ;
//   - le second lie en plus l'empreinte du code : sans la clé serveur, impossible de
//     deviner le code hors ligne ni de fabriquer un défi.
async function hmacTag(hmacKey, material) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(material)))
}
const headMaterial = (email, x, n) => `flitdrop-restore|2|head|${email}|${x}|${n}`
const codeMaterial = async (email, code, x, n) => `flitdrop-restore|2|code|${email}|${await sha256Hex(code)}|${x}|${n}`

export async function makeChallenge(cfg, email, code) {
  const { hmac } = await loadKeys(cfg.signingKey)
  const x = nowSec() + CODE_TTL_SEC
  const n = randomHex(16)
  const head = b64urlEncode(enc.encode(JSON.stringify({ v: 2, x, n })))
  const tag = new Uint8Array(64)
  tag.set(await hmacTag(hmac, headMaterial(email, x, n)), 0)
  tag.set(await hmacTag(hmac, await codeMaterial(email, code, x, n)), 32)
  return head + '.' + b64urlEncode(tag)
}

// Lit un défi sans le vérifier. null si mal formé.
export function readChallenge(challenge) {
  if (typeof challenge !== 'string' || challenge.length > 512) return null
  const parts = challenge.split('.')
  if (parts.length !== 2) return null
  const head = b64urlDecode(parts[0])
  const tag = b64urlDecode(parts[1])
  if (!head || !tag || tag.length !== 64 || head.length > 256) return null
  let p
  try {
    p = JSON.parse(dec.decode(head))
  } catch {
    return null
  }
  if (!p || p.v !== 2 || !Number.isInteger(p.x) || typeof p.n !== 'string' || !/^[0-9a-f]{32}$/.test(p.n)) return null
  return { x: p.x, n: p.n, headTag: tag.slice(0, 32), codeTag: tag.slice(32) }
}

// Le défi a-t-il été émis par ce serveur, pour cette adresse ? (sans le code)
export async function challengeIssued(cfg, parsed, email) {
  const { hmac } = await loadKeys(cfg.signingKey)
  return constantTimeEqual(await hmacTag(hmac, headMaterial(email, parsed.x, parsed.n)), parsed.headTag)
}

// Le code saisi est-il celui du défi ? Comparaison à temps constant.
export async function challengeCodeOk(cfg, parsed, email, code) {
  const { hmac } = await loadKeys(cfg.signingKey)
  return constantTimeEqual(await hmacTag(hmac, await codeMaterial(email, code, parsed.x, parsed.n)), parsed.codeTag)
}
