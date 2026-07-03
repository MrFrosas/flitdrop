# Synchronisation du presse-papiers : la vérité (audit vérifié, juillet 2026)

La question centrale : « je copie un message WhatsApp sur mon iPhone, est-ce que ça se colle tout seul sur le PC, comme le Presse-papiers universel d'Apple ? »

Réponse courte, vérifiée sur les docs officielles Apple et Android : **non, pas tout seul dans le sens téléphone vers PC, et ce n'est pas une limite de Flitdrop. C'est un verrou des systèmes d'exploitation que même une app native ne peut pas franchir.** Voici le détail, sans enjoliver.

## Pourquoi le « tout seul » depuis le téléphone est impossible pour tout le monde

Le Presse-papiers universel d'Apple marche tout seul parce que c'est un **service du système** (Continuity), réservé aux appareils Apple d'un même compte iCloud. Apple ne l'ouvre à **aucune** app tierce. C'est le mur qu'ont heurté toutes les solutions du marché : Clipt (OnePlus, fermé), Pushbullet, SwiftKey, KDE Connect.

- **iPhone.** Depuis iOS 9, une app ne peut lire le presse-papiers **que si elle est ouverte au premier plan**. En arrière-plan, elle lit « rien ». Et depuis iOS 16, même au premier plan, lire le presse-papiers affiche la pop-up « Coller depuis d'autres apps ». Il n'existe aucun déclencheur « quand je copie » dans les Raccourcis. Donc sur iPhone : **un geste (un tap) est obligatoire**, jamais automatique.
- **Android.** Depuis Android 10, seule l'app **au premier plan** ou le **clavier par défaut** peut lire le presse-papiers. Un service en arrière-plan ne le peut pas. Donc : **un tap** (tuile, notification) ou « devenir le clavier » pour du quasi-automatique.
- **PC (Windows/Mac).** Là, aucune restriction : le PC peut surveiller **son propre** presse-papiers en continu, tout seul.

## Ce qui est donc réellement automatique, et ce qui demande un tap

| Sens | iPhone | Android | PC |
|---|---|---|---|
| **Téléphone → PC** (je copie sur le tel) | Un tap (Bouton Action / Raccourci / app ouverte) | Un tap (tuile) ou clavier Flitdrop | reçoit tout seul |
| **PC → Téléphone** (je copie sur le PC) | **automatique côté PC**, le tel reçoit dans « Recevoir » | **automatique côté PC** | **pousse tout seul** |

Autrement dit : le PC est le côté facile. Le téléphone est le côté bridé, dans les deux sens, par l'OS.

## Ce que Flitdrop fait déjà (livré et testé)

- **PC → téléphone, automatique.** Un réglage « Synchroniser mon presse-papiers » : dès que vous copiez du texte sur le PC, il devient disponible sur le téléphone (onglet « Recevoir »), sans aucune action. Testé de bout en bout, avec anti-doublon et anti-écho (le texte reçu du téléphone n'est pas renvoyé en boucle).
- **Téléphone → PC, en un tap.** L'onglet « Texte » de la page envoie le presse-papiers au PC en un tap ; le Raccourci Apple « Coller sur le PC » fait pareil depuis le Bouton Action de l'iPhone.

## Ce qu'une app native ajouterait (et ce qu'elle n'ajouterait jamais)

L'app native rend le « un tap » **fluide et proche de l'automatique** : sur iPhone via le Bouton Action et une **extension de clavier Flitdrop** (qui peut insérer le contenu reçu du PC directement, sans passer par le presse-papiers système) ; sur Android via une **tuile** et un **clavier** (le seul composant qui approche le « tout seul »). Mais elle ne transformera **jamais** le « un tap » en « zéro tap » sur iPhone : l'interdiction de lire le presse-papiers en arrière-plan est un verrou d'Apple que personne ne contourne, et la tendance 2025-2026 (macOS ajoute la même pop-up que l'iPhone) va vers **plus** de restrictions.

Verdict honnête : le meilleur discours est **« ton presse-papiers partout, en un geste »**, pas « comme par magie ». Promettre l'invisible créerait de la déception dès le premier test sur iPhone.

## Le réglage texte / images / off

Un réglage pour activer ou couper la synchro, et la limiter au texte, a du sens, mais pour la **vie privée et le coût**, pas pour la rendre plus automatique :
- Le presse-papiers contient souvent des mots de passe, des codes 2FA, des données bancaires. Pouvoir couper, ou se limiter au texte, est un gage de confiance.
- Les images (captures d'écran) sont lourdes et parfois sensibles : les garder en opt-in évite d'en envoyer sans le vouloir.

Défaut recommandé : synchro texte en opt-in (coupée par défaut), images en opt-in séparé, avec un interrupteur maître. La synchro d'images du presse-papiers nécessite un module natif de lecture d'image (feuille de route) ; la synchro de texte est livrée.
