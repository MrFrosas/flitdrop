// Fabrique le .dmg macOS avec appdmg : écrit la mise en page (fond, positions
// des icônes) DIRECTEMENT dans le .DS_Store, sans passer par Finder ni
// AppleScript. C'est ce qui rend le fond fiable, y compris sur un serveur de
// build sans écran (là où electron-builder échoue en silence).
import appdmg from 'appdmg'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// icône du volume .dmg (facultatif) : convertie depuis le PNG via sips (macOS)
const icns = path.join(here, 'build', 'icon.icns')
if (!fs.existsSync(icns)) {
  try {
    execFileSync('sips', ['-s', 'format', 'icns', path.join(here, 'build', 'icon.png'), '--out', icns], { stdio: 'ignore' })
  } catch {
    // pas bloquant : le dmg aura l'icône par défaut
  }
}
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
const appPath = path.join(here, 'release', 'mac-arm64', 'Flitdrop.app')
if (!fs.existsSync(appPath)) {
  console.error('Flitdrop.app introuvable : lance d’abord electron-builder --mac dir')
  process.exit(1)
}
const outDir = path.join(here, 'release')
const out = path.join(outDir, `Flitdrop-${version}-arm64.dmg`)
fs.rmSync(out, { force: true })

const spec = {
  title: `Flitdrop ${version}`,
  icon: path.join(here, 'build', 'icon.icns'),
  background: path.join(here, 'build', 'background@2x.png'),
  'icon-size': 92,
  window: { size: { width: 540, height: 380 } },
  contents: [
    { x: 140, y: 190, type: 'file', path: appPath },
    { x: 400, y: 190, type: 'link', path: '/Applications' },
  ],
}
// l'icône de volume est optionnelle : on la retire si le .icns n'existe pas
if (!fs.existsSync(spec.icon)) delete spec.icon

await new Promise((resolve, reject) => {
  const ee = appdmg({ target: out, basepath: here, specification: spec })
  ee.on('progress', (info) => {
    if (info.type === 'step-begin') console.log('  •', info.title)
  })
  ee.on('finish', resolve)
  ee.on('error', reject)
})
console.log('dmg créé :', path.relative(process.cwd(), out))
