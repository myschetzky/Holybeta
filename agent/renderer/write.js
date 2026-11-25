'use strict';
/*
 * "Skriv i HolyMoly": en simpel Word-agtig editor, hvor alt skal være tastet.
 *  - Indsæt, træk-og-slip og store tekstklumper blokeres (og tælles).
 *  - Skriveforløbet måles: tastede tegn, slettede tegn, tempo (tegn/sek.) og hvor jævnt tasterne kommer.
 *  - Dokumentet gemmes hos serveren hvert 5. sekund. Serveren noterer selv elevens lampe undervejs
 *    og afgør ved aflevering, om der kan udstedes et skrive-bevis.
 *  - Ved hver gemning svarer serveren med en prøve-vurdering: hvorfor beviset vil mangle (uden tal).
 *    "Afslut dokument" viser årsagerne først: "Annuller" eller "Aflever uden mærke".
 *  - Til alle: stavekontrol (højreklik), tekststørrelse og linjeafstand (Visning), zoom (Ctrl +/-/0), genveje og skærmlæser.
 *  - Hjælpemidler, læreren har slået til: ordforslag (ét ord ad gangen) og diktering tælles for sig (stats.predicted/dictated).
 *  - Øvedokument ("Øv dig"): kun i dette vindues hukommelse. Det sendes aldrig og vurderes lokalt (HMDoc.evaluateStats).
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
  const newStats = () => ({ typed: 0, deleted: 0, restored: 0, keystrokes: 0, pasteBlocked: 0, pasteInserted: 0, dropBlocked: 0, maxCps: 0, burst: 0, fastShare: 0, regularity: null, focusLostMs: 0, activeMs: 0, predicted: 0, dictated: 0 });
  // Hjælpemidler, læreren har slået til for eleven ('ordforslag', 'diktering')
  let aids = [];
  const hasAid = (a) => aids.includes(a);
  // Afvist tekst: sig det venligt – og peg på læreren, hvis eleven bruger et hjælpemiddel
  const AID_TOAST = 'Det kunne ikke sættes ind her. Bruger du et ordblinde-program eller diktering, så sig det til din lærer.';

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

  /* Tekst fra et hjælpemiddel: tæller som skrevet (så teksten kan forklares), men ikke i skrivetempoet */
  function countAid(kind, n) {
    stats.typed += n;
    if (kind) stats[kind] = (stats[kind] || 0) + n;
    allowance += n;
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
  let snapCaret = -1;
  function takeSnap() { snap = toBlocks(); snapLen = textLen(); snapCaret = caretOffset(); allowance = 0; }
  /* Markørens plads som antal tegn fra dokumentets start (så den kan sættes igen, når en ændring rulles tilbage) */
  function caretOffset() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !ed.contains(sel.focusNode)) return -1;
    try {
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.setEnd(sel.focusNode, sel.focusOffset);
      return r.toString().length;
    } catch (e) { return -1; }
  }
  function setCaret(off) {
    if (off < 0) { caretToEnd(); return; }
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n, left = off;
    while ((n = w.nextNode())) {
      if (left <= n.nodeValue.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      left -= n.nodeValue.length;
    }
    caretToEnd();
  }
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
      setCaret(snapCaret);
      toast(AID_TOAST);
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
      if (data.length > max) {
        // Ordforslag (hjælpemiddel): ét ord, der fuldender det, eleven er begyndt at skrive
        if (t === 'insertText' && hasAid('ordforslag') && isPrediction(data)) { lastPrediction = performance.now(); countAid('predicted', data.length); dirty = true; return; }
        e.preventDefault(); stats.pasteBlocked++; toast(AID_TOAST); return;
      }
      // Stavekontrollens forslag (højreklik) erstatter et ord: tæller som tastet, men ikke i tempoet
      if (t === 'insertReplacementText') countAid('', Math.max(1, data.length));
      else countTyped(Math.max(1, data.length));
    } else if (t === 'insertParagraph' || t === 'insertLineBreak') {
      countTyped(1);
    } else if (t === 'historyUndo' || t === 'historyRedo') {
      // Fortryd må kun bringe tekst tilbage, som eleven selv har skrevet og slettet
      undoing = true;
      allowance += Math.max(0, stats.deleted - stats.restored);
    } else if (t.startsWith('delete')) {
      const sel = window.getSelection();
      stats.deleted += Math.max(1, sel && !sel.isCollapsed ? sel.toString().length : 1);
      noteDeleted(t, sel);
    }
    dirty = true;
  });
  /*
   * Ordforslag: højst 30 tegn, ét ord (evt. med mellemrum efter), højst én gang pr. 700 ms – og kun når det fuldender
   * et ord, eleven selv er begyndt på: bogstaver lige før markøren, et markeret ordstykke eller et ordstykke,
   * programmet lige har slettet med tilbage-tasten.
   */
  let lastPrediction = 0, delFrag = '', delAt = 0;
  const WORD_RE = /^[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)* ?$/u;
  function fragBefore(sel) {
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return '';
    const n = sel.anchorNode;
    if (!n || n.nodeType !== 3 || !ed.contains(n)) return '';
    const m = n.nodeValue.slice(0, sel.anchorOffset).match(/[\p{L}\p{N}'’-]*$/u);
    return m ? m[0] : '';
  }
  function noteDeleted(t, sel) {
    if (t !== 'deleteContentBackward' || !sel || !sel.isCollapsed) { delFrag = ''; return; }
    const n = sel.anchorNode;
    const ch = n && n.nodeType === 3 && sel.anchorOffset > 0 ? n.nodeValue.charAt(sel.anchorOffset - 1) : '';
    const now = performance.now();
    delFrag = /[\p{L}\p{N}]/u.test(ch) ? (now - delAt < 1500 ? ch + delFrag : ch) : '';
    delAt = now;
  }
  function isPrediction(data) {
    if (data.length > 30 || !WORD_RE.test(data)) return false;
    if (performance.now() - lastPrediction < 700) return false;
    const word = data.trim().toLocaleLowerCase('da');
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) { const picked = sel.toString().toLocaleLowerCase('da'); return !!picked && word.startsWith(picked); }
    if (fragBefore(sel)) return true;
    const recent = delFrag && performance.now() - delAt < 1500 ? delFrag.toLocaleLowerCase('da') : '';
    return !!recent && word.startsWith(recent);
  }

  page.addEventListener('compositionstart', (e) => { if (e.target === ed) composing = true; });
  page.addEventListener('compositionend', (e) => {
    if (e.target !== ed) return;
    composing = false;
    if (!editable()) return;
    // Døde taster (fx ´ + e) og korte IME-ord er tastet – lange "kompositioner" er ikke.
    // Diktering (hjælpemiddel): højst 300 tegn ad gangen tælles som dikteret (over 10 % giver ikke mærket).
    if (e.data && hasAid('diktering') && e.data.length > 12 && e.data.length <= 300) countAid('dictated', e.data.length);
    else if (e.data) countTyped(Math.min(12, e.data.length));
    checkGrowth();
  });
  page.addEventListener('input', (e) => {
    if (e.target !== ed) return;
    dirty = true;
    if (!composing) checkGrowth();
    updateWords();
    if (doc && doc.practice) practicePreviewSoon();
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
  // Knapperne virker med mus og tastatur (click). mousedown forhindrer kun, at markeringen i teksten forsvinder.
  function format(cmd, value) {
    if (!editable()) return;
    if (document.activeElement !== ed) ed.focus();
    document.execCommand(cmd, false, value || null);
    dirty = true; syncTools();
  }
  document.querySelectorAll('.tools [data-cmd], .tools [data-block]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => (b.dataset.block ? format('formatBlock', b.dataset.block) : format(b.dataset.cmd)));
  });
  // Genveje: Ctrl+Alt+1/2 = overskrift/underoverskrift, Ctrl+Shift+8 = punktopstilling (AltGr-tegn som @ røres ikke)
  page.addEventListener('keydown', (e) => {
    if (e.target !== ed || !e.ctrlKey || e.metaKey || e.getModifierState('AltGraph')) return;
    if (e.altKey && !e.shiftKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); format('formatBlock', e.key === '1' ? 'h1' : 'h2'); }
    else if (e.shiftKey && !e.altKey && e.code === 'Digit8') { e.preventDefault(); format('insertUnorderedList'); }
  });
  function syncTools() {
    for (const c of ['bold', 'italic', 'underline']) {
      const b = document.querySelector(`.tools [data-cmd="${c}"]`);
      try { const on = document.queryCommandState(c); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } catch (e) { /* */ }
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
  // Øvedokumentet kan altid skrives i (det forlader aldrig computeren)
  const editable = () => !!(doc && !doc.submitted && (lessonLive || doc.practice));
  const PRACTICE_TEXT = 'Øvedokument – forlader aldrig denne computer og slettes, når du lukker vinduet.';
  function applyMode() {
    const can = editable();
    const practice = !!(doc && doc.practice);
    ed.contentEditable = can ? 'true' : 'false';
    $('title').disabled = !can;
    $('submit').disabled = !can || practice;
    $('docx').disabled = practice;
    // Klare ord: med et bevis har Word-filen mærket i sidefoden – ellers er det en kopi uden mærke
    const marked = !!(doc && doc.result && doc.result.certId);
    $('docx').textContent = marked ? 'Gem Word-fil med mærket' : 'Gem kopi (uden mærke)';
    $('del').hidden = !(doc && !doc.submitted && !practice);
    const n = $('notice');
    n.classList.toggle('practice', practice);
    if (practice) { n.textContent = PRACTICE_TEXT; n.hidden = false; }
    else if (doc && doc.submitted) { n.textContent = doc.result && doc.result.certId ? `Afsluttet med mærket "${(doc.result.label || labelFor(doc.result.place))}". Dokumentet kan ikke længere ændres – vedhæft det til en aflevering under "Afleveringer".` : 'Afsluttet uden bevis. Dokumentet kan ikke længere ændres. Det er ikke afleveret, før du vedhæfter det under "Afleveringer".'; n.hidden = false; }
    else if (!lessonLive) { n.textContent = 'Du kan skrive her, når din lærer har startet en lektion eller du har startet en skriveøkt.'; n.hidden = false; }
    else n.hidden = true;
    showPreview();
  }
  /*
   * Prøve-vurdering: hvad mangler, hvis eleven afleverer nu (kun kategorier – aldrig tempotal).
   * 'kort' kan rettes og vises neutralt ("Bevis: 34 af 100 ord"). Andre kategorier er permanente for dokumentet.
   */
  const SHORT = { kort: 'for kort', rod: 'rød lampe', forbindelse: 'forbindelse', indsat: 'indsat tekst', tempo: 'skrivetempo', ai: 'AI-spor', hjaelpemiddel: 'diktering' };
  const fixable = (c) => (typeof c.fixable === 'boolean' ? c.fixable : c.key === 'kort');
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const wordsNow = () => { const m = (ed.innerText || '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu); return m ? m.length : 0; };
  const shortText = (c) => `Bevis: ${Math.min(wordsNow(), c.need || 100)} af ${c.need || 100} ord`;
  const lostText = (c) => `Dette dokument kan ikke længere få mærket (${c.at ? 'kl. ' + hhmm(c.at) + ': ' : ''}${c.label || SHORT[c.key] || c.key}). Start et nyt dokument, hvis du vil have mærket.`;
  /** Den vigtigste besked: permanent kategori > hjælpemiddel > for kort */
  function previewLine(cats) {
    const lost = cats.find(c => !fixable(c) && c.key !== 'hjaelpemiddel');
    if (lost) return lostText(lost);
    const aid = cats.find(c => c.key === 'hjaelpemiddel');
    if (aid) return aid.text;
    const kort = cats.find(c => c.key === 'kort');
    return kort ? shortText(kort) : '';
  }
  function showPreview() {
    const el = $('preview');
    const pv = doc && !doc.submitted && (lessonLive || doc.practice) ? doc.preview : null;
    if (!pv) { el.hidden = true; return; }
    const cats = Array.isArray(pv.categories) ? pv.categories : [];
    el.hidden = false;
    if (!cats.length) { el.textContent = doc.practice ? 'Øvedokument: skriveforløbet ser fint ud' : 'Beviset er i orden indtil videre'; el.title = ''; return; }
    el.textContent = previewLine(cats);
    el.title = cats.map(c => (c.key === 'kort' ? shortText(c) : c.text)).join('\n');
  }
  function fillDocs(list) {
    const sel = $('docs');
    sel.replaceChildren(...list.map(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = (d.title || 'Uden titel') + (d.submitted ? (d.certId ? ' ✓' : ' (afsluttet)') : ''); return o; }));
    if (practiceDoc) { const o = document.createElement('option'); o.value = PRACTICE_ID; o.textContent = 'Øvedokument'; sel.prepend(o); }
    if (doc) sel.value = doc.id;
  }
  /* ---------- øvedokument: kun i dette vindues hukommelse – sendes aldrig og gemmes aldrig ---------- */
  const PRACTICE_ID = 'oevedokument';
  let practiceDoc = null;
  function leavePractice() {
    if (!doc || !doc.practice) return;
    doc.blocks = toBlocks(); doc.title = $('title').value; doc.stats = stats;
    dirty = false; // øvedokumentet gemmes aldrig – og må ikke få det næste dokument til at blive gemt
  }
  async function openPractice() {
    await saveNow();
    leavePractice();
    if (!practiceDoc) practiceDoc = { id: PRACTICE_ID, practice: true, title: 'Øvedokument', blocks: [], stats: {}, submitted: 0, preview: null };
    doc = practiceDoc;
    stats = Object.assign(newStats(), doc.stats || {});
    newEditor();
    $('title').value = doc.title;
    fromBlocks(doc.blocks);
    takeSnap();
    $('saved').textContent = '';
    applyMode();
    fillDocs((await window.hmw.state()).docs);
    practicePreview();
    ed.focus();
  }
  /** Lokal prøve-vurdering af øvedokumentet: samme regler som serveren for tekst og tempo (lampen måles ikke her). */
  let practiceT = 0;
  function practicePreviewSoon() { clearTimeout(practiceT); practiceT = setTimeout(practicePreview, 800); }
  function practicePreview() {
    if (!doc || !doc.practice || !window.HMDoc) return;
    const D = window.HMDoc;
    const text = D.normalizeText(D.textOf(toBlocks()));
    const r = D.evaluateStats(text, stats, { aids });
    const order = Object.keys(D.CATEGORY_TEXT);
    const cats = r.cats.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(key => ({ key, text: D.CATEGORY_TEXT[key], fixable: key === 'kort', need: key === 'kort' ? D.PROOF.MIN_WORDS : undefined }));
    doc.preview = { ok: !cats.length, categories: cats };
    showPreview();
  }
  async function open(id) {
    if (id === PRACTICE_ID) { await openPractice(); return; }
    await saveNow();
    const d = await window.hmw.load(id);
    if (!d) return;
    leavePractice();
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
    leavePractice();
    const d = await window.hmw.create(opts);
    await open(d.id);
    ed.focus();
  }
  /** Afleveringens kladde – eller et nyt dokument til den (writer.openForAssignment i hovedprocessen). */
  async function openFor(assignmentId) {
    await saveNow();
    const r = await window.hmw.openFor(assignmentId);
    if (!r || !r.ok) { toast((r && r.error) || 'Kunne ikke åbne afleveringen'); return; }
    await open(r.id);
    ed.focus();
  }

  /* ---------- skrivetime: læreren har valgt en opgave ---------- */
  function setWriteLesson(w) {
    const b = $('write-banner');
    b.hidden = !(w && w.title);
    b.textContent = w && w.title ? `Skrivetime: ${w.title}. Dokumentet afleveres til opgaven, når du trykker "Afslut dokument".` : '';
  }
  window.hmw.onWriteLesson(setWriteLesson);
  // Hovedprocessen har åbnet kladden til skrivetimen (vinduet blinker – fokus tages ikke)
  window.hmw.onOpenDoc((id) => { if (id && (!doc || doc.id !== id)) open(id); });
  $('docs').addEventListener('change', (e) => open(e.target.value));
  $('new').addEventListener('click', () => newDoc());
  $('practice').addEventListener('click', () => openPractice());

  /* ---------- gem ---------- */
  let saving = false;
  async function saveNow() {
    if (!doc || doc.practice || doc.submitted || !dirty || saving) return;
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
  // Mangler beviset, vises årsagerne først: "Annuller" (intet låses) eller "Aflever uden mærke" (låses uden bevis)
  let confirmForce = false;
  function openConfirm(cats) {
    const a = doc && doc.assignmentId && assignments.find(x => x.id === doc.assignmentId);
    $('confirm-asg').hidden = !a;
    if (a) $('confirm-asg').textContent = `Dokumentet bliver derefter afleveret til "${a.title}".`;
    $('confirm-not-handed').hidden = !!a; // uden en skrivetime afleveres teksten ikke af sig selv
    $('confirm-mark').textContent = labels.base;
    const missing = Array.isArray(cats) && cats.length > 0;
    confirmForce = missing;
    $('confirm-title').textContent = missing ? 'Dokumentet får ikke mærket' : 'Afslut dokumentet?';
    $('confirm-text').hidden = missing;
    $('confirm-why').hidden = !missing;
    $('confirm-list').replaceChildren(...(missing ? cats.map(c => li(c.key === 'kort' ? shortText(c) : c.text)) : []));
    if (missing) {
      // Kan alt rettes (kun "for kort"), kan eleven skrive videre. Ellers: start et nyt dokument for at få mærket.
      const lost = cats.find(c => !fixable(c) && c.key !== 'hjaelpemiddel');
      const note = lost ? lostText(lost)
        : cats.every(fixable) ? 'Skriver du videre, kan du stadig få mærket. Afleverer du nu, kan teksten ikke længere ændres, og den får ikke mærket.'
          : 'Afleverer du, kan teksten ikke længere ændres.';
      $('confirm-note').textContent = note;
    }
    $('confirm-no').textContent = 'Annuller';
    $('confirm-yes').textContent = missing ? 'Aflever uden mærke' : 'Afslut';
    $('confirm').showModal();
  }
  $('submit').addEventListener('click', () => {
    if (!editable() || doc.practice) return;
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
      attached = ar.ok ? { title: a.title, receipt: ar.receipt } : null;
      if (!ar.ok) toast('Kunne ikke aflevere til "' + a.title + '": ' + (ar.error || 'ukendt fejl'));
    }
    showResult(r, attached);
  }
  function li(text) { const x = document.createElement('li'); x.textContent = text; return x; }
  function showResult(r, attachedTo) {
    const body = $('r-body');
    body.replaceChildren();
    if (r.certId) {
      $('r-title').textContent = r.label || labelFor(r.place);
      const box = document.createElement('div'); box.className = 'cert';
      const code = document.createElement('div'); code.className = 'code'; code.textContent = 'HM-' + r.certId.slice(0, 8).toUpperCase();
      const p = document.createElement('p'); p.textContent = 'Dokumentet har fået mærket. Det står også i sidefoden, når du gemmer det som Word. Beviset dækker skriveforløbet på computeren – ikke afskrift fra telefon eller papir. Koden og linket kan bruges til at tjekke det.';
      const url = document.createElement('div'); url.className = 'url'; url.textContent = r.url || '';
      box.append(code, p, url);
      body.append(box);
    } else {
      $('r-title').textContent = attachedTo ? 'Afleveret uden bevis' : 'Afsluttet uden bevis';
      const cats = r.categories || [];
      const p = document.createElement('p'); p.textContent = cats.length ? 'Dokumentet fik ikke mærket, fordi:' : 'HolyMoly kunne ikke udstede et bevis for dokumentet.';
      const ul = document.createElement('ul'); ul.className = 'why-list';
      for (const c of cats) ul.append(li(c.text));
      body.append(p, ul);
    }
    $('r-docx').textContent = r.certId ? 'Gem Word-fil med mærket' : 'Gem kopi (uden mærke)';
    // Klare ord: er teksten afleveret til læreren – eller kun afsluttet?
    const p = document.createElement('p');
    if (attachedTo) {
      p.className = 'st-ok';
      const V = window.HMAssignmentsView;
      p.textContent = (V && V.receiptText(attachedTo.receipt)) || `Afleveret til "${attachedTo.title}".`;
    } else p.textContent = 'Dokumentet er afsluttet, men ikke afleveret til din lærer. Aflever det under "Afleveringer".';
    body.append(p);
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
    const all = (await window.hmw.state()).docs;
    const docs = all.filter(d => d.submitted);
    const ul = $('asg-list');
    if (!assignments.length) { ul.replaceChildren(el('li', 'empty', 'Din lærer har ikke lagt nogen afleveringer ud.')); return; }
    ul.replaceChildren(...assignments.map((a) => {
      const li = el('li');
      li.dataset.asg = String(a.id); // word-writer.js sætter "Skriv i Word" ind her
      const late = a.due && Date.now() > a.due && !a.submission;
      li.append(el('div', 'head', null));
      li.firstChild.append(el('span', 't', a.title), el('span', 'meta' + (late ? ' late' : ''), (a.className ? a.className + ' · ' : '') + (a.due ? 'Frist ' + fmtDue(a.due) : 'Ingen frist')));
      if (a.description) li.append(el('div', 'desc', a.description));
      if (a.submission) li.append(el('div', 'st' + (a.submission.certified ? ' ok' : ''), `Afleveret: "${a.submission.title || 'Uden titel'}"` + (a.submission.certified ? ' – ' + labels.base : ' – uden bevis')));
      const row = el('div', 'row');
      const canHome = a.home && !lessonLive && !(a.due && Date.now() > a.due);
      // Har eleven en kladde til afleveringen, fortsætter knappen den (i stedet for et nyt dokument)
      const draft = all.find(d => d.assignmentId === a.id && !d.submitted);
      const write = el('button', 'btn', draft ? `Fortsæt kladde (${draft.words || 0} ord)` : canHome ? 'Skriv hjemme' : 'Skriv besvarelse');
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
        await openFor(a.id);
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

  /* ---------- min lampe (footer) ---------- */
  // Symbol + tekst fra hovedprocessen (writer.lampView). Editoren låses aldrig af lampen eller af en afbrydelse.
  function setLamp(v) {
    const el = $('lamp');
    if (!v) { el.hidden = true; $('lost').hidden = true; return; }
    const text = v.text + (v.homeNote ? ' ' + v.homeNote : '');
    el.className = 'lamp ' + v.color;
    el.querySelector('.lamp-dot').textContent = v.symbol;
    el.querySelector('.lamp-text').textContent = text;
    el.title = text;
    el.hidden = false;
    $('lost').hidden = !v.banner;
  }
  window.hmw.onLamp(setLamp);
  // En afbrudt skriveøkt kunne ikke fortsættes (fx fristen er overskredet): teksten er gemt på computeren
  window.hmw.onSessionEnded((msg) => toast((msg ? msg.replace(/[.\s]+$/, '') + '. ' : '') + 'Teksten er gemt på computeren.'));

  /* ---------- start ---------- */
  /* ---------- visning: tekststørrelse og linjeafstand (kun på skærmen – Word-filen ændres ikke) ---------- */
  let prefs = { size: 16, lh: 'normal' };
  function applyPrefs(p) {
    if (p && typeof p === 'object') prefs = Object.assign({}, prefs, p);
    const size = Math.min(24, Math.max(14, Number(prefs.size) || 16));
    page.style.setProperty('--ed-size', size + 'px');
    page.style.setProperty('--ed-lh', prefs.lh === 'luftig' ? '2.1' : '1.6');
    $('size-val').textContent = size + ' px';
    $('size-down').disabled = size <= 14;
    $('size-up').disabled = size >= 24;
    document.querySelectorAll('#view-panel [data-lh]').forEach(b => b.setAttribute('aria-pressed', b.dataset.lh === (prefs.lh === 'luftig' ? 'luftig' : 'normal') ? 'true' : 'false'));
  }
  async function setPrefs(p) {
    applyPrefs(p);
    if (window.hmw.setPrefs) applyPrefs(await window.hmw.setPrefs(p));
  }
  function toggleView(open) {
    const panel = $('view-panel');
    const show = open == null ? panel.hidden : !!open;
    panel.hidden = !show;
    $('view-btn').setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) ($('size-up').disabled ? $('size-down') : $('size-up')).focus();
  }
  $('view-btn').addEventListener('click', () => toggleView());
  $('view-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleView(false); $('view-btn').focus(); } });
  document.addEventListener('mousedown', (e) => { if (!$('view-panel').hidden && !e.target.closest('.view-wrap')) toggleView(false); });
  $('size-down').addEventListener('click', () => setPrefs({ size: (Number(prefs.size) || 16) - 2 }));
  $('size-up').addEventListener('click', () => setPrefs({ size: (Number(prefs.size) || 16) + 2 }));
  document.querySelectorAll('#view-panel [data-lh]').forEach(b => b.addEventListener('click', () => setPrefs({ lh: b.dataset.lh })));
  if (window.hmw.onPrefs) window.hmw.onPrefs(applyPrefs);
  // Skærmlæsere får gemt-status og prøve-vurdering at vide (uden at flytte fokus)
  for (const id of ['saved', 'preview']) { $(id).setAttribute('role', 'status'); $(id).setAttribute('aria-live', 'polite'); }
  if (window.hmw.onAids) window.hmw.onAids((list) => { aids = Array.isArray(list) ? list : []; if (doc && doc.practice) practicePreview(); });

  window.hmw.onLesson((live) => { lessonLive = !!live; applyMode(); });
  (async () => {
    const s = await window.hmw.state();
    lessonLive = s.lesson;
    if (s.labels) labels = s.labels;
    if (Array.isArray(s.aids)) aids = s.aids;
    applyPrefs(s.prefs);
    setWriteLesson(s.writeLesson);
    const first = (s.openId && s.docs.find(d => d.id === s.openId)) || s.docs[0];
    if (first) await open(first.id); else await newDoc();
    applyMode();
  })();
})();
