'use strict';
// "Skriv i Word": tekst-tjekket (agent/src/word/session.js) og udklipsholderen (agent/src/word/clipboard.js).
// Ren logik – ingen Word, ingen Electron.
const test = require('node:test');
const assert = require('node:assert');
const { WordCheck, wordTextToBlocks, wordText, clock } = require('../agent/src/word/session.js');
const { ClipboardGuard } = require('../agent/src/word/clipboard.js');

const OWN = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. Digterne skrev om længsel og om det ukendte. ';
const FOREIGN = 'Oplysningstiden lagde vægt på fornuft, videnskab og kritisk tænkning, og dens tænkere ønskede at reformere samfundet gennem viden. ';

/** En økt, hvor serveren er klar: lektion, forbindelse, grøn lampe og Copilot slået fra. */
function ready(opts) {
  const c = new WordCheck(Object.assign({ clock: () => '10.14' }, opts));
  c.server({ live: true, online: true, lamp: { color: 'green' } });
  return c;
}
/** Skriv tekst ind med menneskeligt tempo: 8 tegn pr. måling, én måling i sekundet. Returnerer tiden bagefter. */
function type(c, before, add, t, step = 8) {
  for (let n = step; ; n += step) {
    const x = before + add.slice(0, Math.min(n, add.length));
    t += 1000;
    c.snapshot({ t, text: x, copilot: 'off', foreground: true });
    if (n >= add.length) return t;
  }
}

test('wordTextToBlocks: afsnit, linjeskift, tabeller, sideskift og kontroltegn som i Word-filen', () => {
  const raw = 'Overskrift\rFørste linje\vanden linje\r\rCelle 1\r\x07Celle 2\r\x07\r\fNy side\x02 med fodnote\x01\r';
  assert.deepStrictEqual(wordTextToBlocks(raw).map(b => b.r[0].x), ['Overskrift', 'Første linje anden linje', 'Celle 1', 'Celle 2', ' Ny side med fodnote']);
  assert.strictEqual(wordText(raw), 'Overskrift\nFørste linje anden linje\nCelle 1\nCelle 2\nNy side med fodnote');
  assert.deepStrictEqual(wordTextToBlocks(''), []);
  assert.ok(wordTextToBlocks('a\r'.repeat(5000)).length <= 3000, 'højst 3000 afsnit');
});

test('menneskelig skrivning er grøn hele vejen', () => {
  const c = ready();
  assert.strictEqual(c.start('', 0).color, 'grey', 'venter på Copilot-status');
  const t = type(c, '', OWN.repeat(3), 0);
  const s = c.status(t);
  assert.deepStrictEqual([s.color, s.symbol, s.text], ['green', '✓', 'Grøn – teksten tæller med']);
  assert.strictEqual(c.stats().pasteInserted, 0);
});

test('tekst indsat fra et andet program: rød med klokkeslæt, og den forbliver rød', () => {
  const c = ready();
  c.start('', 0);
  let t = type(c, '', OWN, 0);
  t += 1000;
  let s = c.snapshot({ t, text: OWN + FOREIGN, copilot: 'off' });
  assert.deepStrictEqual([s.color, s.symbol], ['red', '✗']);
  assert.strictEqual(s.text, 'Rød: tekst indsat fra et andet program kl. 10.14');
  assert.ok(s.notes.some(n => /kan ikke få mærket/.test(n)));
  // Slettes den indsatte tekst igen, er dokumentet stadig rødt (serveren har set den)
  t += 1000;
  s = c.snapshot({ t, text: OWN, copilot: 'off' });
  assert.strictEqual(s.color, 'red');
  assert.deepStrictEqual(c.stats(), { pasteInserted: 1, pasteBlocked: 0, focusLostMs: 0, activeMs: c.stats().activeMs, copilot: 'off' });
});

