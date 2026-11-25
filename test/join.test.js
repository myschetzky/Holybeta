'use strict';
// Eleverne tilmelder sig selv med lærerens klassekode + deres navn
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/src/index.js');

test('klassekode: eleven tilmelder sig med navn og dukker op i klasseværelset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-join-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json(), { _status: r.status });
  };
  const enroll = async (body) => { const r = await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return Object.assign(await r.json(), { _status: r.status }); };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const created = await call('POST', '/api/classes', { name: '2.g Dansk' });
    assert.match(created.joinCode, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/, 'klassen får en klassekode');
    let cls = await call('GET', '/api/classes/' + created.id);
    assert.strictEqual(cls.joinCode, created.joinCode);
    assert.strictEqual(cls.joinOpen, true);
    assert.strictEqual(cls.students.length, 0);

    // 1) Kun koden: serveren beder om navnet og fortæller hvilken klasse det er
    let r = await enroll({ code: created.joinCode.toLowerCase().replace('-', ' ') });
    assert.strictEqual(r._status, 400);
    assert.strictEqual(r.needName, true);
    assert.strictEqual(r.className, '2.g Dansk');
    assert.strictEqual(r.teacherName, 'Mette');
    assert.strictEqual((await enroll({ code: created.joinCode, name: '12' })).needName, true, 'navnet skal være et navn');

    // 2) Kode + navn: eleven er tilmeldt og står i klasseværelset med det samme
    r = await enroll({ code: created.joinCode, name: '  Anna   Jensen ' });
    assert.strictEqual(r._status, 200);
    assert.ok(r.token.length > 30);
    assert.strictEqual(r.studentName, 'Anna Jensen');
    cls = await call('GET', '/api/classes/' + created.id);
    assert.strictEqual(cls.students.length, 1);
    assert.ok(cls.students[0].joined && cls.students[0].enrolled);
    assert.strictEqual((await call('GET', '/api/classes'))[0].count, 1);
    const ev = await call('GET', `/api/students/${r.studentId}/events?kind=alerts&limit=10&before=${Date.now() + 1000}`);
    assert.match(ev.events[0].title, /tilmeldte sig med klassekoden/);

    // 3) Samme navn igen = ny elev, men læreren får besked
    const r2 = await enroll({ code: created.joinCode, name: 'anna jensen' });
    assert.strictEqual(r2._status, 200);
    assert.notStrictEqual(r2.studentId, r.studentId);
    const ev2 = await call('GET', `/api/students/${r2.studentId}/events?kind=alerts&limit=10&before=${Date.now() + 1000}`);
    assert.match(ev2.events[0].title, /allerede en elev med det navn/);

    // 4) Læreren har skrevet et navn ind på forhånd: eleven får den plads (vises først når eleven er tilmeldt)
    await call('POST', `/api/classes/${created.id}/students`, { names: ['Bo Nielsen'] });
    cls = await call('GET', '/api/classes/' + created.id);
    const bo = cls.students.find(s => s.name === 'Bo Nielsen');
    assert.strictEqual(bo.joined, false, 'ikke tilmeldte vises ikke');
    const r3 = await enroll({ code: created.joinCode, name: 'Bo Nielsen' });
    assert.strictEqual(r3.studentId, bo.id);

    // 5) Ny kode til én elev (ny computer): eleven bliver i klasseværelset
    await call('POST', `/api/students/${r.studentId}/invite`, {});
    cls = await call('GET', '/api/classes/' + created.id);
    const anna = cls.students.find(s => s.id === r.studentId);
    assert.ok(anna.joined && !anna.enrolled && anna.inviteCode);

    // 6) Lukket for tilmelding, og en ny klassekode gør den gamle ugyldig
    let j = await call('POST', `/api/classes/${created.id}/joincode`, { action: 'close' });
    assert.strictEqual(j.joinOpen, false);
    r = await enroll({ code: created.joinCode, name: 'Carl Holm' });
    assert.strictEqual(r._status, 403);
    assert.match(r.error, /lukket for tilmelding/);
    await call('POST', `/api/classes/${created.id}/joincode`, { action: 'open' });
    j = await call('POST', `/api/classes/${created.id}/joincode`, { action: 'new' });
    assert.notStrictEqual(j.joinCode, created.joinCode);
    assert.strictEqual((await enroll({ code: created.joinCode, name: 'Carl Holm' }))._status, 404, 'den gamle kode virker ikke længere');
    assert.strictEqual((await enroll({ code: j.joinCode, name: 'Carl Holm' }))._status, 200);

    // 7) Bordene overlapper ikke, når elever tilmelder sig én ad gangen
    const big = await call('POST', '/api/classes', { name: 'Stor klasse' });
    for (let i = 0; i < 14; i++) assert.strictEqual((await enroll({ code: big.joinCode, name: 'Elev ' + String.fromCharCode(65 + i) + ' Hansen' }))._status, 200);
    let desks = (await call('GET', '/api/classes/' + big.id)).students;
    const cols = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(desks.length * 1.8))));
    const rows = Math.ceil(desks.length / cols);
    for (const a of desks) for (const b2 of desks) {
      if (a.id >= b2.id) continue;
      assert.ok(Math.abs(a.x - b2.x) > 0.8 * 0.88 / cols || Math.abs(a.y - b2.y) > 0.8 * 0.78 / rows, `${a.name} og ${b2.name} overlapper`);
    }
    // Har læreren flyttet bordene, bliver de stående, når en ny elev kommer
    await call('PUT', `/api/classes/${big.id}/layout`, { positions: [{ id: desks[0].id, x: 0.9, y: 0.9 }] });
    const before = (await call('GET', '/api/classes/' + big.id)).students.map(s => [s.id, s.x, s.y].join());
    await enroll({ code: big.joinCode, name: 'Ny Elev' });
    const after = (await call('GET', '/api/classes/' + big.id)).students;
    for (const row of before) assert.ok(after.some(s => [s.id, s.x, s.y].join() === row), 'lærerens placering er uændret');

    // 8) En anden lærer kan ikke ændre klassekoden
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('POST', `/api/classes/${created.id}/joincode`, { action: 'new' }))._status, 404);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
