'use strict';
// Målinger til piloten: "Var det forkert?" gemmer kun årsag og bevistype, og pilottallene er aggregerede tal for hele
// skolen pr. måned – ingen navne, ingen opdeling pr. lærer, klasse eller elev, ingen AI-forsøg, og k ≥ 5.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createServer } = require('../server/src/index.js');
const PILOT = require('../server/src/pilot.js');
const RET = require('../server/src/retention.js');

function client(base) {
  let ck = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
}

test('"Var det forkert?": kun dag, art, årsagskode og bevistype – ingen elev, lærer eller klokkeslæt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pilot-fb-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    assert.strictEqual((await client(base)('POST', '/api/feedback', { kind: 'lampe', reason: 'video', source: 'klasse' }))._status, 401, 'kun lærere');
    const call = client(base);
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette Lærer', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('POST', '/api/feedback', { kind: 'lampe', reason: 'video', source: 'klasse', studentId: 7, name: 'Anna' })).ok, true);
    assert.strictEqual((await call('POST', '/api/feedback', { kind: 'afslag', reason: 'tempo', source: 'word' })).ok, true);
    assert.strictEqual((await call('POST', '/api/feedback', { kind: 'afslag', reason: '<script>', source: 'hjemme' })).ok, true);
    assert.strictEqual((await call('POST', '/api/feedback', { kind: 'andet', reason: 'tempo', source: 'klasse' }))._status, 400);
    assert.strictEqual((await call('POST', '/api/feedback', { kind: 'afslag', reason: 'tempo', source: 'Anna' }))._status, 400);
    const cols = srv.db.prepare('PRAGMA table_info(feedback)').all().map(c => c.name);
    assert.deepStrictEqual(cols, ['id', 'day', 'kind', 'reason', 'source'], 'ingen elev, lærer eller tidspunkt');
    const rows = srv.db.prepare('SELECT day, kind, reason, source FROM feedback ORDER BY id').all().map(r => ({ ...r }));
    assert.deepStrictEqual(rows.map(r => [r.kind, r.reason, r.source]), [['lampe', 'video', 'klasse'], ['afslag', 'tempo', 'word'], ['afslag', 'andet', 'hjemme']]);
    assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!JSON.stringify(rows).includes('Anna'));
    // Slettes efter revisionssporets frist
    srv.db.prepare("UPDATE feedback SET day = '2020-01-01' WHERE id = 1").run();
    assert.strictEqual(RET.purge(srv.db, RET.fromEnv({})).feedback, 1);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pilottal: månedstal for hele skolen, k ≥ 5, ingen navne, ingen opdeling pr. lærer og ingen AI-forsøg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pilot-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const db = srv.db;
  let closed = false;
  try {
    const T0 = Date.UTC(2027, 1, 3, 8, 0); // februar 2027
    // To lærere med hver sin klasse og navngivne elever
    db.prepare("INSERT INTO teachers (id, email, name, pass_hash, created) VALUES (91, 'a@x.dk', 'Lærer Alfa', 'x', 0), (92, 'b@x.dk', 'Lærer Beta', 'x', 0)").run();
    db.prepare("INSERT INTO classes (id, teacher_id, name, created) VALUES (91, 91, 'Klasse Alfa', 0), (92, 92, 'Klasse Beta', 0)").run();
    const names = [];
    for (let i = 0; i < 12; i++) { const n = 'Elevnavn' + i; names.push(n); db.prepare('INSERT INTO students (id, class_id, name, created, enrolled) VALUES (?, ?, ?, 0, 1)').run(900 + i, i < 6 ? 91 : 92, n); }
    // Seks lektioner: alle elever bliver grønne efter 2 min.; én elev rød (video) i 3 min. pr. lektion; én elev rød af AI
    for (let l = 0; l < 6; l++) {
      const id = 9000 + l, start = T0 + l * 86400_000, cls = l < 3 ? 91 : 92;
      db.prepare('INSERT INTO lessons (id, class_id, started, ends_at, ended) VALUES (?, ?, ?, ?, ?)').run(id, cls, start, start + 45 * 60_000, start + 45 * 60_000);
      const kids = (cls === 91 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11]).map(i => 900 + i);
      for (const sid of kids) {
        db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'grey', 'Ingen forbindelse (netværk?)')").run(sid, id, start);
        db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'green', '')").run(sid, id, start + 2 * 60_000);
      }
      db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'red', 'Video og streaming: www.youtube.com')").run(kids[0], id, start + 10 * 60_000);
      db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'green', '')").run(kids[0], id, start + 13 * 60_000);
      db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'red', 'AI / chatbots: chatgpt.com')").run(kids[1], id, start + 20 * 60_000);
      db.prepare("INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?, ?, ?, 'green', '')").run(kids[1], id, start + 21 * 60_000);
    }
    // Afleveringer: 8 med mærke, 6 afslag for tempo, 2 for indsat (under k)
    const doc = (i, cert, cats) => db.prepare('INSERT INTO documents (id, student_id, class_id, title, created, updated, submitted, result, cert_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 900 + (i % 12), i % 12 < 6 ? 91 : 92, 'Titel med Elevnavn' + i, T0, T0, T0 + i * 1000, JSON.stringify({ categories: cats.map(key => ({ key })) }), cert ? 'c' + i : null);
    for (let i = 0; i < 8; i++) doc(i, true, []);
    for (let i = 8; i < 14; i++) doc(i, false, ['tempo']);
    for (let i = 14; i < 16; i++) doc(i, false, ['indsat']);
    // "Var det forkert?": 5 røde lamper (video) og 1 afslag
    for (let i = 0; i < 5; i++) PILOT.record(db, { kind: 'lampe', reason: 'video', source: 'klasse' }, T0 + 1000);
    PILOT.record(db, { kind: 'afslag', reason: 'tempo', source: 'klasse' }, T0 + 1000);
    for (let i = 0; i < 7; i++) db.prepare("INSERT INTO audit_log (ts, teacher_id, action, student_id) VALUES (?, 91, 'afspillede dokument', 900)").run(T0 + i);

    const rows = PILOT.stats(db, { from: Date.UTC(2027, 1, 1), to: Date.UTC(2027, 2, 1) });
    for (const r of rows) assert.deepStrictEqual(Object.keys(r), ['month', 'metric', 'reason', 'value', 'n', 'note'], 'kun disse felter – ingen lærer, klasse eller elev');
    assert.ok(rows.every(r => r.month === '2027-02'), 'kun månedstal');
    const get = (metric, reason = '') => rows.find(r => r.metric === metric && r.reason === reason);
    assert.strictEqual(get('lektioner').value, 6);
    assert.strictEqual(get('minutter til alle er grønne (median)').value, 2);
    assert.strictEqual(get('røde minutter', 'video').value, 18);
    assert.strictEqual(get('grå minutter', 'Ingen forbindelse').value, 72);
    assert.ok(!rows.some(r => /ai|AI/.test(r.reason) && /røde/.test(r.metric)), 'AI-forsøg tælles ikke');
    assert.strictEqual(get('afleveringer').value, 16);
    assert.strictEqual(get('andel med mærke (%)').value, 50);
    assert.strictEqual(get('afslag', 'tempo').value, 6);
    assert.deepStrictEqual([get('afslag', 'indsat').value, get('afslag', 'indsat').note], ['', 'færre end 5'], 'k ≥ 5');
    assert.strictEqual(get('markeret forkert: rød lampe', 'video (klasse)').value, 5);
    assert.strictEqual(get('markeret forkert: afslag', 'tempo (klasse)').value, '', 'én markering vises ikke');
    assert.strictEqual(get('åbnede afspilninger').value, 7);
    // CSV: ingen navne – hverken elever, lærere, klasser, titler eller værter
    const csv = PILOT.toCsv(rows);
    for (const bad of [...names, 'Lærer Alfa', 'Lærer Beta', 'Klasse Alfa', 'Klasse Beta', 'Titel', 'youtube', 'chatgpt']) assert.ok(!csv.includes(bad), bad);
    // Forbuddet står i koden: ingen lærer, klasse, navne eller GROUP BY i pilot.js' SQL
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'pilot.js'), 'utf8');
    const sql = (src.match(/'(SELECT|INSERT)[^']*'|"SELECT[^"]*"/g) || []).join('\n');
    assert.ok(sql.length > 100, sql);
    assert.ok(!/teacher|class_id|\bname\b|title|GROUP BY/i.test(sql), sql);
    // npm run enkel -- pilottal 2027-02
    await srv.close();
    closed = true;
    const p = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'enkel.js'), 'pilottal', '2027-02'], { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.match(p.stdout, /^﻿Måned;Måling;Årsag;Værdi;Antal;Note\r\n/);
    assert.match(p.stdout, /2027-02;andel med mærke \(%\);;50;16;/);
    for (const bad of names) assert.ok(!p.stdout.includes(bad));
  } finally { if (!closed) await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dashboardet: "Var det forkert?" ved rød lampe i elevskuffen og ved afslag på mærket', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'app.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'index.html'), 'utf8');
  assert.match(idx, /id="d-wrong" hidden[^>]*>Var det forkert\?</);
  assert.match(app, /\$\('#d-wrong'\)\.hidden = v\.color !== 'red';/);
  assert.match(app, /text: 'Var afslaget forkert\?'/);
  assert.match(app, /api\('\/api\/feedback', \{ method: 'POST', body: \{ kind, reason: pick\.value \|\| reasons\[0\], source \} \}\)/);
});
