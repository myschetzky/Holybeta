'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const ACRules = require('../../shared/rules.js');
const dbm = require('./db');
const { Hub } = require('./hub');
const U = require('./util');
const G = require('./guardapi');
const { UniLogin, configFromEnv } = require('./oidc');
const { DocStore } = require('./docs');
const RET = require('./retention');
const { createMailer } = require('./mail');
const { createAccounts } = require('./accounts');
const { createProxyTrust } = require('./proxytrust');

/** Skolens ja fra opts.schoolApproval eller miljøet (DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO, LEDELSE_JA_DATO). */
const APPROVAL_FIELDS = [['controller', 'DATAANSVARLIG'], ['dpo', 'DPO_KONTAKT'], ['dpiaDate', 'DPIA_DATO'], ['approvedDate', 'LEDELSE_JA_DATO']];
function schoolApprovalFrom(o) {
  const out = {};
  for (const [k, env] of APPROVAL_FIELDS) out[k] = String((o && o[k] != null ? o[k] : process.env[env]) ?? '').trim().slice(0, 200);
  return out;
}
const PIN_MAX_FAILS = 10; // forkerte elevkoder i alt, før koden låses til læreren nulstiller den

/**
 * De mest almindelige koder (som en klassekammerat ville prøve først): ens cifre (1111), rækker op eller ned (1234, 9876,
 * 7890), gentagne par (1212, 1122, 123123) og årstal 1950-2030.
 */
function weakPin(pin) {
  const p = String(pin);
  if (!/^\d{4,6}$/.test(p)) return false;
  const d = [...p].map(Number);
  if (/^(\d)\1+$/.test(p)) return true;
  const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  if (steps.every(x => x === 1) || steps.every(x => x === 9)) return true;
  if (/^(\d\d)\1+$/.test(p) || /^(\d\d\d)\1$/.test(p)) return true;
  if (/^(\d)\1(\d)\2((\d)\4)?$/.test(p)) return true;
  if (p.length === 4 && Number(p) >= 1950 && Number(p) <= 2030) return true;
  return false;
}
const APPROVAL_MISSING = 'Beta: skolens ja mangler. Udfyld DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO og LEDELSE_JA_DATO på serveren (se docs/ENKEL.md).';
// Beta: en server, der behandler elevdata, skal drives af skolen – eller have en databehandleraftale med en voksen/juridisk person
const OPERATOR_MISSING = 'Serveren drives ikke af skolen, og der er ingen databehandleraftale. Bed skolens IT om at overtage driften.';
/*
 * Ruter, der ikke findes i enkel tilstand (beta): bestilling, platform-administration, to-faktor (undtagen TOTP),
 * e-mail-bekræftelse, glemt adgangskode, Unilogin og priser. Svarer 404, som om de aldrig fandtes.
 */
const SIMPLE_OFF = /^\/api\/(school\/order|admin\/|account\/2fa\/(?!totp)|verify|password\/(forgot|reset)|auth\/unilogin\/|pricing)/;
/*
 * Funktioner, der kan slås fra. Beta (enkel tilstand) er én profil: ingen live-skærm, ingen skærmbilleder (heller ikke
 * automatiske) og intet lighedstjek. Hånd op og skrivetime er med. BETA_FEATURES="liveScreen,screenshot" slår ting til,
 * "-hand" slår fra. Uden enkel tilstand er alt slået til.
 */
const FEATURE_KEYS = ['liveScreen', 'screenshot', 'autoEvidence', 'similar', 'hand', 'writeLesson'];
function featuresFor(simple, betaFeatures) {
  const f = Object.fromEntries(FEATURE_KEYS.map(k => [k, !simple]));
  if (simple) { f.hand = true; f.writeLesson = true; }
  if (simple) {
    for (const tok of String(betaFeatures || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)) {
      const key = FEATURE_KEYS.find(k => k.toLowerCase() === tok.replace(/^[-+]/, '').toLowerCase());
      if (key) f[key] = !tok.startsWith('-');
    }
  }
  return f;
}

