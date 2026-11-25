#!/usr/bin/env node
/*
 * Bygger HolyMoly's hjemmeside til GitHub Pages (site/):
 *
 *   index.html                 forsiden (server/public/forside.html) med priser
 *   demo.html                  det rigtige lærer-dashboard + en simulator (scripts/pages/shim.js), der svarer i stedet
 *                              for serveren med data optaget fra `npm run demo` (scripts/pages/demo-data.json)
 *   vilkaar.html, privatliv.html, databehandleraftale.html, hent.html
 *
 * GitHub Pages kan kun levere statiske filer, så dashboardets adresser er #login, #klasser, #klasse-1 osv.
 * Er HolyMoly hostet et sted, peger "Prøv gratis" og "Log ind" derhen:  HOLYMOLY_APP_URL=https://app.holymoly.dk
 *
 *   node scripts/build-pages.js              ->  site/
 *   node scripts/build-pages.js --fragment   ->  site/fragment.html (demoen uden <html>/<head>, til indlejring)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const P = path.join(ROOT, 'server', 'public') + path.sep;
const OUT = path.join(ROOT, 'site');
const fragment = process.argv.includes('--fragment');

const must = (s, a, b) => {
  if (!s.includes(a)) throw new Error('build-pages: fandt ikke "' + a.slice(0, 70) + '" – er dashboardet ændret?');
  return s.split(a).join(b);
};
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'pages', 'demo-data.json'), 'utf8'));
const iconSvg = fs.readFileSync(P + 'icon.svg');
const icon = 'data:image/svg+xml;base64,' + iconSvg.toString('base64');

let css = fs.readFileSync(P + 'app.css', 'utf8');
css += `
.demo-note { font-size: 13px; background: color-mix(in srgb, var(--accent) 10%, var(--panel)); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 8px; padding: 8px 10px; margin: 0; }
.demo-note b { user-select: all; }
`;

const html = fs.readFileSync(P + 'index.html', 'utf8');
let body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="/shared/doc.js">'));
body = must(body, '/icon.svg', icon);
body = must(body, '<p class="error" id="auth-error" hidden></p>',
  '<p class="demo-note">Demo: log ind som lærer med <b>demo@holymoly.dk</b> og adgangskoden <b>demo-kodeord</b>. Alle elever er simulerede – intet sendes nogen steder hen.</p>\n        <p class="error" id="auth-error" hidden></p>');
body = must(body, '<input name="email" type="email" autocomplete="username"', '<input name="email" type="email" value="demo@holymoly.dk" autocomplete="username"');
body = must(body, '<input name="password" type="password" autocomplete="current-password"', '<input name="password" type="password" value="demo-kodeord" autocomplete="current-password"');

let js = fs.readFileSync(P + 'app.js', 'utf8');
// Adresser i hash (#klasse-1) i stedet for stier, så det virker på GitHub Pages
js = must(js, "if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState']({}, '', path);",
  "const hh = window.__hmToHash(path); if (location.hash !== hh) history[replace ? 'replaceState' : 'pushState'](null, '', hh);");
js = must(js, 'const p = location.pathname;', 'const p = window.__hmFromHash(location.hash);');
js = must(js, "src: '/api/evidence/' + e.evidenceId", 'src: window.__hmEvidence(e.evidenceId)');
js = must(js, "window.open('/api/evidence/' + e.evidenceId, '_blank', 'noopener')", "void 0");
js = must(js, "h('a', { href: '/bevis/' + d.certId, target: '_blank', rel: 'noopener', text: 'Se beviset' })", "h('span', { class: 'muted', text: '(tjek-siden findes på den rigtige HolyMoly-server)' })");
// Links fra demoen til de statiske sider ved siden af
for (const [a, b] of [['href="/forside"', 'href="index.html"'], ['href="/vilkaar"', 'href="vilkaar.html"'], ['href="/privatliv"', 'href="privatliv.html"'], ['href="/hent"', 'href="hent.html"']]) body = body.split(a).join(b);
js = must(js, "sub.certId ? h('a', { class: 'btn small ghost', href: '/bevis/' + sub.certId, target: '_blank', rel: 'noopener', text: 'Tjek' }) : null", 'null');
js = must(js, "csv.href = `/api/classes/${classId}/lessons/${id}.csv`;", "csv.onclick = () => toast('I den rigtige HolyMoly hentes rapporten her som regneark (CSV)');");
js = must(js, "help: () => { location.href = '/hjaelp.html'; }", "help: () => toast('Lærervejledningen findes i den rigtige HolyMoly')");
js = must(js, "$('#d-export').href = `/api/students/${id}/export.csv`;", "$('#d-export').onclick = () => toast('I den rigtige HolyMoly hentes elevens log her som regneark (CSV)');");

let acc = fs.readFileSync(P + 'account.js', 'utf8');
acc = must(acc, "onclick: () => { location.href = '/hjaelp.html'; }", "onclick: () => toast('Lærervejledningen findes i den rigtige HolyMoly')");
acc = must(acc, "setTimeout(() => { location.href = '/forside'; }, 800);", "void 0;");
for (const [a, b] of [["href: '/forside'", "href: 'index.html'"], ["href: '/vilkaar'", "href: 'vilkaar.html'"], ["href: '/privatliv'", "href: 'privatliv.html'"], ["href: '/databehandleraftale'", "href: 'databehandleraftale.html'"], ["href: '/hent'", "href: 'hent.html'"], ["src: '/icon.svg'", 'src: ' + JSON.stringify(icon)]]) acc = acc.split(a).join(b);

const routing = `
var HM_PAGES = ['login', 'elev', 'afleveringer', 'opret', 'glemt', 'nulstil', 'bekraeft', 'konto', 'skole', 'admin'];
window.__hmToHash = function (p) {
  p = String(p).split('#')[0].split('?')[0];
  var m = /^\\/klasse\\/(\\d+)$/.exec(p);
  if (m) return '#klasse-' + m[1];
  var k = p.replace(/^\\//, '');
  return HM_PAGES.indexOf(k) >= 0 ? '#' + k : '#klasser';
};
window.__hmFromHash = function (h) {
  var m = /^#klasse-(\\d+)$/.exec(h || '');
  if (m) return '/klasse/' + m[1];
  if (h === '#klasser') return '/';
  var k = String(h || '').replace(/^#/, '');
  return HM_PAGES.indexOf(k) >= 0 ? '/' + k : '/login';
};`;

const theme = fs.readFileSync(P + 'theme.js', 'utf8');
const head = `<script>
${theme}</script>
<style>
${css}</style>`;
const scripts = `<script>window.__HM_DATA = ${esc(JSON.stringify(data))};${routing}</script>
<script>
${esc(fs.readFileSync(path.join(ROOT, 'shared', 'doc.js'), 'utf8'))}</script>
<script>
${esc(fs.readFileSync(path.join(__dirname, 'pages', 'shim.js'), 'utf8'))}</script>
<script>
${esc(js)}</script>
<script>
${esc(acc)}</script>`;

fs.mkdirSync(OUT, { recursive: true });
if (fragment) {
  const out = `<title>HolyMoly Lærerdemo</title>\n${head}\n${body}\n${scripts}\n`;
  fs.writeFileSync(path.join(OUT, 'fragment.html'), out);
  console.log('site/fragment.html', out.length, 'bytes');
} else {
  const page = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="HolyMoly – elevernes bevis på, at deres tekst ikke er skrevet med AI. Prøv lærer-dashboardet med en simuleret klasse.">
<title>HolyMoly – demo</title>
<link rel="icon" href="icon.svg" type="image/svg+xml">
${head}
</head>
<body>
${body}
${scripts}
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, 'demo.html'), page);
  fs.writeFileSync(path.join(OUT, 'icon.svg'), iconSvg);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('site/demo.html', page.length, 'bytes');

  // Forside, jura og hent-side: samme filer som på serveren, med relative links
  const siteCfg = { pages: true, app: process.env.HOLYMOLY_APP_URL || '', demo: 'demo.html',
    pricing: { perStudent: Number(process.env.PRICE_PER_STUDENT || 129), minimum: Number(process.env.PRICE_MINIMUM || 2500), trialDays: Number(process.env.TRIAL_DAYS || 30) },
    info: { company: { name: process.env.COMPANY_NAME || 'HolyMoly', cvr: process.env.COMPANY_CVR || '', email: process.env.COMPANY_EMAIL || '', address: process.env.COMPANY_ADDRESS || '', hosting: process.env.HOSTING_PROVIDER || '' } } };
  for (const [src, dst] of [['forside.html', 'index.html'], ['vilkaar.html', 'vilkaar.html'], ['vilkaar-elev.html', 'vilkaar-elev.html'], ['privatliv.html', 'privatliv.html'], ['databehandleraftale.html', 'databehandleraftale.html'], ['hent.html', 'hent.html'], ['tilbud.html', 'tilbud.html'], ['sikkerhed.html', 'sikkerhed.html']]) {
    let h = fs.readFileSync(P + src, 'utf8');
    for (const [a, b] of [['href="/site.css"', 'href="site.css"'], ['src="/theme.js"', 'src="theme.js"'], ['href="/icon.svg"', 'href="icon.svg"'],
      ['href="/vilkaar"', 'href="vilkaar.html"'], ['href="/privatliv"', 'href="privatliv.html"'], ['href="/databehandleraftale"', 'href="databehandleraftale.html"'], ['href="/hent"', 'href="hent.html"'], ['href="/tilbud"', 'href="tilbud.html"'], ['href="/sikkerhed"', 'href="sikkerhed.html"'], ['src="/img/', 'src="img/'], ['src="/icon.svg"', 'src="icon.svg"'], ['src="/tilbud.js"', 'src="tilbud.js"']]) h = h.split(a).join(b);
    h = must(h, '<script src="/site.js"></script>', `<script>window.HM_SITE = ${esc(JSON.stringify(siteCfg))};</script>\n  <script src="site.js"></script>`);
    fs.writeFileSync(path.join(OUT, dst), h);
  }
  for (const f of ['site.css', 'site.js', 'theme.js', 'tilbud.js']) fs.copyFileSync(P + f, path.join(OUT, f));
  fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
  for (const f of fs.readdirSync(P + 'img')) fs.copyFileSync(path.join(P, 'img', f), path.join(OUT, 'img', f));
  console.log('site/index.html (forside) + jura og hent-side');
}
