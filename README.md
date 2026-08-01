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

## v1.5 — Cibles caloriques calculées automatiquement

Nouvelle section **Ton corps** dans le Profil : poids, taille, âge, sexe, niveau
d'activité (5 niveaux, facteurs 1.2 à 1.9).

L'app calcule alors les cibles avec **Mifflin-St Jeor** :
`MB = 10×poids + 6.25×taille − 5×âge + 5` (homme) ou `− 161` (femme),
puis `maintien = MB × facteur d'activité`, puis l'ajustement d'objectif :

| Objectif | Calories | Protéines |
|---|---|---|
| Prise de muscle | maintien **+12 %** | 2.0 g/kg |
| Maintien | maintien | 1.6 g/kg |
| Perte de poids | maintien **−18 %** | 2.2 g/kg |
| Équilibre | maintien | 1.4 g/kg |

Le résultat s'affiche en direct (avec métabolisme de base et maintien en détail)
et se recalcule à chaque modification. La case « Calculer mes cibles
automatiquement » se décoche pour reprendre la main et saisir des valeurs
manuelles.

**Combiné au bloc C** : si le Worker poids est branché, la dernière pesée
remplace le poids saisi avant chaque génération, les cibles se recalculent
dessus, puis l'ajustement de tendance (±100-150 kcal) s'applique par-dessus.
Autrement dit, la chaîne complète est : balance → Apple Santé → Worker →
cibles recalculées → plan de la semaine.

## v1.6 — Foyer complet, sport, restrictions

### Correctif majeur
`max_tokens` passé de 8000 à 16000 : une semaine complète (6 recettes + 28 créneaux)
dépassait le plafond, la réponse était tronquée, le JSON échouait et l'app relançait
en silence — d'où l'impression de boucle infinie. Ajoutés aussi : timeout dur de
3 minutes par appel, détection explicite de la troncature (`stop_reason`), et un
statut numéroté (1/3, 2/3, 3/3) pour voir où en est la génération.

### Fiches personnes
Chaque membre du foyer a désormais sa fiche : âge, sexe, poids, taille, niveau
d'activité, objectif propre (ou celui du foyer). L'app calcule ses besoins réels et
en dérive automatiquement son coefficient de portion — plus besoin de le deviner.

Sous 18 ans, Mifflin-St Jeor n'est pas fiable : l'app bascule sur les apports moyens
de référence par tranche d'âge (ANSES/PNNS), modulés par le niveau d'activité.

### Sport
Par personne : nombre de séances hebdo, intensité (légère 250 / modérée 400 /
intense 600 kcal), et les jours d'entraînement. Les calories du sport s'ajoutent aux
besoins, et les jours cochés reçoivent plus de glucides (+15-20 %) avec les repas les
plus riches en protéines placés autour de la séance.

### Restrictions
Deux niveaux par personne, traités différemment :
- **Interdits** (allergie, régime) : jamais, sous aucune forme, même en trace ou en
  substitut proche.
- **N'aime pas** : évités, mais un usage discret et bien intégré reste toléré.

## v1.7 — Sélection automatique du meilleur rapport qualité/prix

### Le principe
L'extension ne prend plus « le premier résultat » : pour chaque article, elle
récolte jusqu'à 8 candidats sur la page de résultats, les note, et retient le
meilleur — avec sa justification.

### Deux axes de notation (`js/scoring.js`, partagé app ↔ extension)
- **Prix** : ramené au prix au kg / au litre / à l'unité, la seule comparaison
  honnête entre des conditionnements différents. Le libellé est analysé pour en
  extraire la contenance (« 2x300g », « 1,5 L », « x12 »).
- **Santé** : via **Open Food Facts** (libre, sans clé), interrogé par code-barres.
  Nutri-Score (poids 3), groupe NOVA de transformation (3), nombre d'additifs (2),
  longueur de la liste d'ingrédients (1), bonus bio. Pour les produits sans
  code-barres (viande, légumes au poids), repli sur des heuristiques de libellé :
  un produit brut est bien noté, un produit pané ou en sauce est pénalisé.

