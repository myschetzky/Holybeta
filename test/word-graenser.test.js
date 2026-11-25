'use strict';
// Grænser for tastetælleren og skrivelogen i Word (låst fast):
//  - til serveren går kun samlede tal pr. snapshot – aldrig tastekoder, tegn eller tid pr. tast,
//  - tælleren kører kun under en Word-økt i HolyMoly og tæller kun med netop det Word-vindue i forgrunden,
//  - skrivelogens uddrag for et Word-dokument er kun dokumentets egen tekst.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WordManager } = require('../agent/src/word/manager.js');
const { WordBridge } = require('../agent/src/word/bridge.js');
const { FakeWordBridge } = require('../agent/src/word/bridge-fake.js');
const { WordCheck } = require('../agent/src/word/session.js');
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');

// Det eneste, der må stå i stats fra Word: tal (og Copilot-status og keys: true/false)
const ALLOWED = ['activeMs', 'burst', 'copilot', 'deleted', 'fastShare', 'focusLostMs', 'injected', 'keys', 'keystrokes', 'maxCps', 'pasteBlocked', 'pasteInserted', 'pasteKeys', 'regularity', 'restored', 'typed', 'undo', 'untyped'];
// Felter, som en tastetæller ville bruge til at sende hvilke taster eller tid pr. tast
const JUNK = { vkCode: 65, scanCode: 30, key: 'a', char: 'a', codes: [65, 66], times: [1000, 1080, 1170], keyTimes: [[65, 1000]], gaps: [80, 90], lastKey: 1170, text: 'HEMMELIG' };
const scalar = (v) => v === null || typeof v === 'number' || typeof v === 'boolean' || ['on', 'off', 'unknown', ''].includes(v);

function assertOnlyCounts(stats, where) {
  assert.ok(stats && typeof stats === 'object', where);
  for (const k of Object.keys(stats)) assert.ok(ALLOWED.includes(k), `${where}: ukendt felt ${k}`);
  for (const [k, v] of Object.entries(stats)) assert.ok(scalar(v), `${where}: ${k} er ikke et tal (${JSON.stringify(v)})`);
  const json = JSON.stringify(stats);
  for (const bad of ['vkCode', 'scanCode', 'codes', 'times', 'keyTimes', 'gaps', 'lastKey', 'HEMMELIG', '[']) assert.ok(!json.includes(bad), `${where}: ${bad} i ${json}`);
}

test('elev-appen: doc og doc-submit fra Word har kun samlede tal – også når tælleren sender tastekoder og tider', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordgr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // En Word-bro, hvis tæller (fejlagtigt) sender tastekoder og tid pr. tast med tællerne
  const bridge = new FakeWordBridge();
  const orig = bridge.state.bind(bridge);
  bridge.state = async () => { const r = await orig(); if (r.keys) r.keys = Object.assign({}, r.keys, JUNK); return Object.assign(r, { keyLog: [{ vk: 65, t: 1 }] }); };
  let now = 1_700_000_000_000;
  const sent = [];
  const mgr = new WordManager({ bridge, autoTick: false, send: (m) => { sent.push(m); return true; }, lessonActive: () => true, online: () => true, serverUrl: 'https://holymoly.test', dir: path.join(dir, 'docs'), dataDir: path.join(dir, 'data'), now: () => now });
  const st = await mgr.start({});
  assert.ok(st.ok, st.error);
  mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  for (const part of ['Romantikken var en periode. ', 'Digterne skrev om naturen. ', 'Og om længsel.']) {
    bridge.fake.handle({ cmd: 'fake:type', text: part });
    now += 3000;
    await mgr.tick();
    mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  }
  const docs = sent.filter(m => m.type === 'doc' && m.stats && m.stats.keys === true);
  assert.ok(docs.length >= 2, 'snapshots med talte tastetryk');
  for (const m of docs) {
    assertOnlyCounts(m.stats, 'doc');
    assert.deepStrictEqual(Object.keys(m).sort(), ['blocks', 'id', 'source', 'stats', 'title', 'type'], 'intet andet i beskeden');
  }
  // Tallene er samlede (ét tal pr. felt), ikke en liste pr. tast
  assert.strictEqual(docs[docs.length - 1].stats.typed, 'Romantikken var en periode. Digterne skrev om naturen. Og om længsel.'.length);
  // Det lokale register (Min HolyMoly) gemmer heller ikke andet end tallene
  const reg = fs.readFileSync(path.join(dir, 'data', 'word-documents.json'), 'utf8');
  for (const bad of ['vkCode', 'keyTimes', 'keyLog', 'HEMMELIG']) assert.ok(!reg.includes(bad), bad);
  // "Tekst færdig": aflevering med de samme regler
  const done = mgr.action('done');
  let sub = null;
  for (let i = 0; i < 100 && !sub; i++) { await new Promise(r => setTimeout(r, 10)); sub = sent.find(m => m.type === 'doc-submit'); }
  assert.ok(sub, 'Tekst færdig sender doc-submit');
  assertOnlyCounts(sub.stats, 'doc-submit');
  mgr.onMessage({ type: 'doc-result', id: st.id, ok: false, error: 'test' });
  await done;
  mgr.stop();
});

