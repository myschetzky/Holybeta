'use strict';
/*
 * Kontoer, skoler og licenser.
 *
 *  - Lærere opretter sig selv med e-mail + adgangskode (bekræft e-mail) – eller logger ind med Unilogin.
 *  - E-mail-login har to-faktor (godkendelses-app + reservekoder). Unilogin har sin egen sikkerhed (MitID m.m.).
 *  - En skole har en prøveperiode og derefter en licens (antal elever, udløbsdato). Skolens administrator
 *    inviterer kolleger og bestiller licensen (faktura med EAN/CVR). HolyMoly's egne administratorer
 *    (PLATFORM_ADMINS) aktiverer licenser på /admin.
 *  - Er licensen udløbet, kan læreren stadig se og eksportere alt – men ikke starte nye lektioner.
 */
const U = require('./util');
const T = require('./totp');
const { weakReason } = require('./passwords');

const DAY = 86400_000;
const ORDER_STATUSES = ['ny', 'faktureret', 'betalt', 'annulleret'];
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;
// Enkel tilstand: brugernavn i stedet for e-mail (bogstaver, tal, punktum, bindestreg, understreg)
const usernameOk = (u) => /^[\p{L}\p{N}._-]{2,40}$/u.test(u);
const cleanName = (v, max = 100) => U.str(v, max).replace(/[\u0000-\u001F\u007F]/g, '').trim();

