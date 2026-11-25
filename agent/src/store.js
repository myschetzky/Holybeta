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
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

module.exports = { load, save };
