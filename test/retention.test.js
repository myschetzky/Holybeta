'use strict';
// Frister (server/src/retention.js): kladder, afspilning, skrivedetaljer, dokumenter og beviser – med falsk tid
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const dbm = require('../server/src/db.js');
const { DocStore } = require('../server/src/docs.js');
const RET = require('../server/src/retention.js');
const { createServer } = require('../server/src/index.js');

const DAY = 86400_000;
const SENT = 'Romantikken var en periode i kunsten hvor følelser og natur fik en stor plads. ';
const green = { color: 'green', violations: [] };
const blocksOf = (text) => [{ t: 'p', r: [{ x: text }] }];
const meta = { studentName: 'Anna Jensen', className: '2.g', teacherName: 'Mette', issuer: 'https://holymoly.test' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ret-'));
  const db = dbm.open(dir);
  db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
  db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', 0)").run();
  db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (1, 1, 'Anna Jensen', 0, 1)").run();
  return { dir, db, docs: new DocStore(db, dir), anna: { id: 1, class_id: 1 } };
}
/** Skriv en tekst med menneskeligt tempo fra start (gemning hvert 5. sek.). */
function write(docs, student, fullText, start, id = crypto.randomUUID(), step = 40) {
  let t = start;
  for (let n = step; ; n += step) {
    const text = fullText.slice(0, Math.min(n, fullText.length));
    const r = docs.save(student, { id, title: 'R', blocks: blocksOf(text), stats: { typed: Math.round(text.length * 1.15) + 12, deleted: 5, keystrokes: text.length + 20, maxCps: 6, regularity: 0.7 } }, green, 1, t);
    assert.ok(r.ok, r.error);
    if (n >= fullText.length) break;
    t += 5000;
  }
  return id;
}

test('frister: standardtal, miljøvariabler og beskrivelsen', () => {
  const R = RET.fromEnv({}, {});
  assert.deepStrictEqual({ ...R, maxVersions: undefined }, { draftDays: 60, versionsDays: 60, docDays: 365, certYears: 3, logDays: 30, backupDays: 14, inactiveDays: 180, auditDays: 365, maxVersions: undefined });
  const E = RET.fromEnv({}, { DRAFT_DAYS: '10', VERSIONS_DAYS: '20', DOC_RETENTION_DAYS: '200', CERT_YEARS: '5', LOG_RETENTION_DAYS: '14', BACKUP_DAYS: '0' });
  assert.deepStrictEqual([E.draftDays, E.versionsDays, E.docDays, E.certYears, E.logDays, E.backupDays], [10, 20, 200, 5, 14, 0]);
  // Vrøvl giver standarden
  assert.strictEqual(RET.fromEnv({}, { DRAFT_DAYS: 'abc', CERT_YEARS: '-1' }).draftDays, 60);
  assert.strictEqual(RET.fromEnv({}, { CERT_YEARS: '-1' }).certYears, 3);
  const text = RET.describe(R).map(x => x.text).join(' ');
  assert.match(text, /60 dage efter seneste ændring/);
  assert.match(text, /365 dage efter aflevering/);
  assert.match(text, /3 år/);
  assert.match(text, /14 dage/);
});

