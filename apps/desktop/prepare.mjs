// Copie le cœur bundlé + les interfaces web dans l'app Electron.
// Après ça, l'app n'a besoin d'AUCUN node_modules à l'exécution.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
console.log('cœur et interfaces copiés dans apps/desktop/')
