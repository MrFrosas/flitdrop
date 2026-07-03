import { describe, it, expect } from 'vitest'
import { newKey, seal, open, sealJSON, openJSON, openFreshJSON, NonceCache, randomToken } from '../src/crypto.js'

describe('crypto', () => {
  const key = newKey()

  it('chiffre et déchiffre (roundtrip)', () => {
    const plain = new TextEncoder().encode('bonjour flitdrop été 2026 🚀')
    const sealed = seal(key, plain, 'wd1|dev|test')
    const out = open(key, sealed, 'wd1|dev|test')
    expect(Buffer.from(out).toString('utf8')).toBe('bonjour flitdrop été 2026 🚀')
  })

  it('rejette un payload altéré', () => {
    const sealed = seal(key, new Uint8Array([1, 2, 3]), 'ctx')
    sealed[sealed.length - 1] = ((sealed[sealed.length - 1] as number) ^ 0xff) & 0xff
    expect(() => open(key, sealed, 'ctx')).toThrow()
  })

  it('rejette une AAD différente (rejeu inter-contexte)', () => {
    const sealed = seal(key, new Uint8Array([9, 9]), 'wd1|dev|chunk|t1|0')
    expect(() => open(key, sealed, 'wd1|dev|chunk|t1|1')).toThrow()
  })

  it('rejette une mauvaise clé', () => {
    const sealed = seal(key, new Uint8Array([7]), 'x')
    expect(() => open(newKey(), sealed, 'x')).toThrow()
  })

  it('JSON scellé roundtrip', () => {
    const b64 = sealJSON(key, { a: 1, s: 'été' }, 'ctx')
    expect(openJSON(key, b64, 'ctx')).toEqual({ a: 1, s: 'été' })
  })

  it('openFreshJSON rejette un horodatage trop vieux', () => {
    const nonces = new NonceCache()
    const b64 = sealJSON(key, { ts: Date.now() - 10 * 60 * 1000, jti: randomToken(9) }, 'ctx')
    expect(() => openFreshJSON(key, b64, 'ctx', nonces)).toThrow(/expiré/)
  })

  it('openFreshJSON rejette un jti rejoué', () => {
    const nonces = new NonceCache()
    const payload = { ts: Date.now(), jti: randomToken(9) }
    const b64a = sealJSON(key, payload, 'ctx')
    expect(() => openFreshJSON(key, b64a, 'ctx', nonces)).not.toThrow()
    const b64b = sealJSON(key, payload, 'ctx')
    expect(() => openFreshJSON(key, b64b, 'ctx', nonces)).toThrow(/rejeu/)
  })

  it('NonceCache reste borné même sous un flux d’enveloppes valides', () => {
    const nonces = new NonceCache()
    for (let i = 0; i < 60_000; i++) expect(nonces.check(`jti-unique-${i}`)).toBe(true)
    const size = (nonces as unknown as { seen: Map<string, number> }).seen.size
    expect(size).toBeLessThanOrEqual(20_000)
    // un jti tout récent reste détecté comme rejeu (pas encore évincé)
    expect(nonces.check('jti-unique-59999')).toBe(false)
  })
})
