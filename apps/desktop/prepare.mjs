// Copie le cœur bundlé + les interfaces web dans l'app Electron, et bundle
// l'auto-update. Après ça, l'app n'a besoin d'AUCUN node_modules à l'exécution.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.join(here, '..', '..', 'packages', 'core')

const dist = path.join(coreDir, 'dist', 'flitdrop.cjs')
if (!fs.existsSync(dist)) {
  console.error('dist/flitdrop.cjs introuvable : lance d’abord "npm run build -w @flitdrop/core"')
  process.exit(1)
}
fs.mkdirSync(path.join(here, 'core'), { recursive: true })
fs.copyFileSync(dist, path.join(here, 'core', 'flitdrop.cjs'))
fs.rmSync(path.join(here, 'public'), { recursive: true, force: true })
fs.cpSync(path.join(coreDir, 'public'), path.join(here, 'public'), { recursive: true })

// bundle l'auto-update (electron-updater inline, electron reste externe) : un
// seul fichier updater.cjs, aucun node_modules requis dans l'app empaquetée.
await esbuild.build({
  entryPoints: [path.join(here, 'src', 'updater.js')],
  outfile: path.join(here, 'updater.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning',
})
console.log('cœur, interfaces et auto-update préparés dans apps/desktop/')
