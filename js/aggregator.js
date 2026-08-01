/* Basket aggregation:
   1. merge ingredients across recipes (key: nom_canonique)
   2. subtract home inventory
   3. convert to purchase units when a Leclerc match with pack size exists
   4. build the export payload for the browser extension */
const Aggregator = (() => {
  const RAYON_LABELS = {
    fruits_legumes: 'Fruits & légumes',
    boucherie: 'Boucherie',
    poissonnerie: 'Poissonnerie',
    cremerie_oeufs: 'Crèmerie & œufs',
    epicerie_salee: 'Épicerie salée',
    epicerie_sucree: 'Épicerie sucrée',
    surgeles: 'Surgelés',
    boulangerie: 'Boulangerie',
    boissons: 'Boissons',
    condiments_epices: 'Condiments & épices'
  };
  const RAYON_ORDER = Object.keys(RAYON_LABELS);

  function fmtQty(q, unit) {
    if (unit === 'piece') return `${q} pc`;
    if (unit === 'g' && q >= 1000) return `${(q / 1000).toFixed(q % 1000 === 0 ? 0 : 1)} kg`;
    if (unit === 'ml' && q >= 1000) return `${(q / 1000).toFixed(q % 1000 === 0 ? 0 : 1)} L`;
    return `${Math.round(q)} ${unit === 'ml' ? 'ml' : 'g'}`;
  }

  /* Returns items: [{ nom_canonique, rayon, besoin, unite, enStock, aAcheter,
       match?, packs?, prix_estime?, fondDePlacard }] */
  function buildBasket(plan, inventory, matches) {
    // Scale each recipe by the portions actually planned (couverts-aware).
    // No planning → full batch (scale 1).
    const plannedByRecipe = new Map();
    for (const p of plan.planning || []) {
      plannedByRecipe.set(p.recette_id, (plannedByRecipe.get(p.recette_id) || 0) + (p.portions || 1));
    }
    const hasPlanning = (plan.planning || []).length > 0;

    const merged = new Map();
    for (const r of plan.recettes) {
      const planned = plannedByRecipe.get(r.id);
      const scale = hasPlanning && planned > 0 ? planned / r.portions : 1;
      for (const ing of r.ingredients) {
        const key = ing.nom_canonique;
        if (!merged.has(key)) {
          merged.set(key, {
            nom_canonique: key,
            rayon: ing.rayon,
            unite: ing.unite,
            besoin: 0,
            fondDePlacard: !!ing.fond_de_placard,
            peremption_type: ing.peremption_type || null
          });
        }
        const item = merged.get(key);
        if (item.unite !== ing.unite) {
          // Unit mismatch across recipes: keep both visible, never guess a conversion.
          console.warn(`Unit mismatch for ${key}: ${item.unite} vs ${ing.unite}`);
        }
        item.besoin += ing.quantite * scale;
        item.fondDePlacard = item.fondDePlacard && !!ing.fond_de_placard;
      }
    }

    const invByName = new Map(inventory.map(i => [i.nom_canonique, i]));
    const items = [];
    for (const item of merged.values()) {
      const inv = invByName.get(item.nom_canonique);
      const enStock = inv && inv.unite === item.unite ? inv.quantite : 0;
      let aAcheter = Math.max(0, item.besoin - enStock);
      if (item.fondDePlacard && !inv) aAcheter = 0; // presumed in stock

      const match = matches[item.nom_canonique] || null;
      let packs = null;
      let prixEstime = null;
      if (match && aAcheter > 0 && match.pack_quantite > 0 && match.pack_unite === item.unite) {
        packs = Math.ceil(aAcheter / match.pack_quantite);
        if (typeof match.prix_eur === 'number') prixEstime = packs * match.prix_eur;
      }

      items.push({ ...item, enStock, aAcheter, match, packs, prix_estime: prixEstime });
    }

    items.sort((a, b) => {
      const r = RAYON_ORDER.indexOf(a.rayon) - RAYON_ORDER.indexOf(b.rayon);
      return r !== 0 ? r : a.nom_canonique.localeCompare(b.nom_canonique, 'fr');
    });
    return items;
  }

  function groupByRayon(items) {
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.rayon)) groups.set(it.rayon, []);
      groups.get(it.rayon).push(it);
    }
    return [...groups.entries()].map(([rayon, list]) => ({
      rayon, label: RAYON_LABELS[rayon] || rayon, items: list
    }));
  }

  function totalEstime(items) {
    let total = 0;
    let complete = true;
    for (const it of items) {
      if (it.aAcheter <= 0) continue;
      if (typeof it.prix_estime === 'number') total += it.prix_estime;
      else complete = false;
    }
    return { total, complete };
  }

  /* --- Conditionnements et gaspillage --------------------- */

  /* What the store actually sells for a given ingredient: pack size and
     label. Real associations first, then the price sweep (whose labels
     carry the quantity), then nothing. */
  function conditionnement(nomCanonique, matches) {
    const m = (matches || {})[nomCanonique];
    if (m && m.pack_quantite > 0 && m.pack_unite) {
      return { quantite: m.pack_quantite, unite: m.pack_unite, libelle: m.libelle, source: 'associe' };
    }
    const releve = (typeof Store !== 'undefined' && Store.getPrix) ? Store.getPrix() : null;
    const r = releve?.prix?.[nomCanonique];
    if (r?.libelle && typeof Scoring !== 'undefined') {
      const t = Scoring.packSize({ libelle: r.libelle });
      if (t) return { quantite: t.quantite, unite: t.unite, libelle: r.libelle, source: 'releve' };
    }
    return null;
  }

  /* Per-ingredient waste analysis: how much of the last pack stays unused.
     This is what makes "buy 1 pack of 500 g for a recipe needing 320 g"
     visible — and fixable. */
  function analyserEmballages(items, matches) {
    const lignes = [];
    let valeurPerdue = 0;
    for (const it of items) {
      if (it.aAcheter <= 0 || it.fondDePlacard) continue;
      const cond = conditionnement(it.nom_canonique, matches);
      if (!cond || cond.unite !== it.unite || !(cond.quantite > 0)) continue;

      const packs = Math.ceil(it.aAcheter / cond.quantite);
      const achete = packs * cond.quantite;
      const reste = achete - it.aAcheter;
      const part = achete > 0 ? reste / achete : 0;

      // Le prix du reste, quand on le connaît : c'est ce qui parle vraiment.
      let coutReste = null;
      const releve = (typeof Store !== 'undefined' && Store.getPrix) ? Store.getPrix() : null;
      const rel = releve?.prix?.[it.nom_canonique];
      const parKg = rel?.par_kg
        ?? (rel?.par_piece > 0 && Catalogue.poidsPiece(it.nom_canonique)
              ? rel.par_piece / (Catalogue.poidsPiece(it.nom_canonique) / 1000)
              : null)
        ?? (typeof Catalogue !== 'undefined' ? Catalogue.prixReference(it.nom_canonique) : null);
      if (parKg > 0) {
        const kg = cond.unite === 'piece'
          ? (reste * Catalogue.poidsPiece(it.nom_canonique)) / 1000
          : reste / 1000;
        coutReste = Math.round(parKg * kg * 100) / 100;
        valeurPerdue += coutReste;
      }

      lignes.push({
        nom: it.nom_canonique, unite: it.unite,
        besoin: Math.round(it.aAcheter),
        pack: cond.quantite, libelle: cond.libelle,
        packs, achete: Math.round(achete), reste: Math.round(reste),
        part: Math.round(part * 100), coutReste,
        peremption: it.peremption_type
      });
    }
    lignes.sort((a, b) => (b.coutReste ?? 0) - (a.coutReste ?? 0));
    const gaspilleurs = lignes.filter(l => l.part >= 25 && l.reste > 0);
    return {
      lignes, gaspilleurs,
      valeurPerdue: Math.round(valeurPerdue * 100) / 100,
      partMoyenne: lignes.length
        ? Math.round(lignes.reduce((a, l) => a + l.part, 0) / lignes.length)
        : 0
    };
  }

  /* Leftover chaining: which recipe opens a pack, and which ones finish it.
     A 400 ml can of coconut milk used 300 ml on Monday and 100 ml on Tuesday
     is the whole point — showing it turns an invisible optimisation into
     something the user can trust and follow. */
  function chainageRestes(plan, matches) {
    const parIngredient = new Map();
    const recettesParId = new Map(plan.recettes.map(r => [r.id, r]));
    const ordre = new Map();   // recette_id -> premier jour d'utilisation

    for (const p of plan.planning || []) {
      if (!ordre.has(p.recette_id) || p.jour < ordre.get(p.recette_id)) {
        ordre.set(p.recette_id, p.jour);
      }
    }

    for (const r of plan.recettes) {
      const jour = ordre.get(r.id);
      if (jour === undefined) continue;
      for (const ing of r.ingredients) {
        if (ing.fond_de_placard) continue;
        if (!parIngredient.has(ing.nom_canonique)) parIngredient.set(ing.nom_canonique, []);
        parIngredient.get(ing.nom_canonique).push({
          recetteId: r.id, nom: r.nom, jour, quantite: ing.quantite, unite: ing.unite
        });
      }
    }

    const chaines = [];
    for (const [nom, usages] of parIngredient) {
      if (usages.length < 2) continue;
      const cond = conditionnement(nom, matches);
      if (!cond || cond.unite !== usages[0].unite) continue;
      const total = usages.reduce((a, u) => a + u.quantite, 0);
      // On ne retient que le partage d'un même pack : si le total dépasse
      // largement un pack, ce n'est plus un reste réutilisé.
      if (total > cond.quantite * 1.05) continue;
      usages.sort((a, b) => a.jour - b.jour);
      chaines.push({
        nom, pack: cond.quantite, unite: cond.unite, libelle: cond.libelle,
        total: Math.round(total),
        reste: Math.round(cond.quantite - total),
        usages
      });
    }
    return chaines;
  }

  /* Estimated basket cost, ingredient by ingredient.
     Real prices first (products the user has associated), reference prices
     as a fallback. Returns { total, connus, estimes, details[] } so the UI
     can say how much of the estimate is actually grounded. */
  function estimerCout(items) {
    let total = 0, connus = 0, estimes = 0;
    const details = [];
    const releve = (typeof Store !== 'undefined' && Store.getPrix) ? Store.getPrix() : null;
    const prixReleves = releve?.prix || {};
    // Quand l'utilisateur ne veut que des prix réels, on n'invente rien :
    // les ingrédients non relevés restent sans prix, et le total le dit.
    const relevesUniquement = (typeof Store !== 'undefined' && Store.getSettings)
      ? !!Store.getSettings().prixRelevesUniquement : false;
    for (const it of items) {
      if (it.aAcheter <= 0) continue;
      let prix = null, source = null;

      const rel = prixReleves[it.nom_canonique];
      if (typeof it.prix_estime === 'number') {
        prix = it.prix_estime; source = 'reel';
      } else if (rel && rel.par_piece > 0 && it.unite === 'piece') {
        // Produit vendu à la pièce et compté à la pièce : direct.
        prix = rel.par_piece * it.aAcheter;
        source = 'reel';
      } else if (rel && rel.par_kg > 0) {
        // Prix relevé dans le magasin où l'on va commander : la meilleure source.
        const kg = it.unite === 'piece'
          ? (it.aAcheter * Catalogue.poidsPiece(it.nom_canonique)) / 1000
          : it.aAcheter / 1000;
        prix = rel.par_kg * kg;
        source = 'reel';
      } else if (rel && rel.par_piece > 0) {
        // Vendu à la pièce, besoin exprimé au poids : passer par le poids typique.
        const pieces = it.aAcheter / Catalogue.poidsPiece(it.nom_canonique);
        prix = rel.par_piece * pieces;
        source = 'reel';
      } else if (it.match && typeof it.match.prix_eur === 'number' && it.match.pack_quantite > 0) {
        prix = Math.ceil(it.aAcheter / it.match.pack_quantite) * it.match.prix_eur;
        source = 'reel';
      } else if (relevesUniquement) {
        prix = null;   // pas de prix relevé : on ne comble pas le trou
      } else {
        const ref = Catalogue.prixReference(it.nom_canonique);
        if (ref !== null) {
          // Les prix de référence sont au kilo : pour un ingrédient compté à
          // la pièce, il faut passer par le poids typique d'une unité.
          const kg = it.unite === 'piece'
            ? (it.aAcheter * Catalogue.poidsPiece(it.nom_canonique)) / 1000
            : it.aAcheter / 1000;
          prix = ref * kg;
          source = 'reference';
        }
      }

      if (prix === null) { details.push({ nom: it.nom_canonique, prix: null, source: 'inconnu' }); continue; }
      total += prix;
      if (source === 'reel') connus++; else estimes++;
      details.push({ nom: it.nom_canonique, prix: Math.round(prix * 100) / 100, source });
    }
    return { total: Math.round(total * 100) / 100, connus, estimes, details };
  }

  /* Payload consumed by the Chrome extension. When a 2nd delivery is
     recommended, at-risk items are tagged livraison 2. */
  function buildExport(items, plan, delivery, options) {
    const riskNames = new Set((delivery?.risks || []).map(r => r.nom_canonique));
    return {
      source: 'panier-repas',
      version: 2,
      genere_le: new Date().toISOString(),
      semaine: plan.semaine.date_debut,
      enseigne: options?.enseigne || null,
      pref_sante: options?.prefSante ?? 0.5,
      budget_max_article: options?.budgetMaxArticle || null,
      livraisons: (delivery?.livraisons || []).map(d => ({
        rang: d.rang, date: d.date, heure: d.heure, label: d.label
      })),
      articles: items
        .filter(it => it.aAcheter > 0)
        .map(it => ({
          nom_canonique: it.nom_canonique,
          quantite_besoin: it.aAcheter,
          unite: it.unite,
          libelle_produit: it.match?.libelle || null,
          ref: it.match?.ref || null,
          packs: it.packs || null,
          livraison: delivery?.frequence === 2 && riskNames.has(it.nom_canonique) ? 2 : 1,
          recherche: it.match?.libelle || it.nom_canonique
        }))
    };
  }

  /* After ordering: merge the purchased quantities back into home inventory. */
  function applyPurchaseToInventory(items, inventory, matches) {
    const inv = [...inventory];
    const byName = new Map(inv.map((i, idx) => [i.nom_canonique, idx]));
    const today = new Date();
    const DLC_DAYS = { tres_courte: 3, courte: 7, moyenne: 30, longue: 180 };

    for (const it of items) {
      if (it.aAcheter <= 0) continue;
      // Ce qui entre à la maison, c'est le contenu des packs achetés — pas le
      // besoin des recettes. La différence est précisément le reste.
      const cond = conditionnement(it.nom_canonique, matches);
      const bought = it.packs && it.match
        ? it.packs * it.match.pack_quantite
        : (cond && cond.unite === it.unite
            ? Math.ceil(it.aAcheter / cond.quantite) * cond.quantite
            : it.aAcheter);
      const days = DLC_DAYS[it.peremption_type] || 30;
      const dlc = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
      if (byName.has(it.nom_canonique)) {
        const existing = inv[byName.get(it.nom_canonique)];
        existing.quantite += bought;
        existing.dlc = dlc;
      } else {
        inv.push({ nom_canonique: it.nom_canonique, quantite: bought, unite: it.unite, dlc });
      }
    }
    return inv;
  }

  /* Delivery frequency recommendation.
     Assumes delivery the day before jour 1 (e.g. Sunday for a Monday start).
     An item is "at risk" when it's cooked later than its fresh shelf life. */
  const SHELF_DAYS = { tres_courte: 3, courte: 7, moyenne: 30, longue: 180 };
  const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

  function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* Pick the preferred slot landing latest at or before `maxOffset` days from
     the week start. Offsets: jour 1 (lundi) = 0 … jour 7 (dimanche) = 6, and
     the previous week's slots are offset - 7. Returns null when none fits. */
  function pickSlot(preferes, maxOffset) {
    if (!preferes || !preferes.length) return null;
    let best = null;
    for (const s of preferes) {
      for (const offset of [s.jour - 1 - 7, s.jour - 1]) {
        if (offset <= maxOffset && (best === null || offset > best.offset)) {
          best = { offset, jour: s.jour, heure: s.heure };
        }
      }
    }
    return best;
  }

  function recommendDelivery(plan, items, slots) {
    if (!(plan.planning || []).length) return null;
    const preferes = slots?.preferes || [];
    const start = plan.semaine.date_debut;

    // last day each ingredient is used
    const lastUseByIngredient = new Map();
    const recipesById = new Map(plan.recettes.map(r => [r.id, r]));
    for (const p of plan.planning) {
      const r = recipesById.get(p.recette_id);
      if (!r) continue;
      for (const ing of r.ingredients) {
        const prev = lastUseByIngredient.get(ing.nom_canonique) || 0;
        if (p.jour > prev) lastUseByIngredient.set(ing.nom_canonique, p.jour);
      }
    }

    const risks = [];
    for (const it of items) {
      if (it.aAcheter <= 0 || !it.peremption_type) continue;
      const shelf = SHELF_DAYS[it.peremption_type];
      const lastUse = lastUseByIngredient.get(it.nom_canonique);
      if (!lastUse || !shelf) continue;
      if (lastUse > shelf) {
        risks.push({
          nom_canonique: it.nom_canonique,
          lastUse,
          lastUseLabel: DAY_NAMES[lastUse - 1],
          shelf
        });
      }
    }

    // delivery 1: at or before the day preceding jour 1 (offset -1)
    const slot1 = pickSlot(preferes, -1);
    const d1 = {
      rang: 1,
      date: addDays(start, slot1 ? slot1.offset : -1),
      heure: slot1?.heure || null,
      label: slot1 ? `${DAY_NAMES[slot1.jour - 1]} ${slot1.heure}` : `${DAY_NAMES[6]} (veille)`
    };

    if (risks.length === 0) {
      return {
        frequence: 1,
        livraisons: [d1],
        texte: `1 livraison par semaine suffit — ${d1.label}, le ${d1.date}.`,
        risks: []
      };
    }
    // second delivery the day before the earliest risky use
    risks.sort((a, b) => a.lastUse - b.lastUse);
    const secondDay = Math.max(2, risks[0].lastUse - 1);
    const slot2 = pickSlot(preferes, secondDay - 1);
    const useSlot2 = slot2 && slot2.offset >= 0 && slot2.offset <= secondDay - 1;
    const d2 = {
      rang: 2,
      date: addDays(start, useSlot2 ? slot2.offset : secondDay - 1),
      heure: useSlot2 ? slot2.heure : null,
      label: useSlot2 ? `${DAY_NAMES[slot2.jour - 1]} ${slot2.heure}` : DAY_NAMES[secondDay - 1]
    };
    return {
      frequence: 2,
      secondDay,
      livraisons: [d1, d2],
      texte: `2 livraisons conseillées : ${d1.label} (${d1.date}) + ${d2.label} (${d2.date}).`,
      risks
    };
  }

  return { buildBasket, groupByRayon, totalEstime, estimerCout, conditionnement, analyserEmballages, chainageRestes, buildExport, applyPurchaseToInventory, recommendDelivery, fmtQty, RAYON_LABELS };
})();
