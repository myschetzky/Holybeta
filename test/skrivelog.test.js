'use strict';
// Skrivelogen: hvordan en afleveret tekst blev skrevet – indsatte udsnit, rettelser, flytninger, skrivning pr. minut,
// lampeskift og skriveøkter (server/src/docs.js _planLog/log, GET /api/docs/:id/log og server/public/skrivelog.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dbm = require('../server/src/db.js');
const RET = require('../server/src/retention.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');

const green = { color: 'green', violations: [] };
const meta = { studentName: 'Anna Jensen', className: '2.g Dansk', teacherName: 'Mette', issuer: 'https://holymoly.test' };
// Varieret tekst (ingen gentagelser), så intet stykke findes to steder
const TEXT = [
  'Romantikken var en periode i kunsten, hvor følelser og natur fik en stor plads.',
  'Digterne søgte det guddommelige i landskabet og i barndommens uskyld.',
  'Oehlenschläger skrev Guldhornene i 1802 efter et langt møde med Steffens.',
  'Senere kom guldalderen med Heiberg, Andersen og Kierkegaard som store navne.',
  'Mange værker handler om længsel efter noget, der ligger uden for hverdagen.',
  'Naturen bliver et spejl for sjælen, og havet og skoven får symbolsk betydning.',
].join(' ');
const PASTE = 'Kilde fra nettet: Den romantiske bevægelse opstod i Tyskland omkring år 1800 som en reaktion mod oplysningstidens fornuftsdyrkelse og den industrielle revolutions materialisme, og den bredte sig hurtigt til resten af Europa.';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-slog-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g Dansk', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1)").run();
  const done = () => { try { db.close(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } };
  return { dir, db, docs: new DocStore(db, dir), anna: { id: 1, class_id: 1 }, done };
}
const blocksOf = (text, word) => (word ? text.split('\n').map(x => ({ t: 'p', r: [{ x }] })) : [{ t: 'h1', r: [{ x: 'Romantikken' }] }, { t: 'p', r: [{ x: text }] }]);
const typedStats = (text, extra) => Object.assign({ typed: Math.round(text.length * 1.15) + 12, deleted: Math.round(text.length * 0.1), keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 }, extra || {});

/** Gem én version. Returnerer svaret fra save(). */
function save(docs, student, id, text, t, opts = {}) {
  const r = docs.save(student, Object.assign({ id, title: 'Romantikken', blocks: blocksOf(text, opts.word), stats: opts.stats || typedStats(text) }, opts.word ? { source: 'word' } : {}), opts.view || green, opts.lesson || 1, t);
  assert.ok(r.ok, r.error);
  return r;
}
/** Skriv en tekst i et menneskeligt tempo: step tegn hvert 5. sek. Returnerer tidspunktet for sidste gemning. */
function type(docs, student, id, text, { start = 1_000_000, from = 0, step = 30, word = false, view, lesson } = {}) {
  let t = start;
  for (let n = Math.min(text.length, from + step); ; n = Math.min(text.length, n + step)) {
    save(docs, student, id, text.slice(0, n), t, { word, view: view ? view(t) : green, stats: word ? {} : undefined, lesson });
    if (n >= text.length) break;
    t += 5000;
  }
  return t;
}
const kinds = (log) => log.events.map(e => e.kind);

