/* Plan generation through the Anthropic API (direct browser access).
   One automatic repair round-trip if the first output fails validation. */
const Generator = (() => {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELE_LEGER = 'claude-haiku-4-5-20251001';

  /* Token accounting, cumulated across every call of a generation, so the
     UI can tell the user what a week actually costs. */
  const usage = { input: 0, output: 0, cacheEcrit: 0, cacheLu: 0 };
  function resetUsage() { usage.input = usage.output = usage.cacheEcrit = usage.cacheLu = 0; }
  function lireUsage() { return { ...usage }; }

  /* Public rates, $/million tokens. Cache reads bill at 10% of input,
     cache writes at 125%. Kept here so the estimate stays auditable. */
  const TARIFS = {
    'claude-sonnet-5':            { in: 2,  out: 10 },
    'claude-sonnet-4-6':          { in: 3,  out: 15 },
    'claude-haiku-4-5-20251001':  { in: 1,  out: 5 },
    'claude-opus-5':              { in: 5,  out: 25 }
  };

  function estimerCout(u, modele) {
    const t = TARIFS[modele] || TARIFS['claude-sonnet-4-6'];
    const dollars =
      (u.input / 1e6) * t.in +
      (u.cacheEcrit / 1e6) * t.in * 1.25 +
      (u.cacheLu / 1e6) * t.in * 0.1 +
      (u.output / 1e6) * t.out;
    return dollars;
  }

  const SYSTEM_PROMPT = `Tu es un moteur de planification de repas. Tu génères un plan hebdomadaire au format JSON strict "PlanSemaine v1.0".

RÈGLES ABSOLUES :
1. Réponds UNIQUEMENT avec le JSON, sans texte avant/après, sans balises markdown.
2. Chaque nom_canonique est en minuscules, au singulier, sans marque. Réutilise EXACTEMENT le même nom canonique pour un même ingrédient d'une recette à l'autre.
3. Unités : uniquement "g", "ml", "piece". Convertis les mesures ménagères (1 c.à.s = 15 ml).
4. fond_de_placard: true pour sel, poivre, huiles, épices, vinaigres, miel.
5. VARIÉTÉ — règle centrale, à respecter avant toute autre considération d'économie :
   - variete.recettes_min à variete.recettes_max recettes DISTINCTES pour la semaine.
   - Une même recette n'apparaît JAMAIS plus de variete.max_repetitions fois dans le planning.
   - Jamais le même plat deux jours de suite sur le même créneau de repas.
   - Les petits-déjeuners et collations peuvent être plus répétitifs que les déjeuners et dîners, mais proposes-en au moins 2 variantes chacun.
   - L'économie se fait par le PARTAGE D'INGRÉDIENTS entre recettes différentes, pas par la répétition du même plat : réutilise un même ingrédient acheté (un poulet, un chou, un pot de crème) dans 2 ou 3 recettes distinctes de la semaine, en variant la technique et l'assaisonnement.
   N'ÉMETS PAS le champ "etapes" : les étapes de préparation sont demandées séparément, à la demande. Cela vaut pour toutes les recettes.
6. Le planning respecte les DLC : ingrédients peremption_type "tres_courte" cuisinés dans les 2-3 premiers jours.
7. Les macros cumulées de chaque jour approchent kcal_cible_jour (±5 %) et atteignent proteines_cible_jour_g.
8. Respecte exclusions sans exception.
9. Si un inventaire est fourni, utilise ces ingrédients en priorité dans les premières recettes.
10. BUDGET — tu disposes de prix réels, sers-t'en au lieu d'estimer :
   - prix_au_kilo donne le prix en € par kilo (ou par litre) de chaque ingrédient disponible ; pour un ingrédient compté à la pièce, multiplie par le poids typique d'une unité.
   - Additionne mentalement le coût de tes recettes et reste sous budget_hebdo_eur. Si tu dépasses, remplace les ingrédients les plus chers au kilo par des équivalents moins chers (cuisse plutôt que filet, œufs et légumineuses plutôt que viande, surgelé plutôt que frais hors saison).
   - Renseigne le champ "cout_estime_eur" du plan avec ton estimation du coût total de la semaine. Sois honnête : ce champ est vérifié.
11. couverts_par_repas indique le nombre de couverts (somme des coefficients des convives présents, décimal possible) pour chaque créneau jour/repas. Le planning couvre EXACTEMENT ces créneaux : aucun repas pour un créneau absent ou à 0, et planning.portions = le nombre de couverts du créneau (décimal autorisé, ex. 1.6). Les portions des recettes doivent suffire pour couvrir la somme des couverts planifiés.
12. Les cibles kcal/protéines s'appliquent à l'adulte principal (coefficient 1). Les recettes restent familiales : les couverts partiels mangent les mêmes plats en portion réduite.
13. DISPONIBILITÉ EN MAGASIN — règle stricte : chaque nom_canonique doit désigner un produit réellement trouvable dans un hypermarché français ordinaire. Utilise en priorité les termes exacts du bloc CATALOGUE fourni. Si une recette demande un ingrédient absent du catalogue, remplace-le par l'équivalent le plus proche qui y figure (ex. galanga → gingembre frais, mirin → vinaigre de cidre + sucre, burrata → mozzarella). N'invente jamais un produit d'épicerie spécialisée, de primeur exotique ou de marque précise.
14. complexite fixe l'ambition technique : "express" = ≤ 20 min, peu d'étapes, une seule poêle/casserole ; "simple" = ≤ 40 min, techniques de base, jusqu'à 8 étapes ; "elabore" = ≤ 90 min, plusieurs cuissons, marinades et sauces autorisées. Respecte le plafond de temps (temps_preparation_min + temps_cuisson_min) pour CHAQUE recette.
15. interdits_absolus : ces ingrédients ne doivent JAMAIS apparaître, sous aucune forme, même en trace ou en substitut proche (allergies et régimes). n_aime_pas : simples dégoûts — évite-les, mais un usage discret et bien intégré (fondu dans une sauce, mixé) reste toléré si nécessaire.
16. jours_entrainement donne, par jour de la semaine, qui s'entraîne. Ces jours-là, augmente les glucides (+15 à 20 % environ) et place les repas les plus riches en protéines autour de la séance. Les jours sans entraînement, réduis légèrement les glucides à calories équivalentes.
17. plats_deja_refuses liste des plats que l'utilisateur a explicitement rejetés. Ne les propose plus, ni sous le même nom, ni sous une variante à peine renommée du même plat.
18. CONDITIONNEMENTS — le magasin vend par pack, pas au gramme près :
   - conditionnements donne, pour chaque ingrédient connu, la contenance vendue (ex. lait de coco : 400 ml, crème fraîche : 200 ml, skyr : 450 g).
   - Dimensionne tes recettes pour consommer des packs ENTIERS. Une recette qui demande 100 ml de lait de coco quand le pack fait 400 ml gaspille les trois quarts.
   - Deux façons de faire, dans cet ordre de préférence : (a) ajuster la quantité d'une recette pour qu'elle utilise tout le pack ; (b) prévoir une SECONDE recette dans la semaine qui consomme le reste — c'est la solution élégante, elle apporte de la variété sans alourdir le panier.
   - Exemple attendu : un curry du lundi utilise 300 ml sur une brique de 400 ml de lait de coco ; place alors un dahl ou une soupe le mardi ou le mercredi pour finir les 100 ml restants. Fais-le systématiquement pour les briques, pots et bocaux entamés.
   - Attention aux périssables : un reste de crème fraîche doit être recuisiné dans les 3-4 jours, un reste de riz peut attendre.
   - N'invente pas de contenance pour un ingrédient absent de conditionnements : reste sur des quantités rondes.
19. cuisines liste les styles culinaires souhaités : répartis les recettes de la semaine entre ces styles, en restant fidèle à leurs bases (assaisonnements, techniques) mais uniquement avec des ingrédients du catalogue. Si la liste est vide, varie librement.

STRUCTURE ATTENDUE (types) :
{
  "version": "1.0",
  "semaine": { "date_debut": "YYYY-MM-DD", "nb_jours": 7 },
  "recettes": [{
    "id": "r-slug", "nom": str, "portions": int,
    "temps_preparation_min": int, "temps_cuisson_min": int,
    "macros_par_portion": { "kcal": int, "proteines_g": num, "glucides_g": num, "lipides_g": num },
    "conservation_jours": int,
    "ingredients": [{
      "nom_canonique": str, "quantite": num, "unite": "g|ml|piece",
      "rayon": "fruits_legumes|boucherie|poissonnerie|cremerie_oeufs|epicerie_salee|epicerie_sucree|surgeles|boulangerie|boissons|condiments_epices",
      "peremption_type": "tres_courte|courte|moyenne|longue",
      "fond_de_placard": bool (optionnel)
    }],
  }],
  "planning": [[jour(1-7), "pd"|"dej"|"col"|"din", "r-slug", portions(nombre)], ...]
}
Le planning est un tableau de tableaux compacts, pas d'objets — codes de repas : pd = petit-déjeuner, dej = déjeuner, col = collation, din = dîner.`;

  function stripFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  /* The model emits a compact planning ([jour, code, id, portions]) to save
     output tokens — the rest of the app works with objects. */
  const CODE_REPAS = { pd: 'petit_dejeuner', dej: 'dejeuner', col: 'collation', din: 'diner' };

  function normalise(plan) {
    if (!plan || !Array.isArray(plan.planning)) return plan;
    plan.planning = plan.planning.map(p => {
      if (Array.isArray(p)) {
        const [jour, code, recette_id, portions] = p;
        return { jour, repas: CODE_REPAS[code] || code, recette_id, portions: portions ?? 1 };
      }
      return p;
    });
    for (const r of plan.recettes || []) {
      if (!Array.isArray(r.etapes)) r.etapes = [];   // filled lazily, on demand
    }
    return plan;
  }

  /* Rough progress from a partial JSON stream: how many recipes have been
     emitted so far. Lets the UI say something truthful while waiting. */
  function compteRecettes(partial) {
    const m = partial.match(/"id"\s*:\s*"r-/g);
    return m ? m.length : 0;
  }

  const TIMEOUT_MS = 180000; // 3 min hard ceiling per call

  /* Streamed call: the UI can report progress while tokens arrive, which is
     what makes a 40 s generation feel workable instead of frozen. */
  async function callApi(settings, messages, systemPrompt, onProgress, modele) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: modele || settings.model,
          max_tokens: 16000,
          // Le prompt système (règles + catalogue) est identique d'un appel à
          // l'autre : le mettre en cache évite de le refacturer plein tarif à
          // chaque tour de correction.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          stream: true,
          messages
        })
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Délai dépassé (3 min). Réessaie.');
      throw new Error(`Réseau : ${err.message}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let stopReason = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta?.text) {
            text += ev.delta.text;
            onProgress?.(text);
          } else if (ev.type === 'message_start' && ev.message?.usage) {
            usage.input += ev.message.usage.input_tokens || 0;
            usage.cacheEcrit += ev.message.usage.cache_creation_input_tokens || 0;
            usage.cacheLu += ev.message.usage.cache_read_input_tokens || 0;
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens) usage.output += ev.usage.output_tokens;
          } else if (ev.type === 'error') {
            throw new Error(ev.error?.message || 'Erreur de flux');
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (!text) throw new Error('Réponse vide de l\'API');
    if (stopReason === 'max_tokens') {
      throw new Error('Réponse tronquée : réduis le nombre de repas/jour ou de convives.');
    }
    return text;
  }

  const CODE_INVERSE = { petit_dejeuner: 'pd', dejeuner: 'dej', collation: 'col', diner: 'din' };
  function compactPlanning(planning) {
    return (planning || []).map(p => [p.jour, CODE_INVERSE[p.repas] || p.repas, p.recette_id, p.portions]);
  }

  const SYSTEM_PATCH = `Tu corriges un plan de repas existant. Réponds UNIQUEMENT avec un JSON de la forme :
{ "nouvelles_recettes": [ ...recettes au format habituel, sans "etapes"... ],
  "planning": [[jour, "pd"|"dej"|"col"|"din", "r-slug", portions], ...] }
"planning" REMPLACE intégralement l'ancien : il doit couvrir exactement les mêmes créneaux qu'avant.
N'inclus dans "nouvelles_recettes" que les recettes à AJOUTER — les recettes existantes conservées sont référencées par leur id dans le planning, ne les réémets pas.`;

  /* Ask for a delta instead of a full re-emission: the model keeps the good
     recipes and returns only what changes. */
  async function demanderPatch(settings, system, demande, onProgress) {
    const text = await callApi(settings,
      [{ role: 'user', content: JSON.stringify(demande) }],
      `${SYSTEM_PATCH}\n\n${system}`, onProgress);
    return JSON.parse(stripFences(text));
  }

  function appliquerPatch(plan, patch) {
    const ajouts = Array.isArray(patch.nouvelles_recettes) ? patch.nouvelles_recettes : [];
    const parId = new Map(plan.recettes.map(r => [r.id, r]));
    for (const r of ajouts) parId.set(r.id, r);
    const fusion = { ...plan, recettes: [...parId.values()] };
    if (Array.isArray(patch.planning) && patch.planning.length) fusion.planning = patch.planning;
    const norme = normalise(fusion);
    // écarter les recettes devenues orphelines
    const utilisees = new Set(norme.planning.map(p => p.recette_id));
    norme.recettes = norme.recettes.filter(r => utilisees.has(r.id));
    return norme;
  }

  /* Generate the weekly plan. onStatus(msg) reports progress to the UI. */
  async function generate({ profile, inventory, dateDebut, couverts, joursSport, interdits, detestes, noteAjustement, onStatus }) {
    inventory = inventory || [];
    const settings = Store.getSettings();
    if (!settings.apiKey) throw new Error('NO_API_KEY');

    // Prix réels (produits déjà associés) d'abord, table de référence ensuite :
    // le modèle ne doit pas estimer un budget les yeux fermés.
    const matchesPrix = Store.getMatches();
    const releve = Store.getPrix();
    const prixConnus = {};
    // 1. prix relevés dans le magasin où l'on commande — la meilleure source
    for (const [nom, r] of Object.entries(releve?.prix || {})) {
      if (r.par_kg > 0) prixConnus[nom] = r.par_kg;
    }
    // 2. produits déjà associés
    for (const [nom, m] of Object.entries(matchesPrix)) {
      if (prixConnus[nom] === undefined && typeof m.prix_eur === 'number' && m.pack_quantite > 0) {
        const parKg = m.pack_unite === 'piece'
          ? m.prix_eur / m.pack_quantite
          : m.prix_eur / (m.pack_quantite / 1000);
        prixConnus[nom] = Math.round(parKg * 100) / 100;
      }
    }
    // 3. table de référence, en dernier recours
    for (const nom of Catalogue.flat()) {
      if (prixConnus[nom] === undefined) {
        const ref = Catalogue.prixReference(nom);
        if (ref !== null) prixConnus[nom] = ref;
      }
    }

    // Ce que le magasin vend réellement : contenance par ingrédient.
    const conditionnementsConnus = {};
    for (const nom of new Set([...Object.keys(matchesPrix), ...Object.keys(releve?.prix || {})])) {
      const c = Aggregator.conditionnement(nom, matchesPrix);
      if (c) conditionnementsConnus[nom] = `${c.quantite} ${c.unite}`;
    }

    const v = Catalogue.VARIETES[profile.variete] || Catalogue.VARIETES.equilibre;
    const varieteCfg = {
      niveau: profile.variete || 'equilibre',
      max_repetitions: v.maxRepetitions,
      recettes_min: v.recettesMin,
      recettes_max: v.recettesMax
    };

    const { convives, presence, ...profilLite } = profile;
    const userPayload = {
      profil: profilLite,
      date_debut: dateDebut,
      budget_hebdo_eur: profile.budget_hebdo_eur || undefined,
      conditionnements: conditionnementsConnus,
      prix_au_kilo: prixConnus,
      prix_source: releve ? `relevés chez ${releve.enseigne} le ${releve.date.slice(0, 10)}` : 'estimations de référence',
      variete: varieteCfg || undefined,
      couverts_par_repas: couverts || undefined,
      jours_entrainement: joursSport && Object.keys(joursSport).length ? joursSport : undefined,
      interdits_absolus: interdits?.length ? interdits : undefined,
      n_aime_pas: detestes?.length ? detestes : undefined,
      plats_deja_refuses: profile.plats_refuses?.length ? profile.plats_refuses : undefined,
      note_ajustement: noteAjustement || undefined,
      inventaire: inventory.map(i => ({
        nom_canonique: i.nom_canonique, quantite: i.quantite, unite: i.unite, dlc: i.dlc || undefined
      })),
      preferences_libres: profile.preferences_libres || ''
    };

    // Catalogue guardrails: baseline vocabulary + user-proven products + bans
    const matches = Store.getMatches();
    const unavailable = Store.getUnavailable();
    const system = `${SYSTEM_PROMPT}\n\n${Catalogue.promptBlock(matches, unavailable)}`;

    resetUsage();
    const messages = [{ role: 'user', content: JSON.stringify(userPayload) }];
    const suivi = (partial) => {
      const n = compteRecettes(partial);
      onStatus?.(n ? `${n} recette${n > 1 ? 's' : ''} composée${n > 1 ? 's' : ''}…` : 'Composition du menu…');
    };
    onStatus?.('Composition du menu…');
    let text = await callApi(settings, messages, system, suivi);

    let plan = null;
    // Round 1-2: schema validity. Round 3: catalogue realism.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (text !== null) {
        try {
          plan = normalise(JSON.parse(stripFences(text)));
        } catch (err) {
          plan = null;
        }
      }
      const check = plan ? PlanSchema.validate(plan) : { valid: false, errors: ['invalid JSON'] };

      if (!check.valid) {
        if (attempt >= 2) {
          throw new Error(`Plan invalide après correction : ${check.errors.slice(0, 5).join(' | ')}`);
        }
        onStatus?.('Correction du format…');
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: `Ta réponse est invalide : ${check.errors.slice(0, 10).join(' | ')}. Renvoie le JSON complet corrigé, uniquement le JSON.`
        });
        text = await callApi(settings, messages, system, suivi);
        continue;
      }

      // valid JSON — now check variety, then store availability
      const varAudit = PlanSchema.auditVariete(plan, varieteCfg.max_repetitions);
      if (!varAudit.ok && attempt < 2) {
        onStatus?.('Diversification des menus…');
        // Correction ciblée : on ne redemande QUE les recettes manquantes et le
        // planning, pas les 10 recettes déjà bonnes. Divise le coût du tour
        // par trois environ.
        const patch = await demanderPatch(settings, system, {
          type: 'variete',
          probleme: varAudit.problemes.slice(0, 6).join(' ; '),
          contexte: {
            recettes_existantes: plan.recettes.map(r => ({ id: r.id, nom: r.nom })),
            planning_actuel: compactPlanning(plan.planning),
            couverts_par_repas: couverts,
            cible: `${varieteCfg.recettes_min} à ${varieteCfg.recettes_max} recettes distinctes, ${varieteCfg.max_repetitions} répétitions maximum par plat principal`
          }
        }, suivi);
        plan = appliquerPatch(plan, patch);
        text = null;   // plan déjà en mémoire, rien à reparser
        continue;
      }

      // Contrôle du budget sur des prix réels, pas sur l'estimation du modèle.
      const budget = profile.budget_hebdo_eur;
      if (budget > 0 && attempt < 2) {
        const items = Aggregator.buildBasket(plan, inventory, matches);
        const cout = Aggregator.estimerCout(items);
        plan.cout_panier = cout;
        if (cout.total > budget * 1.15) {
          onStatus?.(`Panier à ${cout.total.toFixed(0)} € pour ${budget} € — allègement…`);
          const chers = [...cout.details].sort((a, b) => b.prix - a.prix).slice(0, 6);
          const patch = await demanderPatch(settings, system, {
            type: 'budget',
            probleme: `Le panier revient à ${cout.total.toFixed(2)} € pour un budget de ${budget} €.`,
            postes_les_plus_chers: chers.map(d => `${d.nom} : ${d.prix.toFixed(2)} €`),
            contexte: {
              recettes_existantes: plan.recettes.map(r => ({ id: r.id, nom: r.nom })),
              planning_actuel: compactPlanning(plan.planning),
              couverts_par_repas: couverts,
              consigne: `Remplace les recettes qui portent les postes les plus chers par des équivalents moins coûteux, à apport protéique comparable. Vise ${budget} €.`
            }
          }, suivi);
          plan = appliquerPatch(plan, patch);
          text = null;
          continue;
        }
      }

      // Gaspillage des conditionnements : un pack ouvert pour un quart
      // utilisé, c'est de l'argent et de la nourriture perdus.
      if (attempt < 2 && Object.keys(conditionnementsConnus).length >= 5) {
        const items = Aggregator.buildBasket(plan, inventory, matches);
        const emb = Aggregator.analyserEmballages(items, matches);
        plan.emballages = emb;
        if (emb.gaspilleurs.length >= 3 || emb.valeurPerdue > 5) {
          onStatus?.(`${emb.valeurPerdue.toFixed(2)} € de restes inutilisés — ajustement…`);
          const patch = await demanderPatch(settings, system, {
            type: 'conditionnements',
            probleme: `Les quantités ne collent pas aux packs vendus : ${emb.valeurPerdue.toFixed(2)} € de produit resterait inutilisé.`,
            restes: emb.gaspilleurs.slice(0, 8).map(g =>
              `${g.nom} : besoin ${g.besoin} ${g.unite}, vendu par ${g.pack} ${g.unite} → ${g.reste} ${g.unite} perdus (${g.part} %)`),
            contexte: {
              recettes_existantes: plan.recettes.map(r => ({ id: r.id, nom: r.nom })),
              planning_actuel: compactPlanning(plan.planning),
              couverts_par_repas: couverts,
              conditionnements: conditionnementsConnus,
              consigne: 'Ajuste les quantités pour consommer des packs entiers, ou ajoute une recette qui réutilise les restes dans la semaine. Ne dépasse pas les cibles caloriques.'
            }
          }, suivi);
          plan = appliquerPatch(plan, patch);
          text = null;
          continue;
        }
      }

      const odd = Catalogue.suspects(plan, matches, unavailable);
      if (odd.length === 0 || attempt >= 3) {
        if (odd.length) console.warn('Ingrédients hors catalogue conservés :', odd);
        plan.hors_catalogue = odd.length ? odd : undefined;
        plan.cout = {
          usd: Math.round(estimerCout(usage, settings.model) * 10000) / 10000,
          tokens: lireUsage(),
          modele: settings.model
        };
        return plan;
      }
      onStatus?.('Ajustement au catalogue…');
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `Ces ingrédients ne sont pas trouvables en hypermarché français : ${odd.join(', ')}. Remplace chacun par l'équivalent le plus proche du bloc CATALOGUE, ajuste les étapes en conséquence, et renvoie le JSON complet corrigé, uniquement le JSON.`
      });
      text = await callApi(settings, messages, system, suivi);
    }
    return plan;
  }

  const SYSTEM_ETAPES = `Tu rédiges les étapes de préparation d'une recette.
Réponds UNIQUEMENT avec un tableau JSON de chaînes, sans texte autour, sans balises markdown.
3 à 6 étapes, une phrase courte et concrète chacune, à l'impératif.
Mentionne les températures et les durées quand elles comptent. N'invente pas d'ingrédient absent de la liste.`;

  /* Steps are generated on demand, recipe by recipe: the week's menu appears
     in seconds instead of waiting for every recipe's instructions. */
  async function genererEtapes(recette) {
    const settings = Store.getSettings();
    if (!settings.apiKey) throw new Error('NO_API_KEY');
    const payload = {
      nom: recette.nom,
      portions: recette.portions,
      temps_preparation_min: recette.temps_preparation_min,
      temps_cuisson_min: recette.temps_cuisson_min,
      ingredients: recette.ingredients.map(i => `${i.nom_canonique} ${i.quantite} ${i.unite}`)
    };
    // Rédiger 4 phrases ne demande pas le gros modèle.
    const text = await callApi(settings, [{ role: 'user', content: JSON.stringify(payload) }],
      SYSTEM_ETAPES, null, MODELE_LEGER);
    const etapes = JSON.parse(stripFences(text));
    if (!Array.isArray(etapes) || !etapes.length) throw new Error('Étapes illisibles');
    return etapes.map(String);
  }

  const SYSTEM_REMPLACER = `Tu remplaces UNE recette dans un plan de repas existant.
Réponds UNIQUEMENT avec un JSON de la forme :
{ "recette": { ...une seule recette au format habituel, sans "etapes"... } }
Contraintes :
- même nombre de portions et macros comparables (±10 % sur les calories et les protéines par portion) : elle occupe les mêmes créneaux.
- réutilise en priorité les ingrédients déjà présents dans les autres recettes de la semaine, pour ne pas alourdir le panier.
- respecte les interdits, les dégoûts, la complexité et les styles de cuisine demandés.
- l'identifiant doit être nouveau et différent de tous ceux déjà utilisés.`;

  /* Replace a single recipe in place. Costs one small call instead of a full
     week: the planning slots are simply repointed to the new recipe. */
  async function remplacerRecette({ plan, recetteId, raison, profile, onStatus }) {
    const settings = Store.getSettings();
    if (!settings.apiKey) throw new Error('NO_API_KEY');
    const ancienne = plan.recettes.find(r => r.id === recetteId);
    if (!ancienne) throw new Error('recette introuvable');

    resetUsage();
    const autres = plan.recettes.filter(r => r.id !== recetteId);
    const ingredientsDejaLa = [...new Set(autres.flatMap(r => r.ingredients.map(i => i.nom_canonique)))];
    const creneaux = (plan.planning || []).filter(p => p.recette_id === recetteId).length;

    const demande = {
      a_remplacer: { nom: ancienne.nom, portions: ancienne.portions, macros: ancienne.macros_par_portion },
      raison: raison || 'ne plaît pas',
      creneaux_occupes: creneaux,
      ingredients_deja_dans_la_semaine: ingredientsDejaLa,
      autres_plats_de_la_semaine: autres.map(r => r.nom),
      profil: {
        objectif: profile.objectif,
        complexite: profile.complexite,
        cuisines: profile.cuisines,
        interdits: [...new Set(profile.convives.flatMap(c => c.exclusions || []))],
        n_aime_pas: [...new Set([
          ...profile.convives.flatMap(c => c.deteste || []),
          ...(profile.plats_refuses || [])
        ])]
      }
    };

    onStatus?.('Recherche d\'un autre plat…');
    const system = `${SYSTEM_REMPLACER}\n\n${Catalogue.promptBlock(Store.getMatches(), Store.getUnavailable())}`;
    const text = await callApi(settings, [{ role: 'user', content: JSON.stringify(demande) }], system);
    const rep = JSON.parse(stripFences(text));
    const nouvelle = rep.recette || rep;
    if (!nouvelle || !nouvelle.id || !Array.isArray(nouvelle.ingredients)) {
      throw new Error('réponse inattendue');
    }
    if (!Array.isArray(nouvelle.etapes)) nouvelle.etapes = [];
    if (plan.recettes.some(r => r.id === nouvelle.id)) nouvelle.id = `${nouvelle.id}-${Date.now().toString(36)}`;

    const majPlan = {
      ...plan,
      recettes: [...autres, nouvelle],
      planning: (plan.planning || []).map(p =>
        p.recette_id === recetteId ? { ...p, recette_id: nouvelle.id } : p)
    };
    majPlan.cout = plan.cout;
    return { plan: majPlan, nouvelle, ancienne, cout: estimerCout(lireUsage(), settings.model) };
  }

  return { generate, genererEtapes, remplacerRecette, lireUsage, estimerCout, TARIFS };
})();
