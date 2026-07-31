/* Floating panel injected on the Leclerc site.
   Reads the shopping list from chrome.storage.local (set via the popup),
   walks through items: search → add to cart → next.
   Hard rule: NEVER touches checkout/payment pages. */
(() => {
  const PAYMENT_HINTS = ['paiement', 'checkout', 'commande/valider'];
  if (PAYMENT_HINTS.some(h => location.href.toLowerCase().includes(h))) {
    return; // never operate on payment pages
  }

  let state = null; // { articles: [...], cursor: number, log: [] }

  function saveState() {
    chrome.storage.local.set({ prState: state }).catch(err => console.error('state save failed', err));
  }

  async function loadState() {
    const data = await chrome.storage.local.get(['prList', 'prState']);
    if (data.prState && data.prState.articles?.length) {
      state = data.prState;
    } else if (data.prList && data.prList.articles?.length) {
      state = { articles: data.prList.articles, creneau: data.prList.creneau || null, cursor: 0, log: [] };
      saveState();
    }
  }

  function panelHtml() {
    const total = state.articles.length;
    const current = state.articles[state.cursor];
    const done = state.cursor >= total;
    const creneau = state.creneau
      ? `<div class="pr-slot">🚚 Créneau visé : ${state.creneau.label} — ${state.creneau.date}</div>`
      : '';
    const logLines = state.log.slice(-4).map(l => `<div class="pr-log ${l.ok ? '' : 'pr-err'}">${l.msg}</div>`).join('');
    return `
      <div class="pr-head">
        <strong>Panier Repas</strong>
        <span>${Math.min(state.cursor, total)}/${total}</span>
        <button id="pr-close" title="Fermer">✕</button>
      </div>
      ${creneau}
      ${done
        ? `<div class="pr-done">✅ Liste terminée.<br>Vérifie ton panier puis passe au paiement <b>toi-même</b>.</div>`
        : `<div class="pr-current">
             <div class="pr-name">${current.recherche}</div>
             <div class="pr-qty">${current.packs ? current.packs + ' pack(s)' : current.quantite_besoin + ' ' + current.unite}</div>
           </div>
           <div class="pr-actions">
             <button id="pr-search">1. Chercher</button>
             <button id="pr-add">2. Ajouter 1er résultat</button>
             <button id="pr-skip">Passer</button>
           </div>`}
      ${logLines}
      <button id="pr-reset" class="pr-reset">Réinitialiser la liste</button>`;
  }

  function render(panel) {
    panel.innerHTML = panelHtml();
    panel.querySelector('#pr-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#pr-reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(['prState']);
      state.cursor = 0;
      state.log = [];
      await loadState();
      render(panel);
    });
    const current = state.articles[state.cursor];
    if (!current) return;

    panel.querySelector('#pr-search')?.addEventListener('click', () => {
      saveState();
      location.href = LeclercAdapter.searchPageUrl(current.recherche);
    });
    panel.querySelector('#pr-add')?.addEventListener('click', async () => {
      try {
        const result = await LeclercAdapter.addFirstResultFromCurrentPage();
        state.log.push({ ok: true, msg: `✓ ${result.libelle}` });
        state.cursor += 1;
      } catch (err) {
        console.error(err);
        state.log.push({ ok: false, msg: `✗ ${current.recherche} : ${err.message}` });
      }
      saveState();
      render(panel);
    });
    panel.querySelector('#pr-skip')?.addEventListener('click', () => {
      state.log.push({ ok: true, msg: `→ ${current.recherche} passé` });
      state.cursor += 1;
      saveState();
      render(panel);
    });
  }

  async function init() {
    await loadState();
    if (!state) return; // no list loaded: stay invisible
    const panel = document.createElement('div');
    panel.id = 'pr-panel';
    document.body.appendChild(panel);
    render(panel);
  }

  init().catch(err => console.error('Panier Repas init failed:', err));
})();
