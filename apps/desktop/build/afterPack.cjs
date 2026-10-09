// Retouches après empaquetage, par plateforme.
//
// Toutes plateformes, en premier : fusibles d'Electron (voir build/fuses.cjs).
// Ils modifient le binaire, donc ils passent AVANT la signature ad hoc de macOS
// ci-dessous et avant la signature Windows (faite par electron-builder après
// afterPack). L'empreinte de app.asar est déjà écrite à ce stade (Info.plist,
// ressource de l'exe) et rien ici ne touche à app.asar.
//
// macOS : signature ad-hoc de l'app. Sans aucune signature, macOS sur Apple
// Silicon refuse d'ouvrir l'app téléchargée avec « Flitdrop est endommagé et ne
// peut pas être ouvert ». Une signature ad-hoc (codesign -s -) suffit à la rendre
// lançable : il restera l'avertissement « développeur non identifié », normal
// tant que l'app n'est pas notariée. Depuis macOS 15, le clic droit > Ouvrir ne
// suffit plus : on ouvre l'app une fois, puis Réglages Système >
// Confidentialité et sécurité > Ouvrir quand même.
//
// Linux : lanceur pour l'AppImage. Dans une AppImage, l'assistant de bac à sable
// de Chromium (chrome-sandbox) ne peut pas être setuid root, et Ubuntu 24.04+
// interdit par défaut les espaces de noms utilisateur aux apps non confinées
// (kernel.apparmor_restrict_unprivileged_userns=1) : Electron s'arrête alors
// AVANT d'exécuter le moindre JS (« The SUID sandbox helper binary was found,
// but is not configured correctly »). electron-builder ne passe --no-sandbox que
// via le raccourci du menu, pas au double-clic sur le fichier. Le lanceur
// l'ajoute donc seulement quand l'app tourne depuis une AppImage ($APPIMAGE est
// posé par le runtime AppImage). Le .deb, lui, installe chrome-sandbox setuid
// (after-install) et garde le bac à sable complet.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { flipAndVerifyFuses } = require('./fuses.cjs')

function linuxLauncher(context) {
  const exe = context.packager.executableName
  const bin = path.join(context.appOutDir, exe)
  const real = path.join(context.appOutDir, `${exe}-bin`)
  if (!fs.existsSync(bin)) throw new Error(`exécutable Linux introuvable : ${bin}`)
  fs.renameSync(bin, real)
  const script = [
    '#!/bin/sh',
    '# Lanceur Flitdrop (Linux), voir apps/desktop/build/afterPack.cjs.',
    'HERE="$(dirname "$(readlink -f "$0")")"',
    'if [ -n "$APPIMAGE" ]; then',
    `  exec "$HERE/${exe}-bin" --no-sandbox "$@"`,
    'fi',
    `exec "$HERE/${exe}-bin" "$@"`,
    '',
  ].join('\n')
  fs.writeFileSync(bin, script, { mode: 0o755 })
  console.log(`  • lanceur Linux posé (${exe} -> ${exe}-bin)`)
}

exports.default = async function afterPack(context) {
  // Linux : sur l'exécutable d'Electron, avant que le lanceur le renomme
  await flipAndVerifyFuses(context)
  if (context.electronPlatformName === 'linux') {
    linuxLauncher(context)
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  // Les fusibles ont changé « Electron Framework » : sans nouvelle signature,
  // macOS refuse de lancer l'app sur Apple Silicon. Un échec arrête donc le
  // build au lieu de produire une app morte.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
      stdio: 'inherit',
    })
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  } catch (e) {
    throw new Error(`signature ad-hoc de ${appName}.app échouée : ${e.message}`)
  }
  console.log(`  • signature ad-hoc appliquée à ${appName}.app et vérifiée`)
  console.log(
    '  • 1er lancement (app non notariée) : ouvrir l’app une fois, puis Réglages Système > Confidentialité et sécurité > Ouvrir quand même'
  )
}
