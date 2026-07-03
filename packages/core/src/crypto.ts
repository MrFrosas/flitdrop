import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from 'node:crypto'
import { b64u } from './util.js'
import { PAYLOAD_MAX_AGE_MS } from './constants.js'

export const NONCE_LEN = 24
const te = new TextEncoder()
const td = new TextDecoder()

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
  const nonce = new Uint8Array(randomBytes(NONCE_LEN))
  const ct = xchacha20poly1305(key, nonce, te.encode(aad)).encrypt(plain)
  const out = new Uint8Array(NONCE_LEN + ct.length)
  out.set(nonce, 0)
  out.set(ct, NONCE_LEN)
  return out
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  if (sealed.length < NONCE_LEN + 16) throw new Error('payload tronqué')
  const nonce = sealed.subarray(0, NONCE_LEN)
  const ct = sealed.subarray(NONCE_LEN)
  return xchacha20poly1305(key, nonce, te.encode(aad)).decrypt(ct)
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
