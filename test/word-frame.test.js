'use strict';
// "Skriv i Word": rammen om Word (word-frame.html) og vinduet, der følger Word (overlay.js).
// Rammen tegnes i Chromium (Playwright) med en attrap af hovedprocessen; skærmbilleder i test-results/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const R = (f) => path.join(__dirname, '..', 'agent', 'renderer', f);
const OUT = path.join(__dirname, '..', 'test-results');

test('word-frame.html: streng CSP, intet inline-script, og de kanaler, preload og overlay.js bruger, passer sammen', () => {
  const html = fs.readFileSync(R('word-frame.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
  assert.ok(!/<script>(?!<\/script>)/.test(html) && !/ on[a-z]+="/.test(html), 'ingen inline-script eller on*-attributter');
  for (const id of ['bar', 'title', 'saved', 'done', 'mole', 'mole-svg', 'bubble', 'bubble-text', 'live', 'panel', 'p-actions']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, />Tekst færdig</);
  const pre = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'frame-preload.js'), 'utf8');
  const ov = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'overlay.js'), 'utf8');
  for (const ch of ['word-frame:view', 'word-frame:interactive', 'word-frame:action']) { assert.ok(pre.includes(`'${ch}'`), ch); assert.ok(ov.includes(`'${ch}'`), ch); }
  const css = fs.readFileSync(R('word-frame.css'), 'utf8');
  assert.match(css, /\.frame \{[^}]*border: 4px solid var\(--blue\)/);
  assert.match(css, /--blue: #2f5bea/);
});

/** overlay.js med en attrap af Electron */
function loadOverlay() {
  const ipc = { on: new Map(), handle: new Map() };
  const wins = [];
  class BrowserWindow {
    constructor(opts) { this.opts = opts; this.visible = false; this.bounds = { x: 0, y: 0, width: 0, height: 0 }; this.ignore = []; this.focusable = []; this.sent = []; this.focusCalls = 0; this.webContents = { send: (c, v) => this.sent.push([c, v]), setWindowOpenHandler() {}, on() {} }; wins.push(this); }
    setAlwaysOnTop() {} setIgnoreMouseEvents(v, o) { this.ignore.push([v, o]); } loadFile(f) { this.file = f; } on() {}
    isDestroyed() { return false; } getBounds() { return this.bounds; } setBounds(b) { this.bounds = b; } setFocusable(v) { this.focusable.push(v); }
    isVisible() { return this.visible; } showInactive() { this.visible = true; } hide() { this.visible = false; } focus() { this.focusCalls++; } isFocused() { return false; } destroy() {}
  }
  const electron = { BrowserWindow, ipcMain: { on: (c, f) => ipc.on.set(c, f), handle: (c, f) => ipc.handle.set(c, f) }, screen: {} };
  const { WordOverlay } = require('../agent/src/word/overlay.js');
  const actions = [];
  const o = new WordOverlay({ electron, onAction: (id) => actions.push(id) });
  return { o, ipc, wins, actions };
}