### Réglage
Dans ⚙ Réglages, un curseur **prix ↔ santé** en 5 crans, du « moins cher avant
tout » à « la meilleure composition avant tout ». Plus un plafond optionnel par
article : au-delà, le produit reste proposé mais lourdement pénalisé (il peut
être le seul disponible).

### Garder la main
- Bouton **« Choisir… »** dans le panneau : la liste des 5 meilleurs s'affiche
  avec note, prix au kg et détails nutritionnels — tu tranches.
- Le curseur prix/santé est aussi accessible directement dans le panneau, et
  se change en cours de route.
- Dans l'app, chaque association reste modifiable à la main comme avant, et le
  dialogue affiche désormais pourquoi le produit a été retenu.

### Boucle d'apprentissage
En fin de liste, **« Copier les choix pour l'app »** → dans le Panier,
**« Importer les choix »**. Les produits retenus deviennent des associations
permanentes (libellé, contenance déduite, prix, EAN, note, justification), donc
les semaines suivantes n'ont plus à re-chercher.

## v1.8 — Pilote automatique et adapter auto-calibrant

### L'app cherche les références et les prix elle-même
Un seul bouton : **« ▶ Remplir tout le panier »**. L'extension parcourt toute la
liste sans intervention — pour chaque article elle lance la recherche, récolte
jusqu'à 8 candidats, interroge Open Food Facts sur leur composition, les note,
retient le meilleur, l'ajoute au panier et passe au suivant. L'état vit dans
`chrome.storage`, donc le pilote survit aux navigations entre chaque recherche.

Pause possible à tout moment, curseur prix ↔ santé modifiable en cours de route,
et bouton « Choisir ce produit… » pour trancher soi-même parmi les 5 meilleurs.

*Pourquoi l'extension et pas la PWA ?* Un site tiers refuse les requêtes venant
d'un autre domaine (CORS), et le panier exige la session connectée. L'extension
s'exécute dans la page : c'est le bras de l'app, pas un contournement.

### Adapter auto-calibrant — plus aucun sélecteur à régler
`extension/adapter.js` ne contient plus de classes CSS codées en dur. Il repère
les prix dans la page, remonte l'arbre DOM jusqu'au niveau où ces prix ont des
voisins de même signature structurelle (la grille de produits), puis extrait de
chaque carte le titre, le prix, le prix au kilo, le code-barres et le bouton
d'ajout — ce dernier reconnu par son intitulé, pas par sa classe.

Validé sur deux structures HTML sans rien en commun. En cas de souci :
`LeclercAdapter.diagnostic()` en console.

### Score de pertinence
Nouveau troisième axe, en **multiplicateur** des deux autres : le produit
correspond-il vraiment à l'ingrédient demandé ? Sans lui, des « émincés de poulet
panés surgelés » à 5,40 €/kg battaient du filet de poulet frais sur le seul
critère du prix. Un produit transformé proposé pour un ingrédient brut
(filet, pavé, escalope…) est désormais écarté.

## v1.9 — Menus variés et vue tableau

### Le problème
La consigne de génération disait « batch cooking : 4 à 6 recettes maximum,
portions multiples » — d'où quatre repas identiques dans la semaine. L'économie
était cherchée par la répétition du même plat.

### La correction : varier les plats, partager les ingrédients
Nouveau réglage **Variété des menus** dans le Profil, en trois niveaux :

| Niveau | Répétitions max d'un plat principal | Recettes distinctes |
|---|---|---|
| Batch cooking | 4 | 5 à 7 |
| **Équilibré** (défaut) | 2 | 8 à 11 |
| Variété maximale | 1 | 12 à 16 |

La consigne dit maintenant explicitement que **l'économie se fait par le partage
d'ingrédients entre recettes différentes, pas par la répétition du même plat** :
un poulet acheté sert dans deux ou trois plats distincts, avec des techniques et
des assaisonnements différents.

### Audit automatique
`PlanSchema.auditVariete()` contrôle le plan généré : plafond de répétitions,
jamais le même plat deux jours de suite au même repas, et assez de plats
principaux distincts. En cas d'échec, un tour de correction est demandé au
modèle. Petits-déjeuners et collations ont un plafond plus souple — personne ne
se plaint de manger deux fois le même porridge.

