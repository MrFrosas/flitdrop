; Intégration Explorateur Windows : « clic-droit > Envoyer vers > Flitdrop ».
; Le dossier SendTo est natif Windows (10 et 11), aucune signature requise :
; l'Explorateur lance Flitdrop.exe avec les fichiers sélectionnés en arguments,
; et l'app les met à disposition du téléphone.

; Plantage possible à la toute première installation (0xC0000005, vu par la
; validation manuelle winget le 28/07/2026). Dans electron-builder < 26.9, quand
; HKCU InstallLocation est vide, multiUser.nsh recopie le résultat de
; SHGetKnownFolderPath avec une lecture de longueur fixe (NSIS_MAX_STRLEN) dans
; un tampon plus court : selon le tas, la lecture sort de la mémoire allouée et
; le setup meurt avant l'extraction (electron-builder #7921, #8536, corrigé
; en amont par #9769). preInit s'exécute dans .onInit AVANT initMultiUser : en
; posant InstallLocation sur le dossier par défaut, la branche fautive n'est
; jamais prise. Le chemin est identique au défaut d'electron-builder.
; La garde BUILD_UNINSTALLER est indispensable : dans ce mode, .onInit tourne
; sur la machine de build pour écrire l'uninstaller, pas chez l'utilisateur.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" 0 +2
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  !endif
!macroend

!macro customInstall
  CreateShortCut "$SENDTO\Flitdrop.lnk" "$appExe"
!macroend

!macro customUnInstall
  Delete "$SENDTO\Flitdrop.lnk"
!macroend