test('skrivelog: tastet tekst giver skrivning pr. minut – intet indsat, intet flyttet', () => {
  const { db, docs, anna, done } = setup();
  try {
    const id = crypto.randomUUID();
    const end = type(docs, anna, id, TEXT);
    // En lille rettelse (under 20 tegn) er almindelig skrivning
    const fixed = TEXT.replace('stor plads', 'plads');
    save(docs, anna, id, fixed, end + 5000);
    assert.ok(docs.submit(anna, id, Object.assign({ force: true }, meta), end + 60_000).ok);
    const log = docs.log(id);
    assert.ok(!kinds(log).includes('indsat'), JSON.stringify(log.events));
    assert.ok(!kinds(log).includes('flyttet'));
    assert.ok(!kinds(log).includes('rettelse'));
    assert.deepStrictEqual(log.pastes, []);
    // Skrivning samlet i én række pr. minut
    const rows = db.prepare("SELECT ts FROM doc_events WHERE doc_id = ? AND kind = 'skrivning'").all(id);
    const minutes = new Set(rows.map(r => Math.floor(r.ts / 60_000)));
    assert.strictEqual(rows.length, minutes.size, 'én række pr. minut');
    const added = log.events.filter(e => e.kind === 'skrivning').reduce((a, e) => a + e.detail.added, 0);
    assert.strictEqual(added, ('Romantikken\n' + TEXT).length, 'alt tastet tæller (også overskriften)');
    assert.strictEqual(log.events.filter(e => e.kind === 'skrivning').reduce((a, e) => a + e.detail.removed, 0), 'stor '.length);
    // Opsummering
    const s = log.summary;
    assert.strictEqual(s.sessions, 1);
    assert.strictEqual(s.pastes, 0);
    assert.strictEqual(s.corrections, 0);
    assert.strictEqual(s.source, 'holymoly');
    assert.ok(s.typed > 0 && s.words > 50 && s.minutesWriting >= 1);
    assert.deepStrictEqual([kinds(log)[0], kinds(log).slice(-2)].flat(), ['start', 'slut', 'afleveret']);
  } finally { done(); }
});

test('skrivelog: et indsat stykke over vækstbudgettet logges med selve teksten', () => {
  const { docs, anna, done } = setup();
  try {
    const id = crypto.randomUUID();
    const start = TEXT.slice(0, 120);
    const end = type(docs, anna, id, start);
    // 200+ tegn på 6 sek.: vækst-flag ("indsat for hurtigt")
    const r = save(docs, anna, id, start + ' ' + PASTE, end + 6000);
    assert.ok(r.doc.monitor.includes('indsat for hurtigt'));
    // … og et meget langt stykke afkortes til 2.000 tegn
    const long = Array.from({ length: 40 }, (_, i) => `Afsnit ${i} med tekst om emnet nummer ${i * 7}, der ikke er skrevet her.`).join(' ');
    save(docs, anna, id, start + ' ' + PASTE + ' ' + long, end + 12_000);
    docs.submit(anna, id, Object.assign({ force: true }, meta), end + 60_000);
    const log = docs.log(id);
    assert.strictEqual(log.pastes.length, 2, JSON.stringify(log.events.map(e => e.kind)));
    assert.strictEqual(log.pastes[0].excerpt, PASTE);
    assert.strictEqual(log.pastes[0].chars, PASTE.length);
    assert.strictEqual(log.pastes[0].reason, 'hurtigt');
    assert.strictEqual(log.pastes[0].ts, end + 6000);
    assert.strictEqual(log.pastes[1].excerpt.length, 2001);
    assert.ok(log.pastes[1].excerpt.endsWith('…'));
    assert.strictEqual(log.pastes[1].chars, long.length);
    assert.strictEqual(log.summary.pastes, 2);
    assert.strictEqual(log.summary.pastedChars, PASTE.length + long.length);
    // Det indsatte tæller ikke som skrivning
    assert.strictEqual(log.events.filter(e => e.kind === 'skrivning').reduce((a, e) => a + e.detail.added, 0), 'Romantikken\n'.length + start.length);

    // Første gemning med for meget tekst (budget 150 tegn): 'start'
    const pre = crypto.randomUUID();
    save(docs, anna, pre, TEXT.slice(0, 300), 3_000_000);
    assert.strictEqual(docs.log(pre).pastes[0].reason, 'start');
    // Elev-appen melder indsat tekst (pasteInserted), selv om budgettet holder
    const app = crypto.randomUUID();
    const e2 = type(docs, anna, app, TEXT.slice(0, 90), { start: 4_000_000 });
    save(docs, anna, app, TEXT.slice(0, 90) + ' Kopieret sætning fra en anden fil på computeren.', e2 + 60_000, { stats: typedStats(TEXT, { pasteInserted: 1 }) });
    assert.deepStrictEqual(docs.log(app).pastes.map(p => [p.reason, p.excerpt]), [['paste', 'Kopieret sætning fra en anden fil på computeren.']]);
  } finally { done(); }
});

