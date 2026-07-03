import { xchacha20poly1305 } from '@noble/ciphers/chacha'

export const NONCE_LEN = 24
const te = new TextEncoder()
const td = new TextDecoder()

export function bytesToB64u(bytes: Uint8Array): string {
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64uToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''
  const bin = atob(b + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function rand(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Même construction que côté PC : nonce(24) || ciphertext+tag, AAD contextuelle. */
export function seal(key: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  const nonce = rand(NONCE_LEN)
  const ct = xchacha20poly1305(key, nonce, te.encode(aad)).encrypt(plain)
  const out = new Uint8Array(NONCE_LEN + ct.length)
  out.set(nonce, 0)
  out.set(ct, NONCE_LEN)
  return out
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  const nonce = sealed.subarray(0, NONCE_LEN)
  return xchacha20poly1305(key, nonce, te.encode(aad)).decrypt(sealed.subarray(NONCE_LEN))
}

export function sealJSON(key: Uint8Array, obj: unknown, aad: string): string {
  return bytesToB64u(seal(key, te.encode(JSON.stringify(obj)), aad))
}

export function openJSON<T>(key: Uint8Array, b64: string, aad: string): T {
  return JSON.parse(td.decode(open(key, b64uToBytes(b64), aad))) as T
}

export function jti(): string {
  return bytesToB64u(rand(12))
}

export function fmtSize(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