test('grænsen: 60 sammenhængende tegn på under 2 sek. – mere tid giver plads til mere', () => {
  const add59 = 'abcdefghij klmnopqrst uvwxyzæøå abcdefghij klmnopqrst uvwx'; // 58 tegn i ét stykke
  let c = ready(); c.start(OWN, 0);
  assert.strictEqual(c.snapshot({ t: 1500, text: OWN + add59, copilot: 'off' }).color, 'green');
  c = ready(); c.start(OWN, 0);
  assert.strictEqual(c.snapshot({ t: 1500, text: OWN + add59 + ' ekstra ord', copilot: 'off' }).color, 'red');
  // 150 nye tegn på 20 sek. (Word svarede ikke imens) er muligt for et menneske – 400 er ikke
  const long = FOREIGN.slice(0, 150);
  c = ready(); c.start(OWN, 0);
  assert.strictEqual(c.snapshot({ t: 20_000, text: OWN + long, copilot: 'off' }).color, 'green');
  c = ready(); c.start(OWN, 0);
  assert.strictEqual(c.snapshot({ t: 20_000, text: OWN + FOREIGN.repeat(4), copilot: 'off' }).color, 'red');
});

test('egen tekst må kopieres, flyttes og fortrydes', () => {
  const A = 'Første afsnit handler om naturen og om bjergene i Tyskland som digterne elskede at beskrive. ';
  const B = 'Andet afsnit handler om byen og om de mennesker der flyttede fra landet ind til fabrikkerne. ';
  const c = ready();
  c.start('', 0);
  let t = type(c, '', A + '\r' + B, 0);
  // Kopi af eget afsnit
  t += 1000; assert.strictEqual(c.snapshot({ t, text: A + '\r' + B + '\r' + A, copilot: 'off' }).color, 'green');
  // Flyt: klip og sæt ind på én gang
  t += 1000; assert.strictEqual(c.snapshot({ t, text: B + '\r' + A + '\r' + A, copilot: 'off' }).color, 'green');
  // Klip i én måling, sæt ind senere
  t += 1000; c.snapshot({ t, text: A + '\r' + A, copilot: 'off' });
  t += 5000; assert.strictEqual(c.snapshot({ t, text: A + '\r' + A + '\r' + B, copilot: 'off' }).color, 'green');
  // Slet alt og fortryd (Ctrl+Z)
  t += 1000; c.snapshot({ t, text: '', copilot: 'off' });
  t += 1000; assert.strictEqual(c.snapshot({ t, text: A + '\r' + A + '\r' + B, copilot: 'off' }).color, 'green');
  // Erstat alle: mange korte ord skiftet ud på én gang er ikke et spring
  t += 1000; assert.strictEqual(c.snapshot({ t, text: (A + '\r' + A + '\r' + B).replace(/om/g, 'angående'), copilot: 'off' }).color, 'green');
  assert.strictEqual(c.stats().pasteInserted, 0);
});

test('AI-fraser er røde, så længe de står i teksten', () => {
  const c = ready();
  c.start(OWN, 0);
  const t = type(c, OWN, 'As an AI language model I cannot', 0);
  const s = c.status(t);
  assert.strictEqual(s.color, 'red');
  assert.strictEqual(s.text, 'Rød: Teksten indeholder "as an AI language model"');
  assert.strictEqual(c.snapshot({ t: t + 1000, text: OWN, copilot: 'off' }).color, 'green');
});

test("Copilot: 'on' er rød, 'unknown' er grå, 'off' er grøn – og serveren får det værste", () => {
  const c = ready();
  c.start(OWN, 0);
  let s = c.snapshot({ t: 1000, text: OWN, copilot: 'unknown' });
  assert.deepStrictEqual([s.color, s.symbol, s.text], ['grey', '?', "Grå: HolyMoly kan ikke se, om Word's AI (Copilot) er slået fra. Spørg skolens IT."]);
  s = c.snapshot({ t: 2000, text: OWN, copilot: 'on' });
  assert.deepStrictEqual([s.color, s.text], ['red', "Rød: Word's AI (Copilot) er slået til"]);
  s = c.snapshot({ t: 3000, text: OWN, copilot: 'off' });
  assert.strictEqual(s.color, 'green');
  assert.strictEqual(c.stats().copilot, 'on');
});

