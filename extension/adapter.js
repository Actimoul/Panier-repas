/* ============================================================
   ADAPTER ENSEIGNE — auto-calibrant, multi-magasins
   ------------------------------------------------------------
   Ne demande AUCUN réglage manuel. Au lieu de sélecteurs codés
   en dur (qui cassent à chaque refonte du site), l'adapter
   découvre la structure de la page :

   1. il repère tous les nœuds texte contenant un prix (« 4,20 € »)
   2. il remonte l'arbre DOM jusqu'à trouver le niveau où ces
      nœuds ont des voisins de même signature (mêmes classes) —
      c'est la grille de produits
   3. dans chaque carte, il identifie le titre, le prix, le prix
      au kg, le code-barres et le bouton d'ajout (par son
      intitulé, pas sa classe)

   La seule partie propre à chaque enseigne est l'URL de
   recherche, déclarée dans ENSEIGNES ci-dessous. L'enseigne
   active est reconnue automatiquement d'après le domaine.
   ============================================================ */

const ENSEIGNES = {
  intermarche: {
    nom: 'Intermarché',
    domaines: ['intermarche.com'],
    search: (q) => `https://www.intermarche.com/recherche/${encodeURIComponent(q)}`
  },
  leclerc: {
    nom: 'E.Leclerc',
    domaines: ['leclercdrive.fr', 'e-leclerc.com'],
    search: (q) => `${location.origin}/recherche.aspx?TexteRecherche=${encodeURIComponent(q)}`
  },
  carrefour: {
    nom: 'Carrefour',
    domaines: ['carrefour.fr'],
    search: (q) => `https://www.carrefour.fr/s?q=${encodeURIComponent(q)}`
  },
  auchan: {
    nom: 'Auchan',
    domaines: ['auchan.fr'],
    search: (q) => `https://www.auchan.fr/recherche?text=${encodeURIComponent(q)}`
  },
  houra: {
    nom: 'Houra',
    domaines: ['houra.fr'],
    search: (q) => `https://www.houra.fr/recherche?q=${encodeURIComponent(q)}`
  },
  coursesu: {
    nom: 'Courses U',
    domaines: ['coursesu.com'],
    search: (q) => `https://www.coursesu.com/recherche?text=${encodeURIComponent(q)}`
  }
};

