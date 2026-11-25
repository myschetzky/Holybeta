#!/usr/bin/env node
/*
 * HolyMoly i enkel tilstand – til at komme i gang på én skole uden e-mail, licens eller Unilogin.
 *
 *   npm run enkel                         starter serveren (data gemmes i server/data)
 *   npm run enkel -- nulstil <brugernavn> laver en ny midlertidig adgangskode til en lærer
 *   npm run enkel -- godkend <brugernavn> godkender en ny lærer (når ingen kollega kan gøre det)
 *   npm run enkel -- overdrag             registrerer, at skolens IT har overtaget driften (kræver SCHOOL_OPERATED=1)
 *   npm run enkel -- aktive               er der lektioner eller skriveøkter i gang? (exit 1 = ja; bruges af scripts/opdater.sh)
 *   npm run enkel -- revisionsspor [dage] revisionssporet (lærerhandlinger uden indhold) som CSV på stdout (standard: 365 dage)
 *   npm run enkel -- backup-ud <mål>      krypteret backup (database + signeringsnøgle) til én fil – kræver BACKUP_PASSPHRASE
 *   npm run enkel -- gendan-test <fil> [mappe]  dekrypterer backuppen og tjekker database og nyeste bevis (med mappe: filerne beholdes der)
 *   npm run enkel -- ny-noegle [--kompromitteret [ÅÅÅÅ-MM-DD]]  ny signeringsnøgle; den gamle kan kun verificere
 *   npm run enkel -- bekraeft-ja          skolen har sagt ja til den nuværende konfiguration (hæver blokeringen efter en ændring)
 *   npm run enkel -- pilottal [ÅÅÅÅ-MM]   pilottallene for hele skolen pr. måned som CSV (ingen navne, ingen opdeling pr. lærer)
 *
 * Lærere opretter sig med navn, brugernavn og adgangskode (den første med opsætningskoden, som skrives her ved start).
 * Elever skriver klassekoden, deres navn og en kode på 4 cifre i HolyMoly-appen. Lektioner kræver skolens ja:
 * DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO og LEDELSE_JA_DATO i miljøet. Se docs/ENKEL.md.
 */
'use strict';
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'server', 'data');
const PORT = Number(process.env.PORT || 8080);

if (process.argv[2] === 'nulstil') {
  // Ny adgangskode uden e-mail: kun den, der har adgang til serveren, kan gøre det
  const user = String(process.argv[3] || '').trim().toLowerCase();
  if (!user) { console.error('Skriv brugernavnet:  npm run enkel -- nulstil <brugernavn>'); process.exit(1); }
  const db = require('../server/src/db.js').open(DATA_DIR);
  const U = require('../server/src/util.js');
  const t = db.prepare('SELECT id, name FROM teachers WHERE email = ?').get(user);
  if (!t) { console.error(`Ingen lærer med brugernavnet "${user}".`); process.exit(1); }
  // 4 grupper á 4 tegn uden forvekslelige tegn (0/O, 1/l)
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pw = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => abc[crypto.randomInt(abc.length)]).join('')).join('-');
  db.prepare('UPDATE teachers SET pass_hash = ? WHERE id = ?').run(U.hashPassword(pw), t.id);
  db.prepare('DELETE FROM sessions WHERE teacher_id = ?').run(t.id); // log ud overalt
  console.log(`Ny adgangskode til ${t.name} (${user}):\n\n    ${pw}\n\nBed læreren skifte den under Konto efter login.`);
  process.exit(0);
}

if (process.argv[2] === 'godkend') {
  // Normalt godkender en kollega nye lærere i dashboardet. Her kan den, der driver serveren, gøre det.
  const user = String(process.argv[3] || '').trim().toLowerCase();
  if (!user) { console.error('Skriv brugernavnet:  npm run enkel -- godkend <brugernavn>'); process.exit(1); }
  const db = require('../server/src/db.js').open(DATA_DIR);
  const t = db.prepare('SELECT id, name, approved FROM teachers WHERE email = ?').get(user);
  if (!t) { console.error(`Ingen lærer med brugernavnet "${user}".`); process.exit(1); }
  if (t.approved) { console.log(`${t.name} (${user}) er allerede godkendt.`); process.exit(0); }
  db.prepare('UPDATE teachers SET approved = ? WHERE id = ?').run(Date.now(), t.id);
  console.log(`${t.name} (${user}) er godkendt.`);
  process.exit(0);
}

