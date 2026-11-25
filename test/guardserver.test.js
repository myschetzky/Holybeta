'use strict';
/*
 * HolyMoly-vagten mod serveren – med rigtig kryptografi (ECDSA P-256) som på elevens computer.
 * Viser at: en falsk klient uden vagt aldrig bliver grøn, vagtens signatur ikke kan forfalskes,
 * genafspilning afvises, og vagtens fund (AI-forbindelser, falske klienter, forbudte programmer) giver rød.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
const { createServer } = require('../server/src/index.js');

const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return null; };

/** En vagt som den på elevens computer (Windows-varianten: IEEE-P1363-signaturer og ECCPUBLICBLOB). */
class FakeGuard {
  constructor(base, { windowsBlob = true } = {}) {
    this.base = base;
    this.kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.windowsBlob = windowsBlob;
    this.seq = 0;
  }
  pubLine() {
    if (!this.windowsBlob) return 'pub=' + this.kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const jwk = this.kp.publicKey.export({ format: 'jwk' });
    const blob = Buffer.alloc(72);
    blob.writeUInt32LE(0x31534345, 0); blob.writeUInt32LE(32, 4);
    Buffer.from(jwk.x, 'base64url').copy(blob, 8); Buffer.from(jwk.y, 'base64url').copy(blob, 40);
    return 'pubblob=' + blob.toString('base64');
  }
  async post(p, body, key = this.kp.privateKey) {
    const fmt = this.windowsBlob ? 'p1363' : 'der';
    const sig = crypto.sign('sha256', Buffer.from(body), { key, dsaEncoding: fmt === 'p1363' ? 'ieee-p1363' : 'der' }).toString('base64');
    const r = await fetch(this.base + p, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-HM-Sig': sig, 'X-HM-Sig-Format': fmt }, body });
    const text = await r.text();
    const out = { status: r.status, lines: text.split('\n'), get: (k) => (text.split('\n').find(l => l.startsWith(k + '=')) || '').slice(k.length + 1) };
    out.all = (k) => out.lines.filter(l => l.startsWith(k + '=')).map(l => l.slice(k.length + 1));
    return out;
  }
  pair(code) { return this.post('/api/guard/pair', ['v=1', 'code=' + code, this.pubLine(), 'os=Windows 11', 'host=PC', 'keystore=tpm'].join('\n') + '\n'); }
  beat(student, extra = [], seq) {
    const n = seq ?? ++this.seq;
    return this.post('/api/guard/beat', ['v=1', 'students=' + student, 'seq=' + n, 'ts=' + Date.now(), 'os=windows', 'guard=1.3.0', 'hosts=1', 'policies=1', 'app=1', 'lesson=' + (this.inLesson ? 1 : 0)].concat(extra).join('\n') + '\n');
  }
}

test('vagten: parring, signerede hjertebanker og fund der giver rød', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-guard-srv-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, signupCode: 'k', quiet: true }); // vagt kræves (standard)
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  let ck = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return r.json();
  };
  try {
    await call('POST', '/api/register', { email: 'l@x.dk', name: 'L', password: 'tavle-kridt-1234', signupCode: 'k' });
    const cls = await call('POST', '/api/classes', { name: 'K' });
    const st = (await call('POST', `/api/classes/${cls.id}/students`, { names: ['Eva'] })).students[0];
    const en = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st.inviteCode }) })).json();
    await call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 30 });

    // "Elev-appen" – kan lige så godt være et falsk program der sender grøn status
    const ag = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    ag.msgs = [];
    ag.on('message', (d, bin) => { if (!bin) ag.msgs.push(JSON.parse(d.toString())); });
    await new Promise(r => ag.on('open', r));
    ag.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Windows 11', host: 'PC', version: '1.3.0' } }));
    const welcome = await until(() => ag.msgs.find(m => m.type === 'welcome'));
    const pairCode = welcome.guardPair[st.id];
    assert.ok(pairCode && pairCode.length > 20, 'appen får en parringskode til vagten');
    await until(() => ag.msgs.find(m => m.type === 'lesson' && m.live));
    const green = () => ag.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk', violations: [], degraded: [] }));
    green();
    await new Promise(r => setTimeout(r, 100));

    // 1) Uden vagt kan en klient ALDRIG blive grøn – uanset hvad den sender
    let v = srv.hub.studentView(st.id);
    assert.strictEqual(v.color, 'grey');
    assert.match(v.greyReason, /ikke tilknyttet/);

    // 2) Vagten parres (bevis for nøglen) – en anden nøgle kan derefter ikke parres
    const guard = new FakeGuard(base);
    const p = await guard.pair(pairCode);
    assert.strictEqual(p.status, 200);
    // Samme vagt igen (fx genstart) er fint
    assert.strictEqual((await guard.pair(pairCode)).status, 200);
    // En ANDEN nøgle med samme kode = to vagter på samme computer -> den ene er falsk -> rød (og bliver stående)
    const evil = new FakeGuard(base);
    assert.strictEqual((await evil.pair(pairCode)).status, 409, 'koden kan ikke bruges af en anden vagt');
    assert.match(srv.hub.studentView(st.id).violations.map(x => x.text).join(), /To forskellige HolyMoly-vagter/);
    srv.hub.guardAlerts.delete(st.id);


    // 3) Gyldig hjertebanke -> først grå ("venter på vagten"), indtil vagten selv overvåger lektionen; så grøn
    let r = await guard.beat(st.id);
    green();
    await new Promise(r2 => setTimeout(r2, 100));
    assert.match(srv.hub.studentView(st.id).greyReason, /Venter på HolyMoly-vagten/);
    guard.inLesson = true;
    r = await guard.beat(st.id);
    assert.strictEqual(r.get('lesson'), '1');
    assert.ok(r.all('block').includes('chatgpt.com') && r.all('block').includes('www.instagram.com'), 'blokeringsliste fra serveren');
    green();
    await new Promise(r2 => setTimeout(r2, 100));
    assert.strictEqual(srv.hub.studentView(st.id).color, 'green');
    // Uændret liste sendes ikke igen
    r = await guard.beat(st.id, ['blockhash=' + r.get('blockhash')]);
    assert.strictEqual(r.all('block').length, 0);

    // 4) Forfalskning: et elev-program uden vagtens nøgle, og genafspilning
    const forged = await guard.post('/api/guard/beat', `v=1\nstudents=${st.id}\nseq=999\nts=${Date.now()}\n`, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
    assert.strictEqual(forged.status, 401, 'falsk signatur afvises');
    assert.deepStrictEqual(forged.all('unpaired'), [String(st.id)], 'vagten får besked på at parre igen');
    assert.strictEqual((await guard.beat(st.id, [], 1)).status, 401, 'genafspillet besked afvises');
    // … men en falsk besked med et elev-id kan IKKE gøre eleven rød (det kunne enhver klassekammerat ellers)
    v = srv.hub.studentView(st.id);
    assert.notStrictEqual(v.color, 'red');
    assert.ok(!v.violations.some(x => /Ugyldig signatur/.test(x.text)));
    srv.hub.guardReports.delete(st.id);

    // 5) Vagtens fund: Python mod OpenAI, et falsk program forbundet til serveren, et spil der ikke kan lukkes
    r = await guard.beat(st.id, [
      'proc=4321\tpython\tpython', 'proc=777\tRobloxPlayerBeta\tRobloxPlayerBeta', 'proc=55\tchrome\tchrome',
      'conn=4321\t104.18.1.1\t443', 'conn=55\t104.18.2.2\t443',
      'dns=api.openai.com\t104.18.1.1', 'dns=chatgpt.com\t104.18.2.2',
      'client=9999\t0\tC:\\Users\\eva\\snyd.exe',
    ]);
    assert.deepStrictEqual(r.all('kill'), ['777'], 'vagten får besked på at lukke spillet');
    v = srv.hub.studentView(st.id);
    assert.strictEqual(v.color, 'red');
    const texts = v.violations.map(x => x.text).join(' | ');
    assert.match(texts, /python bruger AI \(api\.openai\.com\)/);
    assert.match(texts, /Falsk HolyMoly-klient: snyd\.exe/);
    assert.doesNotMatch(texts, /chrome/, 'browserens trafik vurderes af browser-delen, ikke her');

    // 5b) En browser forbundet til HolyMoly-serveren (fx tjek-siden for et skrive-bevis) er ikke en falsk klient
    srv.hub.guardReports.delete(st.id);
    await guard.beat(st.id, ['client=555\t0\tC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']);
    assert.doesNotMatch(srv.hub.studentView(st.id).violations.map(x => x.text).join(), /Falsk/);
    // hosts-filen kunne ikke skrives (fx antivirus): grå, ikke rød
    srv.hub.guardReports.delete(st.id);
    await guard.beat(st.id, ['hosts=0']);
    green();
    await new Promise(r2 => setTimeout(r2, 100));
    v = srv.hub.studentView(st.id);
    assert.strictEqual(v.color, 'grey');
    assert.match(v.greyReason, /hosts-filen/);

    // 6) Den ægte app kører ikke, men "nogen" sender status for eleven -> rød
    srv.hub.guardReports.delete(st.id);
    await guard.beat(st.id, ['app=0']);
    assert.match(srv.hub.studentView(st.id).violations.map(x => x.text).join(), /kommer ikke fra HolyMoly-appen/);

    // 6b) Vagten melder en intern fejl -> grå med årsag (aldrig grøn), og fejlen logges én gang
    srv.hub.guardReports.delete(st.id);
    await guard.beat(st.id, ['error=linje 375: Adgang nægtet']);
    await guard.beat(st.id, ['error=linje 375: Adgang nægtet']);
    green();
    await new Promise(r2 => setTimeout(r2, 100));
    v = srv.hub.studentView(st.id);
    assert.strictEqual(v.color, 'grey');
    assert.match(v.greyReason, /vagten har en fejl: linje 375/);
    const errEvents = srv.hub.db.prepare("SELECT COUNT(*) AS n FROM events WHERE student_id = ? AND kind = 'system' AND title LIKE '%melder en fejl%'").get(st.id).n;
    assert.strictEqual(errEvents, 1, 'samme fejl logges kun én gang');
    // ...men en fejl kan ikke skjule et fund: rød vinder
    await guard.beat(st.id, ['error=x', 'client=9999\t0\tC:\\snyd.exe']);
    assert.strictEqual(srv.hub.studentView(st.id).color, 'red');
    // Fejlen er væk ved næste gode hjertebanke
    srv.hub.guardReports.delete(st.id);
    await guard.beat(st.id);
    assert.strictEqual(srv.hub.studentView(st.id).color, 'green');

    // 7) Vagten holder op med at svare -> grå
    const rep = srv.hub.guardReports.get(st.id);
    rep.ts = Date.now() - 60_000;
    rep.violations = [];
    v = srv.hub.studentView(st.id);
    assert.strictEqual(v.color, 'grey');
    assert.match(v.greyReason, /svarer ikke/);

    // 7b) En ekstra forbindelse (fx et script med elevens token) får SAMME parringskode – den kan ikke
    //     ugyldiggøre den kode, den rigtige app allerede har givet vagten
    const st2 = (await call('POST', `/api/classes/${cls.id}/students`, { names: ['Bo'] })).students[0];
    const en2 = await (await fetch(base + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st2.inviteCode }) })).json();
    const codeOf = async () => {
      const w = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
      const ms = [];
      w.on('message', (d, bin) => { if (!bin) ms.push(JSON.parse(d.toString())); });
      await new Promise(r2 => w.on('open', r2));
      w.send(JSON.stringify({ type: 'hello', tokens: [en2.token], device: { os: 'Windows 11', host: 'PC', version: '1.3.0' } }));
      const wm = await until(() => ms.find(m => m.type === 'welcome'));
      w.close();
      return wm.guardPair[st2.id];
    };
    const c1 = await codeOf();
    assert.strictEqual(await codeOf(), c1);
    // En browser kan ikke forbinde som elev-app
    const fromBrowser = new WebSocket(base.replace('http', 'ws') + '/ws/agent', { headers: { Origin: 'https://evil.example' } });
    const refused = await new Promise(r2 => { fromBrowser.on('error', () => r2(true)); fromBrowser.on('open', () => r2(false)); });
    assert.strictEqual(refused, true);

    // 8) Ny kode til eleven = ny computer: den gamle vagt-nøgle gælder ikke længere
    await call('POST', `/api/students/${st.id}/invite`, {});
    assert.strictEqual((await guard.beat(st.id)).status, 401);
    ag.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vagten: Mac-varianten (DER-signatur og SPKI-nøgle) virker også', async () => {
  const G = require('../server/src/guardapi.js');
  const g = new FakeGuard('http://x', { windowsBlob: false });
  const pem = G.pemFromSpki(g.pubLine().slice(4));
  const body = 'v=1\nstudents=1\n';
  const sig = crypto.sign('sha256', Buffer.from(body), g.kp.privateKey).toString('base64');
  assert.ok(G.verifySig(pem, body, sig, 'der'));
  assert.ok(!G.verifySig(pem, body + 'x', sig, 'der'));
});
