/*
 * HolyMoly content script. Kører i alle sider og rammer (også iframes) og fanger
 * det netværksblokeringen ikke kan se: proxy-kopier af sider, oversætter-proxyer,
 * indlejrede rammer, base64-kodede adresser og sider der genkendes på indholdet.
 */
(function () {
  'use strict';
  if (window.__holymoly) return;
  window.__holymoly = true;
  const TOP = window === window.top;

  chrome.storage.local.get('hm', ({ hm }) => {
    if (!hm || !hm.active || !(hm.endsAt > Date.now()) || !hm.rules) return;
    const C = self.ACRules.compile(hm.rules, hm.config || {});
    let blocked = false;

    function block(r, reason) {
      if (blocked) return;
      blocked = true;
      try { window.stop(); } catch (e) { /* */ }
      const msg = { type: 'blocked', url: location.href, title: document.title, category: r.category, reason, top: TOP };
      try { chrome.runtime.sendMessage(msg); } catch (e) { /* */ }
      // Fjern indholdet med det samme – både i hovedsiden og i indlejrede rammer.
      const wipe = () => {
        try {
          document.documentElement.replaceChildren();
          const b = document.createElement('body');
          b.style.cssText = 'margin:0;background:#101317;color:#eceef2;font:16px system-ui;display:grid;place-items:center;height:100vh';
          b.textContent = 'Blokeret af HolyMoly';
          document.documentElement.append(b);
        } catch (e) { /* */ }
      };
      wipe();
      // Nogle sider genopbygger DOM'en – bliv ved med at fjerne den.
      new MutationObserver(() => { if (document.body && document.body.textContent !== 'Blokeret af HolyMoly') wipe(); })
        .observe(document.documentElement, { childList: true, subtree: true });
    }

    // Lærerens "altid tilladte" sider røres ikke (heller ikke af indholds-genkendelsen)
    if (C.isAllowedHost(location.hostname)) return;

    // 1) Adressen (inkl. indlejrede/base64-kodede adresser og oversætter-proxyer)
    const ru = C.classifyUrl(location.href);
    // Prøvetilstand gælder sider eleven åbner – ikke indlejrede rammer (login-widgets, reCAPTCHA …)
    if (ru && ru.blocked && !(ru.category === 'exam' && !TOP)) return block(ru, 'url:' + ru.via);
    if (!TOP && document.referrer) {
      // about:blank-rammer arver ikke en adresse – tjek forælderens
    }

    // 2) Google: slå AI-oversigter og AI-tilstand fra (udm=14 = kun weblinks)
    if (TOP && /(^|\.)google\.[a-z.]+$/.test(location.hostname) && location.pathname === '/search') {
      const p = new URLSearchParams(location.search);
      const udm = p.get('udm');
      if (!p.get('tbm') && (udm === null || udm === '50')) {
        p.set('udm', '14');
        location.replace(location.pathname + '?' + p.toString() + location.hash);
        return;
      }
    }

    // 3) AI inde i tilladte sider (Gemini i Google Docs, Copilot i Word Online …): skjul knapper og paneler
    const aiSel = C.aiUiSelectors(location.hostname).join(',');
    let aiHidden = 0;
    function hideAi() {
      if (!aiSel) return;
      let els;
      try { els = document.querySelectorAll(aiSel); } catch (e) { return; }
      for (const el of els) {
        if (el.dataset.hmHidden) continue;
        el.dataset.hmHidden = '1';
        el.style.setProperty('display', 'none', 'important');
        aiHidden++;
      }
    }

    // 4) Indholdet: og:site_name, sidetitel og kendetegn i DOM'en
    const sigs = C.domSignatures();
    function scan() {
      if (blocked) return;
      hideAi();
      // Indholdet blokeres kun med mindst to uafhængige beviser, så en side der bare
      // hedder "ChatGPT" eller har et felt med samme id ikke rammes ved en fejl.
      // og:site_name tæller dobbelt (det sætter kun tjenesten selv – eller en kopi af den).
      let score = 0;
      let hit = null;
      const metas = document.querySelectorAll('meta[property="og:site_name"], meta[name="application-name"], meta[name="apple-mobile-web-app-title"], meta[property="al:android:app_name"]');
      for (const m of metas) {
        const r = C.classifySiteName(m.getAttribute('content') || '');
        if (r && r.blocked) { score += 2; hit = hit || r; break; }
      }
      const rt = C.classifyTitle(document.title);
      if (rt && rt.blocked) { score += 1; hit = hit || rt; }
      for (const s of sigs) {
        try {
          if (document.querySelector(s.selector)) { score += 1; hit = hit || C.result(s.category, s.selector, 'dom'); break; }
        } catch (e) { /* ugyldig selector */ }
      }
      if (score >= 2 && hit) return block(hit, 'indhold');
      // Rammer i siden, der peger på blokerede adresser
      for (const f of document.querySelectorAll('iframe[src], frame[src], embed[src], object[data]')) {
        const src = f.getAttribute('src') || f.getAttribute('data');
        try {
          const r = C.classifyUrl(new URL(src, location.href).href);
          if (r && r.blocked) { f.remove(); try { chrome.runtime.sendMessage({ type: 'blocked', url: src, title: document.title, category: r.category, reason: 'iframe', top: false }); } catch (e) { /* */ } }
        } catch (e) { /* */ }
      }
    }

    let pending = false;
    const schedule = () => {
      if (pending || blocked) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 300);
    };
    const start = () => {
      scan();
      const obs = new MutationObserver(schedule);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'content'] });
      // Titlen ændrer sig i single-page apps
      const t = document.querySelector('title');
      if (t) new MutationObserver(schedule).observe(t, { childList: true, characterData: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    // Single-page apps skifter adresse uden at genindlæse
    let lastHref = location.href;
    setInterval(() => {
      if (blocked || location.href === lastHref) return;
      lastHref = location.href;
      const r = C.classifyUrl(location.href);
      if (r && r.blocked) block(r, 'url:' + r.via);
    }, 700);
  });
})();
