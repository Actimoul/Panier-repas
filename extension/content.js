/* Floating panel injected on the Leclerc site.
   For each article: search → harvest candidates → score them (price/kg +
   Open Food Facts health data) → auto-pick the best → add to cart.
   The user can always override with "Choisir…".
   Hard rule: NEVER touches checkout/payment pages. */
(() => {
  const PAYMENT_HINTS = ['paiement', 'checkout', 'commande/valider'];
  if (PAYMENT_HINTS.some(h => location.href.toLowerCase().includes(h))) return;

  let state = null;   // { articles, creneau, cursor, log, prefSante, choix }
  let busy = false;

  function saveState() {
    chrome.storage.local.set({ prState: state }).catch(err => console.error('state save failed', err));
  }

  async function loadState() {
    const data = await chrome.storage.local.get(['prList', 'prState']);
    if (data.prState && data.prState.articles?.length) {
      state = data.prState;
    } else if (data.prList && data.prList.articles?.length) {
      state = {
        articles: data.prList.articles,
        creneau: data.prList.creneau || null,
        prefSante: data.prList.pref_sante ?? 0.5,
        budgetMax: data.prList.budget_max_article || null,
        cursor: 0,
        log: [],
        choix: []   // products actually picked, sent back to the app
      };
      saveState();
    }
  }

  /* Score the current results page and return the ranked candidates. */
  async function analysePage(setStatus) {
    const raw = LeclercAdapter.harvestCandidates(8);
    if (!raw.length) throw new Error('Aucun produit sur cette page (sélecteurs à ajuster ?)');
    setStatus(`${raw.length} candidats — analyse nutritionnelle…`);
    await Scoring.enrich(raw, (done, total) => setStatus(`Composition ${done}/${total}…`));
    return Scoring.rank(raw, { prefSante: state.prefSante, budgetMax: state.budgetMax });
  }

  function panelHtml() {
    const total = state.articles.length;
    const current = state.articles[state.cursor];
    const done = state.cursor >= total;
    const creneau = state.creneau
      ? `<div class="pr-slot">🚚 ${state.creneau.label} — ${state.creneau.date}</div>` : '';
    const logLines = state.log.slice(-4)
      .map(l => `<div class="pr-log ${l.ok ? '' : 'pr-err'}">${l.msg}</div>`).join('');

    const prefLabel = state.prefSante <= 0.25 ? 'prix'
      : state.prefSante >= 0.75 ? 'santé' : 'équilibré';

    return `
      <div class="pr-head">
        <strong>Panier Repas</strong>
        <span>${Math.min(state.cursor, total)}/${total}</span>
        <button id="pr-close" title="Fermer">✕</button>
      </div>
      ${creneau}
      ${done ? `<div class="pr-done">✅ Liste terminée.<br>Vérifie ton panier puis paie <b>toi-même</b>.
                  <button id="pr-export" class="pr-wide">Copier les choix pour l'app</button></div>`
        : `<div class="pr-current">
             <div class="pr-name">${current.recherche}</div>
             <div class="pr-qty">${current.packs ? current.packs + ' pack(s)' : current.quantite_besoin + ' ' + current.unite}</div>
           </div>
           <div class="pr-pref">
             Critère : <b>${prefLabel}</b>
             <input type="range" id="pr-slider" min="0" max="1" step="0.25" value="${state.prefSante}" />
           </div>
           <div class="pr-actions">
             <button id="pr-search">1. Chercher</button>
             <button id="pr-auto">2. Meilleur choix</button>
             <button id="pr-manual">Choisir…</button>
             <button id="pr-skip">Passer</button>
           </div>
           <div id="pr-status" class="pr-status"></div>
           <div id="pr-candidates"></div>`}
      ${logLines}
      <button id="pr-reset" class="pr-reset">Réinitialiser la liste</button>`;
  }

  function renderCandidates(list, panel, onPick) {
    const box = panel.querySelector('#pr-candidates');
    if (!box) return;
    box.innerHTML = list.slice(0, 5).map((c, i) => `
      <button class="pr-cand ${i === 0 ? 'best' : ''}" data-i="${c.index}">
        <div class="pr-cand-top">${i === 0 ? '★ ' : ''}${c.libelle.slice(0, 46)}</div>
        <div class="pr-cand-sub">${c.score}/100 · ${c.prix_eur ? c.prix_eur.toFixed(2) + ' €' : 'prix ?'}${
          c.prix_unitaire ? ' · ' + c.prix_unitaire.toFixed(2) + ' €/kg' : ''}${
          c.sante_details.length ? ' · ' + c.sante_details.slice(0, 2).join(', ') : ''}</div>
      </button>`).join('');
    box.querySelectorAll('.pr-cand').forEach(btn => btn.addEventListener('click', () => {
      onPick(list.find(c => c.index === parseInt(btn.dataset.i, 10)));
    }));
  }

  function render(panel) {
    panel.innerHTML = panelHtml();
    const setStatus = (msg) => {
      const el = panel.querySelector('#pr-status');
      if (el) el.textContent = msg || '';
    };

    panel.querySelector('#pr-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#pr-reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(['prState']);
      state = null;
      await loadState();
      render(panel);
    });

    panel.querySelector('#pr-export')?.addEventListener('click', async () => {
      const payload = { source: 'panier-repas-choix', version: 1, choix: state.choix };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        panel.querySelector('#pr-export').textContent = 'Copié ✓';
      } catch (err) {
        console.error('Clipboard failed:', err);
      }
    });

    const current = state.articles[state.cursor];
    if (!current) return;

    panel.querySelector('#pr-slider').addEventListener('change', (e) => {
      state.prefSante = parseFloat(e.target.value);
      saveState();
      render(panel);
    });

    panel.querySelector('#pr-search').addEventListener('click', () => {
      saveState();
      location.href = LeclercAdapter.searchPageUrl(current.recherche);
    });

    /* Record the pick, add to cart, advance. */
    async function commit(choice) {
      try {
        setStatus('Ajout au panier…');
        await LeclercAdapter.addByIndex(choice.index);
        state.choix.push({
          nom_canonique: current.nom_canonique,
          libelle: choice.libelle,
          prix_eur: choice.prix_eur,
          ean: choice.ean,
          score: choice.score,
          justification: Scoring.explain(choice)
        });
        state.log.push({ ok: true, msg: `✓ ${choice.libelle.slice(0, 34)} (${choice.score}/100)` });
        state.cursor += 1;
      } catch (err) {
        console.error(err);
        state.log.push({ ok: false, msg: `✗ ${err.message}` });
      }
      saveState();
      render(panel);
    }

    panel.querySelector('#pr-auto').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const ranked = await analysePage(setStatus);
        const best = ranked[0];
        setStatus(`Retenu : ${Scoring.explain(best, ranked)}`);
        await commit(best);
      } catch (err) {
        console.error(err);
        setStatus('');
        state.log.push({ ok: false, msg: `✗ ${err.message}` });
        saveState();
        render(panel);
      } finally {
        busy = false;
      }
    });

    panel.querySelector('#pr-manual').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const ranked = await analysePage(setStatus);
        setStatus('Choisis un produit :');
        renderCandidates(ranked, panel, commit);
      } catch (err) {
        console.error(err);
        setStatus(err.message);
      } finally {
        busy = false;
      }
    });

    panel.querySelector('#pr-skip').addEventListener('click', () => {
      state.log.push({ ok: true, msg: `→ ${current.recherche} passé` });
      state.cursor += 1;
      saveState();
      render(panel);
    });
  }

  async function init() {
    await loadState();
    if (!state) return;
    const panel = document.createElement('div');
    panel.id = 'pr-panel';
    document.body.appendChild(panel);
    render(panel);
  }

  init().catch(err => console.error('Panier Repas init failed:', err));
})();
