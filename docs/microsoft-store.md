# Publication sur le Microsoft Store

## Checklist

1. **Compte développeur individuel : gratuit** depuis le 10 septembre 2025 (les 19 USD historiques ont été supprimés). Inscription sur storedeveloper.microsoft.com avec vérification d'identité (pièce officielle + selfie). Vérifié le 3 juillet 2026.
2. **Réserver le nom** de l'app dans le Partner Center (vérifier la disponibilité de « Flitdrop » au moment de la réservation, prévoir des variantes).
3. Récupérer l'**identité du package** (Package/Identity/Name et Publisher) dans Partner Center → Gestion des produits, et remplacer les `PLACEHOLDER` dans `apps/desktop/electron-builder.yml`.
4. Builder sur Windows (ou GitHub Actions, workflow fourni) : `npm run dist:win -w @flitdrop/desktop` → `release/*.appx`.
5. Soumission : uploader l'appx (le Store signe lui-même les paquets soumis via Partner Center, pas besoin de certificat de signature de code pour la voie Store).
6. **Fiche** : captures de l'interface radar + de la page téléphone, description axée « AirDrop pour Windows » (voir la note marque dans l'audit), catégorie Productivité / Utilitaires.
7. **Politique de confidentialité** (obligatoire, URL) : Flitdrop n'envoie aucune donnée à des serveurs, tout reste sur le réseau local ; le mentionner est un argument, pas juste une conformité.
8. Déclaration des capacités réseau du MSIX : `internetClient` + `privateNetworkClientServer` (réception sur le réseau local). electron-builder les inclut par défaut pour appx ; vérifier dans le manifeste généré.

## Pare-feu Windows (détail décisif pour le taux d'activation)

Une app qui écoute sur le LAN déclenche normalement l'invite du Pare-feu Windows au premier lancement. Piège vérifié par l'audit : si l'utilisateur clique « Annuler », Windows crée des **règles de blocage persistantes** que le grand public ne saura jamais annuler.

La parade : un MSIX peut **déclarer ses règles de pare-feu dans le manifeste** (extension `desktop2:Extension` catégorie `windows.firewallRules`), ce qui supprime entièrement l'invite. À ajouter au manifeste généré par electron-builder (post-traitement du AppxManifest.xml) avant la soumission, et à valider en certification.

Second piège vérifié : sur un réseau marqué « Public » dans Windows, mDNS et l'écoute locale sont bloqués par défaut. L'onboarding doit détecter ce cas et guider vers « réseau privé ».

## Alternative hors Store

L'installeur NSIS (`release/*.exe`) se distribue depuis un site web. Sans certificat de signature de code (~300 €/an), SmartScreen affichera un avertissement au début : le Store est donc la voie principale au lancement, le `.exe` sert aux early adopters.

## Mises à jour

Voie Store : soumettre une nouvelle version, mise à jour automatique chez les utilisateurs. C'est l'avantage décisif du Store pour un utilitaire grand public.
