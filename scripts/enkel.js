#!/usr/bin/env node
/*
 * HolyMoly i enkel tilstand – til at komme i gang på én skole uden e-mail, licens eller Unilogin.
 *
 *   npm run enkel                         starter serveren (data gemmes i server/data)
 *   npm run enkel -- nulstil <brugernavn> laver en ny midlertidig adgangskode til en lærer
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