test('frister: oprydning med falsk tid – kladder, afspilning, detaljer, dokumenter og beviser', () => {
  const { dir, db, docs, anna } = setup();
  const R = RET.fromEnv({}, {});
  const t0 = 1_700_000_000_000;
  const text = SENT.repeat(9).trim();
  // Et afleveret dokument med bevis, en kladde og en ny kladde
  const done = write(docs, anna, text, t0);
  const res = docs.submit(anna, done, meta, t0 + 600_000);
  assert.ok(res.certId);
  const oldDraft = write(docs, anna, text.slice(0, 120), t0);
  const newDraft = write(docs, anna, text.slice(0, 120), t0 + 59 * DAY);
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;

  // Dag 59: intet slettes
  const p59 = RET.purge(db, R, t0 + 59 * DAY);
  assert.deepStrictEqual([p59.drafts, p59.versions, p59.events, p59.reduced, p59.documents, p59.expired], [0, 0, 0, 0, 0, 0]);
  // Dag 61: den gamle kladde og afspilningen er væk; skrivedetaljerne er kun minuttal
  const p61 = RET.purge(db, R, t0 + 61 * DAY);
  assert.strictEqual(p61.drafts, 1);
  assert.ok(!docs.full(oldDraft), 'gammel kladde slettet');
  assert.ok(docs.full(newDraft), 'ny kladde bliver');
  assert.strictEqual(docs.versions(done).length, 0, 'afspilningen er slettet');
  assert.strictEqual(p61.reduced, 1);
  const row = db.prepare('SELECT stats, monitor, result FROM documents WHERE id = ?').get(done);
  assert.strictEqual(row.stats, '{}');
  const m = JSON.parse(row.monitor);
  assert.strictEqual(m.reduced, true);
  assert.deepStrictEqual([m.red, m.grey, m.flags], [[], [], []]);
  assert.strictEqual(m.greenMs % 60_000, 0, 'kun minuttal');
  assert.deepStrictEqual(JSON.parse(row.result).facts.words, res.facts.words, 'vurderingen (facts) bliver');
  assert.ok(docs.full(done), 'dokumentet kan stadig åbnes');
  // Igen samme dag: intet nyt at gøre
  assert.strictEqual(RET.purge(db, R, t0 + 61 * DAY).reduced, 0);

  // Dag 366: dokumentet slettes, beviset bliver en gravsten med fristens dato
  const p366 = RET.purge(db, R, t0 + 366 * DAY);
  assert.strictEqual(p366.documents, 1);
  const c = docs.certificate(res.certId);
  assert.strictEqual(c.valid, true);
  assert.strictEqual(c.docDeleted, t0 + 366 * DAY);
  assert.strictEqual(docs.certificateOwner(res.certId), null, 'intet navn');
  assert.strictEqual(count("SELECT COUNT(*) AS n FROM certificates WHERE student_name != '' OR class_name != ''"), 0);

  // Efter 3 år: beviset er udløbet (id'et er kendt, men indholdet er væk)
  const p3 = RET.purge(db, R, t0 + 3 * 365 * DAY + 2 * DAY);
  assert.strictEqual(p3.expired, 1);
  const x = docs.certificate(res.certId);
  assert.ok(x.expired);
  assert.strictEqual(count("SELECT COUNT(*) AS n FROM certificates WHERE payload != '' OR text_sha256 IS NOT NULL"), 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('frister: inaktive elever, skriveøkter hjemme og computerens fingeraftryk – og describe() viser dem', () => {
  const { dir, db, docs, anna } = setup();
  try {
    const R = RET.fromEnv({}, {});
    assert.strictEqual(RET.fromEnv({}, { INACTIVE_STUDENT_DAYS: '30' }).inactiveDays, 30);
    assert.strictEqual(RET.fromEnv({ inactiveStudentDays: 7 }, {}).inactiveDays, 7);
    const t0 = 1_700_000_000_000;
    // To elever: Anna er inaktiv (sidst set t0), Bo er set for nylig
    db.prepare("INSERT INTO students (id, class_id, name, created, enrolled) VALUES (2, 1, 'Bo', 0, 1)").run();
    const upd = db.prepare('UPDATE students SET aids = ?, device_info = ?, last_seen = ? WHERE id = ?');
    upd.run('["ordforslag"]', '{"os":"Windows"}', t0, 1);
    upd.run('["diktering"]', '{"os":"Windows"}', t0 + 170 * DAY, 2);
    db.prepare("INSERT INTO lessons (id, class_id, started, ends_at, ended) VALUES (10, 1, ?, ?, ?)").run(t0, t0 + 3600_000, t0 + 3600_000);
    db.prepare('INSERT INTO lesson_extensions (lesson_id, student_id, ends_at) VALUES (10, 1, ?), (10, 2, ?)').run(t0 + 200 * DAY, t0 + 200 * DAY);
    // Skriveøkter hjemme: en afsluttet (lukket), en afbrudt ('drop') og en, der stadig kører
    const home = db.prepare("INSERT INTO lessons (id, class_id, started, ends_at, ended, student_id, kind, end_reason, device_hash) VALUES (?, 1, ?, ?, ?, ?, 'hjemme', ?, 'abcd')");
    home.run(20, t0, t0 + 3 * 3600_000, t0 + 3600_000, 1, 'lukket');
    home.run(21, t0, t0 + 3 * 3600_000, t0 + 3600_000, 2, 'drop');
    home.run(22, t0 + 40 * DAY, t0 + 41 * DAY, null, 2, null);
    // En kladde skrevet i skriveøkt 20 (hjemme) – afleveres efter, at rækken er slettet
    const draft = write(docs, anna, SENT.repeat(9).trim(), t0 + 1000);
    db.prepare('UPDATE documents SET monitor = json_set(monitor, \'$.lessons\', json(\'[20]\')) WHERE id = ?').run(draft);
    assert.deepStrictEqual(docs.placeOf(draft), { home: true, lesson: false });

    // Dag 0,5: fingeraftrykket på den lukkede økt er væk med det samme, den afbrudte beholder det et døgn
    let p = RET.purge(db, R, t0 + 12 * 3600_000);
    const hash = (id) => db.prepare('SELECT device_hash AS h FROM lessons WHERE id = ?').get(id).h;
    assert.strictEqual(hash(20), null);
    assert.strictEqual(hash(21), 'abcd');
    p = RET.purge(db, R, t0 + 2 * DAY);
    assert.strictEqual(hash(21), null);
    assert.strictEqual(hash(22), 'abcd', 'en økt, der kører, beholder sit fingeraftryk');

    // Dag 31: de afsluttede skriveøkter hjemme er slettet – kladden er stadig "hjemme"
    p = RET.purge(db, R, t0 + 31 * DAY);
    assert.strictEqual(p.homeLessons, 2);
    assert.deepStrictEqual(db.prepare("SELECT id FROM lessons WHERE kind = 'hjemme' ORDER BY id").all().map(r => r.id), [22]);
    assert.deepStrictEqual(docs.placeOf(draft), { home: true, lesson: false });
    assert.ok(db.prepare('SELECT id FROM lessons WHERE id = 10').get(), 'klassens lektion bliver');

    // Dag 181: Anna er inaktiv – hjælpemidler, computer og ekstra tid er væk. Bo beholder sine.
    p = RET.purge(db, R, t0 + 181 * DAY);
    assert.strictEqual(p.inactive, 1);
    const st = (id) => db.prepare('SELECT aids, device_info FROM students WHERE id = ?').get(id);
    assert.deepStrictEqual({ ...st(1) }, { aids: null, device_info: null });
    assert.deepStrictEqual({ ...st(2) }, { aids: '["diktering"]', device_info: '{"os":"Windows"}' });
    assert.deepStrictEqual(db.prepare('SELECT student_id FROM lesson_extensions').all().map(r => r.student_id), [2]);
    // Udløbet ekstra tid slettes for alle
    RET.purge(db, R, t0 + 202 * DAY);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM lesson_extensions').get().n, 0);

    // describe() (til /privatliv og /vilkaar-elev) viser de nye frister
    const items = RET.describe(R);
    assert.ok(items.find(x => x.key === 'inactiveDays' && /180 dage/.test(x.text) && /Hjælpemidler/.test(x.what)));
    assert.match(items.find(x => x.key === 'logDays').what, /skriveøkter hjemme/);
    assert.strictEqual(RET.publicInfo(R).inactiveDays, 180);
    const priv = fs.readFileSync(path.join(__dirname, '..', 'server/public/privatliv.html'), 'utf8');
    assert.match(priv, /data-cfg="retention\.inactiveDays"/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frister: en skriveøkt, der lukkes, mister computerens fingeraftryk med det samme', () => {
  const hub = fs.readFileSync(path.join(__dirname, '..', 'server/src/hub.js'), 'utf8');
  assert.match(hub, /device_hash = CASE WHEN \? = \\'drop\\' THEN device_hash ELSE NULL END/);
  assert.match(hub, /UPDATE students SET device_info = \?, last_seen = \? WHERE id = \?/);
});

test('frister: ved aflevering beholdes højst 120 versioner (første og sidste med)', () => {
  const { dir, db, docs, anna } = setup();
  const id = crypto.randomUUID();
  // 300 versioner (hver gemning 25 sek. efter den forrige)
  let t = 1_000_000;
  let text = '';
  for (let i = 0; i < 300; i++) {
    text += 'ord ';
    assert.ok(docs.save(anna, { id, title: 'R', blocks: blocksOf(text), stats: { typed: text.length + 5 } }, green, 1, t).ok);
    t += 25_000;
  }
  const before = docs.versions(id);
  assert.strictEqual(before.length, 300);
  docs.submit(anna, id, Object.assign({ force: true }, meta), t);
  const after = docs.versions(id);
  assert.strictEqual(after.length, RET.MAX_VERSIONS);
  assert.strictEqual(after[0].ts, before[0].ts);
  assert.strictEqual(after[after.length - 1].ts, before[before.length - 1].ts);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('frister: /api/info.retention, lærerens "Slet kladde" og elevens doc-delete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ret2-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, minProofWords: 10, draftDays: 45 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', Origin: base }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  let ws;
  try {
    const info = await call('GET', '/api/info');
    assert.strictEqual(info.retention.draftDays, 45);
    assert.strictEqual(info.retention.docDays, 365);
    assert.ok(info.retention.items.some(i => /45 dage/.test(i.text)));
    // /privatliv har pladserne til tallene
    const html = await (await fetch(base + '/privatliv')).text();
    for (const k of ['draftDays', 'versionsDays', 'docDays', 'certYears', 'logDays', 'backupDays']) assert.ok(html.includes(`data-cfg="retention.${k}"`), k);
    assert.ok((await (await fetch(base + '/vilkaar-elev')).text()).includes('data-cfg="retention.draftDays"'));

    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ws.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ws.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    const t = 'Romantikken var en periode i kunsten, hvor følelser og natur fik plads.';
    const saveDoc = async (id) => {
      ws.send(JSON.stringify({ type: 'doc', id, title: 'Kladde', blocks: blocksOf(t), stats }));
      assert.strictEqual((await wait(m => m.type === 'doc-saved' && m.id === id)).ok, true);
      await new Promise(r => setTimeout(r, 1550));
    };
    const d1 = crypto.randomUUID(), d2 = crypto.randomUUID(), d3 = crypto.randomUUID();
    await saveDoc(d1); await saveDoc(d2); await saveDoc(d3);

    // Læreren sletter en kladde – logbogen får en linje
    assert.strictEqual((await call('DELETE', '/api/docs/' + d1))._status, 200);
    assert.strictEqual((await call('GET', '/api/docs/' + d1))._status, 404);
    const ev = await call('GET', `/api/students/${en.studentId}/events?kind=alerts`);
    assert.ok(ev.events.some(e => e.kind === 'teacher' && /Mette slettede kladden "Kladde"/.test(e.title)), JSON.stringify(ev.events));

    // Eleven sletter en kladde fra skrivevinduet (også uden lektion)
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    await wait(m => m.type === 'lesson' && !m.live);
    ws.send(JSON.stringify({ type: 'doc-delete', id: d2 }));
    assert.strictEqual((await wait(m => m.type === 'doc-deleted' && m.id === d2)).ok, true);
    assert.strictEqual((await call('GET', '/api/docs/' + d2))._status, 404);
    // Et id, serveren ikke kender: ok (intet at slette)
    ws.send(JSON.stringify({ type: 'doc-delete', id: crypto.randomUUID() }));
    assert.strictEqual((await wait(m => m.type === 'doc-deleted')).ok, true);

    // Et afleveret dokument kan ikke slettes – hverken af læreren eller eleven
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);
    ws.send(JSON.stringify({ type: 'doc-submit', id: d3, title: 'Kladde', blocks: blocksOf(t), stats, force: true }));
    assert.strictEqual((await wait(m => m.type === 'doc-result')).ok, true);
    const del = await call('DELETE', '/api/docs/' + d3);
    assert.strictEqual(del._status, 409);
    assert.match(del.error, /afleveret/);
    ws.send(JSON.stringify({ type: 'doc-delete', id: d3 }));
    const r3 = await wait(m => m.type === 'doc-deleted' && m.id === d3);
    assert.strictEqual(r3.ok, false);
  } finally {
    if (ws) ws.terminate();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
