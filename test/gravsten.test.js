'use strict';
// Gravsten: slettes teksten (klasse slettet eller frist nået), lever beviset videre uden navn. Kun "Slet elev" sletter beviset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

const blocksOf = (text) => [{ t: 'p', r: [{ x: text }] }];

test('gravsten: et slettet dokument efterlader et gyldigt bevis uden navn – også efter genstart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-grav-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, minProofWords: 10 });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  const sockets = [];
  async function agent(token) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    sockets.push(ws);
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ws.on('open', r));
    ws.wait = async (f) => { for (let i = 0; i < 200; i++) { const m = ws.msgs.find(f); if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ws.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await ws.wait(m => m.type === 'welcome');
    return ws;
  }
  /** Skriv og aflever et kort dokument i en lektion. Returnerer bevisets id. */
  async function writeProof(ws, classId) {
    await call('POST', `/api/classes/${classId}/lesson`, { action: 'start', minutes: 45 });
    await ws.wait(m => m.type === 'lesson' && m.live);
    ws.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    const id = crypto.randomUUID();
    const stats = { typed: 200, keystrokes: 180, maxCps: 5, regularity: 0.6 };
    const t = 'Romantikken var en periode i kunsten, hvor følelser og natur fik plads.';
    ws.send(JSON.stringify({ type: 'doc', id, title: 'Stil', blocks: blocksOf(t), stats }));
    assert.strictEqual((await ws.wait(m => m.type === 'doc-saved')).ok, true);
    await new Promise(r => setTimeout(r, 1100));
    ws.send(JSON.stringify({ type: 'doc-submit', id, title: 'Stil', blocks: blocksOf(t), stats }));
    const res = await ws.wait(m => m.type === 'doc-result');
    assert.ok(res.certId, JSON.stringify(res));
    await call('POST', `/api/classes/${classId}/lesson`, { action: 'stop' });
    return { certId: res.certId, docId: id };
  }
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const A = await call('POST', '/api/classes', { name: 'A' });
    const B = await call('POST', '/api/classes', { name: 'B' });
    const enroll = async (code, name) => (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })).json();
    const anna = await enroll(A.joinCode, 'Anna Jensen');
    const bo = await enroll(B.joinCode, 'Bo Nielsen');

    // 1) Klassen slettes: beviset bliver en gravsten
    const a = await agent(anna.token);
    const pa = await writeProof(a, A.id);
    const before = await call('GET', '/api/bevis/' + pa.certId);
    assert.strictEqual(before.owner.student, 'Anna Jensen');
    assert.strictEqual(before.docDeleted, null);
    assert.strictEqual((await call('DELETE', '/api/classes/' + A.id))._status, 200);
    a.close();

    // 2) Genstart: gravstenen er der stadig (ingen oprydning ved opstart)
    await srv.close();
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    const after = await call('GET', '/api/bevis/' + pa.certId);
    assert.strictEqual(after._status, 200);
    assert.strictEqual(after.valid, true);
    assert.ok(after.docDeleted > 0, 'docDeleted er sat');
    assert.strictEqual(after.owner, undefined, 'intet navn efter sletning');
    assert.strictEqual(after.payload.sha256.length, 64, 'teksten kan stadig tjekkes med filen');
    const row = srv.db.prepare('SELECT doc_id, student_name, class_name, text_sha256 FROM certificates WHERE id = ?').get(pa.certId);
    assert.deepStrictEqual({ ...row }, { doc_id: '', student_name: '', class_name: '', text_sha256: after.payload.sha256 });

    // 3) Et id, der aldrig er udstedt: 404 med teksten "aldrig udstedt"
    const never = await call('GET', '/api/bevis/xxxxxxxxxxxxxxxx');
    assert.strictEqual(never._status, 404);
    assert.match(never.error, /aldrig udstedt/);

    // 4) Slet elev: beviset slettes helt
    const b = await agent(bo.token);
    const pb = await writeProof(b, B.id);
    assert.strictEqual((await call('DELETE', '/api/students/' + bo.studentId))._status, 200);
    assert.strictEqual((await call('GET', '/api/bevis/' + pb.certId))._status, 404);
    b.close();
  } finally {
    for (const s of sockets) s.terminate();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
