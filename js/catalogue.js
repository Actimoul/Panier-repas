/* Supermarket-reality guardrails.
   The generator is free-form by nature; this module keeps it inside what a
   French hypermarket (Leclerc) actually stocks, and learns from the user:
   - VOCABULAIRE: baseline of ingredients reliably found in store
   - matches: products the user has already matched = proven available
   - unavailable: ingredients the user marked "introuvable" = banned */
const Catalogue = (() => {

  /* Baseline vocabulary, by rayon. Deliberately conservative: staples of a
     standard French hypermarket, no specialty-shop items. */
  const VOCABULAIRE = {
    fruits_legumes: [
      'pomme de terre', 'patate douce', 'carotte', 'oignon', 'échalote', 'ail',
      'tomate', 'tomate cerise', 'courgette', 'aubergine', 'poivron', 'brocoli',
      'chou-fleur', 'haricot vert', 'épinard', 'salade verte', 'roquette', 'concombre',
      'champignon de Paris', 'poireau', 'céleri', 'butternut', 'betterave',
      'citron', 'citron vert', 'orange', 'banane', 'pomme', 'poire', 'kiwi',
      'fraise', 'framboise', 'myrtille', 'raisin', 'avocat', 'mangue', 'ananas',
      'gingembre frais', 'persil', 'coriandre', 'basilic', 'menthe', 'ciboulette'
    ],
    boucherie: [
      'filet de poulet', 'cuisse de poulet', 'poulet entier', 'escalope de dinde',
      'boeuf haché 5%', 'boeuf haché 15%', 'steak de boeuf', 'bavette', 'rumsteck',
      'côte de porc', 'filet mignon de porc', 'échine de porc', 'lardons',
      'jambon blanc', 'jambon cru', 'saucisse', 'chipolata', 'merguez',
      'agneau (gigot)', 'côtelette d\'agneau', 'veau (escalope)', 'poulet rôti'
    ],
    poissonnerie: [
      'pavé de saumon', 'filet de cabillaud', 'filet de colin', 'truite',
      'dos de merlu', 'sardine', 'maquereau', 'crevette', 'moules', 'thon frais',
      'saumon fumé', 'noix de saint-jacques'
    ],
    cremerie_oeufs: [
      'oeuf', 'lait demi-écrémé', 'lait entier', 'crème fraîche épaisse',
      'crème liquide', 'beurre', 'yaourt nature', 'skyr nature', 'fromage blanc',
      'petit-suisse', 'emmental râpé', 'mozzarella', 'parmesan', 'feta',
      'chèvre frais', 'comté', 'gruyère', 'ricotta', 'mascarpone', 'crème de soja'
    ],
    epicerie_salee: [
      'riz basmati', 'riz long grain', 'riz arborio', 'pâtes (penne)',
      'pâtes (spaghetti)', 'pâtes (tagliatelles)', 'coquillettes', 'semoule de couscous',
      'boulgour', 'quinoa', 'lentille verte', 'lentille corail', 'pois chiche',
      'haricot rouge', 'haricot blanc', 'tomate concassée en conserve',
      'concentré de tomate', 'passata', 'thon en conserve', 'maïs en conserve',
      'lait de coco', 'bouillon de volaille (cube)', 'bouillon de légumes (cube)',
      'farine de blé', 'chapelure', 'polenta', 'nouilles chinoises', 'galette de blé',
      'pain de mie', 'tortilla de blé', 'olive verte', 'olive noire', 'cornichon'
    ],
    epicerie_sucree: [
      'flocons d\'avoine', 'muesli', 'sucre en poudre', 'miel', 'confiture',
      'chocolat noir', 'chocolat au lait', 'cacao en poudre', 'amande',
      'noix', 'noisette', 'cajou', 'raisin sec', 'datte', 'beurre de cacahuète',
      'compote de pomme', 'levure chimique', 'sucre vanillé'
    ],
    surgeles: [
      'haricot vert surgelé', 'brocoli surgelé', 'épinard surgelé',
      'poêlée de légumes surgelée', 'petit pois surgelé', 'ratatouille surgelée',
      'filet de poisson surgelé', 'crevette surgelée', 'fruit rouge surgelé',
      'frite surgelée', 'pomme dauphine surgelée'
    ],
    boulangerie: [
      'baguette', 'pain complet', 'pain de campagne', 'pain burger',
      'pâte brisée', 'pâte feuilletée', 'pâte à pizza', 'wrap'
    ],
    boissons: [
      'jus d\'orange', 'jus de pomme', 'eau gazeuse', 'lait d\'amande',
      'lait de soja', 'lait d\'avoine'
    ],
    condiments_epices: [
      'huile d\'olive', 'huile de tournesol', 'huile de sésame', 'vinaigre balsamique',
      'vinaigre de cidre', 'sauce soja', 'moutarde', 'ketchup', 'mayonnaise',
      'sel', 'poivre', 'paprika', 'paprika fumé', 'curry', 'cumin', 'curcuma',
      'herbes de Provence', 'thym', 'laurier', 'origan', 'piment d\'Espelette',
      'cannelle', 'muscade', 'gingembre moulu', 'ras el-hanout', 'sauce tomate',
      'pâte de curry', 'sauce nuoc-mâm', 'tahini', 'harissa'
    ]
  };

  const CUISINES = [
    'française', 'italienne', 'méditerranéenne', 'asiatique', 'indienne',
    'mexicaine', 'moyen-orientale', 'américaine', 'nord-africaine'
  ];

  /* Variety levels: how much repetition is acceptable across the week.
     maxRepetitions = how many times one recipe may appear in the planning. */
  const VARIETES = {
    batch: {
      label: 'Batch cooking (peu de vaisselle)',
      desc: 'peu de recettes, cuisinées en grande quantité — économique et rapide',
      maxRepetitions: 4, recettesMin: 5, recettesMax: 7
    },
    equilibre: {
      label: 'Équilibré',
      desc: 'chaque plat revient au plus 2 fois, ingrédients partagés entre recettes',
      maxRepetitions: 2, recettesMin: 8, recettesMax: 11
    },
    maxi: {
      label: 'Variété maximale',
      desc: 'un plat différent à chaque repas — plus de préparation',
      maxRepetitions: 1, recettesMin: 12, recettesMax: 16
    }
  };

  const COMPLEXITES = {
    express: { label: 'Express (≤ 20 min)', max_min: 20, desc: 'peu d\'étapes, une seule poêle/casserole, pas de four long' },
    simple: { label: 'Simple (≤ 40 min)', max_min: 40, desc: 'techniques de base, jusqu\'à 8 étapes' },
    elabore: { label: 'Élaboré (≤ 90 min)', max_min: 90, desc: 'plusieurs cuissons, marinades, sauces montées, dressage soigné' }
  };

  function flat() {
    return Object.values(VOCABULAIRE).flat();
  }

  /* Compact vocabulary block for the system prompt. */
  function promptBlock(matches, unavailable) {
    const proven = Object.keys(matches || {});
    const banned = unavailable || [];
    const lines = Object.entries(VOCABULAIRE)
      .map(([rayon, list]) => `${rayon}: ${list.join(', ')}`)
      .join('\n');
    let block = `CATALOGUE DISPONIBLE (hypermarché français type Leclerc) :\n${lines}`;
    if (proven.length) {
      block += `\n\nDÉJÀ ASSOCIÉS À UN PRODUIT EN RAYON (réutilise ces noms exacts en priorité absolue) : ${proven.join(', ')}`;
    }
    if (banned.length) {
      block += `\n\nINTROUVABLES EN MAGASIN — INTERDITS : ${banned.join(', ')}`;
    }
    return block;
  }

  /* Normalize for comparison: lowercase, strip accents, singularize words.
     "haricots verts surgelés" and "haricot vert surgelé" must match. */
  function norm(s) {
    return s
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
      .join(' ');
  }

  /* Post-generation check: which ingredients fall outside what we know is
     available? Returns the list of suspicious nom_canonique. */
  function suspects(plan, matches, unavailable) {
    const known = new Set([
      ...flat().map(norm),
      ...Object.keys(matches || {}).map(norm)
    ]);
    const banned = new Set((unavailable || []).map(norm));
    const out = new Set();
    for (const r of plan.recettes || []) {
      for (const ing of r.ingredients || []) {
        const n = norm(ing.nom_canonique);
        if (banned.has(n)) { out.add(ing.nom_canonique); continue; }
        if (known.has(n)) continue;
        // tolerate close variants: "tomate cerise" vs "tomate"
        const loose = [...known].some(k => n.includes(k) || k.includes(n));
        if (!loose) out.add(ing.nom_canonique);
      }
    }
    return [...out];
  }

  return { VOCABULAIRE, CUISINES, COMPLEXITES, VARIETES, flat, promptBlock, suspects };
})();
