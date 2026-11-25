'use strict';
// "Skriv i Word": hele økten (agent/src/word/manager.js) med den falske Word og en rigtig HolyMoly-server.
// Word -> snapshots -> serveren (source: 'word') -> "Tekst færdig" -> bevis -> forseglet fil -> Min HolyMoly -> aflevering.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const { WordManager } = require('../agent/src/word/manager.js');
const { FakeWordBridge } = require('../agent/src/word/bridge-fake.js');
const S = require('../agent/src/word/seal.js');
const D = require('../shared/doc.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function fakeOverlay() {
  return { views: [], hidden: 0, isFocused: false, update(v) { this.views.push(v); }, hide() { this.hidden++; }, destroy() {}, focused() { return this.isFocused; }, last() { return this.views[this.views.length - 1]; } };
}

/** En HolyMoly-server med en lærer, en klasse, en elev, en aflevering og en elev-app (WebSocket) koblet til en WordManager. */
async function rig(t, { lesson = true, home = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordmgr-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'srv'), signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 5 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
  const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
  const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
  const asg = await call('POST', `/api/classes/${cls.id}/assignments`, Object.assign({ title: 'Stil om romantikken' }, home ? { home: true, due: Date.now() + 7 * 86400_000 } : {}));
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
  const msgs = [];
  let live = false;
  let mgr = null;
  ws.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    msgs.push(m);
    if (m.type === 'lesson') live = !!m.live;
    if (mgr) mgr.onMessage(m);
  });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Windows', host: 'PC', version: '1.3.0' } }));
  const wait = async (f) => { for (let i = 0; i < 250; i++) { const m = msgs.find(f); if (m) return m; await sleep(20); } throw new Error('ingen besked'); };
  await wait(m => m.type === 'welcome');
  if (lesson) {
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ws.send(JSON.stringify({ type: 'status', activity: 'Word', violations: [], degraded: [] }));
  }
  const bridge = new FakeWordBridge();
  const overlay = fakeOverlay();
  const folder = [];
  mgr = new WordManager({
    bridge, overlay, autoTick: false, saveEveryMs: 1600,
    send: (m) => { if (ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; },
    lessonActive: () => live, online: () => ws.readyState === 1, serverUrl: 'https://holymoly.test',
    dir: path.join(dir, 'Dokumenter', 'HolyMoly'), dataDir: path.join(dir, 'userData'), showInFolder: (p) => folder.push(p),
  });
  for (const m of msgs) mgr.onMessage(m); // afleveringer og lampe, der kom før
  await wait(m => m.type === 'assignments' && m.items.length);
  mgr.onMessage(msgs.filter(m => m.type === 'assignments').pop());
  t.after(async () => { mgr.stop(); ws.close(); await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { mgr, bridge, overlay, folder, call, en, asg, cls, wait, msgs, dir, fake: bridge.fake };
}

/** Eleven skriver i Word: små bidder med menneskeligt tempo, så serveren ser hver gemning. */
async function typeInWord(r, text, chunk = 18) {
  for (let i = 0; i < text.length; i += chunk) {
    r.fake.handle({ cmd: 'fake:type', text: text.slice(i, i + chunk) });
    await sleep(1650);
    await r.mgr.tick();
  }
  await sleep(1650);
  await r.mgr.tick();
}

test('Word-økt: skriv -> Tekst færdig -> bevis -> forseglet fil, som tjek-siden godkender -> Min HolyMoly -> aflevering', { timeout: 60_000 }, async (t) => {
  const r = await rig(t);
  const st = await r.mgr.start({ assignmentId: r.asg.id });
  assert.ok(st.ok, st.error);
  const d = r.mgr.get(st.id);
  assert.strictEqual(d.title, 'Stil om romantikken');
  assert.ok(d.path.endsWith(path.join('HolyMoly', 'Stil om romantikken.docx')), d.path);
  assert.ok(fs.existsSync(d.path), 'Word gemte det nye dokument');
  // Rammen følger Word-vinduet og viser titlen og "Gemt kl."
  let v = r.overlay.last();
  assert.strictEqual(v.visible, true);
  assert.deepStrictEqual(v.rect, { x: 100, y: 80, w: 1200, h: 800 });
  assert.strictEqual(v.bar.title, 'Stil om romantikken');
  assert.match(v.bar.saved, /^Gemt kl\. \d\d\.\d\d$/);
  // Skriv (Copilot er slået fra i den falske Word)
  await typeInWord(r, 'Romantikken var en periode med følelser og natur i kunsten.');
  v = r.overlay.last();
  assert.strictEqual(v.status.color, 'green', v.status.text);
  assert.strictEqual(v.status.text, 'Grøn – teksten tæller med');
  // Serveren har fået teksten som Word-gemninger
  const full = await r.call('GET', '/api/docs/' + st.id);
  assert.match(full.blocks.map(b => b.r[0].x).join(' '), /følelser og natur/);
  // Word i baggrunden: rammen skjules (men økten kører videre)
  r.fake.handle({ cmd: 'fake:set', foreground: false });
  await r.mgr.tick();
  assert.strictEqual(r.overlay.last().visible, false);
  r.fake.handle({ cmd: 'fake:set', foreground: true });

  // Tekst færdig
  const res = await r.mgr.action('done');
  assert.ok(res.ok && res.certId && res.sealed && res.verified, JSON.stringify(res));
  assert.strictEqual(res.attached, true, 'vedhæftet til afleveringen');
  const panel = r.overlay.last().panel;
  assert.strictEqual(panel.kind, 'ok');
  assert.strictEqual(panel.title, 'Teksten er gyldig');
  assert.match(panel.text, /forseglet med mærket og gemt som "Stil om romantikken – forseglet\.docx"/);
  assert.match(panel.text, /Afleveret til "Stil om romantikken"/);
  assert.strictEqual(panel.mark, '✓ Tastet i Word via HolyMoly – intet indsat · i timen · kun Word');
  // Den forseglede fil: sidefod med mærket, koden og tjek-linket, læsebeskyttet, og brødteksten passer til beviset
  assert.ok(r.fake.sealed.footerLines[1].startsWith('HolyMoly HM-' + res.certId.slice(0, 8).toUpperCase() + '  ·  Tjek: https://holymoly.test/bevis/' + res.certId));
  const cert = await r.call('GET', '/api/bevis/' + res.certId);
  assert.deepStrictEqual(cert.payload.observed, ['word', 'taster'], 'tastetrykkene er talt');
  const bytes = fs.readFileSync(res.path);
  const ver = await S.verifySealed(bytes, cert.payload.sha256);
  assert.deepStrictEqual([ver.ok, ver.protected], [true, true]);
  assert.strictEqual(sha(ver.text), cert.payload.sha256);
  assert.ok(!fs.existsSync(path.join(path.dirname(res.path), 'Stil om romantikken.docx')), 'kladden er erstattet af den forseglede fil');
  // Min HolyMoly
  const item = r.mgr.list().find(x => x.id === st.id);
  assert.strictEqual(item.label, '✓ Tastet i Word via HolyMoly – intet indsat · i timen · kun Word');
  assert.strictEqual(item.verified, true);
  assert.strictEqual(item.sealedPath, res.path);
  // Åbn mappe
  await r.mgr.action('folder');
  assert.deepStrictEqual(r.folder, [res.path]);
  // Økten er slut: rammen lukkes med "Luk"
  assert.strictEqual(r.mgr.s, null);
  await r.mgr.action('close');
  assert.ok(r.overlay.hidden >= 1);
  // Læreren ser afleveringen
  const all = await r.call('GET', '/api/assignments');
  assert.ok(JSON.stringify(all).includes(st.id) || JSON.stringify(all).includes('Stil om romantikken'));
});

test('Word-økt: tekst indsat fra et andet program -> rød muldvarp -> "Skriv videre" / "Gem uden mærke"', { timeout: 60_000 }, async (t) => {
  const r = await rig(t);
  const st = await r.mgr.start({});
  assert.ok(st.ok, st.error);
  assert.match(r.mgr.get(st.id).title, /^Dokument /);
  await typeInWord(r, 'Mit eget første afsnit om romantikken.');
  r.fake.handle({ cmd: 'fake:paste', text: ' Oplysningstiden lagde vægt på fornuft, videnskab og kritisk tænkning, og dens tænkere ønskede at reformere samfundet.' });
  await sleep(1650);
  await r.mgr.tick();
  const v = r.overlay.last();
  assert.strictEqual(v.status.color, 'red');
  assert.match(v.status.text, /^Rød: tekst indsat fra et andet program kl\. \d\d\.\d\d$/);
  // Tekst færdig: serveren afviser beviset og spørger
  let res = await r.mgr.action('done');
  assert.strictEqual(res.confirm, true);
  let p = r.overlay.last().panel;
  assert.strictEqual(p.kind, 'confirm');
  assert.ok(p.items.includes('Der er kommet tekst i Word, som ikke er tastet (fx indsat, Copilot, diktering eller autotekst).'), p.items.join());
  assert.deepStrictEqual(p.actions.map(a => a.label), ['Skriv videre', 'Gem uden mærke']);
  // Skriv videre: boksen lukker, økten kører
  await r.mgr.action('continue');
  assert.strictEqual(r.overlay.last().panel, null);
  assert.ok(r.mgr.s);
  // Gem uden mærke: serveren låser uden bevis, Word gemmer og lukker
  res = await r.mgr.action('nomark');
  assert.deepStrictEqual([res.ok, res.certId], [true, null]);
  p = r.overlay.last().panel;
  assert.strictEqual(p.title, 'Gemt uden mærke');
  assert.strictEqual(r.mgr.s, null);
  const item = r.mgr.list().find(x => x.id === st.id);
  assert.ok(item.submitted && !item.certId && !item.label);
  const full = await r.call('GET', '/api/docs/' + st.id);
  assert.ok(full.submitted && !full.certId);
});

test('Word-økt hjemme: kun til en aflevering, der må skrives hjemme – skriveøkten starter og slutter med Word', { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { lesson: false, home: true });
  // Uden lektion og uden aflevering: nej
  const no = await r.mgr.start({});
  assert.match(no.error, /kun bruges, mens en lektion er i gang/);
  const st = await r.mgr.start({ assignmentId: r.asg.id });
  assert.ok(st.ok, st.error);
  assert.ok(r.msgs.some(m => m.type === 'write-session-result' && m.ok));
  await r.wait(m => m.type === 'lesson' && m.live);
  // Eleven lukker Word: økten slutter, skriveøkten lukkes, dokumentet står i Min HolyMoly som påbegyndt
  r.fake.handle({ cmd: 'fake:set', open: false });
  await r.mgr.tick();
  assert.strictEqual(r.mgr.s, null);
  assert.strictEqual(r.overlay.last().panel.title, 'Word-økten er slut');
  await r.wait(m => m.type === 'lesson' && !m.live);
  const item = r.mgr.list().find(x => x.id === st.id);
  assert.deepStrictEqual([item.submitted, item.open], [0, false]);
});

/* ---------------------------------------------------------------- uden server ---------------------------------------------------------------- */
function local(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordmgr-l-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const sent = [];
  const bridge = opts.bridge || new FakeWordBridge();
  const overlay = fakeOverlay();
  const clip = { text: '', formats: [], clears: 0, readText() { return this.text; }, availableFormats() { return this.formats; }, clear() { this.text = ''; this.formats = []; this.clears++; } };
  const mgr = new WordManager({ bridge, overlay, clipboard: clip, autoTick: false, send: (m) => { sent.push(m); return true; }, lessonActive: () => opts.live !== false, online: () => true, serverUrl: 'https://holymoly.test', dir: path.join(dir, 'docs'), dataDir: path.join(dir, 'data'), now: () => now });
  return { mgr, bridge, overlay, clip, sent, dir, tick: (ms) => { now += ms; }, fake: bridge.fake };
}

test('uden Word eller uden Windows: en klar besked, og intet startes', async (t) => {
  const { WordBridge } = require('../agent/src/word/bridge.js');
  let l = local(t, { bridge: new WordBridge({ platform: 'darwin' }) });
  assert.deepStrictEqual(await l.mgr.info(), { supported: false, word: false, allowed: true, available: false });
  assert.strictEqual((await l.mgr.start({})).error, 'Skriv i Word findes kun på Windows');
  l = local(t, { bridge: new FakeWordBridge({ word: false }) });
  assert.strictEqual((await l.mgr.start({})).error, 'Word findes ikke på computeren');
  assert.deepStrictEqual(await l.mgr.info(), { supported: true, word: false, allowed: true, available: false });
});

test('serveren får Word-teksten som afsnit med source: word og stats uden tekst; Word gemmer selv hvert minut', async (t) => {
  const l = local(t);
  const st = await l.mgr.start({});
  assert.ok(st.ok);
  const first = l.sent.find(m => m.type === 'doc');
  assert.deepStrictEqual([first.source, first.blocks], ['word', []], 'det tomme dokument straks');
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  l.fake.handle({ cmd: 'fake:type', text: 'Første afsnit.\rAndet afsnit' });
  l.tick(3000);
  await l.mgr.tick();
  const doc = l.sent.filter(m => m.type === 'doc').pop();
  assert.deepStrictEqual(doc.blocks, [{ t: 'p', r: [{ x: 'Første afsnit.' }] }, { t: 'p', r: [{ x: 'Andet afsnit' }] }]);
  // Kun tal (og Copilot-status) – med tastetryk også tastetællerne, aldrig hvilke taster
  assert.deepStrictEqual(Object.keys(doc.stats).sort(), ['activeMs', 'burst', 'copilot', 'deleted', 'fastShare', 'focusLostMs', 'injected', 'keys', 'keystrokes', 'maxCps', 'pasteBlocked', 'pasteInserted', 'pasteKeys', 'regularity', 'restored', 'typed', 'undo', 'untyped']);
  assert.deepStrictEqual([doc.stats.keys, doc.stats.typed, doc.stats.untyped], [true, 27, 0]);
  assert.ok(Object.values(doc.stats).every(v => v === null || typeof v === 'number' || typeof v === 'boolean' || ['on', 'off', 'unknown'].includes(v)), JSON.stringify(doc.stats));
  // Uændret tekst sendes ikke igen; svar fra serveren gemmer "sidst set" lokalt
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true, preview: { ok: false, categories: [{ key: 'kort', text: 'Teksten er for kort. Et bevis kræver mindst 100 ord.' }] } });
  assert.strictEqual(l.mgr.get(st.id).lastText, 'Første afsnit.\nAndet afsnit');
  assert.deepStrictEqual(l.overlay.last().status.notes, ['Teksten er for kort. Et bevis kræver mindst 100 ord.']);
  const n = l.sent.length;
  l.tick(3000); await l.mgr.tick();
  assert.strictEqual(l.sent.length, n);
  // Efter et minut uden at gemme: Word gemmer
  const saves = () => l.fake.log.filter(c => c === 'save').length;
  const before = saves();
  l.tick(61_000); await l.mgr.tick();
  assert.strictEqual(saves(), before + 1);
  // Lampen fra serveren tæller med
  l.mgr.onMessage({ type: 'my-lamp', color: 'red', reason: 'ChatGPT' });
  assert.strictEqual(l.overlay.last().status.text, 'Rød: ChatGPT er åben. Luk det.');
});

