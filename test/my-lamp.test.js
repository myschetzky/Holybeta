'use strict';
// Elevens egen lampe (my-lamp): kun til elevens egen app, ved farveskift og højst hvert 10. sek.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
const status = (w, violations = []) => w.send(JSON.stringify({ type: 'status', activity: 'HolyMoly – Skriv', violations, degraded: [] }));

test('my-lamp: kun til elevens egen app, ved farveskift, højst hvert 10. sek. – hjemme med kategorien', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mylamp-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return r.json().catch(() => ({}));
  };
  const enroll = async (code, name) => (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })).json();
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    const home = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil hjemme', home: true, due: Date.now() + 86400_000 });
    const anna = await enroll(cls.joinCode, 'Anna Jensen');
    const bo = await enroll(cls.joinCode, 'Bo Nielsen');
    const a = await agent(base, anna.token);
    const b = await agent(base, bo.token);

    // Uden lektion: ingen lampe
    status(a);
    await sleep(100);
    assert.ok(!a.msgs.some(m => m.type === 'my-lamp'));

    // Skriveøkt hjemme: grøn, når appen har meldt sin første status
    a.send(JSON.stringify({ type: 'write-session', assignmentId: home.id, on: true }));
    await a.wait(m => m.type === 'lesson' && m.live && m.solo);
    await sleep(100);
    assert.ok(!a.msgs.some(m => m.type === 'my-lamp'), 'ingen lampe før appens første status');
    status(a);
    const green = await a.wait(m => m.type === 'my-lamp');
    assert.deepStrictEqual(green, { type: 'my-lamp', color: 'green', reason: '', home: true });

    // Samme farve igen: intet nyt
    status(a);
    await sleep(150);
    assert.ok(!a.msgs.some(m => m.type === 'my-lamp'), 'kun ved farveskift');

    // Rød inden for 10 sek.: venter – og sendes, når de 10 sek. er gået (her: et senere "nu")
    status(a, [{ kind: 'site', text: 'AI: chatgpt.com', category: 'ai' }]);
    await sleep(150);
    assert.ok(!a.msgs.some(m => m.type === 'my-lamp'), 'højst hvert 10. sek.');
    const conn = srv.hub.agentByStudent.get(anna.studentId);
    assert.strictEqual(conn.myLamp.pending, true);
    srv.hub._myLamp(anna.studentId, null, Date.now() + 10_500);
    const red = await a.wait(m => m.type === 'my-lamp');
    assert.deepStrictEqual(red, { type: 'my-lamp', color: 'red', reason: 'AI / chatbots', home: true }, 'kun kategorien – aldrig adressen');

    // Klassekammeraten får aldrig Annas lampe
    assert.ok(!b.msgs.some(m => m.type === 'my-lamp'));
    a.close(); b.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
