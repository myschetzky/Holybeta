'use strict';
// Elev-appen: lampen i skrivevinduets footer (my-lamp, server-restart, ingen forbindelse) og en afbrudt skriveøkt,
// der fortsættes af sig selv uden at låse skrivevinduet. Electron er erstattet af en lille attrap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadWriter(net) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-writer-lamp-'));
  const handlers = new Map();
  const wins = [];
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.sent = []; this.destroyed = false; this.handlers = {};
      this.webContents = { send: (ch, v) => this.sent.push([ch, v]), once() {}, on() {}, setWindowOpenHandler() {}, session: { setSpellCheckerLanguages() {} } };
      wins.push(this);
    }
    removeMenu() {} loadFile() {} on(ev, cb) { this.handlers[ev] = cb; } once() {}
    isDestroyed() { return this.destroyed; } isVisible() { return true; }
    show() {} focus() {} showInactive() {} flashFrame() {}
  }
  const electron = { app: { getPath: () => dir, isPackaged: true }, BrowserWindow, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, dialog: {} };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  const file = require.resolve('../agent/src/writer.js');
  delete require.cache[file];
  let Writer;
  try { ({ Writer } = require(file)); } finally { Module._load = orig; }
  const sent = [];
  const w = new Writer({
    send: (m) => { sent.push(m); return net.online; }, lessonActive: () => net.live, serverUrl: 'https://holymoly.test', studentName: () => 'Anna',
    online: () => net.online, lastRecv: () => net.lastRecv,
  });
  w.onMessage({ type: 'assignments', items: [{ id: 7, title: 'Stil hjemme', home: true }] });
  return { Writer, w, handlers, wins, sent, cleanup: () => { clearInterval(w._lampTimer); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const lampOf = (win) => { const l = win.sent.filter(([ch]) => ch === 'write:lamp'); return l.length ? l[l.length - 1][1] : undefined; };

test('lampView: symbol og tekst for grøn, rød og grå – grå uden forbindelse, banner efter 60 sek., hjemme kun farven', () => {
  const { Writer, cleanup } = loadWriter({ online: true, live: true, lastRecv: Date.now() });
  try {
    const now = 1_000_000;
    const base = { live: true, online: true, lastRecv: now - 1000, lostSince: 0 };
    assert.strictEqual(Writer.lampView(Object.assign({}, base, { live: false, color: 'green' }), now), null, 'ingen lampe uden lektion');
    let v = Writer.lampView(Object.assign({}, base, { color: 'green' }), now);
    assert.deepStrictEqual([v.color, v.symbol, v.text, v.lost], ['green', '✓', 'Grøn – skriveforløbet følges.', false]);
    v = Writer.lampView(Object.assign({}, base, { color: 'red', reason: 'AI / chatbots', home: true }), now);
    assert.deepStrictEqual([v.color, v.symbol], ['red', '!']);
    assert.strictEqual(v.text, 'Rød: AI / chatbots åben. Luk det. Dette dokument kan ikke få mærket for tiden med rødt.');
    assert.strictEqual(v.homeNote, 'Hjemme ser din lærer kun farven.');
    v = Writer.lampView(Object.assign({}, base, { color: 'grey', reason: 'Forbinder…' }), now);
    assert.deepStrictEqual([v.color, v.symbol, v.text], ['grey', '?', 'Grå: Forbinder. Skriv videre – teksten gemmes på computeren.']);
    assert.strictEqual(v.homeNote, '', 'i klassen ingen hjemme-tekst');
    // Mere end 15 sek. uden besked fra serveren: grå – også selv om den sidste lampe var grøn
    v = Writer.lampView(Object.assign({}, base, { color: 'green', lastRecv: now - 16_000 }), now);
    assert.deepStrictEqual([v.color, v.text, v.lost, v.banner], ['grey', 'Grå: Ingen forbindelse til HolyMoly. Skriv videre – teksten gemmes på computeren.', true, false]);
    v = Writer.lampView(Object.assign({}, base, { color: 'green', online: false, lostSince: now - 61_000 }), now);
    assert.strictEqual(v.banner, true, 'banneret efter 60 sek. grå');
    v = Writer.lampView(Object.assign({}, base, { color: 'green', restart: true }), now);
    assert.strictEqual(v.text, 'HolyMoly-serveren genstarter. Skriv bare videre – teksten gemmes på computeren.');
  } finally { cleanup(); }
});

test('skrivevinduet: my-lamp, server-restart og tabt forbindelse i footeren', () => {
  const net = { online: true, live: true, lastRecv: Date.now() };
  const { w, wins, cleanup } = loadWriter(net);
  try {
    w.open();
    const win = wins[0];
    w.lessonChanged(true);
    assert.strictEqual(lampOf(win).text, 'Grå: Venter på HolyMoly. Skriv videre – teksten gemmes på computeren.');
    w.onMessage({ type: 'my-lamp', color: 'green', reason: '', home: true });
    assert.strictEqual(lampOf(win).color, 'green');
    assert.strictEqual(lampOf(win).homeNote, 'Hjemme ser din lærer kun farven.');
    const n = win.sent.length;
    w._pushLamp();
    assert.strictEqual(win.sent.length, n, 'kun ved ændring');
    w.onMessage({ type: 'server-restart' });
    assert.match(lampOf(win).text, /^HolyMoly-serveren genstarter/);
    w.onMessage({ type: 'welcome' });
    w.onMessage({ type: 'my-lamp', color: 'red', reason: 'AI / chatbots', home: false });
    assert.strictEqual(lampOf(win).symbol, '!');
    // Netværket forsvinder: grå inden for 15 sek. – og efter 60 sek. et banner. Skrivevinduet låses ikke.
    const t0 = Date.now();
    net.lastRecv = t0 - 16_000;
    assert.strictEqual(w._pushLamp(t0).color, 'grey');
    assert.strictEqual(w._pushLamp(t0 + 61_000).banner, true);
    assert.ok(!win.sent.some(([ch, v]) => ch === 'write:lesson' && v === false), 'editoren låses aldrig af en afbrydelse');
    // Lektionen er slut: ingen lampe
    net.live = false;
    w.lessonChanged(false);
    assert.strictEqual(lampOf(win), null);
  } finally { cleanup(); }
});

test('afbrudt skriveøkt: appen sender resume ved welcome, låser ikke imens og starter en ny økt, hvis resume afvises', async () => {
  const net = { online: true, live: false, lastRecv: Date.now() };
  const { w, wins, sent, handlers, cleanup } = loadWriter(net);
  try {
    w.open();
    const win = wins[0];
    // Eleven starter en skriveøkt hjemme
    const p = handlers.get('write:session')({}, { assignmentId: 7, on: true });
    w.onMessage({ type: 'write-session-result', assignmentId: 7, ok: true, endsAt: Date.now() + 3600_000 });
    assert.strictEqual((await p).ok, true);
    net.live = true;
    w.lessonChanged(true);

    // Forbindelsen kommer igen: resume sendes af sig selv
    sent.length = 0;
    w.onMessage({ type: 'welcome' });
    assert.deepStrictEqual(sent, [{ type: 'write-session', assignmentId: 7, on: true, resume: true }]);
    // Serveren har afsluttet økten (lesson live:false), men skrivevinduet låses ikke, mens den genoptages
    net.live = false;
    w.lessonChanged(false);
    assert.ok(!win.sent.some(([ch, v]) => ch === 'write:lesson' && v === false));
    assert.strictEqual(handlers.get('write:state')().lesson, true);
    // Resume afvist (fx for længe væk): en ny skriveøkt til samme aflevering
    sent.length = 0;
    w.onMessage({ type: 'write-session-result', assignmentId: 7, ok: false, resume: true, error: 'Skriveøkten kan ikke fortsættes. Start den igen.' });
    assert.deepStrictEqual(sent, [{ type: 'write-session', assignmentId: 7, on: true }]);
    net.live = true;
    w.lessonChanged(true);
    w.onMessage({ type: 'write-session-result', assignmentId: 7, ok: true, endsAt: Date.now() + 3600_000 });
    assert.strictEqual(w.resuming, false);
    assert.strictEqual(w.soloAssignment, 7);

    // Igen afbrudt, og hverken resume eller en ny økt lykkes: eleven får besked, og først nu låses vinduet
    w.onMessage({ type: 'welcome' });
    net.live = false;
    w.lessonChanged(false);
    w.onMessage({ type: 'write-session-result', assignmentId: 7, ok: false, resume: true, error: 'x' });
    w.onMessage({ type: 'write-session-result', assignmentId: 7, ok: false, error: 'Fristen for afleveringen er overskredet' });
    assert.ok(win.sent.some(([ch, v]) => ch === 'write:session-ended' && v === 'Fristen for afleveringen er overskredet'));
    assert.deepStrictEqual(win.sent.filter(([ch]) => ch === 'write:lesson').pop(), ['write:lesson', false]);
    assert.strictEqual(w.soloAssignment, 0);

    // Uden skriveøkt eller uden åbent vindue sendes intet resume
    sent.length = 0;
    w.onMessage({ type: 'welcome' });
    assert.deepStrictEqual(sent, []);
  } finally { cleanup(); }
});

test('main.js giver my-lamp, server-restart og welcome videre til skrivevinduet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  assert.match(src, /case 'my-lamp':/);
  assert.match(src, /case 'server-restart':/);
  assert.match(src, /lastRecv: \(\) =>/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', 'write.html'), 'utf8');
  assert.match(html, /<footer[\s\S]*id="lamp"[^>]*role="status"[^>]*aria-live="polite"[\s\S]*<\/footer>/);
  assert.match(html, /Forbindelsen er væk\. Det, du skriver nu, tæller måske ikke med i beviset\./);
});