test('skrivelog: en rettelse logges med det fjernede, en flytning af egen tekst uden tekst', () => {
  const { docs, anna, done } = setup();
  try {
    const id = crypto.randomUUID();
    let t = type(docs, anna, id, TEXT);
    // Sætning slettet
    const gone = 'Digterne søgte det guddommelige i landskabet og i barndommens uskyld.';
    const without = TEXT.replace(gone + ' ', '');
    save(docs, anna, id, without, t += 5000);
    // Ord erstattet med et andet (over 20 tegn fjernet)
    const replaced = without.replace('efter et langt møde med Steffens', 'efter en lang nat');
    save(docs, anna, id, replaced, t += 5000);
    // Fortryd: den slettede sætning kommer tilbage (skrivevinduet melder restored)
    save(docs, anna, id, replaced.replace('uskyld.', 'uskyld.').replace('plads. ', 'plads. ' + gone + ' '), t += 5000, { stats: typedStats(TEXT, { restored: gone.length + 1 }) });
    docs.submit(anna, id, Object.assign({ force: true }, meta), t + 60_000);
    const log = docs.log(id);
    const fixes = log.events.filter(e => e.kind === 'rettelse');
    assert.deepStrictEqual(fixes.map(e => e.excerpt), [gone, 'et langt møde med Steffens.']);
    assert.strictEqual(fixes[1].detail.replaced, 'en lang nat.'.length);
    const moved = log.events.filter(e => e.kind === 'flyttet');
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(moved[0].chars, gone.length);
    assert.strictEqual(moved[0].excerpt, undefined, 'flyttet tekst gemmes ikke');
    assert.strictEqual(log.summary.corrections, 2);
    assert.strictEqual(log.summary.moves, 1);
    assert.strictEqual(log.summary.pastes, 0);
  } finally { done(); }
});

test('skrivelog: Word-dokument – spring, flyttet afsnit og et afsnit sat ind over et andet', () => {
  const { db, docs, anna, done } = setup();
  try {
    const paras = ['Romantikken i Danmark begyndte omkring år 1800 med en ny interesse for naturen.', 'Oehlenschläger og Grundtvig var blandt de første, der skrev i den nye stil.', 'Guldalderen bragte både maleri, digtning og filosofi i blomst i København.'];
    const id = crypto.randomUUID();
    const text = paras.join('\n');
    let t = type(docs, anna, id, text, { word: true, step: 20 });
    // Første afsnit flyttes til sidst (klip og sæt ind i Word): flyttet, ingen rettelse
    const movedText = [paras[1], paras[2], paras[0]].join('\n');
    save(docs, anna, id, movedText, t += 3000, { word: true, stats: {} });
    // Et afsnit erstattes af en anden tekst af samme længde (ingen vækst – men stykket er nyt): indsat (word) + rettelse
    const other = 'Denne tekst kom fra et helt andet sted og blev sat ind over et afsnit.';
    save(docs, anna, id, [paras[1], other, paras[0]].join('\n'), t += 3000, { word: true, stats: {} });
    // Spring: 200 nye tegn på 3 sek. (vækst-flag)
    save(docs, anna, id, [paras[1], other, paras[0], PASTE].join('\n'), t += 3000, { word: true, stats: {} });
    docs.submit(anna, id, Object.assign({ force: true }, meta), t + 60_000);
    const log = docs.log(id);
    assert.strictEqual(log.summary.source, 'word');
    assert.strictEqual(log.summary.typed, undefined, 'ingen tastestatistik fra Word');
    assert.deepStrictEqual(log.events.filter(e => e.kind === 'flyttet').map(e => e.chars), [paras[0].length]);
    assert.deepStrictEqual(log.pastes.map(p => [p.reason, p.excerpt]), [['word', other], ['hurtigt', PASTE]]);
    assert.deepStrictEqual(log.events.filter(e => e.kind === 'rettelse').map(e => e.excerpt), [paras[2]]);
    // Et Word-dokument kan ikke fortsættes i skrivevinduet (og logges ikke)
    const n = db.prepare('SELECT COUNT(*) AS n FROM doc_events WHERE doc_id = ?').get(id).n;
    assert.strictEqual(docs.save(anna, { id, title: 'x', blocks: blocksOf('x'), stats: {} }, green, 1, t + 70_000).ok, false);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM doc_events WHERE doc_id = ?').get(id).n, n);
  } finally { done(); }
});