const StoreAdapter = {

  /* Optionnel : si tu repères une API interne, remplis ceci. */
  api: {
    enabled: false,
    searchUrl: null,      // ex. (q) => `/api/recherche?q=${encodeURIComponent(q)}`
    addUrl: null,         // ex. '/api/panier/ajouter'
    mapProduct: null      // ex. (p) => ({ libelle: p.nom, prix_eur: p.prix, ean: p.ean })
  },

  /* Enseigne active, déduite du domaine courant. */
  enseigne() {
    const host = location.hostname;
    for (const [cle, e] of Object.entries(ENSEIGNES)) {
      if (e.domaines.some(d => host.endsWith(d))) return { cle, ...e };
    }
    return null;
  },

  /* URL de recherche de l'enseigne courante. Repli générique si le
     domaine n'est pas répertorié : la plupart des sites acceptent ?q= */
  searchPageUrl(query) {
    const e = this.enseigne();
    if (e) return e.search(query);
    return `${location.origin}/recherche?q=${encodeURIComponent(query)}`;
  },

  /* --- Traversée profonde (shadow DOM) --------------------- */

  /* Les sites modernes encapsulent leurs composants dans des shadow roots,
     que querySelectorAll ne traverse pas. Sans cette traversée, un bouton
     « Ajouter » parfaitement visible à l'écran reste introuvable. */
  tousLesNoeuds(racine = document.body, profondeur = 0) {
    const out = [];
    if (!racine || profondeur > 12) return out;
    const walker = document.createTreeWalker(racine, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      out.push(n);
      if (n.shadowRoot) out.push(...this.tousLesNoeuds(n.shadowRoot, profondeur + 1));
      n = walker.nextNode();
    }
    return out;
  },

  /* querySelectorAll qui traverse les shadow roots. */
  chercherProfond(selecteur, racine = document.body) {
    const directs = [...(racine.querySelectorAll?.(selecteur) || [])];
    const dansShadow = this.tousLesNoeuds(racine)
      .filter(n => n.shadowRoot)
      .flatMap(n => [...n.shadowRoot.querySelectorAll(selecteur)]);
    return [...new Set([...directs, ...dansShadow])];
  },

  /* --- État de la page ------------------------------------ */

  /* Reconnaître une page d'erreur ou de blocage AVANT d'essayer d'y lire des
     produits : continuer à naviguer sur un site qui renvoie des 500 ne fait
     qu'aggraver le problème. */
  ERREUR_RE: /\b(erreur\s*5\d\d|erreur\s*4\d\d|le serveur ne r[ée]pond pas|service (temporairement )?indisponible|trop de requ[êe]tes|acc[èe]s refus[ée]|maintenance en cours)\b/i,

  pageEnErreur() {
    const txt = (document.body?.innerText || this.texteVisible(document.body)).slice(0, 1200);
    if (this.ERREUR_RE.test(txt)) return txt.split('\n').find(l => this.ERREUR_RE.test(l))?.trim() || 'page d\'erreur';
    // Une page réellement morte : aucun texte, aucune image, aucun script,
    // aucun élément interactif. Un squelette d'application monopage en cours
    // de rendu a toujours au moins un script — il ne doit pas être confondu
    // avec une panne.
    const vide = txt.replace(/\s/g, '').length < 60
      && !document.querySelector('img, svg')
      && !document.querySelector('script')
      && !document.querySelector('button, input, a[href]');
    return vide ? 'page vide' : null;
  },

  /* Page de résultats sans aucun produit : ce n'est pas une panne, juste une
     recherche infructueuse — l'article doit être passé, pas retenté. */
  aucunResultat() {
    const txt = (document.body?.innerText || '').toLowerCase();
    return /\b(aucun (r[ée]sultat|produit)|pas de r[ée]sultat|0 produit|rien ne correspond)\b/.test(txt);
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

  /* Le texte réellement affiché, shadow DOM compris : textContent s'arrête
     au bord d'un composant et renvoie une chaîne vide pour une carte dont
     tout le contenu est encapsulé. */
  texteVisible(el) {
    if (!el) return '';
    let t = el.textContent || '';
    if (el.shadowRoot) t += ' ' + el.shadowRoot.textContent;
    for (const n of el.querySelectorAll ? el.querySelectorAll('*') : []) {
      if (n.shadowRoot) t += ' ' + n.shadowRoot.textContent;
    }
    return t;
  },

  /* Parent d'un élément, y compris à travers une frontière de shadow DOM :
     à l'intérieur d'un composant, parentElement s'arrête au bord et la
     remontée échoue. On saute alors sur l'hôte du shadow root. */
  parentTraversant(el) {
    if (el.parentElement) return el.parentElement;
    const racine = el.getRootNode?.();
    return racine && racine.host ? racine.host : null;
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
    for (let depth = 0; depth < 10 && el; depth++) {
      const parent = this.parentTraversant(el);
      if (!parent) break;
      const sig = this.signature(el);
      const siblings = [...parent.children].filter(c => this.signature(c) === sig);
      const text = this.texteVisible(el).trim();
      if (siblings.length >= 2 && text.length > 12 && text.length < 600) {
        return { card: el, siblings };
      }
      el = parent;
    }
    return null;
  },

  /* Repère la grille de produits de la page courante. */
  findProductGrid() {
    // Les prix peuvent vivre dans un shadow root : on parcourt tous les
    // éléments, shadow DOM compris, et on garde ceux qui portent un prix.
    const priceNodes = [];
    for (const el of this.tousLesNoeuds()) {
      if (priceNodes.length > 60) break;
      if (el.childElementCount !== 0) continue;
      const t = el.textContent;
      if (t && t.includes('€') && this.PRICE_RE.test(t) && el.offsetParent !== null) {
        priceNodes.push(el);
      }
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

  /* --- Produits venus de l'API interne du site ------------- */

  /* Les champs varient d'un site à l'autre : on les devine par leur nom. */
  CHAMPS: {
    libelle: /^(lib|libelle|nom|name|titre|title|designation|label|productname)/i,
    prix: /^(prix|price|amount|tarif|prixunitaire|unitprice|pricettc|prixttc)/i,
    prixKg: /(prixkilo|prixaukilo|priceperkg|unitprice|prixunite)/i,
    ean: /^(ean|gtin|codebarre|barcode|sku|reference|ref|id)$/i,
    marque: /^(marque|brand)/i,
    quantite: /^(quantite|contenance|conditionnement|packaging|weight|poids)/i
  },

  valeurChamp(obj, motif) {
    for (const [k, v] of Object.entries(obj)) {
      if (motif.test(k) && v !== null && v !== undefined && v !== '') return v;
    }
    // un niveau d'imbrication
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (motif.test(k2) && v2 !== null && v2 !== undefined && v2 !== '') return v2;
        }
      }
    }
    return null;
  },

  nombre(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)/);
      return m ? parseFloat(m[1].replace(',', '.')) : null;
    }
    return null;
  },

  /* Transforme la réponse de l'API du site en candidats comparables. */
  candidatsDepuisApi(liste, limite = 8) {
    return liste.slice(0, limite).map((p, index) => {
      const libelle = String(this.valeurChamp(p, this.CHAMPS.libelle) || '').trim();
      const quantite = this.valeurChamp(p, this.CHAMPS.quantite);
      const ean = this.valeurChamp(p, this.CHAMPS.ean);
      return {
        index,
        _api: p,
        libelle: quantite && !libelle.match(/\d/) ? `${libelle} ${quantite}` : libelle,
        marque: this.valeurChamp(p, this.CHAMPS.marque) || null,
        prix_eur: this.nombre(this.valeurChamp(p, this.CHAMPS.prix)),
        prix_par_kg: this.nombre(this.valeurChamp(p, this.CHAMPS.prixKg)),
        quantite_texte: `${libelle} ${quantite || ''}`,
        ean: ean && /^\d{8,14}$/.test(String(ean)) ? String(ean) : null
      };
    }).filter(c => c.libelle && c.prix_eur);
  },

  /* --- Extraction ----------------------------------------- */

  extractTitle(card) {
    const heading = this.chercherProfond('h1,h2,h3,h4,a[title],img[alt]', card)[0]
      || card.querySelector('h1,h2,h3,h4,a[title],img[alt]');
    if (heading) {
      const v = heading.getAttribute?.('title') || heading.getAttribute?.('alt') || heading.textContent;
      if (v && v.trim().length > 4) return v.trim().slice(0, 120);
    }
    // sinon : le plus long fragment de texte qui n'est pas un prix
    const fragments = this.tousLesNoeuds(card.shadowRoot || card)
      .map(e => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
      .filter(t => t.length > 5 && !t.includes('€') && !this.ADD_LABEL_RE.test(t));
    fragments.sort((a, b) => b.length - a.length);
    return (fragments[0] || this.texteVisible(card).trim()).slice(0, 120);
  },

  extractEan(card) {
    const attrs = ['data-ean', 'data-gtin', 'data-barcode', 'data-sku', 'data-id-produit', 'data-product-id', 'data-id'];
    for (const a of attrs) {
      const v = card.getAttribute?.(a) || this.chercherProfond(`[${a}]`, card)[0]?.getAttribute(a);
      if (v && /^\d{8,14}$/.test(String(v).trim())) return String(v).trim();
    }
    const href = this.chercherProfond('a[href]', card)[0]?.getAttribute('href') || '';
    const inHref = href.match(/\b(\d{13})\b/);
    if (inHref) return inHref[1];
    const inHtml = card.innerHTML.match(/\b(\d{13})\b/);
    return inHtml ? inHtml[1] : null;
  },

  SELECTEURS_CLIQUABLES: 'button, [role="button"], input[type="submit"], input[type="button"], a, [class*="ajout"], [class*="add"], [class*="panier"], [class*="cart"], [class*="cta"], [onclick]',

  estBoutonAjout(el) {
    const label = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.value || ''} ${el.className || ''} ${el.getAttribute('data-testid') || ''}`;
    return this.ADD_LABEL_RE.test(label);
  },

  /* Le bouton d'ajout n'est pas toujours DANS la carte détectée : selon les
     sites il vit dans un conteneur frère, ou n'apparaît qu'au survol. On
     élargit la recherche à deux niveaux d'ancêtres, et on simule le survol
     avant d'abandonner. */
  findAddButton(card) {
    const chercher = (racine) => {
      const clickables = this.chercherProfond(this.SELECTEURS_CLIQUABLES, racine);
      return clickables.find(b => this.estBoutonAjout(b)) || null;
    };

    let trouve = chercher(card);
    if (trouve) return trouve;

    // le bouton apparaît peut-être au survol
    try {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      trouve = chercher(card);
      if (trouve) return trouve;
    } catch { /* ignore */ }

    // remonter jusqu'à deux niveaux, sans déborder sur les cartes voisines
    let noeud = card;
    for (let i = 0; i < 2; i++) {
      const suivant = this.parentTraversant(noeud);
      if (!suivant) break;
      noeud = suivant;
      const candidats = this.chercherProfond(this.SELECTEURS_CLIQUABLES, noeud)
        .filter(b => this.estBoutonAjout(b));
      if (candidats.length === 1) return candidats[0];
      // plusieurs cartes sous cet ancêtre : garder celui qui contient la carte
      const propre = candidats.find(b => card.contains(b) || b.contains(card));
      if (propre) return propre;
    }

    // dernier recours : un cliquable non-lien dans la carte
    return this.chercherProfond(this.SELECTEURS_CLIQUABLES, card)
      .find(b => b.tagName !== 'A') || null;
  },

  /* Récolte tous les produits de la page de résultats courante. */
  harvestCandidates(limit = 8) {
    const cards = this.findProductGrid().slice(0, limit);
    return cards.map((card, index) => {
      const text = this.texteVisible(card);
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
    // Les listes virtualisées ne rendent leurs boutons qu'à l'approche :
    // on amène la carte à l'écran et on laisse le temps au rendu.
    try {
      card.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 600));
    } catch { /* ignore */ }

    const btn = this.findAddButton(card);
    if (!btn) throw new Error('bouton d\'ajout introuvable sur la fiche produit');
    const libelle = this.extractTitle(card);
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    return { ok: true, libelle };
  },

  async addFirstResultFromCurrentPage() {
    return this.addByIndex(0);
  },

  /* Diagnostic complet, à lancer dans la console d'une page de résultats.
     Copie un rapport dans le presse-papiers : c'est ce rapport qui permet
     de corriger l'adapter sans deviner. */
  async diagnostic() {
    const e = this.enseigne();
    const cartes = this.findProductGrid();
    const rapport = {
      site: location.hostname,
      url: location.href.slice(0, 160),
      enseigne: e ? e.nom : 'non reconnue',
      page_en_erreur: this.pageEnErreur(),
      aucun_resultat: this.aucunResultat(),
      elements_total: this.tousLesNoeuds().length,
      elements_avec_shadow: this.tousLesNoeuds().filter(n => n.shadowRoot).length,
      cartes_detectees: cartes.length,
      api_recherche_apprise: null,
      api_panier_apprise: null,
      cartes: cartes.slice(0, 3).map(c => ({
        titre: this.extractTitle(c),
        prix: this.parsePrice(this.texteVisible(c)),
        prix_kg: this.parseUnitPrice(this.texteVisible(c)),
        ean: this.extractEan(c),
        bouton_trouve: !!this.findAddButton(c),
        bouton_html: this.findAddButton(c)?.outerHTML?.slice(0, 200) || null,
        cliquables_dans_la_carte: this.chercherProfond(this.SELECTEURS_CLIQUABLES, c)
          .slice(0, 6).map(b => `${b.tagName}.${(b.className || '').toString().slice(0, 40)} "${(b.textContent || '').trim().slice(0, 25)}" aria="${b.getAttribute('aria-label') || ''}"`),
        html: c.outerHTML.slice(0, 900)
      }))
    };

    try {
      const connu = await Sniffer.connu();
      rapport.api_recherche_apprise = connu?.url || null;
      rapport.api_panier_apprise = connu?.panier?.urlComplete || null;
      rapport.captures_recherche = Sniffer.captures.length;
      rapport.captures_ecriture = Sniffer.capturesPanier.length;
      rapport.exemples_captures = Sniffer.captures.slice(-3).map(c => c.url.slice(0, 120));
    } catch { /* Sniffer absent */ }

    console.log('%c[Panier Repas] Rapport de diagnostic', 'font-weight:bold;color:#2F6B3C');
    console.log(rapport);
    const texte = JSON.stringify(rapport, null, 2);
    try {
      await navigator.clipboard.writeText(texte);
      console.log('%c✓ Rapport copié dans le presse-papiers — colle-le dans la conversation.',
        'color:#2F6B3C;font-weight:bold');
    } catch {
      console.log('Copie automatique refusée. Sélectionne et copie le texte ci-dessous :');
      console.log(texte);
    }
    return rapport;
  }
};

globalThis.StoreAdapter = StoreAdapter;
/* Alias de compatibilité avec les versions précédentes. */
globalThis.LeclercAdapter = StoreAdapter;
globalThis.ENSEIGNES = ENSEIGNES;
