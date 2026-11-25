'use strict';
// "Skriv i Word" i elev-appen: valget af skrivemåde (hovedvinduet, skrivevinduet, afleveringer, skrivetime) og
// koblingen til Electron (agent/src/word/app.js) med en attrap af Electron.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const A = (...p) => path.join(__dirname, '..', 'agent', ...p);
const read = (...p) => fs.readFileSync(A(...p), 'utf8');

test('valget af skrivemåde: knapperne findes i hovedvinduet og skrivevinduet, og broerne passer sammen', () => {
  const idx = read('renderer', 'index.html');
  assert.match(idx, /id="write"[^>]*>Skriv i HolyMoly</);
  assert.match(idx, /id="write-word"[^>]*hidden>Skriv i Word</);
  assert.match(idx, /id="mine"[^>]*>Min HolyMoly</);
  const ui = read('renderer', 'ui.js');
  assert.match(ui, /\$\('write-word'\)\.hidden = !s\.word;/, 'kun når Word findes');
  assert.match(ui, /window\.hm\.action\('word'\)/);
  const main = read('src', 'main.js');
  assert.match(main, /word: !!state\.wordAvailable/);
  assert.match(main, /if \(id === 'word'\) return word \? word\.manager\.start\(\{\}\)/);
  assert.match(main, /if \(word\) word\.manager\.onMessage\(msg\);/);
  assert.match(read('renderer', 'write.html'), /<script src="word-writer\.js"><\/script>/);
  const pre = read('src', 'write-preload.js');
  for (const ch of ['word:info', 'word:start', 'word:write-lesson', 'word:mine']) {
    assert.ok(pre.includes(`'${ch}'`), ch);
    assert.ok(read('src', 'word', 'app.js').includes(`'${ch}'`), ch);
  }
  // Pakningen tager agent/src/word med (word.ps1 læses af Node og sendes til PowerShell – virker også fra app.asar)
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('src/**/*') && pkg.build.files.includes('renderer/**/*'));
});

test('app.js: kobler Word-tilstanden til Electron (IPC, Dokumenter/HolyMoly, falsk Word under udvikling)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordapp-'));
  const handlers = new Map();
  class BrowserWindow {
    constructor() { this.webContents = { send() {}, setWindowOpenHandler() {}, on() {} }; this.b = {}; }
    removeMenu() {} loadFile() {} on() {} isDestroyed() { return false; } show() {} focus() {} setAlwaysOnTop() {} setIgnoreMouseEvents() {}
    getBounds() { return this.b; } setBounds(b) { this.b = b; } setFocusable() {} isVisible() { return false; } showInactive() {} hide() {} destroy() {} isFocused() { return false; }
  }
  const electron = {
    app: { isPackaged: false, getPath: (k) => path.join(dir, k) },
    BrowserWindow, ipcMain: { handle: (c, f) => handlers.set(c, f), on() {} }, screen: {}, clipboard: { readText: () => '', availableFormats: () => [], clear() {} }, shell: { showItemInFolder() {} },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
  const file = require.resolve('../agent/src/word/app.js');
  delete require.cache[file];
  process.env.HOLYMOLY_WORD_FAKE = '1';
  let createWordMode;
  try { ({ createWordMode } = require(file)); } finally { Module._load = orig; }
  try {
    const writer = { writeAsg: { assignmentId: 7, title: 'Stil' }, _summary: () => [{ id: 'h1', title: 'K', submitted: 0 }], _get: () => ({ updated: 5 }), open() { this.opened = true; } };
    const w = createWordMode({ send: () => true, lessonActive: () => true, online: () => true, serverUrl: () => 'https://holymoly.test', writer: () => writer });
    assert.deepStrictEqual(await handlers.get('word:info')(), { supported: true, word: true, available: true }, 'falsk Word under udvikling');
    assert.deepStrictEqual(await handlers.get('word:write-lesson')(), { assignmentId: 7, title: 'Stil' });
    assert.strictEqual(w.manager.o.dir, path.join(dir, 'documents', 'HolyMoly'));
    const r = await handlers.get('word:start')({}, { assignmentId: 0 });
    assert.ok(r.ok, r.error);
    assert.ok(fs.existsSync(w.manager.get(r.id).path));
    w.openWriter('h1');
    assert.deepStrictEqual([writer.opened, writer.pendingOpen], [true, 'h1']);
    w.manager.stop();
  } finally {
    delete process.env.HOLYMOLY_WORD_FAKE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* */ }
test('skrivevinduet: "Skriv i Word" øverst, ved afleveringerne og under skrivetimens banner', { skip: !chromium && 'Playwright findes ikke', timeout: 60_000 }, async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.addInitScript(() => {
      window.__word = [];
      const asg = [{ id: 7, title: 'Stil om romantikken', className: '2.g', due: 0, home: false, submission: null }];
      const doc = { id: 'd1', title: '', blocks: [], stats: {}, submitted: 0 };
      const fixed = {
        state: async () => ({ lesson: true, docs: [{ id: 'd1', title: '', submitted: 0 }], labels: { base: 'x', lektion: 'x', hjemme: 'x' }, writeLesson: { assignmentId: 7, title: 'Stil om romantikken' }, openId: '' }),
        create: async () => ({ id: 'd1' }), load: async () => doc, save: async () => ({ ok: true }), assignments: async () => asg,
        wordInfo: async () => ({ supported: true, word: true, available: true }), wordWriteLesson: async () => ({ assignmentId: 7, title: 'Stil om romantikken' }),
        word: async (id) => { window.__word.push(id); return { ok: true }; }, mine: async () => { window.__word.push('mine'); },
      };
      window.hmw = new Proxy(fixed, { get: (o, k) => (k in o ? o[k] : (String(k).startsWith('on') ? () => {} : async () => ({ ok: true }))) });
    });
    await page.goto('file://' + A('renderer', 'write.html'));
    await page.waitForSelector('#word-new:not([hidden])');
    assert.ok(await page.locator('#word-mine').isVisible());
    assert.ok(await page.locator('#word-choice').isVisible(), 'skrivetime: valget under banneret');
    await page.locator('#word-choice button').click();
    await page.locator('#asg-btn').click();
    await page.waitForSelector('#asg-list li[data-asg="7"] .word-btn');
    await page.locator('#asg-list li[data-asg="7"] .word-btn').click();
    await page.locator('#word-new').click();
    await page.locator('#word-mine').click();
    assert.deepStrictEqual(await page.evaluate(() => window.__word), [7, 7, 0, 'mine']);
  } finally { await browser.close(); }
});
