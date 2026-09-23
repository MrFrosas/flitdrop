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

; Installation venue du Microsoft Store : la fiche du Store sert le même .exe
; que le site, l'app ne peut donc pas le savoir seule. Le Store lance
; l'installeur avec les paramètres saisis dans le Partner Center (« /S /store »),
; ou le fichier publié pour le Store porte « store » dans son nom
; (Flitdrop-Setup-x.y.z-store.exe). On pose alors un marqueur à côté de l'exe ;
; l'app le lit au lancement et garde « store » dans sa config (une mise à jour
; automatique par l'installeur GitHub ne l'efface donc pas).
!include "FileFunc.nsh"

!macro customInstall
  CreateShortCut "$SENDTO\Flitdrop.lnk" "$appExe"
  ; registres rendus tels quels à electron-builder
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/store" $R1
  IfErrors 0 flitdrop_store_mark
  ; nom de l'installeur : recherche de « store » (StrCmp ignore la casse)
  StrCpy $R2 0
  flitdrop_store_loop:
    StrCpy $R3 $EXEFILE 5 $R2
    StrCmp $R3 "" flitdrop_store_done
    StrCmp $R3 "store" flitdrop_store_mark
    IntOp $R2 $R2 + 1
    Goto flitdrop_store_loop
  flitdrop_store_mark:
    FileOpen $R4 "$INSTDIR\store-install" w
    FileWrite $R4 "store"
    FileClose $R4
  flitdrop_store_done:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  Delete "$SENDTO\Flitdrop.lnk"
!macroend
