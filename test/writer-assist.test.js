'use strict';
// Skrivevinduet for alle: stavekontrol i højreklik-menuen, zoom der huskes, hjælpemidler og øvedokumentet.
// Electron er erstattet af en lille attrap (som i writer-lesson.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadWriter(dir) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'hm-writer-assist-'));
  const handlers = new Map();
  const wins = [];
  const menus = [];
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.sent = []; this.destroyed = false; this.zoom = 0;
      const wc = this.webContents = {
        sent: this.sent, ev: {}, replaced: [], added: [],
        send: (ch, v) => this.sent.push([ch, v]), once() {},
        on: (ev, fn) => { wc.ev[ev] = fn; },
        setWindowOpenHandler() {}, setZoomLevel: (z) => { this.zoom = z; },
        replaceMisspelling: (w) => wc.replaced.push(w),
        session: { setSpellCheckerLanguages() {}, addWordToSpellCheckerDictionary: (w) => wc.added.push(w) },
      };
      wins.push(this);
    }
    removeMenu() {} loadFile() {} on() {} once() {}
    isDestroyed() { return this.destroyed; } isVisible() { return true; }
    show() {} focus() {} showInactive() {} flashFrame() {}
  }
  const electron = {
    app: { getPath: () => dir, isPackaged: true }, BrowserWindow, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, dialog: {},
    Menu: { buildFromTemplate: (tpl) => { const m = { tpl, popup() { m.shown = true; } }; menus.push(m); return m; } },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  for (const f of ['../agent/src/writer.js', '../agent/src/store.js']) delete require.cache[require.resolve(f)];
  let Writer, store;
  try { ({ Writer } = require('../agent/src/writer.js')); store = require('../agent/src/store.js'); } finally { Module._load = orig; }
  // Menu hentes først, når der højreklikkes: attrappen skal også gælde der
  const withElectron = (fn) => { Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); }; try { return fn(); } finally { Module._load = orig; } };
  const sent = [];
  const w = new Writer({ send: (m) => { sent.push(m); return true; }, lessonActive: () => true, serverUrl: 'https://holymoly.test', studentName: () => 'Anna' });
  return { w, store, handlers, wins, menus, sent, dir, withElectron, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('stavekontrol: højreklik viser højst 6 forslag, "Tilføj til ordbogen", Klip og Kopiér – aldrig Indsæt', () => {
  const { w, wins, menus, withElectron, cleanup } = loadWriter();
  try {
    w.open();
    const wc = wins[0].webContents;
    assert.strictEqual(wins[0].opts.webPreferences.spellcheck, true);
    const params = { isEditable: true, misspelledWord: 'skrivr', dictionarySuggestions: ['skriver', 'skrive', 'skrevet', 'skriv', 'skrift', 'skrin', 'skrig'], selectionText: '', editFlags: { canCut: false, canCopy: false, canPaste: true } };
    withElectron(() => wc.ev['context-menu']({}, params));
    const tpl = menus[0].tpl;
    assert.ok(menus[0].shown);
    assert.deepStrictEqual(tpl.slice(0, 6).map(i => i.label), ['skriver', 'skrive', 'skrevet', 'skriv', 'skrift', 'skrin']);
    assert.ok(tpl.some(i => i.label === 'Tilføj "skrivr" til ordbogen'));
    assert.ok(tpl.some(i => i.role === 'cut') && tpl.some(i => i.role === 'copy'));
    assert.ok(!tpl.some(i => i.role === 'paste' || /Indsæt/.test(i.label || '')), 'ingen Indsæt');
    // Et valg erstatter ordet (Chromium sender insertReplacementText, som skrivevinduet tæller som tastet)
    tpl[0].click();
    assert.deepStrictEqual(wc.replaced, ['skriver']);
    tpl.find(i => /Tilføj/.test(i.label)).click();
    assert.deepStrictEqual(wc.added, ['skrivr']);
    // Ingen forslag
    withElectron(() => wc.ev['context-menu']({}, Object.assign({}, params, { dictionarySuggestions: [] })));
    assert.strictEqual(menus[1].tpl[0].label, 'Ingen forslag');
    assert.strictEqual(menus[1].tpl[0].enabled, false);
  } finally { cleanup(); }
});

test('zoom: Ctrl +/-/0 inden for -1..3, og niveauet overlever en genstart (store.js writerPrefs)', () => {
  const a = loadWriter();
  try {
    a.w.open();
    const win = a.wins[0];
    const key = (k, extra = {}) => { let stopped = false; win.webContents.ev['before-input-event']({ preventDefault: () => { stopped = true; } }, Object.assign({ type: 'keyDown', control: true, key: k }, extra)); return stopped; };
    assert.strictEqual(key('+'), true);
    assert.strictEqual(win.zoom, 0.5);
    for (let i = 0; i < 10; i++) key('+');
    assert.strictEqual(win.zoom, 3, 'højst 3');
    assert.strictEqual(key('a'), false, 'andre genveje røres ikke');
    assert.strictEqual(key('+', { alt: true }), false, 'AltGr-tegn røres ikke');
    key('0');
    assert.strictEqual(win.zoom, 0);
    for (let i = 0; i < 5; i++) key('-');
    assert.strictEqual(win.zoom, -1, 'mindst -1');
    key('+'); key('+'); key('+');
    assert.strictEqual(win.zoom, 0.5);
    // Tekststørrelse og linjeafstand fra Visning
    assert.deepStrictEqual(a.handlers.get('write:prefs')({}, { lh: 'luftig' }), { zoom: 0.5, size: 16, lh: 'luftig' });
    assert.deepStrictEqual(a.handlers.get('write:prefs')({}, { size: 40 }), { zoom: 0.5, size: 24, lh: 'luftig' });
    // Tilmeldingerne gemmes uden at visningen forsvinder
    a.store.save({ enrollments: [], deviceId: 'abcdefghij' });
    // Genstart: ny Writer læser visningen fra holymoly.json
    const b = loadWriter(a.dir);
    assert.deepStrictEqual(b.w.prefs, { zoom: 0.5, size: 24, lh: 'luftig' });
    b.w.open();
    b.wins[0].webContents.ev['did-finish-load']();
    assert.strictEqual(b.wins[0].zoom, 0.5);
    assert.deepStrictEqual(b.handlers.get('write:state')().prefs, { zoom: 0.5, size: 24, lh: 'luftig' });
  } finally { a.cleanup(); }
});

test('hjælpemidler og øvedokument: aids når skrivevinduet, og et øvedokument sendes aldrig', () => {
  const { w, wins, sent, handlers, cleanup } = loadWriter();
  try {
    w.open();
    w.setAids(['diktering', 'ukendt', 'ordforslag']);
    assert.deepStrictEqual(handlers.get('write:state')().aids, ['ordforslag', 'diktering']);
    assert.deepStrictEqual(wins[0].sent.pop(), ['write:aids', ['ordforslag', 'diktering']]);
    // Øvedokumentet ligger kun i skrivevinduets hukommelse – og hvis det alligevel nåede hertil, sendes det ikke
    const before = sent.length;
    assert.strictEqual(w._send({ id: 'oevedokument', practice: true, title: 'Øvedokument', blocks: [], stats: {} }), false);
    assert.strictEqual(sent.length, before);
    // Prøve-vurderingen: fixable, need, label og at kommer igennem til skrivevinduet
    const pv = w.constructor.cleanPreview({ ok: false, categories: [{ key: 'kort', text: 'Kort.', fixable: true, need: 100 }, { key: 'rod', text: 'Rød.', fixable: false, label: 'AI-side', at: 1_700_000_000_000 }, { key: 'tempo', text: 'Tempo.' }] });
    assert.deepStrictEqual(pv.categories, [
      { key: 'kort', text: 'Kort.', fixable: true, need: 100 },
      { key: 'rod', text: 'Rød.', fixable: false, label: 'AI-side', at: 1_700_000_000_000 },
      { key: 'tempo', text: 'Tempo.', fixable: false },
    ]);
  } finally { cleanup(); }
});

test('skrivevinduet: tastatur, skærmlæser, Visning og øvedokument er på plads', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'agent/renderer/write.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'agent/renderer/write.js'), 'utf8');
  for (const l of ['Fed', 'Kursiv', 'Understreget']) assert.match(html, new RegExp(`aria-label="${l}" aria-pressed="false"`));
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
  assert.match(js, /for \(const id of \['saved', 'preview'\]\) \{ \$\(id\)\.setAttribute\('role', 'status'\); \$\(id\)\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(html, />Visning</);
  assert.match(html, /Tekststørrelse/);
  assert.match(html, /Linjeafstand/);
  assert.match(html, /<script src="\.\.\/src\/doc\.js"><\/script>/);
  assert.match(html, /id="practice"[^>]*>Øv dig</);
  // Knapperne kører på click (mousedown kun for at beholde markeringen), og genvejene findes
  assert.match(js, /b\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\);\n\s*b\.addEventListener\('click'/);
  assert.match(js, /e\.key === '1' \|\| e\.key === '2'/);
  assert.match(js, /e\.code === 'Digit8'/);
  // Afvist tekst: markøren sættes, hvor den var, og eleven får den venlige tekst
  assert.match(js, /setCaret\(snapCaret\)/);
  assert.ok(js.includes("'Det kunne ikke sættes ind her. Bruger du et ordblinde-program eller diktering, så sig det til din lærer.'"));
  // Øvedokumentet gemmes aldrig, kan skrives uden lektion og vurderes lokalt
  assert.match(js, /if \(!doc \|\| doc\.practice \|\| doc\.submitted \|\| !dirty \|\| saving\) return;/);
  assert.match(js, /\(lessonLive \|\| doc\.practice\)/);
  assert.match(js, /D\.evaluateStats\(text, stats, \{ aids \}\)/);
  assert.ok(js.includes("'Øvedokument – forlader aldrig denne computer og slettes, når du lukker vinduet.'"));
  // Prøve-vurderingens tekster
  assert.ok(js.includes('`Bevis: ${Math.min(wordsNow(), c.need || 100)} af ${c.need || 100} ord`'));
  assert.ok(js.includes('Dette dokument kan ikke længere få mærket ('));
  assert.ok(js.includes('Start et nyt dokument, hvis du vil have mærket.'));
  assert.ok(js.includes("'Aflever uden mærke'"));
});

test('tilmelding: "Vælg en kode (4-6 cifre)", "Skriv koden igen" og "Vis kode" – og svage koder fanges i appen', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'agent/renderer/index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'agent/renderer/ui.js'), 'utf8');
  assert.match(html, /id="student-pin"[^>]*placeholder="Vælg en kode \(4-6 cifre\)"/);
  assert.match(html, /id="student-pin2"[^>]*placeholder="Skriv koden igen"/);
  assert.match(html, /id="pin-show"[^>]*>Vis kode</);
  assert.match(html, /<script src="\.\.\/src\/rules\.js"><\/script>/);
  assert.match(ui, /const R = window\.ACRules;/);
  assert.match(ui, /R\.weakPin\(v\)/);
  assert.match(ui, /De to koder er ikke ens/);
  assert.match(ui, /R\.WEAK_PIN_TEXT/);
});