### Vue tableau
L'onglet Semaine s'ouvre désormais sur une grille jours × repas : chaque case
donne le plat et ses calories, avec **une couleur par plat distinct** — les
répétitions sautent aux yeux. Une ligne de totaux donne kcal et protéines par
jour, et un badge annonce le nombre de plats différents. Touche une case pour
sauter à la recette. Un sélecteur Tableau / Recettes bascule entre les deux vues.

## v2.0 — Recette du repas, pas du batch

Toucher une case du tableau ouvrait la recette complète, c'est-à-dire les
quantités cumulées de toutes les fois où le plat revient dans la semaine —
12 œufs pour des œufs brouillés du lundi matin.

La fiche affiche désormais **le repas précis** : en-tête « MAR · PETIT-DÉJ »,
puis les quantités ramenées aux couverts de ce créneau. Pour 1,6 couvert sur une
recette prévue pour 4 : 5 œufs, 128 g de flocons, 320 ml de lait. Les unités
comptables sont arrondies au demi le plus proche — on ne casse pas 4,8 œufs.

Quand le plat revient ailleurs dans la semaine, un sélecteur **Ce repas /
Tout préparer** bascule vers la version batch, et une note rappelle les autres
créneaux concernés avec le total des couverts : utile quand tu veux cuisiner une
seule fois pour plusieurs jours. Pour un plat unique, le sélecteur ne s'affiche
pas.

Les macros suivent le même principe : la fiche annonce les calories et protéines
de la part réellement servie à ce repas, et le tableau affiche les kcal du
créneau (pas de la portion de référence) avec le nombre de couverts.

## v2.1 — Multi-enseignes

Leclerc ne livre pas partout en Île-de-France. L'adapter n'ayant jamais rien
connu de Leclerc (il détecte les prix et en déduit la grille produits, sans
sélecteur codé en dur), le passage au multi-enseignes ne touche qu'une chose :
l'URL de recherche.

**Enseignes déclarées** : Intermarché, E.Leclerc, Carrefour, Auchan, Houra,
Courses U. L'enseigne active se choisit dans ⚙ Réglages ; l'extension reconnaît
automatiquement celle du site où elle se trouve et l'affiche en tête du panneau.
Pour un domaine non répertorié, elle bascule sur une URL de recherche générique
(`/recherche?q=`), qui marche sur beaucoup de sites.

Ajouter une enseigne : une entrée dans `ENSEIGNES` en tête de
`extension/adapter.js`, plus le domaine dans `host_permissions` et
`content_scripts.matches` du manifeste. Rien d'autre.

L'en-tête du ticket, le lien de recherche du dialogue produit et le payload
d'export portent désormais le nom de l'enseigne choisie.

## v2.2 — Génération deux à trois fois plus rapide

Trois causes à la lenteur, trois corrections.

**1. L'app attendait les recettes de cuisine avant d'afficher quoi que ce soit.**
Les étapes de préparation représentaient à elles seules un tiers du texte
produit. Elles ne sont plus générées avec le plan : le menu de la semaine
s'affiche dès que les recettes et le planning sont là, et la préparation d'un
plat s'écrit à la demande, quand tu l'ouvres (2-3 s pour une recette), puis
reste mémorisée dans le plan.

**2. Le format de sortie était bavard.** Le modèle recopiait le profil que
l'app possède déjà, et émettait le planning en 28 objets nommés. Le profil a
disparu de la réponse et le planning est passé en tableaux compacts
(`[jour, "dej", "r-slug", 1.6]`), normalisés à la réception. **Sortie réduite
de 34 %** sur une semaine de 10 recettes — mesuré, pas estimé.

**3. Aucun retour pendant l'attente.** L'appel se fait désormais en streaming :
le statut affiche « 3 recettes composées… » et progresse réellement, au lieu
d'un spinner muet. Les tours de correction (format, variété, catalogue)
streament aussi.

Ordre de grandeur sur une semaine de 10 recettes, à débit constant : de ~31 s à
~20 s pour le premier affichage, avec une progression visible du début à la fin.

## v2.3 — Transfert direct app ↔ extension

