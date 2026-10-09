// FICHIER GÉNÉRÉ : rempli par l'orchestrateur avant une version publiée.
//
// LICENSE_PUBLIC_KEY_B64 : clé PUBLIQUE Ed25519 brute (32 octets, base64) qui
// vérifie les jetons Flitdrop Pro signés par le serveur (functions/api/license,
// secret LICENSE_SIGNING_KEY). Publique par nature : sans la clé privée, elle
// ne permet de fabriquer aucun jeton.
// ATTENTION : la valeur ci-dessous est une clé DE TEST (sa clé privée traîne
// dans les tests). À remplacer par la vraie clé avant toute publication.
export const LICENSE_PUBLIC_KEY_B64 = '/DuOo3uFrsEk2LTrypdMWZtYQITS1nUXLp8QK3vLmrg='

// Mode payant par défaut quand flitdrop.com n'a JAMAIS répondu sur cette
// installation. false tant que le mode payant n'est pas lancé (une
// installation hors ligne garde tout comme aujourd'hui). À passer à true dans
// les versions publiées APRÈS le lancement : une installation neuve qui ne
// joint jamais flitdrop.com (pare-feu, domaine bloqué) ne reste alors pas
// illimitée pour toujours.
export const PAID_MODE_BUILD_DEFAULT = false
