#!/usr/bin/env node
/*
 * Test-harness til vagt-testene på rigtige Windows/Mac-maskiner (GitHub Actions).
 * Starter en rigtig HolyMoly-server, opretter lærer/klasse/elev, forbinder en "elev-app" (WebSocket),
 * afleverer parringskoden til vagten (requests/pair.txt) og starter en lektion.
 * Styring på http://127.0.0.1:18081:  GET /view  GET /events  POST /stop  POST /start
 *   node harness.js <datamappe-til-vagten> <os-navn> <sti til "HolyMoly"-binærfil (kopi af node)>
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../../server/src/index.js');

const { spawn } = require('node:child_process');
const guardData = process.argv[2];
const osName = process.argv[3] || 'Windows 11';
const trayExe = process.argv[4];

/* Kald uden genbrugte forbindelser (keep-alive), så vagten ikke ser harnessen som en klient */
function request(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: 18080, path: p, method, agent: false,
      headers: Object.assign({ Connection: 'close' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, cookie ? { Cookie: cookie } : {}) }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const srv = createServer({ port: 18080, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hm-h-')), signupCode: 'k', quiet: true });
  await srv.listen();
  const base = 'http://127.0.0.1:18080';
  let ck = '';
  const call = async (method, p, body) => {
    const r = await request(method, p, body, ck);
    const sc = r.headers['set-cookie']; if (sc) ck = String(sc[0]).split(';')[0];
    return r.json;
  };
  await call('POST', '/api/register', { email: 'l@x.dk', name: 'Lærer', password: 'tavle-kridt-1234', signupCode: 'k' });
  const cls = await call('POST', '/api/classes', { name: 'Test' });
  await call('PATCH', '/api/classes/' + cls.id, { config: { extraBlocked: ['example-blocked-site.com'] } });
  const st = (await call('POST', `/api/classes/${cls.id}/students`, { names: ['Eva'] })).students[0];
  const en = (await request('POST', '/api/enroll', { code: st.inviteCode })).json;
  await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 30 });
  // Den (simulerede) ægte elev-app køres fra installationsmappens HolyMoly-binærfil.
  // Den får parringskoden fra serveren og afleverer den til vagten – præcis som den rigtige app.
  const tray = spawn(trayExe, [path.join(__dirname, 'fake-tray.js'), en.token, osName, guardData], { stdio: 'inherit' });
  process.on('exit', () => tray.kill());

  http.createServer(async (req, res) => {
    let out = {};
    if (req.url === '/view') out = srv.hub.studentView(st.id);
    else if (req.url === '/events') out = (await call('GET', `/api/students/${st.id}/events?kind=alerts`)).events;
    else if (req.url === '/stop') { srv.hub.stopLesson(cls.id); out = { ok: true }; }
    else if (req.url === '/start') { srv.hub.startLesson(cls.id, 30); out = { ok: true }; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  }).listen(18081, '127.0.0.1', () => console.log('harness klar, elev', st.id));
})().catch((e) => { console.error(e); process.exit(1); });
