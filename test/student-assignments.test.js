'use strict';
// Elevens afleveringsside i hovedvinduet: logikken (agent/src/assignments-view.js), ipc'en (agent/src/verified.js)
// og "Skriv verificeret aflevering" i main.js. Electron er erstattet af en lille attrap (som i writer-lesson.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const V = require('../agent/src/assignments-view.js');

const H = 3600_000;
const NOW = new Date(2026, 10, 25, 10, 14).getTime();
const MARK = '\u2713 Tastet i HolyMoly \u2013 intet indsat';

test('afleveringer deles som lærerens side: Åbne (tidligste frist først, uden frist sidst) og passerede (nyeste først)', () => {
  const list = [
    { id: 1, title: 'Uden frist', due: 0 },
    { id: 2, title: 'Om en uge', due: NOW + 7 * 24 * H },
    { id: 3, title: 'I morgen', due: NOW + 24 * H },
    { id: 4, title: 'I går', due: NOW - 24 * H, submission: { docId: 'x', certified: true } },
    { id: 5, title: 'For en uge siden', due: NOW - 7 * 24 * H },
    { id: 0, title: 'Ugyldig' }, null,
  ];
  const g = V.split(list, NOW);
  assert.deepStrictEqual(g.open.map(a => a.id), [3, 2, 1]);
  assert.deepStrictEqual(g.past.map(a => a.id), [4, 5]);
  assert.strictEqual(g.pastTitle, 'Fristen er overskredet');
  assert.strictEqual(g.missing, 4);
  // Fristen netop nu: passeret
  assert.strictEqual(V.isPast({ due: NOW }, NOW), true);
  // Har eleven afleveret alle de passerede, hedder kortet 'Afleveret'
  assert.strictEqual(V.split([{ id: 4, due: NOW - H, submission: { docId: 'x' } }], NOW).pastTitle, 'Afleveret');
  assert.deepStrictEqual(V.split(undefined, NOW), { open: [], past: [], pastTitle: 'Fristen er overskredet', missing: 0 });
});

test('status pr. række: Mangler, Afleveret ✓ {mærke}, Afleveret uden mærke og Fristen er overskredet (neutral)', () => {
  assert.deepStrictEqual(V.status({ id: 1, due: NOW + H }, NOW), { key: 'missing', text: 'Mangler', tone: 'todo' });
  assert.deepStrictEqual(V.status({ id: 1 }, NOW), { key: 'missing', text: 'Mangler', tone: 'todo' });
  const done = V.status({ id: 1, submission: { docId: 'd', certified: true, label: MARK + ' \u00b7 hjemme' } }, NOW);
  assert.deepStrictEqual(done, { key: 'done', text: 'Afleveret \u2713 Tastet i HolyMoly \u2013 intet indsat \u00b7 hjemme', tone: 'ok' });
  // Ukendt mærke (dokumentet ligger på en anden computer): grundmærket
  assert.strictEqual(V.status({ id: 1, submission: { docId: 'd', certified: true } }, NOW).text, 'Afleveret \u2713 Tastet i HolyMoly \u2013 intet indsat');
  assert.deepStrictEqual(V.status({ id: 1, due: NOW - H, submission: { docId: 'd', certified: false } }, NOW), { key: 'done-unmarked', text: 'Afleveret uden mærke', tone: 'neutral' });
  const late = V.status({ id: 1, due: NOW - H }, NOW);
  assert.deepStrictEqual(late, { key: 'late', text: 'Fristen er overskredet', tone: 'neutral' });
  assert.notStrictEqual(late.tone, 'bad', 'aldrig rød');
  assert.strictEqual(V.where({ className: '2.g Dansk', home: true }), '2.g Dansk · må skrives hjemme');
  assert.strictEqual(V.where({ className: '2.g Dansk', home: false }), '2.g Dansk · skrives i timen');
  assert.strictEqual(V.where({ home: false }), 'Skrives i timen');
});

