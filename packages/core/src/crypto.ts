import { xchacha20poly1305, hchacha } from '@noble/ciphers/chacha'
import { createCipheriv, createDecipheriv, getCiphers, randomBytes } from 'node:crypto'
import { b64u } from './util.js'
import { PAYLOAD_MAX_AGE_MS } from './constants.js'
import { createWasmAead, type WasmAead } from './xchacha-wasm.js'

export const NONCE_LEN = 24
const te = new TextEncoder()
const td = new TextDecoder()

// ---------- moteurs de chiffrement ----------
// Même algorithme (XChaCha20-Poly1305) et mêmes octets partout ; seul le
// moteur change, choisi une fois au premier usage :
//  - 'native' : OpenSSL de Node (HChaCha20 de noble + chacha20-poly1305),
//    plus de 1 Go/s ; absent d'Electron (BoringSSL n'a pas ce chiffrement) ;
//  - 'wasm'   : wasm/xchacha20poly1305.c, 2 à 3 fois noble ;
//  - 'noble'  : JavaScript pur, le secours.
// Chaque moteur doit refaire à l'identique un chiffrement de noble et refuser
// un tag modifié avant d'être retenu. Le PC ne bloque ainsi plus son fil
// principal pendant qu'un morceau de 8 Mo se déchiffre.
export type AeadEngine = 'native' | 'wasm' | 'noble'

interface Engine {
  name: AeadEngine
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Uint8Array
  open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array
}

const badTag = () => new Error('invalid tag')

const nobleEngine: Engine = {
  name: 'noble',
  seal(key, nonce, plain, aad) {
    const ct = xchacha20poly1305(key, nonce, aad).encrypt(plain)
    const out = new Uint8Array(NONCE_LEN + ct.length)
    out.set(nonce, 0)
    out.set(ct, NONCE_LEN)
    return out
  },
  open(key, sealed, aad) {
    return xchacha20poly1305(key, sealed.subarray(0, NONCE_LEN), aad).decrypt(sealed.subarray(NONCE_LEN))
  },
}

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])
const u32 = (b: Uint8Array) => {
  const c = b.slice()
  return new Uint32Array(c.buffer, c.byteOffset, c.byteLength >> 2)
}
function nativeParams(key: Uint8Array, nonce: Uint8Array): { subkey: Buffer; iv: Buffer } {
  const out = new Uint32Array(8)
  hchacha(SIGMA, u32(key), u32(nonce.subarray(0, 16)), out)
  const subkey = Buffer.from(out.buffer)
  const iv = Buffer.alloc(12)
  iv.set(nonce.subarray(16, 24), 4)
  return { subkey, iv }
}

function makeNativeEngine(): Engine | null {
  if (!getCiphers().includes('chacha20-poly1305')) return null
  return {
    name: 'native',
    seal(key, nonce, plain, aad) {
      const { subkey, iv } = nativeParams(key, nonce)
      const c = createCipheriv('chacha20-poly1305', subkey, iv, { authTagLength: 16 })
      c.setAAD(aad, { plaintextLength: plain.length })
      const out = Buffer.allocUnsafe(NONCE_LEN + plain.length + 16)
      out.set(nonce, 0)
      const body = c.update(plain)
      out.set(body, NONCE_LEN)
      c.final()
      out.set(c.getAuthTag(), NONCE_LEN + plain.length)
      subkey.fill(0)
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    },
    open(key, sealed, aad) {
      if (sealed.length < NONCE_LEN + 16) throw badTag()
      const { subkey, iv } = nativeParams(key, sealed.subarray(0, NONCE_LEN))
      const d = createDecipheriv('chacha20-poly1305', subkey, iv, { authTagLength: 16 })
      const len = sealed.length - NONCE_LEN - 16
      d.setAAD(aad, { plaintextLength: len })
      d.setAuthTag(sealed.subarray(sealed.length - 16))
      const plain = d.update(sealed.subarray(NONCE_LEN, NONCE_LEN + len))
      try {
        // final() vérifie le tag : en cas d'échec, le clair calculé est effacé
        d.final()
      } catch {
        plain.fill(0)
        throw badTag()
      } finally {
        subkey.fill(0)
      }
      return new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength)
    },
  }
}

function makeWasmEngine(): Engine | null {
  const w: WasmAead | null = createWasmAead()
  if (!w) return null
  return {
    name: 'wasm',
    seal: (key, nonce, plain, aad) => w.seal(key, nonce, plain, aad),
    open(key, sealed, aad) {
      const plain = w.open(key, sealed, aad)
      if (!plain) throw badTag()
      return plain
    },
  }
}

/** Le moteur donne-t-il exactement les octets de noble, et refuse-t-il un
 *  tag, une AAD ou une clé fausse ? (tailles autour des blocs de 16 et 64) */
