# Licences Flitdrop Pro : serveur, Paddle et mise en route

Flitdrop Pro est un achat unique (5,99 €, à vie, mises à jour comprises), vendu par Paddle, revendeur officiel (« merchant of record ») : Paddle encaisse, gère la TVA de chaque pays, les reçus et les remboursements. Nous n'avons **aucune base de données** : tout ce qui concerne un achat vit chez Paddle, et le serveur de licences n'est qu'un ensemble de Pages Functions sans état, déployées avec le site à chaque push sur `main`.

Interrupteur général : tant que `LICENSE_ENABLED` ne vaut pas exactement `1` (ou qu'un réglage requis manque), `GET /api/license/config` répond `enabled: false` et l'app garde son comportement d'aujourd'hui, tout débloqué.

## Le circuit

```
App (PC)                                   flitdrop.com (Pages Functions)            Paddle
  1. GET /api/license/config  ───────────▶ config.js : enabled, jeton client, prix
  2. tire un secret (64 hex, gardé dans l'app), claim = empreinte du secret
     ouvre flitdrop.com/pro?claim=<32 hex> (navigateur)
                                            page /pro : Paddle.js, customData { claim } ─▶ transaction
  3. POST /api/license/claim { secret }     claim.js : recalcule le claim depuis le secret,
     toutes les 5 s ───────────────────────▶ transaction « completed »
                                              de moins de 48 h avec ce claim et le prix Pro ◀─ API
     ◀── 200 { token }                        inscrit l'appareil chez le client Paddle ─▶ customer.custom_data
  4. tous les jours, si le jeton expire
     dans moins de 10 jours :
     POST /api/license/renew  ─────────────▶ renew.js : achat toujours valable ?
     ◀── 200 { token } | 403 revoked          appareil toujours inscrit ?            ◀─ API
  « J'ai déjà acheté » :
     POST /api/license/restore/start ──────▶ start.js : achat pour cette adresse ? ─▶ e-mail (Resend)
     POST /api/license/restore/verify ─────▶ verify.js : bon code ? ─▶ jeton
```

Code : `functions/api/license/` (un fichier par point d'entrée) et `functions/_lib/license/` (modules partagés ; Pages ne route que les fichiers qui exportent `onRequest`, ce dossier n'expose donc aucune adresse).

### Le jeton de licence

`base64url(JSON) + "." + base64url(signature Ed25519 des octets UTF-8 de ce JSON)`, avec le contenu :

```json
{ "v": 1, "env": "production", "plan": "pro", "dev": "<identifiant d'appareil, 32 hex>", "cus": "<32 premiers hex du SHA-256 de l'id client Paddle>", "iat": 1791000000, "exp": 1793592000 }
```

Valable 30 jours (`exp = iat + 30 jours`). L'app vérifie la signature avec la clé **publique** embarquée ; seule la clé **privée** (secret `LICENSE_SIGNING_KEY`) permet d'en fabriquer. Hors ligne, l'app tolère 7 jours après `exp`.

`env` vaut `production` ou `sandbox`. L'app publiée (empaquetée) n'accepte que des jetons `production`, vérifiés avec la clé publique de production (`packages/core/src/license-key.ts`) ; un jeton sans `env`, ou du bac à sable, n'y vaut rien. Deux paires de clés distinctes : production et bac à sable.

### Où vivent les données

| Donnée | Où | Contenu |
|---|---|---|
| Claim | `custom_data.claim` de la transaction Paddle | 32 premiers hex de `sha256("flitdrop-claim-v1:" + secret)`, passé par la page /pro ; le secret (32 octets aléatoires, 64 hex) ne quitte l'app que vers `POST /api/license/claim` |
| Appareils autorisés | `custom_data.flitdrop_devices` du client Paddle | `[{ "d": "<32 hex>", "t": <date en s> }]`, 5 au plus, le plus ancien sort |
| Appareils débloqués par claim | `custom_data.flitdrop_claims` du client Paddle | `{ "txn_...": ["<32 hex>", ...] }`, 5 appareils au plus par achat |

`d` est toujours une **empreinte** (SHA-256 tronqué) de l'identifiant d'appareil, jamais l'identifiant lui-même. Les autres clés de `custom_data` du client sont conservées à chaque écriture.

## Les points d'entrée

Réponses JSON, `cache-control: no-store` (sauf config). Corps de plus de 4 Ko refusé. Les identifiants `claim` et `device` sont exactement 32 caractères hexadécimaux **minuscules**, le `secret` 64 (sinon 400).

| Point d'entrée | Réponses |
|---|---|
| `GET /api/license/config` | `{ enabled, env, clientToken, priceId, earlyDiscountId, launchedAt, trialDays: 14, earlyDays: 30, displayPrice }`, cache public de 60 s. Mode coupé : `enabled: false` et `null` partout sauf les constantes. |
| `POST /api/license/claim { secret, device }` | Le serveur calcule le claim depuis le secret. `200 { token }` achat Pro terminé (`completed`) de moins de 48 h, avec ce claim, ni remboursé ni rétrofacturé. `202 { pending: true }` sinon (pas encore payé, autre prix, remboursé). `403 { error: "claim_used" }` ce claim a déjà débloqué 5 appareils différents. `403 { error: "too_many_devices" }` achat sur trop d'ordinateurs (5 actifs, 10 nouveaux par 30 jours). |
| `POST /api/license/restore/start { email, lang }` | Toujours `200 { challenge }`, achat ou pas. L'e-mail (code de 12 caractères) ne part que si l'adresse a un achat valable, vers l'adresse enregistrée chez Paddle, après la réponse. |
| `POST /api/license/restore/verify { email, code, challenge, device }` | `200 { token }`, ou `400 { error: "code" }` (code faux, défi modifié, autre adresse), `400 { error: "expired" }` (plus de 15 min, ou code déjà utilisé), `400 { error: "nopurchase" }` (remboursé entre-temps), `403 { error: "too_many_devices" }`. |
| `POST /api/license/renew { token, device }` | `200 { token }` si l'achat est toujours valable et l'appareil toujours inscrit ; `403 { error: "revoked" }` sinon (remboursé, rétrofacturé, appareil sorti de la liste, jeton invalide ou d'un autre appareil). Un jeton expiré (moins d'un an) est accepté, puisque tout est revérifié. |

Communes à tous les POST : `400 { error: "bad_request" }` (entrée invalide), `429 { error: "too_many" }` avec `Retry-After` (limites ci-dessous), `503 { error: "unavailable" }` avec `Retry-After: 60` (Paddle injoignable, lent, en refus ou réponse inattendue), `503 { error: "disabled" }` (mode payant coupé), `405` (autre méthode).

### Règles de sécurité

- **Jamais de licence sur une erreur.** Toute réponse inattendue de Paddle (réseau, 4xx, 5xx, 429, forme bizarre, liste tronquée là où il fallait tout voir, écriture du registre non confirmée) donne un 503 rapide (9 s au plus au total, 4 s par appel, un seul nouvel essai sur une panne passagère). L'app garde alors son état et réessaie plus tard.
- **Après un 429 de Paddle** (Paddle bloque alors l'adresse 60 s), plus aucun appel n'est tenté pendant la durée annoncée.
- **Remboursement et rétrofacturation** : un achat ne compte plus dès qu'un remboursement **approuvé** couvre l'article Pro ou tout le montant, ou dès qu'une rétrofacturation (`chargeback`) n'a pas été annulée par Paddle. Un remboursement en attente d'approbation ne retire rien encore.
- **Code de restauration** : 12 caractères en base32 de Crockford (sans I, L, O ni U), affiché `XXXX-XXXX-XXXX`, soit 60 bits. À la saisie : casse, tirets et espaces ignorés, O lu comme 0, I et L lus comme 1. Le défi renvoyé à l'app est sans état : `base64url({ v, x: expiration, n: nonce }) + "." + HMAC-SHA256`, où le HMAC couvre l'adresse, l'empreinte du code, l'expiration et le nonce, avec une clé dérivée (HKDF) de `LICENSE_SIGNING_KEY`. Comparaison à temps constant. 15 minutes.
- **Aucune fuite** : la réponse de `restore/start` est la même avec ou sans achat, et l'e-mail part après la réponse. Les journaux ne contiennent que le type d'erreur : jamais de clé, d'adresse e-mail ni de jeton. La clé d'API n'est envoyée qu'à l'hôte Paddle configuré (un lien de pagination vers un autre hôte est refusé).
- **Limites par isolat** (mémoire d'un serveur Cloudflare, remises à zéro à son redémarrage) :

| Point d'entrée | Limites |
|---|---|
| claim | 40 par minute et par IP, 20 par minute et par claim |
| restore/start | 10 par 15 min et par IP, 3 par 15 min et par adresse, 100 e-mails par heure au total |
| restore/verify | 20 par 15 min et par IP, 10 par 15 min et par adresse, 5 essais par défi |
| renew | 60 par heure et par IP, 10 par heure et par appareil |

## Variables à poser dans Cloudflare Pages

Tableau de bord Cloudflare, Workers & Pages, projet du site, Settings, Variables and Secrets. Les valeurs ne s'appliquent **qu'au déploiement suivant** : après tout changement, relancer un déploiement (Deployments, « Retry deployment » sur le dernier, ou un push sur `main`).

| Nom | Type | Rôle |
|---|---|---|
| `LICENSE_ENABLED` | texte | `1` pour allumer le mode payant ; toute autre valeur ou absence = coupé |
| `PADDLE_ENV` | texte | `sandbox` ou `production` |
| `PADDLE_API_KEY` | **secret** | clé d'API Paddle (droits ci-dessous) |
| `PADDLE_CLIENT_TOKEN` | texte | jeton côté client Paddle (public par nature, sert à Paddle.js) |
| `PADDLE_PRICE_ID` | texte | id du prix Flitdrop Pro (`pri_...`) |
| `PADDLE_EARLY_DISCOUNT_ID` | texte, facultatif | id de la remise de lancement (`dsc_...`) |
| `LICENSE_SIGNING_KEY` | **secret** | clé privée Ed25519 (PKCS8 DER en base64, une ligne) |
| `LICENSE_LAUNCHED_AT` | texte, facultatif | date du lancement (ISO, par exemple `2026-10-20`) |
| `RESEND_API_KEY` | **secret** | déjà en place pour le formulaire de contact |

Le serveur coupe aussi le mode payant si une clé ou un jeton est visiblement de l'autre environnement (clé `pdl_sdbx_...` ou jeton `test_...` avec `PADDLE_ENV=production`, et l'inverse), ou si la clé de signature n'est pas une clé Ed25519 valide.

## Clé de signature

Une seule fois, sur le Mac, hors du dépôt :

```
node tools/license-keygen.mjs ~/flitdrop-licence-cle-privee.txt
```

Le script écrit la clé **privée** dans ce fichier (lisible par toi seul, jamais écrasé) et affiche **uniquement** la clé **publique** (44 caractères base64), à embarquer dans l'app. Coller le contenu du fichier dans le secret `LICENSE_SIGNING_KEY` (en production et en preview), puis ranger le fichier dans le gestionnaire de mots de passe et le supprimer du disque. Pour réafficher la clé publique plus tard : `node tools/license-keygen.mjs --public <fichier>`.

Ne jamais changer cette clé sans raison grave (fuite) : tous les jetons existants deviendraient invalides et l'app devrait embarquer la nouvelle clé publique. En cas de fuite : nouvelle paire, nouvelle version de l'app avec la nouvelle clé publique, puis nouveau secret ; les acheteurs repassent par « J'ai déjà acheté ».

## Créer le produit dans Paddle

À faire d'abord dans le compte **sandbox** (sandbox-vendors.paddle.com), puis à refaire à l'identique dans le compte **live** (vendors.paddle.com) : les deux comptes ne partagent rien.

1. **Catalog, Products, New product** : nom « Flitdrop Pro », catégorie fiscale des logiciels téléchargeables (« Standard digital goods »), description courte.
2. Dans ce produit, **New price** : paiement unique (pas d'abonnement, « one-time »), 5,99 EUR. Prix par pays si voulu (« Override price for specific countries ») : par exemple 5,99 USD, 5,49 GBP, des prix plus bas pour les pays à faible pouvoir d'achat. Quantité 1 (minimum 1, maximum 1). Copier l'id `pri_...` dans `PADDLE_PRICE_ID`.
3. **Remise de lancement** (facultatif) : Catalog, Discounts, New discount : 50 %, limitée à ce prix, expiration 30 jours après le lancement, sans code public si elle n'est appliquée que par lien. Copier l'id `dsc_...` dans `PADDLE_EARLY_DISCOUNT_ID`.
4. **Developer tools, Authentication** :
   - nouvelle clé d'API avec seulement ces droits : `transaction.read`, `customer.write` (qui comprend la lecture des clients), `adjustment.read`. La copier dans `PADDLE_API_KEY` (secret).
   - nouveau jeton côté client (« client-side token ») : dans `PADDLE_CLIENT_TOKEN`.
5. **Checkout, Checkout settings** : lien de paiement par défaut `https://flitdrop.com/pro` (Paddle l'exige avant tout paiement). En live, faire approuver le domaine `flitdrop.com` par Paddle (vérification du site, qui demande les pages Conditions, Remboursement et Tarifs en ligne).

## Ce que fait l'app

- **Réponses du serveur** : seul `403 { error: "revoked" }` au renouvellement retire un jeton. Hors ligne, `429`, `5xx` (dont `503`), réponse illisible : rien ne change, l'app réessaie plus tard. `403 too_many_devices` (achat ou restauration) : une carte calme avec l'adresse contact@flitdrop.com, le plan ne change pas, plus de vérification automatique.
- **État signé et deuxième emplacement** (voir l'en-tête de `packages/core/src/license.ts`) : remettre une ancienne copie de `config.json` ne fait ni redescendre le compteur du jour ni revenir un essai fini ; reculer l'horloge ne donne jamais un deuxième jour neuf ; l'essai finit quand l'heure la plus tardive vue (horloge du PC ou en-tête `Date` de la config de flitdrop.com) dépasse sa fin.
- **Microsoft Store** : une installation du Store (canal gardé dans la config) reste en mode payant coupé, comme avant, tant que la config ne dit pas `storeEnabled: true` (absent = coupé).
- **Installations d'avant Flitdrop Pro** : config d'une version < 0.7.0 au premier lancement de la version payante, noté une fois dans l'état signé (`legacy`). Après l'essai, la synchro automatique et tout l'historique du presse-papiers restent gratuits ; seules la limite du jour et les dossiers par mois s'appliquent. Une carte d'accueil explique l'essai, une fois.
- **Prix affichés** : `price: { currency, display, displayEarly }` de la config (prix du pays de la personne) d'abord, puis `displayPrice` / `displayPriceEarly`, puis la moitié du prix affiché seulement si le serveur ne donne aucun prix de lancement.
- **Identifiant de la machine illisible un lancement** (commande lente au démarrage) : l'identité déjà gardée sert pour la session, Pro et les 30 fichiers restent, nouvelle lecture après 5 s, 30 s, 2 min puis toutes les 10 minutes. Relu différent : traité comme une config copiée sur un autre PC.

## Tester en sandbox

Attention : l'app lit la config de `https://flitdrop.com`. Allumer `LICENSE_ENABLED=1` en **production** fait passer toutes les installations en mode payant (essai de 14 jours compris). Pour tester sans toucher aux utilisateurs, poser les valeurs sandbox dans l'environnement **Preview** de Pages et tester sur l'adresse d'un déploiement de preview (branche) :

1. Preview : `LICENSE_ENABLED=1`, `PADDLE_ENV=sandbox`, clé d'API et jeton client sandbox, `PADDLE_PRICE_ID` sandbox, `LICENSE_SIGNING_KEY`, `RESEND_API_KEY`. Pousser une branche pour obtenir un déploiement de preview.
2. `curl https://<preview>.pages.dev/api/license/config` : `enabled: true`, `env: "sandbox"`.
3. Tirer un secret et son claim (voir « L'app contre le bac à sable » plus bas) et ouvrir `https://<preview>.pages.dev/pro?claim=<claim>&lang=fr`. Payer avec la carte de test Paddle `4242 4242 4242 4242`, date d'expiration future, n'importe quel nom, CVC `100` (si refusé, voir la page « sandbox » de la doc Paddle).
4. `curl -X POST https://<preview>.pages.dev/api/license/claim -H 'content-type: application/json' -d '{"secret":"<secret>","device":"<32 hex>"}'` : `202` tant que Paddle n'a pas fini, puis `200 { token }`. Dans Paddle, le client porte `flitdrop_devices` dans ses données personnalisées.
5. Restauration : `restore/start` avec l'adresse utilisée au paiement, code reçu par e-mail, puis `restore/verify`.
6. Remboursement : dans Paddle, Transactions, la transaction, « Refund » total. En sandbox, Paddle approuve les remboursements toutes les dix minutes ; ensuite `renew` répond `403 revoked` et `claim` répond `202`.
7. Tests automatiques (Paddle et Resend simulés) : `node --test tools/license-tests/*.test.mjs`.

### L'app contre le bac à sable

L'app **non empaquetée** (lancée depuis le dépôt : `npm run desktop` à la racine pour l'app de bureau, ou `npm run dev` pour le coeur seul) accepte deux variables d'environnement ; l'app empaquetée les ignore toujours (même garde que `allowEnvOverride = !app.isPackaged`) :

| Variable | Rôle |
|---|---|
| `FLITDROP_LICENSE_BASE` | racine des licences à la place de `https://flitdrop.com` : `/api/license/config`, `claim`, `renew`, `restore/*` et la page d'achat `/pro?claim=...` |
| `FLITDROP_LICENSE_PUBLIC_KEY` | clé publique Ed25519 brute (32 octets, base64) à la place de celle de production ; l'app attend alors des jetons `env: "sandbox"` |
| `FLITDROP_LICENSE_ENV` | facultatif : `sandbox` ou `production`, pour forcer l'environnement attendu des jetons |
| `FLITDROP_LICENSE_MARK_FILE` | facultatif : fichier du deuxième emplacement, pour repartir d'une installation neuve |

`FLITDROP_LICENSE_CONFIG_URL` (ancien nom, adresse complète de la config) reste lu ; `FLITDROP_LICENSE_BASE` l'emporte.

Clé publique du bac à sable : `BVtEu9aF0iGk3vIZavLb/vsDogisjIX+PAPvYOf1g0Q=` (sa clé privée est le `LICENSE_SIGNING_KEY` de l'environnement Preview). Clé publique de production, embarquée : `TkGgVAzKlDgcwcU4bDpbeOE/mdjAe5260x+h4pOiXDc=`.

```
FLITDROP_LICENSE_BASE=https://<preview>.pages.dev \
FLITDROP_LICENSE_PUBLIC_KEY=BVtEu9aF0iGk3vIZavLb/vsDogisjIX+PAPvYOf1g0Q= \
FLITDROP_HOME=/tmp/flitdrop-sandbox FLITDROP_LICENSE_MARK_FILE=/tmp/flitdrop-sandbox.t \
npm run desktop
```

(`FLITDROP_HOME` et le fichier de marque séparés : l'essai et le compteur de ce test ne touchent pas à l'installation habituelle.)

Pour tester un achat à la main avec `curl` : tirer un secret (`openssl rand -hex 32`), calculer le claim (`printf 'flitdrop-claim-v1:%s' <secret> | shasum -a 256 | cut -c1-32`), ouvrir `/pro?claim=<claim>`, puis `POST /api/license/claim` avec `{"secret":"<secret>","device":"<32 hex>"}`.

## Allumer en production

1. Produit, prix, remise, clé d'API et jeton client créés dans le compte **live**, domaine approuvé.
2. Variables de **production** : `PADDLE_ENV=production`, valeurs live, `LICENSE_SIGNING_KEY` (la même clé que celle dont l'app embarque la clé publique), `LICENSE_LAUNCHED_AT`, et en tout dernier `LICENSE_ENABLED=1`.
3. Redéployer, puis vérifier `curl https://flitdrop.com/api/license/config` : `enabled: true`, `env: "production"`.
4. Couper en urgence : `LICENSE_ENABLED=0`, redéployer. La config répond `enabled: false` au plus une minute après le déploiement ; les achats restent chez Paddle et se retrouvent au rallumage.

## Limites connues

- **Limites anti-abus par isolat** : elles freinent un seul client, pas une attaque répartie sur des milliers d'adresses. Le code de 60 bits reste hors de portée dans les deux cas.
- **Code de restauration réutilisable** pendant ses 15 minutes sur un autre serveur Cloudflare (sans base de données, seul l'isolat qui l'a accepté s'en souvient). Le registre de 5 appareils borne l'effet.
- **Écritures concurrentes** : deux appareils qui s'inscrivent à la même seconde chez le même client peuvent s'écraser (la dernière écriture gagne) ; l'appareil perdu repasse par claim ou « J'ai déjà acheté ».
- **Renouvellement et nombre de clients** : le jeton ne porte qu'une empreinte de l'id client ; le serveur retrouve le client en parcourant la liste des clients Paddle (200 par page, 40 pages au plus, soit 8 000 clients, empreintes gardées en mémoire de l'isolat). Au-delà de 5 000 clients environ, passer à un espace KV Cloudflare (empreinte vers id client) ; sans cela, le renouvellement répondrait 503 au-delà de 8 000 clients. Sur l'offre gratuite de Workers, une requête a droit à 50 appels sortants : 40 pages restent dessous.
- **Points de l'API Paddle non vérifiables sans compte** (le code reste prudent dans chaque cas) : si `PATCH /customers/{id}` remplace ou fusionne `custom_data` (on envoie toujours l'objet complet), si le filtre `email` tient compte de la casse (on essaie aussi la recherche, puis on compare sans casse), l'encodage des crochets de `created_at[GTE]` (laissés tels quels, comme dans la doc), et le statut exact d'une rétrofacturation (tout statut autre que `reversed` ou `rejected` retire la licence). À vérifier lors du test sandbox.
