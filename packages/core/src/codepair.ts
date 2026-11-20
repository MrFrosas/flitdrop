// Appairage par code à 6 chiffres : pour l'icône de l'écran d'accueil (qui ne
// peut pas scanner de QR code) ou un téléphone qui n'y arrive pas.
//
// Le PC montre un code à côté du QR code. Le téléphone, déjà sur la page de
// ce PC, tape le code et envoie une clé publique X25519 éphémère. Le PC
// répond avec la sienne et l'appairage (identifiant, clé, identité du PC),
// chiffré sous une clé tirée de l'échange X25519 et du code. Quelqu'un qui
// écoute le wifi voit passer le code mais ne peut rien déchiffrer : la clé
// d'appairage ne circule jamais en clair, comme avec le QR code.
//
// Code à usage unique, valable tant que son QR code l'est (3 minutes), lié à
// cet appairage en attente. Contre les essais au hasard : en plus de la
// limite par adresse, trop d'échecs en peu de temps, tous téléphones
// confondus, effacent tous les codes en cours (la fenêtre du PC en montre un
// nouveau à son renouvellement).
import crypto from 'node:crypto'

export const CODE_DIGITS = 6
/** Échecs tolérés, toutes adresses confondues, sur FAIL_WINDOW_MS. */
export const MAX_FAILS = 20
export const FAIL_WINDOW_MS = 10 * 60 * 1000
export const CODEPAIR_AAD = 'wd1|codepair'

const CODE_RE = /^\d{6}$/
const PUB_RE = /^[A-Za-z0-9_-]{43}$/

/** « 482 913 », « 482913 », « 482-913 » : six chiffres, ou ''. */
export function normalizeCode(raw: unknown): string {
  const digits = String(raw ?? '').replace(/[\s.-]/g, '')
  return CODE_RE.test(digits) ? digits : ''
}

/** Code affiché sur le PC : « 482 913 ». */
export function formatCode(code: string): string {
  return CODE_RE.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export class PairCodes {
  private codes = new Map<string, { deviceId: string; expires: number }>()
  private fails: number[] = []

  constructor(private now: () => number = () => Date.now()) {}

  /** Nouveau code pour cet appairage en attente. */
  issue(deviceId: string, ttlMs: number): string {
    this.prune()
    let code = ''
    do code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
    while (this.codes.has(code))
    this.codes.set(code, { deviceId, expires: this.now() + ttlMs })
    return code
  }

  /** Code tapé sur le téléphone : l'appairage qu'il désigne (le code est
   *  alors consommé), ou null. */
  claim(raw: unknown): string | null {
    this.prune()
    const code = normalizeCode(raw)
    const hit = code ? this.codes.get(code) : undefined
    if (!hit) {
      const now = this.now()
      this.fails = this.fails.filter((t) => now - t < FAIL_WINDOW_MS)
      this.fails.push(now)
      if (this.fails.length > MAX_FAILS) {
        this.codes.clear()
        this.fails = []
      }
      return null
    }
    this.codes.delete(code)
    return hit.deviceId
  }

  /** Oublie le code d'un appairage (appairé par le QR code, retiré). */
  forget(deviceId: string): void {
    for (const [code, v] of this.codes) if (v.deviceId === deviceId) this.codes.delete(code)
  }

  size(): number {
    this.prune()
    return this.codes.size
  }

  private prune(): void {
    const now = this.now()
    for (const [code, v] of this.codes) if (v.expires <= now) this.codes.delete(code)
  }
}

/** Clé de chiffrement de la réponse : SHA-256 de l'étiquette, du code, des
 *  deux clés publiques et du secret X25519. Calculée de même sur le
 *  téléphone (webclient/phone.ts, codePairKey). */
export function codePairKey(shared: Uint8Array, code: string, phonePub: string, pcPub: string): Uint8Array {
  return new Uint8Array(
    crypto
      .createHash('sha256')
      .update(`flitdrop-codepair-v1|${code}|${phonePub}|${pcPub}|`)
      .update(shared)
      .digest()
  )
}

/** Côté PC : clé publique X25519 éphémère et clé de la réponse, ou null si
 *  la clé du téléphone est invalide. */
export function pcHandshake(phonePub: unknown, code: string): { pcPub: string; key: Uint8Array } | null {
  if (typeof phonePub !== 'string' || !PUB_RE.test(phonePub)) return null
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
    const pcPub = String(publicKey.export({ format: 'jwk' }).x)
    const peer = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: phonePub }, format: 'jwk' })
    const shared = new Uint8Array(crypto.diffieHellman({ privateKey, publicKey: peer }))
    // point de petit ordre : secret nul, refusé
    if (shared.every((b) => b === 0)) return null
    return { pcPub, key: codePairKey(shared, code, phonePub, pcPub) }
  } catch {
    return null
  }
}