test('serveren: ingen lektion, ingen forbindelse, læsefejl, lampen og prøve-vurderingen', () => {
  const c = new WordCheck({ clock: () => '10.14' });
  c.start(OWN, 0);
  c.snapshot({ t: 1000, text: OWN, copilot: 'off' });
  assert.match(c.status().text, /^Grå: Ingen lektion eller skriveøkt/);
  c.server({ live: true, online: false });
  assert.match(c.status().text, /^Grå: Ingen forbindelse til HolyMoly/);
  c.server({ online: true });
  assert.strictEqual(c.status().text, 'Grå: Venter på HolyMoly.');
  c.server({ lamp: { color: 'grey', reason: 'Venter på HolyMoly-vagten…' } });
  assert.strictEqual(c.status().text, 'Grå: Venter på HolyMoly-vagten.');
  c.server({ lamp: { color: 'red', reason: 'ChatGPT' } });
  assert.strictEqual(c.status().text, 'Rød: ChatGPT er åben. Luk det.');
  c.server({ lamp: { color: 'green' } });
  assert.strictEqual(c.status().color, 'green');
  assert.match(c.snapshot({ t: 2000, error: 'Word svarer ikke' }).text, /kan ikke læse dokumentet/);
  c.snapshot({ t: 3000, text: OWN, copilot: 'off' });
  // For kort: kun en note. Andre kategorier: rød.
  c.server({ preview: { ok: false, categories: [{ key: 'kort', text: 'Teksten er for kort. Et bevis kræver mindst 100 ord.' }] } });
  let s = c.status();
  assert.strictEqual(s.color, 'green');
  assert.deepStrictEqual(s.notes, ['Teksten er for kort. Et bevis kræver mindst 100 ord.']);
  c.server({ preview: { ok: false, categories: [{ key: 'forbindelse', text: 'HolyMoly kunne ikke følge hele skriveforløbet (grå lampe eller ingen forbindelse).' }] } });
  s = c.status();
  assert.deepStrictEqual([s.color, s.text], ['red', 'Rød: HolyMoly kunne ikke følge hele skriveforløbet (grå lampe eller ingen forbindelse)']);
});

test('genåbnet dokument: ny tekst, siden HolyMoly sidst så det, er skrevet uden for HolyMoly', () => {
  let c = ready();
  c.start(OWN + FOREIGN, 0, OWN);
  c.snapshot({ t: 1000, text: OWN + FOREIGN, copilot: 'off' });
  assert.strictEqual(c.status().text, 'Rød: dokumentet er ændret uden for HolyMoly');
  c = ready();
  c.start(OWN + ' slut', 0, OWN);
  assert.strictEqual(c.snapshot({ t: 1000, text: OWN + ' slut', copilot: 'off' }).color, 'green', 'et par ord er ikke et spring');
});

test('knows(): elevens egen tekst kendes – også tekst, der er slettet igen', () => {
  const c = ready();
  c.start('', 0);
  let t = type(c, '', OWN, 0);
  assert.strictEqual(c.knows('følelser og natur fik en stor plads'), true);
  assert.strictEqual(c.knows(FOREIGN), false);
  assert.strictEqual(c.knows('Romantikken'), true);
  t += 1000; c.snapshot({ t, text: 'X', copilot: 'off' });
  assert.strictEqual(c.knows('Digterne skrev om længsel og om det ukendte'), true, 'slettet tekst kendes stadig');
});

test('tid uden for Word tælles (højst 5 sek. pr. måling), og stats indeholder aldrig tekst', () => {
  const c = ready();
  c.start(OWN, 0);
  c.snapshot({ t: 1000, text: OWN, copilot: 'off', foreground: false });
  c.snapshot({ t: 60_000, text: OWN, copilot: 'off', foreground: false });
  c.snapshot({ t: 61_000, text: OWN, copilot: 'off', foreground: true });
  c.clipboardCleared();
  const st = c.stats();
  assert.deepStrictEqual(st, { pasteInserted: 0, pasteBlocked: 1, focusLostMs: 6000, activeMs: 1000, copilot: 'off' });
  assert.ok(!JSON.stringify(st).includes('Romantik'));
});

test('clock: dansk klokkeslæt med punktum', () => {
  assert.match(clock(Date.UTC(2026, 10, 25, 9, 14)), /^10\.14$/);
});

