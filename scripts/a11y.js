#!/usr/bin/env node
/*
 * Tilgængelighedstjek (WCAG 2.1 A/AA) af HolyMoly's sider med axe-core i en rigtig browser.
 * Kommunerne stiller krav om webtilgængelighed (EN 301 549 / WCAG 2.1), når de køber IT.
 *
 *   npm i --no-save axe-core@4        (én gang)
 *   npm run a11y                      (starter selv en demo-server)
 *
 * Afslutter med fejlkode 1, hvis der er fund.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let AXE;
try { AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) {
  console.error('axe-core mangler. Kør først:  npm i --no-save axe-core@4');
  process.exit(2);
}
const { chromium } = require('playwright');
const { createServer } = require('../server/src/index.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-a11y-'));
  const srv = createServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, requireGuard: false });
  const port = await srv.listen();
  const B = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  // CSP slås kun fra i testbrowseren, så axe kan indsprøjtes
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, bypassCSP: true });
  const p = await ctx.newPage();
  let total = 0;
  const run = async (name, pg = p) => {
    await pg.waitForTimeout(600);
    await pg.addScriptTag({ content: AXE });
    const v = await pg.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
      .map(x => ({ id: x.id, impact: x.impact, help: x.help, targets: x.nodes.slice(0, 5).map(n => n.target.join(' ')) })));
    total += v.length;
    console.log(`${v.length ? '✗' : '✓'} ${name}${v.length ? '' : ' – ingen fund'}`);
    for (const x of v) console.log(`    [${x.impact}] ${x.id}: ${x.help}\n      ${x.targets.join(' | ')}`);
  };
  try {
    for (const pth of ['/forside', '/tilbud', '/sikkerhed', '/vilkaar', '/privatliv', '/databehandleraftale', '/hent', '/login', '/opret']) {
      await p.goto(B + pth); await run(pth);
    }
    // Lærer-dashboardet med en klasse og en elev
    await p.goto(B + '/opret');
    await p.evaluate(() => { try { localStorage.setItem('hm-intro-seen', '1'); } catch (e) { /* */ } });
    await p.fill('input[name=name]', 'Mette Lærer');
    await p.fill('input[name=email]', 'mette@skole.dk');
    await p.fill('input[name=password]', 'tavle-kridt-1234-blæk');
    await p.click('#signup-submit');
    await p.waitForSelector('#new-class');
    await run('/ (klasser, tom)');
    await p.fill('#new-class input[name=name]', '2.g Dansk');
    await p.click('#new-class button');
    await p.waitForSelector('#room');
    await run('/klasse (klasseværelset)');
    await p.click('#asg-btn'); await p.waitForSelector('#dlg[open]');
    await run('/klasse (afleveringer)');
    await p.keyboard.press('Escape');
    await p.goto(B + '/konto'); await p.waitForSelector('.danger-zone');
    await run('/konto');
    // Afleveringer på tværs af klasser
    await p.evaluate(async () => { const c = (await (await fetch('/api/classes')).json())[0]; await fetch(`/api/classes/${c.id}/assignments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Novelleanalyse', due: Date.now() + 86400000, home: true }) }); });
    await p.goto(B + '/afleveringer'); await p.waitForSelector('.table');
    await run('/afleveringer');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Skolesiden findes kun med licens-styring: licens, lærere og sikkerhedsloggen (den åbnes også – virker i en rigtig browser)
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-a11y-skole-'));
  const srv2 = createServer({ port: 0, host: '127.0.0.1', dataDir: dir2, quiet: true, requireGuard: false, licensing: true, verifyEmail: false });
  const B2 = 'http://127.0.0.1:' + await srv2.listen();
  try {
    const p2 = await ctx.newPage();
    await p2.goto(B2 + '/forside'); // samme oprindelse, så fetch gemmer cookien
    const reg = await p2.evaluate(async () => (await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@skole.dk', name: 'Ada Admin', password: 'tavle-kridt-1234-blæk', schoolName: 'Tilgængelig Skole', acceptTerms: true }) })).status);
    if (reg !== 200) throw new Error('Kunne ikke oprette skolens administrator: HTTP ' + reg);
    await p2.evaluate(() => { try { localStorage.setItem('hm-intro-seen', '1'); } catch (e) { /* */ } });
    await p2.goto(B2 + '/skole');
    const btn = p2.getByRole('button', { name: 'Vis sikkerhedsloggen' });
    await btn.waitFor();
    await btn.click();
    await p2.getByText('Ada Admin oprettede skolen').waitFor({ timeout: 8000 });
    await run('/skole (licens, lærere og sikkerhedslog)', p2);
  } finally {
    await browser.close();
    await srv2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  console.log(total ? `\n${total} fund` : '\nIngen fund (WCAG 2.1 A/AA, axe-core)');
  process.exit(total ? 1 : 0);
})();
