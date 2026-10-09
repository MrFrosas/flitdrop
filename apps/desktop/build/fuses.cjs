// Fusibles d'Electron de Flitdrop : des interrupteurs gravés dans le binaire
// d'Electron, posés par afterPack.cjs AVANT toute signature (macOS : codesign
// ad hoc juste après ; Windows : electron-builder signe l'exe après afterPack).
// Ils ferment les portes qui permettent de faire tourner un autre code que celui
// de l'app avec son identité, ou de modifier l'app sans que rien ne le voie.
//
// - RunAsNode coupé : ELECTRON_RUN_AS_NODE=1 ne transforme plus Flitdrop en
//   Node.js nu, capable d'exécuter n'importe quel script. Rien dans l'app ne
//   s'en sert : ni child_process.fork ni utilityProcess, le coeur ne lance que
//   des outils du système, et electron-updater lance l'installeur NSIS ou la
//   nouvelle AppImage, jamais l'exe en mode Node.
// - NODE_OPTIONS et --inspect (--inspect-brk, SIGUSR1) ignorés : plus
//   d'injection de code ni de débogueur dans le processus principal, celui qui
//   tient la licence.
// - Intégrité de app.asar : l'en-tête de l'archive est comparé à l'empreinte
//   écrite par electron-builder (Info.plist « ElectronAsarIntegrity » sur
//   macOS, ressource INTEGRITY/ELECTRONASAR de l'exe sur Windows), puis chaque
//   fichier lu à la sienne : un octet changé et l'app s'arrête net. Linux :
//   Electron ne fait pas cette vérification (shell/common/asar/archive.cc), le
//   fusible y est sans effet mais reste allumé pour un réglage unique.
// - OnlyLoadAppFromAsar : l'app ne démarre que depuis app.asar, jamais depuis
//   un dossier resources/app posé à côté pour contourner l'intégrité.
// - GrantFileProtocolExtraPrivileges coupé : la fenêtre charge
//   http://127.0.0.1, rien n'utilise file://.
// - Chiffrement des cookies : Windows seulement (DPAPI, silencieux). Fusible
//   allumé, Electron lit la clé à CHAQUE démarrage
//   (shell/browser/net/system_network_context_manager.cc, SetEncryptionKey).
//   macOS la range dans le trousseau : l'app n'y est signée qu'en ad hoc, son
//   empreinte change à chaque version, et macOS demanderait le mot de passe de
//   session après chaque mise à jour. Linux : trousseau GNOME ou KWallet, avec
//   la même fenêtre possible. Le gain y serait nul : Flitdrop ne garde aucun
//   cookie sur le disque (le cookie d'administration est un cookie de session).
// - LoadBrowserProcessSpecificV8Snapshot : inchangé.
//
// Usage en ligne de commande (tests du CI et vérifications locales) :
//   node build/fuses.cjs verifier <Flitdrop.app | Flitdrop.exe | flitdrop-bin> [darwin|win32|linux]
//   node build/fuses.cjs alterer-asar <app.asar> [entete|main.cjs]
const fs = require('node:fs')
const path = require('node:path')

// Réglage voulu, par plateforme d'Electron (darwin, win32, linux).
function fuseSettings(platform) {
  return {
    RunAsNode: false,
    EnableCookieEncryption: platform === 'win32',
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  }
}

// @electron/fuses 2.x est un module ESM
const loadFuses = () => import('@electron/fuses')

// Ce qu'on passe à @electron/fuses : le .app sur macOS (la bibliothèque y
// trouve « Electron Framework », qui porte les fusibles), l'exécutable ailleurs.
// Linux : à appeler AVANT que le lanceur renomme l'exécutable en *-bin.
function electronTarget(context) {
  const { appOutDir, electronPlatformName: platform, packager } = context
  if (platform === 'darwin') return path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  if (platform === 'win32') return path.join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  return path.join(appOutDir, packager.executableName)
}

