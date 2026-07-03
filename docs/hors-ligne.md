# Mode hors-ligne (sans wifi, sans internet)

La question : « à la gare, dans le train, en pleine nature sans réseau : est-ce que ça marche quand même, comme AirDrop ? »

## La vérité technique (vérifiée, juillet 2026)

AirDrop fonctionne hors réseau parce que les deux appareils sont des **Apple** : ils créent un lien Wi-Fi direct (AWDL) entre eux. **Apple verrouille cette technologie à son écosystème** : aucune app tierce, sur aucun téléphone, ne peut créer ce lien direct vers un PC Windows. Et Windows n'a aucune API équivalente (Wi-Fi Aware). Donc le « vrai » P2P sans-fil iPhone ↔ Windows est **impossible pour tout le monde**, pas seulement pour nous. C'est une limite d'Apple et de Windows, pas de Flitdrop.

Le Bluetooth ne sauve pas la mise non plus : iOS interdit aux apps tierces d'envoyer des fichiers à un PC Windows en Bluetooth classique, et le Bluetooth basse consommation (le seul autorisé) est ~100× trop lent pour une photo.

## La solution qui, elle, marche : le PC devient le réseau

Windows 11 sait créer son **propre point d'accès Wi-Fi** (Paramètres → Réseau → Point d'accès sans fil). Le téléphone s'y connecte comme à n'importe quel wifi. Résultat : les deux appareils sont sur un **réseau local privé qu'ils forment eux-mêmes**, sans box, sans routeur, sans internet. Flitdrop fonctionne alors normalement, à pleine vitesse, où que vous soyez.

C'est **plus sûr** que le wifi d'un café : le réseau appartient à votre PC, personne d'autre n'est dessus, et tout reste chiffré de bout en bout par-dessus.

### En pratique
1. Sur le PC : activer le point d'accès Wi-Fi de Windows (Flitdrop propose un raccourci vers ce réglage dans « Mode hors-ligne »).
2. Sur le téléphone : rejoindre ce wifi (nom + mot de passe affichés par Windows, ou QR code wifi).
3. Ouvrir Flitdrop : le PC est détecté, les transferts marchent comme d'habitude.

Android peut aussi utiliser le **Wi-Fi Direct** avec l'app native (feuille de route v2), qui automatise entièrement cette étape.

## Résumé honnête

| Scénario | Marche ? |
|---|---|
| Même wifi (maison, bureau) | ✅ toujours, à pleine vitesse |
| Sans internet mais via le point d'accès du PC | ✅ oui, réseau formé par le PC |
| iPhone ↔ Windows en Wi-Fi direct « pur » comme AirDrop | ❌ impossible pour tout tiers (verrou Apple + Windows) |
| Android ↔ Windows en Wi-Fi Direct | ✅ prévu avec l'app native |

La bonne nouvelle : le point d'accès du PC couvre à 100 % le cas « pas de réseau », pour iPhone **et** Android, dès aujourd'hui.
