'use strict';
// "Min HolyMoly": elevens dokumenter fra skrivevinduet og Word i én liste (mine.js, mine-window.js, word-mine.html).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../agent/src/word/mine.js');
const { MineWindow } = require('../agent/src/word/mine-window.js');
const { WordManager } = require('../agent/src/word/manager.js');
const { FakeWordBridge } = require('../agent/src/word/bridge-fake.js');

const WORD_LABEL = '✓ Tastet i Word via HolyMoly – intet indsat · i timen';
const assignments = [
  { id: 1, title: 'Stil om romantikken', due: 0, submission: { docId: 'w2' } },
  { id: 2, title: 'Novelleanalyse', due: Date.UTC(2026, 0, 10), submission: null },
];

test('items(): Word- og HolyMoly-dokumenter med status, knapper og aflevering – nyeste først', () => {
  const list = M.items({
    wordDocs: [
      { id: 'w1', title: 'Påbegyndt', submitted: 0, updated: 50, words: 12, open: false, path: 'C:/d/Påbegyndt.docx' },
      { id: 'w2', title: 'Forseglet', submitted: 90, updated: 90, words: 300, certId: 'abc', label: WORD_LABEL, sealedPath: 'C:/d/F – forseglet.docx', verified: true },
      { id: 'w3', title: '', submitted: 70, updated: 70, certId: null, label: '' },
      { id: 'w4', title: 'Åben nu', submitted: 0, updated: 10, open: true },
      { id: 'w5', title: 'Fejl', submitted: 60, updated: 60, certId: 'x', label: WORD_LABEL, sealError: 'Word kunne ikke forsegle dokumentet: optaget' },
    ],
    writerDocs: [
      { id: 'h1', title: 'Kladde', submitted: 0, updated: 80, words: 40 },
      { id: 'h2', title: 'Med mærke', submitted: 40, certId: 'c', label: '✓ Tastet i HolyMoly – intet indsat · i timen', updated: 40 },
    ],
    assignments,
  });
  assert.deepStrictEqual(list.map(x => x.key), ['word:w2', 'holymoly:h1', 'word:w3', 'word:w5', 'word:w1', 'holymoly:h2', 'word:w4']);
  const by = Object.fromEntries(list.map(x => [x.key, x]));
  assert.deepStrictEqual([by['word:w1'].status, by['word:w1'].actions], ['Påbegyndt i Word', ['continue', 'folder']]);
  assert.deepStrictEqual([by['word:w4'].status, by['word:w4'].actions], ['Åben i Word', ['folder']]);
  assert.deepStrictEqual([by['word:w2'].status, by['word:w2'].kind, by['word:w2'].actions], [WORD_LABEL + ' · forseglet', 'maerke', ['folder', 'attach']]);
  assert.strictEqual(by['word:w2'].attachedTo, 'Stil om romantikken');
  assert.deepStrictEqual([by['word:w3'].title, by['word:w3'].status, by['word:w3'].kind], ['Uden titel', 'Afsluttet uden mærke', 'uden']);
  assert.strictEqual(by['word:w5'].status, WORD_LABEL, 'ikke forseglet: ingen "forseglet"');
  assert.match(by['word:w5'].note, /kunne ikke forsegle/);
  assert.deepStrictEqual([by['holymoly:h1'].status, by['holymoly:h1'].actions], ['Kladde i HolyMoly', ['writer']]);
  assert.deepStrictEqual([by['holymoly:h2'].sourceText, by['holymoly:h2'].actions], ['HolyMoly', ['writer', 'attach']]);
});

