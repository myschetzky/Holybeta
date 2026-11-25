'use strict';
// "Skriv i HolyMoly": skriveforløb -> skrive-bevis (eller begrundelse for at der ikke kan udstedes et)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');
const D = require('../shared/doc.js');

const SENT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. ';
const green = { color: 'green', violations: [] };
const meta = { studentName: 'Anna Jensen', className: '2.g Dansk', teacherName: 'Mette', issuer: 'https://holymoly.test' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-docs-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g Dansk', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1), (2, 1, 'Bo Nielsen', 0, 1)").run();
  return { dir, db, docs: new DocStore(db, dir), anna: { id: 1, class_id: 1 }, bo: { id: 2, class_id: 1 } };
}
const blocksOf = (text) => [{ t: 'h1', r: [{ x: 'Romantikken' }] }, { t: 'p', r: [{ x: text }] }];

/** Skriv en tekst over tid: gemmer hvert 5. sek. med menneskeligt tempo. Returnerer dokument-id. */
function write(docs, student, fullText, { start = 1_000_000, view = () => green, stats = {}, id = crypto.randomUUID(), step = 40 } = {}) {
  let t = start;
  for (let n = step; ; n += step) {
    const text = fullText.slice(0, Math.min(n, fullText.length));
    const r = docs.save(student, { id, title: 'Romantikken', blocks: blocksOf(text), stats: Object.assign({ typed: Math.round(text.length * 1.15) + 12, deleted: Math.round(text.length * 0.1), keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 }, stats) }, view(t), 1, t);
    assert.ok(r.ok, r.error);
    if (n >= fullText.length) break;
    t += 5000;
  }
  return id;
}

