/* Weight sync (Cloudflare Worker fed by the iOS Shortcut) and kcal auto-adjust. */
const Health = (() => {
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

  return { syncWeights, weeklyTrend, adjustKcal };
})();
