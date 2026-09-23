const { app, BrowserWindow, Tray, Menu, Notification, clipboard, nativeImage, shell, dialog, powerMonitor } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

let win = null
let tray = null
let core = null
let updater = null
let quitting = false
let clipWatcher = null

// i18n : fonctions du bundle coeur, chargées au démarrage. `tr` traduit selon le
// réglage de langue du PC, sinon la locale du système d'exploitation.
let _t = null
let _resolveLang = null
let _langFrom = null
const tr = (key, params) =>
  _t ? _t(_resolveLang(core && core.cfg ? core.cfg.lang : 'auto', _langFrom(app.getLocale())), key, params) : key

// Canal d'installation, pour les statistiques : Microsoft Store, installeur
// Windows (nsis), .dmg, AppImage, .deb, ou lancement de développement. La
// fiche du Store sert le même installeur .exe que le site : c'est l'installeur
// qui pose le marqueur « store-install » à côté de l'exe (build/installer.nsh),
// et le coeur garde « store » dans la config après une mise à jour.
function installChannel() {
  if (!app.isPackaged) return 'dev'
  if (process.platform === 'win32') {
    if (process.windowsStore) return 'store'
    try {
      if (fs.existsSync(path.join(path.dirname(process.execPath), 'store-install'))) return 'store'
    } catch {
      // illisible : installeur classique
    }
    return 'nsis'
  }
  if (process.platform === 'darwin') return 'dmg'
  if (process.env.APPIMAGE) return 'appimage'
  return 'deb'
}

// Rapports d'erreur du processus principal : confiés au coeur, qui les nettoie
// et ne les envoie qu'avec l'accord « statistiques détaillées ». Le moniteur
// n'altère pas le comportement par défaut d'Electron en cas d'exception.
function reportMainError(err, handled) {
  try {
    if (core && core.telemetry) core.telemetry.exception(err, 'main', handled)
  } catch {
    // jamais d'erreur en rapportant une erreur
  }
}
process.on('uncaughtExceptionMonitor', (err) => reportMainError(err, false))
process.on('unhandledRejection', (reason) => {
  console.error('Promesse rejetée non gérée :', reason)
  reportMainError(reason, false)
})

