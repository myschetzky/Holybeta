'use strict';
// Enkel tilstand: lærer med brugernavn (ingen e-mail), elever med klassekode + navn + egen kode
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, weakPin } = require('../server/src/index.js');

// Skolens ja (beta): uden disse fire felter startes ingen lektioner i enkel tilstand
const APPROVAL = { controller: 'Testskolen', dpo: 'dpo@kommune.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' };

function client(base) {
  let ck = '';
  return {
    async call(method, p, body) {
      const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
      const text = await r.text();
      try { return Object.assign(JSON.parse(text), { _status: r.status }); } catch (e) { return { _status: r.status, _text: text }; }
    },
  };
}

test('enkel tilstand: brugernavn, klassekode, navn og elevkode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple-'));
  // Selv med licens, to-faktor og e-mail slået til, slår enkel tilstand dem fra
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, licensing: true, require2fa: true, mailSend: async () => {}, schoolApproval: APPROVAL });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  // Appen sender accept: true, når eleven har sat flueben ved vilkårene
  const enroll = (body) => client(base).call('POST', '/api/enroll', Object.assign({ accept: true }, body));
  try {
    const info = await client(base).call('GET', '/api/info');
    assert.strictEqual(info.simple, true);
    assert.strictEqual(info.licensing, false);
    assert.strictEqual(info.require2fa, false);
    assert.strictEqual(info.verifyEmail, false);
    assert.deepStrictEqual(info.approval, APPROVAL, '/api/info viser skolens ja (til /privatliv)');
    assert.deepStrictEqual(info.approvalMissing, []);
    assert.strictEqual(info.lessonBlocked, false);
    // Den første lærer skal bruge opsætningskoden fra serverens log
    assert.strictEqual(info.signupRequiresCode, true);
    assert.strictEqual(info.firstTeacher, true);
    const setup = srv.setupCode();
    assert.match(setup, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.strictEqual(srv.setupCode(), setup, 'samme kode, til den er brugt');

    // Lærer: brugernavn i stedet for e-mail, ingen opsætningstrin bagefter
    const A = client(base);
    let r = await A.call('POST', '/api/register', { email: 'Mette', name: 'Mette Hansen', password: 'tavle-kridt-1234', acceptTerms: true });
    assert.strictEqual(r._status, 403, 'uden opsætningskode');
    assert.match(r.error, /opsætningskode/);
    r = await A.call('POST', '/api/register', { email: 'Mette', name: 'Mette Hansen', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: 'ABCD-EFGH' });
    assert.strictEqual(r._status, 403, 'forkert opsætningskode');
    r = await A.call('POST', '/api/register', { email: 'mette lærer', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: setup });
    assert.strictEqual(r._status, 400, 'mellemrum i brugernavn afvises');
    r = await A.call('POST', '/api/register', { email: 'Mette', name: 'Mette Hansen', password: 'tavle-kridt-1234', signupCode: setup });
    assert.match(r.error, /vilkårene/, 'læreren skal acceptere vilkårene');
    r = await A.call('POST', '/api/register', { email: 'Mette', name: 'Mette Hansen', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: setup.toLowerCase() });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(srv.setupCode(), null, 'opsætningskoden er brugt');
    assert.strictEqual((await client(base).call('GET', '/api/info')).firstTeacher, false);
    r = await client(base).call('POST', '/api/register', { email: 'eva', name: 'Eva', password: 'tavle-kridt-4242', acceptTerms: true, signupCode: setup });
    assert.strictEqual(r._status, 403, 'opsætningskoden virker kun én gang');
    // Nu findes der en lærer: flere lærere kræver lærerkoden fra en kollega
    let info2 = await client(base).call('GET', '/api/info');
    assert.strictEqual(info2.signupRequiresCode, true);
    r = await client(base).call('POST', '/api/register', { email: 'jens', name: 'Jens', password: 'tavle-kridt-9876', acceptTerms: true });
    assert.strictEqual(r._status, 403, 'uden lærerkode');
    assert.match(r.error, /lærerkode/);
    const me = await A.call('GET', '/api/me');
    assert.strictEqual(me.teacherCode, undefined, 'lærerkoden står ikke i /api/me – den vises først efter et klik');
    assert.strictEqual(me.teacherCodeOn, true);
    const shown = await A.call('POST', '/api/account/teacher-code/show', {});
    me.teacherCode = shown.teacherCode;
    assert.match(me.teacherCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(Math.abs(shown.expires - (Date.now() + 30 * 60_000)) < 5000, 'lærerkoden gælder 30 minutter');
    r = await client(base).call('POST', '/api/register', { email: 'mette', name: 'Anden', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: me.teacherCode });
    assert.strictEqual(r._status, 409, 'brugernavnet er taget');
    const J = client(base);
    r = await J.call('POST', '/api/register', { email: 'jens', name: 'Jens', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: me.teacherCode.toLowerCase().replace('-', '') });
    assert.strictEqual(r.ok, true, 'lærerkoden virker med og uden bindestreg');
    assert.strictEqual(r.pending, true, 'Jens venter på godkendelse');
    // Mette godkender Jens (testet i detaljer i accounts.test.js)
    assert.ok((await A.call('POST', `/api/account/teachers/${(await A.call('GET', '/api/account/pending-teachers')).teachers[0].id}/approve`, {})).ok);
    // Ny lærerkode: den gamle virker ikke længere
    const rot = await J.call('POST', '/api/account/teacher-code', {});
    assert.notStrictEqual(rot.teacherCode, me.teacherCode);
    r = await client(base).call('POST', '/api/register', { email: 'ole', name: 'Ole', password: 'tavle-kridt-5555', acceptTerms: true, signupCode: me.teacherCode });
    assert.strictEqual(r._status, 403);
    assert.strictEqual(me.needs, null);
    assert.strictEqual(me.simple, true);
    r = await client(base).call('POST', '/api/login', { email: 'mette', password: 'forkert-forkert' });
    assert.match(r.error, /brugernavn/);
    const B = client(base);
    r = await B.call('POST', '/api/login', { email: 'METTE', password: 'tavle-kridt-1234' });
    assert.strictEqual(r.ok, true);

    const cls = await A.call('POST', '/api/classes', { name: '2.g Dansk' });
    assert.ok(cls.joinCode);

    // Elev: klassekode -> serveren beder om navn og kode
    r = await enroll({ code: cls.joinCode });
    assert.strictEqual(r.needName, true);
    assert.strictEqual(r.needPin, true);
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen' });
    assert.match(r.error, /Opdater/, 'gammel app uden kodefelt får besked om at opdatere');
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '4821', accept: undefined });
    assert.match(r.error, /Opdater/, 'gammel app uden vilkår får besked om at opdatere');
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '4821', accept: false });
    assert.match(r.error, /flueben ved vilkårene/);
    assert.strictEqual(r.needAccept, true);
    assert.strictEqual(r.termsPath, '/vilkaar-elev');
    assert.strictEqual((await fetch(base + '/vilkaar-elev')).status, 200);
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '12' });
    assert.match(r.error, /4-6 cifre/);
    const first = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '4821' });
    assert.ok(first.token, JSON.stringify(first));

    // Samme navn uden kode / med forkert kode: afvises
    r = await enroll({ code: cls.joinCode, name: 'anna  jensen', pin: '' });
    assert.ok(r.needName && !r.token);
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '0000' });
    assert.strictEqual(r._status, 401);
    assert.match(r.error, /Forkert kode/);

    // Rigtig kode på en ny computer: samme elev, ny nøgle – den gamle virker ikke længere
    const again = await enroll({ code: cls.joinCode, name: 'anna jensen', pin: '4821' });
    assert.strictEqual(again.studentId, first.studentId);
    assert.notStrictEqual(again.token, first.token);
    assert.strictEqual(again.studentName, 'Anna Jensen');
    const students = await A.call('GET', `/api/classes/${cls.id}`);
    const list = students.students || [];
    assert.strictEqual(list.filter(s => /anna/i.test(s.name)).length, 1, 'ingen dublet');

    // Koden kan ikke gættes: efter 5 forkerte forsøg (1 brugt ovenfor; rigtige koder tæller ikke) spærres der
    let blocked = false;
    for (let i = 0; i < 6; i++) {
      r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: String(1000 + i) });
      if (r._status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, 'for mange forkerte koder spærres');
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen', pin: '4821' });
    assert.strictEqual(r._status, 429, 'også den rigtige kode venter, når der er spærret');

    // En anden elev med et andet navn kan sagtens tilmelde sig – men ikke med en kode, der er let at gætte
    for (const weak of ['1234', '1111', '2008', '1212']) {
      r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: weak });
      assert.strictEqual(r._status, 400, weak);
      assert.strictEqual(r.error, 'Vælg en kode, der er sværere at gætte');
    }
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '7391' });
    assert.ok(r.token);
    const bo = r.studentId;

    // Bo har glemt sin kode: læreren nulstiller den og får en engangskode på 6 cifre, som Bo skriver i appen – samme plads
    let st = await A.call('POST', `/api/students/${bo}/reset-pin`, {});
    assert.strictEqual(st.pin, false);
    assert.ok(st.pinResetUntil > Date.now());
    assert.match(st.resetCode, /^\d{6}$/);
    assert.ok(!weakPin(st.resetCode));
    const oneTime = st.resetCode;
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '' });
    assert.ok(r.needName && !r.token, 'uden kode sker der intet');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '8264' });
    assert.strictEqual(r._status, 401, 'Bo (eller en anden) kan ikke bare vælge en ny kode med navnet');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '7391' });
    assert.strictEqual(r._status, 401, 'den gamle kode virker ikke');
    const boAgain = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: oneTime });
    assert.strictEqual(boAgain.studentId, bo, 'samme elev');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: oneTime });
    assert.strictEqual(r.studentId, bo, 'engangskoden er nu Bos kode');
    const boRow = (await A.call('GET', `/api/classes/${cls.id}`)).students.find(s => s.id === bo);
    assert.strictEqual(boRow.pin, true);
    assert.strictEqual(boRow.pinResetUntil, null);
    // En udløbet engangskode virker ikke – og navnet er stadig Bos (ingen dublet)
    st = await A.call('POST', `/api/students/${bo}/reset-pin`, {});
    srv.db.prepare('UPDATE students SET pin_reset_until = ? WHERE id = ?').run(Date.now() - 1000, bo);
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: st.resetCode });
    assert.strictEqual(r._status, 401);
    assert.match(r.error, /udløbet/);
    assert.strictEqual((await A.call('GET', `/api/classes/${cls.id}`)).students.find(s => s.id === bo).pinReset, true);
    // En anden lærer kan ikke nulstille Bos kode
    r = await J.call('POST', `/api/students/${bo}/reset-pin`, {});
    assert.strictEqual(r._status, 404);

    // Daglig backup af databasen: en hel SQLite-fil, der kan åbnes
    const file = srv.backup(true);
    assert.ok(file && fs.existsSync(file));
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(file, { readOnly: true });
    assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM students').get().n >= 2);
    copy.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('almindelig tilstand: elevkode er frivillig, e-mail kræves stadig', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple2-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  try {
    const A = client(base);
    let r = await A.call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234' });
    assert.strictEqual(r._status, 400, 'brugernavn uden @ afvises uden enkel tilstand');
    r = await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'tavle-kridt-1234' });
    assert.strictEqual(r.ok, true);
    const cls = await A.call('POST', '/api/classes', { name: '2.g' });
    const enroll = (body) => client(base).call('POST', '/api/enroll', body);
    r = await enroll({ code: cls.joinCode, name: 'Anna Jensen' });
    assert.ok(r.token, 'uden kode som før');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '5555' });
    assert.strictEqual(r._status, 400, 'let gættelig kode afvises også her');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '5827' });
    assert.ok(r.token);
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '5827' });
    assert.ok(r.token, 'Bo kan logge ind igen med sin kode');
    r = await enroll({ code: cls.joinCode, name: 'Bo Nielsen', pin: '1111' });
    assert.strictEqual(r._status, 401);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elevkoder: de mest almindelige koder afvises', () => {
  for (const p of ['0000', '1111', '999999', '1234', '2345', '0123', '7890', '123456', '4321', '9876', '3210', '654321',
    '1212', '121212', '1122', '112233', '123123', '1950', '1999', '2008', '2030']) assert.strictEqual(weakPin(p), true, p);
  for (const p of ['4821', '7391', '5827', '1949', '2031', '1357', '8264', '102938', '1221']) assert.strictEqual(weakPin(p), false, p);
});