test('udklipsholderen ryddes under økten, når Word (eller rammen) er i forgrunden', async (t) => {
  const l = local(t);
  await l.mgr.start({});
  l.mgr.clipTick();
  l.clip.text = 'Tekst kopieret fra en hjemmeside om noget helt andet end opgaven handler om.'; l.clip.formats = ['text/plain'];
  l.fake.handle({ cmd: 'fake:set', foreground: false });
  await l.mgr.tick();
  assert.strictEqual(l.mgr.clipTick(), false, 'Word i baggrunden: intet');
  l.overlay.isFocused = true; // eleven har klikket på rammen
  assert.strictEqual(l.mgr.clipTick(), true);
  assert.strictEqual(l.clip.clears, 1);
  assert.strictEqual(l.mgr.s.check.stats().pasteBlocked, 1);
});

test('genåbnet dokument: fortsæt i Word – og tekst skrevet uden for HolyMoly gør muldvarpen rød', async (t) => {
  const l = local(t);
  const st = await l.mgr.start({});
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  l.fake.handle({ cmd: 'fake:type', text: 'Mit eget afsnit.' });
  l.tick(3000); await l.mgr.tick();
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  await l.bridge.save();
  l.fake.handle({ cmd: 'fake:set', open: false });
  await l.mgr.tick();
  assert.strictEqual(l.mgr.s, null);
  // Ændret uden for HolyMoly (fx i Word uden HolyMoly)
  l.fake.stored[l.mgr.get(st.id).path] = ['Mit eget afsnit. Og en hel masse tekst, der er skrevet et andet sted, uden at HolyMoly kunne se det, og som nu står her.'];
  const again = await l.mgr.start({ docId: st.id });
  assert.ok(again.ok, again.error);
  assert.strictEqual(l.overlay.last().status.text, 'Rød: dokumentet er ændret uden for HolyMoly');
  assert.match((await l.mgr.start({})).error, /allerede et Word-dokument åbent/);
});

