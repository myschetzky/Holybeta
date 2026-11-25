'use strict';
// Kontoer, e-mail-bekræftelse, to-faktor, glemt adgangskode, skoler, invitationer, licenser og administration
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/src/index.js');
const T = require('../server/src/totp.js');

function client(base) {
  let ck = '';
  return {
    get cookie() { return ck; },
    async call(method, p, body) {
      const r = await fetch(base + p, { method, redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      const text = await r.text();
      try { return Object.assign(JSON.parse(text), { _status: r.status }); } catch (e) { return { _status: r.status, _text: text, _type: r.headers.get('content-type') }; }
    },
  };
}
const linkIn = (mail, word) => { const m = mail.text.match(new RegExp('https?://\\S+/' + word + '\\?[a-z]+=([A-Za-z0-9_-]+)')); return m && m[1]; };
const codeNow = (secret, offset = 0) => T.hotp(T.unbase32(secret.replace(/\s/g, '')), T.stepNow() + offset);

test('konto, to-faktor, skole, invitation, licens og administration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-acc-'));
  const mails = [];
  const srv = createServer({
    port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false,
    licensing: true, require2fa: true, mailSend: async (m) => { mails.push(m); }, publicUrl: 'https://holymoly.test',
    platformAdmins: 'boss@holymoly.dk', salesEmail: 'salg@holymoly.dk', trialDays: 30, pricePerStudent: 50, priceMinimum: 1000,
  });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  const last = (to) => [...mails].reverse().find(m => m.to === to);
  try {
    // Forsiden vises for besøgende; dashboardet for lærere
    const front = await fetch(base + '/');
    assert.match(await front.text(), /<title>HolyMoly – elevernes bevis på, at deres tekst ikke er skrevet med AI/);
    assert.strictEqual((await fetch(base + '/vilkaar')).status, 200);
    assert.match(await (await fetch(base + '/tilbud')).text(), /Tilbud til skolens ledelse/);
    assert.match(await (await fetch(base + '/sikkerhed')).text(), /Sikkerhed og databeskyttelse/);
    assert.strictEqual((await fetch(base + '/hent/../../etc/passwd.exe')).status, 404);

    const pricing = await client(base).call('GET', '/api/pricing');
    assert.strictEqual(pricing.perStudent, 50);
    assert.strictEqual(pricing.trialDays, 30);

    // --- Opret konto + skole ---
    const A = client(base);
    let r = await A.call('POST', '/api/register', { email: 'Mette@Skole.dk', name: 'Mette', password: 'kort', schoolName: 'Aarhus Gymnasium', acceptTerms: true });
    assert.strictEqual(r._status, 400, 'for kort adgangskode');
    // Blokliste (NIST SP 800-63B-4): almindelige adgangskoder, ord + tal/år, rækker og lærerens egne navne
    // (hele listen testes i passwords.test.js – her kun at serveren bruger den, også med skolens navn)
    r = await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'Sommer2024!', schoolName: 'Aarhus Gymnasium', acceptTerms: true });
    assert.strictEqual(r._status, 400, 'almindeligt ord + år afvises');
    r = await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'AarhusGymnasium1', schoolName: 'Aarhus Gymnasium', acceptTerms: true });
    assert.match(r.error, /navn/, 'skolens navn afvises');
    r = await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'Mette', password: 'tavle-kridt-1234', schoolName: 'Aarhus Gymnasium' });
    assert.strictEqual(r._status, 400, 'vilkår skal accepteres');
    r = await A.call('POST', '/api/register', { email: 'Mette@Skole.dk', name: 'Mette', password: 'tavle-kridt-1234', schoolName: 'Aarhus Gymnasium', acceptTerms: true });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r.verify, true);
    assert.ok(last('salg@holymoly.dk').subject.includes('Aarhus Gymnasium'), 'salg får besked om ny skole');
    assert.strictEqual((await A.call('POST', '/api/register', { email: 'mette@skole.dk', name: 'X', password: 'tavle-kridt-1234', schoolName: 'Y', acceptTerms: true }))._status, 409);

    // Ikke bekræftet: kun kontoen kan bruges
    let me = await A.call('GET', '/api/me');
    assert.strictEqual(me.needs, 'verify');
    assert.strictEqual(me.school.role, 'admin');
    assert.strictEqual(me.license.state, 'trial');
    assert.strictEqual(me.license.daysLeft, 30);
    r = await A.call('POST', '/api/classes', { name: '2.g' });
    assert.strictEqual(r._status, 403);
    assert.strictEqual(r.needs, 'verify');

    // Bekræft e-mail via linket i mailen
    const vtok = linkIn(last('mette@skole.dk'), 'bekraeft');
    assert.ok(vtok, 'bekræftelses-link i mailen');
    assert.match(last('mette@skole.dk').text, /https:\/\/holymoly\.test\/bekraeft/);
    assert.strictEqual((await client(base).call('POST', '/api/verify', { token: 'forkert' }))._status, 400);
    assert.strictEqual((await client(base).call('POST', '/api/verify', { token: vtok }))._status, 200);
    assert.strictEqual((await client(base).call('POST', '/api/verify', { token: vtok }))._status, 400, 'engangslink');

    // To-faktor skal sættes op
    me = await A.call('GET', '/api/me');
    assert.strictEqual(me.needs, '2fa');
    const st = await A.call('POST', '/api/account/2fa/start');
    assert.ok(st.secret && st.otpauth.startsWith('otpauth://totp/HolyMoly:') && st.qrSvg.startsWith('<svg'));
    assert.strictEqual((await A.call('POST', '/api/account/2fa/enable', { code: '000000' }))._status, 400);
    const en = await A.call('POST', '/api/account/2fa/enable', { code: codeNow(st.secret) });
    assert.strictEqual(en._status, 200);
    assert.strictEqual(en.backupCodes.length, 10);
    assert.match(last('mette@skole.dk').subject, /To-faktor er slået til/, 'læreren får besked, når to-faktor slås til');
    me = await A.call('GET', '/api/me');
    assert.strictEqual(me.needs, null);
    assert.strictEqual(me.totp, true);

    // Nu virker dashboardet
    const cls = await A.call('POST', '/api/classes', { name: '2.g Dansk' });
    assert.ok(cls.id);
    r = await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start', minutes: 45 });
    assert.strictEqual(r._status, 200, 'prøveperioden giver lov til lektioner');
    await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });

    // --- Login med to-faktor ---
    const B = client(base);
    r = await B.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'forkert-kode' });
    assert.strictEqual(r._status, 401);
    r = await B.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'tavle-kridt-1234' });
    assert.strictEqual(r.mfa, true);
    assert.strictEqual(B.cookie, '', 'ingen session før koden');
    assert.strictEqual((await B.call('POST', '/api/login/2fa', { ticket: r.ticket, code: '123456' }))._status, 401);
    // Samme kode som ved opsætningen kan ikke bruges igen (genafspilning) – næste kode virker
    let ok = await B.call('POST', '/api/login/2fa', { ticket: r.ticket, code: codeNow(st.secret, 1) });
    assert.strictEqual(ok._status, 200);
    assert.strictEqual((await B.call('GET', '/api/me')).needs, null);
    // Reservekode virker én gang
    const C = client(base);
    r = await C.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'tavle-kridt-1234' });
    ok = await C.call('POST', '/api/login/2fa', { ticket: r.ticket, code: en.backupCodes[0].toLowerCase() });
    assert.strictEqual(ok._status, 200);
    assert.strictEqual(ok.backupLeft, 9);
    const D = client(base);
    r = await D.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'tavle-kridt-1234' });
    assert.strictEqual((await D.call('POST', '/api/login/2fa', { ticket: r.ticket, code: en.backupCodes[0] }))._status, 401);
    // For mange forkerte koder: billetten dør
    for (let i = 0; i < 4; i++) await D.call('POST', '/api/login/2fa', { ticket: r.ticket, code: '000000' });
    assert.match((await D.call('POST', '/api/login/2fa', { ticket: r.ticket, code: en.backupCodes[1] })).error, /start forfra/);

    // --- Glemt adgangskode ---
    const before = mails.length;
    assert.strictEqual((await client(base).call('POST', '/api/password/forgot', { email: 'findes@ikke.dk' }))._status, 200);
    assert.strictEqual(mails.length, before, 'ingen mail til ukendt adresse – men samme svar');
    await client(base).call('POST', '/api/password/forgot', { email: 'mette@skole.dk' });
    const rtok = linkIn(last('mette@skole.dk'), 'nulstil');
    assert.ok(rtok);
    assert.strictEqual((await client(base).call('POST', '/api/password/reset', { token: rtok, password: 'kort' }))._status, 400);
    assert.match((await client(base).call('POST', '/api/password/reset', { token: rtok, password: 'Vinter2025' })).error, /almindeligt ord/);
    assert.match((await client(base).call('POST', '/api/password/reset', { token: rtok, password: 'mette-mette' })).error, /navn|række/, 'lærerens eget navn afvises også ved nulstilling');
    r = await client(base).call('POST', '/api/password/reset', { token: rtok, password: 'nyt-kodeord-123' });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r.mfa, true);
    // Læreren får besked om ændringen (OWASP ASVS) – med et link til at nulstille, hvis det ikke var hende
    const sec = last('mette@skole.dk');
    assert.match(sec.subject, /adgangskode.*nulstillet/i);
    assert.match(sec.text, /Var det ikke dig/);
    assert.match(sec.text, /https:\/\/holymoly\.test\/glemt/);
    assert.strictEqual((await A.call('GET', '/api/me'))._status, 401, 'alle sessioner logget ud efter nulstilling');
    r = await A.call('POST', '/api/login', { email: 'mette@skole.dk', password: 'nyt-kodeord-123' });
    assert.strictEqual(r.mfa, true, 'to-faktor kræves stadig efter nulstilling');
    await A.call('POST', '/api/login/2fa', { ticket: r.ticket, code: en.backupCodes[2] });

    // --- Invitér en kollega ---
    r = await A.call('POST', '/api/school/invites', { emails: ['jonas@skole.dk', 'ikke-en-mail'] });
    assert.strictEqual(r._status, 400);
    r = await A.call('POST', '/api/school/invites', { emails: ['jonas@skole.dk'] });
    assert.deepStrictEqual(r.sent, ['jonas@skole.dk']);
    const itok = linkIn(last('jonas@skole.dk'), 'opret');
    assert.ok(itok);
    const info = await client(base).call('GET', '/api/invite/' + itok);
    assert.strictEqual(info.schoolName, 'Aarhus Gymnasium');
    const J = client(base);
    r = await J.call('POST', '/api/register', { email: 'jonas@skole.dk', name: 'Jonas', password: 'tavle-kridt-5678', invite: itok, acceptTerms: true });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r.verify, false, 'e-mailen er bevist af invitationen');
    me = await J.call('GET', '/api/me');
    assert.strictEqual(me.school.name, 'Aarhus Gymnasium');
    assert.strictEqual(me.school.role, 'teacher');
    assert.strictEqual(me.needs, '2fa');
    assert.strictEqual((await J.call('GET', '/api/school')).needs, '2fa', 'skolen kan først ses, når to-faktor er sat op');
    assert.strictEqual((await J.call('POST', '/api/school/invites', { emails: ['x@y.dk'] }))._status, 403, 'kun admin inviterer');
    assert.strictEqual((await client(base).call('GET', '/api/invite/' + itok))._status, 404, 'invitationen er brugt');

    // Skolens oversigt for admin
    let school = await A.call('GET', '/api/school');
    assert.strictEqual(school.teachers.length, 2);
    const jonas = school.teachers.find(t => t.name === 'Jonas');
    assert.strictEqual(jonas.totp, false);
    // Sidste admin kan ikke fjernes / degraderes
    const mette = school.teachers.find(t => t.me);
    assert.strictEqual((await A.call('PATCH', '/api/school/teachers/' + mette.id, { role: 'teacher' }))._status, 400);
    assert.strictEqual((await A.call('PATCH', '/api/school/teachers/' + jonas.id, { role: 'admin' }))._status, 200);
    assert.strictEqual((await A.call('PATCH', '/api/school/teachers/' + jonas.id, { role: 'teacher' }))._status, 200);

    // --- Licensen udløber: ingen nye lektioner, men data kan stadig ses ---
    srv.db.prepare('UPDATE schools SET trial_ends = ?').run(Date.now() - 1000);
    me = await A.call('GET', '/api/me');
    assert.strictEqual(me.license.state, 'expired');
    r = await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start' });
    assert.strictEqual(r._status, 402);
    assert.strictEqual(r.needs, 'license');
    assert.strictEqual((await A.call('GET', `/api/classes/${cls.id}`))._status, 200);

    // --- Bestil licens ---
    r = await A.call('POST', '/api/school/order', { students: 300, years: 1, cvr: '1234', acceptTerms: true });
    assert.strictEqual(r._status, 400, 'CVR skal have 8 cifre');
    r = await A.call('POST', '/api/school/order', { students: 300, years: 1, cvr: '12345678', ean: '5798000000001', reference: 'IT-123', acceptTerms: true });
    assert.strictEqual(r._status, 200);
    assert.strictEqual(r.amount, 15000);
    assert.ok(last('salg@holymoly.dk').subject.includes('Licensbestilling'));
    assert.ok(last('mette@skole.dk').subject.includes('Tak for din bestilling'));
    school = await A.call('GET', '/api/school');
    assert.strictEqual(school.orders[0].ean, '5798000000001');
    // Minimumspris
    r = await A.call('POST', '/api/school/order', { students: 5, years: 2, cvr: '12345678', invoiceEmail: 'faktura@skole.dk', acceptTerms: true });
    assert.strictEqual(r.amount, 2000);

    // --- HolyMoly-administration ---
    assert.strictEqual((await A.call('GET', '/api/admin/overview'))._status, 403);
    const Boss = client(base);
    await Boss.call('POST', '/api/register', { email: 'boss@holymoly.dk', name: 'Boss', password: 'kodeord-boss1', schoolName: 'HolyMoly', acceptTerms: true });
    await client(base).call('POST', '/api/verify', { token: linkIn(last('boss@holymoly.dk'), 'bekraeft') });
    const bst = await Boss.call('POST', '/api/account/2fa/start');
    await Boss.call('POST', '/api/account/2fa/enable', { code: codeNow(bst.secret) });
    assert.strictEqual((await Boss.call('GET', '/api/me')).platformAdmin, true);
    const ov = await Boss.call('GET', '/api/admin/overview');
    assert.strictEqual(ov._status, 200);
    assert.strictEqual(ov.stats.schools, 2);
    const order = ov.orders.find(o => o.students === 300);
    r = await Boss.call('PATCH', '/api/admin/orders/' + order.id, { status: 'faktureret', activate: true });
    assert.strictEqual(r._status, 200);
    me = await A.call('GET', '/api/me');
    assert.strictEqual(me.license.state, 'active');
    assert.strictEqual(me.license.seats, 300);
    assert.ok(me.license.daysLeft >= 364);
    assert.ok(last('mette@skole.dk').subject.includes('aktiveret'));
    r = await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start' });
    assert.strictEqual(r._status, 200, 'lektioner virker igen');
    await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'stop' });
    assert.strictEqual((await Boss.call('PATCH', '/api/admin/schools/' + me.school.id, { trialEnds: '2030-01-01' }))._status, 200);

    // --- Admin nulstiller en kollegas to-faktor; slet konto ---
    assert.strictEqual((await A.call('POST', `/api/school/teachers/${jonas.id}/reset-2fa`))._status, 200);
    assert.strictEqual((await A.call('DELETE', '/api/account', { password: 'nyt-kodeord-123' }))._status, 400, 'eneste admin kan ikke slette sig');
    assert.strictEqual((await J.call('GET', '/api/me'))._status, 401, 'kollegaen er logget ud efter nulstilling');
    assert.strictEqual((await J.call('POST', '/api/login', { email: 'jonas@skole.dk', password: 'tavle-kridt-5678' })).ok, true);
    assert.strictEqual((await J.call('DELETE', '/api/account', { password: 'forkert' }))._status, 400);
    assert.strictEqual((await J.call('DELETE', '/api/account', { password: 'tavle-kridt-5678' }))._status, 200);
    assert.strictEqual(srv.db.prepare("SELECT COUNT(*) AS n FROM teachers WHERE email = 'jonas@skole.dk'").get().n, 0);
    assert.strictEqual((await A.call('DELETE', '/api/account', { password: 'nyt-kodeord-123' }))._status, 200, 'nu er hun alene og kan slette');
    assert.strictEqual(srv.db.prepare("SELECT COUNT(*) AS n FROM schools WHERE name = 'Aarhus Gymnasium'").get().n, 0, 'tom skole slettes');
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 0, 'klasserne slettes med kontoen');
  } finally {
    await srv.close();
  }
});

