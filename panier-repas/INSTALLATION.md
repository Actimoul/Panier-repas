# Panier Repas — procédure d'installation complète

Trois blocs indépendants. Le bloc A suffit pour une app fonctionnelle.

| Bloc | Quoi | Où | Durée | Requis ? |
|---|---|---|---|---|
| A | PWA sur GitHub Pages + clé API | ordi puis iPhone | 15 min | **oui** |
| B | Extension Chrome + repérage Leclerc | ordi | 20 min | pour le remplissage auto |
| C | Worker + Raccourci iOS (poids) | ordi puis iPhone | 20 min | optionnel |

---

## Inventaire des fichiers

```
panier-repas/
├── index.html                    shell HTML, 4 onglets, dialogues        (83 l.)
├── manifest.webmanifest          manifeste PWA (nom, icônes, couleurs)   (15 l.)
├── sw.js                         service worker, cache "panier-repas-v6" (43 l.)
├── README.md                     doc technique et historique des versions
├── INSTALLATION.md               ce fichier
│
├── css/
│   └── styles.css                design tokens + tous les composants     (427 l.)
│
├── icons/
│   ├── icon.svg                  source vectorielle
│   ├── icon-192.png              icône PWA
│   └── icon-512.png              icône PWA / splash iOS
│
├── js/
│   ├── store.js                  localStorage centralisé (8 clés)        (103 l.)
│   ├── catalogue.js              vocabulaire supermarché, cuisines,
│   │                             complexités, détection hors-catalogue   (147 l.)
│   ├── schema.js                 validateur PlanSemaine v1.0             (74 l.)
│   ├── plan-semaine.schema.json  JSON Schema de référence (doc)
│   ├── generator.js              appel API Anthropic, prompt système,
│   │                             2 tours de correction auto              (148 l.)
│   ├── aggregator.js             fusion ingrédients, inventaire, packs,
│   │                             reco livraison, export extension        (262 l.)
│   ├── health.js                 sync poids + ajustement kcal            (55 l.)
│   └── app.js                    UI des 4 onglets et dialogues           (693 l.)
│
├── extension/                    extension Chrome MV3
│   ├── manifest.json             permissions, content scripts            (24 l.)
│   ├── adapter.js                ⚠️ SEUL fichier lié au site Leclerc     (65 l.)
│   ├── content.js                panneau flottant, progression           (104 l.)
│   ├── popup.html / popup.js     chargement liste + choix livraison      (92 l.)
│   ├── panel.css                 style du panneau                        (42 l.)
│   └── icon-128.png
│
└── worker/                       Cloudflare Worker (poids)
    ├── worker.js                 endpoints /weight (POST) et /weights    (66 l.)
    └── wrangler.toml             config, id KV à remplir                 (7 l.)
```

Ordre de chargement des scripts (défini dans `index.html`) :
`store.js → catalogue.js → schema.js → generator.js → aggregator.js → health.js → app.js`.
Chaque module expose un objet global unique (`Store`, `Catalogue`, `PlanSchema`,
`Generator`, `Aggregator`, `Health`). Pas de bundler, pas de build.

---

## BLOC A — La PWA (obligatoire)

### A1. Récupérer les fichiers
Décompresse `panier-repas-v1.4.zip`. Tu obtiens le dossier `panier-repas/`.

### A2. Tester en local (recommandé avant de publier)
```bash
cd panier-repas
python3 -m http.server 8080
```
Ouvre <http://localhost:8080>. Le service worker refuse le protocole `file://`,
donc n'ouvre pas `index.html` par double-clic — ça ne marchera pas.

Tu dois voir l'onglet Profil. Si la page est blanche : ouvre la console (F12),
c'est presque toujours un fichier manquant dans `js/`.

