/* Lightweight validator for PlanSemaine v1.0 (no external deps).
   Returns { valid: boolean, errors: string[] }. Mirrors the JSON Schema
   shipped in js/plan-semaine.schema.json — keep them in sync. */
const PlanSchema = (() => {
  const UNITS = ['g', 'ml', 'piece'];
  const RAYONS = [
    'fruits_legumes', 'boucherie', 'poissonnerie', 'cremerie_oeufs',
    'epicerie_salee', 'epicerie_sucree', 'surgeles', 'boulangerie',
    'boissons', 'condiments_epices'
  ];
  const REPAS = ['petit_dejeuner', 'dejeuner', 'collation', 'diner'];

  function validate(plan) {
    const errors = [];
    const push = (msg) => errors.push(msg);

    if (!plan || typeof plan !== 'object') {
      return { valid: false, errors: ['plan is not an object'] };
    }
    if (plan.version !== '1.0') push('version must be "1.0"');
    if (!plan.semaine || !/^\d{4}-\d{2}-\d{2}$/.test(plan.semaine.date_debut || '')) {
      push('semaine.date_debut must be YYYY-MM-DD');
    }
    if (!Array.isArray(plan.recettes) || plan.recettes.length === 0) {
      push('recettes must be a non-empty array');
      return { valid: false, errors };
    }

    const ids = new Set();
    plan.recettes.forEach((r, i) => {
      const where = `recettes[${i}]`;
      if (!r.id || !/^r-[a-z0-9-]+$/.test(r.id)) push(`${where}.id invalid (pattern r-[a-z0-9-]+)`);
      if (ids.has(r.id)) push(`${where}.id duplicated: ${r.id}`);
      ids.add(r.id);
      if (!r.nom) push(`${where}.nom missing`);
      if (!Number.isInteger(r.portions) || r.portions < 1) push(`${where}.portions must be integer >= 1`);
      const m = r.macros_par_portion;
      if (!m || ['kcal', 'proteines_g', 'glucides_g', 'lipides_g'].some(k => typeof m[k] !== 'number')) {
        push(`${where}.macros_par_portion incomplete`);
      }
      if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) {
        push(`${where}.ingredients must be non-empty`);
      } else {
        r.ingredients.forEach((ing, j) => {
          const w = `${where}.ingredients[${j}]`;
          if (!ing.nom_canonique) push(`${w}.nom_canonique missing`);
          if (!(typeof ing.quantite === 'number') || ing.quantite <= 0) push(`${w}.quantite must be > 0`);
          if (!UNITS.includes(ing.unite)) push(`${w}.unite must be one of ${UNITS.join('/')}`);
          if (!RAYONS.includes(ing.rayon)) push(`${w}.rayon invalid: ${ing.rayon}`);
        });
      }
      if (!Array.isArray(r.etapes) || r.etapes.length === 0) push(`${where}.etapes must be non-empty`);
    });

    if (plan.planning) {
      if (!Array.isArray(plan.planning)) {
        push('planning must be an array');
      } else {
        plan.planning.forEach((p, i) => {
          if (!ids.has(p.recette_id)) push(`planning[${i}].recette_id unknown: ${p.recette_id}`);
          if (p.portions !== undefined && !(typeof p.portions === 'number' && p.portions > 0)) {
            push(`planning[${i}].portions must be a number > 0`);
          }
          if (!Number.isInteger(p.jour) || p.jour < 1 || p.jour > 7) push(`planning[${i}].jour must be 1-7`);
          if (!REPAS.includes(p.repas)) push(`planning[${i}].repas invalid: ${p.repas}`);
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /* Variety audit, separate from schema validity: a repetitive plan is
     valid JSON but a bad week.
     Main meals (lunch/dinner) carry the strict rules; breakfast and snacks
     are allowed to repeat — nobody minds eating the same porridge twice.
     Returns { ok, problemes[] }. */
  const REPAS_PRINCIPAUX = ['dejeuner', 'diner'];

  function auditVariete(plan, maxRepetitions) {
    const problemes = [];
    const noms = Object.fromEntries((plan.recettes || []).map(r => [r.id, r.nom]));
    const planning = plan.planning || [];

    // 1. repetition ceiling, per meal category
    const counts = new Map();   // "recette|categorie" -> n
    for (const p of planning) {
      const cat = REPAS_PRINCIPAUX.includes(p.repas) ? 'principal' : 'secondaire';
      const key = `${p.recette_id}|${cat}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, n] of counts) {
      const [id, cat] = key.split('|');
      const plafond = cat === 'principal' ? maxRepetitions : Math.max(3, maxRepetitions * 2);
      if (n > plafond) {
        problemes.push(`« ${noms[id] || id} » revient ${n} fois en ${cat === 'principal' ? 'plat principal' : 'petit-déj/collation'} (maximum ${plafond})`);
      }
    }

    // 2. same main dish two days running on the same slot
    const bySlot = new Map();
    for (const p of planning) bySlot.set(`${p.repas}|${p.jour}`, p.recette_id);
    for (const p of planning) {
      if (!REPAS_PRINCIPAUX.includes(p.repas)) continue;
      if (bySlot.get(`${p.repas}|${p.jour - 1}`) === p.recette_id) {
        problemes.push(`« ${noms[p.recette_id] || p.recette_id} » deux jours de suite au ${p.repas}`);
      }
    }

    // 3. enough distinct main dishes overall
    const principaux = new Set(planning.filter(p => REPAS_PRINCIPAUX.includes(p.repas)).map(p => p.recette_id));
    const creneauxPrincipaux = planning.filter(p => REPAS_PRINCIPAUX.includes(p.repas)).length;
    if (creneauxPrincipaux >= 6 && principaux.size < Math.ceil(creneauxPrincipaux / maxRepetitions)) {
      problemes.push(`seulement ${principaux.size} plats principaux distincts pour ${creneauxPrincipaux} repas`);
    }

    return { ok: problemes.length === 0, problemes: [...new Set(problemes)] };
  }

  return { validate, auditVariete };
})();
