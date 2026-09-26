// XChaCha20-Poly1305 en WebAssembly (wasm/xchacha20poly1305.c) : mêmes octets
// que @noble/ciphers, mais bien plus rapide, surtout dans Safari sur la page
// HTTP du téléphone (JavaScript sans JIT). Sert au téléphone (dans des Web
// Workers) et au PC (Electron n'a pas chacha20-poly1305 dans node:crypto).
// Aucun import Node ni navigateur : ce module tourne partout.
import { XCHACHA_WASM_B64 } from './xchacha-wasm-bin.js'

export const NONCE_LEN = 24
export const TAG_LEN = 16

export interface WasmAead {
  /** nonce(24) || chiffré || tag(16), avec le nonce fourni */
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Uint8Array
  /** clair, ou null si le tag ne correspond pas (données modifiées, mauvaise clé ou AAD) */
  open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null
}

const PAGE = 65536
// [0, 64 Ko) : pile du code C ; puis clé, et le reste pour AAD + données
const KEY_AT = PAGE
const AAD_AT = PAGE + 64

// décodage base64 sans atob ni Buffer (Workers, Node, JavaScriptCore seul)
function b64ToBytes(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const T = new Uint8Array(128)
  for (let i = 0; i < 64; i++) T[A.charCodeAt(i)] = i
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array((clean.length * 3) >> 2)
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (T[clean.charCodeAt(i)]! << 18) |
      (T[clean.charCodeAt(i + 1)]! << 12) |
      ((T[clean.charCodeAt(i + 2)] ?? 0) << 6) |
      (T[clean.charCodeAt(i + 3)] ?? 0)
    if (o < out.length) out[o++] = n >> 16
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

const hex = (s: string) => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** Instancie le module, ou null s'il n'y a pas de WebAssembly (mode Isolement
 *  d'iOS, politique de sécurité) ou si le test connu échoue : l'appelant
 *  garde alors le chiffrement en JavaScript, identique mais plus lent. */
export function createWasmAead(): WasmAead | null {
  try {
    if (typeof WebAssembly !== 'object') return null
    const memory = new WebAssembly.Memory({ initial: 4 })
    const mod = new WebAssembly.Module(b64ToBytes(XCHACHA_WASM_B64) as BufferSource)
    const inst = new WebAssembly.Instance(mod, {
      env: {
        __linear_memory: memory,
        __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, PAGE),
        __indirect_function_table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
      },
    })
    const ex = inst.exports as {
      xcp_seal: (k: number, n: number, a: number, al: number, i: number, l: number, o: number) => void
      xcp_open: (k: number, n: number, a: number, al: number, i: number, l: number, o: number) => number
    }
    // zone des données : nonce(24) || données || tag(16), alignée sur 16
    const layout = (aadLen: number, dataLen: number) => {
      const buf = (AAD_AT + aadLen + 15) & ~15
      const need = buf + NONCE_LEN + dataLen + TAG_LEN
      const have = memory.buffer.byteLength
      if (need > have) memory.grow(Math.ceil((need - have) / PAGE))
      return buf
    }
    const aead: WasmAead = {
      seal(key, nonce, plain, aad) {
        if (key.length !== 32 || nonce.length !== NONCE_LEN) throw new Error('clé ou nonce invalide')
        const buf = layout(aad.length, plain.length)
        const m = new Uint8Array(memory.buffer)
        m.set(key, KEY_AT)
        m.set(aad, AAD_AT)
        m.set(nonce, buf)
        m.set(plain, buf + NONCE_LEN)
        ex.xcp_seal(KEY_AT, buf, AAD_AT, aad.length, buf + NONCE_LEN, plain.length, buf + NONCE_LEN)
        m.fill(0, KEY_AT, KEY_AT + 32)
        return m.slice(buf, buf + NONCE_LEN + plain.length + TAG_LEN)
      },
      open(key, sealed, aad) {
        if (key.length !== 32) throw new Error('clé invalide')
        if (sealed.length < NONCE_LEN + TAG_LEN) return null
        const len = sealed.length - NONCE_LEN - TAG_LEN
        const buf = layout(aad.length, len)
        const m = new Uint8Array(memory.buffer)
        m.set(key, KEY_AT)
        m.set(aad, AAD_AT)
        m.set(sealed, buf)
        const rc = ex.xcp_open(KEY_AT, buf, AAD_AT, aad.length, buf + NONCE_LEN, len, buf + NONCE_LEN)
        m.fill(0, KEY_AT, KEY_AT + 32)
        return rc === 0 ? m.slice(buf + NONCE_LEN, buf + NONCE_LEN + len) : null
      },
    }
    return selfTest(aead) ? aead : null
  } catch {
    return null
  }
}

/** Vecteur publié (draft-irtf-cfrg-xchacha, A.3.1), aller-retour et tag
 *  modifié refusé : le module n'est utilisé que s'il donne exactement ça. */
export function selfTest(aead: WasmAead): boolean {
  const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f')
  const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657')
  const aad = hex('50515253c0c1c2c3c4c5c6c7')
  const plain = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
  )
  const want =
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216' +
    'cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e' +
    'c0875924c1c7987947deafd8780acf49'
  const sealed = aead.seal(key, nonce, plain, aad)
  let got = ''
  for (let i = NONCE_LEN; i < sealed.length; i++) got += sealed[i]!.toString(16).padStart(2, '0')
  if (got !== want) return false
  const back = aead.open(key, sealed, aad)
  if (!back || back.length !== plain.length || back.some((b, i) => b !== plain[i])) return false
  const bad = sealed.slice()
  bad[bad.length - 1]! ^= 1
  if (aead.open(key, bad, aad) !== null) return false
  const badAad = aad.slice()
  badAad[0]! ^= 1
  return aead.open(key, sealed, badAad) === null
}
