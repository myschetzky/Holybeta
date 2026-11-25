'use strict';
// Skrivetime: klassens lektion, hvor eleverne skriver én aflevering (lessons.write_assignment_id, l.writeAssignment).
// Den er en lektion i klassen – aldrig "hjemme".
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
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
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

test('skrivetime: lektion med én aflevering – i timen, ikke hjemme – og kun klassens egne afleveringer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-writelesson-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base);
    await A('POST', '/api/register', { email: 'a@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await A('POST', '/api/classes', { name: '2.g Dansk' });
    const asg = await A('POST', `/api/classes/${cls.id}/assignments`, { title: 'Novelleanalyse', due: Date.now() + 86400_000 });
    // En anden lærer med sin egen klasse og aflevering
    const B = client(base);
    await B('POST', '/api/register', { email: 'b@x.dk', name: 'Bo', password: 'tavle-kridt-4321', signupCode: 'k' });
    const clsB = await B('POST', '/api/classes', { name: '3.x' });
    const asgB = await B('POST', `/api/classes/${clsB.id}/assignments`, { title: 'Bos opgave' });

    // En fremmed lærers aflevering afvises – og en fremmed klasse kan ikke startes
    let r = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45, assignmentId: asgB.id });
    assert.strictEqual(r._status, 404);
    assert.strictEqual(srv.hub.lessonOf(cls.id), null, 'ingen lektion startet');
    r = await B('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45, assignmentId: asg.id });
    assert.strictEqual(r._status, 404);

    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const sid = en.studentId;
    const ag = await agent(base, en.token);

    r = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45, assignmentId: asg.id });
    assert.strictEqual(r.lesson.live, true);
    assert.deepStrictEqual(r.lesson.write, { assignmentId: asg.id, title: 'Novelleanalyse' });
    const lesson = await ag.wait(m => m.type === 'lesson' && m.live);
    assert.deepStrictEqual(lesson.write, { assignmentId: asg.id, title: 'Novelleanalyse' }, 'appen får write.assignmentId');
    assert.strictEqual(lesson.solo, null, 'ikke en skriveøkt');
    // Klassens lektion har writeAssignment – aldrig assignmentId (det ville gøre den til "hjemme")
    const l = srv.hub.lessonOf(cls.id);
    assert.strictEqual(l.assignmentId, undefined);
    assert.deepStrictEqual(l.writeAssignment, { id: asg.id, title: 'Novelleanalyse' });
    assert.strictEqual(srv.hub.isHome(sid), false);
    assert.strictEqual(srv.hub.policyFor(sid).kind, 'klasse');
    assert.strictEqual(srv.db.prepare('SELECT write_assignment_id FROM lessons WHERE id = ?').get(l.id).write_assignment_id, asg.id);

    // Eleven skriver og afleverer: mærket siger "i timen"
    const id = crypto.randomUUID();
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    const text = 'Novellen handler om en pige der flytter fra byen ud på landet og finder sig selv.';
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Novelleanalyse', blocks: blocksOf(text), stats: STATS }));
    assert.strictEqual((await ag.wait(m => m.type === 'doc-saved')).ok, true);
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Novelleanalyse', blocks: blocksOf(text + ' Slut.'), stats: STATS }));
    const res = await ag.wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));
    assert.deepStrictEqual(srv.docs.placeOf(id), { home: false, lesson: true }, 'placeOf: lektion');
    assert.match(D.label(res.facts.place), /· i timen$/);

    // Ny sluttid uden assignmentId: skrivetimen fortsætter. assignmentId: null gør den til en almindelig lektion.
    r = await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 60 });
    assert.deepStrictEqual(r.lesson.write, { assignmentId: asg.id, title: 'Novelleanalyse' });
    ag.close();
    await srv.close();

    // Skrivetimen overlever en genstart
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    assert.deepStrictEqual(srv.hub.lessonOf(cls.id).writeAssignment, { id: asg.id, title: 'Novelleanalyse' });
    const A2 = client(base);
    await A2('POST', '/api/login', { email: 'a@x.dk', password: 'tavle-kridt-1234' });
    r = await A2('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 60, assignmentId: null });
    assert.strictEqual(r.lesson.write, undefined, 'almindelig lektion igen');
    assert.strictEqual(srv.hub.lessonOf(cls.id).writeAssignment, null);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skrivetime: kan slås fra med BETA_FEATURES=-writeLesson', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-writelesson2-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, betaFeatures: '-writeLesson', dbaDate: '2026-11-20',
    schoolApproval: { controller: 'Testskolen', dpo: 'dpo@x.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-02' } });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const A = client(base);
    assert.ok((await A('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: srv.setupCode() })).ok);
    const cls = await A('POST', '/api/classes', { name: '2.g' });
    const asg = await A('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil' });
    assert.strictEqual((await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45, assignmentId: asg.id }))._status, 404);
    assert.strictEqual((await A('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 })).lesson.live, true);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