test('skrivelog: lampeskift og skriveøkter', () => {
  const { db, docs, anna, done } = setup();
  try {
    db.prepare("INSERT INTO lessons (id, class_id, started, ends_at, kind, student_id) VALUES (1, 1, 0, 0, 'klasse', NULL), (2, 1, 0, 0, 'hjemme', 1)").run();
    const id = crypto.randomUUID();
    const red = { color: 'red', violations: [{ text: 'AI / chatbots: chatgpt.com', category: 'ai' }] };
    let t = type(docs, anna, id, TEXT.slice(0, 150), { view: (x) => (x >= 1_010_000 && x < 1_020_000 ? red : green) });
    // Rød mellem to gemninger (serveren målte den selv)
    docs.observe(id, { color: 'red', violations: [{ text: 'Video: youtube.com', category: 'video' }] }, t + 2000);
    docs.observe(id, green, t + 4000);
    save(docs, anna, id, TEXT.slice(0, 170), t += 5000);
    // Ny skriveøkt hjemme dagen efter
    docs.pause(id);
    const last = type(docs, anna, id, TEXT, { start: t + 86_400_000, from: 170, lesson: 2 });
    docs.submit(anna, id, Object.assign({ force: true }, meta), last + 1000);
    const log = docs.log(id);
    const lamps = log.events.filter(e => e.kind === 'lampe').map(e => [e.detail.color, e.detail.why || '', !!e.detail.between]);
    assert.deepStrictEqual(lamps, [['red', 'AI / chatbots: chatgpt.com', false], ['green', '', false], ['red', 'Video: youtube.com', true]]);
    assert.strictEqual(log.summary.sessions, 2);
    const starts = log.events.filter(e => e.kind === 'start');
    assert.deepStrictEqual(starts.map(e => e.detail && e.detail.place), ['lektion', 'hjemme']);
    assert.strictEqual(log.events.filter(e => e.kind === 'slut').length, 2);
    assert.ok(!JSON.stringify(log).includes('"lesson"'), 'lektionens id sendes ikke');
  } finally { done(); }
});

test('skrivelog: slettes med afspilningen (frist) og med dokumentet', () => {
  const { db, docs, anna, done } = setup();
  try {
    const DAY = RET.DAY;
    const t0 = 1_700_000_000_000;
    const count = (id) => db.prepare('SELECT COUNT(*) AS n FROM doc_events WHERE doc_id = ?').get(id).n;
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
    type(docs, anna, a, TEXT, { start: t0 });
    docs.submit(anna, a, Object.assign({ force: true }, meta), t0 + 600_000);
    type(docs, anna, b, TEXT.slice(0, 100), { start: t0 });
    type(docs, anna, c, TEXT.slice(0, 100), { start: t0 + 59 * DAY });
    assert.ok(count(a) > 0 && count(b) > 0 && count(c) > 0);
    const R = RET.fromEnv({}, {});
    const p = RET.purge(db, R, t0 + 61 * DAY);
    assert.ok(p.events > 0, JSON.stringify(p));
    assert.strictEqual(count(a), 0, 'afleveret: skrivelogen følger afspilningen');
    assert.strictEqual(count(b), 0, 'gammel kladde slettet: skrivelogen med');
    assert.ok(count(c) > 0, 'ny kladde bliver');
    // Efter fristen: opsummeringen siger, at loggen er slettet
    assert.strictEqual(docs.log(a).summary.expired, true);
    // Kladden slettes af eleven: skrivelogen med
    assert.ok(docs.deleteDraft(c, anna.id).ok);
    assert.strictEqual(count(c), 0);
    // Uden fremmednøgler (gamle databaser): triggeren rydder op
    const d = crypto.randomUUID();
    type(docs, anna, d, TEXT.slice(0, 100), { start: t0 + 60 * DAY });
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM documents WHERE id = ?').run(d);
    db.exec('PRAGMA foreign_keys = ON');
    assert.strictEqual(count(d), 0);
  } finally { done(); }
});