test('attachTargets(): kun afsluttede dokumenter, og den aflevering, dokumentet allerede er afleveret til, er markeret', () => {
  const list = M.items({ wordDocs: [{ id: 'w2', title: 'F', submitted: 1, certId: 'a', label: 'x' }, { id: 'w1', title: 'K', submitted: 0 }], assignments });
  const t = M.attachTargets(assignments, list.find(x => x.id === 'w2'), Date.UTC(2026, 5, 1));
  assert.deepStrictEqual(t.map(x => [x.id, x.current, x.late]), [[1, true, false], [2, false, true]]);
  assert.match(t[1].text, /^Novelleanalyse \(frist /);
  assert.deepStrictEqual(M.attachTargets(assignments, list.find(x => x.id === 'w1')), []);
  assert.deepStrictEqual(M.ACTION_TEXT, { continue: 'Fortsæt i Word', folder: 'Åbn mappe', attach: 'Vedhæft til aflevering', writer: 'Åbn i HolyMoly' });
});

function rigWindow(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const word = new WordManager({ bridge: new FakeWordBridge(), autoTick: false, send: (m) => { sent.push(m); return true; }, lessonActive: () => true, online: () => true, serverUrl: 'https://holymoly.test', dir: path.join(dir, 'docs'), dataDir: path.join(dir, 'data') });
  word.onMessage({ type: 'assignments', items: [{ id: 7, title: 'Stil', home: false }] });
  const handlers = new Map();
  const wins = [];
  class BrowserWindow {
    constructor(o) { this.opts = o; this.sent = []; this.webContents = { send: (c) => this.sent.push(c), setWindowOpenHandler() {}, on() {} }; wins.push(this); }
    removeMenu() {} loadFile(f) { this.file = f; } on() {} isDestroyed() { return false; } show() {} focus() {}
  }
  const opened = [], folders = [];
  const mw = new MineWindow({ electron: { BrowserWindow, ipcMain: { handle: (c, f) => handlers.set(c, f) } }, src: { word, writerDocs: () => [{ id: 'h1', title: 'Fra skrivevinduet', submitted: 5, certId: 'c', label: 'L', updated: 5 }], openWriter: (id) => opened.push(id), showInFolder: (p) => folders.push(p) } });
  return { mw, word, sent, handlers, wins, opened, folders };
}

test('Min HolyMoly-vinduet: liste, Skriv i Word, Åbn mappe, Åbn i HolyMoly og Vedhæft – kun fra sin egen side', async (t) => {
  const r = rigWindow(t);
  r.mw.open();
  const w = r.wins[0];
  assert.ok(w.file.endsWith(path.join('renderer', 'word-mine.html')));
  assert.strictEqual(w.opts.webPreferences.sandbox, true);
  const ev = { sender: w.webContents };
  assert.strictEqual(await r.handlers.get('mine:state')({ sender: {} }), null, 'en anden side får intet');
  let s = await r.handlers.get('mine:state')(ev);
  assert.deepStrictEqual(s.word, { available: true, supported: true, active: false });
  assert.deepStrictEqual(s.items.map(x => x.key), ['holymoly:h1']);
  assert.deepStrictEqual(s.assignments.map(a => a.title), ['Stil']);
  // Skriv i Word (til afleveringen)
  const st = await r.handlers.get('mine:action')(ev, { id: 'word', assignmentId: 7 });
  assert.ok(st.ok, st.error);
  assert.ok(w.sent.includes('mine:changed'));
  s = await r.handlers.get('mine:state')(ev);
  assert.strictEqual(s.word.active, true);
  const it = s.items.find(x => x.source === 'word');
  assert.deepStrictEqual([it.title, it.status], ['Stil', 'Åben i Word']);
  // Åbn mappe
  await r.handlers.get('mine:action')(ev, { id: 'folder', key: it.key });
  assert.deepStrictEqual(r.folders, [r.word.get(it.id).path]);
  // Åbn i HolyMoly
  await r.handlers.get('mine:action')(ev, { id: 'writer', key: 'holymoly:h1' });
  assert.deepStrictEqual(r.opened, ['h1']);
  // Vedhæft et HolyMoly-dokument: samme besked som skrivevinduet
  const p = r.handlers.get('mine:action')(ev, { id: 'attach', key: 'holymoly:h1', assignmentId: 7 });
  await new Promise(res => setImmediate(res));
  assert.deepStrictEqual(r.sent.filter(m => m.type === 'assignment-attach'), [{ type: 'assignment-attach', assignmentId: 7, docId: 'h1' }]);
  r.word.onMessage({ type: 'assignment-result', assignmentId: 7, ok: true });
  assert.deepStrictEqual(await p, { ok: true, error: '' });
  // Et Word-dokument, der ikke er færdigt, kan ikke vedhæftes
  assert.match((await r.handlers.get('mine:action')(ev, { id: 'attach', key: it.key, assignmentId: 7 })).error, /Tekst færdig/);
  assert.strictEqual((await r.handlers.get('mine:action')(ev, { id: 'xx' })).ok, false);
  r.word.stop();
});

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* */ }
test('word-mine.html tegnes med listen og knapperne', { skip: !chromium && 'Playwright findes ikke', timeout: 60_000 }, async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return; }
  try {
    const page = await browser.newPage({ viewport: { width: 780, height: 640 } });
    const list = M.items({
      wordDocs: [{ id: 'w2', title: 'Stil om romantikken', submitted: 90, updated: Date.now(), words: 312, certId: 'abc', label: WORD_LABEL, sealedPath: 'x', verified: true }, { id: 'w1', title: 'Novelle', submitted: 0, updated: Date.now() - 1000, words: 85 }],
      writerDocs: [{ id: 'h1', title: 'Digtanalyse', submitted: 0, updated: Date.now() - 5000, words: 40 }], assignments,
    }).map(it => Object.assign(it, { targets: M.attachTargets(assignments, it) }));
    await page.addInitScript((state) => {
      window.__acts = [];
      window.hmmine = { state: async () => state, action: async (a) => { window.__acts.push(a); return { ok: true }; }, onChange() {} };
    }, { word: { available: true, active: false }, items: list, assignments: [], texts: M.ACTION_TEXT });
    await page.goto('file://' + path.join(__dirname, '..', 'agent', 'renderer', 'word-mine.html'));
    await page.waitForSelector('#list li[data-key]');
    assert.deepStrictEqual(await page.locator('header .btn').allInnerTexts(), ['Skriv i HolyMoly', 'Skriv i Word']);
    assert.deepStrictEqual(await page.locator('#list li .t').allInnerTexts(), ['Stil om romantikken', 'Novelle', 'Digtanalyse']);
    assert.strictEqual(await page.locator('li[data-key="word:w2"] .st').innerText(), WORD_LABEL + ' · forseglet');
    assert.strictEqual(await page.locator('li[data-key="word:w2"]').getByText('Afleveret til "Stil om romantikken"').count(), 1);
    await page.locator('li[data-key="word:w1"] button', { hasText: 'Fortsæt i Word' }).click();
    await page.locator('li[data-key="word:w2"] button', { hasText: 'Vedhæft til aflevering' }).click();
    await page.locator('#new-word').click();
    assert.deepStrictEqual(await page.evaluate(() => window.__acts), [{ id: 'continue', key: 'word:w1' }, { id: 'attach', key: 'word:w2', assignmentId: 1 }, { id: 'word' }]);
    fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'min-holymoly.png'), fullPage: true });
  } finally { await browser.close(); }
});
