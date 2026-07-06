// Auto-update façon VS Code / Slack : vérifie la derniere version publiee sur
// GitHub, la telecharge en arriere-plan, et propose de redemarrer pour
// l'installer. Le flux tag -> release GitHub sert de serveur de mise a jour.
// Ce fichier est bundle par esbuild (electron-updater inline, electron externe)
// en updater.cjs pour eviter tout souci d'empaquetage node_modules du monorepo.
const { autoUpdater } = require('electron-updater')

/**
 * @param {{
 *  app: import('electron').App,
 *  dialog: import('electron').Dialog,
 *  Notification: typeof import('electron').Notification,
 *  tr: (key: string, params?: Record<string, string|number>) => string,
 *  isEnabled: () => boolean,
 *  getWin: () => import('electron').BrowserWindow | null,
 * }} opts
 */
function setupAutoUpdate(opts) {
  const { app, dialog, Notification, tr, isEnabled, getWin } = opts
  // pas de mise a jour en developpement (app non empaquetee)
  if (!app.isPackaged) return { checkNow: () => {} }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Windows fonctionne des maintenant ; macOS n'appliquera les MAJ qu'une fois
  // l'app signee + notarisee (Apple refuse une mise a jour non signee).
  autoUpdater.on('error', () => {
    // silencieux : hors-ligne, pas de release, etc. ne doivent rien casser
  })

  let notified = false
  autoUpdater.on('update-available', (info) => {
    if (notified) return
    notified = true
    try {
      new Notification({
        title: tr('update.available', { v: info && info.version ? info.version : '' }),
        body: tr('update.downloading'),
      }).show()
    } catch {
      // notifications non critiques
    }
  })

  let prompted = false
  autoUpdater.on('update-downloaded', async (info) => {
    if (prompted) return
    prompted = true
    const win = getWin && getWin()
    try {
      const res = await dialog.showMessageBox(win || undefined, {
        type: 'info',
        buttons: [tr('update.restart'), tr('update.later')],
        defaultId: 0,
        cancelId: 1,
        title: tr('update.readyTitle'),
        message: tr('update.readyTitle'),
        detail: tr('update.readyBody', { v: info && info.version ? info.version : '' }),
      })
      if (res.response === 0) setImmediate(() => autoUpdater.quitAndInstall())
      // sinon : la MAJ s'installera au prochain « Quitter » (autoInstallOnAppQuit)
    } catch {
      // ignore
    }
  })

  const check = () => {
    if (isEnabled()) autoUpdater.checkForUpdates().catch(() => {})
  }
  // 1er controle 10 s apres le lancement (laisse l'app demarrer), puis toutes les 6 h
  setTimeout(check, 10_000)
  const timer = setInterval(check, 6 * 60 * 60 * 1000)
  timer.unref?.()

  return { checkNow: () => autoUpdater.checkForUpdates().catch(() => {}) }
}

module.exports = { setupAutoUpdate }
