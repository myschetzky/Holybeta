#!/usr/bin/env node
/*
 * Bygger browser-udvidelsen til:
 *   extension/dist/chromium/  + holymoly-chromium.zip  (Chrome, Edge, Brave, Opera, Vivaldi)
 *   extension/dist/firefox/   + holymoly-firefox.zip   (Firefox 115+)
 * Samme kode – kun manifestet er forskelligt.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension');
const dist = path.join(src, 'dist');
fs.copyFileSync(path.join(root, 'shared', 'rules.js'), path.join(src, 'rules.js'));
fs.rmSync(dist, { recursive: true, force: true });

const files = fs.readdirSync(src).filter(f => f !== 'dist' && !f.startsWith('.'));
const base = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

function build(name, manifest) {
  const out = path.join(dist, name);
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) fs.cpSync(path.join(src, f), path.join(out, f), { recursive: true });
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const zip = path.join(dist, `holymoly-${name}.zip`);
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
    console.log('✓', path.relative(root, zip));
  } catch (e) {
    console.log('✓', path.relative(root, out), '(zip ikke installeret – kun mappe)');
  }
}

build('chromium', base);

const ff = JSON.parse(JSON.stringify(base));
delete ff.minimum_chrome_version;
ff.background = { scripts: ['rules.js', 'background.js'] };
ff.browser_specific_settings = {
  gecko: {
    id: 'udvidelse@holymoly.dk', strict_min_version: '115.0',
    // Ærlig deklaration: besøgte sider deles med HolyMoly-appen (og læreren) under lektionen
    data_collection_permissions: { required: ['browsingActivity'] },
  },
};
ff.permissions = ff.permissions.filter(p => p !== 'declarativeNetRequestWithHostAccess');
build('firefox', ff);
