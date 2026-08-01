/* Floating panel injected on the store site. 

   AUTOPILOT: one click and the extension walks the whole list by itself —
   for each article it searches, harvests candidates, scores them (price per kg
   + Open Food Facts nutritional data), picks the best and adds it to the cart,
   then moves on. Navigation between searches survives page reloads because the
   whole state lives in chrome.storage.

   The user can pause at any time, or open the candidate list to choose.
   Hard rule: NEVER touches checkout/payment pages. */
(() => {
  const PAYMENT_HINTS = ['paiement', 'checkout', 'commande/valider'];
  if (PAYMENT_HINTS.some(h => location.href.toLowerCase().includes(h))) return;

  /* Rythme : un site marchand n'aime pas les rafales. Ces délais sont ce qui
     sépare un pilote discret d'un pilote qui déclenche une erreur 500. */
  const DELAI_RECHERCHE = 6000;  // entre deux recherches (+ variation aléatoire)
  const DELAI_ECHEC = 12000;     // après un échec, puis ×2, ×3
  const DELAI_API = 500;         // via l'API interne : pas de page à charger
  const SCORE_MINIMUM = 35;      // en dessous, on ne met rien dans le panier

  /* Un peu d'irrégularité : des requêtes parfaitement cadencées sont ce qui
     ressemble le moins à une navigation humaine. */
  const rythme = (base) => base + Math.round(Math.random() * base * 0.4);

  let state = null;
  let panel = null;
  let working = false;

  const save = () => chrome.storage.local.set({ prState: state })
    .catch(err => console.error('state save failed', err));

  async function loadState() {
    const data = await chrome.storage.local.get(['prList', 'prState']);
    if (data.prState?.articles?.length) {
      state = data.prState;
    } else if (data.prList?.articles?.length) {
      state = {
        articles: data.prList.articles,
        creneau: data.prList.creneau || null,
        prefSante: data.prList.pref_sante ?? 0.5,
        budgetMax: data.prList.budget_max_article || null,
        cursor: 0, log: [], choix: [], aVerifier: [],
        auto: false,           // autopilot running
        awaitingResults: false,// a search navigation is in flight
        echecs: 0,             // consecutive failures → back off, then stop
        pauseJusqua: 0,        // epoch ms: don't touch the site before this
        modeApi: false         // true once both endpoints are known
      };
      save();
    }
  }

  /* ---------- rendering ---------- */

  function html() {
    const total = state.articles.length;
    const done = state.cursor >= total;
    const current = state.articles[state.cursor];
    const pct = Math.round((Math.min(state.cursor, total) / total) * 100);
    const e = StoreAdapter.enseigne();
    const enseigneLigne = `<div class="pr-store">${e ? e.nom : '⚠ enseigne non reconnue'}</div>`;
    const creneau = state.creneau
      ? `<div class="pr-slot">🚚 ${state.creneau.label} — ${state.creneau.date}</div>` : '';
    const logLines = state.log.slice(-5)
      .map(l => `<div class="pr-log ${l.ok ? '' : 'pr-err'}">${l.msg}</div>`).join('');
    const prefLabel = state.prefSante <= 0.25 ? 'prix'
      : state.prefSante >= 0.75 ? 'santé' : 'équilibré';

    if (done) {
      const totalEur = state.choix.reduce((a, c) => a + (c.prix_eur || 0), 0);
      return `
        <div class="pr-head"><strong>Panier Repas</strong><span>${total}/${total}</span>
          <button id="pr-close" title="Fermer">✕</button></div>
        ${enseigneLigne}
        ${creneau}
        <div class="pr-done">✅ Panier rempli — ${state.choix.length} produits, ${totalEur.toFixed(2)} €.<br>
          ${(state.aVerifier || []).length
            ? `<span class="pr-warn">${state.aVerifier.length} article(s) à ajouter à la main : ${state.aVerifier.join(', ')}</span><br>` : ''}
          Vérifie puis paie <b>toi-même</b>.
          <button id="pr-export" class="pr-wide">Copier les choix pour l'app</button></div>
        ${logLines}
        <button id="pr-reset" class="pr-reset">Réinitialiser</button>`;
    }

    return `
      <div class="pr-head"><strong>Panier Repas</strong><span>${state.cursor}/${total}</span>
        <button id="pr-close" title="Fermer">✕</button></div>
      ${enseigneLigne}
      ${creneau}
      <div class="pr-bar"><div class="pr-bar-fill" style="width:${pct}%"></div></div>
      <div class="pr-current">
        <div class="pr-name">${current.recherche}</div>
        <div class="pr-qty">${current.packs ? current.packs + ' pack(s)' : current.quantite_besoin + ' ' + current.unite}</div>
      </div>
      <div class="pr-pref">Critère : <b>${prefLabel}</b>
        <input type="range" id="pr-slider" min="0" max="1" step="0.25" value="${state.prefSante}" ${state.auto ? 'disabled' : ''} />
      </div>
      <button id="pr-toggle" class="pr-wide ${state.auto ? 'pr-stop' : ''}">
        ${state.auto ? '⏸ Mettre en pause' : '▶ Remplir tout le panier'}
      </button>
      <div class="pr-actions">
        <button id="pr-manual">Choisir ce produit…</button>
        <button id="pr-skip">Passer</button>
      </div>
      ${state.modeApi
        ? '<button id="pr-prix" class="pr-wide pr-secondaire">💶 Relever tous les prix (rapide)</button>'
        : '<div class="pr-note">💶 Les prix des produits ajoutés sont enregistrés au fil de l\'eau. Le relevé complet nécessite le mode rapide.</div>'}
      <div id="pr-status" class="pr-status"></div>
      <div id="pr-candidates"></div>
      ${logLines}
      <button id="pr-reset" class="pr-reset">Réinitialiser</button>`;
  }

  const setStatus = (msg) => {
    const el = panel?.querySelector('#pr-status');
    if (el) el.textContent = msg || '';
  };

  function renderCandidates(list, onPick) {
    const box = panel.querySelector('#pr-candidates');
    if (!box) return;
    box.innerHTML = list.slice(0, 5).map((c, i) => `
      <button class="pr-cand ${i === 0 ? 'best' : ''}" data-i="${c.index}">
        <div class="pr-cand-top">${i === 0 ? '★ ' : ''}${c.libelle.slice(0, 46)}</div>
        <div class="pr-cand-sub">${c.score}/100 · ${c.prix_eur ? c.prix_eur.toFixed(2) + ' €' : 'prix ?'}${
          c.prix_unitaire ? ' · ' + c.prix_unitaire.toFixed(2) + ' €/kg' : ''}${
          c.sante_details?.length ? ' · ' + c.sante_details.slice(0, 2).join(', ') : ''}</div>
      </button>`).join('');
    box.querySelectorAll('.pr-cand').forEach(btn => btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.i, 10);
      onPick(list.find(c => c.index === idx));
    }));
  }

  function render() {
    panel.innerHTML = html();

    panel.querySelector('#pr-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#pr-reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(['prState']);
      state = null;
      await loadState();
      if (state) render(); else panel.remove();
    });

    panel.querySelector('#pr-export')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(
          { source: 'panier-repas-choix', version: 1, choix: state.choix }, null, 2));
        panel.querySelector('#pr-export').textContent = 'Copié ✓';
      } catch (err) { console.error('Clipboard failed:', err); }
    });

    if (state.cursor >= state.articles.length) return;

    panel.querySelector('#pr-slider').addEventListener('change', (e) => {
      state.prefSante = parseFloat(e.target.value);
      save(); render();
    });

    panel.querySelector('#pr-toggle').addEventListener('click', () => {
      state.auto = !state.auto;
      save(); render();
      if (state.auto) scheduleTick(200);
    });

    panel.querySelector('#pr-manual').addEventListener('click', async () => {
      state.auto = false; save(); render();
      try {
        const ranked = await analyse();
        setStatus('Choisis un produit :');
        renderCandidates(ranked, (c) => commit(c, ranked));
      } catch (err) { setStatus(err.message); }
    });

    panel.querySelector('#pr-prix')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#pr-prix');
      btn.disabled = true;
      const etatAuto = state.auto;
      state.auto = false;
      try {
        const data = await chrome.storage.local.get(['prAReleverPrix']);
        const liste = data.prAReleverPrix?.length
          ? data.prAReleverPrix
          : state.articles.map(a => a.nom_canonique).filter(Boolean);
        const r = await releverPrix(liste);
        const n = Object.keys(r.prix).length;
        state.log.push({ ok: true, msg: `💶 ${n} prix relevés chez ${r.enseigne}` });
        setStatus(`${n} prix relevés — récupère-les depuis l'app`);
      } catch (err) {
        console.error(err);
        state.log.push({ ok: false, msg: `✗ relevé : ${err.message}` });
      } finally {
        state.auto = etatAuto;
        btn.disabled = false;
        save(); render();
      }
    });

    panel.querySelector('#pr-skip').addEventListener('click', () => {
      state.log.push({ ok: true, msg: `→ ${state.articles[state.cursor].recherche} passé` });
      state.cursor += 1;
      save(); render();
      if (state.auto) scheduleTick(300);
    });
  }

  /* ---------- the autopilot ---------- */

  /* Endpoints learned for this domain, if any. */
  let apiRecherche = null;
  let apiPanier = null;

  async function chargerApi() {
    const e = await Sniffer.connu();
    apiRecherche = e && e.url ? e : null;
    apiPanier = e && e.panier ? e.panier : null;
    return !!(apiRecherche && apiPanier);
  }

  /* Fast path: query the site's own JSON endpoint. No navigation, no render. */
  async function analyseApi() {
    const current = state.articles[state.cursor];
    setStatus(`« ${current.recherche} » — recherche directe…`);
    const liste = await Sniffer.chercher(apiRecherche, current.recherche);
    const bruts = StoreAdapter.candidatsDepuisApi(liste, 8);
    if (!bruts.length) {
      const e = new Error(`Aucun résultat pour « ${current.recherche} »`);
      e.sansResultat = true;
      throw e;
    }
    await Scoring.enrich(bruts, (d, t) => setStatus(`Composition ${d}/${t}…`));
    return Scoring.rank(bruts, {
      prefSante: state.prefSante,
      budgetMax: state.budgetMax,
      nomCanonique: current.nom_canonique || current.recherche
    });
  }

  async function analyse() {
    const current = state.articles[state.cursor];
    const err = StoreAdapter.pageEnErreur();
    if (err) { const e = new Error(`Le site répond : ${err}`); e.siteEnPanne = true; throw e; }
    const raw = StoreAdapter.harvestCandidates(8);
    if (!raw.length) {
      if (StoreAdapter.aucunResultat()) {
        const e = new Error(`Aucun résultat pour « ${current.recherche} »`);
        e.sansResultat = true;
        throw e;
      }
      throw new Error('Aucun produit détecté sur cette page');
    }
    setStatus(`${raw.length} candidats — composition…`);
    await Scoring.enrich(raw, (d, t) => setStatus(`Composition ${d}/${t}…`));
    const ranked = Scoring.rank(raw, {
      prefSante: state.prefSante,
      budgetMax: state.budgetMax,
      nomCanonique: current.nom_canonique || current.recherche
    });
    if (!ranked.length || ranked[0].score <= 0) {
      throw new Error(`Aucun produit ne correspond à « ${current.recherche} »`);
    }
    return ranked;
  }

  async function commit(choice, ranked) {
    const current = state.articles[state.cursor];
    try {
      setStatus('Ajout au panier…');
      if (state.modeApi && apiPanier && choice._api) {
        const id = StoreAdapter.valeurChamp(choice._api, StoreAdapter.CHAMPS.ean)
          || choice._api.id || choice._api.idProduit;
        await Sniffer.ajouter(apiPanier, id, choice.packs || 1);
      } else {
        // Observer l'appel qui va partir : c'est ainsi qu'on apprend l'ajout direct.
        const idProduit = choice.ean
          || choice._card?.getAttribute?.('data-id-produit')
          || choice._card?.getAttribute?.('data-id')
          || choice._card?.querySelector?.('[data-id]')?.getAttribute('data-id')
          || null;
        if (idProduit) Sniffer.observerPanier(idProduit);
        await StoreAdapter.addByIndex(choice.index, ranked);
        // Premier ajout réussi par clic : c'est le moment d'apprendre l'appel
        // panier, pendant que la requête vient de partir.
        await apprendrePanier(choice);
      }
      state.choix.push({
        nom_canonique: current.nom_canonique,
        libelle: choice.libelle,
        prix_eur: choice.prix_eur,
        ean: choice.ean,
        score: choice.score,
        justification: Scoring.explain(choice, ranked)
      });
      state.log.push({ ok: true, msg: `✓ ${choice.libelle.slice(0, 32)} — ${choice.score}/100` });
    } catch (err) {
      console.error(err);
      state.log.push({ ok: false, msg: `✗ ${current.recherche} : ${err.message}` });
    }
    state.cursor += 1;
    state.awaitingResults = false;
    if (!state.modeApi && apiRecherche && apiPanier) {
      state.modeApi = true;
      state.log.push({ ok: true, msg: '⚡ mode rapide activé — plus de navigation' });
    }
    save();
    render();
    // Ne jamais rappeler tick() en direct : on peut être appelé DEPUIS tick,
    // et le verrou `working` avalerait l'appel imbriqué. On planifie.
    if (state.auto) scheduleTick(state.modeApi ? DELAI_API : 600);
  }

  /* Record the real price of one ingredient, from the product just chosen. */
  async function enregistrerPrix(nomCanonique, choice) {
    if (!nomCanonique) return;
    const parKg = Scoring.unitPrice(choice);
    if (!(parKg > 0)) return;
    const data = await chrome.storage.local.get(['prPrix']);
    const releve = data.prPrix || {
      enseigne: StoreAdapter.enseigne()?.nom || location.hostname,
      domaine: location.hostname,
      date: new Date().toISOString(),
      prix: {}, echecs: []
    };
    releve.prix[nomCanonique] = {
      par_kg: Math.round(parKg * 100) / 100,
      libelle: choice.libelle,
      prix_eur: choice.prix_eur,
      ean: choice.ean || null,
      score: choice.score
    };
    releve.date = new Date().toISOString();
    releve.enseigne = StoreAdapter.enseigne()?.nom || releve.enseigne;
    await chrome.storage.local.set({ prPrix: releve });
  }

  /* Price sweep: query the store's own API for a list of ingredients and
     record the real price per kg of the best matching product for each.
     Only possible in API mode — one page load per ingredient would take
     twenty minutes and hammer the site. */
  async function releverPrix(ingredients) {
    if (!apiRecherche) throw new Error('API du site pas encore apprise');
    const prix = {};
    const echecs = [];
    for (let i = 0; i < ingredients.length; i++) {
      const nom = ingredients[i];
      setStatus(`Relevé des prix ${i + 1}/${ingredients.length} — ${nom}`);
      try {
        const liste = await Sniffer.chercher(apiRecherche, nom);
        const bruts = StoreAdapter.candidatsDepuisApi(liste, 6);
        if (!bruts.length) { echecs.push(nom); continue; }
        const ranked = Scoring.rank(bruts, { prefSante: state.prefSante, nomCanonique: nom });
        const best = ranked[0];
        if (!best || best.score < SCORE_MINIMUM) { echecs.push(nom); continue; }
        const parKg = Scoring.unitPrice(best);
        if (parKg > 0) {
          prix[nom] = {
            par_kg: Math.round(parKg * 100) / 100,
            libelle: best.libelle,
            prix_eur: best.prix_eur,
            ean: best.ean || null,
            score: best.score
          };
        } else {
          echecs.push(nom);
        }
      } catch (err) {
        console.warn('relevé', nom, err.message);
        echecs.push(nom);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const releve = {
      enseigne: StoreAdapter.enseigne()?.nom || location.hostname,
      domaine: location.hostname,
      date: new Date().toISOString(),
      prix, echecs
    };
    await chrome.storage.local.set({ prPrix: releve });
    return releve;
  }

  /* Threshold, fallback, add. Shared by the DOM path and the API path. */
  async function deciderEtAjouter(ranked) {
    const current = state.articles[state.cursor];
    // Ne rien mettre au panier plutôt que d'y mettre n'importe quoi : un
    // « gratin à l'ail » n'est pas de l'ail, mieux vaut le signaler.
    const acceptables = ranked.filter(c => c.score >= SCORE_MINIMUM);
    if (!acceptables.length) {
      state.log.push({
        ok: false,
        msg: `⊘ ${current.recherche} : rien de convaincant (meilleur ${ranked[0].score}/100) — à faire à la main`
      });
      state.cursor += 1;
      state.aVerifier = [...(state.aVerifier || []), current.recherche];
      state.pauseJusqua = Date.now() + (state.modeApi ? DELAI_API : rythme(DELAI_RECHERCHE));
      save(); render();
      if (state.auto) scheduleTick(state.modeApi ? DELAI_API : 600);
      return;
    }
    const retenu = state.modeApi
      ? acceptables[0]
      : (acceptables.find(c => StoreAdapter.findAddButton(c._card)) || acceptables[0]);
    if (retenu !== ranked[0]) state.log.push({ ok: true, msg: '↓ repli sur un autre candidat' });
    setStatus(`Retenu : ${Scoring.explain(retenu, ranked)}`);
    renderCandidates(ranked, (c) => commit(c, ranked));
    if (!state.modeApi) await new Promise(r => setTimeout(r, 900));
    await commit(retenu, ranked);
  }

  async function apprendreRecherche(terme) {
    if (apiRecherche) return;
    const m = Sniffer.modele(terme);
    if (!m) return;
    await Sniffer.enregistrer(m);
    apiRecherche = m;
    state.log.push({ ok: true, msg: '⚡ recherche directe apprise' });
  }

  /* Learn the cart endpoint from the click we just made. */
  async function apprendrePanier(choice) {
    if (apiPanier) return;
    const id = choice.ean
      || choice._card?.getAttribute?.('data-id-produit')
      || choice._card?.getAttribute?.('data-id')
      || choice._card?.querySelector?.('[data-id]')?.getAttribute('data-id')
      || null;
    if (!id) return;
    await new Promise(r => setTimeout(r, 400));   // laisser la requête partir
    const m = Sniffer.modelePanier(id);
    if (!m) return;
    await Sniffer.enregistrerPanier(m);
    apiPanier = m;
    state.log.push({ ok: true, msg: '⚡ ajout direct appris — la suite ira vite' });
  }

  let tickTimer = null;
  function scheduleTick(delay = 300) {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tick().catch(err => console.error(err)); }, delay);
  }

  /* One step of the autopilot. Either we are on a results page for the
     current article (analyse + pick), or we navigate to the search. */
  async function tick() {
    if (working || !state.auto) return;
    if (state.cursor >= state.articles.length) { state.auto = false; save(); render(); return; }

    // Respecter le rythme : un site marchand n'est pas une API.
    const attente = state.pauseJusqua - Date.now();
    if (attente > 0) {
      setStatus(`Pause ${Math.ceil(attente / 1000)} s pour ménager le site…`);
      scheduleTick(attente + 200);
      return;
    }

    working = true;
    try {
      const current = state.articles[state.cursor];

      // Chemin rapide : les deux points d'entrée du site sont connus, plus
      // aucune page à charger.
      if (state.modeApi) {
        const ranked = await analyseApi();
        state.echecs = 0;
        await deciderEtAjouter(ranked);
        return;
      }

      if (!state.awaitingResults) {
        state.awaitingResults = true;
        state.pauseJusqua = Date.now() + rythme(DELAI_RECHERCHE);
        save();
        setStatus(`Recherche « ${current.recherche} »…`);
        Sniffer.observer(current.recherche);
        await new Promise(r => setTimeout(r, 700));
        location.href = StoreAdapter.searchPageUrl(current.recherche);
        return; // page unloads here
      }
      const ranked = await analyse();
      state.echecs = 0;
      await apprendreRecherche(current.recherche);
      await deciderEtAjouter(ranked);
    } catch (err) {
      console.error(err);
      state.awaitingResults = false;

      if (err.sansResultat) {
        // pas une panne : on passe simplement l'article
        state.log.push({ ok: false, msg: `→ ${err.message} — passé` });
        state.cursor += 1;
        state.echecs = 0;
        state.pauseJusqua = Date.now() + rythme(DELAI_RECHERCHE);
        save(); render();
        if (state.auto) scheduleTick(600);
        return;
      }

      state.echecs += 1;
      state.log.push({ ok: false, msg: `✗ ${err.message}` });

      if (err.siteEnPanne || state.echecs >= 3) {
        state.auto = false;
        const minutes = err.siteEnPanne ? 2 : 1;
        state.pauseJusqua = Date.now() + minutes * 60000;
        save(); render();
        setStatus(err.siteEnPanne
          ? `Le site est en difficulté. Pilote arrêté — attends ~${minutes} min puis relance.`
          : 'Trois échecs d\'affilée. Pilote arrêté — reprends à la main ou relance.');
        return;
      }

      // échec isolé : on ralentit et on retente la même recherche
      state.pauseJusqua = Date.now() + DELAI_ECHEC * state.echecs;
      save(); render();
      if (state.auto) scheduleTick(DELAI_ECHEC * state.echecs);
    } finally {
      working = false;
    }
  }

  async function init() {
    // le script peut s'exécuter avant que le body existe (document_start)
    if (!document.body) {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    await loadState();
    if (!state) return;
    if (document.getElementById('pr-panel')) return; // déjà injecté

    // Points d'entrée déjà appris pour ce site ? Alors on ira vite.
    const pret = await chargerApi();
    if (pret) state.modeApi = true;

    // Sur une page d'erreur, on met le pilote en pause avant même d'afficher
    // quoi que ce soit : inutile d'insister sur un site en difficulté.
    const panne = StoreAdapter.pageEnErreur();
    if (panne && state.auto) {
      state.auto = false;
      state.awaitingResults = false;
      state.pauseJusqua = Date.now() + 120000;
      state.log.push({ ok: false, msg: `✗ site en difficulté (${panne}) — pilote en pause` });
      save();
    }
    panel = document.createElement('div');
    panel.id = 'pr-panel';
    document.body.appendChild(panel);
    render();
    // resume autopilot after the search navigation
    if (state.auto) scheduleTick(1200);
  }

  init().catch(err => console.error('Panier Repas init failed:', err));
})();
