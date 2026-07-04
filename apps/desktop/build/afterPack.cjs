// Signature ad-hoc de l'app macOS après empaquetage.
// Sans aucune signature, macOS sur Apple Silicon refuse d'ouvrir l'app
// téléchargée avec « Flitdrop est endommagé et ne peut pas être ouvert ».
// Une signature ad-hoc (codesign -s -) suffit à la rendre lançable : il
// restera l'avertissement « développeur non identifié » (clic-droit > Ouvrir),
// ce qui est normal tant que l'app n'est pas notariée par Apple.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
      stdio: 'inherit',
    })
    console.log(`  • signature ad-hoc appliquée à ${appName}.app`)
  } catch (e) {
    console.warn('  ⚠ signature ad-hoc échouée :', e.message)
  }
}
