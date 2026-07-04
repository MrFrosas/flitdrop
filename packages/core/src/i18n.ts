// Dictionnaire partagé (anglais + français) + helpers. Aucune dépendance au DOM :
// ce module est importé par les deux clients web, par l'app Electron (main.cjs)
// et par le serveur, pour que le même texte ne soit jamais écrit deux fois.
// La manipulation du DOM (applyI18n) vit dans i18n-dom.ts.

export type Lang = 'en' | 'fr'
export const LANGS: Lang[] = ['en', 'fr']

type Dict = Record<string, string>

// Anglais d'abord (audience mondiale), puis français. Les clés sont plates,
// en points. Les pluriels utilisent des sous-clés .one / .other.
const en: Dict = {
  // unités et temps
  'unit.b': 'B', 'unit.kb': 'KB', 'unit.mb': 'MB', 'unit.gb': 'GB',
  'time.now': 'just now', 'time.never': 'never seen',
  // navigation / vues (PC)
  'nav.radar': 'Radar', 'nav.history': 'History', 'nav.send': 'Send', 'nav.clipboard': 'Clipboard', 'nav.settings': 'Settings',
  'header.pair': 'Pair a phone',
  'live.title': 'Live', 'live.calm': 'All quiet', 'live.calmHint': 'Incoming transfers show up here in real time.',
  'radar.thisPc': 'This PC',
  // radar / réceptions
  'feed.receiving': 'Receiving from {name}…', 'feed.openFolder': 'Open folder', 'feed.textCopied': 'Text copied to your clipboard', 'feed.copyAgain': 'Copy again',
  // historique
  'hist.empty': 'Nothing yet', 'hist.emptyHint': 'Files and texts you exchange appear here.',
  'hist.file': 'file', 'hist.text': 'text', 'hist.clip': 'clipboard', 'hist.from': 'from {name}', 'hist.to': 'to {name}', 'hist.open': 'Open folder',
  // envoi (PC -> tel)
  'send.title': 'Send to a phone', 'send.drop': 'Drop files here', 'send.dropHint': 'or <u>click to browse</u>. The phone picks them up in its « Received » tab.',
  'send.textTitle': 'Send a text', 'send.textPlaceholder': 'Type or paste text to send to the phone…', 'send.textBtn': 'Make available',
  'send.queueTitle': 'Ready for the phone', 'send.outboxEmpty': 'Nothing waiting', 'send.outboxEmptyHint': 'Drop a file above and it appears on the paired phone.',
  'outbox.downloaded': 'picked up ✓', 'outbox.waiting': 'waiting',
  // presse-papiers (PC)
  'clip.search': 'Search history…', 'clip.clear': 'Clear all', 'clip.disabled': 'History disabled', 'clip.disabledHint': 'Enable « Clipboard history » in settings to keep what you copy here.',
  'clip.empty': 'Clipboard empty', 'clip.emptyHint': 'Everything you copy on this PC lands here.',
  'clip.copiedHere': 'copied on this PC', 'clip.received': 'received from {name}', 'clip.open': 'Open', 'clip.copy': 'Copy', 'clip.phone': 'Phone',
  'clip.kind.youtube': 'YouTube video', 'clip.kind.image': 'Image', 'clip.kind.link': 'Link', 'clip.kind.email': 'E-mail', 'clip.kind.color': 'Color', 'clip.kind.code': 'Code', 'clip.kind.text': 'Text',
  // réglages (PC)
  'set.thisPc': 'This PC', 'set.style': 'Style', 'set.theme': 'Theme', 'set.lang': 'Language',
  'set.auto': 'Automatic (system)', 'opt.auto': 'Automatic', 'set.apple': 'Apple', 'set.windows': 'Windows', 'set.light': 'Light', 'set.dark': 'Dark', 'set.langFr': 'Français', 'set.langEn': 'English',
  'set.name': 'Name shown to phones', 'set.dir': 'Download folder', 'set.maxFile': 'Max file size', 'set.approval': 'Ask me before each transfer',
  'set.clipboard': 'Sync my clipboard to phones (when I copy text on the PC it becomes available on the phone, « Received » tab)',
  'set.clipHistory': 'Clipboard history (local only, auto-purged)', 'set.keepMax': 'Keep at most', 'set.eraseAfter': 'Erase after',
  'set.items': '{n} items', 'set.hours': '{n} hours', 'set.days': '{n} days',
  'set.save': 'Save', 'set.saved': 'Settings saved ✓', 'set.saveFailed': 'Setting rejected',
  // Raccourci iOS
  'sc.title': 'Direct share from iPhone (Shortcut)', 'sc.hint': 'With an Apple Shortcut, « Send to PC » appears in the iPhone share sheet: Photos → Share → Send to PC. No app to install.',
  'sc.enable': 'Enable Shortcut sharing. Handy, but this channel is not encrypted (unlike the rest): turn it off on a public Wi-Fi you don’t control.',
  'sc.device': 'Phone concerned', 'sc.create': 'Create the shortcut (2 minutes, once)',
  'sc.step1': 'On the iPhone, open the <b>Shortcuts</b> app and create a new shortcut.', 'sc.step2': 'In its settings (ⓘ icon), turn on <b>« Show in Share Sheet »</b>.',
  'sc.step3': 'Add the <b>« Get Contents of URL »</b> action with the « Send files » address above.', 'sc.step4': 'Method <b>POST</b>, body <b>Form</b>: add a <b>File</b> field named <code>file</code> with the <b>Shortcut Input</b> variable.',
  'sc.step5': 'Name it <b>« Send to PC »</b>, pick an icon, save.', 'sc.step6': 'From Photos or any app: Share → Send to PC. Done.',
  'sc.pairFirst': 'Pair a phone first', 'sc.rowFiles': 'Send files', 'sc.rowText': 'Paste on PC', 'sc.rowClip': 'Read PC clipboard', 'sc.rowFallback': 'Fallback if .local fails',
  // aide / confidentialité
  'help.title': 'Help and privacy', 'help.hint': 'An idea, a bug? Say it in two clicks, it opens a pre-filled ticket on GitHub.', 'help.reportBug': 'Report a problem', 'help.suggest': 'Suggest an idea',
  'help.telemetry': 'Help improve Flitdrop by sharing anonymous usage and error data. No content of your files or clipboard is ever sent. Off by default, you decide.',
  'help.issueBug': 'Problem: ', 'help.issueIdea': 'Idea: ', 'help.version': 'Version', 'help.savedPref': 'Preference saved ✓',
  // réinitialiser
  'reset.title': 'Reset this PC', 'reset.hint': 'Every phone you pair is tied to THIS PC only: nobody else on the Wi-Fi sees your data. If you lend or sell the machine, reset to wipe everything: paired devices, clipboard history and pending files. Phones will need to scan a QR code again.',
  'reset.btn': 'Reset this PC', 'reset.confirm': 'Reset this PC?\n\nAll paired phones will be forgotten, the clipboard history and pending files will be erased. Phones will have to scan a QR code again.', 'reset.done': 'PC reset ✓', 'reset.doneHint': 'Pairings and history erased.', 'reset.failed': 'Reset failed',
  // appairage (modale PC)
  'pair.title': 'Pair a phone', 'pair.hint': 'Scan this QR code with the phone’s camera (same Wi-Fi as the PC).', 'pair.orScan': '  (or scan the QR code)',
  'pair.waiting': 'Waiting for scan…', 'pair.rename': 'Device name', 'pair.done': 'Done', 'pair.cannotScan': 'Phone can’t scan?', 'pair.copyHint': 'Copy this link and open it on the phone. It contains the pairing key: keep it private.', 'pair.copyLink': 'Copy pairing link', 'pair.linkCopied': 'Pairing link copied ✓', 'pair.linkCopiedHint': 'Open it on the phone.', 'pair.copyFailed': 'Copy failed', 'pair.paired': 'Paired ✓', 'pair.cancel': 'Close',
  // bienvenue
  'welcome.title': 'Welcome to Flitdrop', 'welcome.body': 'Send files, photos and clipboard between your phone and this PC, encrypted end to end. Nothing to install on the phone.', 'welcome.start': 'Pair my phone', 'welcome.skip': 'Later',
  // divers PC
  'common.copied': 'Copied ✓', 'common.copyFailed': 'Could not copy', 'common.close': 'Close', 'common.open': 'Open',
  'up.filesReady.one': 'File ready ✓', 'up.filesReady.other': '{n} files ready ✓', 'up.readyHint': '« Received » tab on the phone.', 'up.failed': 'Send failed',
  'device.seen': 'Last seen {when}', 'device.revoke': 'Remove device', 'device.rename': 'Rename', 'device.pairedSeen': 'Paired {paired} · last seen {seen}. Exchanges with this device are end-to-end encrypted.',
  'appr.title': 'Incoming transfer', 'appr.body': '{name} wants to send « {file} » ({size}).', 'appr.accept': 'Accept', 'appr.decline': 'Decline',
  'clipboard.empty': 'Clipboard empty',
  // desktop : divers écrans
  'radar.empty': 'No phone paired', 'radar.emptyHint': '30 seconds, a QR code, and you’re set.',
  'send.textPh': 'A link, an address, a wifi password…', 'send.pushClip': 'Send my clipboard', 'send.dropOverlay': 'Drop to make it available to the phone',
  'device.title': 'Device', 'device.shortcut': 'Set up the iPhone shortcut',
  'sz.512mb': '512 MB', 'sz.1gb': '1 GB', 'sz.4gb': '4 GB', 'sz.8gb': '8 GB', 'sz.16gb': '16 GB',
  'opt.items50': '50 items', 'opt.items200': '200 items', 'opt.items500': '500 items', 'opt.h24': '24 hours', 'opt.d7': '7 days', 'opt.d30': '30 days',
  'welcome.intro': 'Your PC’s AirDrop. Three things to know, that’s it:',
  'welcome.step1': '<b>Pair your phone once.</b> One QR code to scan, the connection is remembered, even after a restart.',
  'welcome.step2': '<b>Send both ways.</b> The phone sends photos and text; you drop files here, it picks them up.',
  'welcome.step3': '<b>Everything stays with you.</b> End-to-end encrypted, on your wifi, no cloud, no account.',
  // desktop : toasts et états dynamiques
  'clip.phoneTitle': 'Make available to the phone', 'clip.readyPhone': 'Ready on the phone ✓', 'clip.recvTab': '« Received » tab.',
  'pair.connected': 'Phone connected ✓', 'toast.devicePaired': 'New device paired',
  'toast.pickedUp': 'Picked up on the phone ✓', 'toast.clipSynced': 'Clipboard synced ✓',
  'toast.renamed': 'Device renamed ✓', 'toast.removed': 'Device removed', 'toast.removedHint': 'It can no longer send anything to this PC.',
  'toast.textQueued': 'Text made available ✓', 'toast.clipPushed': 'Clipboard sent ✓', 'toast.histCleared': 'History cleared', 'toast.openFolderFailed': 'Could not open the folder',
  // ---------- TELEPHONE ----------
  'ph.brand': 'Flitdrop',
  'ph.scan.title': 'Connect this phone to your PC', 'ph.scan.lead': 'Open Flitdrop on the PC, click « Pair a phone » and scan the QR code with the camera.',
  'ph.paste.hint': 'From the home screen you can’t scan. On the PC, open « Pair a phone » > « Copy pairing link », then paste it here:', 'ph.paste.placeholder': 'Paste the pairing link', 'ph.paste.btn': 'Connect', 'ph.paste.invalid': 'Invalid pairing link',
  'ph.err.notFound': 'PC not found', 'ph.err.notFoundMsg': 'Check that Flitdrop is open on the PC and your phone is on the same Wi-Fi.', 'ph.err.retry': 'Retry', 'ph.err.forget': 'Forget this PC',
  'ph.err.revoked': 'Pairing refused', 'ph.err.revokedMsg': 'This phone was removed on the PC. Scan a QR code again to reconnect.',
  'ph.err.wrongPc': 'Paired to another PC', 'ph.err.wrongPcMsg': 'This phone is paired to another Flitdrop PC. Scan the right PC’s QR code.',
  'ph.err.notThisPc': 'Not the right PC', 'ph.err.notThisPcMsg': 'Another PC answers at this address. Scan the paired PC’s QR code.',
  'ph.altHint': 'The PC may have changed address. Try:', 'ph.reconnectVia': 'Reconnect via {host}',
  'ph.title': 'Share', 'ph.connectedTo': 'Connected to', 'ph.menuInfo': 'This phone is paired to « {name} ». Transfers are end-to-end encrypted.',
  'ph.install.title': 'Add Flitdrop to the home screen', 'ph.install.sub': 'One tap and it opens like a real app, already connected.', 'ph.install.add': 'Add',
  'ph.tab.send': 'Send', 'ph.tab.text': 'Text', 'ph.tab.recv': 'Received', 'ph.tab.clip': 'History',
  'ph.send.title': 'Choose files', 'ph.send.hint': 'Photos, videos, documents. They land in the PC’s Flitdrop folder.',
  'ph.send.queued': 'Queued…', 'ph.send.empty': 'Empty file, skipped', 'ph.send.tooBig': 'Too large (limit {size})', 'ph.send.progress': '{pct} % · {speed}/s', 'ph.send.lost': 'Connection lost, resuming…', 'ph.send.arrived': 'Delivered to {name} ✓', 'ph.send.refused': 'Refused on the PC', 'ph.send.lostRetry': 'Connection lost, try again', 'ph.send.failed': 'Send failed',
  'ph.send.sending': 'Sending <b>{a}/{b}</b>…', 'ph.send.processed': '<b>{n}</b> files processed',
  'ph.text.placeholder': 'Paste or type your text here…', 'ph.text.count.one': '{n} character', 'ph.text.count.other': '{n} characters',
  'ph.text.btn': 'Send to PC', 'ph.text.sending': 'Sending…', 'ph.text.done': 'In the PC clipboard ✓', 'ph.text.hint': 'The text lands straight in the PC clipboard. Ctrl+V and it’s pasted.',
  'ph.recv.textFrom': 'Text from PC', 'ph.recv.copy': 'Copy', 'ph.recv.open': 'Open', 'ph.recv.empty': 'Nothing waiting.', 'ph.recv.emptyHint': 'On the PC, drop a file into Flitdrop, « Send » tab, and it appears here.',
  'ph.recv.copied': 'Copied to your clipboard ✓', 'ph.recv.selectCopy': 'Select the text to copy it', 'ph.recv.downloading': 'Downloading…', 'ph.recv.done': 'Received ✓', 'ph.recv.fileDone': 'File downloaded ✓', 'ph.recv.dlFailed': 'download failed', 'ph.recv.incomplete': 'incomplete transfer, try again',
  'ph.clip.receive': 'Receive', 'ph.clip.copiedPc': 'Copied on the PC', 'ph.clip.receivedFrom': 'Received from {name}', 'ph.clip.copy': 'Copy', 'ph.clip.imgAvailable': 'Available in « Received » ✓', 'ph.clip.imgFailed': 'Could not fetch the image', 'ph.clip.empty': 'Clipboard empty', 'ph.clip.emptyHint': 'Copy text, a link or an image on the PC: it shows up here, ready to paste on this phone.', 'ph.clip.disabled': 'History disabled', 'ph.clip.disabledHint': 'Turn on « Clipboard history » in Flitdrop’s settings on the PC.',
  'ph.img.hint': 'Press and hold the image to save it to your photos.',
  'ph.menu.title': 'This phone', 'ph.menu.style': 'Style', 'ph.menu.theme': 'Theme', 'ph.menu.lang': 'Language', 'ph.menu.android': 'Android',
  'ph.menu.install': 'Add to home screen', 'ph.menu.forget': 'Forget this PC', 'ph.menu.close': 'Close',
  'ph.installSheet.title': 'Flitdrop like an app', 'ph.installSheet.ios': 'In Safari: Share button (the square with an arrow), then « Add to Home Screen ». The Flitdrop icon appears like an app, connected to your PC, no QR re-scan.', 'ph.installSheet.android': 'In Chrome: menu ⋮ top right, then « Add to Home screen ». The Flitdrop icon appears like an app, connected to your PC, no QR re-scan.',
  // ---------- Electron (barre systeme, notifications, dialogue) ----------
  'tray.open': 'Open Flitdrop', 'tray.openFolder': 'Open download folder', 'tray.autostart': 'Launch at session start', 'tray.quit': 'Quit', 'tray.tip': 'Flitdrop: ready to receive',
  'notif.filesReady.one': 'Ready for the phone', 'notif.filesReady.other': '{n} files ready for the phone', 'notif.filesReadyBody': 'Pick them up in Flitdrop, « Received » tab.',
  'dialog.startFailed': 'Flitdrop could not start: {msg}',
  // ---------- reponses serveur en clair (Raccourci iOS, garde admin) ----------
  'srv.shortcutOff': 'Shortcut sharing is disabled on this PC (« Direct iPhone share » setting).',
  'srv.loopbackOnly': 'This interface is only accessible from this PC.',
  'srv.adminBadLink': 'Flitdrop: invalid link. Relaunch the app to get the right link.',
  'srv.scArrivedOne': '« {name} » arrived on {pc} ✅', 'srv.scArrivedMany': '{n} files arrived on {pc} ✅', 'srv.scCopied': 'Copied to {pc} ✅',
  'srv.scBadToken': 'Invalid token. Re-scan the Flitdrop QR code on your PC.', 'srv.scNoFile': 'No file received.', 'srv.scTooBig': 'File too large (limit {mb} MB).', 'srv.scFailed': 'Reception failed.', 'srv.scNothing': 'Nothing to copy.',
  // ---------- codes d'erreur API (localises cote client) ----------
  'err.deviceUnknown': 'Unknown or removed device', 'err.authRefused': 'Authentication refused', 'err.wrongPc': 'Device paired to another PC', 'err.rateLimited': 'Too many requests, try again in a minute',
  'err.transferNotFound': 'Transfer not found', 'err.badIndex': 'Invalid index', 'err.missingBody': 'Missing body', 'err.badChunk': 'Corrupt chunk or invalid key', 'err.badChunkSize': 'Invalid chunk size', 'err.chunkOrder': 'Invalid chunk order', 'err.tooManyTransfers': 'Too many simultaneous transfers', 'err.transferDone': 'Transfer finished', 'err.transferIncomplete': 'Incomplete transfer', 'err.diskWrite': 'Disk write error', 'err.badSize': 'Invalid size', 'err.tooBig': 'File too large', 'err.badSplit': 'Inconsistent chunking', 'err.refused': 'Transfer refused on the PC',
  'err.textEmpty': 'Empty or too long text', 'err.entryNotFound': 'Entry not found', 'err.itemNotFound': 'Item not found', 'err.imageGone': 'Image no longer available', 'err.fileGone': 'File no longer available', 'err.notAFile': 'Not a file',
  'err.localOnly': 'Local access only', 'err.unauthorized': 'Not authorized', 'err.imgCopyUnavailable': 'Image copy unavailable', 'err.clipWriteFailed': 'Could not write to the clipboard', 'err.pairingNotFound': 'Pairing not found', 'err.emptyName': 'Empty name', 'err.deviceNotFound': 'Device not found', 'err.clipboardEmpty': 'Clipboard empty', 'err.badLink': 'Invalid link', 'err.requestExpired': 'Request expired', 'err.badFolderPath': 'Invalid folder path', 'err.cannotCreateFolder': 'Could not create this folder',
  'err.generic': 'Error {status}', 'err.internal': 'Internal error', 'err.notFound': 'Not found',
}

