# Télémétrie de l'app et déploiement Cloudflare

But : savoir enfin si les gens qui installent Flitdrop s'en servent (activation), et repérer les pannes réelles pour corriger en priorité ce qui casse le plus. **Aucun contenu n'est jamais envoyé** : ni fichier, ni nom de fichier, ni presse-papiers, ni nom d'appareil, ni chemin contenant un nom d'utilisateur, ni adresse IP. Les tailles sont des tranches (« 1-10MB »), pas des octets.

## Le circuit

```
App 0.6.4 et plus (partie Node : serveur core ou processus principal Electron)
  → POST https://flitdrop.com/api/telemetry  (un évènement par requête, JSON)
  → Pages Function functions/api/telemetry.js, déployée avec le site à chaque push sur main
      (elle importe telemetry-worker/worker.js : un seul code pour les deux entrées)
      1. valide et nettoie (listes blanches, tailles bornées)
      2. Analytics Engine, dataset flitdrop_events (seulement si la liaison existe ; aucune aujourd'hui)
      3. PostHog, projet « Flitdrop » sur le cloud EU (id 282507)

Versions 0.5 à 0.6.3 : POST https://telemetry.flitdrop.com/e → Worker flitdrop-telemetry
  (déployé à la main dans le tableau de bord ; il porte encore le code de juillet,
  qui relaie vers l'ancien projet PostHog US tant qu'on ne le redéploie pas)
```

Pourquoi une Pages Function : le Worker ne se déploie que dans le tableau de bord Cloudflare (ou avec wrangler connecté au compte), alors que la fonction part avec le site à chaque push. Aucune manipulation à la main.

Le navigateur du téléphone n'envoie jamais rien directement : tout part du PC. Le Worker appelle PostHog lui-même, donc l'IP de l'utilisateur ne quitte jamais Cloudflare. Il ajoute seulement le pays (`request.cf.country`, par exemple `FR`), et demande à PostHog de ne pas géolocaliser le Worker (`$ip` nul, `$geoip_disable`).

## Deux niveaux

| Niveau | Quand | Identifiant | Dans PostHog |
|---|---|---|---|
| `basic` | Par défaut, désactivable dans les Réglages (section Aide et confidentialité) | Aucun : ni iid, ni hash, ni nom d'appareil | `distinct_id` aléatoire neuf à chaque évènement, `$process_person_profile: false` (pas de profil). L'ancienneté n'y figure qu'en tranches (mois d'installation, 0 / 1-7 / 8-30 / 31+ jours) : la date exacte d'installation ne peut pas servir de clé entre deux évènements |
| `full` | Seulement après accord explicite (`telemetryConsent === true` dans la config) | `iid`, un aléatoire local non relié à une personne | `distinct_id` = hash FNV-1a stable de l'iid (même calcul qu'avant), profils autorisés. L'iid est maintenant tiré par l'app dans sa config : une installation qui avait accepté avec une version 0.5 à 0.6.3 reçoit un nouvel iid à la mise à jour, et son ancien historique reste dans l'ancien projet PostHog (US), sans lien avec le nouveau |

Si les statistiques de base sont coupées **et** qu'il n'y a pas d'accord complet, l'app n'envoie rien du tout.

Rien ne part non plus, même en `basic`, tant que l'app n'a pas affiché au moins une fois (fenêtre visible) le texte qui annonce ces statistiques : la question de l'écran d'accueil ou la carte en haut de la fenêtre. La page le signale au serveur local (`POST /api/admin/telemetry/notice`, drapeau `basicNoticeShown` dans la config), et c'est seulement à ce moment que partent `app_first_launch` ou `app_updated` et le premier `app_daily_active`. Une réponse à la question, ou un réglage dans la section Aide et confidentialité, vaut aussi annonce vue. C'est ce qui protège les installations mises à jour depuis une version où l'app promettait « décoché par défaut » : elles n'envoient rien avant d'avoir été prévenues. Une app lancée cachée à l'ouverture de session attend donc que sa fenêtre soit ouverte.

