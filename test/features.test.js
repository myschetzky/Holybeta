'use strict';
// Ræk hånden op, lektionsrapport, afspil skriveforløbet og ligheds-tjek – gennem en rigtig server
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(20); } return null; }

test('ræk hånden op, lektionsrapport, afspil skriveforløbet og ligheds-tjek', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-feat-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true, requireGuard: false });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    const text = await r.text();
    try { return Object.assign(JSON.parse(text), { _status: r.status }); } catch (e) { return { _status: r.status, _text: text, _type: r.headers.get('content-type') }; }
  };
  const socks = [];
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'Mette', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: '2.g Dansk' });
    async function student(name) {
      const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name }) })).json();
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
      ws.msgs = [];
      ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
      await new Promise(r => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
      await until(() => ws.msgs.find(m => m.type === 'welcome'));
      ws.id = en.studentId;
      ws.status = (violations = []) => ws.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk', violations, degraded: [] }));
      socks.push(ws);
      return ws;
    }
    const anna = await student('Anna Jensen');
    const bo = await student('Bo Nielsen');
    const teacher = new WebSocket(base.replace('http', 'ws') + `/ws/teacher?classId=${cls.id}`, { headers: { Cookie: ck, Origin: base } });
    teacher.msgs = [];
    teacher.on('message', (d, bin) => { if (!bin) teacher.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => teacher.on('open', r));
    socks.push(teacher);

    // Uden lektion: hånden kan ikke rækkes op
    anna.send(JSON.stringify({ type: 'hand', up: true }));
    await sleep(100);
    assert.strictEqual(srv.hub.studentView(anna.id).hand, null);

    // 0) Lektionens links: kun web-adresser, og læreren får besked hvis et link er blokeret af reglerne
    const lr = await call('PATCH', '/api/classes/' + cls.id, { config: { links: [
      { title: 'Opgave 3', url: 'https://docs.google.com/document/d/abc' },
      { title: 'Ondt', url: 'javascript:alert(1)' },
      { title: '', url: 'https://chatgpt.com/' },
    ] } });
    assert.deepStrictEqual(lr.config.links.map(l => l.title), ['Opgave 3', 'chatgpt.com']);
    assert.deepStrictEqual(lr.blockedLinks.map(b => b.host), ['chatgpt.com']);

    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    const lessonMsg = await until(() => anna.msgs.find(m => m.type === 'lesson' && m.live));
    assert.strictEqual(lessonMsg.config.links[0].url, 'https://docs.google.com/document/d/abc', 'appen får lektionens links');
    anna.status(); bo.status();
    await sleep(150);

    // 1) Ræk hånden op -> læreren ser ✋ -> læreren sænker den -> appen får besked
    anna.send(JSON.stringify({ type: 'hand', up: true }));
    assert.ok(await until(() => teacher.msgs.find(m => m.type === 'student' && m.student.studentId === anna.id && m.student.hand)), 'læreren ser hånden');
    teacher.send(JSON.stringify({ type: 'hand', studentId: anna.id, up: false }));
    assert.ok(await until(() => anna.msgs.find(m => m.type === 'hand' && m.up === false)), 'appen får besked om at hånden er taget ned');
    assert.strictEqual(srv.hub.studentView(anna.id).hand, null);
    // En anden klasses lærer/elev-id kan ikke sænkes (ownStudent) – og en elev kan ikke sænke en andens hånd
    bo.send(JSON.stringify({ type: 'hand', up: true }));
    await until(() => srv.hub.studentView(bo.id).hand);

    // 2) Bo er rød et øjeblik
    bo.status([{ kind: 'site', text: 'AI / chatbots: chatgpt.com', category: 'ai' }]);
    await sleep(300);
    bo.status();
    await sleep(200);

    // 3) Skriveforløb: versioner til afspilning + Bo skriver næsten det samme som Anna
    const essay = 'Romantikken var en periode i kunsten omkring år 1800 hvor følelser naturen og det guddommelige fik en stor plads og digterne søgte det hele og det uendelige i stedet for oplysningstidens fornuft';
    const save = (ws, id, text) => { ws.send(JSON.stringify({ type: 'doc', id, title: 'Romantikken', blocks: [{ t: 'p', r: [{ x: text }] }], stats: { typed: text.length + 10, keystrokes: text.length, maxCps: 5, regularity: 0.6 } })); };
    const aDoc = crypto.randomUUID();
    save(anna, aDoc, essay.slice(0, 60));
    await until(() => anna.msgs.find(m => m.type === 'doc-saved' && m.ok));
    anna.msgs.length = 0;
    await sleep(1600);
    save(anna, aDoc, essay.slice(0, 260)); // stor ændring -> ny version
    await until(() => anna.msgs.find(m => m.type === 'doc-saved'));
    const bDoc = crypto.randomUUID();
    save(bo, bDoc, essay.replace('1800', '1810') + ' Det er min egen afslutning.');
    await until(() => bo.msgs.find(m => m.type === 'doc-saved' && m.ok));

    const v = await call('GET', `/api/docs/${aDoc}/versions`);
    assert.strictEqual(v.versions.length, 2, 'to versioner at afspille');
    assert.ok(v.versions[0].text.length < v.versions[1].text.length);
    const sim = await call('GET', `/api/docs/${bDoc}/similar`);
    assert.strictEqual(sim.similar[0].student, 'Anna Jensen');
    assert.ok(sim.similar[0].percent >= 60, 'høj lighed: ' + sim.similar[0].percent);

    // 4) Lektionsrapport
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    const lessons = await call('GET', `/api/classes/${cls.id}/lessons`);
    assert.strictEqual(lessons.lessons.length, 1);
    const rep = await call('GET', `/api/classes/${cls.id}/lessons/${lessons.lessons[0].id}`);
    const rb = rep.students.find(s => s.name === 'Bo Nielsen');
    const ra = rep.students.find(s => s.name === 'Anna Jensen');
    assert.ok(rb.red > 0 && rb.redReasons.some(x => /chatgpt/.test(x)), 'Bos røde tid og årsag');
    assert.ok(ra.green > 0 && ra.red === 0);
    assert.strictEqual(ra.hands, 1);
    assert.strictEqual(rb.hands, 1);
    const sum = (s) => s.green + s.red + s.grey;
    assert.ok(Math.abs(sum(ra) - (rep.lesson.ended - rep.lesson.started)) < 5, 'hele lektionen er fordelt på farverne');
    const csv = await call('GET', `/api/classes/${cls.id}/lessons/${lessons.lessons[0].id}.csv`);
    assert.match(csv._type, /text\/csv/);
    assert.match(csv._text, /"Bo Nielsen";.*chatgpt/);

    // En anden lærer kan hverken se rapporten eller dokumenterne
    ck = '';
    await call('POST', '/api/register', { email: 'b@x.dk', name: 'B', password: 'tavle-kridt-1234', signupCode: 'k' });
    assert.strictEqual((await call('GET', `/api/classes/${cls.id}/lessons`))._status, 404);
    assert.strictEqual((await call('GET', `/api/docs/${aDoc}/versions`))._status, 404);
  } finally {
    for (const s of socks) try { s.close(); } catch (e) { /* */ }
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