if (process.argv[2] === 'overdrag') {
  // Skolens IT har overtaget serveren og signeringsnøglen. Sammen med SCHOOL_OPERATED=1 kan der startes lektioner uden DBA_DATO.
  const db = require('../server/src/db.js').open(DATA_DIR);
  const cur = db.prepare("SELECT value FROM meta WHERE key = 'school_operated_since'").get();
  if (cur) { console.log(`Driften blev overdraget til skolen ${new Date(Number(cur.value)).toISOString().slice(0, 10)}.`); process.exit(0); }
  db.prepare("INSERT INTO meta (key, value) VALUES ('school_operated_since', ?)").run(String(Date.now()));
  console.log('Driften er registreret som overdraget til skolen.');
  if (String(process.env.SCHOOL_OPERATED || '') !== '1') console.log('Husk også SCHOOL_OPERATED=1 i miljøet – ellers er det stadig en testserver.');
  process.exit(0);
}

if (process.argv[2] === 'aktive') {
  // Før en opdatering (scripts/opdater.sh): er der lektioner eller skriveøkter i gang? Exit 1 = ja, vent med at genstarte.
  // Databasen åbnes kun til læsning og uden migrering, så tjekket kan køre ved siden af den kørende server.
  const fs = require('node:fs');
  const file = path.join(DATA_DIR, 'holymoly.db');
  if (!fs.existsSync(file)) { console.log('Ingen database endnu. Intet er i gang.'); process.exit(0); }
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (e) { db = new DatabaseSync(file); }
  const now = Date.now();
  const cols = new Set(db.prepare('PRAGMA table_info(lessons)').all().map(c => c.name));
  const home = cols.has('kind') ? "(kind = 'hjemme' OR student_id IS NOT NULL)" : 'student_id IS NOT NULL';
  const n = (sql) => { try { return db.prepare(sql).get(now).n; } catch (e) { return 0; } };
  const lessons = n(`SELECT COUNT(*) AS n FROM lessons WHERE ended IS NULL AND ends_at > ? AND NOT ${home}`);
  const solos = n(`SELECT COUNT(*) AS n FROM lessons WHERE ended IS NULL AND ends_at > ? AND ${home}`);
  const extra = n('SELECT COUNT(*) AS n FROM lesson_extensions WHERE ends_at > ?');
  db.close();
  if (!lessons && !solos && !extra) { console.log('Ingen lektioner eller skriveøkter i gang.'); process.exit(0); }
  const parts = [];
  if (lessons) parts.push(`${lessons} ${lessons === 1 ? 'lektion' : 'lektioner'}`);
  if (solos) parts.push(`${solos} ${solos === 1 ? 'skriveøkt' : 'skriveøkter'}`);
  if (extra) parts.push(`${extra} ${extra === 1 ? 'elev' : 'elever'} med ekstra tid`);
  console.log('I gang: ' + parts.join(', ') + '.');
  process.exit(1);
}

