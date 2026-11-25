/* HolyMoly – lærer-dashboard. Ingen build-step, ingen eksterne afhængigheder.
 * Al data fra elever indsættes som tekst (textContent), aldrig som HTML. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM er tilladt af vores CSP, style-attributter er ikke
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected') el[k] = !!v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const app = $('#app');
  const tpl = (id) => document.getElementById(id).content.cloneNode(true);
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* */ }
    if (res.status === 401 && !opts.noRedirect) { route('/login'); throw new Error('Ikke logget ind'); }
    // Kontoen er ikke sat op (e-mail, to-faktor eller skole): forsiden viser, hvad der mangler
    if (res.status === 403 && data && data.needs && !opts.noRedirect) { route('/', true); throw new Error(data.error); }
    if (!res.ok) throw new Error((data && data.error) || ('Fejl ' + res.status));
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return alert(msg);
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* ---------------- dialog ---------------- */
  function dialog({ title, body, actions }) {
    const dlg = $('#dlg');
    $('#dlg-title').textContent = title;
    const b = $('#dlg-body');
    b.replaceChildren(...(Array.isArray(body) ? body : [body]).filter(Boolean));
    const err = $('#dlg-error');
    err.hidden = true;
    const acts = $('#dlg-actions');
    acts.replaceChildren();
    return new Promise((resolve) => {
      for (const a of actions.filter(Boolean)) {
        const btn = h('button', { type: a.submit ? 'submit' : 'button', class: 'btn ' + (a.kind || ''), text: a.label });
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          if (!a.run) { dlg.close(); resolve(a.value); return; }
          btn.disabled = true;
          try {
            const v = await a.run();
            if (v !== false) { dlg.close(); resolve(v); }
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          } finally { btn.disabled = false; }
        });
        acts.append(btn);
      }
      dlg.onclose = () => resolve(undefined);
      dlg.showModal();
      const first = b.querySelector('input, textarea, select');
      if (first) first.focus();
    });
  }

  /* ---------------- tema, intro og info-knap ---------------- */
  let downloadUrl = '';
  let uniLoginOn = false;
  let introShown = false;
  const currentTheme = () => (document.documentElement.getAttribute('data-hm-theme') === 'dark' ? 'dark' : 'light');
  function setTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-hm-theme', 'dark');
    else document.documentElement.removeAttribute('data-hm-theme');
    try { localStorage.setItem('hm-theme', t); } catch (e) { /* privat vindue: gælder kun nu */ }
  }

  // "Sådan kommer eleverne i gang" + farvernes betydning (samme indhold i intro og info-knap)
  function guideNode() {
    const frag = tpl('tpl-guide');
    for (const a of frag.querySelectorAll('.dl-link')) {
      if (downloadUrl) a.href = downloadUrl;
      else a.replaceWith(document.createTextNode('link'));
    }
    return frag;
  }

  // Første gang: velkomst med vejledningen. Derefter findes den under i-knappen.
  function maybeIntro() {
    let seen = false;
    try { seen = localStorage.getItem('hm-intro-seen') === '1'; } catch (e) { /* */ }
    if (seen || introShown) return;
    introShown = true;
    dialog({
      title: 'Velkommen til HolyMoly',
      body: [guideNode(), h('p', { class: 'muted small guide-note', text: 'Du kan altid læse det her igen under i-knappen øverst til højre.' })],
      actions: [{ label: 'Kom i gang', kind: 'primary', value: true }],
    }).then(() => { try { localStorage.setItem('hm-intro-seen', '1'); } catch (e) { /* */ } });
  }

  // i-knappen: vejledning og farver lige under knappen. Returnerer oprydning.
  function setupInfo() {
    const btn = $('#info-btn'), pop = $('#info-pop');
    if (!btn || !pop) return () => {};
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pop.hidden) return close();
      pop.replaceChildren(guideNode());
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }

  function showPrefs() {
    const seg = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Udseende' });
    const pick = (val) => {
      setTheme(val);
      for (const b of seg.children) { const on = b.dataset.val === val; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    };
    for (const [val, label] of [['light', 'Lys'], ['dark', 'Mørk']]) {
      const on = currentTheme() === val;
      seg.append(h('button', { type: 'button', role: 'radio', class: on ? 'on' : '', 'aria-checked': String(on), dataset: { val }, text: label, onclick: () => pick(val) }));
    }
    return dialog({
      title: 'Indstillinger',
      body: [h('div', {}, h('b', { text: 'Udseende' }), seg), h('p', { class: 'muted small', text: 'Gemmes i denne browser.' }),
        uniLoginOn ? h('div', { class: 'stack' }, h('b', { text: 'UNI-Login' }), h('a', { class: 'btn uni-btn', href: '/api/auth/unilogin/start?role=teacher&link=1', text: 'Tilknyt UNI-Login til din konto' }), h('p', { class: 'muted small', text: 'Så kan du logge ind med UNI-Login i stedet for e-mail og adgangskode.' })) : null],
      actions: [{ label: 'Luk', kind: 'primary', value: true }],
    });
  }

  /* ---------------- router ---------------- */
  // Konto, skole og administration ligger i account.js (registreres i HM.pages)
  const PAGE_ROUTES = { '/afleveringer': 'assignments', '/opret': 'signup', '/glemt': 'forgot', '/nulstil': 'reset', '/bekraeft': 'verify', '/konto': 'account', '/skole': 'school', '/admin': 'admin' };
  let cleanup = null;
  function route(path, replace) {
    if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState']({}, '', path);
    render();
  }
  window.addEventListener('popstate', render);

  let renderSeq = 0;
  const stale = (seq) => seq !== renderSeq;
  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    renderSeq++;
    const p = location.pathname;
    let m;
    if (p === '/login') return renderAuth();
    if (p === '/elev') return renderStudent();
    const page = PAGE_ROUTES[p];
    if (page && HM.pages[page]) return HM.pages[page]();
    if ((m = p.match(/^\/klasse\/(\d+)$/))) return renderRoom(Number(m[1]));
    return renderClasses();
  }

  /* ---------------- login ---------------- */
  // Vælg Lærer eller Elev. Unilogin (STIL's loginvælger: Unilogin, MitID eller skolens eget login) eller e-mail + to-faktor.
  function renderAuth() {
    app.replaceChildren(tpl('tpl-auth'));
    const form = $('#auth-form');
    const err = $('#auth-error');
    const showErr = (msg) => { err.textContent = msg; err.hidden = !msg; };
    // Fejl fra Unilogin: teksten kommer fra serveren i en kortlivet cookie – aldrig fra adressen (så ingen kan
    // sende et ægte link med sin egen tekst på login-siden)
    if (new URLSearchParams(location.search).has('fejl')) {
      let msg = 'Login mislykkedes. Prøv igen.';
      const m = /(?:^|;\s*)hm_loginmsg=([^;]*)/.exec(document.cookie);
      if (m) {
        try { msg = decodeURIComponent(m[1]) || msg; } catch (e) { /* ugyldig kodning: brug standardteksten */ }
        document.cookie = 'hm_loginmsg=; Path=/login; Max-Age=0; SameSite=Lax';
      }
      showErr(msg.slice(0, 300));
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* */ }
    }

    const setRole = (r) => {
      $$('.role-seg button').forEach(b => { const on = b.dataset.role === r; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      $$('[data-only-role]').forEach(el => { el.hidden = el.dataset.onlyRole !== r; });
      try { localStorage.setItem('hm-login-role', r); } catch (e) { /* */ }
    };
    let saved = 'teacher';
    try { saved = localStorage.getItem('hm-login-role') === 'student' ? 'student' : 'teacher'; } catch (e) { /* */ }
    $$('.role-seg button').forEach(b => b.addEventListener('click', () => { showErr(''); setRole(b.dataset.role); }));
    setRole(saved);

    api('/api/info', { noRedirect: true }).then((info) => {
      // Enkel tilstand: brugernavn i stedet for e-mail, intet Unilogin og ingen "glemt adgangskode" (ingen mails)
      if (info.simple) {
        $('#login-id-label').textContent = 'Brugernavn';
        const f = $('#auth-form').email; f.type = 'text'; f.maxLength = 40; f.setAttribute('autocapitalize', 'none'); f.spellcheck = false;
        $('#forgot-link').hidden = true;
      }
      // Unilogin vises altid (undtagen i enkel tilstand). Er det ikke sat op endnu, forklarer knappen hvorfor i stedet for at gå i stykker.
      if (!info.simple || info.uniLogin) for (const id of ['uni-teacher', 'uni-teacher-help', 'uni-or', 'uni-student', 'uni-student-help']) $('#' + id).hidden = false;
      if (!info.uniLogin) {
        for (const id of ['uni-teacher', 'uni-student']) {
          const el = $('#' + id);
          el.removeAttribute('href');
          el.setAttribute('aria-disabled', 'true');
          el.classList.add('off');
          el.addEventListener('click', () => showErr('Unilogin er ikke slået til på denne server endnu (HolyMoly skal tilsluttes hos STIL). Indtil da: lærere logger ind med e-mail, og elever bruger klassekoden i appen.'));
        }
      }
      if (!info.signupOpen && !info.signupRequiresCode) $('#signup-foot').hidden = true;
      else if (info.licensing) $('#signup-foot').replaceChildren('Er skolen ikke med endnu? ', h('a', { href: '/opret', 'data-nav': '', text: 'Start skolens prøveperiode' }));
    }).catch(() => {});

    let ticket = null, backup = false;
    const mfa = $('#mfa-step');
    const showMfa = (on) => {
      $('#login-step').hidden = on; mfa.hidden = !on; $('#signup-foot').hidden = on;
      $('.role-seg').hidden = on;
      if (on) { mfa.code.value = ''; mfa.code.focus(); }
    };
    $('#mfa-back').addEventListener('click', () => { ticket = null; showErr(''); showMfa(false); });
    $('#mfa-backup').addEventListener('click', () => {
      backup = !backup;
      $('#mfa-help').textContent = backup ? 'Skriv en af dine reservekoder (fx K7QF2-M2XP9). Hver kode virker én gang.' : 'Skriv den 6-cifrede kode fra din godkendelses-app.';
      $('#mfa-backup').textContent = backup ? 'Brug godkendelses-appen' : 'Brug en reservekode';
      mfa.code.inputMode = backup ? 'text' : 'numeric';
      mfa.code.focus();
    });
    const done = () => HM.afterLogin();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showErr('');
      const data = Object.fromEntries(new FormData(form));
      $('#auth-submit').disabled = true;
      try {
        const r = await api('/api/login', { method: 'POST', body: data, noRedirect: true });
        if (r.mfa) { ticket = r.ticket; showMfa(true); return; }
        done();
      } catch (ex) { showErr(ex.message); } finally { $('#auth-submit').disabled = false; }
    });
    mfa.addEventListener('submit', async (e) => {
      e.preventDefault();
      showErr('');
      $('#mfa-submit').disabled = true;
      try {
        const r = await api('/api/login/2fa', { method: 'POST', body: { ticket, code: mfa.code.value }, noRedirect: true });
        if (r.backupLeft != null && r.backupLeft <= 3) toast(`Du har ${r.backupLeft} reservekoder tilbage – lav nye under Konto`);
        done();
      } catch (ex) {
        showErr(ex.message);
        if (/start forfra|udløbet/.test(ex.message)) showMfa(false);
        else mfa.code.select();
      } finally { $('#mfa-submit').disabled = false; }
    });
  }

  /* ---------------- elev (UNI-Login på hjemmesiden) ---------------- */
  async function renderStudent() {
    let me;
    try { me = await api('/api/student/me', { noRedirect: true }); } catch (e) { route('/login', true); return; }
    app.replaceChildren(tpl('tpl-student'));
    $('#st-name').textContent = me.name;
    const ul = $('#st-classes');
    ul.replaceChildren(...(me.classes.length
      ? me.classes.map(c => h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title', text: c.name }), h('div', { class: 'url', text: 'Lærer: ' + c.teacher }))))
      : [h('li', { class: 'muted', text: 'Du er ikke tilmeldt en klasse endnu. Skriv klassekoden fra din lærer i HolyMoly-appen.' })]));
    // Afleveringer: det der mangler først, så det afleverede
    const asg = me.assignments || [];
    $('#st-asg-wrap').hidden = !asg.length;
    $('#st-asg').replaceChildren(...asg.map((a) => {
      const sub = a.submission;
      const late = !sub && a.due && Date.now() > a.due;
      const status = sub
        ? (sub.certId ? h('span', { class: 'badge green', text: HMDoc.label(sub.place) }) : h('span', { class: 'muted small', text: 'Afleveret (uden bevis)' }))
        : h('span', { class: 'badge' + (late ? ' red' : ''), text: late ? 'Fristen er overskredet' : 'Mangler' });
      const meta = [a.className, a.due ? 'Frist ' + fmtDateTime(a.due) : 'Ingen frist', a.home ? 'må skrives hjemme' : 'skrives i timen'].filter(Boolean).join(' · ');
      return h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title', text: a.title }), h('div', { class: 'url', text: meta }),
          sub ? h('div', { class: 'url', text: `Afleveret ${fmtDateTime(sub.submitted)}: "${sub.title || 'Uden titel'}"${sub.late ? ' (efter fristen)' : ''}` }) : null),
        status,
        sub && sub.certId ? h('a', { class: 'btn small ghost', href: '/bevis/' + sub.certId, target: '_blank', rel: 'noopener', text: 'Se tjek-siden' }) : null);
    }));
    if (me.downloadUrl) $('#st-dl').href = me.downloadUrl;
    else $('#st-dl').replaceWith(document.createTextNode('Hent HolyMoly-appen (link fra IT-ansvarlig)'));
    $('#st-logout').addEventListener('click', async () => { await api('/api/student/logout', { method: 'POST', body: {} }); route('/login'); });
  }

  /* ---------------- klasser ---------------- */
  async function renderClasses() {
    const seq = renderSeq;
    let me;
    try { me = await api('/api/me'); } catch (e) { return; }
    if (stale(seq)) return;
    if (me.needs) return HM.pages.setup(me);
    app.replaceChildren(HM.topbar(me, 'klasser'), tpl('tpl-classes'));
    const banner = HM.licenseBanner(me);
    if (banner) $('.page').prepend(banner);
    const waiting = HM.pendingTeachersBanner(me);
    if (waiting) $('.page').prepend(waiting);
    cleanup = setupInfo();
    api('/api/info').then(info => { downloadUrl = info.downloadUrl || ''; uniLoginOn = !!info.uniLogin; maybeIntro(); }).catch(() => {});
    const list = $('#class-list');
    const load = async () => {
      const classes = await api('/api/classes');
      list.replaceChildren(...classes.map(c => h('button', { class: 'class-card', onclick: () => route('/klasse/' + c.id) },
        h('h3', { text: c.name }),
        h('div', { class: 'muted small', text: c.count + (c.count === 1 ? ' elev' : ' elever') }),
        c.nextAssignment ? h('div', { class: 'card-asg' },
          h('div', { class: 'small', text: 'Næste aflevering: ' + c.nextAssignment.title }),
          h('div', { class: 'muted small', text: (c.nextAssignment.due ? 'Frist ' + fmtDateTime(c.nextAssignment.due) + ' · ' : '') + `${c.nextAssignment.handed}/${c.count} afleveret` })) : null,
        c.lesson.live ? h('div', { class: 'pill live', style: 'display:inline-block;margin-top:8px', text: 'Lektion i gang' }) : null,
      )));
      if (!classes.length) list.append(HM.gettingStarted());
    };
    $('#new-class').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      const r = await api('/api/classes', { method: 'POST', body: { name } });
      route('/klasse/' + r.id);
    });
    load();
  }

  /* ---------------- klasseværelse ---------------- */
  async function renderRoom(classId) {
    const seq = renderSeq;
    let cls, info;
    try {
      [cls, info] = await Promise.all([api('/api/classes/' + classId), api('/api/info')]);
    } catch (e) {
      if (stale(seq)) return;
      if (e.message !== 'Ikke logget ind') { toast(e.message); route('/'); }
      return;
    }
    if (stale(seq)) return; // brugeren er gået videre, mens klassen blev hentet
    app.replaceChildren(tpl('tpl-room'));
    downloadUrl = info.downloadUrl || ''; uniLoginOn = !!info.uniLogin;
    const cleanupInfo = setupInfo();
    const state = {
      cls, info, students: new Map(), views: new Map(), lesson: cls.lesson,
      editing: false, open: null, tab: 'now', detail: null, liveUrl: null, ws: null, closed: false,
      events: [], lessonTimer: null,
    };
    // Kun elever der har tilmeldt sig, står i klasseværelset
    for (const s of cls.students) if (s.joined) state.students.set(s.id, s);
    // Beta: uden skolens ja kan lektioner ikke startes (knappen er slået fra, og banneret siger hvorfor)
    if (info.lessonBlocked) {
      const why = info.lessonBlockedReason === 'operator'
        ? 'Lektioner kan ikke startes endnu – serveren drives ikke af skolen, og der er ingen databehandleraftale. Eleverne kan godt tilmelde sig.'
        : 'Lektioner kan ikke startes endnu – skolen har ikke givet sit ja. Eleverne kan godt tilmelde sig.';
      $('.room-wrap').prepend(h('div', { class: 'banner warn', role: 'status', id: 'approval-banner', style: 'margin-bottom:12px' },
        h('span', { text: why })));
      if (!(cls.lesson && cls.lesson.live)) { $('#lesson-btn').disabled = true; $('#lesson-btn').title = 'Venter på skolens ja'; }
    }

    // Skrivetime, ekstra tid og funktioner, der er slået fra (room-write.js)
    const rw = window.HM.room && window.HM.room.write ? window.HM.room.write({ state, classId, h, $, api, dialog, toast, updateLessonUi: () => updateLessonUi() }) : null;

    $('#class-name').textContent = cls.name;
    $('#back').addEventListener('click', () => route('/'));

    // Menu
    const menu = $('#menu');
    $('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $('#menu-btn').setAttribute('aria-expanded', String(!menu.hidden)); });
    const closeMenu = () => { menu.hidden = true; };
    document.addEventListener('click', closeMenu);
    menu.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      closeMenu();
      ({ help: () => { location.href = '/hjaelp.html'; }, prefs: showPrefs, edit: () => setEditing(true), auto: autoLayout, joincode: showJoinCode, report: () => showReport(), assignments: () => showAssignments(), links: () => showLinks(), settings: showSettings, rename: renameClass, delete: deleteClass })[act]();
    });
    $('#edit-done').addEventListener('click', () => setEditing(false));
    $('#join-btn').addEventListener('click', showJoinCode);
    updateJoinUi();

    $('#lesson-btn').addEventListener('click', toggleLesson);
    $('#freeze-all').addEventListener('click', freezeAll);
    // Gennemgang: alle skærme på standby med ur, dato og tid tilbage af lektionen
    $('#review-btn').addEventListener('click', () => {
      if (reviewing()) { send({ type: 'freeze', all: true, on: false }); return; }
      send({ type: 'freeze', all: true, on: true, mode: 'review', message: '' });
      toast('Gennemgang: alle skærme er på standby');
    });
    $('#unfreeze-all').addEventListener('click', () => send({ type: 'freeze', all: true, on: false }));
    $('#asg-btn').addEventListener('click', () => showAssignments());
    if (location.hash === '#afleveringer') { history.replaceState(null, '', location.pathname); setTimeout(() => showAssignments(), 0); }

    // Skuffe
    $('#d-close').addEventListener('click', closeDrawer);
    $$('.tabs button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTab(); }));
    $('#d-freeze').addEventListener('click', () => {
      const v = state.views.get(state.open);
      if (!v) return;
      if (v.frozen) send({ type: 'freeze', studentIds: [state.open], on: false });
      else freezeOne(state.open);
    });
    $('#d-hand').addEventListener('click', () => { if (state.open != null) send({ type: 'hand', studentId: state.open, up: false }); });
    $('#d-shot').addEventListener('click', () => {
      if (isHome(state.open)) return toast(HOME_MSG);
      send({ type: 'screenshot', studentId: state.open });
      toast('Tager skærmbillede…');
    });
    $('#d-fullscreen').addEventListener('click', () => { const sc = $('.screen'); if (document.fullscreenElement) document.exitFullscreen(); else sc.requestFullscreen().catch(() => {}); });
    $('#d-screen-sel').addEventListener('change', (e) => { if (!isHome(state.open)) send({ type: rw ? rw.watchType() : 'watch', studentId: state.open, screen: Number(e.target.value) }); });
    const onKey = (e) => { if (e.key === 'Escape' && state.open && !$('#dlg').open) closeDrawer(); };
    document.addEventListener('keydown', onKey);

    /* ---- websocket ---- */
    let backoff = 500;
    function connect() {
      if (state.closed) return;
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/teacher?classId=' + classId);
      ws.binaryType = 'arraybuffer';
      state.ws = ws;
      ws.onopen = () => {
        backoff = 500;
        setConn(true);
        state.watching = null;
        if (state.open) watchOpen(Number($('#d-screen-sel').value) || 0);
      };
      ws.onmessage = (e) => (typeof e.data === 'string' ? onMessage(JSON.parse(e.data)) : onBinary(e.data));
      ws.onclose = (e) => {
        setConn(false);
        if (state.closed) return;
        // 4401: login-sessionen er slut (logget ud, ny adgangskode eller udløbet). Ingen genforbindelse.
        if (e && e.code === 4401) {
          state.closed = true;
          dialog({ title: 'Du er logget ud', body: h('p', { text: 'Du er logget ud. Log ind igen.' }), actions: [{ label: 'Log ind', kind: 'primary', value: true }] })
            .then(() => route('/login'));
          return;
        }
        setTimeout(connect, backoff);
        backoff = Math.min(10_000, backoff * 2);
      };
    }
    function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }
    function setConn(ok) {
      const pill = $('#lesson-pill');
      if (!ok) { pill.textContent = 'Forbinder…'; pill.className = 'pill'; } else updateLessonUi();
    }

    function onMessage(m) {
      switch (m.type) {
        case 'snapshot':
          state.lesson = m.lesson;
          state.views = new Map(m.students.map(s => [s.studentId, s]));
          // Elever kan være tilføjet/fjernet
          refreshClass().then(() => { drawDesks(); updateLessonUi(); });
          break;
        case 'student':
          state.views.set(m.student.studentId, m.student);
          updateDesk(m.student.studentId);
          updateCounts();
          if (state.open === m.student.studentId) updateDrawerHead();
          break;
        case 'lesson':
          state.lesson = m.lesson;
          updateLessonUi();
          break;
        case 'detail':
          if (m.studentId === state.open && !isHome(m.studentId)) { state.detail = m.detail; if (state.tab === 'now' || state.tab === 'apps') renderTab(); }
          break;
        case 'event':
          if (m.studentId === state.open) {
            if (m.event.kind === 'evidence' && /læreren/.test(m.event.title || '')) {
              toast('Skærmbillede gemt under Hændelser');
              state.tab = 'alerts';
            }
            if (state.tab === 'alerts' || state.tab === 'now') renderTab();
          }
          break;
        case 'assignments':
          if (state.asgRefresh) state.asgRefresh();
          break;
        case 'docs':
          // Opdatér listen – men smid ikke læreren ud af et dokument, der er åbent
          if (m.studentId === state.open && state.tab === 'docs' && !state.docOpen) renderTab();
          break;
        case 'error':
          toast(m.message);
          break;
      }
    }

    function onBinary(buf) {
      const dv = new DataView(buf);
      if (dv.getUint8(0) !== 1) return;
      const hl = dv.getUint32(1);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 5, hl)));
      const blob = new Blob([new Uint8Array(buf, 5 + hl)], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      if (header.kind === 'live') {
        if (header.studentId !== state.open || isHome(header.studentId)) { URL.revokeObjectURL(url); return; }
        const img = $('#d-screen');
        const prev = state.liveUrl;
        img.onload = () => { if (prev) URL.revokeObjectURL(prev); };
        img.src = url;
        img.hidden = false;
        state.liveUrl = url;
        $('#d-screen-msg').hidden = true;
        updateScreenSelect(header.screens || 1, header.screen || 0);
        send({ type: 'frameAck', studentId: header.studentId });
      }
    }

    async function refreshClass() {
      const c = await api('/api/classes/' + classId);
      state.cls = c;
      state.students = new Map(c.students.filter(s => s.joined).map(s => [s.id, s]));
      updateJoinUi();
      $('#class-name').textContent = c.name;
    }

    /* ---- bordene ---- */
    // Bordstørrelse efter klassens størrelse, så bordene ikke overlapper
    function sizeDesks() {
      const room = $('#room');
      if (!room) return;
      const n = Math.max(1, state.students.size);
      const cols = Math.min(8, Math.max(Math.min(n, 4), Math.ceil(Math.sqrt(n * 1.8))));
      const rows = Math.ceil(n / cols);
      const W = room.clientWidth, H = room.clientHeight;
      const w = Math.max(104, Math.min(200, (0.88 * W) / cols - 16));
      room.style.setProperty('--desk-w', Math.round(w) + 'px');
    }
    window.addEventListener('resize', sizeDesks); // fjernes i cleanup

    function drawDesks() {
      const wrap = $('#desks');
      wrap.replaceChildren();
      sizeDesks();
      $('#room-empty').hidden = state.students.size > 0;
      for (const s of state.students.values()) {
        const d = h('button', { class: 'desk', dataset: { id: s.id }, type: 'button' },
          h('div', { class: 'row' }, h('i', { class: 'lamp grey' }), h('span', { class: 'name', text: s.name }), h('span', { class: 'hand-badge', title: 'Rakte hånden op', 'aria-label': 'Rakte hånden op', hidden: true }, '✋')),
          h('div', { class: 'act' }),
          h('div', { class: 'flag' }),
        );
        d.style.left = (s.x * 100) + '%';
        d.style.top = (s.y * 100) + '%';
        attachDrag(d, s);
        wrap.append(d);
        updateDesk(s.id);
      }
      updateCounts();
    }

    // En elev der har fået ny kode (ny computer), venter på at blive tilmeldt igen
    const notConnected = (s) => (s.enrolled ? 'Ikke forbundet' : (s.inviteCode ? 'Ny computer – kode: ' + s.inviteCode : 'Ikke forbundet'));

    function viewText(v, s) {
      if (state.editing) {
        if (s.enrolled) return { act: 'Tilmeldt' + (s.device && s.device.os ? ' · ' + s.device.os : ''), flag: '' };
        return { act: s.inviteCode ? 'Ny computer – kode: ' + s.inviteCode : 'Koden er udløbet', flag: '', code: true };
      }
      if (!v) return { act: notConnected(s), flag: '' };
      let act = v.activity || '';
      let flag = '';
      if (v.color === 'red' && v.violations.length) {
        act = v.violations[0].text;
        flag = v.activity && v.activity !== act ? v.activity : '';
      } else if (v.color === 'grey') {
        act = v.closed ? v.closed.reason + ' ' + fmtTime(v.closed.ts)
          : (v.online ? (v.greyReason || v.activity) : notConnected(s));
        flag = v.online && v.greyReason ? v.activity : '';
      }
      if (!flag && v.lastAttempt && Date.now() - v.lastAttempt.ts < 5 * 60_000) flag = 'Forsøgte: ' + v.lastAttempt.text;
      // Skriveøkt uden for timen
      if (v.solo) flag = 'Skriver hjemme: ' + v.solo;
      return { act, flag, home: !!v.solo };
    }

    function updateDesk(id) {
      const d = $(`.desk[data-id="${id}"]`);
      const s = state.students.get(id);
      if (!d || !s) return;
      const v = state.views.get(id);
      const color = v ? v.color : 'grey';
      d.querySelector('.lamp').className = 'lamp ' + color;
      d.classList.toggle('red', color === 'red' && !state.editing);
      d.classList.toggle('frozen', !!(v && v.frozen));
      // ✋ Eleven har rakt hånden op
      const hand = !!(v && v.hand && !state.editing);
      d.classList.toggle('hand', hand);
      d.querySelector('.hand-badge').hidden = !hand;
      d.classList.toggle('editing', state.editing);
      const t = viewText(v, s);
      const act = d.querySelector('.act');
      act.textContent = t.act;
      act.classList.toggle('code', !!t.code);
      d.querySelector('.flag').textContent = t.flag;
      d.classList.toggle('home', !!t.home && !state.editing);
      d.title = s.name + ' – ' + t.act + (t.flag ? '\n' + t.flag : '');
    }

    const reviewing = () => [...state.views.values()].some(v => v.review && v.frozen);
    function updateReviewBtn() {
      const b = $('#review-btn');
      if (!b) return;
      const on = reviewing();
      b.textContent = on ? 'Afslut gennemgang' : 'Gennemgang';
      b.classList.toggle('primary', on);
    }

    function updateCounts() {
      updateReviewBtn();
      const unf = $('#unfreeze-all');
      if (unf) unf.hidden = !([...state.views.values()].some(v => v.frozen && !v.review));
      let g = 0, r = 0, gr = 0, hands = 0;
      for (const s of state.students.values()) {
        const v = state.views.get(s.id);
        if (v && v.hand) hands++;
        const c = v ? v.color : 'grey';
        if (c === 'green') g++; else if (c === 'red') r++; else gr++;
      }
      const el = $('#counts');
      el.replaceChildren(...[
        h('span', {}, h('b', { text: g }), ' OK'),
        h('span', {}, h('b', { text: r, style: r ? 'color:var(--red)' : '' }), r === 1 ? ' rød' : ' røde'),
        h('span', {}, h('b', { text: gr }), ' grå'),
        hands ? h('span', { class: 'hands-count', title: 'Elever der har rakt hånden op' }, '✋ ', h('b', { text: hands })) : null,
      ].filter(Boolean));
      document.title = (hands ? '✋ ' : '') + (r ? `(${r}) ` : '') + state.cls.name + ' – HolyMoly';
    }

    function updateLessonUi() {
      if (state.open != null) updateDrawerHead();
      const pill = $('#lesson-pill');
      const btn = $('#lesson-btn');
      clearInterval(state.lessonTimer);
      if (state.lesson && state.lesson.live) {
        const tick = () => {
          const left = Math.max(0, state.lesson.endsAt - Date.now());
          pill.textContent = rw ? rw.pillText(state.lesson, Math.ceil(left / 60000)) : `Lektion · ${Math.ceil(left / 60000)} min tilbage`;
          pill.title = 'Lektionen slutter ' + fmtTime(state.lesson.endsAt);
        };
        tick();
        state.lessonTimer = setInterval(tick, 15_000);
        pill.className = 'pill live';
        btn.textContent = 'Afslut lektion';
        btn.className = 'btn';
        btn.disabled = false; // en lektion i gang kan altid afsluttes
        btn.removeAttribute('title');
        $('#toolbar-live').hidden = false;
      } else {
        pill.textContent = 'Ingen lektion';
        pill.title = 'Overvågningen er slukket, til du starter en lektion';
        pill.className = 'pill';
        btn.textContent = 'Start lektion';
        btn.className = 'btn primary';
        btn.disabled = !!state.info.lessonBlocked;
        if (state.info.lessonBlocked) btn.title = 'Venter på skolens ja'; else btn.removeAttribute('title');
        $('#toolbar-live').hidden = true;
      }
      if (rw) rw.updateUi();
    }

    async function toggleLesson() {
      if (state.lesson && state.lesson.live) {
        // Har nogle elever ekstra tid, vælger læreren, om de må skrive færdig
        const choice = rw && rw.hasExtra() ? await rw.stopDialog()
          : ((await dialog({ title: 'Afslut lektionen?', body: h('p', { text: 'Overvågning, blokering og frysning stopper for alle elever i klassen.' }), actions: [{ label: 'Annuller', value: false }, { label: 'Afslut lektion', kind: 'danger', value: true }] })) ? { all: false } : null);
        if (!choice) return;
        const r = await api(`/api/classes/${classId}/lesson`, { method: 'POST', body: { action: 'stop', all: choice.all } });
        state.lesson = r.lesson;
        updateLessonUi();
        showReport(); // overblik over timen, lige når den er slut
        return;
      }
      const sel = h('select', { name: 'minutes' }, ...[45, 60, 90, 120, 180, 240].map(m => h('option', { value: m, text: m + ' minutter', selected: m === (state.cls.config.lessonMinutes || 90) })));
      // Skrivetime: "Skal eleverne skrive en opgave?" (room-write.js)
      const write = rw ? await rw.startFields() : null;
      const shown = dialog({
        title: 'Start lektion',
        body: [h('p', { class: 'muted', text: 'Elever med appen åben bliver overvåget og blokeret indtil lektionen slutter. Lektionen stopper automatisk.' }), h('label', {}, 'Varighed', sel), ...(write ? write.nodes : [])],
        actions: [{ label: 'Annuller' }, { label: 'Start', kind: 'primary', submit: true, run: async () => {
          try { return await api(`/api/classes/${classId}/lesson`, { method: 'POST', body: Object.assign({ action: 'start', minutes: Number(sel.value) }, write ? write.payload() : {}) }); } catch (ex) {
            // Beta: serveren starter ingen lektioner, før skolens ja er udfyldt
            if (/skolens ja mangler/i.test(ex.message)) return { approval: ex.message };
            throw ex;
          }
        } }],
      });
      if (write) write.wire();
      const r = await shown;
      if (r && r.approval) {
        await dialog({
          title: 'Skolens ja mangler',
          body: [
            h('p', { text: 'Lektionen er ikke startet. HolyMoly er i beta, og skolen skal først sige ja.' }),
            h('p', { text: 'Den, der driver serveren, skal udfylde fire ting: hvem der er dataansvarlig, kontakt til skolens DPO, datoen for konsekvensanalysen (DPIA) og datoen for ledelsens ja.' }),
            h('p', { class: 'muted small', text: 'Eleverne kan godt tilmelde sig imens.' }),
          ],
          actions: [{ label: 'OK', kind: 'primary', value: true }],
        });
        return;
      }
      if (r) { state.lesson = r.lesson; updateLessonUi(); }
    }

    async function freezeAll() {
      const msg = h('input', { maxlength: 200, placeholder: 'Fx "Kig op på tavlen"' });
      const ok = await dialog({ title: 'Frys alle skærme?', body: [h('label', {}, 'Besked til eleverne (valgfri)', msg)], actions: [{ label: 'Annuller', value: false }, { label: 'Frys alle', kind: 'primary', submit: true, value: true }] });
      if (ok) send({ type: 'freeze', all: true, on: true, message: msg.value });
    }
    async function freezeOne(id) {
      const s = state.students.get(id);
      const msg = h('input', { maxlength: 200, placeholder: 'Valgfri besked' });
      const ok = await dialog({ title: 'Frys skærmen hos ' + s.name + '?', body: [h('label', {}, 'Besked (valgfri)', msg)], actions: [{ label: 'Annuller', value: false }, { label: 'Frys', kind: 'primary', submit: true, value: true }] });
      if (ok) send({ type: 'freeze', studentIds: [id], on: true, message: msg.value });
    }

    /* ---- redigering ---- */
    function setEditing(on) {
      state.editing = on;
      $('#editbar').hidden = !on;
      if (on) closeDrawer();
      for (const id of state.students.keys()) updateDesk(id);
    }

    function attachDrag(el, s) {
      let start = null;
      el.addEventListener('pointerdown', (e) => {
        if (!state.editing) return;
        const room = $('#room').getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, room, moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 4) start.moved = true;
        if (!start.moved) return;
        el.classList.add('dragging');
        const x = Math.min(0.97, Math.max(0.03, (e.clientX - start.room.left) / start.room.width));
        const y = Math.min(0.96, Math.max(0.16, (e.clientY - start.room.top) / start.room.height));
        s.x = x; s.y = y;
        el.style.left = (x * 100) + '%';
        el.style.top = (y * 100) + '%';
      });
      el.addEventListener('pointerup', () => {
        if (!start) return;
        const moved = start.moved;
        start = null;
        el.classList.remove('dragging');
        if (moved) {
          el.dataset.justDragged = '1';
          setTimeout(() => { delete el.dataset.justDragged; }, 50);
          api(`/api/classes/${classId}/layout`, { method: 'PUT', body: { positions: [{ id: s.id, x: s.x, y: s.y }] } }).catch(e => toast(e.message));
        }
      });
      el.addEventListener('click', () => {
        if (el.dataset.justDragged) return;
        if (state.editing) editStudent(s.id); else openDrawer(s.id);
      });
    }

    async function autoLayout() {
      await api(`/api/classes/${classId}/layout/auto`, { method: 'POST', body: {} });
      await refreshClass();
      drawDesks();
    }

    /* ---- lektionens links (eleverne åbner dem med ét klik i appen) ---- */
    async function showLinks() {
      let links = (state.cls.config.links || []).map(l => ({ title: l.title, url: l.url }));
      const list = h('ul', { class: 'list' });
      const warn = h('div', {});
      const title = h('input', { placeholder: 'Fx Opgave 3 – Romantikken', maxlength: 80 });
      const url = h('input', { placeholder: 'https://…', type: 'url', maxlength: 2000 });
      const render = () => list.replaceChildren(...(links.length ? links.map((l, i) => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title', text: l.title || l.url }), h('div', { class: 'url', text: l.url })),
        h('button', { class: 'btn small', type: 'button', text: 'Fjern', onclick: () => { links.splice(i, 1); render(); save().catch(e => toast(e.message)); } })))
        : [h('li', { class: 'muted', text: 'Ingen links endnu.' })]));
      const save = async () => {
        const r = await api('/api/classes/' + classId, { method: 'PATCH', body: { config: { links } } });
        state.cls.config = r.config;
        links = r.config.links.map(l => ({ title: l.title, url: l.url }));
        render();
        // Er et link blokeret af reglerne? Så kan eleverne ikke åbne det – tilbyd at tillade siden
        warn.replaceChildren(...r.blockedLinks.map(b => h('div', { class: 'violation' }, `${b.host} er blokeret (${b.label}) – eleverne kan ikke åbne linket. `,
          h('button', { class: 'btn small', type: 'button', text: `Tillad ${b.host}`, onclick: async () => {
            const allowed = [...new Set([...(state.cls.config.allowed || []), b.host])];
            const r2 = await api('/api/classes/' + classId, { method: 'PATCH', body: { config: { allowed } } });
            state.cls.config = r2.config;
            toast(`${b.host} er nu tilladt i klassen`);
            await save();
          } }))));
        return r;
      };
      const add = async () => {
        let u = url.value.trim();
        if (!u) throw new Error('Skriv en adresse');
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        try { new URL(u); } catch (e) { throw new Error('Det er ikke en gyldig adresse'); }
        links.push({ title: title.value.trim(), url: u });
        await save();
        title.value = ''; url.value = '';
        title.focus();
        return false;
      };
      render();
      await save().catch(() => {});
      await dialog({
        title: 'Lektionens links – ' + state.cls.name,
        body: [
          h('p', { class: 'muted', text: 'Eleverne ser linksene i HolyMoly-appen, mens lektionen er i gang, og åbner dem med ét klik. Så skal du ikke sende dem ud i timen.' }),
          list, warn,
          h('div', { class: 'stack' }, h('label', {}, 'Titel', title), h('label', {}, 'Adresse', url)),
        ],
        actions: [{ label: 'Tilføj link', run: add }, { label: 'Færdig', kind: 'primary', value: true }],
      });
    }

    /* ---- lektionsrapport ---- */
    const minutes = (ms) => Math.round(ms / 60000);
    async function showReport(lessonId) {
      const ls = (await api(`/api/classes/${classId}/lessons`)).lessons;
      if (!ls.length) { toast('Der har ikke været nogen lektioner endnu'); return; }
      const sel = h('select', { 'aria-label': 'Lektion' }, ...ls.map(l => h('option', { value: l.id, text: fmtDateTime(l.started) + (l.live ? ' (i gang)' : '') })));
      const wrap = h('div', { class: 'report' });
      const csv = h('a', { class: 'btn small', text: 'Hent som regneark (CSV)' });
      async function load(id) {
        sel.value = String(id);
        csv.href = `/api/classes/${classId}/lessons/${id}.csv`;
        wrap.replaceChildren(h('p', { class: 'muted', text: 'Henter…' }));
        const rep = await api(`/api/classes/${classId}/lessons/${id}`);
        const tot = rep.students.reduce((a, s) => ({ red: a.red + (s.red > 0 ? 1 : 0), hands: a.hands + s.hands, cert: a.cert + s.certified, sub: a.sub + s.submitted }), { red: 0, hands: 0, cert: 0, sub: 0 });
        const summary = h('p', { class: 'small' }, `${rep.lesson.minutes} min. · ${rep.students.length} elever · `,
          h('b', { text: tot.red }), ' med rød lampe · ', h('b', { text: tot.hands }), ' gange hånd op · ', h('b', { text: tot.sub }), ' afleveringer (', h('b', { text: tot.cert }), ' med skrive-bevis)');
        const rows = rep.students.map(s => {
          const all = Math.max(1, s.green + s.red + s.grey);
          const seg = (cls, ms) => h('span', { class: 'seg-' + cls, style: `width:${(ms / all) * 100}%`, title: `${minutes(ms)} min.` });
          const notes = [];
          if (s.violations) notes.push(`${s.violations} fund`);
          if (s.attempts) notes.push(`${s.attempts} blokerede forsøg`);
          if (s.hands) notes.push(`✋ ${s.hands}`);
          if (s.submitted) notes.push(`${s.submitted} afleveret${s.certified ? ` (${s.certified} med bevis)` : ''}`);
          return h('tr', {},
            h('td', { class: 'r-name', text: s.name }),
            h('td', { class: 'r-bar' }, h('div', { class: 'timebar', 'aria-label': `Grøn ${minutes(s.green)} min., rød ${minutes(s.red)} min., grå ${minutes(s.grey)} min.` }, seg('green', s.green), seg('red', s.red), seg('grey', s.grey)),
              s.redReasons.length ? h('div', { class: 'r-why', text: s.redReasons.join(' · ') }) : null),
            h('td', { class: 'r-num', text: `${minutes(s.green)} / ${minutes(s.red)} / ${minutes(s.grey)}` }),
            h('td', { class: 'r-notes muted small', text: notes.join(' · ') || '–' }));
        });
        wrap.replaceChildren(summary, h('div', { class: 'r-scroll' }, h('table', { class: 'report-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Elev' }), h('th', { text: 'Lektionen (grøn / rød / grå)' }), h('th', { text: 'Min.' }), h('th', { text: 'Noter' }))),
          h('tbody', {}, ...rows))));
      }
      sel.addEventListener('change', () => load(sel.value).catch(e => toast(e.message)));
      await load(lessonId || ls[0].id);
      $('#dlg').classList.add('wide');
      await dialog({
        title: 'Lektionsrapport – ' + state.cls.name,
        body: [h('div', { class: 'row-actions' }, sel, csv), wrap, h('p', { class: 'muted small', text: 'Grå = ikke bekræftet, fx fordi appen var lukket. Tiden før en elev forbinder sig, tæller som grå.' })],
        actions: [{ label: 'Luk', kind: 'primary', value: true }],
      });
      $('#dlg').classList.remove('wide');
    }

    /* ---- afleveringer: læreren lægger en opgave ud, eleverne vedhæfter et dokument skrevet i HolyMoly ---- */
    const fmtDue = (ts) => new Date(ts).toLocaleString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const localInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    async function downloadWord(docId) {
      const d = await api('/api/docs/' + docId);
      // Mærket med det, der blev målt (observed) og "TESTSERVER" – samme tekst og farve som elevens egen Word-fil
      const mark = d.certId ? { code: 'HM-' + d.certId.slice(0, 8).toUpperCase(), url: `${location.origin}/bevis/${d.certId}`, place: d.place, observed: d.observed, test: d.test } : null;
      const blob = new Blob([HMDoc.toDocx(d.blocks, { title: d.title, mark, readOnly: true })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const a = h('a', { href: URL.createObjectURL(blob), download: (d.title || 'Dokument').replace(/[\\/:*?"<>|]/g, '') + '.docx' });
      document.body.append(a); a.click(); a.remove();
    }
    async function showAssignments() {
      const box = h('div', { class: 'asg' });
      let view = { kind: 'list' };
      function assignmentForm(a) {
        const title = h('input', { maxlength: 120, value: a ? a.title : '', placeholder: 'Fx Novelleanalyse – "Hvide sko"', required: true });
        const desc = h('textarea', { maxlength: 4000, rows: 5, placeholder: 'Opgaveformulering, krav og hjælpemidler' });
        desc.value = a ? a.description : '';
        const due = h('input', { type: 'datetime-local', value: a && a.due ? localInput(a.due) : '' });
        const home = h('input', { type: 'checkbox', checked: a ? !!a.home : false });
        const err = h('p', { class: 'error', hidden: true });
        const save = h('button', { class: 'btn primary', type: 'button', text: a ? 'Gem' : 'Opret aflevering' });
        const cancel = h('button', { class: 'btn', type: 'button', text: 'Tilbage', onclick: () => { view = a ? { kind: 'one', id: a.id } : { kind: 'list' }; render(); } });
        save.addEventListener('click', async () => {
          err.hidden = true;
          const body = { title: title.value, description: desc.value, due: due.value ? new Date(due.value).getTime() : null, home: home.checked };
          try {
            if (a) await api('/api/assignments/' + a.id, { method: 'PATCH', body });
            else { const r = await api(`/api/classes/${classId}/assignments`, { method: 'POST', body }); a = { id: r.id }; }
            toast('Afleveringen er gemt – eleverne kan se den i HolyMoly-appen');
            view = { kind: 'one', id: a.id }; render();
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        });
        box.replaceChildren(h('div', { class: 'stack' },
          h('label', {}, 'Titel', title), h('label', {}, 'Beskrivelse', desc), h('label', {}, 'Frist', due),
          h('label', { class: 'check' }, home, h('span', {}, h('b', { text: 'Må skrives hjemme' }), ' – eleven starter en skriveøkt i HolyMoly-appen. Computeren er beskyttet mod AI, mens der skrives, præcis som i timen.')), err,
          h('div', { class: 'row-actions start' }, save, cancel)));
        title.focus();
      }
      async function renderList() {
        const r = await api(`/api/classes/${classId}/assignments`);
        const add = h('button', { class: 'btn primary', type: 'button', text: 'Ny aflevering', onclick: () => { view = { kind: 'new' }; render(); } });
        const items = r.assignments.map(a => h('li', { class: 'clickable', onclick: () => { view = { kind: 'one', id: a.id }; render(); } },
          h('div', { class: 'main' }, h('div', { class: 'title', text: a.title }), h('div', { class: 'url', text: (a.due ? 'Frist ' + fmtDue(a.due) : 'Ingen frist') + (a.home ? ' · må skrives hjemme' : ' · skrives i timen') })),
          h('span', { class: 'badge', text: `${a.handed}/${r.students} afleveret` }),
          a.certified ? h('span', { class: 'badge green', text: `${a.certified} med bevis` }) : null));
        box.replaceChildren(h('div', { class: 'row-actions start' }, add),
          items.length ? h('ul', { class: 'list' }, ...items) : h('p', { class: 'muted', text: 'Ingen afleveringer endnu. Opret en, så kan eleverne se den i HolyMoly-appen og vedhæfte et dokument, de har skrevet i HolyMoly.' }));
      }
      async function renderOne(id) {
        const a = await api('/api/assignments/' + id);
        const back = h('button', { class: 'btn small', type: 'button', text: '← Alle afleveringer', onclick: () => { view = { kind: 'list' }; render(); } });
        const edit = h('button', { class: 'btn small', type: 'button', text: 'Rediger', onclick: () => { view = { kind: 'edit', a }; render(); } });
        const del = h('button', { class: 'btn small ghost', type: 'button', text: 'Slet', onclick: async () => {
          if (!confirmDel) { confirmDel = true; del.textContent = 'Klik igen for at slette'; return; }
          await api('/api/assignments/' + a.id, { method: 'DELETE', body: {} }); view = { kind: 'list' }; render();
        } });
        let confirmDel = false;
        const handed = a.students.filter(s => s.submission);
        const cert = handed.filter(s => s.submission.certId).length;
        const rows = a.students.map((s) => {
          const sub = s.submission;
          const status = !sub ? h('span', { class: 'muted', text: 'Ikke afleveret' })
            : h('div', {}, h('div', { text: sub.title || 'Uden titel' }), h('div', { class: 'muted small', text: fmtDateTime(sub.submitted) + (sub.place === 'hjemme' ? ' · skrevet hjemme' : sub.place === 'lektion og hjemme' ? ' · skrevet i timen og hjemme' : '') + (sub.late ? ' · efter fristen' : '') }));
          // Uden bevis er ikke en anklage: neutral grå tekst (årsagen står i elevens dokument under Dokumenter)
          // Fra en testserver: badge 'Testserver' i stedet for et grønt mærke. Uden vagt: gråt mærke med "kun skrivevinduet".
          const mark = !sub ? null : sub.certId ? (sub.test ? h('span', { class: 'badge', title: HMDoc.label(sub.place, { observed: sub.observed, test: true }), text: 'Testserver' })
            : h('span', { class: 'badge' + (HMDoc.markGreen({ observed: sub.observed }) ? ' green' : ''), text: HMDoc.label(sub.place, { observed: sub.observed }) }))
            : h('span', { class: 'muted small', title: (sub.reasons || []).join('; '), text: 'Uden bevis' });
          const acts = sub ? h('div', { class: 'row-actions start' },
            sub.docId ? h('button', { class: 'btn small', type: 'button', text: 'Skrivelog', 'aria-label': `Skrivelog for ${s.name}`, onclick: () => { view = { kind: 'log', id: a.id, docId: sub.docId, name: s.name, title: sub.title }; render(); } }) : null,
            h('button', { class: 'btn small', type: 'button', text: 'Hent Word', onclick: () => downloadWord(sub.docId).catch(e => toast(e.message)) }),
            sub.certId ? h('a', { class: 'btn small ghost', href: '/bevis/' + sub.certId, target: '_blank', rel: 'noopener', text: 'Tjek' }) : null) : null;
          return h('tr', {}, h('td', { class: 'r-name', text: s.name }), h('td', {}, status), h('td', {}, mark), h('td', {}, acts));
        });
        box.replaceChildren(
          h('div', { class: 'row-actions' }, back, h('div', { class: 'row-actions start' }, edit, del)),
          h('div', { class: 'asg-head' }, h('h3', { text: a.title }), h('div', { class: 'muted small', text: (a.due ? 'Frist ' + fmtDue(a.due) : 'Ingen frist') + (a.home ? ' · må skrives hjemme' : ' · skrives i timen') }),
            a.description ? h('p', { class: 'asg-desc', text: a.description }) : null),
          h('p', { class: 'small' }, h('b', { text: String(handed.length) }), ` af ${a.students.length} har afleveret · `, h('b', { text: String(cert) }), ' med mærket ', h('i', { text: HMDoc.label() })),
          h('p', { class: 'muted small', text: 'Manglende flueben er ikke bevis for snyd. En snydsag kræver altid, at eleven bliver hørt.' }),
          h('div', { class: 'r-scroll' }, h('table', { class: 'report-table' },
            h('thead', {}, h('tr', {}, h('th', { text: 'Elev' }), h('th', { text: 'Aflevering' }), h('th', { text: 'Bevis' }), h('th', { text: '' }))),
            h('tbody', {}, ...rows))));
      }
      // Skrivelogen for elevens vedhæftede aflevering, med afspilningen nedenunder ("Vis i afspilningen")
      async function renderLog(v) {
        const back = h('button', { class: 'btn small', type: 'button', text: '← Tilbage til afleveringen', onclick: () => { view = { kind: 'one', id: v.id }; render(); } });
        const logSec = h('div', { class: 'sec' });
        const replay = h('div', { class: 'sec' });
        box.replaceChildren(h('div', { class: 'row-actions' }, back),
          h('div', { class: 'asg-head' }, h('h3', { text: `${v.name}: "${v.title || 'Uden titel'}"` })), logSec, replay);
        await Promise.all([fillLog(v.docId, logSec, replay), fillReplay(v.docId, replay).catch(() => {})]);
      }
      async function render() {
        try {
          if (view.kind === 'list') await renderList();
          else if (view.kind === 'one') await renderOne(view.id);
          else if (view.kind === 'log') await renderLog(view);
          else assignmentForm(view.kind === 'edit' ? view.a : null);
        } catch (e) { box.replaceChildren(h('p', { class: 'error', text: e.message })); }
      }
      // Nye afleveringer fra eleverne vises med det samme (men læreren smides ikke ud af en formular)
      state.asgRefresh = () => { if (view.kind === 'list' || view.kind === 'one') render(); };
      await render();
      $('#dlg').classList.add('wide');
      await dialog({ title: 'Afleveringer – ' + state.cls.name, body: box, actions: [{ label: 'Luk', kind: 'primary', value: true }] });
      $('#dlg').classList.remove('wide');
      state.asgRefresh = null;
    }

    /* ---- klassekode ---- */
    function updateJoinUi() {
      const c = state.cls;
      if (!c || !$('#join-code')) return;
      $('#join-code').textContent = c.joinCode || '';
      $('#join-btn').classList.toggle('closed', !c.joinOpen);
      $('#join-btn').title = c.joinOpen ? 'Eleverne skriver klassekoden i HolyMoly-appen første gang' : 'Lukket for tilmelding';
      $('#empty-code').textContent = c.joinCode || '';
      $('#empty-code').classList.toggle('closed', !c.joinOpen);
    }
    async function showJoinCode() {
      const code = h('div', { class: 'big-code' });
      const status = h('p', { class: 'small' });
      const render = () => {
        code.textContent = state.cls.joinCode;
        code.classList.toggle('closed', !state.cls.joinOpen);
        status.textContent = state.cls.joinOpen
          ? 'Åben: nye elever kan tilmelde sig med koden.'
          : 'Lukket: koden virker ikke, før du åbner igen. Elever der allerede er tilmeldt, påvirkes ikke.';
        updateJoinUi();
      };
      const act = async (action) => {
        const r = await api(`/api/classes/${classId}/joincode`, { method: 'POST', body: { action } });
        Object.assign(state.cls, r);
        render();
        return false; // bliv i dialogen
      };
      render();
      await dialog({
        title: 'Klassekode – ' + state.cls.name,
        body: [
          h('p', { class: 'muted', text: 'Eleverne skriver koden i HolyMoly-appen første gang og derefter deres navn. Så dukker de op i klasseværelset.' }),
          code, status,
          h('p', { class: 'muted small', text: 'Ny kode: den gamle holder op med at virke. Luk for tilmelding, når alle er med, så ingen udefra kan melde sig til.' }),
        ],
        actions: [
          { label: 'Ny kode', run: () => act('new') },
          { label: 'Luk / åbn for tilmelding', run: () => act(state.cls.joinOpen ? 'close' : 'open') },
          { label: 'Luk', kind: 'primary', value: true },
        ],
      });
    }

    async function editStudent(id) {
      const s = state.students.get(id);
      const name = h('input', { value: s.name, maxlength: 80 });
      const info = s.enrolled
        ? h('p', { class: 'muted small', text: 'Tilmeldt' + (s.device ? ` på ${s.device.os || 'ukendt'}` : '') + '. "Ny computer" logger den gamle computer ud og giver en kode til den nye.' })
        : h('p', { class: 'small' }, 'Venter på ny computer – kode: ', h('b', { text: s.inviteCode || 'udløbet' }));
      // Elevens egen kode (enkel tilstand): læreren kan nulstille den, hvis eleven har glemt den
      const pinInfo = s.pinLocked
        ? h('p', { class: 'small' }, h('b', { text: 'Koden er låst' }), ' efter for mange forkerte forsøg. Er det eleven selv, så nulstil koden.')
        : s.pinResetUntil
          ? h('p', { class: 'small' }, `Koden er nulstillet. Engangskoden virker indtil kl. ${fmtTime(s.pinResetUntil)}. Har ${s.name} ikke nået det, så nulstil igen.`)
          : s.pinReset ? h('p', { class: 'small' }, 'Engangskoden er udløbet. Nulstil igen for at få en ny.')
            : s.pin ? h('p', { class: 'muted small', text: 'Eleven har sin egen kode. Har eleven glemt den, så nulstil den. Du får en engangskode, som eleven skriver i appen.' }) : null;
      // Hjælpemidler (ordblinde m.fl.): skrivevinduet tillader dem, og skrivetempoet vurderes ikke.
      // Vises kun her og i lærer-logbogen – aldrig i mærket, beviset eller Word-filen.
      const aidsNow = Array.isArray(s.aids) ? s.aids : [];
      const aidBox = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'aid', value: key, checked: aidsNow.includes(key) }), label);
      const aids = h('fieldset', { class: 'aids' },
        h('legend', { text: 'Hjælpemidler' }),
        aidBox('ordforslag', 'Ordforslag'), aidBox('diktering', 'Diktering'),
        h('p', { class: 'muted small', text: 'Til elever med fx ordblindhed. Skrivetempoet bliver ikke vurderet. Over 10 % dikteret tekst giver ikke mærket, men eleven får ingen ulempe. Valget står i logbogen.' }));
      const r = await dialog({
        title: s.name,
        body: [h('label', {}, 'Navn', name), info, pinInfo, aids],
        actions: [
          s.pin || s.pinReset ? { label: 'Nulstil kode', run: async () => {
            const r = await api(`/api/students/${id}/reset-pin`, { method: 'POST', body: {} });
            return { resetCode: r.resetCode, until: r.pinResetUntil };
          } } : null,
          { label: 'Slet elev', kind: 'danger', run: async () => {
            if (!confirm(`Slet ${s.name} og al elevens log?`)) return false;
            await api('/api/students/' + id, { method: 'DELETE' });
            return 'deleted';
          } },
          { label: 'Ny computer', run: async () => api(`/api/students/${id}/invite`, { method: 'POST', body: {} }).then(r => ({ code: r.inviteCode })) },
          { label: 'Gem', kind: 'primary', submit: true, run: async () => {
            await api('/api/students/' + id, { method: 'PATCH', body: { name: name.value } });
            const picked = [...aids.querySelectorAll('input[name=aid]:checked')].map(x => x.value);
            if (picked.join() !== aidsNow.join()) await api(`/api/students/${id}/aids`, { method: 'PUT', body: { aids: picked } });
            return 'saved';
          } },
        ],
      });
      if (r) {
        await refreshClass(); drawDesks();
        if (r.resetCode) {
          await dialog({
            title: 'Ny kode til ' + s.name,
            body: [
              h('p', { text: 'Giv eleven denne kode. Eleven skriver klassekoden, sit navn og koden i appen. Koden er herefter elevens kode.' }),
              h('div', { class: 'big-code', text: r.resetCode }),
              h('p', { class: 'muted small', text: `Koden virker til kl. ${fmtTime(r.until)}. Vis den kun til eleven.` }),
            ],
            actions: [{ label: 'Luk', kind: 'primary', value: true }],
          });
        }
        if (r.code) {
          await dialog({
            title: 'Ny computer til ' + s.name,
            body: [h('p', { text: 'Eleven skriver denne kode i HolyMoly-appen på den nye computer. Den gamle computer er logget ud.' }), h('div', { class: 'big-code', text: r.code }), h('p', { class: 'muted small', text: 'Koden virker én gang og udløber efter 14 dage.' })],
            actions: [{ label: 'Luk', kind: 'primary', value: true }],
          });
        }
      }
    }

    async function showSettings() {
      const conf = state.cls.config;
      const cats = h('div', { class: 'cats' }, ...Object.entries(state.info.categories).filter(([k]) => k !== 'custom').map(([k, c]) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'cat', value: k, checked: conf.categories[k] }), c.label)));
      const extra = h('textarea', { rows: 4, placeholder: 'fx kahoot.it\nspil.dk' });
      extra.value = (conf.extraBlocked || []).join('\n');
      const allowed = h('textarea', { rows: 3, placeholder: 'fx youtube.com (hvis I bruger det i timen)' });
      allowed.value = (conf.allowed || []).join('\n');
      const allowedApps = h('input', { placeholder: 'fx spotify, discord', value: (conf.allowedApps || []).join(', ') });
      const blockedApps = h('input', { placeholder: 'fx minecraft, et-nyt-spil', value: (conf.extraBlockedApps || []).join(', ') });
      const exam = h('input', { type: 'checkbox', checked: conf.examMode });
      const examAllowed = h('textarea', { rows: 3, placeholder: 'fx netproever.dk\nordnet.dk\ndocs.google.com' });
      examAllowed.value = (conf.examAllowed || []).join('\n');
      const kill = h('input', { type: 'checkbox', checked: conf.killApps });
      const autoEv = h('input', { type: 'checkbox', checked: !!conf.autoEvidence });
      const r = await dialog({
        title: 'Blokering og regler',
        body: [
          h('div', { class: 'sec' }, h('h3', { text: 'Blokér disse kategorier' }), cats),
          h('label', {}, 'Ekstra blokerede sider (ét domæne pr. linje)', extra),
          h('label', {}, 'Altid tilladte sider (undtagelser)', allowed),
          h('label', {}, 'Tilladte programmer (kommasepareret)', allowedApps),
          h('label', {}, 'Blokerede programmer (kommasepareret)', blockedApps),
          h('div', { class: 'sec' }, h('h3', { text: 'Prøvetilstand' }),
            h('label', { class: 'check' }, exam, 'Kun disse sider må åbnes (alt andet blokeres og giver rød)'),
            examAllowed,
            h('p', { class: 'muted small', text: 'Login-sider (UNI-Login, Google, Microsoft, MitID) og netprøver.dk er altid tilladt.' })),
          h('label', { class: 'check' }, kill, 'Luk forbudte programmer automatisk (spil, AI-apps, VPN …)'),
          h('label', { class: 'check' }, autoEv, 'Tag automatisk et skærmbillede ved forbudt brug (eleven får besked hver gang)'),
          h('p', { class: 'muted small', text: 'Ændringer slår igennem med det samme hos elever der er forbundet.' }),
        ],
        actions: [{ label: 'Annuller' }, {
          label: 'Gem', kind: 'primary', submit: true, run: () => api('/api/classes/' + classId, {
            method: 'PATCH', body: {
              config: {
                categories: Object.fromEntries($$('input[name=cat]', cats).map(i => [i.value, i.checked])),
                extraBlocked: extra.value.split(/[\s,]+/).filter(Boolean),
                allowed: allowed.value.split(/[\s,]+/).filter(Boolean),
                allowedApps: allowedApps.value.split(',').map(s => s.trim()).filter(Boolean),
                extraBlockedApps: blockedApps.value.split(',').map(s => s.trim()).filter(Boolean),
                examMode: exam.checked,
                examAllowed: examAllowed.value.split(/[\s,]+/).filter(Boolean),
                killApps: kill.checked,
                autoEvidence: autoEv.checked,
              },
            },
          }),
        }],
      });
      if (r) { state.cls.config = r.config; toast('Reglerne er gemt'); }
    }

    async function renameClass() {
      const name = h('input', { value: state.cls.name, maxlength: 80 });
      const r = await dialog({ title: 'Omdøb klasse', body: h('label', {}, 'Navn', name), actions: [{ label: 'Annuller' }, { label: 'Gem', kind: 'primary', submit: true, run: () => api('/api/classes/' + classId, { method: 'PATCH', body: { name: name.value } }) }] });
      if (r) { state.cls.name = name.value; $('#class-name').textContent = name.value; }
    }

    async function deleteClass() {
      const ok = await dialog({ title: 'Slet ' + state.cls.name + '?', body: h('p', { text: 'Klassen, alle elever og hele loggen slettes. Det kan ikke fortrydes.' }), actions: [{ label: 'Annuller', value: false }, { label: 'Slet', kind: 'danger', value: true }] });
      if (!ok) return;
      await api('/api/classes/' + classId, { method: 'DELETE' });
      route('/');
    }

    /* ---- elev-skuffen ---- */
    function openDrawer(id) {
      if (state.watching != null && state.watching !== id) send({ type: 'unwatch' });
      state.watching = null;
      state.open = id;
      state.tab = 'now';
      state.detail = null;
      $('#drawer').hidden = false;
      $('#d-screen').removeAttribute('src');
      $('#d-screen').hidden = true;
      $('#d-screen-sel').hidden = true;
      $('#d-screen-sel').value = '0';
      updateDrawerHead(); // kigger med (watchOpen), medmindre eleven skriver hjemme
      renderTab();
    }
    // Skriveøkt hjemme: skærm, skærmbilleder, faner og programmer kan ikke ses (serveren afviser det også)
    const HOME_MSG = 'Skriveøkt hjemme: skærmen kan ikke ses';
    function isHome(id) { const v = state.views.get(id); return !!(v && v.solo); }
    /** Kig med på den åbne elev – men aldrig, mens eleven skriver hjemme. */
    function watchOpen(screen) {
      const id = state.open;
      if (id == null) return;
      if (isHome(id)) {
        if (state.watching != null) send({ type: 'unwatch' });
        state.watching = null;
        state.detail = null;
        return;
      }
      if (state.watching === id) return;
      send({ type: rw ? rw.watchType() : 'watch', studentId: id, screen: screen || 0 });
      state.watching = id;
    }
    function closeDrawer() {
      if (state.open == null) return;
      send({ type: 'unwatch' });
      state.watching = null;
      state.open = null;
      $('#drawer').hidden = true;
      if (state.liveUrl) { URL.revokeObjectURL(state.liveUrl); state.liveUrl = null; }
    }
    function updateScreenSelect(n, cur) {
      const sel = $('#d-screen-sel');
      if (n <= 1) { sel.hidden = true; return; }
      if (sel.options.length !== n) sel.replaceChildren(...Array.from({ length: n }, (_, i) => h('option', { value: i, text: 'Skærm ' + (i + 1) })));
      sel.value = String(cur);
      sel.hidden = false;
    }
    function updateDrawerHead() {
      const id = state.open;
      const s = state.students.get(id);
      const v = state.views.get(id) || { color: 'grey' };
      if (!s) return closeDrawer();
      $('#d-name').textContent = s.name;
      $('#d-export').href = `/api/students/${id}/export.csv`;
      $('#d-lamp').className = 'lamp ' + v.color;
      const t = viewText(v, s);
      $('#d-sub').textContent = t.act + (v.device && v.device.os ? ' · ' + v.device.os : '');
      $('#d-freeze').textContent = v.frozen ? 'Optø' : 'Frys';
      $('#d-hand').hidden = !v.hand;
      $('#d-freeze').disabled = !(state.lesson && state.lesson.live);
      if (rw) rw.updateDrawer(id);
      const home = !!v.solo;
      const shot = $('#d-shot');
      shot.disabled = home || !(state.lesson && state.lesson.live && v.online);
      shot.title = home ? 'Eleven skriver hjemme. Der tages ingen skærmbilleder af skærmen derhjemme.' : '';
      const full = $('#d-fullscreen');
      full.disabled = home;
      full.title = home ? 'Eleven skriver hjemme. Skærmen kan ikke ses.' : '';
      watchOpen(Number($('#d-screen-sel').value) || 0);
      const msg = $('#d-screen-msg');
      if (home) {
        msg.hidden = false;
        msg.textContent = 'Skriveøkt hjemme: skærmen kan ikke ses. Du ser kun, at eleven skriver, og hvad HolyMoly har blokeret.';
        $('#d-screen').removeAttribute('src');
        $('#d-screen').hidden = true;
        $('#d-screen-sel').hidden = true;
      } else if (v.color === 'grey' || v.color === 'idle') {
        msg.hidden = false;
        msg.textContent = v.color === 'idle' ? 'Start lektionen for at se skærmen' : (v.greyReason || 'Eleven er ikke forbundet');
        $('#d-screen').removeAttribute('src');
        $('#d-screen').hidden = true;
      } else if (!$('#d-screen').getAttribute('src')) {
        msg.hidden = false;
        msg.textContent = 'Venter på billede…';
      }
      if (state.tab === 'now') renderTab();
    }

    async function renderTab() {
      $$('.tabs button').forEach(b => { const on = b.dataset.tab === state.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      const body = $('#d-body');
      const id = state.open;
      if (id == null) return;
      const tab = state.tab;
      if (tab === 'now') {
        const v = state.views.get(id) || {};
        const d = state.detail || { tabs: [], apps: [] };
        const secs = [];
        if (v.solo) secs.push(h('div', { class: 'sec' }, h('h3', { text: 'Skriver hjemme' }), h('p', { class: 'muted small', text: `Skriveøkt til "${v.solo}". Skærm, faner og programmer vises ikke, når eleven skriver hjemme.` })));
        if (v.violations && v.violations.length) {
          secs.push(h('div', { class: 'sec' }, h('h3', { text: 'Lige nu' }), ...v.violations.map(x => h('div', { class: 'violation', text: x.text }))));
        }
        if (v.degraded && v.degraded.length) {
          secs.push(h('div', { class: 'sec' }, h('h3', { text: 'Overvågning ikke komplet' }), ...v.degraded.map(x => h('div', { class: 'violation grey', text: x.text }))));
        }
        // Hjemme vises intet aktivt vindue – kun at eleven skriver
        if (!v.solo) secs.push(h('div', { class: 'sec' }, h('h3', { text: 'Aktivt vindue' }), h('div', { text: v.activity || '–' }), v.url ? h('div', { class: 'muted small', text: v.url }) : null,
          v.app && !v.url ? appButtons(v.app) : null));
        if (v.ext) secs.push(h('div', { class: 'sec' }, h('h3', { text: 'Browser-udvidelse' }), h('div', { class: 'small', text: v.ext.connected ? 'Aktiv i: ' + (v.ext.browsers.join(', ') || '–') : 'Ikke forbundet' })));
        if (!v.solo) secs.push(h('div', { class: 'sec' }, h('h3', { text: `Åbne faner (${d.tabs.length})` }),
          d.tabs.length ? h('ul', { class: 'list' }, ...d.tabs.map(t => {
            const r = t.blocked;
            return h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title', text: (t.active ? '▶ ' : '') + (t.title || hostOf(t.url)) }), h('div', { class: 'url', text: t.url })), t.browser ? h('span', { class: 'badge', text: t.browser }) : null);
          })) : h('p', { class: 'muted small', text: 'Ingen data endnu.' })));
        body.replaceChildren(...secs);
        return;
      }
      if (tab === 'apps') {
        const d = isHome(id) ? { apps: [] } : (state.detail || { apps: [] });
        body.replaceChildren(
          h('div', { class: 'sec' }, h('h3', { text: `Kørende programmer (${d.apps.length})` }),
            h('ul', { class: 'list' }, ...d.apps.map(a => h('li', {}, h('div', { class: 'main', text: a.name }), a.category ? h('span', { class: 'badge ' + (a.blocked ? 'red' : ''), text: a.category }) : null, appButtons(a.name))))),
          h('div', { class: 'sec' }, h('h3', { text: 'Skift mellem programmer' }), h('p', { class: 'muted', text: 'Henter…' })),
        );
        const log = await eventList(id, 'apps');
        if (state.open !== id || state.tab !== 'apps') return;
        body.lastElementChild.replaceChildren(h('h3', { text: 'Skift mellem programmer' }), log);
        return;
      }
      if (tab === 'docs') {
        state.docOpen = null;
        body.replaceChildren(h('p', { class: 'muted', text: 'Henter…' }));
        const view = await docList(id).catch(e => h('p', { class: 'error', text: e.message }));
        if (state.open === id && state.tab === 'docs') body.replaceChildren(view);
        return;
      }
      body.replaceChildren(h('p', { class: 'muted', text: 'Henter…' }));
      const list = await eventList(id, tab);
      if (state.open === id && state.tab === tab) body.replaceChildren(list);
    }

    // Bloker/tillad et program for hele klassen med ét klik
    function appButtons(appName) {
      const name = String(appName).toLowerCase().replace(/\.exe$/, '');
      const conf = state.cls.config;
      const blocked = (conf.extraBlockedApps || []).includes(name);
      const allowed = (conf.allowedApps || []).includes(name);
      const set = async (field, on) => {
        const list = new Set(conf[field] || []);
        if (on) list.add(name); else list.delete(name);
        const r = await api('/api/classes/' + classId, { method: 'PATCH', body: { config: { [field]: [...list] } } });
        state.cls.config = r.config;
        toast(on ? (field === 'extraBlockedApps' ? `${appName} er nu blokeret i klassen` : `${appName} er nu tilladt i klassen`) : 'Fjernet');
        renderTab();
      };
      return h('span', { class: 'appbtns' },
        h('button', { class: 'btn small' + (blocked ? ' danger' : ''), text: blocked ? 'Blokeret ✓' : 'Bloker', onclick: () => set('extraBlockedApps', !blocked) }),
        h('button', { class: 'btn small', text: allowed ? 'Tilladt ✓' : 'Tillad', onclick: () => set('allowedApps', !allowed) }));
    }

    /* ---- "Skriv i HolyMoly": elevens dokumenter og skrive-beviser ---- */
    const proofCode = (certId) => 'HM-' + certId.slice(0, 8).toUpperCase();
    async function docList(id) {
      const r = await api(`/api/students/${id}/docs`);
      if (!r.docs.length) return h('p', { class: 'muted', text: 'Eleven har ikke skrevet i HolyMoly endnu. Eleven åbner "Skriv dokument" i appen under lektionen.' });
      const ul = h('ul', { class: 'list' });
      for (const d of r.docs) {
        const badge = d.certId ? h('span', { class: 'badge green', text: 'Bevis ' + proofCode(d.certId) })
          : d.submitted ? h('span', { class: 'badge', text: 'Afleveret uden bevis' })
            : h('span', { class: 'badge', text: 'Skriver…' });
        ul.append(h('li', { class: 'clickable', onclick: () => showDoc(d.id) },
          h('div', { class: 'main' }, h('div', { class: 'title', text: d.title || 'Uden titel' }), h('div', { class: 'url', text: `${d.words} ord · ${d.submitted ? 'afleveret ' + fmtDateTime(d.submitted) : 'senest gemt ' + fmtDateTime(d.updated)}` })),
          badge));
      }
      return h('div', { class: 'sec' }, h('h3', { text: 'Dokumenter skrevet i HolyMoly' }), ul);
    }
    function renderBlocks(blocks) {
      const root = h('div', { class: 'doc-view' });
      let list = null;
      for (const b of blocks) {
        let host;
        if (b.t === 'ul' || b.t === 'ol') {
          if (!list || list.tagName.toLowerCase() !== b.t) { list = h(b.t, {}); root.append(list); }
          host = h('li', {}); list.append(host);
        } else { list = null; host = h(b.t === 'h1' ? 'h1' : b.t === 'h2' ? 'h2' : 'p', {}); root.append(host); }
        for (const r of b.r) {
          let n = document.createTextNode(r.x);
          if (r.u) n = h('u', {}, n);
          if (r.i) n = h('i', {}, n);
          if (r.b) n = h('b', {}, n);
          host.append(n);
        }
      }
      return root;
    }
    async function showDoc(docId) {
      const id = state.open;
      let d;
      try { d = await api('/api/docs/' + docId); } catch (e) { toast(e.message); return; }
      if (state.open !== id || state.tab !== 'docs') return;
      state.docOpen = docId;
      const body = $('#d-body');
      const back = h('button', { class: 'btn small', text: '← Alle dokumenter', onclick: () => { state.docOpen = null; renderTab(); } });
      // Kladde uden for klassens lektion: kun titel og omfang
      if (d.draft) {
        body.replaceChildren(h('div', { class: 'sec' }, h('div', { class: 'row-actions' }, back)), h('h3', { text: d.title || 'Uden titel' }),
          h('p', { class: 'muted small', text: `${d.words} ord · senest gemt ${fmtDateTime(d.updated)}` }),
          h('p', { text: 'Kladde – kan læses, når eleven afleverer.' }));
        return;
      }
      const word = h('button', { class: 'btn small', text: 'Hent som Word', onclick: () => {
        const mark = d.certId ? { code: proofCode(d.certId), url: `${location.origin}/bevis/${d.certId}`, place: d.place, observed: d.observed, test: d.test } : null;
        const blob = new Blob([HMDoc.toDocx(d.blocks, { title: d.title, author: d.studentName || '', mark, readOnly: true })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const a = h('a', { href: URL.createObjectURL(blob), download: (d.title || 'Dokument').replace(/[\\/:*?"<>|]/g, '') + '.docx' });
        document.body.append(a); a.click(); a.remove();
      } });
      const status = d.certId
        ? h('div', { class: 'sec' }, h('div', { class: 'proof-head ok', text: '✓ Skrive-bevis ' + proofCode(d.certId) }),
          h('p', { class: 'small' }, HMDoc.label(d.place, { observed: d.observed, test: d.test }) + '. ' + HMDoc.LIMIT_TEXT + ' ', h('a', { href: '/bevis/' + d.certId, target: '_blank', rel: 'noopener', text: 'Se beviset' })))
        : h('div', { class: 'sec' }, h('div', { class: 'proof-head', text: d.submitted ? 'Afleveret uden bevis' : 'Ikke afleveret endnu – sådan ser det ud lige nu:' }),
          d.reasons.length ? h('ul', { class: 'small' }, ...d.reasons.map(x => h('li', { class: 'violation grey', text: x }))) : h('p', { class: 'small muted', text: 'Indtil videre er der intet, der forhindrer et bevis.' }),
          d.submitted ? h('p', { class: 'muted small', text: 'Manglende flueben er ikke bevis for snyd. En snydsag kræver altid, at eleven bliver hørt.' }) : null);
      const facts = d.facts ? h('p', { class: 'muted small', text: `${d.facts.words} ord · ${d.facts.writingMinutes} min. skrivetid · ${d.source === 'word' ? 'skrevet i Word (ingen tastestatistik)' : `${d.facts.typed} tegn tastet, ${d.facts.deleted} slettet`} ·${d.facts.monitoredShare} % med fuld overvågning` }) : null;
      const notes = d.notes && d.notes.length ? h('ul', { class: 'muted small' }, ...d.notes.map(x => h('li', { text: x }))) : null;
      const replay = h('div', { class: 'sec' });
      const similar = h('div', { class: 'sec' });
      // Skrivelogen (kun afleverede dokumenter – samme regel som afspilningen)
      const logSec = h('div', { class: 'sec' });
      const logBtn = d.submitted ? logButton(docId, logSec, replay) : null;
      body.replaceChildren(h('div', { class: 'sec' }, h('div', { class: 'row-actions' }, back, h('div', { class: 'row-actions start' }, logBtn, word))), h('h3', { text: d.title || 'Uden titel' }), status, facts, notes, logSec, similar, renderBlocks(d.blocks), replay);
      // Lighedstjek og afspilning kun for afleverede dokumenter
      if (d.submitted && state.info.features && state.info.features.similar) fillSimilar(docId, similar).catch(() => {});
      if (d.submitted) fillReplay(docId, replay).catch(() => {});
    }

    // Ligner dokumentet andre i klassen? (lokalt tjek af fælles sætningsdele – en oplysning, aldrig en rød lampe)
    async function fillSimilar(docId, el) {
      const r = await api(`/api/docs/${docId}/similar`);
      if (!r.similar.length) return;
      el.replaceChildren(h('h3', { text: 'Ligner andre afleveringer' }),
        h('ul', { class: 'small' }, ...r.similar.map(x => h('li', {}, h('b', { text: x.percent + ' %' }), ` fælles sætningsdele med ${x.student}s "${x.title || 'Uden titel'}"`))),
        h('p', { class: 'muted small', text: 'Det kan være samarbejde, afskrift – eller at begge citerer den samme kilde. Tal med eleverne, før du konkluderer noget.' }));
    }

    // Afspil skriveforløbet: teksten som den så ud undervejs (gemt hvert ~20. sek.)
    async function fillReplay(docId, el) {
      const r = await api(`/api/docs/${docId}/versions`);
      const v = r.versions;
      if (v.length < 2) return;
      const view = h('div', { class: 'replay-text' });
      const when = h('span', { class: 'muted small' });
      const range = h('input', { type: 'range', min: 0, max: v.length - 1, value: v.length - 1, 'aria-label': 'Tidspunkt i skriveforløbet' });
      let timer = null;
      const show = (i) => {
        range.value = String(i);
        const cur = v[i];
        const prev = i > 0 ? v[i - 1].text : '';
        // Fremhæv det nye siden forrige version (fælles begyndelse/slutning springes over)
        let a = 0; while (a < prev.length && a < cur.text.length && prev[a] === cur.text[a]) a++;
        let z = 0; while (z < prev.length - a && z < cur.text.length - a && prev[prev.length - 1 - z] === cur.text[cur.text.length - 1 - z]) z++;
        view.replaceChildren(document.createTextNode(cur.text.slice(0, a)), h('mark', { text: cur.text.slice(a, cur.text.length - z) }), document.createTextNode(cur.text.slice(cur.text.length - z)));
        when.textContent = `${fmtTime(cur.ts)} · ${cur.text.length} tegn · version ${i + 1} af ${v.length}`;
      };
      const play = h('button', { class: 'btn small', type: 'button', text: '▶ Afspil', onclick: () => {
        if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ Afspil'; return; }
        let i = Number(range.value) >= v.length - 1 ? 0 : Number(range.value);
        show(i);
        play.textContent = '⏸ Pause';
        timer = setInterval(() => {
          if (!document.body.contains(view)) { clearInterval(timer); return; }
          i++;
          if (i >= v.length) { clearInterval(timer); timer = null; play.textContent = '▶ Afspil'; return; }
          show(i);
        }, 700);
      } });
      range.addEventListener('input', () => show(Number(range.value)));
      el.replaceChildren(h('h3', { text: 'Afspil skriveforløbet' }), h('div', { class: 'replay-bar' }, play, range), when, view);
      show(v.length - 1);
      // Skrivelogens "Vis i afspilningen": første version fra tidspunktet (eller den sidste)
      el.seek = (ts) => {
        if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ Afspil'; }
        const i = v.findIndex(x => x.ts >= ts);
        show(i < 0 ? v.length - 1 : i);
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        range.focus();
      };
    }

    // Skrivelogen: hvordan teksten blev skrevet (skrivelog.js). replay = afspilningens sektion (til "Vis i afspilningen").
    async function fillLog(docId, el, replay) {
      el.replaceChildren(h('p', { class: 'muted small', text: 'Henter skrivelogen …' }));
      try {
        const log = await api(`/api/docs/${docId}/log`);
        el.replaceChildren(window.HM.skrivelog.render({ h }, log, { seek: (ts) => { if (replay && replay.seek) replay.seek(ts); else toast('Afspilningen er ikke klar endnu'); } }));
      } catch (e) { el.replaceChildren(h('p', { class: 'error', text: e.message })); }
    }
    /** Knappen 'Skrivelog', der folder skrivelogen ud og ind (hentes første gang). */
    function logButton(docId, el, replay) {
      let loaded = false;
      el.hidden = true;
      el.id = el.id || 'slog-' + docId.slice(0, 8);
      const btn = h('button', { class: 'btn small', type: 'button', text: 'Skrivelog', 'aria-expanded': 'false', 'aria-controls': el.id, onclick: () => {
        el.hidden = !el.hidden;
        btn.setAttribute('aria-expanded', String(!el.hidden));
        if (!el.hidden && !loaded) { loaded = true; fillLog(docId, el, replay); }
      } });
      return btn;
    }

    async function eventList(id, kind) {
      const wrap = h('div', {});
      const ul = h('ul', { class: 'list' });
      wrap.append(ul);
      let before = Date.now() + 60_000;
      let lastDay = '';
      const more = h('button', { class: 'btn more', text: 'Vis ældre' });
      const load = async () => {
        const r = await api(`/api/students/${id}/events?kind=${kind}&limit=150&before=${before}`);
        for (const e of r.events) {
          const day = new Date(e.ts).toDateString();
          if (day !== lastDay) {
            lastDay = day;
            ul.append(h('li', {}, h('b', { class: 'small', text: new Date(e.ts).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' }) })));
          }
          ul.append(eventRow(e));
          before = e.ts;
        }
        more.hidden = r.events.length < 150;
        if (!ul.children.length) ul.append(h('li', { class: 'muted', text: 'Intet registreret endnu.' }));
      };
      more.addEventListener('click', () => load().catch(e => toast(e.message)));
      wrap.append(more);
      await load().catch(e => toast(e.message));
      return wrap;
    }

    const KIND = { nav: '', blocked: 'Blokeret', violation: 'Overtrædelse', tamper: 'Advarsel', killed: 'Lukket', evidence: 'Skærmbillede', info: 'Info', teacher: 'Lærer', system: 'System', hand: 'Hånd op', app: '' };
    function eventRow(e) {
      const main = h('div', { class: 'main' });
      if (e.kind === 'nav' || e.kind === 'blocked') {
        main.append(h('div', { class: 'title', text: e.title || hostOf(e.url) }), h('div', { class: 'url', text: e.url || '' }));
      } else if (e.kind === 'app') {
        main.append(h('div', { class: 'title', text: e.app || '' }), e.title ? h('div', { class: 'url', text: e.title }) : null);
      } else {
        main.append(h('div', { class: 'title', text: e.title || e.app || e.url || '' }));
        if (e.url) main.append(h('div', { class: 'url', text: e.url }));
      }
      if (e.evidenceId) {
        const img = h('img', { class: 'evidence', alt: 'Skærmbillede', loading: 'lazy', src: '/api/evidence/' + e.evidenceId });
        img.addEventListener('click', () => window.open('/api/evidence/' + e.evidenceId, '_blank', 'noopener'));
        main.append(img);
      }
      const label = KIND[e.kind];
      const red = e.blocked || ['blocked', 'violation', 'tamper', 'killed'].includes(e.kind);
      return h('li', {}, h('span', { class: 'time', text: fmtTime(e.ts), title: fmtDateTime(e.ts) }), main,
        label || e.category ? h('span', { class: 'badge ' + (red ? 'red' : ''), text: label || e.category }) : null);
    }

    drawDesks();
    updateLessonUi();
    connect();

    cleanup = () => {
      state.closed = true;
      window.removeEventListener('resize', sizeDesks);
      clearInterval(state.lessonTimer);
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', onKey);
      if (rw) rw.cleanup();
      cleanupInfo();
      if (state.ws) state.ws.close();
    };
  }

  // Fælles hjælpere til account.js
  window.HM = Object.assign(window.HM || {}, {
    $, $$, h, api, toast, dialog, route, tpl, app, fmtTime, fmtDateTime, setTheme, currentTheme, showPrefs, setupInfo,
    setCleanup: (f) => { cleanup = f; }, isStale: (seq) => stale(seq), seq: () => renderSeq,
    setInfo: (info) => { downloadUrl = info.downloadUrl || ''; uniLoginOn = !!info.uniLogin; },
    maybeIntro: () => maybeIntro(),
  });
  window.HM.pages = window.HM.pages || {};
  // Alle scripts er indlæst, før siden tegnes (account.js kommer efter app.js)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