// Surveillance UNIQUE du presse-papiers : une minuterie pour le texte (lu par
// Electron et confié au coeur, sans lancer pbpaste ni PowerShell) et pour les
// images (ce que la page web ne peut pas lire). Une image restée copiée n'est
// plus réencodée ni relue en entier sans signe de nouvelle copie.
// Ralentie après une minute sans activité ou quand tout est coupé, en pause
// écran verrouillé ou en veille, avec une vérification immédiate au retour.
function watchClipboard(ClipboardWatcher) {
  clipWatcher = new ClipboardWatcher({
    clipboard,
    checkText: () => (core ? core.pollClipboard() : undefined),
    // Linux sous Wayland : le texte passe encore par wl-paste, qu'on ne lance
    // pas quand le presse-papiers ne contient qu'une image
    textNeedsTextFormat: usesExternalTextRead(),
    imagesEnabled: () => !!core && core.cfg.clipHistoryEnabled,
    anyEnabled: () => !!core && (core.cfg.clipHistoryEnabled || core.cfg.clipboardAutoPush),
    onImage: (png, thumb, w, h) => {
      if (core) core.addClipboardImage(png, thumb, w, h)
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
  })
  clipWatcher.start()
  // verrouillage : macOS et Windows seulement ; la veille partout. Deux causes
  // distinctes : un réveil derrière l'écran verrouillé reste en pause.
  powerMonitor.on('lock-screen', () => clipWatcher && clipWatcher.lock())
  powerMonitor.on('unlock-screen', () => clipWatcher && clipWatcher.unlock())
  powerMonitor.on('suspend', () => clipWatcher && clipWatcher.suspend())
  powerMonitor.on('resume', () => clipWatcher && clipWatcher.wake())
}

// Linux sous Wayland : on garde wl-paste tant que la lecture par Electron n'est
// pas testée sur Ubuntu.
function usesExternalTextRead() {
  return process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY
}

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
        title: n === 1 ? tr('notif.filesReady.one') : tr('notif.filesReady.other', { n }),
        body: tr('notif.filesReadyBody'),
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
    { label: tr('tray.open'), click: () => { win.show(); win.focus() } },
    { label: tr('tray.openFolder'), click: () => shell.openPath(core.cfg.downloadDir) },
    { type: 'separator' },
    {
      label: tr('tray.autostart'),
      type: 'checkbox',
      checked: isAutoStart(),
      click: (item) => {
        // démarre caché : Flitdrop attend en fond, comme AirDrop
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
      },
    },
    { label: tr('tray.checkUpdates'), click: () => { if (updater) updater.checkNow() } },
    { type: 'separator' },
    { label: tr('tray.quit'), click: () => { quitting = true; app.quit() } },
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
    const bundle = require(path.join(__dirname, 'core', 'flitdrop.cjs'))
    const { startServer, ClipboardWatcher } = bundle
    _t = bundle.t
    _resolveLang = bundle.resolveLang
    _langFrom = bundle.langFrom
    core = await startServer({
      quiet: true,
      // statistiques : version de l'app, canal d'installation, langue du système
      telemetry: { version: app.getVersion(), channel: installChannel(), systemLocale: app.getLocale() },
      // recopie d'une image de l'historique dans le presse-papiers système
      writeImageToClipboard: (png) => {
        try {
          clipboard.writeImage(nativeImage.createFromBuffer(png))
        } catch {
          // non critique
        }
      },
      // texte lu et écrit dans le processus, sans lancer de programme externe
      // (sauf Linux sous Wayland, voir usesExternalTextRead)
      clipboardText: usesExternalTextRead()
        ? undefined
        : { read: () => clipboard.readText(), write: (text) => clipboard.writeText(text) },
      // la surveillance unique ci-dessous appelle core.pollClipboard()
      manualClipboardPoll: true,
      // une fonction presse-papiers rallumée : vérification tout de suite
      onSettingsChanged: () => clipWatcher && clipWatcher.poke(),
    })
    watchClipboard(ClipboardWatcher)
    // auto-update : vérifie/télécharge la dernière version publiée sur GitHub,
    // propose de redémarrer. Windows fonctionne tout de suite ; macOS quand signé.
    try {
      const { setupAutoUpdate } = require(path.join(__dirname, 'updater.cjs'))
      updater = setupAutoUpdate({
        app,
        dialog,
        Notification,
        tr,
        isEnabled: () => !core || !core.cfg || core.cfg.autoUpdate !== false,
        getWin: () => win,
      })
    } catch {
      // l'app fonctionne même si l'auto-update échoue à s'initialiser
    }
    const isMac = process.platform === 'darwin'
    const isWin = process.platform === 'win32'
    const osTag = isMac ? 'mac' : isWin ? 'win' : 'linux'
    // l'interface web sait sur quel OS elle tourne pour servir le bon skin natif
    const url = `http://127.0.0.1:${core.port}/app/?k=${encodeURIComponent(core.adminToken)}&os=${osTag}`
    const startHidden = process.argv.includes('--hidden')

    /** @type {import('electron').BrowserWindowConstructorOptions} */
    const winOpts = {
      width: 1160,
      height: 760,
      minWidth: 940,
      minHeight: 620,
      autoHideMenuBar: true,
      title: 'Flitdrop',
      show: false,
      // Windows exige un .ico pour l'icône de fenêtre/barre des tâches ; un .png
      // y laisse l'icône par défaut. macOS/Linux prennent le .png.
      icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
      // démarrage caché : la page ne dessine rien (ni l'animation du radar)
      // avant la première ouverture. Seulement dans ce cas : sinon
      // 'ready-to-show' ne viendrait jamais et la fenêtre ne s'afficherait pas.
      paintWhenInitiallyHidden: !startHidden,
    }
    if (isMac) {
      // rendu natif macOS : feux tricolores intégrés + matériau "vibrancy"
      // (Liquid Glass) visible derrière l'interface translucide. La vibrancy
      // exige transparent:true (sinon aucun effet).
      winOpts.titleBarStyle = 'hiddenInset'
      winOpts.trafficLightPosition = { x: 18, y: 18 }
      winOpts.vibrancy = 'under-window'
      winOpts.visualEffectState = 'active'
      winOpts.transparent = true
      winOpts.backgroundColor = '#00000000'
    } else if (isWin) {
      // rendu natif Windows 11 : matériau Mica derrière la fenêtre (22H2+).
      // Mica exige transparent:false (défaut), on ne le passe donc pas.
      winOpts.backgroundMaterial = 'mica'
      winOpts.backgroundColor = '#00000000'
    } else {
      winOpts.backgroundColor = '#1b1b1b'
    }
    win = new BrowserWindow(winOpts)
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
      // macOS : image "template" monochrome (le système la teinte + la dimensionne
      // comme les icônes natives). Windows/Linux : l'icône couleur.
      const trayImg =
        process.platform === 'darwin'
          ? nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'))
          : nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'))
      if (process.platform === 'darwin') trayImg.setTemplateImage(true)
      tray = new Tray(trayImg)
      tray.setToolTip(tr('tray.tip'))
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
    dialog.showErrorBox('Flitdrop', tr('dialog.startFailed', { msg: err && err.message ? err.message : String(err) }))
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
    if (clipWatcher) clipWatcher.stop()
    if (core) await core.close().catch(() => {})
  })
}
