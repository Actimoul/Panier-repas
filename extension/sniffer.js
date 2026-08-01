/* Endpoint discovery.

   Navigating a search page per ingredient costs one full page load each — 6 s
   of throttle plus render. But the site itself talks to a JSON API to render
   those results. If we learn that endpoint once, we can query it directly:
   no navigation, no rendering, a fraction of the load on the site, and a pace
   measured in hundreds of milliseconds instead of seconds.

   This module wraps fetch and XMLHttpRequest to watch what the page requests
   while the user searches normally, keeps the calls that look like a product
   search, and remembers the URL shape per domain. Nothing is sent anywhere:
   the observation stays in chrome.storage, on this machine. */
const Sniffer = (() => {
  const CLE = 'prEndpoints';

  /* An URL is a search candidate when it carries the query we typed. */
  let termeAttendu = null;
  const captures = [];

  function estJson(contentType) {
    return /json/i.test(contentType || '');
  }

  /* Does this payload look like a product list? We ask three questions:
     is it an array (or does it hold one), do the items have a name-ish and a
     price-ish field, and are there several of them. */
  /* `minimum` vaut 2 pendant l'APPRENTISSAGE — deux éléments au moins pour
     ne pas prendre n'importe quel objet pour une liste de produits — mais 1
     à l'USAGE : une recherche pointue peut ne ramener qu'un seul produit, et
     le rejeter reviendrait à perdre le prix de cet ingrédient. */
  function trouverListeProduits(data, profondeur = 0, minimum = 2) {
    if (!data || profondeur > 4) return null;
    if (Array.isArray(data)) {
      if (data.length >= minimum && data.every(x => x && typeof x === 'object')) {
        const cles = Object.keys(data[0]).map(k => k.toLowerCase());
        const aNom = cles.some(k => /(lib|nom|name|titre|title|designation)/.test(k));
        const aPrix = cles.some(k => /(prix|price|amount|tarif)/.test(k));
        if (aNom && aPrix) return data;
      }
      for (const item of data.slice(0, 5)) {
        const t = trouverListeProduits(item, profondeur + 1, minimum);
        if (t) return t;
      }
      return null;
    }
    if (typeof data === 'object') {
      for (const v of Object.values(data)) {
        const t = trouverListeProduits(v, profondeur + 1, minimum);
        if (t) return t;
      }
    }
    return null;
  }

  /* La page lance souvent sa requête avant que le pilote ait eu le temps de
     demander une observation. On enregistre donc en continu, dans un tampon
     glissant, et on filtre après coup par le terme cherché. */
  function noterCandidat(url, methode, corps, texte) {
    let data;
    try { data = JSON.parse(texte); } catch { return; }
    const liste = trouverListeProduits(data);
    if (!liste) return;
    captures.push({
      url, methode,
      corps: corps ? String(corps).slice(0, 500) : null,
      exemple: liste[0], taille: liste.length, date: Date.now()
    });
    if (captures.length > 20) captures.shift();
  }

  /* Install the wrappers. Idempotent, and deliberately transparent: every
     call is forwarded untouched, we only look at a copy of the response. */
  let installe = false;
  function installer() {
    if (installe) return;
    installe = true;

    const fetchOrigine = window.fetch;
    window.fetch = async function (...args) {
      const reponse = await fetchOrigine.apply(this, args);
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req.url;
        const methode = (args[1]?.method || (typeof req === 'object' ? req.method : 'GET') || 'GET').toUpperCase();
        const corps = args[1]?.body || null;
        noterPanier(url, methode, corps);
        if (estJson(reponse.headers.get('content-type'))) {
          reponse.clone().text().then(t => noterCandidat(url, methode, corps, t)).catch(() => {});
        }
      } catch { /* ne jamais gêner la page */ }
      return reponse;
    };

    const openOrigine = XMLHttpRequest.prototype.open;
    const sendOrigine = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (methode, url, ...reste) {
      this.__pr = { methode: (methode || 'GET').toUpperCase(), url };
      return openOrigine.call(this, methode, url, ...reste);
    };
    XMLHttpRequest.prototype.send = function (corps) {
      try { if (this.__pr) noterPanier(this.__pr.url, this.__pr.methode, corps); } catch { /* ignore */ }
      this.addEventListener('load', () => {
        try {
          if (this.__pr && estJson(this.getResponseHeader('content-type'))) {
            noterCandidat(this.__pr.url, this.__pr.methode, corps, this.responseText);
          }
        } catch { /* ignore */ }
      });
      return sendOrigine.call(this, corps);
    };
  }

  /* --- Apprentissage de l'ajout au panier ------------------ */

  /* On observe le clic réel sur « Ajouter » d'un produit dont on connaît
     l'identifiant : la requête qui part et qui contient cet identifiant est
     l'appel d'ajout au panier. */
  let idAttendu = null;
  const capturesPanier = [];

  /* Même principe que pour la recherche : on garde toutes les écritures
     récentes, et on cherche après coup celle qui portait l'identifiant. */
  function noterPanier(url, methode, corps) {
    if (methode === 'GET') return;
    capturesPanier.push({
      url, methode,
      corps: corps ? String(corps).slice(0, 500) : null,
      date: Date.now()
    });
    if (capturesPanier.length > 20) capturesPanier.shift();
  }

  function observerPanier(idProduit) {
    idAttendu = idProduit ? String(idProduit) : null;
    installer();
  }

  function modelePanier(idProduit) {
    const id = String(idProduit);
    const c = [...capturesPanier].reverse()
      .find(x => `${x.url} ${x.corps || ''}`.includes(id));
    if (!c) return null;
    return {
      url: c.url.split('?')[0],
      urlComplete: c.url.replace(new RegExp(id, 'g'), '{id}'),
      methode: c.methode,
      corps: c.corps ? c.corps.replace(new RegExp(id, 'g'), '{id}') : null,
      domaine: location.hostname,
      date: new Date().toISOString()
    };
  }

  async function ajouter(m, idProduit, quantite = 1) {
    const url = (m.urlComplete || m.url).replace(/\{id\}/g, encodeURIComponent(idProduit));
    const options = { method: m.methode || 'POST', credentials: 'include', headers: {} };
    if (m.corps) {
      options.headers['Content-Type'] = 'application/json';
      options.body = m.corps.replace(/\{id\}/g, idProduit).replace(/\{qte\}/g, String(quantite));
    }
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`ajout au panier : ${res.status}`);
    return true;
  }

  /* Watch one real search and deduce the endpoint template. */
  function observer(terme) {
    termeAttendu = terme;
    installer();
  }

  function contient(capture, terme) {
    const t = terme.toLowerCase();
    return `${capture.url} ${capture.corps || ''}`.toLowerCase().includes(t)
      || capture.url.toLowerCase().includes(encodeURIComponent(t).toLowerCase());
  }

  function modele(terme) {
    const pertinentes = captures.filter(c => contient(c, terme));
    if (!pertinentes.length) return null;
    // la capture la plus riche est la bonne
    const meilleure = [...pertinentes].sort((a, b) => b.taille - a.taille)[0];
    const gabaritUrl = meilleure.url
      .replace(new RegExp(encodeURIComponent(terme), 'gi'), '{q}')
      .replace(new RegExp(terme, 'gi'), '{q}');
    const gabaritCorps = meilleure.corps
      ? meilleure.corps.replace(new RegExp(terme, 'gi'), '{q}')
      : null;
    if (!gabaritUrl.includes('{q}') && !(gabaritCorps || '').includes('{q}')) return null;
    return {
      url: gabaritUrl,
      methode: meilleure.methode,
      corps: gabaritCorps,
      champs: Object.keys(meilleure.exemple || {}),
      exemple: meilleure.exemple,
      taille: meilleure.taille,
      domaine: location.hostname,
      date: new Date().toISOString()
    };
  }

  async function enregistrer(m) {
    const data = await chrome.storage.local.get([CLE]);
    const tous = data[CLE] || {};
    tous[location.hostname] = m;
    await chrome.storage.local.set({ [CLE]: tous });
  }

  async function connu() {
    const data = await chrome.storage.local.get([CLE]);
    return (data[CLE] || {})[location.hostname] || null;
  }

  async function oublier() {
    const data = await chrome.storage.local.get([CLE]);
    const tous = data[CLE] || {};
    delete tous[location.hostname];
    await chrome.storage.local.set({ [CLE]: tous });
  }

  /* Query the learned endpoint directly. */
  async function chercher(m, terme) {
    const url = m.url.replace(/\{q\}/g, encodeURIComponent(terme));
    const options = { credentials: 'include', headers: { 'Accept': 'application/json' } };
    if (m.methode !== 'GET' && m.corps) {
      options.method = m.methode;
      options.headers['Content-Type'] = 'application/json';
      options.body = m.corps.replace(/\{q\}/g, terme);
    }
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`API du site : ${res.status}`);
    const data = await res.json();
    // À l'usage, un seul résultat est un résultat valable.
    const liste = trouverListeProduits(data, 0, 1);
    if (!liste) throw new Error('réponse inattendue de l\'API du site');
    return liste;
  }

  async function enregistrerPanier(m) {
    const data = await chrome.storage.local.get([CLE]);
    const tous = data[CLE] || {};
    tous[location.hostname] = { ...(tous[location.hostname] || {}), panier: m };
    await chrome.storage.local.set({ [CLE]: tous });
  }

  return {
    demarrer: installer,
    observer, modele, enregistrer, connu, oublier, chercher, trouverListeProduits, captures,
    observerPanier, modelePanier, enregistrerPanier, ajouter, capturesPanier
  };
})();

/* Les wrappers sont posés immédiatement : la page peut lancer sa requête
   avant que le pilote ne se réveille. */
Sniffer.demarrer();
globalThis.Sniffer = Sniffer;
