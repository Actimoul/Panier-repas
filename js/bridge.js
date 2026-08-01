/* Client side of the extension bridge.

   The extension injects bridge.js on this page; we talk to it through
   window.postMessage. If it isn't installed, every call rejects quickly and
   the UI falls back to the clipboard. */
const Bridge = (() => {
  const SOURCE = 'panier-repas';
  const REPLY = 'panier-repas-ext';

  let installed = null;   // null = unknown, true/false once probed
  let version = null;

  /* Listen passively: the bridge announces itself on load. */
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source === REPLY && event.data.type === 'pong') {
      installed = true;
      version = event.data.version || null;
    }
  });

  function ask(type, payload, timeoutMs = 1200) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        installed = installed === true ? true : false;
        reject(new Error('EXTENSION_ABSENTE'));
      }, timeoutMs);

      function onMsg(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const d = event.data;
        if (!d || d.source !== REPLY) return;
        if (d.type === 'error') {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          reject(new Error(d.message || 'Erreur extension'));
          return;
        }
        // any non-pong reply resolves the pending question
        if (d.type !== 'pong' || type === 'ping') {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          installed = true;
          resolve(d);
        }
      }

      window.addEventListener('message', onMsg);
      window.postMessage({ source: SOURCE, type, payload }, window.location.origin);
    });
  }

  return {
    estInstallee: () => installed,
    versionExtension: () => version,
    ping: () => ask('ping', null, 800),
    envoyerListe: (payload) => ask('load-list', payload, 2500),
    recupererChoix: () => ask('get-choices', null, 2000)
  };
})();