test('enkel tilstand: elevens kode låses efter 10 forkerte forsøg – også efter genstart – til læreren nulstiller den', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple3-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, schoolApproval: APPROVAL });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  const A = client(base);
  try {
    const setup = srv.setupCode();
    assert.strictEqual((await A.call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: setup })).ok, true);
    const cls = await A.call('POST', '/api/classes', { name: '2.g' });
    const enroll = (body) => client(base).call('POST', '/api/enroll', Object.assign({ accept: true, code: cls.joinCode, name: 'Anna Jensen' }, body));
    const anna = (await enroll({ pin: '4821' })).studentId;
    const fails = () => srv.db.prepare('SELECT pin_fails FROM students WHERE id = ?').get(anna).pin_fails;

    // Forkerte forsøg gemmes i databasen; den rigtige kode nulstiller tællingen
    assert.strictEqual((await enroll({ pin: '4822' }))._status, 401);
    assert.strictEqual((await enroll({ pin: '4823' }))._status, 401);
    assert.strictEqual(fails(), 2);
    assert.ok((await enroll({ pin: '4821' })).token);
    assert.strictEqual(fails(), 0);
    // Rigtige koder tæller ikke mod grænsen i hukommelsen
    for (let i = 0; i < 6; i++) assert.ok((await enroll({ pin: '4821' })).token, 'rigtig kode ' + i);

    // 10 forkerte forsøg i alt (her: 8 fra før + 2) -> låst, også for den rigtige kode
    srv.db.prepare('UPDATE students SET pin_fails = 8 WHERE id = ?').run(anna);
    assert.strictEqual((await enroll({ pin: '4824' }))._status, 401);
    let r = await enroll({ pin: '4825' });
    assert.strictEqual(r._status, 423);
    assert.match(r.error, /låst/);
    r = await enroll({ pin: '4821' });
    assert.strictEqual(r._status, 423, 'den rigtige kode virker heller ikke');
    const row = (await A.call('GET', `/api/classes/${cls.id}`)).students.find(s => s.id === anna);
    assert.strictEqual(row.pinLocked, true, 'læreren ser, at koden er låst');

    // Genstart: stadig låst (tællingen ligger i databasen, ikke i hukommelsen)
    await srv.close();
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    r = await enroll({ pin: '4821' });
    assert.strictEqual(r._status, 423);

    // Læreren nulstiller: engangskoden virker, og tællingen er nulstillet
    assert.strictEqual((await client(base).call('POST', `/api/students/${anna}/reset-pin`, {}))._status, 401, 'kræver login');
    const B = client(base);
    assert.strictEqual((await B.call('POST', '/api/login', { email: 'mette', password: 'tavle-kridt-1234' })).ok, true);
    const reset = await B.call('POST', `/api/students/${anna}/reset-pin`, {});
    assert.strictEqual(reset.pinLocked, false);
    assert.strictEqual(fails(), 0);
    r = await enroll({ pin: reset.resetCode });
    assert.strictEqual(r.studentId, anna);
    assert.ok((await enroll({ pin: reset.resetCode })).token, 'engangskoden er nu elevens kode');
    assert.strictEqual((await enroll({ pin: '4821' }))._status, 401, 'den gamle kode virker ikke');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enkel tilstand: lærerkoden vises efter et klik og gælder 30 minutter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple4-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, schoolApproval: APPROVAL });
  const base = 'http://127.0.0.1:' + await srv.listen();
  const age = (min) => srv.db.prepare("UPDATE meta SET value = ? WHERE key = 'teacher_code_created'").run(String(Date.now() - min * 60_000));
  try {
    const A = client(base);
    assert.strictEqual((await A.call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: srv.setupCode() })).ok, true);
    // Før nogen har klikket "Vis kode", findes der ingen gyldig kode
    let r = await client(base).call('POST', '/api/register', { email: 'jens', name: 'Jens', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: 'ABCD-EFGH' });
    assert.strictEqual(r._status, 403);
    const show = () => A.call('POST', '/api/account/teacher-code/show', {});
    const first = (await show()).teacherCode;
    assert.strictEqual((await show()).teacherCode, first, 'samme kode inden for 30 minutter');
    age(29);
    assert.strictEqual((await show()).teacherCode, first, '29 minutter gammel: virker stadig');
    // 31 minutter gammel: den gamle virker ikke, og "Vis kode" giver en ny
    age(31);
    r = await client(base).call('POST', '/api/register', { email: 'jens', name: 'Jens', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: first });
    assert.strictEqual(r._status, 403, 'den udløbne kode virker ikke');
    assert.match(r.error, /udløbet lærerkode/);
    const next = await show();
    assert.notStrictEqual(next.teacherCode, first);
    assert.ok(next.expires > Date.now() + 29 * 60_000);
    r = await client(base).call('POST', '/api/register', { email: 'jens', name: 'Jens', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: next.teacherCode });
    assert.strictEqual(r.ok, true);
    // Udløber koden, mens ingen ser den, virker den heller ikke ved oprettelse
    age(31);
    r = await client(base).call('POST', '/api/register', { email: 'ole', name: 'Ole', password: 'tavle-kridt-5555', acceptTerms: true, signupCode: next.teacherCode });
    assert.strictEqual(r._status, 403);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enkel tilstand: ingen lektioner eller skriveøkter uden skolens ja', async () => {
  const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../server')] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple5-'));
  // Et enkelt felt mangler (tom tekst)
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true, schoolApproval: Object.assign({}, APPROVAL, { dpiaDate: '' }) });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    assert.deepStrictEqual(srv.approvalMissing(), ['DPIA_DATO']);
    const info = await client(base).call('GET', '/api/info');
    assert.strictEqual(info.approval, null);
    assert.deepStrictEqual(info.approvalMissing, ['DPIA_DATO'], 'kun variabelnavnene – ingen værdier');
    assert.strictEqual(info.lessonBlocked, true);
    const A = client(base);
    assert.strictEqual((await A.call('POST', '/api/register', { email: 'mette', name: 'Mette', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: srv.setupCode() })).ok, true);
    const cls = await A.call('POST', '/api/classes', { name: '2.g' });
    const r = await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.strictEqual(r._status, 409);
    assert.strictEqual(r.error, 'Beta: skolens ja mangler. Udfyld DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO og LEDELSE_JA_DATO på serveren (se docs/ENKEL.md).');
    assert.strictEqual(srv.hub.lessonOf(cls.id), null);

    // Skriveøkt hjemme afvises med samme besked
    const asg = await A.call('POST', `/api/classes/${cls.id}/assignments`, { title: 'Stil', home: true, due: Date.now() + 86400_000 });
    const en = await client(base).call('POST', '/api/enroll', { accept: true, code: cls.joinCode, name: 'Anna Jensen', pin: '4821' });
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const msgs = [];
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await new Promise(res => ws.on('open', res));
    const wait = async (f) => { for (let i = 0; i < 150; i++) { const m = msgs.find(f); if (m) return m; await new Promise(res => setTimeout(res, 20)); } throw new Error('ingen besked'); };
    ws.send(JSON.stringify({ type: 'hello', tokens: [en.token], device: { os: 'Linux', host: 'PC', version: '1.3.0' } }));
    await wait(m => m.type === 'welcome');
    ws.send(JSON.stringify({ type: 'write-session', assignmentId: asg.id, on: true }));
    const res = await wait(m => m.type === 'write-session-result');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /skolens ja mangler/);
    assert.strictEqual(srv.hub.soloOf(en.studentId), null);
    ws.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('almindelig tilstand: skolens ja kræves ikke', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simple6-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, schoolApproval: { controller: '', dpo: '', dpiaDate: '', approvedDate: '' } });
  const base = 'http://127.0.0.1:' + await srv.listen();
  try {
    const info = await client(base).call('GET', '/api/info');
    assert.strictEqual(info.approval, null);
    assert.strictEqual(info.lessonBlocked, false, 'uden enkel tilstand blokeres lektioner ikke');
    assert.strictEqual(srv.setupCode(), null, 'ingen opsætningskode uden enkel tilstand');
    const A = client(base);
    assert.strictEqual((await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'tavle-kridt-1234' })).ok, true);
    const cls = await A.call('POST', '/api/classes', { name: '2.g' });
    const r = await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.strictEqual(r.lesson.live, true);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
