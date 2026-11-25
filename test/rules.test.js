'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/rules.js');

const c = R.compile();
const cat = (u) => { const r = c.classifyUrl(u); return r && r.blocked ? r.category : null; };

test('direkte domæner blokeres', () => {
  assert.strictEqual(cat('https://chatgpt.com/c/abc'), 'ai');
  assert.strictEqual(cat('https://www.instagram.com/'), 'social');
  assert.strictEqual(cat('https://m.tiktok.com/@x'), 'social');
  assert.strictEqual(cat('https://www.snapchat.com/web'), 'social');
  assert.strictEqual(cat('https://likee.video/'), 'social');
  assert.strictEqual(cat('https://gemini.google.com/app'), 'ai');
  assert.strictEqual(cat('https://poki.com/da'), 'games');
});

test('almindelige skolesider er tilladt', () => {
  for (const u of ['https://www.lectio.dk/lectio/1/forside.aspx', 'https://docs.google.com/document/d/1/edit',
    'https://www.dr.dk/nyheder', 'https://www.google.com/search?q=fotosyntese', 'https://da.wikipedia.org/wiki/TikTok',
    'https://www.office.com/', 'https://classroom.google.com/', 'https://www.ordnet.dk/ddo', 'https://example.com/?utm_source=instagram.com']) {
    assert.strictEqual(cat(u), null, u);
  }
});

test('Google Translate som proxy fanges', () => {
  assert.strictEqual(cat('https://chatgpt-com.translate.goog/?_x_tr_sl=en&_x_tr_tl=da'), 'ai');
  assert.strictEqual(cat('https://www-instagram-com.translate.goog/'), 'social');
  assert.strictEqual(cat('https://translate.google.com/translate?sl=en&tl=da&u=https://claude.ai/new'), 'ai');
  assert.strictEqual(cat('https://translate.google.dk/translate?u=chatgpt.com'), 'ai');
});

test('indlejrede og base64-kodede adresser i proxyer', () => {
  const b64 = Buffer.from('https://www.tiktok.com/foryou').toString('base64');
  assert.strictEqual(cat('https://random-cdn.example/?__cpo=' + b64), 'social');
  assert.strictEqual(cat('https://site.example/go/' + Buffer.from('https://chatgpt.com').toString('base64url')), 'ai');
  // Arkivet bruges i kildekritik – kun arkiverede kopier af forbudte sider blokeres
  assert.strictEqual(cat('https://web.archive.org/web/2024/https://www.instagram.com/'), 'social');
  assert.strictEqual(cat('https://web.archive.org/web/2024/https://www.dr.dk/'), null);
  assert.strictEqual(cat('https://accounts.google.com/signin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'), 'ai');
});

test('unblocked games og proxyer på gratis hosting', () => {
  assert.strictEqual(cat('https://sites.google.com/view/unblocked-games-66'), 'games');
  assert.strictEqual(cat('https://someone.github.io/eaglercraft/'), 'games');
  assert.strictEqual(cat('https://my-proxy.vercel.app/'), 'proxy');
  assert.strictEqual(cat('https://www.croxyproxy.com/'), 'proxy');
});

test('AI gemt i søgemaskiner', () => {
  assert.strictEqual(cat('https://www.bing.com/chat?q=hej'), 'ai');
  assert.strictEqual(cat('https://www.google.com/search?q=x&udm=50'), 'ai');
  assert.strictEqual(cat('https://duckduckgo.com/?q=x&ia=chat'), 'ai');
  assert.strictEqual(cat('https://www.bing.com/search?q=x'), null);
});

test('lærerens indstillinger', () => {
  const c2 = R.compile(null, { categories: { video: false }, extraBlocked: ['kahoot.it'], allowed: ['youtube.com'] });
  assert.strictEqual(c2.classifyUrl('https://www.youtube.com/watch?v=1'), null);
  assert.strictEqual(c2.classifyUrl('https://kahoot.it/').category, 'custom');
  assert.strictEqual(c2.classifyUrl('https://kahoot.it/').blocked, true);
  const tr = c2.classifyUrl('https://www.deepl.com/translator');
  assert.strictEqual(tr.blocked, false); // oversættelse er tilladt som standard
});

test('programmer og vinduestitler', () => {
  assert.strictEqual(c.classifyApp('Discord.exe').category, 'social');
  assert.strictEqual(c.classifyApp('RobloxPlayerBeta').category, 'games');
  assert.strictEqual(c.classifyApp('ChatGPT').category, 'ai');
  assert.strictEqual(c.classifyApp('AnyDesk.exe').category, 'remote');
  assert.strictEqual(c.classifyApp('tor').category, 'proxy');
  assert.strictEqual(c.classifyApp('WINWORD', 'Dansk stil.docx - Word'), null);
  assert.strictEqual(c.classifyApp('Taskmgr'), null);
  assert.strictEqual(c.classifyApp('torrent-helper'), null); // "tor" matcher kun præcist
  assert.strictEqual(c.classifyApp('ApplicationFrameHost', 'Instagram').category, 'social');
  assert.strictEqual(c.browserOf('msedge.exe'), 'edge');
  assert.strictEqual(c.browserOf('firefox'), 'firefox');
  assert.strictEqual(c.classifyTitle('TikTok - Wikipedia'), null);
  assert.strictEqual(c.classifyTitle('Lofi beats - YouTube').category, 'video');
  assert.strictEqual(c.classifyTitle('ChatGPT').category, 'ai');
  assert.strictEqual(c.classifySiteName('Instagram').category, 'social');
});

test('kopierne af regelfilen er identiske', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../shared/rules.js'), 'utf8');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '../extension/rules.js'), 'utf8'), src, 'extension/rules.js er ude af sync – kør npm run sync');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '../agent/src/rules.js'), 'utf8'), src, 'agent/src/rules.js er ude af sync – kør npm run sync');
});

test('gennemgang: ingen falsk blokering af tilladte sider, billedsøgning og dokumentation', () => {
  // Lærerens "altid tilladte" sider kan udvidelsen slå op (så indholds-genkendelsen lader dem være)
  const ok = R.compile(null, { allowed: ['youtube.com'] });
  assert.strictEqual(ok.isAllowedHost('www.youtube.com'), true);
  assert.strictEqual(ok.isAllowedHost('chatgpt.com'), false);
  // Billedsøgning med et YouTube-miniaturebillede som kilde er ikke et besøg på YouTube
  for (const u of [
    'https://www.bing.com/images/search?q=kat&mediaurl=https%3a%2f%2fi.ytimg.com%2fvi%2fx%2fhq.jpg',
    'https://duckduckgo.com/?q=kat&iai=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx',
    'https://www.google.com/imgres?imgurl=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg&imgrefurl=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx',
  ]) assert.ok(!(c.classifyUrl(u) || {}).blocked, u);
  // Dokumentation om "proxy" er ikke en proxy-side – men tydelige "unblocked"-sider er stadig blokeret
  assert.ok(!(c.classifyUrl('https://x.github.io/design-patterns/proxy') || {}).blocked);
  assert.ok(c.classifyUrl('https://unblocked-games.github.io/').blocked);
  assert.ok(c.classifyUrl('https://www.croxyproxy.com/').blocked);
});