test('Tekst færdig uden lektion og uden forbindelse: tydelig besked, intet låses', async (t) => {
  const l = local(t);
  const st = await l.mgr.start({});
  l.mgr.o.lessonActive = () => false;
  const r = await l.mgr.action('done');
  assert.match(r.error, /kræver, at lektionen eller skriveøkten er i gang/);
  assert.strictEqual(l.overlay.last().panel.kind, 'error');
  assert.ok(!l.mgr.get(st.id).submitted);
  await l.mgr.action('continue');
  assert.strictEqual(l.overlay.last().panel, null);
});

/* ---------------------------------------------------------------- tastetryk i Word ---------------------------------------------------------------- */
test('Word-økt med tastetryk og Copilot slået til: gråt ? under skrivningen, men beviset udstedes (ingen afslag)', { timeout: 60_000 }, async (t) => {
  const r = await rig(t);
  r.fake.handle({ cmd: 'fake:set', copilot: 'on' });
  const st = await r.mgr.start({});
  assert.ok(st.ok, st.error);
  await typeInWord(r, 'Romantikken var en periode med følelser og natur i kunsten.');
  const v = r.overlay.last();
  assert.deepStrictEqual([v.status.color, v.status.text], ['grey', 'Grå: Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket.']);
  const full = await r.call('GET', '/api/docs/' + st.id);
  assert.ok(full.notes.some(n => /Copilot/.test(n)), full.notes.join());
  const res = await r.mgr.action('done');
  assert.ok(res.ok && res.certId, JSON.stringify(res));
  const cert = await r.call('GET', '/api/bevis/' + res.certId);
  assert.ok(cert.payload.checks.includes('Teksten passer med tastetrykkene i Word'), cert.payload.checks.join());
});

