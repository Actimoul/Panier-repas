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

/* Enseignes reconnues. IMPORTANT : aucun gabarit d'URL de recherche n'est
   déclaré ici. Deviner l'adresse de recherche d'un site est non seulement
   inefficace — le site sert alors une page générique — mais dangereux : sur
   Intermarché, une URL de recherche mal formée renvoie une erreur 500. La
   recherche passe donc exclusivement par le formulaire du site, et l'accueil
   sert de point de départ sûr. */
const ENSEIGNES = {
  intermarche: { nom: 'Intermarché', domaines: ['intermarche.com'] },
  leclerc: { nom: 'E.Leclerc', domaines: ['leclercdrive.fr', 'e-leclerc.com'] },
  carrefour: { nom: 'Carrefour', domaines: ['carrefour.fr'] },
  auchan: { nom: 'Auchan', domaines: ['auchan.fr'] },
  houra: { nom: 'Houra', domaines: ['houra.fr'] },
  coursesu: { nom: 'Courses U', domaines: ['coursesu.com'] }
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

  /* Point de départ sûr quand la page courante ne permet pas de chercher :
     l'accueil du site, qui porte toujours la barre de recherche. On ne
     fabrique JAMAIS d'URL de recherche — voir le commentaire d'ENSEIGNES. */
  urlAccueil() {
    return `${location.origin}/`;
  },

  /* Conservé pour compatibilité : renvoie l'accueil, pas une URL devinée. */
  searchPageUrl() {
    return this.urlAccueil();
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

  /* --- Recherche par le formulaire du site ----------------- */

  /* Deviner l'URL de recherche d'un site est une mauvaise idée : si le
     gabarit est faux, le site sert une page d'accueil et on récolte des
     promotions au hasard. On utilise donc SON champ de recherche. */
  SELECTEURS_RECHERCHE: [
    'input[type="search"]',
    'input[role="searchbox"]',
    '[role="searchbox"]',
    'input[name*="earch" i]',
    'input[name*="echerche" i]',
    'input[id*="earch" i]',
    'input[id*="echerche" i]',
    'input[placeholder*="echerch" i]',
    'input[aria-label*="echerch" i]',
    'input[placeholder*="produit" i]',
    'form[role="search"] input[type="text"]'
  ].join(','),

  champRecherche() {
    const candidats = this.chercherProfond(this.SELECTEURS_RECHERCHE)
      .filter(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
    // le plus large est en général la barre principale, pas un filtre
    candidats.sort((a, b) => (b.offsetWidth || 0) - (a.offsetWidth || 0));
    return candidats[0] || null;
  },

  /* Écrire dans un champ piloté par un framework demande de passer par le
     setter natif : une simple affectation de .value est ignorée par React. */
  ecrireDansChamp(champ, texte) {
    const proto = champ instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    champ.focus();
    if (setter) setter.call(champ, texte); else champ.value = texte;
    champ.dispatchEvent(new Event('input', { bubbles: true }));
    champ.dispatchEvent(new Event('change', { bubbles: true }));
  },

  /* Lance une recherche via le formulaire du site. Retourne true si elle a
     pu être déclenchée. */
  async rechercherViaFormulaire(terme) {
    const champ = this.champRecherche();
    if (!champ) return false;
    this.ecrireDansChamp(champ, terme);
    await new Promise(r => setTimeout(r, 400));

    for (const type of ['keydown', 'keypress', 'keyup']) {
      champ.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
    }

    // certains formulaires n'écoutent que la soumission
    const form = champ.closest('form');
    if (form) {
      try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch { /* ignore */ }
    }
    return true;
  },

  /* --- Détection générique -------------------------------- */

  PRICE_RE: /(\d{1,3}(?:[.,]\d{1,2}))\s*€|€\s*(\d{1,3}(?:[.,]\d{1,2}))/,
  UNIT_PRICE_RE: /(\d+(?:[.,]\d+)?)\s*€\s*\/\s*(kg|l|litre|pi[eè]ce|unit)/i,
  ADD_LABEL_RE: /ajouter|j'achète|au panier|\+\s*panier/i,

  /* Le prix affiché en gros n'est pas le prix au kilo : « 13,59 €/Kg » ne
     doit jamais être pris pour le prix du produit. On écarte donc tout
     montant suivi d'une unité, et on garde le dernier restant — le prix de
     vente est presque toujours en bas de carte. */
  parsePrice(text) {
    if (!text) return null;
    const tous = [...text.matchAll(/(\d{1,3}(?:[.,]\d{1,2}))\s*€\s*(\/\s*\w+)?|€\s*(\d{1,3}(?:[.,]\d{1,2}))/g)];
    const nus = tous.filter(m => !m[2]);
    const choisi = nus.length ? nus[nus.length - 1] : null;
    if (!choisi) return null;
    return parseFloat((choisi[1] || choisi[3]).replace(',', '.'));
  },

  /* « 3,29 €/Pièce » n'est PAS un prix au kilo : le confondre divise
     l'estimation d'un panier par quatre sur les légumes vendus à l'unité.
     On renvoie donc le montant ET son unité. */
  parseUnitPrice(text) {
    if (!text) return null;
    const m = text.match(this.UNIT_PRICE_RE);
    if (!m) return null;
    const valeur = parseFloat(m[1].replace(',', '.'));
    const u = (m[2] || '').toLowerCase();
    const parPiece = /pi[eè]ce|unit/.test(u);
    return { valeur, unite: parPiece ? 'piece' : (/^l|litre/.test(u) ? 'l' : 'kg'), parPiece };
  },

  /* Compatibilité : uniquement le prix au kilo ou au litre. */
  prixAuKilo(text) {
    const r = this.parseUnitPrice(text);
    return r && !r.parPiece ? r.valeur : null;
  },

  prixALaPiece(text) {
    const r = this.parseUnitPrice(text);
    return r && r.parPiece ? r.valeur : null;
  },

  /* Le texte réellement affiché, shadow DOM compris : textContent s'arrête
     au bord d'un composant et renvoie une chaîne vide pour une carte dont
     tout le contenu est encapsulé. */
  texteVisible(el) {
    if (!el) return '';
    // innerText respecte les sauts de ligne : sans lui, « Primeur<br>Ail »
    // devient « PrimeurAil » et le mot « ail » n'est plus reconnaissable.
    let t = (el.innerText || el.textContent || '');
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
  /* Un prix n'est presque jamais dans un seul nœud texte : les sites le
     découpent en « 1,36 » + « € », parfois avec les centimes en exposant.
     On cherche donc le plus PETIT élément dont le texte rendu forme un prix
     complet — pas la feuille du DOM, qui n'en contient qu'un morceau. */
  noeudsPrix(limite = 80) {
    const trouves = [];
    for (const el of this.tousLesNoeuds()) {
      if (trouves.length >= limite) break;
      if (el.offsetParent === null) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 40 || !t.includes('€')) continue;
      if (!this.PRICE_RE.test(t)) continue;
      // ne garder que le plus petit conteneur : si un enfant porte déjà le
      // prix entier, c'est lui le bon.
      const enfantPorteur = [...el.children].some(c => {
        const ct = (c.innerText || c.textContent || '').trim();
        return ct.includes('€') && this.PRICE_RE.test(ct) && ct.length <= t.length;
      });
      if (enfantPorteur) continue;
      trouves.push(el);
    }
    return trouves;
  },

  /* Le prix de vente est celui affiché en bas de carte, à côté du bouton.
     Les autres montants (prix au kilo, « à partir de », prix barré) sont
     ailleurs. On choisit donc par la position, pas par l'ordre du texte. */
  prixDeVente(card) {
    const noeuds = this.chercherProfond('*', card)
      .filter(el => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 40 || !t.includes('€')) return false;
        if (/\/\s*(kg|kilo|l|litre|pi[eè]ce|unit|pers)/i.test(t)) return false;
        if (!this.PRICE_RE.test(t)) return false;
        return ![...el.children].some(c => {
          const ct = (c.innerText || '').trim();
          return ct.includes('€') && this.PRICE_RE.test(ct) && ct.length <= t.length;
        });
      });
    if (!noeuds.length) return this.parsePrice(this.texteVisible(card));

    let meilleur = null, plusBas = -Infinity;
    for (const el of noeuds) {
      try {
        const y = el.getBoundingClientRect().top;
        if (y > plusBas) { plusBas = y; meilleur = el; }
      } catch { meilleur = meilleur || el; }
    }
    return this.parsePrice((meilleur.innerText || '').trim());
  },

  findProductGrid() {
    const priceNodes = this.noeudsPrix();
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
        prix_par_piece: null,
        quantite_texte: `${libelle} ${quantite || ''}`,
        ean: ean && /^\d{8,14}$/.test(String(ean)) ? String(ean) : null
      };
    }).filter(c => c.libelle && c.prix_eur);
  },

  /* --- Extraction ----------------------------------------- */

  /* Le titre n'est presque jamais une feuille du DOM : « Le Choix du
     Primeur<br>Ail BLANC - CAT. 1 » contient un <br>, et une mention comme
     « FRANCE » est une feuille bien plus courte. On note donc les candidats
     plutôt que de prendre le plus long fragment terminal. */
  BALISES_INLINE: new Set(['BR', 'SPAN', 'B', 'STRONG', 'EM', 'I', 'SMALL', 'MARK', 'U']),

  estBlocTexte(el) {
    return [...el.children].every(c => this.BALISES_INLINE.has(c.tagName));
  },

  extractTitle(card) {
    const propre = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const texte = (e) => propre(e.innerText || this.texteVisible(e));

    // 1. un vrai titre, s'il existe
    const heading = this.chercherProfond('h1,h2,h3,h4,h5', card)[0];
    if (heading) {
      const v = texte(heading);
      if (v.length > 3) return v.slice(0, 120);
    }

    // 2. sinon, le meilleur bloc de texte de la carte
    const rc = card.getBoundingClientRect?.();
    const candidats = [];
    for (const el of this.tousLesNoeuds(card.shadowRoot || card)) {
      if (!this.estBlocTexte(el)) continue;
      const t = texte(el);
      if (t.length < 4 || t.length > 140) continue;
      if (t.includes('€')) continue;
      if (this.ADD_LABEL_RE.test(t) || this.EXCLUS_RE.test(t)) continue;
      if (/^(france|bio|nouveau|promo|prix|par|le|la|les)$/i.test(t)) continue;

      let note = Math.min(t.length, 60);
      if (/[a-zà-ÿ]/.test(t) && /[A-ZÀ-Ÿ]/.test(t)) note += 10;   // casse mixte
      if (t === t.toUpperCase() && t.length < 12) note -= 20;      // mention type FRANCE
      try {
        const re = el.getBoundingClientRect();
        if (rc && rc.height > 0) {
          const haut = (re.top - rc.top) / rc.height;
          if (haut > 0.2 && haut < 0.75) note += 15;  // sous l'image, avant le prix
        }
      } catch { /* ignore */ }
      candidats.push({ t, note });
    }
    candidats.sort((a, b) => b.note - a.note);
    if (candidats.length) return candidats[0].t.slice(0, 120);

    // 3. repli : le texte de la carte, nettoyé
    return propre(this.texteVisible(card)).slice(0, 120);
  },

  /* Les noms d'attributs varient d'un site à l'autre (data-ean, data-gtin,
     data-produit-id…). Plutôt qu'une liste jamais complète, on accepte tout
     attribut data-* dont la valeur ressemble à un identifiant produit. */
  extractEan(card) {
    const plausible = (v) => v && /^\d{8,14}$/.test(String(v).trim());

    const scanner = (el) => {
      if (!el.attributes) return null;
      for (const a of el.attributes) {
        if (!/^data-/i.test(a.name)) continue;
        if (/price|prix|qty|quantite|index|position|count/i.test(a.name)) continue;
        if (plausible(a.value)) return String(a.value).trim();
      }
      return null;
    };

    const direct = scanner(card);
    if (direct) return direct;
    for (const el of this.chercherProfond('*', card).slice(0, 40)) {
      const v = scanner(el);
      if (v) return v;
    }

    const href = this.chercherProfond('a[href]', card)[0]?.getAttribute('href') || '';
    const inHref = href.match(/\b(\d{8,14})\b/);
    if (inHref) return inHref[1];
    const inHtml = card.innerHTML.match(/\b(\d{13})\b/);
    return inHtml ? inHtml[1] : null;
  },

  SELECTEURS_CLIQUABLES: 'button, [role="button"], input[type="submit"], input[type="button"], a, [class*="ajout"], [class*="add"], [class*="panier"], [class*="cart"], [class*="cta"], [onclick]',

  /* Ce qui n'est JAMAIS un ajout au panier, même si le libellé contient
     « ajouter » : la mise en favoris est le piège classique — sur beaucoup de
     sites son intitulé est « Ajouter aux favoris ». */
  EXCLUS_RE: /favori|wishlist|souhait|coeur|cœur|heart|comparer|partager|liste\s*de\s*course|alerte|notifier/i,

  descripteur(el) {
    return [
      el.textContent, el.getAttribute('title'), el.getAttribute('aria-label'),
      el.value, el.className, el.getAttribute('data-testid'), el.getAttribute('data-test'),
      el.id, el.getAttribute('name')
    ].filter(Boolean).join(' ');
  },

  estExclu(el) {
    return this.EXCLUS_RE.test(this.descripteur(el));
  },

  estBoutonAjout(el) {
    if (this.estExclu(el)) return false;
    return this.ADD_LABEL_RE.test(this.descripteur(el));
  },

  /* Score géométrique : l'ajout au panier est en bas de carte, près du prix ;
     les favoris et le partage sont en haut. Sans libellé exploitable — le
     bouton n'est souvent qu'une icône — c'est la position qui tranche. */
  scoreBouton(el, card) {
    if (this.estExclu(el)) return -100;
    let score = 0;
    if (this.ADD_LABEL_RE.test(this.descripteur(el))) score += 50;
    if (/panier|cart|basket|add-to/i.test(this.descripteur(el))) score += 30;
    try {
      const rc = card.getBoundingClientRect();
      const re = el.getBoundingClientRect();
      if (rc.height > 0) {
        const positionRelative = (re.top + re.height / 2 - rc.top) / rc.height;
        if (positionRelative > 0.6) score += 25;          // moitié basse
        else if (positionRelative < 0.25) score -= 20;    // coin haut : favoris
        if (re.right > rc.left + rc.width * 0.6) score += 5;
      }
    } catch { /* pas de géométrie disponible */ }
    if (el.tagName === 'BUTTON') score += 10;
    if (el.tagName === 'A' && el.getAttribute('href')) score -= 15;   // lien vers la fiche
    if (el.querySelector('svg, img')) score += 5;
    return score;
  },

  /* Le bouton d'ajout n'est pas toujours DANS la carte détectée : selon les
     sites il vit dans un conteneur frère, ou n'apparaît qu'au survol. On
     élargit la recherche à deux niveaux d'ancêtres, et on simule le survol
     avant d'abandonner. */
  findAddButton(card) {
    const evaluer = (racine) => {
      const clickables = this.chercherProfond(this.SELECTEURS_CLIQUABLES, racine)
        .filter(el => !this.estExclu(el));
      if (!clickables.length) return null;
      const notes = clickables.map(el => ({ el, note: this.scoreBouton(el, card) }));
      notes.sort((a, b) => b.note - a.note);
      return notes[0].note > 0 ? notes[0].el : null;
    };

    let trouve = evaluer(card);
    if (trouve) return trouve;

    // le bouton n'apparaît peut-être qu'au survol
    try {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      trouve = evaluer(card);
      if (trouve) return trouve;
    } catch { /* ignore */ }

    // remonter d'un niveau, sans déborder sur les cartes voisines
    const parent = this.parentTraversant(card);
    if (parent) {
      const candidats = this.chercherProfond(this.SELECTEURS_CLIQUABLES, parent)
        .filter(el => !this.estExclu(el) && (card.contains(el) || el.contains(card)));
      if (candidats.length) {
        const notes = candidats.map(el => ({ el, note: this.scoreBouton(el, card) }));
        notes.sort((a, b) => b.note - a.note);
        if (notes[0].note > 0) return notes[0].el;
      }
    }
    return null;
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
        prix_eur: this.prixDeVente(card),
        prix_par_kg: this.prixAuKilo(text),
        prix_par_piece: this.prixALaPiece(text),
        // La contenance (« Le pot de 140g », « Le filet de 2 têtes ») vit
        // sous le titre, pas dedans : lire toute la carte, sinon le prix au
        // kilo ne peut pas être recalculé et le panier est sous-évalué.
        quantite_texte: text,
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
      noeuds_prix_reperes: this.noeudsPrix().length,
      exemples_prix: this.noeudsPrix(6).map(e => `${e.tagName}.${(e.className||'').toString().slice(0,30)} "${(e.innerText||'').trim().slice(0,24)}"`),
      cartes_detectees: cartes.length,
      api_recherche_apprise: null,
      api_panier_apprise: null,
      cartes: cartes.slice(0, 3).map(c => ({
        titre: this.extractTitle(c),
        prix: this.prixDeVente(c),
        prix_brut_carte: this.parsePrice(this.texteVisible(c)),
        texte_carte: this.texteVisible(c).replace(/\s+/g, ' ').slice(0, 200),
        prix_kg: this.prixAuKilo(this.texteVisible(c)),
        prix_piece: this.prixALaPiece(this.texteVisible(c)),
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
