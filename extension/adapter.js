/* ============================================================
   LECLERC SITE ADAPTER
   ------------------------------------------------------------
   C'est LE fichier à ajuster après ton repérage DevTools.
   Tout le reste de l'extension est indépendant du site.

   Étapes du repérage (une seule fois) :
   1. Connecte-toi sur ton drive/livraison Leclerc.
   2. Ouvre DevTools > Réseau (filtre XHR/Fetch).
   3. Fais une recherche produit → note l'URL d'API de recherche
      et la forme de la réponse JSON (id produit, libellé, prix).
   4. Ajoute un produit au panier → note l'appel (URL, méthode,
      corps, en-têtes type token CSRF).
   5. Reporte ça ci-dessous. Si le site n'a pas d'API exploitable,
      remplis plutôt les sélecteurs DOM (mode "click").
   ============================================================ */
const LeclercAdapter = {
  /* URL de recherche affichable (fallback universel, fonctionne toujours). */
  searchPageUrl(query) {
    return `${location.origin}/recherche.aspx?TexteRecherche=${encodeURIComponent(query)}`;
  },

  /* --- MODE CLICK (DOM) — à vérifier/ajuster --- */
  selectors: {
    // TODO: vérifier ces sélecteurs sur TON magasin (ils varient selon la version du site)
    searchInput: 'input[type="search"], input[name*="echerche"]',
    productCard: '[class*="produit"], [class*="product-card"]',
    productTitle: '[class*="libelle"], [class*="title"]',
    productPrice: '[class*="prix"], [class*="price"]',
    productUnitPrice: '[class*="prixUnitaire"], [class*="unit-price"], [class*="perKg"]',
    productBrand: '[class*="marque"], [class*="brand"]',
    addToCartBtn: 'button[class*="ajout"], button[title*="jouter"]'
  },

  /* Parse "4,20 €" / "€4.20" / "14,00 €/kg" into a number. */
  parsePrice(text) {
    if (!text) return null;
    const m = text.replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  },

  /* Try hard to find an EAN: data attributes, then any 13-digit run in the
     card's markup (product links and images usually embed it). */
  extractEan(card) {
    const attrs = ['data-ean', 'data-gtin', 'data-barcode', 'data-sku', 'data-id-produit'];
    for (const a of attrs) {
      const v = card.getAttribute?.(a) || card.querySelector(`[${a}]`)?.getAttribute(a);
      if (v && /^\d{8,14}$/.test(v.trim())) return v.trim();
    }
    const m = card.innerHTML.match(/\b(\d{13})\b/);
    return m ? m[1] : null;
  },

  /* Harvest every product on the current search results page.
     Returns [{ libelle, marque, prix_eur, prix_par_kg, quantite_texte, ean, index }] */
  harvestCandidates(limit = 8) {
    const cards = [...document.querySelectorAll(this.selectors.productCard)].slice(0, limit);
    return cards.map((card, index) => {
      const txt = (sel) => card.querySelector(sel)?.textContent?.trim() || '';
      const libelle = txt(this.selectors.productTitle) || card.textContent.trim().slice(0, 80);
      return {
        index,
        libelle,
        marque: txt(this.selectors.productBrand) || null,
        prix_eur: this.parsePrice(txt(this.selectors.productPrice)),
        prix_par_kg: this.parsePrice(txt(this.selectors.productUnitPrice)),
        quantite_texte: libelle,
        ean: this.extractEan(card)
      };
    }).filter(c => c.libelle);
  },

  /* Add the Nth product of the current results page to the cart. */
  async addByIndex(index) {
    const cards = [...document.querySelectorAll(this.selectors.productCard)];
    const card = cards[index];
    if (!card) throw new Error(`Produit #${index + 1} introuvable sur la page`);
    const btn = card.querySelector(this.selectors.addToCartBtn);
    if (!btn) throw new Error('Bouton "Ajouter" introuvable (sélecteur addToCartBtn à ajuster ?)');
    const title = card.querySelector(this.selectors.productTitle)?.textContent?.trim() || '(libellé inconnu)';
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    return { ok: true, libelle: title };
  },

  /* Ajoute au panier le premier résultat de la page de recherche courante.
     Retourne { ok, libelle } ou lève une erreur explicite. */
  async addFirstResultFromCurrentPage() {
    return this.addByIndex(0);
  }

  /* --- MODE API (optionnel, plus fiable) ---
     Si ton repérage révèle une API JSON interne, implémente ici :

  async apiSearch(query) {
    const res = await fetch(`/api/recherche?q=${encodeURIComponent(query)}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`search API ${res.status}`);
    return res.json();
  },

  async apiAddToCart(productId, qty) {
    const res = await fetch('/api/panier/ajouter', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: productId, quantite: qty })
    });
    if (!res.ok) throw new Error(`addToCart API ${res.status}`);
    return res.json();
  }
  */
};
