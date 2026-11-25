'use strict';
// CI-tjek: de kopierede filer skal være præcis som kilden i shared/. Fejler testen, så kør `npm run sync`
// (og `node scripts/build-extensions.js`, hvis browser-udvidelsen er bygget lokalt i extension/dist).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Kopierne, som `npm run sync` laver (læst fra package.json, så listen ikke kan glide fra scriptet). */
function syncPairs() {
  const script = JSON.parse(read('package.json')).scripts.sync;
  const pairs = [];
  // for(const d of ['agent/src/rules.js','extension/rules.js'])fs.copyFileSync('shared/rules.js',d)
  for (const m of script.matchAll(/for\(const d of \[([^\]]*)\]\)fs\.copyFileSync\('([^']+)',d\)/g)) {
    for (const d of m[1].matchAll(/'([^']+)'/g)) pairs.push([m[2], d[1]]);
  }
  // fs.copyFileSync('shared/netwatch.js','agent/src/netwatch.js')
  for (const m of script.matchAll(/fs\.copyFileSync\('([^']+)','([^']+)'\)/g)) pairs.push([m[1], m[2]]);
  return pairs;
}

test('npm run sync: hver fil i shared/ har en kopi, og kopierne er identiske med kilden', () => {
  const pairs = syncPairs();
  assert.ok(pairs.length >= 4, 'sync-scriptet kunne læses: ' + JSON.stringify(pairs));
  for (const f of fs.readdirSync(path.join(root, 'shared')).filter(n => n.endsWith('.js'))) {
    assert.ok(pairs.some(([src]) => src === 'shared/' + f), `shared/${f} kopieres ikke af npm run sync`);
  }
  const stale = pairs.filter(([src, dst]) => !fs.existsSync(path.join(root, dst)) || read(src) !== read(dst)).map(([src, dst]) => `${dst} (fra ${src})`);
  assert.deepStrictEqual(stale, [], 'kopierne afviger fra shared/ – kør npm run sync');
});

test('browser-udvidelsen: en bygget extension/dist har samme rules.js som shared/', () => {
  const dist = path.join(root, 'extension', 'dist');
  // dist er ikke i git; den bygges af scripts/build-extensions.js (CI bygger den forfra)
  const builds = fs.existsSync(dist) ? fs.readdirSync(dist, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const stale = builds.filter(b => !fs.existsSync(path.join(dist, b, 'rules.js')) || fs.readFileSync(path.join(dist, b, 'rules.js'), 'utf8') !== read('shared/rules.js'));
  assert.deepStrictEqual(stale.map(b => `extension/dist/${b}/rules.js`), [], 'udvidelsen er bygget med gamle regler – kør node scripts/build-extensions.js');
  // Bygge-scriptet kopierer selv shared/rules.js, før det bygger
  assert.match(read('scripts/build-extensions.js'), /fs\.copyFileSync\(path\.join\(root, 'shared', 'rules\.js'\), path\.join\(src, 'rules\.js'\)\)/);
});
