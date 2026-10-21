import fs from 'node:fs'
import { execFile } from 'node:child_process'

/** Marque un fichier reçu d'un téléphone comme venu de l'extérieur, comme le
 *  fait un navigateur pour un téléchargement : sous Windows, un programme
 *  reçu passe par SmartScreen à l'ouverture et les macros d'Office sont
 *  bloquées ; sous macOS, Gatekeeper vérifie une app ou un script avant de
 *  l'ouvrir. Sans effet sur une photo ou une vidéo. Jamais d'exception : un
 *  disque qui ne sait pas porter la marque (FAT, exFAT) n'empêche rien. */
export function markFromOutside(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (platform === 'win32') {
        // flux NTFS « Zone.Identifier », zone 3 = Internet
        fs.writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n', () => resolve())
      } else if (platform === 'darwin') {
        const stamp = Math.floor(Date.now() / 1000).toString(16)
        execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${stamp};Flitdrop;`, file], { timeout: 5000 }, () => resolve())
      } else resolve()
    } catch {
      resolve()
    }
  })
}
