'use strict';
// "Skriv i Word": serveren behandler Word-gemninger (source: 'word') med samme pipeline som skrivevinduet.
// Tastetryk-tjek springes over, observed bliver ['word'] (+ 'vagt'), og mærket hedder "Tastet i Word via HolyMoly".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');
const D = require('../shared/doc.js');

const SENT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. ';
const green = { color: 'green', violations: [] };
const meta = { studentName: 'Anna Jensen', className: '2.g Dansk', issuer: 'https://holymoly.test' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-word-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g Dansk', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1)").run();
  return { dir, docs: new DocStore(db, dir), anna: { id: 1, class_id: 1 } };
}
// Word sender ét afsnit pr. blok og ingen tastestatistik
const paras = (text) => text.split('\n').map(x => ({ t: 'p', r: [{ x }] }));

/** Skriv i Word: et snapshot hvert 3. sek. med menneskeligt tempo (ca. 8 tegn/sek.). */
function writeWord(docs, student, fullText, { start = 1_000_000, stats = {}, id = crypto.randomUUID(), step = 24, view = () => green } = {}) {
  let t = start;
  assert.ok(docs.save(student, { id, title: 'Romantikken', blocks: [], stats, source: 'word' }, view(t), 1, t).ok, 'det tomme dokument');
  for (let n = step; ; n += step) {
    t += 3000;
    const text = fullText.slice(0, Math.min(n, fullText.length));
    const r = docs.save(student, { id, title: 'Romantikken', blocks: paras(text), stats, source: 'word' }, view(t), 1, t);
    assert.ok(r.ok, r.error);
    if (n >= fullText.length) break;
  }
  return { id, t };
}

