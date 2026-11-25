'use strict';
/*
 * Hub: holder styr på forbundne elev-apps (agents) og lærer-dashboards og
 * formidler status, kommandoer og skærmbilleder mellem dem.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256, str, encodeFrame, decodeFrame, isJpeg, RateLimiter } = require('./util');
const D = require('../../shared/doc.js');

// Hændelser elev-appen må sende. 'teacher' (lærer-logbogen) kan kun skrives af serveren selv.
const EVENT_KINDS = new Set(['nav', 'app', 'blocked', 'violation', 'tamper', 'killed', 'info']);
const MAX_EVENTS_PER_LESSON = 20_000;
const MAX_EVIDENCE_PER_LESSON = 200;
const MAX_TABS = 60;
const MAX_APPS = 120;
const STALE_MS = 20_000; // ingen status i 20 sek -> grå
const HOME_NO_SCREEN = 'Skriveøkt hjemme: skærmen kan ikke ses';
/*
 * Hjemme har én fast profil: kun AI, fjernstyring og virtuelle maskiner blokeres, intet lukkes,
 * og der tages aldrig skærmbilleder. Læreren ser kun "Skriver hjemme", lampen og kategorien.
 */
const HOME_CATEGORIES = ['ai', 'remote', 'vm'];
const HOME_ACTIVITY = 'Skriver hjemme';
const HOME_EVENT_KINDS = new Set(['info', 'blocked', 'violation', 'tamper', 'killed']);
const CATEGORY_TEXT = { ai: 'AI / chatbots', remote: 'Fjernstyring', vm: 'Virtuel maskine' };
function homeConfig(config) {
  const c = Object.assign({}, config || {});
  return Object.assign(c, {
    categories: HOME_CATEGORIES.slice(), killApps: false, autoEvidence: false, profile: 'skriv',
    extraBlocked: [], extraBlockedApps: [], examMode: false, examAllowed: [], examAllowedApps: [],
  });
}
/** Hjemme: kun rødt for ai, fjernstyring og vm – og kun med kategorien som tekst. */
function homeViolations(list) {
  const out = [];
  for (const v of list || []) {
    if (HOME_CATEGORIES.includes(v.category) && !out.some(o => o.category === v.category)) out.push({ kind: v.kind, text: CATEGORY_TEXT[v.category], category: v.category });
  }
  return out;
}
function hostOnly(u) {
  try { return new URL(String(u)).hostname.slice(0, 253); } catch (e) { return ''; }
}

