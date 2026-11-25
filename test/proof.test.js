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

function write(docs, student, fullText, { start = 1_000_000, view = () => green, stats = {}, id = crypto.randomUUID(), step = 40, blocks = blocksOf } = {}) {
  let t = start;
  let last;
  for (let n = step; ; n += step) {
    const text = fullText.slice(0, Math.min(n, fullText.length));
    last = docs.save(student, { id, title: 'Romantikken', blocks: blocks(text), stats: Object.assign({ typed: Math.round(text.length * 1.15) + 12, deleted: Math.round(text.length * 0.1), keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 }, stats) }, view(t), 1, t);
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
  assert.match(footer, /Dækker skriveforløbet på computeren – ikke afskrift fra telefon eller papir\. 6 ord\./);
  assert.ok(!/Skrevet uden AI/.test(footer));
  // Det gamle mærke står ingen steder i koden længere
  for (const f of ['shared/doc.js', 'agent/src/doc.js', 'agent/renderer/write.html', 'agent/renderer/write.js', 'agent/src/writer.js', 'server/public/app.js', 'server/public/bevis.js', 'server/public/bevis.html']) {
    assert.ok(!/Skrevet uden AI/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
  }
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'agent/src/doc.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'shared/doc.js'), 'utf8'), 'npm run sync');
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

test('F: grå tid tæller kun, når teksten voksede – og ikke de første 30 sek. med "Venter på HolyMoly-vagten"', () => {
  const { docs, anna, done } = setup();
  try {
    const greyStill = { color: 'grey', greyReason: 'HolyMoly-vagten svarer ikke' };
    // Lang grå pause (5 min.), hvor eleven ikke skriver: tæller ikke
    const a = write(docs, anna, LONG.slice(0, 400));
    let t = a.end;
    for (let i = 0; i < 100; i++) { t += 3000; docs.observe(a.id, greyStill, t); }
    t += 3000; docs.observe(a.id, green, t);
    const rest = write(docs, anna, LONG, { id: a.id, start: t + 3000 });
    void rest;
    let r = docs.submit(anna, a.id, meta, rest.end + 1000);
    assert.ok(r.certId, r.reasons.join(' | '));
    assert.match(r.notes.join(), /hvor teksten ikke voksede/);
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
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', simple: true, minProofWords: 10, schoolApproval: { controller: 'Testskolen', dpo: 'dpo@test.dk', dpiaDate: '2026-12-01', approvedDate: '2026-12-02' } });
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
    assert.strictEqual((await call('GET', '/api/bevis/' + res.certId)).owner, undefined);
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