Le niveau `basic` suffit à mesurer l'activation de façon agrégée (installations → premier appairage → premier transfert → retour les jours suivants, par mois d'installation). Le niveau `full` permet en plus de suivre le parcours d'une même installation et de recevoir les erreurs détaillées.

## Enveloppe

```json
{ "event": "transfer_ok", "v": "0.7.0", "ts": 1790000000000, "tier": "basic",
  "props": { "os": "win", "arch": "x64", "channel": "nsis", "locale": "fr",
             "install_week": "2026-09", "days_since_install": 1,
             "direction": "phone_to_pc", "kind": "photo", "size": "1-10MB", "first": true } }
```

- `event` : nom de l'évènement (liste ci-dessous), 40 caractères au plus.
- `v` : version de l'app, 16 caractères au plus.
- `ts` : horodatage en millisecondes (remplacé par l'heure du Worker s'il est absurde, plus de 10 min dans le futur).
- `tier` : `basic` ou `full` ; toute autre valeur est ignorée.
- `iid` : présent **seulement** en `full` ; en `basic` le Worker l'ignore même s'il arrive.
- `props` : objet plat (texte, nombre ou booléen).

Le Worker ne garde que les évènements et les propriétés prévus. Les textes sont coupés à 40 caractères (300 pour un message d'erreur, 4000 pour une pile), les nombres doivent être finis, les booléens sont gardés tels quels, tout le reste est jeté. Corps de plus de 16 Ko refusé (413). Réponse 204 immédiate ; l'envoi à PostHog se fait ensuite (`ctx.waitUntil`).

Sur chaque évènement, PostHog reçoit aussi : `source: "desktop-app"`, `app_version`, `tier`, `country` (si connu), `$lib: "flitdrop-telemetry-worker"`.

## Propriétés communes (tous les évènements, deux niveaux)

| Propriété | Valeurs |
|---|---|
| `os` | `win`, `mac`, `linux` |
| `arch` | `x64`, `arm64`... |
| `channel` | `nsis`, `store`, `dmg`, `appimage`, `deb`, `dev`. `store` : installation venue du Microsoft Store, repérée par le marqueur `store-install` que l'installeur pose quand le Store le lance avec `/store` (ou quand son nom contient « store ») ; gardé dans la config après une mise à jour automatique |
| `locale` | langue de l'interface : `en`, `fr`, `de` |
| `install_week` | en `full` : semaine ISO du premier lancement, par exemple `2026-W39` ; en `basic` : seulement le mois, par exemple `2026-09` |
| `days_since_install` | en `full` : entier >= 0 ; en `basic` : tranche notée par sa borne basse, `0` (jour même), `1` (1 à 7 jours), `8` (8 à 30), `31` (31 et plus) |

## Évènements du niveau `basic` (acceptés aussi en `full`)

| Évènement | Propriétés | Sens |
|---|---|---|
| `app_first_launch` | aucune | Premier lancement d'une version qui sait compter (une seule fois par installation) |
| `app_updated` | `from_version` | Mise à jour ; remplace `app_first_launch` pour une installation plus ancienne |
| `app_daily_active` | `paired_devices` (0, 1 ou 2, 2 voulant dire deux ou plus), `launches_today` (facultatif) | Au plus une fois par jour calendaire local |
| `phone_page_opened` | `first` (première ouverture sur cette installation), `platform` (`ios`, `android`, `other`, d'après l'en-tête User-Agent, qui n'est jamais envoyé) | Un téléphone vient de charger la page Flitdrop servie par le PC (QR scanné), avant tout appairage : compté seulement quand un QR d'appairage attend d'être scanné, jamais quand un téléphone déjà appairé rouvre son icône ou recharge la page. Compté par le serveur du PC, jamais par le téléphone ; la page seule, pas ses fichiers ; pas depuis le PC lui-même (127.0.0.1). Au plus une fois par tranche de 10 minutes pour un même téléphone : ce dédoublonnage se fait en mémoire (adresse du téléphone et type), jamais écrit sur le disque, jamais envoyé. `first` s'appuie sur le drapeau `firstPhonePageDone` de la config ; une installation qui avait déjà appairé ou transféré le reçoit à vrai lors de la mise à jour |
| `pairing_success` | `platform` (`ios`, `android`, `other`), `first` (premier appairage de cette installation) | Un téléphone vient d'être appairé |
| `transfer_ok` | `direction` (`phone_to_pc`, `pc_to_phone`), `kind` (`file`, `photo`, `text`, `clipboard`), `size` (`<1MB`, `1-10MB`, `10-100MB`, `100MB-1GB`, `>1GB`, absent pour le texte et le presse-papiers), `first` (premier transfert réussi de cette installation) | Transfert réussi. Fichier du PC vers le téléphone : compté seulement quand le téléphone confirme l'avoir reçu entier et déchiffré ; un échec signalé ensuite par le téléphone remplace la réussite |
| `transfer_fail` | `direction`, `kind`, `status` (nombre), `reason` (code court) | Transfert échoué |
| `worker_deploy_test` | aucune | Contrôle après un déploiement (voir plus bas) |

`reason` doit être un code ou une catégorie (`ENOSPC`, `timeout`...), jamais un message. Par sécurité, le Worker remplace par `other` toute raison qui ressemble à un chemin, une adresse, une IP ou un e-mail.

## Évènements réservés au niveau `full`

| Évènement | Propriétés |
|---|---|
| `welcome_shown`, `welcome_pair_clicked`, `welcome_skipped` | aucune |
| `pair_qr_shown`, `pair_link_copied` | aucune |
| `phone_connect` | `platform` (`ios`, `android`, `other`) |
| `settings_changed` | `key` (nom du réglage, jamais sa valeur) |
| `history_opened` | aucune |
| `telemetry_choice` | `choice` (`full`, `basic_only`, `none`), `where` (`welcome`, `prompt`, `settings`) |
| `$exception` | `$exception_type`, `$exception_message` (300 car.), `$exception_stack_trace_raw` (4000 car.), `source` (`main`, `server`, `desktop`, `phone`), `handled` (booléen) |

Envoyés en `basic`, ces évènements sont ignorés.

Pour `$exception`, le client retire déjà le dossier personnel (remplacé par `~`) et les chaines de requête ; le Worker refait ce nettoyage (dossiers `C:\Users\...`, `/Users/...`, `/home/...`, chaines de requête, e-mails, adresses IP). Dans PostHog, l'endroit où l'erreur est née arrive dans `error_source` (car `source` vaut toujours `desktop-app`), et le Worker ajoute `$exception_list` et `$exception_level` pour que l'onglet Error tracking les regroupe. La pile nettoyée y est aussi découpée en frames (`stacktrace.frames`, 50 au plus, la plus ancienne en premier, format V8 `at fn (fichier:12:3)` ou Safari/Firefox `fn@fichier:12:3`) : sans elles, PostHog n'affiche aucune pile et ne regroupe que par type et message.

## Anciennes versions (0.5 à 0.6.3)

Elles envoyaient, **seulement si l'utilisateur avait coché la case**, `{ iid, v, event, props, ts }` sans `tier`, depuis l'interface (et depuis le téléphone pour les transferts). Le Worker les accepte toujours, traitées en `full` avec `legacy: true` :

| Évènement | Propriétés gardées |
|---|---|
| `app_open` | `os` |
| `phone_connect` | `platform` (`iphone`/`ipad` → `ios`, `android`, sinon `other`) |
| `transfer_ok` | `size`, `resumes`, plus `direction: phone_to_pc` et `kind: file` |
| `transfer_fail` | `status`, `reason` (nettoyée), plus `direction: phone_to_pc` et `kind: file` |

Le `distinct_id` est calculé comme avant (hash de l'iid), mais ces évènements arrivent maintenant dans le projet EU, alors que l'historique de ces installations est resté dans l'ancien projet US : pas de continuité entre les deux.

## Déployer

Le collecteur des versions 0.6.4 et plus se déploie tout seul : push sur main (site + `functions/`).

Contrôle après déploiement :

```bash
curl -i -X POST https://flitdrop.com/api/telemetry \
  -H 'content-type: application/json' \
  -d '{"event":"app_daily_active","v":"test","ts":0,"tier":"basic","props":{"os":"mac","channel":"dev"}}'
```

Le Worker `telemetry.flitdrop.com` (anciennes versions), si on veut un jour le mettre à jour, par le tableau de bord Cloudflare :

1. **Workers & Pages** → **flitdrop-telemetry** → **Edit code**.
2. Remplacer tout le contenu par celui de `telemetry-worker/worker.js`, puis **Deploy**.
3. Vérifier que le domaine personnalisé `telemetry.flitdrop.com` est bien attaché (onglet **Settings** → **Domains & Routes**) et, si on veut le SQL, la liaison Analytics Engine `FLITDROP_TELEMETRY` → dataset `flitdrop_events` (onglet **Settings** → **Bindings**). Sans cette liaison, le Worker relaie quand même vers PostHog.

Ou en ligne de commande : `npx wrangler deploy` depuis `telemetry-worker/` (utilise `wrangler.toml`).

Contrôle après déploiement :

```bash
curl -i -X POST https://telemetry.flitdrop.com/e \
  -H 'content-type: application/json' \
  -d '{"event":"worker_deploy_test","v":"test","ts":0,"tier":"basic","props":{"os":"mac"}}'
```

Réponse attendue : `204`. L'évènement `worker_deploy_test` apparaît ensuite dans PostHog (projet Flitdrop, EU) sous **Activity**.

Tests locaux du Worker (aucune dépendance) :

```bash
node --check telemetry-worker/worker.js
node --test telemetry-worker/worker.test.mjs
```

## Lire les données

**PostHog** (https://eu.posthog.com, projet Flitdrop) : entonnoir d'activation `app_first_launch` → `phone_page_opened` (`first = true`) → `pairing_success` (`first = true`) → `transfer_ok` (`first = true`) ; l'écart entre les deux premières marches mesure les installations dont aucun téléphone n'arrive jusqu'à la page (QR illisible, mauvaise adresse, pare-feu, wifi invité), découpé par `install_week`, `os` ou `channel` ; rétention avec `app_daily_active` ; onglet Error tracking pour `$exception`. En `basic` il n'y a pas de personne : on lit des volumes et des taux (par exemple nombre de premiers transferts rapporté au nombre de premiers lancements du même mois), pas des parcours individuels.

**Analytics Engine** (SQL via l'API Cloudflare). Colonnes : `blob1` évènement, `blob2` os, `blob3` version, `blob4` status, `blob5` reason, `blob6` size, `blob7` pays, `blob8` niveau, `blob9` direction, `blob10` kind, `blob11` channel, `blob12` locale, `blob13` semaine d'installation, `double2` jours depuis l'installation (-1 si inconnu). Les sept premières gardent l'ordre historique.

```sql
SELECT blob1 AS event, blob2 AS os, blob4 AS status, blob5 AS reason, count() AS n
FROM flitdrop_events
WHERE timestamp > now() - INTERVAL '7' DAY
GROUP BY event, os, status, reason
ORDER BY n DESC
```

## Coût

Cloudflare Workers et Analytics Engine ont un palier gratuit largement suffisant (10 M d'écritures par mois incluses). PostHog EU : le palier gratuit couvre 1 M d'évènements par mois.

## Retours utilisateurs

Indépendamment de la télémétrie, les boutons **« Signaler un problème »** et **« Proposer une idée »** (Réglages → Aide et confidentialité) ouvrent un ticket prérempli sur le dépôt GitHub. C'est le canal pour les retours détaillés ; la télémétrie, elle, sert aux statistiques agrégées.
