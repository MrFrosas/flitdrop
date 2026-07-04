# Télémétrie anonyme (opt-in) et déploiement Cloudflare

Flitdrop peut remonter, **seulement si l'utilisateur coche la case** (décochée par défaut, dans Réglages → Aide et confidentialité), des évènements **anonymes** : ouverture de l'app, transfert réussi ou échoué avec le type d'erreur, plateforme, version. **Aucun contenu de fichier ni de presse-papiers n'est jamais envoyé.** Les tailles sont des tranches (« 1-10MB »), pas des octets. L'identifiant d'installation est un aléatoire local, non relié à une personne.

But : détecter les pannes réelles chez les utilisateurs pour améliorer le logiciel.

## Ce qu'il faut faire (une seule fois)

Prérequis : un compte Cloudflare (gratuit), et le domaine `flitdrop.app` ajouté à Cloudflare (ce que tu prévois d'acheter).

1. **Installe l'outil** : `npm install -g wrangler` puis `wrangler login`.
2. **Déploie le Worker** :
   ```bash
   cd telemetry-worker
   wrangler deploy
   ```
   Cela crée le dataset Analytics Engine `flitdrop_events` et publie le Worker.
3. **Branche le sous-domaine** : dans le tableau de bord Cloudflare, une fois `flitdrop.app` ajouté, décommente le bloc `[[routes]]` de `wrangler.toml` (pattern `telemetry.flitdrop.app/e`, `custom_domain = true`) et refais `wrangler deploy`. Le client Flitdrop envoie déjà vers `https://telemetry.flitdrop.app/e` (constante `ENDPOINT` dans `packages/core/src/webclient/telemetry.ts`) ; tant que ce n'est pas déployé, les envois échouent en silence, sans gêner personne.

## Lire les données

Dans le tableau de bord Cloudflare → Workers & Pages → Analytics Engine, ou en SQL via l'API :

```sql
SELECT blob1 AS event, blob2 AS os, blob4 AS status, blob5 AS reason, count() AS n
FROM flitdrop_events
WHERE timestamp > now() - INTERVAL '7' DAY
GROUP BY event, os, status, reason
ORDER BY n DESC
```

Tu vois d'un coup d'œil les transferts qui échouent, par OS et par type d'erreur, pour corriger en priorité ce qui casse le plus.

## Coût

Cloudflare Workers et Analytics Engine ont un palier gratuit largement suffisant pour un lancement (10 M d'écritures/mois incluses). Zéro coût tant que le volume reste modeste.

## Retours utilisateurs

Indépendamment de la télémétrie, les boutons **« Signaler un problème »** et **« Proposer une idée »** (Réglages → Aide et confidentialité) ouvrent un ticket prérempli sur le dépôt GitHub. C'est le canal pour les retours détaillés ; la télémétrie, elle, sert aux statistiques agrégées.
