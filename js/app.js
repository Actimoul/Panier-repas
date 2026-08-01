/* Main UI logic. French UI text, English code. Errors always surface as toasts. */
(() => {
  const view = document.getElementById('view');
  const toastEl = document.getElementById('toast');
  const tabs = [...document.querySelectorAll('.tab')];
  let currentTab = 'semaine';
  let generating = false;

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
  const DAY_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const MEAL_LABELS = { petit_dejeuner: 'Petit-déj', dejeuner: 'Déjeuner', collation: 'Collation', diner: 'Dîner' };
  let semaineVue = 'tableau';   // 'tableau' | 'recettes'

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

    const byId = Object.fromEntries(plan.recettes.map(r => [r.id, r]));
    const planning = plan.planning || [];

    /* Which meal rows and which days actually have something planned. */
    const mealsUsed = Store.REPAS_TYPES.filter(rt => planning.some(p => p.repas === rt));
    const daysUsed = [...new Set(planning.map(p => p.jour))].sort((a, b) => a - b);

    /* Colour code: one hue per distinct recipe, so repetitions jump out. */
    const recipeOrder = [...new Set(planning.map(p => p.recette_id))];
    const hueOf = (id) => (recipeOrder.indexOf(id) * 47) % 360;

    const dayTotals = {};
    for (const p of planning) {
      const r = byId[p.recette_id];
      if (!r) continue;
      const t = dayTotals[p.jour] || (dayTotals[p.jour] = { kcal: 0, prot: 0 });
      t.kcal += r.macros_par_portion.kcal * (p.portions || 1);
      t.prot += r.macros_par_portion.proteines_g * (p.portions || 1);
    }

    const weightCard = (() => {
      const weights = Store.getWeights();
      if (!weights.length) return '';
      const last = weights[weights.length - 1];
      const trend = Health.weeklyTrend(weights);
      const trendTxt = trend === null ? '' : ` · ${trend >= 0 ? '+' : ''}${trend.toFixed(1)} kg/sem`;
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-family:var(--font-display);font-weight:700;font-size:0.9rem">⚖️ ${last.kg.toFixed(1)} kg</span>
        <span class="hint" style="margin:0">${esc(last.date)}${trendTxt}</span></div>`;
    })();

    const horsCat = plan.hors_catalogue || [];
    const horsCatCard = horsCat.length
      ? `<div class="card delivery warn"><b>⚠️ ${horsCat.length} ingrédient(s) peut-être introuvable(s)</b>
          <p class="hint" style="margin:6px 0 0">${horsCat.map(esc).join(', ')}. Si tu ne les trouves pas, marque-les « introuvable » depuis le Panier.</p></div>`
      : '';

    /* Variety summary — the whole point of the table view. */
    const nbDistinctes = new Set(planning.map(p => p.recette_id)).size;
    const varieteBadge = `<span class="badge ${nbDistinctes >= 8 ? 'ok' : nbDistinctes >= 5 ? '' : 'warn'}">${nbDistinctes} plats différents</span>`;

    /* --- the menu table --- */
    const table = `
      <div class="menu-wrap">
        <table class="menu">
          <thead>
            <tr><th class="corner"></th>
              ${daysUsed.map(j => `<th>${DAY_LABELS[j - 1] || 'J' + j}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${mealsUsed.map(rt => `
              <tr>
                <th class="row-h">${MEAL_LABELS[rt] || rt}</th>
                ${daysUsed.map(j => {
                  const slot = planning.find(p => p.jour === j && p.repas === rt);
                  if (!slot) return '<td class="empty-cell">—</td>';
                  const r = byId[slot.recette_id];
                  if (!r) return '<td class="empty-cell">?</td>';
                  const h = hueOf(slot.recette_id);
                  const parts = slot.portions || 1;
                  return `<td class="meal" data-rid="${esc(r.id)}" data-jour="${j}" data-repas="${esc(rt)}"
                            tabindex="0" role="button" style="--h:${h}" title="${esc(r.nom)}">
                    <span class="meal-name">${esc(r.nom)}</span>
                    <span class="meal-macro">${Math.round(r.macros_par_portion.kcal * parts)} kcal${parts !== 1 ? ` · ${parts} pers.` : ''}</span>
                  </td>`;
                }).join('')}
              </tr>`).join('')}
            <tr class="totals">
              <th class="row-h">Total</th>
              ${daysUsed.map(j => {
                const t = dayTotals[j] || { kcal: 0, prot: 0 };
                return `<td><b>${Math.round(t.kcal)}</b><span>${Math.round(t.prot)}g prot</span></td>`;
              }).join('')}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">Touche un plat pour voir sa recette. Chaque couleur = un plat différent.</p>`;

    /* --- recipe cards (secondary view) --- */
    const recipes = plan.recettes.map(r => {
      const ings = r.ingredients.map(i =>
        `<li>${esc(i.nom_canonique)} — <span style="font-family:var(--font-mono)">${Aggregator.fmtQty(i.quantite, i.unite)}</span></li>`).join('');
      const steps = r.etapes.map(e => `<li>${esc(e)}</li>`).join('');
      const slots = planning.filter(p => p.recette_id === r.id)
        .map(p => `${DAY_LABELS[p.jour - 1]} ${MEAL_LABELS[p.repas] || p.repas}`).join(' · ');
      return `
        <div class="card recipe" id="rec-${esc(r.id)}" style="border-left-color:hsl(${hueOf(r.id)} 45% 38%)">
          <h3>${esc(r.nom)}</h3>
          <div class="meta">${r.portions} portions · ${r.macros_par_portion.kcal} kcal · ${r.macros_par_portion.proteines_g}g prot / portion${slots ? ' · ' + esc(slots) : ''}</div>
          <details><summary>Ingrédients & étapes</summary><ul>${ings}</ul><ol>${steps}</ol></details>
        </div>`;
    }).join('');

    view.innerHTML = `
      <div class="section-title">Semaine du ${esc(plan.semaine.date_debut)} ${varieteBadge}</div>
      ${weightCard}
      ${horsCatCard}
      <div class="seg">
        <button class="seg-btn ${semaineVue === 'tableau' ? 'on' : ''}" data-vue="tableau">Tableau</button>
        <button class="seg-btn ${semaineVue === 'recettes' ? 'on' : ''}" data-vue="recettes">Recettes</button>
      </div>
      <div id="vue-tableau" ${semaineVue === 'tableau' ? '' : 'hidden'}>${table}</div>
      <div id="vue-recettes" ${semaineVue === 'recettes' ? '' : 'hidden'}>${recipes}</div>
      <div class="btn-row">
        <button class="btn ghost" id="btn-regenerate">Régénérer</button>
        <button class="btn primary" id="btn-to-basket">Voir le panier →</button>
      </div>`;

    view.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      semaineVue = b.dataset.vue;
      renderSemaine();
    }));

    /* Tapping a cell opens the recipe FOR THAT MEAL, scaled to its couverts. */
    view.querySelectorAll('.meal').forEach(cell => {
      const open = () => openRepasDialog(
        plan, cell.dataset.rid, parseInt(cell.dataset.jour, 10), cell.dataset.repas
      );
      cell.addEventListener('click', open);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    document.getElementById('btn-regenerate').addEventListener('click', generatePlan);
    document.getElementById('btn-to-basket').addEventListener('click', () => switchTab('panier'));
  }

  /* Recipe for ONE meal slot: quantities scaled from the batch down to the
     couverts of that day/meal. A batch view stays one tap away, because when
     several slots share a recipe you cook them together. */
  function openRepasDialog(plan, recetteId, jour, repas) {
    const r = plan.recettes.find(x => x.id === recetteId);
    if (!r) return;
    const planning = plan.planning || [];
    const slot = planning.find(p => p.jour === jour && p.repas === repas && p.recette_id === recetteId);
    const portions = slot?.portions || 1;
    const ratio = portions / r.portions;

    const autres = planning.filter(p => p.recette_id === recetteId && !(p.jour === jour && p.repas === repas));
    const totalPortions = planning
      .filter(p => p.recette_id === recetteId)
      .reduce((a, p) => a + (p.portions || 1), 0);

    const dlg = document.getElementById('dlg-match');
    const body = document.getElementById('dlg-match-body');

    function lignes(coef) {
      return r.ingredients.map(i => {
        const q = i.quantite * coef;
        // On ne casse pas 4,8 œufs : les unités comptables s'arrondissent
        // au demi le plus proche, et jamais à zéro.
        const affich = i.unite === 'piece'
          ? Math.max(0.5, Math.round(q * 2) / 2) + ' pc'
          : Aggregator.fmtQty(q, i.unite);
        return `<li><span>${esc(i.nom_canonique)}</span><b>${affich}</b>${
          i.fond_de_placard ? ' <span class="hint" style="margin:0">(placard)</span>' : ''}</li>`;
      }).join('');
    }

    const m = r.macros_par_portion;
    function draw(mode) {
      const coef = mode === 'repas' ? ratio : 1;
      const parts = mode === 'repas' ? portions : r.portions;
      body.innerHTML = `
        <div class="repas-head">
          <div class="repas-quand">${DAY_LABELS[jour - 1]} · ${MEAL_LABELS[repas] || repas}</div>
          <h2>${esc(r.nom)}</h2>
          <div class="repas-meta">
            ${mode === 'repas'
              ? `pour <b>${parts} couvert${parts > 1 ? 's' : ''}</b> · ${Math.round(m.kcal * parts)} kcal · ${Math.round(m.proteines_g * parts)} g prot`
              : `préparation complète : <b>${parts} portions</b> · ${Math.round(m.kcal * parts)} kcal au total`}
            ${r.temps_preparation_min || r.temps_cuisson_min
              ? ` · ${(r.temps_preparation_min || 0) + (r.temps_cuisson_min || 0)} min` : ''}
          </div>
        </div>

        ${autres.length ? `
          <div class="seg" style="margin-bottom:12px">
            <button class="seg-btn ${mode === 'repas' ? 'on' : ''}" data-mode="repas">Ce repas</button>
            <button class="seg-btn ${mode === 'batch' ? 'on' : ''}" data-mode="batch">Tout préparer</button>
          </div>` : ''}

        <div class="sub-title" style="margin-top:0">Ingrédients</div>
        <ul class="ing-list">${lignes(coef)}</ul>

        <div class="sub-title">Préparation</div>
        <ol class="etapes">${r.etapes.map(e => `<li>${esc(e)}</li>`).join('')}</ol>

        ${autres.length ? `<p class="hint">Ce plat revient aussi : ${
          autres.map(p => `${DAY_LABELS[p.jour - 1]} ${MEAL_LABELS[p.repas] || p.repas}`).join(', ')
        }.${mode === 'repas' ? ` En le préparant d'un coup (${Math.round(totalPortions * 10) / 10} couverts au total), tu ne cuisines qu'une fois.` : ''}</p>` : ''}

        <div class="dialog-actions">
          <button class="btn primary" id="rp-close">Fermer</button>
        </div>`;

      body.querySelectorAll('.seg-btn[data-mode]').forEach(b =>
        b.addEventListener('click', () => draw(b.dataset.mode)));
      body.querySelector('#rp-close').addEventListener('click', () => dlg.close());
    }

    draw('repas');
    dlg.showModal();
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

      // 2. targets: recompute from body metrics when auto mode is on,
      //    using the latest synced weight if available
      let profileForGen = profile;
      if (profile.cibles_auto) {
        const latest = weights.length ? weights[weights.length - 1].kg : null;
        const metrics = { ...profile.metrics, poids_kg: latest || profile.metrics.poids_kg };
        const t = Health.computeTargets(metrics, profile.objectif);
        if (t) {
          profileForGen = { ...profile, kcal_cible_jour: t.kcal, proteines_cible_jour_g: t.proteines_g };
          if (latest && latest !== profile.metrics.poids_kg) {
            Store.setProfile({ ...profile, metrics, kcal_cible_jour: t.kcal, proteines_cible_jour_g: t.proteines_g });
          }
        }
      }

      // 3. kcal fine-tuning from the weight trend
      const adj = Health.adjustKcal(profileForGen, weights);
      const profileAdjusted = { ...profileForGen, kcal_cible_jour: adj.kcal };
      if (adj.delta !== 0) toast(`Kcal ajustées : ${profileForGen.kcal_cible_jour} → ${adj.kcal} (${adj.reason})`);

      // 4. couverts per meal slot, weighted by each person's real needs
      const ref = profile.convives[0];
      const coefById = {};
      for (const c of profile.convives) {
        coefById[c.id] = c.coefficient
          ?? (c.id === ref.id ? 1 : (Health.coefficientDerive(c, ref, profile.objectif) ?? 1));
      }
      const couverts = {};
      for (let jour = 1; jour <= 7; jour++) {
        couverts[jour] = {};
        for (const repas of Store.REPAS_TYPES) {
          const ids = profile.presence?.[jour]?.[repas] || [];
          const sum = ids.reduce((acc, id) => acc + (coefById[id] || 0), 0);
          if (sum > 0) couverts[jour][repas] = Math.round(sum * 10) / 10;
        }
      }

      // 5. training days: extra carbs/protein on those days
      const joursSport = {};
      for (const c of profile.convives) {
        for (const j of c.sport?.jours || []) {
          joursSport[j] = joursSport[j] || [];
          joursSport[j].push(c.nom);
        }
      }

      // 6. restrictions, split by severity
      const interdits = [...new Set(profile.convives.flatMap(c => c.exclusions || []))];
      const detestes = [...new Set(profile.convives.flatMap(c => c.deteste || []))];

      const plan = await Generator.generate({
        profile: profileAdjusted,
        inventory: Store.getInventory(),
        dateDebut: nextMonday(),
        couverts,
        joursSport,
        interdits,
        detestes,
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
        <button class="btn ghost" id="btn-import">Importer les choix</button>
      </div>
      <button class="btn primary block" id="btn-ordered">Commande passée ✓</button>`;

    view.querySelectorAll('.ticket-line.unmatched, .ticket-line.matched').forEach(el => {
      const open = () => openMatchDialog(el.dataset.name);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    document.getElementById('btn-slots')?.addEventListener('click', openSlotsDialog);

    document.getElementById('btn-copy-export').addEventListener('click', async () => {
      const st = Store.getSettings();
      const payload = Aggregator.buildExport(items, plan, delivery, {
        prefSante: st.prefSante, budgetMaxArticle: st.budgetMaxArticle
      });
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        toast('Liste copiée — colle-la dans l\'extension');
      } catch (err) {
        console.error('Clipboard failed:', err);
        toast('Copie impossible : ' + err.message, true);
      }
    });

    document.getElementById('btn-import')?.addEventListener('click', () => openImportDialog());

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

  /* Import the products the extension actually picked, so the app's
     product dictionary learns from them. */
  function openImportDialog() {
    const dlg = document.getElementById('dlg-match');
    const body = document.getElementById('dlg-match-body');
    body.innerHTML = `
      <h2>Importer les choix</h2>
      <p class="hint">Colle ici ce que l'extension a copié après avoir rempli le panier. Les produits retenus seront mémorisés comme associations.</p>
      <textarea id="imp-text" rows="6" placeholder='{"source":"panier-repas-choix", ...}'></textarea>
      <div class="dialog-actions">
        <button class="btn ghost" id="imp-cancel">Annuler</button>
        <button class="btn primary" id="imp-ok">Importer</button>
      </div>`;
    body.querySelector('#imp-cancel').addEventListener('click', () => dlg.close());
    body.querySelector('#imp-ok').addEventListener('click', () => {
      let payload;
      try {
        payload = JSON.parse(body.querySelector('#imp-text').value);
      } catch {
        toast('JSON illisible', true);
        return;
      }
      if (payload.source !== 'panier-repas-choix' || !Array.isArray(payload.choix)) {
        toast('Format inattendu — copie depuis l\'extension', true);
        return;
      }
      const matches = Store.getMatches();
      let n = 0;
      for (const c of payload.choix) {
        if (!c.nom_canonique || !c.libelle) continue;
        const existing = matches[c.nom_canonique] || {};
        const size = Scoring.packSize({ libelle: c.libelle });
        matches[c.nom_canonique] = {
          ...existing,
          libelle: c.libelle,
          pack_quantite: size?.quantite || existing.pack_quantite || 1,
          pack_unite: size?.unite || existing.pack_unite || 'piece',
          prix_eur: typeof c.prix_eur === 'number' ? c.prix_eur : existing.prix_eur,
          ref: c.ean || existing.ref,
          score: c.score,
          justification: c.justification
        };
        n++;
      }
      Store.setMatches(matches);
      dlg.close();
      renderPanier();
      toast(`${n} produit(s) importé(s) ✓`);
    });
    dlg.showModal();
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
      ${current?.justification ? `<div class="calc-box"><div class="calc-main">Choisi automatiquement${current.score ? ` — ${current.score}/100` : ''}</div><div class="calc-detail">${esc(current.justification)}</div></div>` : ''}
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
  const DAYS_SHORT = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const REPAS_SHORT = { petit_dejeuner: 'Déj', dejeuner: 'Midi', collation: 'Coll', diner: 'Soir' };

  function renderProfil() {
    const p = Store.getProfile();
    const banned = Store.getUnavailable();

    /* Each convive is a full person: metrics, sport, restrictions. */
    function personCard(c, i) {
      const isMain = i === 0;
      const sport = c.sport || {};
      return `
      <div class="person" data-idx="${i}">
        <div class="person-head">
          <input class="c-nom" value="${esc(c.nom || '')}" placeholder="Prénom" aria-label="Prénom" />
          ${isMain ? '<span class="badge">toi</span>' : '<button class="del c-del" title="Retirer" aria-label="Retirer ce convive">✕</button>'}
        </div>

        <div class="grid-2">
          <label>Âge <input class="c-age" type="number" min="1" max="110" value="${c.age ?? ''}" placeholder="35" /></label>
          <label>Sexe
            <select class="c-sexe">
              <option value="homme"${c.sexe !== 'femme' ? ' selected' : ''}>Homme</option>
              <option value="femme"${c.sexe === 'femme' ? ' selected' : ''}>Femme</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>Poids (kg) <input class="c-poids" type="number" step="0.1" value="${c.poids_kg ?? ''}" placeholder="78" /></label>
          <label>Taille (cm) <input class="c-taille" type="number" value="${c.taille_cm ?? ''}" placeholder="178" /></label>
        </div>
        <label>Niveau d'activité (hors sport)
          <select class="c-activite">
            ${Object.entries(Health.ACTIVITES).map(([k, v]) =>
              `<option value="${k}"${(c.activite || 'modere') === k ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
          </select>
        </label>
        ${!isMain ? `
        <label>Objectif
          <select class="c-objectif">
            <option value=""${!c.objectif ? ' selected' : ''}>Comme le foyer</option>
            <option value="prise_de_muscle"${c.objectif === 'prise_de_muscle' ? ' selected' : ''}>Prise de muscle</option>
            <option value="maintien"${c.objectif === 'maintien' ? ' selected' : ''}>Maintien</option>
            <option value="perte_de_poids"${c.objectif === 'perte_de_poids' ? ' selected' : ''}>Perte de poids</option>
            <option value="equilibre"${c.objectif === 'equilibre' ? ' selected' : ''}>Équilibre</option>
          </select>
        </label>` : ''}

        <div class="sub-title">Sport</div>
        <div class="grid-2">
          <label>Séances / semaine <input class="c-seances" type="number" min="0" max="14" value="${sport.seances_par_semaine ?? 0}" /></label>
          <label>Intensité
            <select class="c-intensite">
              <option value="legere"${sport.intensite === 'legere' ? ' selected' : ''}>Légère</option>
              <option value="moderee"${(sport.intensite || 'moderee') === 'moderee' ? ' selected' : ''}>Modérée</option>
              <option value="intense"${sport.intensite === 'intense' ? ' selected' : ''}>Intense</option>
            </select>
          </label>
        </div>
        <label style="margin-bottom:4px">Jours d'entraînement</label>
        <div class="days-row c-jours">
          ${DAYS_SHORT.map((d, j) => {
            const on = (sport.jours || []).includes(j + 1);
            return `<button type="button" class="day-btn ${on ? 'on' : ''}" data-j="${j + 1}" aria-pressed="${on}" aria-label="Jour ${j + 1}">${d}</button>`;
          }).join('')}
        </div>
        <p class="hint">Les jours cochés reçoivent plus de glucides et de protéines.</p>

        <div class="sub-title">Ce qu'il ou elle ne mange pas</div>
        <label>Interdits (allergie, régime)
          <input class="c-excl" value="${esc((c.exclusions || []).join(', '))}" placeholder="arachide, crustacé" />
        </label>
        <label>N'aime pas
          <input class="c-deteste" value="${esc((c.deteste || []).join(', '))}" placeholder="courgette, olive" />
        </label>

        <div class="calc-box c-besoin"></div>
      </div>`;
    }

    view.innerHTML = `
      <div class="section-title">Objectif du foyer</div>
      <div class="card">
        <label>Objectif par défaut
          <select id="p-objectif">
            <option value="prise_de_muscle">Prise de muscle</option>
            <option value="maintien">Maintien</option>
            <option value="perte_de_poids">Perte de poids</option>
            <option value="equilibre">Équilibre</option>
          </select>
        </label>
        <label class="switch">
          <input type="checkbox" id="p-auto" ${p.cibles_auto ? 'checked' : ''} />
          <span>Calculer les cibles automatiquement</span>
        </label>
        <div class="grid-2" id="p-manual">
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
        <label>Variété des menus
          <select id="p-variete">
            ${Object.entries(Catalogue.VARIETES).map(([k, v]) =>
              `<option value="${k}">${esc(v.label)}</option>`).join('')}
          </select>
        </label>
        <p class="hint" id="p-variete-desc"></p>
        <label style="margin-bottom:6px">Types de cuisine</label>
        <div class="chips" id="p-cuisines">
          ${Catalogue.CUISINES.map(c => `
            <button type="button" class="chip ${(p.cuisines || []).includes(c) ? 'on' : ''}"
              data-cuisine="${esc(c)}" aria-pressed="${(p.cuisines || []).includes(c)}">${esc(c)}</button>`).join('')}
        </div>
        <p class="hint">Aucun sélectionné = l'app varie librement.</p>
      </div>

      <div class="section-title">Le foyer</div>
      <div id="p-people">${p.convives.map(personCard).join('')}</div>
      <button class="btn ghost block" id="p-add-conv" style="margin-bottom:12px">+ Ajouter une personne</button>

      <div class="section-title">Qui mange à la maison ?</div>
      <div class="card">
        <p class="hint">Touche une case pour basculer la présence. Un créneau sans personne = pas de repas prévu (cantine, resto…).</p>
        ${p.convives.map(c => `
          <div class="pres-block" data-cid="${esc(c.id)}">
            <div class="pres-name">${esc(c.nom || 'Convive')}</div>
            <div class="pres-grid">
              <span></span>${DAYS_SHORT.map(d => `<span class="pres-h">${d}</span>`).join('')}
              ${Store.REPAS_TYPES.map(rt => `
                <span class="pres-h">${REPAS_SHORT[rt]}</span>
                ${[1, 2, 3, 4, 5, 6, 7].map(j => {
                  const on = (p.presence?.[j]?.[rt] || []).includes(c.id);
                  return `<button class="pres-cell ${on ? 'on' : ''}" data-j="${j}" data-r="${rt}" aria-pressed="${on}" aria-label="${esc(c.nom)} jour ${j} ${rt}"></button>`;
                }).join('')}`).join('')}
            </div>
          </div>`).join('')}
      </div>

      <div class="section-title">Préférences générales</div>
      <div class="card">
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

    const varieteSel = document.getElementById('p-variete');
    varieteSel.value = p.variete || 'equilibre';
    const showVarieteDesc = () => {
      document.getElementById('p-variete-desc').textContent =
        Catalogue.VARIETES[varieteSel.value]?.desc || '';
    };
    showVarieteDesc();
    varieteSel.addEventListener('change', showVarieteDesc);

    /* Read every person card back into objects. */
    function readPeople() {
      return [...view.querySelectorAll('.person')].map((el, i) => {
        const base = p.convives[i] || Store.personneVide(`c${Date.now()}${i}`, 'Convive');
        const val = (sel) => el.querySelector(sel)?.value ?? '';
        const list = (sel) => val(sel).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        return {
          ...base,
          nom: val('.c-nom').trim() || base.nom || 'Convive',
          age: parseInt(val('.c-age'), 10) || null,
          sexe: val('.c-sexe') || 'homme',
          poids_kg: parseFloat(val('.c-poids')) || null,
          taille_cm: parseFloat(val('.c-taille')) || null,
          activite: val('.c-activite') || 'modere',
          objectif: val('.c-objectif') || null,
          sport: {
            seances_par_semaine: parseInt(val('.c-seances'), 10) || 0,
            intensite: val('.c-intensite') || 'moderee',
            jours: [...el.querySelectorAll('.day-btn.on')].map(b => parseInt(b.dataset.j, 10))
          },
          exclusions: list('.c-excl'),
          deteste: list('.c-deteste')
        };
      });
    }

    /* Live per-person needs + household targets. */
    function refreshBesoins() {
      const people = readPeople();
      const objectifFoyer = document.getElementById('p-objectif').value;
      const auto = document.getElementById('p-auto').checked;
      document.getElementById('p-manual').style.display = auto ? 'none' : '';

      const ref = people[0];
      view.querySelectorAll('.person').forEach((el, i) => {
        const box = el.querySelector('.c-besoin');
        const b = Health.besoinsPersonne(people[i], objectifFoyer);
        if (!b) {
          box.innerHTML = `<div class="calc-detail">Renseigne l'âge${i === 0 || (people[i].age ?? 99) >= 18 ? ', le poids et la taille' : ''} pour estimer les besoins.</div>`;
          return;
        }
        const coef = i === 0 ? 1 : (Health.coefficientDerive(people[i], ref, objectifFoyer) ?? 1);
        const sportTxt = b.kcalSport ? ` · dont ${b.kcalSport} kcal de sport/jour` : '';
        box.innerHTML = `
          <div class="calc-main"><b>${b.kcal} kcal</b> · <b>${b.proteines_g} g</b> de protéines / jour</div>
          <div class="calc-detail">${b.estEnfant ? 'estimation enfant' : `métabolisme ${b.bmr} kcal · maintien ${b.maintenance} kcal`}${sportTxt}${i > 0 ? ` · portion ×${coef}` : ''}</div>`;
      });

      if (auto && ref) {
        const b = Health.besoinsPersonne(ref, objectifFoyer);
        if (b) {
          document.getElementById('p-kcal').value = b.kcal;
          document.getElementById('p-prot').value = b.proteines_g;
        }
      }
    }

    /* Any input in a person card, or the household objective, recomputes. */
    view.addEventListener('input', (e) => {
      if (e.target.closest('.person') || ['p-objectif', 'p-auto'].includes(e.target.id)) refreshBesoins();
    });
    view.addEventListener('change', (e) => {
      if (e.target.closest('.person') || ['p-objectif', 'p-auto'].includes(e.target.id)) refreshBesoins();
    });

    view.querySelectorAll('.day-btn').forEach(btn => btn.addEventListener('click', () => {
      const on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', String(on));
      refreshBesoins();
    }));

    view.querySelectorAll('.chip[data-cuisine]').forEach(chip => chip.addEventListener('click', () => {
      const on = chip.classList.toggle('on');
      chip.setAttribute('aria-pressed', String(on));
    }));

    view.querySelectorAll('.chip[data-banned]').forEach(chip => chip.addEventListener('click', () => {
      Store.setUnavailable(Store.getUnavailable().filter(b => b !== chip.dataset.banned));
      Store.setProfile(readProfileForm(p));
      renderProfil();
      toast('Réautorisé ✓');
    }));

    view.querySelectorAll('.pres-cell').forEach(cell => cell.addEventListener('click', () => {
      const cid = cell.closest('.pres-block').dataset.cid;
      const j = cell.dataset.j, r = cell.dataset.r;
      p.presence[j] = p.presence[j] || {};
      p.presence[j][r] = p.presence[j][r] || [];
      const list = p.presence[j][r];
      const pos = list.indexOf(cid);
      if (pos >= 0) list.splice(pos, 1); else list.push(cid);
      cell.classList.toggle('on', pos < 0);
      cell.setAttribute('aria-pressed', String(pos < 0));
    }));

    document.getElementById('p-add-conv').addEventListener('click', () => {
      const saved = readProfileForm(p);
      const id = 'c' + Date.now().toString(36);
      saved.convives = [...saved.convives, Store.personneVide(id, '')];
      for (let j = 1; j <= 7; j++) {
        saved.presence[j] = saved.presence[j] || {};
        for (const rt of Store.REPAS_TYPES) {
          saved.presence[j][rt] = saved.presence[j][rt] || [];
          if (!saved.presence[j][rt].includes(id)) saved.presence[j][rt].push(id);
        }
      }
      Store.setProfile(saved);
      renderProfil();
    });

    view.querySelectorAll('.c-del').forEach(btn => btn.addEventListener('click', () => {
      const idx = parseInt(btn.closest('.person').dataset.idx, 10);
      const saved = readProfileForm(p);
      const removed = saved.convives.splice(idx, 1)[0];
      for (let j = 1; j <= 7; j++) for (const rt of Store.REPAS_TYPES) {
        const l = saved.presence?.[j]?.[rt];
        if (l) { const k = l.indexOf(removed.id); if (k >= 0) l.splice(k, 1); }
      }
      Store.setProfile(saved);
      renderProfil();
    }));

    function readProfileForm(base) {
      const convives = readPeople();
      const main = convives[0] || {};
      return {
        objectif: document.getElementById('p-objectif').value,
        nb_personnes: convives.length,
        repas_par_jour: parseInt(document.getElementById('p-repas').value, 10) || 3,
        kcal_cible_jour: parseInt(document.getElementById('p-kcal').value, 10) || 2500,
        proteines_cible_jour_g: parseInt(document.getElementById('p-prot').value, 10) || 120,
        budget_hebdo_eur: parseFloat(document.getElementById('p-budget').value) || 0,
        exclusions: [...new Set(convives.flatMap(c => c.exclusions))],
        preferences_libres: document.getElementById('p-prefs').value.trim(),
        metrics: {
          poids_kg: main.poids_kg, taille_cm: main.taille_cm, age: main.age,
          sexe: main.sexe, activite: main.activite
        },
        cibles_auto: document.getElementById('p-auto').checked,
        complexite: document.getElementById('p-complexite').value,
        variete: document.getElementById('p-variete').value,
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

    refreshBesoins();
  }

  /* ---------- settings dialog ---------- */
  const dlgSettings = document.getElementById('dlg-settings');
  const PREF_LABELS = {
    '0': 'Le moins cher avant tout',
    '0.25': 'Plutôt le prix',
    '0.5': 'Équilibre prix / composition',
    '0.75': 'Plutôt la qualité nutritionnelle',
    '1': 'La meilleure composition avant tout'
  };
  function updatePrefLabel() {
    const v = document.getElementById('set-pref-sante').value;
    document.getElementById('set-pref-label').textContent = PREF_LABELS[v] || '';
  }
  document.getElementById('set-pref-sante').addEventListener('input', updatePrefLabel);
  document.getElementById('btn-settings').addEventListener('click', () => {
    const s = Store.getSettings();
    document.getElementById('set-api-key').value = s.apiKey;
    document.getElementById('set-model').value = s.model;
    document.getElementById('set-worker-url').value = s.workerUrl;
    document.getElementById('set-worker-secret').value = s.workerSecret;
    document.getElementById('set-pref-sante').value = s.prefSante ?? 0.5;
    document.getElementById('set-budget-article').value = s.budgetMaxArticle ?? '';
    updatePrefLabel();
    dlgSettings.showModal();
  });
  document.getElementById('form-settings').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'ok') {
      try {
        Store.setSettings({
          apiKey: document.getElementById('set-api-key').value.trim(),
          model: document.getElementById('set-model').value,
          workerUrl: document.getElementById('set-worker-url').value.trim(),
          workerSecret: document.getElementById('set-worker-secret').value.trim(),
          prefSante: parseFloat(document.getElementById('set-pref-sante').value),
          budgetMaxArticle: parseFloat(document.getElementById('set-budget-article').value) || null
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