test('dokumenter: kun med mærke under Verificerede afleveringer, manglende felter og Word-filer håndteres', () => {
  const docs = [
    { id: 'a', title: 'Gammel', certId: 'c1', label: MARK, submitted: NOW - 48 * H, words: 300 },
    { id: 'b', title: 'Ny', certId: 'c2', submitted: NOW - H },
    { id: 'c', title: 'Uden mærke', submitted: NOW - 2 * H, words: 120 },
    { id: 'd', title: 'Kladde', words: 40, updated: NOW },
    { id: 'w', title: 'Kronik', certId: 'c3', label: MARK + ' · hjemme', path: 'C:\\Elev\\Kronik.docx', submitted: NOW - 3 * H },
    { id: 'w2', title: 'Word uden sti', certId: 'c4', source: 'word', submitted: NOW - 4 * H },
    { id: 'a', title: 'Dublet' }, {}, null,
  ];
  const v = V.verified(docs);
  assert.deepStrictEqual(v.map(d => d.id), ['b', 'w', 'w2', 'a'], 'kun mærkede, nyeste først, ingen dubletter');
  const b = v.find(d => d.id === 'b');
  assert.strictEqual(b.words, 0);
  assert.strictEqual(b.label, MARK, 'manglende mærketekst: grundmærket');
  assert.deepStrictEqual([b.source, b.canOpen, b.canDocx], ['holymoly', true, true]);
  const w = v.find(d => d.id === 'w');
  assert.deepStrictEqual([w.source, w.path, w.canOpen, w.canDocx], ['word', 'C:\\Elev\\Kronik.docx', true, false], 'Word: Vis i mappe, ingen Hent Word-fil');
  assert.strictEqual(v.find(d => d.id === 'w2').canOpen, false, 'Word-dokument uden sti kan ikke vises i mappe');
  assert.strictEqual(V.normalizeDocs(docs).find(d => d.id === 'd').date, NOW, 'dato: afleveret, ellers ændret, ellers oprettet');
  assert.deepStrictEqual(V.verified(undefined), []);
});

test('Aflever: afsluttede dokumenter, mærkede for sig; dokumenter afleveret til en anden aflevering vises ikke', () => {
  const docs = [
    { id: 'm1', title: 'Mærket', certId: 'c1', submitted: NOW - 3 * H },
    { id: 'm2', title: 'Til opgaven', certId: 'c2', submitted: NOW - 5 * H, assignmentId: 7 },
    { id: 'm3', title: 'Brugt andetsteds', certId: 'c3', submitted: NOW - H },
    { id: 'u1', title: 'Uden mærke', submitted: NOW - H },
    { id: 'k', title: 'Kladde', certId: '', submitted: 0 },
  ];
  const asg = [{ id: 7, submission: { docId: 'm1' } }, { id: 8, submission: { docId: 'm3' } }];
  const r = V.forAttach(docs, asg, 7);
  assert.deepStrictEqual(r.marked.map(d => d.id), ['m2', 'm1'], 'dokumentet skrevet til afleveringen først; det nuværende kan vælges igen');
  assert.deepStrictEqual(r.unmarked.map(d => d.id), ['u1']);
  assert.strictEqual(V.UNMARKED_NOTE, 'Afleveringer uden mærke er ikke bevis for snyd.');
  // Resultatet
  assert.deepStrictEqual(V.attachResult({ ok: true }, NOW), { ok: true, text: 'Afleveret kl. 10.14' });
  assert.deepStrictEqual(V.attachResult({ ok: false, error: 'Dokumentet er allerede afleveret til en anden aflevering' }, NOW),
    { ok: false, text: 'Dokumentet er allerede afleveret til en anden aflevering' });
  assert.strictEqual(V.attachResult(null, NOW).ok, false);
  assert.strictEqual(V.fmtDue(new Date(2026, 10, 26, 9, 5).getTime()), 'tors. 26. nov. kl. 09.05');
  assert.strictEqual(V.fmtDue(0), '–');
  assert.strictEqual(V.fmtDate(NOW), '25. nov. 2026');
});

test('Skriv verificeret aflevering: kun åbne afleveringer; uden for timen kun dem, der må skrives hjemme', () => {
  const list = [
    { id: 1, title: 'Hjemme', className: '2.g', home: true, due: NOW + H },
    { id: 2, title: 'I timen', className: '2.g', home: false, due: NOW + 2 * H },
    { id: 3, title: 'Overskredet', home: true, due: NOW - H },
  ];
  const out = V.writable(list, { lesson: false, now: NOW });
  assert.deepStrictEqual(out.map(a => [a.id, a.canWrite]), [[1, true], [2, false]]);
  assert.strictEqual(out[1].why, 'Skrives i timen, når din lærer har startet en lektion');
  assert.ok(V.writable(list, { lesson: true, now: NOW }).every(a => a.canWrite));
});

/* ---------- ipc i hovedprocessen ---------- */

