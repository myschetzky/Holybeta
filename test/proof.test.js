'use strict';
// Skrive-beviset efter dommerens krav: ærligt mærke, ingen persondata, tekst-tjek af Word-filen,
// testserver-mærkning, prøve-vurdering, ingen låsning uden bevis, færre falske afslag og en nøgle der ikke forsvinder stille.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');
const D = require('../shared/doc.js');

const SENT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. ';
const LONG = SENT.repeat(9).trim(); // 117 ord
const green = { color: 'green', violations: [] };
const meta = { studentName: 'Anna Jensen', className: '2.g Dansk', teacherName: 'Mette', issuer: 'https://holymoly.test' };
const blocksOf = (text) => [{ t: 'h1', r: [{ x: 'Romantikken' }] }, { t: 'p', r: [{ x: text }] }];
const inflateRaw = async (b) => new Uint8Array(zlib.inflateRawSync(b));

function setup(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proof-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g Dansk', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1)").run();
  const done = () => { try { db.close(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ } };
  return { dir, db, docs: new DocStore(db, dir, opts), anna: { id: 1, class_id: 1 }, done };
}

function write(docs, student, fullText, { start = 1_000_000, view = () => green, stats = {}, id = crypto.randomUUID(), step = 40, blocks = blocksOf, lesson = 1 } = {}) {
  let t = start;
  let last;
  for (let n = step; ; n += step) {
    const text = fullText.slice(0, Math.min(n, fullText.length));
    last = docs.save(student, { id, title: 'Romantikken', blocks: blocks(text), stats: Object.assign({ typed: Math.round(text.length * 1.15) + 12, deleted: Math.round(text.length * 0.1), keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 }, stats) }, view(t), lesson, t);
    assert.ok(last.ok, last.error);
    if (n >= fullText.length) break;
    t += 5000;
  }
  return { id, last, end: t };
}

/** Samme zip som toDocx, men pakket med "deflate" (som når Word gemmer filen igen). */
async function deflateDocx(bytes) {
  const names = ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'docProps/core.xml'];
  const files = [];
  for (const n of names) { const d = await D.readZipEntry(bytes, n, inflateRaw); if (d) files.push([n, Buffer.from(d)]); }
  const parts = []; const central = []; let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name); const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nb.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(off, 42);
    parts.push(loc, nb, comp); central.push(cen, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

test('A: mærket siger, hvad HolyMoly har set – og Word-filens sidefod har forbeholdet og antal ord', async () => {
  assert.strictEqual(D.label('lektion'), '✓ Tastet i HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.label('hjemme'), '✓ Tastet i HolyMoly – intet indsat · hjemme uden opsyn');
  assert.strictEqual(D.label('lektion og hjemme'), '✓ Tastet i HolyMoly – intet indsat · hjemme uden opsyn');
  assert.strictEqual(D.label(), '✓ Tastet i HolyMoly – intet indsat');
  const blocks = blocksOf('Fem ord står i teksten.');
  const z = D.toDocx(blocks, { title: 'X', mark: { code: 'HM-ABCD1234', url: 'https://holymoly.test/bevis/abc', place: 'hjemme' } });
  const footer = new TextDecoder().decode(await D.readZipEntry(z, 'word/footer1.xml', inflateRaw));
  assert.match(footer, /✓ Tastet i HolyMoly – intet indsat · hjemme uden opsyn/);
  assert.match(footer, /Mærket viser, hvad HolyMoly målte på elevens computer\. Det dækker ikke afskrift fra telefon eller papir, og en computer, eleven selv har ændret, eller en maskine, der taster som et menneske, kan ikke udelukkes\. Mangler mærket, er det ikke et tegn på snyd\. 6 ord\./);
  assert.ok(!/Skrevet uden AI/.test(footer));
  // Det gamle mærke står ingen steder i koden længere
  for (const f of ['shared/doc.js', 'agent/src/doc.js', 'agent/renderer/write.html', 'agent/renderer/write.js', 'agent/src/writer.js', 'server/public/app.js', 'server/public/bevis.js', 'server/public/bevis.html']) {
    assert.ok(!/Skrevet uden AI/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
  }
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'agent/src/doc.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'shared/doc.js'), 'utf8'), 'npm run sync');
});

test('H: mærket v3 – "kun skrivevinduet" uden vagt, "TESTSERVER" fra en testserver, og v2 vises som før', () => {
  const only = ['skrivevindue'], both = ['skrivevindue', 'vagt'];
  assert.strictEqual(D.label('hjemme', { observed: only }), '✓ Tastet i HolyMoly – intet indsat · hjemme · kun skrivevinduet');
  assert.match(D.label('hjemme', { observed: only }), /kun skrivevinduet/);
  assert.strictEqual(D.label('klasse', { observed: only }), '✓ Tastet i HolyMoly – intet indsat · i timen · kun skrivevinduet');
  assert.strictEqual(D.label('klasse', { observed: both }), '✓ Tastet i HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.label('ekstra', { observed: both }), '✓ Tastet i HolyMoly – intet indsat · i timen');
  assert.strictEqual(D.label('hjemme', { observed: both, test: true }), '✓ Tastet i HolyMoly – intet indsat · hjemme · TESTSERVER');
  assert.strictEqual(D.label('lektion og hjemme', { observed: only, test: true }), '✓ Tastet i HolyMoly – intet indsat · hjemme · kun skrivevinduet · TESTSERVER');
  // v2 (uden observed): som før
  assert.strictEqual(D.label('hjemme'), '✓ Tastet i HolyMoly – intet indsat · hjemme uden opsyn');
  // Grønt kun med vagt og uden testserver
  assert.strictEqual(D.markGreen({ observed: both }), true);
  assert.strictEqual(D.markGreen({ observed: only }), false);
  assert.strictEqual(D.markGreen({ observed: both, test: true }), false);
  assert.strictEqual(D.markGreen({}), true, 'v2-mærke: grønt som før');
  // Forbeholdet nævner afskrift, en ændret computer og autotyper – og at et manglende mærke ikke er snyd
  assert.match(D.LIMIT_TEXT, /afskrift fra telefon eller papir/);
  assert.match(D.LIMIT_TEXT, /computer, eleven selv har ændret/);
  assert.match(D.LIMIT_TEXT, /maskine, der taster som et menneske/);
  assert.match(D.LIMIT_TEXT, /Mangler mærket, er det ikke et tegn på snyd/);
});

test('H: bevis v3 fra en testserver – intet nameHash, TESTSERVER og gråt mærke i Word, og intet felt kobler elevens beviser', async () => {
  const t = setup({ testServer: true });
  try {
    const created = Date.UTC(2026, 10, 20, 9, 0);
    const r = t.docs.submit(t.anna, write(t.docs, t.anna, LONG).id, Object.assign({ observed: ['skrivevindue'], assignmentCreated: created }, meta), 3_000_000);
    assert.ok(r.certId, r.reasons.join());
    assert.strictEqual(r.test, true);
    assert.deepStrictEqual(r.observed, ['skrivevindue']);
    assert.strictEqual(r.kind, 'klasse');
    const c = t.docs.certificate(r.certId);
    assert.strictEqual(c.valid, true);
    assert.strictEqual(c.v, 3);
    const p = c.payload;
    assert.strictEqual(p.v, 3);
    assert.ok(!('nameHash' in p), 'intet nameHash');
    assert.ok(!/nameHash|Anna|Jensen/.test(c.signed));
    assert.deepStrictEqual(Object.keys(p), ['v', 'id', 'sha256', 'words', 'started', 'submitted', 'kind', 'observed', 'test', 'assignmentCreated', 'checks', 'issuer', 'keyId']);
    assert.strictEqual(p.test, true);
    assert.strictEqual(p.kind, 'klasse');
    assert.deepStrictEqual(p.observed, ['skrivevindue']);
    assert.strictEqual(p.assignmentCreated, '2026-11-20');
    assert.strictEqual(p.started, 1_000_000);
    assert.strictEqual(p.checks[0], 'Tastet i HolyMolys skrivevindue – indsæt blokeret');
    assert.ok(!p.checks.some(x => /vagten/.test(x)), 'ingen vagt-linje uden vagt');
    assert.ok(p.checks.includes('Menneskeligt skrivetempo'));
    // Dokumentet: full() har test og observed, og Word-filen har TESTSERVER og et gråt mærke
    const full = t.docs.full(t.db.prepare('SELECT id FROM documents WHERE cert_id = ?').get(r.certId).id);
    assert.strictEqual(full.test, true);
    assert.deepStrictEqual(full.observed, ['skrivevindue']);
    const z = D.toDocx(full.blocks, { title: full.title, mark: { code: 'HM-' + r.certId.slice(0, 8).toUpperCase(), url: 'https://holymoly.test/bevis/' + r.certId, place: full.place, observed: full.observed, test: full.test } });
    const footer = new TextDecoder().decode(await D.readZipEntry(z, 'word/footer1.xml', inflateRaw));
    assert.match(footer, /TESTSERVER/);
    assert.match(footer, /kun skrivevinduet/);
    assert.match(footer, /Testserver – må ikke bruges til bedømmelse\. Tjek altid teksten på linket\./);
    assert.ok(!/15803D/.test(footer), 'mærket er ikke grønt');
    assert.match(footer, /w:color w:val="6B7280"\/><w:sz w:val="18"/);
    const core = new TextDecoder().decode(await D.readZipEntry(z, 'docProps/core.xml', inflateRaw));
    assert.match(core, /<dc:description>[^<]*TESTSERVER[^<]*Testserver – må ikke bruges til bedømmelse\. Tjek altid teksten på linket\.<\/dc:description>/);
    // Med vagt og fra skolens egen server: grønt og uden testserver-linje
    const z2 = D.toDocx(full.blocks, { title: full.title, mark: { code: 'HM-X', url: 'u', place: 'lektion', observed: ['skrivevindue', 'vagt'] } });
    const footer2 = new TextDecoder().decode(await D.readZipEntry(z2, 'word/footer1.xml', inflateRaw));
    assert.match(footer2, /15803D/);
    assert.ok(!/TESTSERVER|Testserver/.test(footer2));

    // To beviser fra samme elev under forskellige forhold: ingen fælles felter ud over v, issuer og keyId.
    // (Skolens server med vagt, hjemme i en skriveøkt og til en anden aflevering)
    t.db.prepare('INSERT INTO lessons (id, class_id, started, ends_at, student_id) VALUES (7, 1, 0, 9e15, 1)').run();
    const school = new DocStore(t.db, t.dir, {});
    const r2 = school.submit(t.anna, write(school, t.anna, LONG + ' Hjemme.', { lesson: 7, start: 5_000_000 }).id, Object.assign({}, meta, { observed: ['skrivevindue', 'vagt'], assignmentCreated: Date.UTC(2026, 10, 22, 9, 0), issuer: 'https://holymoly.test' }), 7_000_000);
    assert.ok(r2.certId, r2.reasons.join());
    const p2 = school.certificate(r2.certId).payload;
    assert.strictEqual(p2.kind, 'hjemme');
    assert.deepStrictEqual(p2.observed, ['skrivevindue', 'vagt']);
    assert.ok(p2.checks.includes('HolyMoly-vagten blokerede AI på computeren'));
    assert.strictEqual(D.label(p2.kind, p2), '✓ Tastet i HolyMoly – intet indsat · hjemme');
    const common = (a, b) => Object.keys(a).filter(k => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
    assert.deepStrictEqual(common(p, p2).filter(k => !['v', 'issuer', 'keyId'].includes(k)), [], 'ingen fælles felter: ' + common(p, p2));
    // Under de samme forhold er de fælles felter de samme som med en anden elevs bevis – intet felt er elevens eget
    t.db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (2, 1, 'Bo Nielsen', 0, 1)").run();
    const same = Object.assign({ observed: ['skrivevindue'], assignmentCreated: created }, meta);
    const a3 = t.docs.certificate(t.docs.submit(t.anna, write(t.docs, t.anna, LONG + ' Igen.', { start: 9_000_000 }).id, same, 11_000_000).certId).payload;
    const bo = { id: 2, class_id: 1 };
    const pb = t.docs.certificate(t.docs.submit(bo, write(t.docs, bo, LONG + ' Bo.', { start: 9_000_000 }).id, Object.assign({}, same, { studentName: 'Bo Nielsen' }), 11_000_000).certId).payload;
    for (const k of common(p, a3)) assert.ok(common(p, pb).includes(k), `${k} er fælles for Annas beviser, men ikke med Bos`);
    assert.deepStrictEqual(common(p, a3).sort(), ['assignmentCreated', 'checks', 'issuer', 'keyId', 'kind', 'observed', 'test', 'v']);
  } finally { t.done(); }
});

test('H: vagten tæller kun med i "observed", hvis den fulgte hele forløbet – og hjælpemidler giver "Skrivetempo ikke vurderet"', () => {
  const t = setup();
  try {
    const withGuard = Object.assign({ observed: ['skrivevindue', 'vagt'] }, meta);
    // Vagten svarede ikke et øjeblik (under grænsen for grå tid): beviset udstedes, men uden "vagt"
    const a = write(t.docs, t.anna, LONG.slice(0, 400));
    t.docs.observe(a.id, { color: 'grey', greyReason: 'HolyMoly-vagten svarer ikke' }, a.end + 3000);
    t.docs.observe(a.id, green, a.end + 6000);
    const rest = write(t.docs, t.anna, LONG, { id: a.id, start: a.end + 9000 });
    const r = t.docs.submit(t.anna, a.id, withGuard, rest.end + 1000);
    assert.ok(r.certId, r.reasons.join(' | '));
    assert.deepStrictEqual(t.docs.certificate(r.certId).payload.observed, ['skrivevindue']);
    // "Venter på HolyMoly-vagten" ved lektionsstart er ikke et hul
    const b = write(t.docs, t.anna, LONG, { view: (x) => x < 1_010_000 ? { color: 'grey', greyReason: 'Venter på HolyMoly-vagten' } : green });
    const rb = t.docs.submit(t.anna, b.id, withGuard, 3_000_000);
    assert.ok(rb.certId, rb.reasons.join(' | '));
    assert.deepStrictEqual(t.docs.certificate(rb.certId).payload.observed, ['skrivevindue', 'vagt']);
    // Et forfalsket observed udvider ikke målingen
    const c = t.docs.submit(t.anna, write(t.docs, t.anna, LONG).id, Object.assign({}, meta, { observed: ['skrivevindue', 'vagt', 'skærm'] }), 3_000_000);
    assert.deepStrictEqual(t.docs.certificate(c.certId).payload.observed, ['skrivevindue', 'vagt']);
    // Uden observed (fx en ældre hub): kun skrivevinduet
    const d = t.docs.submit(t.anna, write(t.docs, t.anna, LONG).id, meta, 3_000_000);
    assert.deepStrictEqual(t.docs.certificate(d.certId).payload.observed, ['skrivevindue']);
    // Hjælpemidler (students.aids bygges senere): tempoet vurderes ikke
    const e = t.docs.submit(t.anna, write(t.docs, t.anna, LONG).id, Object.assign({}, meta, { aids: ['ordforslag'] }), 3_000_000);
    const pe = t.docs.certificate(e.certId).payload;
    assert.ok(pe.checks.includes('Skrivetempo ikke vurderet'));
    assert.ok(!pe.checks.includes('Menneskeligt skrivetempo'));
    assert.strictEqual(pe.assignmentCreated, null);
  } finally { t.done(); }
});

test('H: et v2-bevis (med nameHash) verificeres og vises stadig', () => {
  const t = setup();
  try {
    const doc = t.docs.save(t.anna, { id: crypto.randomUUID(), title: 'Gammel', blocks: blocksOf('Hej'), stats: {} }, green, 1, 1000).doc;
    const payload = JSON.stringify({ v: 2, id: 'v2v2v2v2v2v2v2v2', sha256: 'abc', words: 117, submitted: 1_750_000_000_000, place: 'hjemme', checks: ['Tastet i HolyMoly med overvågning – hjemme i en skriveøkt uden opsyn'], limits: 'Beviset dækker skriveforløbet på computeren – ikke afskrift fra telefon eller papir.', issuer: 'https://holymoly.test', keyId: t.docs.keyId, nameHash: 'f'.repeat(64) });
    const sig = crypto.sign(null, Buffer.from(payload), t.docs.privateKey).toString('base64');
    t.db.prepare('INSERT INTO certificates (id, doc_id, payload, sig, created) VALUES (?,?,?,?,?)').run('v2v2v2v2v2v2v2v2', doc.id, payload, sig, 1_750_000_000_000);
    const c = t.docs.certificate('v2v2v2v2v2v2v2v2');
    assert.strictEqual(c.v, 2);
    assert.strictEqual(c.valid, true);
    assert.strictEqual(c.payload.place, 'hjemme');
    assert.strictEqual(D.label(c.payload.place), '✓ Tastet i HolyMoly – intet indsat · hjemme uden opsyn');
    t.db.prepare('UPDATE certificates SET payload = replace(payload, ?, ?) WHERE id = ?').run('"words":117', '"words":118', 'v2v2v2v2v2v2v2v2');
    assert.strictEqual(t.docs.certificate('v2v2v2v2v2v2v2v2').valid, false);
  } finally { t.done(); }
  // Tjek-siden kan vise både v2 og v3 og har boksen "Hvad betyder mærket?"
  const js = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.html'), 'utf8');
  assert.match(html, /Hvad betyder mærket\?/);
  assert.match(html, /Hvad blev målt/);
  assert.match(js, /HMDoc\.LIMIT_TEXT/);
  assert.match(js, /Skrevet til en aflevering oprettet/);
  assert.match(js, /p\.v === 3/);
  assert.match(js, /Passer – men tilhører ikke en af dine elever/);
  // Elev-appen og dashboardet sender mærkets observed og test med til Word-filen, og afleveringstabellen viser "Testserver"
  const writer = fs.readFileSync(path.join(__dirname, '..', 'agent/src/writer.js'), 'utf8');
  assert.match(writer, /place: d\.result\.place \|\| '' \}, Writer\.markInfo\(d\.result\)\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'server/public/app.js'), 'utf8');
  assert.strictEqual((app.match(/place: d\.place, observed: d\.observed, test: d\.test \}/g) || []).length, 2, 'downloadWord og showDoc');
  assert.match(app, /sub\.test \? h\('span', \{ class: 'badge'[^\n]*text: 'Testserver' \}\)/);
});

test('B: teksten i en Word-fil tjekkes mod beviset – også når Word har pakket filen igen', async () => {
  const { docs, anna, done } = setup();
  try {
    const listBlocks = (text) => [{ t: 'h1', r: [{ x: 'Romantikken' }] }, { t: 'p', r: [{ x: text.slice(0, 200) }, { x: ' & <slut>', b: 1 }] }, { t: 'ol', r: [{ x: 'Første punkt' }] }, { t: 'ol', r: [{ x: 'Andet punkt' }] }, { t: 'ul', r: [{ x: 'Et punkt' }] }, { t: 'p', r: [{ x: '1. januar er en dato. ' + text.slice(200) }] }];
    const { id } = write(docs, anna, LONG, { blocks: listBlocks, stats: { typed: 3000 } });
    const r = docs.submit(anna, id, meta, 3_000_000);
    assert.ok(r.certId, r.reasons.join());
    const p = docs.certificate(r.certId).payload;
    const full = docs.full(id);
    for (const z of [D.toDocx(full.blocks, { title: 'Romantikken', mark: { code: 'HM-X', url: 'u', place: p.place } })]) {
      for (const bytes of [z, await deflateDocx(z)]) {
        const xml = new TextDecoder().decode(await D.readZipEntry(bytes, 'word/document.xml', inflateRaw));
        const t = D.docxText(xml);
        assert.strictEqual(t.title, 'Romantikken');
        const hashes = t.variants.map(v => crypto.createHash('sha256').update(v).digest('hex'));
        assert.ok(hashes.includes(p.sha256), 'Word-filen passer til beviset');
        assert.strictEqual(hashes[0], p.sha256, 'den første udgave er den rigtige');
        assert.strictEqual(D.wordCount(t.text), p.words);
      }
    }
    // En ændret tekst passer ikke
    const changed = full.blocks.map(b => ({ t: b.t, r: b.r.map(x => ({ x: x.x.replace('følelser', 'tanker') })) }));
    const xml2 = new TextDecoder().decode(await D.readZipEntry(D.toDocx(changed, { title: 'Romantikken' }), 'word/document.xml', inflateRaw));
    assert.ok(!D.docxText(xml2).variants.some(v => crypto.createHash('sha256').update(v).digest('hex') === p.sha256));
    await assert.rejects(D.readZipEntry(new Uint8Array(100), 'word/document.xml', inflateRaw), /ikke en Word-fil/);
    // Tjek-siden siger aldrig "Gyldigt" før teksten er sammenlignet
    const js = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.js'), 'utf8');
    assert.match(js, /Beviset findes – tjek at teksten passer/);
    assert.match(js, /Teksten passer til beviset/);
    assert.match(js, /Teksten passer IKKE/);
    assert.match(js, /DecompressionStream\('deflate-raw'\)/);
    assert.ok(!/Gyldigt/.test(js));
  } finally { done(); }
});

test('B: mindst 100 ord for et bevis', () => {
  const { docs, anna, done } = setup();
  try {
    const short = SENT.repeat(7).trim(); // 91 ord
    const r = docs.submit(anna, write(docs, anna, short).id, meta, 3_000_000);
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons.join(), /for kort.*mindst 100 ord/);
    assert.ok(docs.submit(anna, write(docs, anna, LONG).id, meta, 4_000_000).certId);
  } finally { done(); }
});

test('C: gamle beviser (v1) vises kun som gyldig/ugyldig og dato – signaturen tjekkes stadig', () => {
  const { docs, done } = setup();
  try {
    const doc = docs.save({ id: 1, class_id: 1 }, { id: crypto.randomUUID(), title: 'Gammel', blocks: blocksOf('Hej'), stats: {} }, green, 1, 1000).doc;
    const payload = JSON.stringify({ v: 1, id: 'oldoldoldoldold1', type: 'HolyMoly-skrivebevis', student: 'Anna Jensen', class: '2.g Dansk', teacher: 'Mette', title: 'Gammel', sha256: 'x', words: 1, pasteBlocked: 2, submitted: 1_700_000_000_000, issuer: 'https://holymoly.test', keyId: docs.keyId });
    const sig = crypto.sign(null, Buffer.from(payload), docs.privateKey).toString('base64');
    docs.db.prepare('INSERT INTO certificates (id, doc_id, payload, sig, created) VALUES (?,?,?,?,?)').run('oldoldoldoldold1', doc.id, payload, sig, 1_700_000_000_000);
    const c = docs.certificate('oldoldoldoldold1');
    assert.deepStrictEqual(c, { v: 1, legacy: true, valid: true, submitted: 1_700_000_000_000 });
    assert.ok(!/Anna/.test(JSON.stringify(c)));
    // Læreren kan stadig se, hvem det gamle bevis tilhører
    assert.strictEqual(docs.certificateOwner('oldoldoldoldold1').student, 'Anna Jensen');
    docs.db.prepare('UPDATE certificates SET payload = replace(payload, ?, ?)').run('"words":1', '"words":9');
    assert.strictEqual(docs.certificate('oldoldoldoldold1').valid, false);
  } finally { done(); }
});

test('D: enkel tilstand uden SCHOOL_OPERATED=1 mærker beviset "Testserver"', () => {
  const t = setup({ testServer: true });
  try {
    const r = t.docs.submit(t.anna, write(t.docs, t.anna, LONG).id, meta, 3_000_000);
    const p = t.docs.certificate(r.certId).payload;
    assert.strictEqual(p.issuer, 'https://holymoly.test (Testserver – må ikke bruges til bedømmelse)');
  } finally { t.done(); }
  const js = fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server/public/bevis.html'), 'utf8');
  assert.match(js, /Testserver – må ikke bruges til bedømmelse/);
});

test('E: prøve-vurdering ved hver gemning, og ingen låsning uden bevis, medmindre eleven vælger det', () => {
  const { docs, anna, done } = setup();
  try {
    // Undervejs: for kort (kategorier, aldrig tal)
    const first = docs.save(anna, { id: crypto.randomUUID(), title: 'R', blocks: blocksOf('Kort tekst her.'), stats: { typed: 30 } }, green, 1, 1000);
    assert.strictEqual(first.preview.ok, false);
    assert.deepStrictEqual(first.preview.categories.map(c => c.key), ['kort']);
    // Rød lampe + indsat tekst
    const { id, last } = write(docs, anna, LONG, { view: (t) => t > 1_010_000 ? { color: 'red', violations: [{ text: 'AI / chatbots: chatgpt.com' }] } : green, stats: { pasteInserted: 1, maxCps: 40 } });
    assert.deepStrictEqual(last.preview.categories.map(c => c.key), ['rod', 'indsat', 'tempo']);
    for (const c of last.preview.categories) assert.ok(!/\d/.test(c.text), 'ingen tempotal til eleven: ' + c.text);
    // "Afslut dokument" uden "Aflever alligevel": ikke låst, eleven kan skrive videre
    const r = docs.submit(anna, id, meta, 2_000_000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.confirm, true);
    assert.deepStrictEqual(r.categories.map(c => c.key), ['rod', 'indsat', 'tempo']);
    assert.strictEqual(docs.full(id).submitted, null);
    assert.ok(docs.save(anna, { id, title: 'R', blocks: blocksOf(LONG + ' Mere.'), stats: { typed: 9999 } }, green, 1, 2_000_100).ok, 'kan stadig skrive');
    // "Aflever alligevel": afleveret uden bevis og låst
    const f = docs.submit(anna, id, Object.assign({ force: true }, meta), 2_000_200);
    assert.strictEqual(f.ok, true);
    assert.strictEqual(f.certId, null);
    assert.ok(docs.full(id).submitted);
    assert.match(docs.save(anna, { id, title: 'R', blocks: blocksOf('x'), stats: {} }, green, 1, 2_000_300).error, /afleveret/);
    // Med bevis kræves intet valg
    const ok = write(docs, anna, LONG);
    assert.strictEqual(ok.last.preview.ok, true);
    assert.deepStrictEqual(ok.last.preview.categories, []);
    assert.ok(docs.submit(anna, ok.id, meta, 3_000_000).certId);
  } finally { done(); }
});

test('F: en ærlig tekst om AI får bevis – kun ordrette chatbot-fraser giver afslag', () => {
  const { docs, anna, done } = setup();
  try {
    const honest = 'Jeg mener, at ChatGPT sagde noget forkert om romantikken, da vi prøvede den i klassen. Som en AI kan den ikke føle naturen, men jeg kan. ' + LONG;
    const md = [{ t: 'p', r: [{ x: '### Indledning' }] }, { t: 'p', r: [{ x: '**Romantikken**' }] }, { t: 'p', r: [{ x: honest }] }];
    const { id } = write(docs, anna, honest, { blocks: (t) => t.length < honest.length ? [{ t: 'p', r: [{ x: t }] }] : md });
    const r = docs.submit(anna, id, meta, 3_000_000);
    assert.ok(r.certId, r.reasons.join(' | '));
    assert.match(r.notes.join(), /nævner, hvad en AI-chat sagde/);
    assert.match(r.notes.join(), /som en AI/);
    assert.match(r.notes.join(), /Markdown/);
    for (const t of ['As an AI language model, I cannot do that.', 'Jeg er en sprogmodel og kan ikke svare.', 'Regenerate response', 'Pr. min vidensopdatering er det sådan.']) assert.strictEqual(D.aiTraces(t).length, 1, t);
    // Knap-tekst kun som en linje for sig – ikke midt i en sætning
    assert.deepStrictEqual(D.aiTraces('Man må ikke bare kopiér kode fra nettet.'), []);
  } finally { done(); }
});

test('F: grå tid uden vækst har sin egen grænse – og de første 30 sek. med "Venter på HolyMoly-vagten" tæller ikke', () => {
  const { docs, anna, done } = setup();
  try {
    const greyStill = { color: 'grey', greyReason: 'HolyMoly-vagten svarer ikke' };
    // Kort grå pause (9 sek.), hvor eleven ikke skriver: under grænsen (10 min. og 15 % af tiden) – kun en note
    const a = write(docs, anna, LONG.slice(0, 400));
    let t = a.end;
    for (let i = 0; i < 3; i++) { t += 3000; docs.observe(a.id, greyStill, t); }
    t += 3000; docs.observe(a.id, green, t);
    const rest = write(docs, anna, LONG, { id: a.id, start: t + 3000 });
    let r = docs.submit(anna, a.id, meta, rest.end + 1000);
    assert.ok(r.certId, r.reasons.join(' | '));
    assert.match(r.notes.join(), /hvor teksten ikke voksede/);
    // Lang grå pause (5 min.) uden vækst: tilgives ikke længere (over 15 % af tiden)
    const a2 = write(docs, anna, LONG.slice(0, 400));
    t = a2.end;
    for (let i = 0; i < 100; i++) { t += 3000; docs.observe(a2.id, greyStill, t); }
    t += 3000; docs.observe(a2.id, green, t);
    const rest2 = write(docs, anna, LONG, { id: a2.id, start: t + 3000 });
    r = docs.submit(anna, a2.id, meta, rest2.end + 1000);
    assert.match(r.reasons.join(), /ikke komplet i 5 min\., mens dokumentet var åbent/);
    assert.deepStrictEqual(r.categories.map(c => c.key), ['forbindelse']);
    // Grå, mens teksten vokser: tæller
    const b = write(docs, anna, LONG, { view: (x) => x > 1_020_000 ? greyStill : green });
    r = docs.submit(anna, b.id, meta, b.end + 1000);
    assert.match(r.reasons.join(), /ikke komplet/);
    // "Venter på HolyMoly-vagten" i 25 sek. ved lektionsstart, mens eleven skriver: tæller ikke
    const waitView = { color: 'grey', greyReason: 'Venter på HolyMoly-vagten' };
    const c = write(docs, anna, LONG, { view: (x) => x < 1_000_000 + 25_000 ? waitView : green });
    r = docs.submit(anna, c.id, meta, c.end + 1000);
    assert.ok(r.certId, r.reasons.join(' | '));
    // … men venter den i 5 min., tæller tiden efter de første 30 sek.
    const d = write(docs, anna, LONG, { view: (x) => x < 1_000_000 + 300_000 ? waitView : green });
    r = docs.submit(anna, d.id, meta, d.end + 1000);
    assert.match(r.reasons.join(), /ikke komplet/);
  } finally { done(); }
});

test('F2: serverens egen nedetid (server_runs) tæller ikke mod eleven – dog højst 400 tegn pr. hul', () => {
  const { db, docs, anna, done } = setup();
  try {
    // Eleven skriver, serveren går ned i 5 min. (sidst i live ved t1, starter igen ved t1 + 5 min.)
    const a = write(docs, anna, LONG.slice(0, 200));
    const t1 = a.end + 1000;
    db.prepare('INSERT INTO server_runs (start, last_alive) VALUES (?, ?), (?, ?)').run(0, t1, t1 + 300_000, t1 + 300_000);
    assert.strictEqual(docs._downtime(a.end, t1 + 305_000), 300_000);
    // Efter genstarten: 200 tegn mere (under 2 tegn/sek. × 300 sek., højst 400) – intet flag, og nedetiden er ikke grå
    const st = (n) => ({ typed: Math.round(n * 1.15) + 12, deleted: 5, keystrokes: n + 20, maxCps: 6, regularity: 0.7 });
    assert.ok(docs.save(anna, { id: a.id, title: 'R', blocks: blocksOf(LONG.slice(0, 400)), stats: st(420) }, green, 1, t1 + 305_000).ok);
    const m = JSON.parse(db.prepare('SELECT monitor FROM documents WHERE id = ?').get(a.id).monitor);
    assert.strictEqual(m.downMs, 300_000, 'nedetiden er talt for sig');
    assert.ok(m.greyMs <= 10_000, 'kun tiden uden for nedetiden er grå: ' + m.greyMs);
    assert.deepStrictEqual(m.flags, []);
    // For meget tekst under nedetiden (mere end 400 tegn ud over det tilladte): flag som før
    const c = write(docs, anna, LONG.slice(0, 120), { start: 50_000_000 });
    const t2 = c.end + 1000;
    db.prepare('UPDATE server_runs SET last_alive = ? WHERE start = ?').run(t2, t1 + 300_000);
    db.prepare('INSERT INTO server_runs (start, last_alive) VALUES (?, ?)').run(t2 + 600_000, t2 + 600_000);
    assert.ok(docs.save(anna, { id: c.id, title: 'R', blocks: blocksOf(LONG), stats: st(LONG.length + 40) }, green, 1, t2 + 605_000).ok);
    const r2 = docs.submit(anna, c.id, meta, t2 + 610_000);
    assert.match(r2.reasons.join(), /ikke kunne følge med \(serveren var nede i 10 min\.\)/);
  } finally { done(); }
});

test('G: serveren starter ikke, hvis signeringsnøglen mangler, men der findes beviser', () => {
  const { dir, db, docs, anna, done } = setup();
  try {
    assert.ok(docs.submit(anna, write(docs, anna, LONG).id, meta, 3_000_000).certId);
    const key = path.join(dir, 'proof-key.pem');
    const saved = fs.readFileSync(key);
    fs.rmSync(key);
    assert.throws(() => new DocStore(db, dir), /Signeringsnøglen mangler.*1 skrive-beviser/);
    assert.ok(!fs.existsSync(key), 'ingen ny nøgle bag om ryggen');
    fs.writeFileSync(key, saved);
    const again = new DocStore(db, dir);
    assert.strictEqual(again.keyId, docs.keyId);
  } finally { done(); }
  // Første start uden beviser: nøglen laves
  const t = setup();
  try { assert.ok(fs.existsSync(path.join(t.dir, 'proof-key.pem'))); } finally { t.done(); }
});

test('C + D + E: gennem serveren – offentligt uden navne, læreren ser navnet, testserver, prøve-vurdering og "Aflever alligevel"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proof-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', simple: true, minProofWords: 10, schoolApproval: { controller: 'Testskolen', dpo: 'dpo@test.dk', dpiaDate: '2026-12-01', approvedDate: '2026-12-02' }, dbaDate: '2026-12-03' });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    const reg = await call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k', acceptTerms: true });
    assert.ok(reg._status < 300, JSON.stringify(reg));
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen', pin: '4821', accept: true }) })).json();
    assert.ok(en.token, JSON.stringify(en));
    const ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };

    // Prøve-vurdering følger med gem-svaret
    const short = crypto.randomUUID();
    ag.send(JSON.stringify({ type: 'doc', id: short, title: 'Kort', blocks: blocksOf('Kun tre ord.'), stats }));
    const saved = await wait(m => m.type === 'doc-saved');
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(saved.preview.categories.map(c => c.key), ['kort']);
    // Afslut uden "Aflever alligevel": ikke låst
    await new Promise(r => setTimeout(r, 1100));
    ag.send(JSON.stringify({ type: 'doc-submit', id: short, title: 'Kort', blocks: blocksOf('Kun tre ord.'), stats }));
    const no = await wait(m => m.type === 'doc-result');
    assert.strictEqual(no.ok, false);
    assert.strictEqual(no.confirm, true);
    assert.strictEqual((await call('GET', '/api/docs/' + short)).submitted, null);
    // "Aflever alligevel"
    ag.send(JSON.stringify({ type: 'doc-submit', id: short, force: true }));
    const forced = await wait(m => m.type === 'doc-result');
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(forced.certId, null);

    const id = crypto.randomUUID();
    const text = 'Romantikken var en periode hvor følelser og natur fik stor plads i kunsten. Slut.';
    await new Promise(r => setTimeout(r, 1100));
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Romantikken', blocks: blocksOf(text), stats }));
    const res = await wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));

    // Offentligt: ingen navne, klasse eller lærer – men "Testserver"
    const pubRaw = await (await fetch(base + '/api/bevis/' + res.certId)).text();
    assert.ok(!/Anna|Jensen|2\.g|Mette/.test(pubRaw), pubRaw);
    const pub = JSON.parse(pubRaw);
    assert.strictEqual(pub.valid, true);
    assert.match(pub.payload.issuer, /Testserver – må ikke bruges til bedømmelse/);
    assert.strictEqual(pub.owner, undefined);
    // Elevens lærer (logget ind) ser navn og klasse
    const own = await call('GET', '/api/bevis/' + res.certId);
    assert.deepStrictEqual(own.owner, { student: 'Anna Jensen', class: '2.g Dansk', title: 'Romantikken' });
    // En anden lærer gør ikke
    ck = '';
    await call('POST', '/api/register', { email: 'bente', name: 'Bente', password: 'tavle-kridt-1234', signupCode: 'k', acceptTerms: true });
    const other = await call('GET', '/api/bevis/' + res.certId);
    assert.strictEqual(other.owner, undefined);
    // … men får at vide, at beviset tilhører en anden lærers elev ("Passer – men tilhører ikke en af dine elever")
    assert.strictEqual(other.notMine, true);
    assert.strictEqual(pub.notMine, undefined, 'ikke logget ind: intet om ejeren');
    assert.strictEqual(own.notMine, undefined);
    // Bevis v3 gennem serveren: testserver, kun skrivevinduet (vagten kræves ikke her), og doc-result har test og observed
    assert.strictEqual(pub.payload.v, 3);
    assert.strictEqual(pub.payload.test, true);
    assert.deepStrictEqual(pub.payload.observed, ['skrivevindue']);
    assert.strictEqual(res.test, true);
    assert.deepStrictEqual(res.observed, ['skrivevindue']);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D: SCHOOL_OPERATED=1 fjerner "Testserver" i enkel tilstand', async () => {
  for (const [opts, expect] of [[{ simple: true }, true], [{ simple: true, schoolOperated: '1' }, false], [{ simple: false }, false]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proof-school-'));
    const srv = createServer(Object.assign({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false }, opts));
    try {
      await srv.listen();
      assert.strictEqual(srv.docs.testServer, expect, JSON.stringify(opts));
    } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