function versionLt(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** En klasselektion går altid forud for en skriveøkt; ellers den nyeste. */
function preferLesson(l, cur) {
  const ls = !!l.assignmentId, cs = !!cur.assignmentId;
  if (ls !== cs) return !ls;
  return l.started > cur.started;
}

class Hub {
  constructor({ db, dataDir, getRules, classConfig, log, staleMs, minAgentVersion, minExtensionVersion, downloadUrl, requireGuard, compileFor, docs, publicUrl, lessonBlocked }) {
    // Enkel tilstand: skolens ja mangler -> ingen lektioner og ingen skriveøkter (returnerer en besked eller null)
    this.lessonBlocked = lessonBlocked || (() => null);
    this.docs = docs || null;           // "Skriv i HolyMoly" (server/src/docs.js)
    this.publicUrl = publicUrl || '';
    this.requireGuard = !!requireGuard;
    this.compileFor = compileFor || null;
    this.guardReports = new Map(); // studentId -> { ts, violations, kill, seen }
    this.pairCodes = new Map(); // studentId -> { code, exp } (vagtens engangs-parringskode)
    this.guardAlerts = new Map(); // studentId -> [{ text, until }] (fx to vagter på samme computer)
    this.writing = new Map(); // studentId -> dokument-id der skrives på (lampen følges løbende)
    this.solo = new Map();    // studentId -> skriveøkt uden for timen { id, started, endsAt, assignmentId, title }
    this.soloQuota = new Map(); // studentId -> { day, n, last } – mod oversvømmelse af skriveøkter
    this.hands = new Map(); // studentId -> tidspunkt eleven rakte hånden op (kun under lektionen)
    this.lastColor = new Map(); // studentId -> { lessonId, color } (til lektionsrapporten)
    this.staleMs = staleMs || STALE_MS;
    this.minAgentVersion = minAgentVersion || '';
    this.minExtensionVersion = minExtensionVersion || '';
    this.downloadUrl = downloadUrl || '';
    this.db = db;
    this.dataDir = dataDir;
    this.getRules = getRules;
    this.classConfig = classConfig;
    this.log = log || (() => {});
    this.agentConns = new Set();
    this.agentByStudent = new Map(); // studentId -> conn
    this.status = new Map(); // studentId -> seneste status (summary)
    this.detail = new Map(); // studentId -> {tabs, apps}
    this.teachers = new Map(); // classId -> Set<tconn>
    this.watchers = new Map(); // studentId -> Set<tconn>
    this.frozen = new Map(); // studentId -> { message, mode: 'freeze' | 'review' }
    this.closed = new Map(); // studentId -> {ts, reason}
    this.lessons = new Map(); // classId -> {id, endsAt, started}
    this.studentClass = new Map(); // cache studentId -> classId (kun til visning – aldrig til adgangskontrol)
    this.limits = new Map(); // studentId -> { rl, evidenceRl, events, evidence, lessonId } – overlever genforbindelser

    const now = Date.now();
    // Skriveøkter (én elev) overlever ikke en genstart – ellers ville de blive til en lektion for hele klassen
    db.prepare('UPDATE lessons SET ended = MIN(ends_at, ?) WHERE student_id IS NOT NULL AND ended IS NULL').run(now);
    for (const l of db.prepare('SELECT * FROM lessons WHERE ended IS NULL AND student_id IS NULL').all()) {
      if (l.ends_at > now) this.lessons.set(l.class_id, { id: l.id, endsAt: l.ends_at, started: l.started });
      else db.prepare('UPDATE lessons SET ended = ? WHERE id = ?').run(l.ends_at, l.id);
    }
    this._q = {
      student: db.prepare('SELECT id, class_id, name FROM students WHERE id = ?'),
      studentByToken: db.prepare('SELECT s.id, s.class_id, s.name, c.name AS class_name, t.name AS teacher_name FROM students s JOIN classes c ON c.id = s.class_id JOIN teachers t ON t.id = c.teacher_id WHERE s.device_token_hash = ?'),
      insertEvent: db.prepare('INSERT INTO events (student_id, lesson_id, ts, kind, url, title, app, category, blocked, detail, evidence_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      insertEvidence: db.prepare('INSERT INTO evidence (student_id, lesson_id, ts, file, reason) VALUES (?,?,?,?,?)'),
      studentsOfClass: db.prepare('SELECT id FROM students WHERE class_id = ?'),
    };
    this.timer = setInterval(() => this._tick(), Math.min(3_000, Math.max(100, this.staleMs / 4)));
    this.timer.unref();
  }

  /* ------------------------------ lektioner ------------------------------ */

  lessonOf(classId) {
    const l = this.lessons.get(classId);
    if (l && l.endsAt > Date.now()) return l;
    return null;
  }
  /** Skriveøkt for én elev (en aflevering skrives hjemme). */
  soloOf(sid) {
    const s = this.solo.get(sid);
    return s && s.endsAt > Date.now() ? s : null;
  }
  /** Er eleven "i lektion"? Klassens lektion – eller elevens egen skriveøkt. */
  lessonFor(sid, classId = this.studentClass.get(sid)) {
    return (classId != null && this.lessonOf(classId)) || this.soloOf(sid);
  }
  /**
   * Skriver eleven hjemme lige nu (skriveøkt uden klassens lektion)? Så ser læreren hverken skærm,
   * skærmbilleder, faner eller apps – kun at eleven skriver, og hvad HolyMoly har blokeret.
   */
  isHome(sid) {
    const l = this.lessonFor(sid);
    return !!(l && l.assignmentId);
  }

  /**
   * Hvad gælder for eleven lige nu? kind 'hjemme' (skriveøkt uden klassens lektion) eller 'klasse'.
   * Hjemme-profilen er fast og håndhæves både her (hændelser, status, vagt) og i elevens app.
   */
  policyFor(sid, classId = this.studentClass.get(sid)) {
    let config = {};
    try { config = (classId != null && this.classConfig(classId)) || {}; } catch (e) { config = {}; }
    const observed = this.requireGuard ? ['skrivevindue', 'vagt'] : ['skrivevindue'];
    if (this.isHome(sid)) return { kind: 'hjemme', observed, config: homeConfig(config) };
    return { kind: 'klasse', observed, config };
  }

  /**
   * Skriveøkt: eleven skriver en aflevering uden for timen. Kun elevens egen computer overvåges og blokeres
   * – præcis som i en lektion – og kun mens skrivevinduet er åbent (højst 3 timer, aldrig efter fristen).
   */
  startSolo(sid, asg, conn) {
    const now = Date.now();
    if (this.lessonFor(sid)) return { ok: false, error: 'Du er allerede i en lektion – skriv bare' };
    // Er eleven i en lektion i en ANDEN klasse (samme computer), må en skriveøkt ikke trække computeren ud af den
    const others = conn ? [...conn.students.values()] : [];
    if (others.some(s => this.lessonOf(s.class_id) || this.soloOf(s.id))) return { ok: false, error: 'Du er i en lektion lige nu – skriv i timen i stedet' };
    // Højst én ny skriveøkt hvert 30. sekund og 20 om dagen pr. elev
    const day = new Date(now).toISOString().slice(0, 10);
    const q = this.soloQuota.get(sid);
    const quota = q && q.day === day ? q : { day, n: 0, last: 0 };
    if (now - quota.last < 30_000) return { ok: false, error: 'Vent et øjeblik, før du starter igen' };
    if (quota.n >= 20) return { ok: false, error: 'Du har startet for mange skriveøkter i dag' };
    quota.n++; quota.last = now;
    this.soloQuota.set(sid, quota);
    const endsAt = Math.min(now + 3 * 3600_000, asg.due ? asg.due + 5 * 60_000 : Infinity);
    if (endsAt <= now + 60_000) return { ok: false, error: 'Fristen for afleveringen er overskredet' };
    const classId = this.studentClass.get(sid);
    const r = this.db.prepare('INSERT INTO lessons (class_id, started, ends_at, student_id) VALUES (?,?,?,?)').run(classId, now, endsAt, sid);
    this.solo.set(sid, { id: Number(r.lastInsertRowid), started: now, endsAt, assignmentId: asg.id, title: asg.title });
    this.closed.delete(sid);
    this._q.insertEvent.run(sid, Number(r.lastInsertRowid), now, 'info', null, `Startede en skriveøkt til "${asg.title}"`.slice(0, 500), null, null, 0, null, null);
    this._soloChanged(sid);
    return { ok: true, endsAt };
  }
  endSolo(sid) {
    const s = this.solo.get(sid);
    if (!s) return;
    this.solo.delete(sid);
    this.db.prepare('UPDATE lessons SET ended = ? WHERE id = ?').run(Math.min(Date.now(), s.endsAt), s.id);
    this.status.delete(sid);
    this.detail.delete(sid);
    this.closed.delete(sid);
    this._soloChanged(sid);
  }
  _soloChanged(sid) {
    // Kigger en lærer med, når skriveøkten starter, lukkes der for skærm og faner
    if (this.isHome(sid)) { this.detail.delete(sid); this._dropWatchers(sid, HOME_NO_SCREEN); }
    const conn = this.agentByStudent.get(sid);
    if (conn) this._assignActive(conn);
    this._pushStudent(sid);
  }
  /** Lærere, der kigger med på eleven, holder op med det (skærm og faner forsvinder fra dashboardet). */
  _dropWatchers(sid, message) {
    const w = this.watchers.get(sid);
    if (!w) return;
    for (const t of [...w]) {
      this._unwatch(t);
      this._sendTeacher(t, { type: 'detail', studentId: sid, detail: { tabs: [], apps: [] } });
      if (message) this._sendTeacher(t, { type: 'error', message });
    }
    this.watchers.delete(sid);
  }

  startLesson(classId, minutes) {
    const now = Date.now();
    const existing = this.lessonOf(classId);
    // Ny lektion starter aldrig med frosne skærme fra sidst
    if (!existing) for (const r of this._q.studentsOfClass.all(classId)) this.frozen.delete(r.id);
    if (existing) {
      existing.endsAt = now + minutes * 60_000;
      this.db.prepare('UPDATE lessons SET ends_at = ? WHERE id = ?').run(existing.endsAt, existing.id);
    } else {
      const r = this.db.prepare('INSERT INTO lessons (class_id, started, ends_at) VALUES (?,?,?)').run(classId, now, now + minutes * 60_000);
      this.lessons.set(classId, { id: Number(r.lastInsertRowid), endsAt: now + minutes * 60_000, started: now });
      for (const { id } of this._q.studentsOfClass.all(classId)) this.closed.delete(id);
      // En klasselektion går forud for skriveøkter på de samme computere
      for (const conn of this.agentConns) {
        if (![...conn.students.values()].some(s => s.class_id === classId)) continue;
        for (const sid of conn.students.keys()) if (this.solo.has(sid)) this.endSolo(sid);
      }
    }
    this._lessonChanged(classId);
    return this.lessons.get(classId);
  }

  stopLesson(classId) {
    const l = this.lessons.get(classId);
    if (!l) return;
    this.db.prepare('UPDATE lessons SET ended = ? WHERE id = ?').run(Date.now(), l.id);
    this.lessons.delete(classId);
    for (const { id } of this._q.studentsOfClass.all(classId)) {
      this.frozen.delete(id);
      this.hands.delete(id);
      this.lastColor.delete(id);
      this.closed.delete(id);
      this.status.delete(id);
      this.detail.delete(id);
    }
    this._lessonChanged(classId);
  }

  _lessonChanged(classId) {
    for (const conn of this.agentConns) {
      if ([...conn.students.values()].some(s => s.class_id === classId)) this._assignActive(conn);
    }
    this._broadcastClass(classId, { type: 'lesson', lesson: this._lessonInfo(classId) });
    this._broadcastSnapshot(classId);
  }

  _lessonInfo(classId) {
    const l = this.lessonOf(classId);
    return l ? { live: true, id: l.id, started: l.started, endsAt: l.endsAt } : { live: false };
  }

  _tick() {
    const now = Date.now();
    for (const [sid, s] of this.solo) if (s.endsAt <= now) this.endSolo(sid);
    // "Skriv i HolyMoly": serveren følger selv lampen, mens eleven skriver (ikke kun ved gemning)
    if (this.docs) {
      for (const [sid, docId] of this.writing) {
        const classId = this.studentClass.get(sid);
        if (this.lessonFor(sid, classId)) this.docs.observe(docId, this.studentView(sid), now);
        else this.docs.pause(docId);
      }
    }
    for (const [classId, l] of this.lessons) {
      if (l.endsAt <= now) this.stopLesson(classId);
    }
    // Vagten er gået i stå -> opdater lærerens skærm (selv om elev-appen er stille)
    for (const [sid, rep] of this.guardReports) {
      const stale = now - rep.ts >= 25_000;
      if (stale !== !!rep.staleNotified) { rep.staleNotified = stale; this._pushStudent(sid); }
    }
    // Ingen status fra appen i 20 sek -> grå i dashboardet
    for (const [sid, st] of this.status) {
      const stale = now - st.recv > this.staleMs;
      if (st.stale !== stale) {
        st.stale = stale;
        this._pushStudent(sid);
      }
    }
  }

  /* ------------------------------ elev-apps ------------------------------ */

  handleAgent(ws, req) {
    const conn = {
      ws, ip: req.socket.remoteAddress, students: new Map(), active: null,
      helloDone: false, streamMode: null, frameRl: new RateLimiter(20, 8),
      byeReason: null, alive: true, device: null, screenshotUntil: 0, violationUntil: 0,
    };
    const helloTimer = setTimeout(() => { if (!conn.helloDone) ws.close(4400, 'hello timeout'); }, 15_000);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) return this._agentBinary(conn, data);
        if (data.length > 256 * 1024) return;
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return; }
        if (!msg || typeof msg.type !== 'string') return;
        if (!conn.helloDone) {
          if (msg.type !== 'hello') return ws.close(4400, 'expected hello');
          clearTimeout(helloTimer);
          return this._agentHello(conn, msg);
        }
        const lim = conn.active ? this._limits(conn.active) : null;
        if (lim && !lim.rl.take('m', msg.type === 'events' ? Math.max(1, Math.min(500, (msg.items || []).length)) : 1)) return;
        this._agentMessage(conn, msg);
      } catch (e) {
        this.log('agent message error', e);
      }
    });
    ws.on('close', () => { clearTimeout(helloTimer); this._agentClosed(conn); });
    ws.on('error', () => {});
  }

  _agentHello(conn, msg) {
    const tokens = Array.isArray(msg.tokens) ? msg.tokens.slice(0, 20) : [];
    for (const t of tokens) {
      if (typeof t !== 'string' || t.length < 20 || t.length > 200) continue;
      const row = this._q.studentByToken.get(sha256(t));
      if (row) conn.students.set(row.id, row);
    }
    if (conn.students.size === 0) {
      this._send(conn, { type: 'error', code: 'unauthorized', message: 'Din kode er ikke længere gyldig. Bed din lærer om en ny.' });
      return conn.ws.close(4401, 'unauthorized');
    }
    conn.helloDone = true;
    conn.device = {
      // Computerens navn (host) gemmes ikke – det er ofte elevens navn. Appen sender et tilfældigt id.
      os: str(msg.device && msg.device.os, 40), id: str(msg.device && msg.device.id, 32),
      version: str(msg.device && msg.device.version, 20),
    };
    const invalid = tokens.length - conn.students.size;
    // For gammel app -> forbundet, men får ingen lektion (grå "Skal opdatere") indtil den er opdateret
    conn.outdated = !!(this.minAgentVersion && versionLt(conn.device.version, this.minAgentVersion));
    for (const [sid, s] of conn.students) {
      this.studentClass.set(sid, s.class_id);
      const old = this.agentByStudent.get(sid);
      if (old && old !== conn) {
        old.students.delete(sid);
        this._send(old, { type: 'replaced', studentId: sid });
        if (old.students.size === 0) old.ws.close(4409, 'replaced');
        else this._assignActive(old);
      }
      this.agentByStudent.set(sid, conn);
      this.db.prepare('UPDATE students SET device_info = ? WHERE id = ?').run(JSON.stringify(conn.device), sid);
    }
    this.agentConns.add(conn);
    // Parringskoder til vagten (kun for elever hvis computer ikke allerede har en tilknyttet vagt)
    const guardPair = {};
    for (const [sid] of conn.students) {
      const row = this.db.prepare('SELECT guard_pubkey FROM students WHERE id = ?').get(sid);
      if (row && !row.guard_pubkey) {
        // Samme kode så længe den gælder: en ekstra forbindelse (fx et script) må ikke kunne ugyldiggøre
        // den kode, den rigtige app allerede har givet vagten
        let pc = this.pairCodes.get(sid);
        const cur = this.db.prepare('SELECT guard_pair_hash, guard_pair_expires FROM students WHERE id = ?').get(sid);
        if (!pc || pc.exp < Date.now() + 60_000 || !cur || cur.guard_pair_hash !== sha256(pc.code)) {
          pc = { code: require('node:crypto').randomBytes(24).toString('base64url'), exp: Date.now() + 15 * 60_000 };
          this.pairCodes.set(sid, pc);
          this.db.prepare('UPDATE students SET guard_pair_hash = ?, guard_pair_expires = ? WHERE id = ?').run(sha256(pc.code), pc.exp, sid);
        }
        guardPair[sid] = pc.code;
      }
    }
    this._send(conn, {
      type: 'welcome', guardPair,
      enrollments: [...conn.students.values()].map(s => ({ studentId: s.id, studentName: s.name, className: s.class_name, teacherName: s.teacher_name })),
      invalidTokens: invalid,
      rules: this.getRules(),
      serverTime: Date.now(),
      updateRequired: conn.outdated, minAgentVersion: this.minAgentVersion,
      minExtensionVersion: this.minExtensionVersion, downloadUrl: this.downloadUrl,
    });
    this._assignActive(conn);
    for (const s of conn.students.values()) this._pushStudent(s.id);
    this._sendAssignments(conn);
  }

  /* ---------- Afleveringer ---------- */
  /** Elevens afleveringer i alle klasser på forbindelsen (med elevens egen vedhæftning). */
  _sendAssignments(conn) {
    const items = [];
    const q = this.db.prepare(`SELECT a.id, a.title, a.description, a.due, a.created, a.home, c.name AS class_name,
        s.doc_id, s.submitted, d.title AS doc_title, d.cert_id
      FROM assignments a JOIN classes c ON c.id = a.class_id
      LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = ?
      LEFT JOIN documents d ON d.id = s.doc_id
      WHERE a.class_id = ? ORDER BY COALESCE(a.due, a.created) LIMIT 100`);
    for (const st of conn.students.values()) {
      for (const r of q.all(st.id, st.class_id)) {
        items.push({ id: r.id, studentId: st.id, className: r.class_name, title: r.title, description: r.description, due: r.due, created: r.created, home: !!r.home,
          submission: r.doc_id ? { docId: r.doc_id, title: r.doc_title || '', submitted: r.submitted, certified: !!r.cert_id } : null });
      }
    }
    this._send(conn, { type: 'assignments', items });
  }
  /** Læreren har oprettet/ændret/slettet en aflevering: elevernes apps opdateres. */
  assignmentsChanged(classId) {
    for (const conn of this.agentConns) {
      if ([...conn.students.values()].some(s => s.class_id === classId)) this._sendAssignments(conn);
    }
    this._broadcastClass(classId, { type: 'assignments' });
  }

  /** Finder den elev-tilmelding på forbindelsen der har en igangværende lektion. */
  _assignActive(conn) {
    let best = null;
    for (const s of (conn.outdated ? [] : conn.students.values())) {
      const l = this.lessonFor(s.id, s.class_id);
      if (l && (!best || preferLesson(l, best.lesson))) best = { student: s, lesson: l };
    }
    const prev = conn.active;
    conn.active = best ? { studentId: best.student.id, classId: best.student.class_id, lessonId: best.lesson.id, endsAt: best.lesson.endsAt, solo: !!best.lesson.assignmentId } : null;
    if (conn.active && (!prev || prev.lessonId !== conn.active.lessonId)) conn.activeSince = Date.now();
    const changed = !prev !== !conn.active || (prev && conn.active && (prev.lessonId !== conn.active.lessonId || prev.endsAt !== conn.active.endsAt || prev.studentId !== conn.active.studentId));
    if (changed || !conn.lessonSent) {
      conn.lessonSent = true;
      if (conn.active) {
        const s = best.student;
        const solo = best.lesson.assignmentId ? best.lesson : null;
        this._send(conn, {
          type: 'lesson', live: true, studentId: s.id, className: solo ? `Skriveøkt: ${solo.title}` : s.class_name, teacherName: s.teacher_name,
          studentName: s.name, endsAt: best.lesson.endsAt, config: this.policyFor(s.id, s.class_id).config,
          solo: solo ? { assignmentId: solo.assignmentId, title: solo.title } : null,
        });
      } else {
        this._send(conn, { type: 'lesson', live: false });
      }
      if (prev && (!conn.active || prev.studentId !== conn.active.studentId)) {
        this.status.delete(prev.studentId);
        this._pushStudent(prev.studentId);
      }
    }
    if (conn.active) {
      const fz = this.frozen.get(conn.active.studentId);
      const l = this.lessonOf(conn.active.classId);
      this._send(conn, { type: 'freeze', on: !!fz, message: fz ? fz.message : '', mode: fz ? fz.mode : 'freeze', endsAt: l ? l.endsAt : 0, startedAt: l ? l.started : 0 });
    }
    this._updateStream(conn);
  }

  _agentMessage(conn, msg) {
    const a = conn.active;
    switch (msg.type) {
      case 'status': {
        if (!a) return;
        const st = this._sanitizeStatus(msg);
        // Hjemme gemmes hverken adresse, program eller vinduestitel – kun kategorien for rødt
        if (a.solo) Object.assign(st, { activity: HOME_ACTIVITY, url: '', app: '', violations: homeViolations(st.violations) });
        const prev = this.status.get(a.studentId);
        // Ny overtrædelse -> ét skærmbillede som dokumentation må følge med
        const key = (v) => v.map(x => x.kind + '|' + x.text).join('\n');
        if (st.violations.length && (!prev || key(prev.violations) !== key(st.violations)) && this._autoEvidence(a.studentId)) conn.violationUntil = Date.now() + 30_000;
        this.status.set(a.studentId, st);
        if (prev && prev.stale !== st.stale) { /* nyt liv */ }
        this._pushStudent(a.studentId);
        // Hjemme sendes faner og apps aldrig videre til læreren – og de gemmes heller ikke
        if ((msg.tabs || msg.apps) && !a.solo) {
          const d = this.detail.get(a.studentId) || { tabs: [], apps: [] };
          if (Array.isArray(msg.tabs)) d.tabs = msg.tabs.slice(0, MAX_TABS).map(t => ({ url: str(t.url, 1000), title: str(t.title, 200), active: !!t.active, browser: str(t.browser, 20) }));
          if (Array.isArray(msg.apps)) d.apps = msg.apps.slice(0, MAX_APPS).map(x => ({ name: str(x.name, 80), category: str(x.category, 20), blocked: !!x.blocked }));
          this.detail.set(a.studentId, d);
          this._pushDetail(a.studentId);
        }
        break;
      }
      case 'events': {
        if (!Array.isArray(msg.items)) return;
        if (a) {
          for (const it of msg.items.slice(0, 500)) this._insertEvent(a, it);
        }
        // Kvittér selv om lektionen er slut, så appen ikke bliver ved med at sende.
        this._send(conn, { type: 'ack', seq: Number(msg.seq) || 0 });
        break;
      }
      case 'bye': {
        conn.byeReason = str(msg.reason, 40) || 'quit';
        break;
      }
      case 'hand': {
        // "Ræk hånden op": kun under lektionen
        if (!a) return;
        const up = !!msg.up;
        if (up === this.hands.has(a.studentId)) return;
        if (up) {
          this.hands.set(a.studentId, Date.now());
          if (!this.shuttingDown) {
            const ins = this._q.insertEvent.run(a.studentId, a.lessonId, Date.now(), 'hand', null, 'Rakte hånden op', null, null, 0, null, null);
            this._broadcastToWatchers(a.studentId, { type: 'event', studentId: a.studentId, event: { id: Number(ins.lastInsertRowid), ts: Date.now(), kind: 'hand', title: 'Rakte hånden op' } });
          }
        } else this.hands.delete(a.studentId);
        this._pushStudent(a.studentId);
        break;
      }
      // "Skriv i HolyMoly": kun under en lektion (så er HolyMoly selv vidne til skriveforløbet)
      case 'doc': {
        if (!this.docs) return;
        const id = str(msg.id, 64);
        if (!a) return this._send(conn, { type: 'doc-saved', id, ok: false, error: 'Du kan kun skrive i HolyMoly, mens en lektion er i gang' });
        const now = Date.now();
        if (now - (conn.lastDocSave || 0) < 1500) return this._send(conn, { type: 'doc-saved', id, ok: false, error: 'busy' });
        conn.lastDocSave = now;
        const student = this._q.student.get(a.studentId);
        const r = this.docs.save(student, msg, this.studentView(a.studentId), a.lessonId, now, now - (conn.activeSince || now));
        if (r.ok) this.writing.set(a.studentId, id);
        this._send(conn, { type: 'doc-saved', id, ok: r.ok, error: r.error || '', ts: now, preview: r.preview || null });
        if (r.ok && !conn.docAnnounced?.has(id)) {
          (conn.docAnnounced = conn.docAnnounced || new Set()).add(id);
          this._broadcastToWatchers(a.studentId, { type: 'docs', studentId: a.studentId });
        }
        break;
      }
      case 'doc-submit': {
        if (!this.docs) return;
        const id = str(msg.id, 64);
        if (!a) return this._send(conn, { type: 'doc-result', id, ok: false, error: 'Aflevering kræver at lektionen er i gang' });
        const meta = this.db.prepare('SELECT s.id, s.class_id, s.name AS student, c.name AS class, t.name AS teacher FROM students s JOIN classes c ON c.id = s.class_id JOIN teachers t ON t.id = c.teacher_id WHERE s.id = ?').get(a.studentId);
        // Den endelige version kommer med afleveringen (så der aldrig udstedes bevis for en ældre version)
        if (Array.isArray(msg.blocks)) {
          const sv = this.docs.save({ id: meta.id, class_id: meta.class_id }, msg, this.studentView(a.studentId), a.lessonId, Date.now(), Date.now() - (conn.activeSince || Date.now()));
          if (!sv.ok && !/afleveret/.test(sv.error || '')) return this._send(conn, { type: 'doc-result', id, ok: false, error: sv.error });
        }
        const r = this.docs.submit({ id: meta.id, class_id: meta.class_id }, id, { studentName: meta.student, className: meta.class, teacherName: meta.teacher, issuer: this.publicUrl, view: this.studentView(a.studentId), force: msg.force === true });
        if (r.ok && this.writing.get(a.studentId) === id) this.writing.delete(a.studentId);
        this._send(conn, Object.assign({ type: 'doc-result', id }, r));
        if (r.ok && !r.already && !this.shuttingDown) {
          const l = this.lessonOf(meta.class_id);
          const doc = this.docs.full(id);
          const text = r.certId ? `Afleverede "${doc.title || 'Uden titel'}" med skrive-bevis` : `Afleverede "${doc.title || 'Uden titel'}" uden bevis: ${r.reasons.join('; ')}`;
          const ins = this._q.insertEvent.run(a.studentId, l ? l.id : null, Date.now(), 'info', null, text.slice(0, 500), null, null, 0, null, null);
          this._broadcastToWatchers(a.studentId, { type: 'event', studentId: a.studentId, event: { id: Number(ins.lastInsertRowid), ts: Date.now(), kind: 'info', title: text.slice(0, 500) } });
          this._broadcastToWatchers(a.studentId, { type: 'docs', studentId: a.studentId });
        }
        break;
      }
      case 'doc-delete': {
        // Eleven sletter en kladde i skrivevinduet (også uden for lektionen). Afleverede dokumenter kan ikke slettes.
        if (!this.docs) return;
        const id = str(msg.id, 64);
        const reply = (ok, error) => this._send(conn, { type: 'doc-deleted', id, ok, error: error || '' });
        const row = this.db.prepare('SELECT student_id FROM documents WHERE id = ?').get(id);
        if (!row || !conn.students.has(row.student_id)) return reply(true); // findes ikke hos serveren: intet at slette
        const r = this.docs.deleteDraft(id, row.student_id);
        if (!r.ok) return reply(false, r.error);
        this.docDeleted(row.student_id, id, `Eleven slettede kladden "${r.title || 'Uden titel'}"`);
        return reply(true);
      }
      case 'write-session': {
        // Eleven åbner/lukker en skriveøkt til en aflevering, der må skrives hjemme
        const aid = Number(msg.assignmentId) || 0;
        const reply = (ok, error, endsAt) => this._send(conn, { type: 'write-session-result', assignmentId: aid, ok, error: error || '', endsAt: endsAt || 0 });
        if (!msg.on) {
          for (const sid of conn.students.keys()) if (this.solo.has(sid) && (!aid || this.solo.get(sid).assignmentId === aid)) this.endSolo(sid);
          return reply(true);
        }
        const asg = this.db.prepare('SELECT id, class_id, title, due, home FROM assignments WHERE id = ?').get(aid);
        const st = asg && [...conn.students.values()].find(s => s.class_id === asg.class_id);
        if (!st) return reply(false, 'Afleveringen findes ikke');
        if (!asg.home) return reply(false, 'Din lærer har ikke åbnet for at skrive denne aflevering uden for timen');
        if (conn.outdated) return reply(false, 'HolyMoly skal opdateres først');
        const blocked = this.lessonBlocked();
        if (blocked) return reply(false, blocked);
        const r = this.startSolo(st.id, asg, conn);
        return reply(r.ok, r.error, r.endsAt);
      }
      case 'assignment-attach': {
        // Eleven vedhæfter et afleveret HolyMoly-dokument til en opgave (også uden for lektionen)
        const aid = Number(msg.assignmentId) || 0;
        const docId = str(msg.docId, 64);
        const reply = (ok, error) => this._send(conn, { type: 'assignment-result', assignmentId: aid, ok, error: error || '' });
        const now = Date.now();
        if (now - (conn.lastAttach || 0) < 1000) return reply(false, 'Vent et øjeblik og prøv igen');
        conn.lastAttach = now;
        const asg = this.db.prepare('SELECT id, class_id, title, due, created FROM assignments WHERE id = ?').get(aid);
        const st = asg && [...conn.students.values()].find(s => s.class_id === asg.class_id);
        if (!st) return reply(false, 'Afleveringen findes ikke');
        const doc = this.db.prepare('SELECT id, title, submitted, cert_id, created, result FROM documents WHERE id = ? AND student_id = ?').get(docId, st.id);
        if (!doc) return reply(false, 'Dokumentet findes ikke hos HolyMoly. Skriv det i HolyMoly under en lektion.');
        if (!doc.submitted) return reply(false, 'Afslut dokumentet først (knappen "Afslut dokument")');
        // Et dokument skrevet før afleveringen blev lagt ud – eller allerede afleveret til en anden – kan ikke bruges
        if (doc.created < asg.created - 10 * 60_000) return reply(false, 'Dokumentet er skrevet, før afleveringen blev lagt ud. Skriv en ny besvarelse.');
        if (this.db.prepare('SELECT 1 FROM assignment_submissions WHERE doc_id = ? AND assignment_id != ?').get(doc.id, asg.id)) return reply(false, 'Dokumentet er allerede afleveret til en anden aflevering');
        this.db.prepare(`INSERT INTO assignment_submissions (assignment_id, student_id, doc_id, submitted) VALUES (?,?,?,?)
          ON CONFLICT(assignment_id, student_id) DO UPDATE SET doc_id = excluded.doc_id, submitted = excluded.submitted`).run(asg.id, st.id, doc.id, now);
        reply(true);
        this._sendAssignments(conn);
        if (!this.shuttingDown) {
          const late = asg.due && now > asg.due ? ' (efter fristen)' : '';
          const text = `Afleverede "${doc.title || 'Uden titel'}" til ${asg.title}${late}${doc.cert_id ? ' – ' + D.label(((JSON.parse(doc.result || '{}').facts) || {}).place) : ' – uden mærke'}`;
          const l = this.lessonOf(asg.class_id);
          const ins = this._q.insertEvent.run(st.id, l ? l.id : null, now, 'info', null, text.slice(0, 500), null, null, 0, null, null);
          this._broadcastToWatchers(st.id, { type: 'event', studentId: st.id, event: { id: Number(ins.lastInsertRowid), ts: now, kind: 'info', title: text.slice(0, 500) } });
          this._broadcastClass(asg.class_id, { type: 'assignments' });
        }
        break;
      }
      case 'ping':
        this._send(conn, { type: 'pong', t: msg.t, serverTime: Date.now() });
        break;
      default:
        break;
    }
  }

  _sanitizeStatus(msg) {
    const vio = Array.isArray(msg.violations) ? msg.violations.slice(0, 10).map(v => ({
      kind: str(v.kind, 30), text: str(v.text, 160), category: str(v.category, 20),
    })) : [];
    const deg = Array.isArray(msg.degraded) ? msg.degraded.slice(0, 6).map(d => ({ kind: str(d.kind, 30), text: str(d.text, 160) })) : [];
    return {
      recv: Date.now(),
      stale: false,
      degraded: deg,
      attempt: msg.attempt ? { text: str(msg.attempt.text, 160), ts: Number(msg.attempt.ts) || 0 } : null,
      activity: str(msg.activity, 200),
      url: str(msg.url, 1000),
      app: str(msg.app, 80),
      violations: vio,
      frozen: !!msg.frozen,
      ext: msg.ext && typeof msg.ext === 'object' ? { connected: !!msg.ext.connected, browsers: Array.isArray(msg.ext.browsers) ? msg.ext.browsers.slice(0, 8).map(b => str(b, 20)) : [] } : null,
      screens: Math.min(8, Math.max(1, Number(msg.screens) || 1)),
    };
  }

  /** Grænser pr. elev pr. lektion (ikke pr. forbindelse – så genforbindelser ikke nulstiller dem). */
  _limits(a) {
    // Skriveøkter deler grænse pr. elev pr. dag (ellers nulstiller hver ny økt loftet over hændelser og billeder)
    const key = a.solo ? 'solo:' + new Date().toISOString().slice(0, 10) : a.lessonId;
    let l = this.limits.get(a.studentId);
    if (!l || l.lessonId !== key) {
      l = { lessonId: key, rl: new RateLimiter(600, 10), evidenceRl: new RateLimiter(6, 0.1), events: 0, evidence: 0 };
      this.limits.set(a.studentId, l);
    }
    return l;
  }

  _insertEvent(a, it) {
    if (!it || typeof it !== 'object' || this.shuttingDown) return;
    const kind = str(it.kind, 20);
    if (!EVENT_KINDS.has(kind)) return;
    // Hjemme: ingen navigation eller programskift. Adresser kun som værtsnavn, titel kun som kategori.
    if (a.solo) {
      if (!HOME_EVENT_KINDS.has(kind)) return;
      const label = CATEGORY_TEXT[str(it.category, 20)];
      it = { kind, ts: it.ts, url: it.url ? hostOnly(it.url) : '', title: label || (kind === 'blocked' || kind === 'violation' ? 'Blokeret' : str(it.title, 300)),
        category: str(it.category, 20), blocked: !!it.blocked };
    }
    const lim = this._limits(a);
    if (++lim.events > MAX_EVENTS_PER_LESSON) return;
    if (kind === 'violation') {
      // En overtrædelse må ledsages af ét skærmbillede som dokumentation
      // – men kun hvis læreren har slået automatiske skærmbilleder til for klassen
      const conn = this.agentByStudent.get(a.studentId);
      if (conn && this._autoEvidence(a.studentId)) conn.violationUntil = Date.now() + 30_000;
    }
    let ts = Number(it.ts) || Date.now();
    const now = Date.now();
    if (ts > now + 60_000 || ts < now - 12 * 3600_000) ts = now; // urimelige tider fra elevens ur
    let detail = null;
    if (it.detail && typeof it.detail === 'object') {
      const d = Object.assign({}, it.detail);
      delete d.audit; // kun serveren skriver lærer-logbogen
      try { detail = JSON.stringify(d).slice(0, 2000); } catch (e) { detail = null; }
    }
    const r = this._q.insertEvent.run(a.studentId, a.lessonId, ts, kind, str(it.url, 2000) || null, str(it.title, 300) || null,
      str(it.app, 100) || null, str(it.category, 20) || null, it.blocked ? 1 : 0, detail, null);
    if (kind === 'blocked' || kind === 'violation' || kind === 'tamper' || kind === 'killed') {
      this._broadcastToWatchers(a.studentId, { type: 'event', studentId: a.studentId, event: { id: Number(r.lastInsertRowid), ts, kind, url: str(it.url, 2000), title: str(it.title, 300), app: str(it.app, 100), category: str(it.category, 20), blocked: !!it.blocked } });
    }
  }

  _agentBinary(conn, data) {
    const a = conn.active;
    if (!a) return;
    const f = decodeFrame(data);
    if (!f || !isJpeg(f.payload) || f.payload.length > 2_500_000) return;
    const kind = f.header.kind;
    // Skriveøkt hjemme: ingen billeder af skærmen – hverken live eller som skærmbillede
    if (a.solo) return;
    if (kind === 'live') {
      if (!conn.frameRl.take()) return;
      const w = this.watchers.get(a.studentId);
      if (!w || w.size === 0) return;
      const out = encodeFrame({ kind: 'live', studentId: a.studentId, ts: Date.now(), screen: Number(f.header.screen) || 0, screens: Number(f.header.screens) || 1 }, f.payload);
      for (const t of w) this._sendBinaryTeacher(t, out);
    } else if (kind === 'evidence') {
      // Kun efter lærerens "Tag skærmbillede" eller lige efter en overtrædelse – aldrig af sig selv
      const now = Date.now();
      const requested = now < conn.screenshotUntil;
      if (!requested && now >= conn.violationUntil) return;
      const lim = this._limits(a);
      if (!lim.evidenceRl.take() || ++lim.evidence > MAX_EVIDENCE_PER_LESSON) return;
      if (requested) { conn.screenshotUntil = 0; f.header.reason = 'Skærmbillede taget af læreren'; } else conn.violationUntil = 0;
      const dir = path.join(this.dataDir, 'evidence', String(a.studentId));
      fs.mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      const file = path.join(String(a.studentId), ts + '-' + crypto.randomBytes(4).toString('hex') + '.jpg');
      fs.writeFile(path.join(this.dataDir, 'evidence', file), f.payload, (err) => {
        if (err) return this.log('evidence write failed', err);
        if (this.shuttingDown) return; // serveren lukker – databasen er væk
        try { this._saveEvidence(a, f, file, ts); } catch (e) { this.log('evidence save failed', e); }
      });
    }
  }

  _saveEvidence(a, f, file, ts) {
    {
      {
        const reason = str(f.header.reason, 200);
        const ev = this._q.insertEvidence.run(a.studentId, a.lessonId, ts, file, reason);
        const evId = Number(ev.lastInsertRowid);
        const r = this._q.insertEvent.run(a.studentId, a.lessonId, ts, 'evidence', str(f.header.url, 2000) || null, reason, str(f.header.app, 100) || null, str(f.header.category, 20) || null, 0, null, evId);
        this._broadcastToWatchers(a.studentId, { type: 'event', studentId: a.studentId, event: { id: Number(r.lastInsertRowid), ts, kind: 'evidence', title: reason, evidenceId: evId } });
      }
    }
  }

  _agentClosed(conn) {
    this.agentConns.delete(conn);
    if (this.shuttingDown) return;
    for (const sid of conn.students.keys()) {
      if (this.agentByStudent.get(sid) !== conn) continue;
      this.agentByStudent.delete(sid);
      const classId = this.studentClass.get(sid);
      if (this.solo.has(sid)) this.endSolo(sid); // appen lukket = skriveøkten slutter
      if (conn.active && conn.active.studentId === sid && this.lessonOf(classId)) {
        const reason = conn.byeReason ? 'Eleven lukkede appen' : 'Forbindelsen blev afbrudt';
        this.closed.set(sid, { ts: Date.now(), reason, quit: !!conn.byeReason });
        this._q.insertEvent.run(sid, conn.active.lessonId, Date.now(), conn.byeReason ? 'tamper' : 'info', null, reason, null, null, 0, null, null);
      }
      this.status.delete(sid);
      this._pushStudent(sid);
    }
  }

  _updateStream(conn) {
    let mode = 'off';
    let screen = 0;
    if (conn.active && !conn.active.solo) {
      const w = this.watchers.get(conn.active.studentId);
      if (w && w.size) {
        mode = 'live';
        for (const t of w) screen = t.watchScreen || 0;
      }
      // Ellers sendes der ingen billeder – skærmen ses kun når læreren klikker på eleven.
    }
    const key = mode + ':' + screen;
    if (conn.streamMode !== key) {
      conn.streamMode = key;
      this._send(conn, { type: 'stream', mode, screen });
    }
  }

  /* ------------------------------ lærere ------------------------------ */

  /** sessHash: hash af lærerens login-session (forbindelsen lukkes, når sessionen ophører – se closeTeacher og heartbeat). */
  handleTeacher(ws, teacher, classRow, sessHash = null) {
    const t = { ws, teacher, classId: classRow.id, watching: null, watchScreen: 0, sessHash };
    let set = this.teachers.get(classRow.id);
    if (!set) { set = new Set(); this.teachers.set(classRow.id, set); }
    set.add(t);
    ws.on('message', (data, isBinary) => {
      if (isBinary || data.length > 16 * 1024) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return; }
      try { this._teacherMessage(t, msg); } catch (e) { this.log('teacher message error', e); }
    });
    ws.on('close', () => {
      set.delete(t);
      this._unwatch(t);
      this._refreshStreams(t.classId);
    });
    ws.on('error', () => {});
    this._sendTeacher(t, this._snapshot(classRow.id));
    this._refreshStreams(classRow.id);
  }

  _teacherMessage(t, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    // Ejerskab tjekkes ALTID i databasen (aldrig i cachen – id'er kan genbruges efter sletning)
    const ownStudent = (id) => Number.isInteger(id) && id > 0 && (this._q.student.get(id) || {}).class_id === t.classId;
    switch (msg.type) {
      case 'freeze': {
        const on = !!msg.on;
        const message = str(msg.message, 200);
        // 'review' = Gennemgang: skærmen viser ur, dato og hvor lang tid der er tilbage af lektionen
        const mode = msg.mode === 'review' ? 'review' : 'freeze';
        const lesson = this.lessonOf(t.classId);
        // Uden lektion fryses intet (og intet "hænger" frosset til næste lektion)
        if (on && !lesson) return this._sendTeacher(t, { type: 'error', message: 'Start en lektion for at fryse skærme' });
        const ids = msg.all ? this._q.studentsOfClass.all(t.classId).map(r => r.id) : (Array.isArray(msg.studentIds) ? msg.studentIds.map(Number) : []);
        for (const id of ids) {
          if (!ownStudent(id)) continue;
          this.studentClass.set(id, t.classId);
          const was = this.frozen.get(id);
          if (on) this.frozen.set(id, { message, mode }); else this.frozen.delete(id);
          if (on !== !!was || (on && was && was.mode !== mode)) {
            this._audit(id, on ? `${t.teacher.name} ${mode === 'review' ? 'startede gennemgang (skærmen på standby)' : 'frøs skærmen'}` : `${t.teacher.name} ${was && was.mode === 'review' ? 'afsluttede gennemgangen' : 'optøede skærmen'}`);
          }
          const conn = this.agentByStudent.get(id);
          if (conn && conn.active && conn.active.studentId === id) this._send(conn, { type: 'freeze', on, message, mode, endsAt: lesson ? lesson.endsAt : 0, startedAt: lesson ? lesson.started : 0 });
          this._pushStudent(id);
        }
        break;
      }
      case 'watch': {
        const id = Number(msg.studentId);
        if (!ownStudent(id)) return;
        if (this.isHome(id)) {
          this._unwatch(t);
          return this._sendTeacher(t, { type: 'error', message: HOME_NO_SCREEN, studentId: id, home: true });
        }
        this._unwatch(t);
        t.watching = id;
        t.watchScreen = Math.max(0, Math.min(7, Number(msg.screen) || 0));
        let w = this.watchers.get(id);
        if (!w) { w = new Set(); this.watchers.set(id, w); }
        w.add(t);
        this._audit(id, `${t.teacher.name} så skærmen live`);
        const conn = this.agentByStudent.get(id);
        if (conn) { conn.streamMode = null; this._updateStream(conn); }
        this._sendTeacher(t, { type: 'detail', studentId: id, detail: this.detail.get(id) || { tabs: [], apps: [] } });
        break;
      }
      case 'unwatch':
        this._unwatch(t);
        break;
      case 'hand': {
        const id = Number(msg.studentId);
        if (!ownStudent(id) || !this.hands.has(id)) return;
        this.hands.delete(id);
        const conn = this.agentByStudent.get(id);
        if (conn) this._send(conn, { type: 'hand', up: false });
        this._pushStudent(id);
        break;
      }
      case 'screenshot': {
        // Læreren tager et skærmbillede – gemmes under elevens hændelser
        const id = Number(msg.studentId);
        if (!ownStudent(id)) return;
        if (this.isHome(id)) return this._sendTeacher(t, { type: 'error', message: HOME_NO_SCREEN, studentId: id, home: true });
        const conn = this.agentByStudent.get(id);
        if (conn && conn.active && conn.active.studentId === id) {
          this._audit(id, `${t.teacher.name} tog et skærmbillede`);
          conn.screenshotUntil = Date.now() + 20_000;
          this._send(conn, { type: 'screenshot' });
        } else this._sendTeacher(t, { type: 'error', message: 'Eleven er ikke forbundet' });
        break;
      }
      case 'frameAck': {
        const id = Number(msg.studentId);
        if (t.watching !== id) return;
        const conn = this.agentByStudent.get(id);
        if (conn) this._send(conn, { type: 'frameAck' });
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------ HolyMoly-vagten ------------------------------ */

  _guardRequired(conn) {
    // Styresystemet kommer fra klienten selv og kan forfalskes – vagten kræves derfor altid, når klassen kræver den
    return !!(this.requireGuard && conn);
  }

  _guardView(sid, conn) {
    const row = this.db.prepare('SELECT guard_pubkey FROM students WHERE id = ?').get(sid) || {};
    const rep = this.guardReports.get(sid);
    const fresh = rep && Date.now() - rep.ts < 25_000;
    const alerts = (this.guardAlerts.get(sid) || []).filter(a => a.until > Date.now()).map(a => ({ kind: 'guard_tamper', text: a.text, category: '' }));
    const out = { violations: (fresh ? rep.violations : []).concat(alerts), grey: '', state: !row.guard_pubkey ? 'unpaired' : (fresh ? 'ok' : 'stale') };
    if (this.isHome(sid)) {
      // Hjemme: kun kategorien – og ikke to gange, hvis appen allerede melder den samme
      const shown = new Set(((this.status.get(sid) || {}).violations || []).map(v => v.category));
      out.violations = homeViolations(out.violations).filter(v => !shown.has(v.category));
    }
    if (this._guardRequired(conn)) {
      const os = String((conn.device && conn.device.os) || '');
      if (!row.guard_pubkey) out.grey = /^(Windows|macOS)/.test(os) ? 'HolyMoly-vagten er ikke tilknyttet denne computer' : 'HolyMoly-vagten findes ikke til denne computer';
      else if (!fresh) out.grey = 'HolyMoly-vagten svarer ikke';
      else if (rep.error) out.grey = 'HolyMoly-vagten har en fejl: ' + rep.error;
      // Under lektionen: grøn først når vagten selv overvåger lektionen (ellers er der et hul ved lektionsstart)
      else if (this.lessonFor(sid) && !rep.inLesson) out.grey = 'Venter på HolyMoly-vagten';
      else if (rep.hostsFailed) out.grey = 'Blokeringen på computeren kunne ikke sættes (hosts-filen)';
    }
    return out;
  }

  /** En elev har tilmeldt sig selv med klassekoden: læreren ser det straks. */
  /** Har klassen slået automatisk skærmbillede ved forbudt brug til? (standard: nej) */
  _autoEvidence(sid) {
    // Aldrig skærmbilleder af elevens skærm derhjemme
    if (this.isHome(sid)) return false;
    const classId = this.studentClass.get(sid);
    if (classId == null) return false;
    try { return this.classConfig(classId).autoEvidence === true; } catch (e) { return false; }
  }

  studentJoined(sid, classId, text) {
    this.studentClass.set(sid, classId);
    if (!this.shuttingDown) {
      const l = this.lessonOf(classId);
      this._q.insertEvent.run(sid, l ? l.id : null, Date.now(), 'system', null, text, null, null, 0, null, null);
    }
    this._broadcastSnapshot(classId);
  }

  guardPaired(sid) {
    if (!this.shuttingDown) {
      const classId = (this._q.student.get(sid) || {}).class_id;
      const l = classId != null ? this.lessonOf(classId) : null;
      this._q.insertEvent.run(sid, l ? l.id : null, Date.now(), 'system', null, 'HolyMoly-vagten blev tilknyttet elevens computer', null, null, 0, null, null);
    }
    this._pushStudent(sid);
  }

  guardTamper(sid, text) {
    // Gemmes for sig (15 min.), så vagtens næste hjertebanke ikke visker advarslen ud
    const list = (this.guardAlerts.get(sid) || []).filter(a => a.until > Date.now() && a.text !== text);
    list.push({ text, until: Date.now() + 15 * 60_000 });
    this.guardAlerts.set(sid, list.slice(-10));
    if (!this.shuttingDown) {
      const classId = this.studentClass.get(sid) ?? (this._q.student.get(sid) || {}).class_id;
      const l = classId != null ? this.lessonOf(classId) : null;
      this._q.insertEvent.run(sid, l ? l.id : null, Date.now(), 'tamper', null, text, null, null, 0, null, null);
    }
    this._pushStudent(sid);
  }

  /** En signeret, gyldig hjertebanke fra vagten. Returnerer lektion, blokeringsliste og hvad der skal lukkes. */
  guardBeat(students, rep) {
    const { classifyReport } = require('./guardapi');
    let best = null;
    for (const s of students) {
      this.studentClass.set(s.id, s.class_id);
      const l = this.lessonFor(s.id, s.class_id);
      if (l && (!best || preferLesson(l, best.lesson))) best = { s, lesson: l };
    }
    const result = { live: false, until: 0, blocked: [], kill: [] };
    for (const s of students) {
      const prev = this.guardReports.get(s.id) || { seen: new Map() };
      if (!best || best.s.id !== s.id) {
        this.guardReports.set(s.id, { ts: Date.now(), violations: [], kill: [], seen: new Map() });
        continue;
      }
      const { config } = this.policyFor(s.id, s.class_id);
      const R = this.compileFor(s.class_id, config);
      const c = classifyReport(rep, R, {
        now: Date.now(), killApps: config.killApps !== false, seenForbidden: prev.seen,
        trayConnected: this.agentByStudent.has(s.id), lessonLive: true, lessonStarted: best.lesson.started,
      });
      const before = (prev.violations || []).map(v => v.text).join('\n');
      const error = String(rep.error || '').slice(0, 200);
      const notes = prev.notes || new Set();
      this.guardReports.set(s.id, { ts: Date.now(), violations: c.violations, kill: c.kill, seen: c.seenForbidden, error, inLesson: rep.lesson === '1', hostsFailed: rep.hosts === '0', notes });
      // Bemærkninger fra vagten (fx browser-indstillinger sat på plads igen efter en GPO/MDM-opdatering): logges, ingen lampe
      for (const n of (rep._multi.note || []).slice(0, 10)) {
        const [ts, text = ''] = String(n).split('\t');
        if (Number(ts) < best.lesson.started || notes.has(text) || notes.size > 50) continue;
        notes.add(text);
        this._q.insertEvent.run(s.id, best.lesson.id, Date.now(), 'system', null, 'HolyMoly-vagten: ' + text.slice(0, 200), null, null, 0, null, null);
      }
      if (error && error !== prev.error) {
        this._q.insertEvent.run(s.id, best.lesson.id, Date.now(), 'system', null, 'HolyMoly-vagten melder en fejl: ' + error, null, null, 0, null, null);
      }
      // Nye fund fra vagten logges
      for (const v of c.violations) {
        if (!before.includes(v.text)) this._q.insertEvent.run(s.id, best.lesson.id, Date.now(), v.kind === 'fake_client' || v.kind === 'guard_tamper' ? 'tamper' : 'violation', null, 'Vagt: ' + v.text, null, v.category || null, 0, null, null);
      }
      result.live = true;
      result.until = best.lesson.endsAt;
      result.blocked = R.blockedDomainList();
      result.kill = c.kill;
      this._pushStudent(s.id);
    }
    return result;
  }

  /** En kladde er slettet: stop målingen, skriv det i logbogen og opdater lærerens liste. */
  docDeleted(sid, docId, text) {
    if (this.writing.get(sid) === docId) this.writing.delete(sid);
    this._audit(sid, text);
    this._broadcastToWatchers(sid, { type: 'docs', studentId: sid });
  }

  /** Lærer-logbog: hvem så hvad hvornår (vises under elevens hændelser). */
  _audit(studentId, text) {
    if (this.shuttingDown) return;
    const classId = this.studentClass.get(studentId);
    const l = classId != null ? this.lessonOf(classId) : null;
    const r = this._q.insertEvent.run(studentId, l ? l.id : null, Date.now(), 'teacher', null, text, null, null, 0, null, null);
    this._broadcastToWatchers(studentId, { type: 'event', studentId, event: { id: Number(r.lastInsertRowid), ts: Date.now(), kind: 'teacher', title: text } });
  }

  _unwatch(t) {
    if (t.watching == null) return;
    const id = t.watching;
    const w = this.watchers.get(id);
    if (w) { w.delete(t); if (!w.size) this.watchers.delete(id); }
    t.watching = null;
    const conn = this.agentByStudent.get(id);
    if (conn) this._updateStream(conn);
  }

  _refreshStreams(classId) {
    for (const conn of this.agentConns) {
      if (conn.active && conn.active.classId === classId) this._updateStream(conn);
    }
  }

  /** Status som lærer-dashboardet ser den. */
  studentView(sid) {
    const conn = this.agentByStudent.get(sid);
    const classId = this.studentClass.get(sid);
    const lesson = this.lessonFor(sid, classId);
    const st = this.status.get(sid);
    const v = {
      studentId: sid, online: !!conn, frozen: this.frozen.has(sid), review: (this.frozen.get(sid) || {}).mode === 'review', color: 'grey', activity: '', url: '', app: '',
      hand: lesson ? (this.hands.get(sid) || null) : null,
      violations: [], degraded: [], greyReason: '', closed: this.closed.get(sid) || null, lastAttempt: null, ext: null, screens: 1,
      device: conn ? conn.device : null,
    };
    // Skriveøkt uden for timen: læreren ser, at eleven skriver hjemme (og til hvilken aflevering)
    const solo = this.soloOf(sid);
    if (solo && !this.lessonOf(classId)) v.solo = solo.title;
    if (!conn) return v;
    if (conn.outdated && lesson) {
      v.color = 'grey';
      v.greyReason = 'Skal opdatere HolyMoly';
      v.activity = `Har version ${conn.device.version || '?'} – kræver ${this.minAgentVersion}`;
      return v;
    }
    if (!lesson || !conn.active || conn.active.studentId !== sid) {
      v.color = 'idle';
      v.activity = conn.active ? 'Er i en anden lektion' : 'Forbundet – venter på lektion';
      return v;
    }
    if (!st) { v.color = 'grey'; v.activity = 'Forbinder…'; return v; }
    Object.assign(v, { activity: st.activity, url: st.url, app: st.app, violations: st.violations, ext: st.ext, screens: st.screens, lastAttempt: st.attempt, degraded: st.degraded });
    if (this.isHome(sid)) Object.assign(v, { activity: HOME_ACTIVITY, url: '', app: '', violations: homeViolations(st.violations), lastAttempt: null });
    // HolyMoly-vagten (SYSTEM/root) er et uafhængigt vidne – dens fund vejer tungest
    const g = this._guardView(sid, conn);
    if (g.violations.length) v.violations = g.violations.concat(st.violations);
    v.guard = g.state;
    // Rød vinder over grå: en bekræftet overtrædelse skjules aldrig af en grå tilstand (vagtens fund gælder også, når appen er stille)
    if (g.violations.length) { v.color = 'red'; return v; }
    if (g.grey) { v.color = 'grey'; v.greyReason = g.grey; return v; }
    if (st.violations.length && !st.stale) { v.color = 'red'; return v; }
    // Grå = overvågningen er ikke komplet. Kun bekræftede overtrædelser giver rød.
    if (st.stale) { v.color = 'grey'; v.greyReason = 'Ingen forbindelse (netværk?)'; }
    else if (st.degraded.length) { v.color = 'grey'; v.greyReason = st.degraded.map(d => d.text).join(', '); }
    else v.color = 'green';
    return v;
  }

  _snapshot(classId) {
    const students = this._q.studentsOfClass.all(classId).map(r => {
      this.studentClass.set(r.id, classId);
      return this.studentView(r.id);
    });
    return { type: 'snapshot', lesson: this._lessonInfo(classId), students };
  }

  _broadcastSnapshot(classId) {
    const set = this.teachers.get(classId);
    if (!set || !set.size) return;
    const snap = this._snapshot(classId);
    for (const t of set) this._sendTeacher(t, snap);
  }

  _pushStudent(sid) {
    const classId = this.studentClass.get(sid);
    if (classId == null) return;
    const view = this.studentView(sid);
    this._logColor(sid, classId, view);
    this._broadcastClass(classId, { type: 'student', student: view });
  }

  /** Lektionsrapport: gem hvert farveskift under lektionen (rød med årsag, grå med årsag). */
  _logColor(sid, classId, view) {
    const l = this.lessonOf(classId);
    if (!l || this.shuttingDown) return;
    const color = view.color === 'green' || view.color === 'red' ? view.color : 'grey';
    const prev = this.lastColor.get(sid);
    if (prev && prev.lessonId === l.id && prev.color === color) return;
    this.lastColor.set(sid, { lessonId: l.id, color });
    const reason = color === 'red' ? (view.violations[0] || {}).text || '' : color === 'grey' ? view.greyReason || (view.online ? '' : 'Ikke forbundet') : '';
    try { this.db.prepare('INSERT INTO lesson_colors (student_id, lesson_id, ts, color, reason) VALUES (?,?,?,?,?)').run(sid, l.id, Date.now(), color, String(reason).slice(0, 200)); } catch (e) { /* elev slettet */ }
  }

  _pushDetail(sid) {
    if (this.isHome(sid)) return;
    this._broadcastToWatchers(sid, { type: 'detail', studentId: sid, detail: this.detail.get(sid) });
  }

  _broadcastToWatchers(sid, msg) {
    const w = this.watchers.get(sid);
    if (!w) return;
    for (const t of w) this._sendTeacher(t, msg);
  }

  _broadcastClass(classId, msg) {
    const set = this.teachers.get(classId);
    if (!set) return;
    for (const t of set) this._sendTeacher(t, msg);
  }

  /** Kaldes når klassens indstillinger ændres. */
  configChanged(classId) {
    for (const conn of this.agentConns) {
      if (conn.active && conn.active.classId === classId) {
        this._send(conn, { type: 'config', config: this.policyFor(conn.active.studentId, classId).config });
      }
    }
  }

  rulesChanged() {
    const rules = this.getRules();
    for (const conn of this.agentConns) if (conn.helloDone) this._send(conn, { type: 'rules', rules });
  }

  /** Eleven slettes: glem alt i hukommelsen (id'et kan senere genbruges af en ny elev). */
  forgetStudent(sid) {
    this.revokeStudent(sid);
    this.studentClass.delete(sid);
    this.limits.delete(sid);
    const w = this.watchers.get(sid);
    if (w) for (const t of [...w]) { this._unwatch(t); this._sendTeacher(t, { type: 'detail', studentId: sid, detail: { tabs: [], apps: [] } }); }
    this.watchers.delete(sid);
  }

  /** Klassen slettes: luk lærernes forbindelser til den. */
  forgetClass(classId) {
    const set = this.teachers.get(classId);
    if (set) for (const t of [...set]) { try { t.ws.close(4404, 'class deleted'); } catch (e) { /* */ } }
    this.teachers.delete(classId);
    this.lessons.delete(classId);
  }

  /** Når en elev slettes eller får ny kode, skal en eventuel forbindelse smides af. */
  revokeStudent(sid) {
    const conn = this.agentByStudent.get(sid);
    this.frozen.delete(sid);
    this.status.delete(sid);
    this.detail.delete(sid);
    this.closed.delete(sid);
    if (!conn) return;
    conn.students.delete(sid);
    this.agentByStudent.delete(sid);
    this._send(conn, { type: 'revoked', studentId: sid });
    if (conn.students.size === 0) conn.ws.close(4401, 'revoked');
    else this._assignActive(conn);
  }

  /**
   * Lærerens login er ophørt (logget ud, ny adgangskode, to-faktor nulstillet, konto slettet): luk lærerens
   * forbindelser med 4401. exceptHash: sessionen, der skiftede adgangskoden, beholder sin. onlyHash: kun den ene session.
   */
  closeTeacher(teacherId, exceptHash = null, onlyHash = null) {
    let n = 0;
    for (const set of this.teachers.values()) {
      for (const t of [...set]) {
        if (t.teacher.id !== teacherId) continue;
        if (exceptHash && t.sessHash === exceptHash) continue;
        if (onlyHash && t.sessHash !== onlyHash) continue;
        try { t.ws.close(4401, 'logged out'); } catch (e) { /* */ }
        n++;
      }
    }
    return n;
  }

  heartbeat() {
    for (const conn of this.agentConns) {
      if (!conn.alive) { conn.ws.terminate(); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch (e) { /* ignorer */ }
    }
    // Lærer-forbindelser lever kun, så længe login-sessionen gælder (udløb og absolut grænse, SESSION_MAX_HOURS)
    if (typeof this.teacherSessionOk === 'function') {
      for (const set of this.teachers.values()) {
        for (const t of [...set]) {
          if (t.sessHash && !this.teacherSessionOk(t.sessHash)) { try { t.ws.close(4401, 'session expired'); } catch (e) { /* */ } }
        }
      }
    }
  }

  _send(conn, msg) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }
  _sendTeacher(t, msg) {
    if (t.ws.readyState === 1) t.ws.send(JSON.stringify(msg));
  }
  _sendBinaryTeacher(t, buf) {
    // Spring billeder over hvis læreren har en langsom forbindelse.
    if (t.ws.readyState === 1 && t.ws.bufferedAmount < 4_000_000) t.ws.send(buf, { binary: true });
  }
}

module.exports = { Hub };