test('skrivelog: diff-hjælperen holder et indsat afsnit samlet', () => {
  const { docs, anna, done } = setup();
  try {
    // Et afsnit sat ind over en sætning: ét indsat stykke (ikke delt ved fælles ord som "og" eller mellemrum)
    const id = crypto.randomUUID();
    const base = 'Første afsnit handler om naturen og om følelserne.\nAndet afsnit er kort og godt.\nTredje afsnit slutter teksten af.';
    const t = type(docs, anna, id, base, { start: 5_000_000, step: 25 });
    const pasted = 'Et nyt og langt afsnit om romantikken og naturen og følelserne, som er kommet ind på én gang fra et andet sted.';
    save(docs, anna, id, base.replace('Andet afsnit er kort og godt.', pasted), t + 3000, { stats: typedStats(base, { pasteInserted: 1 }) });
    const log = docs.log(id);
    assert.deepStrictEqual(log.pastes.map(p => p.excerpt), [pasted]);
    assert.deepStrictEqual(log.events.filter(e => e.kind === 'rettelse').map(e => e.excerpt), ['Andet afsnit er kort og godt.']);
  } finally { done(); }
});

test('GET /api/docs/:id/log: kun lærerens egne elever og kun afleverede dokumenter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-slog-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
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
    const anna = { id: en.studentId, class_id: cls.id };
    const id = crypto.randomUUID();
    const now = Date.now() - 600_000;
    const t = type(srv.docs, anna, id, TEXT.slice(0, 100), { start: now });
    save(srv.docs, anna, id, TEXT.slice(0, 100) + ' ' + PASTE, t + 5000);
    // Kladde: 409 (samme regel som afspilningen)
    const draft = await call('GET', `/api/docs/${id}/log`);
    assert.strictEqual(draft._status, 409);
    assert.ok(!JSON.stringify(draft).includes('Kilde fra nettet'));
    srv.docs.submit(anna, id, Object.assign({ force: true }, meta), t + 10_000);
    const log = await call('GET', `/api/docs/${id}/log`);
    assert.strictEqual(log._status, 200);
    assert.deepStrictEqual(Object.keys(log.summary).sort(), ['corrections', 'deleted', 'minutesWriting', 'moves', 'pastedChars', 'pastes', 'sessions', 'source', 'started', 'submitted', 'typed', 'words'].sort());
    assert.strictEqual(log.pastes[0].excerpt, PASTE);
    assert.strictEqual(log.events[log.events.length - 1].kind, 'afleveret', 'nyeste sidst');
    // Ukendt dokument og en anden lærer: 404
    assert.strictEqual((await call('GET', `/api/docs/${crypto.randomUUID()}/log`))._status, 404);
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('GET', `/api/docs/${id}/log`))._status, 404);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- dashboardet (server/public/skrivelog.js og app.js) ---------------- */
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');

/** Kører skrivelog.js med en lille falsk DOM (h som i app.js). */
function slogModule() {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(pub('skrivelog.js'), { window, Date });
  const h = (tag, attrs, ...kids) => {
    const el = { tag, attrs: attrs || {}, kids: kids.flat().filter(k => k != null && k !== false) };
    el.append = (...k) => el.kids.push(...k.flat().filter(x => x != null));
    return el;
  };
  const text = (n) => (n == null ? '' : typeof n === 'string' ? n : (n.attrs.text || '') + n.kids.map(text).join(''));
  const find = (n, f, out = []) => { if (n && typeof n === 'object') { if (f(n)) out.push(n); n.kids.forEach(k => find(k, f, out)); } return out; };
  return { S: window.HM.skrivelog, h, text, find };
}

