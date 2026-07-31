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

  return { validate };
})();