Le copier-coller d'un blob JSON entre deux fenêtres était une friction inutile,
et le popup avait gardé des textes « Leclerc » codés en dur alors que
l'enseigne est désormais un réglage.

### Le pont
`extension/bridge.js` est un content script injecté sur l'origine de l'app
(`*.github.io`, `localhost`). Il relaie des `window.postMessage` dans les deux
sens, en n'acceptant que les messages de la même fenêtre et de la même origine :

- l'app envoie sa liste → le pont l'écrit dans `chrome.storage` → confirmation ;
- l'app réclame les choix → le pont lit `prState.choix` → réponse ;
- un `ping` permet de savoir si l'extension est installée.

Côté app, `js/bridge.js` expose `Bridge.ping()`, `Bridge.envoyerListe()` et
`Bridge.recupererChoix()`. Toute absence de réponse sous 1-2 s signifie
« extension non installée » : le bouton **Copier (secours)** reste disponible et
l'import manuel refait surface tout seul.

### Ce qui change à l'usage
- **Envoyer à l'extension** remplace « Copier pour l'extension » : un clic, rien
  à coller. Avec deux livraisons recommandées, l'app demande d'abord laquelle
  préparer et n'envoie que ses articles, créneau compris.
- **Récupérer les choix** lit directement l'extension au lieu d'ouvrir une zone
  de saisie.
- Le popup affiche l'état réel (« 18 articles pour Intermarché — 4 déjà
  traités ») et nomme l'enseigne de la liste chargée. La zone de collage est
  repliée dans un « Charger manuellement », en secours.

**Note d'installation** : le pont exige de recharger l'extension
(`chrome://extensions` → ↻) après mise à jour, car un content script sur une
nouvelle origine ne s'active pas à chaud.

## v2.4 — Coût divisé par trois

Une génération coûtait jusqu'à 12 centimes quand elle déclenchait deux tours de
correction, parce que chaque tour renvoyait toute la conversation — catalogue de
200 ingrédients compris — et redemandait le plan complet. Quatre corrections.

### 1. Mise en cache du prompt système
Les règles et le catalogue (~3000 tokens) sont identiques d'un appel à l'autre.
Marqués `cache_control: ephemeral`, ils sont facturés 10 % du tarif d'entrée sur
tous les appels suivants au lieu du plein tarif.

### 2. Correction ciblée au lieu de régénération
Quand l'audit de variété échoue, l'app ne redemande plus les 10 recettes : elle
envoie la liste des recettes existantes (id + nom seulement) et réclame un
**patch** — les recettes à ajouter et le nouveau planning. La fusion se fait
localement, et les recettes devenues orphelines sont écartées. Sortie divisée
par trois sur ces tours.

### 3. Modèle léger pour les étapes
Rédiger quatre phrases de préparation ne demande pas le gros modèle : les étapes
passent sur Haiku 4.5, trois fois moins cher, sans différence perceptible.

### 4. Coût visible
Le sélecteur de modèle annonce l'ordre de grandeur par semaine générée, et
chaque plan affiche son coût réel en centimes (badge sur l'écran Semaine, calculé
depuis les tokens réellement facturés, cache compris).

### Mesures
| Cas | Avant | Après |
|---|---|---|
| Génération propre | 3,7 ¢ | 2,6 ¢ |
| Avec 2 corrections | 12,5 ¢ | 4,0 ¢ |
| Étapes d'une recette | 0,32 ¢ | 0,11 ¢ |

Usage courant — une semaine par semaine plus une vingtaine de recettes
ouvertes — : **environ 18 centimes par mois**. Sur Haiku pour tout, environ le
tiers.

## v2.5 — Le pilote ménage le site, et ne prend plus une tarte pour un citron

Deux défauts révélés par le premier vrai passage sur Intermarché.

### Erreur 500 : le pilote allait trop vite
Il enchaînait les recherches sans respirer, le site a fini par ne plus répondre.
Corrections :
- **3,5 s entre deux recherches** au minimum, au lieu de 0,6 s.
- **Reconnaissance des pages d'erreur** (« le serveur ne répond pas », erreur 5xx,
  page vide) : le pilote s'arrête net et impose deux minutes de pause, au lieu
  d'insister.
