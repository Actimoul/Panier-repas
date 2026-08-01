/* Weight sync (Cloudflare Worker fed by the iOS Shortcut) and kcal auto-adjust. */
const Health = (() => {

  /* --- Targets from body metrics (Mifflin-St Jeor + activity + goal) --- */

  /* Daily-life activity only — NOT training. Sport is counted separately
     (sessions × intensity), so describing it here would double-count it.
     Factors are therefore lower than the classic Harris-Benedict ladder,
     which bundles exercise into the multiplier. */
  const ACTIVITES = {
    sedentaire: { label: 'Assis toute la journée (bureau, télétravail, voiture)', facteur: 1.2 },
    peu_actif: { label: 'Un peu de marche (trajets à pied, quelques déplacements)', facteur: 1.3 },
    actif: { label: 'Debout ou en mouvement une bonne partie du temps', facteur: 1.45 },
    physique: { label: 'Métier physique (chantier, manutention, soins)', facteur: 1.6 },
    tres_physique: { label: 'Métier très physique (port de charges toute la journée)', facteur: 1.75 }
  };

  /* Older profiles used the exercise-based ladder; map them onto the new one. */
  const ACTIVITES_MIGRATION = {
    leger: 'peu_actif', modere: 'actif', intense: 'physique', tres_intense: 'tres_physique'
  };
  function migrerActivite(a) {
    return ACTIVITES[a] ? a : (ACTIVITES_MIGRATION[a] || 'peu_actif');
  }

  /* Goal adjustment on maintenance calories, and protein per kg bodyweight. */
  const OBJECTIF_REGLAGE = {
    prise_de_muscle: { kcalPct: 0.12, protParKg: 2.0 },
    maintien: { kcalPct: 0, protParKg: 1.6 },
    perte_de_poids: { kcalPct: -0.18, protParKg: 2.2 },
    equilibre: { kcalPct: 0, protParKg: 1.4 }
  };

  /* Mifflin-St Jeor basal metabolic rate. sexe: 'homme' | 'femme'. */
  function bmr({ poids_kg, taille_cm, age, sexe }) {
    const base = 10 * poids_kg + 6.25 * taille_cm - 5 * age;
    return sexe === 'femme' ? base - 161 : base + 5;
  }

  /* Returns { bmr, maintenance, kcal, proteines_g } or null if metrics
     are incomplete. Values are rounded to usable numbers. */
  function computeTargets(metrics, objectif) {
    if (!metrics) return null;
    const { poids_kg, taille_cm, age, sexe, activite } = metrics;
    if (!(poids_kg > 0 && taille_cm > 0 && age > 0)) return null;

    const b = bmr({ poids_kg, taille_cm, age, sexe: sexe || 'homme' });
    const facteur = ACTIVITES[migrerActivite(activite)].facteur;
    const maintenance = b * facteur;
    const reglage = OBJECTIF_REGLAGE[objectif] || OBJECTIF_REGLAGE.maintien;
    const kcal = Math.round((maintenance * (1 + reglage.kcalPct)) / 10) * 10;
    const proteines_g = Math.round(poids_kg * reglage.protParKg / 5) * 5;
    return {
      bmr: Math.round(b),
      maintenance: Math.round(maintenance / 10) * 10,
      kcal,
      proteines_g
    };
  }

  /* Extra calories burned per training session, by intensity.
     Applied as a weekly average spread over the week. */
  const SPORT_KCAL = { legere: 250, moderee: 400, intense: 600 };

  /* Children: Mifflin-St Jeor is unreliable under ~18. Use published
     average daily needs (ANSES/PNNS) scaled by activity instead. */
  function besoinEnfant(age, sexe, facteur) {
    let base;
    if (age <= 3) base = 1100;
    else if (age <= 6) base = 1400;
    else if (age <= 9) base = 1700;
    else if (age <= 12) base = 2000;
    else if (age <= 15) base = sexe === 'femme' ? 2200 : 2500;
    else base = sexe === 'femme' ? 2300 : 2800;
    // facteur 1.2..1.75 → moduler autour de la référence « actif » (1.45)
    return Math.round(base * (1 + (facteur - 1.45) * 0.35) / 10) * 10;
  }

  /* Daily needs for one person.
     person: { age, sexe, poids_kg, taille_cm, activite, objectif?, sport? }
     sport: { seances_par_semaine, intensite }
     Returns { kcal, proteines_g, estEnfant } or null if metrics missing. */
  function besoinsPersonne(person, objectifParDefaut) {
    if (!person || !(person.age > 0)) return null;
    const facteur = ACTIVITES[migrerActivite(person.activite)].facteur;
    const sport = person.sport || {};
    const seances = Math.max(0, Number(sport.seances_par_semaine) || 0);
    const kcalSport = Math.round(seances * (SPORT_KCAL[sport.intensite] || SPORT_KCAL.moderee) / 7);

    if (person.age < 18) {
      const kcal = Math.round((besoinEnfant(person.age, person.sexe, facteur) + kcalSport) / 10) * 10;
      const poids = person.poids_kg || null;
      return {
        kcal,
        proteines_g: poids ? Math.round(poids * 1.2 / 5) * 5 : Math.round(kcal * 0.16 / 4 / 5) * 5,
        kcalSport,
        estEnfant: true
      };
    }

    if (!(person.poids_kg > 0 && person.taille_cm > 0)) return null;
    const b = bmr({ poids_kg: person.poids_kg, taille_cm: person.taille_cm, age: person.age, sexe: person.sexe || 'homme' });
    const maintenance = b * facteur + kcalSport;
    const objectif = person.objectif || objectifParDefaut || 'maintien';
    const reglage = OBJECTIF_REGLAGE[objectif] || OBJECTIF_REGLAGE.maintien;
    return {
      kcal: Math.round((maintenance * (1 + reglage.kcalPct)) / 10) * 10,
      proteines_g: Math.round(person.poids_kg * reglage.protParKg / 5) * 5,
      maintenance: Math.round(maintenance / 10) * 10,
      bmr: Math.round(b),
      kcalSport,
      estEnfant: false
    };
  }

  /* Portion coefficient of a convive relative to the main adult (index 0). */
  function coefficientDerive(person, reference, objectifParDefaut) {
    const a = besoinsPersonne(person, objectifParDefaut);
    const r = besoinsPersonne(reference, objectifParDefaut);
    if (!a || !r || !r.kcal) return null;
    return Math.round((a.kcal / r.kcal) * 20) / 20; // 0.05 steps
  }

  /* --- Weight sync (Cloudflare Worker fed by the iOS Shortcut) --- */

  /* Fetch recent weights from the Worker. Non-blocking: on failure, returns
     the locally cached list and reports the error to the caller. */
  async function syncWeights() {
    const { workerUrl, workerSecret } = Store.getSettings();
    if (!workerUrl) return { weights: Store.getWeights(), synced: false };
    const url = `${workerUrl.replace(/\/$/, '')}/weights`;
    const res = await fetch(url, { headers: { 'X-Secret': workerSecret } });
    if (!res.ok) throw new Error(`Worker ${res.status}`);
    const weights = await res.json();
    if (!Array.isArray(weights)) throw new Error('Worker: réponse inattendue');
    weights.sort((a, b) => a.date.localeCompare(b.date));
    Store.setWeights(weights);
    return { weights, synced: true };
  }

  /* Weekly trend in kg/week over the last ~21 days (simple linear regression). */
  function weeklyTrend(weights) {
    const cutoff = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
    const pts = weights.filter(w => w.date >= cutoff);
    if (pts.length < 3) return null;
    const xs = pts.map(w => new Date(w.date).getTime() / 86400000);
    const ys = pts.map(w => w.kg);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (den === 0) return null;
    return (num / den) * 7; // kg per week
  }

  /* Returns { kcal, delta, reason, trend } — kcal adjusted from the goal + trend. */
  function adjustKcal(profile, weights) {
    const base = profile.kcal_cible_jour;
    const trend = weeklyTrend(weights);
    if (trend === null) return { kcal: base, delta: 0, reason: null, trend: null };

    let delta = 0, reason = null;
    if (profile.objectif === 'prise_de_muscle') {
      if (trend < 0.1) { delta = 150; reason = 'poids stable/descendant → +150 kcal'; }
      else if (trend > 0.5) { delta = -100; reason = 'prise trop rapide → −100 kcal'; }
    } else if (profile.objectif === 'perte_de_poids') {
      if (trend > -0.1) { delta = -150; reason = 'poids stable/montant → −150 kcal'; }
      else if (trend < -1.0) { delta = 150; reason = 'perte trop rapide → +150 kcal'; }
    } else {
      if (trend > 0.3) { delta = -100; reason = 'poids en hausse → −100 kcal'; }
      else if (trend < -0.3) { delta = 100; reason = 'poids en baisse → +100 kcal'; }
    }
    return { kcal: base + delta, delta, reason, trend };
  }

  return { syncWeights, weeklyTrend, adjustKcal, computeTargets, besoinsPersonne, coefficientDerive, bmr, migrerActivite, ACTIVITES, SPORT_KCAL };
})();
