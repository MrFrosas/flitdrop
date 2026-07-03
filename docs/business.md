# Modèle économique et feuille de route

## Positionnement

**« L'AirDrop de ton PC. Sans rien installer sur ton téléphone. »**

- Cible marketing n°1 : utilisateurs d'iPhone avec un PC Windows (le segment mal servi par tout le monde, y compris Microsoft et Google).
- Android : supporté à 100 % via le navigateur, mais on ne promet pas de battre Quick Share chez lui ; on gagne sur « une seule app pour tous tes appareils, y compris l'iPhone ».
- Angle différenciant en copy : zéro app côté téléphone, zéro compte, zéro cloud, chiffré de bout en bout, gratuit sur ton wifi sans limite.

## Offre (validée par les données de l'audit)

**Gratuit, pour toujours, sans pub :**
- Transferts illimités sur le réseau local (fichiers, photos, vidéos, texte, presse-papiers), dans les deux sens.
- Appareils illimités, taille de fichier jusqu'à 8 Go (réglable).
- C'est le standard du marché (le LAN gratuit partout) ET notre coût est nul. Toute limite artificielle ici détruirait la note Store, notre principal actif face à un Phone Link à 3,0/5.

**Flitdrop Plus, paiement unique ~19,99 € (pas d'abonnement) :**
- Transfert hors réseau local via relais chiffré de bout en bout (fair use généreux, ex. 30 Go/mois : coût réel ~0,03 €/utilisateur/mois via TURN Hetzner).
- Multi-PC (maison + bureau), historique étendu, réglages avancés (dossiers par appareil, règles de tri photo/vidéo).
- Le choix du paiement unique suit la demande explicite du marché (« one time fee not subscription ») et évite de rejouer la leçon des abonnements à vie Minax.

**Flitdrop Pro (plus tard, abonnement ~3,99 €/mois) :**
- Pour les pros : relais illimité, envoi à plusieurs PC simultanés, files d'équipe. Uniquement quand le besoin sera prouvé par la télémétrie opt-in.

## Encaissement

- Microsoft Store 2026 : **0 % de commission** pour une app non-jeu avec son propre système de paiement (vs 15 % via le commerce Microsoft).
- Recommandation : passer par un merchant of record (Paddle ou Lemon Squeezy, ~5 %) plutôt que Stripe en direct. Raisons : ils gèrent la TVA UE/mondiale (lourde en direct pour un auto-entrepreneur), et le compte Stripe existant est déjà partagé entre 3 plateformes, ce qui compliquerait la segmentation comptable.

## Go-to-market (à démarrer AVANT le lancement)

L'audit est formel : l'organique du Store est minuscule (les concurrents plafonnent à quelques dizaines d'avis), le vrai canal est le SEO/YouTube sur « airdrop for windows » / « airdrop pour pc », qui met ~3 mois à produire.

1. **Maintenant** : réserver flitdrop.com + flitdrop.app, réserver le nom dans le Partner Center, poser la landing page (démo vidéo 30 s : partager une photo depuis l'iPhone → elle apparaît sur le PC).
2. **Pendant le développement v1.0** : 3-4 articles comparatifs honnêtes (« AirDrop pour Windows : les 7 solutions testées en 2026 »), en français ET en anglais ; 1 vidéo YouTube démo.
3. **Lancement** : Store (fiche léchée, captures radar + téléphone), Product Hunt, Reddit (r/Windows11, r/iphone) en toute transparence (pas d'astroturfing, la niche en est déjà polluée et se fait détecter).
4. Pied de page légal : « AirDrop is a trademark of Apple Inc. Flitdrop has not been authorized, sponsored, or otherwise approved by Apple Inc. »

## Feuille de route

**v1.0 (construite le 3 juillet 2026)** : serveur local chiffré + interface radar PC + page téléphone + Raccourcis iOS + Electron + packaging Windows. État : fonctionnel, testé (29 tests automatisés + parcours navigateur réel).

**v1.1 (avant lancement public)** :
- Test de charge Raccourci iOS (vidéos 1-4 Go) sur un vrai iPhone : LA validation manquante.
- Règles pare-feu dans le manifeste MSIX (supprime l'invite pare-feu, décisif pour l'activation).
- Détection « réseau Public » Windows avec guidage.
- Onboarding premier lancement (3 écrans) + page d'installation des Raccourcis par lien iCloud.
- Anglais (i18n), télémétrie opt-in minimale (succès appairage / transfert, anonyme).

**v1.2** : rendez-vous cloud pour le Raccourci (l'IP peut changer, le lien jamais), presse-papiers images, auto-démarrage discret.

**v2 (payant activé)** : relais TURN chiffré de bout en bout (Hetzner), Flitdrop Plus, multi-PC. Éventuellement app compagnon iOS OPTIONNELLE pour le presse-papiers automatique (le seul cas qui exige une app), sans jamais en faire un prérequis.

## Les deux métriques qui comptent

1. **Taux d'appairage réussi au premier essai** (l'échec de découverte est la plainte n°1 du marché entier).
2. **Le deuxième transfert** (J+7) : un produit qui réussit le premier transfert mais casse quand l'IP change meurt en silence. Toute la conception (clé persistante, .local + IP de secours, reconnexion silencieuse) vise cette métrique.
