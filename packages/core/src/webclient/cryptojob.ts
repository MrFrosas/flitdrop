// Travail d'un Web Worker de chiffrement (voir cryptoworker.ts et
// cryptopool.ts), séparé de son point d'entrée pour être testé sous Node.
// Même construction que wdcrypto.ts (XChaCha20-Poly1305, nonce(24) ||
// chiffré || tag, même AAD) : le PC ne voit aucune différence. WebAssembly
// quand il est là (environ 10 fois plus rapide sans JIT), sinon le même code
// JavaScript que la page.
import { createWasmAead, type WasmAead } from '../xchacha-wasm.js'
import { seal as jsSeal, open as jsOpen, rand, NONCE_LEN } from './wdcrypto.js'

export type CryptoEngine = 'wasm' | 'js'

export interface CryptoJob {
  id: number
  op: 'seal' | 'open'
  key: Uint8Array
  aad: string
  buf: ArrayBuffer
}

export type CryptoReply =
  | { ready: true; engine: CryptoEngine }
  | { id: number; buf: ArrayBuffer; ms: number }
  | { id: number; error: 'auth' }
  /** échec du Worker lui-même (mémoire, moteur) : le tampon reçu revient
   *  intact, la page refait ce travail elle-même */
  | { id: number; error: 'fail'; buf?: ArrayBuffer }

const te = new TextEncoder()

/** Prépare le moteur (WebAssembly si possible, sinon JavaScript) et renvoie
 *  la fonction qui traite un travail : réponse + tampons à transférer. */
export function makeCryptoRunner(useWasm = true): {
  engine: CryptoEngine
  handle(job: CryptoJob): { reply: CryptoReply; transfer: ArrayBuffer[] }
} {
  const wasm: WasmAead | null = useWasm ? createWasmAead() : null
  const run = (job: CryptoJob): Uint8Array | null => {
    const data = new Uint8Array(job.buf)
    if (job.op === 'seal') {
      // nonce aléatoire neuf pour chaque morceau (crypto.getRandomValues)
      if (wasm) return wasm.seal(job.key, rand(NONCE_LEN), data, te.encode(job.aad))
      return jsSeal(job.key, data, job.aad)
    }
    if (wasm) return wasm.open(job.key, data, te.encode(job.aad))
    try {
      return jsOpen(job.key, data, job.aad)
    } catch {
      return null
    }
  }
  return {
    engine: wasm ? 'wasm' : 'js',
    handle(job) {
      const t0 = Date.now()
      let out: Uint8Array | null
      try {
        out = run(job)
      } catch {
        // l'entrée n'a pas été modifiée (le moteur travaille sur sa copie) :
        // elle repart à la page, qui refait ce morceau sans le perdre
        const back = job.buf.byteLength > 0 ? job.buf : undefined
        return { reply: { id: job.id, error: 'fail', buf: back }, transfer: back ? [back] : [] }
      }
      // tag faux : rien n'est déchiffré, la page abandonne ce téléchargement
      if (!out) return { reply: { id: job.id, error: 'auth' }, transfer: [] }
      // rendu sans copie (transfert du tampon) ; une vue partielle est recopiée
      const buf = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : new Uint8Array(out).buffer) as ArrayBuffer
      return { reply: { id: job.id, buf, ms: Date.now() - t0 }, transfer: [buf] }
    },
  }
}
