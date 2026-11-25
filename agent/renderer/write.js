'use strict';
/*
 * "Skriv i HolyMoly": en simpel Word-agtig editor, hvor alt skal være tastet.
 *  - Indsæt, træk-og-slip og store tekstklumper blokeres (og tælles).
 *  - Skriveforløbet måles: tastede tegn, slettede tegn, tempo (tegn/sek.) og hvor jævnt tasterne kommer.
 *  - Dokumentet gemmes hos serveren hvert 5. sekund. Serveren noterer selv elevens lampe undervejs
 *    og afgør ved aflevering, om der kan udstedes et skrive-bevis.
 *  - Ved hver gemning svarer serveren med en prøve-vurdering: hvorfor beviset vil mangle (uden tal).
 *    "Afslut dokument" viser årsagerne først: "Skriv videre" eller "Aflever alligevel".
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const page = document.querySelector('.page');
  let ed = $('editor');
  document.execCommand('defaultParagraphSeparator', false, 'p');
  document.execCommand('styleWithCSS', false, false);
  // Nyt editor-element for hvert dokument = ny fortryd-historik (intet kan "fortrydes" over i et andet dokument)
  function newEditor() {
    const fresh = ed.cloneNode(false);
    ed.replaceWith(fresh);
    ed = fresh;
  }

  let doc = null;        // { id, title, created, submitted, result, stats }
  let dirty = false;
  let lessonLive = false;
  let stats = null;
  // Mærket (D.label fra hovedprocessen – samme tekst som i Word-filen og på tjek-siden)
  let labels = { base: '', lektion: '', hjemme: '' };
  const labelFor = (place) => (/hjemme/.test(place || '') ? labels.hjemme : place ? labels.lektion : labels.base);
  const newStats = () => ({ typed: 0, deleted: 0, restored: 0, keystrokes: 0, pasteBlocked: 0, pasteInserted: 0, dropBlocked: 0, maxCps: 0, burst: 0, fastShare: 0, regularity: null, focusLostMs: 0, activeMs: 0 });

  /* ---------- måling af skriveforløbet ---------- */
  const times = [];   // tidspunkter for tastede tegn (seneste 5 sek. til tempo)
  const gaps = [];    // afstand mellem tastetryk (til jævnhed)
  let lastKey = 0, timed = 0, fast = 0, repeatKey = false;
  // En tast der holdes nede (auto-gentag, fx en streg "------") er ikke skrivetempo
  page.addEventListener('keydown', (e) => { repeatKey = !!e.repeat; }, true);
  function countTyped(n) {
    stats.typed += n;
    stats.keystrokes++;
    allowance += n;
    if (repeatKey) return;
    const now = performance.now();
    if (lastKey) {
      const g = now - lastKey;
      timed++;
      if (g < 12) fast++;                       // hurtigere end en finger kan trykke = maskine
      if (g >= 12 && g < 2000) { gaps.push(g); if (gaps.length > 600) gaps.shift(); }
      if (g < 5000) stats.activeMs += g;
      if (timed >= 100) stats.fastShare = Math.round((fast / timed) * 1000) / 1000;
    }
    lastKey = now;
    for (let i = 0; i < n; i++) times.push(now);
    while (times.length && now - times[0] > 5000) times.shift();
    // Tempo over de seneste 5 sek. og "byger" inden for ét sekund (fx et program der sender en hel sætning)
    if (times.length > 20) stats.maxCps = Math.max(stats.maxCps, Math.round((times.length / 5) * 10) / 10);
    let inSec = 0;
    for (let i = times.length - 1; i >= 0 && now - times[i] <= 1000; i--) inSec++;
    stats.burst = Math.max(stats.burst, inSec);
    if (gaps.length >= 200) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
      stats.regularity = Math.round((sd / mean) * 1000) / 1000;
    }
  }

  let toastT;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /*
   * Værn mod tekst der ikke er tastet, uanset hvordan den kommer ind (diktering, IME, programmer):
   * efter hver ændring sammenlignes tekstens vækst med det, der er talt som tastet. Vokser den mere,
   * rulles ændringen tilbage.
   */
  let snap = [], snapLen = 0, allowance = 0, composing = false, undoing = false;
  const textLen = () => (ed.textContent || '').length;
  function takeSnap() { snap = toBlocks(); snapLen = textLen(); allowance = 0; }
  function caretToEnd() {
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function checkGrowth() {
    const growth = textLen() - snapLen;
    if (undoing) { stats.restored += Math.max(0, growth); undoing = false; takeSnap(); return; }
    if (growth > allowance + 2) {
      stats.pasteBlocked++;
      fromBlocks(snap);
      caretToEnd();
      toast('Tekst der ikke er tastet, kan ikke indsættes her.');
      snapLen = textLen();
      allowance = 0;
      return;
    }
    takeSnap();
  }

  const PASTE = new Set(['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank', 'insertLink']);
  page.addEventListener('beforeinput', (e) => {
    if (e.target !== ed) return;
    if (!editable()) { e.preventDefault(); return; }
    const t = e.inputType;
    if (PASTE.has(t)) {
      e.preventDefault();
      if (t === 'insertFromDrop') stats.dropBlocked++; else stats.pasteBlocked++;
      toast('Indsæt er slået fra her. Det du afleverer, skal du selv have skrevet.');
      return;
    }
    if (t === 'insertText' || t === 'insertReplacementText') {
      const data = t === 'insertReplacementText' ? (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '' : (e.data || '');
      // Et tastetryk giver ét tegn (enkelte taster lidt flere; stavekontrollen et ord). Store klumper er ikke tastet.
      const max = t === 'insertReplacementText' ? 40 : 4;
      if (data.length > max) { e.preventDefault(); stats.pasteBlocked++; toast('Tekst der ikke er tastet, kan ikke indsættes.'); return; }
      countTyped(Math.max(1, data.length));
    } else if (t === 'insertParagraph' || t === 'insertLineBreak') {
      countTyped(1);
    } else if (t === 'historyUndo' || t === 'historyRedo') {
      // Fortryd må kun bringe tekst tilbage, som eleven selv har skrevet og slettet
      undoing = true;
      allowance += Math.max(0, stats.deleted - stats.restored);
    } else if (t.startsWith('delete')) {
      const sel = window.getSelection();
      stats.deleted += Math.max(1, sel && !sel.isCollapsed ? sel.toString().length : 1);
    }
    dirty = true;
  });
  page.addEventListener('compositionstart', (e) => { if (e.target === ed) composing = true; });
  page.addEventListener('compositionend', (e) => {
    if (e.target !== ed) return;
    composing = false;
    if (!editable()) return;
    // Døde taster (fx ´ + e) og korte IME-ord er tastet – lange "kompositioner" er ikke
    if (e.data) countTyped(Math.min(12, e.data.length));
    checkGrowth();
  });
  page.addEventListener('input', (e) => {
    if (e.target !== ed) return;
    dirty = true;
    if (!composing) checkGrowth();
    updateWords();
  });
  // Indsæt (Ctrl+V, genvejsmenu) og træk-og-slip stoppes allerede her – og tælles
  page.addEventListener('paste', (e) => {
    if (e.target !== ed && !ed.contains(e.target)) return;
    e.preventDefault();
    if (!editable()) return;
    stats.pasteBlocked++;
    toast('Indsæt er slået fra her. Det du afleverer, skal du selv have skrevet.');
  });
  page.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!editable()) return;
    stats.dropBlocked++;
    toast('Træk-og-slip af tekst er slået fra her.');
  });
  page.addEventListener('dragover', (e) => e.preventDefault());
  $('title').addEventListener('input', () => { dirty = true; });
  $('title').addEventListener('paste', (e) => { e.preventDefault(); if (stats) stats.pasteBlocked++; toast('Indsæt er slået fra her.'); });
  $('title').addEventListener('drop', (e) => e.preventDefault());
  $('title').addEventListener('beforeinput', (e) => { if (e.inputType.startsWith('history')) e.preventDefault(); });

  let blurAt = 0;
  window.addEventListener('blur', () => { blurAt = Date.now(); });
  window.addEventListener('focus', () => { if (blurAt && stats) stats.focusLostMs += Date.now() - blurAt; blurAt = 0; });

  /* ---------- formatering ---------- */
  document.querySelectorAll('.tools [data-cmd]').forEach(b => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (!editable()) return;
    document.execCommand(b.dataset.cmd, false, null);
    dirty = true; syncTools();
  }));
  document.querySelectorAll('.tools [data-block]').forEach(b => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (!editable()) return;
    document.execCommand('formatBlock', false, b.dataset.block);
    dirty = true; syncTools();
  }));
  function syncTools() {
    for (const c of ['bold', 'italic', 'underline']) {
      const b = document.querySelector(`.tools [data-cmd="${c}"]`);
      try { b.classList.toggle('on', document.queryCommandState(c)); } catch (e) { /* */ }
    }
  }
  document.addEventListener('selectionchange', syncTools);

  /* ---------- dokument <-> blokke (ingen HTML sendes nogen steder hen) ---------- */
  function toBlocks() {
    const blocks = [];
    let cur = null;
    const start = (t) => { cur = { t, r: [] }; blocks.push(cur); };
    function runs(node, fmt, t) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          if (!cur) start(t);
          if (c.nodeValue) cur.r.push(Object.assign({ x: c.nodeValue }, fmt));
        } else if (c.nodeType === 1) {
          const tag = c.tagName.toLowerCase();
          if (tag === 'br') { start(t); continue; }
          const f = Object.assign({}, fmt);
          if (tag === 'b' || tag === 'strong') f.b = 1;
          if (tag === 'i' || tag === 'em') f.i = 1;
          if (tag === 'u') f.u = 1;
          runs(c, f, t);
        }
      }
    }
    for (const n of ed.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) { start('p'); cur.r.push({ x: n.nodeValue }); } continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        for (const li of n.querySelectorAll(':scope > li')) { start(tag); runs(li, {}, tag); }
        continue;
      }
      const t = tag === 'h1' ? 'h1' : tag === 'h2' || tag === 'h3' ? 'h2' : 'p';
      start(t);
      runs(n, {}, t);
    }
    // Fjern tomme blokke i slutningen
    while (blocks.length && !blocks[blocks.length - 1].r.some(r => r.x.trim())) blocks.pop();
    return blocks;
  }
  function fromBlocks(blocks) {
    ed.replaceChildren();
    let list = null;
    for (const b of blocks || []) {
      let host;
      if (b.t === 'ul' || b.t === 'ol') {
        if (!list || list.tagName.toLowerCase() !== b.t) { list = document.createElement(b.t); ed.append(list); }
        host = document.createElement('li'); list.append(host);
      } else {
        list = null;
        host = document.createElement(b.t === 'h1' ? 'h1' : b.t === 'h2' ? 'h2' : 'p');
        ed.append(host);
      }
      for (const r of b.r) {
        let node = document.createTextNode(r.x);
        if (r.u) { const u = document.createElement('u'); u.append(node); node = u; }
        if (r.i) { const i = document.createElement('i'); i.append(node); node = i; }
        if (r.b) { const s = document.createElement('b'); s.append(node); node = s; }
        host.append(node);
      }
      if (!b.r.length) host.append(document.createElement('br'));
    }
    updateWords();
  }
  function updateWords() {
    const m = (ed.innerText || '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu);
    $('words').textContent = (m ? m.length : 0) + ' ord';
  }

  /* ---------- tilstand ---------- */
  const editable = () => !!(doc && !doc.submitted && lessonLive);
  function applyMode() {
    const can = editable();
    ed.contentEditable = can ? 'true' : 'false';
    $('title').disabled = !can;
    $('submit').disabled = !can;
    $('del').hidden = !(doc && !doc.submitted);
    const n = $('notice');
    if (doc && doc.submitted) { n.textContent = doc.result && doc.result.certId ? `Afsluttet med mærket "${labelFor(doc.result.place)}". Dokumentet kan ikke længere ændres – vedhæft det til en aflevering under "Afleveringer".` : 'Afsluttet uden bevis. Dokumentet kan ikke længere ændres.'; n.hidden = false; }
    else if (!lessonLive) { n.textContent = 'Du kan skrive her, når din lærer har startet en lektion eller du har startet en skriveøkt.'; n.hidden = false; }
    else n.hidden = true;
    showPreview();
  }
  /* Prøve-vurdering: hvad mangler, hvis eleven afleverer nu (kun kategorier – aldrig tempotal) */
  const SHORT = { kort: 'for kort', rod: 'rød lampe', forbindelse: 'forbindelse', indsat: 'indsat tekst', tempo: 'skrivetempo', ai: 'AI-spor' };
  function showPreview() {
    const el = $('preview');
    const pv = doc && !doc.submitted && lessonLive ? doc.preview : null;
    if (!pv) { el.hidden = true; return; }
    const cats = Array.isArray(pv.categories) ? pv.categories : [];
    el.hidden = false;
    if (!cats.length) { el.textContent = 'Beviset er i orden indtil videre'; el.title = ''; return; }
    el.textContent = 'Beviset vil mangle: ' + cats.map(c => SHORT[c.key] || c.key).join(', ');
    el.title = cats.map(c => c.text).join('\n');
  }
  function fillDocs(list) {
    const sel = $('docs');
    sel.replaceChildren(...list.map(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = (d.title || 'Uden titel') + (d.submitted ? (d.certId ? ' ✓' : ' (afsluttet)') : ''); return o; }));
    if (doc) sel.value = doc.id;
  }
  async function open(id) {
    await saveNow();
    const d = await window.hmw.load(id);
    if (!d) return;
    doc = d;
    stats = Object.assign(newStats(), d.stats || {});
    newEditor();
    $('title').value = d.title || '';
    fromBlocks(d.blocks);
    takeSnap();
    $('saved').textContent = '';
    applyMode();
    fillDocs((await window.hmw.state()).docs);
  }
  async function newDoc(opts) {
    await saveNow();
    const d = await window.hmw.create(opts);
    await open(d.id);
    ed.focus();
  }
  $('docs').addEventListener('change', (e) => open(e.target.value));
  $('new').addEventListener('click', () => newDoc());

  /* ---------- gem ---------- */
  let saving = false;
  async function saveNow() {
    if (!doc || doc.submitted || !dirty || saving) return;
    saving = true;
    dirty = false;
    try {
      const r = await window.hmw.save({ id: doc.id, title: $('title').value, blocks: toBlocks(), stats });
      $('saved').textContent = r.ok ? 'Gemt ' + new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }) + (r.local ? ' (på computeren)' : '') : (r.error || 'Kunne ikke gemme');
      if (!r.ok) dirty = true;
    } finally { saving = false; }
  }
  setInterval(saveNow, 5000);
  window.hmw.onSaved((r) => {
    if (!doc || r.id !== doc.id) return;
    if (!r.ok && r.error && r.error !== 'busy') $('saved').textContent = r.error;
    if (r.ok && r.preview) { doc.preview = r.preview; showPreview(); }
  });

  /* ---------- aflever ---------- */
  // Mangler beviset, vises årsagerne først: "Skriv videre" (intet låses) eller "Aflever alligevel" (låses uden bevis)
  let confirmForce = false;
  function openConfirm(cats) {
    const a = doc && doc.assignmentId && assignments.find(x => x.id === doc.assignmentId);
    $('confirm-asg').hidden = !a;
    if (a) $('confirm-asg').textContent = `Dokumentet bliver derefter afleveret til "${a.title}".`;
    $('confirm-mark').textContent = labels.base;
    const missing = Array.isArray(cats) && cats.length > 0;
    confirmForce = missing;
    $('confirm-title').textContent = missing ? 'Beviset vil mangle' : 'Afslut dokumentet?';
    $('confirm-text').hidden = missing;
    $('confirm-why').hidden = !missing;
    $('confirm-list').replaceChildren(...(missing ? cats.map(c => li(c.text)) : []));
    $('confirm-no').textContent = missing ? 'Skriv videre' : 'Annuller';
    $('confirm-yes').textContent = missing ? 'Aflever alligevel' : 'Afslut';
    $('confirm').showModal();
  }
  $('submit').addEventListener('click', () => {
    if (!editable()) return;
    const pv = doc.preview;
    openConfirm(pv && !pv.ok ? pv.categories : null);
  });
  $('confirm').addEventListener('close', () => {
    if ($('confirm').returnValue !== 'yes') { if (confirmForce) ed.focus(); return; }
    submitNow(confirmForce);
  });
  async function submitNow(force) {
    dirty = true;
    await saveNow();
    $('submit').disabled = true;
    $('saved').textContent = 'Afleverer…';
    const r = await window.hmw.submit(doc.id, force);
    $('saved').textContent = '';
    if (!r.ok && r.confirm) {
      // Serveren giver ikke et bevis: intet er låst. Eleven vælger selv.
      doc.preview = { ok: false, categories: r.categories || [] };
      applyMode();
      openConfirm(doc.preview.categories);
      return;
    }
    if (!r.ok) { toast(r.error || 'Kunne ikke aflevere'); applyMode(); return; }
    doc = await window.hmw.load(doc.id);
    applyMode();
    fillDocs((await window.hmw.state()).docs);
    // Skrevet til en aflevering: vedhæftes med det samme
    let attached = null;
    const a = doc.assignmentId && assignments.find(x => x.id === doc.assignmentId);
    if (a) {
      const ar = await window.hmw.attach(a.id, doc.id);
      attached = ar.ok ? a.title : null;
      if (!ar.ok) toast('Kunne ikke aflevere til "' + a.title + '": ' + (ar.error || 'ukendt fejl'));
    }
    showResult(r, attached);
  }
  function li(text) { const x = document.createElement('li'); x.textContent = text; return x; }
  function showResult(r, attachedTo) {
    const body = $('r-body');
    body.replaceChildren();
    if (r.certId) {
      $('r-title').textContent = labelFor(r.place);
      const box = document.createElement('div'); box.className = 'cert';
      const code = document.createElement('div'); code.className = 'code'; code.textContent = 'HM-' + r.certId.slice(0, 8).toUpperCase();
      const p = document.createElement('p'); p.textContent = 'Dokumentet har fået mærket. Det står også i sidefoden, når du gemmer det som Word. Beviset dækker skriveforløbet på computeren – ikke afskrift fra telefon eller papir. Koden og linket kan bruges til at tjekke det.';
      const url = document.createElement('div'); url.className = 'url'; url.textContent = r.url || '';
      box.append(code, p, url);
      body.append(box);
    } else {
      $('r-title').textContent = 'Afleveret uden bevis';
      const cats = r.categories || [];
      const p = document.createElement('p'); p.textContent = cats.length ? 'Dokumentet fik ikke mærket, fordi:' : 'HolyMoly kunne ikke udstede et bevis for dokumentet.';
      const ul = document.createElement('ul'); ul.className = 'why-list';
      for (const c of cats) ul.append(li(c.text));
      body.append(p, ul);
    }
    if (attachedTo) { const p = document.createElement('p'); p.className = 'st-ok'; p.textContent = `Afleveret til "${attachedTo}".`; body.append(p); }
    $('result').showModal();
  }

  /* ---------- afleveringer fra læreren ---------- */
  let assignments = [];
  const fmtDue = (ts) => new Date(ts).toLocaleString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function setAssignments(list) {
    assignments = Array.isArray(list) ? list : [];
    const open = assignments.filter(a => !a.submission).length;
    $('asg-count').hidden = !open;
    $('asg-count').textContent = String(open);
    if ($('asg').open) renderAssignments();
  }
  const HOME_TEXT = 'Hjemme blokerer HolyMoly kun AI-tjenester og fjernstyring, mens skrivevinduet er åbent. Din lærer ser kun, at du skriver, din lampe og om noget blev blokeret – ikke din skærm, dine faner, programmer eller hvilke sider du besøger. Hjemme tages der aldrig skærmbilleder.';
  async function renderAssignments() {
    const docs = (await window.hmw.state()).docs.filter(d => d.submitted);
    const ul = $('asg-list');
    if (!assignments.length) { ul.replaceChildren(el('li', 'empty', 'Din lærer har ikke lagt nogen afleveringer ud.')); return; }
    ul.replaceChildren(...assignments.map((a) => {
      const li = el('li');
      const late = a.due && Date.now() > a.due && !a.submission;
      li.append(el('div', 'head', null));
      li.firstChild.append(el('span', 't', a.title), el('span', 'meta' + (late ? ' late' : ''), (a.className ? a.className + ' · ' : '') + (a.due ? 'Frist ' + fmtDue(a.due) : 'Ingen frist')));
      if (a.description) li.append(el('div', 'desc', a.description));
      if (a.submission) li.append(el('div', 'st' + (a.submission.certified ? ' ok' : ''), `Afleveret: "${a.submission.title || 'Uden titel'}"` + (a.submission.certified ? ' – ' + labels.base : ' – uden bevis')));
      const row = el('div', 'row');
      const canHome = a.home && !lessonLive && !(a.due && Date.now() > a.due);
      const write = el('button', 'btn', canHome ? 'Skriv hjemme' : 'Skriv besvarelse');
      write.type = 'button';
      write.disabled = !lessonLive && !canHome;
      write.title = lessonLive || canHome ? '' : (a.home ? 'Fristen er overskredet' : 'Denne aflevering skrives i timen, når din lærer har startet en lektion');
      write.addEventListener('click', async () => {
        if (canHome) {
          // Skriveøkt hjemme: kun AI og fjernstyring blokeres, og kun mens skrivevinduet er åbent
          write.disabled = true;
          const r = await window.hmw.session(a.id, true);
          write.disabled = false;
          if (!r.ok) { toast(r.error || 'Kunne ikke starte skriveøkten'); return; }
          toast('Skriveøkten er startet. HolyMoly er aktiv, til du lukker skrivevinduet.');
        }
        $('asg').close();
        await newDoc({ assignmentId: a.id });
      });
      row.append(write);
      if (a.home) li.append(el('div', 'muted', 'Må skrives hjemme. ' + HOME_TEXT));
      if (docs.length) {
        const sel = el('select');
        sel.setAttribute('aria-label', 'Vælg dokument');
        for (const d of docs) { const o = el('option', null, (d.title || 'Uden titel') + (d.certId ? ' ✓' : ' (uden bevis)')); o.value = d.id; sel.append(o); }
        if (a.submission) sel.value = a.submission.docId;
        const att = el('button', 'btn primary', a.submission ? 'Skift dokument' : 'Vedhæft');
        att.type = 'button';
        att.addEventListener('click', async () => {
          att.disabled = true;
          const r = await window.hmw.attach(a.id, sel.value);
          att.disabled = false;
          toast(r.ok ? `Afleveret til "${a.title}"` : (r.error || 'Kunne ikke aflevere'));
        });
        row.append(sel, att);
      } else row.append(el('span', 'muted', 'Afslut et dokument for at kunne vedhæfte det.'));
      li.append(row);
      return li;
    }));
  }
  async function showAssignments() { await saveNow(); await renderAssignments(); if (!$('asg').open) $('asg').showModal(); }
  $('asg-btn').addEventListener('click', showAssignments);
  window.hmw.onAssignments(setAssignments);
  window.hmw.onShowAssignments(showAssignments);
  window.hmw.assignments().then(setAssignments);
  $('r-docx').addEventListener('click', () => exportDocx());
  async function exportDocx() {
    await saveNow();
    if (!doc) return;
    const r = await window.hmw.docx(doc.id);
    if (r && r.ok) toast('Gemt som ' + r.name);
    else if (r && r.error) toast(r.error);
  }
  $('docx').addEventListener('click', exportDocx);

  /* ---------- slet kladde ---------- */
  $('del').addEventListener('click', () => { if (doc && !doc.submitted) $('del-dlg').showModal(); });
  $('del-dlg').addEventListener('close', async () => {
    if ($('del-dlg').returnValue !== 'yes' || !doc || doc.submitted) return;
    dirty = false;
    const r = await window.hmw.remove(doc.id);
    if (!r.ok) { toast(r.error || 'Kunne ikke slette kladden'); return; }
    toast('Kladden er slettet');
    doc = null;
    const s = await window.hmw.state();
    if (s.docs.length) await open(s.docs[0].id); else await newDoc();
  });

  /* ---------- start ---------- */
  window.hmw.onLesson((live) => { lessonLive = !!live; applyMode(); });
  (async () => {
    const s = await window.hmw.state();
    lessonLive = s.lesson;
    if (s.labels) labels = s.labels;
    if (s.docs.length) await open(s.docs[0].id); else await newDoc();
    applyMode();
  })();
})();
