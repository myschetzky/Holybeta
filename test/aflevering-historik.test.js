'use strict';
// Afleveringen: ingen skjult overskrivning, historik til læreren, kvittering til eleven og klare ord i skrivevinduet
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'server')] }));
const { createServer } = require('../server/src/index.js');
const V = require('../agent/src/assignments-view.js');
const RET = require('../server/src/retention.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('aflevering igen: den tidligere gemmes i historikken, læreren ser det, og eleven får en kvittering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hist-'));
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
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cls.joinCode, name: 'Anna Jensen' }) })).json();
    const asg = await call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Kronik', due: Date.now() + 3600_000 });
    // To afsluttede dokumenter (det andet med en hemmelig tekst, der ikke må stå i historikken)
    const st = { id: en.studentId, class_id: cls.id };
    const mk = (title, words) => {
      const id = crypto.randomUUID();
      const t = Date.now();
      assert.ok(srv.docs.save(st, { id, title, blocks: [{ t: 'p', r: [{ x: words }] }], stats: { typed: words.length + 5 } }, { color: 'green', violations: [] }, 1, t).ok);
      srv.docs.submit(st, id, { force: true }, t + 1000);
      return id;
    };
    const first = mk('Første', 'En to tre fire fem.');
    const second = mk('Anden', 'Hemmelig anden udgave med seks ord.');

    ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ag.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    const wait = async (f) => { for (let i = 0; i < 200; i++) { const m = msgs.find(f); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 20)); } throw new Error('ingen besked'); };
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    const attach = async (docId) => {
      await new Promise(r => setTimeout(r, 1050)); // højst én vedhæftning i sekundet
      ag.send(JSON.stringify({ type: 'assignment-attach', assignmentId: asg.id, docId }));
      return wait(m => m.type === 'assignment-result');
    };

    const r1 = await attach(first);
    assert.strictEqual(r1.ok, true);
    assert.deepStrictEqual(Object.keys(r1.receipt).sort(), ['assignment', 'at', 'code', 'late', 'mark', 'replaces', 'words']);
    assert.strictEqual(r1.receipt.assignment, 'Kronik');
    assert.strictEqual(r1.receipt.words, 5);
    assert.strictEqual(r1.receipt.replaces, null);
    // Samme dokument igen: intet ændres, og tidspunktet er stadig det første
    const again = await attach(first);
    assert.strictEqual(again.receipt.at, r1.receipt.at);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM assignment_history').get().n, 0);
    // Et andet dokument: den første aflevering gemmes i historikken – kun id'er og tider
    const r2 = await attach(second);
    assert.strictEqual(r2.receipt.replaces, r1.receipt.at);
    assert.strictEqual(r2.receipt.words, 6);
    const hist = srv.db.prepare('SELECT * FROM assignment_history').all().map(x => ({ ...x }));
    assert.strictEqual(hist.length, 1);
    assert.deepStrictEqual(Object.keys(hist[0]).sort(), ['assignment_id', 'cert_id', 'doc_id', 'replaced', 'student_id', 'submitted']);
    assert.strictEqual(hist[0].doc_id, first);
    assert.strictEqual(hist[0].submitted, r1.receipt.at);
    assert.ok(!JSON.stringify(hist).includes('En to tre'), 'ingen tekstkopi');
    // Elevens kvittering i appen
    const text = V.receiptText(r2.receipt);
    assert.match(text, /^Kvittering: Afleveret til "Kronik" .+ \(serverens tid\) · 6 ord · uden mærke · erstatter afleveringen fra /);

    // Læreren ser "Afleveret igen … (1 tidligere)"
    const view = await call('GET', `/api/assignments/${asg.id}`);
    const sub = view.students.find(s => s.id === en.studentId).submission;
    assert.strictEqual(sub.docId, second);
    assert.strictEqual(sub.previous, 1);
    assert.strictEqual(sub.firstSubmitted, r1.receipt.at);
    assert.match(read('server/public/app.js'), /`Afleveret igen \$\{fmtDateTime\(sub\.submitted\)\} \(\$\{sub\.late \? 'efter fristen, ' : ''\}\$\{sub\.previous\} tidligere/);
    // Logbogen siger "Afleverede igen"
    const log = await call('GET', `/api/students/${en.studentId}/events?kind=alerts&limit=20`);
    assert.ok(log.events.some(e => /^Afleverede igen "Anden" til Kronik/.test(e.title)));

    // Slettes det tidligere dokument (fx efter fristen), forsvinder historikken med det (slette-triggeren)
    srv.db.prepare('DELETE FROM documents WHERE id = ?').run(first);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM assignment_history').get().n, 0);
    // … og historikken følger DOC_RETENTION_DAYS
    srv.db.prepare('INSERT INTO assignment_history (assignment_id, student_id, doc_id, cert_id, submitted, replaced) VALUES (?,?,?,?,?,?)').run(asg.id, en.studentId, 'x', null, 1000, 2000);
    RET.purge(srv.db, RET.fromEnv({}, {}), 1000 + 366 * RET.DAY);
    assert.strictEqual(srv.db.prepare("SELECT COUNT(*) AS n FROM assignment_history WHERE doc_id = 'x'").get().n, 0);
  } finally {
    if (ag) ag.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('klare ord: "Gem kopi (uden mærke)", og "Afslut" er ikke det samme som at aflevere', () => {
  const html = read('agent/renderer/write.html');
  const js = read('agent/renderer/write.js');
  assert.ok(!/Gem som Word/.test(html + js), 'det gamle ord er væk');
  assert.match(html, /<button class="btn" id="docx">Gem kopi \(uden mærke\)<\/button>/);
  assert.match(js, /marked \? 'Gem Word-fil med mærket' : 'Gem kopi \(uden mærke\)'/);
  assert.match(html, /Afslut er ikke det samme som at aflevere/);
  assert.match(js, /Dokumentet er afsluttet, men ikke afleveret til din lærer/);
  // Kvitteringen vises i skrivevinduet og på afleveringssiden
  assert.match(html, /<script src="\.\.\/src\/assignments-view\.js"><\/script>/);
  assert.match(js, /V\.receiptText\(attachedTo\.receipt\)/);
  assert.match(read('agent/src/verified.js'), /receipt: \(r && r\.receipt\) \|\| null/);
  assert.strictEqual(V.attachResult({ ok: true }, new Date(2026, 10, 25, 10, 14).getTime()).text, 'Afleveret kl. 10.14', 'ældre server uden kvittering');
});