/* ---------------------------------------------------------------- udklipsholderen ---------------------------------------------------------------- */
function fakeClipboard() {
  return { text: '', formats: [], clears: 0, readText() { return this.text; }, availableFormats() { return this.formats; }, clear() { this.text = ''; this.formats = []; this.clears++; }, set(t) { this.text = t; this.formats = t ? ['text/plain'] : []; } };
}

test('udklipsholderen: tekst fra et andet program tømmes, når Word er i forgrunden', () => {
  const c = ready();
  c.start(OWN, 0);
  const cb = fakeClipboard();
  const cleared = [];
  const g = new ClipboardGuard({ clipboard: cb, knows: (x) => c.knows(x), onClear: (i) => { c.clipboardCleared(); cleared.push(i); } });
  g.tick({ wordForeground: true });
  // Eleven kopierer i browseren (Word i baggrunden): intet sker endnu
  cb.set(FOREIGN);
  assert.strictEqual(g.tick({ wordForeground: false }), false);
  assert.strictEqual(cb.text, FOREIGN, 'uden for Word røres udklipsholderen ikke');
  // Word kommer i forgrunden: tømmes
  assert.strictEqual(g.tick({ wordForeground: true }), true);
  assert.strictEqual(cb.text, '');
  assert.deepStrictEqual(cleared, [{ chars: FOREIGN.length }]);
  assert.strictEqual(c.stats().pasteBlocked, 1);
  // Lige så snart et andet program kopierer, mens Word er i forgrunden (fx et program i baggrunden)
  cb.set(FOREIGN + ' mere');
  assert.strictEqual(g.tick({ wordForeground: true }), true);
});

test('udklipsholderen: kopi fra Word (egen tekst) og korte stykker, mens Word er i forgrunden, får lov at blive', () => {
  const c = ready();
  c.start(OWN, 0);
  const cb = fakeClipboard();
  const g = new ClipboardGuard({ clipboard: cb, knows: (x) => c.knows(x) });
  g.tick({ wordForeground: true });
  cb.set('følelser og natur fik en stor plads');
  assert.strictEqual(g.tick({ wordForeground: true }), false);
  cb.set('lige skrevet');
  assert.strictEqual(g.tick({ wordForeground: true }), false, 'kort tekst kopieret i Word, før HolyMoly nåede at læse den');
  // Egen tekst kopieret, mens Word var i baggrunden (fx fra HolyMolys liste) er stadig elevens egen
  cb.set('Digterne skrev om længsel og om det ukendte');
  assert.strictEqual(g.tick({ wordForeground: false }), false);
  assert.strictEqual(g.tick({ wordForeground: true }), false);
  assert.strictEqual(cb.clears, 0);
});

test('udklipsholderen: fremmed indhold fra før økten og billeder fra andre programmer tømmes også', () => {
  const c = ready();
  c.start(OWN, 0);
  const cb = fakeClipboard();
  cb.set(FOREIGN);
  const g = new ClipboardGuard({ clipboard: cb, knows: (x) => c.knows(x) });
  assert.strictEqual(g.tick({ wordForeground: true }), true, 'lå i udklipsholderen, før Word-økten startede');
  cb.text = ''; cb.formats = ['image/png'];
  g.tick({ wordForeground: false });
  assert.strictEqual(g.tick({ wordForeground: true }), true);
  assert.strictEqual(cb.clears, 2);
});