- **Temporisation progressive** : après un échec, 8 s ; deuxième, 16 s ;
  troisième, arrêt. Fini les boucles d'échec.
- **« Aucun résultat » n'est plus une panne** : l'article est simplement passé.
- **Repli sur le candidat suivant** quand le premier n'a pas de bouton d'ajout
  (rupture, fiche particulière) au lieu d'échouer sur l'article.

### « Gratin de courgettes, ail et fines herbes » retenu pour « ail »
La pertinence cherchait ses mots-clés en sous-chaîne : « ail » se trouvait dans
n'importe quoi. Réécrite :
- **Correspondance par mots entiers**, avec tolérance aux pluriels et aux
  racines, jamais en sous-chaîne.
- **Détection des plats préparés** (tarte, gratin, quiche, soupe, sauce, jus,
  compote, dessert…) : −70 points quand l'ingrédient demandé est brut. Une tarte
  au citron n'est pas un citron.
- **Le mot principal doit être présent** : −40 sinon.

Mesuré : « Gratin de courgettes, ail et fines herbes » passe de 100 à 30 de
pertinence, « Ail violet filet 200g » reste à 100 — et gagne le classement dans
les trois réglages du curseur prix/santé.

## v2.6 — Activité quotidienne ≠ sport

Le champ « Niveau d'activité » proposait « Léger (1-2 séances/sem) », « Modéré
(3-4 séances/sem) »… alors que les séances de sport sont déjà saisies juste en
dessous, avec leur intensité et leurs jours. Le sport était donc compté deux
fois : une fois dans le multiplicateur, une fois dans les calories ajoutées.

Le champ décrit maintenant ce qu'il devrait : **l'activité de la vie courante**.

| Niveau | Facteur |
|---|---|
| Assis toute la journée (bureau, télétravail, voiture) | ×1,20 |
| Un peu de marche (trajets à pied, quelques déplacements) | ×1,30 |
| Debout ou en mouvement une bonne partie du temps | ×1,45 |
| Métier physique (chantier, manutention, soins) | ×1,60 |
| Métier très physique (port de charges toute la journée) | ×1,75 |

Les facteurs sont plus bas que l'échelle Harris-Benedict classique, qui englobe
l'exercice dans le multiplicateur — ici l'exercice est ajouté séparément.

Les profils existants sont migrés automatiquement (`leger` → un peu de marche,
`modere` → debout/en mouvement, etc.), sans perte de réglage.

## v2.7 — Rien plutôt que n'importe quoi

Deuxième passage réel : la pertinence corrigée avait bien fait tomber le
« Gratin de courgettes, ail et fines herbes » de 55 à 17/100 — mais il finissait
quand même dans le panier, faute de meilleur candidat sur la page.

### Seuil d'acceptation
En dessous de **35/100**, plus rien n'est ajouté. L'article est marqué « à faire
à la main » et le récapitulatif de fin les liste : « 3 articles à ajouter à la
main : ail, ciboulette, citron ». Un panier avec trois trous vaut mieux qu'un
panier avec trois gratins.

### Bouton d'ajout : recherche élargie
« Bouton non détecté sur la fiche » revenait sur ciboulette, citron, concombre.
Sur beaucoup de sites le bouton n'est pas *dans* la carte produit mais dans un
conteneur frère, ou n'apparaît qu'au survol. La recherche remonte maintenant
jusqu'à deux niveaux d'ancêtres — en vérifiant qu'elle ne prend pas le bouton de
la carte voisine — et simule un survol avant d'abandonner.

### Rythme encore ralenti
Le site a renvoyé une deuxième erreur 500. Délai entre recherches porté de 3,5 s
à **6 s, avec une variation aléatoire de ±40 %** : une cadence parfaitement
régulière est justement ce qui ne ressemble pas à une navigation humaine. Après
un échec : 12 s, puis 24 s, puis arrêt.

Une liste de 36 articles prend désormais une dizaine de minutes. C'est le prix
d'un site qui tient debout jusqu'au bout.

## v2.8 — Mode rapide : l'API interne du site

