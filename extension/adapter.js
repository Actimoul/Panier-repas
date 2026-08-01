/* ============================================================
   LECLERC SITE ADAPTER — auto-calibrating
   ------------------------------------------------------------
   Ne demande AUCUN réglage manuel. Au lieu de sélecteurs codés
   en dur (qui cassent à chaque refonte du site), l'adapter
   découvre la structure de la page :

   1. il repère tous les nœuds texte contenant un prix (« 4,20 € »)
   2. il remonte l'arbre DOM jusqu'à trouver le niveau où ces
      nœuds ont des voisins de même signature (mêmes classes) —
      c'est la grille de produits
   3. dans chaque carte, il identifie le titre (texte le plus
      long hors prix), le prix, le prix au kg, le code-barres
      et le bouton d'ajout (par son intitulé, pas sa classe)

   Si le site expose une API JSON interne, renseigne-la dans
   `api` plus bas : elle sera utilisée en priorité.
   ============================================================ */
const LeclercAdapter = {

  /* Optionnel : si tu repères une API interne, remplis ceci. */
  api: {
    enabled: false,
    searchUrl: null,      // ex. (q) => `/api/recherche?q=${encodeURIComponent(q)}`
    addUrl: null,         // ex. '/api/panier/ajouter'
    mapProduct: null      // ex. (p) => ({ libelle: p.nom, prix_eur: p.prix, ean: p.ean })
  },

  searchPageUrl(query) {
    return `${location.origin}/recherche.aspx?TexteRecherche=${encodeURIComponent(query)}`;
  },

  /* --- Détection générique -------------------------------- */

  PRICE_RE: /(\d{1,3}(?:[.,]\d{1,2}))\s*€|€\s*(\d{1,3}(?:[.,]\d{1,2}))/,
  UNIT_PRICE_RE: /(\d+(?:[.,]\d+)?)\s*€\s*\/\s*(kg|l|litre|pi[eè]ce|unit)/i,
  ADD_LABEL_RE: /ajouter|j'achète|au panier|\+\s*panier/i,

  parsePrice(text) {
    if (!text) return null;
    const m = text.match(this.PRICE_RE);
    if (!m) return null;
    return parseFloat((m[1] || m[2]).replace(',', '.'));
  },

  parseUnitPrice(text) {
    if (!text) return null;
    const m = text.match(this.UNIT_PRICE_RE);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  },

  /* Signature structurelle d'un élément : sert à reconnaître
     les frères de même nature (les cartes d'une même grille). */
  signature(el) {
    const cls = (el.className || '').toString().split(/\s+/)
      .filter(c => c && !/^(is-|has-|active|selected)/.test(c))
      .slice(0, 3).sort().join('.');
    return `${el.tagName}|${cls}`;
  },

  /* Trouve le conteneur de carte produit : on remonte depuis un
     prix jusqu'au premier ancêtre ayant ≥2 frères de même
     signature et contenant assez de texte pour être une carte. */
  findCardFor(priceEl) {
    let el = priceEl;
    for (let depth = 0; depth < 8 && el && el.parentElement; depth++) {
      const parent = el.parentElement;
      const sig = this.signature(el);
      const siblings = [...parent.children].filter(c => this.signature(c) === sig);
      const text = (el.textContent || '').trim();
      if (siblings.length >= 2 && text.length > 12 && text.length < 400) {
        return { card: el, siblings };
      }
      el = parent;
    }
    return null;
  },

  /* Repère la grille de produits de la page courante. */
  findProductGrid() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const priceNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue;
      if (t && t.includes('€') && this.PRICE_RE.test(t)) {
        const el = node.parentElement;
        if (el && el.offsetParent !== null) priceNodes.push(el);
      }
      if (priceNodes.length > 60) break;
    }
    if (!priceNodes.length) return [];

    // La grille la plus fréquemment retrouvée est la bonne.
    const tally = new Map();
    for (const p of priceNodes) {
      const found = this.findCardFor(p);
      if (!found) continue;
      const key = this.signature(found.card);
      if (!tally.has(key)) tally.set(key, { count: 0, cards: found.siblings });
      tally.get(key).count++;
    }
    if (!tally.size) return [];
    const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    return best.cards;
  },

  /* --- Extraction ----------------------------------------- */

  extractTitle(card) {
    const heading = card.querySelector('h1,h2,h3,h4,a[title],img[alt]');
    if (heading) {
      const v = heading.getAttribute?.('title') || heading.getAttribute?.('alt') || heading.textContent;
      if (v && v.trim().length > 4) return v.trim().slice(0, 120);
    }
    // sinon : le plus long fragment de texte qui n'est pas un prix
    const fragments = [...card.querySelectorAll('*')]
      .map(e => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
      .filter(t => t.length > 5 && !t.includes('€') && !this.ADD_LABEL_RE.test(t));
    fragments.sort((a, b) => b.length - a.length);
    return (fragments[0] || card.textContent.trim()).slice(0, 120);
  },

  extractEan(card) {
    const attrs = ['data-ean', 'data-gtin', 'data-barcode', 'data-sku', 'data-id-produit', 'data-product-id'];
    for (const a of attrs) {
      const v = card.getAttribute?.(a) || card.querySelector(`[${a}]`)?.getAttribute(a);
      if (v && /^\d{8,14}$/.test(v.trim())) return v.trim();
    }
    const href = card.querySelector('a[href]')?.getAttribute('href') || '';
    const inHref = href.match(/\b(\d{13})\b/);
    if (inHref) return inHref[1];
    const inHtml = card.innerHTML.match(/\b(\d{13})\b/);
    return inHtml ? inHtml[1] : null;
  },

  findAddButton(card) {
    const clickables = [...card.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"], a, [class*="ajout"], [class*="add"], [class*="cta"], [onclick]'
    )];
    const labelled = clickables.find(b => {
      const label = `${b.textContent || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('aria-label') || ''} ${b.value || ''} ${b.className || ''}`;
      return this.ADD_LABEL_RE.test(label);
    });
    if (labelled) return labelled;
    // repli : un cliquable non-lien dans la carte est presque toujours l'ajout panier
    return clickables.find(b => b.tagName !== 'A') || null;
  },

  /* Récolte tous les produits de la page de résultats courante. */
  harvestCandidates(limit = 8) {
    const cards = this.findProductGrid().slice(0, limit);
    return cards.map((card, index) => {
      const text = card.textContent || '';
      return {
        index,
        _card: card,
        libelle: this.extractTitle(card),
        marque: null,
        prix_eur: this.parsePrice(text),
        prix_par_kg: this.parseUnitPrice(text),
        quantite_texte: this.extractTitle(card),
        ean: this.extractEan(card)
      };
    }).filter(c => c.libelle && c.prix_eur);
  },

  /* Ajoute au panier le produit d'indice donné.
     `candidates` peut être trié : on retrouve la carte par son champ .index,
     jamais par sa position dans le tableau. */
  async addByIndex(index, candidates) {
    const match = Array.isArray(candidates)
      ? candidates.find(c => c.index === index)
      : null;
    const card = match?._card || this.findProductGrid()[index];
    if (!card) throw new Error(`Produit #${index + 1} introuvable`);
    const btn = this.findAddButton(card);
    if (!btn) throw new Error('Bouton « Ajouter » non détecté sur la fiche');
    const libelle = this.extractTitle(card);
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    return { ok: true, libelle };
  },

  async addFirstResultFromCurrentPage() {
    return this.addByIndex(0);
  },

  /* Diagnostic : à lancer dans la console si quelque chose cloche. */
  diagnostic() {
    const cards = this.findProductGrid();
    console.log(`[Panier Repas] ${cards.length} cartes détectées`);
    cards.slice(0, 3).forEach((c, i) => console.log(` #${i}`, {
      titre: this.extractTitle(c),
      prix: this.parsePrice(c.textContent),
      prixKg: this.parseUnitPrice(c.textContent),
      ean: this.extractEan(c),
      bouton: !!this.findAddButton(c)
    }));
    return cards.length;
  }
};

/* Exposition explicite : les fichiers de content script partagent le même
   monde isolé, mais on ne dépend pas de la portée lexicale de haut niveau. */
globalThis.LeclercAdapter = LeclercAdapter;
