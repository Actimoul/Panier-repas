# Panier Repas

PWA de planification de repas hebdomadaire + extension Chrome pour remplir le panier Leclerc.
Zéro build, zéro dépendance : HTML/CSS/JS vanilla, déployable tel quel sur GitHub Pages.

## Flux complet

1. **Profil** — objectif (prise de muscle…), kcal, protéines, budget, exclusions.
2. **Semaine** — génération du plan via l'API Anthropic (clé dans ⚙ Réglages),
   validation stricte du JSON avec une boucle d'auto-correction (1 retry).
3. **Panier** — le Ticket : ingrédients fusionnés, groupés par rayon, inventaire déduit,
   fond de placard exclu. Chaque ligne « ? » se touche pour l'associer à un produit
   Leclerc (libellé, contenu du pack, prix) → mémorisé pour toutes les semaines suivantes,
   conversion automatique en nombre de packs + total estimé.
4. **Extension** — « Copier pour l'extension » → coller dans le popup → le panneau
   flottant sur le site Leclerc enchaîne recherche/ajout article par article.
   **L'extension ne touche jamais aux pages de paiement** : tu valides et paies toi-même.
5. **Commande passée ✓** — les quantités achetées rejoignent l'inventaire avec des DLC
   estimées ; la génération suivante réutilise ces restes en priorité.

## Déploiement de la PWA

```bash
# n'importe quel hébergement statique fait l'affaire
git init && git add . && git commit -m "init"
# → GitHub Pages (Settings > Pages > branch main, root)
```

