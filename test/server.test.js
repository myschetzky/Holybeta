'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test-'));
let srv, base, cookie;

async function req(method, p, body, opts = {}) {
  const res = await fetch(base + p, {
    method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, cookie && !opts.anon ? { Cookie: cookie } : {}, opts.headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc && !opts.anon) cookie = sc.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch (e) { /* */ }
  return { status: res.status, data };
}

function wsClient(p, headers) {
  const ws = new WebSocket(base.replace('http', 'ws') + p, { headers });
  ws.msgs = [];
  ws.bins = [];
  ws.on('message', (d, bin) => { if (bin) ws.bins.push(d); else ws.msgs.push(JSON.parse(d.toString())); });
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); ws.on('unexpected-response', (_r, resp) => rej(new Error('HTTP ' + resp.statusCode))); });
}
async function waitFor(ws, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find(pred);
    if (m) return m;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Timeout – fik: ' + JSON.stringify(ws.msgs.map(m => m.type)));
}
function frame(header, payload) {
  const h = Buffer.from(JSON.stringify(header));
  const b = Buffer.alloc(5 + h.length + payload.length);
  b[0] = 1; b.writeUInt32BE(h.length, 1); h.copy(b, 5); payload.copy(b, 5 + h.length);
  return b;
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

test.before(async () => {
  srv = createServer({ port: 0, host: '127.0.0.1', dataDir, signupCode: 'skole123', quiet: true, staleMs: 1500, requireGuard: false });
  const port = await srv.listen();
  base = 'http://127.0.0.1:' + port;
});
test.after(async () => { await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('fuldt forløb: lærer, klasse, elev, lektion, status, frys, live, log', async () => {
  // Oprettelse kræver skolekode
  assert.strictEqual((await req('POST', '/api/register', { email: 'l@skole.dk', name: 'Lærer', password: 'tavle-kridt-1234', signupCode: 'forkert' })).status, 403);
  assert.strictEqual((await req('POST', '/api/register', { email: 'l@skole.dk', name: 'Lærer', password: 'tavle-kridt-1234', signupCode: 'skole123' })).status, 200);
  assert.strictEqual((await req('GET', '/api/me')).data.name, 'Lærer');

  const cls = (await req('POST', '/api/classes', { name: '2.g Dansk' })).data;
  const added = (await req('POST', `/api/classes/${cls.id}/students`, { names: ['Anna', 'Bo'] })).data.students;
  assert.strictEqual(added.length, 2);
  const anna = added[0];
  assert.match(anna.inviteCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Eleven tilmelder sig med koden (uden login-cookie)
  const bad = await req('POST', '/api/enroll', { code: 'AAAA-AAAA' }, { anon: true });
  assert.strictEqual(bad.status, 404);
  const en = await req('POST', '/api/enroll', { code: anna.inviteCode.toLowerCase().replace('-', '') }, { anon: true });
  assert.strictEqual(en.status, 200);
  assert.strictEqual(en.data.studentName, 'Anna');
  // Koden kan kun bruges én gang
  assert.strictEqual((await req('POST', '/api/enroll', { code: anna.inviteCode }, { anon: true })).status, 404);

  // Elev-appen forbinder
  const agent = await wsClient('/ws/agent');
  agent.send(JSON.stringify({ type: 'hello', tokens: [en.data.token, 'x'.repeat(40)], device: { os: 'Windows 11', host: 'PC-1' } }));
  const welcome = await waitFor(agent, m => m.type === 'welcome');
  assert.strictEqual(welcome.enrollments[0].studentName, 'Anna');
  assert.ok(welcome.rules.domains.ai.includes('chatgpt.com'));
  await waitFor(agent, m => m.type === 'lesson' && m.live === false);

  // Læreren åbner klassen
  const teacher = await wsClient('/ws/teacher?classId=' + cls.id, { Cookie: cookie, Origin: base });
  const snap = await waitFor(teacher, m => m.type === 'snapshot');
  assert.strictEqual(snap.students.find(s => s.studentId === anna.id).color, 'idle');
  assert.strictEqual(snap.students.find(s => s.studentId !== anna.id).color, 'grey');

  // Uden lektion ignoreres status fra eleven
  agent.send(JSON.stringify({ type: 'status', activity: 'før lektion', violations: [] }));

  // Lektion startes -> appen får besked + regler
  await req('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
  const lesson = await waitFor(agent, m => m.type === 'lesson' && m.live);
  assert.strictEqual(lesson.className, '2.g Dansk');
  assert.ok(lesson.config.categories.ai);
  // Ingen billeder af skærmen, før læreren klikker på eleven
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!agent.msgs.some(m => m.type === 'stream' && m.mode !== 'off'), 'ingen billeder uden klik');
  agent.send(frame({ kind: 'feed' }, JPEG));
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(teacher.bins.length, 0, 'serveren videresender ikke billeder læreren ikke har bedt om');

  // Status: grøn, derefter rød
  agent.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk stil', violations: [], degraded: [] }));
  await waitFor(teacher, m => m.type === 'student' && m.student.color === 'green' && m.student.activity.includes('Dansk stil'));

  // Manglende tilladelse -> grå med årsag
  agent.send(JSON.stringify({ type: 'status', activity: 'Pages', violations: [], degraded: [{ kind: 'screen', text: 'Mangler tilladelse til skærmoptagelse' }] }));
  const g = await waitFor(teacher, m => m.type === 'student' && m.student.color === 'grey' && m.student.online);
  assert.match(g.student.greyReason, /skærmoptagelse/);

  // Appen holder op med at sende status -> grå; kommer den igen -> grøn
  agent.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk stil', violations: [], degraded: [] }));
  const stale = await waitFor(teacher, m => m.type === 'student' && m.student.color === 'grey' && /forbindelse/i.test(m.student.greyReason), 4000);
  agent.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk stil', violations: [], degraded: [] }));
  await waitFor(teacher, m => m.type === 'student' && m.student.color === 'green' && teacher.msgs.indexOf(m) > teacher.msgs.indexOf(stale));
  agent.send(JSON.stringify({ type: 'status', activity: 'chatgpt.com', violations: [{ kind: 'site', text: 'AI: chatgpt.com', category: 'ai' }] }));
  const red = await waitFor(teacher, m => m.type === 'student' && m.student.color === 'red');
  assert.strictEqual(red.student.violations[0].text, 'AI: chatgpt.com');


  // Læreren kigger med -> live-billeder + kvittering
  teacher.send(JSON.stringify({ type: 'watch', studentId: anna.id }));
  await waitFor(agent, m => m.type === 'stream' && m.mode === 'live');
  const before = teacher.bins.length;
  agent.send(frame({ kind: 'live', screen: 0, screens: 2 }, JPEG));
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(teacher.bins.length, before + 1);
  const acks = agent.msgs.filter(m => m.type === 'frameAck').length;
  teacher.send(JSON.stringify({ type: 'frameAck', studentId: anna.id }));
  await waitFor(agent, () => agent.msgs.filter(m => m.type === 'frameAck').length > acks);

  // Læreren tager et skærmbillede -> appen sender det -> gemt under hændelser
  teacher.send(JSON.stringify({ type: 'screenshot', studentId: anna.id }));
  await waitFor(agent, m => m.type === 'screenshot');
  agent.send(frame({ kind: 'evidence', reason: 'Skærmbillede taget af læreren' }, JPEG));
  const shot = await waitFor(teacher, m => m.type === 'event' && m.event.kind === 'evidence');
  assert.strictEqual(shot.event.title, 'Skærmbillede taget af læreren');

  // Frys
  teacher.send(JSON.stringify({ type: 'freeze', studentIds: [anna.id], on: true, message: 'Kig op' }));
  const fz = await waitFor(agent, m => m.type === 'freeze' && m.on);
  assert.strictEqual(fz.message, 'Kig op');
  await waitFor(teacher, m => m.type === 'student' && m.student.frozen);

  // Gennemgang: alle skærme på standby med ur og tid tilbage (appen får lektionens sluttid)
  teacher.send(JSON.stringify({ type: 'freeze', all: true, on: true, mode: 'review', message: '' }));
  const rv = await waitFor(agent, m => m.type === 'freeze' && m.on && m.mode === 'review');
  assert.ok(rv.endsAt > Date.now(), 'appen får lektionens sluttid');
  await waitFor(teacher, m => m.type === 'student' && m.student.review && m.student.frozen);
  teacher.send(JSON.stringify({ type: 'freeze', all: true, on: false }));
  await waitFor(agent, m => m.type === 'freeze' && !m.on);
  const reviewLog = (await req('GET', `/api/students/${anna.id}/events?kind=alerts`)).data.events.map(e => e.title).join(' | ');
  assert.match(reviewLog, /startede gennemgang/);
  assert.match(reviewLog, /afsluttede gennemgangen/);
  teacher.send(JSON.stringify({ type: 'freeze', studentIds: [anna.id], on: true, message: 'Kig op' }));
  await waitFor(agent, m => m.type === 'freeze' && m.on && m.mode === 'freeze');

  // Web-log
  agent.send(JSON.stringify({ type: 'events', seq: 3, items: [
    { kind: 'nav', url: 'https://docs.google.com/x', title: 'Dansk stil', ts: Date.now() },
    { kind: 'blocked', url: 'https://chatgpt.com/', title: 'chatgpt.com', category: 'ai', blocked: true, ts: Date.now() },
    { kind: 'hack', url: 'x' },
  ] }));
  await waitFor(agent, m => m.type === 'ack' && m.seq === 3);
  agent.send(frame({ kind: 'evidence', reason: 'AI: chatgpt.com' }, JPEG));
  await new Promise(r => setTimeout(r, 200));
  const log = (await req('GET', `/api/students/${anna.id}/events?kind=web`)).data.events;
  assert.deepStrictEqual(log.map(e => e.kind).sort(), ['blocked', 'nav']);
  const alerts = (await req('GET', `/api/students/${anna.id}/events?kind=alerts`)).data.events;
  const ev = alerts.find(e => e.kind === 'evidence');
  assert.ok(ev && ev.evidenceId);
  const img = await fetch(base + '/api/evidence/' + ev.evidenceId, { headers: { Cookie: cookie } });
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');

  // Eksport af elevens log (CSV) – beskyttet mod formel-injektion
  agent.send(JSON.stringify({ type: 'events', seq: 4, items: [{ kind: 'violation', url: 'https://x.dk/', title: '=HYPERLINK("http://ond.dk")', ts: Date.now() }] }));
  await waitFor(agent, m => m.type === 'ack' && m.seq === 4);
  const csvRes = await fetch(base + `/api/students/${anna.id}/export.csv`, { headers: { Cookie: cookie } });
  assert.strictEqual(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csv = await csvRes.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/ond\.dk""\)"/);
  assert.match(csv, /chatgpt\.com/);

  // Eleven lukker appen -> grå med besked til læreren
  agent.send(JSON.stringify({ type: 'bye', reason: 'quit' }));
  agent.close();
  const gone = await waitFor(teacher, m => m.type === 'student' && m.student.studentId === anna.id && !m.student.online);
  assert.strictEqual(gone.student.color, 'grey');
  assert.strictEqual(gone.student.closed.reason, 'Eleven lukkede appen');
  const tamper = (await req('GET', `/api/students/${anna.id}/events?kind=alerts`)).data.events.find(e => e.kind === 'tamper');
  assert.ok(tamper);

  // Lektion stoppes
  await req('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
  await waitFor(teacher, m => m.type === 'lesson' && !m.lesson.live);
  teacher.close();
});

test('sikkerhed: adgang og validering', async () => {
  // En anden lærer kan ikke se den første lærers klasser
  const first = cookie;
  cookie = null;
  await req('POST', '/api/register', { email: 'b@skole.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'skole123' });
  const theirs = await req('GET', '/api/classes');
  assert.strictEqual(theirs.data.length, 0);
  assert.strictEqual((await req('GET', '/api/classes/1')).status, 404);
  assert.strictEqual((await req('GET', '/api/students/1/events')).status, 404);
  assert.strictEqual((await req('GET', '/api/evidence/1')).status, 404);
  await assert.rejects(wsClient('/ws/teacher?classId=1', { Cookie: cookie, Origin: base }));
  cookie = first;
  // Cross-site POST afvises
  assert.strictEqual((await req('POST', '/api/classes', { name: 'x' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  // Ikke-JSON afvises
  const r = await fetch(base + '/api/classes', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
  assert.strictEqual(r.status, 415);
  // Ugyldige elev-tokens smides af
  const agent = await wsClient('/ws/agent');
  agent.send(JSON.stringify({ type: 'hello', tokens: ['y'.repeat(43)] }));
  await new Promise((res) => agent.on('close', (code) => { assert.strictEqual(code, 4401); res(); }));
  // Uden login
  assert.strictEqual((await req('GET', '/api/classes', null, { anon: true })).status, 401);
  // Sikkerheds-headers
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
  // websockets kun til serveren selv – ikke "ws: wss:" (= enhver vært, som en indsprøjtet side kunne sende data til)
  const csp = page.headers.get('content-security-policy');
  const connect = /connect-src ([^;]*)/.exec(csp)[1].split(' ');
  assert.ok(!connect.includes('ws:') && !connect.includes('wss:'), csp);
  assert.ok(connect.includes(base.replace('http', 'ws')), csp);
  assert.match(csp, /object-src 'none'/);
  assert.strictEqual(page.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.strictEqual((await fetch(base + '/api/classes', { headers: { Cookie: cookie } })).headers.get('cross-origin-resource-policy'), 'same-origin');
  // Et falsk Host-navn kommer ikke med i CSP'en
  const evilCsp = await new Promise((resolve, reject) => {
    require('node:http').get(base + '/', { headers: { Host: 'evil.example;script-src *' } }, (r) => { r.resume(); resolve(r.headers['content-security-policy']); }).on('error', reject);
  });
  assert.doesNotMatch(evilCsp, /evil|script-src \*/);
  // Path traversal
  const trav = await fetch(base + '/..%2f..%2fsrc%2findex.js');
  assert.notStrictEqual(await trav.text(), fs.readFileSync(path.join(__dirname, '../server/src/index.js'), 'utf8'));
});

test('login rate-limit', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await req('POST', '/api/login', { email: 'x@skole.dk', password: 'forkert' }, { anon: true });
  assert.strictEqual(last.status, 429);
});

test('for gammel elev-app får ingen lektion og vises grå "Skal opdatere"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test2-'));
  const s2 = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, minAgentVersion: '1.1.0', downloadUrl: 'https://example.com/hm' });
  const port = await s2.listen();
  const b = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(b + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return r.json();
  };
  try {
    await call('POST', '/api/register', { email: 'x@y.dk', name: 'X', password: 'tavle-kridt-1234', signupCode: 'k' });
    const c = await call('POST', '/api/classes', { name: 'K' });
    const st = (await call('POST', `/api/classes/${c.id}/students`, { names: ['Eva'] })).students[0];
    const en = await (await fetch(b + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st.inviteCode }) })).json();
    await call('POST', `/api/classes/${c.id}/lesson`, { action: 'start', minutes: 30 });
    const ag = new WebSocket(b.replace('http', 'ws') + '/ws/agent');
    ag.msgs = [];
    ag.on('message', (d, bin) => { if (!bin) ag.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'macOS 14', host: 'Mac', version: '1.0.0' } }));
    const w = await waitFor(ag, m => m.type === 'welcome');
    assert.strictEqual(w.updateRequired, true);
    assert.strictEqual(w.downloadUrl, 'https://example.com/hm');
    await waitFor(ag, m => m.type === 'lesson' && m.live === false);
    const view = s2.hub.studentView(st.id);
    assert.strictEqual(view.color, 'grey');
    assert.strictEqual(view.greyReason, 'Skal opdatere HolyMoly');
    ag.close();
  } finally {
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sikkerhed: regressionstests fra sikkerhedseftersynet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sec-'));
  const s3 = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const port = await s3.listen();
  const b = 'http://127.0.0.1:' + port;
  const mk = () => {
    let ck = '';
    const call = async (method, p, body) => {
      const r = await fetch(b + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    return { call, cookie: () => ck };
  };
  try {
    // 1) Ugyldig cookie-kodning må ikke kunne få serveren til at gå ned
    await new Promise((resolve) => {
      const sock = require('node:net').connect(port, '127.0.0.1', () => {
        sock.write('GET /ws/teacher?classId=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: hm_session=%E0%A4%A\r\n\r\n');
      });
      sock.on('data', () => {}); sock.on('close', resolve); sock.on('error', resolve);
    });
    assert.strictEqual((await fetch(b + '/healthz')).status, 200, 'serveren kører stadig');

    // 2) Lærer A må ikke kunne se en elev hos lærer B via et genbrugt id
    const A = mk(), B = mk();
    await A.call('POST', '/api/register', { email: 'a@x.dk', name: 'A', password: 'tavle-kridt-1234', signupCode: 'k' });
    await B.call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    const ca = (await A.call('POST', '/api/classes', { name: 'A-klasse' })).data;
    const tmp = (await A.call('POST', `/api/classes/${ca.id}/students`, { names: ['Midlertidig'] })).data.students[0];
    await A.call('DELETE', '/api/students/' + tmp.id);
    const cb = (await B.call('POST', '/api/classes', { name: 'B-klasse' })).data;
    const victim = (await B.call('POST', `/api/classes/${cb.id}/students`, { names: ['Offer'] })).data.students[0];
    assert.notStrictEqual(victim.id, tmp.id, 'slettede id\'er genbruges ikke');
    const tA = new WebSocket(b.replace('http', 'ws') + '/ws/teacher?classId=' + ca.id, { headers: { Cookie: A.cookie(), Origin: b } });
    tA.msgs = []; tA.bins = [];
    tA.on('message', (d, bin) => { if (bin) tA.bins.push(d); else tA.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => tA.on('open', r));
    for (const id of [tmp.id, victim.id]) tA.send(JSON.stringify({ type: 'watch', studentId: id }));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!tA.msgs.some(m => m.type === 'detail' && m.studentId === victim.id), 'A får intet om B\'s elev');
    tA.close();

    // 3) Elev-appen kan ikke sende skærmbilleder af sig selv eller forfalske lærer-logbogen
    const en = await (await fetch(b + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: victim.inviteCode }) })).json();
    await B.call('POST', `/api/classes/${cb.id}/lesson`, { action: 'start', minutes: 30 });
    const ag = new WebSocket(b.replace('http', 'ws') + '/ws/agent');
    ag.msgs = [];
    ag.on('message', (d, bin) => { if (!bin) ag.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { version: '9.9.9' } }));
    await waitFor(ag, m => m.type === 'lesson' && m.live);
    ag.send(frame({ kind: 'evidence', reason: 'Falsk' }, JPEG));
    ag.send(JSON.stringify({ type: 'events', seq: 1, items: [
      { kind: 'info', title: 'B optøede skærmen', detail: { audit: true } },
      { kind: 'teacher', title: 'B så skærmen live' },
    ] }));
    await waitFor(ag, m => m.type === 'ack');
    await new Promise(r => setTimeout(r, 200));
    const ev = (await B.call('GET', `/api/students/${victim.id}/events`)).data.events;
    assert.ok(!ev.some(e => e.kind === 'evidence'), 'uopfordret skærmbillede afvist');
    assert.ok(!ev.some(e => e.kind === 'teacher'), 'eleven kan ikke skrive i lærer-logbogen');
    assert.ok(!ev.some(e => e.detail && e.detail.audit), 'audit-markering fjernet');
    // Automatiske skærmbilleder ved overtrædelser er slået fra som standard (dataminimering) ...
    ag.send(JSON.stringify({ type: 'status', activity: 'x', violations: [{ kind: 'site', text: 'AI: chatgpt.com' }], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    ag.send(frame({ kind: 'evidence', reason: 'AI: chatgpt.com' }, JPEG));
    await new Promise(r => setTimeout(r, 300));
    let ev2 = (await B.call('GET', `/api/students/${victim.id}/events`)).data.events;
    assert.strictEqual(ev2.filter(e => e.kind === 'evidence').length, 0, 'intet automatisk skærmbillede uden lærerens tilvalg');
    // ... men når læreren har slået det til, må en overtrædelse ledsages af ét skærmbillede
    await B.call('PATCH', `/api/classes/${cb.id}`, { config: { autoEvidence: true } });
    ag.send(JSON.stringify({ type: 'status', activity: 'x', violations: [{ kind: 'site', text: 'AI: claude.ai' }], degraded: [] }));
    await new Promise(r => setTimeout(r, 100));
    ag.send(frame({ kind: 'evidence', reason: 'AI: claude.ai' }, JPEG));
    await new Promise(r => setTimeout(r, 300));
    ev2 = (await B.call('GET', `/api/students/${victim.id}/events`)).data.events;
    assert.strictEqual(ev2.filter(e => e.kind === 'evidence').length, 1);
    ag.close();
  } finally {
    await s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sikkerhed: lærerens login har en absolut levetid (NIST SP 800-63B-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sess-'));
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, sessionMaxHours: 1 });
  const b = 'http://127.0.0.1:' + await s.listen();
  try {
    const r = await fetch(b + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'abs@skole.dk', name: 'Abs', password: 'tavle-kridt-1234', signupCode: 'k' }) });
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /Max-Age=3600/, 'cookien holder ikke længere end serveren tillader');
    const cookie = sc.split(';')[0];
    const me = () => fetch(b + '/api/me', { headers: { Cookie: cookie } }).then(x => x.status);
    assert.strictEqual(await me(), 200);
    const row = () => s.db.prepare('SELECT created, expires FROM sessions').get();
    const born = row().created;
    assert.ok(born > Date.now() - 60_000, 'login-tidspunktet gemmes');
    // Aktiv lærer, kort før grænsen: forlængelsen må ikke gå ud over login + 1 time
    s.db.prepare('UPDATE sessions SET created = ?, expires = ?').run(Date.now() - 50 * 60_000, Date.now() + 60_000);
    assert.strictEqual(await me(), 200);
    assert.ok(row().expires <= row().created + 3600_000, 'forlænges aldrig ud over den absolutte grænse');
    // Efter grænsen: logget ud, selv om sessionen ellers stadig var gyldig, og sessionen er slettet
    s.db.prepare('UPDATE sessions SET created = ?, expires = ?').run(Date.now() - 61 * 60_000, Date.now() + 6 * 3600_000);
    assert.strictEqual(await me(), 401);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    // Gamle sessioner (fra før "created") regnes fra deres seneste forlængelse
    const r2 = await fetch(b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'abs@skole.dk', password: 'tavle-kridt-1234' }) });
    const c2 = r2.headers.get('set-cookie').split(';')[0];
    // (forlænget for 10 min. siden = udløber om 12 t – 10 min.)
    s.db.prepare('UPDATE sessions SET created = NULL, expires = ?').run(Date.now() + 12 * 3600_000 - 10 * 60_000);
    assert.strictEqual(await fetch(b + '/api/me', { headers: { Cookie: c2 } }).then(x => x.status), 200, 'gammel session uden created virker stadig');
    // … og en gammel session, der blev forlænget for over en time siden, er udløbet
    s.db.prepare('UPDATE sessions SET created = NULL, expires = ?').run(Date.now() + 12 * 3600_000 - 61 * 60_000);
    assert.strictEqual(await fetch(b + '/api/me', { headers: { Cookie: c2 } }).then(x => x.status), 401);
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows: filen kan være låst et øjeblik */ }
  }
});

