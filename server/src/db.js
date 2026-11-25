'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'holymoly.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0.5,
      y REAL NOT NULL DEFAULT 0.5,
      invite_code TEXT UNIQUE,
      invite_expires INTEGER,
      device_token_hash TEXT UNIQUE,
      device_info TEXT,
      enrolled INTEGER,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      started INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      ended INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      lesson_id INTEGER,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      url TEXT,
      title TEXT,
      app TEXT,
      category TEXT,
      blocked INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      evidence_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS events_student_ts ON events(student_id, ts);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      lesson_id INTEGER,
      ts INTEGER NOT NULL,
      file TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS evidence_ts ON evidence(ts);
  `);
  // Migrering: kolonner til HolyMoly-vagten (tilføjes hvis databasen er fra en ældre version)
  const cols = new Set(db.prepare('PRAGMA table_info(students)').all().map(c => c.name));
  for (const [name, type] of [['guard_pubkey', 'TEXT'], ['guard_seq', 'INTEGER NOT NULL DEFAULT 0'], ['guard_pair_hash', 'TEXT'],
    ['guard_pair_expires', 'INTEGER'], ['guard_info', 'TEXT'], ['guard_pair_used', 'TEXT'], ['guard_pair_used_until', 'INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE students ADD COLUMN ${name} ${type}`);
  }
  // Migrering: klassekode (eleverne tilmelder sig selv med den + deres navn)
  const ccols = new Set(db.prepare('PRAGMA table_info(classes)').all().map(c => c.name));
  if (!ccols.has('join_code')) db.exec('ALTER TABLE classes ADD COLUMN join_code TEXT');
  if (!ccols.has('join_open')) db.exec('ALTER TABLE classes ADD COLUMN join_open INTEGER NOT NULL DEFAULT 1');
  // Har læreren selv flyttet bordene? Så flyttes de ikke, når nye elever tilmelder sig
  if (!ccols.has('layout_custom')) db.exec('ALTER TABLE classes ADD COLUMN layout_custom INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS classes_join_code ON classes(join_code)');
  // Migrering: UNI-Login (lærere og elever kendes på deres UNI-ID)
  const tcols = new Set(db.prepare('PRAGMA table_info(teachers)').all().map(c => c.name));
  if (!tcols.has('uni_id')) db.exec('ALTER TABLE teachers ADD COLUMN uni_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS teachers_uni_id ON teachers(uni_id)');
  const scols = new Set(db.prepare('PRAGMA table_info(students)').all().map(c => c.name));
  if (!scols.has('uni_id')) db.exec('ALTER TABLE students ADD COLUMN uni_id TEXT');
  // Enkel tilstand: elevens egen kode (4-6 cifre, som scrypt-hash), så kun eleven kan logge ind med sit navn på en ny computer
  if (!scols.has('pin_hash')) db.exec('ALTER TABLE students ADD COLUMN pin_hash TEXT');
  // Hvornår eleven accepterede vilkårene for elever i appen (enkel tilstand)
  if (!scols.has('terms_accepted')) db.exec('ALTER TABLE students ADD COLUMN terms_accepted INTEGER');
  // Læreren har nulstillet elevens kode: engangskoden gælder indtil dette tidspunkt
  if (!scols.has('pin_reset_until')) db.exec('ALTER TABLE students ADD COLUMN pin_reset_until INTEGER');
  // Nulstillet kode: engangskoden fra læreren (scrypt-hash), som eleven skriver i appen inden pin_reset_until
  if (!scols.has('pin_reset_hash')) db.exec('ALTER TABLE students ADD COLUMN pin_reset_hash TEXT');
  // Forkerte kode-forsøg i alt (efter 10 er koden låst, til læreren nulstiller den)
  if (!scols.has('pin_fails')) db.exec('ALTER TABLE students ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0');
  // Elevens hjælpemidler (JSON-liste: 'ordforslag', 'diktering'), sat af læreren. Kun til skrivevinduet og vurderingen –
  // aldrig i beviset, mærket eller Word-filen.
  if (!scols.has('aids')) db.exec('ALTER TABLE students ADD COLUMN aids TEXT');
  // Små indstillinger for serveren (fx lærerkoden i enkel tilstand)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Lektionsrapport: hvornår skiftede elevens lampe farve (kun under lektionen)
  db.exec(`CREATE TABLE IF NOT EXISTS lesson_colors (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    color TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS lesson_colors_l ON lesson_colors(lesson_id, student_id, ts);`);
  db.exec(`CREATE TABLE IF NOT EXISTS student_sessions (
    token_hash TEXT PRIMARY KEY, uni_id TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL
  )`);

  /* ---- Kontoer, skoler og licenser ---- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS schools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      trial_ends INTEGER NOT NULL,
      license_until INTEGER,
      seats INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );
    -- Engangs-links pr. e-mail: bekræft e-mail, nulstil adgangskode, invitation til en skole
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
      school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
      email TEXT,
      role TEXT,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tokens_teacher ON tokens(teacher_id, kind);
    CREATE TABLE IF NOT EXISTS license_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      school_name TEXT,
      created INTEGER NOT NULL,
      students INTEGER NOT NULL,
      years INTEGER NOT NULL DEFAULT 1,
      amount INTEGER NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ny'
    );
    -- Afleveringer: læreren opretter en opgave; eleven vedhæfter et dokument skrevet i HolyMoly
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due INTEGER,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assignments_class ON assignments(class_id, due);
    CREATE TABLE IF NOT EXISTS assignment_submissions (
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL,
      submitted INTEGER NOT NULL,
      PRIMARY KEY (assignment_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS trial_claims (
      who TEXT PRIMARY KEY,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_codes (
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      PRIMARY KEY (teacher_id, code_hash)
    );
  `);
  const tc = new Set(db.prepare('PRAGMA table_info(teachers)').all().map(c => c.name));
  // Lærere fra før e-mail-bekræftelsen fandtes, regnes som bekræftede (DEFAULT 1); nye oprettes med 0
  for (const [name, type] of [['school_id', 'INTEGER REFERENCES schools(id) ON DELETE SET NULL'], ['role', "TEXT NOT NULL DEFAULT 'teacher'"],
    ['email_verified', 'INTEGER NOT NULL DEFAULT 1'], ['totp_secret', 'TEXT'], ['totp_step', 'INTEGER NOT NULL DEFAULT 0'], ['terms_accepted', 'INTEGER']]) {
    if (!tc.has(name)) db.exec(`ALTER TABLE teachers ADD COLUMN ${name} ${type}`);
  }
  // Skriveøkt: en elev skriver en aflevering hjemme – en "lektion" for kun den elev
  const lc = new Set(db.prepare('PRAGMA table_info(lessons)').all().map(c => c.name));
  if (!lc.has('student_id')) db.exec('ALTER TABLE lessons ADD COLUMN student_id INTEGER');
  // Skrivetime: klassens lektion, hvor eleverne skriver én bestemt aflevering
  if (!lc.has('write_assignment_id')) db.exec('ALTER TABLE lessons ADD COLUMN write_assignment_id INTEGER');
  // Skriveøkt: hvilken slags række (klasse/hjemme), afleveringen, hvorfor den sluttede ('drop' = forbindelsen blev væk),
  // og computeren (sha256 af elevens token, 16 tegn), så en afbrudt økt kun kan fortsættes på samme computer
  if (!lc.has('kind')) {
    db.exec("ALTER TABLE lessons ADD COLUMN kind TEXT NOT NULL DEFAULT 'klasse'");
    db.exec("UPDATE lessons SET kind = 'hjemme' WHERE student_id IS NOT NULL");
  }
  if (!lc.has('assignment_id')) db.exec('ALTER TABLE lessons ADD COLUMN assignment_id INTEGER');
  if (!lc.has('end_reason')) db.exec('ALTER TABLE lessons ADD COLUMN end_reason TEXT');
  if (!lc.has('device_hash')) db.exec('ALTER TABLE lessons ADD COLUMN device_hash TEXT');
  // Ekstra tid: samme lektion (samme id) varer længere for enkelte elever
  db.exec(`CREATE TABLE IF NOT EXISTS lesson_extensions (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    ends_at INTEGER NOT NULL,
    PRIMARY KEY (lesson_id, student_id)
  )`);
  const ac = new Set(db.prepare('PRAGMA table_info(assignments)').all().map(c => c.name));
  if (!ac.has('home')) db.exec('ALTER TABLE assignments ADD COLUMN home INTEGER NOT NULL DEFAULT 0');
  // Unilogin: skolens institutionsnummer (lærere fra institutionen kobles automatisk på) og lærerens institutioner
  const sch = new Set(db.prepare('PRAGMA table_info(schools)').all().map(c => c.name));
  if (!sch.has('inst_nr')) db.exec('ALTER TABLE schools ADD COLUMN inst_nr TEXT');
  // Sikkerhedslog til skolens administrator (logins, ændringer af login, administratorhandlinger) – OWASP A09
  db.exec(`CREATE TABLE IF NOT EXISTS security_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    teacher_id INTEGER,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS security_log_school_ts ON security_log(school_id, ts);`);
  // Sletning efter ophør: hvilke varsler er sendt ("<udløbstidspunkt>:<dage før>")
  if (!sch.has('purge_notice')) db.exec('ALTER TABLE schools ADD COLUMN purge_notice TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS schools_inst_nr ON schools(inst_nr) WHERE inst_nr IS NOT NULL');
  const tch = new Set(db.prepare('PRAGMA table_info(teachers)').all().map(c => c.name));
  if (!tch.has('uni_insts')) db.exec('ALTER TABLE teachers ADD COLUMN uni_insts TEXT');
  // Enkel tilstand: en ny lærer skal godkendes af en godkendt kollega (tidspunktet; NULL = venter).
  // Lærere fra før kolonnen fandtes, er godkendt.
  if (!tch.has('approved')) {
    db.exec('ALTER TABLE teachers ADD COLUMN approved INTEGER');
    db.exec('UPDATE teachers SET approved = created');
  }
  const oc = new Set(db.prepare('PRAGMA table_info(license_orders)').all().map(c => c.name));
  if (!oc.has('school_name')) db.exec('ALTER TABLE license_orders ADD COLUMN school_name TEXT');
  // mfa = 1: sessionen er logget ind med to-faktor (godkendelses-app) eller UNI-Login
  const sc = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name));
  if (!sc.has('mfa')) db.exec('ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0');
  // Hvornår sessionen blev logget ind (absolut levetid, uanset aktivitet)
  if (!sc.has('created')) db.exec('ALTER TABLE sessions ADD COLUMN created INTEGER');
  // Serverens egne kørsler: hvornår den startede, og hvornår den sidst var i live. Hullerne imellem er serverens nedetid
  // (tæller ikke mod elevens skrive-bevis, se docs.js _observe).
  db.exec(`CREATE TABLE IF NOT EXISTS server_runs (start INTEGER NOT NULL, last_alive INTEGER NOT NULL, clean INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS server_runs_start ON server_runs(start);`);
  return db;
}

module.exports = { open };