test('WordCheck og broen: kun de kendte tællere går videre, hvem der end leverer dem', async () => {
  const c = new WordCheck();
  c.snapshot({ t: 0, text: '', copilot: 'off', foreground: true, keys: Object.assign({ typed: 0, keystrokes: 0 }, JUNK) });
  c.snapshot({ t: 1000, text: 'Hej', copilot: 'off', foreground: true, keys: Object.assign({ typed: 3, keystrokes: 3 }, JUNK) });
  assertOnlyCounts(c.stats(), 'WordCheck.stats');
  // En anden Word-proces, der selv leverer keys i state-svaret: renses i broen
  const b = new WordBridge({ command: 'ingen', keys: false });
  b.request = async () => ({ ok: true, open: true, text: 'Hej', hwnd: 42, keys: Object.assign({ typed: 3 }, JUNK) });
  const s = await b.state();
  assert.ok(!('hwnd' in s), 'vinduets hwnd bliver i broen');
  assert.deepStrictEqual(Object.keys(s.keys).sort(), ['burst', 'deleted', 'fastShare', 'injected', 'keystrokes', 'maxCps', 'pasteKeys', 'regularity', 'typed', 'undo']);
  assert.strictEqual(s.keys.typed, 3);
});

test('tælleren kører kun under en Word-økt og kun med Word-vinduet i forgrunden (statisk tjek af broen og keys.ps1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'bridge.js'), 'utf8');
  // Tælleren laves kun, når et dokument åbnes (en Word-økt), og stoppes, når økten slutter
  const makes = src.split('\n').filter(l => /this\.makeKeys\(\)/.test(l));
  assert.strictEqual(makes.length, 1, makes.join('\n'));
  const open = src.slice(src.indexOf('async open('), src.indexOf('async state('));
  assert.match(open, /this\.keys = this\.makeKeys\(\)/);
  for (const fn of ['async seal(', 'async close(', 'stop() {']) assert.match(src.slice(src.indexOf(fn)), /_keysStop\(\)/, fn);
  const ps = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'keys.ps1'), 'utf8');
  // Uden et Word-vindue (target 0) eller med et andet vindue i forgrunden tælles intet
  assert.match(ps, /if \(tg == 0 \|\| GetForegroundWindow\(\)\.ToInt64\(\) != tg\) return;/);
  assert.match(ps, /static long target = 0;/);
  // Tider pr. tast bliver i processen (kun til tempoet) – det, der sendes, er Snapshot() med ét tal pr. felt
  const snap = ps.slice(ps.indexOf('public static Hashtable Snapshot('));
  assert.ok(!/times|gaps|lastKey/.test(snap.slice(0, snap.indexOf('return h;'))), 'ingen tider pr. tast i svaret');
});

