; Intégration Explorateur Windows : « clic-droit > Envoyer vers > Flitdrop ».
; Le dossier SendTo est natif Windows (10 et 11), aucune signature requise :
; l'Explorateur lance Flitdrop.exe avec les fichiers sélectionnés en arguments,
; et l'app les met à disposition du téléphone.

!macro customInstall
  CreateShortCut "$SENDTO\Flitdrop.lnk" "$appExe"
!macroend

!macro customUnInstall
  Delete "$SENDTO\Flitdrop.lnk"
!macroend
