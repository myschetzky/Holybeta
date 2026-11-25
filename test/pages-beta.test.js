'use strict';
// GitHub Pages: med "simple": true i server/edition.json (beta/Holybeta) bygges beta-forsiden – uden priser og /tilbud
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const build = (env) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-pages-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-pages.js')], { env: Object.assign({}, process.env, { PAGES_OUT: out }, env), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return out;
};

test('build-pages: beta-forside uden priser og /tilbud, når udgaven er enkel', () => {
  const out = build({ PAGES_BETA: '1' });
  try {
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(index, /Skolens ja/);
    assert.match(index, /Hvis HolyMoly ikke virker/);
    assert.doesNotMatch(index, /prøveperiode|129|Unilogin|tilbud/i);
    assert.match(index, /"beta":true/);
    assert.match(index, /"preview":true/, 'statusboksen ved, at der ingen server er bag siden');
    assert.ok(index.includes('href="vilkaar-elev.html"') && index.includes('href="databehandleraftale.html"'), 'relative links');
    assert.ok(!fs.existsSync(path.join(out, 'tilbud.html')) && !fs.existsSync(path.join(out, 'tilbud.js')));
    assert.ok(fs.existsSync(path.join(out, 'databehandleraftale.html')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('build-pages: den fulde udgave har priser og /tilbud som i dag', () => {
  const out = build({ PAGES_BETA: '0' });
  try {
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(index, /Start skolens prøveperiode/);
    assert.match(index, /"perStudent":129/);
    assert.ok(fs.existsSync(path.join(out, 'tilbud.html')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('build-pages: udgaven læses fra server/edition.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-pages.js'), 'utf8');
  assert.match(src, /edition\.json/);
  assert.match(src, /beta \? 'forside-beta\.html' : 'forside\.html'/);
});