test('sikkerhed: overtagelse af en for-oprettet konto, prøveperioder og invitationer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-acc3-'));
  const mails = [];
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, licensing: true, require2fa: true,
    mailSend: async (m) => { mails.push(m); }, publicUrl: 'https://holymoly.test', platformAdmins: 'boss@holymoly.dk' });
  const port = await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  const last = (to) => [...mails].reverse().find(m => m.to === to);
  try {
    // En angriber for-opretter ejerens e-mail (kan ikke bekræfte den)
    const X = client(base);
    await X.call('POST', '/api/register', { email: 'boss@holymoly.dk', name: 'Falsk', password: 'angriber-kode-1', schoolName: 'Falsk skole', acceptTerms: true });
    assert.strictEqual((await X.call('GET', '/api/me')).needs, 'verify');
    // Ikke-bekræftet: kan hverken sætte to-faktor op, oprette skole eller knytte Unilogin
    assert.strictEqual((await X.call('POST', '/api/account/2fa/start'))._status, 403);
    assert.strictEqual((await X.call('POST', '/api/school/create', { name: 'Y', acceptTerms: true }))._status, 403);
    const link = await fetch(base + '/api/auth/unilogin/start?role=teacher&link=1', { redirect: 'manual', headers: { Cookie: X.cookie } });
    assert.notStrictEqual(link.status, 302, 'ingen Unilogin-tilknytning fra en ikke-bekræftet konto');
    assert.strictEqual((await X.call('GET', '/api/admin/overview'))._status, 403);
    // Ejeren nulstiller adgangskoden: overtager kontoen ren, og angriberen er logget ud
    srv.db.prepare("UPDATE teachers SET totp_secret = 'v1.x', uni_id = 'falsk-uni' WHERE email = 'boss@holymoly.dk'").run(); // som om angriberen havde nået det
    await client(base).call('POST', '/api/password/forgot', { email: 'boss@holymoly.dk' });
    const r = await client(base).call('POST', '/api/password/reset', { token: linkIn(last('boss@holymoly.dk'), 'nulstil'), password: 'ejerens-kode-123' });
    assert.strictEqual(r.mfa, false, 'angriberens to-faktor er fjernet');
    const row = srv.db.prepare("SELECT * FROM teachers WHERE email = 'boss@holymoly.dk'").get();
    assert.strictEqual(row.uni_id, null);
    assert.strictEqual(row.school_id, null);
    assert.strictEqual(srv.db.prepare("SELECT COUNT(*) AS n FROM schools WHERE name = 'Falsk skole'").get().n, 0);
    assert.strictEqual((await X.call('GET', '/api/me'))._status, 401);

    // Prøveperioden gives kun én gang pr. e-mail
    const A = client(base);
    await A.call('POST', '/api/register', { email: 'a@skole.dk', name: 'A', password: 'tavle-kridt-1234', schoolName: 'Skole 1', acceptTerms: true });
    srv.db.prepare("UPDATE teachers SET email_verified = 1 WHERE email = 'a@skole.dk'").run();
    const st = await A.call('POST', '/api/account/2fa/start');
    await A.call('POST', '/api/account/2fa/enable', { code: codeNow(st.secret) });
    let me = await A.call('GET', '/api/me');
    assert.strictEqual(me.license.state, 'trial');
    srv.db.prepare('UPDATE teachers SET school_id = NULL').run(); // fx fjernet fra skolen af en anden admin
    const again = await A.call('POST', '/api/school/create', { name: 'Skole 2', acceptTerms: true });
    assert.strictEqual(again.trial, false);
    me = await A.call('GET', '/api/me');
    assert.strictEqual(me.license.state, 'expired', 'ingen ny prøveperiode');

    // Invitationer gælder kun den e-mail, de er sendt til
    srv.db.prepare("UPDATE teachers SET school_id = ?, role = 'admin' WHERE email = 'a@skole.dk'").run(me.school.id);
    await A.call('POST', '/api/school/invites', { emails: ['kollega@skole.dk'], role: 'admin' });
    const itok = linkIn(last('kollega@skole.dk'), 'opret');
    const Z = client(base);
    assert.strictEqual((await Z.call('POST', '/api/register', { email: 'fremmed@x.dk', name: 'Z', password: 'tavle-kridt-1234', invite: itok, acceptTerms: true }))._status, 400);
    assert.strictEqual((await Z.call('POST', '/api/register', { email: 'kollega@skole.dk', name: 'K', password: 'tavle-kridt-1234', invite: itok, acceptTerms: true }))._status, 200);
  } finally { await srv.close(); }
});

