import { describe, it, expect, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { createWasmAead, selfTest } from '../src/xchacha-wasm.js'
import { seal, open, aeadEngine, _setAeadEngine, type AeadEngine } from '../src/crypto.js'
import * as wd from '../src/webclient/wdcrypto.js'

const te = new TextEncoder()
const rnd = (n: number) => new Uint8Array(randomBytes(n))
// tailles autour des blocs ChaCha (64) et Poly1305 (16), et de vrais morceaux
const SIZES = [0, 1, 15, 16, 17, 31, 63, 64, 65, 127, 128, 129, 255, 256, 1000, 4096 + 7, 65536 + 3, (1 << 20) + 13]

describe('XChaCha20-Poly1305 en WebAssembly', () => {
  const w = createWasmAead()!

  it('se charge et passe le vecteur publié', () => {
    expect(w).not.toBeNull()
    expect(selfTest(w)).toBe(true)
  })

  it('donne exactement les octets de noble (tailles, AAD, clés et nonces aléatoires)', () => {
    for (const n of SIZES) {
      for (let r = 0; r < 4; r++) {
        const key = rnd(32)
        const nonce = rnd(24)
        const plain = rnd(n)
        const aad = rnd(r * 29)
        const ref = xchacha20poly1305(key, nonce, aad).encrypt(plain)
        const got = w.seal(key, nonce, plain, aad)
        expect(Buffer.from(got.subarray(0, 24)).equals(Buffer.from(nonce))).toBe(true)
        expect(Buffer.from(got.subarray(24)).equals(Buffer.from(ref)), `n=${n}`).toBe(true)
        // et déchiffre ce que noble a chiffré
        const sealedByNoble = new Uint8Array(24 + ref.length)
        sealedByNoble.set(nonce)
        sealedByNoble.set(ref, 24)
        expect(Buffer.from(w.open(key, sealedByNoble, aad)!).equals(Buffer.from(plain))).toBe(true)
      }
    }
  })

  it('refuse tout octet modifié (nonce, chiffré, tag), une autre AAD ou une autre clé', () => {
    const key = rnd(32)
    const plain = rnd(100)
    const aad = te.encode('wd1|dev|chunk|t|0')
    const sealed = w.seal(key, rnd(24), plain, aad)
    for (let i = 0; i < sealed.length; i++) {
      for (const bit of [1, 0x80]) {
        const bad = sealed.slice()
        bad[i] = bad[i]! ^ bit
        expect(w.open(key, bad, aad), `octet ${i}`).toBeNull()
      }
    }
    expect(w.open(key, sealed, te.encode('wd1|dev|chunk|t|1'))).toBeNull()
    expect(w.open(rnd(32), sealed, aad)).toBeNull()
    expect(w.open(key, sealed.subarray(0, 39), aad)).toBeNull()
    expect(Buffer.from(w.open(key, sealed, aad)!).equals(Buffer.from(plain))).toBe(true)
  })

  it('garde des résultats justes quand la mémoire grandit puis resservent de petits messages', () => {
    const key = rnd(32)
    for (const n of [8 << 20, 10, (8 << 20) + 40, 3]) {
      const nonce = rnd(24)
      const plain = rnd(n)
      const aad = te.encode('a|' + n)
      const ref = xchacha20poly1305(key, nonce, aad).encrypt(plain)
      expect(Buffer.from(w.seal(key, nonce, plain, aad).subarray(24)).equals(Buffer.from(ref))).toBe(true)
    }
  })
})

describe('moteurs du PC (crypto.ts) : mêmes octets, anciens téléphones compris', () => {
  const engines: AeadEngine[] = ['noble', 'wasm']
  try {
    _setAeadEngine('native')
    engines.push('native')
  } catch {
    // OpenSSL sans chacha20-poly1305 (Electron) : le PC passe par le wasm
  }
  afterAll(() => {
    _setAeadEngine(null)
  })

  it('choisit un moteur rapide quand il y en a un', () => {
    _setAeadEngine(null)
    expect(['native', 'wasm']).toContain(aeadEngine())
  })

  for (const name of engines) {
    it(`${name} : le PC ouvre ce que la page du téléphone (noble) a chiffré, et inversement`, () => {
      _setAeadEngine(name)
      const key = rnd(32)
      for (const n of [0, 1, 64, 1000, (4 << 20) + 1]) {
        const plain = rnd(n)
        const aad = `wd1|dev|dl|item|${n}`
        // page du téléphone, ancienne comme nouvelle : wdcrypto (noble)
        const fromPhone = wd.seal(key, plain, aad)
        expect(Buffer.from(open(key, fromPhone, aad)).equals(Buffer.from(plain))).toBe(true)
        const fromPc = seal(key, plain, aad)
        expect(Buffer.from(wd.open(key, fromPc, aad)).equals(Buffer.from(plain))).toBe(true)
      }
    })

    it(`${name} : refuse un tag, une AAD ou une clé faux, et un message tronqué`, () => {
      _setAeadEngine(name)
      const key = rnd(32)
      const sealed = seal(key, rnd(300), 'ctx')
      const bad = sealed.slice()
      bad[30] = bad[30]! ^ 4
      expect(() => open(key, bad, 'ctx')).toThrow()
      expect(() => open(key, sealed, 'ctx2')).toThrow()
      expect(() => open(rnd(32), sealed, 'ctx')).toThrow()
      expect(() => open(key, sealed.subarray(0, 30), 'ctx')).toThrow()
    })

    it(`${name} : un nonce neuf à chaque chiffrement`, () => {
      _setAeadEngine(name)
      const key = rnd(32)
      const seen = new Set<string>()
      for (let i = 0; i < 200; i++) seen.add(Buffer.from(seal(key, new Uint8Array(1), 'x').subarray(0, 24)).toString('hex'))
      expect(seen.size).toBe(200)
    })
  }
})
