'use strict';
/* Gemmer elevens tilmeldinger lokalt. Tokens krypteres med OS'ets nøglering hvor muligt. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'holymoly.json');

/* Tilfældigt id for denne computer. Serveren får det i stedet for computerens navn (som ofte er elevens navn). */
const newDeviceId = () => crypto.randomBytes(9).toString('base64url');
const validDeviceId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(v);

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const enrollments = (raw.enrollments || []).map((e) => {
      let token = null;
      try {
        token = e.enc ? safeStorage.decryptString(Buffer.from(e.token, 'base64')) : e.token;
      } catch (err) { token = null; }
      return token ? { token, studentId: Number(e.studentId) || 0, studentName: e.studentName, className: e.className, teacherName: e.teacherName } : null;
    }).filter(Boolean);
    return { enrollments, deviceId: validDeviceId(raw.deviceId) ? raw.deviceId : newDeviceId() };
  } catch (e) {
    return { enrollments: [], deviceId: newDeviceId() };
  }
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (e) { return {}; }
}
function writeRaw(out) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/*
 * Skrivevinduets visning (kun på denne computer): zoom (Ctrl +/-/0, -1..3), tekststørrelse (14-24 px) og linjeafstand.
 * Det påvirker ikke dokumentet eller Word-filen.
 */
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function cleanPrefs(p) {
  const o = p && typeof p === 'object' ? p : {};
  return { zoom: clamp(o.zoom, -1, 3, 0), size: Math.round(clamp(o.size, 14, 24, 16)), lh: o.lh === 'luftig' ? 'luftig' : 'normal' };
}
function loadWriterPrefs() { return cleanPrefs(readRaw().writerPrefs); }
function saveWriterPrefs(p) {
  const raw = readRaw();
  raw.writerPrefs = cleanPrefs(Object.assign(cleanPrefs(raw.writerPrefs), p && typeof p === 'object' ? p : {}));
  try { writeRaw(raw); } catch (e) { /* disken er fuld e.l. – visningen er ikke vigtig */ }
  return raw.writerPrefs;
}

function save(state) {
  const enc = canEncrypt();
  if (!validDeviceId(state.deviceId)) state.deviceId = newDeviceId();
  const out = {
    deviceId: state.deviceId,
    enrollments: state.enrollments.map((e) => ({
      token: enc ? safeStorage.encryptString(e.token).toString('base64') : e.token,
      enc,
      studentId: e.studentId,
      studentName: e.studentName, className: e.className, teacherName: e.teacherName,
    })),
  };
  const prefs = readRaw().writerPrefs; // skrivevinduets visning bevares
  if (prefs) out.writerPrefs = cleanPrefs(prefs);
  writeRaw(out);
}

module.exports = { load, save, loadWriterPrefs, saveWriterPrefs, cleanPrefs };
