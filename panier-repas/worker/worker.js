/* Cloudflare Worker — weight endpoint for Panier Repas.
   Fed by the iOS Shortcut (Apple Health → POST /weight),
   read by the PWA (GET /weights).

   Setup:
   1. wrangler kv namespace create WEIGHTS   → paste the id into wrangler.toml
   2. wrangler secret put SHARED_SECRET      → choose a long random string
   3. wrangler deploy
   Put the worker URL + secret in the app's settings (⚙). */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Secret'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const secret = request.headers.get('X-Secret');
    if (!secret || secret !== env.SHARED_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/weight') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const kg = parseFloat(body.kg);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '')
        ? body.date
        : new Date().toISOString().slice(0, 10);
      if (!(kg > 20 && kg < 400)) {
        return json({ error: `kg out of range: ${body.kg}` }, 400);
      }
      const raw = await env.WEIGHTS.get('all');
      const list = raw ? JSON.parse(raw) : [];
      const idx = list.findIndex(w => w.date === date);
      if (idx >= 0) list[idx].kg = kg; else list.push({ date, kg });
      list.sort((a, b) => a.date.localeCompare(b.date));
      // keep the last 120 entries
      await env.WEIGHTS.put('all', JSON.stringify(list.slice(-120)));
      return json({ ok: true, count: list.length });
    }

    if (request.method === 'GET' && url.pathname === '/weights') {
      const raw = await env.WEIGHTS.get('all');
      return json(raw ? JSON.parse(raw) : []);
    }

    return json({ error: 'not found' }, 404);
  }
};