### A3. Publier sur GitHub Pages
```bash
cd panier-repas
git init
git add .
git commit -m "Panier Repas v1.4"
git branch -M main
git remote add origin https://github.com/actimoul/panier-repas.git
git push -u origin main
```
(Crée d'abord le repo vide `panier-repas` sur github.com/actimoul.)

Puis sur GitHub : **Settings → Pages → Source: Deploy from a branch →
Branch: `main`, dossier `/ (root)` → Save**. Attends 1 à 2 minutes.
Ton URL : `https://actimoul.github.io/panier-repas/`

### A4. Créer la clé API Anthropic
1. <https://console.anthropic.com> → **API Keys** → *Create Key*.
2. Copie la clé (`sk-ant-...`) — elle n'est affichée qu'une fois.
3. **Billing** → ajoute quelques euros de crédit.
   Ordre de grandeur : une génération de semaine coûte quelques centimes.

### A5. Installer sur l'iPhone
1. Ouvre ton URL GitHub Pages dans **Safari** (pas Chrome — l'ajout à
   l'écran d'accueil ne fonctionne correctement que dans Safari sur iOS).
2. Bouton Partager → **Sur l'écran d'accueil** → Ajouter.
3. Lance l'app depuis l'icône : elle s'ouvre en plein écran, sans barre Safari.

### A6. Configurer et générer
1. Icône **⚙** en haut à droite → colle la clé API → Enregistrer.
   La clé reste dans le `localStorage` de ton téléphone et part uniquement
   vers `api.anthropic.com`.
2. Onglet **Profil** :
   - Objectif, kcal/jour, protéines/jour, repas/jour, budget hebdo.
   - **Style de cuisine** : complexité (Express / Simple / Élaboré) et types
     de cuisine (chips multi-sélection).
   - **Convives** : toi en coefficient 1, ton fils en 0.5–0.7 selon son âge.
   - **Qui mange à la maison ?** : décoche les créneaux d'absence
     (cantine, resto, garde alternée). Un créneau vide = aucun repas généré.
   - Exclusions et préférences libres.
   - **Enregistrer le profil**.
3. Onglet **Semaine** → **Générer ma semaine**. Compte 20 à 40 secondes.

Si ça échoue : le message d'erreur est explicite. `API 401` = clé invalide,
`API 400` = crédit épuisé, « Plan invalide après correction » = relance
simplement, c'est un aléa du modèle.

### A7. Associer les produits (une seule fois par ingrédient)
Onglet **Panier**. Chaque ligne préfixée `?` n'est pas encore associée.
1. Touche la ligne → le dialogue s'ouvre avec un lien de recherche Leclerc.
2. Trouve le produit sur le site, reviens et saisis : libellé, contenu du
   pack (600 pour une barquette de 600 g), unité, prix, réf/EAN si tu veux.
3. Enregistre. L'association est mémorisée **définitivement** : la ligne passe
   en `✓`, se convertit en nombre de packs et alimente le total estimé.

Si un produit n'existe pas chez Leclerc : bouton **« Introuvable en magasin »**.
L'ingrédient est banni des générations suivantes (réversible depuis le Profil).
C'est ce qui fait converger l'app vers le catalogue réel de ton magasin.

Compte une vingtaine d'associations la première semaine, puis quasi plus rien.

### A8. Boucler la semaine
Après réception de la commande : Panier → **« Commande passée ✓ »**. Les
quantités achetées rejoignent l'inventaire avec des DLC estimées, et la
génération suivante réutilise ces restes en priorité.

---

## BLOC B — L'extension Chrome

### B1. Charger l'extension
1. Chrome → `chrome://extensions`
2. Active **Mode développeur** (interrupteur en haut à droite).
3. **Charger l'extension non empaquetée** → sélectionne le dossier `extension/`.
4. Épingle-la dans la barre d'outils (icône puzzle → punaise).

### B2. Repérage du site Leclerc — l'étape à faire toi-même
Impossible pour moi de deviner les sélecteurs sans une session connectée à
ton magasin. Ça se fait une fois, en 5 minutes.

1. Connecte-toi sur ton drive/livraison Leclerc.
2. **F12** → onglet **Réseau** → filtre **Fetch/XHR** → coche *Conserver le journal*.
3. Tape une recherche produit (ex. « poulet ») et valide.
   → Note l'URL appelée et regarde l'aperçu de la réponse : y a-t-il un JSON
     avec les produits (id, libellé, prix) ?
4. Clique sur **Ajouter au panier** d'un produit.
   → Note l'URL, la méthode (POST), le corps envoyé, et les en-têtes
     inhabituels (jeton CSRF, `X-...`).
5. Clic droit sur la carte produit → **Inspecter** → note les classes CSS de :
   la carte produit, son titre, le bouton d'ajout.

### B3. Reporter dans adapter.js
Ouvre `extension/adapter.js`. Les instructions sont en tête de fichier.

- **Cas 1 — le site a une API JSON interne** (le plus fiable) : décommente le
  bloc `apiSearch` / `apiAddToCart` en bas du fichier et remplace les URLs et
  les noms de champs par ceux relevés.
- **Cas 2 — pas d'API exploitable** : ajuste les quatre sélecteurs de l'objet
  `selectors` (`productCard`, `productTitle`, `addToCartBtn`, `searchInput`)
  avec les classes relevées à l'étape B2.5.

Puis `chrome://extensions` → bouton **recharger** (↻) sur l'extension.

### B4. Utiliser
1. App → Panier → **Copier pour l'extension**.
2. Clic sur l'icône de l'extension → colle dans la zone de texte.
3. **Livraison à préparer** : si deux livraisons sont recommandées, le
   sélecteur affiche le créneau visé et le nombre d'articles de chacune.
4. **Charger la liste**.
5. Va sur le site Leclerc : le panneau flottant apparaît en bas à droite avec
   le créneau visé et le premier article.
6. Pour chaque article : **1. Chercher** → **2. Ajouter 1er résultat**
   (ou **Passer**). Le compteur avance, le journal garde les 4 dernières lignes.
7. À la fin : message de confirmation. **Tu vérifies le panier et tu paies
   toi-même** — l'extension ne s'active jamais sur une page de paiement.

---

## BLOC C — Poids automatique (optionnel)

Chaîne : balance → **Starfit** → **Apple Santé** → **Raccourci iOS** →
**Worker Cloudflare** → l'app ajuste tes kcal.

### C1. Vérifier la synchro Starfit
Ouvre Starfit → réglages → active la synchronisation **Apple Santé**.
Autorise l'écriture du poids. Pèse-toi une fois et vérifie que la mesure
apparaît bien dans l'app Santé (Parcourir → Corps → Poids).

### C2. Déployer le Worker
```bash
npm install -g wrangler
cd panier-repas/worker
wrangler login                        # ouvre le navigateur
wrangler kv namespace create WEIGHTS  # → copie l'id retourné
```
Ouvre `wrangler.toml` et remplace `REMPLACER_PAR_L_ID_KV` par l'id obtenu.

```bash
wrangler secret put SHARED_SECRET     # tape une longue chaîne aléatoire, garde-la
wrangler deploy                       # → note l'URL affichée
```

Test rapide :
```bash
curl -X POST https://TON-WORKER.workers.dev/weight \
  -H "X-Secret: TON_SECRET" -H "Content-Type: application/json" \
  -d '{"kg": 78.4}'
# → {"ok":true,"count":1}
```

### C3. Renseigner l'app
⚙ Réglages → **URL du Worker** (sans slash final) + **Secret du Worker**
→ Enregistrer.

### C4. Créer le Raccourci iOS
App **Raccourcis** → onglet **Automatisation** → **+** :

1. **Heure de la journée** → Dimanche → 20:00 → hebdomadaire.
2. Décoche *Demander avant d'exécuter* (sinon rien ne partira tout seul).
3. Actions à ajouter, dans l'ordre :
   - **Rechercher des échantillons de santé**
     - Type : *Poids*
     - Trier par : *Date de début*, ordre décroissant
     - Limite : *1 élément*
   - **Obtenir les détails des échantillons de santé**
     - Détail : *Valeur* → cette sortie est ton poids.
   - **Obtenir le contenu de l'URL**
     - URL : `https://TON-WORKER.workers.dev/weight`
     - Méthode : **POST**
     - En-têtes : `X-Secret` = ton secret
     - Corps de la requête : **JSON**
       - clé `kg` (type Nombre) = la variable *Valeur* de l'étape précédente.
4. Enregistre. Lance-le une fois à la main pour vérifier : la réponse doit
   contenir `"ok": true`.

### C5. Ce que ça change
À chaque génération, l'app récupère l'historique, calcule ta tendance sur
3 semaines et ajuste les kcal cibles avant d'appeler le modèle :

| Objectif | Tendance | Ajustement |
|---|---|---|
| Prise de muscle | < +0,1 kg/sem | **+150 kcal** |
| Prise de muscle | > +0,5 kg/sem | **−100 kcal** |
| Perte de poids | > −0,1 kg/sem | **−150 kcal** |
| Perte de poids | < −1,0 kg/sem | **+150 kcal** |
| Maintien | ±0,3 kg/sem | **∓100 kcal** |

L'ajustement est annoncé par un toast avant la génération, et le dernier
poids + la tendance s'affichent en haut de l'écran Semaine.

---

## Mise à jour de l'app

```bash
# remplace les fichiers, puis :
git add . && git commit -m "v1.x" && git push
```
Le service worker sert un cache versionné (`panier-repas-v6`) : à chaque
changement de version du cache dans `sw.js`, l'ancien est purgé
automatiquement. Sur iPhone, ferme et rouvre l'app pour prendre la mise à jour.

**Tes données ne sont jamais touchées** par une mise à jour : profil,
associations produits, inventaire et poids vivent dans le `localStorage`,
indépendamment du cache.

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Page blanche | fichier `js/` manquant | console F12, vérifier les 404 |
| « Clé API manquante » | clé non enregistrée | ⚙ → coller → Enregistrer |
| `API 401` | clé invalide ou révoquée | recréer une clé |
| `API 400` credit | crédit épuisé | recharger sur console.anthropic.com |
| « Plan invalide après correction » | aléa du modèle | relancer la génération |
| Sync poids impossible | URL/secret erronés | vérifier avec le `curl` de C2 |
| Panneau extension absent | aucune liste chargée | popup → Charger la liste |
| « Bouton Ajouter introuvable » | sélecteurs à ajuster | refaire B2/B3 |
| Total estimé partiel (`*`) | produits non associés | associer les lignes `?` |
