'use strict';
// Skriveøkt hjemme: læreren ser hverken skærm, skærmbilleder, faner eller programmer
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
function frame(header, payload) {
  const h = Buffer.from(JSON.stringify(header));
  const b = Buffer.alloc(5 + h.length + payload.length);
  b[0] = 1; b.writeUInt32BE(h.length, 1); h.copy(b, 5); payload.copy(b, 5 + h.length);
  return b;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ws(url, headers) {
  const w = new WebSocket(url, { headers });
  w.msgs = []; w.bins = [];
  w.on('message', (d, bin) => { if (bin) w.bins.push(d); else w.msgs.push(JSON.parse(d.toString())); });
  w.wait = async (f, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) { const m = w.msgs.find(f); if (m) { w.msgs.splice(w.msgs.indexOf(m), 1); return m; } await sleep(20); }
    throw new Error('ingen besked – fik: ' + JSON.stringify(w.msgs.map(m => m.type)));
  };
  return new Promise((res, rej) => { w.on('open', () => res(w)); w.on('error', rej); });
}

test('skriveøkt hjemme: ingen skærm, skærmbilleder, faner eller programmer til læreren', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
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
    // Selv med automatiske skærmbilleder slået til for klassen
    await call('PATCH', `/api/classes/${cls.id}`, { config: { autoEvidence: true } });
    const home = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const sid = en.studentId;
    const agent = await ws(base.replace('http', 'ws') + '/ws/agent');
    agent.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await agent.wait(m => m.type === 'welcome');
    const teacher = await ws(base.replace('http', 'ws') + '/ws/teacher?classId=' + cls.id, { Cookie: ck, Origin: base });
    await teacher.wait(m => m.type === 'snapshot');

    // Læreren kigger med, før eleven starter en skriveøkt – det lukkes, når skriveøkten starter
    teacher.send(JSON.stringify({ type: 'watch', studentId: sid }));
    await teacher.wait(m => m.type === 'detail');
    agent.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    assert.strictEqual((await agent.wait(m => m.type === 'write-session-result')).ok, true);
    await agent.wait(m => m.type === 'lesson' && m.live && m.solo);
    const dropped = await teacher.wait(m => m.type === 'error');
    assert.strictEqual(dropped.message, 'Skriveøkt hjemme: skærmen kan ikke ses');
    assert.strictEqual(srv.hub.isHome(sid), true);
    assert.ok(!srv.hub.watchers.has(sid), 'ingen kigger med');
    assert.strictEqual(srv.hub.studentView(sid).solo, 'Stil hjemme');

    // Se skærm og Tag skærmbillede afvises
    teacher.send(JSON.stringify({ type: 'watch', studentId: sid }));
    assert.strictEqual((await teacher.wait(m => m.type === 'error')).message, 'Skriveøkt hjemme: skærmen kan ikke ses');
    teacher.send(JSON.stringify({ type: 'screenshot', studentId: sid }));
    assert.strictEqual((await teacher.wait(m => m.type === 'error')).message, 'Skriveøkt hjemme: skærmen kan ikke ses');
    await sleep(100);
    assert.ok(!agent.msgs.some(m => m.type === 'screenshot'), 'appen bliver ikke bedt om et skærmbillede');
    assert.ok(!agent.msgs.some(m => m.type === 'stream' && m.mode !== 'off'), 'appen sender ingen billeder');
    assert.ok(!teacher.msgs.some(m => m.type === 'detail' && m.detail && m.detail.tabs && m.detail.tabs.length), 'ingen faner');

    // Faner og programmer fra appen sendes ikke videre og gemmes ikke
    agent.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations: [{ kind: 'site', text: 'AI: chatgpt.com', category: 'ai' }], degraded: [],
      tabs: [{ url: 'https://privat.dk/side', title: 'Privat', active: true }], apps: [{ name: 'Spotify', category: '' }] }));
    await teacher.wait(m => m.type === 'student' && m.student.studentId === sid && m.student.color === 'red');
    assert.strictEqual(srv.hub.detail.get(sid), undefined, 'faner og apps gemmes ikke');
    assert.strictEqual(srv.hub._autoEvidence(sid), false, 'aldrig automatiske skærmbilleder hjemme');
    // Billeder fra appen (live eller som skærmbillede) smides væk
    agent.send(frame({ kind: 'live', screen: 0, screens: 1 }, JPEG));
    agent.send(frame({ kind: 'evidence', reason: 'Overtrædelse' }, JPEG));
    agent.send(JSON.stringify({ type: 'events', seq: 1, items: [{ kind: 'violation', title: 'AI: chatgpt.com', category: 'ai' }] }));
    await agent.wait(m => m.type === 'ack');
    agent.send(frame({ kind: 'evidence', reason: 'Overtrædelse' }, JPEG));
    await sleep(200);
    assert.strictEqual(teacher.bins.length, 0);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0, 'intet skærmbillede gemt');
    assert.ok(!teacher.msgs.some(m => m.type === 'detail' && m.detail && (m.detail.tabs || []).length), 'ingen faner til læreren');

    // Skriveøkten slutter, og en lektion i klassen starter: så kan læreren se skærmen igen
    agent.msgs.length = 0;
    agent.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: false }));
    await agent.wait(m => m.type === 'lesson' && !m.live);
    assert.strictEqual(srv.hub.isHome(sid), false);
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await agent.wait(m => m.type === 'lesson' && m.live && !m.solo);
    assert.strictEqual(srv.hub._autoEvidence(sid), true);
    teacher.msgs.length = 0;
    teacher.send(JSON.stringify({ type: 'watch', studentId: sid }));
    await agent.wait(m => m.type === 'stream' && m.mode === 'live');
    assert.ok(!teacher.msgs.some(m => m.type === 'error'), JSON.stringify(teacher.msgs.filter(m => m.type === 'error')));
    agent.close(); teacher.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
