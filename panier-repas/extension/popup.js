const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const delivEl = document.getElementById('deliv');
const slotEl = document.getElementById('slot-info');
let parsed = null;

function showSlot() {
  const rang = parseInt(delivEl.value, 10);
  const liv = (parsed?.livraisons || []).find(l => l.rang === rang);
  if (!liv) { slotEl.hidden = true; return; }
  const count = parsed.articles.filter(a => (a.livraison || 1) === rang).length;
  slotEl.textContent = `Créneau : ${liv.label} — ${liv.date} · ${count} article(s)`;
  slotEl.hidden = false;
}

/* Re-parse on every edit so the delivery picker reflects the pasted payload. */
listEl.addEventListener('input', () => {
  try {
    parsed = JSON.parse(listEl.value);
  } catch {
    parsed = null;
  }
  const livraisons = parsed?.livraisons || [];
  delivEl.innerHTML = (livraisons.length ? livraisons : [{ rang: 1, label: 'Livraison 1' }])
    .map(l => `<option value="${l.rang}">Livraison ${l.rang}${l.label ? ' — ' + l.label : ''}</option>`)
    .join('');
  showSlot();
});
delivEl.addEventListener('change', showSlot);

async function refreshStatus() {
  const data = await chrome.storage.local.get(['prList', 'prState']);
  if (data.prState) {
    statusEl.textContent = `Liste en cours : ${data.prState.cursor}/${data.prState.articles.length} articles traités.`;
  } else if (data.prList) {
    statusEl.textContent = `Liste chargée : ${data.prList.articles.length} articles. Ouvre le site Leclerc.`;
  } else {
    statusEl.textContent = 'Aucune liste chargée.';
  }
}

document.getElementById('load').addEventListener('click', async () => {
  statusEl.classList.remove('err');
  try {
    const payload = parsed || JSON.parse(listEl.value);
    if (payload.source !== 'panier-repas' || !Array.isArray(payload.articles)) {
      throw new Error('format inattendu (copie depuis l\'app)');
    }
    const rang = parseInt(delivEl.value, 10);
    const articles = payload.articles.filter(a => (a.livraison || 1) === rang);
    if (!articles.length) throw new Error('aucun article pour cette livraison');
    const creneau = (payload.livraisons || []).find(l => l.rang === rang) || null;
    await chrome.storage.local.set({ prList: { ...payload, articles, creneau } });
    await chrome.storage.local.remove(['prState']);
    await refreshStatus();
  } catch (err) {
    statusEl.classList.add('err');
    statusEl.textContent = 'Erreur : ' + err.message;
  }
});

refreshStatus();
