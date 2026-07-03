# Modèle de sécurité

## Ce qui est garanti

**Chiffrement de bout en bout entre le téléphone (page web) et le PC.**

- Algorithme : XChaCha20-Poly1305 (AEAD), bibliothèque @noble/ciphers (pure JS, auditée), identique côté navigateur et côté PC.
- Clé : 32 octets aléatoires générés par le PC à l'appairage, transmis uniquement dans le **fragment** du QR code (`/s/#id.clé`). Un fragment d'URL n'est jamais envoyé dans les requêtes HTTP : la clé ne transite jamais sur le réseau, même en clair local.
- Chaque message porte une **AAD contextuelle** (`wd1|appareil|usage|transfert|n°chunk`) : un chiffré capturé ne peut être rejoué ni sur une autre route, ni pour un autre appareil, ni à une autre position de fichier.
- Les enveloppes JSON portent un horodatage (fenêtre 2 min) et un identifiant unique `jti` (cache anti-rejeu).
- Un chunk falsifié, tronqué ou déplacé est rejeté (tag Poly1305 + AAD). Testé.

**Surface d'administration verrouillée.**

- `/app` et `/api/admin/*` : accessibles uniquement depuis la machine (vérification loopback) ET avec jeton (query une fois, puis cookie HttpOnly SameSite=Strict). Comparaisons en temps constant.
- Le WebSocket temps réel exige le même jeton et le loopback.

**Écriture disque défensive.**

- Noms de fichiers nettoyés (traversée `../`, caractères interdits, noms réservés Windows CON/PRN/…, longueur bornée), collisions dédupliquées « (2) ».
- Écriture dans un `.tmp` puis renommage atomique ; fichiers incomplets purgés (délai d'inactivité 10 min).
- Taille maximale par fichier configurable (défaut 8 Go), vérifiée à l'init ET pendant le flux.

**Anti-abus.**

- La route des chunks refuse les inconnus avant de lire le corps (pas de buffering pour un attaquant).
- Limites de débit par IP sur l'appairage et les routes Raccourci.
- Maximum 4 transferts simultanés par appareil, corps JSON bornés.
- Appairages non finalisés purgés après 15 min. Appareils révocables en un clic (clé détruite).

## Ce qui est un compromis assumé (v1)

1. **Les routes Raccourci iOS (`/api/shortcut/*`) utilisent un jeton porteur, sans chiffrement applicatif.** L'app Raccourcis ne sait pas faire de crypto. Conséquence : sur un wifi hostile (café public), le contenu envoyé par le Raccourci est lisible par un observateur du réseau local. Sur le wifi personnel (le cas d'usage), le risque est faible. Le jeton est propre à chaque appareil et révocable. La page web, elle, est chiffrée de bout en bout partout. Piste v2 : relay HTTPS optionnel pour les réseaux non fiables.
2. **Pas de TLS sur le LAN.** Volontaire : certificat auto-signé = avertissements bloquants sur mobile. Le chiffrement applicatif AEAD couvre la confidentialité et l'intégrité des données ; les métadonnées HTTP (chemins, tailles) restent visibles sur le LAN.
3. **Localhost partagé.** Un autre logiciel s'exécutant sur le PC avec la session de l'utilisateur peut lire le jeton admin dans `~/.flitdrop/config.json`. C'est le modèle de menace standard d'une app de bureau (un malware local a déjà gagné).

## Tests de sécurité automatisés

`npm test` couvre : altération de chunk → 403, rejeu d'enveloppe → 403, appareil inconnu → 403, AAD croisée → échec, horodatage périmé → échec, jeton Raccourci invalide → 401, admin sans jeton → 401, traversée de chemin → neutralisée, taille excessive → 413, borne dure du cache anti-rejeu, réservation atomique des noms de fichiers.

## Revue d'attaque du 3 juillet 2026

Une revue adversariale (4 auditeurs sur des angles distincts : autz/crypto, système de fichiers, déni de service, sécurité des clients web : puis contre-vérification de chaque faille sur le code réel) a été menée. Résultat : 3 faux positifs écartés (dont un « appareil appairé peut lire toute l'outbox », qui est le comportement voulu d'une file de diffusion) et **4 vrais défauts, tous corrigés le jour même** :

1. **Course sur les noms de fichiers** (`uniquePath` non atomique) → remplacée par `reserveUniquePath` qui crée le fichier en mode exclusif (`O_CREAT|O_EXCL`) et boucle sur collision. Deux envois du même nom obtiennent « nom » et « nom (2) », jamais un écrasement.
2. **Corps bufferisé avant authentification** sur les routes `/api/phone/*` → une garde d'appareil + une limite de débit sont désormais montées **avant** tout parseur de corps : un attaquant non appairé est rejeté sans qu'on lise son corps.
3. **Cache anti-rejeu sans plafond** → `NonceCache` a maintenant un plafond dur (20 000) avec éviction FIFO amortie.
4. **Fuite de descripteur** si un téléchargement PC → téléphone est interrompu (téléphone qui quitte le wifi) → le flux disque est détruit dès la fermeture de la connexion.

Aucune de ces failles n'était critique (toutes rétrogradées en faible/moyen après contre-vérification, car conditionnées à un appareil déjà appairé ou sans impact sur la confidentialité), mais deux étaient aussi de vrais bugs de fiabilité, donc corrigées sans hésiter.