test('skrive-bevis: ægte skriveforløb giver et signeret bevis, der kan tjekkes', () => {
  const { dir, docs, anna } = setup();
  const text = SENT.repeat(9).trim();
  const id = write(docs, anna, text);
  const r = docs.submit(anna, id, meta, 2_000_000);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.reasons, []);
  assert.ok(r.certId && r.certId.length === 16);
  const c = docs.certificate(r.certId);
  assert.strictEqual(c.valid, true);
  // Ingen persondata i det signerede bevis: kun en saltet hash af navnet
  assert.deepStrictEqual(Object.keys(c.payload), ['v', 'id', 'sha256', 'words', 'submitted', 'place', 'checks', 'limits', 'issuer', 'keyId', 'nameHash']);
  assert.strictEqual(c.payload.v, 2);
  assert.ok(!/Anna|Jensen|2\.g|Mette|pasteBlocked/.test(c.signed), c.signed);
  assert.strictEqual(c.payload.nameHash, docs.nameHash('anna  jensen'));
  assert.notStrictEqual(c.payload.nameHash, crypto.createHash('sha256').update('anna jensen').digest('hex'), 'hashen er saltet');
  assert.strictEqual(c.payload.issuer, 'https://holymoly.test');
  // Navn og klasse ligger usigneret i databasen (til elevens egen lærer)
  assert.deepStrictEqual(docs.certificateOwner(r.certId), { studentId: 1, student: 'Anna Jensen', class: '2.g Dansk', title: 'Romantikken' });
  // Beviset dækker præcis den normaliserede tekst (titel-blokken er en del af dokumentet)
  const expect = D.normalizeText(D.textOf(blocksOf(text)));
  assert.strictEqual(c.payload.sha256, crypto.createHash('sha256').update(expect).digest('hex'));
  // Listepunkter er markeret, så tjek-siden kan genkende Word-listens "1." / "•"
  assert.deepStrictEqual(DocStore.listLines([{ t: 'h1', r: [{ x: 'T' }] }, { t: 'p', r: [] }, { t: 'ol', r: [{ x: 'a' }] }, { t: 'ul', r: [{ x: 'b' }] }, { t: 'p', r: [{ x: '24. december' }] }]), [1, 2]);
  // Afleveret = låst
  assert.match(docs.save(anna, { id, title: 'x', blocks: blocksOf('ændret'), stats: {} }, green, 1, 2_000_100).error, /afleveret/);
  // Manipulation af det gemte bevis opdages
  docs.db.prepare('UPDATE certificates SET payload = replace(payload, ?, ?) WHERE id = ?').run(`"words":${c.payload.words}`, `"words":${c.payload.words + 50}`, r.certId);
  assert.strictEqual(docs.certificate(r.certId).valid, false);
  try { db.close(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
});

test('skrive-bevis: snyd giver ikke et bevis – og begrundelsen står der', () => {
  const { dir, docs, anna, bo } = setup();
  const text = SENT.repeat(9).trim();
  const reasonsFor = (opts, t = text) => docs.submit(anna, write(docs, anna, t, opts), meta, 5_000_000).reasons.join(' | ');

  // Tekst der dukker op hurtigere end man kan skrive (fx indsat via et andet værktøj)
  assert.match(reasonsFor({ step: 400 }), /allerede \d+ tegn, første gang/);
  // … også midt i forløbet
  const jump = crypto.randomUUID();
  write(docs, anna, text.slice(0, 120), { id: jump });
  docs.save(anna, { id: jump, title: 'R', blocks: blocksOf(text), stats: { typed: 999 } }, green, 1, 1_000_000 + 15_000);
  assert.match(docs.submit(anna, jump, meta).reasons.join(), /indsat for hurtigt/);
  // Tekst skrevet uden forbindelse kan HolyMoly ikke bevise (siges ærligt)
  const off = crypto.randomUUID();
  write(docs, anna, text.slice(0, 120), { id: off });
  docs.save(anna, { id: off, title: 'R', blocks: blocksOf(text), stats: { typed: 999 } }, green, 1, 1_000_000 + 10 * 60_000);
  assert.match(docs.submit(anna, off, meta).reasons.join(), /uden forbindelse/);
  // Rød lampe undervejs (fx ChatGPT i browseren)
  assert.match(reasonsFor({ view: (t) => t > 1_010_000 ? { color: 'red', violations: [{ text: 'AI / chatbots: chatgpt.com' }] } : green }), /Rød lampe.*chatgpt/);
  // Overvågningen ikke komplet i en stor del af tiden (fx vagten slået fra)
  assert.match(reasonsFor({ view: (t) => t > 1_020_000 ? { color: 'grey', greyReason: 'HolyMoly-vagten svarer ikke' } : green }), /ikke komplet.*vagten svarer ikke/);
  // Mere tekst end der er tastet
  assert.match(reasonsFor({ stats: { typed: 50 } }), /mere tekst, end der er tastet/);
  // Indsat tekst
  assert.match(reasonsFor({ stats: { pasteInserted: 1 } }), /indsat tekst/);
  // Autotyper: for hurtigt eller maskinelt jævnt tempo
  assert.match(reasonsFor({ stats: { maxCps: 31 } }), /hurtigere end et menneske/);
  assert.match(reasonsFor({ stats: { regularity: 0.08, keystrokes: 900 } }), /maskinelt jævnt/);
  // Ordrette chatbot-fraser i teksten
  assert.match(reasonsFor({}, 'As an AI language model, I cannot have opinions. ' + text), /as an AI language model/);
  // For kort
  assert.match(reasonsFor({}, 'Kort tekst.'), /for kort/);
  // Et program der sender en hel sætning på én gang, eller tastetryk hurtigere end en finger
  assert.match(reasonsFor({ stats: { burst: 110 } }), /under ét sekund/);
  assert.match(reasonsFor({ stats: { fastShare: 0.6, keystrokes: 900 } }), /hurtigere, end en finger/);
  // Tastet fyld der slettes igen, kan ikke dække over tekst der ikke er tastet
  assert.match(reasonsFor({ stats: { typed: 600, deleted: 400 } }), /mere tekst, end der er tastet/);
  // Rød MELLEM to gemninger (eleven stopper med at skrive, bruger AI og skriver videre): serveren følger selv med
  const gap = crypto.randomUUID();
  write(docs, anna, text.slice(0, 120), { id: gap });
  docs.observe(gap, { color: 'red', violations: [{ text: 'AI / chatbots: chatgpt.com' }] }, 1_000_000 + 20_000);
  docs.observe(gap, green, 1_000_000 + 110_000);
  docs.save(anna, { id: gap, title: 'R', blocks: blocksOf(text.slice(0, 150)), stats: { typed: 999 } }, green, 1, 1_000_000 + 115_000);
  assert.match(docs.submit(anna, gap, meta).reasons.join(), /Rød lampe.*chatgpt/);
  // Pause mellem to lektioner tæller ikke som grå
  const two = crypto.randomUUID();
  write(docs, anna, text.slice(0, 200), { id: two });
  docs.pause(two);
  write(docs, anna, text, { id: two, start: 9_000_000 });
  assert.deepStrictEqual(docs.submit(anna, two, meta, 9_500_000).reasons, []);
  // Blokerede indsæt-forsøg stopper ikke beviset, men står som bemærkning
  const okWithNote = docs.submit(anna, write(docs, anna, text, { stats: { pasteBlocked: 2 } }), meta, 6_000_000);
  assert.ok(okWithNote.certId);
  assert.match(okWithNote.notes.join(), /2 forsøg på at indsætte/);
  // En anden elev kan ikke overtage eller aflevere dokumentet
  const id = write(docs, anna, text);
  assert.strictEqual(docs.save(bo, { id, title: 'x', blocks: blocksOf('hej'), stats: {} }, green, 1, 7_000_000).ok, false);
  assert.strictEqual(docs.submit(bo, id, meta).ok, false);
  // Ugyldigt indhold afvises
  assert.strictEqual(docs.save(anna, { id: crypto.randomUUID(), title: '', blocks: [{ t: 'script', r: [] }], stats: {} }, green, 1).ok, false);
  assert.strictEqual(docs.save(anna, { id: '../x', title: '', blocks: [], stats: {} }, green, 1).ok, false);
  try { db.close(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
});

test('skrive-bevis: hele vejen gennem serveren (elev-app -> aflevering -> lærer -> offentligt tjek)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-docs-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    const id = crypto.randomUUID();
    const doc = (text) => ({ type: 'doc', id, title: 'Romantikken', blocks: blocksOf(text), stats: { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 } });

    // Uden lektion: kan ikke skrive (så kan HolyMoly ikke være vidne)
    ag.send(JSON.stringify(doc('Første linje')));
    assert.match((await wait(m => m.type === 'doc-saved')).error, /lektion/);

    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    ag.send(JSON.stringify(doc('Romantikken var en periode hvor følelser og natur fik stor plads i kunsten.')));
    assert.strictEqual((await wait(m => m.type === 'doc-saved')).ok, true);
    // Aflevering med den endelige version (gemt lige før – også selv om sidste autogem blev afvist som "busy")
    const final = doc('Romantikken var en periode hvor følelser og natur fik stor plads i kunsten. Slut.');
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: final.title, blocks: final.blocks, stats: final.stats }));
    const res = await wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));

    // Læreren ser dokumentet og beviset
    const list = await call('GET', `/api/students/${en.studentId}/docs`);
    assert.strictEqual(list.docs[0].certId, res.certId);
    const full = await call('GET', '/api/docs/' + id);
    assert.match(full.blocks[1].r[0].x, /Slut\.$/, 'beviset gælder den endelige version');
    const alerts = await call('GET', `/api/students/${en.studentId}/events?kind=alerts&limit=10&before=${Date.now() + 1000}`);
    assert.match(alerts.events.map(e => e.title).join(), /med skrive-bevis/);

    // Alle kan tjekke beviset – uden login
    const pub = await (await fetch(base + '/api/bevis/' + res.certId)).json();
    assert.strictEqual(pub.valid, true);
    assert.strictEqual(pub.payload.issuer, 'https://holymoly.test');
    const page = await fetch(base + '/bevis/' + res.certId);
    assert.match(await page.text(), /Skrive-bevis – HolyMoly/);
    assert.strictEqual((await fetch(base + '/api/bevis/xxxxxxxxxxxxxxxx')).status, 404);

    // En anden lærer kan ikke se dokumentet
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('GET', '/api/docs/' + id))._status, 404);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('afleveringer: læreren opretter, eleven vedhæfter et dokument med flueben, læreren ser det', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-asg-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    assert.strictEqual((await call('POST', `/api/classes/${cls.id}/assignments`, { title: '' }))._status, 400);
    const due = Date.now() + 86400_000;
    const asg = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Novelleanalyse', description: 'Analysér "Hvide sko".\nHøjst 2 sider.', due });
    assert.ok(asg.id);

    const agent = async (name) => {
      const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) })).json();
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
      ws.msgs = [];
      ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
      await new Promise(r => ws.on('open', r));
      ws.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
      ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
      await ws.wait(m => m.type === 'welcome');
      ws.studentId = en.studentId;
      return ws;
    };
    const anna = await agent('Anna Jensen');
    const bo = await agent('Bo Nielsen');
    // Eleven får afleveringen med det samme (også uden lektion)
    const first = await anna.wait(m => m.type === 'assignments' && m.items.length);
    assert.strictEqual(first.items[0].title, 'Novelleanalyse');
    assert.strictEqual(first.items[0].due, due);
    assert.strictEqual(first.items[0].submission, null);

    // Anna skriver i en lektion og afslutter med flueben
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await anna.wait(m => m.type === 'lesson' && m.live);
    anna.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    anna.send(JSON.stringify({ type: 'doc', id, title: 'Hvide sko', blocks: blocksOf('Novellen handler om en pige og hendes sko.'), stats }));
    assert.strictEqual((await anna.wait(m => m.type === 'doc-saved')).ok, true);

    // Ikke afsluttet endnu: kan ikke vedhæftes
    anna.send(JSON.stringify({ type: 'assignment-attach', assignmentId: asg.id, docId: id }));
    assert.match((await anna.wait(m => m.type === 'assignment-result')).error, /Aflever og få bevis|afslut/i);
    await new Promise(r => setTimeout(r, 1100));
    anna.send(JSON.stringify({ type: 'doc-submit', id, title: 'Hvide sko', blocks: blocksOf('Novellen handler om en pige og hendes sko. Slut.'), stats }));
    const res = await anna.wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));

    // Bo kan ikke vedhæfte Annas dokument
    bo.send(JSON.stringify({ type: 'assignment-attach', assignmentId: asg.id, docId: id }));
    assert.strictEqual((await bo.wait(m => m.type === 'assignment-result')).ok, false);
    // Anna vedhæfter – også efter lektionen
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    await new Promise(r => setTimeout(r, 1100));
    anna.send(JSON.stringify({ type: 'assignment-attach', assignmentId: asg.id, docId: id }));
    assert.strictEqual((await anna.wait(m => m.type === 'assignment-result')).ok, true);
    const upd = await anna.wait(m => m.type === 'assignments' && m.items[0] && m.items[0].submission);
    assert.strictEqual(upd.items[0].submission.certified, true);

    // Samlet oversigt på tværs af klasser
    const all = await call('GET', '/api/assignments');
    assert.strictEqual(all.assignments.length, 1);
    assert.strictEqual(all.assignments[0].className, '2.g Dansk');
    assert.strictEqual(all.assignments[0].handed, 1);
    assert.strictEqual(all.assignments[0].certified, 1);
    assert.strictEqual(all.assignments[0].students, 2);
    // Læreren ser, hvem der har afleveret, og om afleveringen har fluebenet
    const list = await call('GET', `/api/classes/${cls.id}/assignments`);
    assert.strictEqual(list.assignments[0].handed, 1);
    assert.strictEqual(list.assignments[0].certified, 1);
    assert.strictEqual(list.students, 2);
    const one = await call('GET', '/api/assignments/' + asg.id);
    const a = one.students.find(s => s.name === 'Anna Jensen');
    assert.strictEqual(a.submission.certId, res.certId);
    assert.strictEqual(a.submission.late, false);
    assert.strictEqual(one.students.find(s => s.name === 'Bo Nielsen').submission, null);

    // Ændring og sletning når eleverne
    assert.strictEqual((await call('PATCH', '/api/assignments/' + asg.id, { title: 'Novelleanalyse (ny frist)' }))._status, 200);
    assert.strictEqual((await bo.wait(m => m.type === 'assignments' && m.items[0] && /ny frist/.test(m.items[0].title))).items.length, 1);
    // En anden lærer kan ikke se eller ændre afleveringen
    const ck1 = ck; ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('GET', '/api/assignments/' + asg.id))._status, 404);
    assert.strictEqual((await call('DELETE', '/api/assignments/' + asg.id, {}))._status, 404);
    ck = ck1;
    assert.strictEqual((await call('DELETE', '/api/assignments/' + asg.id, {}))._status, 200);
    assert.strictEqual((await bo.wait(m => m.type === 'assignments' && m.items.length === 0)).items.length, 0);

    // Word-filen: flueben i sidefoden og skrivebeskyttet
    const D = require('../shared/doc.js');
    const zipText = Buffer.from(D.toDocx(blocksOf('Tekst'), { title: 'X', mark: { code: 'HM-ABCD1234', url: 'https://holymoly.test/bevis/abc' }, readOnly: true })).toString('latin1');
    assert.ok(zipText.includes('word/footer1.xml') && zipText.includes('word/settings.xml'));
    anna.close(); bo.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skriveøkt: en aflevering skrives hjemme med HolyMoly aktiv – kun på elevens egen computer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-solo-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    assert.strictEqual((await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil', home: true }))._status, 400, 'hjemme kræver en frist');
    const home = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const inClass = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil i timen', due: Date.now() + 86400_000 });
    const agent = async (name) => {
      const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) })).json();
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
      ws.msgs = [];
      ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
      await new Promise(r => ws.on('open', r));
      ws.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
      ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
      await ws.wait(m => m.type === 'welcome');
      ws.studentId = en.studentId;
      return ws;
    };
    const anna = await agent('Anna Jensen');
    const bo = await agent('Bo Nielsen');
    const items = (await anna.wait(m => m.type === 'assignments' && m.items.length === 2)).items;
    assert.strictEqual(items.find(i => i.id === home.id).home, true);

    // En aflevering, der skal skrives i timen, kan ikke åbnes hjemme
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: inClass.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, false);
    // Skriveøkten: Annas computer går i lektion – Bos gør ikke
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, true);
    const lesson = await anna.wait(m => m.type === 'lesson' && m.live);
    assert.match(lesson.className, /Skriveøkt: Stil hjemme/);
    assert.strictEqual(lesson.solo.assignmentId, home.id);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(!bo.msgs.some(m => m.type === 'lesson' && m.live), 'kun elevens egen computer');
    assert.strictEqual((await call('GET', `/api/classes/${cls.id}`)).lesson.live, false, 'klassen har ingen lektion');
    assert.strictEqual(srv.hub.studentView(anna.studentId).solo, 'Stil hjemme', 'læreren ser "Skriver hjemme" på bordet');
    assert.strictEqual(srv.hub.studentView(bo.studentId).solo, undefined);
    const classes = await call('GET', '/api/classes');
    assert.strictEqual(classes[0].openAssignments, 2);
    assert.ok(['Stil hjemme', 'Stil i timen'].includes(classes[0].nextAssignment.title));

    anna.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    anna.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf('Jeg skriver hjemme om romantikken og digterne i Danmark omkring år 1800.'), stats }));
    assert.strictEqual((await anna.wait(m => m.type === 'doc-saved')).ok, true);
    await new Promise(r => setTimeout(r, 1100));
    anna.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf('Jeg skriver hjemme om romantikken og digterne i Danmark omkring år 1800. Slut.'), stats }));
    const res = await anna.wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));
    anna.send(JSON.stringify({ type: 'assignment-attach', assignmentId: home.id, docId: id }));
    assert.strictEqual((await anna.wait(m => m.type === 'assignment-result')).ok, true);

    // Skrivevinduet lukkes: skriveøkten slutter
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: false }));
    await anna.wait(m => m.type === 'lesson' && !m.live);
    // Skriveøkter står ikke i klassens lektionsrapport
    assert.strictEqual((await call('GET', `/api/classes/${cls.id}/lessons`)).lessons.length, 0);
    const one = await call('GET', '/api/assignments/' + home.id);
    assert.strictEqual(one.home, true);
    assert.strictEqual(one.students.find(s => s.name === 'Anna Jensen').submission.certId, res.certId);
    anna.close(); bo.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sikkerhed: skriveøkter efter genstart, mod en klasselektion, kvote, genbrug og sletning af beviser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-solo2-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  let srv = mk();
  let port = await srv.listen();
  let base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  const agent = async (tokens) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ws.on('open', r));
    ws.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ws.send(JSON.stringify({ type: 'hello', tokens, device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await ws.wait(m => m.type === 'welcome');
    return ws;
  };
  const enroll = async (code, name) => (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })).json();
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const A = await call('POST', '/api/classes', { name: 'A' });
    const B = await call('POST', '/api/classes', { name: 'B' });
    const home = await call('POST', `/api/classes/${A.id}/assignments`, { title: 'Hjemme', home: true, due: Date.now() + 86400_000 });
    const home2 = await call('POST', `/api/classes/${A.id}/assignments`, { title: 'Hjemme 2', home: true, due: Date.now() + 86400_000 });
    const annaA = await enroll(A.joinCode, 'Anna Jensen');
    const annaB = await enroll(B.joinCode, 'Anna Jensen');
    const bo = await enroll(A.joinCode, 'Bo Nielsen');

    // 2. En skriveøkt kan ikke trække computeren ud af en igangværende lektion i en anden klasse
    let anna = await agent([annaA.token, annaB.token]);
    await call('POST', `/api/classes/${B.id}/lesson`, { action: 'start', minutes: 45 });
    await anna.wait(m => m.type === 'lesson' && m.live);
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, false);
    await call('POST', `/api/classes/${B.id}/lesson`, { action: 'stop' });
    await anna.wait(m => m.type === 'lesson' && !m.live);

    // 3. Kvote: ny skriveøkt højst hvert 30. sek.
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, true);
    await anna.wait(m => m.type === 'lesson' && m.live);
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: false }));
    await anna.wait(m => m.type === 'write-session-result');
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.match((await anna.wait(m => m.type === 'write-session-result')).error, /Vent/);

    // 1. Genstart under en skriveøkt: bliver IKKE til en lektion for hele klassen
    srv.hub.soloQuota.clear();
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, true);
    anna.close();
    await srv.close();
    srv = mk(); port = await srv.listen(); base = 'http://127.0.0.1:' + port;
    const boWs = await agent([bo.token]);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(!boWs.msgs.some(m => m.type === 'lesson' && m.live), 'klassekammeraten kommer ikke i lektion');
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE ended IS NULL').get().n, 0, 'skriveøkten er lukket ved genstart');

    // 6 + 5. Skrevet hjemme: står på beviset; samme dokument kan ikke afleveres to gange
    anna = await agent([annaA.token, annaB.token]);
    anna.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await anna.wait(m => m.type === 'write-session-result')).ok, true);
    await anna.wait(m => m.type === 'lesson' && m.live);
    anna.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    const t = 'Jeg skriver hjemme om romantikken og digterne i Danmark omkring år 1800.';
    anna.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(t), stats }));
    assert.strictEqual((await anna.wait(m => m.type === 'doc-saved')).ok, true);
    await new Promise(r => setTimeout(r, 1100));
    anna.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf(t), stats }));
    const res = await anna.wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));
    const pub = await (await fetch(base + '/api/bevis/' + res.certId)).json();
    assert.strictEqual(pub.payload.place, 'hjemme');
    assert.match(pub.payload.checks[0], /hjemme i en skriveøkt/);
    anna.send(JSON.stringify({ type: 'assignment-attach', assignmentId: home.id, docId: id }));
    assert.strictEqual((await anna.wait(m => m.type === 'assignment-result')).ok, true);
    await new Promise(r => setTimeout(r, 1100));
    anna.send(JSON.stringify({ type: 'assignment-attach', assignmentId: home2.id, docId: id }));
    assert.match((await anna.wait(m => m.type === 'assignment-result')).error, /allerede afleveret/);
    const one = await call('GET', '/api/assignments/' + home.id);
    assert.strictEqual(one.students.find(s => s.name === 'Anna Jensen').submission.place, 'hjemme');

    // 4. Slettes eleven, forsvinder det offentlige bevis
    assert.strictEqual((await call('DELETE', '/api/students/' + annaA.studentId))._status, 200);
    assert.strictEqual((await fetch(base + '/api/bevis/' + res.certId)).status, 404);
    anna.close(); boWs.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
