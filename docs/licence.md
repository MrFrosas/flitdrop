# Licences Flitdrop Pro : serveur, Paddle, base D1 et mise en route

Flitdrop Pro est un achat unique (5,99 €, à vie, mises à jour comprises), vendu par Paddle, revendeur officiel (« merchant of record ») : Paddle encaisse, gère la TVA de chaque pays, les reçus et les remboursements. Paddle reste la **source de vérité** des achats, des clients, des remboursements et des rétrofacturations. Le serveur de licences est un ensemble de Pages Functions déployées avec le site à chaque push sur `main`, plus une petite base **Cloudflare D1** (SQLite) qui garde ce que Paddle ne sait pas tenir de façon sûre : les appareils autorisés, les index pour retrouver un achat en un seul appel, les codes déjà utilisés, les plafonds anti-abus et les rétractations reçues.

Interrupteur général : tant que `LICENSE_ENABLED` ne vaut pas exactement `1` (ou qu'un réglage requis manque, base D1 comprise), `GET /api/license/config` répond `enabled: false` et l'app garde son comportement d'aujourd'hui, tout débloqué.

## Le circuit

```
App (PC)                                     flitdrop.com (Pages Functions + D1)                Paddle
  1. GET /api/license/config  ─────────────▶ config.js : enabled, jeton client, prix localisé ─▶ pricing-preview (cache 6 h)
  2. tire claimSecret (64 hex, gardé par l'app)
     ouvre flitdrop.com/pro?claim=<empreinte du secret, 32 hex>
                                              page /pro : ?claim= retiré de l'adresse aussitôt,
                                              Paddle.js chargé seulement au clic ;
                                              customData { claim } ─────────────────────────────▶ transaction
                                              checkout.completed : POST checkout-done
                                              { transaction_id, claim } : lue chez Paddle ◀──── GET /transactions/{id}
                                              et notée dans D1 (claim -> transaction)
  3. POST /api/license/claim { secret, device } toutes les 5 s
                                ────────────▶ claim.js : empreinte du secret -> D1 -> transaction
                                              relue chez Paddle (completed, pas remboursée) ◀── 2 appels
     ◀── 200 { token }                        appareil inscrit dans D1 (5 actifs, 5 par claim)
  4. tous les jours, si le jeton expire
     dans moins de 10 jours :
     POST /api/license/renew ──────────────▶ renew.js : « cus » -> client par D1, appareil actif ?
     ◀── 200 { token } | 403 revoked          achats du client toujours valables ? ◀─────────── 2 appels
  « J'ai déjà acheté » :
     POST /api/license/restore/start ──────▶ réponse immédiate ; après la réponse : achat pour
                                              cette adresse ? -> e-mail du code (Resend)
     POST /api/license/restore/verify ─────▶ verify.js : bon code, une seule fois -> jeton
Site, page /refund#withdraw :
     POST /api/withdraw ───────────────────▶ rétractation notée dans D1, accusé daté par e-mail
```

Code : `functions/api/license/` (un fichier par point d'entrée), `functions/api/withdraw.js` et `functions/_lib/license/` (modules partagés ; Pages ne route que les fichiers qui exportent `onRequest`, ce dossier n'expose donc aucune adresse) : `config.js` (réglages, garde-fou d'environnement), `crypto.js` (jetons, claim, défis), `db.js` (base D1), `paddle.js` (API Paddle), `price.js` (prix localisé), `mail.js` (e-mails), `http.js`, `state.js`.

## Deux environnements, deux clés

| | Production | Preview (sandbox) |
|---|---|---|
| Adresse | `flitdrop.com`, `www.flitdrop.com` | adresses de preview `*.flitdrop.pages.dev` (et `localhost`) |
| Paddle | compte live, `PADDLE_ENV=production` | compte sandbox (carte de test gratuite), `PADDLE_ENV=sandbox` |
| Base D1 liée sous `LICENSE_DB` | `flitdrop-licences` (juridiction UE) | `flitdrop-licences-sandbox` (juridiction UE) |
| Clé de signature `LICENSE_SIGNING_KEY` | clé de production, dont l'app publiée embarque la clé publique | **une autre** clé, réservée à la sandbox |

Trois verrous empêchent un achat sandbox gratuit de donner une licence de production :

1. **Garde-fou d'hôte** : la sandbox ne répond jamais sur `flitdrop.com` ni `www.flitdrop.com`, et la production ne répond que là (pas sur `flitdrop.pages.dev` ni sur une preview). Sinon la config dit `enabled: false` et tous les points d'entrée répondent `503 disabled`. Une erreur de réglage entre Production et Preview coupe donc la vente au lieu de fabriquer des jetons d'un environnement sur l'autre.
2. **Le jeton dit son environnement** (`env`), et `renew` refuse (`403 revoked`) tout jeton d'un autre environnement que le sien. L'app publiée refuse elle-même tout jeton dont `env` n'est pas `production`.
3. **Une clé de signature par environnement** : un jeton sandbox ne passe pas la vérification de la clé publique de production.

### Le jeton de licence

`base64url(JSON) + "." + base64url(signature Ed25519 des octets UTF-8 de ce JSON)`, avec le contenu :

```json
{ "v": 1, "env": "production", "plan": "pro", "dev": "<identifiant d'appareil, 32 hex>", "cus": "<32 premiers hex du SHA-256 de l'id client Paddle>", "iat": 1791000000, "exp": 1793592000 }
```

Valable 30 jours (`exp = iat + 30 jours`). L'app vérifie la signature avec la clé **publique** embarquée ; seule la clé **privée** (secret `LICENSE_SIGNING_KEY`) permet d'en fabriquer. Hors ligne, l'app tolère 7 jours après `exp`.

`env` vaut `production` ou `sandbox`. L'app publiée (empaquetée) n'accepte que des jetons `production`, vérifiés avec la clé publique de production (`packages/core/src/license-key.ts`) ; un jeton sans `env`, ou du bac à sable, n'y vaut rien. Deux paires de clés distinctes : production et bac à sable.

### Le claim : un secret que l'adresse ne contient jamais

L'app tire `claimSecret` (64 hexadécimaux) et ne l'envoie qu'à `POST /api/license/claim`. L'adresse de la page /pro ne porte que son empreinte : `claim = 32 premiers hex de sha256("flitdrop-claim-v1:" + claimSecret)`. Le serveur recalcule le claim depuis le secret. Une adresse `/pro?claim=...` qui fuiterait (historique, outil de mesure, capture d'écran) ne permet donc de rien débloquer.

En plus, la page /pro retire `claim`, `early` et `lang` de la barre d'adresse dès son chargement (`site/js/pro.js`, chargé avant `site/js/analytics.js`), en les gardant en mémoire et dans le `sessionStorage` de l'onglet (pour le changement de langue). Les outils de mesure ne reçoivent jamais de paramètre de requête : PostHog et GA4 reçoivent une adresse nettoyée (seuls les `utm_*` des campagnes restent), et Clarity, qui lit l'adresse lui-même, ne démarre jamais tant qu'un `?claim=` y figure. Le consentement n'est pas touché (même filtre, même ordre).

## La base D1

Liaison `LICENSE_DB` sur le projet Pages. Les tables se créent toutes seules (`CREATE TABLE IF NOT EXISTS`, une fois par isolat) : **aucune migration à lancer**. Copie de référence : [`docs/licence-schema.sql`](licence-schema.sql) (un test vérifie qu'elle reste identique au code). Sans la liaison, la config dit `enabled: false` et les points d'entrée répondent `503` à retenter.

| Table | Contenu |
|---|---|
| `purchases` | claim -> transaction Paddle (id, client, dernier statut vu, remboursée ou non). Notée par checkout-done ou par le balayage de secours. Une transaction notée n'est remplacée par une autre que si elle a été remboursée. |
| `customers` | `cus` (empreinte du jeton) -> id client Paddle, noté au déblocage et à la restauration : le renouvellement retrouve le client en O(1). |
| `devices` | appareils par client : empreinte de l'appareil (jamais l'identifiant brut), inscription, dernière fois vu, sortie (`evicted_at`). Un appareil sorti garde sa ligne : c'est la preuve que son jeton ne se renouvelle plus. |
| `claim_devices` | appareils débloqués par chaque claim (5 au plus, à vie). |
| `registrations` | journal des nouvelles inscriptions (plafond de 10 par client sur 30 jours glissants), gardé 60 jours. |
| `used_challenges` | nonces des codes de restauration déjà utilisés (usage unique sur tous les serveurs). |
| `counters` | plafonds partagés entre isolats (par adresse e-mail, par jour, par minute). Les adresses n'y figurent qu'en empreinte. |
| `withdrawals` | rétractations reçues (nom, adresse, commande, langue, date et heure, accusé envoyé ou non), gardées 3 ans. |
| `price_cache` | prix localisé par pays, 6 heures (10 minutes après une erreur). |

Règle d'écriture : **jamais « lire puis écrire » en JavaScript**. Chaque plafond tient dans une écriture conditionnelle d'une seule instruction (`INSERT ... SELECT ... WHERE (SELECT count(*) ...) < 5`, `ON CONFLICT ... DO UPDATE ... WHERE n < max`, puis lecture de `meta.changes`), ou dans un lot (`batch`) que D1 exécute d'un bloc, dans une seule transaction. Inscrire un appareil est un seul lot : place du claim, journal sous le plafond mensuel, inscription, sortie du moins récemment vu, verdict lu dans la même transaction. Deux requêtes simultanées ne peuvent donc jamais dépasser un plafond (les tests le prouvent avec 50 requêtes simultanées).

Règles des appareils :

- au plus **5 appareils actifs** par client ; en inscrire un 6e fait sortir le **moins récemment vu** (jamais celui qu'on inscrit). « Vu » = débloqué, restauré ou renouvelé ;
- au plus **10 nouvelles inscriptions** par client sur 30 jours glissants ; au-delà : `403 { error: "too_many_devices" }` (l'app affiche un message calme et le lien de contact). Un appareil encore actif se restaure toujours ;
- un **claim** débloque au plus **5 appareils**, à vie : `403 { error: "claim_used" }` au-delà.

Lire la base : `npx wrangler d1 execute flitdrop-licences --remote --command "SELECT count(*) FROM devices WHERE evicted_at IS NULL"` (et `flitdrop-licences-sandbox` pour la preview).

## Les points d'entrée

Réponses JSON, `cache-control: no-store` (sauf config). Corps de plus de 4 Ko refusé. `device` et `claim` : exactement 32 hexadécimaux **minuscules** ; `secret` : 64 hexadécimaux minuscules (sinon 400).

| Point d'entrée | Réponses |
|---|---|
| `GET /api/license/config` | `{ enabled, env, clientToken, priceId, earlyDiscountId, launchedAt, trialDays: 14, earlyDays: 30, displayPrice, displayPriceEarly, price, storeEnabled }`, cache **privé** de 60 s (le prix dépend du pays). Mode coupé : `enabled: false` et `null` pour les réglages Paddle. Détails ci-dessous. |
| `POST /api/license/checkout-done { transaction_id, claim }` | Toujours `200 { ok: true }` pour une requête bien formée : lit cette transaction chez Paddle (un appel, par son id) et la note si elle porte le prix Pro, ce claim, un client, et le statut `paid` ou `completed`. Ne donne jamais de jeton. |
| `POST /api/license/claim { secret, device }` | `200 { token }` achat Pro `completed` portant ce claim, ni remboursé ni rétrofacturé. `202 { pending: true }` sinon (pas encore payé ou terminé, remboursé, autre prix, balayage de secours incomplet : jamais un échec définitif, l'app continue d'interroger). `403 { error: "claim_used" }` ou `403 { error: "too_many_devices" }`. |
| `POST /api/license/restore/start { email, lang }` | Toujours `200 { challenge }`, **tout de suite** : la recherche chez Paddle et l'e-mail (code de 12 caractères, vers l'adresse enregistrée chez Paddle) se font après la réponse. Ni le contenu ni le temps de réponse ne disent si l'adresse a acheté. |
| `POST /api/license/restore/verify { email, code, challenge, device }` | `200 { token }`, `400 { error: "code" }` (code faux, défi falsifié, autre adresse), `400 { error: "expired" }` (plus de 15 min, ou code déjà utilisé, sur n'importe quel serveur), `400 { error: "nopurchase" }` (remboursé entre-temps), `403 { error: "too_many_devices" }`. |
| `POST /api/license/renew { token, device }` | `200 { token }` si l'achat est valable et l'appareil actif. `403 { error: "revoked" }` **seulement sur une preuve** : jeton invalide, d'un autre appareil ou d'un autre environnement, appareil sorti, tous les achats du client remboursés ou rétrofacturés. `503` si l'état ne peut pas être établi (client ou appareil inconnus de la base, aucun achat Pro trouvé, panne) : l'app garde son jeton jusqu'à l'expiration, puis « J'ai déjà acheté ». Un jeton expiré (moins d'un an) est accepté. |
| `POST /api/withdraw { name, email, order?, lang }` | Toujours `200 { ok: true, receivedAt }` pour une demande bien formée (voir « Rétractation »). |

Communes à tous les POST : `400 { error: "bad_request" }` (entrée invalide), `429 { error: "too_many" }` avec `Retry-After`, `503 { error: "unavailable" }` avec `Retry-After` (Paddle ou base injoignables, lents, en refus, réponse inattendue), `503 { error: "disabled" }` avec `Retry-After: 300` (mode payant coupé), `405` (autre méthode).

### La config en détail

- `displayPrice` et `displayPriceEarly` : tableau fixe de secours, calculé d'un seul endroit (`functions/_lib/license/config.js`) : `{ EUR: "5,99 €", USD: "$5.99", GBP: "£5.49" }` et, à 50 %, `{ EUR: "3,00 €", USD: "$3.00", GBP: "£2.75" }` (arrondi comme Paddle, vérifié en sandbox le 9 octobre 2026 : 5,99 € à -50 % = 3,00 €).
- `price = { currency, display, displayEarly }` : prix localisé pour le pays du visiteur (`request.cf.country`, donné par Cloudflare). Notre serveur demande l'aperçu de prix de Paddle (`POST /pricing-preview` avec le prix, le seul code pays et, pour `displayEarly`, la remise de lancement), en cache 6 heures par pays dans D1. Euro, dollar et livre s'écrivent comme sur le site (`5,99 €`), les autres devises comme Paddle les écrit. Sur toute erreur (Paddle, base, pays inconnu, mode coupé) : le prix de secours du tableau fixe (livre au Royaume-Uni, dollar aux États-Unis, euro ailleurs), sans jamais faire attendre plus de 3 s. La page /pro ne charge donc **Paddle.js qu'au clic** sur « Débloquer » : aucune requête vers Paddle à la simple visite (EDPB, lignes directrices 2/2023).
- Prix de lancement : la page /pro l'affiche (sans prix barré) si `?early=1`, si `earlyDiscountId` existe et si `LICENSE_LAUNCHED_AT` + `earlyDays` n'est pas passé, avec la ligne « Prix de lancement pour les premiers utilisateurs, jusqu'au {date}. Ensuite, Flitdrop Pro coûte {price}. » Sans `LICENSE_LAUNCHED_AT`, aucun prix de lancement n'est annoncé.
- `storeEnabled` : `true` seulement si `STORE_ENABLED` vaut exactement `1` (par défaut `false`, indépendant du mode payant). L'app laisse les installations Microsoft Store gratuites et sans limite tant que la fiche du Store ne déclare pas l'achat intégré.

## Règles de sécurité

- **Jamais de licence sur un doute.** Toute réponse inattendue de Paddle (réseau, 4xx, 5xx, 429, forme bizarre, liste tronquée là où il fallait tout voir) ou de la base donne un 503 rapide (9 s au plus, 4 s par appel, un seul nouvel essai sur une panne passagère). L'app garde son état et réessaie.
- **Jamais de retrait sur un doute.** `renew` ne répond `403 revoked` que sur une preuve positive (remboursement approuvé ou rétrofacturation non annulée sur tous les achats Pro du client, appareil sorti, jeton faux ou d'un autre environnement). Client ou appareil absents de la base, aucun achat trouvé (prix changé par erreur, par exemple) ou panne : `503`.
- **Remboursement et rétrofacturation** : un achat ne compte plus dès qu'un remboursement **approuvé** couvre l'article Pro ou tout le montant, ou dès qu'une rétrofacturation (`chargeback`) n'a pas été annulée par Paddle. Un remboursement en attente d'approbation ne retire rien encore.
- **Statut** : seul `completed` débloque (`paid` n'est pas encore l'état final chez Paddle) ; checkout-done note `paid` ou `completed`, claim attend `completed`.
- **Code de restauration** : 12 caractères en base32 de Crockford (sans I, L, O ni U), affiché `XXXX-XXXX-XXXX` (60 bits). Saisie : casse, tirets et espaces ignorés, O lu comme 0, I et L lus comme 1. Défi sans état : `base64url({ v: 2, x: expiration, n: nonce }) + "." + base64url(tag)`, où `tag` = HMAC de l'en-tête (adresse, expiration, nonce) puis HMAC du code (adresse, empreinte du code, expiration, nonce), clé dérivée (HKDF) de `LICENSE_SIGNING_KEY`. Le serveur vérifie d'abord qu'il a émis ce défi pour cette adresse, puis compte l'essai sur son nonce (5 par défi, dans D1 : inventer des nonces ne donne rien), puis compare le code à temps constant. Usage unique partout : le nonce est pris dans `used_challenges` avant de délivrer (et rendu si Paddle ou la base tombent juste après).
- **Aucune fuite** : `restore/start` répond la même chose, tout de suite, achat ou pas. Les journaux ne contiennent que le type d'erreur : jamais de clé, d'adresse e-mail, de secret ni de jeton. La clé d'API n'est envoyée qu'à l'hôte Paddle configuré (un lien de pagination vers un autre hôte est refusé).
- **Appels Paddle bornés** : 16 au plus par requête quoi qu'il arrive (pages comprises, sinon 503), et en pratique : config 0 (ou 2 par pays toutes les 6 h), checkout-done 1, claim 2 (balayage de secours : 12 au plus), renew 2 à 4, restore 10 au plus, withdraw 0. Après un 429 de Paddle, plus aucun appel pendant la durée annoncée. Des requêtes anonymes ne peuvent pas faire marteler Paddle : budgets partagés par minute pour tout le site (10 balayages de secours, 30 lectures checkout-done, 20 recherches de restauration, 20 aperçus de prix) et cache négatif de 4 s par claim.

### Limites

En mémoire de l'isolat (premier filtre, remis à zéro au redémarrage) :

| Point d'entrée | Limites |
|---|---|
| claim | 40 par minute et par IP, 20 par minute et par claim |
| checkout-done | 10 par minute et par IP, 6 par minute et par claim |
| restore/start | 10 par 15 min et par IP, 3 par 15 min et par adresse |
| restore/verify | 20 par 15 min et par IP, 10 par 15 min et par adresse |
| renew | 60 par heure et par IP, 10 par heure et par appareil |
| withdraw | 5 par heure et par IP |

Dans la base D1 (partagées par tous les serveurs ; silencieuses quand la réponse doit rester la même) :

| Quoi | Plafond |
|---|---|
| Codes de restauration par adresse | 5 par heure, 10 par jour (au-delà : même réponse, pas d'e-mail) |
| Essais par défi de restauration | 5 |
| Appareils | 5 actifs par client, 10 nouvelles inscriptions par 30 jours, 5 par claim |
| Accusés de rétractation par adresse | 2 par jour (la rétractation reste notée et nous parvient) |
| E-mails de restauration | 50 par jour pour tout le site |
| Rétractations avec e-mails | 10 par jour pour tout le site (20 e-mails : accusé et copie) ; 200 notées par jour |

**Quota Resend** : l'offre gratuite donne 100 e-mails par jour, partagés avec le formulaire de contact du site. Restauration (50) et rétractation (20) en laissent toujours au moins 30 au formulaire de contact.

## Rétractation (fonction légale)

La directive 2023/2673 (en France, art. L221-21 et D221-5 du Code de la consommation, en vigueur depuis le 19 juin 2026 ; en Allemagne, § 356a BGB) impose une fonction de rétractation en ligne et un accusé de réception sans délai sur un support durable.

- Page `/refund` (et `/fr/refund`, `/de/refund`) : en tête, le bouton « Renoncer au contrat ici » ouvre en place le formulaire `#withdraw` (l'adresse `/refund#withdraw` l'ouvre directement ; la page /pro y renvoie). Trois champs exactement : nom et prénom, adresse e-mail de l'achat, numéro de commande ou date d'achat. **Aucun motif demandé** (la loi allemande l'interdit). Dessous : « Ou renoncer chez Paddle (paddle.net) » et l'e-mail.
- `POST /api/withdraw` répond toujours `200` pour une demande bien formée. Après la réponse : la rétractation est notée dans D1 (`withdrawals`, avec la date et l'heure de réception), un accusé part vers l'adresse **tapée** (les trois champs, « reçue le ... à ... (heure de Paris) », remboursement par Paddle sous 14 jours), et une copie vers notre boîte (la même que le formulaire de contact ; `contact@flitdrop.com` ne reçoit pas encore de courrier, rien n'y est envoyé).
- **Aucun remboursement automatique** : la clé Paddle est en lecture seule. Rembourser à la main dans Paddle (Transactions, la commande, Refund), sous 14 jours. Les rétractations sont aussi lisibles dans la base : `npx wrangler d1 execute flitdrop-licences --remote --command "SELECT * FROM withdrawals ORDER BY received_at DESC LIMIT 20"`.
- Marche même mode payant coupé (un achat passé se rétracte toujours) : il faut seulement la base D1 et `RESEND_API_KEY`. Sans l'une ou l'autre : `503`, et la page propose Paddle et l'e-mail.

## Variables et liaisons dans Cloudflare Pages

Tableau de bord Cloudflare, Workers & Pages, projet `flitdrop`, Settings. Les valeurs ne s'appliquent **qu'au déploiement suivant** : après tout changement, relancer un déploiement (Deployments, « Retry deployment », ou un push).

**Liaison D1** (Settings, Bindings, D1 database) : nom de variable `LICENSE_DB`, base `flitdrop-licences` en **Production**, base `flitdrop-licences-sandbox` en **Preview** (les deux en juridiction UE, déjà créées). Rien d'autre à faire : les tables se créent à la première requête.

**Preview** (sandbox) : seulement

| Nom | Type | Valeur |
|---|---|---|
| `LICENSE_ENABLED` | texte | `1` |
| `PADDLE_ENV` | texte | `sandbox` |
| `PADDLE_API_KEY` | **secret** | clé d'API du compte sandbox (`pdl_sdbx_...`) |
| `LICENSE_SIGNING_KEY` | **secret** | la clé **sandbox** (jamais celle de production) |
| `RESEND_API_KEY` | **secret**, facultatif | sans lui, la restauration répond mais n'envoie aucun code, et la rétractation répond 503 |

Le jeton client, le prix et la remise sandbox sont des valeurs **publiques** inscrites dans le code par défaut (`test_ecf2165ca0f01949c2dfe708311`, `pri_01m4gfwxvbg1jjgbp7rbxns9wa`, `dsc_01m4gfz5p1h0p8rghvn1z36jjg`) ; `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_ID`, `PADDLE_EARLY_DISCOUNT_ID` les remplacent si on les pose. `LICENSE_LAUNCHED_AT` est utile pour tester le prix de lancement.

**Production** : aucune valeur par défaut, tout vient des variables.

| Nom | Type | Rôle |
|---|---|---|
| `LICENSE_ENABLED` | texte | `1` pour allumer le mode payant ; toute autre valeur ou absence = coupé |
| `PADDLE_ENV` | texte | `production` |
| `PADDLE_API_KEY` | **secret** | clé d'API live (`pdl_live_...`, droits ci-dessous) |
| `PADDLE_CLIENT_TOKEN` | texte | jeton côté client live (`live_...`, public par nature) |
| `PADDLE_PRICE_ID` | texte | id du prix Flitdrop Pro (`pri_...`) |
| `PADDLE_EARLY_DISCOUNT_ID` | texte, facultatif | id de la remise de lancement (`dsc_...`) |
| `LICENSE_SIGNING_KEY` | **secret** | la clé de **production** (celle dont l'app publiée embarque la clé publique) |
| `LICENSE_LAUNCHED_AT` | texte, facultatif | date du lancement (ISO, par exemple `2026-10-20`) ; requise pour annoncer le prix de lancement |
| `RESEND_API_KEY` | **secret** | requis en production (déjà en place pour le formulaire de contact) |
| `STORE_ENABLED` | texte, facultatif | `1` quand la fiche Microsoft Store déclare l'achat intégré ; sinon l'app du Store reste gratuite et sans limite |

Le serveur coupe aussi le mode payant si une clé ou un jeton est visiblement de l'autre environnement (clé `pdl_sdbx_...` ou jeton `test_...` avec `PADDLE_ENV=production`, et l'inverse), si la clé de signature n'est pas une clé Ed25519 valide, si la base D1 n'est pas liée, ou si l'environnement est servi sur le mauvais hôte.

## Clés de signature : une par environnement

Une seule fois, sur le Mac, hors du dépôt :

```
node tools/license-keygen.mjs ~/flitdrop-licence-production.txt
node tools/license-keygen.mjs ~/flitdrop-licence-sandbox.txt
```

Chaque commande écrit une clé **privée** dans son fichier (lisible par toi seul, jamais écrasé) et affiche **uniquement** la clé **publique** (44 caractères base64). Le fichier de production va dans le secret `LICENSE_SIGNING_KEY` de **Production**, et sa clé publique est celle que l'app publiée embarque. Le fichier sandbox va dans `LICENSE_SIGNING_KEY` de **Preview** ; sa clé publique ne sert qu'aux versions de test de l'app. Ranger ensuite les deux fichiers dans le gestionnaire de mots de passe et les supprimer du disque. Réafficher une clé publique : `node tools/license-keygen.mjs --public <fichier>`.

Ne jamais mettre la même clé dans les deux environnements. Ne jamais changer la clé de production sans raison grave (fuite) : tous les jetons existants deviendraient invalides et l'app devrait embarquer la nouvelle clé publique. En cas de fuite : nouvelle paire, nouvelle version de l'app avec la nouvelle clé publique, puis nouveau secret ; les acheteurs repassent par « J'ai déjà acheté ».

## Créer le produit dans Paddle

À faire d'abord dans le compte **sandbox** (sandbox-vendors.paddle.com), puis à refaire à l'identique dans le compte **live** (vendors.paddle.com) : les deux comptes ne partagent rien.

1. **Catalog, Products, New product** : nom « Flitdrop Pro », catégorie fiscale des logiciels téléchargeables (« Standard digital goods »), description courte.
2. Dans ce produit, **New price** : paiement unique (« one-time »), 5,99 EUR. Prix par pays si voulu (« Override price for specific countries ») : par exemple 5,99 USD, 5,49 GBP. Quantité 1 (minimum 1, maximum 1). Copier l'id `pri_...` dans `PADDLE_PRICE_ID`.
3. **Remise de lancement** (facultatif) : Catalog, Discounts, New discount : 50 %, limitée à ce prix, expiration 30 jours après le lancement, sans code public. Copier l'id `dsc_...` dans `PADDLE_EARLY_DISCOUNT_ID`.
4. **Developer tools, Authentication** :
   - nouvelle clé d'API **en lecture seule** : `transaction.read`, `customer.read`, `adjustment.read`, et les droits de lecture que Paddle demande pour l'aperçu de prix (`POST /pricing-preview`, en général lecture des prix et des produits). Plus besoin d'écrire chez le client : les appareils vivent dans D1. La copier dans `PADDLE_API_KEY` (secret).
   - nouveau jeton côté client (« client-side token ») : dans `PADDLE_CLIENT_TOKEN` (en sandbox, celui du code par défaut suffit).
5. **Checkout, Checkout settings** : lien de paiement par défaut `https://flitdrop.com/pro`. En live, faire approuver le domaine `flitdrop.com` par Paddle (vérification du site : pages Conditions, Remboursement et Tarifs en ligne).

## Ce que fait l'app

- **Réponses du serveur** : seul `403 { error: "revoked" }` au renouvellement retire un jeton. Hors ligne, `429`, `5xx` (dont `503`), réponse illisible : rien ne change, l'app réessaie plus tard. `403 too_many_devices` (achat ou restauration) : une carte calme avec l'adresse contact@flitdrop.com, le plan ne change pas, plus de vérification automatique.
- **État signé et deuxième emplacement** (voir l'en-tête de `packages/core/src/license.ts`) : remettre une ancienne copie de `config.json` ne fait ni redescendre le compteur du jour ni revenir un essai fini ; reculer l'horloge ne donne jamais un deuxième jour neuf ; l'essai finit quand l'heure la plus tardive vue (horloge du PC ou en-tête `Date` de la config de flitdrop.com) dépasse sa fin.
- **Microsoft Store** : une installation du Store (canal gardé dans la config) reste en mode payant coupé, comme avant, tant que la config ne dit pas `storeEnabled: true` (absent = coupé).
- **Installations d'avant Flitdrop Pro** : config d'une version < 0.7.0 au premier lancement de la version payante, noté une fois dans l'état signé (`legacy`). Après l'essai, la synchro automatique et tout l'historique du presse-papiers restent gratuits ; seules la limite du jour et les dossiers par mois s'appliquent. Une carte d'accueil explique l'essai, une fois.
- **Prix affichés** : `price: { currency, display, displayEarly }` de la config (prix du pays de la personne) d'abord, puis `displayPrice` / `displayPriceEarly`, puis la moitié du prix affiché seulement si le serveur ne donne aucun prix de lancement.
- **Identifiant de la machine illisible un lancement** (commande lente au démarrage) : l'identité déjà gardée sert pour la session, Pro et les 30 fichiers restent, nouvelle lecture après 5 s, 30 s, 2 min puis toutes les 10 minutes. Relu différent : traité comme une config copiée sur un autre PC.
- **Identifiant illisible dès le premier lancement** : une identité de secours aléatoire sert (`licenseFallbackId`), et l'état signé note l'empreinte de la session qui l'a créée (`fallbackHost` : système, compte, dossier personnel, processeur). Au premier lancement où l'identifiant de la machine se lit, sur cette même session, l'état passe à l'identifiant de la machine sans rien perdre : dates de l'essai, compteur du jour, `legacy`, deuxième emplacement récrit. Un jeton Pro obtenu sous l'identité de secours est gardé : cette identité reste celle de la licence sur cette machine (c'est sous ce nom que le serveur l'a enregistrée, renouvellements compris), et l'état signé note l'empreinte de la machine (`machineDev`), si bien que la config copiée ailleurs ne vaut rien. Session différente, ou état sans `fallbackHost` : traité comme une config copiée sur un autre PC. Deuxième emplacement illisible à ce lancement-là : le passage attend le lancement suivant, rien ne se ferme. Limite connue : une config de secours copiée sur un autre PC de session identique (même système, même compte, même dossier personnel, même processeur) n'est pas distinguable.

## Tester en sandbox

Attention : l'app publiée lit la config de `https://flitdrop.com`. Allumer `LICENSE_ENABLED=1` en **production** fait passer toutes les installations en mode payant (essai de 14 jours compris). Pour tester sans toucher aux utilisateurs, tout se fait sur une adresse de **preview** (la sandbox n'y répond que là).

1. Preview : poser les variables du tableau Preview, vérifier la liaison D1 `flitdrop-licences-sandbox`, pousser une branche.
2. `curl https://<preview>.flitdrop.pages.dev/api/license/config` : `enabled: true`, `env: "sandbox"`, `storeEnabled: false`, et un `price` ; depuis un VPN d'un autre pays (Royaume-Uni, États-Unis), `price.currency` change. Si `price` reste le prix fixe partout, la clé d'API n'a pas le droit d'aperçu de prix (le journal Cloudflare dit `license price: preview failed`).
3. Garde-fou : la même config servie sur `flitdrop.com` avec `PADDLE_ENV=sandbox` doit répondre `enabled: false` (vérifiable en local avec `localhost` contre un hôte de production dans les tests automatiques).
4. Tirer un secret (`openssl rand -hex 32`), calculer le claim : `printf 'flitdrop-claim-v1:%s' <secret> | shasum -a 256 | cut -c1-32`. Ouvrir `https://<preview>.flitdrop.pages.dev/pro?claim=<claim>&lang=fr&early=1` : l'adresse perd aussitôt `?claim=` (le vérifier dans la barre d'adresse et dans les requêtes PostHog), aucune requête vers Paddle avant le clic. Payer avec la carte de test Paddle `4242 4242 4242 4242`, date future, CVC `100`.
5. Après le paiement : la page appelle `checkout-done` ; `npx wrangler d1 execute flitdrop-licences-sandbox --remote --command "SELECT * FROM purchases"` montre la ligne. Puis `curl -X POST https://<preview>.flitdrop.pages.dev/api/license/claim -H 'content-type: application/json' -d '{"secret":"<secret>","device":"<32 hex>"}'` : `202` tant que Paddle n'a pas fini, puis `200 { token }` dont le contenu dit `"env":"sandbox"`.
6. Six appareils différents sur le même secret : le 6e reçoit `403 claim_used`. Restauration : `restore/start` avec l'adresse du paiement (réponse immédiate), code reçu par e-mail, `restore/verify` ; le même code une 2e fois : `expired`.
7. Rétractation : `https://<preview>.flitdrop.pages.dev/refund#withdraw` (et `/fr/refund#withdraw`, `/de/refund#withdraw`) : le formulaire s'ouvre, l'envoi affiche la confirmation, l'accusé arrive à l'adresse tapée avec l'heure de Paris, la copie arrive dans notre boîte, la ligne est dans `withdrawals`.
8. Remboursement : dans Paddle, Transactions, la transaction, « Refund » total. En sandbox, Paddle approuve les remboursements toutes les dix minutes ; ensuite `renew` répond `403 revoked` et `claim` répond `202`.
9. Tests automatiques (Paddle et Resend simulés, D1 sur `node:sqlite`) : `node --test tools/license-tests/*.test.mjs`.

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
2. Variables de **production** (tableau ci-dessus), liaison D1 `flitdrop-licences`, `LICENSE_SIGNING_KEY` de production, `LICENSE_LAUNCHED_AT`, et en tout dernier `LICENSE_ENABLED=1`.
3. Redéployer, puis vérifier `curl https://flitdrop.com/api/license/config` : `enabled: true`, `env: "production"`.
4. Couper en urgence : `LICENSE_ENABLED=0`, redéployer. La config répond `enabled: false` au plus une minute après le déploiement ; les achats restent chez Paddle (et les appareils dans D1) et se retrouvent au rallumage.

## Outils et tests

- `tools/license-keygen.mjs` : génère une paire de clés (une par environnement, voir plus haut).
- `tools/license-tests/` : `node --test tools/license-tests/*.test.mjs`
  - `fake-paddle.mjs` : faux Paddle Billing (transactions, clients, ajustements, aperçu de prix) et faux Resend, à la place de `fetch` ;
  - `d1-shim.mjs` : fausse base D1 sur `node:sqlite` (mêmes appels que D1, lots en transaction, `meta.changes`), avec un délai aléatoire par appel pour reproduire les courses entre requêtes simultanées ;
  - `harness.mjs` : clés de test (une par environnement), environnements, appel direct des Pages Functions ;
  - `license.test.mjs` (fonctionnement), `security.test.mjs` (les attaques de la revue rejouées et refusées, concurrence, bornes d'appels Paddle), `withdraw.test.mjs` (rétractation), `site.test.mjs` (adresse nettoyée avant la mesure, Paddle seulement au clic, page /refund), `keygen.test.mjs`.

## Limites connues

- **Premières limites en mémoire de l'isolat** : elles freinent un seul client, pas une attaque répartie ; les plafonds qui comptent vraiment (appareils, codes, adresses, budgets) sont dans D1 et valent pour tous les serveurs.
- **Balayage de secours** (page /pro fermée avant la fin du paiement, donc pas de checkout-done) : transactions terminées des 48 dernières heures, 10 pages de 30. Au-delà de 300 ventes en 48 h, un achat très ancien dans la fenêtre peut rester « en attente » : l'acheteur passe alors par « J'ai déjà acheté ». Jamais de faux échec, jamais de licence par erreur.
- **Base D1 perdue ou vidée** : aucun retrait ; `renew` répond 503 (client inconnu), l'app garde son jeton jusqu'à son expiration, puis l'acheteur restaure par e-mail, ce qui réinscrit l'appareil.
- **Points de l'API Paddle à vérifier en sandbox** (le code reste prudent dans chaque cas) : droits exacts de l'aperçu de prix, écriture des montants des autres devises, si le filtre `email` tient compte de la casse (on essaie aussi la recherche, puis on compare sans casse), l'encodage des crochets de `created_at[GTE]`, et le statut exact d'une rétrofacturation (tout statut autre que `reversed` ou `rejected` retire la licence).
- **`contact@flitdrop.com` ne reçoit pas encore de courrier** : aucun e-mail du serveur ne demande d'y répondre ; la page /refund garde son lien `mailto` comme troisième choix, à revoir quand la boîte sera en place.
