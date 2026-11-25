'use strict';
/*
 * Skærmbilleder af afleveringssiden i hovedvinduet med en attrap af broen (test/sim/afleveringer-stub.js).
 *   node test/sim/afleveringer-shot.js      → test/sim/out/afleveringer-*.png
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const stub = require('./afleveringer-stub.js');

(async () => {
  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 780, height: 600 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(stub);
  await p.goto('file://' + path.join(__dirname, '..', '..', 'agent', 'renderer', 'index.html'));
  await p.waitForSelector('#status:not([hidden])');
  await p.screenshot({ path: path.join(out, 'afleveringer-0-hovedvindue.png') });
  await p.click('#afl-btn');
  await p.waitForSelector('#afl-open-table tbody tr');
  await p.screenshot({ path: path.join(out, 'afleveringer-1-side.png'), fullPage: true });
  await p.click('#afl-write'); await p.waitForSelector('#afl-pick[open]');
  await p.screenshot({ path: path.join(out, 'afleveringer-2-hvilken.png') });
  await p.keyboard.press('Escape');
  await p.click('#afl-verified'); await p.waitForSelector('#afl-docs[open]');
  await p.screenshot({ path: path.join(out, 'afleveringer-3-verificerede.png') });
  await p.keyboard.press('Escape');
  await p.click('#afl-past-table button'); await p.waitForSelector('#afl-attach[open]');
  await p.click('#afl-attach-more summary');
  await p.click('#afl-attach-marked .afl-choice');
  await p.click('#afl-attach-go'); await p.waitForSelector('#afl-attach-result.ok');
  await p.screenshot({ path: path.join(out, 'afleveringer-4-aflever.png') });
  await browser.close();
  if (errors.length) { console.error('Fejl i siden:\n' + errors.join('\n')); process.exit(1); }
  console.log('Gemt i ' + out);
})();
