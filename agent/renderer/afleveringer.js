/*
 * Afleveringer i hovedvinduet – som lærerens side 'Afleveringer' i dashboardet (server/public/account.js).
 * Kortet 'Åbne' har knapperne 'Skriv verificeret aflevering' og 'Verificerede afleveringer'; hver aflevering har 'Aflever'.
 * Data og handlinger: window.hm.verified (agent/src/preload.js → agent/src/verified.js). Logikken: window.HMAssignmentsView.
 */
(function () {
  'use strict';
  const V = window.HMAssignmentsView;
  const $ = (id) => document.getElementById(id);
  let data = { lesson: false, now: Date.now(), assignments: [], docs: [] };
  let isOpen = false;
  let attachFor = null;
  let opener = null; // knappen, der åbnede den viste dialog

  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function button(text, cls, onClick) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function say(text) { $('afl-live').textContent = ''; setTimeout(() => { $('afl-live').textContent = text; }, 30); }

  /* ---------- siden ---------- */
  async function refresh() {
    if (!isOpen) return;
    try { const d = await window.hm.verified.overview(); if (d && typeof d === 'object') data = d; } catch (e) { /* hovedprocessen svarede ikke: vis det, vi har */ }
    render();
  }
  let refreshTimer = null;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 300); }

  function openPage() {
    if (isOpen) { $('afl-title').focus(); return refresh(); }
    isOpen = true;
    document.body.classList.add('afl-open');
    $('afl').hidden = false;
    try { window.hm.verified.page(true); } catch (e) { /* */ }
    render();
    $('afl-title').focus();
    return refresh();
  }
  function closePage() {
    if (!isOpen) return;
    isOpen = false;
    for (const id of ['afl-pick', 'afl-docs', 'afl-attach']) if ($(id).open) $(id).close();
    document.body.classList.remove('afl-open');
    $('afl').hidden = true;
    try { window.hm.verified.page(false); } catch (e) { /* */ }
    if (!$('status').hidden) $('afl-btn').focus();
  }

  function row(a, now) {
    const st = V.status(a, now);
    const tr = el('tr');
    const what = el('td');
    what.append(el('b', null, a.title || 'Uden titel'), el('div', 'muted small', V.where(a)));
    if (a.description) { const d = el('div', 'afl-desc small', a.description); what.append(d); }
    const due = el('td', 'num', V.fmtDue(a.due));
    const status = el('td');
    status.append(el('span', 'afl-badge ' + st.tone, st.text));
    const act = el('td', 'afl-act');
    const b = button('Aflever', 'small', (e) => { opener = e.currentTarget; showAttach(a); });
    b.setAttribute('aria-label', `Aflever ${a.title || 'Uden titel'}`);
    act.append(b);
    tr.append(what, due, status, act);
    return tr;
  }
  function fill(tableId, list, empty, now) {
    const tb = $(tableId).tBodies[0];
    if (!list.length) {
      const td = el('td', 'muted', empty);
      td.colSpan = 4;
      const tr = el('tr'); tr.append(td);
      tb.replaceChildren(tr);
      return;
    }
    tb.replaceChildren(...list.map(a => row(a, now)));
  }
  function render() {
    const now = Date.now();
    const g = V.split(data.assignments, now);
    fill('afl-open-table', g.open, 'Ingen åbne afleveringer lige nu.', now);
    $('afl-past').hidden = !g.past.length;
    $('afl-past-h').textContent = g.pastTitle;
    $('afl-past-cap').textContent = g.pastTitle === 'Afleveret' ? 'Afleverede afleveringer, hvor fristen er passeret' : 'Afleveringer, hvor fristen er passeret';
    fill('afl-past-table', g.past, '', now);
  }

  /* ---------- 'Skriv verificeret aflevering': hvilken aflevering? ---------- */
  function choice(name, value, title, meta, { checked = false, disabled = false, hint = '' } = {}) {
    const lab = el('label', 'afl-choice' + (disabled ? ' disabled' : ''));
    const inp = el('input');
    inp.type = 'radio'; inp.name = name; inp.value = String(value); inp.checked = checked; inp.disabled = disabled;
    const txt = el('span', 'afl-choice-text');
    txt.append(el('span', 't', title));
    if (meta) txt.append(el('span', 'm', meta));
    if (hint) txt.append(el('span', 'm', hint));
    lab.append(inp, txt);
    return lab;
  }
  async function showPick() {
    await refresh();
    const items = V.writable(data.assignments, { lesson: !!data.lesson, now: Date.now() });
    const fs = $('afl-pick-list');
    const legend = fs.querySelector('legend');
    let picked = false;
    const opts = items.map((a) => {
      const meta = a.where + (a.due ? ' · Frist ' + V.fmtDue(a.due) : '') + (a.submitted ? ' · Afleveret' : '');
      const c = choice('afl-pick', a.id, a.title || 'Uden titel', meta, { checked: a.canWrite && !picked, disabled: !a.canWrite, hint: a.why });
      if (a.canWrite) picked = true;
      return c;
    });
    opts.push(choice('afl-pick', 0, 'Uden aflevering', data.lesson ? 'Et nyt dokument, der ikke hører til en aflevering.' : 'Uden for timen får teksten kun mærke, når den skrives til en aflevering, der må skrives hjemme.', { checked: !picked }));
    fs.replaceChildren(legend, ...opts);
    $('afl-pick-result').textContent = '';
    $('afl-pick-go').disabled = false;
    $('afl-pick').showModal();
    const first = fs.querySelector('input:checked');
    if (first) first.focus();
  }
  $('afl-pick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = $('afl-pick-form').querySelector('input[name="afl-pick"]:checked');
    if (!sel) return;
    $('afl-pick-go').disabled = true;
    $('afl-pick-result').textContent = 'Åbner skrivevinduet…';
    let r;
    try { r = await window.hm.verified.write(Number(sel.value) || 0); } catch (err) { r = { ok: false, error: 'Kunne ikke åbne skrivevinduet' }; }
    $('afl-pick-go').disabled = false;
    if (r && r.ok) { $('afl-pick').close(); say('Skrivevinduet er åbnet.'); return; }
    $('afl-pick-result').textContent = (r && r.error) || 'Kunne ikke åbne skrivevinduet';
  });
  $('afl-pick-cancel').addEventListener('click', () => $('afl-pick').close());

  /* ---------- 'Verificerede afleveringer' ---------- */
  async function showDocs() {
    let list = [];
    try { list = (await window.hm.verified.list()) || []; } catch (e) { list = []; }
    const body = $('afl-docs-body');
    $('afl-docs-result').textContent = '';
    if (!list.length) {
      body.replaceChildren(el('p', 'muted', 'Du har ingen verificerede afleveringer endnu. Brug "Skriv verificeret aflevering".'));
    } else {
      const titles = new Map((data.assignments || []).map(a => [a.id, a.title]));
      const table = el('table', 'afl-table');
      const cap = el('caption', 'sr-only', 'Dine dokumenter med mærke');
      const head = el('thead'); const hr = el('tr');
      for (const h of ['Dokument', 'Ord', 'Dato', 'Mærke']) { const th = el('th', null, h); th.scope = 'col'; hr.append(th); }
      const thAct = el('th'); thAct.scope = 'col'; thAct.append(el('span', 'sr-only', 'Handling')); hr.append(thAct);
      head.append(hr);
      const tb = el('tbody');
      for (const d of list) {
        const tr = el('tr');
        const t = el('td');
        t.append(el('b', null, d.title || 'Uden titel'));
        const to = d.assignmentId && titles.get(d.assignmentId);
        t.append(el('div', 'muted small', (d.source === 'word' ? 'Word' : 'HolyMoly') + (to ? ' · til ' + to : '')));
        const act = el('td', 'afl-act');
        const name = d.title || 'Uden titel';
        const run = async (b, fn, okText) => {
          b.disabled = true;
          let r;
          try { r = await fn(); } catch (e) { r = { ok: false, error: 'Det lykkedes ikke' }; }
          b.disabled = false;
          if (r && r.ok) $('afl-docs-result').textContent = okText(r);
          else if (r && r.error) $('afl-docs-result').textContent = r.error;
        };
        if (d.canOpen) {
          const label = d.source === 'word' ? 'Vis i mappe' : 'Åbn';
          const b = button(label, 'small', () => run(b, () => window.hm.verified.open(d.id), () => d.source === 'word' ? `"${name}" er vist i mappen.` : `"${name}" er åbnet i skrivevinduet.`));
          b.setAttribute('aria-label', `${label} ${name}`);
          act.append(b);
        }
        if (d.canDocx) {
          const b = button('Hent Word-fil', 'small', () => run(b, () => window.hm.verified.docx(d.id), (r) => `Gemt som ${r.name || 'Word-fil'}.`));
          b.setAttribute('aria-label', `Hent Word-fil ${name}`);
          act.append(b);
        }
        tr.append(t, el('td', 'num', String(d.words || 0)), el('td', 'num', V.fmtDate(d.date)), el('td', 'small', d.label), act);
        tb.append(tr);
      }
      table.append(cap, head, tb);
      body.replaceChildren(table);
    }
    $('afl-docs').showModal();
    const first = body.querySelector('button') || $('afl-docs').querySelector('button[value="ok"]');
    if (first) first.focus();
  }

  /* ---------- 'Aflever': vælg en verificeret aflevering ---------- */
  function docChoice(d, current) {
    const meta = `${d.words} ord · ${V.fmtDate(d.date)}` + (d.source === 'word' ? ' · Word' : '');
    return choice('afl-doc', d.id, d.title || 'Uden titel', meta, { checked: d.id === current, hint: d.certId ? d.label : 'Uden mærke' });
  }
  async function showAttach(a) {
    await refresh();
    a = (data.assignments || []).find(x => x.id === a.id) || a;
    attachFor = a;
    const now = Date.now();
    $('afl-attach-h').textContent = `Aflever: ${a.title || 'Uden titel'}`;
    $('afl-attach-meta').textContent = V.where(a) + ' · ' + (a.due ? 'Frist ' + V.fmtDue(a.due) : 'Ingen frist');
    $('afl-attach-late').hidden = !V.isPast(a, now);
    const current = a.submission ? a.submission.docId : '';
    $('afl-attach-now').hidden = !a.submission;
    if (a.submission) $('afl-attach-now').textContent = `Du har afleveret "${a.submission.title || 'Uden titel'}". Vælger du et andet dokument, afleverer du det i stedet.`;
    const { marked, unmarked } = V.forAttach(data.docs, data.assignments, a.id);
    const fm = $('afl-attach-marked');
    fm.replaceChildren(fm.querySelector('legend'), ...(marked.length ? marked.map(d => docChoice(d, current))
      : [el('p', 'muted small', 'Du har ingen verificerede afleveringer endnu. Brug "Skriv verificeret aflevering".')]));
    const fu = $('afl-attach-unmarked');
    fu.replaceChildren(fu.querySelector('legend'), ...(unmarked.length ? unmarked.map(d => docChoice(d, current))
      : [el('p', 'muted small', 'Ingen afsluttede dokumenter uden mærke.')]));
    $('afl-attach-more').open = unmarked.some(d => d.id === current);
    $('afl-attach-result').textContent = '';
    $('afl-attach-result').className = 'afl-result';
    $('afl-attach-cancel').textContent = 'Annuller';
    updateAttachBtn();
    $('afl-attach').showModal();
    const first = $('afl-attach-form').querySelector('input[name="afl-doc"]:checked') || fm.querySelector('input') || $('afl-attach-more').querySelector('summary');
    if (first) first.focus();
  }
  function updateAttachBtn() { $('afl-attach-go').disabled = !$('afl-attach-form').querySelector('input[name="afl-doc"]:checked'); }
  $('afl-attach-form').addEventListener('change', updateAttachBtn);
  $('afl-attach-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = $('afl-attach-form').querySelector('input[name="afl-doc"]:checked');
    if (!sel || !attachFor) return;
    const a = attachFor;
    $('afl-attach-go').disabled = true;
    $('afl-attach-result').className = 'afl-result';
    $('afl-attach-result').textContent = 'Afleverer…';
    let r;
    try { r = await window.hm.verified.attach(a.id, sel.value); } catch (err) { r = { ok: false, error: '' }; }
    const res = V.attachResult(r, (r && r.at) || Date.now());
    $('afl-attach-result').className = 'afl-result ' + (res.ok ? 'ok' : 'err');
    $('afl-attach-result').textContent = res.text;
    if (res.ok) {
      $('afl-attach-cancel').textContent = 'Luk';
      say(`${a.title || 'Uden titel'}: ${res.text}`);
      refreshSoon();
    } else updateAttachBtn();
  });
  $('afl-attach-cancel').addEventListener('click', () => $('afl-attach').close());

  /* ---------- knapper og opdateringer ---------- */
  // Når en dialog lukkes, får knappen, der åbnede den, fokus igen
  for (const id of ['afl-pick', 'afl-docs', 'afl-attach']) {
    $(id).addEventListener('close', () => {
      // Tabellen kan være tegnet igen imens: så findes den nye knap med samme navn
      const label = opener && opener.getAttribute('aria-label');
      const again = opener && !document.contains(opener) && label ? [...document.querySelectorAll('#afl button[aria-label]')].find(b => b.getAttribute('aria-label') === label) : null;
      const target = opener && document.contains(opener) ? opener : again;
      if (target && isOpen) target.focus(); else if (isOpen) $('afl-title').focus();
      opener = null;
    });
  }
  const withOpener = (fn) => (e) => { opener = e.currentTarget; return fn(); };

  $('afl-btn').addEventListener('click', openPage);
  $('assign-btn').addEventListener('click', openPage);
  $('afl-back').addEventListener('click', closePage);
  $('afl-write').addEventListener('click', withOpener(showPick));
  $('afl-verified').addEventListener('click', withOpener(showDocs));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen && !document.querySelector('dialog[open]')) closePage();
  });
  window.addEventListener('focus', refreshSoon);
  if (window.hm.onShowAssignments) window.hm.onShowAssignments(() => openPage());
  window.hm.onState((s) => {
    if (!isOpen) return;
    // Første opsætning eller ingen klasse: siden lukkes (ui.js viser opsætningen)
    if (!s || s.serverSetup || !(s.enrollments || []).length) { closePage(); return; }
    refreshSoon();
  });
  window.HMAfleveringer = { open: openPage, close: closePage, refresh, isOpen: () => isOpen };
})();
