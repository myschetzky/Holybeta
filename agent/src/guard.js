'use strict';
/*
 * Elev-appens side af HolyMoly-vagten (den administrator-/root-tjeneste der installeres sammen med appen).
 *
 * Vagten taler SELV med serveren (signeret med sin egen nøgle) og får lektion, blokeringsliste og
 * "luk dette program" derfra – ikke fra elev-appen. Appens eneste opgave her er at aflevere
 * engangs-parringskoden fra serveren til vagten (requests/pair.txt), første gang computeren bruges.
 * Vagten skriver sin status (guard-status.json, kun administrator kan ændre den) som appen viser.
 */
const fs = require('node:fs');
const path = require('node:path');

const PREFIXES = ['', 'www.', 'm.', 'api.', 'chat.', 'app.', 'web.', 'mobile.', 'login.', 'auth.'];
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function dataDir() {
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'HolyMoly');
  if (process.platform === 'darwin') return '/Library/Application Support/HolyMoly';
  return process.env.HM_GUARD_DIR || null; // Linux: kun til test
}

/** hosts-filen kan ikke wildcards – så de mest brugte underdomæner skrives ud. */
function expandHosts(domains, max = 20000) {
  const out = new Set();
  for (const raw of domains) {
    const d = String(raw || '').toLowerCase().trim().replace(/^\*\./, '').replace(/^www\./, '');
    if (!HOST_RE.test(d) || d.length > 240) continue;
    for (const p of PREFIXES) {
      if (out.size >= max) break;
      out.add(p + d);
    }
  }
  return [...out].sort();
}

/** Afleverer engangs-parringskoder (fra serveren) til vagten: { studentId: kode } */
function writePairRequest(codes, dir = dataDir()) {
  if (!dir || !codes) return false;
  const lines = Object.entries(codes)
    .filter(([sid, code]) => /^\d+$/.test(String(sid)) && /^[A-Za-z0-9_-]{20,100}$/.test(String(code)))
    .map(([sid, code]) => `pair=${sid}\t${code}`);
  if (!lines.length) return false;
  try {
    const reqDir = path.join(dir, 'requests');
    const tmp = path.join(reqDir, `pair.${process.pid}.tmp`);
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, path.join(reqDir, 'pair.txt'));
    return true;
  } catch (e) {
    return false;
  }
}

/** Første opsætning: beder vagten om at gemme skolens serveradresse (vagten gør det kun, hvis ingen er sat). */
function writeServerRequest(url, dir = dataDir()) {
  if (!dir || !/^(https:\/\/[a-z0-9.:-]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(String(url))) return false;
  try {
    const reqDir = path.join(dir, 'requests');
    const tmp = path.join(reqDir, `server.${process.pid}.tmp`);
    fs.writeFileSync(tmp, url + '\n');
    fs.renameSync(tmp, path.join(reqDir, 'server.txt'));
    return true;
  } catch (e) {
    return false;
  }
}

/** Vagtens status, eller null hvis den ikke findes / er forældet. */
function readStatus(dir = dataDir(), now = Date.now()) {
  if (!dir) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'guard-status.json'), 'utf8').replace(/^\uFEFF/, ''));
    const ts = Number(s.ts) || 0;
    return {
      fresh: now - ts < 30_000 && ts <= now + 60_000,
      ts,
      version: String(s.version || ''),
      lessonUntil: Number(s.lessonUntil) || 0,
      hostsActive: !!s.hostsActive,
      hostsCount: Number(s.hostsCount) || 0,
      tamper: (Array.isArray(s.tamper) ? s.tamper : []).slice(-20).map(t => ({ ts: Number(t.ts) || 0, what: String(t.what || '').slice(0, 200) })),
    };
  } catch (e) {
    return null;
  }
}

/** Er vagten installeret? (status-mappen findes) */
function installed(dir = dataDir()) {
  try { return !!dir && fs.existsSync(path.join(dir, 'requests')); } catch (e) { return false; }
}

module.exports = { expandHosts, writePairRequest, writeServerRequest, readStatus, installed, dataDir, HOST_RE };
