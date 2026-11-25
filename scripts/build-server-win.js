#!/usr/bin/env node
/*
 * Bygger en "pak ud og kør"-version af HolyMoly-serveren til Windows:
 *   dist/HolyMoly-Server-Windows/
 *     node.exe                 (den Node, der kører scriptet – skal være 22.13+)
 *     app/server, app/shared   (serveren med sine pakker)
 *     Start HolyMoly.cmd       (starter serveren og åbner lærer-siden)
 *     LÆS MIG.txt
 * Kræver at `npm ci --omit=dev --prefix server` er kørt.
 *
 *   node scripts/build-server-win.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'HolyMoly-Server-Windows');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) { console.error('Kræver Node 22.13 eller nyere (node:sqlite)'); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'server', 'node_modules', 'ws'))) { console.error('Kør først: npm ci --omit=dev --prefix server'); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'app'), { recursive: true });
const copy = (from, to) => fs.cpSync(path.join(ROOT, from), path.join(OUT, 'app', to), { recursive: true, filter: (src) => !/[\\/](data|test)([\\/]|$)/.test(path.relative(ROOT, src)) });
copy('server/src', 'server/src');
copy('server/public', 'server/public');
copy('server/node_modules', 'server/node_modules');
copy('server/package.json', 'server/package.json');
copy('server/edition.json', 'server/edition.json');
copy('shared', 'shared');
fs.copyFileSync(process.execPath, path.join(OUT, 'node.exe'));

const cmd = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'if not exist "data" mkdir "data"',
  'set "DATA_DIR=%~dp0data"',
  'if "%PORT%"=="" set PORT=8080',
  'if exist "indstillinger.cmd" call "indstillinger.cmd"',
  'echo.',
  'echo   HolyMoly-serveren starter paa http://localhost:%PORT%',
  'echo   Luk dette vindue for at stoppe serveren.',
  'echo.',
  'start "" "http://localhost:%PORT%/opret"',
  // Stopper serveren uventet (fejl), startes den igen – højst 20 gange, så fx en optaget port ikke giver en evig løkke
  'set RESTARTS=0',
  ':run',
  '"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0app\\server\\src\\index.js"',
  'if not errorlevel 1 goto end',
  'set /a RESTARTS+=1',
  'if %RESTARTS% gtr 20 goto end',
  'echo.',
  'echo   HolyMoly stoppede uventet. Starter igen om 5 sekunder ... (%RESTARTS%/20)',
  'timeout /t 5 /nobreak >nul',
  'goto run',
  ':end',
  'pause',
].join('\r\n') + '\r\n';
fs.writeFileSync(path.join(OUT, 'Start HolyMoly.cmd'), cmd);

const settings = [
  'rem Indstillinger til HolyMoly-serveren (fjern "rem" foran de linjer, du vil bruge).',
  'rem Se alle muligheder i README.md og deploy/.env.example på GitHub.',
  'rem set PORT=8080',
  'rem set PUBLIC_URL=https://holymoly.minskole.dk',
  'rem set TEACHER_SIGNUP_CODE=en-lang-hemmelig-kode',
  'rem set SMTP_URL=smtps://bruger:kode@smtp.minskole.dk:465',
  'rem set MAIL_FROM=HolyMoly ^<noreply@minskole.dk^>',
  'rem set LOG_RETENTION_DAYS=30',
].join('\r\n') + '\r\n';
fs.writeFileSync(path.join(OUT, 'indstillinger.cmd'), settings);

const readme = `HolyMoly-serveren til Windows
==============================

1. Dobbeltklik på "Start HolyMoly.cmd". Lærer-siden åbner i browseren (http://localhost:8080).
2. Opret en lærerkonto og en klasse. Klassen får en klassekode.
3. Data (database, beviser, nøgler) gemmes i mappen "data" ved siden af. Tag backup af den.

Elev-appen og browseren på ANDRE computere
------------------------------------------
Elev-appen taler kun med serveren over HTTPS (ellers kan andre på skolens net læse med).
På denne computer virker http://localhost:8080 til at prøve HolyMoly.
Til en rigtig klasse skal serveren have en HTTPS-adresse, fx med Caddy (se deploy/ på GitHub)
eller en hostet HolyMoly. Skolens IT kan give elev-appen adressen ved installationen:

   HolyMoly-Setup.exe /S /SERVER=https://holymoly.minskole.dk

Ellers spørger elev-appen om adressen første gang.

Indstillinger (e-mail, skolekode, adresse) sættes i "indstillinger.cmd".
`;
fs.writeFileSync(path.join(OUT, 'LÆS MIG.txt'), '﻿' + readme.replace(/\n/g, '\r\n'));
console.log('✓', path.relative(ROOT, OUT), `(Node ${process.versions.node})`);
