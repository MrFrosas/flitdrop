# Feuille de route : apps natives et intégration OS

L'app PC + la page web (livrées) couvrent déjà le cas d'usage principal. Cette feuille de route décrit ce qu'il faut construire pour atteindre l'expérience « vraiment comme AirDrop », dans l'ordre de valeur.

## Étape A : Intégration Windows native (la plus rentable, la moins risquée)

**Objectif :** clic-droit sur un fichier dans l'Explorateur → « Envoyer vers mon téléphone » ; recevoir depuis le menu Partager de Windows ; démarrage automatique discret à l'ouverture de session (comme AirDrop, toujours prêt).

- **Comment :** ajouter une **identité de package Windows** via un *sparse package* posé par-dessus l'installeur Electron actuel (pas de réécriture), plus un handler COM `IExplorerCommand` signé. Certificat de signature : Azure Trusted Signing.
- **Coût :** modéré, tout en réutilisant le cœur existant. Aucune app mobile requise.
- **Débloque :** clic-droit Explorateur (1er niveau du menu Windows 11), cible de Partage Windows, démarrage session, et supprime l'invite pare-feu (règles dans le manifeste).

## Étape B : App iOS native (l'expérience « icône à côté d'AirDrop »)

**Objectif :** Photos → Partager → l'icône **Flitdrop** dans la feuille de partage → ça envoie direct au PC, sans ouvrir d'app en plein écran ; envoi qui survit à la veille ; détection automatique du PC.

- **Comment :** app SwiftUI minimale + **Share Extension « headless »** (sous-classe `UIViewController`, `completeRequest` immédiat) qui délègue l'upload à un **`background URLSession`** (via App Group) parlant au serveur local chiffré du PC. Reprise via l'upload résumable IETF (natif `URLSession` iOS 17+). Découverte mDNS pour retrouver le PC.
- **Contraintes vérifiées :** ~120 Mo de RAM max dans l'extension → streamer sur disque ; le timing du background est décidé par le système ; un « force-quit » de l'app tue le transfert.
- **Distribution :** App Store, 99 $/an, review 24-48 h. Pas de risque « anti-AirDrop » (mythe : LocalSend & co sont en ligne). **Aucun** écran de paiement dans l'app.
- **Prérequis d'ingénierie :** nécessite un Mac + Xcode + un iPhone de test. Ne peut pas être buildé/publié sans ces outils.

## Étape C : App Android native

**Objectif :** partage natif, envoi écran éteint, Wi-Fi Direct hors réseau, presse-papiers.

- **Comment :** Kotlin, `foreground service` type `dataSync` (survit à la veille, plafond 6 h/24 h depuis Android 15), WorkManager pour reprise, Wi-Fi Direct/SoftAP pour le hors-réseau automatique, Web Share Target pour recevoir le partage natif.
- **Distribution :** Google Play, 25 $ une fois.

## Étape D : Le compte Pro et le paiement (0 % de commission)

- Le Pro se vend **sur l'app PC / le site** via Stripe (ou Paddle/Lemon Squeezy pour la TVA). Les apps mobiles, gratuites, ne font qu'authentifier un compte déjà Pro. Résultat : **0 %** de commission Apple/Google, légalement.
- Ce que débloque le Pro : relais internet chiffré (hors réseau local), multi-PC, historique étendu. Paiement unique conseillé (le marché rejette l'abonnement).

## Ce qui restera hors de portée (à assumer, pas à promettre)

- Réception passive app fermée sur iPhone (service système Apple).
- Radio-direct pur iPhone ↔ Windows sans point d'accès (verrou Apple + absence d'API Windows).

## Ordre conseillé

**A (Windows natif) → B (iOS) → C (Android) → D (Pro).** L'étape A donne le plus de « waouh natif » pour le moins d'effort et de risque, sans toucher aux stores mobiles. Les apps mobiles viennent quand la traction le justifie.