test('Word: et ærligt skriveforløb uden tastestatistik giver et bevis med observed ["word"] og Word-mærket', () => {
  const { dir, docs, anna } = setup();
  try {
    const text = SENT.repeat(9).trim();
    const { id, t } = writeWord(docs, anna, text);
    const r = docs.submit(anna, id, Object.assign({ observed: ['skrivevindue'] }, meta), t + 1000);
    assert.ok(r.ok && r.certId, JSON.stringify(r.reasons));
    assert.deepStrictEqual(r.observed, ['word']);
    const c = docs.certificate(r.certId);
    assert.strictEqual(c.valid, true);
    assert.deepStrictEqual(c.payload.observed, ['word']);
    assert.strictEqual(c.payload.checks[0], 'Skrevet i Word gennem HolyMoly – ingen tekst indsat fra andre programmer');
    assert.ok(c.payload.checks.includes('Teksten voksede i et menneskeligt tempo'));
    assert.strictEqual(c.payload.sha256, crypto.createHash('sha256').update(D.normalizeText(text), 'utf8').digest('hex'));
    assert.strictEqual(D.label(r.facts.place, { observed: r.observed }), '✓ Tastet i Word via HolyMoly – intet indsat · i timen · kun Word');
    assert.strictEqual(docs.full(id).source, 'word');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: med vagten bliver observed ["word", "vagt"], og mærket er grønt', () => {
  const { dir, docs, anna } = setup();
  try {
    const { id, t } = writeWord(docs, anna, SENT.repeat(9).trim());
    const r = docs.submit(anna, id, Object.assign({ observed: ['skrivevindue', 'vagt'] }, meta), t + 1000);
    assert.deepStrictEqual(r.observed, ['word', 'vagt']);
    assert.strictEqual(D.label('hjemme', { observed: r.observed }), '✓ Tastet i Word via HolyMoly – intet indsat · hjemme');
    assert.strictEqual(D.markGreen({ observed: r.observed }), true);
    assert.ok(docs.certificate(r.certId).payload.checks.includes('HolyMoly-vagten blokerede AI på computeren'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: indsat tekst (meldt af appen eller set af serveren), AI-fraser og rød lampe giver intet bevis', () => {
  const { dir, docs, anna } = setup();
  try {
    // Appen så et spring fra et andet program (pasteInserted)
    let w = writeWord(docs, anna, SENT.repeat(9).trim(), { stats: { pasteInserted: 1, pasteBlocked: 2 } });
    let ev = docs.evaluate(docs.q.get.get(w.id));
    assert.deepStrictEqual(ev.categories.map(c => c.key), ['indsat']);
    assert.ok(ev.reasons.includes('Der er indsat tekst fra et andet program i Word'));
    assert.ok(ev.notes.some(n => /Udklipsholderen blev tømt 2 gange/.test(n)), ev.notes.join());

    // Serverens eget vækstbudget: 600 tegn på 3 sek.
    const id = crypto.randomUUID();
    assert.ok(docs.save(anna, { id, title: 'X', blocks: [], source: 'word' }, green, 1, 1_000_000).ok);
    assert.ok(docs.save(anna, { id, title: 'X', blocks: paras(SENT.repeat(8)), source: 'word' }, green, 1, 1_003_000).ok);
    ev = docs.evaluate(docs.q.get.get(id));
    assert.ok(ev.categories.some(c => c.key === 'indsat'), JSON.stringify(ev.reasons));
    assert.match(ev.reasons.join(), /Tekst indsat for hurtigt/);

    // AI-frase
    w = writeWord(docs, anna, SENT.repeat(8) + 'As an AI language model I cannot do that.');
    assert.ok(docs.evaluate(docs.q.get.get(w.id)).categories.some(c => c.key === 'ai'));

    // Rød lampe undervejs
    w = writeWord(docs, anna, SENT.repeat(9).trim(), { view: (t) => (t > 1_010_000 && t < 1_020_000 ? { color: 'red', violations: [{ text: 'ChatGPT åben' }] } : green) });
    assert.ok(docs.evaluate(docs.q.get.get(w.id)).categories.some(c => c.key === 'rod'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: Copilot slået til giver intet bevis; ukendt Copilot-status er kun en note', () => {
  const { dir, docs, anna } = setup();
  try {
    let w = writeWord(docs, anna, SENT.repeat(9).trim(), { stats: { copilot: 'on' } });
    let ev = docs.evaluate(docs.q.get.get(w.id));
    assert.deepStrictEqual(ev.categories.map(c => c.key), ['ai']);
    w = writeWord(docs, anna, SENT.repeat(9).trim(), { stats: { copilot: 'unknown' } });
    ev = docs.evaluate(docs.q.get.get(w.id));
    assert.strictEqual(ev.ok, true);
    assert.ok(ev.notes.some(n => /Copilot/.test(n)));
    // Skrivevinduet kender ikke Copilot-feltet
    assert.strictEqual(DocStore.cleanStats({ copilot: 'måske' }).copilot, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: tastetryk-tjekkene springes over, men skrivevinduet har dem stadig', () => {
  const { dir, docs, anna } = setup();
  try {
    // Ingen typed/keystrokes og en "umulig" maxCps fra en falsk klient: tæller ikke i Word
    const w = writeWord(docs, anna, SENT.repeat(9).trim(), { stats: { maxCps: 80, burst: 200, keystrokes: 500, fastShare: 0.9, regularity: 0.01 } });
    assert.deepStrictEqual(docs.evaluate(docs.q.get.get(w.id)).reasons, []);
    // Samme tal i skrivevinduet giver afslag
    const id = crypto.randomUUID();
    let t = 1_000_000;
    const text = SENT.repeat(9).trim();
    for (let n = 24; ; n += 24) {
      const x = text.slice(0, n);
      assert.ok(docs.save(anna, { id, title: 'Y', blocks: paras(x), stats: { maxCps: 80, typed: 0 } }, green, 1, t).ok);
      t += 3000;
      if (n >= text.length) break;
    }
    const keys = docs.evaluate(docs.q.get.get(id)).categories.map(c => c.key);
    assert.ok(keys.includes('indsat') && keys.includes('tempo'), keys.join());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: et dokument kan ikke skifte mellem skrivevinduet og Word', () => {
  const { dir, docs, anna } = setup();
  try {
    const a = crypto.randomUUID();
    assert.ok(docs.save(anna, { id: a, title: 'A', blocks: [] }, green, 1, 1000).ok);
    assert.match(docs.save(anna, { id: a, title: 'A', blocks: [], source: 'word' }, green, 1, 5000).error, /skrevet i HolyMoly/);
    const b = crypto.randomUUID();
    assert.ok(docs.save(anna, { id: b, title: 'B', blocks: [], source: 'word' }, green, 1, 1000).ok);
    assert.match(docs.save(anna, { id: b, title: 'B', blocks: [] }, green, 1, 5000).error, /kun fortsættes i Word/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word: hele vejen gennem serveren (doc med source word -> doc-submit -> bevis -> vedhæft til aflevering)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-word-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 5 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const asg = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil om romantikken' });
    const ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Windows', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ag.send(JSON.stringify({ type: 'status', activity: 'Word', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const text = 'Ja nej mor far bil hus kat'; // under 30 tegn: serverens vækstbudget for 2 sek.
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Romantikken', blocks: [], stats: {}, source: 'word' }));
    assert.strictEqual((await wait(m => m.type === 'doc-saved')).ok, true);
    await new Promise(r => setTimeout(r, 1600)); // serverens 1,5 sek. mellem gemninger
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Romantikken', blocks: paras(text), stats: {}, source: 'word', assignmentId: asg.id }));
    const res = await wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));
    assert.deepStrictEqual(res.observed, ['word']);
    const pub = await (await fetch(base + '/api/bevis/' + res.certId)).json();
    assert.deepStrictEqual(pub.payload.observed, ['word']);
    assert.strictEqual(pub.payload.sha256, crypto.createHash('sha256').update(D.normalizeText(text)).digest('hex'));
    // Vedhæft til afleveringen (samme besked som skrivevinduet)
    ag.send(JSON.stringify({ type: 'assignment-attach', assignmentId: asg.id, docId: id }));
    const at = await wait(m => m.type === 'assignment-result');
    assert.strictEqual(at.ok, true, at.error);
    const alerts = await call('GET', `/api/students/${en.studentId}/events?kind=alerts&limit=10&before=${Date.now() + 1000}`);
    assert.match(alerts.events.map(e => e.title).join(), /Tastet i Word via HolyMoly/);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mærket og sidefoden: Word-mærket, "kun Word" og de samme sidefodslinjer i toDocx', () => {
  assert.strictEqual(D.label('lektion', { observed: ['word', 'vagt'] }), '✓ Tastet i Word via HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.label('lektion', { observed: ['skrivevindue'] }), '✓ Tastet i HolyMoly – intet indsat · i timen · kun skrivevinduet');
  const mark = { code: 'HM-ABCD1234', url: 'https://holymoly.test/bevis/abcd', place: 'lektion', observed: ['word'], test: true };
  let lines = D.footerLines(mark, 120);
  assert.deepStrictEqual(lines, [
    '✓ Tastet i Word via HolyMoly – intet indsat · i timen · kun Word · TESTSERVER',
    'HolyMoly HM-ABCD1234  ·  Tjek: https://holymoly.test/bevis/abcd',
    D.LIMIT_TEXT + ' 120 ord.',
    D.TEST_TEXT,
  ]);
  assert.deepStrictEqual(D.footerLines(null, 1), []);
  // toDocx bruger de samme linjer (Hej verden = 2 ord)
  lines = D.footerLines(mark, 2);
  const footer = Buffer.from(D.toDocx([{ t: 'p', r: [{ x: 'Hej verden' }] }], { mark })).toString('utf8');
  for (const l of lines) assert.ok(footer.includes(l.replace(/&/g, '&amp;')), l);
});

/* ---------------------------------------------------------------- Word med tastetryk (stats.keys) ---------------------------------------------------------------- */
// Tal fra Word-appens tastetæller: kun kategorier og tider – aldrig hvilke taster
const keyStats = (len, extra = {}) => Object.assign({ keys: true, typed: len, deleted: 0, restored: 0, pasteKeys: 0, injected: 0, undo: 0, keystrokes: len, maxCps: 7.2, burst: 11, fastShare: 0.01, regularity: 0.62, untyped: 0 }, extra);

test('Word med tastetryk: ærlig skrivning med autokorrektur består, og beviset siger, at teksten passer med tastetrykkene', () => {
  const { dir, docs, anna } = setup();
  try {
    const text = D.normalizeText(SENT.repeat(9).trim());
    // Autokorrektur og autoformat: 2 % mere tekst end tastetryk (inden for margenen på 3 %), og en del slettet og fortrudt
    const stats = keyStats(Math.round(text.length * 0.98) - 40, { deleted: 60, restored: 100, undo: 3, pasteKeys: 2 });
    const { id, t } = writeWord(docs, anna, text, { stats });
    const ev = docs.evaluate(docs.q.get.get(id));
    assert.deepStrictEqual(ev.reasons, []);
    assert.strictEqual(ev.facts.keys, true);
    assert.ok(!ev.notes.some(n => /Tastetryk kan ikke tælles/.test(n)), ev.notes.join());
    const r = docs.submit(anna, id, Object.assign({ observed: ['skrivevindue'] }, meta), t + 1000);
    assert.ok(r.ok && r.certId, JSON.stringify(r.reasons));
    const c = docs.certificate(r.certId);
    assert.ok(c.payload.checks.includes('Teksten passer med tastetrykkene i Word'), c.payload.checks.join());
    assert.ok(c.payload.checks.includes('Menneskeligt skrivetempo'));
    assert.ok(!c.payload.checks.includes('Teksten voksede i et menneskeligt tempo'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word med tastetryk: tekst uden tastetryk (Copilot, diktering) giver "indsat" med Word-teksten', () => {
  const { dir, docs, anna } = setup();
  try {
    const text = SENT.repeat(9).trim();
    // Eleven tastede en kort prompt – resten kom i menneskeligt tempo, men uden tastetryk (serverens vækstbudget ser intet)
    const w = writeWord(docs, anna, text, { stats: keyStats(120) });
    const ev = docs.evaluate(docs.q.get.get(w.id));
    assert.deepStrictEqual(ev.categories.map(c => c.key), ['indsat']);
    assert.ok(ev.reasons.includes(D.WORD_UNTYPED), ev.reasons.join());
    assert.strictEqual(ev.categories[0].text, 'Der er kommet tekst i Word, som ikke er tastet (fx indsat, Copilot, diktering eller autotekst).');
    // Lige over margenen (3 % eller 20 tegn) fejler, lige under består
    const len = D.normalizeText(text).length;
    const margin = D.wordKeyMargin(len);
    assert.strictEqual(margin, Math.ceil(len * 0.03));
    assert.strictEqual(D.evaluateStats(text, keyStats(len - margin), { word: true, minWords: 5 }).found.length, 0);
    assert.deepStrictEqual(D.evaluateStats(text, keyStats(len - margin - 1), { word: true, minWords: 5 }).cats, ['indsat']);
    assert.strictEqual(D.wordKeyMargin(100), 20, 'korte tekster: mindst 20 tegn');
    // Appen så det undervejs (muldvarpen blev rød), selv om tallene til sidst passer
    assert.deepStrictEqual(D.evaluateStats(text, keyStats(len, { untyped: 1 }), { word: true, minWords: 5 }).cats, ['indsat']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word med tastetryk: Ctrl+V og et spring, der ikke er tastet, giver "indsat"; Ctrl+V af egen tekst gør ikke', () => {
  const text = SENT.repeat(9).trim();
  const len = D.normalizeText(text).length;
  let r = D.evaluateStats(text, keyStats(len - 300, { pasteKeys: 1 }), { word: true, minWords: 5 });
  assert.deepStrictEqual(r.cats, ['indsat']);
  assert.ok(r.reasons.some(x => /Ctrl\+V \(1 gange\)/.test(x)), r.reasons.join());
  // Eleven kopierede sit eget afsnit (restored): Ctrl+V er ingen sag
  r = D.evaluateStats(text, keyStats(len - 300, { pasteKeys: 3, restored: 300 }), { word: true, minWords: 5 });
  assert.deepStrictEqual(r.found, []);
});

test('Word med tastetryk: taster sendt af et program (injected) giver "tempo" – med hjælpemidler kun en note', () => {
  const text = SENT.repeat(9).trim();
  const len = D.normalizeText(text).length;
  let r = D.evaluateStats(text, keyStats(len, { injected: 21 }), { word: true, minWords: 5 });
  assert.deepStrictEqual(r.cats, ['tempo']);
  assert.ok(r.reasons.some(x => /^Taster sendt af et program/.test(x)));
  assert.deepStrictEqual(D.evaluateStats(text, keyStats(len, { injected: 20 }), { word: true, minWords: 5 }).found, []);
  r = D.evaluateStats(text, keyStats(len, { injected: 400 }), { word: true, minWords: 5, aids: ['ordforslag'] });
  assert.deepStrictEqual(r.found, []);
  assert.ok(r.notes.some(x => /Taster sendt af et program.*hjælpemidler/.test(x)), r.notes.join());
  // Samme tempo-tjek som skrivevinduet
  r = D.evaluateStats(text, keyStats(len, { maxCps: 40, keystrokes: 500, fastShare: 0.5, regularity: 0.05 }), { word: true, minWords: 5 });
  assert.deepStrictEqual(r.cats, ['tempo']);
  assert.strictEqual(r.found.length, 3);
});

test('Word med tastetryk: Copilot slået til er kun en note – uden tastetryk er det stadig et afslag', () => {
  const { dir, docs, anna } = setup();
  try {
    const text = SENT.repeat(9).trim();
    let w = writeWord(docs, anna, text, { stats: keyStats(D.normalizeText(text).length, { copilot: 'on' }) });
    let ev = docs.evaluate(docs.q.get.get(w.id));
    assert.strictEqual(ev.ok, true, ev.reasons.join());
    assert.ok(ev.notes.some(n => /Words AI \(Copilot\) er slået til – bruger du den, får teksten ikke mærket/.test(n)), ev.notes.join());
    // keys: false (appen kunne ikke tælle) følger de gamle regler: Copilot 'on' = afslag, og en note om tastetryk
    w = writeWord(docs, anna, text, { stats: { keys: false, typed: 0, copilot: 'on' } });
    ev = docs.evaluate(docs.q.get.get(w.id));
    assert.deepStrictEqual(ev.categories.map(c => c.key), ['ai']);
    assert.ok(ev.notes.some(n => /^Tastetryk kan ikke tælles på denne computer/.test(n)), ev.notes.join());
    assert.strictEqual(ev.facts.keys, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Word uden tastetryk (keys: null/false): de gamle regler – ingen tastetjek, typed 0 er ingen sag', () => {
  const { dir, docs, anna } = setup();
  try {
    const w = writeWord(docs, anna, SENT.repeat(9).trim(), { stats: { keys: false, typed: 0, maxCps: 80, injected: 500, untyped: 3 } });
    const ev = docs.evaluate(docs.q.get.get(w.id));
    assert.deepStrictEqual(ev.reasons, []);
    // cleanStats: keys er kun sand, når appen siger true
    assert.strictEqual(DocStore.cleanStats({ keys: 'ja' }).keys, false);
    assert.strictEqual(DocStore.cleanStats({ keys: true, pasteKeys: -1, injected: 'x' }).keys, true);
    assert.deepStrictEqual([DocStore.cleanStats({ pasteKeys: -1 }).pasteKeys, DocStore.cleanStats({ injected: 'x' }).injected], [0, 0]);
    // Skrivevinduet er uændret: typed 0 giver stadig afslag
    assert.deepStrictEqual(D.evaluateStats(SENT.repeat(9), { typed: 0 }, { minWords: 5 }).cats, ['indsat']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
