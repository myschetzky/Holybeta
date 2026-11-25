/* HolyMoly – forside, priser, jura og hent-side: topbar, footer, priser og links.
 * På serveren hentes priser og firmaoplysninger fra /api/pricing og /api/info.
 * På GitHub Pages sætter build-scriptet window.HM_SITE (ingen server). */
(function () {
  'use strict';
  const S = Object.assign({ app: '', demo: '', pages: false, pricing: null, info: null }, window.HM_SITE || {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const kr = (n) => Math.round(n).toLocaleString('da-DK') + ' kr.';
  const appUrl = (p) => (S.app ? S.app.replace(/\/+$/, '') + p : (S.pages ? (S.demo || 'demo.html') : p));
  const home = S.pages ? './' : '/forside';
  const page = (p) => (S.pages ? p.replace(/^\//, '') + '.html' : p);
  const icon = S.pages ? 'icon.svg' : '/icon.svg';

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c));
    return e;
  }

  /* ---------- topbar og footer (fælles for alle sider) ---------- */
  const onFront = !!$('.hero');
  const sec = (id) => (onFront ? '#' + id : home + '#' + id);
  const head = $('#site-head');
  if (head) {
    const nav = el('nav', { class: 'site-nav', 'aria-label': 'Hovedmenu', id: 'site-nav' },
      el('a', { href: sec('produkt'), text: 'Sådan virker det' }),
      el('a', { href: sec('tryghed'), text: 'Databeskyttelse' }), el('a', { href: sec('priser'), text: 'Priser' }), el('a', { href: sec('faq'), text: 'Spørgsmål' }));
    const toggle = el('button', { class: 'btn small plain menu-toggle', 'aria-expanded': 'false', 'aria-controls': 'site-nav', text: 'Menu' });
    toggle.addEventListener('click', () => { const o = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(o)); toggle.textContent = o ? 'Luk' : 'Menu'; });
    nav.addEventListener('click', (e) => { if (e.target.tagName === 'A') { nav.classList.remove('open'); toggle.textContent = 'Menu'; } });
    head.append(el('div', { class: 'wrap' },
      el('a', { class: 'logo', href: home }, el('img', { src: icon, alt: '' }), 'HolyMoly'),
      nav,
      el('div', { class: 'head-cta' },
        el('a', { class: 'btn small plain login', 'data-link': 'login', href: '/login', text: 'Log ind' }),
        el('a', { class: 'btn small primary', 'data-link': 'signup', href: '/opret', text: 'Start prøveperiode' }),
        toggle)));
    const onScroll = () => head.classList.toggle('scrolled', scrollY > 4);
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }
  const foot = $('#site-foot');
  if (foot) {
    foot.append(el('div', { class: 'wrap' },
      el('div', { class: 'about' }, el('a', { class: 'logo', href: home }, el('img', { src: icon, alt: '' }), 'HolyMoly'),
        el('p', { text: 'Elevernes bevis på, at deres tekst ikke er skrevet med AI.' }), el('p', { class: 'small', 'data-company': 'line' })),
      el('div', {}, el('h4', { text: 'Produkt' }), el('ul', {}, el('li', {}, el('a', { href: sec('produkt'), text: 'Sådan virker det' })), el('li', {}, el('a', { href: sec('priser'), text: 'Priser' })), el('li', {}, el('a', { href: page('/hent'), text: 'Hent elev-appen' })), S.demo || S.pages ? el('li', {}, el('a', { 'data-link': 'demo', href: '#', text: 'Se demoen' })) : null)),
      el('div', {}, el('h4', { text: 'Skoler' }), el('ul', {}, el('li', {}, el('a', { 'data-link': 'signup', href: '/opret', text: 'Start prøveperiode' })), el('li', {}, el('a', { 'data-link': 'login', href: '/login', text: 'Log ind' })), el('li', {}, el('a', { href: sec('faq'), text: 'Spørgsmål' })))),
      el('div', {}, el('h4', { text: 'Jura' }), el('ul', {}, el('li', {}, el('a', { href: page('/sikkerhed'), text: 'Sikkerhed og databeskyttelse' })), el('li', {}, el('a', { href: page('/vilkaar'), text: 'Vilkår' })), el('li', {}, el('a', { href: page('/vilkaar-elev'), text: 'Vilkår for elever' })), el('li', {}, el('a', { href: page('/privatliv'), text: 'Privatlivspolitik' })), el('li', {}, el('a', { href: page('/databehandleraftale'), text: 'Databehandleraftale' })))),
      el('div', { class: 'legal' }, el('span', { 'data-company': 'copy', text: '© ' + new Date().getFullYear() + ' HolyMoly' }))));
  }

  /* ---------- links: opret / log ind / demo / kontakt ---------- */
  function wireLinks(info) {
    const contact = info && info.company && info.company.email;
    for (const a of $$('[data-link]')) {
      const k = a.dataset.link;
      if (k === 'signup') { a.href = appUrl('/opret'); if (S.pages && !S.app) a.textContent = 'Se demoen'; }
      else if (k === 'login') a.href = appUrl('/login');
      else if (k === 'demo') { if (S.demo || S.pages) a.href = S.demo || 'demo.html'; else if (a.closest('li')) a.closest('li').remove(); else a.remove(); }
      else if (k === 'contact' && contact) a.href = 'mailto:' + contact;
    }
  }

  /* ---------- priser og firmaoplysninger ---------- */
  function applyPricing(p) {
    if (!p) return;
    for (const e of $$('[data-price]')) e.textContent = kr(p.perStudent);
    for (const e of $$('[data-min]')) e.textContent = kr(p.minimum);
    for (const e of $$('[data-trial]')) e.textContent = String(p.trialDays || 30);
    const r = $('#calc-n'), out = $('#calc-out'), tot = $('#calc-total');
    if (!r) return;
    const upd = () => { const n = Number(r.value); out.textContent = n.toLocaleString('da-DK'); tot.textContent = kr(Math.max(p.minimum, n * p.perStudent)); };
    r.oninput = upd; upd();
  }
  function applyCompany(c) {
    if (!c) return;
    const name = c.name || 'HolyMoly';
    const line = [c.cvr ? name + ' · CVR ' + c.cvr : '', c.address].filter(Boolean).join(' · ');
    for (const e of $$('[data-company]')) {
      const k = e.dataset.company;
      const v = k === 'line' ? line : k === 'copy' ? '© ' + new Date().getFullYear() + ' ' + name : c[k];
      if (v) e.textContent = v;
    }
  }

  /* ---------- beta: skolens ja (vises på privatlivssiden) ---------- */
  function fillApproval(info) {
    const box = document.getElementById('approval');
    if (!box || !info) return;
    const a = info.approval;
    if (a) {
      box.hidden = false;
      box.replaceChildren(el('b', { text: 'Ansvarlig for denne server: ' }), document.createTextNode(`${a.controller}. Databeskyttelsesrådgiver: ${a.dpo}. Konsekvensanalyse: ${a.dpiaDate}. Ledelsens godkendelse: ${a.approvedDate}.`));
    } else if (info.simple && info.lessonBlocked) {
      box.hidden = false;
      box.replaceChildren(el('b', { text: 'Skolen har ikke givet sit ja endnu. ' }), document.createTextNode('Der kan ikke startes lektioner, før det er på plads.'));
    }
  }

  /* ---------- hent-siden ---------- */
  function fillDownloads(info) {
    if (!$('#downloads')) return;
    const d = (info && info.downloads) || {};
    const fallback = info && info.downloadUrl;
    for (const os of ['windows', 'mac']) {
      const a = $(`[data-dl="${os}"]`);
      const url = a && (d[os] || fallback);
      if (url) { a.href = url; a.hidden = false; $(`[data-dl-missing="${os}"]`).hidden = true; }
    }
    const ext = (info && info.extensionUrls) || {};
    for (const b of ['chrome', 'edge', 'firefox']) { const a = $(`[data-ext="${b}"]`); if (a && ext[b]) { a.href = ext[b]; a.hidden = false; } }
  }

  /* ---------- frister (server/src/retention.js): tal i <span data-cfg="retention.draftDays"> ---------- */
  function fillRetention(r) {
    if (!r) return;
    for (const e of $$('[data-cfg^="retention."]')) {
      const v = r[e.dataset.cfg.slice(10)];
      if (v != null) e.textContent = String(v);
    }
  }

  const defaults = { perStudent: 129, minimum: 2500, trialDays: 30 };
  if (S.pages) { applyPricing(S.pricing || defaults); applyCompany(S.info && S.info.company); wireLinks(S.info); fillDownloads(null); }
  else {
    applyPricing(defaults); wireLinks(null);
    fetch('/api/pricing').then(r => r.json()).then(applyPricing).catch(() => {});
    fetch('/api/info').then(r => r.json()).then((i) => { applyCompany(i.company); wireLinks(i); fillDownloads(i); fillApproval(i); fillRetention(i.retention); }).catch(() => fillDownloads(null));
  }
})();