test('overlay.js: gennemsigtigt, uden ramme, altid øverst, klik går igennem, og følger Word-vinduet', () => {
  const { o, ipc, wins, actions } = loadOverlay();
  o.update({ visible: false });
  assert.strictEqual(wins.length, 0, 'intet vindue, før Word er synligt');
  const view = { visible: true, rect: { x: 100, y: 80, w: 1200, h: 800 }, status: { color: 'green', text: 'Grøn – teksten tæller med' }, bar: { title: 'Stil' }, panel: null };
  o.update(view);
  const w = wins[0];
  assert.strictEqual(w.opts.transparent, true);
  assert.strictEqual(w.opts.frame, false);
  assert.strictEqual(w.opts.alwaysOnTop, true);
  assert.strictEqual(w.opts.focusable, false, 'tager ikke fokus fra Word');
  assert.strictEqual(w.opts.skipTaskbar, true);
  assert.strictEqual(w.opts.webPreferences.contextIsolation, true);
  assert.strictEqual(w.opts.webPreferences.sandbox, true);
  assert.ok(w.file.endsWith(path.join('renderer', 'word-frame.html')));
  assert.deepStrictEqual(w.ignore[0], [true, { forward: true }]);
  assert.deepStrictEqual(w.bounds, { x: 100, y: 80, width: 1200, height: 800 });
  assert.strictEqual(w.visible, true);
  assert.deepStrictEqual(w.sent.pop(), ['word-frame:view', view]);
  // Word flyttes: rammen følger
  o.update(Object.assign({}, view, { rect: { x: 0, y: 0, w: 1920, h: 1040 } }));
  assert.deepStrictEqual(w.bounds, { x: 0, y: 0, width: 1920, height: 1040 });
  // Musen over bjælken/muldvarpen: kun fra rammens egen side
  const sender = w.webContents;
  ipc.on.get('word-frame:interactive')({ sender }, true);
  assert.deepStrictEqual(w.ignore.pop(), [false, { forward: true }]);
  ipc.on.get('word-frame:interactive')({ sender: {} }, false);
  assert.strictEqual(w.ignore.length, 1, 'en anden side kan ikke ændre det');
  ipc.handle.get('word-frame:action')({ sender }, 'done');
  assert.deepStrictEqual(actions, ['done']);
  // En boks med valg: vinduet må tage fokus (tastatur)
  o.update(Object.assign({}, view, { panel: { kind: 'confirm', title: 'X', actions: [{ id: 'continue', label: 'Skriv videre' }] } }));
  assert.strictEqual(w.focusable.pop(), true);
  assert.strictEqual(w.focusCalls, 1);
  // Word i baggrunden eller minimeret: skjult
  o.update({ visible: false, rect: null });
  assert.strictEqual(w.visible, false);
});

/* ---------------------------------------------------------------- Chromium ---------------------------------------------------------------- */
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* ikke installeret */ }

