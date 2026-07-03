import { startServer } from './server.js'
import { PRODUCT_NAME, VERSION } from './constants.js'
import { localIPv4s } from './util.js'
import os from 'node:os'

async function main() {
  const info = await startServer({})

  const ip = localIPv4s()[0] ?? '127.0.0.1'
  console.log(`
  ${PRODUCT_NAME} v${VERSION} — prêt.

  Interface du PC   ${info.adminUrl}
  Réseau local      http://${ip}:${info.port}  (les téléphones s'appairent par QR code depuis l'interface)
  Raccourci iOS     http://${os.hostname().replace(/\.local$/i, '')}.local:${info.port}
  Fichiers reçus    ${info.cfg.downloadDir}
`)

  const shutdown = async () => {
    await info.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('Démarrage impossible :', (e as Error).message)
  process.exit(1)
})
