chrome.runtime.sendMessage({ type: 'status' }, (r) => {
  const el = document.getElementById('s');
  if (!r) { el.textContent = 'Ingen status.'; return; }
  const t = r.endsAt ? new Date(r.endsAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }) : '';
  el.textContent = (r.connected ? 'Forbundet til HolyMoly-appen. ' : 'HolyMoly-appen kører ikke. ') +
    (r.active ? 'Lektion i gang – blokering aktiv til kl. ' + t + '.' : 'Ingen lektion – intet blokeres.');
});
