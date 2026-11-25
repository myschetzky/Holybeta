'use strict';
/* Gemmer elevens tilmeldinger lokalt. Tokens krypteres med OS'ets nøglering hvor muligt. */
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'holymoly.json');

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
    return { enrollments };
  } catch (e) {
    return { enrollments: [] };
  }
}

function save(state) {
  const enc = canEncrypt();
  const out = {
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
