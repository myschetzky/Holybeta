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
