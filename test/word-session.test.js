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