const fr: Dict = {
  'unit.b': 'o', 'unit.kb': 'Ko', 'unit.mb': 'Mo', 'unit.gb': 'Go',
  'time.now': 'à l’instant', 'time.never': 'jamais vu',
  'nav.radar': 'Radar', 'nav.history': 'Historique', 'nav.send': 'Envoyer', 'nav.clipboard': 'Presse-papiers', 'nav.settings': 'Réglages',
  'header.pair': 'Appairer un téléphone',
  'live.title': 'En direct', 'live.calm': 'Tout est calme', 'live.calmHint': 'Les réceptions apparaissent ici en temps réel.',
  'radar.thisPc': 'Ce PC',
  'feed.receiving': 'Réception depuis {name}…', 'feed.openFolder': 'Ouvrir le dossier', 'feed.textCopied': 'Texte copié dans ton presse-papiers', 'feed.copyAgain': 'Copier à nouveau',
  'hist.empty': 'Rien pour l’instant', 'hist.emptyHint': 'Les fichiers et textes échangés apparaissent ici.',
  'hist.file': 'fichier', 'hist.text': 'texte', 'hist.clip': 'presse-papiers', 'hist.from': 'depuis {name}', 'hist.to': 'vers {name}', 'hist.open': 'Ouvrir le dossier',
  'send.title': 'Envoyer à un téléphone', 'send.drop': 'Dépose des fichiers ici', 'send.dropHint': 'ou <u>clique pour parcourir</u>. Le téléphone les récupère dans son onglet « Recevoir ».',
  'send.textTitle': 'Envoyer un texte', 'send.textPlaceholder': 'Écris ou colle le texte à envoyer au téléphone…', 'send.textBtn': 'Rendre disponible',
  'send.queueTitle': 'Prêt pour le téléphone', 'send.outboxEmpty': 'Rien en attente', 'send.outboxEmptyHint': 'Dépose un fichier au-dessus et il apparaît sur le téléphone appairé.',
  'outbox.downloaded': 'récupéré ✓', 'outbox.waiting': 'en attente',
  'clip.search': 'Rechercher dans l’historique…', 'clip.clear': 'Tout effacer', 'clip.disabled': 'Historique désactivé', 'clip.disabledHint': 'Active « Historique du presse-papiers » dans les réglages pour retrouver ici tout ce que tu copies.',
  'clip.empty': 'Presse-papiers vide', 'clip.emptyHint': 'Tout ce que tu copies sur ce PC atterrit ici.',
  'clip.copiedHere': 'copié sur ce PC', 'clip.received': 'reçu de {name}', 'clip.open': 'Ouvrir', 'clip.copy': 'Copier', 'clip.phone': 'Téléphone',
  'clip.kind.youtube': 'Vidéo YouTube', 'clip.kind.image': 'Image', 'clip.kind.link': 'Lien', 'clip.kind.email': 'E-mail', 'clip.kind.color': 'Couleur', 'clip.kind.code': 'Code', 'clip.kind.text': 'Texte',
  'set.thisPc': 'Ce PC', 'set.style': 'Style', 'set.theme': 'Thème', 'set.lang': 'Langue',
  'set.auto': 'Automatique (système)', 'opt.auto': 'Automatique', 'set.apple': 'Apple', 'set.windows': 'Windows', 'set.light': 'Clair', 'set.dark': 'Sombre', 'set.langFr': 'Français', 'set.langEn': 'English',
  'set.name': 'Nom visible par les téléphones', 'set.dir': 'Dossier de réception', 'set.maxFile': 'Taille max par fichier', 'set.approval': 'Me demander avant chaque réception',
  'set.clipboard': 'Synchroniser mon presse-papiers vers les téléphones (quand je copie du texte sur le PC, il devient disponible sur le téléphone, onglet « Recevoir »)',
  'set.clipHistory': 'Historique du presse-papiers (local uniquement, purgé automatiquement)', 'set.keepMax': 'Garder au maximum', 'set.eraseAfter': 'Effacer après',
  'set.items': '{n} éléments', 'set.hours': '{n} heures', 'set.days': '{n} jours',
  'set.save': 'Enregistrer', 'set.saved': 'Réglages enregistrés ✓', 'set.saveFailed': 'Réglage refusé',
  'sc.title': 'Partage direct depuis l’iPhone (Raccourci)', 'sc.hint': 'Avec un Raccourci Apple, « Envoyer au PC » apparaît dans la feuille de partage de l’iPhone : Photos → Partager → Envoyer au PC. Aucune app à installer.',
  'sc.enable': 'Activer le partage par Raccourci. Pratique, mais ce canal n’est pas chiffré (contrairement au reste) : à désactiver sur un wifi public que tu ne contrôles pas.',
  'sc.device': 'Téléphone concerné', 'sc.create': 'Créer le raccourci (2 minutes, à faire une fois)',
  'sc.step1': 'Sur l’iPhone, ouvre l’app <b>Raccourcis</b> puis crée un nouveau raccourci.', 'sc.step2': 'Dans ses réglages (icône ⓘ), active <b>« Afficher dans la feuille de partage »</b>.',
  'sc.step3': 'Ajoute l’action <b>« Obtenir le contenu de l’URL »</b> avec l’adresse « Envoyer des fichiers » ci-dessus.', 'sc.step4': 'Méthode <b>POST</b>, corps <b>Formulaire</b> : ajoute un champ de type <b>Fichier</b>, nommé <code>file</code>, avec la variable <b>Entrée du raccourci</b>.',
  'sc.step5': 'Nomme-le <b>« Envoyer au PC »</b>, choisis une icône, enregistre.', 'sc.step6': 'Depuis Photos ou n’importe quelle app : Partager → Envoyer au PC. Terminé.',
  'sc.pairFirst': 'Appaire d’abord un téléphone', 'sc.rowFiles': 'Envoyer des fichiers', 'sc.rowText': 'Coller sur le PC', 'sc.rowClip': 'Lire le presse-papiers du PC', 'sc.rowFallback': 'Secours si .local ne répond pas',
  'help.title': 'Aide et confidentialité', 'help.hint': 'Une idée, un bug ? Dis-le en deux clics, ça ouvre un ticket prérempli sur GitHub.', 'help.reportBug': 'Signaler un problème', 'help.suggest': 'Proposer une idée',
  'help.telemetry': 'Aider à améliorer Flitdrop en partageant des données d’usage et d’erreurs anonymes. Aucun contenu de vos fichiers ni de votre presse-papiers n’est jamais envoyé. Décoché par défaut, vous décidez.',
  'help.issueBug': 'Problème : ', 'help.issueIdea': 'Idée : ', 'help.version': 'Version', 'help.savedPref': 'Préférence enregistrée ✓',
  'reset.title': 'Réinitialiser ce PC', 'reset.hint': 'Chaque téléphone que tu appaires est lié à CE PC uniquement : personne d’autre sur le wifi ne voit tes données. Si tu prêtes ou revends la machine, réinitialise pour tout effacer : appareils appairés, historique du presse-papiers et fichiers en attente. Les téléphones devront re-scanner un QR code.',
  'reset.btn': 'Réinitialiser ce PC', 'reset.confirm': 'Réinitialiser ce PC ?\n\nTous les téléphones appairés seront oubliés, l’historique du presse-papiers et les fichiers en attente seront effacés. Les téléphones devront re-scanner un QR code.', 'reset.done': 'PC réinitialisé ✓', 'reset.doneHint': 'Appairages et historique effacés.', 'reset.failed': 'Échec de la réinitialisation',
  'pair.title': 'Appairer un téléphone', 'pair.hint': 'Scanne ce QR code avec l’appareil photo du téléphone (même wifi que le PC).', 'pair.orScan': '  (ou scanne le QR code)',
  'pair.waiting': 'En attente du scan…', 'pair.rename': 'Nom de l’appareil', 'pair.done': 'Terminer', 'pair.cannotScan': 'Le téléphone n’arrive pas à scanner ?', 'pair.copyHint': 'Copie ce lien et ouvre-le sur le téléphone. Il contient la clé d’appairage : garde-le privé.', 'pair.copyLink': 'Copier le lien d’appairage', 'pair.linkCopied': 'Lien d’appairage copié ✓', 'pair.linkCopiedHint': 'Ouvre-le sur le téléphone.', 'pair.copyFailed': 'Copie impossible', 'pair.paired': 'Appairé ✓', 'pair.cancel': 'Fermer',
  'welcome.title': 'Bienvenue sur Flitdrop', 'welcome.body': 'Envoie fichiers, photos et presse-papiers entre ton téléphone et ce PC, chiffré de bout en bout. Rien à installer sur le téléphone.', 'welcome.start': 'Appairer mon téléphone', 'welcome.skip': 'Plus tard',
  'common.copied': 'Copié ✓', 'common.copyFailed': 'Impossible de copier', 'common.close': 'Fermer', 'common.open': 'Ouvrir',
  'up.filesReady.one': 'Fichier prêt ✓', 'up.filesReady.other': '{n} fichiers prêts ✓', 'up.readyHint': 'Onglet « Recevoir » sur le téléphone.', 'up.failed': 'Échec de l’envoi',
  'device.seen': 'Vu {when}', 'device.revoke': 'Retirer cet appareil', 'device.rename': 'Renommer', 'device.pairedSeen': 'Appairé {paired} · vu {seen}. Les échanges avec cet appareil sont chiffrés de bout en bout.',
  'appr.title': 'Réception entrante', 'appr.body': '{name} veut envoyer « {file} » ({size}).', 'appr.accept': 'Accepter', 'appr.decline': 'Refuser',
  'clipboard.empty': 'Presse-papiers vide',
  'radar.empty': 'Aucun téléphone appairé', 'radar.emptyHint': '30 secondes, un QR code, et c’est réglé.',
  'send.textPh': 'Un lien, une adresse, un mot de passe wifi…', 'send.pushClip': 'Envoyer mon presse-papiers', 'send.dropOverlay': 'Dépose pour mettre à disposition du téléphone',
  'device.title': 'Appareil', 'device.shortcut': 'Configurer le raccourci iPhone',
  'sz.512mb': '512 Mo', 'sz.1gb': '1 Go', 'sz.4gb': '4 Go', 'sz.8gb': '8 Go', 'sz.16gb': '16 Go',
  'opt.items50': '50 éléments', 'opt.items200': '200 éléments', 'opt.items500': '500 éléments', 'opt.h24': '24 heures', 'opt.d7': '7 jours', 'opt.d30': '30 jours',
  'welcome.intro': 'L’AirDrop de ton PC. Trois choses à savoir, et c’est tout :',
  'welcome.step1': '<b>Appaire ton téléphone une seule fois.</b> Un QR code à scanner, la connexion est mémorisée, même après un redémarrage.',
  'welcome.step2': '<b>Envoie dans les deux sens.</b> Le téléphone envoie photos et textes ; toi, tu glisses des fichiers ici, il les récupère.',
  'welcome.step3': '<b>Tout reste chez toi.</b> Chiffré de bout en bout, sur ton wifi, sans cloud ni compte.',
  'clip.phoneTitle': 'Mettre à disposition du téléphone', 'clip.readyPhone': 'Prêt sur le téléphone ✓', 'clip.recvTab': 'Onglet « Recevoir ».',
  'pair.connected': 'Téléphone connecté ✓', 'toast.devicePaired': 'Nouvel appareil appairé',
  'toast.pickedUp': 'Récupéré sur le téléphone ✓', 'toast.clipSynced': 'Presse-papiers synchronisé ✓',
  'toast.renamed': 'Appareil renommé ✓', 'toast.removed': 'Appareil retiré', 'toast.removedHint': 'Il ne peut plus rien envoyer vers ce PC.',
  'toast.textQueued': 'Texte mis à disposition ✓', 'toast.clipPushed': 'Presse-papiers envoyé ✓', 'toast.histCleared': 'Historique effacé', 'toast.openFolderFailed': 'Impossible d’ouvrir le dossier',
  'ph.brand': 'Flitdrop',
  'ph.scan.title': 'Connecte ce téléphone à ton PC', 'ph.scan.lead': 'Ouvre Flitdrop sur le PC, clique sur « Appairer un téléphone » et scanne le QR code avec l’appareil photo.',
  'ph.paste.hint': 'Depuis l’écran d’accueil, tu ne peux pas scanner. Sur le PC, ouvre « Appairer un téléphone » > « Copier le lien d’appairage », puis colle-le ici :', 'ph.paste.placeholder': 'Colle le lien d’appairage', 'ph.paste.btn': 'Se connecter', 'ph.paste.invalid': 'Lien d’appairage invalide',
  'ph.err.notFound': 'PC introuvable', 'ph.err.notFoundMsg': 'Vérifie que Flitdrop est ouvert sur le PC et que ton téléphone est sur le même wifi.', 'ph.err.retry': 'Réessayer', 'ph.err.forget': 'Oublier ce PC',
  'ph.err.revoked': 'Appairage refusé', 'ph.err.revokedMsg': 'Ce téléphone a été retiré sur le PC. Re-scanne un QR code pour le reconnecter.',
  'ph.err.wrongPc': 'Appairé à un autre PC', 'ph.err.wrongPcMsg': 'Ce téléphone est appairé à un autre PC Flitdrop. Re-scanne le QR code du bon PC.',
  'ph.err.notThisPc': 'Ce n’est pas le bon PC', 'ph.err.notThisPcMsg': 'Un autre PC répond à cette adresse. Re-scanne le QR code du PC appairé.',
  'ph.altHint': 'Le PC a peut-être changé d’adresse. Essaie :', 'ph.reconnectVia': 'Se reconnecter via {host}',
  'ph.title': 'Partager', 'ph.connectedTo': 'Connecté à', 'ph.menuInfo': 'Ce téléphone est appairé à « {name} ». Les envois sont chiffrés de bout en bout.',
  'ph.install.title': 'Ajoute Flitdrop à l’écran d’accueil', 'ph.install.sub': 'Un appui et ça s’ouvre comme une vraie app, déjà connectée.', 'ph.install.add': 'Ajouter',
  'ph.tab.send': 'Envoyer', 'ph.tab.text': 'Texte', 'ph.tab.recv': 'Reçus', 'ph.tab.clip': 'Historique',
  'ph.send.title': 'Choisir des fichiers', 'ph.send.hint': 'Photos, vidéos, documents. Ils arrivent dans le dossier Flitdrop du PC.',
  'ph.send.queued': 'En attente…', 'ph.send.empty': 'Fichier vide, ignoré', 'ph.send.tooBig': 'Trop volumineux (limite {size})', 'ph.send.progress': '{pct} % · {speed}/s', 'ph.send.lost': 'Connexion perdue, reprise…', 'ph.send.arrived': 'Arrivé sur {name} ✓', 'ph.send.refused': 'Refusé sur le PC', 'ph.send.lostRetry': 'Connexion perdue, réessaie', 'ph.send.failed': 'Échec de l’envoi',
  'ph.send.sending': 'Envoi <b>{a}/{b}</b>…', 'ph.send.processed': '<b>{n}</b> fichiers traités',
  'ph.text.placeholder': 'Colle ou écris ton texte ici…', 'ph.text.count.one': '{n} caractère', 'ph.text.count.other': '{n} caractères',
  'ph.text.btn': 'Envoyer sur le PC', 'ph.text.sending': 'Envoi…', 'ph.text.done': 'Dans le presse-papiers du PC ✓', 'ph.text.hint': 'Le texte atterrit directement dans le presse-papiers du PC. Ctrl+V, et c’est collé.',
  'ph.recv.textFrom': 'Texte du PC', 'ph.recv.copy': 'Copier', 'ph.recv.open': 'Ouvrir', 'ph.recv.empty': 'Rien en attente.', 'ph.recv.emptyHint': 'Sur le PC, glisse un fichier dans Flitdrop, onglet « Envoyer », et il apparaîtra ici.',
  'ph.recv.copied': 'Copié dans ton presse-papiers ✓', 'ph.recv.selectCopy': 'Sélectionne le texte pour le copier', 'ph.recv.downloading': 'Téléchargement…', 'ph.recv.done': 'Reçu ✓', 'ph.recv.fileDone': 'Fichier téléchargé ✓', 'ph.recv.dlFailed': 'téléchargement impossible', 'ph.recv.incomplete': 'transfert incomplet, réessaie',
  'ph.clip.receive': 'Recevoir', 'ph.clip.copiedPc': 'Copié sur le PC', 'ph.clip.receivedFrom': 'Reçu de {name}', 'ph.clip.copy': 'Copier', 'ph.clip.imgAvailable': 'Disponible dans « Recevoir » ✓', 'ph.clip.imgFailed': 'Impossible de récupérer l’image', 'ph.clip.empty': 'Presse-papiers vide', 'ph.clip.emptyHint': 'Copie un texte, un lien ou une image sur le PC : ça apparaît ici, prêt à recoller sur ce téléphone.', 'ph.clip.disabled': 'Historique désactivé', 'ph.clip.disabledHint': 'Active « Historique du presse-papiers » dans les réglages de Flitdrop sur le PC.',
  'ph.img.hint': 'Reste appuyé sur l’image pour l’enregistrer dans tes photos.',
  'ph.menu.title': 'Ce téléphone', 'ph.menu.style': 'Style', 'ph.menu.theme': 'Thème', 'ph.menu.lang': 'Langue', 'ph.menu.android': 'Android',
  'ph.menu.install': 'Ajouter à l’écran d’accueil', 'ph.menu.forget': 'Oublier ce PC', 'ph.menu.close': 'Fermer',
  'ph.installSheet.title': 'Flitdrop comme une app', 'ph.installSheet.ios': 'Dans Safari : bouton Partager (le carré avec une flèche), puis « Sur l’écran d’accueil ». L’icône Flitdrop apparaît comme une app, connectée à ton PC, sans re-scanner le QR code.', 'ph.installSheet.android': 'Dans Chrome : menu ⋮ en haut à droite, puis « Ajouter à l’écran d’accueil ». L’icône Flitdrop apparaît comme une app, connectée à ton PC, sans re-scanner le QR code.',
  'tray.open': 'Ouvrir Flitdrop', 'tray.openFolder': 'Ouvrir le dossier de réception', 'tray.autostart': 'Lancer au démarrage de la session', 'tray.quit': 'Quitter', 'tray.tip': 'Flitdrop : prêt à recevoir',
  'notif.filesReady.one': 'Prêt pour le téléphone', 'notif.filesReady.other': '{n} fichiers prêts pour le téléphone', 'notif.filesReadyBody': 'À récupérer dans Flitdrop, onglet « Recevoir ».',
  'dialog.startFailed': 'Flitdrop n’a pas pu démarrer : {msg}',
  'srv.shortcutOff': 'Le partage par Raccourci est désactivé sur ce PC (réglage « Partage direct iPhone »).',
  'srv.loopbackOnly': 'Interface accessible depuis ce PC uniquement.',
  'srv.adminBadLink': 'Flitdrop : lien invalide. Relance l’application pour obtenir le bon lien.',
  'srv.scArrivedOne': '« {name} » est arrivé sur {pc} ✅', 'srv.scArrivedMany': '{n} fichiers sont arrivés sur {pc} ✅', 'srv.scCopied': 'Copié sur {pc} ✅',
  'srv.scBadToken': 'Jeton invalide. Re-scanne le QR code Flitdrop sur ton PC.', 'srv.scNoFile': 'Aucun fichier reçu.', 'srv.scTooBig': 'Fichier trop volumineux (limite {mb} Mo).', 'srv.scFailed': 'Échec de la réception.', 'srv.scNothing': 'Rien à copier.',
  'err.deviceUnknown': 'Appareil inconnu ou révoqué', 'err.authRefused': 'Authentification refusée', 'err.wrongPc': 'Appareil appairé à un autre PC', 'err.rateLimited': 'Trop de requêtes, réessaie dans une minute',
  'err.transferNotFound': 'Transfert introuvable', 'err.badIndex': 'Index invalide', 'err.missingBody': 'Corps manquant', 'err.badChunk': 'Chunk corrompu ou clé invalide', 'err.badChunkSize': 'Taille de chunk invalide', 'err.chunkOrder': 'Ordre de chunks invalide', 'err.tooManyTransfers': 'Trop de transferts simultanés', 'err.transferDone': 'Transfert terminé', 'err.transferIncomplete': 'Transfert incomplet', 'err.diskWrite': 'Erreur d’écriture disque', 'err.badSize': 'Taille invalide', 'err.tooBig': 'Fichier trop volumineux', 'err.badSplit': 'Découpage incohérent', 'err.refused': 'Transfert refusé sur le PC',
  'err.textEmpty': 'Texte vide ou trop long', 'err.entryNotFound': 'Entrée introuvable', 'err.itemNotFound': 'Élément introuvable', 'err.imageGone': 'Image plus disponible', 'err.fileGone': 'Fichier plus disponible', 'err.notAFile': 'Pas un fichier',
  'err.localOnly': 'Accès local uniquement', 'err.unauthorized': 'Non autorisé', 'err.imgCopyUnavailable': 'Recopie d’image indisponible', 'err.clipWriteFailed': 'Impossible d’écrire dans le presse-papiers', 'err.pairingNotFound': 'Appairage introuvable', 'err.emptyName': 'Nom vide', 'err.deviceNotFound': 'Appareil introuvable', 'err.clipboardEmpty': 'Presse-papiers vide', 'err.badLink': 'Lien invalide', 'err.requestExpired': 'Demande expirée', 'err.badFolderPath': 'Chemin de dossier invalide', 'err.cannotCreateFolder': 'Impossible de créer ce dossier',
  'err.generic': 'Erreur {status}', 'err.internal': 'Erreur interne', 'err.notFound': 'Introuvable',
}