function agreesWithNoble(e: Engine): boolean {
  try {
    for (const n of [0, 1, 17, 64, 65, 1000]) {
      const key = new Uint8Array(randomBytes(32))
      const nonce = new Uint8Array(randomBytes(NONCE_LEN))
      const plain = new Uint8Array(randomBytes(n))
      const aad = te.encode(`wd1|test|${n}`)
      const a = e.seal(key, nonce, plain, aad)
      const b = nobleEngine.seal(key, nonce, plain, aad)
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false
      const back = e.open(key, b, aad)
      if (back.length !== n || back.some((v, i) => v !== plain[i])) return false
      const bad = b.slice()
      bad[bad.length - 1] = (bad[bad.length - 1]! ^ 1) & 0xff
      let refused = false
      try {
        e.open(key, bad, aad)
      } catch {
        refused = true
      }
      if (!refused) return false
    }
    return true
  } catch {
    return false
  }
}

let engine: Engine | null = null
function current(): Engine {
  if (engine) return engine
  const forced = process.env.FLITDROP_AEAD
  const candidates: (() => Engine | null)[] =
    forced === 'noble' ? [] : forced === 'wasm' ? [makeWasmEngine] : [makeNativeEngine, makeWasmEngine]
  for (const make of candidates) {
    let e: Engine | null = null
    try {
      e = make()
    } catch {
      e = null
    }
    if (e && agreesWithNoble(e)) return (engine = e)
  }
  return (engine = nobleEngine)
}

/** Moteur retenu (diagnostic, tests). */
export function aeadEngine(): AeadEngine {
  return current().name
}

/** Tests seulement : force un moteur (null = nouveau choix automatique). */
export function _setAeadEngine(name: AeadEngine | null): AeadEngine {
  engine = null
  if (name === 'noble') engine = nobleEngine
  else if (name === 'native') engine = makeNativeEngine()
  else if (name === 'wasm') engine = makeWasmEngine()
  if (name && !engine) throw new Error(`moteur ${name} indisponible`)
  return current().name
}

export function newKey(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

export function randomToken(bytes = 24): string {
  return Buffer.from(randomBytes(bytes)).toString('base64url')
}

/** Chiffre avec XChaCha20-Poly1305. Sortie: nonce(24) || ciphertext+tag.
 *  L'AAD lie le message à son contexte (appareil, usage, n° de chunk) :
 *  un payload rejoué sur une autre route ou un autre appareil est rejeté. */
export function seal(key: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  // nonce aléatoire de 24 octets à chaque appel (jamais réutilisé)
  const nonce = new Uint8Array(randomBytes(NONCE_LEN))
  return current().seal(key, nonce, plain, te.encode(aad))
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  if (sealed.length < NONCE_LEN + 16) throw new Error('payload tronqué')
  return current().open(key, sealed, te.encode(aad))
}

export function sealJSON(key: Uint8Array, obj: unknown, aad: string): string {
  return b64u.enc(seal(key, te.encode(JSON.stringify(obj)), aad))
}

export function openJSON<T = Record<string, unknown>>(key: Uint8Array, b64: string, aad: string): T {
  return JSON.parse(td.decode(open(key, b64u.dec(b64), aad))) as T
}

/** Anti-rejeu : chaque payload JSON porte un jti unique et un horodatage.
 *  La Map est bornée par un plafond dur avec éviction FIFO du plus ancien jti,
 *  pour qu'un flux d'enveloppes valides ne puisse pas la faire enfler sans fin. */
export class NonceCache {
  private seen = new Map<string, number>()
  private static readonly MAX_ENTRIES = 20_000

  check(jti: string): boolean {
    if (!jti || jti.length < 8 || this.seen.has(jti)) return false
    const now = Date.now()
    if (this.seen.size >= NonceCache.MAX_ENTRIES) {
      // purge des expirés, et si encore trop plein, éviction FIFO par lot
      // jusqu'à 90 % du plafond : coût amorti O(1) par insertion sous charge.
      const target = Math.floor(NonceCache.MAX_ENTRIES * 0.9)
      for (const [k, exp] of this.seen) {
        if (this.seen.size <= target) break
        if (exp < now) this.seen.delete(k)
      }
      for (const k of this.seen.keys()) {
        if (this.seen.size <= target) break
        this.seen.delete(k)
      }
    }
    this.seen.set(jti, now + PAYLOAD_MAX_AGE_MS * 2)
    return true
  }
}

export function openFreshJSON<T = Record<string, unknown>>(
  key: Uint8Array,
  b64: string,
  aad: string,
  nonces: NonceCache
): T {
  const obj = openJSON<T & { ts?: number; jti?: string }>(key, b64, aad)
  const age = Math.abs(Date.now() - Number(obj.ts ?? 0))
  if (!Number.isFinite(age) || age > PAYLOAD_MAX_AGE_MS) throw new Error('payload expiré')
  if (!nonces.check(String(obj.jti ?? ''))) throw new Error('rejeu détecté')
  return obj
}