/* ---------------------------------------------------------------- tastetryk i Word (snapshot.keys) ---------------------------------------------------------------- */
const D = require('../shared/doc.js');
const K0 = () => ({ typed: 0, deleted: 0, pasteKeys: 0, injected: 0, undo: 0, keystrokes: 0, maxCps: 6.8, burst: 10, fastShare: 0.01, regularity: 0.6 });
/** En økt med tastetælleren. k: tællerne (som broen leverer dem) – ændres af hjælperne nedenfor. */
function withKeys(opts) {
  const c = ready(opts);
  const k = K0();
  let t = 0, text = '';
  const o = { copilot: 'off' };
  const snap = (extra = {}) => c.snapshot(Object.assign({ t, text, copilot: o.copilot, foreground: true, keys: Object.assign({}, k) }, extra));
  c.snapshot({ t, text, copilot: 'off', keys: Object.assign({}, k) });
  return {
    c, k, o,
    /** Eleven taster: 8 tegn pr. sekund, én tast pr. tegn. */
    type(add, step = 8) { for (let n = 0; n < add.length; n += step) { const x = add.slice(n, n + step); k.typed += x.length; k.keystrokes += x.length; text += x; t += 1000; snap(); } return snap(); },
    /** Tekst uden tastetryk i et menneskeligt tempo (fx Copilot eller diktering i små bidder – vækst-tjekket ser intet). */
    insert(add, step = 8) { let s; for (let n = 0; n < add.length; n += step) { text += add.slice(n, n + step); t += 1000; s = snap(); } return s; },
    paste(add) { k.pasteKeys++; text += add; t += 1000; return snap(); },
    set(x, keys = {}) { Object.assign(k, keys); text = x; t += 1000; return snap(); },
    snap, get text() { return text; }, get t() { return t; },
  };
}

test('tastetryk: ærlig skrivning med autokorrektur er grøn, og serveren siger det samme', () => {
  const w = withKeys();
  w.type(OWN.repeat(4));
  // Autokorrektur/autoformat: et par tegn mere end tastet (inden for margenen)
  let s = w.set(w.text + ' (c) 2026 – fx, dvs. osv.', { typed: w.k.typed + 6 });
  assert.deepStrictEqual([s.color, s.text], ['green', 'Grøn – teksten tæller med']);
  const st = w.c.stats();
  assert.deepStrictEqual([st.keys, st.untyped, st.typed], [true, 0, w.k.typed]);
  assert.deepStrictEqual(D.evaluateStats(w.text, st, { word: true, minWords: 5 }).found, [], 'serveren: ingen afslag');
  assert.ok(!s.notes.some(n => /Tastetryk/.test(n)));
});

test('tastetryk: tekst uden tastetryk i et menneskeligt tempo (Copilot, diktering) gør muldvarpen rød – vækst-tjekket alene ser det ikke', () => {
  const w = withKeys();
  w.type(OWN);
  const s = w.insert(FOREIGN.repeat(2));
  assert.strictEqual(w.c.inserts.length, 0, 'intet spring: teksten kom i små bidder');
  assert.deepStrictEqual([s.color, s.symbol], ['red', '✗']);
  assert.strictEqual(s.text, 'Rød: der er kommet tekst, som ikke er tastet, kl. 10.14');
  assert.ok(s.notes.includes('Fx indsat, Copilot, diktering eller autotekst.'));
  assert.ok(s.notes.some(n => /kan ikke få mærket/.test(n)));
  // Permanent: også når teksten slettes igen
  assert.strictEqual(w.set(OWN).color, 'red');
  const st = w.c.stats();
  assert.ok(st.untyped >= 1);
  assert.deepStrictEqual(D.evaluateStats(OWN.repeat(3), st, { word: true, minWords: 5 }).cats, ['indsat']);
  // Uden tastetryk (gammel app eller keys: null) ville den samme økt være grøn
  const old = ready();
  old.start('', 0);
  type(old, '', OWN + FOREIGN.repeat(2), 0);
  assert.strictEqual(old.status().color, 'green');
});

test('tastetryk: margenen er max(20 tegn, 3 %) – som serveren', () => {
  const novel = (n) => 'x'.repeat(n);
  let w = withKeys();
  w.type('Kort start ');
  assert.strictEqual(w.insert(novel(20), 40).color, 'green', '20 tegn uden tastetryk: autokorrektur');
  w = withKeys();
  w.type('Kort start ');
  assert.strictEqual(w.insert(novel(22), 40).color, 'red', 'mellemrummet efter "start" er tastet, men ikke nyt: 21 tegn kan ikke forklares');
  // En lang tekst: 3 % af teksten
  w = withKeys();
  w.type(OWN.repeat(10)); // ca. 1230 tegn -> margen 37
  const m = D.wordKeyMargin(w.text.length + 36);
  assert.ok(m >= 37, String(m));
  assert.strictEqual(w.insert(' ' + novel(35), 40).color, 'green');
});

