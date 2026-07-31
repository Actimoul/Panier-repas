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
    addToCartBtn: 'button[class*="ajout"], button[title*="jouter"]'
  },

  /* Ajoute au panier le premier résultat de la page de recherche courante.
     Retourne { ok, libelle } ou lève une erreur explicite. */
  async addFirstResultFromCurrentPage() {
    const card = document.querySelector(this.selectors.productCard);
    if (!card) throw new Error('Aucun produit trouvé sur cette page (sélecteur productCard à ajuster ?)');
    const btn = card.querySelector(this.selectors.addToCartBtn);
    if (!btn) throw new Error('Bouton "Ajouter" introuvable (sélecteur addToCartBtn à ajuster ?)');
    const title = card.querySelector(this.selectors.productTitle)?.textContent?.trim() || '(libellé inconnu)';
    btn.click();
    await new Promise(r => setTimeout(r, 800)); // laisse le site réagir
    return { ok: true, libelle: title };
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
