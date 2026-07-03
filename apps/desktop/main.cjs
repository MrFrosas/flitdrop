const { app, BrowserWindow, Tray, Menu, shell } = require('electron')
const path = require('node:path')

let win = null
let tray = null
let core = null
let quitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    const { startServer } = require(path.join(__dirname, 'core', 'flitdrop.cjs'))
    core = await startServer({ quiet: true })
    const url = `http://127.0.0.1:${core.port}/app/?k=${encodeURIComponent(core.adminToken)}`

    win = new BrowserWindow({
      width: 1160,
      height: 760,
      minWidth: 940,
      minHeight: 620,
      backgroundColor: '#0a0e16',
      autoHideMenuBar: true,
      title: 'Flitdrop',
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    win.loadURL(url)
    // fermer la fenêtre = passer en arrière-plan (la réception continue)
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        win.hide()
      }
    })

    try {
      tray = new Tray(path.join(__dirname, 'build', 'tray.png'))
      tray.setToolTip('Flitdrop — prêt à recevoir')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Ouvrir Flitdrop', click: () => { win.show(); win.focus() } },
          { label: 'Ouvrir le dossier de réception', click: () => shell.openPath(core.cfg.downloadDir) },
          { type: 'separator' },
          { label: 'Quitter', click: () => { quitting = true; app.quit() } },
        ])
      )
      tray.on('double-click', () => { win.show(); win.focus() })
    } catch {
      // pas bloquant si l'icône de zone de notification échoue
    }

    app.on('activate', () => { if (win) win.show() })
  })

  app.on('window-all-closed', () => {
    // rester actif en arrière-plan pour continuer à recevoir
  })

  app.on('before-quit', async () => {
    quitting = true
    if (core) await core.close().catch(() => {})
  })
}
