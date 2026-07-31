/* Product selection engine: picks the best value-for-money product among
   candidates harvested from the Leclerc site.

   Two axes, weighted by the user's preference slider (0 = prix, 1 = santé):
   - PRICE: price per kg/L/unit, normalized against the candidate set
   - HEALTH: Nutri-Score, NOVA processing group, additive count, organic label,
     ingredient list length — sourced from Open Food Facts when an EAN is known,
     with label-based fallbacks otherwise.

   Shared verbatim by the PWA and the browser extension. */
const Scoring = (() => {

  const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product/';
  const OFF_FIELDS = 'product_name,brands,quantity,nutriscore_grade,nova_group,additives_n,ingredients_n,labels_tags,nutriments';

  const NUTRISCORE_POINTS = { a: 100, b: 78, c: 55, d: 30, e: 8 };
  const NOVA_POINTS = { 1: 100, 2: 78, 3: 45, 4: 10 };

  /* --- Open Food Facts lookup (no key, no signup) ------------------ */

  const cache = new Map();

  async function fetchOFF(ean) {
    if (!ean) return null;
    const code = String(ean).replace(/\D/g, '');
    if (code.length < 8) return null;
    if (cache.has(code)) return cache.get(code);
    try {
      const res = await fetch(`${OFF_BASE}${code}.json?fields=${OFF_FIELDS}`);
      if (!res.ok) { cache.set(code, null); return null; }
      const data = await res.json();
      const product = data.status === 1 ? data.product : null;
      cache.set(code, product);
      return product;
    } catch (err) {
      console.warn('Open Food Facts indisponible pour', code, err.message);
      cache.set(code, null);
      return null;
    }
  }

  /* Enrich candidates in place with their Open Food Facts record.
     Sequential with a small delay: the API is free, we stay polite. */
  async function enrich(candidates, onProgress) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.ean && !c.off) {
        c.off = await fetchOFF(c.ean);
        await new Promise(r => setTimeout(r, 120));
      }
      onProgress?.(i + 1, candidates.length);
    }
    return candidates;
  }

  /* --- Normalization ---------------------------------------------- */

  /* Extract the pack size in a comparable base unit (g, ml or piece).
     Reads an explicit field first, then falls back to parsing the label. */
  function packSize(candidate) {
    if (candidate.pack_quantite > 0 && candidate.pack_unite) {
      return { quantite: candidate.pack_quantite, unite: candidate.pack_unite };
    }
    const src = `${candidate.quantite_texte || ''} ${candidate.libelle || ''}`.toLowerCase();
    // "2x300g", "1,5 l", "500 g", "x12"
    const mult = src.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)/);
    if (mult) {
      const n = parseInt(mult[1], 10);
      const v = parseFloat(mult[2].replace(',', '.'));
      return toBase(n * v, mult[3]);
    }
    const single = src.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/);
    if (single) return toBase(parseFloat(single[1].replace(',', '.')), single[2]);
    const pieces = src.match(/[x×]\s*(\d+)\b/);
    if (pieces) return { quantite: parseInt(pieces[1], 10), unite: 'piece' };
    return null;
  }

  function toBase(value, unit) {
    switch (unit) {
      case 'kg': return { quantite: value * 1000, unite: 'g' };
      case 'g': return { quantite: value, unite: 'g' };
      case 'l': return { quantite: value * 1000, unite: 'ml' };
      case 'cl': return { quantite: value * 10, unite: 'ml' };
      case 'ml': return { quantite: value, unite: 'ml' };
      default: return null;
    }
  }

  /* Price per kg / L / unit — the only fair way to compare packs. */
  function unitPrice(candidate) {
    if (candidate.prix_par_kg > 0) return candidate.prix_par_kg;
    const size = packSize(candidate);
    if (!size || !(candidate.prix_eur > 0)) return null;
    if (size.unite === 'piece') return candidate.prix_eur / size.quantite;
    return candidate.prix_eur / (size.quantite / 1000); // € per kg or L
  }

  /* --- Health score ------------------------------------------------ */

  /* JS word boundaries break on accented characters ("pané\b" never matches),
     so labels are de-accented before any heuristic test. */
  function deaccent(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /* 0-100. Uses Open Food Facts when available, otherwise falls back to
     label heuristics so that raw produce (no barcode) isn't penalized. */
  function healthScore(candidate) {
    const off = candidate.off;
    const label = deaccent(`${candidate.libelle || ''} ${candidate.marque || ''}`);
    const isBio = /\bbio\b|organic/.test(label) || (off?.labels_tags || []).some(t => /organic|bio/.test(t));

    if (!off) {
      // Unpackaged fresh produce: usually the healthiest option available.
      const brut = /\b(frais|fraiche|entier|filet|pave|escalope|cru|nature|brut)\b/.test(label);
      const transforme = /\b(pane|frit|nugget|cordon|sauce|creme|sucre|confit|fume|marine|prepare|surgele\s+pret)\b/.test(label);
      let base = brut ? 72 : 50;
      if (isBio) base += 10;
      if (transforme) base -= 25;
      return {
        score: Math.max(0, Math.min(100, base)),
        source: 'libellé',
        details: transforme ? ['produit transformé'] : (brut ? ['produit brut'] : [])
      };
    }

    const details = [];
    let parts = [];

    const grade = (off.nutriscore_grade || '').toLowerCase();
    if (NUTRISCORE_POINTS[grade] !== undefined) {
      parts.push({ v: NUTRISCORE_POINTS[grade], w: 3 });
      details.push(`Nutri-Score ${grade.toUpperCase()}`);
    }

    const nova = Number(off.nova_group);
    if (NOVA_POINTS[nova] !== undefined) {
      parts.push({ v: NOVA_POINTS[nova], w: 3 });
      details.push(`NOVA ${nova}${nova === 4 ? ' (ultra-transformé)' : ''}`);
    }

    const additifs = Number(off.additives_n);
    if (Number.isFinite(additifs)) {
      parts.push({ v: Math.max(0, 100 - additifs * 18), w: 2 });
      details.push(`${additifs} additif${additifs > 1 ? 's' : ''}`);
    }

    const nIng = Number(off.ingredients_n);
    if (Number.isFinite(nIng) && nIng > 0) {
      // short ingredient lists usually mean less processing
      parts.push({ v: Math.max(0, 100 - Math.max(0, nIng - 3) * 6), w: 1 });
      details.push(`${nIng} ingrédients`);
    }

    if (!parts.length) return { score: 50, source: 'inconnu', details: [] };

    const total = parts.reduce((a, p) => a + p.w, 0);
    let score = parts.reduce((a, p) => a + p.v * p.w, 0) / total;
    if (isBio) { score = Math.min(100, score + 8); details.push('bio'); }
    return { score: Math.round(score), source: 'Open Food Facts', details };
  }

  /* --- Combined ranking -------------------------------------------- */

  /* prefSante: 0 = prix seul, 1 = santé seule. 0.5 = équilibre.
     budgetMax: optional € ceiling per pack; over it, the candidate is
     kept but heavily penalized rather than removed (it may be the only one). */
  function rank(candidates, { prefSante = 0.5, budgetMax = null } = {}) {
    const withPrice = candidates.map(c => ({ c, up: unitPrice(c), health: healthScore(c) }));
    const prices = withPrice.map(x => x.up).filter(v => v > 0);
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;

    const scored = withPrice.map(({ c, up, health }) => {
      // price score: cheapest = 100, most expensive = 30 (never 0 — price is
      // one criterion among others, not a disqualification)
      let priceScore = 60;
      if (up > 0 && min !== null && max !== null && max > min) {
        priceScore = 100 - ((up - min) / (max - min)) * 70;
      } else if (up > 0) {
        priceScore = 100;
      }

      let score = priceScore * (1 - prefSante) + health.score * prefSante;
      let alerte = null;
      if (budgetMax && c.prix_eur > budgetMax) {
        score -= 25;
        alerte = `au-dessus du budget (${budgetMax.toFixed(2)} €)`;
      }

      return {
        ...c,
        prix_unitaire: up,
        score_prix: Math.round(priceScore),
        score_sante: health.score,
        sante_source: health.source,
        sante_details: health.details,
        score: Math.round(score),
        alerte
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /* Human-readable justification for the winning product. */
  function explain(winner, all) {
    if (!winner) return '';
    const bits = [];
    if (winner.prix_unitaire > 0) {
      const unit = packSize(winner)?.unite === 'piece' ? 'pièce' : 'kg/L';
      bits.push(`${winner.prix_unitaire.toFixed(2)} €/${unit}`);
    }
    if (winner.sante_details.length) bits.push(winner.sante_details.join(', '));
    else if (winner.sante_source === 'libellé') bits.push('produit brut');
    if (all && all.length > 1) bits.push(`meilleur sur ${all.length} candidats`);
    if (winner.alerte) bits.push(`⚠️ ${winner.alerte}`);
    return bits.join(' · ');
  }

  return { fetchOFF, enrich, rank, explain, healthScore, unitPrice, packSize };
})();

if (typeof module !== 'undefined') module.exports = Scoring;
