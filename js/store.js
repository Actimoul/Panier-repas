/* Centralized localStorage store. Every persisted key lives here. */
const Store = (() => {
  const KEYS = {
    settings: 'pr.settings',      // { apiKey, model, workerUrl, workerSecret }
    profile: 'pr.profile',        // profile object incl. convives + presence
    plan: 'pr.plan',              // last generated PlanSemaine
    inventory: 'pr.inventory',    // [{ nom_canonique, quantite, unite, dlc? }]
    matches: 'pr.matches',        // { [nom_canonique]: { libelle, ref, pack_quantite, pack_unite, prix_eur } }
    weights: 'pr.weights',        // [{ date: 'YYYY-MM-DD', kg: number }]
    unavailable: 'pr.unavailable', // [nom_canonique] marked "introuvable en magasin"
    slots: 'pr.slots',            // { preferes: [{ jour: 1-7, heure: 'HH:MM' }], historique: [...] }
    prix: 'pr.prix'               // { enseigne, date, prix: { nom: { par_kg, libelle, ... } } }
  };

  const REPAS_TYPES = ['petit_dejeuner', 'dejeuner', 'collation', 'diner'];

  function defaultPresence(convives) {
    // every convive present at every meal by default
    const ids = convives.map(c => c.id);
    const presence = {};
    for (let jour = 1; jour <= 7; jour++) {
      presence[jour] = {};
      for (const repas of REPAS_TYPES) presence[jour][repas] = [...ids];
    }
    return presence;
  }

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.error(`Store read failed for ${key}:`, err);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error(`Store write failed for ${key}:`, err);
      throw err; // never swallow: caller shows a toast
    }
  }

  function personneVide(id, nom) {
    return {
      id, nom,
      age: null, sexe: 'homme', poids_kg: null, taille_cm: null,
      activite: 'peu_actif',
      objectif: null,                     // null = suit l'objectif du foyer
      sport: { seances_par_semaine: 0, intensite: 'moderee', jours: [] },
      exclusions: [],                     // interdits (allergie, régime)
      deteste: [],                        // simples dégoûts
      coefficient: null                   // null = dérivé des besoins
    };
  }

  function defaultProfile() {
    const convives = [personneVide('moi', 'Moi')];
    return {
      objectif: 'prise_de_muscle',
      nb_personnes: 1,
      repas_par_jour: 4,
      kcal_cible_jour: 2800,
      proteines_cible_jour_g: 160,
      budget_hebdo_eur: 75,
      exclusions: [],
      preferences_libres: '',
      complexite: 'simple',
      variete: 'equilibre',   // batch | equilibre | maxi
      cuisines: [],
      metrics: { poids_kg: null, taille_cm: null, age: null, sexe: 'homme', activite: 'peu_actif' },
      cibles_auto: true,
      plats_refuses: [],      // plats explicitement rejetés, à ne plus proposer
      convives,
      presence: defaultPresence(convives)
    };
  }

  return {
    REPAS_TYPES,
    defaultPresence,
    personneVide,

    getSettings: () => ({
      apiKey: '', model: 'claude-sonnet-5', workerUrl: '', workerSecret: '',
      prefSante: 0.5, budgetMaxArticle: null, enseigne: 'intermarche',
      prixRelevesUniquement: false,   // n'afficher que les prix venus du magasin
      ...read(KEYS.settings, {})
    }),
    setSettings: (s) => write(KEYS.settings, s),

    getProfile: () => {
      const stored = read(KEYS.profile, {});
      const p = { ...defaultProfile(), ...stored };
      // migration: older profiles have no convives/presence
      if (!Array.isArray(p.convives) || p.convives.length === 0) {
        p.convives = [personneVide('moi', 'Moi')];
      }
      // migration: convives created before v1.6 lack metrics/sport/restrictions
      p.convives = p.convives.map((c, i) => ({
        ...personneVide(c.id || `c${i}`, c.nom || 'Convive'),
        ...c,
        sport: { seances_par_semaine: 0, intensite: 'moderee', jours: [], ...(c.sport || {}) },
        exclusions: c.exclusions || [],
        deteste: c.deteste || []
      }));
      // the main adult inherits the legacy top-level metrics
      if (p.convives[0] && !p.convives[0].age && p.metrics?.age) {
        p.convives[0] = { ...p.convives[0], ...p.metrics };
      }
      if (!p.presence || typeof p.presence !== 'object') {
        p.presence = defaultPresence(p.convives);
      }
      // migration: older profiles have no body metrics
      if (!Array.isArray(p.plats_refuses)) p.plats_refuses = [];
      p.metrics = {
        poids_kg: null, taille_cm: null, age: null, sexe: 'homme', activite: 'peu_actif',
        ...(p.metrics || {})
      };
      return p;
    },
    setProfile: (p) => write(KEYS.profile, p),

    getPlan: () => read(KEYS.plan, null),
    setPlan: (p) => write(KEYS.plan, p),

    getInventory: () => read(KEYS.inventory, []),
    setInventory: (inv) => write(KEYS.inventory, inv),

    getMatches: () => read(KEYS.matches, {}),
    setMatches: (m) => write(KEYS.matches, m),

    getWeights: () => read(KEYS.weights, []),
    setWeights: (w) => write(KEYS.weights, w),

    getSlots: () => ({ preferes: [], historique: [], ...read(KEYS.slots, {}) }),
    setSlots: (s) => write(KEYS.slots, s),

    getPrix: () => read(KEYS.prix, null),
    setPrix: (p) => write(KEYS.prix, p),

    getUnavailable: () => read(KEYS.unavailable, []),
    setUnavailable: (u) => write(KEYS.unavailable, u)
  };
})();
