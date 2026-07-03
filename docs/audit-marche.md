# Audit du marché — « AirDrop pour Windows » (3 juillet 2026)

Méthode : 8 recherches web thématiques menées en parallèle, puis contre-vérification adversariale des affirmations décisives (chaque vérificateur avait pour mission de RÉFUTER), puis passage critique sur les trous restants. 17 agents, ~480 requêtes et lectures de sources. Les faits ci-dessous sont sourcés et datés ; les corrections issues de la contre-vérification sont intégrées.

## Verdict en 5 points

1. **Le créneau « iPhone → PC Windows sans app à installer » est quasi vide en juillet 2026.** Tous les grands acteurs exigent une app côté téléphone. C'est le trou que Flitdrop attaque.
2. **La demande est réelle et récurrente** : threads Reddit mensuels, tutos YouTube à 2,48 M de vues, 8+ éditeurs qui achètent le mot-clé « airdrop for windows », et Phone Link noté 3,0/5 avec 460 840 avis (douleur massive au cœur même du Store).
3. **La voie technique choisie est validée** : Raccourci Apple (seul accès zéro-app à la feuille de partage iOS) + page web chiffrée en JS pur (le chiffrement n'est pas le goulot : ~300 Mo/s en JS, le wifi réel plafonne à 15-50 Mo/s).
4. **Le combo Microsoft Store 2026 est exceptionnellement favorable** : compte développeur gratuit, certification ~3 jours, 0 % de commission avec son propre système de paiement, et LocalSend (le leader open source) est banni du Store depuis 2023.
5. **La fenêtre est ouverte mais pas éternelle** : Microsoft améliore Phone Link, l'interopérabilité AirDrop imposée par l'UE s'étend côté téléphones (pas côté Windows). Shipper en semaines, pas en mois.

## La concurrence (état vérifié, juillet 2026)

| Solution | iPhone sans app ? | Verdict |
|---|---|---|
| Microsoft Phone Link | Non (app Link to Windows obligatoire) | 3,0/5 sur 460 840 avis. Max 100 fichiers, 1 transfert à la fois, fenêtre ouverte obligatoire, compte Microsoft requis. Presse-papiers partagé : Android uniquement, iOS exclu. |
| Google Quick Share Windows | Non (Android seulement) | Actif (MAJ juin 2026). Ne couvre pas l'iPhone. Plainte n°1 : « No devices to share with ». L'interop AirDrop 2026 se joue téléphone-téléphone, pas sur Windows. |
| Intel Unison | — | Mort le 30 juin 2025. |
| Samsung Quick Share PC | Non | Exige des drivers Intel spécifiques, vise les Galaxy. Fragmentation Samsung/Google confusante. |
| LocalSend (OSS, 84 536 étoiles GitHub) | Non (app des deux côtés ; version web en bêta) | Très populaire mais problèmes de découverte récurrents (pare-feu, VPN, isolation AP), et banni du Microsoft Store depuis 2023. |
| PairDrop / Snapdrop | Oui (navigateur) mais pas de feuille de partage | Snapdrop racheté par LimeWire et dénaturé (fichiers routés par leurs serveurs) ; PairDrop au ralenti (dernière release fév. 2025). Pas de réception PC en arrière-plan, pas d'intégration Windows. |
| AirDroid | Non | 3,99 $/mois ; gratuit bridé à 200 Mo/mois et 30 Mo/fichier ; plaintes de résiliation piégée. |
| Send Anywhere (Estmob/Rakuten) | Partiel (web) | 8,99 $/mois ; gratuit avec clé valable 10 min et pubs. |
| Feem | Non | Licence annuelle à renouvellement manuel, pubs plein écran. |
| KDE Connect Windows | Non | Adoption quasi nulle, iOS bridé par Apple, CVE-2025-66270 en 2025. |
| Nearby Sharing natif Windows | — | PC Windows entre eux uniquement. |

Nouveaux entrants zéro-install repérés : FilePlease, SpeedyShare (marketing agressif sur Reddit, dont de l'astroturfing identifié). La niche commence à attirer du monde : signal de validation ET d'urgence.

## Contraintes techniques vérifiées

**iOS**
- Web Share Target : toujours absent de Safari (bug WebKit 194593 ouvert depuis 2019, position « neutre »). Une PWA n'apparaîtra pas dans la feuille de partage iOS à horizon utile. L'architecture « tout PWA » est morte d'avance.
- Raccourcis Apple : « Obtenir le contenu de l'URL » POSTe bien des fichiers en multipart vers un serveur HTTP du LAN. Installation en 1 tap par lien iCloud (iOS 15+). Pièges : résolution .local capricieuse (utiliser l'IP en secours), buffering mémoire (fiable jusqu'à quelques centaines de Mo, au-delà passer par la page web), écran verrouillé = transfert interrompu, deux prompts de confidentialité au premier envoi.
- iOS 26 : Wi-Fi Aware ouvert aux tiers (DMA) mais exige une app native ET Windows n'a aucune API Wi-Fi Aware. Voie morte pour nous, et pour les concurrents aussi.
- Safari : l'upload chunké (lire 4 Mo à la fois) est le bon pattern ; lire un fichier entier en mémoire crashe la page vers ~100 Mo. OPFS `createWritable` (iOS 26+) débloquera les gros fichiers PC → iPhone.
- Web Distribution UE / sideloading : inaccessible à un indépendant (incorporation UE + 1 M de premières installations/an requis). Non pertinent vu l'approche zéro-app.

**Android**
- API 29 (Android 10) couvre ~91 % du parc actif ; notre page web vise ES2020, largement compatible.
- Web Share Target v2 (PWA dans le menu partager) ne marche que via WebAPK Chrome+GMS ; l'installation PWA via Samsung Internet est cassée début 2026. Conclusion : Android passe par la page web simple (ça marche partout), la PWA installable est un bonus, jamais un prérequis.
- Chrome 142 impose une permission « Local Network Access » aux sites PUBLICS qui contactent des IP privées. Notre page est servie par le PC lui-même : non concernée. (Le pattern PairDrop, lui, est fragilisé.)
- Positionnement : Quick Share couvre déjà Android→Windows gratuitement. Marketing iPhone-first assumé, Android supporté honnêtement via navigateur.

**Windows**
- Windows 11 : 69,9 % mondial, 72,3 % en France (StatCounter juin 2026). Win10 ~28 %, ESU consommateur gratuit prolongé jusqu'au 12 octobre 2027 (annonce 25 juin 2026) : le parc Win10 fond lentement. Electron couvre les deux.
- Microsoft Store : compte individuel gratuit (depuis le 10 sept. 2025), certification ≤ 3 jours, Electron/MSIX officiellement supporté, le Store signe les paquets. Commission 15 %, ou **0 % avec son propre système de paiement** (app non-jeu).
- mDNS : Windows répond nativement à `<NomPC>.local` (UDP 5353, profil réseau Privé). Pas de DNS-SD natif. Pare-feu : déclarer les règles dans le manifeste MSIX (`windows.firewallRules`) supprime l'invite ; un refus à l'invite classique crée des blocages persistants.

## Le nom

Vérification Store/App Store/Play/marques/domaines sur 5 candidats :
- **Windrop : mort** (windrop.app, produit vivant de la même catégorie, + « WinDrop — AirDrop for Windows » open source).
- **Flick : mort** (app « Flick. » de partage de fichiers, même catégorie, Store+iOS+Android, marque US).
- **Droply : mort** (app iOS homonyme même catégorie, 2 marques US).
- **Dropair : juridiquement le pire choix** (transposition directe de la marque AirDrop d'Apple, US Reg 4302137, classe 9 « file sharing software »).
- **Flitdrop : le seul propre.** Zéro app, zéro produit, zéro marque trouvés ; flitdrop.com ET flitdrop.app libres au 3 juillet 2026. Alternatives de repli : Zapdrop, Blinkdrop. Vérification formelle USPTO/EUIPO à faire avant dépôt de marque.

Marketing « AirDrop pour Windows » : autorisé en usage descriptif et comparatif, interdit dans le nom du produit. Prévoir en pied de page : « AirDrop is a trademark of Apple Inc. Flitdrop has not been authorized, sponsored, or otherwise approved by Apple Inc. »

## Monétisation (chiffres vérifiés)

- Pattern du marché : **le LAN est gratuit partout ; le mur payant, c'est le relais internet** (AirDroid : 200 Mo/mois en gratuit).
- Coût réel d'un relais : TURN auto-hébergé Hetzner ≈ 1 €/To (20 To inclus par VPS), soit ~45× moins cher que Cloudflare TURN (0,05 $/Go). Les quotas des concurrents sont de la discrimination tarifaire, pas une contrainte de coût : un relais gratuit généreux est finançable et devient une arme.
- Les utilisateurs paient déjà par dépit, mais rejettent l'abonnement (« I'd even be willing to pay but like a one time fee not subscription »).
- Conversion freemium utilitaires : 2,6-6,1 %, moyenne ~3,7 %.
- Détail juridique décisif : un relais store-and-forward (fichiers stockés) fait de l'éditeur un hébergeur de contenus (RGPD, DSA). Un TURN éphémère chiffré de bout en bout, non. Choix arrêté : TURN éphémère E2E.

Voir [business.md](business.md) pour le modèle complet.

## Ce que l'audit n'a PAS validé (à tester en conditions réelles)

Honnêteté d'abord, ce sont les vrais risques restants :
1. **Test de charge du Raccourci iOS sur vidéos de 1-4 Go et lots de 100+ photos** : le buffering mémoire de l'app Raccourcis est la plus grosse inconnue. Mitigation déjà en place : la page web chunkée gère ces cas.
2. Comportement de Safari sur les HEIC/Live Photos à l'upload (original ou conversion ?).
3. Taux de complétion réel de l'onboarding (QR + prompts réseau local iOS) devant 5-10 vrais utilisateurs.
4. Fréquence réelle du besoin hors-LAN (calibre la frontière gratuit/payant).
5. Stabilité de l'endpoint du Raccourci quand l'IP change (mitigations v1 : .local + IP de secours ; v1.1 : rendez-vous cloud).
