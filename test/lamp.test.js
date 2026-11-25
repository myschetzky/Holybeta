'use strict';
// Lampen: rød vinder over grå (en bekræftet overtrædelse må aldrig skjules af en grå tilstand)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('lampen: rød vinder over grå – både appens og vagtens fund', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-lamp-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return r.json().catch(() => ({}));
  };
  let ws;
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna' }) })).json();
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await sleep(150);
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await sleep(150);
    const status = (violations, degraded) => ws.send(JSON.stringify({ type: 'status', activity: 'x', violations, degraded }));
    const view = () => srv.hub.studentView(en.studentId);

    status([], []);
    await sleep(120);
    assert.strictEqual(view().color, 'green');
    // Appen melder både en manglende udvidelse (grå) og ChatGPT i forgrunden (rød): rød
    status([{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }], [{ kind: 'ext', text: 'Udvidelsen mangler' }]);
    await sleep(120);
    assert.strictEqual(view().color, 'red');
    // Kun grå
    status([], [{ kind: 'ext', text: 'Udvidelsen mangler' }]);
    await sleep(120);
    assert.strictEqual(view().color, 'grey');
    // Vagtens fund, mens appen er stille (ingen forbindelse): rød – ikke grå
    srv.hub.status.get(en.studentId).stale = true;
    assert.strictEqual(view().color, 'grey');
    srv.hub.guardAlerts.set(en.studentId, [{ text: 'To vagter på samme computer', until: Date.now() + 60_000 }]);
    const v = view();
    assert.strictEqual(v.color, 'red');
    assert.ok(v.violations.some(x => /To vagter/.test(x.text)));
  } finally {
    if (ws) ws.terminate();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