function createServer(opts = {}) {
  const cfg = {
    port: Number(opts.port ?? process.env.PORT ?? 8080),
    host: opts.host ?? process.env.HOST ?? '0.0.0.0',
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
    signupCode: opts.signupCode ?? process.env.TEACHER_SIGNUP_CODE ?? '',
    // Liste af proxyer (værter, IP-adresser eller net), hvis X-Forwarded-* må bruges. '1' = alle (se proxytrust.js)
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY ?? '',
    // Alle frister står i retention.js (kladder, versioner, dokumenter, beviser, log og backup)
    retention: RET.fromEnv(opts),
    // Lærerens login holder højst så længe, uanset aktivitet (NIST SP 800-63B-4, AAL2: genlogin mindst hver 24. time).
    // 12 timer = det samme som cookien altid har holdt; nu håndhæver serveren det også (en stjålet cookie kan ikke holdes i live).
    sessionMaxHours: Math.min(24, Math.max(1, Number(opts.sessionMaxHours ?? process.env.SESSION_MAX_HOURS ?? 12) || 12)),
    downloadUrl: opts.downloadUrl ?? process.env.AGENT_DOWNLOAD_URL ?? '',
    minAgentVersion: opts.minAgentVersion ?? process.env.MIN_AGENT_VERSION ?? '',
    // Windows/Mac-elever skal have en tilknyttet HolyMoly-vagt (SYSTEM/root) for at kunne være grønne
    requireGuard: (opts.requireGuard ?? process.env.REQUIRE_GUARD ?? '1') !== '0' && opts.requireGuard !== false,
    minExtensionVersion: opts.minExtensionVersion ?? process.env.MIN_EXTENSION_VERSION ?? '',
    extensionUrls: {
      chrome: process.env.EXTENSION_URL_CHROME || '',
      edge: process.env.EXTENSION_URL_EDGE || '',
      firefox: process.env.EXTENSION_URL_FIREFOX || '',
    },
    maxLessonMinutes: 300,
    // Serverens offentlige adresse (står på skrive-beviser), fx https://holymoly.minskole.dk
    publicUrl: String(opts.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    // UNI-Login (OpenID Connect via STIL). Kræver godkendelse hos STIL – se server/src/oidc.js
    uniLogin: opts.uniLogin ?? configFromEnv(),
    // Når UNI-Login er slået til, skal elever bruge det (så ingen kan skrive et falsk navn). UNILOGIN_OPTIONAL=1 slår kravet fra.
    uniLoginOptional: (opts.uniLoginOptional ?? process.env.UNILOGIN_OPTIONAL) === '1' || opts.uniLoginOptional === true,
    quiet: !!opts.quiet,
    // Enkel tilstand (SIMPLE=1, npm run enkel): lærere logger ind med brugernavn (ingen e-mail), eleverne med
    // klassekode + navn + egen kode på 4-6 cifre. Ingen licens, e-mail-bekræftelse eller to-faktor.
    simple: (opts.simple ?? process.env.SIMPLE) === '1' || opts.simple === true,
    /* ---- kontoer og licenser (hostet HolyMoly) ---- */
    smtpUrl: opts.smtpUrl ?? process.env.SMTP_URL ?? '',
    mailFrom: opts.mailFrom ?? process.env.MAIL_FROM ?? '',
    // Alle kan oprette en lærerkonto (SIGNUP=closed: kun med invitation). Er TEACHER_SIGNUP_CODE sat, kræves koden.
    signupOpen: (opts.signupOpen ?? process.env.SIGNUP ?? 'open') !== 'closed' && opts.signupOpen !== false,
    // Skoler, prøveperiode og licens. Slået fra på en skoles egen server (alt virker uden licens).
    licensing: opts.licensing ?? process.env.LICENSING === '1',
    trialDays: Number(opts.trialDays ?? process.env.TRIAL_DAYS ?? 30),
    // Licens-servere: skolens data slettes så mange dage efter, at prøveperiode og licens er udløbet (0 = aldrig).
    // Svarer til databehandleraftalens "senest 90 dage efter ophør".
    purgeAfterDays: Math.max(0, Number(opts.purgeAfterDays ?? process.env.PURGE_AFTER_DAYS ?? 90) || 0),
    pricing: {
      perStudent: Number(opts.pricePerStudent ?? process.env.PRICE_PER_STUDENT ?? 129), // kr. pr. elev pr. år ekskl. moms
      minimum: Number(opts.priceMinimum ?? process.env.PRICE_MINIMUM ?? 2500),           // kr. pr. år ekskl. moms
      currency: 'DKK',
    },
    platformAdmins: String(opts.platformAdmins ?? process.env.PLATFORM_ADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    salesEmail: opts.salesEmail ?? process.env.SALES_EMAIL ?? '',
    company: {
      name: process.env.COMPANY_NAME || 'HolyMoly', cvr: process.env.COMPANY_CVR || '', email: process.env.COMPANY_EMAIL || process.env.SALES_EMAIL || '',
      address: process.env.COMPANY_ADDRESS || '', hosting: process.env.HOSTING_PROVIDER || '',
    },
    // Hvor sikkerhedsfejl meldes (/.well-known/security.txt, RFC 9116). Tom = firmaets e-mail.
    securityContact: opts.securityContact ?? process.env.SECURITY_CONTACT ?? '',
    // Skolens ja (enkel tilstand/beta): dataansvarlig, DPO, DPIA og ledelsens ja. Uden dem startes ingen lektioner.
    schoolApproval: schoolApprovalFrom(opts.schoolApproval),
    // Dato for databehandleraftalen med den, der driver serveren (en voksen eller juridisk person). Tom = ingen aftale.
    dbaDate: String(opts.dbaDate ?? process.env.DBA_DATO ?? '').trim().slice(0, 40),
    // Hvem driver serveren – en rolle, ikke et navn (står på den offentlige forside), fx "en lærer på skolen"
    operator: String(opts.operator ?? process.env.DRIFTSANSVARLIG ?? '').trim().slice(0, 120),
    betaFeatures: opts.betaFeatures ?? process.env.BETA_FEATURES ?? '',
  };
  cfg.retentionDays = cfg.retention.logDays;
  // Daglig kopi af databasen i <data>/backup (VACUUM INTO – en hel, konsistent fil). Antal dage der gemmes; 0 = slået fra.
  cfg.backupDays = cfg.retention.backupDays;
  // E-mail-bekræftelse er slået til, når serveren kan sende mails (eller VERIFY_EMAIL=1)
  cfg.verifyEmail = opts.verifyEmail ?? (process.env.VERIFY_EMAIL ? process.env.VERIFY_EMAIL === '1' : !!(cfg.smtpUrl || opts.mailSend));
  // To-faktor (godkendelses-app) kræves for e-mail-login. Unilogin har sin egen sikkerhed.
  cfg.require2fa = opts.require2fa ?? process.env.REQUIRE_2FA === '1';
  // Enkel tilstand: intet af det, der kræver e-mail eller licens
  if (cfg.simple) { cfg.licensing = false; cfg.verifyEmail = false; cfg.require2fa = false; }
  /** Navnene på de felter i skolens ja, der mangler (tom liste = alt er udfyldt). */
  const approvalMissingFields = () => APPROVAL_FIELDS.filter(([k]) => !cfg.schoolApproval[k]).map(([, env]) => env);
  /** Er driften overdraget til skolen? SCHOOL_OPERATED=1 og overdragelsen er registreret (npm run enkel -- overdrag). */
  const handedOver = () => schoolOperated && !!(db.prepare("SELECT value FROM meta WHERE key = 'school_operated_since'").get() || {}).value;
  /** 'approval' (skolens ja mangler), 'operator' (hverken overdragelse eller databehandleraftale) eller null. */
  const lessonBlockedReason = () => {
    if (!cfg.simple) return null;
    if (approvalMissingFields().length) return 'approval';
    if (!cfg.dbaDate && !handedOver()) return 'operator';
    return null;
  };
  /** Enkel tilstand: ingen lektioner eller skriveøkter, før skolens ja og driften er på plads. Returnerer beskeden eller null. */
  const lessonBlocked = () => ({ approval: APPROVAL_MISSING, operator: OPERATOR_MISSING })[lessonBlockedReason()] || null;
  const approvalInfo = () => (approvalMissingFields().length ? null : Object.assign({}, cfg.schoolApproval));
  const log = (...a) => { if (!cfg.quiet) console.log(new Date().toISOString(), ...a); };
  const db = dbm.open(cfg.dataDir);
  const mailer = createMailer({ smtpUrl: cfg.smtpUrl, from: cfg.mailFrom, dataDir: cfg.dataDir, log, send: opts.mailSend });
  const publicDir = path.join(__dirname, '..', 'public');
  const sharedDir = path.join(__dirname, '..', '..', 'shared');

  /* ---------------------------- regler ---------------------------- */
  const overridePath = path.join(cfg.dataDir, 'rules-override.json');
  let rules = null;
  let overrideMtime = 0;
  function loadRules() {
    const base = JSON.parse(JSON.stringify(ACRules.RULE_DATA));
    try {
      const st = fs.statSync(overridePath);
      overrideMtime = st.mtimeMs;
      const o = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      // Override-filen tilføjer til listerne (eller erstatter hvis "replace": true).
      for (const key of ['domains', 'apps', 'titles', 'siteNames', 'domSignatures', 'browsers']) {
        if (!o[key]) continue;
        for (const cat of Object.keys(o[key])) {
          const add = Array.isArray(o[key][cat]) ? o[key][cat].map(String) : [];
          base[key][cat] = o.replace ? add : [...new Set([...(base[key][cat] || []), ...add])];
        }
      }
      for (const key of ['pathRules', 'genericHosts', 'suspiciousWords', 'appAllow']) {
        if (Array.isArray(o[key])) base[key] = o.replace ? o[key] : base[key].concat(o[key]);
      }
      base.version = Number(o.version) || base.version;
      log('Indlæste regel-override', overridePath);
    } catch (e) {
      if (e.code !== 'ENOENT') log('Kunne ikke læse rules-override.json:', e.message);
    }
    rules = base;
  }
  loadRules();

  const DEFAULT_CONFIG = () => ({
    categories: Object.fromEntries(Object.entries(ACRules.CATEGORIES).map(([k, v]) => [k, v.block])),
    extraBlocked: [], allowed: [], allowedApps: [], extraBlockedApps: [], killApps: true, lessonMinutes: 90,
    examMode: false, examAllowed: [], examAllowedApps: [],
    // Automatisk skærmbillede ved forbudt brug: slået fra som standard (dataminimering). Eleven får besked, når det sker.
    autoEvidence: false,
    links: [], // "Lektionens links": [{ title, url }] – vises for eleverne i appen under lektionen
  });
  function classConfig(classId) {
    const row = db.prepare('SELECT config FROM classes WHERE id = ?').get(classId);
    const c = DEFAULT_CONFIG();
    if (!row) return c;
    try {
      const saved = JSON.parse(row.config || '{}');
      if (saved.categories) Object.assign(c.categories, saved.categories);
      for (const k of ['extraBlocked', 'allowed', 'allowedApps', 'extraBlockedApps', 'examAllowed', 'examAllowedApps']) if (Array.isArray(saved[k])) c[k] = saved[k];
      if (typeof saved.killApps === 'boolean') c.killApps = saved.killApps;
      if (typeof saved.autoEvidence === 'boolean') c.autoEvidence = saved.autoEvidence;
      if (typeof saved.examMode === 'boolean') c.examMode = saved.examMode;
      if (saved.lessonMinutes) c.lessonMinutes = saved.lessonMinutes;
      if (Array.isArray(saved.links)) c.links = saved.links;
    } catch (e) { /* standard */ }
    return c;
  }

  // Enkel tilstand uden at skolen driver serveren (SCHOOL_OPERATED=1): beviser mærkes "Testserver"
  const schoolOperated = opts.schoolOperated === true || String(opts.schoolOperated ?? process.env.SCHOOL_OPERATED ?? '') === '1';
  // Funktioner, der kan slås fra (se featuresFor). Håndhæves i serveren, ikke kun i dashboardet.
  const features = featuresFor(cfg.simple, cfg.betaFeatures);
  const docs = new DocStore(db, cfg.dataDir, { testServer: cfg.simple && !schoolOperated, minWords: opts.minProofWords });
  const hub = new Hub({ db, dataDir: cfg.dataDir, docs, publicUrl: cfg.publicUrl, getRules: () => rules, classConfig, log, staleMs: opts.staleMs,
    minAgentVersion: cfg.minAgentVersion, minExtensionVersion: cfg.minExtensionVersion, downloadUrl: cfg.downloadUrl,
    requireGuard: cfg.requireGuard, compileFor: (classId, config) => ACRules.compile(rules, config || classConfig(classId)), lessonBlocked: () => lessonBlocked(), features });

  /* ---------------------------- auth ---------------------------- */
  const SESSION_MS = 12 * 3600_000; // uden aktivitet
  const SESSION_MAX_MS = cfg.sessionMaxHours * 3600_000; // absolut, også med aktivitet
  const uni = new UniLogin(cfg.uniLogin, { fetch: opts.oidcFetch });
  const uniTickets = new Map(); // billet til /api/enroll -> { uniId, name, exp }
  const sweep = (m) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };
  const loginRl = new U.RateLimiter(10, 10 / 300); // 10 forsøg, derefter 1 pr. 30 s
  const loginEmailRl = new U.RateLimiter(50, 1 / 10); // pr. konto – højt nok til at andre ikke kan låse en lærer ude
  // Elever på samme skole deler ofte én offentlig IP (NAT) – derfor rummelige grænser pr. IP.
  // Koderne har 31^8 muligheder og udløber efter 14 dage, så gætning er stadig håbløs.
  const enrollRl = new U.RateLimiter(120, 2);
  // Elevkoder: 5 forsøg pr. elev, derefter ét nyt forsøg hvert 3. minut (10.000 muligheder kan ikke gættes).
  // Desuden låses koden efter PIN_MAX_FAILS forkerte forsøg i alt (gemt i databasen), til læreren nulstiller den.
  const pinRl = new U.RateLimiter(5, 1 / 180);
  const uniRl = new U.RateLimiter(120, 2); // UNI-Login: en hel klasse bag én skole-IP
  const apiRl = new U.RateLimiter(300, 20);

  // X-Forwarded-* bruges kun fra en proxy i TRUST_PROXY (ellers kan enhver forfalske sin IP-adresse)
  const proxyTrust = createProxyTrust(cfg.trustProxy, { log });
  if (proxyTrust.all) log('ADVARSEL: TRUST_PROXY=1 stoler på alle. Skriv proxyens navn eller adresse i stedet, fx TRUST_PROXY=caddy.');
  const fromProxy = (req) => proxyTrust.trusts(req.socket.remoteAddress);
  function clientIp(req) {
    // Den yderste værdi er den proxyen selv har tilføjet – de forreste kan klienten forfalske
    if (req.headers['x-forwarded-for'] && fromProxy(req)) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
    return req.socket.remoteAddress || '';
  }
  function isHttps(req) {
    return req.socket.encrypted || (req.headers['x-forwarded-proto'] === 'https' && fromProxy(req));
  }
  function teacherFromReq(req) {
    const tok = U.parseCookies(req.headers.cookie).hm_session;
    if (!tok) return null;
    const hash = U.sha256(tok);
    const sess = db.prepare('SELECT teacher_id, expires, mfa, created FROM sessions WHERE token_hash = ?').get(hash);
    const now = Date.now();
    if (!sess || sess.expires < now) return null;
    // Sessioner fra før "created" fandtes: regnes fra deres seneste forlængelse
    const born = sess.created ?? (sess.expires - SESSION_MS);
    if (now - born >= SESSION_MAX_MS) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    const row = db.prepare('SELECT * FROM teachers WHERE id = ?').get(sess.teacher_id);
    if (!row) return null;
    // Forlæng ved aktivitet – men aldrig ud over den absolutte grænse
    const until = Math.min(now + SESSION_MS, born + SESSION_MAX_MS);
    if (sess.expires - now < SESSION_MS / 2 && until > sess.expires) {
      db.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?').run(until, hash);
    }
    return Object.assign(row, { sess: { hash, mfa: !!sess.mfa } });
  }
  /** Gælder lærerens session stadig (findes, ikke udløbet, under den absolutte grænse)? Bruges af hub.heartbeat. */
  function teacherSessionOk(hash) {
    const sess = db.prepare('SELECT expires, created FROM sessions WHERE token_hash = ?').get(hash);
    const now = Date.now();
    if (!sess || sess.expires < now) return false;
    return now - (sess.created ?? (sess.expires - SESSION_MS)) < SESSION_MAX_MS;
  }
  hub.teacherSessionOk = teacherSessionOk;
  function studentFromReq(req) {
    const tok = U.parseCookies(req.headers.cookie).hm_student;
    if (!tok) return null;
    const row = db.prepare('SELECT uni_id, name, expires FROM student_sessions WHERE token_hash = ?').get(U.sha256(tok));
    if (!row || row.expires < Date.now()) return null;
    return { uniId: row.uni_id, name: row.name };
  }
  /** Ny lærer-session; returnerer cookien. */
  function newSession(req, teacherId, mfa) {
    const tok = U.randomToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, teacher_id, expires, mfa, created) VALUES (?,?,?,?,?)').run(U.sha256(tok), teacherId, now + Math.min(SESSION_MS, SESSION_MAX_MS), mfa ? 1 : 0, now);
    return `hm_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}${isHttps(req) ? '; Secure' : ''}`;
  }
  function setSession(req, res, teacherId, mfa = 0) {
    res.setHeader('Set-Cookie', newSession(req, teacherId, mfa));
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // ikke-browser-klienter
    try {
      const o = new URL(origin);
      return o.host === req.headers.host || (o.host === req.headers['x-forwarded-host'] && fromProxy(req));
    } catch (e) { return false; }
  }

  /* ---------------------------- http helpers ---------------------------- */
  const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // Andre hjemmesider må ikke indlejre serverens svar (billeder af elevskærme, JSON) – OWASP Secure Headers
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  /**
   * Content-Security-Policy pr. forespørgsel: websockets kun til serveren selv (ikke "ws: wss:" = hvor som helst,
   * som en indsprøjtet side kunne bruge til at sende elevdata ud). Værtsnavnet tjekkes, før det kommer i headeren.
   */
  const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;
  function cspFor(req) {
    const fwd = fromProxy(req) && req.headers['x-forwarded-host'];
    const host = String(fwd || req.headers.host || '').split(',')[0].trim();
    const ws = HOST_RE.test(host) ? (isHttps(req) ? `wss://${host}` : `ws://${host} wss://${host}`) : '';
    return "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; " +
      `connect-src 'self'${ws ? ' ' + ws : ''}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` +
      (isHttps(req) ? '; upgrade-insecure-requests' : '');
  }
  /** CSV-celle: citeret, og beskyttet mod formel-injektion (=, +, -, @ i elevdata). */
  function csvCell(v) {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const data = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, Object.assign({}, SEC_HEADERS, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
    res.end(data);
  }
  const fail = (res, status, error) => send(res, status, { error });
  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) return reject(Object.assign(new Error('Forkert content-type'), { status: 415 }));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('For stor forespørgsel'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        let v;
        try { v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (e) { return reject(Object.assign(new Error('Ugyldig JSON'), { status: 400 })); }
        // Kun et objekt er gyldigt (null, tal eller tekst ville give fejl længere inde)
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(Object.assign(new Error('Ugyldig forespørgsel'), { status: 400 }));
        resolve(v);
      });
      req.on('error', reject);
    });
  }

  function readText(req, limit = G.MAX_BODY) {
    return new Promise((resolve, reject) => {
      if (!String(req.headers['content-type'] || '').startsWith('text/plain')) return reject(Object.assign(new Error('Forkert content-type'), { status: 415 }));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('For stor forespørgsel'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  const sendText = (res, status, text) => {
    res.writeHead(status, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(text);
  };
  const guardRl = new U.RateLimiter(2000, 200); // hele klasser bag én NAT-IP

  /* ---------------------------- HolyMoly-vagten ---------------------------- */
  async function guardApi(req, res, p) {
    if (!guardRl.take('g:' + clientIp(req))) return sendText(res, 429, 'ok=0\nerror=rate\n');
    const body = await readText(req);
    const rep = G.parseLines(body);
    if (p === '/api/guard/pair') {
      const code = String(rep.code || '');
      if (code.length < 20 || code.length > 100) return sendText(res, 400, 'ok=0\nerror=code\n');
      let pem;
      try { pem = rep.pubblob ? G.pemFromEccBlob(Buffer.from(rep.pubblob, 'base64')) : G.pemFromSpki(String(rep.pub || '')); } catch (e) { return sendText(res, 400, 'ok=0\nerror=key\n'); }
      // Bevis for at vagten har den hemmelige nøgle
      if (!G.verifySig(pem, body, req.headers['x-hm-sig'], req.headers['x-hm-sig-format'])) return sendText(res, 401, 'ok=0\nerror=sig\n');
      const h = U.sha256(code);
      // Koden er allerede brugt: med den SAMME nøgle er det bare en gentagelse; med en ANDEN nøgle har to
      // vagter på samme computer fået koden – den ene er falsk (uanset hvem der kom først)
      const used = db.prepare('SELECT id, guard_pubkey FROM students WHERE guard_pair_used = ? AND guard_pair_used_until > ?').get(h, Date.now());
      if (used) {
        if (used.guard_pubkey === pem) return sendText(res, 200, `ok=1\nstudent=${used.id}\n`);
        hub.guardTamper(used.id, 'To forskellige HolyMoly-vagter forsøgte at tilknytte sig denne elev – den ene er falsk');
        return sendText(res, 409, 'ok=0\nerror=already\n');
      }
      const s = db.prepare('SELECT id, guard_pubkey, guard_pair_expires FROM students WHERE guard_pair_hash = ?').get(h);
      if (!s || !s.guard_pair_expires || s.guard_pair_expires < Date.now()) return sendText(res, 404, 'ok=0\nerror=expired\n');
      const info = JSON.stringify({ os: U.str(rep.os, 40), keystore: U.str(rep.keystore, 20), guard: U.str(rep.guard, 20) });
      db.prepare('UPDATE students SET guard_pubkey = ?, guard_seq = 0, guard_pair_hash = NULL, guard_pair_expires = NULL, guard_info = ?, guard_pair_used = ?, guard_pair_used_until = ? WHERE id = ?').run(pem, info, h, Date.now() + 60 * 60_000, s.id);
      hub.guardPaired(s.id);
      return sendText(res, 200, `ok=1\nstudent=${s.id}\n`);
    }
    if (p === '/api/guard/beat') {
      const ids = String(rep.students || rep.student || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
      const seq = Number(rep.seq) || 0;
      const ts = Number(rep.ts) || 0;
      if (Math.abs(Date.now() - ts) > 5 * 60_000) return sendText(res, 400, 'ok=0\nerror=clock\n');
      const valid = [];
      const unpaired = []; // vagten skal glemme disse og parre igen (fx ny kode / ny computer)
      for (const id of ids) {
        const s = db.prepare('SELECT id, class_id, guard_pubkey, guard_seq FROM students WHERE id = ?').get(id);
        if (!s || !s.guard_pubkey) { unpaired.push(id); continue; }
        // En ugyldig signatur afvises – men må aldrig gøre en elev rød (alle kan sende en falsk besked med et elev-id)
        if (!G.verifySig(s.guard_pubkey, body, req.headers['x-hm-sig'], req.headers['x-hm-sig-format'])) { unpaired.push(id); continue; }
        if (seq <= s.guard_seq) continue; // genafspillet besked
        db.prepare('UPDATE students SET guard_seq = ? WHERE id = ?').run(seq, id);
        valid.push(s);
      }
      if (!valid.length) return sendText(res, 401, 'ok=0\nerror=unpaired\n' + unpaired.map(i => `unpaired=${i}\n`).join(''));
      const out = hub.guardBeat(valid, rep);
      const lines = ['ok=1', `lesson=${out.live ? 1 : 0}`, `until=${out.until || 0}`, `next=${out.live ? 5 : 15}`, ...unpaired.map(i => `unpaired=${i}`)];
      if (out.live) {
        const hosts = G.expandHosts(out.blocked);
        const hash = U.sha256(hosts.join('\n')).slice(0, 16);
        lines.push(`blockhash=${hash}`);
        if (rep.blockhash !== hash) for (const h of hosts) lines.push('block=' + h);
        for (const pid of out.kill) lines.push('kill=' + pid);
      }
      return sendText(res, 200, lines.join('\n') + '\n');
    }
    return sendText(res, 404, 'ok=0\n');
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  // Forside, priser og jura er almindelige sider; resten er lærer-dashboardet (index.html)
  // Beta (enkel tilstand): ingen tilbud/priser. Databehandleraftalen bliver – skolens DPO skal bruge den.
  const PAGES = new Set(['/forside', '/vilkaar', '/vilkaar-elev', '/privatliv', '/databehandleraftale', '/hent', '/sikkerhed'].concat(cfg.simple ? [] : ['/tilbud']));
  // Beta-forsiden (ingen priser, ingen prøveperiode, ingen Unilogin) i enkel tilstand
  const FRONT = cfg.simple ? 'forside-beta.html' : 'forside.html';
  const SIMPLE_HIDDEN = new Set(['/tilbud', '/tilbud.html', '/tilbud.js', '/forside.html']);
  function serveDownload(req, res, name) {
    let n;
    try { n = decodeURIComponent(name); } catch (e) { return fail(res, 404, 'Ikke fundet'); }
    if (!/^[\w .()+-]{1,120}\.(exe|msi|pkg|dmg|zip|crx|xpi)$/i.test(n) || n.includes('..')) return fail(res, 404, 'Ikke fundet');
    const f = path.join(cfg.dataDir, 'downloads', n);
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) return fail(res, 404, 'Filen findes ikke');
      res.writeHead(200, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${n.replace(/"/g, '')}"`, 'Cache-Control': 'no-cache' }));
      fs.createReadStream(f).pipe(res);
    });
  }
  function serveStatic(req, res, pathname) {
    let file;
    if (pathname === '/shared/rules.js') file = path.join(sharedDir, 'rules.js');
    else if (pathname === '/shared/doc.js') file = path.join(sharedDir, 'doc.js');
    else if (/^\/bevis\/[A-Za-z0-9_-]{16}$/.test(pathname) || pathname === '/bevis') file = path.join(publicDir, 'bevis.html');
    else if (cfg.simple && SIMPLE_HIDDEN.has(pathname)) return fail(res, 404, 'Ikke fundet');
    else if (pathname === '/' && !teacherFromReq(req) && !studentFromReq(req)) file = path.join(publicDir, FRONT);
    else if (pathname === '/forside') file = path.join(publicDir, FRONT);
    else if (PAGES.has(pathname)) file = path.join(publicDir, pathname.slice(1) + '.html');
    else if (pathname.startsWith('/hent/')) return serveDownload(req, res, pathname.slice(6));
    else {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      file = path.normalize(path.join(publicDir, rel));
      if (!file.startsWith(publicDir + path.sep)) return fail(res, 404, 'Ikke fundet');
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // SPA-fallback
        if (!path.extname(pathname) && pathname !== '/index.html') return serveStatic(req, res, '/index.html');
        return fail(res, 404, 'Ikke fundet');
      }
      res.writeHead(200, Object.assign({}, SEC_HEADERS, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
      res.end(buf);
    });
  }

  /* ---------------------------- API ---------------------------- */
  /** Sletter en klasse med elever, log, skærmbilleder og dokumenter. */
  function deleteClassFully(c) {
    hub.stopLesson(c.id, { all: true });
    const ids = db.prepare('SELECT id FROM students WHERE class_id = ?').all(c.id).map(r => r.id);
    db.prepare('DELETE FROM classes WHERE id = ?').run(c.id);
    for (const id of ids) { hub.forgetStudent(id); fs.rm(path.join(cfg.dataDir, 'evidence', String(id)), { recursive: true, force: true }, () => {}); }
    hub.forgetClass(c.id);
  }
  const accounts = createAccounts({ db, cfg, mailer, log, send, fail, readJson, setSession, clientIp, deleteClassFully,
    loginRl, loginEmailRl, closeTeacher: (id, exceptHash) => hub.closeTeacher(id, exceptHash) });
  /** Elev-appen: filer i data/downloads (fx HolyMoly-Setup.exe / HolyMoly.pkg) eller AGENT_DOWNLOAD_URL. */
  function downloadsInfo() {
    const dir = path.join(cfg.dataDir, 'downloads');
    const out = {};
    for (const [key, re] of [['windows', /\.(exe|msi)$/i], ['mac', /\.(pkg|dmg)$/i]]) {
      try { const f = fs.readdirSync(dir).filter(n => re.test(n)).sort().pop(); if (f) out[key] = '/hent/' + encodeURIComponent(f); } catch (e) { /* ingen mappe */ }
    }
    return out;
  }
  function ownClass(teacher, classId) {
    return db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(Number(classId), teacher.id);
  }
  function ownStudent(teacher, studentId) {
    return db.prepare('SELECT s.* FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND c.teacher_id = ?').get(Number(studentId), teacher.id);
  }
  function studentOut(s) {
    let device = null;
    try { device = s.device_info ? JSON.parse(s.device_info) : null; } catch (e) { /* */ }
    return {
      id: s.id, name: s.name, x: s.x, y: s.y, enrolled: !!s.device_token_hash, device,
      joined: !!s.enrolled, // har tilmeldt sig mindst én gang (kun de vises i klasseværelset)
      inviteCode: s.device_token_hash ? null : (s.invite_expires > Date.now() ? s.invite_code : null),
      inviteExpires: s.device_token_hash ? null : s.invite_expires,
      pin: !!s.pin_hash, pinResetUntil: !s.pin_hash && s.pin_reset_hash && s.pin_reset_until > Date.now() ? s.pin_reset_until : null,
      pinReset: !s.pin_hash && !!s.pin_reset_hash, // nulstillet (engangskoden kan være udløbet)
      pinLocked: (s.pin_fails || 0) >= PIN_MAX_FAILS,
    };
  }
  function newInvite(studentId) {
    for (let i = 0; i < 5; i++) {
      const code = U.inviteCode();
      try {
        // Ny kode = ny computer: den gamle vagt-nøgle gælder ikke længere
        // 'enrolled' bevares, så eleven bliver i klasseværelset, mens den nye computer tilmeldes
        db.prepare('UPDATE students SET invite_code = ?, invite_expires = ?, device_token_hash = NULL, guard_pubkey = NULL, guard_seq = 0, guard_pair_hash = NULL WHERE id = ?').run(code, Date.now() + 14 * 86400_000, studentId);
        return code;
      } catch (e) { /* kollision – prøv igen */ }
    }
    throw new Error('Kunne ikke lave kode');
  }
  /** Klassekode: eleverne skriver den i appen første gang (sammen med deres navn). */
  function newJoinCode(classId) {
    for (let i = 0; i < 10; i++) {
      const code = U.inviteCode();
      if (db.prepare('SELECT 1 FROM students WHERE invite_code = ?').get(code)) continue;
      try { db.prepare('UPDATE classes SET join_code = ? WHERE id = ?').run(code, classId); return code; } catch (e) { /* kollision */ }
    }
    throw new Error('Kunne ikke lave klassekode');
  }
  function joinInfo(c) {
    const row = db.prepare('SELECT join_code, join_open FROM classes WHERE id = ?').get(c.id);
    return { joinCode: row.join_code || newJoinCode(c.id), joinOpen: !!row.join_open };
  }
  /** Lektionsrapport: minutter grøn/rød/grå, fund, forsøg, hænder og afleveringer pr. elev. */
  function lessonReport(c, lessonId) {
    const l = db.prepare('SELECT id, started, ends_at, ended FROM lessons WHERE id = ? AND class_id = ?').get(lessonId, c.id);
    if (!l) return null;
    const end = l.ended || Math.min(l.ends_at, Date.now());
    const students = db.prepare('SELECT id, name FROM students WHERE class_id = ? AND enrolled IS NOT NULL ORDER BY name').all(c.id);
    const colors = db.prepare('SELECT ts, color, reason FROM lesson_colors WHERE lesson_id = ? AND student_id = ? ORDER BY ts');
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM events WHERE lesson_id = ? AND student_id = ? GROUP BY kind');
    const docsQ = db.prepare('SELECT COUNT(*) AS n, COUNT(cert_id) AS c FROM documents WHERE student_id = ? AND submitted BETWEEN ? AND ?');
    const out = students.map((s) => {
      const t = { green: 0, red: 0, grey: 0 };
      const redReasons = new Set();
      let at = l.started, color = 'grey';   // før første melding: ikke forbundet
      for (const r of colors.all(l.id, s.id)) {
        const ts = Math.min(Math.max(r.ts, l.started), end);
        t[color] += Math.max(0, ts - at);
        at = ts; color = r.color in t ? r.color : 'grey';
        if (r.color === 'red' && r.reason && redReasons.size < 10) redReasons.add(r.reason);
      }
      t[color] += Math.max(0, end - at);
      const k = Object.fromEntries(kinds.all(l.id, s.id).map(r => [r.kind, r.n]));
      const d = docsQ.get(s.id, l.started, end + 60_000);
      return {
        id: s.id, name: s.name, green: t.green, red: t.red, grey: t.grey, redReasons: [...redReasons],
        violations: (k.violation || 0) + (k.tamper || 0), attempts: k.blocked || 0, killed: k.killed || 0,
        hands: k.hand || 0, submitted: d.n, certified: d.c,
      };
    });
    return { lesson: { id: l.id, started: l.started, ended: end, minutes: Math.round((end - l.started) / 60000) }, students: out };
  }

  /** Ledig plads til et nyt bord, uden at flytte de borde læreren har placeret. */
  function freeSpot(classId) {
    const taken = db.prepare('SELECT x, y FROM students WHERE class_id = ? AND enrolled IS NOT NULL').all(classId);
    const n = taken.length + 1;
    const cols = Math.min(8, Math.max(Math.min(n, 4), Math.ceil(Math.sqrt(n * 1.8))));
    const nrows = Math.max(1, Math.ceil(n / cols));
    for (let rr = 0; rr < nrows + 4; rr++) {
      for (let c = 0; c < cols; c++) {
        const x = 0.06 + (c + 0.5) * (0.88 / cols), y = Math.min(0.95, 0.2 + (rr + 0.5) * (0.78 / nrows));
        if (!taken.some(t => Math.abs(t.x - x) < 0.85 / cols && Math.abs(t.y - y) < 0.7 / nrows)) return { x, y };
      }
    }
    return { x: 0.5, y: 0.9 };
  }
  /** Ny elev i klasseværelset: et pænt gitter, medmindre læreren selv har placeret bordene. */
  function placeJoined(classId) {
    const c = db.prepare('SELECT layout_custom FROM classes WHERE id = ?').get(classId);
    if (!c || !c.layout_custom) gridLayout(classId);
  }
  const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('da');

  function sanitizeConfig(input, current) {
    const c = current;
    if (input.categories && typeof input.categories === 'object') {
      for (const k of Object.keys(ACRules.CATEGORIES)) if (k in input.categories) c.categories[k] = !!input.categories[k];
    }
    const domList = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 500).map(d => U.str(d, 200).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/.test(d));
    if ('extraBlocked' in input) c.extraBlocked = domList(input.extraBlocked);
    if ('allowed' in input) c.allowed = domList(input.allowed);
    const appList = (arr) => [...new Set((Array.isArray(arr) ? arr : []).slice(0, 200).map(a => U.str(a, 80).trim().toLowerCase().replace(/\.exe$/, '')).filter(Boolean))];
    if ('allowedApps' in input) c.allowedApps = appList(input.allowedApps);
    if ('extraBlockedApps' in input) c.extraBlockedApps = appList(input.extraBlockedApps);
    if ('examAllowedApps' in input) c.examAllowedApps = appList(input.examAllowedApps);
    if ('examAllowed' in input) c.examAllowed = domList(input.examAllowed);
    if ('examMode' in input) c.examMode = !!input.examMode;
    if ('killApps' in input) c.killApps = !!input.killApps;
    if ('autoEvidence' in input) c.autoEvidence = !!input.autoEvidence;
    // Et program kan ikke både være tilladt og blokeret – det seneste valg vinder
    if ('extraBlockedApps' in input && !('allowedApps' in input)) c.allowedApps = c.allowedApps.filter(a => !c.extraBlockedApps.includes(a));
    if ('allowedApps' in input && !('extraBlockedApps' in input)) c.extraBlockedApps = c.extraBlockedApps.filter(a => !c.allowedApps.includes(a));
    if ('lessonMinutes' in input) c.lessonMinutes = U.clampNum(input.lessonMinutes, 10, cfg.maxLessonMinutes, 90);
    if ('links' in input) {
      // Kun almindelige web-adresser (aldrig javascript:, file: osv.) – højst 20
      c.links = (Array.isArray(input.links) ? input.links : []).slice(0, 20).map((l) => {
        let u;
        try { u = new URL(U.str(l && l.url, 2000).trim()); } catch (e) { return null; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        const title = U.str(l.title, 80).replace(/[\u0000-\u001F\u007F]/g, '').trim() || u.hostname.replace(/^www\./, '');
        return { title, url: u.toString() };
      }).filter(Boolean);
    }
    return c;
  }

  /** Titel, beskrivelse og frist til en aflevering. */
  function assignmentInput(b) {
    const title = U.str(b.title, 120).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    const description = U.str(b.description, 4000).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
    if (!title) return { error: 'Skriv en titel' };
    let due = null;
    if (b.due != null && b.due !== '') {
      due = typeof b.due === 'number' ? b.due : Date.parse(b.due);
      if (!Number.isFinite(due)) return { error: 'Ugyldig frist' };
    }
    if (b.home && !due) return { error: 'Sæt en frist, når afleveringen må skrives hjemme' };
    return { title, description, due, home: !!b.home };
  }

  /** Gitter-placering af alle borde i klassen (samme formel som dashboardet). */
  function gridLayout(classId) {
    const rows = db.prepare('SELECT id FROM students WHERE class_id = ? AND enrolled IS NOT NULL ORDER BY name').all(classId);
    const n = rows.length;
    const cols = Math.min(8, Math.max(Math.min(n, 4), Math.ceil(Math.sqrt(n * 1.8))));
    const nrows = Math.max(1, Math.ceil(n / cols));
    const upd = db.prepare('UPDATE students SET x = ?, y = ? WHERE id = ?');
    rows.forEach((r, i) => {
      const c = i % cols, rr = Math.floor(i / cols);
      upd.run(0.06 + (c + 0.5) * (0.88 / cols), 0.2 + (rr + 0.5) * (0.78 / nrows), r.id);
    });
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const ip = clientIp(req);
    if (!apiRl.take(ip)) return fail(res, 429, 'For mange forespørgsler – vent lidt');
    if (m !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'Forkert oprindelse');
    if (cfg.simple && SIMPLE_OFF.test(p)) return fail(res, 404, 'Ukendt adresse');

    // --- offentlige ---
    if (p === '/api/info' && m === 'GET') {
      return send(res, 200, { simple: cfg.simple, uniLogin: uni.enabled, signupRequiresCode: !!accounts.signupCodeNow(), firstTeacher: !!accounts.setupCode(), approval: approvalInfo(), approvalMissing: approvalMissingFields(), lessonBlocked: !!lessonBlocked(), lessonBlockedReason: lessonBlockedReason(),
        operator: cfg.simple ? { role: cfg.operator, dba: !!cfg.dbaDate, handedOver: handedOver(), testServer: docs.testServer } : null, signupOpen: cfg.signupOpen, licensing: cfg.licensing, trialDays: cfg.trialDays, verifyEmail: cfg.verifyEmail, require2fa: cfg.require2fa, company: cfg.company, downloads: downloadsInfo(), downloadUrl: cfg.downloadUrl, extensionUrls: cfg.extensionUrls, categories: ACRules.CATEGORIES, rulesVersion: rules.version,
        retention: RET.publicInfo(cfg.retention), features });
    }
    if (await accounts.publicRoutes(req, res, p, m)) return;
    /* ---- UNI-Login ----
     * Sikkerhed:
     *  - Forsøget er bundet til den browser, der startede det (cookie med hash af state), så ingen kan
     *    sende et login-link til en anden og få dennes login (login-CSRF / overtagelse af en lærers UNI-Login).
     *  - Elev-appen får resultatet via en adresse på elevens EGEN computer (127.0.0.1:<port>, RFC 8252).
     *    Sender en elev sit login-link til en klassekammerat, ender resultatet på klassekammeratens computer
     *    – ikke hos den, der sendte linket.
     */
    if (p === '/api/auth/unilogin/start' && m === 'GET') {
      if (!uni.enabled) return fail(res, 404, 'UNI-Login er ikke sat op på denne server');
      if (!uniRl.take('uni:' + ip)) return fail(res, 429, 'For mange forsøg – prøv igen om lidt');
      const role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
      const app = String(url.searchParams.get('app') || '');
      const port = Number(url.searchParams.get('port') || 0);
      if (app && (!/^[A-Za-z0-9_-]{32,64}$/.test(app) || !Number.isInteger(port) || port < 1024 || port > 65535)) return fail(res, 400, 'Ugyldig forespørgsel');
      if (app && role !== 'student') return fail(res, 400, 'Ugyldig forespørgsel');
      // En lærer der allerede er logget ind med e-mail, kan knytte sit UNI-Login til kontoen
      let linkTo = null;
      if (role === 'teacher' && url.searchParams.get('link') === '1') {
        const t = teacherFromReq(req);
        if (!t || accounts.needs(t, t.sess)) return fail(res, 403, 'Log ind og gør din konto færdig (e-mail og to-faktor), før du tilknytter Unilogin');
        if (t.uni_id) return fail(res, 400, 'Din konto har allerede Unilogin');
        linkTo = t.id;
      }
      try {
        const { url: to, state } = await uni.start(role, { app, port: app ? port : 0, linkTo });
        res.writeHead(302, Object.assign({}, SEC_HEADERS, {
          Location: to, 'Cache-Control': 'no-store',
          'Set-Cookie': `hm_oidc=${U.sha256(state)}; HttpOnly; SameSite=Lax; Path=/api/auth/unilogin; Max-Age=600${isHttps(req) ? '; Secure' : ''}`,
        }));
        return res.end();
      } catch (e) { return fail(res, 502, e.message); }
    }
    if (p === '/api/auth/unilogin/callback' && m === 'GET') {
      const state = String(url.searchParams.get('state') || '');
      const clear = `hm_oidc=; HttpOnly; SameSite=Lax; Path=/api/auth/unilogin; Max-Age=0`;
      // Fejlbeskeden sendes i en kortlivet cookie – ikke i adressen. Ellers kunne enhver sende en lærer et ægte
      // HolyMoly-link med sin egen tekst på login-siden ("Din konto er låst – ring til …"): indholds-forfalskning/phishing.
      const toLogin = (msg) => {
        const note = `hm_loginmsg=${encodeURIComponent(String(msg).slice(0, 300))}; Path=/login; Max-Age=120; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
        res.writeHead(302, Object.assign({}, SEC_HEADERS, { Location: '/login?fejl=1', 'Set-Cookie': [clear, note] }));
        res.end();
      };
      // Kun den browser der startede forsøget, kan afslutte det
      const bound = U.parseCookies(req.headers.cookie).hm_oidc;
      if (!state || !bound || bound !== U.sha256(state)) {
        uni.pending.delete(state);
        return toLogin('Login-forsøget blev ikke startet i denne browser. Start forfra.');
      }
      let who;
      try { who = await uni.finish(url.searchParams.get('code'), state); } catch (e) { return toLogin(e.message); }
      if (who.role === 'student') {
        // Unilogin giver kun navnet, når skolen har godkendt HolyMolys dataaftale med "udvidet brugerinformation"
        if (!who.name && who.app) return toLogin('Unilogin sendte ikke dit navn, fordi skolen ikke har godkendt HolyMolys dataaftale med navne i Unilogin. Bed skolens Unilogin-administrator om det – eller brug klassekoden og dit navn i appen.');
        if (!who.name) who.name = 'Elev';
        if (who.app) {
          // Elev-appen venter på elevens egen computer: engangsbillet dertil (bruges i /api/enroll)
          sweep(uniTickets);
          const ticket = U.randomToken(32);
          uniTickets.set(ticket, { uniId: who.uniId, name: who.name, exp: Date.now() + 10 * 60_000 });
          res.writeHead(302, Object.assign({}, SEC_HEADERS, { Location: `http://127.0.0.1:${who.port}/unilogin?app=${encodeURIComponent(who.app)}&ticket=${ticket}`, 'Set-Cookie': clear, 'Cache-Control': 'no-store' }));
          return res.end();
        }
        const tok = U.randomToken();
        db.prepare('INSERT INTO student_sessions (token_hash, uni_id, name, expires) VALUES (?,?,?,?)').run(U.sha256(tok), who.uniId, who.name, Date.now() + SESSION_MS);
        res.writeHead(302, Object.assign({}, SEC_HEADERS, { Location: '/elev', 'Set-Cookie': [clear, `hm_student=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`] }));
        return res.end();
      }
      // Lærer
      let t = db.prepare('SELECT id FROM teachers WHERE uni_id = ?').get(who.uniId);
      if (!t && who.linkTo) {
        // Kun et lærer-Unilogin kan knyttes til en lærerkonto (aldrig en elevs)
        if (!cfg.uniLogin.roleClaim || !who.isTeacher) return toLogin('Kun et Unilogin med en lærer-rolle kan knyttes til en lærerkonto.');
        const r = db.prepare('UPDATE teachers SET uni_id = ? WHERE id = ? AND uni_id IS NULL').run(who.uniId, who.linkTo);
        t = db.prepare('SELECT id, email FROM teachers WHERE uni_id = ?').get(who.uniId);
        if (r.changes && t && !String(t.email).startsWith('unilogin:')) {
          mailer.send({ to: t.email, subject: 'Unilogin er knyttet til din HolyMoly-konto', title: 'Unilogin tilknyttet',
            lines: [`Unilogin for ${who.name || 'en lærer'} er nu knyttet til din HolyMoly-konto. Du kan logge ind med Unilogin fremover.`,
              'Var det ikke dig, så skift adgangskode med det samme og kontakt din skoles administrator.'] });
        }
      }
      if (!t) {
        if (!cfg.uniLogin.roleClaim) return toLogin('Lærer-login med UNI-Login er ikke færdigt sat op (UNILOGIN_ROLE_CLAIM mangler). Log ind med e-mail, og tilknyt UNI-Login under Indstillinger.');
        if (!who.isTeacher) return toLogin('Dit UNI-Login er ikke en lærer-konto. Elever bruger HolyMoly-appen.');
        const r = db.prepare('INSERT INTO teachers (email, name, pass_hash, created, uni_id) VALUES (?,?,?,?,?)').run('unilogin:' + who.uniId, who.name || 'Lærer', U.hashPassword(U.randomToken()), Date.now(), who.uniId);
        t = { id: Number(r.lastInsertRowid) };
      }
      // Institutioner fra Unilogin huskes (skolens administrator kan vælge skolens institutionsnummer blandt dem),
      // og en lærer uden skole kobles automatisk på den skole, der har institutionsnummeret
      accounts.uniLoggedIn(t.id, who.institutions || []);
      // Unilogin har sin egen sikkerhed (MitID, skolens login) – sessionen tæller som to-faktor
      const sessCookie = newSession(req, t.id, 1);
      accounts.secLog(t.id, 'login', `${who.name || 'Lærer'} loggede ind (Unilogin)`, req);
      // Cookien gemmes selv om vi kommer fra UNI-Login; dashboardets egne kald (samme site) sender den med
      res.writeHead(302, Object.assign({}, SEC_HEADERS, { Location: '/', 'Set-Cookie': [clear, sessCookie] }));
      return res.end();
    }
    // Skrive-bevis: offentligt tjek (id'et er tilfældigt og kan ikke gættes)
    let bm;
    if ((bm = p.match(/^\/api\/bevis\/([A-Za-z0-9_-]{16})$/)) && m === 'GET') {
      const c = docs.certificate(bm[1]);
      // 404 kun for id'er, der aldrig er udstedt her. Et udløbet bevis giver 410.
      if (!c) return fail(res, 404, 'Dette id er aldrig udstedt her');
      if (c.expired) return send(res, 410, { error: 'Beviset er udløbet', expired: c.expired, created: c.created });
      // Navn og klasse står ikke i beviset. Elevens egen lærer (logget ind) får dem med – ingen andre.
      const t = teacherFromReq(req);
      const o = t && docs.certificateOwner(bm[1]);
      if (o && ownStudent(t, o.studentId)) c.owner = { student: o.student, class: o.class, title: o.title };
      // En indlogget lærer får at vide, at beviset tilhører en anden lærers elev (men ikke hvem)
      else if (o) c.notMine = true;
      return send(res, 200, c);
    }
    if (p === '/api/student/me' && m === 'GET') {
      const st = studentFromReq(req);
      if (!st) return fail(res, 401, 'Ikke logget ind');
      const classes = db.prepare('SELECT c.name, t.name AS teacher FROM students s JOIN classes c ON c.id = s.class_id JOIN teachers t ON t.id = c.teacher_id WHERE s.uni_id = ? ORDER BY c.name').all(st.uniId);
      // Elevens afleveringer i alle klasser (kun elevens egne vedhæftninger)
      const assignments = db.prepare(`SELECT a.id, a.title, a.description, a.due, a.home, c.name AS class_name,
          sub.submitted, d.title AS doc_title, d.cert_id
        FROM students s JOIN classes c ON c.id = s.class_id JOIN assignments a ON a.class_id = c.id
        LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = s.id
        LEFT JOIN documents d ON d.id = sub.doc_id
        WHERE s.uni_id = ? ORDER BY (sub.submitted IS NOT NULL), COALESCE(a.due, 9e15) LIMIT 200`).all(st.uniId)
        .map(r => ({ id: r.id, title: r.title, description: r.description, due: r.due, home: !!r.home, className: r.class_name,
          submission: r.submitted ? { submitted: r.submitted, title: r.doc_title || '', certId: r.cert_id || null, late: !!(r.due && r.submitted > r.due) } : null }));
      return send(res, 200, { name: st.name, classes, assignments, downloadUrl: cfg.downloadUrl });
    }
    if (p === '/api/student/logout' && m === 'POST') {
      const tok = U.parseCookies(req.headers.cookie).hm_student;
      if (tok) db.prepare('DELETE FROM student_sessions WHERE token_hash = ?').run(U.sha256(tok));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hm_student=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (p === '/api/logout' && m === 'POST') {
      const tok = U.parseCookies(req.headers.cookie).hm_session;
      if (tok) {
        const h = U.sha256(tok);
        const row = db.prepare('SELECT teacher_id FROM sessions WHERE token_hash = ?').get(h);
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
        if (row) hub.closeTeacher(row.teacher_id, null, h); // klasseværelset i denne browser lukkes også
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (p === '/api/enroll' && m === 'POST') {
      if (!enrollRl.take('enroll:' + ip)) return fail(res, 429, 'For mange forsøg – vent et par minutter');
      const b = await readJson(req);
      const code = U.normalizeCode(b.code);
      if (!code) return fail(res, 400, 'Koden skal have 8 tegn, fx ABCD-2345');
      // Klassekode: eleven tilmelder sig selv med sit navn og dukker op i klasseværelset
      const cls = db.prepare('SELECT c.id, c.name, c.join_open, t.name AS teacher_name FROM classes c JOIN teachers t ON t.id = c.teacher_id WHERE c.join_code = ?').get(code);
      if (cls) {
        if (!cls.join_open) return fail(res, 403, 'Klassen er lukket for tilmelding – spørg din lærer');
        // Navnet kommer fra UNI-Login (billet fra /api/auth/unilogin/app-result) eller – hvis tilladt – fra eleven selv
        const uniRequired = uni.enabled && !cfg.uniLoginOptional;
        const ask = (error, status = 400) => send(res, status, { error, needName: true, needPin: cfg.simple, needAccept: cfg.simple, termsPath: '/vilkaar-elev', uniLogin: uni.enabled, uniLoginRequired: uniRequired, className: cls.name, teacherName: cls.teacher_name });
        let uniId = null, name = '', pin = '';
        if (b.ticket) {
          const t = uniTickets.get(String(b.ticket));
          uniTickets.delete(String(b.ticket));
          if (!t || t.exp < Date.now()) return ask('UNI-Login er udløbet – log ind igen');
          uniId = t.uniId; name = t.name;
        } else {
          if (uniRequired) return ask(b.name ? 'Log ind med UNI-Login' : '');
          name = U.str(b.name, 80).trim().replace(/\s+/g, ' ');
          if (!name) return ask('Skriv dit fulde navn');
          if (name.length < 2 || !/\p{L}/u.test(name)) return ask('Skriv dit rigtige fulde navn');
          // Elevens egen kode (krævet i enkel tilstand, ellers frivillig)
          pin = String(b.pin ?? '').trim();
          if (pin && !/^\d{4,6}$/.test(pin)) return ask('Koden skal være 4-6 cifre');
          if (cfg.simple && !pin) return ask(b.name && b.pin === undefined ? 'Opdater HolyMoly-appen – den nye version spørger efter din kode' : 'Vælg en kode på 4 cifre, som kun du kender');
          // Enkel tilstand: eleven accepterer vilkårene for elever i appen, før tilmeldingen går igennem
          if (cfg.simple && b.accept !== true) return ask(b.accept === undefined ? 'Opdater HolyMoly-appen – den nye version viser vilkårene' : 'Sæt flueben ved vilkårene for at tilmelde dig');
          // Er navnet allerede tilmeldt med en kode, er det samme elev på en ny computer – men kun med den rigtige kode.
          // Har læreren nulstillet koden, skriver eleven engangskoden fra læreren (inden for 30 minutter); den bliver elevens nye kode.
          const owner = db.prepare('SELECT id, name, pin_hash, pin_reset_hash, pin_reset_until, pin_fails FROM students WHERE class_id = ? AND enrolled IS NOT NULL AND (pin_hash IS NOT NULL OR pin_reset_hash IS NOT NULL)').all(cls.id).find(r => normName(r.name) === normName(name));
          if (owner) {
            const resetting = !owner.pin_hash;
            if (!pin) return ask(resetting ? 'Din lærer har nulstillet din kode. Skriv koden, du har fået af din lærer.' : 'Navnet er allerede tilmeldt med en kode. Skriv din kode – eller dit efternavn, hvis du er en anden elev.');
            // For mange forkerte koder i alt (gemt i databasen, så en genstart ikke nulstiller tællingen): kun læreren kan låse op
            if (owner.pin_fails >= PIN_MAX_FAILS) return ask('Din kode er låst efter for mange forkerte forsøg. Bed din lærer om at nulstille den.', 423);
            if (resetting && !(owner.pin_reset_until > Date.now())) return ask('Koden fra din lærer er udløbet. Bed din lærer om en ny.', 401);
            if (!pinRl.take('pin:' + owner.id)) return ask('For mange forkerte koder – vent et par minutter, eller bed din lærer om hjælp', 429);
            if (!U.verifyPassword(pin, resetting ? owner.pin_reset_hash : owner.pin_hash)) {
              const fails = owner.pin_fails + 1;
              db.prepare('UPDATE students SET pin_fails = pin_fails + 1 WHERE id = ?').run(owner.id);
              hub.studentJoined(owner.id, cls.id, fails >= PIN_MAX_FAILS
                ? `${owner.name}s kode er låst efter ${PIN_MAX_FAILS} forkerte forsøg. Nulstil koden, hvis det er eleven selv.`
                : `Nogen prøvede at logge ind som ${owner.name} med en forkert kode`);
              if (fails >= PIN_MAX_FAILS) return ask('Din kode er låst efter for mange forkerte forsøg. Bed din lærer om at nulstille den.', 423);
              return ask(resetting ? 'Forkert kode. Skriv koden, du har fået af din lærer.' : 'Forkert kode. Er du en anden elev med samme navn, så skriv dit efternavn med.', 401);
            }
            pinRl.refund('pin:' + owner.id); // kun forkerte forsøg tæller
            const token = U.randomToken(32);
            // Ved nulstilling bliver engangskoden elevens kode (den er allerede gemt som hash)
            db.prepare('UPDATE students SET device_token_hash = ?, invite_code = NULL, invite_expires = NULL, guard_pubkey = NULL, guard_seq = 0, guard_pair_hash = NULL, terms_accepted = COALESCE(?, terms_accepted), pin_hash = COALESCE(pin_hash, pin_reset_hash), pin_reset_hash = NULL, pin_reset_until = NULL, pin_fails = 0 WHERE id = ?')
              .run(U.sha256(token), b.accept === true ? Date.now() : null, owner.id);
            hub.revokeStudent(owner.id);
            hub.studentJoined(owner.id, cls.id, resetting ? `${owner.name} loggede ind med koden fra læreren` : `${owner.name} loggede ind med sin kode på en ny computer`);
            return send(res, 200, { token, studentId: owner.id, studentName: owner.name, className: cls.name, teacherName: cls.teacher_name });
          }
          // En ny elev vælger sin kode: de mest almindelige koder afvises
          if (pin && weakPin(pin)) return ask('Vælg en kode, der er sværere at gætte');
        }
        // Samme UNI-Login i samme klasse = samme elev (fx ny computer): den gamle computer logges ud
        const same = uniId ? db.prepare('SELECT id FROM students WHERE class_id = ? AND uni_id = ?').get(cls.id, uniId) : null;
        if (same) {
          const token = U.randomToken(32);
          db.prepare('UPDATE students SET device_token_hash = ?, invite_code = NULL, invite_expires = NULL, enrolled = COALESCE(enrolled, ?), name = ?, guard_pubkey = NULL, guard_seq = 0, guard_pair_hash = NULL WHERE id = ?').run(U.sha256(token), Date.now(), name, same.id);
          hub.revokeStudent(same.id);
          hub.studentJoined(same.id, cls.id, `${name} loggede ind med UNI-Login på en ny computer`);
          return send(res, 200, { token, studentId: same.id, studentName: name, className: cls.name, teacherName: cls.teacher_name });
        }
        const token = U.randomToken(32);
        // Har læreren selv skrevet navnet ind på forhånd (og er det ikke taget), bruges den plads
        const pre = db.prepare('SELECT id, name FROM students WHERE class_id = ? AND enrolled IS NULL AND device_token_hash IS NULL').all(cls.id).find(r => normName(r.name) === normName(name));
        const dup = db.prepare('SELECT name FROM students WHERE class_id = ? AND enrolled IS NOT NULL').all(cls.id).some(r => normName(r.name) === normName(name));
        if (!pre && db.prepare('SELECT COUNT(*) AS n FROM students WHERE class_id = ?').get(cls.id).n >= 80) return fail(res, 400, 'Klassen er fuld (højst 80 elever)');
        const spot = freeSpot(cls.id);
        let sid;
        if (pre) {
          sid = pre.id;
          db.prepare('UPDATE students SET device_token_hash = ?, invite_code = NULL, invite_expires = NULL, enrolled = ?, x = ?, y = ?, uni_id = ? WHERE id = ?').run(U.sha256(token), Date.now(), spot.x, spot.y, uniId, sid);
        } else {
          sid = Number(db.prepare('INSERT INTO students (class_id, name, x, y, device_token_hash, enrolled, created, uni_id) VALUES (?,?,?,?,?,?,?,?)').run(cls.id, name, spot.x, spot.y, U.sha256(token), Date.now(), Date.now(), uniId).lastInsertRowid);
        }
        if (pin) db.prepare('UPDATE students SET pin_hash = ? WHERE id = ?').run(U.hashPassword(pin), sid);
        if (b.accept === true) db.prepare('UPDATE students SET terms_accepted = ? WHERE id = ?').run(Date.now(), sid);
        placeJoined(cls.id);
        const how = uniId ? 'med UNI-Login' : 'med klassekoden';
        hub.studentJoined(sid, cls.id, dup && !uniId ? `${name} tilmeldte sig ${how} – der er allerede en elev med det navn. Er det den samme elev på en ny computer, så slet den gamle.` : `${name} tilmeldte sig ${how}`);
        log('Elev tilmeldt med klassekode', sid);
        return send(res, 200, { token, studentId: sid, studentName: name, className: cls.name, teacherName: cls.teacher_name });
      }
      const s = db.prepare('SELECT s.id, s.name, s.class_id, s.enrolled, s.invite_expires, c.name AS class_name, t.name AS teacher_name FROM students s JOIN classes c ON c.id = s.class_id JOIN teachers t ON t.id = c.teacher_id WHERE s.invite_code = ?').get(code);
      if (!s || !s.invite_expires || s.invite_expires < Date.now()) return fail(res, 404, 'Koden findes ikke eller er udløbet');
      const token = U.randomToken(32);
      db.prepare('UPDATE students SET device_token_hash = ?, invite_code = NULL, invite_expires = NULL, enrolled = COALESCE(enrolled, ?) WHERE id = ?').run(U.sha256(token), Date.now(), s.id);
      if (!s.enrolled) {
        const spot = freeSpot(s.class_id);
        db.prepare('UPDATE students SET x = ?, y = ? WHERE id = ?').run(spot.x, spot.y, s.id);
        placeJoined(s.class_id); hub.studentJoined(s.id, s.class_id, `${s.name} tilmeldte sig med sin personlige kode`); }
      hub.revokeStudent(s.id); // evt. gammel enhed smides af
      log('Elev tilmeldt', s.id);
      return send(res, 200, { token, studentId: s.id, studentName: s.name, className: s.class_name, teacherName: s.teacher_name });
    }

    // --- kræver login ---
    const teacher = teacherFromReq(req);
    if (!teacher) return fail(res, 401, 'Ikke logget ind');
    // Mangler e-mail-bekræftelse, to-faktor eller skole, kan kun kontoen sættes op
    const need = accounts.needs(teacher, teacher.sess);
    if (need && !accounts.isOpenWhenNeeds(p, need)) {
      const msg = { verify: 'Bekræft din e-mail først', '2fa': 'Slå to-faktor til først', school: 'Opret eller tilslut din skole først', approval: 'Din konto venter på, at en kollega godkender den' }[need];
      return send(res, 403, { error: msg, needs: need });
    }
    if (await accounts.authedRoutes(req, res, p, m, teacher, teacher.sess)) return;

    if (p === '/api/classes' && m === 'GET') {
      const rows = db.prepare('SELECT c.id, c.name, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.enrolled IS NOT NULL) AS count FROM classes c WHERE teacher_id = ? ORDER BY name').all(teacher.id);
      // Næste aflevering pr. klasse (den med den tidligste frist, der ikke er overskredet)
      const nextAsg = db.prepare(`SELECT a.id, a.title, a.due, a.home, (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS handed
        FROM assignments a WHERE a.class_id = ? AND (a.due IS NULL OR a.due > ?) ORDER BY COALESCE(a.due, 9e15), a.created LIMIT 1`);
      const openAsg = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ? AND (due IS NULL OR due > ?)');
      const now = Date.now();
      return send(res, 200, rows.map((r) => {
        const n = nextAsg.get(r.id, now);
        return Object.assign(r, { lesson: hub._lessonInfo(r.id), openAssignments: openAsg.get(r.id, now).n,
          nextAssignment: n ? { id: n.id, title: n.title, due: n.due, home: !!n.home, handed: n.handed } : null });
      }));
    }
    if (p === '/api/classes' && m === 'POST') {
      const b = await readJson(req);
      const name = U.str(b.name, 80).trim();
      if (!name) return fail(res, 400, 'Skriv et navn til klassen');
      const r = db.prepare('INSERT INTO classes (teacher_id, name, config, created) VALUES (?,?,?,?)').run(teacher.id, name, '{}', Date.now());
      const id = Number(r.lastInsertRowid);
      return send(res, 200, { id, joinCode: newJoinCode(id) });
    }

    let mm;
    if ((mm = p.match(/^\/api\/classes\/(\d+)$/))) {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      if (m === 'GET') {
        const students = db.prepare('SELECT * FROM students WHERE class_id = ? ORDER BY name').all(c.id).map(studentOut);
        return send(res, 200, Object.assign({ id: c.id, name: c.name, config: classConfig(c.id), students, lesson: hub._lessonInfo(c.id) }, joinInfo(c)));
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (b.name != null) {
          const name = U.str(b.name, 80).trim();
          if (name) db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, c.id);
        }
        if (b.config && typeof b.config === 'object') {
          const conf = sanitizeConfig(b.config, classConfig(c.id));
          db.prepare('UPDATE classes SET config = ? WHERE id = ?').run(JSON.stringify(conf), c.id);
          hub.configChanged(c.id);
        }
        // Advar læreren, hvis et af lektionens links er blokeret af klassens regler
        const conf = classConfig(c.id);
        const R = ACRules.compile(rules, conf);
        const blockedLinks = conf.links.map(l => ({ url: l.url, r: R.classifyUrl(l.url) })).filter(x => x.r && x.r.blocked)
          .map(x => ({ url: x.url, host: new URL(x.url).hostname.replace(/^www\./, ''), label: x.r.label }));
        return send(res, 200, { ok: true, config: conf, blockedLinks });
      }
      if (m === 'DELETE') {
        deleteClassFully(c);
        return send(res, 200, { ok: true });
      }
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/students$/)) && m === 'POST') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const b = await readJson(req);
      const names = (Array.isArray(b.names) ? b.names : [b.name]).map(n => U.str(n, 80).trim()).filter(Boolean).slice(0, 60);
      if (!names.length) return fail(res, 400, 'Skriv mindst ét navn');
      const existing = db.prepare('SELECT COUNT(*) AS n FROM students WHERE class_id = ?').get(c.id).n;
      if (existing + names.length > 80) return fail(res, 400, 'Højst 80 elever pr. klasse');
      const created = [];
      for (const name of names) {
        const r = db.prepare('INSERT INTO students (class_id, name, x, y, created) VALUES (?,?,?,?,?)').run(c.id, name, 0.5, 0.5, Date.now());
        const id = Number(r.lastInsertRowid);
        newInvite(id);
        created.push(id);
      }
      // Placér alle borde i et pænt gitter (læreren kan bagefter trække dem rundt)
      gridLayout(c.id);
      created.splice(0, created.length, ...created.map(id => studentOut(db.prepare('SELECT * FROM students WHERE id = ?').get(id))));
      hub._broadcastSnapshot(c.id);
      return send(res, 200, { students: created });
    }
    // Lektionsrapport: de seneste lektioner og en rapport pr. lektion
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/lessons$/)) && m === 'GET') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const rows = db.prepare('SELECT id, started, ends_at, ended FROM lessons WHERE class_id = ? AND student_id IS NULL ORDER BY started DESC LIMIT 40').all(c.id);
      return send(res, 200, { lessons: rows.map(r => ({ id: r.id, started: r.started, ended: r.ended || Math.min(r.ends_at, Date.now()), live: !r.ended && r.ends_at > Date.now() })) });
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/lessons\/(\d+)(\.csv)?$/)) && m === 'GET') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const rep = lessonReport(c, Number(mm[2]));
      if (!rep) return fail(res, 404, 'Lektionen findes ikke');
      if (!mm[3]) return send(res, 200, rep);
      const min = (ms) => (ms / 60000).toFixed(1).replace('.', ',');
      const lines = [['Elev', 'Grøn (min)', 'Rød (min)', 'Grå (min)', 'Fund', 'Blokerede forsøg', 'Hånd op', 'Afleveret', 'Skrive-beviser', 'Røde årsager'].join(';')];
      for (const s of rep.students) lines.push([s.name, min(s.green), min(s.red), min(s.grey), s.violations, s.attempts, s.hands, s.submitted, s.certified, s.redReasons.join(' / ')].map(csvCell).join(';'));
      res.writeHead(200, Object.assign({}, SEC_HEADERS, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="lektionsrapport-${rep.lesson.id}.csv"`,
      }));
      return res.end('\uFEFF' + lines.join('\r\n') + '\r\n');
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/joincode$/)) && m === 'POST') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const b = await readJson(req);
      if (b.action === 'new') newJoinCode(c.id);
      else if (b.action === 'open' || b.action === 'close') db.prepare('UPDATE classes SET join_open = ? WHERE id = ?').run(b.action === 'open' ? 1 : 0, c.id);
      else return fail(res, 400, 'Ukendt handling');
      return send(res, 200, joinInfo(c));
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/lesson$/)) && m === 'POST') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const b = await readJson(req);
      if (b.action === 'start') {
        const blocked = lessonBlocked();
        if (blocked) return send(res, 409, { error: blocked, needs: lessonBlockedReason() });
        const lic = accounts.canTeach(teacher);
        if (!lic.ok) return send(res, 402, { error: lic.error, needs: 'license' });
        const minutes = U.clampNum(b.minutes, 5, cfg.maxLessonMinutes, classConfig(c.id).lessonMinutes);
        // Skrivetime: eleverne skriver én bestemt aflevering. Den skal høre til denne klasse.
        let write;
        if (b.assignmentId != null && b.assignmentId !== '' && b.assignmentId !== 0) {
          if (!features.writeLesson) return fail(res, 404, 'Ikke slået til på denne server');
          const asg = db.prepare('SELECT id, title FROM assignments WHERE id = ? AND class_id = ?').get(Number(b.assignmentId) || 0, c.id);
          if (!asg) return fail(res, 404, 'Afleveringen findes ikke');
          write = { id: asg.id, title: asg.title };
        } else if ('assignmentId' in b) write = null;
        hub.startLesson(c.id, minutes, write);
      } else if (b.action === 'stop') {
        // all: true = "Afslut for alle". Ellers skriver elever med ekstra tid færdig.
        hub.stopLesson(c.id, { all: b.all === true });
      } else if (b.action === 'extend') {
        // Ekstra tid til enkelte elever (fx ordblinde): samme lektion, bare længere for dem
        const minutes = Number(b.minutes);
        if (![10, 15, 30].includes(minutes)) return fail(res, 400, 'Vælg 10, 15 eller 30 minutter');
        const ids = (Array.isArray(b.studentIds) ? b.studentIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
        if (!ids.length) return fail(res, 400, 'Vælg mindst én elev');
        const own = new Set(db.prepare('SELECT id FROM students WHERE class_id = ?').all(c.id).map(r => r.id));
        if (ids.some(id => !own.has(id))) return fail(res, 404, 'Eleven findes ikke');
        const r = hub.extendLesson(c.id, ids, minutes);
        if (!r.ok) return send(res, 409, { error: r.error });
      } else return fail(res, 400, 'Ukendt handling');
      return send(res, 200, { lesson: hub._lessonInfo(c.id) });
    }
    /* ---- Afleveringer ---- */
    // Samlet oversigt over alle lærerens afleveringer på tværs af klasser
    if (p === '/api/assignments' && m === 'GET') {
      const rows = db.prepare(`SELECT a.id, a.title, a.due, a.home, a.created, c.id AS class_id, c.name AS class_name,
          (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id AND st.enrolled IS NOT NULL) AS students,
          (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS handed,
          (SELECT COUNT(*) FROM assignment_submissions s JOIN documents d ON d.id = s.doc_id WHERE s.assignment_id = a.id AND d.cert_id IS NOT NULL) AS certified,
          (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id AND a.due IS NOT NULL AND s.submitted > a.due) AS late
        FROM assignments a JOIN classes c ON c.id = a.class_id WHERE c.teacher_id = ?
        ORDER BY COALESCE(a.due, 9e15) DESC LIMIT 500`).all(teacher.id);
      return send(res, 200, { assignments: rows.map(r => ({ id: r.id, title: r.title, due: r.due, home: !!r.home, created: r.created, classId: r.class_id, className: r.class_name,
        students: r.students, handed: r.handed, certified: r.certified, late: r.late })) });
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/assignments$/))) {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      if (m === 'GET') {
        const total = db.prepare('SELECT COUNT(*) AS n FROM students WHERE class_id = ? AND enrolled IS NOT NULL').get(c.id).n;
        const rows = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id = a.id) AS handed,
            (SELECT COUNT(*) FROM assignment_submissions s JOIN documents d ON d.id = s.doc_id WHERE s.assignment_id = a.id AND d.cert_id IS NOT NULL) AS certified
          FROM assignments a WHERE a.class_id = ? ORDER BY COALESCE(a.due, a.created) DESC`).all(c.id);
        return send(res, 200, { students: total, assignments: rows.map(r => ({ id: r.id, title: r.title, description: r.description, due: r.due, home: !!r.home, created: r.created, handed: r.handed, certified: r.certified })) });
      }
      if (m === 'POST') {
        const b = await readJson(req);
        const a = assignmentInput(b);
        if (a.error) return fail(res, 400, a.error);
        if (db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?').get(c.id).n >= 300) return fail(res, 400, 'Højst 300 afleveringer pr. klasse – slet nogle gamle');
        const r = db.prepare('INSERT INTO assignments (class_id, title, description, due, created, home) VALUES (?,?,?,?,?,?)').run(c.id, a.title, a.description, a.due, Date.now(), a.home ? 1 : 0);
        hub.assignmentsChanged(c.id);
        return send(res, 200, { id: Number(r.lastInsertRowid) });
      }
    }
    if ((mm = p.match(/^\/api\/assignments\/(\d+)$/))) {
      const asg = db.prepare('SELECT a.* FROM assignments a JOIN classes c ON c.id = a.class_id WHERE a.id = ? AND c.teacher_id = ?').get(Number(mm[1]), teacher.id);
      if (!asg) return fail(res, 404, 'Afleveringen findes ikke');
      if (m === 'GET') {
        // Alle elever i klassen – også dem, der ikke har afleveret
        const rows = db.prepare(`SELECT st.id, st.name, s.doc_id, s.submitted, d.title AS doc_title, d.cert_id, d.result
          FROM students st LEFT JOIN assignment_submissions s ON s.student_id = st.id AND s.assignment_id = ?
          LEFT JOIN documents d ON d.id = s.doc_id
          WHERE st.class_id = ? AND st.enrolled IS NOT NULL ORDER BY st.name`).all(asg.id, asg.class_id);
        return send(res, 200, {
          id: asg.id, classId: asg.class_id, title: asg.title, description: asg.description, due: asg.due, home: !!asg.home, created: asg.created,
          students: rows.map((r) => {
            let reasons = [], place = '', observed, test = docs.testServer;
            try {
              const res = r.result ? JSON.parse(r.result) : {};
              reasons = res.reasons || []; place = (res.facts && res.facts.place) || '';
              if (Array.isArray(res.observed)) observed = res.observed;
              if (typeof res.test === 'boolean') test = res.test;
            } catch (e) { /* */ }
            return { id: r.id, name: r.name, submission: r.doc_id ? { docId: r.doc_id, title: r.doc_title || '', submitted: r.submitted, certId: r.cert_id || null, late: !!(asg.due && r.submitted > asg.due), reasons, place, observed, test } : null };
          }),
        });
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        const a = assignmentInput(Object.assign({ title: asg.title, description: asg.description, due: asg.due, home: !!asg.home }, b));
        if (a.error) return fail(res, 400, a.error);
        db.prepare('UPDATE assignments SET title = ?, description = ?, due = ?, home = ? WHERE id = ?').run(a.title, a.description, a.due, a.home ? 1 : 0, asg.id);
        hub.assignmentsChanged(asg.class_id);
        return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        db.prepare('DELETE FROM assignments WHERE id = ?').run(asg.id);
        hub.assignmentsChanged(asg.class_id);
        return send(res, 200, { ok: true });
      }
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/layout\/auto$/)) && m === 'POST') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      db.prepare('UPDATE classes SET layout_custom = 0 WHERE id = ?').run(c.id);
      gridLayout(c.id);
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/classes\/(\d+)\/layout$/)) && m === 'PUT') {
      const c = ownClass(teacher, mm[1]);
      if (!c) return fail(res, 404, 'Klassen findes ikke');
      const b = await readJson(req, 256 * 1024);
      db.prepare('UPDATE classes SET layout_custom = 1 WHERE id = ?').run(c.id);
      const upd = db.prepare('UPDATE students SET x = ?, y = ? WHERE id = ? AND class_id = ?');
      for (const it of (Array.isArray(b.positions) ? b.positions : []).slice(0, 100)) {
        upd.run(U.clampNum(it.x, 0, 1, 0.5), U.clampNum(it.y, 0, 1, 0.5), Number(it.id), c.id);
      }
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/students\/(\d+)$/))) {
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      if (m === 'PATCH') {
        const b = await readJson(req);
        const name = U.str(b.name, 80).trim();
        if (name) db.prepare('UPDATE students SET name = ? WHERE id = ?').run(name, s.id);
        return send(res, 200, studentOut(db.prepare('SELECT * FROM students WHERE id = ?').get(s.id)));
      }
      if (m === 'DELETE') {
        // Slet elev: også elevens beviser (ingen gravsten – eleven skal helt væk)
        docs.deleteStudentCertificates(s.id);
        db.prepare('DELETE FROM students WHERE id = ?').run(s.id);
        hub.forgetStudent(s.id);
        const dir = path.join(cfg.dataDir, 'evidence', String(s.id));
        fs.rm(dir, { recursive: true, force: true }, () => {});
        hub._broadcastSnapshot(s.class_id);
        return send(res, 200, { ok: true });
      }
    }
    // Eleven har glemt sin kode (eller den er låst): den gamle kode slettes, og læreren får en engangskode på 6 cifre,
    // som eleven skriver i appen inden for 30 minutter. Engangskoden bliver derefter elevens kode.
    if ((mm = p.match(/^\/api\/students\/(\d+)\/reset-pin$/)) && m === 'POST') {
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      const until = Date.now() + 30 * 60_000;
      let code;
      do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); while (weakPin(code));
      db.prepare('UPDATE students SET pin_hash = NULL, pin_reset_hash = ?, pin_reset_until = ?, pin_fails = 0 WHERE id = ?').run(U.hashPassword(code), until, s.id);
      pinRl.refund('pin:' + s.id, 5);
      hub.studentJoined(s.id, s.class_id, `${teacher.name} nulstillede ${s.name}s kode`);
      return send(res, 200, Object.assign(studentOut(db.prepare('SELECT * FROM students WHERE id = ?').get(s.id)), { resetCode: code }));
    }
    if ((mm = p.match(/^\/api\/students\/(\d+)\/invite$/)) && m === 'POST') {
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      hub.revokeStudent(s.id);
      newInvite(s.id);
      hub._broadcastSnapshot(s.class_id);
      return send(res, 200, studentOut(db.prepare('SELECT * FROM students WHERE id = ?').get(s.id)));
    }
    if ((mm = p.match(/^\/api\/students\/(\d+)\/docs$/)) && m === 'GET') {
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      return send(res, 200, { docs: docs.list(s.id) });
    }
    // Afspil skriveforløbet og lighed med andre afleveringer i klassen (kun lærerens egne elever og kun afleverede dokumenter)
    if ((mm = p.match(/^\/api\/docs\/([A-Za-z0-9_-]{16,64})\/(versions|similar)$/)) && m === 'GET') {
      const d = docs.full(mm[1]);
      if (!d || !ownStudent(teacher, d.studentId)) return fail(res, 404, 'Dokumentet findes ikke');
      if (!d.submitted) return fail(res, 409, 'Kan ses, når dokumentet er afleveret');
      if (mm[2] === 'versions') return send(res, 200, { versions: docs.versions(mm[1]) });
      if (!features.similar) return fail(res, 404, 'Ikke slået til på denne server');
      return send(res, 200, { similar: docs.similar(mm[1]) });
    }
    if ((mm = p.match(/^\/api\/docs\/([A-Za-z0-9_-]{16,64})$/)) && m === 'GET') {
      const d = docs.full(mm[1]);
      const s = d && ownStudent(teacher, d.studentId);
      if (!s) return fail(res, 404, 'Dokumentet findes ikke');
      // En kladde kan kun læses, mens klassens lektion kører (ikke når eleven skriver hjemme). Ellers kun titel og omfang.
      if (!d.submitted && !(hub.lessonOf(s.class_id) && !hub.isHome(s.id))) {
        return send(res, 200, { id: d.id, studentId: d.studentId, title: d.title, words: d.words, updated: d.updated, draft: true });
      }
      return send(res, 200, d);
    }
    // Læreren sletter en kladde (kun dokumenter, der ikke er afleveret). Elevens kopi i appen røres ikke.
    if ((mm = p.match(/^\/api\/docs\/([A-Za-z0-9_-]{16,64})$/)) && m === 'DELETE') {
      const d = docs.full(mm[1]);
      const s = d && ownStudent(teacher, d.studentId);
      if (!s) return fail(res, 404, 'Dokumentet findes ikke');
      const r = docs.deleteDraft(d.id, s.id);
      if (!r.ok) return fail(res, 409, r.error);
      hub.docDeleted(s.id, d.id, `${teacher.name} slettede kladden "${d.title || 'Uden titel'}"`);
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/students\/(\d+)\/events$/)) && m === 'GET') {
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      const before = Number(url.searchParams.get('before')) || Date.now() + 60_000;
      const limit = U.clampNum(url.searchParams.get('limit'), 1, 500, 200);
      const kind = url.searchParams.get('kind');
      const lessonOnly = url.searchParams.get('lesson');
      let sql = 'SELECT id, lesson_id, ts, kind, url, title, app, category, blocked, detail, evidence_id FROM events WHERE student_id = ? AND ts < ?';
      const args = [s.id, before];
      if (kind === 'web') sql += " AND kind IN ('nav','blocked')";
      else if (kind === 'alerts') sql += " AND kind IN ('blocked','violation','tamper','killed','evidence','info','teacher','system','hand')";
      else if (kind === 'apps') sql += " AND kind IN ('app','killed')";
      if (lessonOnly) { sql += ' AND lesson_id = ?'; args.push(Number(lessonOnly)); }
      sql += ' ORDER BY ts DESC LIMIT ?';
      args.push(limit);
      const rows = db.prepare(sql).all(...args).map(r => ({
        id: r.id, lessonId: r.lesson_id, ts: r.ts, kind: r.kind, url: r.url, title: r.title, app: r.app,
        category: r.category, blocked: !!r.blocked, evidenceId: r.evidence_id,
        detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch (e) { return null; } })() : null,
      }));
      return send(res, 200, { events: rows });
    }
    if ((mm = p.match(/^\/api\/students\/(\d+)\/export\.csv$/)) && m === 'GET') {
      // Hele elevens log som CSV (indsigtsret, klagesager). Logges i lærer-logbogen.
      const s = ownStudent(teacher, mm[1]);
      if (!s) return fail(res, 404, 'Eleven findes ikke');
      const rows = db.prepare('SELECT e.ts, e.kind, e.url, e.title, e.app, e.category, e.blocked, e.evidence_id, l.started AS lesson_started FROM events e LEFT JOIN lessons l ON l.id = e.lesson_id WHERE e.student_id = ? ORDER BY e.ts').all(s.id);
      const KIND = { nav: 'Side', blocked: 'Blokeret', violation: 'Overtrædelse', tamper: 'Advarsel', killed: 'Lukket', evidence: 'Skærmbillede', info: 'Info', app: 'Program', teacher: 'Lærer', system: 'System' };
      const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
      const lines = [['Tid (UTC)', 'Lektion startet (UTC)', 'Type', 'Titel', 'Adresse', 'Program', 'Kategori', 'Blokeret', 'Skærmbillede-id']]
        .concat(rows.map(r => [iso(r.ts), iso(r.lesson_started), KIND[r.kind] || r.kind, r.title, r.url, r.app, r.category, r.blocked ? 'ja' : '', r.evidence_id || '']));
      const csv = '\ufeff' + lines.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
      hub._audit(s.id, `${teacher.name} eksporterede elevens log`);
      const fname = 'holymoly-' + s.name.replace(/[^\wæøåÆØÅ -]/g, '').replace(/\s+/g, '-').slice(0, 60) + '.csv';
      res.writeHead(200, Object.assign({}, SEC_HEADERS, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="holymoly-elev-${s.id}.csv"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      }));
      return res.end(csv);
    }
    if ((mm = p.match(/^\/api\/evidence\/(\d+)$/)) && m === 'GET') {
      const ev = db.prepare('SELECT e.* FROM evidence e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = s.class_id WHERE e.id = ? AND c.teacher_id = ?').get(Number(mm[1]), teacher.id);
      if (!ev) return fail(res, 404, 'Ikke fundet');
      const file = path.normalize(path.join(cfg.dataDir, 'evidence', ev.file));
      if (!file.startsWith(path.join(cfg.dataDir, 'evidence') + path.sep)) return fail(res, 404, 'Ikke fundet');
      return fs.readFile(file, (err, buf) => {
        if (err) return fail(res, 404, 'Billedet er slettet');
        res.writeHead(200, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }));
        res.end(buf);
      });
    }
    return fail(res, 404, 'Ukendt adresse');
  }

  /** Én linje i loggen ved start: hvad kører, og hvad mangler. */
  function startupLine() {
    const missing = approvalMissingFields();
    return [
      `Udgave: ${cfg.simple ? 'beta' : 'koncept'}`,
      `Server: ${docs.testServer ? 'testserver' : 'skolens'}`,
      missing.length ? `Skolens ja mangler: ${missing.join(', ')}` : 'Skolens ja: udfyldt',
      `Vagt: ${cfg.requireGuard ? 'til' : 'fra'}`,
      `Nøgle: ${docs.keyId}`,
    ].join(' · ');
  }

  /* ---------------------------- helbred ---------------------------- */
  /**
   * /healthz (Docker HEALTHCHECK og Uptime Kuma): databasen svarer, der kan skrives, og signeringsnøglen er indlæst.
   * deep: også nattens backup (højst 36 timer gammel) og fri plads på disken (mindst 1 GB).
   * Returnerer navnene på det, der fejler (tom liste = alt er i orden). Svaret har ingen tal om lektioner eller version.
   */
  const MIN_FREE_BYTES = opts.minFreeBytes ?? 1024 ** 3;
  function health(deep) {
    const bad = [];
    try { db.prepare('SELECT 1').get(); } catch (e) { bad.push('database'); }
    if (!bad.length) {
      try { db.prepare("INSERT INTO meta (key, value) VALUES ('healthz', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now())); } catch (e) { bad.push('disk'); }
    }
    if (!docs.privateKey || !docs.keyId || !fs.existsSync(path.join(cfg.dataDir, 'proof-key.pem'))) bad.push('nøgle');
    if (deep) {
      if (cfg.backupDays) {
        let newest = 0;
        try {
          const dir = path.join(cfg.dataDir, 'backup');
          for (const n of fs.readdirSync(dir)) if (/^holymoly-\d{4}-\d{2}-\d{2}\.db$/.test(n)) newest = Math.max(newest, fs.statSync(path.join(dir, n)).mtimeMs);
        } catch (e) { /* ingen backup-mappe */ }
        if (Date.now() - newest > 36 * 3600_000) bad.push('backup');
      }
      try {
        const st = fs.statfsSync(cfg.dataDir);
        if (st.bavail * st.bsize < MIN_FREE_BYTES && !bad.includes('disk')) bad.push('disk');
      } catch (e) { if (!bad.includes('disk')) bad.push('disk'); }
    }
    return bad;
  }

  /* ---------------------------- server ---------------------------- */
  const server = http.createServer((req, res) => {
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', cspFor(req));
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return fail(res, 400, 'Ugyldig adresse'); }
    if (req.method === 'POST' && (url.pathname === '/api/guard/pair' || url.pathname === '/api/guard/beat')) {
      guardApi(req, res, url.pathname).catch((e) => {
        if (!e.status) log('Vagt-API-fejl', e);
        if (!res.headersSent) sendText(res, e.status || 500, 'ok=0\n');
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e) => {
        if (!e.status) log('API-fejl', e);
        if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Serverfejl');
      });
      return;
    }
    if (url.pathname === '/healthz') {
      const bad = health(url.searchParams.get('deep') === '1');
      return send(res, bad.length ? 503 : 200, bad.length ? 'fejl: ' + bad.join(', ') : 'ok');
    }
    // RFC 9116: hvor forskere melder sikkerhedsfejl. Kun hvis der er en kontakt; Expires er påkrævet.
    if (url.pathname === '/.well-known/security.txt' || url.pathname === '/security.txt') {
      const contact = String(cfg.securityContact || cfg.company.email || '').trim();
      if (!contact || /[\r\n]/.test(contact)) return fail(res, 404, 'Ikke fundet');
      const site = cfg.publicUrl ? cfg.publicUrl.replace(/\/+$/, '') : '';
      const lines = [
        `Contact: ${/^(mailto:|https:\/\/)/i.test(contact) ? contact : 'mailto:' + contact}`,
        `Expires: ${new Date(Date.now() + 365 * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z')}`,
        'Preferred-Languages: da, en',
        ...(site ? [`Canonical: ${site}/.well-known/security.txt`, `Policy: ${site}/sikkerhed`] : []),
      ];
      return send(res, 200, lines.join('\n') + '\n', { 'Cache-Control': 'public, max-age=86400' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Ikke tilladt');
    serveStatic(req, res, url.pathname);
  });

  const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false });
  const wssTeacher = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  // Rummelig grænse: en hel klasse bag samme NAT-IP skal kunne genforbinde samtidig
  const wsRl = new U.RateLimiter(600, 20);

  server.on('upgrade', (req, socket, head) => {
    try { onUpgrade(req, socket, head); } catch (e) { log('Upgrade-fejl', e); socket.destroy(); }
  });
  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { return socket.destroy(); }
    const ip = clientIp(req);
    if (!wsRl.take(ip)) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
    if (url.pathname === '/ws/agent') {
      // Elev-appen forbinder fra hovedprocessen (ingen Origin). En hjemmeside i en browser kan ikke udgive sig for at være appen.
      if (req.headers.origin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
      wssAgent.handleUpgrade(req, socket, head, (ws) => hub.handleAgent(ws, req));
      return;
    }
    if (url.pathname === '/ws/teacher') {
      const teacher = teacherFromReq(req);
      const c = teacher && sameOrigin(req) && !accounts.needs(teacher, teacher.sess) ? ownClass(teacher, url.searchParams.get('classId')) : null;
      if (!c) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
      wssTeacher.handleUpgrade(req, socket, head, (ws) => hub.handleTeacher(ws, teacher, c, teacher.sess.hash));
      return;
    }
    socket.destroy();
  }

  /* ---------------------------- vedligehold ---------------------------- */
  /** Daglig kopi af databasen: <data>/backup/holymoly-ÅÅÅÅ-MM-DD.db (én pr. dag; force = lav dagens igen). Ældre kopier end backupDays slettes. */
  function backup(force = false) {
    if (!cfg.backupDays) return null;
    const dir = path.join(cfg.dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `holymoly-${day}.db`);
    if (force || !fs.existsSync(file)) {
      try { fs.rmSync(file, { force: true }); db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); log('Backup af databasen:', file); } catch (e) { log('Backup fejlede:', e.message); return null; }
      // Signeringsnøglen følger med: uden den kan gamle beviser ikke tjekkes efter en gendannelse
      const key = path.join(cfg.dataDir, 'proof-key.pem');
      try { if (fs.existsSync(key)) fs.copyFileSync(key, path.join(dir, 'proof-key.pem')); } catch (e) { log('Backup af nøglen fejlede:', e.message); }
    }
    const keep = fs.readdirSync(dir).filter(n => /^holymoly-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort().reverse();
    for (const old of keep.slice(cfg.backupDays)) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  }
  function retention() {
    const cutoff = Date.now() - cfg.retentionDays * 86400_000;
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    const old = db.prepare('SELECT id, file FROM evidence WHERE ts < ?').all(cutoff);
    for (const e of old) fs.rm(path.join(cfg.dataDir, 'evidence', e.file), { force: true }, () => {});
    db.prepare('DELETE FROM evidence WHERE ts < ?').run(cutoff);
    // Lampernes tidslinje i lektionen (med grunde som "AI: chatgpt.com") er overvågningsdata ligesom
    // hændelserne – slettes efter samme frist (GDPR art. 5: dataminimering og opbevaringsbegrænsning)
    db.prepare('DELETE FROM lesson_colors WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('DELETE FROM student_sessions WHERE expires < ?').run(Date.now());
    db.prepare('DELETE FROM tokens WHERE expires < ?').run(Date.now());
    // Dokumenter, afspilning, skrivedetaljer og beviser efter fristerne i retention.js
    try { RET.purge(db, cfg.retention, Date.now()); } catch (e) { log('Oprydning af dokumenter fejlede', e); }
    // Skoler, hvis prøveperiode/licens har været udløbet længe nok (kun på licens-servere)
    try { accounts.purgeExpired(); } catch (e) { log('Sletning efter ophør fejlede', e); }
    accounts.pruneSecLog();
  }
  // Serverens kørsel: start og "i live" hvert minut (nedetid mellem to kørsler tæller ikke mod elevernes beviser)
  const runId = Number(db.prepare('INSERT INTO server_runs (start, last_alive) VALUES (?, ?)').run(Date.now(), Date.now()).lastInsertRowid);
  const alive = (clean = 0) => { try { db.prepare('UPDATE server_runs SET last_alive = ?, clean = ? WHERE rowid = ?').run(Date.now(), clean, runId); } catch (e) { /* lukket */ } };
  const timers = [
    setInterval(() => alive(), 60_000),
    setInterval(() => hub.heartbeat(), 20_000),
    setInterval(retention, 3600_000),
    setInterval(backup, 3600_000), // tjekker hver time, laver højst én kopi pr. dag
    setInterval(() => {
      try {
        const st = fs.statSync(overridePath);
        if (st.mtimeMs !== overrideMtime) { loadRules(); hub.rulesChanged(); }
      } catch (e) { /* ingen override */ }
    }, 30_000),
  ];
  timers.forEach(t => t.unref());
  retention();
  backup();

  return {
    cfg, db, hub, server,
    docs, // (til tests)
    retention, // (til tests)
    backup, // (til tests)
    /** Enkel tilstand: engangs-opsætningskoden til den første lærer (null, når der findes en lærer). */
    setupCode: () => accounts.setupCode(),
    /** Enkel tilstand: de felter i skolens ja, der mangler (miljøvariablernes navne). */
    approvalMissing: () => approvalMissingFields(),
    async listen() {
      await proxyTrust.ready; // proxyernes værtsnavne er slået op, før den første forespørgsel kommer
      return new Promise((resolve) => server.listen(cfg.port, cfg.host, () => {
        log(`HolyMoly-server kører på http://${cfg.host}:${server.address().port}`);
        if (cfg.smtpUrl && !cfg.publicUrl) log('ADVARSEL: PUBLIC_URL er ikke sat – links i e-mails kan ikke laves.');
        if (!cfg.smtpUrl && !cfg.simple) log('Bemærk: SMTP_URL er ikke sat – e-mails skrives i loggen og i data/outbox/ i stedet for at blive sendt.');
        const setup = accounts.setupCode();
        if (setup) log('Opsætningskode til første lærer: ' + setup);
        if (cfg.simple && approvalMissingFields().length) log('ADVARSEL: ' + APPROVAL_MISSING + ' Mangler: ' + approvalMissingFields().join(', '));
        else if (lessonBlockedReason() === 'operator') log('ADVARSEL: ' + OPERATOR_MISSING + ' (DBA_DATO, eller SCHOOL_OPERATED=1 og npm run enkel -- overdrag)');
        log(startupLine());
        resolve(server.address().port);
      }));
    },
    close() {
      hub.shuttingDown = true;
      timers.forEach(clearInterval);
      proxyTrust.stop();
      alive(1);
      clearInterval(hub.timer);
      for (const c of wssAgent.clients) c.terminate();
      for (const c of wssTeacher.clients) c.terminate();
      return new Promise((r) => server.close(() => { db.close(); r(); }));
    },
  };
}

module.exports = { createServer, weakPin, APPROVAL_FIELDS };

if (require.main === module) {
  // OWASP A10: en glemt fejl i et løfte må ikke vælte serveren midt i en lektion (alle elever ville blive grå).
  // Den logges og serveren kører videre. En ægte undtagelse (ukendt tilstand) stopper processen –
  // Docker (restart: unless-stopped) og "Start HolyMoly.cmd" starter den igen.
  process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'Uventet fejl (serveren kører videre):', e));
  process.on('uncaughtException', (e) => { console.error(new Date().toISOString(), 'Alvorlig fejl – serveren genstarter:', e); process.exit(1); });
  // Udgaven (beta = enkel tilstand til skolen, koncept = den fulde udgave) står i server/edition.json
  let edition = {};
  try { edition = require('../edition.json'); } catch (e) { /* ingen fil = den fulde udgave */ }
  // SIMPLE=1/0 i miljøet går forud for edition.json. Tom (fx "SIMPLE=" i compose) tæller som ikke sat.
  const envSimple = String(process.env.SIMPLE ?? '').trim();
  const simple = envSimple ? envSimple === '1' : !!edition.simple;
  const s = createServer({ simple });
  s.listen();
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
