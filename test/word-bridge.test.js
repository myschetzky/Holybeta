'use strict';
// "Skriv i Word": broens JSON-protokol (med den falske Word som rigtig underproces), forseglingen og tjek-siden.
// Word og PowerShell findes ikke her – word.ps1 tjekkes kun statisk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WordBridge, asciiJson } = require('../agent/src/word/bridge.js');
const { wordLikeDocx, FakeWordBridge } = require('../agent/src/word/bridge-fake.js');
const S = require('../agent/src/word/seal.js');
const D = require('../shared/doc.js');

const FAKE = path.join(__dirname, '..', 'agent', 'src', 'word', 'bridge-fake.js');
const fakeBridge = (opts = {}) => new WordBridge(Object.assign({ command: process.execPath, args: [FAKE] }, opts));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hm-wordbridge-'));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

test('broen findes kun på Windows: andre platforme svarer { supported: false }', async () => {
  const b = new WordBridge({ platform: 'linux' });
  assert.strictEqual(b.supported, false);
  assert.deepStrictEqual(await b.probe(), { supported: false, word: false });
  const r = await b.state();
  assert.deepStrictEqual([r.ok, r.supported], [false, false]);
  assert.strictEqual(new WordBridge({ platform: 'win32' }).supported, true);
  assert.match(new WordBridge({ platform: 'win32' }).args.join(' '), /-STA .*-EncodedCommand/);
});