Dix minutes pour 36 articles, c'était le prix d'une navigation complète par
ingrédient. Mais le site ne rend pas ces pages par magie : il interroge sa
propre API JSON. Autant s'adresser directement à elle.

### Apprentissage automatique
`extension/sniffer.js` enveloppe `fetch` et `XMLHttpRequest` dès le chargement
de la page et garde les vingt dernières réponses JSON qui ressemblent à une
liste de produits (des objets avec un champ nom et un champ prix). Au premier
article, traité normalement par navigation, il reconnaît :

- **l'appel de recherche** — l'URL qui contenait le terme cherché ;
- **l'appel d'ajout au panier** — l'écriture qui contenait l'identifiant du
  produit ajouté.

Les deux gabarits sont mémorisés par domaine dans `chrome.storage`. Rien ne
sort de la machine.

### Ensuite, plus aucune page
Dès le deuxième article, le pilote interroge l'API directement : pas de
navigation, pas de rendu, une charge dérisoire pour le site. Le délai entre
articles tombe de 6 s à 0,5 s.

Mesuré sur une boutique de test avec API réaliste : **une recherche en 16 ms**
au lieu d'un chargement de page, trois articles cherchés, notés et ajoutés en
**51 ms**. Le premier article reste au rythme prudent, le temps d'apprendre.

### Repli intégral
Si le site n'expose rien d'exploitable, tout continue comme avant : navigation,
lecture du DOM, clic — avec les délais prudents et les garde-fous de la v2.7.
Le mode rapide est un bonus, jamais une dépendance.

Les noms de champs sont devinés par leur intitulé (`libelleProduit`, `prixTTC`,
`prixAuKilo`, `idProduit`…), ce qui rend l'adaptation indépendante de l'enseigne.

## v2.9 — Le budget cesse d'être une devinette

Le modèle recevait une consigne « reste sous X € » sans avoir jamais vu un prix.
Il estimait au jugé. Trois corrections.

### 1. Des prix réels dans le prompt
Le payload contient désormais `prix_au_kilo` : environ 130 ingrédients avec leur
prix au kilo. **En premier, les prix relevés en magasin** — ceux des produits
que l'extension a réellement choisis et que tu as importés, convertis au kilo
depuis le format du pack. **En repli**, une table de référence
(`Catalogue.PRIX_REFERENCE`, 122 entrées) aux ordres de grandeur d'un
hypermarché français.

Plus tu utilises l'app, plus la part de prix réels grandit et plus l'estimation
devient juste.

### 2. Poids typique d'une pièce
Un prix au kilo appliqué à un compte donne n'importe quoi : deux têtes d'ail
font 120 g, pas 2 kg. `Catalogue.poidsPiece()` corrige les ingrédients comptés à
l'unité. Avant correction, l'estimation d'une semaine sortait à 115 € ; après,
48 € — la seconde est la bonne.

### 3. Contrôle après génération, pas seulement avant
L'app recalcule le coût réel du panier produit. **Au-delà de 15 % de
dépassement**, elle renvoie au modèle les six postes les plus chers et demande
un patch : remplacer les recettes coûteuses par des équivalents à apport
protéique comparable. Comme pour la variété, c'est une correction ciblée, pas
une régénération.

### Et sur l'écran Semaine
Une carte annonce le coût estimé, une jauge le compare au budget, et la mention
« 2 prix relevés en magasin, 16 estimés » dit honnêtement sur quoi repose le
chiffre. En dépassement, la carte passe au rouge et affiche l'écart.

## v3.0 — Les vrais prix de ton magasin

La table de référence donnait des ordres de grandeur honnêtes, mais un prix de
référence n'est pas le prix de ton Intermarché de Chaville. Maintenant l'app va
les chercher.

### Le relevé
En mode API (donc dès que l'extension a appris les points d'entrée du site), un
bouton **« 💶 Relever les prix du magasin »** apparaît dans le panneau. Pour
chaque ingrédient, il interroge l'API du magasin, note les candidats avec le
même moteur que le remplissage du panier — pertinence comprise, pour ne pas
relever le prix des nuggets quand on demande du filet — et retient le prix au
kilo du meilleur produit.

