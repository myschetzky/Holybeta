/* HolyMoly i browseren (GitHub Pages / demo): en lille simulator der svarer i stedet for serveren.
 * Klassen, lamperne og hændelserne er optaget fra den rigtige HolyMoly-server (npm run demo) – se scripts/build-pages.js.
 * Alt kører lokalt i browseren; intet sendes nogen steder hen. */
(function () {
  'use strict';
  const D = window.__HM_DATA;
  const NOW0 = Date.now();
  const shift = NOW0 - D.capturedAt;               // flyt de optagne tidspunkter til "nu"
  const T = (ts) => ts + shift;
  const CLASS_ID = D.cls.id;
  const EMAIL = 'demo@holymoly.dk', PASSWORD = 'demo-kodeord';
  const LATE = 'Karla Dam';                         // tilmelder sig selv med klassekoden undervejs

  let loggedIn = false;
  const cls = JSON.parse(JSON.stringify(D.cls));
  cls.joinOpen = true;
  cls.config.links = [{ title: 'Opgave 3 – Romantikken', url: 'https://lex.dk/romantikken' }, { title: 'Den Danske Ordbog', url: 'https://ordnet.dk/ddo' }];
  const hands = new Map();
  let lesson = { live: true, id: 1, started: NOW0 - 14 * 60_000, endsAt: NOW0 + 76 * 60_000 };
  const liveViews = new Map(D.snapshot.students.map(v => [v.studentId, Object.assign({}, v)]));
  const frozen = new Map(); // id -> 'freeze' | 'review'
  let nextEventId = 1000;
  const evidence = new Map();
  const byName = (n) => cls.students.find(s => s.name === n) || {};
  const late = byName(LATE);
  if (late.id) late.joined = false;                 // står ikke i klasseværelset endnu
  window.__hmEvidence = (id) => evidence.get(Number(id)) || '';

  /* ---------- elevernes verden (efter navn) ---------- */
  const WN = {
    'Anna Jensen': { browser: 'Chrome', tabs: [['docs.google.com/document/d/1x', 'Dansk stil – Google Docs', 1], ['www.lectio.dk/lectio/skema', 'Skema – Lectio'], ['ordnet.dk/ddo', 'Den Danske Ordbog']], apps: ['Google Chrome', 'Microsoft Teams'], screen: 'doc', cycle: [['docs.google.com – Dansk stil', 'https://docs.google.com/document/d/1x'], ['ordnet.dk – Den Danske Ordbog', 'https://ordnet.dk/ddo/ordbog?query=metafor'], ['docs.google.com – Dansk stil', 'https://docs.google.com/document/d/1x']] },
    'Bo Nielsen': { browser: 'Edge', tabs: [['www.lectio.dk/lectio/opgaver', 'Opgaver – Lectio', 1], ['www.dr.dk/nyheder', 'DR Nyheder']], apps: ['Microsoft Edge', 'Microsoft Word'], screen: 'web' },
    'Clara Holm': { browser: 'Chrome', tabs: [['chatgpt.com/c/68a1', 'ChatGPT', 1], ['docs.google.com/document/d/9k', 'Novelleanalyse – Google Docs']], apps: ['Google Chrome'], screen: 'chat', hist: [['https://chatgpt.com/c/68a1', 'ChatGPT'], ['https://docs.google.com/document/d/9k', 'Novelleanalyse – Google Docs']] },
    'David Ali': { browser: null, tabs: [['www.lectio.dk/lectio/opgaver', 'Opgaver – Lectio']], apps: ['Microsoft Word', 'python', 'Google Chrome'], blockedApps: { python: 'AI' }, screen: 'word' },
    'Emma Sørensen': { browser: 'Chrome', tabs: [['docs.google.com/document/d/3n', 'Noter – Google Docs', 1]], apps: ['Google Chrome', 'holymoly-grøn.exe'], blockedApps: { 'holymoly-grøn.exe': 'Falsk klient' }, screen: 'doc' },
    'Frederik Lund': { browser: null, tabs: [], apps: ['Microsoft Word', 'Microsoft Excel'], screen: 'word' },
    'Gustav Berg': { browser: 'Safari', tabs: [['www.lectio.dk/lectio/skema', 'Skema – Lectio']], apps: ['Pages', 'Safari'], screen: 'word' },
    'Hannah Krogh': { browser: 'Chrome', tabs: [['ordnet.dk/ddo', 'Den Danske Ordbog', 1]], apps: ['Google Chrome'], screen: 'web' },
    'Ida Mølgaard': { browser: null, tabs: [], apps: ['GeoGebra Classic 6', 'RobloxPlayerBeta'], blockedApps: { RobloxPlayerBeta: 'Spil' }, screen: 'geo' },
    'Jonas Friis': { browser: 'Firefox', tabs: [['lex.dk/romantikken', 'Romantikken – lex.dk', 1], ['www.lectio.dk/lectio/opgaver', 'Opgaver – Lectio']], apps: ['Firefox'], screen: 'web', cycle: [['lex.dk – Romantikken', 'https://lex.dk/romantikken'], ['lex.dk – Adam Oehlenschläger', 'https://lex.dk/Adam_Oehlenschläger'], ['lex.dk – Romantikken', 'https://lex.dk/romantikken']] },
    'Karla Dam': { browser: 'Chrome', tabs: [['docs.google.com/document/d/5t', 'Dansk opgave – Google Docs', 1]], apps: ['Google Chrome'], screen: 'doc' },
    'Lucas Bech': { browser: 'Chrome', tabs: [['docs.google.com/document/d/7q', 'Dansk – Google Docs', 1]], apps: ['Google Chrome'], screen: 'doc' },
  };
  const W = {};
  for (const s of cls.students) W[s.id] = WN[s.name] || { tabs: [], apps: [], screen: 'web' };
  function detailOf(id) {
    const w = W[id] || { tabs: [], apps: [] };
    return {
      tabs: w.tabs.map(([u, t, a]) => ({ url: 'https://' + u, title: t, active: !!a, browser: w.browser, blocked: /chatgpt/.test(u) })),
      apps: w.apps.map(n => ({ name: n, category: (w.blockedApps || {})[n] || '', blocked: !!(w.blockedApps || {})[n] })),
    };
  }

  // Hændelser: optaget fra serveren + en realistisk web- og programlog for lektionen
  const events = new Map();
  const ev = (sid, e) => { const list = events.get(sid) || []; const x = Object.assign({ id: nextEventId++, lessonId: 1, url: null, title: null, app: null, category: null, blocked: false, evidenceId: null, detail: null }, e); list.push(x); events.set(sid, list); return x; };
  for (const [key, r] of Object.entries(D.events)) {
    const sid = Number(key.split(':')[0]);
    if (sid === late.id) continue; // Karlas hændelser kommer, når hun tilmelder sig
    for (const e of r.events) if (!(events.get(sid) || []).some(x => x.id === e.id)) { const list = events.get(sid) || []; list.push(Object.assign({}, e, { ts: T(e.ts) })); events.set(sid, list); }
  }
  for (const s of cls.students) {
    if (s.id === late.id) continue;
    const w = W[s.id];
    let t = NOW0 - 13 * 60_000;
    for (const [u, title] of (w.hist || w.tabs.map(x => ['https://' + x[0], x[1]]))) { ev(s.id, { ts: t, kind: 'nav', url: u, title }); t += 3 * 60_000 + (s.id * 7919) % 90_000; }
    let ta = NOW0 - 14 * 60_000;
    for (const a of w.apps) { ev(s.id, { ts: ta, kind: 'app', app: a, title: a }); ta += 4 * 60_000; }
  }
  ev(byName('Clara Holm').id, { ts: NOW0 - 6 * 60_000, kind: 'blocked', url: 'https://claude.ai/new', title: 'claude.ai', category: 'ai', blocked: true });
  ev(byName('Ida Mølgaard').id, { ts: NOW0 - 2 * 60_000, kind: 'killed', app: 'RobloxPlayerBeta', title: 'Lukket af HolyMoly: Spil' });

  /* ---------- dokumenter skrevet i HolyMoly (eksempler) ---------- */
  const P = (x, f) => Object.assign({ x }, f || {});
  const DOCS = {
    'Anna Jensen': { id: 'demo-doc-anna-0001', title: 'Romantikken – dansk stil', certId: 'Rk7Qm2Xp9LwT4hZs', reasons: [], notes: ['1 forsøg på at indsætte tekst blev blokeret'],
      facts: { words: 146, writingMinutes: 38, typed: 1093, deleted: 214, monitoredShare: 100 },
      blocks: [{ t: 'h1', r: [P('Romantikken')] }, { t: 'p', r: [P('Romantikken var en periode i kunsten omkring år 1800, hvor '), P('følelser', { b: 1 }), P(', naturen og det guddommelige fik en stor plads. Digterne vendte sig mod oplysningstidens fornuft og søgte i stedet det hele og det uendelige.')] },
        { t: 'h2', r: [P('Kendetegn')] }, { t: 'ul', r: [P('Naturen som noget levende og helligt')] }, { t: 'ul', r: [P('Geniet: kunstneren som et særligt menneske')] }, { t: 'ul', r: [P('Længsel efter fortiden og det nationale')] },
        { t: 'p', r: [P('I Danmark er Adam Oehlenschlägers digt '), P('Guldhornene', { i: 1 }), P(' et af de første romantiske værker. Det handler om at nutiden ikke forstår fortidens skatte.')] }] },
    'Clara Holm': { id: 'demo-doc-clara-0001', title: 'Novelleanalyse', certId: null, submitted: true, reasons: ['Rød lampe mens teksten blev skrevet: AI / chatbots: chatgpt.com'], notes: [],
      facts: { words: 88, writingMinutes: 21, typed: 640, deleted: 61, monitoredShare: 71 },
      blocks: [{ t: 'h1', r: [P('Analyse af "Hvide sko"')] }, { t: 'p', r: [P('Novellen handler om en pige der skammer sig over sine sko. Fortælleren er en tredjepersonsfortæller som følger pigen tæt.')] }] },
    'Jonas Friis': { id: 'demo-doc-jonas-0001', title: 'Guldalderen', certId: null, reasons: [], notes: [],
      facts: { words: 34, writingMinutes: 9, typed: 251, deleted: 40, monitoredShare: 100 },
      blocks: [{ t: 'h1', r: [P('Guldalderen')] }, { t: 'p', r: [P('Guldalderen er perioden i dansk kunst fra ca. 1800 til 1850. Malerne malede ofte det danske landskab og hverdagen …')] }] },
  };
  const docOf = (sid) => { const s = cls.students.find(x => x.id === sid); return s && DOCS[s.name]; };

  /* ---------- konto, skole og licens (demo) ---------- */
  const orders = [];
  const LIC = () => ({ state: 'trial', until: NOW0 + 23 * 86400_000, daysLeft: 23, trialEnds: NOW0 + 23 * 86400_000, licenseUntil: null, seats: 0, used: cls.students.filter(s => s.joined).length, overSeats: false });
  const ME = () => Object.assign({}, D.me, { uniLinked: false, uniOnly: false, verified: true, totp: true, require2fa: true, needs: null,
    school: { id: 1, name: 'Demo Gymnasium', role: 'admin' }, license: LIC(), licensing: true, platformAdmin: false });
  const SCHOOL = () => ({ id: 1, name: 'Demo Gymnasium', created: NOW0 - 7 * 86400_000, role: 'admin', license: LIC(), licensing: true, pricing: { perStudent: 129, minimum: 2500, currency: 'DKK' },
    teachers: [
      { id: 1, name: D.me.name, email: D.me.email, role: 'admin', verified: true, totp: true, uni: false, classes: 1, students: cls.students.filter(s => s.joined).length, me: true },
      { id: 2, name: 'Jonas Kristensen', email: 'jonas@demo-gymnasium.dk', role: 'teacher', verified: true, totp: true, uni: true, classes: 3, students: 71, me: false },
      { id: 3, name: 'Sara Holm', email: 'sara@demo-gymnasium.dk', role: 'teacher', verified: true, totp: false, uni: true, classes: 2, students: 48, me: false },
    ],
    invites: [{ id: 'a1b2c3d4e5f60718', email: 'peter@demo-gymnasium.dk', role: 'teacher', created: NOW0 - 86400_000, expires: NOW0 + 13 * 86400_000 }],
    orders: orders.slice() });

  /* ---------- afleveringer (demo) ---------- */
  const ASG = [{ id: 1, home: true, title: 'Romantikken – dansk stil', description: 'Skriv en stil om romantikken i dansk litteratur.\nBrug mindst to tekster fra forløbet. Højst 3 sider.', due: NOW0 + 2 * 86400_000, created: NOW0 - 3 * 86400_000 }];
  function asgStudents(a) {
    return cls.students.filter(s => s.joined).map((s) => {
      const d = DOCS[s.name];
      const sub = d && (d.certId || d.submitted) ? { docId: d.id, title: d.title, submitted: NOW0 - 30 * 60_000, certId: d.certId || null, late: false, reasons: d.reasons || [] } : null;
      return { id: s.id, name: s.name, submission: a.id === 1 ? sub : null };
    });
  }

  /* ---------- fetch ---------- */
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  const newCode = () => { const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; let c = ''; for (let i = 0; i < 8; i++) c += A[Math.floor(Math.random() * A.length)]; return c.slice(0, 4) + '-' + c.slice(4); };
  window.fetch = async function (input, opts = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://demo.holymoly.local');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const p = url.pathname, m = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    await new Promise(r => setTimeout(r, 60));
    if (p === '/api/info') return json(200, Object.assign({}, D.info, { uniLogin: false }));
    if (p === '/api/login' && m === 'POST') {
      if (String(body.email || '').trim().toLowerCase() === EMAIL && body.password === PASSWORD) { loggedIn = true; return json(200, { ok: true }); }
      return json(401, { error: 'Forkert e-mail eller adgangskode' });
    }
    if (p === '/api/register') return json(400, { error: 'I demoen kan der ikke oprettes lærere. Log ind med demo@holymoly.dk / demo-kodeord' });
    if (p === '/api/password/forgot') return json(200, { ok: true });
    if (p === '/api/pricing') return json(200, { perStudent: 129, minimum: 2500, currency: 'DKK', trialDays: 30, licensing: true, signup: true });
    if (p.startsWith('/api/invite/')) return json(404, { error: 'Invitationer virker i den rigtige HolyMoly' });
    if (p.startsWith('/api/student/')) return json(401, { error: 'Ikke logget ind' });
    if (!loggedIn) return json(401, { error: 'Ikke logget ind' });
    if (p === '/api/me') return json(200, ME());
    if (p === '/api/school' && m === 'GET') return json(200, SCHOOL());
    if (p === '/api/school/order' && m === 'POST') {
      const n = Math.max(1, Number(body.students) || 0), y = Number(body.years) || 1;
      orders.unshift({ id: orders.length + 1, created: Date.now(), students: n, years: y, amount: Math.max(2500, n * 129) * y, status: 'ny', ean: String(body.ean || ''), invoiceEmail: String(body.invoiceEmail || '') });
      return json(200, { ok: true, id: orders.length, amount: orders[0].amount });
    }
    if (p.startsWith('/api/school') || p.startsWith('/api/account')) return json(400, { error: 'Det virker i den rigtige HolyMoly – demoen gemmer ikke ændringer' });
    if (p.startsWith('/api/admin')) return json(403, { error: 'Kun for HolyMoly-administratorer' });
    if (p === '/api/logout') { loggedIn = false; return json(200, { ok: true }); }
    if (p === '/api/classes' && m === 'GET') {
      const a = ASG[0];
      const handed = a ? asgStudents(a).filter(x => x.submission).length : 0;
      return json(200, [{ id: CLASS_ID, name: cls.name, count: cls.students.filter(s => s.joined).length, lesson, openAssignments: ASG.length,
        nextAssignment: a ? { id: a.id, title: a.title, due: a.due, home: true, handed } : null }]);
    }
    if (p === '/api/classes' && m === 'POST') return json(400, { error: 'I demoen er der kun klassen "2.g Dansk"' });
    const cm = p.match(/^\/api\/classes\/(\d+)(\/.*)?$/);
    if (cm) {
      if (Number(cm[1]) !== CLASS_ID) return json(404, { error: 'Klassen findes ikke' });
      const sub = cm[2] || '';
      if (!sub && m === 'GET') return json(200, JSON.parse(JSON.stringify(Object.assign({}, cls, { lesson }))));
      if (!sub && m === 'PATCH') {
        if (body.name) cls.name = String(body.name).slice(0, 80);
        if (body.config) Object.assign(cls.config, body.config);
        const blockedLinks = (cls.config.links || []).filter(l => /chatgpt|openai|tiktok|instagram|snapchat/.test(l.url) && !(cls.config.allowed || []).some(a => l.url.includes(a)))
          .map(l => ({ url: l.url, host: new URL(l.url).hostname.replace(/^www\./, ''), label: 'Blokeret kategori' }));
        return json(200, { ok: true, config: cls.config, blockedLinks });
      }
      if (!sub && m === 'DELETE') return json(400, { error: 'Demo-klassen kan ikke slettes' });
      if (sub === '/assignments' && m === 'GET') {
        return json(200, { students: cls.students.filter(s => s.joined).length, assignments: ASG.map(a => { const st = asgStudents(a); return Object.assign({}, a, { handed: st.filter(x => x.submission).length, certified: st.filter(x => x.submission && x.submission.certId).length }); }) });
      }
      if (sub === '/assignments' && m === 'POST') {
        if (!String(body.title || '').trim()) return json(400, { error: 'Skriv en titel' });
        const a = { id: ASG.length + 1, title: String(body.title).slice(0, 120), description: String(body.description || ''), due: body.due || null, created: Date.now() };
        ASG.push(a);
        return json(200, { id: a.id });
      }
      if (sub === '/lessons') return json(200, { lessons: [{ id: lesson.id || 1, started: lesson.started || NOW0 - 14 * 60_000, ended: Date.now(), live: !!lesson.live }] });
      if (/^\/lessons\/\d+$/.test(sub)) {
        const start = lesson.started || NOW0 - 14 * 60_000, now = Date.now(), all = now - start;
        const students = cls.students.filter(s => s.joined).map((s) => {
          const v = liveViews.get(s.id) || {};
          const c = v.online ? v.color : 'grey';
          const part = { green: 0, red: 0, grey: 0 };
          if (c === 'red') { part.green = all * 0.55; part.red = all * 0.45; } else if (c === 'green') { part.green = all * 0.97; part.grey = all * 0.03; } else part.grey = all;
          const d = DOCS[s.name];
          return Object.assign(part, { id: s.id, name: s.name, redReasons: c === 'red' ? (v.violations || []).map(x => x.text) : [], violations: c === 'red' ? 1 : 0, attempts: s.name === 'Clara Holm' ? 1 : 0, killed: 0, hands: s.name === 'Jonas Friis' ? 1 : 0, submitted: d && (d.certId || d.submitted) ? 1 : 0, certified: d && d.certId ? 1 : 0 });
        });
        return json(200, { lesson: { id: 1, started: start, ended: now, minutes: Math.round(all / 60000) }, students });
      }
      if (sub === '/joincode') {
        if (body.action === 'new') cls.joinCode = newCode();
        else if (body.action === 'open' || body.action === 'close') cls.joinOpen = body.action === 'open';
        return json(200, { joinCode: cls.joinCode, joinOpen: cls.joinOpen });
      }
      if (sub === '/lesson') {
        if (body.action === 'start') lesson = { live: true, id: lesson.id + 1, started: Date.now(), endsAt: Date.now() + (Number(body.minutes) || 90) * 60_000 };
        else if (body.action === 'extend') {
          // Ekstra tid: kun læreren ser den (simuleret – eleverne skriver ikke videre i demoen)
          const extra = (lesson.extra || []).filter(e => !(body.studentIds || []).includes(e.studentId));
          for (const id of body.studentIds || []) extra.push({ studentId: id, until: (lesson.endsAt || Date.now()) + (Number(body.minutes) || 15) * 60_000 });
          lesson = Object.assign({}, lesson, { extra });
        } else { lesson = { live: false }; frozen.clear(); hands.clear(); }
        setTimeout(() => { broadcast({ type: 'lesson', lesson }); for (const s of cls.students) pushStudent(s.id); }, 30);
        return json(200, { lesson });
      }
      if (sub === '/layout' && m === 'PUT') {
        for (const it of body.positions || []) { const s = cls.students.find(x => x.id === Number(it.id)); if (s) { s.x = it.x; s.y = it.y; } }
        return json(200, { ok: true });
      }
      if (sub === '/layout/auto') {
        const list = cls.students.filter(s => s.joined).sort((a, b) => a.name.localeCompare(b.name, 'da'));
        const n = list.length, cols = Math.min(8, Math.max(Math.min(n, 4), Math.ceil(Math.sqrt(n * 1.8)))), rows = Math.ceil(n / cols);
        list.forEach((s, i) => { s.x = 0.06 + (i % cols + 0.5) * (0.88 / cols); s.y = 0.2 + (Math.floor(i / cols) + 0.5) * (0.78 / rows); });
        return json(200, { ok: true });
      }
      if (sub === '/students') return json(400, { error: 'Eleverne tilmelder sig selv med klassekoden' });
    }
    if (p === '/api/assignments' && m === 'GET') {
      const n = cls.students.filter(s => s.joined).length;
      return json(200, { assignments: ASG.map((a) => { const st = asgStudents(a); return { id: a.id, title: a.title, due: a.due, home: !!a.home, created: a.created, classId: CLASS_ID, className: cls.name, students: n, handed: st.filter(x => x.submission).length, certified: st.filter(x => x.submission && x.submission.certId).length, late: 0 }; }) });
    }
    const am = p.match(/^\/api\/assignments\/(\d+)$/);
    if (am) {
      const a = ASG.find(x => x.id === Number(am[1]));
      if (!a) return json(404, { error: 'Afleveringen findes ikke' });
      if (m === 'GET') return json(200, Object.assign({ classId: CLASS_ID, students: asgStudents(a) }, a));
      if (m === 'PATCH') { Object.assign(a, { title: String(body.title || a.title), description: String(body.description ?? a.description), due: body.due ?? a.due }); return json(200, { ok: true }); }
      if (m === 'DELETE') { ASG.splice(ASG.indexOf(a), 1); return json(200, { ok: true }); }
    }
    const dv = p.match(/^\/api\/docs\/([\w-]+)\/(versions|similar|log)$/);
    if (dv) {
      const s = cls.students.find(x => DOCS[x.name] && DOCS[x.name].id === dv[1]);
      if (!s) return json(404, { error: 'Dokumentet findes ikke' });
      const d = DOCS[s.name];
      const full = d.blocks.map(b => b.r.map(r => r.x).join('')).join('\n');
      if (dv[2] === 'similar') return json(200, { similar: [] });
      if (dv[2] === 'log') {
        // Skrivelogen i demoen: én skriveøkt med jævn skrivning (ingen indsatte udsnit)
        const start = NOW0 - 30 * 60_000, events = [{ ts: start, kind: 'start', chars: 0, detail: { place: 'lektion' } }];
        for (let i = 0; i < 28; i++) { const added = Math.round(full.length / 28); events.push({ ts: start + i * 60_000, kind: 'skrivning', chars: added, detail: { added, removed: Math.round(added / 8) } }); }
        events.push({ ts: start + 27 * 60_000, kind: 'slut', chars: 0 }, { ts: NOW0 - 2 * 60_000, kind: 'afleveret', chars: 0 });
        return json(200, { summary: { started: start, submitted: NOW0 - 2 * 60_000, minutesWriting: 28, sessions: 1, words: d.facts.words, typed: d.facts.typed, deleted: d.facts.deleted, pastes: 0, pastedChars: 0, corrections: 0, moves: 0, source: 'holymoly' }, events, pastes: [] });
      }
      const steps = 8, out = [];
      for (let i = 1; i <= steps; i++) out.push({ ts: NOW0 - (steps - i) * 4 * 60_000, text: full.slice(0, Math.round(full.length * i / steps)) });
      return json(200, { versions: out });
    }
    const dm = p.match(/^\/api\/docs\/([\w-]+)$/);
    if (dm) {
      const s = cls.students.find(x => DOCS[x.name] && DOCS[x.name].id === dm[1]);
      if (!s) return json(404, { error: 'Dokumentet findes ikke' });
      const d = DOCS[s.name];
      return json(200, Object.assign({ studentId: s.id, words: d.facts.words, created: NOW0 - 40 * 60_000, updated: NOW0 - 2 * 60_000, submitted: d.certId || d.submitted ? NOW0 - 2 * 60_000 : null }, d));
    }
    const sm = p.match(/^\/api\/students\/(\d+)(\/.*)?$/);
    if (sm) {
      const sid = Number(sm[1]), sub = sm[2] || '';
      const s = cls.students.find(x => x.id === sid);
      if (!s) return json(404, { error: 'Eleven findes ikke' });
      if (sub === '/docs') {
        const d = docOf(sid);
        return json(200, { docs: d ? [{ id: d.id, title: d.title, words: d.facts.words, created: NOW0 - 40 * 60_000, updated: NOW0 - 2 * 60_000, submitted: d.certId || d.submitted ? NOW0 - 2 * 60_000 : null, certId: d.certId, reasons: d.reasons, notes: d.notes }] : [] });
      }
      if (sub === '/events') {
        const kind = url.searchParams.get('kind'), before = Number(url.searchParams.get('before')) || Infinity;
        const match = { web: ['nav', 'blocked'], apps: ['app', 'killed'], alerts: ['violation', 'tamper', 'evidence', 'killed', 'blocked', 'teacher', 'system', 'info', 'hand'] }[kind] || [];
        const list = (events.get(sid) || []).filter(e => match.includes(e.kind) && e.ts < before).sort((a, b) => b.ts - a.ts).slice(0, 150);
        return json(200, { events: list });
      }
      if (!sub && m === 'PATCH') { if (body.name) s.name = String(body.name).slice(0, 80); return json(200, s); }
      if (sub === '/invite') { s.enrolled = false; s.inviteCode = newCode(); s.device = null; const v = liveViews.get(sid); if (v) v.online = false; setTimeout(() => pushStudent(sid), 30); return json(200, Object.assign({}, s)); }
      if (!sub && m === 'DELETE') return json(400, { error: 'I demoen kan elever ikke slettes' });
    }
    return json(400, { error: 'Ikke muligt i demoen' });
  };

  /* ---------- lærerens WebSocket ---------- */
  const sockets = new Set();
  function broadcast(msg) { for (const s of sockets) s._recv(JSON.stringify(msg)); }
  function viewOf(sid) {
    const base = liveViews.get(sid);
    if (!base || !base.online) return Object.assign({ studentId: sid, color: 'grey', violations: [], degraded: [] }, base || {}, { online: false, color: 'grey' });
    if (!lesson.live) return Object.assign({}, base, { color: 'idle', activity: 'Forbundet – venter på lektion', url: '', app: '', violations: [], degraded: [], greyReason: '', frozen: false, review: false });
    return Object.assign({}, base, { frozen: frozen.has(sid), review: frozen.get(sid) === 'review', hand: hands.get(sid) || null });
  }
  function pushStudent(sid) { broadcast({ type: 'student', student: viewOf(sid) }); }
  const snapshot = () => ({ type: 'snapshot', lesson, students: cls.students.map(s => viewOf(s.id)) });

  class FakeSocket {
    constructor() {
      this.readyState = 0; this.binaryType = 'arraybuffer'; this.watch = null; this.waitAck = false;
      sockets.add(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); this._recv(JSON.stringify(snapshot())); }, 80);
    }
    _recv(data) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'watch') {
        this.watch = m.studentId; this.waitAck = false;
        setTimeout(() => this._recv(JSON.stringify({ type: 'detail', studentId: m.studentId, detail: detailOf(m.studentId) })), 120);
        this._frame();
      } else if (m.type === 'unwatch') this.watch = null;
      else if (m.type === 'frameAck') { this.waitAck = false; setTimeout(() => this._frame(), 900); }
      else if (m.type === 'freeze') {
        if (!lesson.live) return this._recv(JSON.stringify({ type: 'error', message: 'Start en lektion først' }));
        const ids = m.all ? cls.students.map(s => s.id) : (m.studentIds || []);
        for (const id of ids) {
          const v = liveViews.get(id); if (!v || !v.online) continue;
          if (m.on) frozen.set(id, m.mode === 'review' ? 'review' : 'freeze'); else frozen.delete(id);
          pushStudent(id);
        }
      } else if (m.type === 'hand') {
        hands.delete(m.studentId);
        pushStudent(m.studentId);
      } else if (m.type === 'screenshot') {
        const sid = m.studentId;
        const canvas = drawScreen(sid);
        const eid = nextEventId++;
        evidence.set(eid, canvas.toDataURL('image/jpeg', 0.85));
        const e = ev(sid, { ts: Date.now(), kind: 'evidence', title: 'Skærmbillede taget af læreren', evidenceId: eid });
        broadcast({ type: 'event', studentId: sid, event: e });
      }
    }
    async _frame() {
      const sid = this.watch;
      if (sid == null || this.waitAck || this.readyState !== 1) return;
      if (!viewOf(sid).online) return;
      this.waitAck = true;
      const jpeg = await new Promise(r => drawScreen(sid).toBlob(r, 'image/jpeg', 0.8));
      const img = new Uint8Array(await jpeg.arrayBuffer());
      const header = new TextEncoder().encode(JSON.stringify({ kind: 'live', studentId: sid, screens: 1, screen: 0 }));
      const buf = new Uint8Array(5 + header.length + img.length);
      buf[0] = 1; new DataView(buf.buffer).setUint32(1, header.length); buf.set(header, 5); buf.set(img, 5 + header.length);
      if (this.watch === sid && this.onmessage) this.onmessage({ data: buf.buffer });
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose && this.onclose(); }
  }
  window.WebSocket = FakeSocket;

  // Karla tilmelder sig selv med klassekoden 20 sek. efter login – og dukker op i klasseværelset
  let lateTimer = null;
  const origLoginCheck = setInterval(() => {
    if (!loggedIn || lateTimer || !late.id) return;
    clearInterval(origLoginCheck);
    lateTimer = setTimeout(() => {
      if (!cls.joinOpen) return;
      late.joined = true;
      const e = ev(late.id, { ts: Date.now(), kind: 'system', title: LATE + ' tilmeldte sig med klassekoden' });
      ev(late.id, { ts: Date.now(), kind: 'nav', url: 'https://docs.google.com/document/d/5t', title: 'Dansk opgave – Google Docs' });
      broadcast(snapshot());
      broadcast({ type: 'event', studentId: late.id, event: e });
    }, 20_000);
  }, 500);

  // Jonas rækker hånden op 30 sek. efter login
  const handCheck = setInterval(() => {
    if (!loggedIn) return;
    clearInterval(handCheck);
    setTimeout(() => {
      const j = byName('Jonas Friis');
      if (!j.id || !lesson.live) return;
      hands.set(j.id, Date.now());
      const e = ev(j.id, { ts: Date.now(), kind: 'hand', title: 'Rakte hånden op' });
      pushStudent(j.id);
      broadcast({ type: 'event', studentId: j.id, event: e });
    }, 30_000);
  }, 500);

  // Lidt liv i klassen: nogle elever skifter side, og weblogen vokser
  const step = new Map();
  setInterval(() => {
    if (!lesson.live) return;
    for (const s of cls.students) {
      const w = W[s.id];
      if (!w.cycle || frozen.has(s.id)) continue;
      const i = ((step.get(s.id) || 0) + 1) % w.cycle.length;
      step.set(s.id, i);
      const v = liveViews.get(s.id);
      const [activity, url] = w.cycle[i];
      if (!v || v.activity === activity) continue;
      v.activity = activity;
      const e = ev(s.id, { ts: Date.now(), kind: 'nav', url, title: activity.split(' – ')[1] || activity });
      pushStudent(s.id);
      broadcast({ type: 'event', studentId: s.id, event: e });
    }
  }, 9000);

  /* ---------- elevens skærm (tegnet) ---------- */
  function drawScreen(sid) {
    const v = viewOf(sid), w = W[sid] || {};
    const c = document.createElement('canvas'); c.width = 1280; c.height = 800;
    const g = c.getContext('2d');
    const font = (px, wgt = 400) => `${wgt} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const center = (text, y) => { g.fillText(text, (1280 - g.measureText(text).width) / 2, y); };
    // Gennemgang: standby med ur, dato og tid tilbage (samme som elevens skærm)
    if (frozen.get(sid) === 'review') {
      g.fillStyle = '#101317'; g.fillRect(0, 0, 1280, 800);
      const now = new Date();
      g.fillStyle = '#8b93a3'; g.font = font(18); center('GENNEMGANG – KIG OP', 230);
      g.fillStyle = '#eceef2'; g.font = font(190, 200); center(now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }), 420);
      const d = now.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      g.fillStyle = '#c9ced8'; g.font = font(30); center(d.charAt(0).toUpperCase() + d.slice(1), 490);
      if (lesson.live) {
        const left = lesson.endsAt - Date.now(), total = lesson.endsAt - lesson.started;
        g.fillStyle = '#262b35'; g.beginPath(); g.roundRect(360, 540, 560, 10, 5); g.fill();
        g.fillStyle = '#6d8dff'; g.beginPath(); g.roundRect(360, 540, Math.max(10, 560 * Math.max(0, left) / total), 10, 5); g.fill();
        const min = Math.max(0, Math.ceil(left / 60000));
        g.fillStyle = '#eceef2'; g.font = font(26); center(min + (min === 1 ? ' minut' : ' minutter') + ' tilbage af lektionen', 595);
      }
      return c;
    }
    const kind = w.screen || 'web';
    g.fillStyle = '#1f2937'; g.fillRect(0, 0, 1280, 800);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 760);
    g.fillStyle = '#e5e7eb'; g.fillRect(0, 0, 1280, 76);
    const [site, title] = String(v.activity || '').split(' – ');
    if (['doc', 'web', 'chat'].includes(kind)) {
      g.fillStyle = '#fff'; g.beginPath(); g.roundRect(16, 8, 300, 30, [8, 8, 0, 0]); g.fill();
      g.fillStyle = '#111'; g.font = font(14); g.fillText((title || site || '').slice(0, 34), 30, 28);
      g.fillStyle = '#fff'; g.beginPath(); g.roundRect(90, 42, 1100, 28, 14); g.fill();
      g.fillStyle = '#374151'; g.font = font(15); g.fillText(v.url || ('https://' + (site || '')), 110, 61);
    } else {
      g.fillStyle = '#111'; g.font = font(15, 600); g.fillText(String(v.activity || ''), 24, 46);
    }
    const lines = (x, y, n, wmax, color = '#d1d5db', gap = 30) => { g.fillStyle = color; for (let i = 0; i < n; i++) { const ww = wmax * (0.55 + ((i * 37 + sid * 11) % 45) / 100); g.fillRect(x, y + i * gap, ww, 12); } };
    if (kind === 'chat') {
      g.fillStyle = '#f9fafb'; g.fillRect(0, 76, 240, 684);
      g.fillStyle = '#111'; g.font = font(30, 600); g.fillText('Hvad kan jeg hjælpe med?', 420, 200);
      g.fillStyle = '#f3f4f6'; g.beginPath(); g.roundRect(700, 260, 480, 70, 18); g.fill();
      g.fillStyle = '#111'; g.font = font(17); g.fillText('Skriv en analyse af novellen "Hvide sko"', 724, 302);
      lines(300, 380, 8, 700, '#9ca3af', 34);
      g.fillStyle = '#f3f4f6'; g.beginPath(); g.roundRect(320, 680, 760, 56, 28); g.fill();
    } else if (kind === 'word' || kind === 'doc') {
      g.fillStyle = kind === 'word' ? '#2b579a' : '#f1f3f4'; g.fillRect(0, 76, 1280, 44);
      g.fillStyle = '#eef0f3'; g.fillRect(0, 120, 1280, 640);
      g.fillStyle = '#fff'; g.fillRect(330, 140, 620, 620);
      g.fillStyle = '#111'; g.font = font(22, 700); g.fillText(title || 'Dokument', 380, 200);
      lines(380, 240, 14, 520);
    } else if (kind === 'geo') {
      g.strokeStyle = '#e5e7eb'; for (let x = 0; x < 1280; x += 40) { g.beginPath(); g.moveTo(x, 76); g.lineTo(x, 760); g.stroke(); } for (let y = 76; y < 760; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(1280, y); g.stroke(); }
      g.strokeStyle = '#2563eb'; g.lineWidth = 3; g.beginPath(); for (let x = 0; x <= 1280; x += 8) { const y = 420 - 140 * Math.sin((x - 640) / 120); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.lineWidth = 1;
    } else {
      g.fillStyle = '#111'; g.font = font(26, 700); g.fillText(title || site || '', 120, 150);
      lines(120, 190, 15, 900);
    }
    g.fillStyle = '#111827'; g.fillRect(0, 760, 1280, 40);
    g.fillStyle = '#9ca3af'; g.font = font(13); g.fillText(new Date().toLocaleTimeString('da-DK'), 1190, 785);
    if (frozen.get(sid) === 'freeze') { g.fillStyle = 'rgba(17,24,39,.82)'; g.fillRect(0, 0, 1280, 800); g.fillStyle = '#fff'; g.font = font(34, 700); center('Skærmen er låst af læreren', 400); }
    return c;
  }
})();
