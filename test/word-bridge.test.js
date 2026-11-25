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
  const res = { certId: 'abcdefghijklmnop', facts: { place: 'lektion' }, observed: ['word', 'taster', 'vagt'], test: false };
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

/* ---------------------------------------------------------------- tastetælleren ---------------------------------------------------------------- */
const { KeysHelper, cleanKeys } = require('../agent/src/word/keys.js');
const fakeKeys = (env = {}) => () => new KeysHelper({ command: process.execPath, args: [FAKE, '--keys'], env: Object.assign({}, process.env, env), readyMs: 3000 });
const until = async (f, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 30)); } };

test('falsk Word: state har tastetællerne – tegn, Ctrl+V, tekst uden tastetryk, injicerede taster, slet – og kun i forgrunden', async () => {
  const dir = tmp();
  const b = fakeBridge();
  try {
    const o = await b.open(path.join(dir, 'Taster.docx'), true);
    assert.strictEqual(o.ok, true);
    assert.ok(!('hwnd' in o), 'hwnd sendes ikke videre');
    let s = await b.state();
    assert.ok(!('hwnd' in s));
    assert.deepStrictEqual(s.keys, { typed: 0, deleted: 0, pasteKeys: 0, injected: 0, undo: 0, keystrokes: 0, maxCps: 0, burst: 0, fastShare: 0, regularity: null });
    await b.request('fake:type', { text: 'Hej æble' });
    await b.request('fake:paste', { text: ' indsat' });
    await b.request('fake:insert', { text: ' fra Copilot' });
    await b.request('fake:inject', { text: 'abc' });
    await b.request('fake:delete', { chars: 3 });
    s = await b.state();
    assert.strictEqual(s.text, 'Hej æble indsat fra Copilot\r');
    assert.deepStrictEqual([s.keys.typed, s.keys.keystrokes, s.keys.pasteKeys, s.keys.injected, s.keys.deleted], [8, 8, 1, 3, 3]);
    // Word i baggrunden: intet tælles
    await b.request('fake:set', { foreground: false });
    await b.request('fake:type', { text: 'skjult' });
    await b.request('fake:set', { foreground: true });
    assert.strictEqual((await b.state()).keys.typed, 8);
    await b.request('fake:keys', { maxCps: 6.4, burst: 9, undo: 2, regularity: 0.5 });
    s = await b.state();
    assert.deepStrictEqual([s.keys.maxCps, s.keys.burst, s.keys.undo, s.keys.regularity], [6.4, 9, 2, 0.5]);
    // Ny økt: nye tællere
    await b.close(true);
    await b.open(path.join(dir, 'Taster.docx'), false);
    assert.strictEqual((await b.state()).keys.typed, 0);
    // Tastetryk kan ikke tælles: keys: null
    await b.request('fake:set', { keys: false });
    assert.strictEqual((await b.state()).keys, null);
  } finally { b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tastetælleren som egen proces: startes med økten, får Word-vinduets hwnd, kun tal kommer videre, stoppes med økten', async () => {
  const dir = tmp();
  const helpers = [];
  const make = fakeKeys();
  const b = fakeBridge({ env: Object.assign({}, process.env, { HM_FAKE_KEYS: 'none' }), keys: () => { const h = make(); helpers.push(h); return h; } });
  try {
    assert.strictEqual((await b.open(path.join(dir, 'A.docx'), true)).ok, true);
    assert.strictEqual(helpers.length, 1, 'tælleren startes, når økten åbner');
    const s = await until(async () => { const x = await b.state(); return 'keys' in x ? x : null; });
    assert.ok(s, 'tællerne kommer, når tælleren er klar');
    assert.strictEqual(s.keys.typed, 0);
    // Den falske tæller giver kun tal, når den har fået et hwnd – og sender et ekstra felt, som skal smides væk
    helpers[0].child.stdin.write(JSON.stringify({ id: 9999, cmd: 'fake:keys', typed: 42, deleted: 3, pasteKeys: 1, regularity: 0.4 }) + '\n');
    const k = await until(async () => { const x = await b.state(); return x.keys && x.keys.typed === 42 ? x.keys : null; });
    assert.deepStrictEqual(k, { typed: 42, deleted: 3, pasteKeys: 1, injected: 0, undo: 0, keystrokes: 0, maxCps: 0, burst: 0, fastShare: 0, regularity: 0.4 });
    assert.ok(!('vkCode' in k), 'ukendte felter (fx en tast) kommer aldrig videre');
    // Økten slutter: tælleren stopper
    const child = helpers[0].child;
    await b.close(true);
    assert.strictEqual(b.keys, null);
    assert.strictEqual(helpers[0].state, 'off');
    await until(() => child.exitCode !== null || child.signalCode !== null);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'processen er stoppet');
    // Ny økt: en ny tæller (nye tal)
    await b.open(path.join(dir, 'A.docx'), false);
    assert.strictEqual(helpers.length, 2);
    const s2 = await until(async () => { const x = await b.state(); return 'keys' in x ? x : null; });
    assert.strictEqual(s2.keys.typed, 0);
    // Dokumentet lukkes i Word: tælleren stopper
    await b.request('fake:set', { open: false });
    assert.strictEqual((await b.state()).open, false);
    assert.strictEqual(b.keys, null);
  } finally { b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tastetælleren: hooken kan ikke installeres -> keys: null; starter stadig -> intet keys-felt; stopper midt i -> null', async () => {
  const dir = tmp();
  let b = fakeBridge({ env: Object.assign({}, process.env, { HM_FAKE_KEYS: 'none' }), keys: fakeKeys({ HM_FAKE_NO_HOOK: '1' }) });
  try {
    await b.open(path.join(dir, 'B.docx'), true);
    const s = await until(async () => { const x = await b.state(); return 'keys' in x ? x : null; });
    assert.strictEqual(s.keys, null, 'Tastetryk kan ikke tælles på denne computer');
  } finally { b.stop(); }
  b = fakeBridge({ env: Object.assign({}, process.env, { HM_FAKE_KEYS: 'none' }), keys: fakeKeys({ HM_FAKE_KEYS_DELAY: '1500' }) });
  try {
    await b.open(path.join(dir, 'C.docx'), true);
    const s = await b.state();
    assert.strictEqual(s.ok, true);
    assert.ok(!('keys' in s), 'mens tælleren starter, ved broen det ikke endnu');
    const k = await until(async () => { const x = await b.state(); return 'keys' in x ? x : null; });
    assert.ok(k && k.keys && k.keys.typed === 0);
    // Tælleren stopper midt i økten (fx stoppet af antivirus): null
    b.keys.child.stdin.write(JSON.stringify({ id: 1, cmd: 'fake:exit' }) + '\n');
    const gone = await until(async () => { const x = await b.state(); return x.keys === null ? x : null; });
    assert.ok(gone, 'keys: null, når tælleren er væk');
  } finally { b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tastetælleren: kun på Windows som standard, aldrig med en anden Word-proces, og cleanKeys tager kun tal', () => {
  assert.strictEqual(typeof new WordBridge({ platform: 'win32' }).makeKeys, 'function');
  assert.strictEqual(new WordBridge({ platform: 'win32', keys: false }).makeKeys, null);
  assert.strictEqual(fakeBridge().makeKeys, null, 'en anden Word-proces (fx den falske) leverer selv keys');
  assert.deepStrictEqual(cleanKeys({ typed: '5', deleted: -2, vkCode: 65, key: 'a', regularity: -1, maxCps: 'x' }), { typed: 5, deleted: 0, pasteKeys: 0, injected: 0, undo: 0, keystrokes: 0, maxCps: 0, burst: 0, fastShare: 0, regularity: null });
  assert.strictEqual(cleanKeys(null), null);
});

test('keys.ps1 (statisk – kan ikke køres her): hooken sender altid tasten videre, tæller kun i Word-vinduet og gemmer aldrig hvilke taster', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'keys.ps1'), 'utf8');
  const cs = ps.slice(ps.indexOf("@'"), ps.indexOf("'@"));
  assert.ok(cs.length > 1000, 'C#-koden findes');
  // Lavniveau-tastaturhook med egen beskedløkke på sin egen tråd
  assert.match(cs, /SetWindowsHookEx\(WH_KEYBOARD_LL, proc, /);
  assert.match(cs, /const int WH_KEYBOARD_LL = 13;/);
  assert.match(cs, /while \(GetMessage\(out m, IntPtr\.Zero, 0, 0\) > 0\)/);
  assert.match(cs, /UnhookWindowsHookEx\(hook\)/);
  assert.match(cs, /static readonly HookProc proc = Hook;/, 'delegaten holdes i live');
  // Hook-funktionen: én return, og den kalder CallNextHookEx (også når tællingen fejler)
  const hook = cs.slice(cs.indexOf('static IntPtr Hook('), cs.indexOf('static bool Held('));
  assert.deepStrictEqual(hook.match(/return [^;]*;/g), ['return CallNextHookEx(hook, nCode, wParam, lParam);']);
  assert.match(hook, /try \{ if \(nCode >= 0\) Count\(wParam\.ToInt64\(\), lParam\); \} catch \{ \}/);
  // Kun det Word-vindue, broen styrer, og kun i forgrunden – før der læses noget om tasten
  const count = cs.slice(cs.indexOf('static void Count('), cs.indexOf('static int Category('));
  const gateAt = count.indexOf('if (tg == 0 || GetForegroundWindow().ToInt64() != tg) return;');
  assert.ok(gateAt > 0, 'forgrunds-tjekket');
  assert.ok(gateAt < count.indexOf('Marshal.ReadInt32'), 'intet læses om tasten, før forgrunden er tjekket');
  assert.match(ps, /\[HMKeys\]::SetTarget\(\[long\]\$req\.hwnd\)/);
  // Injicerede taster tælles for sig – ikke som tastet
  assert.match(count, /if \(\(flags & LLKHF_INJECTED\) != 0\) \{ injected\+\+; return; \}/);
  // Tasten (vkCode) læses kun som argument til Category() og gemmes aldrig
  assert.deepStrictEqual(count.match(/Marshal\.ReadInt32\(lParam, \d+\)/g), ['Marshal.ReadInt32(lParam, 8)', 'Marshal.ReadInt32(lParam, 12)', 'Marshal.ReadInt32(lParam, 0)']);
  assert.match(count, /int cat = Category\(unchecked\(\(uint\)Marshal\.ReadInt32\(lParam, 0\)\)/);
  assert.ok(!/Marshal\.ReadInt32\(lParam, 4\)/.test(cs), 'scanCode læses ikke');
  assert.ok(!/ToUnicode|GetKeyNameText|MapVirtualKey|GetKeyboardState|KeyInterop|Clipboard/.test(cs), 'ingen oversættelse af taster til tegn eller navne');
  // Ingen felter (static) med en tast, et tegn eller et navn
  const fields = cs.split('\n').filter(l => /^\s*static\b/.test(l) && !/\(/.test(l.replace(/=.*$/, '')));
  assert.ok(fields.length >= 8, fields.join('\n'));
  for (const f of fields) assert.ok(!/\b(vk|key|keys|code|char|chars|name|text|last(Vk|Char|Code))\b/i.test(f.replace(/=.*$/, '')), 'felt: ' + f);
  // Category() er en ren funktion: tager tasten som argument og svarer en kategori
  const cat = cs.slice(cs.indexOf('static int Category('), cs.indexOf('static void Tempo('));
  assert.ok(!/=[^=]/.test(cat.replace(/\/\/.*$/gm, '').replace(/[!<>=]=/g, '')), 'Category() tildeler intet');
  // Det, der sendes, er kun tællerne
  const snap = cs.slice(cs.indexOf('public static Hashtable Snapshot('));
  const sent = (snap.match(/h\["(\w+)"\]/g) || []).map(x => x.slice(3, -2));
  assert.deepStrictEqual(sent.sort(), ['burst', 'deleted', 'fastShare', 'injected', 'keystrokes', 'maxCps', 'pasteKeys', 'regularity', 'typed', 'undo']);
  const sends = ps.match(/Send @\{[^\n]*/g);
  assert.deepStrictEqual(sends, ['Send @{ ready = $true; hook = $ok }', 'Send @{ id = $id; ok = $true; keys = [HMKeys]::Snapshot() }', 'Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message }']);
  // Kategorierne
  assert.match(cat, /if \(vk == 0x56\) return PASTE;/);
  assert.match(cat, /if \(shift && vk == 0x2D\) return PASTE;/);
  assert.match(cat, /if \(vk == 0x5A \|\| vk == 0x59\) return UNDO;/);
  assert.match(cat, /if \(vk == 0x08 \|\| vk == 0x2E\) return DEL;/);
  // Tempo som skrivevinduet (write.js): 5 sek. vindue, byger på 1 sek., < 12 ms, 200 afstande til jævnhed
  const tempo = cs.slice(cs.indexOf('static void Tempo('));
  for (const re of [/if \(g < 12\) fast\+\+;/, /g >= 12 && g < 2000/, /> 5000\) times\.Dequeue\(\)/, /times\.Count > 20/, /<= 1000\) inSec\+\+/, /gaps\.Count >= 200/, /timed >= 100/]) assert.match(tempo, re);
  // Hooken fjernes, når økten slutter (stdin lukkes)
  assert.match(ps, /\[HMKeys\]::Stop\(\)/);
  // Ascii ud og balancerede klammer
  assert.ok(ps.includes("'[^\\x00-\\x7F]'"));
  const code = ps.replace(/'[^'\n]*'/g, "''").replace(/#.*$/gm, '').replace(/\/\/.*$/gm, '');
  for (const [a, b2] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.strictEqual(code.split(a).length, code.split(b2).length, a + b2);
  // word.ps1 har ingen hook (så antivirus, der stopper hooks, ikke stopper Word-broen) – men giver hwnd
  const word = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'word', 'word.ps1'), 'utf8');
  assert.ok(!/SetWindowsHookEx|WH_KEYBOARD_LL/.test(word));
  assert.match(word, /hwnd = \$h\.ToInt64\(\)/);
});
