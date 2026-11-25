/* HolyMoly – konto, skole, licens og administration (lærer-dashboardet).
 * Bruger hjælperne fra app.js (window.HM). Al data indsættes som tekst, aldrig som HTML. */
(function () {
  'use strict';
  const HM = window.HM;
  const { $, h, api, toast, dialog, route } = HM;
  const app = HM.app;

  const kr = (n) => Number(n || 0).toLocaleString('da-DK') + ' kr.';
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
  const isoDate = (ts) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const qs = (k) => new URLSearchParams(location.search).get(k);
  let infoCache = null;
  const info = () => (infoCache = infoCache || api('/api/info', { noRedirect: true }).catch(() => ({})));

  // Interne links (data-nav) skifter side uden at genindlæse
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-nav]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    route(a.getAttribute('href'));
  });
  // Menuer lukker, når man klikker et andet sted
  document.addEventListener('click', () => { for (const m of document.querySelectorAll('.acct-menu')) { m.hidden = true; } });

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {}, noRedirect: true }); } catch (e) { /* */ }
    route('/login');
  }

  /* ---------------- fælles topbar ---------------- */
  function topbar(me, active) {
    const link = (href, label, key) => h('a', { href, 'data-nav': '', class: 'nav-link' + (active === key ? ' on' : ''), 'aria-current': active === key ? 'page' : null, text: label });
    const menu = h('div', { class: 'menu acct-menu', hidden: true, role: 'menu' },
      h('div', { class: 'menu-head' }, h('b', { text: me.name }), h('div', { class: 'muted small', text: me.email || 'Logget ind med Unilogin' })),
      h('button', { role: 'menuitem', text: 'Konto og sikkerhed', onclick: () => route('/konto') }),
      me.school ? h('button', { role: 'menuitem', text: me.school.role === 'admin' ? 'Skole og licens' : 'Skole', onclick: () => route('/skole') }) : null,
      h('button', { role: 'menuitem', text: 'Udseende', onclick: HM.showPrefs }),
      h('button', { role: 'menuitem', text: 'Hjælp', onclick: () => { location.href = '/hjaelp.html'; } }),
      h('button', { role: 'menuitem', class: 'danger', text: 'Log ud', onclick: logout }));
    const btn = h('button', { class: 'btn ghost acct-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'Din konto' },
      h('span', { class: 'avatar', text: initials(me.name) }), h('span', { class: 'acct-name', text: me.name }));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      for (const m of document.querySelectorAll('.acct-menu')) m.hidden = true;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    return h('header', { class: 'topbar app-bar' },
      h('a', { class: 'brand small', href: '/', 'data-nav': '' }, h('img', { src: '/icon.svg', alt: '', width: 26, height: 26 }), h('span', { text: 'HolyMoly' })),
      h('nav', { class: 'nav', 'aria-label': 'Hovedmenu' },
        link('/', 'Klasser', 'klasser'),
        link('/afleveringer', 'Afleveringer', 'afleveringer'),
        me.school ? link('/skole', 'Skole', 'skole') : null,
        me.platformAdmin ? link('/admin', 'Administration', 'admin') : null),
      h('div', { class: 'spacer' }),
      h('div', { class: 'info-wrap' },
        h('button', { class: 'btn info-btn', id: 'info-btn', 'aria-expanded': 'false', 'aria-controls': 'info-pop', title: 'Sådan virker HolyMoly', text: 'i' }),
        h('div', { class: 'info-pop', id: 'info-pop', role: 'dialog', 'aria-label': 'Sådan virker HolyMoly', hidden: true })),
      h('div', { class: 'menu-wrap' }, btn, menu));
  }

  function licenseBanner(me) {
    if (!me.licensing || !me.license || !me.school) return null;
    const L = me.license, admin = me.school.role === 'admin';
    let kind, text;
    if (L.state === 'trial') { kind = L.daysLeft <= 7 ? 'warn' : 'info'; text = `Prøveperiode: ${plural(L.daysLeft, 'dag', 'dage')} tilbage. Alt virker – også Unilogin, skrive-bevis og lektionsrapporter.`; }
    else if (L.state === 'expired') { kind = 'bad'; text = 'Prøveperioden eller licensen er udløbet. I kan se og eksportere alt, men ikke starte nye lektioner.'; }
    else if (L.overSeats) { kind = 'warn'; text = `I bruger ${L.used} af ${L.seats} elevpladser i licensen.`; }
    else if (L.daysLeft <= 30) { kind = 'warn'; text = `Licensen udløber om ${plural(L.daysLeft, 'dag', 'dage')}.`; }
    else return null;
    const act = admin
      ? h('a', { class: 'btn small ' + (kind === 'info' ? '' : 'primary'), href: '/skole#licens', 'data-nav': '', text: L.state === 'active' ? 'Udvid eller forny' : 'Bestil licens' })
      : h('span', { class: 'small muted', text: 'Kontakt skolens administrator.' });
    return h('div', { class: 'banner ' + kind, role: kind === 'bad' ? 'alert' : 'status' }, h('span', { text }), act);
  }

  /** Enkel tilstand: "Ny lærer venter: Mette Hansen (oprettet 25.11 kl. 10.14) – Godkend / Afvis". Fyldes, når listen er hentet. */
  function pendingTeachersBanner(me) {
    if (!me.simple) return null;
    const box = h('div', { class: 'stack', hidden: true });
    const two = (n) => String(n).padStart(2, '0');
    const when = (ts) => { const d = new Date(ts); return `${d.getDate()}.${d.getMonth() + 1} kl. ${two(d.getHours())}.${two(d.getMinutes())}`; };
    const load = async () => {
      let list = [];
      try { list = (await api('/api/account/pending-teachers', { noRedirect: true })).teachers || []; } catch (e) { /* vises ikke */ }
      box.replaceChildren(...list.map((t) => {
        const ok = h('button', { class: 'btn small primary', text: 'Godkend' });
        const no = h('button', { class: 'btn small', text: 'Afvis' });
        ok.addEventListener('click', async () => {
          try { await api(`/api/account/teachers/${t.id}/approve`, { method: 'POST', body: {} }); toast(`${t.name} er godkendt`); load(); } catch (ex) { toast(ex.message); }
        });
        no.addEventListener('click', async () => {
          const sure = await dialog({ title: `Afvis ${t.name}?`, body: h('p', { text: 'Kontoen slettes. Var det en kollega, kan vedkommende oprette sig igen med en ny lærerkode.' }), actions: [{ label: 'Annuller' }, { label: 'Afvis', kind: 'danger', value: true }] });
          if (!sure) return;
          try { await api(`/api/account/teachers/${t.id}`, { method: 'DELETE', body: {} }); toast(`${t.name} er afvist`); load(); } catch (ex) { toast(ex.message); }
        });
        return h('div', { class: 'banner warn', role: 'status' }, h('span', { text: `Ny lærer venter: ${t.name} (oprettet ${when(t.created)})` }), h('span', { class: 'row-actions' }, ok, no));
      }));
      box.hidden = !list.length;
    };
    load();
    return box;
  }

  function gettingStarted() {
    // Trin 1 er det næste skridt (markeret), resten venter – fremgangen er synlig (goal-gradient)
    const step = (n, title, body) => h('li', { class: n === 1 ? 'now' : '' , 'aria-current': n === 1 ? 'step' : null }, h('span', { class: 'step-n', text: String(n) }), h('div', {}, h('b', { text: title }), h('div', { class: 'muted small' }, ...body)));
    return h('section', { class: 'card onboard reveal' },
      h('h2', { text: 'Kom i gang på 5 minutter' }),
      h('ol', { class: 'steps' },
        step(1, 'Opret din første klasse', ['Skriv navnet øverst til højre – fx "2.g Dansk".']),
        step(2, 'Giv eleverne klassekoden', ['Klassen får en kode på 8 tegn. Skriv den på tavlen.']),
        step(3, 'Eleverne henter HolyMoly-appen', ['De installerer den fra ', h('a', { href: '/hent', target: '_blank', rel: 'noopener', text: 'hent-siden' }), ' og skriver klassekoden og deres navn.']),
        step(4, 'Tryk "Start lektion"', ['Lamperne viser, om en elev har AI eller forbudte sider åbne. Alt stopper, når lektionen slutter.'])));
  }

  async function afterLogin() {
    let inv = null;
    try { inv = sessionStorage.getItem('hm-invite'); sessionStorage.removeItem('hm-invite'); } catch (e) { /* */ }
    if (inv) {
      try { const r = await api('/api/invite/accept', { method: 'POST', body: { token: inv }, noRedirect: true }); toast('Du er nu med i ' + r.schoolName); } catch (e) { toast(e.message); }
    }
    route('/', true);
  }

  /* ---------------- små byggeklodser ---------------- */
  const field = (label, input, hint) => h('label', {}, label, input, hint ? h('span', { class: 'hint', text: hint }) : null);
  const input = (attrs) => h('input', attrs);
  const errBox = () => h('p', { class: 'error', hidden: true, role: 'alert' });
  const setErr = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg; };
  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Et øjeblik…'; } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
  // Centreret kort (login-agtige sider)
  function authShell(...children) {
    app.replaceChildren(h('main', { class: 'auth' },
      h('div', { class: 'auth-card wide reveal' },
        h('a', { class: 'brand', href: '/forside' }, h('img', { src: '/icon.svg', alt: '', width: 40, height: 40 }), h('span', { text: 'HolyMoly' })),
        ...children),
      h('p', { class: 'auth-legal' }, h('a', { href: '/forside', text: 'Om HolyMoly' }), ' · ', h('a', { href: '/vilkaar', text: 'Vilkår' }), ' · ', h('a', { href: '/privatliv', text: 'Privatliv' }))));
  }
  function page(me, active, ...children) {
    app.replaceChildren(topbar(me, active), h('main', { class: 'page' }, ...children));
    HM.setCleanup(HM.setupInfo());
  }
  function pwStrength(pw) {
    let s = 0;
    if (pw.length >= 10) s++;
    if (pw.length >= 14) s++;
    if (/[a-zæøå]/.test(pw) && /[A-ZÆØÅ]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^\wæøåÆØÅ]/.test(pw)) s++;
    return pw.length < 10 ? 0 : Math.min(4, s);
  }
  function passwordField(name, label, autocomplete) {
    const inp = input({ name, type: 'password', autocomplete, required: true, minlength: 10, maxlength: 200 });
    const meter = h('div', { class: 'pw-meter', 'aria-hidden': 'true' }, h('span'));
    const hint = h('span', { class: 'hint', text: 'Mindst 10 tegn. En sætning er nemmest at huske.' });
    inp.addEventListener('input', () => { meter.dataset.s = String(pwStrength(inp.value)); });
    return h('label', {}, label, inp, meter, hint);
  }

  /* ---------------- opret konto ---------------- */
  HM.pages.signup = async function signup() {
    const seq = HM.seq();
    const invite = qs('invitation');
    const [inf, inv, me] = await Promise.all([
      info(),
      invite ? api('/api/invite/' + encodeURIComponent(invite), { noRedirect: true }).catch(e => ({ error: e.message })) : null,
      api('/api/me', { noRedirect: true }).catch(() => null),
    ]);
    if (HM.isStale(seq)) return;
    const err = errBox();
    if (inv && inv.error) {
      return authShell(h('h1', { text: 'Invitationen virker ikke' }), h('p', { class: 'muted', text: inv.error }), h('a', { class: 'btn primary', href: '/login', 'data-nav': '', text: 'Til login' }));
    }
    // Inviteret og allerede logget ind / har en konto: tilslut kontoen
    if (inv && (me || inv.hasAccount)) {
      const go = h('button', { class: 'btn primary', text: me ? `Tilslut mig ${inv.schoolName}` : 'Log ind for at tilslutte dig' });
      go.addEventListener('click', async () => {
        if (!me) { try { sessionStorage.setItem('hm-invite', invite); } catch (e) { /* */ } return route('/login'); }
        busy(go, true);
        try { const r = await api('/api/invite/accept', { method: 'POST', body: { token: invite }, noRedirect: true }); toast('Du er nu med i ' + r.schoolName); route('/'); } catch (e) { setErr(err, e.message); busy(go, false); }
      });
      return authShell(h('h1', { text: `Du er inviteret til ${inv.schoolName}` }),
        h('p', { class: 'muted', text: me ? `Du er logget ind som ${me.name}.` : `Der findes allerede en konto med ${inv.email}.` }), err, go);
    }
    if (me && !inv) return route('/', true);

    const closed = !inf.signupOpen && !inf.signupRequiresCode && !inv;
    if (closed) return authShell(h('h1', { text: 'Oprettelse er lukket' }), h('p', { class: 'muted', text: 'På denne server bliver lærere inviteret af skolens administrator. Spørg din skole.' }), h('a', { class: 'btn primary', href: '/login', 'data-nav': '', text: 'Til login' }));

    const form = h('form', { class: 'stack', novalidate: true });
    const name = input({ name: 'name', autocomplete: 'name', required: true, maxlength: 100 });
    const email = inf.simple && !inv
      ? input({ name: 'email', autocomplete: 'username', required: true, maxlength: 40, autocapitalize: 'none', spellcheck: 'false', placeholder: 'Fx mette' })
      : input({ name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 200, value: inv ? inv.email : null });
    const school = input({ name: 'schoolName', autocomplete: 'organization', maxlength: 120, placeholder: 'Fx Aarhus Katedralskole' });
    const code = input({ name: 'signupCode', autocomplete: 'off' });
    const terms = input({ type: 'checkbox', name: 'acceptTerms' });
    form.append(...[
      inf.licensing && !inv ? field('Skolens navn', school) : null,
      field('Dit navn', name),
      inf.simple && !inv ? field('Brugernavn', email, 'Det skriver du, når du logger ind. Ingen e-mail.')
        : field('Din arbejds-e-mail', email, inv ? 'Brug den e-mail, invitationen er sendt til.' : inf.verifyEmail ? 'Vi sender et link, så du kan bekræfte den.' : null),
      passwordField('password', 'Vælg en adgangskode', 'new-password'),
      inf.signupRequiresCode && !inv ? (inf.simple
        ? (inf.firstTeacher ? field('Opsætningskode', code, 'Den første lærer bruger opsætningskoden fra serverens log (den står, når serveren starter).') : field('Lærerkode', code, 'Får du af en kollega, der allerede bruger HolyMoly. Den står under Konto.'))
        : field('Skolekode', code, 'Fra skolens IT-ansvarlige')) : null,
      inf.simple ? h('label', { class: 'check terms' }, terms, h('span', {}, 'Jeg accepterer ', h('a', { href: '/vilkaar', target: '_blank', text: 'vilkårene' }), '. Eleverne accepterer ', h('a', { href: '/vilkaar-elev', target: '_blank', text: 'vilkårene for elever' }), ' i appen, når de tilmelder sig.')) : null,
      inf.licensing ? h('label', { class: 'check terms' }, terms, h('span', {}, 'Jeg accepterer ', h('a', { href: '/vilkaar', target: '_blank', text: 'vilkårene' }), ' og ', h('a', { href: '/databehandleraftale', target: '_blank', text: 'databehandleraftalen' }), ' på skolens vegne.')) : null,
      err,
      h('button', { class: 'btn primary big', type: 'submit', id: 'signup-submit', text: inv ? 'Opret konto og tilslut' : inf.licensing ? 'Opret skolen' : 'Opret konto' })].filter(Boolean));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setErr(err, '');
      const body = { name: name.value, email: email.value, password: form.password.value, schoolName: school.value, signupCode: code.value, acceptTerms: terms.checked, invite: invite || undefined };
      if (!body.name.trim()) return setErr(err, 'Skriv dit navn');
      if (form.password.value.length < 10) return setErr(err, 'Adgangskoden skal være mindst 10 tegn');
      if (inf.licensing && !inv && !body.schoolName.trim()) return setErr(err, 'Skriv skolens navn');
      if (inf.licensing && !terms.checked) return setErr(err, 'Sæt kryds ved vilkårene og databehandleraftalen');
      if (inf.simple && !terms.checked) return setErr(err, 'Sæt kryds ved vilkårene');
      const btn = $('#signup-submit');
      busy(btn, true, 'Opretter…');
      try {
        await api('/api/register', { method: 'POST', body, noRedirect: true });
        route('/', true);
      } catch (ex) { setErr(err, ex.message); busy(btn, false); }
    });
    const intro = inf.licensing && !inv ? h('p', { class: 'muted', text: `Opret skolen, og brug HolyMoly gratis i ${inf.trialDays} dage med alle lærere og klasser. Du bliver skolens administrator og kan invitere kolleger bagefter.` }) : null;
    authShell(
      h('h1', { text: inv ? `Bliv en del af ${inv.schoolName}` : inf.licensing ? 'Start skolens prøveperiode' : 'Opret en lærerkonto' }),
      intro, form,
      h('p', { class: 'auth-foot' }, 'Har du allerede en konto? ', h('a', { href: '/login', 'data-nav': '', text: 'Log ind' })));
    name.focus();
  };

  /* ---------------- glemt / nulstil / bekræft ---------------- */
  HM.pages.forgot = async function forgot() {
    const inf = await info();
    // Enkel tilstand: ingen mails – den, der passer serveren, laver en ny adgangskode
    if (inf.simple) return authShell(h('h1', { text: 'Glemt adgangskode' }),
      h('p', { class: 'muted', text: 'Denne HolyMoly-server bruger ikke e-mail. Bed den, der passer serveren, om en ny midlertidig adgangskode. På serveren skrives: npm run enkel -- nulstil <brugernavn>' }),
      h('p', { class: 'auth-foot' }, h('a', { href: '/login', 'data-nav': '', text: '← Tilbage til login' })));
    const err = errBox();
    const email = input({ name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 200 });
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Send link' });
    const form = h('form', { class: 'stack' }, field('Din e-mail', email), err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setErr(err, '');
      busy(btn, true, 'Sender…');
      try {
        await api('/api/password/forgot', { method: 'POST', body: { email: email.value }, noRedirect: true });
        form.replaceWith(h('div', { class: 'stack' }, h('div', { class: 'notice ok', text: `Hvis ${email.value} har en konto, har vi sendt et link til at vælge en ny adgangskode. Linket virker i 1 time – tjek også spam-mappen.` })));
      } catch (ex) { setErr(err, ex.message); busy(btn, false); }
    });
    authShell(h('h1', { text: 'Glemt adgangskode' }), h('p', { class: 'muted', text: 'Skriv din e-mail, så sender vi et link, hvor du kan vælge en ny.' }), form,
      h('p', { class: 'auth-foot' }, h('a', { href: '/login', 'data-nav': '', text: '← Tilbage til login' })));
    email.focus();
  };

  HM.pages.reset = function reset() {
    const tok = qs('t');
    const err = errBox();
    const pw2 = input({ name: 'password2', type: 'password', autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Gem ny adgangskode' });
    const form = h('form', { class: 'stack' }, passwordField('password', 'Ny adgangskode', 'new-password'), field('Gentag adgangskoden', pw2), err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setErr(err, '');
      if (form.password.value !== pw2.value) return setErr(err, 'De to adgangskoder er ikke ens');
      busy(btn, true, 'Gemmer…');
      try {
        const r = await api('/api/password/reset', { method: 'POST', body: { token: tok, password: form.password.value }, noRedirect: true });
        history.replaceState(null, '', '/nulstil');
        form.replaceWith(h('div', { class: 'stack' },
          h('div', { class: 'notice ok', text: 'Din adgangskode er skiftet, og du er logget ud alle andre steder.' + (r.mfa ? ' Du skal stadig bruge din godkendelses-app, når du logger ind.' : '') }),
          h('a', { class: 'btn primary', href: '/login', 'data-nav': '', text: 'Log ind' })));
      } catch (ex) { setErr(err, ex.message); busy(btn, false); }
    });
    authShell(h('h1', { text: 'Vælg en ny adgangskode' }), tok ? form : h('p', { class: 'error', text: 'Linket mangler en kode. Åbn linket fra mailen igen.' }));
  };

  HM.pages.verify = async function verify() {
    const tok = qs('t');
    authShell(h('h1', { text: 'Bekræfter din e-mail…' }), h('div', { class: 'spinner', 'aria-hidden': 'true' }));
    try {
      if (!tok) throw new Error('Linket mangler en kode. Åbn linket fra mailen igen.');
      await api('/api/verify', { method: 'POST', body: { token: tok }, noRedirect: true });
      history.replaceState(null, '', '/bekraeft');
      authShell(h('h1', { text: 'E-mailen er bekræftet' }), h('p', { class: 'muted', text: 'Tak! Nu mangler du kun det sidste trin.' }),
        h('a', { class: 'btn primary', href: '/', 'data-nav': '', text: 'Fortsæt' }));
    } catch (e) {
      authShell(h('h1', { text: 'Det virkede ikke' }), h('p', { class: 'muted', text: e.message }), h('a', { class: 'btn primary', href: '/', 'data-nav': '', text: 'Til HolyMoly' }));
    }
  };

  /* ---------------- opsætning: e-mail, to-faktor, skole ---------------- */
  const SETUP_STEPS = [['verify', 'E-mail'], ['2fa', 'To-faktor'], ['school', 'Skole']];
  function stepper(me) {
    const steps = SETUP_STEPS.filter(([k]) => k !== '2fa' || me.require2fa).filter(([k]) => k !== 'school' || me.licensing);
    const at = steps.findIndex(([k]) => k === me.needs);
    return h('ol', { class: 'stepper', 'aria-label': 'Opsætning' }, ...steps.map(([k, label], i) =>
      h('li', { class: i < at ? 'done' : i === at ? 'now' : '', 'aria-current': i === at ? 'step' : null }, h('span', { text: i < at ? '✓' : String(i + 1) }), label)));
  }

  HM.pages.setup = function setup(me) {
    const out = h('p', { class: 'auth-foot' }, h('button', { class: 'link small', text: 'Log ud', onclick: logout }));
    if (me.needs === 'approval') {
      const again = h('button', { class: 'btn primary', text: 'Prøv igen' });
      again.addEventListener('click', () => route('/', true));
      return authShell(h('h1', { text: 'Din konto venter på godkendelse' }),
        h('p', { text: 'En kollega, der allerede bruger HolyMoly, skal godkende dig, før du kan bruge HolyMoly.' }),
        h('p', { class: 'muted small', text: 'Bed en kollega om at logge ind. Godkendelsen står øverst på siden med klasserne.' }),
        h('div', { class: 'row-actions' }, again), out);
    }
    if (me.needs === 'verify') {
      const err = errBox();
      const resend = h('button', { class: 'btn', text: 'Send mailen igen' });
      resend.addEventListener('click', async () => {
        busy(resend, true, 'Sender…');
        try { await api('/api/account/verify/resend', { method: 'POST', body: {}, noRedirect: true }); toast('Mailen er sendt igen'); } catch (e) { setErr(err, e.message); }
        busy(resend, false);
      });
      const cont = h('button', { class: 'btn primary', text: 'Jeg har klikket på linket' });
      cont.addEventListener('click', () => route('/', true));
      return authShell(stepper(me), h('h1', { text: 'Tjek din indbakke' }),
        h('p', {}, 'Vi har sendt et link til ', h('b', { text: me.email }), '. Klik på det for at bekræfte din e-mail.'),
        h('p', { class: 'muted small', text: 'Kan du ikke finde mailen? Kig i spam-mappen, eller send den igen.' }), err,
        h('div', { class: 'row-actions' }, resend, cont), out);
    }
    if (me.needs === '2fa') {
      const box = h('div', { class: 'stack' });
      authShell(stepper(me), h('h1', { text: 'Beskyt kontoen med to-faktor' }), box, out);
      return totpWizard(box, () => route('/', true), true);
    }
    if (me.needs === 'school') {
      const err = errBox();
      const name = input({ name: 'name', maxlength: 120, required: true, placeholder: 'Fx Aarhus Gymnasium', autocomplete: 'organization' });
      const terms = input({ type: 'checkbox' });
      const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Opret skolen' });
      const form = h('form', { class: 'stack' }, field('Skolens navn', name, 'Du bliver skolens administrator og kan invitere kolleger.'),
        h('label', { class: 'check terms' }, terms, h('span', {}, 'Jeg accepterer ', h('a', { href: '/vilkaar', target: '_blank', text: 'vilkårene' }), ' og ', h('a', { href: '/databehandleraftale', target: '_blank', text: 'databehandleraftalen' }), ' på skolens vegne.')),
        err, btn);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!terms.checked) return setErr(err, 'Sæt kryds ved vilkårene og databehandleraftalen');
        busy(btn, true, 'Opretter…');
        try { await api('/api/school/create', { method: 'POST', body: { name: name.value, acceptTerms: true }, noRedirect: true }); toast('Skolen er oprettet – god fornøjelse!'); route('/', true); } catch (ex) { setErr(err, ex.message); busy(btn, false); }
      });
      return authShell(stepper(me), h('h1', { text: 'Hvilken skole er du fra?' }), form,
        h('div', { class: 'notice', text: 'Er din skole allerede med i HolyMoly? Så bed skolens administrator om en invitation og åbn linket i mailen.' }), out);
    }
    route('/', true);
  };

  /** Opsætning af godkendelses-app i tre trin: forklaring → scan → reservekoder. */
  function totpWizard(box, onDone, required) {
    const err = errBox();
    const intro = () => {
      const go = h('button', { class: 'btn primary', text: 'Kom i gang' });
      box.replaceChildren(
        h('p', { text: (required ? 'Du har adgang til elevers data, så HolyMoly kræver en ekstra kode fra din telefon, når du logger ind med e-mail. ' : '') + 'Det tager 2 minutter.' }),
        h('ol', { class: 'mini-steps' },
          h('li', {}, 'Hent en godkendelses-app, fx ', h('b', { text: 'Microsoft Authenticator' }), ' eller ', h('b', { text: 'Google Authenticator' }), ' (gratis).'),
          h('li', { text: 'Scan QR-koden, vi viser dig.' }),
          h('li', { text: 'Skriv koden fra appen – og gem dine reservekoder.' })),
        h('p', { class: 'muted small', text: 'Logger du ind med Unilogin, bruges Unilogins egen sikkerhed (fx MitID) i stedet.' }),
        err, go);
      go.addEventListener('click', start);
    };
    const start = async () => {
      setErr(err, '');
      let r;
      try { r = await api('/api/account/2fa/start', { method: 'POST', body: {}, noRedirect: true }); } catch (e) { return setErr(err, e.message); }
      const code = input({ class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, 'aria-label': 'Kode fra appen', placeholder: '123 456' });
      const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Bekræft' });
      const form = h('form', { class: 'stack' }, field('Skriv koden fra appen', code), err, btn);
      const img = r.qrSvg ? h('img', { class: 'qr', alt: 'QR-kode til godkendelses-appen', src: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(r.qrSvg))) }) : null;
      box.replaceChildren(
        h('div', { class: 'qr-wrap' }, img, h('div', { class: 'stack' },
          h('p', { class: 'small', text: 'Åbn appen, tryk "+" / "Tilføj konto", og scan koden.' }),
          h('details', {}, h('summary', { class: 'small', text: 'Kan du ikke scanne?' }), h('p', { class: 'small muted', text: 'Vælg "Indtast kode manuelt" i appen og skriv:' }), h('code', { class: 'secret', text: r.secret })),
          h('a', { class: 'small', href: r.otpauth, text: 'Åbn i appen på denne enhed' }))),
        form);
      code.focus();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        setErr(err, '');
        busy(btn, true, 'Tjekker…');
        try {
          const ok = await api('/api/account/2fa/enable', { method: 'POST', body: { code: code.value }, noRedirect: true });
          showCodes(ok.backupCodes);
        } catch (ex) { setErr(err, ex.message); busy(btn, false); code.select(); }
      });
    };
    const showCodes = (codes) => {
      const done = h('button', { class: 'btn primary', text: 'Færdig', disabled: true });
      const saved = input({ type: 'checkbox' });
      saved.addEventListener('change', () => { done.disabled = !saved.checked; });
      done.addEventListener('click', onDone);
      box.replaceChildren(h('div', { class: 'notice ok', text: 'To-faktor er slået til.' }), backupCodesView(codes),
        h('label', { class: 'check' }, saved, 'Jeg har gemt mine reservekoder et sikkert sted'), done);
    };
    intro();
  }

  function backupCodesView(codes) {
    const text = 'HolyMoly – reservekoder\nHver kode virker én gang, hvis du ikke har din telefon.\n\n' + codes.join('\n') + '\n';
    const copy = h('button', { class: 'btn small', type: 'button', text: 'Kopiér' });
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Kopieret'); } catch (e) { toast('Kunne ikke kopiere – markér koderne i stedet'); } });
    const dl = h('a', { class: 'btn small', download: 'holymoly-reservekoder.txt', href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), text: 'Hent som fil' });
    return h('div', { class: 'stack' },
      h('p', { class: 'small', text: 'Mister du telefonen, kan du logge ind med en af disse reservekoder. Hver kode virker én gang. Gem dem fx i din adgangskode-manager eller print dem.' }),
      h('ol', { class: 'backup-codes' }, ...codes.map(c => h('li', { text: c }))),
      h('div', { class: 'row-actions start' }, copy, dl, h('button', { class: 'btn small', type: 'button', text: 'Print', onclick: () => window.print() })));
  }

  /* ---------------- konto ---------------- */
  HM.pages.account = async function account() {
    const seq = HM.seq();
    let me, inf;
    try { [me, inf] = await Promise.all([api('/api/me'), info()]); } catch (e) { return; }
    if (HM.isStale(seq)) return;
    if (me.needs) return HM.pages.setup(me);

    // Profil
    const err1 = errBox();
    const name = input({ value: me.name, maxlength: 100, autocomplete: 'name' });
    const saveName = h('button', { class: 'btn', type: 'submit', text: 'Gem' });
    const nameForm = h('form', { class: 'inline-form' }, field('Navn', name), saveName);
    nameForm.addEventListener('submit', async (e) => {
      e.preventDefault(); setErr(err1, '');
      try { await api('/api/account/name', { method: 'POST', body: { name: name.value } }); toast('Gemt'); } catch (ex) { setErr(err1, ex.message); }
    });
    const profile = h('section', { class: 'card' }, h('h2', { text: 'Profil' }), nameForm,
      h('dl', { class: 'facts' },
        h('dt', { text: me.simple ? 'Brugernavn' : 'E-mail' }), h('dd', { text: me.email || '– (Unilogin)' }),
        h('dt', { text: 'Skole' }), h('dd', { text: me.school ? `${me.school.name} (${me.school.role === 'admin' ? 'administrator' : 'lærer'})` : '–' }),
        h('dt', { text: 'Unilogin' }), h('dd', {}, me.uniLinked ? h('span', { class: 'badge green', text: 'Tilknyttet' }) : inf.uniLogin ? h('a', { class: 'btn small uni-btn', href: '/api/auth/unilogin/start?role=teacher&link=1' }, 'Tilknyt ', h('b', { text: 'Uni' }), 'login') : h('span', { class: 'muted', text: 'Ikke slået til på serveren' }))),
      err1);

    // Adgangskode
    let pwCard = null;
    if (!me.uniOnly) {
      const err = errBox();
      const cur = input({ type: 'password', autocomplete: 'current-password', required: true });
      const btn = h('button', { class: 'btn', type: 'submit', text: 'Skift adgangskode' });
      const form = h('form', { class: 'stack narrow' }, field('Nuværende adgangskode', cur), passwordField('password', 'Ny adgangskode', 'new-password'), err, btn);
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); setErr(err, '');
        busy(btn, true, 'Gemmer…');
        try { await api('/api/account/password', { method: 'POST', body: { current: cur.value, password: form.password.value } }); form.reset(); toast('Adgangskoden er skiftet – du er logget ud alle andre steder'); } catch (ex) { setErr(err, ex.message); }
        busy(btn, false);
      });
      pwCard = h('section', { class: 'card' }, h('h2', { text: 'Adgangskode' }), form);
    }

    // To-faktor
    const tfBody = h('div', { class: 'stack' });
    const renderTf = () => {
      if (!me.totp) {
        const on = h('button', { class: 'btn primary', text: 'Slå to-faktor til' });
        on.addEventListener('click', () => totpWizard(tfBody, () => { me.totp = true; renderTf(); }, false));
        tfBody.replaceChildren(h('p', { text: 'Kræv en kode fra din telefon, når du logger ind med e-mail. Det beskytter elevernes data, hvis din adgangskode bliver stjålet.' }), on);
        return;
      }
      const newCodes = h('button', { class: 'btn', text: 'Lav nye reservekoder' });
      newCodes.addEventListener('click', async () => {
        const code = input({ class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7 });
        const r = await dialog({ title: 'Nye reservekoder', body: [h('p', { class: 'muted', text: 'De gamle reservekoder holder op med at virke.' }), field('Kode fra godkendelses-appen', code)],
          actions: [{ label: 'Annuller' }, { label: 'Lav nye', kind: 'primary', submit: true, run: () => api('/api/account/2fa/backup', { method: 'POST', body: { code: code.value } }) }] });
        if (r) dialog({ title: 'Dine nye reservekoder', body: backupCodesView(r.backupCodes), actions: [{ label: 'Færdig', kind: 'primary', value: true }] });
      });
      const off = me.require2fa ? null : h('button', { class: 'btn ghost danger-text', text: 'Slå fra' });
      if (off) off.addEventListener('click', async () => {
        const pw = input({ type: 'password', autocomplete: 'current-password' });
        const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 14 });
        const r = await dialog({ title: 'Slå to-faktor fra?', body: [field('Adgangskode', pw), field('Kode fra appen (eller en reservekode)', code)],
          actions: [{ label: 'Annuller' }, { label: 'Slå fra', kind: 'danger', submit: true, run: () => api('/api/account/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } }) }] });
        if (r) { me.totp = false; renderTf(); toast('To-faktor er slået fra'); }
      });
      tfBody.replaceChildren(h('p', {}, h('span', { class: 'badge green', text: 'Slået til' }), ' Du skal bruge koden fra din godkendelses-app, når du logger ind med e-mail.'),
        me.require2fa ? h('p', { class: 'muted small', text: 'Ny telefon? Logger du ind med en reservekode, kan skolens administrator nulstille din to-faktor, så du kan sætte den op igen.' }) : null,
        h('div', { class: 'row-actions start' }, newCodes, off));
    };
    renderTf();
    const tfCard = me.uniOnly || (me.simple && !me.totp) ? null : h('section', { class: 'card' }, h('h2', { text: 'To-faktor' }), tfBody);

    // Udseende
    const seg = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Udseende' });
    for (const [val, label] of [['light', 'Lys'], ['dark', 'Mørk']]) {
      const b = h('button', { type: 'button', role: 'radio', class: HM.currentTheme() === val ? 'on' : '', 'aria-checked': String(HM.currentTheme() === val), text: label });
      b.addEventListener('click', () => { HM.setTheme(val); for (const x of seg.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); } });
      seg.append(b);
    }
    const looks = h('section', { class: 'card' }, h('h2', { text: 'Udseende' }), seg, h('p', { class: 'muted small', text: 'Gemmes i denne browser.' }));

    // Slet konto
    const del = h('button', { class: 'btn danger', text: 'Slet min konto' });
    del.addEventListener('click', async () => {
      const pw = input({ type: me.uniOnly ? 'text' : 'password', autocomplete: me.uniOnly ? 'off' : 'current-password', placeholder: me.uniOnly ? 'SLET' : '' });
      const r = await dialog({
        title: 'Slet din konto?',
        body: [h('p', { text: 'Din konto, dine klasser og alle elevdata i dem (log, skærmbilleder og dokumenter) slettes med det samme. Det kan ikke fortrydes.' }),
          field(me.uniOnly ? 'Skriv SLET for at bekræfte' : 'Skriv din adgangskode for at bekræfte', pw)],
        actions: [{ label: 'Annuller' }, { label: 'Slet alt', kind: 'danger', submit: true, run: () => api('/api/account', { method: 'DELETE', body: { password: pw.value, confirm: pw.value } }) }],
      });
      if (r) { toast('Kontoen er slettet'); setTimeout(() => { location.href = '/forside'; }, 800); }
    });
    const danger = h('section', { class: 'card danger-zone' }, h('h2', { text: 'Slet konto' }),
      h('p', { class: 'muted', text: 'Sletter din konto og dine klasser med alle elevdata. Er du skolens eneste administrator, skal du først gøre en kollega til administrator.' }), del);

    // Enkel tilstand: lærerkoden, som kolleger skal bruge for at oprette sig
    let colleagues = null;
    if (me.teacherCodeOn) {
      const codeEl = h('div', { class: 'big-code', hidden: true });
      const until = h('p', { class: 'muted small', hidden: true });
      const showCode = (r) => {
        codeEl.textContent = r.teacherCode; codeEl.hidden = false;
        until.textContent = `Koden gælder til kl. ${new Date(r.expires).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}.`; until.hidden = false;
        rot.hidden = false; reveal.hidden = true;
      };
      const reveal = h('button', { class: 'btn', type: 'button', text: 'Vis kode' });
      reveal.addEventListener('click', async () => {
        try { showCode(await api('/api/account/teacher-code/show', { method: 'POST', body: {} })); } catch (ex) { toast(ex.message); }
      });
      const rot = h('button', { class: 'btn small', type: 'button', text: 'Lav ny lærerkode', hidden: true });
      rot.addEventListener('click', async () => {
        const ok = await dialog({ title: 'Lav ny lærerkode?', body: h('p', { text: 'Den gamle kode holder op med at virke. Lærere, der allerede er oprettet, mærker intet.' }), actions: [{ label: 'Annuller' }, { label: 'Lav ny', kind: 'primary', value: true }] });
        if (!ok) return;
        try { showCode(await api('/api/account/teacher-code', { method: 'POST', body: {} })); toast('Ny lærerkode'); } catch (ex) { toast(ex.message); }
      });
      colleagues = h('section', { class: 'card' }, h('h2', { text: 'Kolleger' }),
        h('p', { class: 'muted', text: `Kolleger opretter sig på ${location.origin}/opret med lærerkoden. Giv den kun til lærere – ikke til elever.` }),
        h('p', { class: 'muted small', text: 'Koden gælder i 30 minutter. Bagefter skal du godkende din kollega. Det står øverst på siden med klasserne.' }),
        reveal, codeEl, until, rot);
    }
    page(me, 'konto', h('div', { class: 'page-head' }, h('h1', { text: 'Konto og sikkerhed' })),
      h('div', { class: 'cards' }, profile, colleagues, tfCard, pwCard, looks, danger));
  };

  /* ---------------- skole og licens ---------------- */
  function licenseCard(s) {
    const L = s.license;
    const state = { trial: ['Prøveperiode', 'info'], active: ['Aktiv licens', 'green'], expired: ['Udløbet', 'red'] }[L.state];
    const pct = L.seats ? Math.min(100, Math.round(L.used / L.seats * 100)) : 0;
    return h('section', { class: 'card license-card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Licens' }), h('span', { class: 'badge ' + state[1], text: state[0] })),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'tile-n', text: L.state === 'expired' ? '0' : String(L.daysLeft) }), h('div', { class: 'muted small', text: L.state === 'expired' ? `udløb ${fmtDate(L.until)}` : `dage tilbage (til ${fmtDate(L.until)})` })),
        h('div', { class: 'tile' }, h('div', { class: 'tile-n', text: String(L.used) }), h('div', { class: 'muted small', text: L.seats ? `af ${L.seats} elevpladser` : 'elever tilmeldt' }))),
      L.seats ? h('div', { class: 'meter' + (L.overSeats ? ' over' : '') }, h('span', { style: `width:${pct}%` })) : null,
      L.state === 'trial' ? h('p', { class: 'muted small', text: 'I prøveperioden virker alt uden begrænsninger. Bestil licensen, når I er klar – I får en faktura (EAN) og fortsætter uden afbrydelse.' }) : null,
      L.state === 'expired' ? h('p', { class: 'error', text: 'Lektioner kan ikke startes, før licensen er bestilt. Alle data er bevaret.' }) : null);
  }

  function orderForm(s, me) {
    const P = s.pricing;
    const err = errBox();
    const students = input({ type: 'number', min: 1, max: 20000, step: 1, value: Math.max(s.license.used, s.license.seats || 0, 30), required: true });
    const years = h('select', {}, ...[1, 2, 3].map(y => h('option', { value: y, text: y === 1 ? '1 år' : y + ' år' })));
    const total = h('div', { class: 'price-total' });
    const calc = () => {
      const n = Math.max(1, Math.round(Number(students.value) || 0)), y = Number(years.value);
      const yearly = Math.max(P.minimum, n * P.perStudent);
      total.replaceChildren(h('div', { class: 'price-big', text: kr(yearly * y) }),
        h('div', { class: 'muted small', text: `${kr(P.perStudent)} pr. elev pr. år${yearly === P.minimum ? ` (minimum ${kr(P.minimum)} pr. år)` : ''} · ekskl. moms` }));
    };
    students.addEventListener('input', calc); years.addEventListener('change', calc); calc();
    const inst = input({ value: s.name, maxlength: 160, autocomplete: 'organization' });
    const cvr = input({ inputmode: 'numeric', maxlength: 10, placeholder: '8 cifre', autocomplete: 'off' });
    const ean = input({ inputmode: 'numeric', maxlength: 16, placeholder: '13 cifre – offentlige skoler', autocomplete: 'off' });
    const invMail = input({ type: 'email', maxlength: 200, placeholder: 'Hvis I ikke har EAN', autocomplete: 'email' });
    const ref = input({ maxlength: 120, placeholder: 'Fx indkøbsnummer eller kontaktperson' });
    const contact = input({ value: me.name, maxlength: 100, autocomplete: 'name' });
    const phone = input({ type: 'tel', maxlength: 30, autocomplete: 'tel' });
    const terms = input({ type: 'checkbox' });
    const btn = h('button', { class: 'btn primary big', type: 'submit', text: 'Bestil licens' });
    const form = h('form', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Antal elever', students), field('Periode', years)), total,
      h('h3', { text: 'Faktura' }),
      h('div', { class: 'grid2' }, field('Institution', inst), field('CVR-nummer', cvr), field('EAN-nummer', ean), field('Faktura-e-mail', invMail), field('Reference / ordrenummer', ref), field('Kontaktperson', contact), field('Telefon (valgfri)', phone)),
      h('label', { class: 'check terms' }, terms, h('span', {}, 'Jeg bestiller på skolens vegne og accepterer ', h('a', { href: '/vilkaar', target: '_blank', text: 'vilkårene' }), ' og ', h('a', { href: '/databehandleraftale', target: '_blank', text: 'databehandleraftalen' }), '.')),
      err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); setErr(err, '');
      if (!terms.checked) return setErr(err, 'Sæt kryds ved vilkårene og databehandleraftalen');
      busy(btn, true, 'Sender bestilling…');
      try {
        const r = await api('/api/school/order', { method: 'POST', body: { students: Number(students.value), years: Number(years.value), institution: inst.value, cvr: cvr.value, ean: ean.value, invoiceEmail: invMail.value, reference: ref.value, contactName: contact.value, phone: phone.value, acceptTerms: true } });
        form.replaceWith(h('div', { class: 'notice ok' }, h('b', { text: `Tak! Bestilling #${r.id} er modtaget (${kr(r.amount)} ekskl. moms).` }), h('div', { text: 'Vi sender fakturaen og aktiverer licensen. I kan bruge HolyMoly uden afbrydelse imens. Du får en bekræftelse på mail.' })));
      } catch (ex) { setErr(err, ex.message); busy(btn, false); }
    });
    const quote = h('a', { class: 'btn small', target: '_blank', rel: 'noopener', text: 'Hent tilbud til ledelsen' });
    const setQuote = () => { quote.href = '/tilbud?' + new URLSearchParams({ skole: inst.value || s.name, elever: String(Math.max(1, Math.round(Number(students.value) || 1))), aar: years.value, kontakt: contact.value, ean: ean.value.replace(/\D/g, '') }).toString(); };
    for (const x of [students, years, inst, contact, ean]) x.addEventListener('input', setQuote);
    years.addEventListener('change', setQuote);
    setQuote();
    return h('section', { class: 'card', id: 'licens' }, h('div', { class: 'card-head' }, h('h2', { text: s.license.state === 'active' ? 'Udvid eller forny licensen' : 'Bestil licens' }), quote),
      h('p', { class: 'muted small', text: 'Licensen gælder hele skolen: alle lærere, alle klasser, Unilogin, afleveringer og lektionsrapporter. Prisen afhænger kun af antal elever. Skal rektor eller økonomi godkende først, så hent et tilbud.' }), form);
  }

  /** Unilogin: skolens institutionsnummer – lærere fra institutionen kommer automatisk med i skolen. */
  function uniCard(s, reload) {
    const err = errBox();
    const set = async (nr) => {
      setErr(err, '');
      try { await api('/api/school', { method: 'PATCH', body: { instNr: nr } }); toast(nr ? 'Institutionsnummeret er gemt' : 'Institutionsnummeret er fjernet'); reload(); } catch (e) { setErr(err, e.message); }
    };
    const current = s.instNr
      ? h('p', {}, 'Skolens institutionsnummer: ', h('b', { text: s.instNr }), '. Lærere, der logger ind med Unilogin fra institutionen, kommer automatisk med i skolen som lærere.')
      : h('p', { class: 'muted', text: 'Intet institutionsnummer endnu. Lærerne kan stadig inviteres på e-mail.' });
    const mine = (s.myInstitutions || []).filter(i => i.nr !== s.instNr);
    const picks = mine.length
      ? h('div', { class: 'row-actions start' }, ...mine.map(i => h('button', { class: 'btn small', type: 'button', text: `Brug ${i.name || 'institution'} (${i.nr})`, onclick: () => set(i.nr) })))
      : (!s.instNr ? h('p', { class: 'muted small', text: s.uniLogin ? 'Log ind med Unilogin én gang, så kan du vælge skolens institutionsnummer her.' : 'Unilogin er ikke slået til på serveren endnu (se docs/UNILOGIN.md).' }) : null);
    const clear = s.instNr ? h('button', { class: 'btn small ghost danger-text', type: 'button', text: 'Fjern', onclick: () => set(null) }) : null;
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Unilogin' }), clear), current, picks, err);
  }

  function teachersCard(s, reload) {
    const roleSel = (t) => {
      const sel = h('select', { 'aria-label': 'Rolle for ' + t.name }, h('option', { value: 'teacher', text: 'Lærer', selected: t.role === 'teacher' }), h('option', { value: 'admin', text: 'Administrator', selected: t.role === 'admin' }));
      sel.addEventListener('change', async () => {
        try { await api('/api/school/teachers/' + t.id, { method: 'PATCH', body: { role: sel.value } }); toast('Rollen er ændret'); reload(); } catch (e) { toast(e.message); sel.value = t.role; }
      });
      return sel;
    };
    const rowActions = (t) => {
      if (t.me) return h('span', { class: 'muted small', text: 'Dig' });
      const reset = t.totp ? h('button', { class: 'btn small', text: 'Nulstil to-faktor', title: 'Hvis læreren har mistet sin telefon' }) : null;
      if (reset) reset.addEventListener('click', async () => {
        const ok = await dialog({ title: `Nulstil to-faktor for ${t.name}?`, body: h('p', { text: 'Gør det kun, hvis du har talt med læreren (fx mistet telefon). Læreren logges ud og sætter to-faktor op igen ved næste login.' }), actions: [{ label: 'Annuller' }, { label: 'Nulstil', kind: 'danger', value: true }] });
        if (!ok) return;
        try { await api(`/api/school/teachers/${t.id}/reset-2fa`, { method: 'POST', body: {} }); toast('To-faktor er nulstillet'); reload(); } catch (e) { toast(e.message); }
      });
      const rm = h('button', { class: 'btn small ghost danger-text', text: 'Fjern' });
      rm.addEventListener('click', async () => {
        const ok = await dialog({ title: `Fjern ${t.name} fra skolen?`, body: h('p', { text: 'Læreren beholder sin konto og sine klasser, men kan ikke starte lektioner under skolens licens.' }), actions: [{ label: 'Annuller' }, { label: 'Fjern', kind: 'danger', value: true }] });
        if (!ok) return;
        try { await api('/api/school/teachers/' + t.id, { method: 'DELETE', body: {} }); toast(t.name + ' er fjernet'); reload(); } catch (e) { toast(e.message); }
      });
      return h('div', { class: 'row-actions start' }, reset, rm);
    };
    const table = h('div', { class: 't-scroll' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['Navn', 'Rolle', 'Klasser', 'Elever', 'Sikkerhed', ''].map(x => h('th', { text: x })))),
      h('tbody', {}, ...s.teachers.map(t => h('tr', {},
        h('td', {}, h('b', { text: t.name }), h('div', { class: 'muted small', text: t.email || 'Unilogin' })),
        h('td', {}, t.me ? h('span', { text: t.role === 'admin' ? 'Administrator' : 'Lærer' }) : roleSel(t)),
        h('td', { class: 'num', text: String(t.classes) }), h('td', { class: 'num', text: String(t.students) }),
        h('td', {}, t.uni ? h('span', { class: 'badge green', text: 'Unilogin' }) : null, ' ', t.totp ? h('span', { class: 'badge green', text: 'To-faktor' }) : h('span', { class: 'badge', text: 'Ingen to-faktor' }), !t.verified ? h('span', { class: 'badge', text: 'E-mail ikke bekræftet' }) : null),
        h('td', {}, rowActions(t)))))));

    // Invitér
    const err = errBox();
    const emails = h('textarea', { rows: 2, class: 'short', placeholder: 'En eller flere e-mails – fx\nanna@skole.dk, bo@skole.dk', 'aria-label': 'E-mails' });
    const role = h('select', { 'aria-label': 'Rolle' }, h('option', { value: 'teacher', text: 'som lærere' }), h('option', { value: 'admin', text: 'som administratorer' }));
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Send invitationer' });
    const form = h('form', { class: 'stack' }, h('label', {}, 'Invitér kolleger', emails), h('div', { class: 'row-actions start' }, role, btn), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); setErr(err, '');
      const list = emails.value.split(/[\s,;]+/).filter(Boolean);
      if (!list.length) return setErr(err, 'Skriv mindst én e-mail');
      busy(btn, true, 'Sender…');
      try {
        const r = await api('/api/school/invites', { method: 'POST', body: { emails: list, role: role.value } });
        toast(r.sent.length ? `Invitation sendt til ${plural(r.sent.length, 'kollega', 'kolleger')}` : 'Ingen invitationer sendt');
        if (r.skipped.length) setErr(err, 'Ikke sendt: ' + r.skipped.join(', '));
        emails.value = '';
        reload();
      } catch (ex) { setErr(err, ex.message); }
      busy(btn, false);
    });
    const pending = s.invites.length ? h('div', { class: 'stack' }, h('h3', { text: 'Ventende invitationer' }), h('ul', { class: 'list' }, ...s.invites.map(i => {
      const x = h('button', { class: 'btn small ghost', text: 'Annullér' });
      x.addEventListener('click', async () => { await api('/api/school/invites/' + i.id, { method: 'DELETE', body: {} }); reload(); });
      return h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title', text: i.email }), h('div', { class: 'url', text: `${i.role === 'admin' ? 'Administrator' : 'Lærer'} · udløber ${fmtDate(i.expires)}` })), x);
    }))) : null;
    return h('section', { class: 'card span2' }, h('div', { class: 'card-head' }, h('h2', { text: 'Lærere' }), h('span', { class: 'muted small', text: plural(s.teachers.length, 'lærer', 'lærere') })), table, form, pending);
  }

  /** Sikkerhedslog til skolens administrator: logins, ændringer af login og administratorhandlinger. */
  function securityCard() {
    const body = h('div', {});
    const btn = h('button', { class: 'btn small', type: 'button', text: 'Vis sikkerhedsloggen' });
    const KIND = { 'login': ['Login', ''], 'login-fail': ['Fejlet login', 'red'], 'account': ['Konto', ''], 'admin': ['Administration', ''] };
    btn.addEventListener('click', async () => {
      busy(btn, true);
      try {
        const r = await api('/api/school/security-log');
        btn.remove();
        body.append(
          r.entries.length ? h('ul', { class: 'list' }, ...r.entries.map(e => {
            const k = KIND[e.kind] || [e.kind, ''];
            return h('li', {},
              h('div', { class: 'main' }, h('div', { class: 'title', text: e.text }),
                h('div', { class: 'url', text: new Date(e.ts).toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' }) + (e.ip ? ' · ' + e.ip : '') })),
              h('span', { class: 'badge ' + k[1], text: k[0] }));
          })) : h('p', { class: 'muted', text: 'Ingen hændelser endnu.' }),
          h('p', { class: 'muted small', text: `Gemmes i ${r.keepDays} dage. Kun skolens administratorer kan se loggen.` }));
      } catch (e) { toast(e.message); busy(btn, false); }
    });
    return h('section', { class: 'card span2' }, h('div', { class: 'card-head' }, h('h2', { text: 'Sikkerhedslog' })),
      h('p', { class: 'muted', text: 'Hvem har logget ind og hvordan, forkerte adgangskoder og to-faktor-koder, ændringer af adgangskode og to-faktor, invitationer og roller.' }),
      body, btn);
  }

  HM.pages.school = async function school() {
    const seq = HM.seq();
    let me, s;
    try { me = await api('/api/me'); if (me.needs) return HM.pages.setup(me); s = await api('/api/school'); } catch (e) { if (!HM.isStale(seq)) { toast(e.message); route('/'); } return; }
    if (HM.isStale(seq)) return;
    const admin = s.role === 'admin';
    const reload = () => HM.pages.school();
    const title = h('h1', { text: s.name });
    const rename = admin ? h('button', { class: 'btn ghost small', text: 'Omdøb' }) : null;
    if (rename) rename.addEventListener('click', async () => {
      const n = input({ value: s.name, maxlength: 120 });
      const ok = await dialog({ title: 'Omdøb skolen', body: field('Navn', n), actions: [{ label: 'Annuller' }, { label: 'Gem', kind: 'primary', submit: true, run: () => api('/api/school', { method: 'PATCH', body: { name: n.value } }) }] });
      if (ok) reload();
    });
    const orders = admin && s.orders.length ? h('section', { class: 'card' }, h('h2', { text: 'Bestillinger' }), h('ul', { class: 'list' }, ...s.orders.map(o =>
      h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title', text: `#${o.id} · ${o.students} elever · ${o.years === 1 ? '1 år' : o.years + ' år'}` }), h('div', { class: 'url', text: `${fmtDate(o.created)} · ${kr(o.amount)} ekskl. moms · ${o.ean ? 'EAN ' + o.ean : o.invoiceEmail}` })),
        h('span', { class: 'badge ' + (o.status === 'betalt' ? 'green' : o.status === 'annulleret' ? 'red' : ''), text: o.status }))))) : null;
    page(me, 'skole',
      h('div', { class: 'page-head' }, h('div', { class: 'title-row' }, title, rename), h('span', { class: 'pill', text: admin ? 'Du er administrator' : 'Lærer' })),
      HM.licenseBanner(me),
      h('div', { class: 'cards' },
        s.licensing ? licenseCard(s) : null,
        admin && s.licensing ? orderForm(s, me) : null,
        !admin ? h('section', { class: 'card' }, h('h2', { text: 'Spørgsmål om licensen?' }), h('p', { class: 'muted', text: 'Licensen og kollegerne styres af skolens administrator. Spørg vedkommende, hvis du skal have en kollega med, eller licensen skal fornyes.' })) : null,
        admin ? uniCard(s, reload) : null,
        admin ? teachersCard(s, reload) : null,
        admin ? securityCard() : null,
        orders));
    if (location.hash === '#licens') { const el = $('#licens'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };

  /* ---------------- afleveringer på tværs af klasser ---------------- */
  HM.pages.assignments = async function assignments() {
    const seq = HM.seq();
    let me, d;
    try { me = await api('/api/me'); if (me.needs) return HM.pages.setup(me); d = await api('/api/assignments'); } catch (e) { return; }
    if (HM.isStale(seq)) return;
    const now = Date.now();
    const open = d.assignments.filter(a => !a.due || a.due > now).sort((x, y) => (x.due || 9e15) - (y.due || 9e15));
    const past = d.assignments.filter(a => a.due && a.due <= now);
    const row = (a) => {
      const missing = Math.max(0, a.students - a.handed);
      return h('tr', { class: 'clickable', tabindex: '0', onclick: () => route(`/klasse/${a.classId}#afleveringer`), onkeydown: (e) => { if (e.key === 'Enter') route(`/klasse/${a.classId}#afleveringer`); } },
        h('td', {}, h('b', { text: a.title }), h('div', { class: 'muted small', text: a.className + (a.home ? ' · må skrives hjemme' : ' · skrives i timen') })),
        h('td', { class: 'num', text: a.due ? fmtDate(a.due) : '–' }),
        h('td', { class: 'num', text: `${a.handed}/${a.students}` }),
        h('td', {}, a.certified ? h('span', { class: 'badge green', text: `${a.certified} ✓ tastet i HolyMoly` }) : h('span', { class: 'muted small', text: '–' })),
        h('td', {}, !a.students ? h('span', { class: 'muted small', text: 'Ingen elever endnu' })
          : missing ? h('span', { class: 'badge' + (a.due && a.due <= now ? ' red' : ''), text: `${missing} mangler` }) : h('span', { class: 'badge green', text: 'Alle har afleveret' }),
          a.late ? h('div', { class: 'muted small', text: `${a.late} efter fristen` }) : null));
    };
    const table = (rows, empty) => h('div', { class: 't-scroll' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['Aflevering', 'Frist', 'Afleveret', 'Flueben', 'Status'].map(x => h('th', { text: x })))),
      h('tbody', {}, ...(rows.length ? rows.map(row) : [h('tr', {}, h('td', { colspan: 5, class: 'muted', text: empty }))]))));
    page(me, 'afleveringer',
      h('div', { class: 'page-head' }, h('div', { class: 'stack tight' }, h('h1', { text: 'Afleveringer' }),
        h('p', { class: 'muted', text: 'Alle afleveringer i dine klasser. Klik på en aflevering for at se eleverne og hente deres filer. Nye afleveringer oprettes inde i klassen.' }))),
      h('section', { class: 'card' }, h('h2', { text: 'Åbne' }), table(open, 'Ingen åbne afleveringer. Opret en inde i en klasse under "Afleveringer".')),
      past.length ? h('section', { class: 'card' }, h('h2', { text: 'Fristen er overskredet' }), table(past.reverse(), '')) : null);
  };

  /* ---------------- HolyMoly-administration (kun PLATFORM_ADMINS) ---------------- */
  HM.pages.admin = async function admin() {
    const seq = HM.seq();
    let me, d;
    try { me = await api('/api/me'); if (me.needs) return HM.pages.setup(me); d = await api('/api/admin/overview'); } catch (e) { if (!HM.isStale(seq)) { toast(e.message); route('/'); } return; }
    if (HM.isStale(seq)) return;
    const reload = () => HM.pages.admin();
    const st = d.stats;
    const tile = (n, label) => h('div', { class: 'tile' }, h('div', { class: 'tile-n', text: String(n) }), h('div', { class: 'muted small', text: label }));
    const stateBadge = (L) => h('span', { class: 'badge ' + { trial: '', active: 'green', expired: 'red' }[L.state], text: { trial: 'Prøve', active: 'Licens', expired: 'Udløbet' }[L.state] });

    const filter = input({ type: 'search', placeholder: 'Søg skole, e-mail eller CVR', 'aria-label': 'Søg' });
    const orderRows = d.orders.map(o => {
      const sel = h('select', { 'aria-label': 'Status' }, ...['ny', 'faktureret', 'betalt', 'annulleret'].map(x => h('option', { value: x, text: x, selected: o.status === x })));
      sel.addEventListener('change', async () => { try { await api('/api/admin/orders/' + o.id, { method: 'PATCH', body: { status: sel.value } }); toast('Status gemt'); } catch (e) { toast(e.message); } });
      const act = h('button', { class: 'btn small primary', text: 'Aktivér licens', title: `Licens til ${o.students} elever i ${o.years} år fra i dag (eller fra nuværende udløb)` });
      act.addEventListener('click', async () => {
        const ok = await dialog({ title: `Aktivér licens for ${o.school}?`, body: h('p', { text: `${o.students} elevpladser i ${o.years === 1 ? '1 år' : o.years + ' år'}. Skolens administratorer får besked på mail.` }), actions: [{ label: 'Annuller' }, { label: 'Aktivér', kind: 'primary', value: true }] });
        if (!ok) return;
        try { await api('/api/admin/orders/' + o.id, { method: 'PATCH', body: { activate: true, status: o.status === 'ny' ? 'faktureret' : o.status } }); toast('Licensen er aktiveret'); reload(); } catch (e) { toast(e.message); }
      });
      return h('tr', { dataset: { q: [o.school, o.institution, o.cvr, o.ean, o.invoiceEmail, o.orderedBy].join(' ').toLowerCase() } },
        h('td', { class: 'num', text: '#' + o.id }), h('td', { text: fmtDate(o.created) }),
        h('td', {}, h('b', { text: o.institution || o.school }), h('div', { class: 'muted small', text: `CVR ${o.cvr}${o.reference ? ' · ref. ' + o.reference : ''}` })),
        h('td', { class: 'num', text: String(o.students) }), h('td', { class: 'num', text: o.years + ' år' }), h('td', { class: 'num', text: kr(o.amount) }),
        h('td', {}, h('div', { text: o.ean ? 'EAN ' + o.ean : o.invoiceEmail }), h('div', { class: 'muted small', text: o.orderedBy })),
        h('td', {}, sel), h('td', {}, act));
    });
    const schoolRows = d.schools.map(s => {
      const edit = h('button', { class: 'btn small', text: 'Ret' });
      edit.addEventListener('click', async () => {
        const lu = input({ type: 'date', value: isoDate(s.license.licenseUntil) });
        const te = input({ type: 'date', value: isoDate(s.license.trialEnds) });
        const seats = input({ type: 'number', min: 0, value: s.license.seats });
        const note = h('textarea', { rows: 2, maxlength: 1000 }); note.value = s.note;
        const inst = input({ value: s.instNr || '', maxlength: 20, placeholder: 'Fx 751002' });
        const ok = await dialog({ title: s.name, body: [h('div', { class: 'grid2' }, field('Licens til og med', lu, 'Tom = ingen licens'), field('Elevpladser', seats, '0 = ubegrænset'), field('Prøveperiode til', te), field('Unilogin-institutionsnummer', inst)), field('Note (kun for HolyMoly)', note)],
          actions: [{ label: 'Annuller' }, { label: 'Gem', kind: 'primary', submit: true, run: () => api('/api/admin/schools/' + s.id, { method: 'PATCH', body: { licenseUntil: lu.value ? Date.parse(lu.value + 'T23:59:59') : null, trialEnds: Date.parse((te.value || isoDate(Date.now())) + 'T23:59:59'), seats: Number(seats.value), note: note.value, instNr: inst.value.trim() || null } }) }] });
        if (ok) reload();
      });
      return h('tr', { dataset: { q: [s.name, s.admins, s.note].join(' ').toLowerCase() } },
        h('td', {}, h('b', { text: s.name }), h('div', { class: 'muted small', text: s.admins }), s.note ? h('div', { class: 'small', text: s.note }) : null),
        h('td', { text: fmtDate(s.created) }), h('td', { class: 'num', text: String(s.teachers) }),
        h('td', { class: 'num', text: s.license.seats ? `${s.license.used}/${s.license.seats}` : String(s.license.used) }),
        h('td', {}, stateBadge(s.license)), h('td', { text: fmtDate(s.license.until) }), h('td', {}, edit));
    });
    const table = (heads, rows, empty) => h('div', { class: 't-scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...heads.map(x => h('th', { text: x })))),
      h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: heads.length, class: 'muted', text: empty }))]))));
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const tr of document.querySelectorAll('tr[data-q]')) tr.hidden = !!q && !tr.dataset.q.includes(q);
    });
    page(me, 'admin',
      h('div', { class: 'page-head' }, h('h1', { text: 'Administration' }), filter),
      h('div', { class: 'tiles wide' }, tile(st.schools, 'skoler'), tile(st.trial, 'i prøveperiode'), tile(st.active, 'med licens'), tile(st.teachers, 'lærere'), tile(st.students, 'elever'), tile(kr(st.revenue), 'betalt i alt')),
      h('section', { class: 'card' }, h('h2', { text: 'Bestillinger' }), table(['#', 'Dato', 'Skole', 'Elever', 'År', 'Beløb', 'Faktura', 'Status', ''], orderRows, 'Ingen bestillinger endnu')),
      h('section', { class: 'card' }, h('h2', { text: 'Skoler' }), table(['Skole', 'Oprettet', 'Lærere', 'Elever', 'Status', 'Udløber', ''], schoolRows, 'Ingen skoler endnu')));
  };

  Object.assign(HM, { topbar, licenseBanner, pendingTeachersBanner, gettingStarted, afterLogin });
})();
