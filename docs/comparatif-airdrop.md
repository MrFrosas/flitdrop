# Flitdrop vs AirDrop — comparatif honnête (juillet 2026)

Établi à partir d'un audit de faisabilité vérifié (7 recherches web + contre-vérification adversariale, sources datées). L'honnêteté est un choix de produit : promettre ce qu'on ne peut pas tenir se paie en avis 1 étoile.

| Critère | Flitdrop | AirDrop |
|---|---|---|
| **Portée** | Multi-OS réel : iPhone, Android **et** Windows. Le PC est un citoyen de premier rang. | Écosystème Apple seulement (iPhone, iPad, Mac). Rien sur Windows/Android. |
| **Sans app sur le téléphone** | ✅ Oui, via page web appairée par QR (le téléphone envoie, le PC reçoit). *Avantage sur AirDrop.* | Rien à installer, mais rien de web non plus — c'est un service système Apple. |
| **Icône dans la rangée du haut du partage iOS** | Seulement avec l'app iOS native (Share Extension). Sans app : un Raccourci, plus bas dans les actions. | Présence native permanente, par définition. |
| **Hors réseau (gare, sans box ni internet)** | ✅ Oui, via le point d'accès Wi-Fi du PC (le PC forme le réseau). iPhone **et** Android. | ✅ Oui, radio-direct pur (AWDL) sans aucune infrastructure — plus élégant, mais Apple-only. |
| **Débit fichiers lourds** | Élevé : Wi-Fi local, HTTP/TCP, pas de plafond Bluetooth. | Élevé : Wi-Fi direct. |
| **Envoi qui continue téléphone en veille** | iOS : app native requise (URLSession en arrière-plan). Android : oui via l'app. Sans app : non. | Géré nativement, transparent. |
| **Reprise à l'octet près après coupure** | ✅ Oui (déjà implémenté côté web ; standard IETF côté app native). *Avantage sur réseau instable.* | Non garantie ; un échec relance souvent tout. |
| **Réception passive, app fermée, sans action en face** | ❌ Non sur iPhone : c'est un service système réservé à Apple. | ✅ Oui — l'essence même d'AirDrop. |
| **Intégration Windows (clic-droit, partage, démarrage session)** | ✅ Possible avec identité de package + menu signé. | Inexistant : AirDrop n'existe pas sur Windows. |
| **Chiffrement** | Bout en bout XChaCha20-Poly1305, clé échangée hors bande (QR), pas de cloud. | Bout en bout, Apple. |
| **Prix / distribution** | App PC gratuite ; Pro via Stripe (0 % de commission Store) ; apps mobiles gratuites. | Gratuit, préinstallé — mais verrouillé au matériel Apple. |

## Là où Flitdrop gagne franchement

- **Il marche entre marques.** Un Samsung ↔ un PC, un iPhone ↔ un PC : AirDrop ne sait pas faire, Flitdrop oui.
- **Zéro app côté téléphone** possible (page web) — impossible à égaler pour AirDrop, qui n'a pas de version web.
- **Reprise de transfert** à l'octet près sur réseau instable.
- **Intégration Windows** que Microsoft lui-même ne fournit pas correctement.

## Là où AirDrop reste devant (et pourquoi c'est structurel)

- **Réception passive app fermée** et **découverte permanente** : ce sont des services *système*. Seul Apple peut les fournir sur iPhone. Aucun tiers au monde ne peut les répliquer — c'est une limite d'Apple, pas de Flitdrop.
- **Radio-direct pur hors réseau** : AWDL est propriétaire Apple et Windows n'a aucune API équivalente. Notre équivalent honnête est le point d'accès du PC.

## La règle d'or marketing

On peut dire « **AirDrop multi-OS** » et « **l'AirDrop de Windows** » (usage descriptif, autorisé). On ne doit **jamais** promettre « réception passive comme AirDrop sur iPhone sans rien faire » : c'est le seul point qu'aucun concurrent ne peut tenir, et le promettre tuerait la confiance.