Mesuré : **trois ingrédients en 1,3 s**. Les 130 du vocabulaire prennent une
minute environ, une seule fois.

### Trois sources, dans cet ordre
1. **Prix relevés dans ton magasin** (`pr.prix`), horodatés et nommés — la
   meilleure source ;
2. **Produits que tu as associés** à la main ou via l'import des choix ;
3. **Table de référence**, en dernier recours seulement.

Cet ordre vaut pour l'estimation du panier comme pour le prompt de génération :
le modèle planifie désormais avec les prix du magasin où tu commandes, et le
payload précise la source (« relevés chez Intermarché le 2026-08-01 »).

### Dans l'app
Le Panier affiche l'état du relevé — « 💶 118 prix relevés chez Intermarché, le
2026-08-01 » — avec un bouton de mise à jour. Sans relevé, un encart explique
que les coûts sont estimés et propose d'en lancer un.

Le parcours : Panier → « Relever les prix » (prépare la liste) → aller sur le
site du magasin → « 💶 Relever les prix » dans le panneau → revenir au Panier →
« Relever les prix » récupère le résultat.

## v3.1 — Changer un plat qui ne plaît pas

Régénérer toute la semaine parce qu'un seul dîner déplaît était absurde : cher,
lent, et ça remplaçait aussi les plats qu'on voulait garder.

### Un plat à la fois
Dans la fiche d'un repas, bouton **« Changer ce plat »**. Quatre raisons
proposées — ça ne me tente pas, trop long, trop cher, déjà trop vu — qui sont
transmises au modèle pour orienter le remplacement.

Un seul appel, une seule recette générée. Le nouveau plat doit tenir les mêmes
contraintes : même nombre de portions, macros à ±10 %, et **priorité aux
ingrédients déjà présents dans la semaine** pour ne pas alourdir le panier. Tous
les créneaux occupés par l'ancien plat basculent sur le nouveau ; le reste de la
semaine ne bouge pas d'un pouce.

### Le refus est mémorisé
Une case « Ne plus jamais me proposer ce plat », cochée par défaut, ajoute le
plat à `plats_refuses`. Les générations suivantes reçoivent cette liste avec la
consigne de ne le proposer ni sous le même nom ni sous une variante à peine
renommée.

La liste est visible et réversible dans le Profil, comme les ingrédients bannis :
une touche sur un plat le réautorise.

## v3.2 — Shadow DOM : pourquoi les boutons restaient introuvables

« Bouton d'ajout introuvable » revenait sur citron, concombre, ciboulette — des
produits pourtant bien affichés. La cause : les sites modernes encapsulent
leurs composants dans des **shadow roots**, que `querySelectorAll` ne traverse
pas et dont `textContent` ne renvoie rien. Une carte produit paraissait vide et
sans bouton alors qu'elle était sous les yeux.

Trois corrections dans l'adapter :

- **Traversée profonde** : `tousLesNoeuds()` et `chercherProfond()` descendent
  dans chaque shadow root, jusqu'à douze niveaux. Détection de la grille,
  recherche du bouton et extraction passent par là.
- **Remontée traversante** : à l'intérieur d'un composant, `parentElement`
  s'arrête au bord. `parentTraversant()` saute sur l'hôte du shadow root, sans
  quoi la détection de la grille de produits ne remontait jamais assez haut.
- **Texte réellement affiché** : `texteVisible()` concatène le contenu des
  shadow roots. C'est ce qui manquait pour lire les prix et les titres.

S'y ajoute la gestion des **listes virtualisées** : la carte est amenée à
l'écran et on laisse 600 ms au rendu avant de chercher son bouton.

### Diagnostic exploitable
`StoreAdapter.diagnostic()` produit désormais un rapport complet — nombre
d'éléments, combien portent un shadow root, ce qui a été extrait des trois
premières cartes, le HTML du bouton trouvé, la liste des cliquables candidats,
les points d'entrée appris — et le **copie dans le presse-papiers**. De quoi
corriger sans deviner.

Validé sur trois structures sans rien en commun, dont une entièrement en
composants web à shadow DOM.

## v3.3 — Le ticket cesse d'afficher 0,00 €

Deux défauts que le ticket rendait visibles.

