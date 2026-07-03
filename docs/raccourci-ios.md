# Raccourci iOS « Envoyer au PC »

Objectif : depuis Photos (ou n'importe quelle app), Partager → **Envoyer au PC**, comme AirDrop. Sans App Store, sans payer Apple, sans app installée : l'app **Raccourcis** est préinstallée sur tous les iPhone.

Les adresses personnalisées (avec le jeton de l'appareil) s'affichent dans Flitdrop : **Réglages → Partage direct depuis l'iPhone**.

## Raccourci 1 : Envoyer des fichiers (le principal)

1. App **Raccourcis** → onglet Raccourcis → **+**.
2. Touche l'icône de réglages (ⓘ) → active **« Afficher dans la feuille de partage »**. Types acceptés : Images, Fichiers multimédias, Fichiers, PDF.
3. Ajoute l'action **« Obtenir le contenu de l'URL »** :
   - URL : `http://NOM-DU-PC.local:47777/api/shortcut/upload?t=JETON` (copie-la depuis Flitdrop)
   - Méthode : **POST**
   - Corps de la requête : **Formulaire**
   - Ajoute un champ : type **Fichier**, clé `file`, valeur = variable **Entrée du raccourci**
4. (Optionnel) Ajoute l'action **« Afficher le résultat »** pour voir la confirmation « … est arrivé sur le PC ✅ ».
5. Nomme-le **Envoyer au PC**, choisis une icône (flèche vers le haut), enregistre.

Usage : Photos → sélectionner 1 ou plusieurs photos → Partager → Envoyer au PC.

## Raccourci 2 : Coller sur le PC (presse-papiers téléphone → PC)

1. Nouveau raccourci → action **« Obtenir le presse-papiers »**.
2. Action **« Obtenir le contenu de l'URL »** : URL `…/api/shortcut/text?t=JETON`, méthode POST, corps **Fichier** = Presse-papiers.
3. Nomme-le **Coller sur le PC**. Astuce : ajoute-le en widget d'écran d'accueil ou demande à Siri « Coller sur le PC ».

## Raccourci 3 : Copier depuis le PC (presse-papiers PC → téléphone)

1. Nouveau raccourci → **« Obtenir le contenu de l'URL »** : URL `…/api/shortcut/clipboard?t=JETON`, méthode GET.
2. Action **« Copier dans le presse-papiers »**.
3. Nomme-le **Copier depuis le PC**.

## Distribution en un tap (pour le site / le Store)

Créer ces raccourcis une fois, puis **Partager → Copier le lien iCloud** : n'importe quel utilisateur les installe en un tap depuis le site Flitdrop. Le raccourci partagé contient l'URL avec un jeton d'exemple ; à l'installation, iOS propose de personnaliser les champs ("Configuration à l'importation" dans les réglages du raccourci) : y mettre l'adresse affichée par Flitdrop. C'est l'étape à soigner dans l'onboarding produit (page dédiée avec GIF).

## Notes techniques vérifiées (audit juillet 2026)

- Windows 10/11 répond nativement à `NOM-PC.local` en mDNS, ce qui rend le raccourci robuste aux changements d'IP. MAIS la résolution `.local` côté iOS s'est montrée capricieuse sur certains réseaux depuis iOS 17 (doc Apple 101903). D'où l'**adresse de secours en IP** affichée dans Flitdrop : si `.local` ne répond pas, utiliser l'IP et, idéalement, fixer l'IP du PC dans la box (réservation DHCP, 2 minutes).
- « Obtenir le contenu de l'URL » accepte l'HTTP local en clair ; il refuse les certificats auto-signés, d'où le choix du jeton (voir [securite.md](securite.md)).
- Premier envoi : iOS affiche deux confirmations (autoriser la connexion à l'hôte + accès au réseau local). Normal, une seule fois.
- L'envoi s'interrompt si l'écran se verrouille pendant le transfert : pour les grosses vidéos, garder l'écran allumé.
- L'app Raccourcis bufferise le fichier en mémoire : fiable jusqu'à quelques centaines de Mo. Au-delà (grosses vidéos, lots de 100+ photos), **utiliser la page web Flitdrop** dans Safari, qui découpe en morceaux de 4 Mo et n'a pas cette limite.
- Plusieurs fichiers partagés = envoyés dans la même requête multipart : Flitdrop les enregistre tous.
