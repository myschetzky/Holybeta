(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = (ts) => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  let addingClass = false;

  $('code').addEventListener('input', () => {
    const v = $('code').value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
    $('code').value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
  });
  // Trin 1: klassekoden. Trin 2 (kun ved klassekode): elevens navn.
  let askName = false, askPin = false, askAccept = false, pinKnown = false;
  // Ny kode: skriv den to gange. Kender serveren allerede elevens kode (ny computer), skrives den kun én gang.
  function setPinMode(known) {
    pinKnown = !!known;
    $('student-pin2').hidden = !askPin || pinKnown;
    $('pin-show').hidden = !askPin;
    $('student-pin').placeholder = pinKnown ? 'Din kode' : 'Vælg en kode (4-6 cifre)';
  }
  /*
   * Samme tjek som serveren (shared/rules.js), mens eleven skriver – så eleven ikke skal vente på svaret.
   * Det stopper ikke tilmeldingen: en elev, der logger ind igen med en gammel kode, afgøres af serveren.
   */
  $('student-pin').addEventListener('input', () => {
    const R = window.ACRules;
    const v = $('student-pin').value.trim();
    const weak = !pinKnown && !!(R && R.weakPin && R.weakPin(v));
    if (weak) { $('enroll-error').textContent = R.WEAK_PIN_TEXT; $('enroll-error').hidden = false; }
    else if (R && $('enroll-error').textContent === R.WEAK_PIN_TEXT) $('enroll-error').hidden = true;
  });
  $('pin-show').addEventListener('click', () => {
    const show = $('student-pin').type === 'password';
    for (const id of ['student-pin', 'student-pin2']) $(id).type = show ? 'text' : 'password';
    $('pin-show').textContent = show ? 'Skjul kode' : 'Vis kode';
    $('pin-show').setAttribute('aria-pressed', show ? 'true' : 'false');
  });
  function setStep(nameStep, className, teacherName, uni = {}) {
    askName = nameStep;
    const typed = nameStep && !uni.uniLoginRequired;  // må eleven skrive sit navn selv?
    askPin = typed && !!uni.needPin;                    // enkel tilstand: navn + egen kode
    $('code').hidden = nameStep;
    $('student-name').hidden = !typed;
    $('student-pin').hidden = !askPin;
    setPinMode(uni.pinKnown);
    askAccept = typed && !!uni.needAccept;              // enkel tilstand: vilkårene for elever
    $('enroll-terms').hidden = !askAccept;
    $('enroll-submit').hidden = nameStep && !typed;
    $('enroll-uni').hidden = !(nameStep && uni.uniLogin);
    $('enroll-uni-wait').hidden = true;
    // Man kan altid gå tilbage fra navne-trinnet (fx forkert klassekode eller UNI-Login lukket)
    $('enroll-cancel').textContent = nameStep ? 'Tilbage' : 'Annuller';
    if (nameStep) $('enroll-cancel').hidden = false;
    $('enroll-title').textContent = nameStep ? 'Hvad hedder du?' : 'Skriv klassekoden';
    $('enroll-help').textContent = nameStep
      ? `Du tilmelder dig ${className}${teacherName ? ' hos ' + teacherName : ''}. ` + (askPin ? 'Skriv dit fulde navn og vælg en kode på 4-6 cifre. Med koden kan du logge ind igen på en anden computer.' : typed ? 'Skriv dit fulde navn, så din lærer kan se, det er dig.' : 'Log ind med UNI-Login, så din lærer kan se, det er dig.')
      : 'Koden får du af din lærer. Du skal kun gøre det én gang.';
    $('enroll-submit').textContent = nameStep ? 'Tilmeld' : 'Næste';
    setTimeout(() => $(typed ? 'student-name' : nameStep ? 'enroll-uni' : 'code').focus(), 0);
  }
  $('enroll-uni').addEventListener('click', async () => {
    $('enroll-error').hidden = true;
    $('enroll-uni').disabled = true;
    $('enroll-uni-wait').hidden = false;
    const r = await window.hm.enrollUniLogin($('code').value);
    $('enroll-uni').disabled = false;
    $('enroll-uni-wait').hidden = true;
    if (r.ok) { $('code').value = ''; setStep(false); addingClass = false; return; }
    if (r.error) { $('enroll-error').textContent = r.error; $('enroll-error').hidden = false; }
  });
  $('enroll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('enroll-error').hidden = true;
    const name = askName ? $('student-name').value.trim() : '';
    if (askName && name.length < 2) { $('enroll-error').textContent = 'Skriv dit fulde navn'; $('enroll-error').hidden = false; return; }
    const pin = askPin ? $('student-pin').value.trim() : '';
    if (askPin && !/^\d{4,6}$/.test(pin)) { $('enroll-error').textContent = 'Koden skal være 4-6 cifre'; $('enroll-error').hidden = false; return; }
    if (askPin && !pinKnown && $('student-pin2').value.trim() !== pin) { $('enroll-error').textContent = 'De to koder er ikke ens. Skriv koden igen.'; $('enroll-error').hidden = false; $('student-pin2').focus(); return; }
    if (askAccept && !$('enroll-accept').checked) { $('enroll-error').textContent = 'Sæt flueben ved vilkårene for at tilmelde dig'; $('enroll-error').hidden = false; return; }
    const r = await window.hm.enroll($('code').value, name, pin, askAccept ? $('enroll-accept').checked : undefined);
    if (r.needName) { setStep(true, r.className, r.teacherName, r); if (r.error) { $('enroll-error').textContent = r.error; $('enroll-error').hidden = false; } return; }
    if (!r.ok) { $('enroll-error').textContent = r.error; $('enroll-error').hidden = false; return; }
    $('code').value = '';
    $('student-name').value = '';
    $('student-pin').value = '';
    $('student-pin2').value = '';
    $('enroll-accept').checked = false;
    setStep(false);
    addingClass = false;
  });
  $('enroll-terms-link').addEventListener('click', () => window.hm.action('terms'));
  $('enroll-cancel').addEventListener('click', () => { addingClass = false; window.hm.cancelUniLogin(); setStep(false); window.hm.getState().then(render); });
  window.hm.onAddClass(() => { addingClass = true; window.hm.getState().then(render); });

  // Første opsætning: skolens adresse
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').hidden = true;
    $('setup-submit').disabled = true;
    $('setup-submit').textContent = 'Tjekker…';
    const r = await window.hm.setServer($('server').value);
    $('setup-submit').disabled = false;
    $('setup-submit').textContent = 'Fortsæt';
    if (!r.ok) { $('setup-error').textContent = r.error; $('setup-error').hidden = false; return; }
    window.hm.getState().then(render);
  });

  function render(s) {
    $('setup').hidden = !s.serverSetup;
    if (s.serverSetup) {
      $('enroll').hidden = true; $('status').hidden = true;
      $('global-error').hidden = true;
      setTimeout(() => { if (document.activeElement !== $('server')) $('server').focus(); }, 0);
      return;
    }
    const enrolled = s.enrollments.length > 0;
    const showEnroll = !enrolled || addingClass;
    $('enroll').hidden = !showEnroll;
    $('enroll-cancel').hidden = !enrolled && !askName;
    $('status').hidden = showEnroll;
    $('global-error').textContent = s.error || '';
    $('global-error').hidden = !s.error;
    if (showEnroll) { if (!askName) setTimeout(() => $('code').focus(), 0); return; }

    $('name').textContent = s.enrollments[0].studentName;
    $('classes').textContent = s.enrollments.map(e => e.className).join(' · ');

    const ok = s.conn === 'online' && !s.needs.length;
    const st = $('state');
    st.className = 'state ' + (ok ? 'ok' : 'bad');
    $('state-text').textContent = s.conn === 'online'
      ? (s.needs.length ? 'Forbundet – men noget mangler' : (s.lesson ? `Forbundet · lektion til kl. ${fmt(s.lesson.endsAt)}` : 'Forbundet'))
      : (s.conn === 'connecting' ? 'Forbinder…' : 'Ikke forbundet');

    $('todo').hidden = !s.needs.length;
    $('todo-list').replaceChildren(...s.needs.map(n => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = n.text;
      li.append(span);
      for (const a of n.actions || []) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = a.label;
        b.addEventListener('click', () => window.hm.action(a.id));
        li.append(b);
      }
      return li;
    }));
    // "Skriv i HolyMoly" – under lektionen (så kan HolyMoly bevise, at teksten er elevens egen)
    $('lesson-btns').hidden = !(s.conn === 'online' && s.lesson);
    // Lektionens links: ét klik åbner siden i browseren
    const links = s.links || [];
    $('links').hidden = !links.length;
    $('links-list').replaceChildren(...links.map((l, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      const t = document.createElement('span'); t.className = 't'; t.textContent = l.title;
      const hh = document.createElement('span'); hh.className = 'h'; hh.textContent = l.host;
      b.append(t, hh);
      b.addEventListener('click', () => window.hm.action('link:' + i));
      li.append(b);
      return li;
    }));
    // "Ræk hånden op": læreren ser ✋ på dit bord
    $('hand').textContent = s.hand ? 'Tag hånden ned' : '✋ Ræk hånden op';
    $('hand').setAttribute('aria-pressed', String(!!s.hand));
    $('hand').classList.toggle('up', !!s.hand);
    // Afleveringer fra læreren (også uden for lektionen)
    const open = s.assignmentsOpen || 0;
    $('assign').hidden = !(s.enrollments.length && open);
    $('assign-text').textContent = open === 1 ? 'Du har 1 aflevering, der mangler.' : `Du har ${open} afleveringer, der mangler.`;
    $('hint').textContent = ok ? 'Alt er klar. HolyMoly lægger sig nede i hjørnet og kører i baggrunden.' : '';
  }

  $('write').addEventListener('click', () => window.hm.action('write'));
  // 'Se afleveringer' og 'Afleveringer' åbner afleveringssiden (afleveringer.js)
  $('hand').addEventListener('click', () => window.hm.action('hand'));
  window.hm.onState(render);
  window.hm.getState().then(render);
})();
