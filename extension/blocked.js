(function () {
  'use strict';
  // Adressen står efter '#'. En eventuel årsag fra content scriptet står efter '#hm:'.
  const raw = location.hash.slice(1);
  const i = raw.indexOf('#hm:');
  const url = i >= 0 ? raw.slice(0, i) : raw;
  const meta = i >= 0 ? raw.slice(i + 4).split('|') : [];
  const dec = (x) => { try { return decodeURIComponent(x); } catch (e) { return x; } };
  const reason = meta[0] ? dec(meta[0]) : 'netværk';
  const hintCategory = meta[1] ? dec(meta[1]) : '';
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* */ }
  chrome.storage.local.get('hm', ({ hm }) => {
    let label = '';
    let category = '';
    if (hm && hm.rules) {
      const r = self.ACRules.compile(hm.rules, hm.config || {}).classifyUrl(url);
      if (r) { label = r.label; category = r.category; }
    }
    // Sider genkendt på indholdet (fx en kopi af Instagram) har kategorien med fra content scriptet
    if (!category && hintCategory && self.ACRules.CATEGORIES[hintCategory]) {
      category = hintCategory;
      label = self.ACRules.CATEGORIES[hintCategory].label;
    }
    document.getElementById('what').textContent = host + (label ? ' (' + label + ')' : '');
    chrome.runtime.sendMessage({ type: 'blockedPage', url, category, reason });
  });
  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 2) history.go(-2); else location.href = 'about:blank';
  });
})();