test('dashboardet: skrivelogen tegnes med opsummering, indsatte udsnit, diagram og forløb', () => {
  const { S, h, text, find } = slogModule();
  const t0 = new Date(2026, 10, 25, 10, 2).getTime();
  assert.strictEqual(S.duration(134), '2 t 14 min');
  assert.strictEqual(S.duration(45), '45 min');
  assert.strictEqual(S.summaryText({ sessions: 3, minutesWriting: 134, words: 1240, pastes: 2, pastedChars: 318, corrections: 14 }),
    'Skrevet over 3 skriveøkter · 2 t 14 min · 1.240 ord · 2 indsatte udsnit (318 tegn) · 14 rettelser');
  assert.strictEqual(S.summaryText({ sessions: 1, minutesWriting: 20, words: 1, pastes: 0, corrections: 1, moves: 1 }),
    'Skrevet i 1 skriveøkt · 20 min · 1 ord · ingen indsatte udsnit · 1 rettelse · 1 flytning');
  const log = {
    summary: { started: t0, submitted: t0 + 3600_000, minutesWriting: 40, sessions: 1, words: 320, typed: 1900, deleted: 200, pastes: 1, pastedChars: PASTE.length, corrections: 1, moves: 1, source: 'holymoly' },
    events: [
      { ts: t0, kind: 'start', chars: 0, detail: { place: 'lektion' } },
      { ts: t0, kind: 'skrivning', chars: 120, detail: { added: 120, removed: 4 } },
      { ts: t0 + 60_000, kind: 'skrivning', chars: 80, detail: { added: 80, removed: 0 } },
      { ts: t0 + 125_000, kind: 'indsat', chars: PASTE.length, excerpt: PASTE, detail: { reason: 'hurtigt' } },
      { ts: t0 + 180_000, kind: 'rettelse', chars: 26, excerpt: 'et langt møde med Steffens', detail: { replaced: 11 } },
      { ts: t0 + 200_000, kind: 'flyttet', chars: 70 },
      { ts: t0 + 240_000, kind: 'lampe', chars: 0, detail: { color: 'red', why: 'AI / chatbots: chatgpt.com' } },
      { ts: t0 + 300_000, kind: 'slut', chars: 0 },
      { ts: t0 + 3600_000, kind: 'afleveret', chars: 0 },
    ],
    pastes: [{ ts: t0 + 125_000, chars: PASTE.length, excerpt: PASTE, reason: 'hurtigt' }],
  };
  const seeks = [];
  const root = S.render({ h }, log, { seek: (ts) => seeks.push(ts) });
  const all = text(root);
  assert.match(all, /Skrevet i 1 skriveøkt · 40 min · 320 ord · 1 indsat udsnit \(\d+ tegn\) · 1 rettelse · 1 flytning/);
  assert.match(all, /Indsatte udsnit er ikke i sig selv bevis for snyd – tal med eleven\./);
  // Overskrifter: Skrivelog, Indsatte udsnit, Forløb
  assert.deepStrictEqual(find(root, n => /^h[3-4]$/.test(n.tag)).map(text), ['Skrivelog', 'Indsatte udsnit', 'Forløb']);
  // Det indsatte udsnit: klokkeslæt, selve teksten i en boks og "Vis i afspilningen"
  const quote = find(root, n => n.attrs.class === 'slog-paste');
  assert.strictEqual(quote.length, 1);
  assert.strictEqual(text(quote[0]), PASTE);
  assert.match(all, /kl\. 10\.04 · \d+ tegn · Kom ind hurtigere, end man kan taste/);
  const btn = find(root, n => n.tag === 'button' && text(n) === 'Vis i afspilningen');
  btn[0].attrs.onclick();
  assert.deepStrictEqual(seeks, [t0 + 125_000]);
  // Diagrammet har en tekst (aria-label) og en tabel
  const chart = find(root, n => n.attrs.class === 'slog-chart')[0];
  assert.strictEqual(chart.attrs.role, 'img');
  assert.match(chart.attrs['aria-label'], /Skrivning pr\. minut fra kl\. 10\.02 til 10\.07: 200 tegn skrevet, højst 120 tegn på et minut/);
  assert.strictEqual(find(chart, n => n.attrs.class === 'slog-bar').length, 6);
  const table = find(root, n => n.tag === 'table')[0];
  assert.deepStrictEqual(find(table, n => n.tag === 'tr').map(r => r.kids.map(text).join('|')), ['Kl.|Skrevet|Slettet|Indsat', '10.02|120|4|', '10.03|80|0|', '10.04|0|0|' + PASTE.length]);
  // Forløbet: rettelse (fold ud med det fjernede), flytning, lampeskift, slut og aflevering
  const ev = find(root, n => n.attrs.class === 'slog-events')[0];
  const lines = ev.kids.map(text);
  assert.ok(lines.some(l => /Rettelse: 26 tegn fjernet og erstattet med 11 tegn/.test(l) && l.includes('et langt møde med Steffens')));
  assert.ok(find(ev, n => n.tag === 'details').length === 1);
  assert.ok(lines.some(l => /70 tegn flyttet eller kopieret/.test(l)));
  assert.ok(lines.some(l => /Rød lampe: AI \/ chatbots: chatgpt\.com/.test(l)));
  assert.ok(lines.some(l => /Skriveøkten slutter/.test(l)) && lines.some(l => /Afleveret/.test(l)));
  assert.match(all, /i timen/);
  // Word og en skrivelog, der er slettet efter fristen
  assert.match(text(S.render({ h }, { summary: { source: 'word', sessions: 1, words: 0, pastes: 0, corrections: 0 }, events: [], pastes: [] })), /uden at være skrevet i Word/);
  assert.match(text(S.render({ h }, { summary: { expired: true }, events: [], pastes: [] })), /slettet efter skolens frist/);
});