if (process.argv[2] === 'revisionsspor') {
  // Til den driftsansvarlige (klager, mistanke om en kapret lærerkonto): hvem gjorde hvad hos hvilken elev – uden indhold.
  // Elevens navn står kun med, så længe eleven findes. En slettet elev står som et pseudonym.
  const days = Number(process.argv[3] || 365);
  if (!Number.isFinite(days) || days <= 0) { console.error('Skriv antal dage:  npm run enkel -- revisionsspor 90'); process.exit(1); }
  const db = require('../server/src/db.js').open(DATA_DIR);
  const rows = db.prepare(`SELECT a.ts, a.teacher_id, t.name AS teacher, a.action, a.student_id, a.student_ref, s.name AS student, c.name AS class
    FROM audit_log a LEFT JOIN teachers t ON t.id = a.teacher_id LEFT JOIN students s ON s.id = a.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE a.ts >= ? ORDER BY a.ts, a.id`).all(Date.now() - days * 86400_000);
  const cell = (v) => { const x = v == null ? '' : String(v); return /[;"\r\n]/.test(x) || /^[=+\-@]/.test(x) ? '"' + x.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : x; };
  const out = [['Tid (UTC)', 'Lærer-id', 'Lærer', 'Handling', 'Elev-id', 'Elev', 'Klasse'].join(';')];
  for (const r of rows) out.push([new Date(r.ts).toISOString(), r.teacher_id, r.teacher, r.action, r.student_id ?? r.student_ref, r.student, r.class].map(cell).join(';'));
  process.stdout.write('\ufeff' + out.join('\r\n') + '\r\n');
  process.exit(0);
}

if (process.argv[2] === 'backup-ud') {
  // Krypteret backup ud af huset: databasen, proof-key.pem og totp.key i én fil (AES-256-GCM, nøgle fra BACKUP_PASSPHRASE).
  // Læg filen på skolens NAS eller hos en EU-udbyder. Adgangsfrasen skal opbevares to steder – uden den er nøglen tabt.
  const fs = require('node:fs');
  const KR = require('../server/src/keyring.js');
  const target = String(process.argv[3] || '').trim();
  if (!target) { console.error('Skriv hvor backuppen skal hen:  npm run enkel -- backup-ud /mnt/nas/holymoly'); process.exit(1); }
  try { KR.checkPassphrase(process.env.BACKUP_PASSPHRASE); } catch (e) { console.error(e.message + ' Sæt den i miljøet (se docs/PROXMOX.md).'); process.exit(1); }
  const dbFile = path.join(DATA_DIR, 'holymoly.db');
  const keyFile = path.join(DATA_DIR, 'proof-key.pem');
  if (!fs.existsSync(dbFile)) { console.error(`Ingen database i ${DATA_DIR}.`); process.exit(1); }
  if (!fs.existsSync(keyFile)) { console.error(`Signeringsnøglen mangler (${keyFile}).`); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-backup-ud-'));
  try {
    // En hel, konsistent kopi (VACUUM INTO) – virker, mens serveren kører
    const { DatabaseSync } = require('node:sqlite');
    const copy = path.join(tmp, 'holymoly.db');
    const src = new DatabaseSync(dbFile);
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    src.close();
    const files = [{ name: 'holymoly.db', data: fs.readFileSync(copy) }, { name: 'proof-key.pem', data: fs.readFileSync(keyFile) }];
    const totp = path.join(DATA_DIR, 'totp.key');
    if (fs.existsSync(totp)) files.push({ name: 'totp.key', data: fs.readFileSync(totp) });
    const keyId = KR.keyIdOf(crypto.createPublicKey(crypto.createPrivateKey(files[1].data)));
    const out = KR.encrypt(files, process.env.BACKUP_PASSPHRASE, { keyId });
    const day = new Date().toISOString().slice(0, 10);
    const dir = /\.hmbak$/i.test(target) ? path.dirname(target) : target;
    const file = /\.hmbak$/i.test(target) ? target : path.join(target, `holymoly-backup-${day}.hmbak`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', out, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    console.log(`Krypteret backup: ${file} (${Math.round(out.length / 1024)} KB, nøgle ${keyId}).`);
    console.log('Tjek den med:  npm run enkel -- gendan-test ' + file);
  } catch (e) {
    console.error('Backuppen fejlede: ' + e.message);
    process.exit(1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(0);
}

if (process.argv[2] === 'gendan-test') {
  // Gendannelsestest: dekrypterer til en midlertidig mappe, åbner databasen og verificerer det nyeste bevis med nøgleringen.
  const fs = require('node:fs');
  const KR = require('../server/src/keyring.js');
  const file = String(process.argv[3] || '').trim();
  const keep = String(process.argv[4] || '').trim(); // gendan rigtigt: filerne beholdes i denne (tomme) mappe
  if (!file) { console.error('Skriv backupfilen:  npm run enkel -- gendan-test holymoly-backup-ÅÅÅÅ-MM-DD.hmbak'); process.exit(1); }
  if (keep && fs.existsSync(keep) && fs.readdirSync(keep).length) { console.error(`Mappen ${keep} er ikke tom.`); process.exit(1); }
  const tmp = keep ? (fs.mkdirSync(keep, { recursive: true }), keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'hm-gendan-'));
  let code = 0;
  try {
    const { manifest, files } = KR.decrypt(fs.readFileSync(file), process.env.BACKUP_PASSPHRASE);
    for (const f of files) fs.writeFileSync(path.join(tmp, f.name), f.data, { mode: 0o600 });
    for (const need of ['holymoly.db', 'proof-key.pem']) if (!files.some(f => f.name === need)) throw new Error(need + ' mangler i backuppen.');
    const db = require('../server/src/db.js').open(tmp);
    const check = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('Databasen er ødelagt: ' + JSON.stringify(check));
    const { DocStore } = require('../server/src/docs.js');
    const docs = new DocStore(db, tmp);
    const n = (sql) => { try { return db.prepare(sql).get().n; } catch (e) { return 0; } };
    const certs = n('SELECT COUNT(*) AS n FROM certificates'), students = n('SELECT COUNT(*) AS n FROM students');
    const last = db.prepare('SELECT id, created FROM certificates WHERE expired IS NULL ORDER BY created DESC LIMIT 1').get();
    const lines = [`Backuppen er fra ${new Date(manifest.created).toISOString().slice(0, 16).replace('T', ' ')} (UTC). Databasen kan åbnes: ${students} elever, ${certs} beviser.`];
    if (last) {
      const c = docs.certificate(last.id);
      if (!c || !c.valid) throw new Error(`Det nyeste bevis (HM-${last.id.slice(0, 8).toUpperCase()}) kan ikke verificeres.`);
      lines.push(`Det nyeste bevis HM-${last.id.slice(0, 8).toUpperCase()} (${new Date(last.created).toISOString().slice(0, 10)}) er gyldigt med nøgle ${(c.payload && c.payload.keyId) || docs.keyId}.`);
    } else lines.push('Ingen beviser endnu. Signeringsnøglen passer til nøgleringen (' + docs.keyId + ').');
    db.close();
    console.log(lines.join('\n') + '\nGendannelsestesten bestod.' + (keep ? ` Filerne ligger i ${keep}.` : ''));
  } catch (e) {
    console.error('Gendannelsestesten fejlede: ' + e.message);
    code = 1;
  } finally { if (!keep || code) fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

if (process.argv[2] === 'ny-noegle' || process.argv[2] === 'ny-nøgle') {
  // Nøgleskifte: ny proof-key.pem. Den gamle nøgle bliver kun en offentlig nøgle i nøgleringen (trusted_keys) og
  // kan stadig verificere sine gamle beviser – men aldrig signere. Med --kompromitteret [dato] er beviser fra den dato ugyldige.
  const fs = require('node:fs');
  const KR = require('../server/src/keyring.js');
  const args = process.argv.slice(3);
  const ci = args.indexOf('--kompromitteret');
  let compromisedFrom = null;
  if (ci >= 0) {
    const d = args[ci + 1];
    compromisedFrom = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(d + 'T00:00:00Z') : Date.now();
    if (!Number.isFinite(compromisedFrom)) { console.error('Datoen skal skrives ÅÅÅÅ-MM-DD.'); process.exit(1); }
  }
  const db = require('../server/src/db.js').open(DATA_DIR);
  const keyPath = path.join(DATA_DIR, 'proof-key.pem');
  let old = null;
  try { old = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyPath))); } catch (e) { /* ingen nøgle endnu */ }
  const r = KR.rotate(db, old, { compromisedFrom });
  fs.writeFileSync(keyPath + '.tmp', r.privatePem, { mode: 0o600 });
  fs.renameSync(keyPath + '.tmp', keyPath); // den gamle private nøgle er væk
  if (r.oldId) {
    const pubDir = path.join(DATA_DIR, 'proof-keys');
    fs.mkdirSync(pubDir, { recursive: true });
    fs.writeFileSync(path.join(pubDir, r.oldId + '.pub.pem'), old.export({ type: 'spki', format: 'pem' }));
  }
  db.close();
  console.log(`Ny signeringsnøgle: ${r.newId}.`);
  if (r.oldId) console.log(`Den gamle nøgle (${r.oldId}) kan nu kun verificere${compromisedFrom != null ? `. Beviser udstedt fra ${new Date(compromisedFrom).toISOString().slice(0, 10)} med den er ugyldige` : ''}.`);
  console.log('Genstart serveren nu. Lav derefter en ny krypteret backup (backup-ud).');
  process.exit(0);
}

if (process.argv[2] === 'pilottal') {
  // Målinger til piloten (server/src/pilot.js): kun aggregerede tal for hele skolen pr. måned, k ≥ 5, ingen navne.
  const m = String(process.argv[3] || '').trim();
  if (m && !/^\d{4}-\d{2}$/.test(m)) { console.error('Skriv måneden som ÅÅÅÅ-MM, fx  npm run enkel -- pilottal 2027-02'); process.exit(1); }
  const from = m ? Date.parse(m + '-01T00:00:00Z') : 0;
  const to = m ? Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1) : Date.now() + 1;
  const db = require('../server/src/db.js').open(DATA_DIR);
  const PILOT = require('../server/src/pilot.js');
  process.stdout.write(PILOT.toCsv(PILOT.stats(db, { from, to })));
  db.close();
  process.exit(0);
}

if (process.argv[2] === 'bekraeft-ja' || process.argv[2] === 'bekræft-ja') {
  // Låst konfiguration (server/src/configlock.js): skolen har sagt ja til konfigurationen, som den er nu.
  // Kør med samme miljø som serveren (i Docker: docker compose exec holymoly node /app/scripts/enkel.js bekraeft-ja).
  const fs = require('node:fs');
  const { featuresFor, schoolApprovalFrom } = require('../server/src/index.js');
  const RET = require('../server/src/retention.js');
  const CL = require('../server/src/configlock.js');
  const KR = require('../server/src/keyring.js');
  const approval = schoolApprovalFrom();
  const missing = ['controller', 'dpo', 'dpiaDate', 'approvedDate'].filter(k => !approval[k]);
  if (missing.length) { console.error('Skolens ja mangler i miljøet (DATAANSVARLIG, DPO_KONTAKT, DPIA_DATO, LEDELSE_JA_DATO).'); process.exit(1); }
  let keyId;
  try { keyId = KR.keyIdOf(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(path.join(DATA_DIR, 'proof-key.pem'))))); } catch (e) { console.error('Signeringsnøglen mangler. Start serveren én gang først.'); process.exit(1); }
  const snap = CL.snapshot({ features: featuresFor(true, process.env.BETA_FEATURES || ''), retention: RET.fromEnv({}), requireGuard: (process.env.REQUIRE_GUARD ?? '1') !== '0', keyId });
  const db = require('../server/src/db.js').open(DATA_DIR);
  const changed = CL.changes(CL.read(db), snap);
  const v = CL.store(db, approval, snap, 'bekræftede konfigurationen ved skolens ja' + (changed.length ? ': ' + changed.join(', ') : ''));
  db.close();
  console.log(changed.length ? `Skolens ja gælder nu også: ${changed.join(', ')}.` : 'Konfigurationen var allerede den, skolen sagde ja til.');
  console.log(`Fingeraftryk ${v.hash}. Det står i revisionssporet. Eleverne bliver bedt om at læse vilkårene igen, hvis funktionerne er ændret.`);
  process.exit(0);
}

const { createServer } = require('../server/src/index.js');
(async () => {
  const srv = createServer({ simple: true, port: PORT, host: process.env.HOST || '0.0.0.0', dataDir: DATA_DIR });
  await srv.listen();
  const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  const setup = srv.setupCode();
  const missing = srv.approvalMissing();
  console.log([
    '',
    'HolyMoly kører i enkel tilstand (ingen e-mail, licens eller Unilogin).',
    '',
    `  Lærer, på denne computer:  http://localhost:${PORT}`,
    ...lan.map(ip => `  Lærer, på skolens net:     http://${ip}:${PORT}`),
    '',
    ...(setup ? [`  Opsætningskode til første lærer: ${setup}`, '  (Den første lærer skriver koden, når kontoen oprettes. Den virker én gang.)', ''] : []),
    '  1. Opret en lærer med navn, brugernavn og adgangskode, og lav en klasse.',
    '  2. Skriv klassekoden på tavlen.',
    '  3. Eleverne åbner HolyMoly-appen og skriver klassekoden, deres navn og en kode på 4 cifre.',
    '',
    'Elev-appen kræver https. Brug fx en Cloudflare-tunnel eller Caddy med et domæne – se docs/ENKEL.md.',
    `Data gemmes i ${DATA_DIR}. Stop med Ctrl+C.`,
    '',
    ...(missing.length ? [
      'ADVARSEL: Skolens ja mangler. Der kan ikke startes lektioner eller skriveøkter, før det er udfyldt.',
      `  Sæt ${missing.join(', ')} i miljøet, og start serveren igen (se docs/ENKEL.md):`,
      '    DATAANSVARLIG="Skolens navn"  DPO_KONTAKT="dpo@kommune.dk"  DPIA_DATO="2026-11-01"  LEDELSE_JA_DATO="2026-11-15"',
      '',
    ] : []),
  ].join('\n'));
})();
