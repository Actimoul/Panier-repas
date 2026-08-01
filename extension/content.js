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
        cursor: 0, log: [], choix: [],
        auto: false,          // autopilot running
        awaitingResults: false // a search navigation is in flight
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

    panel.querySelector('#pr-skip').addEventListener('click', () => {
      state.log.push({ ok: true, msg: `→ ${state.articles[state.cursor].recherche} passé` });
      state.cursor += 1;
      save(); render();
      if (state.auto) scheduleTick(300);
    });
  }

  /* ---------- the autopilot ---------- */

  async function analyse() {
    const current = state.articles[state.cursor];
    const raw = StoreAdapter.harvestCandidates(8);
    if (!raw.length) throw new Error('Aucun produit détecté sur cette page');
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
      await StoreAdapter.addByIndex(choice.index, ranked);
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
    save();
    render();
    // Ne jamais rappeler tick() en direct : on peut être appelé DEPUIS tick,
    // et le verrou `working` avalerait l'appel imbriqué. On planifie.
    if (state.auto) scheduleTick(600);
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
    working = true;
    try {
      const current = state.articles[state.cursor];
      if (!state.awaitingResults) {
        // navigate: the content script reloads on the results page and resumes
        state.awaitingResults = true;
        save();
        setStatus(`Recherche « ${current.recherche} »…`);
        await new Promise(r => setTimeout(r, 400));
        location.href = StoreAdapter.searchPageUrl(current.recherche);
        return; // page unloads here
      }
      const ranked = await analyse();
      setStatus(`Retenu : ${Scoring.explain(ranked[0], ranked)}`);
      renderCandidates(ranked, (c) => commit(c, ranked));
      await new Promise(r => setTimeout(r, 900)); // laisse voir le choix
      await commit(ranked[0], ranked);
    } catch (err) {
      console.error(err);
      state.log.push({ ok: false, msg: `✗ ${err.message}` });
      state.awaitingResults = false;
      state.auto = false; // stop rather than loop on a broken page
      save(); render();
      setStatus('Pilote arrêté — reprends à la main ou relance.');
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
    panel = document.createElement('div');
    panel.id = 'pr-panel';
    document.body.appendChild(panel);
    render();
    // resume autopilot after the search navigation
    if (state.auto) scheduleTick(1200);
  }

  init().catch(err => console.error('Panier Repas init failed:', err));
})();