test('dashboardet: knappen Skrivelog i dokumentvisningen og ved afleveringerne', () => {
  const src = pub('app.js');
  assert.match(pub('index.html'), /<script src="\/skrivelog\.js"><\/script>/);
  assert.match(src, /api\(`\/api\/docs\/\$\{docId\}\/log`\)/);
  assert.match(src, /window\.HM\.skrivelog\.render\(\{ h \}, log/);
  assert.match(src, /const logBtn = d\.submitted \? logButton\(docId, logSec, replay\) : null;/, 'kun afleverede dokumenter');
  assert.match(src, /text: 'Skrivelog', 'aria-label': `Skrivelog for \$\{s\.name\}`/);
  assert.match(src, /el\.seek = \(ts\) =>/, 'afspilningen kan springe til et tidspunkt');
  // Den statiske demo får også skrivelog.js
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-pages.js'), 'utf8'), /skrivelog\.js/);
});

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* */ }
test('dashboardet i en browser: Skrivelog i elevens dokument og i afleveringen, "Vis i afspilningen"', { skip: !chromium && 'Playwright findes ikke', timeout: 90_000 }, async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return; }
  let AXE = null;
  try { AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [path.join(__dirname, '..')] }), 'utf8'); } catch (e) { /* axe-core er valgfri */ }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-slog-ui-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: !!AXE });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + '/forside');
    const cls = await p.evaluate(async () => {
      try { localStorage.setItem('hm-intro-seen', '1'); } catch (e) { /* */ }
      const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
      await post('/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
      const c = await post('/api/classes', { name: '2.g Dansk' });
      const a = await post(`/api/classes/${c.id}/assignments`, { title: 'Romantikken' });
      return { id: c.id, joinCode: c.joinCode, asg: a.id };
    });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const anna = { id: en.studentId, class_id: cls.id };
    const id = crypto.randomUUID();
    const t0 = Date.now() - 3600_000;
    const t = type(srv.docs, anna, id, TEXT, { start: t0 });
    save(srv.docs, anna, id, TEXT + ' ' + PASTE, t + 6000);
    save(srv.docs, anna, id, (TEXT + ' ' + PASTE).replace('Digterne søgte det guddommelige i landskabet og i barndommens uskyld. ', ''), t + 30_000);
    assert.ok(srv.docs.submit(anna, id, Object.assign({ force: true }, meta), t + 60_000).ok);
    srv.db.prepare('INSERT INTO assignment_submissions (assignment_id, student_id, doc_id, submitted) VALUES (?,?,?,?)').run(cls.asg, anna.id, id, t + 60_000);

    const axe = async (sel) => {
      if (!AXE) return;
      await p.addScriptTag({ content: AXE });
      const v = await p.evaluate(async (sel) => (await axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), sel);
      assert.deepStrictEqual(v, [], sel);
    };

    // 1) Elevens dokument i skuffen
    await p.goto(`${base}/klasse/${cls.id}`);
    await p.click('.desk');
    await p.click('[data-tab=docs]');
    await p.click('#d-body .list li.clickable');
    const btn = p.getByRole('button', { name: 'Skrivelog' });
    await btn.click();
    await p.waitForSelector('#d-body .slog-paste');
    assert.strictEqual(await btn.getAttribute('aria-expanded'), 'true');
    const slog = await p.textContent('#d-body .slog');
    assert.match(slog, /Skrevet i 1 skriveøkt · \d+ min · \d+ ord · 1 indsat udsnit \(\d+ tegn\) · 1 rettelse/);
    assert.match(slog, /ikke i sig selv bevis for snyd/);
    assert.strictEqual(await p.textContent('#d-body .slog-paste'), PASTE);
    assert.match(slog, /Rettelse: \d+ tegn fjernet/);
    assert.ok(await p.isVisible('#d-body .slog-chart'));
    await p.waitForSelector('#d-body .replay-bar');
    await p.click('#d-body .slog button:has-text("Vis i afspilningen")');
    assert.match(await p.textContent('#d-body .replay-text mark'), /Kilde fra nettet/);
    await p.click('#d-body .slog-table summary'); // tabellen foldet ud
    await axe('#d-body .slog');

    // 2) Afleveringen: elevens vedhæftede dokument
    await p.click('#d-close');
    await p.click('#asg-btn');
    await p.waitForSelector('#dlg[open]');
    await p.click('#dlg li.clickable');
    await p.click('#dlg button[aria-label="Skrivelog for Anna Jensen"]');
    await p.waitForSelector('#dlg .slog-paste');
    assert.strictEqual(await p.textContent('#dlg .slog-paste'), PASTE);
    await p.waitForSelector('#dlg .replay-bar');
    await p.click('#dlg .slog button:has-text("Vis i afspilningen")');
    assert.match(await p.textContent('#dlg .replay-text mark'), /Kilde fra nettet/);
    await axe('#dlg .slog');
    if (process.env.SLOG_SHOT) await p.screenshot({ path: process.env.SLOG_SHOT, fullPage: true });
    await p.click('#dlg button:has-text("Tilbage til afleveringen")');
    await p.waitForSelector('#dlg button[aria-label="Skrivelog for Anna Jensen"]');
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elev og privatliv: vilkårene, privatlivspolitikken og lærervejledningen nævner skrivelogen', () => {
  const sentence = 'Når du afleverer, kan din lærer se skrivelogen: hvornår du skrev, hvor meget du rettede, og hvis der er kommet tekst ind, som ikke er tastet, hvilken tekst det var.';
  assert.ok(pub('vilkaar-elev.html').includes(sentence));
  assert.ok(pub('privatliv.html').includes(sentence));
  assert.match(pub('privatliv.html'), /Afspilning, skrivelog og skrivedetaljer[^<]*<\/td><td>[^<]*<\/td><td><span data-cfg="retention\.versionsDays">/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'docs', 'LAERERVEJLEDNING.md'), 'utf8'), /\*\*Skrivelog:\*\*.*ikke i sig selv bevis for snyd/);
  assert.strictEqual(RET.describe(RET.fromEnv({}, {})).find(x => x.key === 'versionsDays').what, 'Afspilning, skrivelog og skrivedetaljer');
});