test('GDPR: overvågningsdata slettes efter LOG_RETENTION_DAYS – også lampernes tidslinje', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ret-'));
  const s = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false, retentionDays: 30 });
  const b = 'http://127.0.0.1:' + await s.listen();
  try {
    let ck = '';
    const call = async (method, p, body) => {
      const r = await fetch(b + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
      return r.json();
    };
    await call('POST', '/api/register', { email: 'ret@skole.dk', name: 'Ret', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '1.a' });
    const { students } = await call('POST', `/api/classes/${cls.id}/students`, { names: ['Anna'] });
    const sid = students[0].id;
    const old = Date.now() - 31 * 86400_000, recent = Date.now() - 86400_000;
    for (const ts of [old, recent]) {
      s.db.prepare('INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?,?,?,?,?)').run(sid, 1, ts, 'red', 'AI: chatgpt.com');
      s.db.prepare("INSERT INTO events (student_id, lesson_id, ts, kind, title) VALUES (?,?,?,'site',?)").run(sid, 1, ts, 'chatgpt.com');
    }
    s.retention();
    assert.deepStrictEqual(s.db.prepare('SELECT ts FROM lesson_colors').all().map(r => r.ts), [recent], 'gammel tidslinje slettet, ny bevaret');
    assert.deepStrictEqual(s.db.prepare('SELECT ts FROM events').all().map(r => r.ts), [recent]);
  } finally {
    await s.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});

