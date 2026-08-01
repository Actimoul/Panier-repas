/* Bridge content script, injected on the app's own origin.

   The PWA cannot talk to chrome.storage directly, and asking the user to
   copy-paste a JSON blob between two windows is friction we can remove.
   This script sits on the app's page and relays messages both ways:

     page  → window.postMessage({ source:'panier-repas', type:'load-list', payload })
     here  → chrome.storage.local.set({ prList })       → replies 'list-loaded'

     page  → window.postMessage({ source:'panier-repas', type:'get-choices' })
     here  → reads chrome.storage.local.prState.choix   → replies 'choices'

     page  → window.postMessage({ source:'panier-repas', type:'get-prices' })
     here  → reads chrome.storage.local.prPrix     → replies 'prices'

     page  → window.postMessage({ source:'panier-repas', type:'set-price-list' })
     here  → stores the ingredients to price       → replies 'price-list-set'

     page  → window.postMessage({ source:'panier-repas', type:'ping' })
     here  → replies 'pong' so the app knows the extension is installed

   Only same-window messages are accepted, and only from the page's own
   origin — no cross-site exposure. */
(() => {
  const SOURCE = 'panier-repas';
  const REPLY = 'panier-repas-ext';

  function reply(type, data) {
    window.postMessage({ source: REPLY, type, ...data }, window.location.origin);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;                 // same window only
    if (event.origin !== window.location.origin) return; // same origin only
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    try {
      switch (msg.type) {
        case 'ping':
          reply('pong', { version: chrome.runtime.getManifest().version });
          break;

        case 'load-list': {
          const payload = msg.payload;
          if (!payload || !Array.isArray(payload.articles)) {
            reply('error', { message: 'liste illisible' });
            return;
          }
          await chrome.storage.local.set({ prList: payload });
          await chrome.storage.local.remove(['prState']);
          reply('list-loaded', { count: payload.articles.length });
          break;
        }

        case 'get-choices': {
          const data = await chrome.storage.local.get(['prState']);
          reply('choices', { choix: data.prState?.choix || [] });
          break;
        }

        case 'get-prices': {
          const data = await chrome.storage.local.get(['prPrix']);
          reply('prices', { releve: data.prPrix || null });
          break;
        }

        /* The app tells the extension which ingredients to price next time
           the user is on the store site. */
        case 'set-price-list': {
          await chrome.storage.local.set({ prAReleverPrix: msg.payload || [] });
          reply('price-list-set', { count: (msg.payload || []).length });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[Panier Repas] bridge:', err);
      reply('error', { message: err.message });
    }
  });

  // Tell the page we're here, in case it loaded before us.
  reply('pong', { version: chrome.runtime.getManifest().version });
})();