test('protokollen: open, state, save, seal og close gennem en underproces – også med æøå og ✓', async () => {
  const dir = tmp();
  const b = fakeBridge();
  try {
    assert.deepStrictEqual(await b.probe(), { supported: true, word: true, version: '16.0' });
    const file = path.join(dir, 'Æbler og pærer.docx');
    const o = await b.open(file, true);
    assert.deepStrictEqual([o.ok, o.path], [true, file]);
    assert.ok(fs.existsSync(file), 'Word gemmer det nye dokument med det samme');
    await b.request('fake:type', { text: 'Romantikken – følelser ✓ og natur.\rAndet afsnit med\ttabulator.' });
    let s = await b.state();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.open, true);
    assert.strictEqual(s.text, 'Romantikken – følelser ✓ og natur.\rAndet afsnit med\ttabulator.\r');
    assert.deepStrictEqual(s.rect, { x: 100, y: 80, w: 1200, h: 800 });
    assert.deepStrictEqual([s.saved, s.foreground, s.copilot], [false, true, 'off']);
    const sv = await b.save();
    assert.deepStrictEqual([sv.ok, sv.path, sv.saved], [true, file, true]);
    // Forsegl: sidefod + læsebeskyttelse, gemt under et nyt navn, dokumentet lukkes
    const sealedPath = path.join(dir, 'Æbler og pærer – forseglet.docx');
    const lines = D.footerLines({ code: 'HM-ABCDEFGH', url: 'https://holymoly.test/bevis/x', place: 'lektion', observed: ['word', 'vagt'] }, 9);
    const r = await b.seal({ footerLines: lines, green: true, password: 'hemmelig', path: sealedPath });
    assert.deepStrictEqual([r.ok, r.path], [true, sealedPath]);
    s = await b.state();
    assert.strictEqual(s.open, false, 'dokumentet er lukket efter forseglingen');
    // Den forseglede fil: samme brødtekst som det gemte dokument, sidefoden er ikke brødtekst, og den er læsebeskyttet
    const blocks = await S.docxBlocks(fs.readFileSync(file));
    const text = S.textOfBlocks(blocks);
    assert.strictEqual(text, 'Romantikken – følelser ✓ og natur.\nAndet afsnit med tabulator.');
    const v = await S.verifySealed(fs.readFileSync(sealedPath), sha(text));
    assert.deepStrictEqual([v.ok, v.protected, v.text], [true, true, text]);
    assert.strictEqual((await b.close()).ok, true);
  } finally { b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('protokollen: Word svarer ikke (timeout), broen stopper og starter igen, ingen Word på computeren', async () => {
  const b = fakeBridge({ timeoutMs: 300 });
  try {
    const r = await b.request('fake:hang');
    assert.deepStrictEqual([r.ok, r.timeout, r.error], [false, true, 'Word svarer ikke']);
    let exited = false;
    b.on('exit', () => { exited = true; });
    const dead = await b.request('fake:exit', {}, 2000);
    assert.deepStrictEqual([dead.ok, dead.error], [false, 'Word-broen stoppede']);
    assert.strictEqual(exited, true);
    // Næste forespørgsel starter broen igen
    const s = await b.state();
    assert.deepStrictEqual([s.ok, s.open], [true, false]);
    const u = await b.request('fake:ukendt');
    assert.deepStrictEqual([u.ok, u.error], [false, 'Ukendt kommando']);
  } finally { b.stop(); }
  const none = fakeBridge({ env: Object.assign({}, process.env, { HM_FAKE_NO_WORD: '1' }) });
  try { assert.deepStrictEqual(await none.probe(), { supported: true, word: false, version: '16.0' }); } finally { none.stop(); }
});

test('asciiJson: kun ASCII på ledningen, og JSON.parse giver den samme tekst', () => {
  const o = { text: 'Æ ø å – ✓ 😀', path: 'C:\\Brugere\\Ånd' };
  const j = asciiJson(o);
  assert.ok(/^[\x00-\x7f]*$/.test(j), j);
  assert.deepStrictEqual(JSON.parse(j), o);
});

test('tjek-siden kan tjekke den forseglede fil: Word-lignende .docx med deflate, overskrifter, lister, linjeskift og titel', async () => {
  const paras = [
    { text: 'Min stil om romantikken', style: 'Titel' },
    { text: 'Indledning', style: 'Overskrift1' },
    'Romantikken var en periode i kunsten,\vhvor følelser fik plads.',
    { text: 'Første punkt', style: 'Listeafsnit' },
    'Afslutning\tmed tabulator & tegn <som> skal escapes.',
  ];
  const draft = wordLikeDocx(paras);
  const blocks = await S.docxBlocks(draft);
  assert.deepStrictEqual(blocks.map(b => b.t), ['p', 'h1', 'p', 'p', 'p']);
  const text = S.textOfBlocks(blocks);
  const proof = sha(text);
  const lines = D.footerLines({ code: 'HM-12345678', url: 'https://holymoly.test/bevis/abc', place: 'hjemme', observed: ['word'], test: true }, D.wordCount(text));
  const sealed = wordLikeDocx(paras, { footerLines: lines, protect: true });
  const v = await S.verifySealed(sealed, proof);
  assert.strictEqual(v.ok, true, 'brødteksten giver samme sha256 som beviset');
  assert.strictEqual(v.protected, true);
  // Præcis som bevis.js: readZipEntry + docxText + første variant med samme hash
  const xml = await D.readZipEntry(sealed, 'word/document.xml', S.inflateRaw);
  const doc = D.docxText(new TextDecoder().decode(xml));
  assert.ok(doc.variants.some(x => sha(x) === proof));
  assert.ok(!doc.variants.some(x => /Tastet i Word|HM-12345678/.test(x)), 'sidefoden er ikke brødtekst');
  // Ændret tekst passer ikke
  const tampered = wordLikeDocx(paras.map(p => (typeof p === 'string' ? p.replace('følelser', 'fornuft') : p)), { footerLines: lines, protect: true });
  assert.strictEqual((await S.verifySealed(tampered, proof)).ok, false);
  assert.strictEqual((await S.verifySealed(wordLikeDocx(paras), proof)).protected, false);
});

test('footerFor: samme linjer som HolyMolys egen Word-fil, grøn kun med vagten og uden testserver', () => {
  const res = { certId: 'abcdefghijklmnop', facts: { place: 'lektion' }, observed: ['word', 'vagt'], test: false };
  const f = S.footerFor(res, 'https://holymoly.test/bevis/abcdefghijklmnop', 250);
  assert.deepStrictEqual(f.lines, [
    '✓ Tastet i Word via HolyMoly – intet indsat · i timen',
    'HolyMoly HM-ABCDEFGH  ·  Tjek: https://holymoly.test/bevis/abcdefghijklmnop',
    D.LIMIT_TEXT + ' 250 ord.',
  ]);
  assert.strictEqual(f.green, true);
  assert.strictEqual(S.footerFor(Object.assign({}, res, { observed: ['word'] }), '', 1).green, false);
  assert.strictEqual(S.footerFor(Object.assign({}, res, { test: true }), '', 1).lines[3], D.TEST_TEXT);
});

test('filnavne: Windows-sikre navne og første ledige navn', () => {
  assert.strictEqual(S.safeName('Stil: "Romantik"/del 1?'), 'Stil Romantikdel 1');
  assert.strictEqual(S.safeName('  '), 'Dokument');
  assert.strictEqual(S.safeName('CON'), 'CON_');
  assert.strictEqual(S.safeName('Slut. '), 'Slut');
  const taken = new Set([path.join('/d', 'Stil.docx'), path.join('/d', 'Stil (2).docx')]);
  assert.strictEqual(S.freePath('/d', 'Stil', (p) => taken.has(p)), path.join('/d', 'Stil (3).docx'));
  assert.deepStrictEqual(S.paths('/d', 'Stil', (p) => taken.has(p)), { draft: path.join('/d', 'Stil (3).docx'), sealed: path.join('/d', 'Stil – forseglet.docx') });
});

test('FakeWordBridge (i samme proces) har samme metoder som WordBridge', async () => {
  const fb = new FakeWordBridge();
  for (const m of ['start', 'probe', 'open', 'state', 'save', 'seal', 'close', 'request', 'stop']) assert.strictEqual(typeof fb[m], 'function', m);
  for (const m of ['start', 'probe', 'open', 'state', 'save', 'seal', 'close', 'request', 'stop']) assert.strictEqual(typeof WordBridge.prototype[m], 'function', m);
  assert.deepStrictEqual(await fb.state(), { ok: true, open: false });
});

test('word.ps1 (statisk – kan ikke køres her): kommandoerne, Copilot-politikkerne og forseglingen', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'word.ps1'), 'utf8');
  for (const c of ['probe', 'open', 'state', 'save', 'seal', 'close']) assert.match(ps, new RegExp(`'${c}' \\{`), c);
  assert.match(ps, /Software\\Policies\\Microsoft\\office\\16\.0\\common\\privacy/);
  assert.match(ps, /'disconnectedstate'/);
  assert.match(ps, /'usercontentdisabled'/);
  assert.match(ps, /\$d\.Protect\(3, \$false, /, 'wdAllowOnlyReading med adgangskode');
  assert.match(ps, /SaveAs2\(\$p, 16\)/);
  assert.match(ps, /GetWindowRect/);
  assert.match(ps, /DwmGetWindowAttribute/);
  assert.match(ps, /Send @\{ ready = \$true/);
  assert.ok(ps.includes("'[^\\x00-\\x7F]'"), 'svar kun i ASCII');
  // Balancerede klammer (en grov syntaks-kontrol)
  const code = ps.replace(/'[^'\n]*'/g, "''").replace(/#.*$/gm, '');
  for (const [a, b] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.strictEqual(code.split(a).length, code.split(b).length, a + b);
  // Word lukkes kun, når der ikke er andre dokumenter åbne
  assert.match(ps, /if \(\$script:word\.Documents\.Count -eq 0\) \{ \$script:word\.Quit\(\)/);
});