function createAccounts(ctx) {
  const { db, cfg, mailer, log, send, fail, readJson, setSession, clientIp, deleteClassFully } = ctx;
  const box = T.secretBox(cfg.dataDir);

  const forgotRl = new U.RateLimiter(5, 5 / 600);      // pr. IP
  const forgotEmailRl = new U.RateLimiter(3, 3 / 3600); // pr. e-mail
  const resendRl = new U.RateLimiter(3, 3 / 3600);
  const inviteRl = new U.RateLimiter(50, 50 / 86400);   // pr. skole
  const orderRl = new U.RateLimiter(5, 5 / 86400);
  const mfaRl = new U.RateLimiter(10, 10 / 3600);       // forkerte to-faktor-koder pr. lærer (10, derefter 10 i timen)
  const mfaFails = new Map(); // lærer-id -> { n, since, warned } – advarsel på mail ved mange forkerte koder
  const DUMMY_HASH = U.hashPassword(U.randomToken()); // samme svartid, uanset om kontoen findes
  const pendingLogin = new Map(); // hash(billet) -> { teacherId, exp, tries }
  const pendingTotp = new Map();  // lærer-id -> { secret, exp }
  const sweep = (m) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };

  /* ---------------- hjælpere ---------------- */
  // Links i mails peger altid på PUBLIC_URL – aldrig på Host-headeren, som en angriber kan sætte
  function baseUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl;
    if (cfg.smtpUrl) throw Object.assign(new Error('Serveren mangler PUBLIC_URL – kontakt HolyMoly'), { status: 500 });
    return `http://${req.headers.host}`;
  }
  function newToken(kind, fields, ttlMs) {
    const tok = U.randomToken(32);
    db.prepare('INSERT INTO tokens (token_hash, kind, teacher_id, school_id, email, role, created, expires) VALUES (?,?,?,?,?,?,?,?)')
      .run(U.sha256(tok), kind, fields.teacherId ?? null, fields.schoolId ?? null, fields.email ?? null, fields.role ?? null, Date.now(), Date.now() + ttlMs);
    return tok;
  }
  function takeToken(kind, tok, consume = true) {
    const h = U.sha256(String(tok || ''));
    const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(h, kind);
    if (!row || row.expires < Date.now()) return null;
    if (consume) db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(h);
    return row;
  }
  const teacherRow = (id) => db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
  const schoolRow = (id) => (id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(id) : null);
  const isUniOnly = (t) => String(t.email).startsWith('unilogin:');

  function licenseOf(schoolId) {
    const s = schoolRow(schoolId);
    if (!s) return null;
    const now = Date.now();
    const used = db.prepare(`SELECT COUNT(*) AS n FROM students st JOIN classes c ON c.id = st.class_id JOIN teachers t ON t.id = c.teacher_id
      WHERE t.school_id = ? AND st.enrolled IS NOT NULL`).get(s.id).n;
    const state = s.license_until && s.license_until > now ? 'active' : s.trial_ends > now ? 'trial' : 'expired';
    const until = state === 'active' ? s.license_until : state === 'trial' ? s.trial_ends : (s.license_until || s.trial_ends);
    return {
      state, until, daysLeft: Math.max(0, Math.ceil((until - now) / DAY)), trialEnds: s.trial_ends, licenseUntil: s.license_until || null,
      seats: s.seats, used, overSeats: state === 'active' && s.seats > 0 && used > s.seats,
    };
  }
  /** Må læreren starte en lektion? (Uden licens-styring – fx skolens egen server – altid ja.) */
  function canTeach(teacher) {
    if (!cfg.licensing) return { ok: true };
    if (!teacher.school_id) return { ok: false, error: 'Opret eller tilslut din skole først' };
    const l = licenseOf(teacher.school_id);
    if (!l || l.state === 'expired') return { ok: false, error: 'Skolens prøveperiode eller licens er udløbet. Skolens administrator kan bestille en licens under Skole → Licens.' };
    return { ok: true };
  }
  // HolyMoly-administrator: e-mailen skal være bevist via en mail (ikke kun "bekræftet", fordi serveren ikke kan sende mails),
  // og der skal være logget ind med to-faktor
  const isPlatformAdmin = (t, sess) => cfg.verifyEmail && !!t.email_verified && cfg.platformAdmins.includes(String(t.email).toLowerCase()) && !!t.totp_secret && !!sess.mfa;

  /** Hvad mangler læreren, før dashboardet kan bruges? */
  function needs(t, sess) {
    if (cfg.verifyEmail && !t.email_verified) return 'verify';
    if (cfg.require2fa && !sess.mfa) return '2fa';
    if (cfg.licensing && !t.school_id) return 'school';
    // Enkel tilstand: en ny lærer skal godkendes af en kollega (lærerkoden kan være nået ud til en elev)
    if (cfg.simple && !t.approved) return 'approval';
    return null;
  }
  function price(students, years = 1) {
    const p = cfg.pricing;
    return Math.max(p.minimum, Math.round(students * p.perStudent)) * years;
  }
  const uniInsts = (t) => { try { const a = JSON.parse(t.uni_insts || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  /** Efter et Unilogin-login: husk lærerens institutioner, og kobl en lærer uden skole på skolen med institutionsnummeret. */
  function uniLoggedIn(teacherId, institutions) {
    const list = (institutions || []).map(i => ({ nr: String(i.nr), name: String(i.name || '') })).slice(0, 20);
    db.prepare('UPDATE teachers SET uni_insts = ? WHERE id = ?').run(JSON.stringify(list), teacherId);
    const t = teacherRow(teacherId);
    if (!t || t.school_id || !list.length) return null;
    const q = db.prepare('SELECT id, name FROM schools WHERE inst_nr = ?');
    for (const i of list) {
      const s = q.get(i.nr);
      if (s) {
        db.prepare("UPDATE teachers SET school_id = ?, role = 'teacher' WHERE id = ? AND school_id IS NULL").run(s.id, t.id);
        log('Lærer koblet på skole via Unilogin-institutionsnummer', t.id, s.id);
        return s;
      }
    }
    return null;
  }
  const instOk = (v) => /^[0-9A-Za-z]{2,20}$/.test(v);

  function me(t, sess) {
    const school = schoolRow(t.school_id);
    return {
      id: t.id, email: isUniOnly(t) ? null : t.email, name: t.name, uniLinked: !!t.uni_id, uniOnly: isUniOnly(t),
      verified: !!t.email_verified, totp: !!t.totp_secret, require2fa: cfg.require2fa, needs: needs(t, sess), simple: cfg.simple,
      // Lærerkoden vises først efter et klik ("Vis kode") og gælder 30 minutter
      teacherCodeOn: cfg.simple && !cfg.signupCode, approved: !!t.approved,
      school: school ? { id: school.id, name: school.name, role: t.role } : null,
      license: school ? licenseOf(school.id) : null, licensing: cfg.licensing,
      platformAdmin: isPlatformAdmin(t, sess),
      uniInstitutions: uniInsts(t),
    };
  }
  /** Ny skole. Prøveperioden gives kun første gang en e-mail (eller et Unilogin) opretter en skole. */
  function createSchool(name, who) {
    const key = String(who || '').toLowerCase();
    const used = key && db.prepare('SELECT 1 FROM trial_claims WHERE who = ?').get(key);
    if (key && !used) db.prepare('INSERT OR IGNORE INTO trial_claims (who, created) VALUES (?,?)').run(key, Date.now());
    const trialEnds = used ? Date.now() : Date.now() + cfg.trialDays * DAY;
    return { id: Number(db.prepare('INSERT INTO schools (name, created, trial_ends, seats) VALUES (?,?,?,0)').run(name, Date.now(), trialEnds).lastInsertRowid), trial: !used };
  }
  const trialKey = (t) => (t.uni_id ? 'uni:' + t.uni_id : String(t.email).toLowerCase());
  async function sendVerify(req, t) {
    db.prepare("DELETE FROM tokens WHERE teacher_id = ? AND kind = 'verify'").run(t.id);
    const tok = newToken('verify', { teacherId: t.id, email: t.email }, 3 * DAY);
    await mailer.send({
      to: t.email, subject: 'Bekræft din e-mail til HolyMoly', title: `Hej ${t.name}`,
      lines: ['Tak fordi du har oprettet dig på HolyMoly. Bekræft din e-mail, så er din konto klar.'],
      button: { label: 'Bekræft e-mail', url: `${baseUrl(req)}/bekraeft?t=${tok}` },
      after: ['Linket virker i 3 dage.'],
    });
  }
  function notifySales(subject, lines) {
    if (!cfg.salesEmail) return;
    mailer.send({ to: cfg.salesEmail, subject, title: subject, lines });
  }
  const sessionsOf = (teacherId, exceptHash) => {
    if (exceptHash) db.prepare('DELETE FROM sessions WHERE teacher_id = ? AND token_hash != ?').run(teacherId, exceptHash);
    else db.prepare('DELETE FROM sessions WHERE teacher_id = ?').run(teacherId);
    // Åbne klasseværelser fra de andre sessioner lukkes med det samme (ikke først ved næste genforbindelse)
    if (ctx.closeTeacher) ctx.closeTeacher(teacherId, exceptHash);
  };
  /** Længde + blokliste (NIST SP 800-63B-4): almindelige/lækkede adgangskoder og lærerens eget navn/e-mail. */
  /* Enkel tilstand: den første lærer opretter sig frit. Derefter kræves lærerkoden, som alle lærere kan se under Konto,
     så en elev ikke kan oprette sig som lærer på en offentlig server. TEACHER_SIGNUP_CODE går forud. */
  const metaGet = (key) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) || {}).value ?? null;
  const metaSet = (key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  // Lærerkoden gælder 30 minutter fra den vises. Derefter laves en ny, næste gang en lærer klikker "Vis kode".
  const TEACHER_CODE_MS = 30 * 60_000;
  /** Den gyldige lærerkode, eller null (ingen eller udløbet). */
  function currentTeacherCode() {
    const code = metaGet('teacher_code');
    const created = Number(metaGet('teacher_code_created'));
    return code && created && Date.now() - created < TEACHER_CODE_MS ? code : null;
  }
  /** "Vis kode": den gyldige kode – eller en ny (rotate = altid en ny, så den gamle holder op med at virke). */
  function showTeacherCode(rotate = false) {
    let code = rotate ? null : currentTeacherCode();
    if (!code) {
      code = U.inviteCode();
      metaSet('teacher_code', code);
      metaSet('teacher_code_created', Date.now());
    }
    return { teacherCode: code, expires: Number(metaGet('teacher_code_created')) + TEACHER_CODE_MS };
  }
  const hasTeachers = () => !!db.prepare('SELECT 1 FROM teachers LIMIT 1').get();
  /* Enkel tilstand: den første lærer skal bruge en engangs-opsætningskode, som kun står i serverens log
     (så en elev ikke kan nå at oprette sig som den første lærer på en ny server). Den slettes, når den er brugt. */
  function setupCode() {
    if (!cfg.simple || cfg.signupCode || hasTeachers()) return null;
    let code = metaGet('setup_code');
    if (!code) {
      code = U.inviteCode();
      metaSet('setup_code', code); // skrives i serverens log ved start (index.js) og af npm run enkel
    }
    return code;
  }
  function signupCodeNow() {
    if (cfg.signupCode) return cfg.signupCode;
    // Ingen gyldig lærerkode: en værdi, som ingen kode kan passe med (koden skal stadig kræves)
    if (cfg.simple) return hasTeachers() ? (currentTeacherCode() || 'udløbet') : setupCode();
    return '';
  }
  function checkPassword(pw, who = {}) {
    if (pw.length < 10) return 'Adgangskoden skal være mindst 10 tegn';
    if (pw.length > 200) return 'Adgangskoden er for lang';
    const school = who.school_id ? (schoolRow(who.school_id) || {}).name : who.school;
    return weakReason(pw, { email: who.email, name: who.name, school });
  }
  /** TOTP-kode eller reservekode. Returnerer 'totp' | 'backup' | null. */
  function checkSecondFactor(t, code) {
    const secret = t.totp_secret ? box.open(t.totp_secret) : null;
    if (!secret) return null;
    const c = String(code || '').trim();
    if (/^\d[\d\s]{5,8}$/.test(c)) {
      const step = T.verify(secret, c, t.totp_step);
      if (step < 0) return null;
      db.prepare('UPDATE teachers SET totp_step = ? WHERE id = ?').run(step, t.id);
      return 'totp';
    }
    if (T.normBackup(c).length === 10) {
      const r = db.prepare('DELETE FROM backup_codes WHERE teacher_id = ? AND code_hash = ?').run(t.id, T.hashBackup(c));
      if (r.changes) return 'backup';
    }
    return null;
  }
  /** Mange forkerte to-faktor-koder efter rigtig adgangskode = nogen kender adgangskoden. Læreren får besked (højst én gang i døgnet). */
  function mfaFailed(t) {
    if (!t) return;
    const now = Date.now();
    let f = mfaFails.get(t.id);
    if (!f || now - f.since > DAY) { f = { n: 0, since: now, warned: false }; mfaFails.set(t.id, f); }
    f.n++;
    if (f.n >= 5 && !f.warned && !isUniOnly(t)) {
      f.warned = true;
      mailer.send({ to: t.email, subject: 'Forsøg på at logge ind på din HolyMoly-konto', title: 'Nogen forsøger at logge ind',
        lines: ['Nogen har skrevet den rigtige adgangskode til din HolyMoly-konto, men en forkert kode fra godkendelses-appen flere gange.',
          'Var det ikke dig, så skift din adgangskode med det samme (Konto og sikkerhed). Din konto er stadig beskyttet af to-faktor.'] });
    }
  }
  /**
   * Sikkerhedslog til skolens administrator (OWASP A09): hvem loggede ind hvordan, hvad blev ændret, af hvem.
   * Kun for lærere på en skole. IP-adressen gemmes til sikkerhedsformål og slettes med loggen efter 90 dage.
   */
  const SECLOG_DAYS = 90;
  function secLog(who, kind, text, req) {
    try {
      const t = who && typeof who === 'object' ? who : teacherRow(who);
      if (!t || !t.school_id) return;
      db.prepare('INSERT INTO security_log (school_id, teacher_id, ts, kind, text, ip) VALUES (?,?,?,?,?,?)')
        .run(t.school_id, t.id, Date.now(), kind, String(text).slice(0, 300), req ? String(clientIp(req)).slice(0, 64) : null);
    } catch (e) { log('Sikkerhedslog fejlede', e.message); }
  }
  /**
   * Sikkerhedsbesked til læreren, når login-oplysningerne ændres (OWASP ASVS: brugeren underrettes om
   * ændringer af adgangskode og to-faktor). Overtager nogen kontoen, opdager ejeren det med det samme.
   */
  function securityMail(req, t, subject, what) {
    secLog(t, 'account', `${t && t.name}: ${what}`, req);
    if (!t || isUniOnly(t)) return;
    log('Sikkerhed:', subject, 'lærer', t.id);
    const when = new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', dateStyle: 'long', timeStyle: 'short' });
    // Ændringen er allerede gemt: en fejl i mailen må ikke give læreren en fejl
    try {
      Promise.resolve(mailer.send({
        to: t.email, subject, title: subject,
        lines: [`${what} (${when}).`, 'Var det dig, behøver du ikke gøre noget.',
          'Var det ikke dig, så nulstil din adgangskode med det samme og kontakt din skoles administrator.'],
        button: { label: 'Nulstil adgangskode', url: `${baseUrl(req)}/glemt` },
      })).catch((e) => log('Sikkerhedsmail kunne ikke sendes', t.id, e.message));
    } catch (e) { log('Sikkerhedsmail kunne ikke sendes', t.id, e.message); }
  }
  function newBackupCodes(teacherId) {
    const codes = T.backupCodes();
    db.prepare('DELETE FROM backup_codes WHERE teacher_id = ?').run(teacherId);
    const ins = db.prepare('INSERT INTO backup_codes (teacher_id, code_hash) VALUES (?,?)');
    for (const c of codes) ins.run(teacherId, T.hashBackup(c));
    return codes;
  }
  function deleteTeacher(t) {
    if (ctx.closeTeacher) ctx.closeTeacher(t.id);
    for (const c of db.prepare('SELECT * FROM classes WHERE teacher_id = ?').all(t.id)) deleteClassFully(c);
    db.prepare('DELETE FROM teachers WHERE id = ?').run(t.id);
    if (t.school_id && !db.prepare('SELECT 1 FROM teachers WHERE school_id = ?').get(t.school_id)) db.prepare('DELETE FROM schools WHERE id = ?').run(t.school_id);
  }
  const admins = (schoolId) => db.prepare("SELECT COUNT(*) AS n FROM teachers WHERE school_id = ? AND role = 'admin'").get(schoolId).n;

  /* ---------------- offentlige ruter (uden login) ---------------- */
  async function publicRoutes(req, res, p, m) {
    const ip = clientIp(req);
    if (p === '/api/pricing' && m === 'GET') {
      return send(res, 200, Object.assign({ trialDays: cfg.trialDays, licensing: cfg.licensing, signup: cfg.signupOpen && !cfg.signupCode }, cfg.pricing));
    }
    if (p === '/api/register' && m === 'POST') {
      if (!ctx.loginRl.take('reg:' + ip)) return fail(res, 429, 'For mange forsøg – prøv igen om lidt'), true;
      const b = await readJson(req);
      let invite = null;
      if (b.invite) {
        invite = takeToken('invite', b.invite, false);
        if (!invite) return fail(res, 400, 'Invitationen er udløbet eller allerede brugt – bed om en ny'), true;
        if (String(invite.email).toLowerCase() !== U.str(b.email, 200).trim().toLowerCase()) return fail(res, 400, `Brug den e-mail, invitationen blev sendt til (${invite.email})`), true;
      }
      const firstTeacher = cfg.simple && !cfg.signupCode && !hasTeachers();
      const needCode = signupCodeNow();
      const want = U.normalizeCode(needCode);
      const codeOk = cfg.signupCode ? String(b.signupCode || '') === cfg.signupCode : !!want && U.normalizeCode(b.signupCode) === want;
      if (needCode && !invite && !codeOk) {
        return fail(res, 403, cfg.signupCode ? 'Forkert skolekode'
          : firstTeacher ? 'Forkert opsætningskode. Den første lærer bruger opsætningskoden fra serverens log ("Opsætningskode til første lærer").'
            : 'Forkert eller udløbet lærerkode. Bed en kollega om en ny under Konto (Vis kode).'), true;
      }
      if (!cfg.signupOpen && !cfg.signupCode && !invite) return fail(res, 403, 'Oprettelse er lukket – du skal inviteres af din skole'), true;
      const email = U.str(b.email, 200).trim().toLowerCase();
      const name = cleanName(b.name);
      const pw = String(b.password || '');
      if (cfg.simple ? !(usernameOk(email) || emailOk(email)) : !emailOk(email)) return fail(res, 400, cfg.simple ? 'Brugernavnet må kun have bogstaver, tal, punktum og bindestreg (2-40 tegn)' : 'Ugyldig e-mail'), true;
      if (!name) return fail(res, 400, 'Skriv dit navn'), true;
      const schoolName = cleanName(b.schoolName, 120);
      const pwErr = checkPassword(pw, { email, name, school: schoolName });
      if (pwErr) return fail(res, 400, pwErr), true;
      if (cfg.licensing && !invite && !schoolName) return fail(res, 400, 'Skriv skolens navn'), true;
      if (cfg.licensing && !b.acceptTerms) return fail(res, 400, 'Du skal acceptere vilkårene og databehandleraftalen'), true;
      if (cfg.simple && !b.acceptTerms) return fail(res, 400, 'Du skal acceptere vilkårene'), true;
      if (db.prepare('SELECT 1 FROM teachers WHERE email = ?').get(email)) return fail(res, 409, cfg.simple ? 'Brugernavnet er taget – vælg et andet, eller log ind' : 'E-mailen er allerede oprettet – log ind, eller brug "Glemt adgangskode"'), true;

      // E-mailen er bevist, hvis man kommer fra en invitation sendt til netop den adresse
      const verified = !cfg.verifyEmail || (invite && String(invite.email).toLowerCase() === email) ? 1 : 0;
      let schoolId = null, role = 'teacher';
      if (invite && schoolRow(invite.school_id)) { schoolId = invite.school_id; role = invite.role === 'admin' ? 'admin' : 'teacher'; }
      else if (schoolName) { schoolId = createSchool(schoolName, email).id; role = 'admin'; }
      // Enkel tilstand: kun den første lærer (opsætningskoden) er godkendt med det samme. De næste godkendes af en kollega.
      const approved = !cfg.simple || !db.prepare('SELECT 1 FROM teachers WHERE approved IS NOT NULL LIMIT 1').get() ? Date.now() : null;
      const r = db.prepare('INSERT INTO teachers (email, name, pass_hash, created, email_verified, school_id, role, terms_accepted, approved) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(email, name, U.hashPassword(pw), Date.now(), verified, schoolId, role, b.acceptTerms ? Date.now() : null, approved);
      const id = Number(r.lastInsertRowid);
      if (!approved) log('Ny lærer venter på godkendelse', id);
      if (firstTeacher) db.prepare("DELETE FROM meta WHERE key = 'setup_code'").run(); // engangskode
      if (invite) db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(invite.token_hash);
      if (invite && schoolId) secLog(teacherRow(id), 'admin', `${name} sluttede sig til skolen via en invitation${role === 'admin' ? ' (som administrator)' : ''}`, req);
      else if (schoolId) secLog(teacherRow(id), 'admin', `${name} oprettede skolen`, req);
      if (!verified) await sendVerify(req, teacherRow(id));
      if (schoolName && !invite) notifySales('Ny skole i prøveperiode: ' + schoolName, [`${name} <${email}> har oprettet ${schoolName}.`, `Prøveperioden løber ${cfg.trialDays} dage.`]);
      setSession(req, res, id, 0);
      log('Ny lærer oprettet', id, schoolName ? '(ny skole)' : invite ? '(inviteret)' : '');
      return send(res, 200, { ok: true, verify: !verified, setup2fa: cfg.require2fa, pending: !approved }), true;
    }
    if (p === '/api/login' && m === 'POST') {
      const b = await readJson(req);
      const email = U.str(b.email, 200).trim().toLowerCase();
      if (!ctx.loginRl.take('login:' + ip + ':' + email) || !ctx.loginEmailRl.take('login:' + email)) return fail(res, 429, 'For mange forsøg – prøv igen om lidt'), true;
      const row = db.prepare('SELECT id, name, school_id, pass_hash, totp_secret FROM teachers WHERE email = ?').get(email);
      const okPw = U.verifyPassword(String(b.password || ''), row ? row.pass_hash : DUMMY_HASH);
      if (row && !okPw) secLog(row, 'login-fail', `${row.name}: forkert adgangskode`, req);
      if (!row || !okPw) return fail(res, 401, cfg.simple ? 'Forkert brugernavn eller adgangskode' : 'Forkert e-mail eller adgangskode'), true;
      // Gammel, svagere hash? Gem adgangskoden igen med den nuværende styrke (vi kender den kun lige nu)
      if (U.needsRehash(row.pass_hash)) db.prepare('UPDATE teachers SET pass_hash = ? WHERE id = ?').run(U.hashPassword(String(b.password)), row.id);
      if (row.totp_secret) {
        sweep(pendingLogin);
        const ticket = U.randomToken(24);
        pendingLogin.set(U.sha256(ticket), { teacherId: row.id, exp: Date.now() + 5 * 60_000, tries: 0 });
        return send(res, 200, { mfa: true, ticket }), true;
      }
      setSession(req, res, row.id, 0);
      secLog(row, 'login', `${row.name} loggede ind (adgangskode, uden to-faktor)`, req);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/login/2fa' && m === 'POST') {
      const b = await readJson(req);
      const key = U.sha256(String(b.ticket || ''));
      const pend = pendingLogin.get(key);
      if (!pend || pend.exp < Date.now()) { pendingLogin.delete(key); return fail(res, 401, 'Login er udløbet – start forfra'), true; }
      if (!mfaRl.take('t:' + pend.teacherId)) return fail(res, 429, 'For mange forsøg – vent et par minutter'), true;
      const t = teacherRow(pend.teacherId);
      const how = t && checkSecondFactor(t, b.code);
      if (!how) {
        mfaFailed(t);
        secLog(t, 'login-fail', `${t && t.name}: rigtig adgangskode, men forkert to-faktor-kode`, req);
        if (++pend.tries >= 5) { pendingLogin.delete(key); return fail(res, 401, 'For mange forkerte koder – start forfra'), true; }
        return fail(res, 401, 'Forkert kode – prøv igen'), true;
      }
      pendingLogin.delete(key);
      mfaRl.refund('t:' + t.id);
      setSession(req, res, t.id, 1);
      secLog(t, 'login', `${t.name} loggede ind (adgangskode + ${how === 'backup' ? 'reservekode' : 'godkendelses-app'})`, req);
      const left = how === 'backup' ? db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE teacher_id = ?').get(t.id).n : null;
      return send(res, 200, { ok: true, backupLeft: left }), true;
    }
    if (p === '/api/verify' && m === 'POST') {
      const b = await readJson(req);
      const tok = takeToken('verify', b.token);
      if (!tok) return fail(res, 400, 'Linket er udløbet eller allerede brugt. Log ind og bed om et nyt.'), true;
      const t = teacherRow(tok.teacher_id);
      if (!t || t.email !== tok.email) return fail(res, 400, 'Linket passer ikke længere til kontoen'), true;
      db.prepare('UPDATE teachers SET email_verified = 1 WHERE id = ?').run(t.id);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/password/forgot' && m === 'POST') {
      const b = await readJson(req);
      const email = U.str(b.email, 200).trim().toLowerCase();
      if (!forgotRl.take(ip)) return fail(res, 429, 'For mange forsøg – prøv igen om lidt'), true;
      // Svaret er altid det samme, så ingen kan se, om en e-mail har en konto
      const t = emailOk(email) && forgotEmailRl.take(email) ? db.prepare('SELECT * FROM teachers WHERE email = ?').get(email) : null;
      if (t) {
        db.prepare("DELETE FROM tokens WHERE teacher_id = ? AND kind = 'reset'").run(t.id);
        const tok = newToken('reset', { teacherId: t.id, email: t.email }, 3600_000);
        await mailer.send({
          to: t.email, subject: 'Nulstil din adgangskode til HolyMoly', title: 'Nulstil adgangskode',
          lines: ['Nogen (forhåbentlig dig) har bedt om at nulstille adgangskoden til din HolyMoly-konto.'],
          button: { label: 'Vælg ny adgangskode', url: `${baseUrl(req)}/nulstil?t=${tok}` },
          after: ['Linket virker i 1 time. Har du to-faktor slået til, skal du stadig bruge din godkendelses-app bagefter.'],
        });
      }
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/password/reset' && m === 'POST') {
      const b = await readJson(req);
      const pw = String(b.password || '');
      // Tjek adgangskoden, før linket bruges op (så læreren kan prøve en anden)
      const peek = takeToken('reset', b.token, false);
      const pwErr = checkPassword(pw, (peek && teacherRow(peek.teacher_id)) || {});
      if (pwErr) return fail(res, 400, pwErr), true;
      const tok = takeToken('reset', b.token);
      if (!tok) return fail(res, 400, 'Linket er udløbet eller allerede brugt – bed om et nyt'), true;
      const t = teacherRow(tok.teacher_id);
      if (!t || t.email !== tok.email) return fail(res, 400, 'Linket passer ikke længere til kontoen'), true;
      if (!t.email_verified) {
        // Kontoen var ikke bekræftet: den kan være oprettet af en anden med denne e-mail. Ejeren overtager den
        // ren – uden Unilogin, to-faktor eller skole, som en anden kan have sat op.
        db.prepare("UPDATE teachers SET uni_id = NULL, totp_secret = NULL, totp_step = 0, school_id = NULL, role = 'teacher' WHERE id = ?").run(t.id);
        db.prepare('DELETE FROM backup_codes WHERE teacher_id = ?').run(t.id);
        if (t.school_id && !db.prepare('SELECT 1 FROM teachers WHERE school_id = ?').get(t.school_id)) db.prepare('DELETE FROM schools WHERE id = ?').run(t.school_id);
      }
      db.prepare('UPDATE teachers SET pass_hash = ?, email_verified = 1 WHERE id = ?').run(U.hashPassword(pw), t.id);
      sessionsOf(t.id); // alle andre steder logges ud
      for (const [k, v] of pendingLogin) if (v.teacherId === t.id) pendingLogin.delete(k);
      securityMail(req, t, 'Din adgangskode til HolyMoly er nulstillet', 'Adgangskoden til din HolyMoly-konto blev nulstillet via "Glemt adgangskode", og du er logget ud alle steder');
      return send(res, 200, { ok: true, mfa: !!teacherRow(t.id).totp_secret }), true;
    }
    let mm;
    if ((mm = p.match(/^\/api\/invite\/([A-Za-z0-9_-]{20,80})$/)) && m === 'GET') {
      const inv = takeToken('invite', mm[1], false);
      const s = inv && schoolRow(inv.school_id);
      if (!s) return fail(res, 404, 'Invitationen er udløbet eller allerede brugt'), true;
      return send(res, 200, { schoolName: s.name, email: inv.email, role: inv.role, hasAccount: !!db.prepare('SELECT 1 FROM teachers WHERE email = ?').get(String(inv.email).toLowerCase()) }), true;
    }
    return false;
  }

  /* ---------------- ruter der kræver login (også før alt er sat op) ---------------- */
  // Hvad må bruges, før kontoen er sat op? En ikke-bekræftet konto kan være oprettet af en anden med ejerens e-mail,
  // så den må intet sætte op (to-faktor, skole, invitation), før e-mailen er bekræftet.
  const OPEN_ALWAYS = new Set(['/api/me', '/api/logout', '/api/account', '/api/account/verify/resend']);
  function isOpenWhenNeeds(p, need) {
    // Venter på en kollegas godkendelse: kun "hvem er jeg" og log ud
    if (need === 'approval') return p === '/api/me' || p === '/api/logout';
    if (OPEN_ALWAYS.has(p)) return true;
    if (need === 'verify') return false;
    if (need === '2fa') return p.startsWith('/api/account/2fa/');
    if (need === 'school') return p === '/api/school/create' || p === '/api/invite/accept' || p.startsWith('/api/account/');
    return false;
  }

  async function authedRoutes(req, res, p, m, t, sess) {
    if (p === '/api/me' && m === 'GET') return send(res, 200, me(t, sess)), true;

    /* --- konto --- */
    if (p === '/api/account/verify/resend' && m === 'POST') {
      if (t.email_verified) return send(res, 200, { ok: true, already: true }), true;
      if (!resendRl.take('v:' + t.id)) return fail(res, 429, 'Vi har sendt flere mails for nylig – tjek din indbakke og spam-mappen'), true;
      await sendVerify(req, t);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/password' && m === 'POST') {
      const b = await readJson(req);
      if (!U.verifyPassword(String(b.current || ''), t.pass_hash)) return fail(res, 400, 'Den nuværende adgangskode er forkert'), true;
      const pwErr = checkPassword(String(b.password || ''), t);
      if (pwErr) return fail(res, 400, pwErr), true;
      db.prepare('UPDATE teachers SET pass_hash = ? WHERE id = ?').run(U.hashPassword(String(b.password)), t.id);
      sessionsOf(t.id, sess.hash);
      securityMail(req, t, 'Din adgangskode til HolyMoly er ændret', 'Adgangskoden til din HolyMoly-konto blev ændret');
      return send(res, 200, { ok: true }), true;
    }
    if ((p === '/api/account/teacher-code' || p === '/api/account/teacher-code/show') && m === 'POST') {
      if (!cfg.simple || cfg.signupCode) return fail(res, 404, 'Ikke fundet'), true;
      const rotate = p === '/api/account/teacher-code';
      if (rotate) log('Ny lærerkode lavet af lærer', t.id);
      return send(res, 200, showTeacherCode(rotate)), true;
    }
    /* --- enkel tilstand: nye lærere godkendes af en kollega --- */
    if (p === '/api/account/pending-teachers' && m === 'GET') {
      if (!cfg.simple) return fail(res, 404, 'Ikke fundet'), true;
      const rows = db.prepare('SELECT id, name, email, created FROM teachers WHERE approved IS NULL ORDER BY created').all();
      return send(res, 200, { teachers: rows.map(r => ({ id: r.id, name: r.name, username: r.email, created: r.created })) }), true;
    }
    let pm;
    if ((pm = p.match(/^\/api\/account\/teachers\/(\d+)(\/approve)?$/)) && ((pm[2] && m === 'POST') || (!pm[2] && m === 'DELETE'))) {
      if (!cfg.simple) return fail(res, 404, 'Ikke fundet'), true;
      const other = db.prepare('SELECT * FROM teachers WHERE id = ? AND approved IS NULL').get(Number(pm[1]));
      if (!other) return fail(res, 404, 'Læreren venter ikke på godkendelse'), true;
      if (pm[2]) {
        db.prepare('UPDATE teachers SET approved = ? WHERE id = ? AND approved IS NULL').run(Date.now(), other.id);
        log('Lærer godkendt', other.id, 'af lærer', t.id);
      } else {
        deleteTeacher(other);
        log('Ny lærer afvist og slettet', other.id, 'af lærer', t.id);
      }
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/name' && m === 'POST') {
      const b = await readJson(req);
      const name = cleanName(b.name);
      if (!name) return fail(res, 400, 'Skriv dit navn'), true;
      db.prepare('UPDATE teachers SET name = ? WHERE id = ?').run(name, t.id);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/2fa/start' && m === 'POST') {
      if (t.totp_secret) return fail(res, 400, 'To-faktor er allerede slået til'), true;
      sweep(pendingTotp);
      const secret = T.newSecret();
      pendingTotp.set(t.id, { secret, exp: Date.now() + 15 * 60_000 });
      const label = isUniOnly(t) ? t.name : t.email;
      const url = T.otpauthUrl(secret, label);
      let qr = '';
      try { qr = await require('qrcode').toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); } catch (e) { /* vis koden som tekst */ }
      return send(res, 200, { secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauth: url, qrSvg: qr }), true;
    }
    if (p === '/api/account/2fa/enable' && m === 'POST') {
      const b = await readJson(req);
      const pend = pendingTotp.get(t.id);
      if (!pend || pend.exp < Date.now()) return fail(res, 400, 'Det tog for lang tid – start forfra'), true;
      if (!mfaRl.take('t:' + t.id)) return fail(res, 429, 'For mange forsøg – vent et par minutter'), true;
      const step = T.verify(pend.secret, b.code, 0);
      if (step < 0) return fail(res, 400, 'Koden passer ikke. Tjek at uret på telefonen er rigtigt, og prøv den nyeste kode.'), true;
      pendingTotp.delete(t.id);
      mfaRl.refund('t:' + t.id);
      db.prepare('UPDATE teachers SET totp_secret = ?, totp_step = ? WHERE id = ?').run(box.seal(pend.secret), step, t.id);
      const codes = newBackupCodes(t.id);
      db.prepare('UPDATE sessions SET mfa = 1 WHERE token_hash = ?').run(sess.hash);
      sessionsOf(t.id, sess.hash); // andre steder logges ud
      securityMail(req, t, 'To-faktor er slået til på din HolyMoly-konto', 'To-faktor (godkendelses-app) blev slået til på din HolyMoly-konto');
      return send(res, 200, { ok: true, backupCodes: codes }), true;
    }
    if (p === '/api/account/2fa/backup' && m === 'POST') {
      const b = await readJson(req);
      if (!t.totp_secret) return fail(res, 400, 'Slå to-faktor til først'), true;
      if (!mfaRl.take('t:' + t.id)) return fail(res, 429, 'For mange forsøg – vent et par minutter'), true;
      if (checkSecondFactor(t, b.code) !== 'totp') return fail(res, 400, 'Forkert kode fra godkendelses-appen'), true;
      mfaRl.refund('t:' + t.id);
      const fresh = newBackupCodes(t.id);
      securityMail(req, t, 'Nye reservekoder til din HolyMoly-konto', 'Der blev lavet nye reservekoder til to-faktor på din HolyMoly-konto. De gamle virker ikke længere');
      return send(res, 200, { backupCodes: fresh }), true;
    }
    if (p === '/api/account/2fa/disable' && m === 'POST') {
      const b = await readJson(req);
      if (cfg.require2fa) return fail(res, 400, 'To-faktor er påkrævet på denne server og kan ikke slås fra. Skift telefon ved at slå den til igen fra din nye telefon efter nulstilling hos skolens administrator.'), true;
      if (!U.verifyPassword(String(b.password || ''), t.pass_hash)) return fail(res, 400, 'Forkert adgangskode'), true;
      if (!mfaRl.take('t:' + t.id)) return fail(res, 429, 'For mange forsøg – vent et par minutter'), true;
      if (!checkSecondFactor(t, b.code)) return fail(res, 400, 'Forkert kode'), true;
      db.prepare('UPDATE teachers SET totp_secret = NULL, totp_step = 0 WHERE id = ?').run(t.id);
      db.prepare('DELETE FROM backup_codes WHERE teacher_id = ?').run(t.id);
      securityMail(req, t, 'To-faktor er slået fra på din HolyMoly-konto', 'To-faktor (godkendelses-app) blev slået fra på din HolyMoly-konto');
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account' && m === 'DELETE') {
      const b = await readJson(req);
      if (!isUniOnly(t) && !U.verifyPassword(String(b.password || ''), t.pass_hash)) return fail(res, 400, 'Forkert adgangskode'), true;
      if (isUniOnly(t) && String(b.confirm || '').trim().toUpperCase() !== 'SLET') return fail(res, 400, 'Skriv SLET for at bekræfte'), true;
      if (t.school_id && t.role === 'admin' && admins(t.school_id) === 1 && db.prepare('SELECT COUNT(*) AS n FROM teachers WHERE school_id = ?').get(t.school_id).n > 1) {
        return fail(res, 400, 'Du er skolens eneste administrator. Gør en kollega til administrator først (Skole → Lærere).'), true;
      }
      secLog(t, 'account', `${t.name} slettede sin konto`, req);
      deleteTeacher(t);
      log('Lærer slettede sin konto', t.id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }), true;
    }

    /* --- skole --- */
    if (p === '/api/school/create' && m === 'POST') {
      const b = await readJson(req);
      if (t.school_id) return fail(res, 400, 'Du er allerede med i en skole'), true;
      const name = cleanName(b.name, 120);
      if (!name) return fail(res, 400, 'Skriv skolens navn'), true;
      if (cfg.licensing && !b.acceptTerms && !t.terms_accepted) return fail(res, 400, 'Du skal acceptere vilkårene og databehandleraftalen'), true;
      const sc = createSchool(name, trialKey(t));
      db.prepare("UPDATE teachers SET school_id = ?, role = 'admin', terms_accepted = COALESCE(terms_accepted, ?) WHERE id = ?").run(sc.id, Date.now(), t.id);
      notifySales((sc.trial ? 'Ny skole i prøveperiode: ' : 'Ny skole (prøveperiode allerede brugt): ') + name, [`${t.name} <${isUniOnly(t) ? 'Unilogin' : t.email}> har oprettet ${name}.`]);
      return send(res, 200, { ok: true, schoolId: sc.id, trial: sc.trial }), true;
    }
    if (p === '/api/invite/accept' && m === 'POST') {
      const b = await readJson(req);
      const inv = takeToken('invite', b.token, false);
      const s = inv && schoolRow(inv.school_id);
      if (!s) return fail(res, 400, 'Invitationen er udløbet eller allerede brugt'), true;
      if (t.school_id && t.school_id !== s.id) return fail(res, 400, 'Du er allerede med i en anden skole. Bed den skoles administrator om at fjerne dig først.'), true;
      if (isUniOnly(t) ? inv.role === 'admin' : String(inv.email).toLowerCase() !== String(t.email).toLowerCase()) {
        return fail(res, 403, `Invitationen er sendt til ${inv.email}. Log ind med den konto – eller bed om en invitation til din egen e-mail.`), true;
      }
      db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(inv.token_hash);
      db.prepare('UPDATE teachers SET school_id = ?, role = ? WHERE id = ?').run(s.id, inv.role === 'admin' ? 'admin' : t.role === 'admin' && t.school_id === s.id ? 'admin' : 'teacher', t.id);
      secLog(teacherRow(t.id), 'admin', `${t.name} sluttede sig til skolen via en invitation${inv.role === 'admin' ? ' (som administrator)' : ''}`, req);
      return send(res, 200, { ok: true, schoolName: s.name }), true;
    }
    if (p === '/api/school' && m === 'GET') {
      const s = schoolRow(t.school_id);
      if (!s) return fail(res, 404, 'Du er ikke med i en skole'), true;
      const out = { id: s.id, name: s.name, created: s.created, role: t.role, license: licenseOf(s.id), pricing: cfg.pricing, licensing: cfg.licensing,
        instNr: s.inst_nr || null, myInstitutions: uniInsts(t), uniLogin: !!cfg.uniLogin && !!cfg.uniLogin.enabled };
      if (t.role === 'admin') {
        out.teachers = db.prepare(`SELECT t.id, t.name, t.email, t.role, t.email_verified, t.totp_secret IS NOT NULL AS totp, t.uni_id IS NOT NULL AS uni,
            (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = t.id) AS classes,
            (SELECT COUNT(*) FROM students st JOIN classes c ON c.id = st.class_id WHERE c.teacher_id = t.id AND st.enrolled IS NOT NULL) AS students
          FROM teachers t WHERE t.school_id = ? ORDER BY t.name`).all(s.id)
          .map(r => ({ id: r.id, name: r.name, email: String(r.email).startsWith('unilogin:') ? null : r.email, role: r.role, verified: !!r.email_verified, totp: !!r.totp, uni: !!r.uni, classes: r.classes, students: r.students, me: r.id === t.id }));
        out.invites = db.prepare("SELECT token_hash, email, role, created, expires FROM tokens WHERE kind = 'invite' AND school_id = ? AND expires > ? ORDER BY created DESC").all(s.id, Date.now())
          .map(r => ({ id: r.token_hash.slice(0, 16), email: r.email, role: r.role, created: r.created, expires: r.expires }));
        out.orders = db.prepare('SELECT id, created, students, years, amount, status, details FROM license_orders WHERE school_id = ? ORDER BY created DESC').all(s.id)
          .map(o => Object.assign({ id: o.id, created: o.created, students: o.students, years: o.years, amount: o.amount, status: o.status }, JSON.parse(o.details)));
      }
      return send(res, 200, out), true;
    }
    // Herfra: kun skolens administrator
    const isAdmin = t.school_id && t.role === 'admin';
    let mm;
    if (p === '/api/school/security-log' && m === 'GET') {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      const rows = db.prepare('SELECT ts, kind, text, ip FROM security_log WHERE school_id = ? ORDER BY ts DESC, id DESC LIMIT 300').all(t.school_id);
      return send(res, 200, { entries: rows, keepDays: SECLOG_DAYS }), true;
    }
    if (p === '/api/school' && m === 'PATCH') {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      const b = await readJson(req);
      if ('name' in b) {
        const name = cleanName(b.name, 120);
        if (!name) return fail(res, 400, 'Skriv skolens navn'), true;
        db.prepare('UPDATE schools SET name = ? WHERE id = ?').run(name, t.school_id);
        secLog(t, 'admin', `${t.name} omdøbte skolen til "${name}"`, req);
      }
      if ('instNr' in b) {
        const nr = b.instNr == null || b.instNr === '' ? null : String(b.instNr).trim();
        if (nr !== null) {
          if (!instOk(nr)) return fail(res, 400, 'Ugyldigt institutionsnummer'), true;
          // Kun et nummer, administratorens eget Unilogin har vist, at vedkommende hører til (så ingen kan "tage" en anden skoles lærere)
          if (!uniInsts(t).some(i => i.nr === nr) && !isPlatformAdmin(t, sess)) return fail(res, 403, 'Log ind med Unilogin fra institutionen for at vælge dens institutionsnummer'), true;
          const other = db.prepare('SELECT id FROM schools WHERE inst_nr = ? AND id != ?').get(nr, t.school_id);
          if (other) return fail(res, 409, 'Institutionsnummeret er allerede knyttet til en anden skole i HolyMoly – kontakt os'), true;
        }
        db.prepare('UPDATE schools SET inst_nr = ? WHERE id = ?').run(nr, t.school_id);
        secLog(t, 'admin', nr ? `${t.name} knyttede institutionsnummer ${nr} til skolen (lærere fra institutionen kobles automatisk på)` : `${t.name} fjernede institutionsnummeret`, req);
      }
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/school/invites' && m === 'POST') {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      const b = await readJson(req);
      const emails = [...new Set((Array.isArray(b.emails) ? b.emails : [b.email]).map(e => U.str(e, 200).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
      if (!emails.length) return fail(res, 400, 'Skriv mindst én e-mail'), true;
      const bad = emails.filter(e => !emailOk(e));
      if (bad.length) return fail(res, 400, 'Ugyldig e-mail: ' + bad.join(', ')), true;
      const role = b.role === 'admin' ? 'admin' : 'teacher';
      const s = schoolRow(t.school_id);
      const sent = [], skipped = [];
      for (const email of emails) {
        const other = db.prepare('SELECT school_id FROM teachers WHERE email = ?').get(email);
        if (other && other.school_id === s.id) { skipped.push(email + ' (er allerede med)'); continue; }
        if (!inviteRl.take('s:' + s.id)) { skipped.push(email + ' (for mange invitationer i dag)'); continue; }
        db.prepare("DELETE FROM tokens WHERE kind = 'invite' AND school_id = ? AND email = ?").run(s.id, email);
        const tok = newToken('invite', { schoolId: s.id, email, role, teacherId: null }, 14 * DAY);
        await mailer.send({
          to: email, subject: `${t.name} inviterer dig til HolyMoly`, title: `Du er inviteret til ${s.name}`,
          lines: [`${t.name} har inviteret dig til at bruge HolyMoly på ${s.name}.`, 'Med HolyMoly kan du se, om eleverne har AI eller forbudte sider åbne i timen. Eleverne kan få et mærke, der viser, at teksten er tastet i HolyMoly uden indsat tekst.'],
          button: { label: other ? 'Tilslut din konto' : 'Opret din konto', url: `${baseUrl(req)}/opret?invitation=${tok}` },
          after: ['Invitationen virker i 14 dage.'],
        });
        sent.push(email);
      }
      if (sent.length) secLog(t, 'admin', `${t.name} inviterede ${sent.join(', ')} som ${role === 'admin' ? 'administrator' : 'lærer'}`, req);
      return send(res, 200, { sent, skipped }), true;
    }
    if ((mm = p.match(/^\/api\/school\/invites\/([a-f0-9]{16})$/)) && m === 'DELETE') {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      db.prepare("DELETE FROM tokens WHERE kind = 'invite' AND school_id = ? AND substr(token_hash, 1, 16) = ?").run(t.school_id, mm[1]);
      return send(res, 200, { ok: true }), true;
    }
    if ((mm = p.match(/^\/api\/school\/teachers\/(\d+)(\/reset-2fa)?$/))) {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      const other = db.prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?').get(Number(mm[1]), t.school_id);
      if (!other) return fail(res, 404, 'Læreren findes ikke på skolen'), true;
      if (mm[2] && m === 'POST') {
        if (other.id === t.id) return fail(res, 400, 'Du kan ikke nulstille din egen to-faktor her – brug dine reservekoder'), true;
        db.prepare('UPDATE teachers SET totp_secret = NULL, totp_step = 0 WHERE id = ?').run(other.id);
        db.prepare('DELETE FROM backup_codes WHERE teacher_id = ?').run(other.id);
        sessionsOf(other.id);
        secLog(t, 'admin', `${t.name} nulstillede to-faktor for ${other.name}`, req);
        if (!isUniOnly(other)) mailer.send({ to: other.email, subject: 'Din to-faktor på HolyMoly er nulstillet', title: 'To-faktor nulstillet', lines: [`${t.name} har nulstillet to-faktor på din konto. Næste gang du logger ind, sætter du den op igen med din telefon.`, 'Var det ikke aftalt med dig, så kontakt din skoles administrator med det samme.'] });
        return send(res, 200, { ok: true }), true;
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        const role = b.role === 'admin' ? 'admin' : 'teacher';
        if (other.role === 'admin' && role !== 'admin' && admins(t.school_id) <= 1) return fail(res, 400, 'Skolen skal have mindst én administrator'), true;
        db.prepare('UPDATE teachers SET role = ? WHERE id = ?').run(role, other.id);
        if (role !== other.role) secLog(t, 'admin', `${t.name} gjorde ${other.name} til ${role === 'admin' ? 'administrator' : 'lærer'}`, req);
        return send(res, 200, { ok: true }), true;
      }
      if (m === 'DELETE') {
        if (other.role === 'admin' && admins(t.school_id) <= 1) return fail(res, 400, 'Skolen skal have mindst én administrator'), true;
        db.prepare("UPDATE teachers SET school_id = NULL, role = 'teacher' WHERE id = ?").run(other.id);
        secLog(t, 'admin', `${t.name} fjernede ${other.name} fra skolen`, req);
        return send(res, 200, { ok: true }), true;
      }
    }
    if (p === '/api/school/order' && m === 'POST') {
      if (!isAdmin) return fail(res, 403, 'Kun skolens administrator'), true;
      if (!orderRl.take('o:' + t.school_id)) return fail(res, 429, 'Du har allerede bestilt flere gange i dag – kontakt os, hvis noget skal rettes'), true;
      const b = await readJson(req);
      const students = Math.round(Number(b.students));
      const years = Math.round(Number(b.years || 1));
      if (!(students >= 1 && students <= 20000)) return fail(res, 400, 'Skriv antal elever (1–20.000)'), true;
      if (![1, 2, 3].includes(years)) return fail(res, 400, 'Vælg 1, 2 eller 3 år'), true;
      const cvr = String(b.cvr || '').replace(/\D/g, '');
      const ean = String(b.ean || '').replace(/\D/g, '');
      const invoiceEmail = U.str(b.invoiceEmail, 200).trim().toLowerCase();
      if (cvr.length !== 8) return fail(res, 400, 'CVR-nummeret skal have 8 cifre'), true;
      if (ean && ean.length !== 13) return fail(res, 400, 'EAN-nummeret skal have 13 cifre'), true;
      if (!ean && !emailOk(invoiceEmail)) return fail(res, 400, 'Skriv EAN-nummer (offentlige skoler) eller en e-mail til fakturaen'), true;
      if (!b.acceptTerms) return fail(res, 400, 'Du skal acceptere vilkårene og databehandleraftalen'), true;
      const s = schoolRow(t.school_id);
      const details = {
        institution: cleanName(b.institution, 160) || s.name, cvr, ean, invoiceEmail: emailOk(invoiceEmail) ? invoiceEmail : '',
        reference: cleanName(b.reference, 120), contactName: cleanName(b.contactName, 100) || t.name, phone: cleanName(b.phone, 30),
        orderedBy: isUniOnly(t) ? t.name : `${t.name} <${t.email}>`,
      };
      const amount = price(students, years);
      const r = db.prepare('INSERT INTO license_orders (school_id, teacher_id, school_name, created, students, years, amount, details) VALUES (?,?,?,?,?,?,?,?)')
        .run(s.id, t.id, s.name, Date.now(), students, years, amount, JSON.stringify(details));
      const id = Number(r.lastInsertRowid);
      const kr = (n) => n.toLocaleString('da-DK') + ' kr.';
      const summary = [`Skole: ${details.institution} (CVR ${cvr}${ean ? ', EAN ' + ean : ''})`, `Licens: ${students} elever i ${years} år`, `Pris: ${kr(amount)} ekskl. moms`,
        `Faktura til: ${ean ? 'EAN ' + ean : details.invoiceEmail}${details.reference ? ' – reference: ' + details.reference : ''}`, `Kontakt: ${details.contactName}${details.phone ? ', ' + details.phone : ''}`];
      notifySales(`Licensbestilling #${id}: ${details.institution}`, [...summary, `Bestilt af ${details.orderedBy}.`, 'Aktivér licensen på /admin, når fakturaen er sendt.']);
      if (!isUniOnly(t)) mailer.send({ to: t.email, subject: `Tak for din bestilling (#${id})`, title: 'Tak for din bestilling', lines: ['Vi har modtaget bestillingen af en HolyMoly-licens:', ...summary, 'Licensen aktiveres, så snart fakturaen er sendt – I kan bruge HolyMoly uden afbrydelse imens.'] });
      log('Licensbestilling', id, 'skole', s.id);
      return send(res, 200, { ok: true, id, amount }), true;
    }

    /* --- HolyMoly's egen administration --- */
    if (p.startsWith('/api/admin/')) {
      if (!isPlatformAdmin(t, sess)) return fail(res, 403, 'Kun for HolyMoly-administratorer'), true;
      if (p === '/api/admin/overview' && m === 'GET') {
        const schools = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id) AS teachers,
            (SELECT GROUP_CONCAT(CASE WHEN t.email LIKE 'unilogin:%' THEN t.name ELSE t.email END, ', ') FROM teachers t WHERE t.school_id = s.id AND t.role = 'admin') AS admins
          FROM schools s ORDER BY s.created DESC`).all()
          .map(s => ({ id: s.id, name: s.name, created: s.created, teachers: s.teachers, admins: s.admins || '', note: s.note || '', instNr: s.inst_nr || null, license: licenseOf(s.id) }));
        const orders = db.prepare("SELECT o.*, COALESCE(s.name, o.school_name || ' (slettet)') AS school FROM license_orders o LEFT JOIN schools s ON s.id = o.school_id ORDER BY o.created DESC LIMIT 300").all()
          .map(o => Object.assign({ id: o.id, schoolId: o.school_id, school: o.school, created: o.created, students: o.students, years: o.years, amount: o.amount, status: o.status }, JSON.parse(o.details)));
        const n = (sql) => db.prepare(sql).get().n;
        const stats = {
          schools: schools.length, trial: schools.filter(s => s.license.state === 'trial').length, active: schools.filter(s => s.license.state === 'active').length,
          teachers: n('SELECT COUNT(*) AS n FROM teachers'), students: n('SELECT COUNT(*) AS n FROM students WHERE enrolled IS NOT NULL'),
          revenue: orders.filter(o => o.status === 'betalt').reduce((a, o) => a + o.amount, 0),
        };
        return send(res, 200, { stats, schools, orders }), true;
      }
      if ((mm = p.match(/^\/api\/admin\/schools\/(\d+)$/)) && m === 'PATCH') {
        const s = schoolRow(Number(mm[1]));
        if (!s) return fail(res, 404, 'Skolen findes ikke'), true;
        const b = await readJson(req);
        const date = (v) => { if (v === null || v === '') return null; const d = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(d) ? d : undefined; };
        if ('licenseUntil' in b) { const d = date(b.licenseUntil); if (d === undefined) return fail(res, 400, 'Ugyldig dato'), true; db.prepare('UPDATE schools SET license_until = ? WHERE id = ?').run(d, s.id); }
        if ('trialEnds' in b) { const d = date(b.trialEnds); if (!d) return fail(res, 400, 'Ugyldig dato'), true; db.prepare('UPDATE schools SET trial_ends = ? WHERE id = ?').run(d, s.id); }
        if ('seats' in b) db.prepare('UPDATE schools SET seats = ? WHERE id = ?').run(U.clampNum(b.seats, 0, 100000, 0), s.id);
        if ('note' in b) db.prepare('UPDATE schools SET note = ? WHERE id = ?').run(U.str(b.note, 1000), s.id);
        if ('instNr' in b) {
          const nr = b.instNr == null || b.instNr === '' ? null : String(b.instNr).trim();
          if (nr !== null && !instOk(nr)) return fail(res, 400, 'Ugyldigt institutionsnummer'), true;
          if (nr !== null && db.prepare('SELECT 1 FROM schools WHERE inst_nr = ? AND id != ?').get(nr, s.id)) return fail(res, 409, 'Institutionsnummeret bruges af en anden skole'), true;
          db.prepare('UPDATE schools SET inst_nr = ? WHERE id = ?').run(nr, s.id);
        }
        log('Admin ændrede skole', s.id, 'af', t.id);
        return send(res, 200, { ok: true, license: licenseOf(s.id) }), true;
      }
      if ((mm = p.match(/^\/api\/admin\/orders\/(\d+)$/)) && m === 'PATCH') {
        const o = db.prepare('SELECT * FROM license_orders WHERE id = ?').get(Number(mm[1]));
        if (!o) return fail(res, 404, 'Bestillingen findes ikke'), true;
        const b = await readJson(req);
        if (b.status && !ORDER_STATUSES.includes(b.status)) return fail(res, 400, 'Ukendt status'), true;
        if (b.status) db.prepare('UPDATE license_orders SET status = ? WHERE id = ?').run(b.status, o.id);
        if (b.activate) {
          // Licensen løber fra i dag – eller forlænges fra den nuværende udløbsdato
          const s = schoolRow(o.school_id);
          if (!s) return fail(res, 400, 'Skolen er slettet – licensen kan ikke aktiveres'), true;
          const from = Math.max(Date.now(), s.license_until || 0);
          const until = new Date(from); until.setFullYear(until.getFullYear() + o.years);
          db.prepare('UPDATE schools SET license_until = ?, seats = ? WHERE id = ?').run(until.getTime(), o.students, s.id);
          const adminsOf = db.prepare("SELECT email FROM teachers WHERE school_id = ? AND role = 'admin' AND email NOT LIKE 'unilogin:%'").all(s.id);
          for (const a of adminsOf) mailer.send({ to: a.email, subject: 'Jeres HolyMoly-licens er aktiveret', title: 'Licensen er aktiveret', lines: [`${s.name} har nu en HolyMoly-licens til ${o.students} elever.`, `Licensen gælder til og med ${until.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' })}.`, 'Tak fordi I bruger HolyMoly!'] });
          log('Licens aktiveret for skole', s.id, 'fra bestilling', o.id);
        }
        return send(res, 200, { ok: true }), true;
      }
      return fail(res, 404, 'Ikke fundet'), true;
    }
    return false;
  }

  /**
   * Sletning efter ophør (databehandleraftalen, GDPR art. 28, stk. 3, litra g): når både prøveperiode og licens
   * har været udløbet i cfg.purgeAfterDays dage, slettes skolens lærere, klasser, elever, logs og tekster.
   * Skolens administratorer får besked 30 og 7 dage før. Fornyes licensen, starter fristen forfra.
   * Bestillinger (fakturagrundlag) bevares – bogføringsloven – men mister koblingen til skolen.
   */
  function purgeExpired(now = Date.now()) {
    if (!cfg.licensing || !cfg.purgeAfterDays) return { warned: 0, purged: 0 };
    let warned = 0, purged = 0;
    const fmt = (ms) => new Date(ms).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'long', year: 'numeric' });
    for (const s of db.prepare('SELECT * FROM schools').all()) {
      const ended = Math.max(s.license_until || 0, s.trial_ends || 0);
      if (ended > now) continue;
      const purgeAt = ended + cfg.purgeAfterDays * DAY;
      // Varsler: "<udløb>:<30|7>:<sendt>". Det sidste varsel skal være sendt mindst 7 dage før sletningen –
      // også for skoler, der var udløbet længe, før denne regel kom (de får varslet nu og slettes om 7 dage).
      const [nEnded, nStage, nSent] = String(s.purge_notice || '').split(':').map(Number);
      const lastSent = nEnded === ended && nStage === 7 ? nSent : 0;
      if (now >= purgeAt && lastSent && now - lastSent >= 7 * DAY) {
        for (const t of db.prepare('SELECT * FROM teachers WHERE school_id = ?').all(s.id)) deleteTeacher(t);
        db.prepare('DELETE FROM schools WHERE id = ?').run(s.id);
        log('Skole slettet efter ophør', s.id, `(udløb ${new Date(ended).toISOString().slice(0, 10)})`);
        purged++;
        continue;
      }
      const stage = now >= purgeAt - 7 * DAY ? 7 : now >= purgeAt - 30 * DAY ? 30 : 0;
      if (!stage || (nEnded === ended && nStage === stage)) continue;
      const deleteAt = stage === 7 ? Math.max(purgeAt, now + 7 * DAY) : purgeAt;
      const daysLeft = Math.ceil((deleteAt - now) / DAY);
      db.prepare('UPDATE schools SET purge_notice = ? WHERE id = ?').run(`${ended}:${stage}:${now}`, s.id);
      for (const a of db.prepare("SELECT * FROM teachers WHERE school_id = ? AND role = 'admin'").all(s.id)) {
        if (isUniOnly(a)) continue;
        mailer.send({
          to: a.email, subject: `${s.name}s HolyMoly-data slettes om ${daysLeft} dage`, title: 'Jeres data bliver slettet',
          lines: [`Prøveperioden eller licensen for ${s.name} udløb ${fmt(ended)}.`,
            `Efter databehandleraftalen sletter vi derfor skolens data ${fmt(deleteAt)}: lærerkonti, klasser, elever, logs og elevernes tekster i HolyMoly.`,
            'Vil I fortsætte, så bestil en licens under Skole → Licens – så slettes intet. Vil I gemme noget, så eksportér det inden.'],
        });
      }
      warned++;
    }
    return { warned, purged };
  }

  /** Sikkerhedsloggen gemmes i SECLOG_DAYS dage (den indeholder IP-adresser). */
  function pruneSecLog(now = Date.now()) {
    db.prepare('DELETE FROM security_log WHERE ts < ?').run(now - SECLOG_DAYS * DAY);
  }

  return { signupCodeNow, setupCode, publicRoutes, authedRoutes, needs, isOpenWhenNeeds, canTeach, licenseOf, me, uniLoggedIn, purgeExpired, secLog, pruneSecLog };
}

module.exports = { createAccounts };
