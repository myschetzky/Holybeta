'use strict';
// Serveren genstarter midt i en skriveøkt: eleverne får 'server-restart', økten genskabes med samme lessons.id,
// og når eleven forbinder igen, kan teksten gemmes og afleveres med bevis.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const blocksOf = (text) => [{ t: 'h1', r: [{ x: 'Stil' }] }, { t: 'p', r: [{ x: text }] }];
const STATS = { typed: 400, keystrokes: 380, maxCps: 5, regularity: 0.6 };
const TEXT = 'Jeg skriver hjemme om romantikken og digterne i Danmark omkring år 1800 og deres syn på naturen.';

async function agent(base, token) {
  const w = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
  w.msgs = [];
  w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d.toString())); });
  w.closed = new Promise(r => w.on('close', (code) => r(code)));
  w.wait = async (f, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await sleep(20); }
    throw new Error('ingen besked – fik: ' + JSON.stringify(w.msgs.map(m => m.type)));
  };
  await new Promise((res, rej) => { w.on('open', res); w.on('error', rej); });
  w.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Linux', version: '1.3.0' } }));
  await w.wait(m => m.type === 'welcome');
  return w;
}

test('genstart midt i en skriveøkt: besked til eleven, samme økt bagefter og et gyldigt bevis', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-restart-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, publicUrl: 'https://holymoly.test', minProofWords: 10 });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  try {
    let ck = '';
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
      return r.json().catch(() => ({}));
    };
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const home = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const sid = en.studentId;
    let ag = await agent(base, en.token);
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await ag.wait(m => m.type === 'write-session-result')).ok, true);
    await ag.wait(m => m.type === 'lesson' && m.live && m.solo);
    const lessonId = srv.hub.solo.get(sid).id;
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    const id = crypto.randomUUID();
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(TEXT), stats: STATS }));
    assert.strictEqual((await ag.wait(m => m.type === 'doc-saved')).ok, true);
    // Lad som om eleven har skrevet i 20 min.
    srv.db.prepare("UPDATE documents SET monitor = json_set(monitor, '$.greenMs', 1200000) WHERE id = ?").run(id);

    // Serveren lukker (SIGTERM, opdatering): eleven får 'server-restart' og lukkekode 1012 (Service Restart)
    await srv.close();
    await ag.wait(m => m.type === 'server-restart');
    assert.strictEqual(await ag.closed, 1012);

    // Ny start med samme data inden for 10 sek.: skriveøkten er genskabt (venter på eleven), og kørslen sluttede rent
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    const runs = srv.db.prepare('SELECT clean FROM server_runs ORDER BY start').all();
    assert.deepStrictEqual(runs.map(r => r.clean), [1, 0]);
    const s = srv.hub.solo.get(sid);
    assert.ok(s && s.id === lessonId && s.pausedAt > 0, 'økten er genskabt med samme lessons.id');
    assert.strictEqual(srv.hub.isHome(sid), true);
    assert.strictEqual(srv.hub.policyFor(sid).kind, 'hjemme');

    ag = await agent(base, en.token);
    const l = await ag.wait(m => m.type === 'lesson' && m.live);
    assert.deepStrictEqual(l.solo, { assignmentId: home.id, title: 'Stil hjemme' });
    ag.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true, resume: true }));
    assert.strictEqual((await ag.wait(m => m.type === 'write-session-result')).ok, true);
    assert.strictEqual(srv.hub.solo.get(sid).id, lessonId);
    ag.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await sleep(100);
    const more = TEXT + ' Om natur og følelser.'; // lidt ny tekst (under 30 tegn på kort tid)
    ag.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(more), stats: STATS }));
    assert.strictEqual((await ag.wait(m => m.type === 'doc-saved')).ok, true);
    await sleep(1600);
    ag.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf(more), stats: STATS }));
    const res = await ag.wait(m => m.type === 'doc-result');
    assert.ok(res.ok && res.certId, JSON.stringify(res));
    assert.strictEqual(res.kind, 'hjemme');
    const pub = await (await fetch(base + '/api/bevis/' + res.certId)).json();
    assert.strictEqual(pub.payload.kind, 'hjemme');
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