test('Word-økt med tastetryk: tekst uden tastetryk (Copilot) i små bidder -> rød muldvarp -> serveren afviser med Word-teksten', { timeout: 60_000 }, async (t) => {
  const r = await rig(t);
  const st = await r.mgr.start({});
  await typeInWord(r, 'Mit eget første afsnit om romantikken.');
  assert.strictEqual(r.overlay.last().status.color, 'green');
  // Copilot skriver i Word: 18 tegn ad gangen (ingen spring, intet for serverens vækstbudget) – men ingen tastetryk
  for (const bid of [' Romantikken var en', ' kunstnerisk og', ' litterær bevægelse.']) {
    r.fake.handle({ cmd: 'fake:insert', text: bid });
    await sleep(1650);
    await r.mgr.tick();
  }
  const v = r.overlay.last();
  assert.match(v.status.text, /^Rød: der er kommet tekst, som ikke er tastet, kl\. \d\d\.\d\d$/);
  assert.strictEqual(r.mgr.s.check.inserts.length, 0, 'vækst-tjekket alene ville ikke se det');
  const res = await r.mgr.action('done');
  assert.strictEqual(res.confirm, true);
  assert.ok(res.categories.includes('Der er kommet tekst i Word, som ikke er tastet (fx indsat, Copilot, diktering eller autotekst).'), res.categories.join());
  const full = await r.call('GET', '/api/docs/' + st.id);
  assert.ok(full.reasons.includes(D.WORD_UNTYPED), full.reasons.join());
});

