'use strict';
// Elev-appen i en skrivetime: writer.openForAssignment finder kladden eller laver en ny, og vinduet åbnes uden at stjæle fokus.
// Electron er erstattet af en lille attrap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadWriter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-writer-'));
  const handlers = new Map();
  const wins = [];
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.calls = []; this.sent = []; this.visible = opts.show !== false; this.destroyed = false;
      this.webContents = { send: (ch, v) => this.sent.push([ch, v]), once() {}, on() {}, setWindowOpenHandler() {}, session: { setSpellCheckerLanguages() {} } };
      wins.push(this);
    }
    removeMenu() {} loadFile() {} on() {} once(ev, cb) { if (ev === 'ready-to-show') this.readyToShow = cb; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    show() { this.calls.push('show'); this.visible = true; } focus() { this.calls.push('focus'); }
    showInactive() { this.calls.push('showInactive'); this.visible = true; } flashFrame(on) { this.calls.push('flash:' + on); }
  }
  const electron = { app: { getPath: () => dir, isPackaged: true }, BrowserWindow, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, dialog: {} };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  const file = require.resolve('../agent/src/writer.js');
  delete require.cache[file];
  let Writer;
  try { ({ Writer } = require(file)); } finally { Module._load = orig; }
  const sent = [];
  const w = new Writer({ send: (m) => { sent.push(m); return true; }, lessonActive: () => true, serverUrl: 'https://holymoly.test', studentName: () => 'Anna' });
  w.onMessage({ type: 'assignments', items: [{ id: 7, title: 'Novelleanalyse' }, { id: 8, title: 'Digtanalyse' }] });
  return { w, handlers, wins, sent, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('skrivetime i elev-appen: kladden åbnes, ellers et nyt dokument – og vinduet tager ikke fokus', async () => {
  const { w, handlers, wins, sent, cleanup } = loadWriter();
  try {
    // Ingen kladde: et nyt dokument til opgaven, og serveren ser det straks
    w.writeLesson({ assignmentId: 7, title: 'Novelleanalyse' });
    assert.strictEqual(wins.length, 1);
    const win = wins[0];
    assert.strictEqual(win.opts.show, false, 'vinduet vises ikke med fokus');
    win.readyToShow();
    assert.deepStrictEqual(win.calls, ['flash:true', 'showInactive']);
    assert.ok(!win.calls.includes('focus'));
    const first = w.docs[0];
    assert.strictEqual(first.assignmentId, 7);
    assert.strictEqual(first.title, 'Novelleanalyse');
    assert.ok(sent.some(m => m.type === 'doc' && m.id === first.id));
    // Vinduet åbner dokumentet og viser banneret, når det er klar
    const st = handlers.get('write:state')();
    assert.strictEqual(st.openId, first.id);
    assert.deepStrictEqual(st.writeLesson, { assignmentId: 7, title: 'Novelleanalyse' });
    assert.strictEqual(handlers.get('write:state')().openId, '', 'kun én gang');

    // Samme skrivetime igen (fx ny config): intet nyt dokument
    w.writeLesson({ assignmentId: 7, title: 'Novelleanalyse' });
    assert.strictEqual(w.docs.length, 1);
    // Skrivetimen slutter: banneret forsvinder
    w.writeLesson(null);
    assert.deepStrictEqual(win.sent.pop(), ['write:write-lesson', null]);
    // Ny skrivetime med samme opgave: kladden fortsættes (vinduet er åbent: blinker og får besked)
    win.calls.length = 0;
    w.writeLesson({ assignmentId: 7, title: 'Novelleanalyse' });
    assert.strictEqual(w.docs.length, 1, 'kladden genbruges');
    assert.deepStrictEqual(win.calls, ['flash:true']);
    assert.deepStrictEqual(win.sent.pop(), ['write:open-doc', first.id]);

    // "Fortsæt kladde (n ord)": antal ord står i listen
    first.blocks = [{ t: 'p', r: [{ x: 'Novellen handler om en pige' }] }];
    assert.strictEqual(handlers.get('write:state')().docs[0].words, 5);
    assert.deepStrictEqual(await handlers.get('write:open-for')(null, 7), { ok: true, id: first.id });
    // En afleveret kladde fortsættes ikke: så laves et nyt dokument
    first.submitted = Date.now();
    const r = await handlers.get('write:open-for')(null, 7);
    assert.notStrictEqual(r.id, first.id);
    assert.strictEqual(w.docs.length, 2);
    assert.strictEqual((await handlers.get('write:open-for')(null, 99)).ok, false, 'ukendt aflevering');
  } finally { cleanup(); }
});

test('main.js giver skrivetimen videre til skrivevinduet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'main.js'), 'utf8');
  assert.match(src, /write: msg\.write \|\| null/);
  assert.match(src, /writer\.writeLesson\(live && state\.lesson\.write \? state\.lesson\.write : null\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', 'write.html'), 'utf8');
  assert.match(html, /id="write-banner"/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'agent', 'renderer', 'write.js'), 'utf8');
  assert.ok(js.includes('Skrivetime: ${w.title}. Dokumentet afleveres til opgaven, når du trykker "Afslut dokument".'));
  assert.ok(js.includes('Fortsæt kladde (${draft.words || 0} ord)'));
});