test('skrivelog: loggen har et loft (rækker og tegn), så den ikke kan fylde disken', () => {
  const { db, docs, anna, done } = setup();
  try {
    const id = crypto.randomUUID();
    let t = type(docs, anna, id, TEXT.slice(0, 60), { start: 7_000_000 });
    // Skiftevis 2.900 nye tegn ind og ud igen: hver gang et indsat udsnit og en rettelse
    for (let i = 0; i < 260; i++) {
      const junk = Array.from({ length: 100 }, (_, k) => `ord${i}x${k} tekst nummer ${i * 100 + k}`).join(' ').slice(0, 2900);
      save(docs, anna, id, TEXT.slice(0, 60) + ' ' + junk, t += 2000);
      save(docs, anna, id, TEXT.slice(0, 60), t += 2000);
    }
    const r = db.prepare('SELECT COUNT(*) AS n, SUM(length(excerpt)) AS chars, MAX(length(excerpt)) AS mx FROM doc_events WHERE doc_id = ?').get(id);
    // Højst 500.000 tegn fulde uddrag – derefter 200 tegn pr. række (og højst 3.000 rækker)
    assert.ok(r.chars > 500_000 && r.chars <= 500_000 + 2001 + r.n * 201, `${r.chars} tegn uddrag`);
    assert.ok(r.n <= 3000);
    const last = db.prepare("SELECT excerpt FROM doc_events WHERE doc_id = ? AND kind = 'indsat' ORDER BY rowid DESC LIMIT 1").get(id);
    assert.strictEqual(last.excerpt.length, 201, 'efter loftet: kun begyndelsen');
  } finally { done(); }
});
