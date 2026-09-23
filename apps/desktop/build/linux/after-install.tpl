#!/bin/bash
# Post-installation du .deb Flitdrop (modèle electron-builder : les variables
# entre accolades précédées d'un dollar sont remplacées au build, ne pas en
# utiliser d'autres dans ce fichier).

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Bac à sable Chromium : chrome-sandbox TOUJOURS setuid root.
# Le modèle d'origine ne le rend setuid que si « unshare --user true » échoue.
# Or ce test tourne ici en root, pour qui la restriction AppArmor d'Ubuntu 23.10+
# (kernel.apparmor_restrict_unprivileged_userns=1, défaut sur Ubuntu 24.04) ne
# s'applique pas : il réussit, chrome-sandbox reste en 0755, et au lancement par
# un utilisateur normal Electron s'arrête net (« The SUID sandbox helper binary
# was found, but is not configured correctly »). Vérifié en CI. Le helper setuid
# fonctionne que les espaces de noms utilisateur soient permis ou non (c'est ce
# que fait le paquet de Google Chrome).
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
