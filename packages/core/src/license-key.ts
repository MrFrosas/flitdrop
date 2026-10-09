// FICHIER GÉNÉRÉ : rempli par l'orchestrateur avant une version publiée.
//
// LICENSE_PUBLIC_KEY_B64 : clé PUBLIQUE Ed25519 brute (32 octets, base64) de
// PRODUCTION, qui vérifie les jetons Flitdrop Pro signés par le serveur
// (functions/api/license, secret LICENSE_SIGNING_KEY de production). Publique
// par nature : sans la clé privée, elle ne permet de fabriquer aucun jeton.
// L'app empaquetée n'accepte QUE cette clé, et seulement des jetons
// env: "production". La clé du bac à sable (sandbox) ne s'utilise qu'en
// développement, par FLITDROP_LICENSE_PUBLIC_KEY (voir docs/licence.md).
export const LICENSE_PUBLIC_KEY_B64 = 'TkGgVAzKlDgcwcU4bDpbeOE/mdjAe5260x+h4pOiXDc='

// Mode payant par défaut quand flitdrop.com n'a JAMAIS répondu sur cette
// installation. false tant que le mode payant n'est pas lancé (une
// installation hors ligne garde tout comme aujourd'hui). À passer à true dans
// les versions publiées APRÈS le lancement : une installation neuve qui ne
// joint jamais flitdrop.com (pare-feu, domaine bloqué) ne reste alors pas
// illimitée pour toujours.
export const PAID_MODE_BUILD_DEFAULT = false