test('TOTP følger RFC 6238 og hemmeligheden gemmes krypteret', () => {
  assert.strictEqual(T.hotp(Buffer.from('12345678901234567890'), 1), '287082');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-box-'));
  const box = T.secretBox(dir);
  const sealed = box.seal('HEMMELIG');
  assert.ok(!sealed.includes('HEMMELIG'));
  assert.strictEqual(T.secretBox(dir).open(sealed), 'HEMMELIG', 'samme nøgle efter genstart');
  assert.strictEqual(T.secretBox(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-box-'))).open(sealed), null, 'andre nøgler kan ikke åbne');
});

test('uden licens-styring (skolens egen server) virker alt som før', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-acc2-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false });
  const port = await srv.listen();
  const A = client('http://127.0.0.1:' + port);
  try {
    const r = await A.call('POST', '/api/register', { email: 'a@b.dk', name: 'A', password: 'tavle-kridt-1234' });
    assert.strictEqual(r._status, 200);
    assert.strictEqual((await A.call('GET', '/api/me')).needs, null);
    const cls = await A.call('POST', '/api/classes', { name: 'X' });
    assert.strictEqual((await A.call('POST', `/api/classes/${cls.id}/lesson`, { action: 'start' }))._status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'outbox')) === false, 'ingen mails uden bekræftelse');
  } finally { await srv.close(); }
});