### Le total ignorait l'estimation
Depuis la v2.9 l'app sait estimer chaque ingrédient, mais le ticket utilisait
encore l'ancien calcul, qui ne comptait que les produits explicitement associés
— d'où un « TOTAL ESTIMÉ 0.00€ » sur un panier de quarante lignes.

Le ticket affiche maintenant un prix par ligne et un total réel, avec la
hiérarchie habituelle : prix relevés en magasin, puis produits associés, puis
table de référence. **En vert les prix relevés, en gris les estimations**, et
le pied de ticket dit la proportion : « 4 prix relevés chez Intermarché, 14
estimés ».

### Les prix s'enregistrent tout seuls
Le relevé complet exigeait le mode API, qui ne s'active pas partout. Mais chaque
produit que le pilote ajoute au panier connaît déjà son prix : il alimente
désormais la table au fil de l'eau, quel que soit le mode. Remplir un panier
suffit donc à rendre l'estimation de la semaine suivante exacte, sans rien faire
de plus.

Le bouton « Relever les prix » récupère ce qui a été collecté, et prépare la
liste complète pour un relevé rapide si le mode API finit par s'activer.

## v3.4 — Composer avec les formats vendus en magasin

Une recette qui demande 100 ml de lait de coco quand le magasin le vend par
400 ml gaspille les trois quarts du pack. L'app connaissait ces formats — via
les produits associés et le relevé de prix — mais n'en tenait aucun compte pour
composer les menus.

### Les conditionnements entrent dans la génération
Le payload contient désormais `conditionnements` : la contenance réellement
vendue pour chaque ingrédient connu. La consigne demande de dimensionner les
recettes sur des **packs entiers**, avec deux stratégies dans l'ordre :

1. ajuster la quantité d'une recette pour consommer tout le pack ;
2. **prévoir une seconde recette dans la semaine qui utilise le reste** — la
   solution élégante : de la variété en plus, rien de plus dans le panier.

La consigne tient compte de la fraîcheur : un reste de crème se recuisine dans
les trois jours, un reste de riz peut attendre.

### Audit après génération
`Aggregator.analyserEmballages()` calcule, ingrédient par ingrédient, le nombre
de packs, ce qui reste et **ce que ce reste coûte**. Au-delà de trois ingrédients
gaspillés à plus de 25 %, ou de 5 € de produit inutilisé, un patch ciblé est
demandé au modèle avec le détail des restes.

### Visible dans le panier
Un bandeau annonce le total — « 📦 4,09 € de restes après cette semaine » — et
chaque ligne concernée porte son détail : « ↳ 1×400g — il restera 240g (1,68€) ».

### Et les restes ne se perdent pas
L'inventaire enregistre désormais **le contenu des packs achetés**, pas le besoin
des recettes. La différence — le reste — est donc disponible la semaine suivante :
un pack de quinoa de 400 g acheté pour 160 g couvre entièrement les 150 g de la
semaine d'après, sans rien racheter.

## v3.5 — Le chaînage des restes, rendu visible

La v3.4 demandait déjà au modèle de finir les packs entamés dans une autre
recette de la semaine. Mais rien ne le montrait : optimisation invisible,
donc invérifiable.

`Aggregator.chainageRestes()` détecte les packs partagés entre plusieurs plats —
un ingrédient utilisé par deux recettes ou plus, dont le total tient dans un
seul conditionnement — et les ordonne par jour d'utilisation.

**Sur l'écran Semaine**, une carte récapitule :

> ♻️ 1 pack partagé entre plusieurs plats
> lait de coco · 400ml
> **Lun** Curry de poulet au lait de coco *300ml* → **Mar** Dahl de lentilles
> corail au coco *100ml*
> *pack entièrement utilisé*

**Dans la fiche d'un plat**, la même information vue de l'intérieur : « ♻️ lait
de coco — pack de 400ml : le reste sert Mar à Dahl de lentilles corail au coco. »
Et pour le plat qui reçoit : « ouvert Lun pour Curry de poulet ».

La consigne de génération a été précisée avec cet exemple exact, pour que le
comportement devienne systématique sur les briques, pots et bocaux entamés.