En local : `python3 -m http.server 8080` puis http://localhost:8080
(le service worker exige http(s), pas file://).

⚠️ La clé API est stockée en localStorage et part directement du navigateur vers
api.anthropic.com (`anthropic-dangerous-direct-browser-access`). Acceptable pour un
usage perso ; si un jour tu partages l'app, bascule l'appel derrière un Cloudflare
Worker comme pour Recto.

## Installation de l'extension

1. chrome://extensions → mode développeur → « Charger l'extension non empaquetée »
   → dossier `extension/`.
2. **Repérage (une seule fois)** : connecte-toi à ton drive Leclerc, DevTools > Réseau,
   fais une recherche + un ajout panier à la main, et reporte ce que tu observes dans
   `extension/adapter.js` (sélecteurs DOM, ou mieux : l'API JSON interne si elle existe).
   C'est le SEUL fichier lié au site — tout le reste est générique.
3. Recharge l'extension. Le panneau apparaît sur le site dès qu'une liste est chargée.

## Fichiers

```
index.html                 shell + dialogues
css/styles.css             design tokens (porcelaine/basilic/paprika, signature "ticket")
js/store.js                localStorage centralisé
js/schema.js               validateur PlanSemaine v1.0 (miroir du JSON Schema)
js/generator.js            appel API + prompt système + auto-correction
js/aggregator.js           fusion, inventaire, packs, export extension
js/app.js                  UI des 4 onglets
js/plan-semaine.schema.json  JSON Schema de référence
sw.js                      cache app shell (jamais l'API)
extension/                 MV3 : popup (chargement liste) + panneau flottant + adapter
```

## Limites connues / TODO

- `adapter.js` livré avec des sélecteurs génériques : à ajuster après ton repérage
  (impossible de les garantir sans accès au site connecté).
- Conversion d'unités inter-recettes non gérée (un même ingrédient en `g` ET en `piece`
  génère deux besoins distincts — le prompt impose la cohérence, le validateur la vérifie).
- Prix estimés = tes saisies lors de l'association produit, pas un flux temps réel.

## v1.1 — Convives & poids (balance connectée)

### Convives et présence
Onglet Profil : ajoute tes convives (toi coefficient 1, un enfant ~0.5-0.7) et coche
la grille « Qui mange à la maison ? » — 7 jours × 4 repas par convive. Un créneau sans
personne = aucun repas généré (cantine, resto, garde alternée…). Les quantités du panier
sont mises à l'échelle exactement sur les couverts planifiés.

### Poids via Starfit → Apple Santé → Raccourci iOS → Worker
Starfit n'a pas d'API, mais pousse le poids dans Apple Santé. Chaîne complète :

1. **Déployer le Worker** (`worker/`) :
   ```bash
   cd worker
   wrangler kv namespace create WEIGHTS   # coller l'id dans wrangler.toml
   wrangler secret put SHARED_SECRET      # longue chaîne aléatoire
   wrangler deploy
   ```
2. **App** : ⚙ Réglages → URL du Worker + secret.
3. **Raccourci iOS** (une fois) :
   - Nouvelle automatisation → « Heure de la journée » → dimanche 20h → Exécuter immédiatement.
   - Action « Rechercher des échantillons de santé » : type Poids, trié par date (plus récent), limite 1.
   - Action « Obtenir les détails » : valeur → variable Poids.
   - Action « Obtenir le contenu de l'URL » :
     - URL : `https://TON-WORKER.workers.dev/weight`
     - Méthode POST, corps JSON : `{ "kg": Poids }`
     - En-tête : `X-Secret` = ton secret.
   - Vérifie dans Starfit que la synchro Apple Santé est activée (réglages de l'app).

À chaque génération de semaine, l'app récupère l'historique, calcule la tendance
(kg/semaine sur 3 semaines) et ajuste les kcal cibles : en prise de muscle, poids
stable → +150 kcal, prise > 0,5 kg/sem → −100 kcal (logique symétrique en perte).
L'ajustement est affiché avant génération, et le dernier poids apparaît sur l'écran Semaine.

## v1.2 — Recommandation de fréquence de livraison

Sur l'onglet Panier, une carte 🚚 croise le planning des repas avec la fraîcheur des
produits achetés (très courte 3 j, courte 7 j, moyenne 30 j, longue 180 j) : si tous
les produits frais sont cuisinés dans leur fenêtre, « 1 livraison/semaine suffit » ;
sinon elle recommande une 2e livraison la veille du premier produit à risque, liste
les produits en cause, et propose l'alternative surgelé pour rester à une livraison.

## v1.3 — Créneaux de livraison mémorisés

Sur l'onglet Panier, bouton « Mes créneaux habituels » : enregistre les créneaux
Leclerc que tu prends d'ordinaire (jour + heure, plusieurs possibles). La carte 🚚
donne alors des **dates exactes** au lieu de jours vagues : « dimanche 18:00 — 2026-08-02 »
plutôt que « la veille ». Sans créneau enregistré, elle retombe sur la veille du début
de semaine.

Quand 2 livraisons sont recommandées, l'export répartit automatiquement les articles :
les produits frais à risque partent en livraison 2, tout le reste en livraison 1. Le
popup de l'extension propose alors un sélecteur « Livraison à préparer » qui affiche le
créneau visé et le nombre d'articles, et ne charge que ceux de la livraison choisie. Le
panneau flottant rappelle le créneau en haut pendant le remplissage.

Format d'export passé en `version: 2` (ajout de `livraisons[]` et du champ `livraison`
par article) — recharge l'extension après mise à jour.

## v1.4 — Style de cuisine & réalisme catalogue

### Complexité et types de cuisine (onglet Profil)
- **Complexité** : Express (≤ 20 min, une seule poêle), Simple (≤ 40 min, techniques de
  base), Élaboré (≤ 90 min, marinades et sauces). Le plafond de temps s'applique à
  chaque recette (préparation + cuisson).
- **Types de cuisine** : chips multi-sélection (française, italienne, méditerranéenne,
  asiatique, indienne, mexicaine, moyen-orientale, américaine, nord-africaine). L'app
  répartit les recettes de la semaine entre les styles cochés ; aucun coché = variété libre.

### Réalisme catalogue Leclerc
Trois garde-fous cumulés, dans `js/catalogue.js` :

1. **Vocabulaire de référence** — ~200 ingrédients réellement présents en hypermarché
   français, groupés par rayon, injectés dans le prompt système. Consigne explicite :
   remplacer tout ingrédient hors catalogue par son équivalent le plus proche
   (galanga → gingembre frais, mirin → vinaigre de cidre + sucre, burrata → mozzarella).
2. **Apprentissage** — les produits que tu as déjà associés à une référence Leclerc sont
   passés au modèle comme « disponibilité prouvée », à réutiliser en priorité absolue.
   Plus tu utilises l'app, plus elle vise juste.
3. **Vérification post-génération** — le plan produit est re-scanné : tout ingrédient
   inconnu du vocabulaire et non associé déclenche un tour de correction automatique
   auprès du modèle. Ce qui subsiste est signalé par une carte ⚠️ sur l'écran Semaine.

**Boucle de retour** : dans le Panier, le dialogue d'un produit propose « Introuvable en
magasin ». L'ingrédient est alors banni des générations suivantes (liste gérable et
réversible depuis le Profil). C'est le mécanisme qui fait converger l'app vers le
catalogue réel de TON magasin.
