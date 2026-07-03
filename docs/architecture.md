# Architecture technique

## Vue d'ensemble

Flitdrop est un serveur local qui vit dans une app de bureau. Le téléphone n'installe rien : il parle au PC via son navigateur (ou un Raccourci Apple), en HTTP sur le réseau local, avec un chiffrement applicatif de bout en bout par-dessus.

```
┌──────────────── PC Windows ────────────────┐
│  Electron (fenêtre + zone de notification)  │
│  └─ Cœur Node.js (un seul fichier bundlé)   │
│     ├─ HTTP :47777 sur le LAN               │
│     │   /s        page téléphone            │
│     │   /api/phone/*     API chiffrée AEAD  │
│     │   /api/shortcut/*  API Raccourci iOS  │
│     ├─ HTTP loopback seulement              │
│     │   /app      interface PC              │
│     │   /api/admin/*  + WebSocket /ws/ui    │
│     └─ Disque : ~/Downloads/Flitdrop         │
└─────────────────────────────────────────────┘
          ▲ QR code (clé hors bande)
┌─────────┴───────── Téléphone ───────────────┐
│  Navigateur (iPhone/Android, zéro install)  │
│  ou Raccourci Apple dans la feuille partage │
└─────────────────────────────────────────────┘
```

## Choix structurants (et pourquoi)

1. **Zéro app côté téléphone.** L'App Store coûte 99 $/an et des semaines de validation ; le Play Store ajoute de la friction. Une page web + un Raccourci Apple donnent 90 % de l'expérience pour 0 % de la friction de distribution. Une app compagnon reste possible plus tard (v2) pour le presse-papiers automatique.
2. **Appairage par QR code = échange de clé hors bande.** Le QR contient une clé secrète de 32 octets qui ne transite jamais sur le réseau. Pas de certificat auto-signé (avertissements navigateur), pas de PIN à taper, pas de serveur cloud.
3. **Chiffrement applicatif plutôt que HTTPS local.** Un certificat auto-signé sur un téléphone = écran d'avertissement rédhibitoire, et `crypto.subtle` est indisponible sur une origine HTTP. On chiffre donc en JS pur avec XChaCha20-Poly1305 (@noble/ciphers, bibliothèque auditée), même construction des deux côtés. Voir [securite.md](securite.md).
4. **Transferts par chunks de 4 Mo avec reprise.** Chaque chunk est chiffré et authentifié individuellement, lié à sa position (rejouer ou réordonner est impossible). Une coupure wifi = on réémet le chunk, pas le fichier.
5. **Un seul fichier serveur bundlé (esbuild).** L'app Electron embarque `flitdrop.cjs` (2 Mo) + les pages web. Aucun node_modules à l'exécution, surface d'attaque et poids minimaux.
6. **Electron pour la v1.** Time-to-market et une seule base TypeScript. Si la RAM devient une critique récurrente, migration Tauri possible sans toucher au cœur (le serveur est indépendant de la coquille).

## Protocole téléphone → PC

1. `POST /api/phone/hello` : enveloppe chiffrée `{deviceLabel, platform, ts, jti}`. Active l'appareil, renvoie (chiffré) le nom du PC et les limites.
2. `POST /api/phone/transfer/init` : métadonnées du fichier (nom, taille, découpage). Le serveur valide, ouvre un fichier temporaire, peut demander l'accord de l'utilisateur (réglage).
3. `POST /api/phone/transfer/:id/chunk/:n` : corps brut = `nonce ‖ ciphertext`. AAD = `wd1|device|chunk|transfert|n`. Écriture séquentielle stricte, ré-émission idempotente.
4. `POST /api/phone/transfer/:id/finish` : vérifie complétude (octets et chunks), déplace atomiquement vers le dossier de réception avec nom dédupliqué.
5. Texte : `POST /api/phone/text` → presse-papiers du PC + historique + toast temps réel.

PC → téléphone : le PC dépose des éléments dans une « outbox » ; le téléphone la sonde toutes les 6 s (page ouverte) et télécharge les fichiers en frames chiffrées `[longueur(4o) ‖ nonce ‖ ciphertext]`.

## Interfaces

- **PC** (`/app`, loopback + jeton admin + cookie HttpOnly) : radar des appareils, flux temps réel (WebSocket), historique, envoi vers téléphone (drag & drop), réglages, configuration du Raccourci iOS.
- **Téléphone** (`/s`) : appairage par fragment d'URL (jamais envoyé au serveur HTTP), envoi de fichiers avec progression et vitesse, envoi de texte, réception.

## Découverte réseau

- Appairage initial : le QR code porte l'IP du PC. Choix validé par l'audit : la résolution `.local` dans les navigateurs n'existe que sur Android 12+, et Chrome 142 ajoute une permission « Local Network Access » pour les sites publics qui parlent au LAN. Notre page étant servie par le PC lui-même (origine privée), elle n'est pas concernée.
- Raccourci iOS : cible `http://<NomDuPC>.local:47777` (Windows y répond nativement), avec adresse IP de secours affichée dans les réglages, car la résolution `.local` d'iOS est capricieuse sur certains réseaux.
- Piste v1.1 : point de rendez-vous cloud optionnel (`flitdrop.app/t/<id>`) pour un raccourci qui ne casse jamais, même quand l'IP change.