test('enkel tilstand: nye lærere godkendes af en godkendt kollega', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-approve-'));
  const mk = () => createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false, simple: true,
    schoolApproval: { controller: 'Testskolen', dpo: 'dpo@test.dk', dpiaDate: '2026-11-01', approvedDate: '2026-11-15' } });
  let srv = mk();
  let base = 'http://127.0.0.1:' + await srv.listen();
  try {
    // Den første lærer (opsætningskoden) er godkendt med det samme
    const A = client(base);
    let r = await A.call('POST', '/api/register', { email: 'mette', name: 'Mette Hansen', password: 'tavle-kridt-1234', acceptTerms: true, signupCode: srv.setupCode() });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.pending);
    let me = await A.call('GET', '/api/me');
    assert.strictEqual(me.needs, null);
    assert.strictEqual(me.approved, true);
    const code = (await A.call('POST', '/api/account/teacher-code/show', {})).teacherCode;

    // Jens bruger lærerkoden: kontoen venter på godkendelse og kan kun se /api/me og logge ud
    const J = client(base);
    r = await J.call('POST', '/api/register', { email: 'jens', name: 'Jens Berg', password: 'tavle-kridt-9876', acceptTerms: true, signupCode: code });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pending, true);
    me = await J.call('GET', '/api/me');
    assert.strictEqual(me.needs, 'approval');
    r = await J.call('GET', '/api/classes');
    assert.strictEqual(r._status, 403);
    assert.strictEqual(r.needs, 'approval');
    for (const [m, p] of [['POST', '/api/classes'], ['POST', '/api/account/teacher-code/show'], ['GET', '/api/account/pending-teachers'], ['POST', `/api/account/teachers/${me.id}/approve`], ['DELETE', '/api/account'], ['POST', '/api/account/password']]) {
      assert.strictEqual((await J.call(m, p, m === 'GET' ? undefined : {}))._status, 403, `${m} ${p} er lukket for en lærer, der venter`);
    }
    const jensId = me.id;

    // Eva venter også
    const E = client(base);
    r = await E.call('POST', '/api/register', { email: 'eva', name: 'Eva Holm', password: 'tavle-kridt-4242', acceptTerms: true, signupCode: code });
    assert.strictEqual(r.pending, true);

    // Mette ser de ventende lærere med navn og tidspunkt
    const pend = await A.call('GET', '/api/account/pending-teachers');
    assert.deepStrictEqual(pend.teachers.map(t => [t.name, t.username]), [['Jens Berg', 'jens'], ['Eva Holm', 'eva']]);
    assert.ok(pend.teachers.every(t => t.created > Date.now() - 60_000));
    const evaId = pend.teachers.find(t => t.username === 'eva').id;

    // Mette godkender Jens og afviser Eva
    assert.ok((await A.call('POST', `/api/account/teachers/${jensId}/approve`, {})).ok);
    assert.strictEqual((await J.call('GET', '/api/me')).needs, null);
    assert.ok(Array.isArray(await J.call('GET', '/api/classes')), 'Jens kan bruge HolyMoly');
    assert.ok((await A.call('DELETE', `/api/account/teachers/${evaId}`)).ok);
    assert.strictEqual((await E.call('GET', '/api/me'))._status, 401, 'Evas konto er slettet');
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM teachers').get().n, 2);
    // En godkendt lærer kan ikke afvises (slettes) eller godkendes igen
    assert.strictEqual((await J.call('DELETE', `/api/account/teachers/${(await A.call('GET', '/api/me')).id}`))._status, 404);
    assert.strictEqual((await A.call('POST', `/api/account/teachers/${jensId}/approve`, {}))._status, 404);
    assert.deepStrictEqual((await A.call('GET', '/api/account/pending-teachers')).teachers, []);

    // Lærere fra før godkendelsen fandtes, er godkendt efter opdateringen
    await srv.close();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'holymoly.db'));
    raw.exec('ALTER TABLE teachers DROP COLUMN approved');
    raw.close();
    srv = mk();
    base = 'http://127.0.0.1:' + await srv.listen();
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) AS n FROM teachers WHERE approved IS NULL').get().n, 0);
  } finally { await srv.close(); }

  // Uden enkel tilstand findes ventelisten ikke
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-approve2-'));
  const full = createServer({ port: 0, host: '127.0.0.1', dataDir: dir2, quiet: true, requireGuard: false, signupCode: 'k' });
  const b2 = 'http://127.0.0.1:' + await full.listen();
  try {
    const X = client(b2);
    assert.ok(!(await X.call('POST', '/api/register', { email: 'x@skole.dk', name: 'X', password: 'tavle-kridt-1234', signupCode: 'k' })).pending);
    assert.strictEqual((await X.call('GET', '/api/me')).needs, null);
    assert.strictEqual((await X.call('GET', '/api/account/pending-teachers'))._status, 404);
  } finally { await full.close(); }
});
