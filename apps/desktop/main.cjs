const { app, BrowserWindow, Tray, Menu, Notification, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

let win = null
let tray = null
let core = null
let quitting = false

// fichiers passés en argument : clic-droit "Envoyer vers > Flitdrop" dans
// l'Explorateur Windows, "Ouvrir avec", ou glisser sur l'icône de l'app.
function extractFiles(argv) {
  return argv.slice(1).filter((a) => {
    if (typeof a !== 'string' || a.startsWith('-')) return false
    try {
      return fs.statSync(a).isFile()
    } catch {
      return false
    }
  })
}

async function shareFiles(paths) {
  if (!core || paths.length === 0) return
  const n = await core.addLocalFiles(paths)
  if (n > 0) {
    try {
      new Notification({
        title: n === 1 ? 'Prêt pour le téléphone' : `${n} fichiers prêts pour le téléphone`,
        body: 'À récupérer dans Flitdrop, onglet « Recevoir ».',
      }).show()
    } catch {
      // les notifications ne sont pas critiques
    }
  }
}

function isAutoStart() {
  return app.getLoginItemSettings().openAtLogin
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Ouvrir Flitdrop', click: () => { win.show(); win.focus() } },
    { label: 'Ouvrir le dossier de réception', click: () => shell.openPath(core.cfg.downloadDir) },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de la session',
      type: 'checkbox',
      checked: isAutoStart(),
      click: (item) => {
        // démarre caché : Flitdrop attend en fond, comme AirDrop
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit() } },
  ])
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = extractFiles(argv)
    if (files.length > 0) {
      void shareFiles(files)
    } else if (win) {
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    const { startServer } = require(path.join(__dirname, 'core', 'flitdrop.cjs'))
    core = await startServer({ quiet: true })
    const url = `http://127.0.0.1:${core.port}/app/?k=${encodeURIComponent(core.adminToken)}`
    const startHidden = process.argv.includes('--hidden')

    win = new BrowserWindow({
      width: 1160,
      height: 760,
      minWidth: 940,
      minHeight: 620,
      backgroundColor: '#1b1b1b',
      autoHideMenuBar: true,
      title: 'Flitdrop',
      show: false,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    win.loadURL(url)
    // apparition sans flash blanc : on montre la fenêtre une fois prête
    win.once('ready-to-show', () => {
      if (!startHidden) win.show()
    })
    // fermer la fenêtre = passer en arrière-plan (la réception continue)
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        win.hide()
      }
    })

    try {
      tray = new Tray(path.join(__dirname, 'build', 'tray.png'))
      tray.setToolTip('Flitdrop : prêt à recevoir')
      tray.setContextMenu(buildTrayMenu())
      tray.on('double-click', () => { win.show(); win.focus() })
    } catch {
      // pas bloquant si l'icône de zone de notification échoue
    }

    // fichiers passés au tout premier lancement (Envoyer vers, Ouvrir avec)
    await shareFiles(extractFiles(process.argv))

    app.on('activate', () => { if (win) win.show() })
  }).catch((err) => {
    const { dialog } = require('electron')
    dialog.showErrorBox('Flitdrop', 'Flitdrop n\'a pas pu démarrer : ' + (err && err.message ? err.message : err))
    quitting = true
    app.quit()
  })

  // macOS : fichiers glissés sur l'icône du Dock
  app.on('open-file', (e, p) => {
    e.preventDefault()
    void shareFiles([p])
  })

  app.on('window-all-closed', () => {
    // rester actif en arrière-plan pour continuer à recevoir
  })

  app.on('before-quit', async () => {
    quitting = true
    if (core) await core.close().catch(() => {})
  })
}
