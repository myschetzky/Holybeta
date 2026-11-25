'use strict';
// Dataminimering af weblog og faner: tilladte sider kun som værtsnavn, vinduestitler kun for forbudte eller ukendte
// programmer, og fane-listen viser kun forbudte faner (resten er et antal). Serveren håndhæver det, uanset appen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

test('weblog og faner: kun det, lampen og blokeringen bruger, gemmes og vises', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mini-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const base = 'http://127.0.0.1:' + await srv.listen();
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return Object.assign(await r.json().catch(() => ({})), { _status: r.status });
  };
  let ag;
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g' });
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna' }) })).json();
    ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Windows 11', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    await wait(m => m.type === 'lesson' && m.live);

    // Weblog og programskift – som en gammel app ville sende dem (fuld adresse og titler)
    ag.send(JSON.stringify({ type: 'events', seq: 1, items: [
      { kind: 'nav', url: 'https://docs.google.com/document/d/hemmeligt-id/edit?q=psykolog', title: 'Ansøgning til psykolog - Google Docs', ts: Date.now() },
      { kind: 'blocked', url: 'https://chatgpt.com/c/123', title: 'chatgpt.com', category: 'ai', blocked: true, ts: Date.now() },
      { kind: 'app', app: 'WINWORD', title: 'Ansøgning til psykolog.docx - Word', ts: Date.now() },
      { kind: 'app', app: 'mitspil', title: 'Mit hemmelige spil', ts: Date.now() },
      { kind: 'app', app: 'Discord', title: 'Discord - #klassen', ts: Date.now() },
    ] }));
    await wait(m => m.type === 'ack' && m.seq === 1);
    const rows = srv.db.prepare('SELECT kind, url, title, app FROM events WHERE student_id = ? AND kind IN (\'nav\', \'blocked\', \'app\') ORDER BY id').all(en.studentId).map(r => ({ ...r }));
    // Tilladt side: kun værtsnavnet, ingen titel
    assert.deepStrictEqual(rows[0], { kind: 'nav', url: 'docs.google.com', title: null, app: null });
    // Blokeret: fuld adresse
    assert.strictEqual(rows[1].url, 'https://chatgpt.com/c/123');
    // Kendt program (Word): ingen vinduestitel. Ukendt og forbudt program: titlen bliver
    assert.deepStrictEqual(rows.slice(2).map(r => [r.app, r.title]), [['WINWORD', null], ['mitspil', 'Mit hemmelige spil'], ['Discord', 'Discord - #klassen']]);
    assert.ok(!JSON.stringify(rows).includes('psykolog'));

    // Fanerne: kun forbudte med adresse og titel – resten som et antal. Appens eget "blocked" tæller ikke.
    ag.send(JSON.stringify({ type: 'status', activity: 'Chrome', url: 'https://docs.google.com/', violations: [], degraded: [], tabs: [
      { url: 'https://docs.google.com/document/d/x', title: 'Ansøgning til psykolog', active: true, browser: 'Chrome', blocked: true },
      { url: 'https://www.dr.dk/nyheder', title: 'DR', active: false, browser: 'Chrome' },
      { url: 'https://chatgpt.com/', title: 'ChatGPT', active: false, browser: 'Chrome', blocked: false },
    ], apps: [{ name: 'WINWORD', category: '', blocked: false }] }));
    let d;
    for (let i = 0; i < 100 && !(d = srv.hub.detail.get(en.studentId)); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(d, 'detail');
    assert.strictEqual(d.allowedTabs, 2);
    assert.deepStrictEqual(d.tabs.map(t => t.url), ['https://chatgpt.com/']);
    assert.strictEqual(d.tabs[0].blocked, true);
    assert.ok(!JSON.stringify(d).includes('psykolog'));
    // Dashboardet viser "N tilladte faner"
    const app = fs.readFileSync(path.join(__dirname, '..', 'server/public/app.js'), 'utf8');
    assert.match(app, /tilladte \$\{okTabs === 1 \? 'fane' : 'faner'\}/);
  } finally {
    if (ag) ag.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
