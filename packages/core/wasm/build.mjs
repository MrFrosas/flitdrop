// Compile wasm/xchacha20poly1305.c en WebAssembly et écrit src/xchacha-wasm-bin.ts
// (octets en base64). Le fichier produit est versionné : le build normal et
// le CI n'ont pas besoin de clang. À relancer seulement si le .c change :
//   node wasm/build.mjs
// Besoin : clang avec la cible wasm32 (celui de Xcode suffit, pas de wasm-ld :
// on garde l'objet relogeable, sans section de données ni appel externe, et on
// retire ses sections personnalisées). Le script vérifie tout ça avant d'écrire.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, 'xchacha20poly1305.c')
const out = path.join(here, '..', 'src', 'xchacha-wasm-bin.ts')
const obj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xcp-')), 'x.o')

execFileSync(
  process.env.CLANG || 'clang',
  ['--target=wasm32', '-mcpu=mvp', '-mmutable-globals', '-O2', '-nostdlib', '-ffreestanding', '-fno-builtin', '-Wall', '-Wextra', '-c', src, '-o', obj],
  { stdio: 'inherit' }
)
const raw = fs.readFileSync(obj)

// lecture des sections (en-tête 8 octets, puis id + taille LEB128 + contenu)
const leb = (buf, pos) => {
  let n = 0
  let shift = 0
  let b
  do {
    b = buf[pos++]
    n |= (b & 0x7f) << shift
    shift += 7
  } while (b & 0x80)
  return [n >>> 0, pos]
}
const kept = [raw.subarray(0, 8)]
const ids = []
for (let pos = 8; pos < raw.length; ) {
  const start = pos
  const id = raw[pos++]
  let size
  ;[size, pos] = leb(raw, pos)
  const end = pos + size
  if (id !== 0) {
    kept.push(raw.subarray(start, end))
    ids.push(id)
  }
  pos = end
}
const bytes = Buffer.concat(kept)
if (ids.includes(11)) throw new Error('section de données inattendue : les adresses ne seraient pas relogées')

const mod = new WebAssembly.Module(bytes)
const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}:${i.kind}`).sort()
const exportsList = WebAssembly.Module.exports(mod).map((e) => `${e.name}:${e.kind}`).sort()
const wantImports = ['env.__indirect_function_table:table', 'env.__linear_memory:memory', 'env.__stack_pointer:global']
if (JSON.stringify(imports) !== JSON.stringify(wantImports)) throw new Error('imports inattendus : ' + imports.join(', '))
if (JSON.stringify(exportsList) !== JSON.stringify(['xcp_open:function', 'xcp_seal:function']))
  throw new Error('exports inattendus : ' + exportsList.join(', '))

const b64 = bytes.toString('base64')
fs.writeFileSync(
  out,
  `// Généré par wasm/build.mjs depuis wasm/xchacha20poly1305.c : ne pas modifier à la main.\n` +
    `// ${bytes.length} octets, sha256 ${(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}\n` +
    `export const XCHACHA_WASM_B64 =\n  '${b64}'\n`
)
console.log(`wasm ${bytes.length} octets -> ${path.relative(process.cwd(), out)}`)