test('OWASP A10: en glemt fejl i et løfte vælter ikke serveren', async () => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-a10-'));
  // Et lille script, der indlæses før serveren og laver en ubehandlet afvisning, når serveren kører
  const pre = path.join(dir, 'reject.js');
  fs.writeFileSync(pre, "setTimeout(() => { Promise.reject(new Error('test: glemt fejl')); }, 300);\n");
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-r', pre, path.join(__dirname, '../server/src/index.js')], {
    env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data') }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) { clearInterval(iv); resolve(m[1]); } else if (Date.now() - t0 > 10_000) { clearInterval(iv); reject(new Error('startede ikke: ' + out)); }
      }, 50);
    });
    await new Promise(r => setTimeout(r, 800));
    assert.match(out, /Uventet fejl \(serveren kører videre\)/);
    assert.strictEqual(child.exitCode, null, 'processen kører stadig');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  }
});

test('security.txt (RFC 9116): kontakt og udløb – kun når der er en kontakt', async () => {
  const mk = async (o) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sectxt-')); const s = createServer(Object.assign({ port: 0, host: '127.0.0.1', dataDir: d, signupCode: 'k', quiet: true, requireGuard: false }, o)); return { s, d, b: 'http://127.0.0.1:' + await s.listen() }; };
  const a = await mk({ securityContact: 'sikkerhed@holymoly.dk', publicUrl: 'https://holymoly.dk' });
  const none = await mk({ securityContact: '' });
  try {
    const r = await fetch(a.b + '/.well-known/security.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    const t = await r.text();
    assert.match(t, /^Contact: mailto:sikkerhed@holymoly\.dk$/m);
    const exp = /^Expires: (\S+)$/m.exec(t);
    assert.ok(exp && Date.parse(exp[1]) > Date.now() + 300 * 86400_000 && Date.parse(exp[1]) < Date.now() + 366 * 86400_000, 'Expires inden for et år');
    assert.match(t, /^Canonical: https:\/\/holymoly\.dk\/\.well-known\/security\.txt$/m);
    assert.match(t, /^Policy: https:\/\/holymoly\.dk\/sikkerhed$/m);
    if (!process.env.COMPANY_EMAIL && !process.env.SALES_EMAIL) assert.strictEqual((await fetch(none.b + '/.well-known/security.txt')).status, 404, 'ingen kontakt = ingen fil');
  } finally {
    for (const x of [a, none]) { await x.s.close(); try { fs.rmSync(x.d, { recursive: true, force: true }); } catch (e) { /* Windows */ } }
  }
});