test('tastetryk: tallene gemmes til næste økt, og "Tastetryk kan ikke tælles" uden tæller', async (t) => {
  const l = local(t);
  const st = await l.mgr.start({});
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  l.fake.handle({ cmd: 'fake:type', text: 'Mit eget afsnit.' });
  l.tick(3000); await l.mgr.tick();
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  assert.deepStrictEqual([l.mgr.get(st.id).stats.keys, l.mgr.get(st.id).stats.typed], [true, 16]);
  // Efter sidste gemning taster eleven videre og lukker Word: tallene gemmes alligevel
  l.fake.handle({ cmd: 'fake:type', text: ' Mere.' });
  l.tick(1000); await l.mgr.tick();
  await l.bridge.save();
  l.fake.handle({ cmd: 'fake:set', open: false });
  await l.mgr.tick();
  assert.strictEqual(l.mgr.get(st.id).stats.typed, 22);
  // Næste økt: tællerne starter forfra i Word, men serveren får hele dokumentets tal
  assert.ok((await l.mgr.start({ docId: st.id })).ok);
  assert.strictEqual(l.sent.filter(m => m.type === 'doc').pop().stats.typed, 22, 'første gemning i den nye økt: tallene fra før');
  l.mgr.onMessage({ type: 'doc-saved', id: st.id, ok: true });
  l.fake.handle({ cmd: 'fake:type', text: ' Og mere.' });
  l.tick(3000); await l.mgr.tick();
  const doc = l.sent.filter(m => m.type === 'doc').pop();
  assert.deepStrictEqual([doc.stats.keys, doc.stats.typed, doc.stats.untyped], [true, 31, 0]);
  assert.notStrictEqual(l.overlay.last().status.color, 'red', l.overlay.last().status.text);
  // Ingen tastetæller på computeren: en note, og stats siger keys: false
  const n = local(t, { bridge: new FakeWordBridge({ keys: false }) });
  const ns = await n.mgr.start({});
  n.mgr.onMessage({ type: 'doc-saved', id: ns.id, ok: true });
  n.fake.handle({ cmd: 'fake:type', text: 'Hej' });
  n.tick(3000); await n.mgr.tick();
  assert.ok(n.overlay.last().status.notes.includes('Tastetryk kan ikke tælles på denne computer.'));
  assert.strictEqual(n.sent.filter(m => m.type === 'doc').pop().stats.keys, false);
  // Et påbegyndt dokument fra før tastetællingen (ingen tal) vurderes uden tastetryk
  assert.deepStrictEqual(WordManager.baseStats({ lastText: 'Gammel tekst' }, false), { keys: false });
  assert.strictEqual(WordManager.baseStats({ lastText: '' }, false), null);
  assert.strictEqual(WordManager.baseStats({ lastText: 'x', stats: { keys: true, typed: 1 } }, true), null, 'et nyt dokument har ingen tidligere tal');
});
