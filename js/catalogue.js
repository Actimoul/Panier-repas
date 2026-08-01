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

  /* Reference prices, € per kg / L / unit, French hypermarket, mid-range.
     Only a fallback for ingredients the user has never bought: as soon as a
     product is associated, its real price takes over. Orders of magnitude,
     deliberately rounded — enough to keep a budget estimate honest. */
  const PRIX_REFERENCE = {
    // fruits & légumes (€/kg sauf mention)
    'pomme de terre': 1.5, 'patate douce': 3.0, 'carotte': 1.5, 'oignon': 1.8,
    'echalote': 4.5, 'ail': 9.0, 'tomate': 3.0, 'tomate cerise': 6.0,
    'courgette': 2.5, 'aubergine': 3.0, 'poivron': 4.0, 'brocoli': 3.5,
    'chou-fleur': 3.0, 'haricot vert': 6.0, 'epinard': 5.0, 'salade verte': 2.0,
    'concombre': 2.5, 'champignon de paris': 5.0, 'poireau': 3.0, 'butternut': 2.5,
    'citron': 3.5, 'orange': 2.5, 'banane': 2.0, 'pomme': 2.5, 'poire': 3.0,
    'kiwi': 4.0, 'fraise': 8.0, 'avocat': 6.0, 'gingembre frais': 12.0,
    'persil': 20.0, 'coriandre': 20.0, 'basilic': 25.0, 'menthe': 25.0, 'ciboulette': 25.0,
    // boucherie
    'filet de poulet': 12.0, 'cuisse de poulet': 6.0, 'poulet entier': 6.5,
    'escalope de dinde': 11.0, 'boeuf hache 5%': 13.0, 'boeuf hache 15%': 9.0,
    'steak de boeuf': 18.0, 'bavette': 17.0, 'cote de porc': 8.0,
    'filet mignon de porc': 13.0, 'echine de porc': 8.0, 'lardons': 10.0,
    'jambon blanc': 12.0, 'saucisse': 9.0, 'merguez': 11.0,
    // poissonnerie
    'pave de saumon': 22.0, 'filet de cabillaud': 18.0, 'filet de colin': 12.0,
    'truite': 14.0, 'sardine': 8.0, 'maquereau': 8.0, 'crevette': 18.0,
    // crèmerie
    'oeuf': 5.8, 'lait demi-ecreme': 1.1, 'lait entier': 1.2,
    'creme fraiche epaisse': 5.0, 'creme liquide': 3.5, 'beurre': 10.0,
    'yaourt nature': 2.0, 'skyr nature': 5.5, 'fromage blanc': 3.0,
    'emmental rape': 9.0, 'mozzarella': 8.0, 'parmesan': 20.0, 'feta': 11.0,
    'chevre frais': 12.0, 'comte': 18.0, 'ricotta': 7.0,
    // épicerie salée
    'riz basmati': 3.0, 'riz long grain': 2.2, 'pates (penne)': 2.0,
    'pates (spaghetti)': 2.0, 'coquillettes': 1.8, 'semoule de couscous': 2.2,
    'boulgour': 3.0, 'quinoa': 7.0, 'lentille verte': 3.5, 'lentille corail': 4.0,
    'pois chiche': 2.5, 'haricot rouge': 2.5, 'tomate concassee en conserve': 1.8,
    'concentre de tomate': 5.0, 'passata': 2.0, 'thon en conserve': 12.0,
    'mais en conserve': 3.0, 'lait de coco': 3.0, 'farine de ble': 1.2,
    // épicerie sucrée
    "flocons d'avoine": 2.0, 'muesli': 4.0, 'sucre en poudre': 1.2, 'miel': 12.0,
    'confiture': 4.0, 'chocolat noir': 12.0, 'amande': 16.0, 'noix': 14.0,
    'noisette': 18.0, 'cajou': 16.0, 'raisin sec': 6.0, 'datte': 8.0,
    'beurre de cacahuete': 8.0, 'compote de pomme': 2.5,
    // surgelés
    'haricot vert surgele': 2.5, 'brocoli surgele': 2.5, 'epinard surgele': 2.0,
    'poelee de legumes surgelee': 3.0, 'petit pois surgele': 2.5,
    'filet de poisson surgele': 12.0, 'crevette surgelee': 15.0, 'fruit rouge surgele': 7.0,
    // boulangerie & divers
    'baguette': 4.4, 'pain complet': 3.0, 'pate brisee': 8.7, 'pate feuilletee': 9.5,
    "huile d'olive": 9.0, 'huile de tournesol': 2.5, 'sauce soja': 6.0,
    'moutarde': 4.0, 'vinaigre balsamique': 6.0
  };

  /* Typical unit weight, grams. Without this, a €/kg price applied to a
     count gives nonsense: 2 heads of garlic are 120 g, not 2 kg. */
  const POIDS_PIECE = {
    'ail': 60, 'oignon': 130, 'echalote': 30, 'citron': 110, 'citron vert': 70,
    'orange': 180, 'banane': 120, 'pomme': 160, 'poire': 170, 'kiwi': 90,
    'avocat': 180, 'mangue': 350, 'tomate': 130, 'courgette': 250,
    'aubergine': 300, 'poivron': 160, 'concombre': 350, 'carotte': 90,
    'pomme de terre': 150, 'patate douce': 250, 'poireau': 200,
    'oeuf': 60, 'pave de saumon': 130, 'filet de poulet': 150,
    'escalope de dinde': 120, 'cote de porc': 180, 'baguette': 250,
    'pate brisee': 230, 'pate feuilletee': 230, 'mozzarella': 125
  };

  function poidsPiece(nomCanonique) {
    const n = nomCanonique.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (POIDS_PIECE[n] !== undefined) return POIDS_PIECE[n];
    const cle = Object.keys(POIDS_PIECE).find(k => n.includes(k) || k.includes(n));
    return cle ? POIDS_PIECE[cle] : 150;   // défaut prudent
  }

  /* €/kg (or €/L, or €/unit for countable items) for one ingredient. */
  function prixReference(nomCanonique) {
    const n = nomCanonique.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (PRIX_REFERENCE[n] !== undefined) return PRIX_REFERENCE[n];
    const cle = Object.keys(PRIX_REFERENCE).find(k => n.includes(k) || k.includes(n));
    return cle ? PRIX_REFERENCE[cle] : null;
  }

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

  return { VOCABULAIRE, CUISINES, COMPLEXITES, VARIETES, PRIX_REFERENCE, prixReference, poidsPiece, flat, promptBlock, suspects };
})();
