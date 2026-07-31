/* Plan generation through the Anthropic API (direct browser access).
   One automatic repair round-trip if the first output fails validation. */
const Generator = (() => {
  const API_URL = 'https://api.anthropic.com/v1/messages';

  const SYSTEM_PROMPT = `Tu es un moteur de planification de repas. Tu génères un plan hebdomadaire au format JSON strict "PlanSemaine v1.0".

RÈGLES ABSOLUES :
1. Réponds UNIQUEMENT avec le JSON, sans texte avant/après, sans balises markdown.
2. Chaque nom_canonique est en minuscules, au singulier, sans marque. Réutilise EXACTEMENT le même nom canonique pour un même ingrédient d'une recette à l'autre.
3. Unités : uniquement "g", "ml", "piece". Convertis les mesures ménagères (1 c.à.s = 15 ml).
4. fond_de_placard: true pour sel, poivre, huiles, épices, vinaigres, miel.
5. Batch cooking : 4 à 6 recettes maximum, portions multiples. Étapes concises : 3 à 6 lignes par recette, une phrase chacune.
6. Le planning respecte les DLC : ingrédients peremption_type "tres_courte" cuisinés dans les 2-3 premiers jours.
7. Les macros cumulées de chaque jour approchent kcal_cible_jour (±5 %) et atteignent proteines_cible_jour_g.
8. Respecte exclusions sans exception.
9. Si un inventaire est fourni, utilise ces ingrédients en priorité dans les premières recettes.
10. Reste sous budget_hebdo_eur (protéines économiques si budget serré).
11. couverts_par_repas indique le nombre de couverts (somme des coefficients des convives présents, décimal possible) pour chaque créneau jour/repas. Le planning couvre EXACTEMENT ces créneaux : aucun repas pour un créneau absent ou à 0, et planning.portions = le nombre de couverts du créneau (décimal autorisé, ex. 1.6). Les portions des recettes doivent suffire pour couvrir la somme des couverts planifiés.
12. Les cibles kcal/protéines s'appliquent à l'adulte principal (coefficient 1). Les recettes restent familiales : les couverts partiels mangent les mêmes plats en portion réduite.
13. DISPONIBILITÉ EN MAGASIN — règle stricte : chaque nom_canonique doit désigner un produit réellement trouvable dans un hypermarché français ordinaire. Utilise en priorité les termes exacts du bloc CATALOGUE fourni. Si une recette demande un ingrédient absent du catalogue, remplace-le par l'équivalent le plus proche qui y figure (ex. galanga → gingembre frais, mirin → vinaigre de cidre + sucre, burrata → mozzarella). N'invente jamais un produit d'épicerie spécialisée, de primeur exotique ou de marque précise.
14. complexite fixe l'ambition technique : "express" = ≤ 20 min, peu d'étapes, une seule poêle/casserole ; "simple" = ≤ 40 min, techniques de base, jusqu'à 8 étapes ; "elabore" = ≤ 90 min, plusieurs cuissons, marinades et sauces autorisées. Respecte le plafond de temps (temps_preparation_min + temps_cuisson_min) pour CHAQUE recette.
15. interdits_absolus : ces ingrédients ne doivent JAMAIS apparaître, sous aucune forme, même en trace ou en substitut proche (allergies et régimes). n_aime_pas : simples dégoûts — évite-les, mais un usage discret et bien intégré (fondu dans une sauce, mixé) reste toléré si nécessaire.
16. jours_entrainement donne, par jour de la semaine, qui s'entraîne. Ces jours-là, augmente les glucides (+15 à 20 % environ) et place les repas les plus riches en protéines autour de la séance. Les jours sans entraînement, réduis légèrement les glucides à calories équivalentes.
17. cuisines liste les styles culinaires souhaités : répartis les recettes de la semaine entre ces styles, en restant fidèle à leurs bases (assaisonnements, techniques) mais uniquement avec des ingrédients du catalogue. Si la liste est vide, varie librement.

STRUCTURE ATTENDUE (types) :
{
  "version": "1.0",
  "semaine": { "date_debut": "YYYY-MM-DD", "nb_jours": 7 },
  "profil": { ...copie du profil reçu... },
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
    "etapes": [str]
  }],
  "planning": [{ "jour": 1-7, "repas": "petit_dejeuner|dejeuner|collation|diner", "recette_id": str, "portions": int }]
}`;

  function stripFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  const TIMEOUT_MS = 180000; // 3 min hard ceiling per call

  async function callApi(settings, messages, systemPrompt) {
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
          model: settings.model,
          max_tokens: 16000,
          system: systemPrompt,
          messages
        })
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Délai dépassé (3 min). Réessaie.');
      throw new Error(`Réseau : ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (!text) throw new Error('Réponse vide de l\'API');
    // Truncated output would silently fail JSON.parse and trigger a useless retry.
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Réponse tronquée : réduis le nombre de repas/jour ou de convives.');
    }
    return text;
  }

  /* Generate the weekly plan. onStatus(msg) reports progress to the UI. */
  async function generate({ profile, inventory, dateDebut, couverts, joursSport, interdits, detestes, noteAjustement, onStatus }) {
    const settings = Store.getSettings();
    if (!settings.apiKey) throw new Error('NO_API_KEY');

    const { convives, presence, ...profilLite } = profile;
    const userPayload = {
      profil: profilLite,
      date_debut: dateDebut,
      couverts_par_repas: couverts || undefined,
      jours_entrainement: joursSport && Object.keys(joursSport).length ? joursSport : undefined,
      interdits_absolus: interdits?.length ? interdits : undefined,
      n_aime_pas: detestes?.length ? detestes : undefined,
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

    const messages = [{ role: 'user', content: JSON.stringify(userPayload) }];
    onStatus?.('Génération du plan de semaine… (1/3)');
    let text = await callApi(settings, messages, system);

    let plan = null;
    // Round 1-2: schema validity. Round 3: catalogue realism.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        plan = JSON.parse(stripFences(text));
      } catch (err) {
        plan = null;
      }
      const check = plan ? PlanSchema.validate(plan) : { valid: false, errors: ['invalid JSON'] };

      if (!check.valid) {
        if (attempt >= 1) {
          throw new Error(`Plan invalide après correction : ${check.errors.slice(0, 5).join(' | ')}`);
        }
        onStatus?.('Format à corriger, nouvelle tentative… (2/3)');
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: `Ta réponse est invalide : ${check.errors.slice(0, 10).join(' | ')}. Renvoie le JSON complet corrigé, uniquement le JSON.`
        });
        text = await callApi(settings, messages, system);
        continue;
      }

      // valid JSON — now check store availability, once
      const odd = Catalogue.suspects(plan, matches, unavailable);
      if (odd.length === 0 || attempt >= 2) {
        if (odd.length) console.warn('Ingrédients hors catalogue conservés :', odd);
        plan.hors_catalogue = odd.length ? odd : undefined;
        return plan;
      }
      onStatus?.('Ajustement au catalogue Leclerc… (3/3)');
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `Ces ingrédients ne sont pas trouvables en hypermarché français : ${odd.join(', ')}. Remplace chacun par l'équivalent le plus proche du bloc CATALOGUE, ajuste les étapes en conséquence, et renvoie le JSON complet corrigé, uniquement le JSON.`
      });
      text = await callApi(settings, messages, system);
    }
    return plan;
  }

  return { generate };
})();