// Relit les fusibles et lève une erreur au moindre écart : une mise à jour
// d'Electron ou de @electron/fuses ne peut pas les rallumer en silence.
async function verifyFuses(target, platform) {
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await loadFuses()
  const wire = await getCurrentFuseWire(target)
  const label = (state) =>
    state === FuseState.ENABLE ? 'allumé' : state === FuseState.DISABLE ? 'coupé' : state === FuseState.REMOVED ? 'retiré' : `inconnu (${state})`
  const lines = []
  const wrong = []
  for (const [name, on] of Object.entries(fuseSettings(platform))) {
    const got = wire[FuseV1Options[name]]
    lines.push(`${name} : ${label(got)}`)
    if (got !== (on ? FuseState.ENABLE : FuseState.DISABLE)) wrong.push(`${name} (attendu ${on ? 'allumé' : 'coupé'}, lu ${label(got)})`)
  }
  if (wrong.length > 0) throw new Error(`fusibles inattendus dans ${target} : ${wrong.join(', ')}`)
  return lines
}

async function flipAndVerifyFuses(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await loadFuses()
  const platform = context.electronPlatformName
  const target = electronTarget(context)
  const config = { version: FuseVersion.V1 }
  for (const [name, on] of Object.entries(fuseSettings(platform))) config[FuseV1Options[name]] = on
  await flipFuses(target, config)
  await verifyFuses(target, platform)
  console.log(`  • fusibles Electron posés et relus (${platform}, ${path.basename(target)})`)
}

// Test d'intégrité : change UN octet de app.asar, choisi pour que l'app
// démarrerait quand même SANS la vérification (le test ne prouve donc que
// l'intégrité) : « entete », un chiffre de l'empreinte d'un fichier dans
// l'en-tête ; sinon une lettre d'un commentaire du fichier nommé (main.cjs par
// défaut, lu au démarrage). Ne sert qu'aux tests, sur une COPIE de l'app.
function alterAsar(asarPath, where) {
  const fd = fs.openSync(asarPath, 'r+')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    fs.readSync(fd, json, 0, jsonLength, 16)
    let pos
    let next
    if (where === 'entete') {
      const at = json.lastIndexOf('"hash":"')
      if (at < 0) throw new Error('aucune empreinte dans l’en-tête (archive sans intégrité ?)')
      pos = 16 + at + '"hash":"'.length
      next = (c) => (c === 0x30 ? 0x31 : 0x30)
    } else {
      const entry = JSON.parse(json.toString('utf8')).files[where]
      if (!entry || entry.offset === undefined) throw new Error(`${where} absent de l’archive`)
      const start = 8 + headerSize + Number(entry.offset)
      const body = Buffer.alloc(entry.size)
      fs.readSync(fd, body, 0, entry.size, start)
      let at = body.indexOf('// ')
      while (at >= 0 && !/[a-z]/i.test(String.fromCharCode(body[at + 3]))) at = body.indexOf('// ', at + 3)
      if (at < 0) throw new Error(`aucun commentaire modifiable dans ${where}`)
      pos = start + at + 3
      next = (c) => c ^ 0x20
    }
    const b = Buffer.alloc(1)
    fs.readSync(fd, b, 0, 1, pos)
    const before = String.fromCharCode(b[0])
    b[0] = next(b[0])
    fs.writeSync(fd, b, 0, 1, pos)
    console.log(`octet ${pos} de ${path.basename(asarPath)} changé (${where}) : « ${before} » devient « ${String.fromCharCode(b[0])} »`)
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = { fuseSettings, electronTarget, verifyFuses, flipAndVerifyFuses, alterAsar }

if (require.main === module) {
  const [cmd, target, arg] = process.argv.slice(2)
  if (cmd === 'verifier' && target) {
    verifyFuses(target, arg || process.platform).then(
      (lines) => {
        for (const l of lines) console.log(`  ${l}`)
        console.log('fusibles conformes')
      },
      (e) => {
        console.error(e.message)
        process.exit(1)
      }
    )
  } else if (cmd === 'alterer-asar' && target) {
    alterAsar(target, arg || 'main.cjs')
  } else {
    console.error('usage : node build/fuses.cjs verifier <app> [plateforme] | alterer-asar <app.asar> [entete|main.cjs]')
    process.exit(2)
  }
}