test('tastetryk: Ctrl+V af fremmed tekst er rød med Ctrl+V – Ctrl+V af egen tekst, flyt og fortryd er grøn', () => {
  let w = withKeys();
  w.type(OWN);
  let s = w.paste(' Fremmed tekst om noget helt andet');
  assert.strictEqual(s.text, 'Rød: tekst indsat med Ctrl+V, som ikke er tastet, kl. 10.14');
  const st = w.c.stats();
  assert.strictEqual(st.pasteKeys, 1);
  assert.ok(D.evaluateStats(w.text, st, { word: true, minWords: 5 }).reasons.some(r => /Ctrl\+V/.test(r)));

  const A = 'Første afsnit handler om naturen og om bjergene i Tyskland som digterne elskede at beskrive. ';
  const B = 'Andet afsnit handler om byen og om de mennesker der flyttede fra landet ind til fabrikkerne. ';
  w = withKeys();
  w.type(A + '\r' + B);
  // Kopi af eget afsnit med Ctrl+V
  assert.strictEqual(w.paste('\r' + A).color, 'green');
  // Flyt (klip og sæt ind)
  assert.strictEqual(w.set(B + '\r' + A + '\r' + A, { pasteKeys: w.k.pasteKeys + 1 }).color, 'green');
  // Slet med Backspace (mange tryk) og fortryd (Ctrl+Z) – teksten kommer igen uden tastetryk
  const full = w.text;
  w.set(B, { deleted: w.k.deleted + 2 * A.length });
  s = w.set(full, { undo: w.k.undo + 1 });
  assert.strictEqual(s.color, 'green');
  const st2 = w.c.stats();
  assert.strictEqual(st2.untyped, 0);
  assert.ok(st2.restored > 2 * A.length, 'tekst, der kom igen, tæller som restored');
  assert.deepStrictEqual(D.evaluateStats(D.normalizeText(full), st2, { word: true, minWords: 5 }).found, [], 'serveren: typed - deleted + restored forklarer teksten');
});

test('tastetryk: taster sendt af et program (injected) tæller ikke som tastet – og serveren giver "tempo"', () => {
  const w = withKeys();
  w.type(OWN);
  // En autotyper "taster" teksten: tasterne er injicerede, så de forklarer ikke teksten
  let s;
  for (let n = 0; n < FOREIGN.length; n += 8) { w.k.injected += Math.min(8, FOREIGN.length - n); s = w.insert(FOREIGN.slice(n, n + 8)); }
  assert.strictEqual(s.color, 'red');
  const st = w.c.stats();
  assert.ok(st.injected > 20);
  const ev = D.evaluateStats(w.text, st, { word: true, minWords: 5 });
  assert.ok(ev.cats.includes('tempo') && ev.cats.includes('indsat'), ev.cats.join());
});

test('tastetryk: Copilot slået til er gråt ? med en note – ikke rødt; uden tastetryk er det stadig rødt', () => {
  const w = withKeys();
  w.type(OWN);
  let s = w.snap({ copilot: 'on' });
  assert.deepStrictEqual([s.color, s.symbol, s.text], ['grey', '?', 'Grå: Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket.']);
  assert.ok(!s.notes.some(n => /Copilot/.test(n)), 'noten står ikke to gange');
  // Er skiltet rødt af en anden grund, står Copilot-noten under
  w.o.copilot = 'on';
  s = w.insert(FOREIGN.repeat(2));
  assert.strictEqual(s.color, 'red');
  assert.ok(s.notes.includes('Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket.'));
  assert.strictEqual(w.c.stats().copilot, 'on');
  assert.deepStrictEqual(D.evaluateStats(OWN.repeat(3), Object.assign(w.c.stats(), { untyped: 0, restored: 1000 }), { word: true, minWords: 5 }).cats, [], 'serveren: Copilot slået til er kun en note');
  // keys: null -> de gamle regler
  const n = ready();
  n.start(OWN, 0);
  s = n.snapshot({ t: 1000, text: OWN, copilot: 'on', keys: null });
  assert.deepStrictEqual([s.color, s.text], ['red', "Rød: Word's AI (Copilot) er slået til"]);
  assert.ok(s.notes.includes('Tastetryk kan ikke tælles på denne computer.'));
});