test('serveren: Word-gemninger gemmer kun kendte tal, og skrivelogens uddrag er kun dokumentets egen tekst', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordgr-srv-'));
  try {
    const db = dbm.open(dir);
    db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
    db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', 0)").run();
    db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna', 0, 1)").run();
    const docs = new DocStore(db, dir);
    const anna = { id: 1, class_id: 1 };
    const id = crypto.randomUUID();
    const green = { color: 'green', violations: [] };
    const para = (x) => x.split('\n').map(p => ({ t: 'p', r: [{ x: p }] }));
    const own = 'Romantikken var en periode i kunsten, hvor følelser og natur fik en stor plads hos digterne.';
    const foreign = 'Dette afsnit er kopieret fra en hjemmeside og kom ind i dokumentet på én gang uden tastetryk overhovedet.';
    const stats = (typed) => Object.assign({ keys: true, typed, keystrokes: typed, pasteInserted: 0 }, JUNK, { clipboard: 'UDKLIP-FRA-ANDET-PROGRAM' });
    let t = 1_000_000;
    let text = '';
    assert.ok(docs.save(anna, { id, title: 'R', blocks: [], stats: stats(0), source: 'word' }, green, 1, t).ok);
    for (let n = 20; n <= own.length + 19; n += 20) {
      t += 3000; text = own.slice(0, n);
      assert.ok(docs.save(anna, { id, title: 'R', blocks: para(text), stats: stats(text.length), source: 'word' }, green, 1, t).ok);
    }
    // Et stort stykke på én gang (logges som 'indsat' med uddrag), og en rettelse (det fjernede logges)
    t += 3000; text = own + '\n' + foreign;
    assert.ok(docs.save(anna, { id, title: 'R', blocks: para(text), stats: stats(own.length), source: 'word' }, green, 1, t).ok);
    t += 3000; text = own.slice(0, 40);
    assert.ok(docs.save(anna, { id, title: 'R', blocks: para(text), stats: stats(own.length), source: 'word' }, green, 1, t).ok);
    // Gemte tal: kun kendte felter
    const row = db.prepare('SELECT stats FROM documents WHERE id = ?').get(id);
    const saved = JSON.parse(row.stats);
    for (const k of Object.keys(JUNK).concat('clipboard')) assert.ok(!(k in saved), k);
    assert.ok(!row.stats.includes('HEMMELIG') && !row.stats.includes('UDKLIP'));
    // Skrivelogen: alle uddrag har stået i dokumentet (i en version eller som det fjernede)
    const all = db.prepare('SELECT text FROM doc_versions WHERE doc_id = ?').all(id).map(r => r.text).concat([own + '\n' + foreign, text]);
    const ev = db.prepare('SELECT kind, excerpt, detail FROM doc_events WHERE doc_id = ?').all(id);
    const withExcerpt = ev.filter(e => e.excerpt != null);
    assert.ok(withExcerpt.some(e => e.kind === 'indsat'), 'det indsatte stykke er logget');
    for (const e of withExcerpt) assert.ok(all.some(x => x.includes(e.excerpt)), `${e.kind}: "${e.excerpt}" stod ikke i dokumentet`);
    for (const e of ev) {
      const s = (e.excerpt || '') + (e.detail || '');
      for (const bad of ['HEMMELIG', 'UDKLIP', 'vkCode', 'keyTimes']) assert.ok(!s.includes(bad), `${e.kind}: ${bad}`);
    }
    // Lærerens skrivelog (log()) viser kun tal for tastetryk
    db.prepare('UPDATE documents SET submitted = ? WHERE id = ?').run(t + 1000, id);
    const log = docs.log(id);
    for (const v of Object.values(log.summary)) assert.ok(scalar(v) || typeof v === 'string', JSON.stringify(log.summary));
    assert.ok(!JSON.stringify(log).includes('HEMMELIG'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