export const messages: Record<Lang, Dict> = { en, fr }

function interp(s: string, params?: Record<string, string | number>): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (_m, k) => (k in params ? String(params[k]) : `{${k}}`))
}

/** Traduit une clé. Repli : langue demandée -> anglais -> la clé elle-même. */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const s = messages[lang]?.[key] ?? messages.en[key] ?? key
  return interp(s, params)
}

/** Pluriel via Intl.PluralRules (l'anglais et le français diffèrent). */
export function tp(lang: Lang, key: string, n: number, params?: Record<string, string | number>): string {
  let cat = 'other'
  try {
    cat = new Intl.PluralRules(lang).select(n)
  } catch {
    cat = n === 1 ? 'one' : 'other'
  }
  const k = messages[lang]?.[`${key}.${cat}`] ? `${key}.${cat}` : `${key}.other`
  return t(lang, k, { n, ...params })
}

/** Temps relatif compact (à l'instant, il y a 3 min / 3 min ago). */
export function rtf(lang: Lang, iso?: string): string {
  if (!iso) return t(lang, 'time.never')
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (sec < 45) return t(lang, 'time.now')
  const fmt = new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'short' })
  if (sec < 3600) return fmt.format(-Math.round(sec / 60), 'minute')
  if (sec < 86400) return fmt.format(-Math.round(sec / 3600), 'hour')
  return fmt.format(-Math.round(sec / 86400), 'day')
}

/** Taille lisible, unités localisées (o/Ko/Mo/Go vs B/KB/MB/GB). */
export function fmtBytes(lang: Lang, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0
  const u = [t(lang, 'unit.b'), t(lang, 'unit.kb'), t(lang, 'unit.mb'), t(lang, 'unit.gb')]
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  // une décimale utile pour Ko/Mo/Go, sans « .0 » superflu (2 Ko, 2,5 Mo)
  const val = i === 0 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
  return `${val} ${u[i]}`
}

/** Résout la langue effective : override utilisateur, sinon 'auto' -> détection. */
export function resolveLang(pref: string | undefined, auto: Lang): Lang {
  return pref === 'fr' || pref === 'en' ? pref : auto
}

/** Détecte fr/en depuis un code de langue (navigator.language, app.getLocale…). */
export function langFrom(code: string | undefined): Lang {
  return (code || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

/** Choisit fr/en depuis un entête Accept-Language (requêtes Raccourci iOS). */
export function acceptLang(header: string | undefined): Lang {
  return langFrom((header || '').split(',')[0])
}
