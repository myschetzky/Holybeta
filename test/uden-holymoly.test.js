'use strict';
// "Uden HolyMoly (andet udstyr)": eleven vises neutralt (ikke gråt), tæller ikke med i grå minutter, markeringen står i
// revisionssporet – og den virker kun for elever uden forbindelse, så den aldrig kan vaske en rød (eller lukket) lampe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const PILOT = require('../server/src/pilot.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('uden HolyMoly: neutral uden forbindelse, ingen grå minutter, i revisionssporet – og ingen vask af rød', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-other-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  let ws;
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const enroll = (name) => fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) }).then(r => r.json());
    const mac = await enroll('Mads Mac');
    const win = await enroll('Wilma Windows');
    const view = (sid) => srv.hub.studentView(sid);
    assert.strictEqual(view(mac.studentId).color, 'grey', 'uden markering: grå');

    // Læreren markerer eleven med Mac
    assert.strictEqual((await call('PUT', `/api/students/${mac.studentId}/other-device`, { on: 'ja' }))._status, 400);
    const s = await call('PUT', `/api/students/${mac.studentId}/other-device`, { on: true });
    assert.strictEqual(s.otherDevice, true);
    assert.deepStrictEqual([view(mac.studentId).color, view(mac.studentId).activity], ['other', 'Uden HolyMoly (andet udstyr)']);
    const audit = srv.db.prepare('SELECT action, teacher_id FROM audit_log WHERE student_id = ?').all(mac.studentId).map(r => r.action);
    assert.deepStrictEqual(audit, ['markerede uden HolyMoly']);

    // Lektionen: Mads er neutral hele vejen og tæller ikke med i grå minutter
    const r = await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    const lessonId = r.lesson.id;
    await sleep(100);
    const rows = srv.db.prepare('SELECT color FROM lesson_colors WHERE lesson_id = ? AND student_id = ?').all(lessonId, mac.studentId).map(x => x.color);
    assert.ok(rows.length && rows.every(c => c === 'other'), rows.join());
    // Markeringen virker ikke for en elev med forbindelse: Wilma markeres, forbinder og bliver rød – rød vinder
    await call('PUT', `/api/students/${win.studentId}/other-device`, { on: true });
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    await new Promise(res => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'hello', tokens: [win.token], device: { os: 'Windows', host: 'PC', version: '1.3.0' } }));
    await sleep(200);
    ws.send(JSON.stringify({ type: 'status', activity: 'x', violations: [{ kind: 'site', text: 'Video og streaming: youtube.com', category: 'video' }], degraded: [] }));
    await sleep(150);
    assert.strictEqual(view(win.studentId).color, 'red', 'en rød lampe kan ikke vaskes');
    // Wilma lukker forbindelsen midt i lektionen: grå (hun har været forbundet i timen) – ikke neutral
    ws.close();
    await sleep(200);
    assert.strictEqual(view(win.studentId).color, 'grey');

    // Lektionsrapporten: Mads har kun "uden HolyMoly"-minutter, ingen grå
    srv.db.prepare('UPDATE lessons SET started = started - 600000 WHERE id = ?').run(lessonId);
    srv.db.prepare('UPDATE lesson_colors SET ts = ts - 600000 WHERE lesson_id = ?').run(lessonId);
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    const rep = await call('GET', `/api/classes/${cls.id}/lessons/${lessonId}`);
    const mads = rep.students.find(x => x.id === mac.studentId);
    assert.ok(mads.grey < 1000, 'ingen grå minutter (højst millisekunder før første måling)');
    assert.ok(mads.other >= 590_000, String(mads.other));
    const csv = await (await fetch(`${base}/api/classes/${cls.id}/lessons/${lessonId}.csv`, { headers: { Cookie: ck } })).text();
    assert.match(csv, /Uden HolyMoly \(min\)/);
    // Pilottallene: ingen grå minutter fra Mads
    const grey = PILOT.stats(srv.db, { from: 0, to: Date.now() + 1 }).filter(x => x.metric === 'grå minutter');
    assert.ok(!grey.some(x => /Uden HolyMoly/.test(x.reason)), JSON.stringify(grey));

    // Markeringen fjernes: grå igen, og det står i revisionssporet
    await call('PUT', `/api/students/${mac.studentId}/other-device`, { on: false });
    assert.strictEqual(view(mac.studentId).color, 'grey');
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE student_id = ? AND action = 'fjernede uden HolyMoly'").get(mac.studentId));
  } finally {
    if (ws) ws.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboardet: knappen i elevskuffen, neutral lampe og forklaring i signaturforklaringen', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');
  assert.match(pub('index.html'), /id="d-other" hidden title="Uden HolyMoly \(andet udstyr\)[^>]*>Uden HolyMoly</);
  assert.match(pub('index.html'), /<i class="lamp other"><\/i>Uden HolyMoly \(andet udstyr\)/);
  assert.match(pub('app.css'), /\.lamp\.other \{/);
  const app = pub('app.js');
  assert.match(app, /\$\('#d-other'\)\.hidden = !s\.otherDevice && !!v\.online;/);
  assert.match(app, /api\(`\/api\/students\/\$\{id\}\/other-device`, \{ method: 'PUT', body: \{ on \} \}\)/);
  assert.match(app, /Der udstedes intet bevis/);
});
