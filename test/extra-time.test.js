'use strict';
// Ekstra tid (fx ordblinde): samme lektion (samme id) varer længere for enkelte elever. Eleven er stadig "i timen" –
// aldrig "hjemme" – og vagten og blokeringen følger med.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');
const D = require('../shared/doc.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const blocksOf = (text) => [{ t: 'h1', r: [{ x: 'Romantikken' }] }, { t: 'p', r: [{ x: text }] }];
const STATS = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };

function client(base) {
  let ck = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    const text = await r.text();
    try { return Object.assign(JSON.parse(text), { _status: r.status, _text: text }); } catch (e) { return { _status: r.status, _text: text }; }
  };
}
async function agent(base, token) {
  const w = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
  w.msgs = [];
  w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d.toString())); });
  w.wait = async (f, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await sleep(20); }
    throw new Error('ingen besked – fik: ' + JSON.stringify(w.msgs.map(m => m.type)));
  };
  await new Promise((res, rej) => { w.on('open', res); w.on('error', rej); });
  w.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Linux', version: '1.3.0' } }));
  await w.wait(m => m.type === 'welcome');
  return w;
}
const enroll = async (base, code, name) => (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })).json();

test('ekstra tid: samme lektion efter stop, "i timen" på beviset, genstart og "Afslut for alle"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-extra-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10, staleMs: 400 });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base);
    await A('POST', '/api/register', { email: 'a@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await A('POST', '/api/classes', { name: '2.g Dansk' });
    const other = await A('POST', '/api/classes', { name: '3.x' });
    const anna = await enroll(base, cls.joinCode, 'Anna Jensen');
    const bo = await enroll(base, cls.joinCode, 'Bo Hansen');
    const fremmed = await enroll(base, other.joinCode, 'Carl');
    const agA = await agent(base, anna.token);
    const agB = await agent(base, bo.token);

    // Ingen lektion: ingen ekstra tid
    assert.strictEqual((await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 15 }))._status, 409);
    const start = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    const lessonId = start.lesson.id;
    await agA.wait(m => m.type === 'lesson' && m.live);
    await agB.wait(m => m.type === 'lesson' && m.live);

    assert.strictEqual((await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 20 }))._status, 400, 'kun +10, +15 eller +30');
    assert.strictEqual((await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [fremmed.studentId], minutes: 15 }))._status, 404, 'kun klassens egne elever');
    const ext = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 15 });
    assert.strictEqual(ext._status, 200, ext._text);
    assert.deepStrictEqual(ext.lesson.extra.map(e => e.studentId), [anna.studentId]);
    assert.ok(Math.abs(ext.lesson.extra[0].until - (start.lesson.endsAt + 15 * 60_000)) < 2000);
    assert.strictEqual(ext.lesson.endsAt, start.lesson.endsAt, 'klassens sluttid er uændret');
    // Appen får elevens egen sluttid
    const l2 = await agA.wait(m => m.type === 'lesson' && m.live && m.endsAt > start.lesson.endsAt);
    assert.ok(Math.abs(l2.endsAt - ext.lesson.extra[0].until) < 5);
    // +15 igen lægges oven i
    const ext2 = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 15 });
    assert.ok(Math.abs(ext2.lesson.extra[0].until - (start.lesson.endsAt + 30 * 60_000)) < 2000);

    // Anna skriver i timen
    const id = crypto.randomUUID();
    agA.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    const text = 'Romantikken var en periode hvor følelser og natur fik stor plads i kunsten og digtningen.';
    agA.send(JSON.stringify({ type: 'doc', id, title: 'Romantikken', blocks: blocksOf(text), stats: STATS }));
    assert.strictEqual((await agA.wait(m => m.type === 'doc-saved')).ok, true);

    // Læreren afslutter – men lader Anna skrive færdig
    agA.msgs.length = 0; agB.msgs.length = 0;
    const stop = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    assert.strictEqual(stop.lesson.live, false);
    assert.strictEqual(stop.lesson.extended.id, lessonId);
    assert.deepStrictEqual(stop.lesson.extra.map(e => e.studentId), [anna.studentId]);
    assert.strictEqual(srv.hub.lessonOf(cls.id), null, 'klassens lektion er slut');
    await agB.wait(m => m.type === 'lesson' && !m.live);
    assert.strictEqual(srv.hub.lessonFor(bo.studentId), null);
    const la = srv.hub.lessonFor(anna.studentId);
    assert.strictEqual(la.id, lessonId, 'samme lesson_id');
    assert.strictEqual(srv.hub.isHome(anna.studentId), false, 'ikke hjemme');
    assert.strictEqual(srv.hub.policyFor(anna.studentId).kind, 'klasse');
    assert.ok(!agA.msgs.some(m => m.type === 'lesson' && !m.live), 'Anna mister ikke lektionen');
    assert.strictEqual(srv.hub.studentView(anna.studentId).color, 'green');

    // Afleveringen efter klassens slut: mærket siger "i timen"
    agA.send(JSON.stringify({ type: 'doc-submit', id, title: 'Romantikken', blocks: blocksOf(text + ' Slut.'), stats: STATS }));
    const res = await agA.wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));
    assert.deepStrictEqual(srv.docs.placeOf(id), { home: false, lesson: true });
    assert.match(D.label(res.facts.place), /· i timen$/);
    // Ekstra tid står aldrig i loggen, rapporten eller beviset
    const logged = srv.db.prepare('SELECT title FROM events WHERE student_id = ?').all(anna.studentId).map(e => e.title).join('\n');
    assert.doesNotMatch(logged, /ekstra tid|\+\d+ min/i);
    const csv = await A('GET', `/api/classes/${cls.id}/lessons/${lessonId}.csv`);
    assert.doesNotMatch(csv._text, /ekstra|\+\d+ min/i);
    const proof = await (await fetch(base + '/api/bevis/' + res.certId)).text();
    assert.doesNotMatch(proof, /ekstra|\+\d+ min/i);
    agA.close(); agB.close();
    await sleep(50);
    await srv.close();

    // Genstart: lektionen genindlæses for Anna
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    srv.hub.studentClass.set(anna.studentId, cls.id);
    srv.hub.studentClass.set(bo.studentId, cls.id);
    assert.strictEqual(srv.hub.lessonFor(anna.studentId).id, lessonId, 'ekstra tid overlever en genstart');
    assert.strictEqual(srv.hub.lessonFor(bo.studentId), null);
    const A2 = client(base);
    await A2('POST', '/api/login', { email: 'a@x.dk', password: 'tavle-kridt-1234' });
    assert.deepStrictEqual((await A2('GET', `/api/classes/${cls.id}`)).lesson.extra.map(e => e.studentId), [anna.studentId]);

    // "Afslut for alle"
    const all = await A2('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop', all: true });
    assert.strictEqual(all.lesson.extra, undefined);
    assert.strictEqual(srv.hub.lessonFor(anna.studentId), null);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM lesson_extensions').get().n, 0);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ekstra tid: udløber af sig selv, og en ny lektion afslutter den forrige ekstra tid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-extra2-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, staleMs: 400 });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base);
    await A('POST', '/api/register', { email: 'a@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await A('POST', '/api/classes', { name: '2.g' });
    const anna = await enroll(base, cls.joinCode, 'Anna');
    const ag = await agent(base, anna.token);
    await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 10 });
    await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    assert.ok(srv.hub.lessonFor(anna.studentId));
    // Den ekstra tid er (næsten) gået
    const l = srv.hub.extended.get(cls.id);
    ag.msgs.length = 0;
    srv.hub.ext.get(l.id).set(anna.studentId, Date.now() + 150);
    await ag.wait(m => m.type === 'lesson' && !m.live, 3000);
    assert.strictEqual(srv.hub.lessonFor(anna.studentId), null);
    assert.strictEqual(srv.hub.extended.has(cls.id), false);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM lesson_extensions').get().n, 0);

    // Ny forlængelse, stop – og så starter en ny lektion: den gamle ekstra tid er væk
    await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'extend', studentIds: [anna.studentId], minutes: 30 });
    const old = (await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' })).lesson.extended.id;
    const fresh = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.notStrictEqual(fresh.lesson.id, old);
    assert.strictEqual(fresh.lesson.extra, undefined);
    assert.strictEqual(srv.hub.lessonFor(anna.studentId).id, fresh.lesson.id);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