test('keys: null – tastetryk kan ikke tælles: note, ingen tastetjek, og stats siger keys: false', () => {
  const c = ready();
  c.start(OWN, 0);
  let t = 0;
  t += 1000; c.snapshot({ t, text: OWN, copilot: 'off', keys: null });
  t += 1000; let s = c.snapshot({ t, text: OWN + FOREIGN.slice(0, 50), copilot: 'off', keys: null });
  assert.strictEqual(s.color, 'green');
  assert.deepStrictEqual(s.notes, ['Tastetryk kan ikke tælles på denne computer.']);
  // Kommer tællerne igen senere i økten, er tællingen stadig ikke komplet
  t += 1000; s = c.snapshot({ t, text: OWN + FOREIGN.slice(0, 50), copilot: 'off', keys: K0() });
  assert.strictEqual(c.keysAvail, false);
  assert.deepStrictEqual(c.stats(), { pasteInserted: 0, pasteBlocked: 0, focusLostMs: 0, activeMs: 3000, copilot: 'off', keys: false });
  assert.deepStrictEqual(D.evaluateStats(OWN.repeat(3), c.stats(), { word: true, minWords: 5 }).found, []);
});

test('tastetryk: tælleren starter efter Word (intet keys-felt endnu) – teksten fra før tæller ikke imod eleven', () => {
  const c = ready();
  c.start('', 0);
  type(c, '', OWN, 0);
  assert.strictEqual(c.keysAvail, null);
  let s = c.snapshot({ t: 20_000, text: OWN + ' videre', copilot: 'off', keys: Object.assign(K0(), { typed: 7 }) });
  assert.strictEqual(s.color, 'green');
  const st = c.stats();
  assert.strictEqual(st.keys, true);
  assert.deepStrictEqual(D.evaluateStats(OWN + ' videre', st, { word: true, minWords: 5 }).found, []);
  s = c.snapshot({ t: 60_000, text: OWN + ' videre ' + FOREIGN.slice(0, 50), copilot: 'off', keys: Object.assign(K0(), { typed: 7 }) });
  assert.strictEqual(c.inserts.length, 0);
  assert.strictEqual(s.color, 'red', 'derefter tæller tastetrykkene');
});

test('tastetryk over flere økter: tallene lægges oveni (base) – og et dokument påbegyndt uden tastetryk vurderes uden', () => {
  // Første økt
  const w = withKeys();
  w.type(OWN);
  const first = w.c.stats();
  // Anden økt: Word åbner det gemte dokument, tællerne starter forfra
  const c = ready({ base: first });
  c.start(OWN, 0, D.normalizeText(OWN));
  c.snapshot({ t: 1000, text: OWN, copilot: 'unknown', keys: K0() });
  c.snapshot({ t: 2000, text: OWN + 'Mere tekst', copilot: 'off', keys: Object.assign(K0(), { typed: 10, maxCps: 9, regularity: 0.3 }) });
  const st = c.stats();
  assert.deepStrictEqual([st.keys, st.typed, st.maxCps, st.regularity, st.copilot], [true, first.typed + 10, 9, 0.3, 'unknown']);
  assert.deepStrictEqual(D.evaluateStats(D.normalizeText(OWN + 'Mere tekst'), st, { word: true, minWords: 5 }).found, []);
  // Påbegyndt uden tastetryk: hele dokumentet vurderes uden
  const old = ready({ base: { keys: false, pasteInserted: 1, copilot: 'on' } });
  old.start(OWN, 0, D.normalizeText(OWN));
  const s = old.snapshot({ t: 1000, text: OWN, copilot: 'off', keys: K0() });
  assert.strictEqual(old.keysCounted(), false);
  assert.ok(s.notes.includes('Tastetryk blev ikke talt, da dokumentet blev påbegyndt. Det vurderes uden tastetryk.'));
  assert.deepStrictEqual(old.stats(), { pasteInserted: 1, pasteBlocked: 0, focusLostMs: 0, activeMs: 1000, copilot: 'on', keys: false });
});