function loadAll() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-verified-'));
  const handlers = new Map();
  const wins = [];
  const saves = [];
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.calls = []; this.sent = []; this.visible = opts.show !== false; this.destroyed = false;
      this.webContents = { send: (ch, v) => this.sent.push([ch, v]), once() {}, on() {}, setWindowOpenHandler() {}, session: { setSpellCheckerLanguages() {} } };
      wins.push(this);
    }
    removeMenu() {} loadFile() {} on() {} once() {}
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    show() { this.calls.push('show'); } focus() { this.calls.push('focus'); } showInactive() {} flashFrame() {}
  }
  const dialog = { showSaveDialog: async (parent, o) => { saves.push({ parent, o }); return { canceled: false, filePath: path.join(dir, 'ud.docx') }; } };
  const electron = { app: { getPath: () => dir, isPackaged: true }, BrowserWindow, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, dialog };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  const file = require.resolve('../agent/src/writer.js');
  delete require.cache[file];
  let Writer;
  try { ({ Writer } = require(file)); } finally { Module._load = orig; }
  const sent = [];
  let online = true;
  const w = new Writer({ send: (m) => { if (!online) return false; sent.push(m); return true; }, lessonActive: () => false, serverUrl: 'https://holymoly.test', studentName: () => 'Anna' });
  w.onMessage({ type: 'assignments', items: [
    { id: 7, title: 'Novelleanalyse', className: '2.g Dansk', due: NOW + 24 * H, home: true },
    { id: 8, title: 'Digtanalyse', className: '2.g Dansk', due: NOW - H, submission: { docId: 'd2', title: 'Digt', submitted: NOW - 2 * H, certified: true } },
  ] });
  const doc = (id, extra) => Object.assign({ id, title: id, blocks: [{ t: 'p', r: [{ x: 'Et to tre fire fem' }] }], stats: {}, created: NOW - 5 * H, updated: NOW - 4 * H, submitted: 0, result: null, assignmentId: 0 }, extra);
  w.docs = [
    doc('d1', { submitted: NOW - 3 * H, result: { certId: 'aaaa1111bbbb', place: 'hjemme', observed: ['skrivevindue', 'vagt'] }, assignmentId: 7 }),
    doc('d2', { submitted: NOW - 2 * H, result: { certId: 'cccc2222dddd', place: 'lektion', observed: ['skrivevindue'] }, assignmentId: 8 }),
    doc('d3', { submitted: NOW - H, result: { certId: null } }),
    doc('d4'),
    doc('w1', { submitted: NOW - H, result: { certId: 'eeee3333ffff', place: 'hjemme' }, path: '/home/elev/Kronik.docx', source: 'word' }),
  ];
  const shown = [];
  const pages = [];
  const writes = [];
  const verified = require('../agent/src/verified.js');
  const mainWin = { id: 'hovedvindue' };
  verified.register({
    ipcMain: electron.ipcMain, shell: { showItemInFolder: (p) => shown.push(p) }, lessonActive: () => false,
    getWriter: () => w, getWin: () => mainWin,
    startWriting: async (aid) => { writes.push(aid); return aid === 99 ? { ok: false, error: 'Afleveringen findes ikke' } : { ok: true }; },
    onPage: (open) => pages.push(open),
  });
  return { w, handlers, wins, sent, saves, shown, pages, writes, mainWin, dir, setOnline: (v) => { online = v; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('verified:overview og verified:list: afleveringer med mærket på det afleverede og kun mærkede dokumenter', async () => {
  const t = loadAll();
  try {
    const o = await t.handlers.get('verified:overview')();
    assert.strictEqual(o.lesson, false);
    const a8 = o.assignments.find(a => a.id === 8);
    assert.strictEqual(a8.submission.label, MARK + ' \u00b7 i timen \u00b7 kun skrivevinduet', 'mærket fra det lokale dokument');
    assert.strictEqual(V.status(a8, NOW).text, 'Afleveret \u2713 Tastet i HolyMoly \u2013 intet indsat \u00b7 i timen \u00b7 kun skrivevinduet');
    assert.strictEqual(o.assignments.find(a => a.id === 7).submission, null);
    assert.ok(o.docs.some(d => d.id === 'd4'), 'kladder er med i overblikket (sorteres fra under Aflever)');
    assert.strictEqual(t.w.assignments[1].submission.label, undefined, 'writerens egne data ændres ikke');

    const list = await t.handlers.get('verified:list')();
    assert.deepStrictEqual(list.map(d => d.id), ['w1', 'd2', 'd1']);
    assert.strictEqual(list.find(d => d.id === 'd1').label, MARK + ' \u00b7 hjemme');
    assert.strictEqual(list.find(d => d.id === 'd1').words, 5);
    assert.strictEqual(list.find(d => d.id === 'w1').source, 'word');

    // Word-delen kan levere sine egne dokumenter (writer.verifiedDocs) – de flettes ind efter id
    t.w.verifiedDocs = () => [{ id: 'x9', title: 'Fra Word', certId: 'w9', submitted: NOW, path: '/tmp/x.docx' }, { id: 'd1', title: 'Dublet' }];
    const list2 = await t.handlers.get('verified:list')();
    assert.deepStrictEqual(list2.map(d => d.id), ['x9', 'w1', 'd2', 'd1']);
  } finally { t.cleanup(); }
});

test('verified:attach går samme vej som skrivevinduets afleveringsdialog (assignment-attach → assignment-result)', async () => {
  const t = loadAll();
  try {
    const attach = t.handlers.get('verified:attach');
    const p = attach(null, { assignmentId: 7, docId: 'd1' });
    assert.deepStrictEqual(t.sent.pop(), { type: 'assignment-attach', assignmentId: 7, docId: 'd1' });
    t.w.onMessage({ type: 'assignment-result', assignmentId: 7, ok: true });
    const r = await p;
    assert.strictEqual(r.ok, true);
    assert.ok(r.at > 0);
    // Serverens fejltekst kommer frem til eleven
    const p2 = attach(null, { assignmentId: 7, docId: 'd2' });
    t.w.onMessage({ type: 'assignment-result', assignmentId: 7, ok: false, error: 'Dokumentet er allerede afleveret til en anden aflevering' });
    assert.deepStrictEqual((await p2).error, 'Dokumentet er allerede afleveret til en anden aflevering');
    // Skrivevinduets egen handler bruger samme metode
    const p3 = t.handlers.get('write:attach')(null, { assignmentId: 7, docId: 'd3' });
    assert.deepStrictEqual(t.sent.pop(), { type: 'assignment-attach', assignmentId: 7, docId: 'd3' });
    t.w.onMessage({ type: 'assignment-result', assignmentId: 7, ok: true });
    assert.strictEqual((await p3).ok, true);
    // Lokale tjek
    assert.strictEqual((await attach(null, { assignmentId: 7, docId: 'd4' })).error, 'Afslut dokumentet først');
    assert.strictEqual((await attach(null, { assignmentId: 99, docId: 'd1' })).error, 'Afleveringen findes ikke');
    assert.strictEqual((await attach(null, { assignmentId: 7, docId: '' })).error, 'Vælg et dokument');
    t.setOnline(false);
    assert.strictEqual((await attach(null, { assignmentId: 7, docId: 'd1' })).error, 'Ingen forbindelse til HolyMoly-serveren');
    // Word-delen kan overtage vedhæftningen af sine egne dokumenter
    t.w.attachVerified = async (aid, docId) => ({ ok: aid === 7 && docId === 'x9' });
    assert.strictEqual((await attach(null, { assignmentId: 7, docId: 'x9' })).ok, true);
  } finally { t.cleanup(); }
});

test('verified:open, verified:docx, verified:write og verified:page', async () => {
  const t = loadAll();
  try {
    // HolyMoly-dokument: skrivevinduet åbnes med dokumentet
    assert.deepStrictEqual(await t.handlers.get('verified:open')(null, 'd1'), { ok: true, id: 'd1' });
    assert.strictEqual(t.wins.length, 1);
    assert.strictEqual(t.handlers.get('write:state')().openId, 'd1');
    // Vinduet er åbent: det får besked om at åbne dokumentet
    await t.handlers.get('verified:open')(null, 'd2');
    assert.deepStrictEqual(t.wins[0].sent.pop(), ['write:open-doc', 'd2']);
    // Word-dokument: vis i mappe
    assert.deepStrictEqual(await t.handlers.get('verified:open')(null, 'w1'), { ok: true });
    assert.deepStrictEqual(t.shown, ['/home/elev/Kronik.docx']);
    assert.strictEqual((await t.handlers.get('verified:open')(null, 'findes-ikke')).ok, false);

    // Hent Word-fil: gemmedialogen hører til hovedvinduet, og filen har mærket
    const r = await t.handlers.get('verified:docx')(null, 'd1');
    assert.deepStrictEqual(r, { ok: true, name: 'ud.docx' });
    assert.strictEqual(t.saves[0].parent, t.mainWin);
    assert.ok(fs.statSync(path.join(t.dir, 'ud.docx')).size > 500);

    assert.deepStrictEqual(await t.handlers.get('verified:write')(null, { assignmentId: 7 }), { ok: true, error: '' });
    assert.deepStrictEqual(await t.handlers.get('verified:write')(null, { assignmentId: 99 }), { ok: false, error: 'Afleveringen findes ikke' });
    assert.deepStrictEqual(t.writes, [7, 99]);
    await t.handlers.get('verified:page')(null, true);
    await t.handlers.get('verified:page')(null, false);
    assert.deepStrictEqual(t.pages, [true, false]);
  } finally { t.cleanup(); }
});

/* ---------- main.js: "Skriv verificeret aflevering" ---------- */

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
function startVerifiedWriting(writer, lesson) {
  const m = /async function startVerifiedWriting\(aid\) \{[\s\S]*?\n\}\n/.exec(MAIN);
  assert.ok(m, 'main.js har startVerifiedWriting');
  // eslint-disable-next-line no-new-func
  return new Function('writer', 'lessonActive', `${m[0]}; return startVerifiedWriting;`)(writer, () => lesson);
}
function fakeWriter() {
  const calls = [];
  return {
    calls,
    assignments: [{ id: 7, title: 'Novelleanalyse', home: true }, { id: 8, title: 'Digtanalyse', home: false }],
    open: () => calls.push(['open']),
    openForAssignment: (aid, o) => calls.push(['openForAssignment', aid, o.title]),
    session: async (aid, on) => { calls.push(['session', aid, on]); return aid === 7 ? { ok: true } : { ok: false, error: 'nej' }; },
  };
}

test('main.js: startVerified fra Word-delen bruges, ellers HolyMolys eget skrivevindue', async () => {
  // Word-delen har startVerified: den kaldes og intet andet
  const w0 = fakeWriter();
  w0.startVerified = async (aid) => { w0.calls.push(['startVerified', aid]); return { ok: true }; };
  assert.deepStrictEqual(await startVerifiedWriting(w0, false)(7), { ok: true });
  assert.deepStrictEqual(w0.calls, [['startVerified', 7]]);

  // I timen: afleveringen åbnes direkte
  const w1 = fakeWriter();
  assert.deepStrictEqual(await startVerifiedWriting(w1, true)(8), { ok: true });
  assert.deepStrictEqual(w1.calls, [['openForAssignment', 8, 'Digtanalyse']]);
  // Uden aflevering: skrivevinduet
  assert.deepStrictEqual(await startVerifiedWriting(w1, true)(0), { ok: true });
  assert.deepStrictEqual(w1.calls.pop(), ['open']);

  // Hjemme: først en skriveøkt, så afleveringen
  const w2 = fakeWriter();
  assert.deepStrictEqual(await startVerifiedWriting(w2, false)(7), { ok: true });
  assert.deepStrictEqual(w2.calls, [['session', 7, true], ['openForAssignment', 7, 'Novelleanalyse']]);
  // Skrives i timen: ingen skriveøkt hjemme
  const r = await startVerifiedWriting(w2, false)(8);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /skrives i timen/);
  assert.strictEqual((await startVerifiedWriting(w2, false)(42)).error, 'Afleveringen findes ikke');
  assert.strictEqual((await startVerifiedWriting(null, false)(7)).ok, false);
});

test('hovedvinduet: afleveringssiden er indlæst, og tabellerne og dialogerne er tilgængelige', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', 'index.html'), 'utf8');
  for (const s of ['afleveringer.css', '../src/assignments-view.js', 'afleveringer.js']) assert.ok(html.includes(s), s);
  assert.ok(html.indexOf('assignments-view.js') < html.indexOf('afleveringer.js"'), 'logikken indlæses før siden');
  assert.match(html, /<h2 id="afl-open-h">Åbne<\/h2>\s*<div class="afl-actions">\s*<button class="btn primary" id="afl-write" type="button">Skriv verificeret aflevering<\/button>\s*<button class="btn" id="afl-verified" type="button">Verificerede afleveringer<\/button>/);
  assert.strictEqual((html.match(/<table class="afl-table"/g) || []).length, 2);
  assert.strictEqual((html.match(/<caption/g) || []).length, 2);
  for (const id of ['afl-pick', 'afl-docs', 'afl-attach']) assert.match(html, new RegExp(`<dialog id="${id}"`));
  assert.ok(html.includes('Vis også dokumenter uden mærke'));
  assert.ok(html.includes('Afleveringer uden mærke er ikke bevis for snyd.'));
  assert.ok(html.includes('Afleveres efter fristen.'));
  assert.ok((html.match(/aria-live="polite"/g) || []).length >= 4);
  const pre = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'preload.js'), 'utf8');
  for (const ch of ['overview', 'list', 'write', 'attach', 'open', 'docx', 'page']) assert.ok(pre.includes(`'verified:${ch}'`), ch);
  assert.match(MAIN, /verified\.register\(/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', 'afleveringer.js'), 'utf8');
  assert.ok(js.includes("$('assign-btn').addEventListener('click', openPage)"), "'Du har N afleveringer' åbner siden");
});
