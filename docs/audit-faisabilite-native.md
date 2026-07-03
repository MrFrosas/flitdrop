# Audit de faisabilité « expérience 100 % native » (3 juillet 2026)

Réponse honnête aux demandes : icône dans la feuille de partage iOS, presse-papiers automatique, envoi hors wifi, envoi qui continue en veille, détection permanente, clic-droit sur Windows. Méthode : 7 recherches web thématiques + contre-vérification adversariale (chaque verdict re-testé pour être réfuté). 15 agents, ~250 sources.

## Le verdict en une phrase

Le « zéro app sur le téléphone » a atteint son plafond. Tout ce que tu demandes maintenant est **possible**, mais exige des **apps natives** — sauf **une** chose qu'aucun tiers au monde ne peut faire, même avec une app.

## 1. Ce qui marche SANS aucune app (aujourd'hui)

- **Recevoir depuis l'iPhone via la page web appairée par QR.** Déjà en place.
- **Transfert hors réseau** (gare, sans box) via le **point d'accès Wi-Fi du PC** : le téléphone rejoint le PC, réseau local formé, ça marche pour iPhone et Android. Voir [hors-ligne.md](hors-ligne.md).
- **Le look natif** (Liquid Glass iOS / Fluent Windows) à ~85-90 % en pur HTML/CSS : c'est ce qui vient d'être livré (polices système, verre dépoli, clair/sombre). *Nuance vérifiée : la vraie réfraction « lentille » de Liquid Glass n'existe que sur Chromium, pas sur Safari iOS — on a le flou et la teinte, pas la déformation. Invisible pour l'utilisateur.*
- **Un Raccourci Flitdrop** dans la feuille de partage iOS, avec icône personnalisée — mais dans la **bande d'actions du bas**, jamais dans la rangée d'apps où trône AirDrop.
- **Reprise de transfert** à l'octet près : déjà implémenté côté web.

## 2. Ce qui exige une app native (et ce que ça débloque)

| Demande | App requise | Comment (vérifié) |
|---|---|---|
| **Icône Flitdrop dans la rangée du haut, à côté d'AirDrop → envoi direct** | iOS | Une **Share Extension** « headless » (sans écran plein) délègue l'upload à un `background URLSession` qui survit à la fermeture de l'extension. Tap = ça part. Contrainte : ~120 Mo de RAM max dans l'extension → streamer sur disque, jamais tout charger. |
| **Envoi qui continue téléphone en veille / verrouillé** | iOS + Android | iOS : `URLSession` en configuration `.background` (le système décide du timing). Android : *foreground service* `dataSync` + WorkManager. |
| **Presse-papiers auto (copier WhatsApp → arrive sur le PC)** | iOS + Android | Un vrai « au moindre copier ça part » est bridé par iOS (accès presse-papiers en arrière-plan restreint, avec bannière de confidentialité). Réaliste : app ouverte, ou widget/Action Button en un tap. |
| **Clic-droit « Envoyer vers mon téléphone » dans l'Explorateur Windows** | Identité de package Windows | `IExplorerCommand` signé + *sparse package* posé par-dessus l'installeur Electron actuel (pas de réécriture) + certificat de signature (Azure Trusted Signing). Débloque aussi la cible de Partage Windows et le démarrage auto en session. |
| **Détection automatique permanente (comme AirDrop, même après redémarrage du PC)** | Apps natives | Découverte mDNS + reconnexion auto. La page web ne peut pas : elle doit être ouverte. |

**Bonne nouvelle sur la distribution :** publier des apps concurrentes d'AirDrop est **banal**. La peur « Apple rejette les concurrents d'AirDrop » est un **mythe vérifié** : LocalSend, Send Anywhere, Documents by Readdle sont tous en ligne sur l'App Store. Compte Apple 99 $/an, Google 25 $ une fois, review 24-48 h.

## 3. Ce qui est IMPOSSIBLE pour tout le monde (même avec une app)

- **Le vrai P2P radio-direct hors réseau iPhone ↔ Windows** façon AirDrop. AWDL est propriétaire Apple (jamais exposé aux tiers), Windows n'a **aucune** API Wi-Fi Aware (confirmé Microsoft, juillet 2025). Notre équivalent = point d'accès du PC.
- **La réception passive, app fermée, sans personne en face, sur iPhone.** AirDrop est un *service système* que seul Apple fournit. Aucun tiers ne peut le répliquer.
- **Bluetooth pour des fichiers** iPhone ↔ Windows : iOS n'expose que le BLE (~1-2 Mbps), inutilisable pour une photo.
- S'enregistrer comme récepteur **Quick Share/Nearby Share** sur Windows : aucune API tierce.

## 4. L'architecture recommandée (4 couches complémentaires)

1. **App PC (le cœur, déjà construit)** — serveur local chiffré + hub de transfert. À enrichir d'une identité de package Windows (sparse package) pour le clic-droit et le démarrage session. C'est là que se vend le Pro (Stripe, 0 % de commission Store).
2. **Transport hors-ligne** — point d'accès Wi-Fi du PC (SoftAP). iPhone + Android, sans box ni internet.
3. **Apps natives optionnelles** — iOS (Share Extension + background URLSession) et Android (foreground service + Wi-Fi Direct). Débloquent l'icône dans le partage, la veille, la détection permanente.
4. **Fallback web zéro-app** — la page web appairée par QR reste l'entrée sans friction pour qui ne veut rien installer.

Règle de com : **« AirDrop multi-OS » oui, réception passive app-fermée sur iPhone non.**

## 5. Monétisation vérifiée : 0 % de commission Apple/Google, légalement

Si les apps mobiles sont **gratuites** et que le paiement du Pro se fait **sur l'app PC (ou le web) via Stripe**, Apple et Google ne prennent **aucune** commission — c'est hors de leur juridiction (fondé sur la règle Apple 3.1.1, « déblocage de fonctionnalités *dans* l'app »). Les apps mobiles ne font qu'authentifier un compte déjà Pro. Coût : ~2,9 % Stripe, ou ~5 % via un *merchant of record* (Paddle / Lemon Squeezy) qui gère la TVA mondiale. Ne jamais mettre d'écran de paiement *dans* l'app iOS (anti-steering).
