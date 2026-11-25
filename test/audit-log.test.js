'use strict';
// Revisionsspor (audit_log): lærerhandlinger uden indhold, kun til at tilføje, egen frist og pseudonym ved sletning
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dbm = require('../server/src/db.js');
const RET = require('../server/src/retention.js');
const { DocStore } = require('../server/src/docs.js');
const { createServer } = require('../server/src/index.js');

const DAY = 86400_000;

test('audit_log: kun til at tilføje, slettes efter AUDIT_DAYS, og en slettet elev bliver et pseudonym', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-audit-'));
  const db = dbm.open(dir);
  new DocStore(db, dir); // dokument-tabellerne (purge rydder også dem)
  try {
    db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (1, 'l@x.dk', 'Mette', 'x', 0)").run();
    db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (1, 1, '2.g', 0)").run();
    db.prepare("INSERT INTO students (id, class_id, name, created) VALUES (1, 1, 'Anna', 0), (2, 1, 'Bo', 0)").run();
    const t0 = 1_700_000_000_000;
    const ins = db.prepare('INSERT INTO audit_log (ts, teacher_id, action, student_id) VALUES (?, 1, ?, ?)');
    ins.run(t0, 'åbnede dokument', 1);
    ins.run(t0 + 1000, 'så weblog', 1);
    ins.run(t0 + 300 * DAY, 'afspillede dokument', 2);
    // Kan ikke ændres eller slettes
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x' WHERE id = 1").run(), /kun tilføjes/);
    assert.throws(() => db.prepare('UPDATE audit_log SET ts = 0 WHERE id = 1').run(), /kun tilføjes/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /efter fristen/);
    // Slet eleven (også via klassen): alle elevens rækker får det samme pseudonym
    db.prepare('DELETE FROM students WHERE id = 1').run();
    const rows = db.prepare('SELECT student_id, student_ref FROM audit_log WHERE teacher_id = 1 ORDER BY id').all();
    assert.strictEqual(rows[0].student_id, null);
    assert.match(rows[0].student_ref, /^slettet-[0-9a-f]{12}$/);
    assert.strictEqual(rows[1].student_ref, rows[0].student_ref);
    assert.strictEqual(rows[2].student_id, 2);
    // Pseudonymet kan ikke ændres bagefter
    assert.throws(() => db.prepare("UPDATE audit_log SET student_ref = 'x' WHERE id = 1").run(), /kun tilføjes/);
    // Fristen: 365 dage som standard – længere end logbogen (30 dage)
    const R = RET.fromEnv({}, {});
    assert.strictEqual(R.auditDays, 365);
    assert.strictEqual(RET.fromEnv({}, { AUDIT_DAYS: '730' }).auditDays, 730);
    assert.strictEqual(RET.purge(db, R, t0 + 364 * DAY).audit, 0);
    assert.strictEqual(RET.purge(db, R, t0 + 366 * DAY).audit, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
    // Fristen åbner ikke for at slette nyere rækker
    assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /efter fristen/);
    assert.ok(RET.describe(R).find(x => x.key === 'auditDays' && /365 dage/.test(x.text) && /pseudonym/.test(x.text)));
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'server/public/privatliv.html'), 'utf8'), /data-cfg="retention\.auditDays"/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit_log: åbnet dokument, afspilning, Word, weblog, hjælpemidler, eksport, kode og sletning logges – uden indhold – og kan eksporteres med enkel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-audit-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, minProofWords: 10 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', Origin: base }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    if (/csv/.test(r.headers.get('content-type') || '')) return { _status: r.status, text: await r.text() };
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const enroll = async (name) => (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) })).json();
    const anna = await enroll('Anna Jensen');
    const bo = await enroll('Bo Nielsen');
    // Et afleveret dokument med en hemmelig titel (titlen må ikke stå i revisionssporet)
    const st = { id: anna.studentId, class_id: cls.id };
    const id = crypto.randomUUID();
    let t = Date.now() - 600_000;
    let text = '';
    for (let i = 0; i < 6; i++) {
      text += 'Romantikken var en periode i kunsten. ';
      assert.ok(srv.docs.save(st, { id, title: 'Ansøgning til psykolog', blocks: [{ t: 'p', r: [{ x: text }] }], stats: { typed: text.length + 10 } }, { color: 'green', violations: [] }, 1, t).ok);
      t += 5000;
    }
    srv.docs.submit(st, id, { force: true }, t);
    const teacherId = srv.db.prepare('SELECT id FROM teachers').get().id;

    assert.strictEqual((await call('GET', '/api/docs/' + id))._status, 200);
    assert.strictEqual((await call('GET', `/api/docs/${id}/versions`))._status, 200);
    assert.strictEqual((await call('GET', `/api/docs/${id}/log`))._status, 200);
    assert.strictEqual((await call('POST', `/api/docs/${id}/word`))._status, 200);
    assert.strictEqual((await call('GET', `/api/students/${anna.studentId}/events?kind=web`))._status, 200);
    assert.strictEqual((await call('GET', `/api/students/${anna.studentId}/events?kind=web`))._status, 200); // samme minut: én række
    assert.strictEqual((await call('PUT', `/api/students/${anna.studentId}/aids`, { aids: ['ordforslag'] }))._status, 200);
    assert.strictEqual((await call('GET', `/api/students/${anna.studentId}/export.csv`))._status, 200);
    assert.strictEqual((await call('POST', `/api/students/${anna.studentId}/reset-pin`))._status, 200);
    assert.strictEqual((await call('DELETE', `/api/students/${bo.studentId}`))._status, 200);

    const rows = srv.db.prepare('SELECT teacher_id, action, student_id, student_ref FROM audit_log ORDER BY id').all();
    const mine = rows.filter(r => r.student_id === anna.studentId).map(r => r.action);
    assert.deepStrictEqual(mine, ['åbnede dokument', 'afspillede dokument', 'så skrivelog', 'hentede Word', 'så weblog', 'ændrede hjælpemidler', 'eksporterede log', 'nulstillede kode']);
    assert.ok(rows.every(r => r.teacher_id === teacherId));
    const deleted = rows.find(r => r.action === 'slettede elev');
    assert.strictEqual(deleted.student_id, null);
    assert.match(deleted.student_ref, /^slettet-/);
    // Uden indhold: ingen titler, navne, tekst eller adresser
    const all = JSON.stringify(srv.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!/psykolog|Anna|Bo Nielsen|Mette|Romantikken|http/.test(all), all);
    // En anden lærer kan ikke skrive i sporet om andres elever
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('POST', `/api/docs/${id}/word`))._status, 404);
    // Dashboardet melder, når Word-filen hentes
    const app = fs.readFileSync(path.join(__dirname, '..', 'server/public/app.js'), 'utf8');
    assert.strictEqual((app.match(/\/word', \{ method: 'POST' \}\)\.catch/g) || []).length, 2);
  } finally {
    await srv.close();
  }
  // npm run enkel -- revisionsspor: CSV til den driftsansvarlige
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), 'revisionsspor', '30'], { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.replace(/^﻿/, '').trim().split('\r\n');
    assert.strictEqual(lines[0], 'Tid (UTC);Lærer-id;Lærer;Handling;Elev-id;Elev;Klasse');
    assert.ok(lines.some(l => /;Mette;åbnede dokument;\d+;Anna Jensen;2\.g$/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /;slettede elev;slettet-[0-9a-f]{12};;$/.test(l)), lines.join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
