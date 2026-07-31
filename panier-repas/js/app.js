/* Main UI logic. French UI text, English code. Errors always surface as toasts. */
(() => {
  const view = document.getElementById('view');
  const toastEl = document.getElementById('toast');
  const tabs = [...document.querySelectorAll('.tab')];
  let currentTab = 'semaine';
  let generating = false;

  const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const REPAS_LABELS = { petit_dejeuner: 'Petit-déj', dejeuner: 'Déjeuner', collation: 'Collation', diner: 'Dîner' };
  const LECLERC_SEARCH = (q) => `https://www.leclercdrive.fr/recherche.aspx?TexteRecherche=${encodeURIComponent(q)}`;

  /* ---------- helpers ---------- */
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), isError ? 5000 : 2500);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function nextMonday() {
    const d = new Date();
    const day = d.getDay(); // 0 = sunday
    const delta = day === 1 ? 0 : (8 - day) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- tab: Semaine ---------- */
  function renderSemaine() {
    const plan = Store.getPlan();
    if (generating) {
      view.innerHTML = `<div class="loading" id="gen-status">Génération du plan de semaine…</div>`;
      return;
    }
    if (!plan) {
      view.innerHTML = `
        <div class="empty">
          <h2>Pas encore de plan</h2>
          <p>Configure ton profil puis génère ta première semaine de repas.</p>
          <button class="btn primary" id="btn-generate">Générer ma semaine</button>
        </div>`;
      document.getElementById('btn-generate').addEventListener('click', generatePlan);
      return;
    }

    // daily macros from planning
    const byId = Object.fromEntries(plan.recettes.map(r => [r.id, r]));
    const dayTotals = {};
    for (const p of plan.planning || []) {
      const r = byId[p.recette_id];
      if (!r) continue;
      const t = dayTotals[p.jour] || (dayTotals[p.jour] = { kcal: 0, prot: 0 });
      t.kcal += r.macros_par_portion.kcal * (p.portions || 1);
      t.prot += r.macros_par_portion.proteines_g * (p.portions || 1);
    }

    const pills = Object.keys(dayTotals).sort((a, b) => a - b).map(j => `
      <div class="day-pill">
        <div class="d">${DAYS[j - 1] || 'J' + j}</div>
        <div class="kcal">${Math.round(dayTotals[j].kcal)}</div>
        <div class="prot">${Math.round(dayTotals[j].prot)}g prot</div>
      </div>`).join('');

    const recipes = plan.recettes.map(r => {
      const ings = r.ingredients.map(i =>
        `<li>${esc(i.nom_canonique)} — <span style="font-family:var(--font-mono)">${Aggregator.fmtQty(i.quantite, i.unite)}</span></li>`).join('');
      const steps = r.etapes.map(e => `<li>${esc(e)}</li>`).join('');
      const slots = (plan.planning || [])
        .filter(p => p.recette_id === r.id)
        .map(p => `${DAYS[p.jour - 1]} ${REPAS_LABELS[p.repas] || p.repas}`)
        .join(' · ');
      return `
        <div class="card recipe">
          <h3>${esc(r.nom)}</h3>
          <div class="meta">${r.portions} portions · ${r.macros_par_portion.kcal} kcal · ${r.macros_par_portion.proteines_g}g prot / portion${slots ? ' · ' + esc(slots) : ''}</div>
          <details><summary>Ingrédients & étapes</summary><ul>${ings}</ul><ol>${steps}</ol></details>
        </div>`;
    }).join('');

    const weights = Store.getWeights();
    let weightCard = '';
    if (weights.length) {
      const last = weights[weights.length - 1];
      const trend = Health.weeklyTrend(weights);
      const trendTxt = trend === null ? '' : ` · ${trend >= 0 ? '+' : ''}${trend.toFixed(1)} kg/sem`;
      weightCard = `<div class="card" style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-family:var(--font-display);font-weight:700;font-size:0.9rem">⚖️ ${last.kg.toFixed(1)} kg</span>
        <span class="hint" style="margin:0">${esc(last.date)}${trendTxt}</span>
      </div>`;
    }

    const horsCat = plan.hors_catalogue || [];
    const horsCatCard = horsCat.length
      ? `<div class="card delivery warn"><b>⚠️ ${horsCat.length} ingrédient(s) peut-être introuvable(s)</b>
          <p class="hint" style="margin:6px 0 0">${horsCat.map(esc).join(', ')}. Si tu ne les trouves pas sur Leclerc, marque-les « introuvable » depuis le Panier : ils seront bannis des prochaines semaines.</p></div>`
      : '';

    view.innerHTML = `
      <div class="section-title">Semaine du ${esc(plan.semaine.date_debut)}</div>
      ${weightCard}
      ${horsCatCard}
      <div class="day-macros">${pills}</div>
      ${recipes}
      <div class="btn-row">
        <button class="btn ghost" id="btn-regenerate">Régénérer</button>
        <button class="btn primary" id="btn-to-basket">Voir le panier →</button>
      </div>`;
    document.getElementById('btn-regenerate').addEventListener('click', generatePlan);
    document.getElementById('btn-to-basket').addEventListener('click', () => switchTab('panier'));
  }

  async function generatePlan() {
    const settings = Store.getSettings();
    if (!settings.apiKey) {
      toast('Ajoute ta clé API dans les réglages ⚙', true);
      document.getElementById('dlg-settings').showModal();
      return;
    }
    generating = true;
    renderSemaine();
    const statusEl = () => document.getElementById('gen-status');
    try {
      const profile = Store.getProfile();

      // 1. weight sync (never blocks generation)
      let weights = Store.getWeights();
      if (Store.getSettings().workerUrl) {
        const el = statusEl(); if (el) el.textContent = 'Synchronisation du poids…';
        try {
          weights = (await Health.syncWeights()).weights;
        } catch (err) {
          console.error('Weight sync failed:', err);
          toast('Sync poids impossible (' + err.message + ') — kcal non ajustées', true);
        }
      }

      // 2. kcal auto-adjust from the trend
      const adj = Health.adjustKcal(profile, weights);
      const profileAdjusted = { ...profile, kcal_cible_jour: adj.kcal };
      if (adj.delta !== 0) toast(`Kcal ajustées : ${profile.kcal_cible_jour} → ${adj.kcal} (${adj.reason})`);

      // 3. couverts per meal slot from the presence grid
      const coefById = Object.fromEntries(profile.convives.map(c => [c.id, c.coefficient]));
      const couverts = {};
      for (let jour = 1; jour <= 7; jour++) {
        couverts[jour] = {};
        for (const repas of Store.REPAS_TYPES) {
          const ids = profile.presence?.[jour]?.[repas] || [];
          const sum = ids.reduce((acc, id) => acc + (coefById[id] || 0), 0);
          if (sum > 0) couverts[jour][repas] = Math.round(sum * 10) / 10;
        }
      }

      const plan = await Generator.generate({
        profile: profileAdjusted,
        inventory: Store.getInventory(),
        dateDebut: nextMonday(),
        couverts,
        noteAjustement: adj.reason,
        onStatus: (msg) => { const el = statusEl(); if (el) el.textContent = msg; }
      });
      Store.setPlan(plan);
      toast('Plan généré ✓');
    } catch (err) {
      console.error('Generation failed:', err);
      toast(err.message === 'NO_API_KEY' ? 'Clé API manquante' : `Échec génération : ${err.message}`, true);
    } finally {
      generating = false;
      if (currentTab === 'semaine') renderSemaine();
    }
  }

  /* ---------- tab: Panier (le Ticket) ---------- */
  function renderPanier() {
    const plan = Store.getPlan();
    if (!plan) {
      view.innerHTML = `<div class="empty"><h2>Panier vide</h2><p>Génère d'abord une semaine de repas.</p></div>`;
      return;
    }
    const matches = Store.getMatches();
    const items = Aggregator.buildBasket(plan, Store.getInventory(), matches);
    const groups = Aggregator.groupByRayon(items.filter(it => it.aAcheter > 0 || it.enStock > 0));
    const toBuy = items.filter(it => it.aAcheter > 0);
    const matchedCount = toBuy.filter(it => it.match).length;
    const { total, complete } = Aggregator.totalEstime(items);
    const slots = Store.getSlots();
    const delivery = Aggregator.recommendDelivery(plan, items, slots);
    let deliveryCard = '';
    if (delivery) {
      const risksTxt = delivery.risks.map(r =>
        `${esc(r.nom_canonique)} (cuisiné ${r.lastUseLabel}, frais ${r.shelf} j)`).join(', ');
      const rows = delivery.livraisons.map(d => `
        <div class="deliv-row">
          <span class="deliv-rang">${d.rang}</span>
          <span class="deliv-label">${esc(d.label)}</span>
          <span class="deliv-date">${esc(d.date)}</span>
        </div>`).join('');
      const noSlots = !slots.preferes.length
        ? `<p class="hint" style="margin:6px 0 0">Enregistre tes créneaux Leclerc habituels pour des dates exactes.</p>`
        : '';
      deliveryCard = `<div class="card delivery ${delivery.frequence === 1 ? 'ok' : 'warn'}">
        <b>🚚 ${delivery.frequence} livraison${delivery.frequence > 1 ? 's' : ''} cette semaine</b>
        ${rows}
        ${delivery.frequence === 2
          ? `<p class="hint" style="margin:6px 0 0">En cause : ${risksTxt}. Alternative : passe ces produits en surgelé et une seule livraison suffit.</p>`
          : `<p class="hint" style="margin:6px 0 0">Tous les produits frais sont cuisinés dans leur fenêtre de fraîcheur.</p>`}
        ${noSlots}
        <button class="btn ghost block" id="btn-slots" style="margin-top:10px">Mes créneaux habituels</button>
      </div>`;
    }

    const lines = groups.map(g => {
      const rows = g.items.map(it => {
        if (it.aAcheter <= 0) {
          return `<div class="ticket-line stock"><span class="name">${esc(it.nom_canonique)}</span><span class="dots"></span><span class="qty">en stock</span></div>`;
        }
        const cls = it.match ? 'matched' : 'unmatched';
        const qty = it.packs && it.match
          ? `${it.packs} × ${esc(it.match.libelle)}`
          : Aggregator.fmtQty(it.aAcheter, it.unite);
        const price = typeof it.prix_estime === 'number' ? ` <b>${it.prix_estime.toFixed(2)}€</b>` : '';
        return `<div class="ticket-line ${cls}" data-name="${esc(it.nom_canonique)}" tabindex="0" role="button">
          <span class="name">${esc(it.nom_canonique)}</span><span class="dots"></span><span class="qty">${qty}${price}</span>
        </div>`;
      }).join('');
      return `<div class="ticket-rayon">${esc(g.label)}</div>${rows}`;
    }).join('');

    view.innerHTML = `
      <div class="section-title">Liste de courses
        <span class="badge ${matchedCount === toBuy.length ? 'ok' : 'warn'}">${matchedCount}/${toBuy.length} produits associés</span>
      </div>
      ${deliveryCard}
      <div class="ticket">
        <div class="ticket-header">E.LECLERC · SEMAINE ${esc(plan.semaine.date_debut)}</div>
        ${lines || '<p>Rien à acheter — tout est en stock.</p>'}
        <div class="ticket-total"><span>TOTAL ESTIMÉ</span><span>${total.toFixed(2)}€${complete ? '' : ' *'}</span></div>
        ${complete ? '' : '<div class="ticket-foot">* partiel : associe les produits (lignes "?") pour un total complet</div>'}
      </div>
      <p class="hint">Touche une ligne "?" pour l'associer à un produit Leclerc. L'association est mémorisée pour toutes les semaines suivantes.</p>
      <div class="btn-row">
        <button class="btn ghost" id="btn-copy-export">Copier pour l'extension</button>
        <button class="btn primary" id="btn-ordered">Commande passée ✓</button>
      </div>`;

    view.querySelectorAll('.ticket-line.unmatched, .ticket-line.matched').forEach(el => {
      const open = () => openMatchDialog(el.dataset.name);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    document.getElementById('btn-slots')?.addEventListener('click', openSlotsDialog);

    document.getElementById('btn-copy-export').addEventListener('click', async () => {
      const payload = Aggregator.buildExport(items, plan, delivery);
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        toast('Liste copiée — colle-la dans l\'extension');
      } catch (err) {
        console.error('Clipboard failed:', err);
        toast('Copie impossible : ' + err.message, true);
      }
    });

    document.getElementById('btn-ordered').addEventListener('click', () => {
      if (!confirm('Marquer la commande comme passée ? Les quantités achetées seront ajoutées à ton inventaire avec des DLC estimées.')) return;
      try {
        const newInv = Aggregator.applyPurchaseToInventory(items, Store.getInventory());
        Store.setInventory(newInv);
        toast('Inventaire mis à jour ✓');
        switchTab('inventaire');
      } catch (err) {
        console.error(err);
        toast('Échec mise à jour inventaire : ' + err.message, true);
      }
    });
  }

  function openSlotsDialog() {
    const dlg = document.getElementById('dlg-match');
    const body = document.getElementById('dlg-match-body');
    const slots = Store.getSlots();
    const DAYS_FULL = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

    const rows = slots.preferes.map((s, i) => `
      <div class="slot-line" data-idx="${i}">
        <span>${DAYS_FULL[s.jour - 1]} · ${esc(s.heure)}</span>
        <button class="del slot-del" title="Retirer" aria-label="Retirer ce créneau">✕</button>
      </div>`).join('');

    body.innerHTML = `
      <h2>Mes créneaux Leclerc</h2>
      <p class="hint">Les créneaux que tu prends d'habitude. L'app cale ses recommandations dessus et l'extension pré-remplit le jour.</p>
      <div id="slot-list">${rows || '<p class="hint">Aucun créneau enregistré.</p>'}</div>
      <div class="grid-2">
        <label>Jour
          <select id="slot-jour">${DAYS_FULL.map((d, i) => `<option value="${i + 1}">${d}</option>`).join('')}</select>
        </label>
        <label>Heure <input id="slot-heure" type="time" value="18:00" /></label>
      </div>
      <button class="btn ghost block" id="slot-add">+ Ajouter ce créneau</button>
      <div class="dialog-actions">
        <button class="btn primary" id="slot-close">Terminé</button>
      </div>`;

    body.querySelector('#slot-add').addEventListener('click', () => {
      const jour = parseInt(body.querySelector('#slot-jour').value, 10);
      const heure = body.querySelector('#slot-heure').value;
      if (!heure) { toast('Choisis une heure', true); return; }
      if (slots.preferes.some(s => s.jour === jour && s.heure === heure)) {
        toast('Ce créneau est déjà enregistré', true);
        return;
      }
      slots.preferes.push({ jour, heure });
      slots.preferes.sort((a, b) => a.jour - b.jour || a.heure.localeCompare(b.heure));
      Store.setSlots(slots);
      dlg.close();
      renderPanier();
      openSlotsDialog();
    });

    body.querySelectorAll('.slot-del').forEach(btn => btn.addEventListener('click', () => {
      slots.preferes.splice(parseInt(btn.closest('.slot-line').dataset.idx, 10), 1);
      Store.setSlots(slots);
      dlg.close();
      renderPanier();
      openSlotsDialog();
    }));

    body.querySelector('#slot-close').addEventListener('click', () => {
      dlg.close();
      renderPanier();
    });
    dlg.showModal();
  }

  function openMatchDialog(name) {
    const dlg = document.getElementById('dlg-match');
    const body = document.getElementById('dlg-match-body');
    const matches = Store.getMatches();
    const current = matches[name];
    body.innerHTML = `
      <h2>Associer « ${esc(name)} »</h2>
      ${current ? `<p class="hint">Actuellement : ${esc(current.libelle)} (${current.pack_quantite} ${esc(current.pack_unite)}${typeof current.prix_eur === 'number' ? ', ' + current.prix_eur.toFixed(2) + '€' : ''})</p>` : ''}
      <a class="match-option" href="${LECLERC_SEARCH(name)}" target="_blank" rel="noopener">🔎 Chercher « ${esc(name)} » sur Leclerc Drive</a>
      <p class="hint">Trouve le produit sur le site, puis renseigne-le ici :</p>
      <label>Libellé produit <input id="m-libelle" value="${current ? esc(current.libelle) : ''}" placeholder="Filet de poulet x2 Marque Repère" /></label>
      <div class="grid-2">
        <label>Contenu du pack <input id="m-packq" type="number" step="any" value="${current ? current.pack_quantite : ''}" placeholder="600" /></label>
        <label>Unité
          <select id="m-packu">
            <option value="g">g</option><option value="ml">ml</option><option value="piece">pièce</option>
          </select>
        </label>
      </div>
      <div class="grid-2">
        <label>Prix (€) <input id="m-prix" type="number" step="0.01" value="${current && typeof current.prix_eur === 'number' ? current.prix_eur : ''}" placeholder="4.90" /></label>
        <label>Réf/EAN (optionnel) <input id="m-ref" value="${current ? esc(current.ref || '') : ''}" placeholder="3564700..." /></label>
      </div>
      <div class="dialog-actions">
        ${current ? '<button class="btn danger" id="m-remove">Dissocier</button>' : ''}
        <button class="btn ghost" id="m-cancel">Annuler</button>
        <button class="btn primary" id="m-save">Enregistrer</button>
      </div>
      <button class="btn ghost block" id="m-unavailable" style="margin-top:6px">Introuvable en magasin</button>
      <p class="hint" style="margin-top:6px">L'ingrédient sera banni des prochaines générations.</p>`;
    if (current) body.querySelector('#m-packu').value = current.pack_unite;

    body.querySelector('#m-cancel').addEventListener('click', () => dlg.close());
    body.querySelector('#m-unavailable').addEventListener('click', () => {
      const banned = Store.getUnavailable();
      if (!banned.includes(name)) banned.push(name);
      Store.setUnavailable(banned);
      delete matches[name];
      Store.setMatches(matches);
      dlg.close();
      renderPanier();
      toast(`« ${name} » banni des prochaines semaines`);
    });
    body.querySelector('#m-remove')?.addEventListener('click', () => {
      delete matches[name];
      Store.setMatches(matches);
      dlg.close();
      renderPanier();
    });
    body.querySelector('#m-save').addEventListener('click', () => {
      const libelle = body.querySelector('#m-libelle').value.trim();
      const packq = parseFloat(body.querySelector('#m-packq').value);
      if (!libelle || !(packq > 0)) {
        toast('Libellé et contenu du pack requis', true);
        return;
      }
      const prix = parseFloat(body.querySelector('#m-prix').value);
      matches[name] = {
        libelle,
        pack_quantite: packq,
        pack_unite: body.querySelector('#m-packu').value,
        prix_eur: Number.isFinite(prix) ? prix : undefined,
        ref: body.querySelector('#m-ref').value.trim() || undefined
      };
      Store.setMatches(matches);
      dlg.close();
      renderPanier();
      toast('Produit associé ✓');
    });
    dlg.showModal();
  }

  /* ---------- tab: Inventaire ---------- */
  function renderInventaire() {
    const inv = Store.getInventory();
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    const rows = inv
      .slice()
      .sort((a, b) => (a.dlc || '9999').localeCompare(b.dlc || '9999'))
      .map((i, idx) => {
        const dlcCls = i.dlc && i.dlc <= soon ? 'soon' : '';
        const expired = i.dlc && i.dlc < today;
        return `<div class="inv-line">
          <span class="name">${esc(i.nom_canonique)}${expired ? ' <span class="badge warn">périmé</span>' : ''}</span>
          <span class="qty">${Aggregator.fmtQty(i.quantite, i.unite)}</span>
          <span class="dlc ${dlcCls}">${i.dlc ? 'DLC ' + i.dlc.slice(5) : ''}</span>
          <button class="del" data-idx="${idx}" title="Retirer" aria-label="Retirer ${esc(i.nom_canonique)}">✕</button>
        </div>`;
      }).join('');

    view.innerHTML = `
      <div class="section-title">Inventaire maison</div>
      <div class="card">${rows || '<p class="hint">Vide. Ajoute ce qu\'il te reste, ou marque une commande comme passée depuis le panier.</p>'}</div>
      <div class="section-title">Ajouter</div>
      <div class="card">
        <label>Ingrédient (nom canonique) <input id="inv-name" placeholder="riz basmati" /></label>
        <div class="grid-2">
          <label>Quantité <input id="inv-qty" type="number" step="any" placeholder="400" /></label>
          <label>Unité <select id="inv-unit"><option value="g">g</option><option value="ml">ml</option><option value="piece">pièce</option></select></label>
        </div>
        <label>DLC (optionnel) <input id="inv-dlc" type="date" /></label>
        <button class="btn primary block" id="inv-add">Ajouter à l'inventaire</button>
      </div>`;

    view.querySelectorAll('.del').forEach(btn => btn.addEventListener('click', () => {
      const next = Store.getInventory();
      next.splice(parseInt(btn.dataset.idx, 10), 1);
      Store.setInventory(next);
      renderInventaire();
    }));

    document.getElementById('inv-add').addEventListener('click', () => {
      const name = document.getElementById('inv-name').value.trim().toLowerCase();
      const qty = parseFloat(document.getElementById('inv-qty').value);
      if (!name || !(qty > 0)) {
        toast('Nom et quantité requis', true);
        return;
      }
      const next = Store.getInventory();
      next.push({
        nom_canonique: name,
        quantite: qty,
        unite: document.getElementById('inv-unit').value,
        dlc: document.getElementById('inv-dlc').value || undefined
      });
      Store.setInventory(next);
      renderInventaire();
      toast('Ajouté ✓');
    });
  }

  /* ---------- tab: Profil ---------- */
  function renderProfil() {
    const p = Store.getProfile();
    const banned = Store.getUnavailable();
    view.innerHTML = `
      <div class="section-title">Objectif</div>
      <div class="card">
        <label>Objectif
          <select id="p-objectif">
            <option value="prise_de_muscle">Prise de muscle</option>
            <option value="maintien">Maintien</option>
            <option value="perte_de_poids">Perte de poids</option>
            <option value="equilibre">Équilibre</option>
          </select>
        </label>
        <div class="grid-2">
          <label>Kcal / jour <input id="p-kcal" type="number" value="${p.kcal_cible_jour}" /></label>
          <label>Protéines / jour (g) <input id="p-prot" type="number" value="${p.proteines_cible_jour_g}" /></label>
        </div>
        <div class="grid-2">
          <label>Repas / jour <input id="p-repas" type="number" min="1" max="6" value="${p.repas_par_jour}" /></label>
          <label>Budget hebdo (€) <input id="p-budget" type="number" value="${p.budget_hebdo_eur}" /></label>
        </div>
      </div>
      <div class="section-title">Style de cuisine</div>
      <div class="card">
        <label>Complexité des recettes
          <select id="p-complexite">
            ${Object.entries(Catalogue.COMPLEXITES).map(([k, v]) =>
              `<option value="${k}">${esc(v.label)}</option>`).join('')}
          </select>
        </label>
        <p class="hint" id="p-complexite-desc"></p>
        <label style="margin-bottom:6px">Types de cuisine</label>
        <div class="chips" id="p-cuisines">
          ${Catalogue.CUISINES.map(c => `
            <button type="button" class="chip ${(p.cuisines || []).includes(c) ? 'on' : ''}"
              data-cuisine="${esc(c)}" aria-pressed="${(p.cuisines || []).includes(c)}">${esc(c)}</button>`).join('')}
        </div>
        <p class="hint">Aucun sélectionné = l'app varie librement.</p>
      </div>
      <div class="section-title">Convives</div>
      <div class="card" id="p-convives">
        ${p.convives.map((c, i) => `
          <div class="conv-line" data-idx="${i}">
            <input class="conv-nom" value="${esc(c.nom)}" placeholder="Prénom" aria-label="Nom du convive" />
            <input class="conv-coef" type="number" step="0.1" min="0.1" max="2" value="${c.coefficient}" aria-label="Coefficient de portion" />
            ${i === 0 ? '<span class="hint" style="margin:0">toi</span>' : '<button class="del conv-del" title="Retirer">✕</button>'}
          </div>`).join('')}
        <p class="hint">Coefficient de portion : 1 = adulte, ~0.5-0.7 pour un enfant selon l'âge.</p>
        <button class="btn ghost block" id="p-add-conv">+ Ajouter un convive</button>
      </div>
      <div class="section-title">Qui mange à la maison ?</div>
      <div class="card">
        <p class="hint">Touche une case pour basculer la présence. Un créneau sans personne = pas de repas prévu (cantine, resto…).</p>
        ${p.convives.map(c => `
          <div class="pres-block" data-cid="${esc(c.id)}">
            <div class="pres-name">${esc(c.nom)}</div>
            <div class="pres-grid">
              <span></span>${['L','M','M','J','V','S','D'].map(d => `<span class="pres-h">${d}</span>`).join('')}
              ${Store.REPAS_TYPES.map(rt => `
                <span class="pres-h">${({petit_dejeuner:'Déj',dejeuner:'Midi',collation:'Coll',diner:'Soir'})[rt]}</span>
                ${[1,2,3,4,5,6,7].map(j => {
                  const on = (p.presence?.[j]?.[rt] || []).includes(c.id);
                  return `<button class="pres-cell ${on ? 'on' : ''}" data-j="${j}" data-r="${rt}" aria-pressed="${on}" aria-label="${c.nom} jour ${j} ${rt}"></button>`;
                }).join('')}`).join('')}
            </div>
          </div>`).join('')}
      </div>
      <div class="section-title">Préférences</div>
      <div class="card">
        <label>Exclusions (séparées par des virgules)
          <input id="p-excl" value="${esc((p.exclusions || []).join(', '))}" placeholder="fruits de mer, champignon" />
        </label>
        <label>Préférences libres
          <textarea id="p-prefs" rows="3" placeholder="pas de poisson le lundi, j'aime les plats épicés…">${esc(p.preferences_libres || '')}</textarea>
        </label>
        ${banned.length ? `
          <label style="margin-bottom:6px">Ingrédients bannis (introuvables en magasin)</label>
          <div class="chips" id="p-banned">
            ${banned.map(b => `<button type="button" class="chip banned" data-banned="${esc(b)}" title="Retirer du bannissement">${esc(b)} ✕</button>`).join('')}
          </div>
          <p class="hint">Touche pour réautoriser.</p>` : ''}
        <button class="btn primary block" id="p-save">Enregistrer le profil</button>
      </div>`;
    document.getElementById('p-objectif').value = p.objectif;
    const complexiteSel = document.getElementById('p-complexite');
    complexiteSel.value = p.complexite || 'simple';
    const showComplexiteDesc = () => {
      document.getElementById('p-complexite-desc').textContent =
        Catalogue.COMPLEXITES[complexiteSel.value]?.desc || '';
    };
    showComplexiteDesc();
    complexiteSel.addEventListener('change', showComplexiteDesc);

    view.querySelectorAll('.chip[data-cuisine]').forEach(chip => chip.addEventListener('click', () => {
      const on = chip.classList.toggle('on');
      chip.setAttribute('aria-pressed', String(on));
    }));

    view.querySelectorAll('.chip[data-banned]').forEach(chip => chip.addEventListener('click', () => {
      const next = Store.getUnavailable().filter(b => b !== chip.dataset.banned);
      Store.setUnavailable(next);
      Store.setProfile(readProfileForm(p));
      renderProfil();
      toast('Réautorisé ✓');
    }));

    // presence toggles: mutate a working copy saved with the profile
    view.querySelectorAll('.pres-cell').forEach(cell => cell.addEventListener('click', () => {
      const cid = cell.closest('.pres-block').dataset.cid;
      const j = cell.dataset.j, r = cell.dataset.r;
      if (!p.presence[j]) p.presence[j] = {};
      if (!p.presence[j][r]) p.presence[j][r] = [];
      const list = p.presence[j][r];
      const pos = list.indexOf(cid);
      if (pos >= 0) list.splice(pos, 1); else list.push(cid);
      cell.classList.toggle('on', pos < 0);
      cell.setAttribute('aria-pressed', String(pos < 0));
    }));

    document.getElementById('p-add-conv').addEventListener('click', () => {
      const id = 'c' + Date.now().toString(36);
      p.convives.push({ id, nom: '', coefficient: 0.6 });
      for (let j = 1; j <= 7; j++) for (const rt of Store.REPAS_TYPES) {
        p.presence[j] = p.presence[j] || {};
        p.presence[j][rt] = p.presence[j][rt] || [];
      }
      Store.setProfile(readProfileForm(p));
      renderProfil();
    });

    view.querySelectorAll('.conv-del').forEach(btn => btn.addEventListener('click', () => {
      const idx = parseInt(btn.closest('.conv-line').dataset.idx, 10);
      const removed = p.convives.splice(idx, 1)[0];
      for (let j = 1; j <= 7; j++) for (const rt of Store.REPAS_TYPES) {
        const l = p.presence?.[j]?.[rt];
        if (l) { const k = l.indexOf(removed.id); if (k >= 0) l.splice(k, 1); }
      }
      Store.setProfile(readProfileForm(p));
      renderProfil();
    }));

    function readProfileForm(base) {
      const convLines = [...view.querySelectorAll('.conv-line')];
      const convives = base.convives.map((c, i) => {
        const line = convLines[i];
        return line ? {
          ...c,
          nom: line.querySelector('.conv-nom').value.trim() || c.nom || 'Convive',
          coefficient: parseFloat(line.querySelector('.conv-coef').value) || c.coefficient
        } : c;
      });
      return {
        objectif: document.getElementById('p-objectif').value,
        nb_personnes: convives.length,
        repas_par_jour: parseInt(document.getElementById('p-repas').value, 10) || 3,
        kcal_cible_jour: parseInt(document.getElementById('p-kcal').value, 10) || 2500,
        proteines_cible_jour_g: parseInt(document.getElementById('p-prot').value, 10) || 120,
        budget_hebdo_eur: parseFloat(document.getElementById('p-budget').value) || 0,
        exclusions: document.getElementById('p-excl').value.split(',').map(s => s.trim()).filter(Boolean),
        preferences_libres: document.getElementById('p-prefs').value.trim(),
        complexite: document.getElementById('p-complexite').value,
        cuisines: [...view.querySelectorAll('.chip[data-cuisine].on')].map(c => c.dataset.cuisine),
        convives,
        presence: base.presence
      };
    }
    document.getElementById('p-save').addEventListener('click', () => {
      try {
        Store.setProfile(readProfileForm(p));
        toast('Profil enregistré ✓');
      } catch (err) {
        toast('Échec enregistrement : ' + err.message, true);
      }
    });
  }

  /* ---------- settings dialog ---------- */
  const dlgSettings = document.getElementById('dlg-settings');
  document.getElementById('btn-settings').addEventListener('click', () => {
    const s = Store.getSettings();
    document.getElementById('set-api-key').value = s.apiKey;
    document.getElementById('set-model').value = s.model;
    document.getElementById('set-worker-url').value = s.workerUrl;
    document.getElementById('set-worker-secret').value = s.workerSecret;
    dlgSettings.showModal();
  });
  document.getElementById('form-settings').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'ok') {
      try {
        Store.setSettings({
          apiKey: document.getElementById('set-api-key').value.trim(),
          model: document.getElementById('set-model').value,
          workerUrl: document.getElementById('set-worker-url').value.trim(),
          workerSecret: document.getElementById('set-worker-secret').value.trim()
        });
        toast('Réglages enregistrés ✓');
      } catch (err) {
        toast('Échec : ' + err.message, true);
      }
    }
  });

  /* ---------- routing ---------- */
  const RENDERERS = { semaine: renderSemaine, panier: renderPanier, inventaire: renderInventaire, profil: renderProfil };
  function switchTab(name) {
    currentTab = name;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    RENDERERS[name]();
    window.scrollTo(0, 0);
  }
  tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  switchTab(Store.getPlan() ? 'semaine' : 'profil');
})();