test('rammen tegnes: kant, bjælke, muldvarp med grøn/rød/grå, boble og boksen efter "Tekst færdig"', { skip: !chromium && 'Playwright findes ikke', timeout: 60_000 }, async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return; } // ingen browser i dette miljø
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, bypassCSP: true }); // kun for Word-baggrunden i testen
    await page.addInitScript(() => {
      window.__calls = [];
      window.hmword = {
        view: async () => null,
        onView: (cb) => { window.__push = cb; },
        interactive: (on) => window.__calls.push(['interactive', on]),
        action: async (id) => { window.__calls.push(['action', id]); },
      };
    });
    // En "Word-side" bag rammen, så skærmbilledet viser, hvordan det ser ud oven på Word
    await page.goto('file://' + R('word-frame.html'));
    await page.addStyleTag({ content: 'html { background: repeating-linear-gradient(#fff 0 22px, #f3f4f6 22px 24px) !important; }' });
    const push = (v) => page.evaluate((x) => window.__push(x), v);
    const base = { visible: true, rect: { x: 0, y: 0, w: 1200, h: 800 }, bar: { title: 'Stil om romantikken', saved: 'Gemt kl. 10.14' }, panel: null, busy: false };

    await push(Object.assign({}, base, { status: { color: 'green', symbol: '✓', text: 'Grøn – teksten tæller med', notes: [] } }));
    assert.strictEqual(await page.locator('#mole-svg').getAttribute('data-color'), 'green');
    assert.strictEqual((await page.locator('#bar').innerText()).replace(/\s+/g, ' ').trim(), 'HolyMoly · Stil om romantikken · Gemt kl. 10.14 Tekst færdig');
    assert.strictEqual(await page.locator('#mole').getAttribute('title'), 'Grøn – teksten tæller med');
    assert.strictEqual(await page.locator('#live').innerText(), 'Grøn – teksten tæller med');
    const border = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.frame')); return [s.borderTopWidth, s.borderTopColor, s.pointerEvents]; });
    assert.deepStrictEqual(border, ['4px', 'rgb(47, 91, 234)', 'none']);
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)', 'gennemsigtig');
    assert.ok(await page.locator('.sym-ok').isVisible());
    assert.ok(!(await page.locator('.sym-no').isVisible()));
    await page.screenshot({ path: path.join(OUT, 'word-frame-groen.png') });

    // Rød: klik på muldvarpen viser årsagen i en boble
    await push(Object.assign({}, base, { status: { color: 'red', symbol: '✗', text: 'Rød: tekst indsat fra et andet program kl. 10.14', notes: ['Dokumentet kan ikke få mærket. Du kan skrive et nyt dokument eller gemme dette uden mærke.'] } }));
    assert.ok(await page.locator('.sym-no').isVisible());
    await page.locator('#mole').hover();
    await page.locator('#mole').click();
    assert.ok(await page.locator('#bubble').isVisible());
    assert.strictEqual(await page.locator('#bubble-text').innerText(), 'Rød: tekst indsat fra et andet program kl. 10.14');
    await page.screenshot({ path: path.join(OUT, 'word-frame-roed.png') });
    let calls = await page.evaluate(() => window.__calls);
    assert.ok(calls.some(c => c[0] === 'interactive' && c[1] === true), 'musen over muldvarpen: rammen tager imod klik');

    // Grå
    await push(Object.assign({}, base, { status: { color: 'grey', symbol: '?', text: "Grå: HolyMoly kan ikke se, om Word's AI (Copilot) er slået fra. Spørg skolens IT.", notes: [] } }));
    assert.ok(await page.locator('.sym-q').isVisible());
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('#bubble').isVisible()));
    await page.screenshot({ path: path.join(OUT, 'word-frame-graa.png') });

    // Tekst færdig
    await page.locator('#done').click();
    calls = await page.evaluate(() => window.__calls);
    assert.deepStrictEqual(calls.filter(c => c[0] === 'action'), [['action', 'done']]);

    // Ikke gyldig: årsagerne og valget
    await push(Object.assign({}, base, { status: { color: 'red', symbol: '✗', text: 'Rød: tekst indsat fra et andet program kl. 10.14', notes: [] }, panel: { kind: 'confirm', title: 'Teksten kan ikke få mærket', text: 'Beviset vil mangle, fordi:', items: ['Der er tekst, som ikke er tastet i HolyMoly.'], note: 'Skriver du videre, kan du stadig nå at få mærket.', actions: [{ id: 'continue', label: 'Skriv videre', primary: true }, { id: 'nomark', label: 'Gem uden mærke' }] } }));
    assert.ok(await page.locator('#panel').isVisible());
    assert.deepStrictEqual(await page.locator('#p-actions button').allInnerTexts(), ['Skriv videre', 'Gem uden mærke']);
    assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.textContent), 'Skriv videre', 'fokus på det primære valg');
    await page.screenshot({ path: path.join(OUT, 'word-frame-valg.png') });
    await page.locator('#p-actions button', { hasText: 'Gem uden mærke' }).click();
    calls = await page.evaluate(() => window.__calls);
    assert.deepStrictEqual(calls.filter(c => c[0] === 'action').pop(), ['action', 'nomark']);

    // Gyldig: mærket og "Åbn mappe"
    await push(Object.assign({}, base, { status: { color: 'green', text: 'Grøn – teksten tæller med', notes: [] }, panel: { kind: 'ok', title: 'Teksten er gyldig', mark: '✓ Tastet i Word via HolyMoly – intet indsat · i timen', text: 'Dokumentet er forseglet med mærket og gemt som "Stil om romantikken – forseglet.docx". Det står i Min HolyMoly.', actions: [{ id: 'folder', label: 'Åbn mappe' }, { id: 'mine', label: 'Min HolyMoly' }, { id: 'close', label: 'Luk', primary: true }] } }));
    assert.strictEqual(await page.locator('#p-mark').innerText(), '✓ Tastet i Word via HolyMoly – intet indsat · i timen');
    await page.screenshot({ path: path.join(OUT, 'word-frame-gyldig.png') });
    // Smalt Word-vindue: bjælken og muldvarpen er stadig inden for kanten
    await page.setViewportSize({ width: 700, height: 500 });
    const box = await page.locator('#bar').boundingBox();
    const mole = await page.locator('#mole').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 700, JSON.stringify(box));
    assert.ok(mole.x + mole.width <= 700 && mole.y + mole.height <= 500, JSON.stringify(mole));
  } finally { await browser.close(); }
});
