/*
 * Klasseværelset: skrivetime, ekstra tid og funktioner, der er slået fra (beta).
 * HM.room.write(ctx) kaldes fra renderRoom i app.js og returnerer de dele, som rummet bruger.
 *
 *  - Skrivetime: lektionsdialogen får "Skal eleverne skrive en opgave?". Eleverne får afleveringen åbnet i skrivevinduet.
 *  - Ekstra tid: "+ tid" i elevskuffen (+10, +15 eller +30 min). Samme lektion, bare længere for eleven.
 *    Ekstra tid vises kun for læreren her – aldrig i Gennemgang, frys, rapport, bevis eller Word.
 *  - Funktioner: uden live-skærm skjules skærmen (dashboardet følger kun faner og hændelser), uden skærmbilleder skjules knappen.
 */
(function () {
  'use strict';
  window.HM = window.HM || {};
  window.HM.room = window.HM.room || {};

  window.HM.room.write = function (ctx) {
    const { state, classId, h, $, api, dialog, toast } = ctx;
    const F = Object.assign({ liveScreen: true, screenshot: true, hand: true, writeLesson: true }, (state.info && state.info.features) || {});
    const clock = (ts) => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
    const nameOf = (id) => (state.students.get(id) || {}).name || 'Elev';
    const extra = () => ((state.lesson && state.lesson.extra) || []).filter(e => e.until > Date.now());
    const extraOf = (id) => extra().find(e => e.studentId === id) || null;
    const live = () => !!(state.lesson && state.lesson.live);

    /* ---------- funktioner, der er slået fra ---------- */
    function applyFeatures() {
      const screen = $('.screen');
      if (screen && !F.liveScreen) screen.hidden = true;
      const shot = $('#d-shot');
      if (shot && !F.screenshot) shot.hidden = true;
    }
    /** watch = skærm, faner og hændelser. follow = kun faner og hændelser (live-skærm slået fra). */
    const watchType = () => (F.liveScreen ? 'watch' : 'follow');

    /* ---------- skrivetime ---------- */
    /** Feltet i lektionsdialogen. null, når skrivetime er slået fra. */
    async function startFields() {
      if (!F.writeLesson) return null;
      let list = [];
      try { list = (await api(`/api/classes/${classId}/assignments`)).assignments || []; } catch (e) { list = []; }
      const open = list.filter(a => !a.due || a.due > Date.now());
      const sel = h('select', { name: 'write' }, h('option', { value: '', text: '(ingen)' }), ...open.map(a => h('option', { value: a.id, text: a.title })));
      const node = h('label', {}, 'Skal eleverne skrive en opgave?', sel);
      const hint = h('p', { class: 'muted small', text: 'Vælger du en opgave, åbner elevernes app den i skrivevinduet. Teksten afleveres til opgaven.' });
      return {
        nodes: open.length ? [node, hint] : [],
        payload: () => (open.length ? { assignmentId: sel.value ? Number(sel.value) : null } : {}),
        /** Primærknappen hedder "Start skrivetime", når en opgave er valgt. */
        wire() {
          const btn = $('#dlg-actions .btn.primary');
          if (!btn) return;
          const base = btn.textContent;
          const upd = () => { btn.textContent = sel.value ? 'Start skrivetime' : base; };
          sel.addEventListener('change', upd);
          upd();
        },
      };
    }
    /** Pillen i topbaren under en lektion. */
    function pillText(lesson, minutesLeft) {
      if (lesson && lesson.write) return `Skrivetime · ${lesson.write.title} · ${minutesLeft} min tilbage`;
      return `Lektion · ${minutesLeft} min tilbage`;
    }

    /* ---------- ekstra tid ---------- */
    const hasExtra = () => extra().some(e => state.students.has(e.studentId));
    /** Stop-dialogen, når nogle elever har ekstra tid. { all } eller null (annuller). */
    async function stopDialog() {
      const ex = extra().filter(e => state.students.has(e.studentId));
      const until = Math.max(...ex.map(e => e.until));
      const who = ex.length === 1 ? '1 elev har' : `${ex.length} elever har`;
      const r = await dialog({
        title: 'Afslut lektionen?',
        body: [
          h('p', { text: `${who} ekstra tid til kl. ${clock(until)}: ${ex.map(e => nameOf(e.studentId)).join(', ')}.` }),
          h('p', { class: 'muted', text: 'Overvågning, blokering og frysning stopper for de andre elever nu.' }),
        ],
        actions: [{ label: 'Annuller', value: null }, { label: 'Afslut for alle', kind: 'danger', value: 'all' }, { label: 'Afslut, men lad dem skrive færdig', kind: 'primary', value: 'keep' }],
      });
      return r === 'all' ? { all: true } : r === 'keep' ? { all: false } : null;
    }
    async function extend(id) {
      const s = state.students.get(id);
      if (!s) return;
      const cur = extraOf(id);
      const pick = (m) => ({ label: '+' + m + ' min', kind: m === 15 ? 'primary' : '', run: () => api(`/api/classes/${classId}/lesson`, { method: 'POST', body: { action: 'extend', studentIds: [id], minutes: m } }) });
      const r = await dialog({
        title: 'Ekstra tid til ' + s.name,
        body: [
          h('p', { text: cur ? `${s.name} har ekstra tid til kl. ${clock(cur.until)}. Mere tid lægges oven i.` : `${s.name} skriver videre efter lektionens slut. Det er den samme lektion, og HolyMoly er aktiv, til tiden er gået.` }),
          h('p', { class: 'muted small', text: 'Kun du ser den ekstra tid. Den står ikke i rapporten, på beviset eller i Word-filen.' }),
        ],
        actions: [{ label: 'Annuller' }, pick(10), pick(15), pick(30)],
      });
      if (r && r.lesson) { state.lesson = r.lesson; ctx.updateLessonUi(); toast(`${s.name} har ekstra tid til kl. ${clock((extraOf(id) || {}).until || Date.now())}`); }
    }
    /** "+ tid" i elevskuffen: under lektionen, eller mens eleven skriver færdig. */
    function updateDrawer(id) {
      const b = $('#d-extra');
      if (!b) return;
      const cur = id != null ? extraOf(id) : null;
      const v = state.views.get(id) || {};
      b.hidden = id == null || !!v.solo || !(live() || cur);
      b.textContent = cur ? `+ tid (til ${clock(cur.until)})` : '+ tid';
      b.title = cur ? `Ekstra tid til kl. ${clock(cur.until)}` : 'Giv eleven ekstra tid (samme lektion)';
    }
    /** Efter klassens slut: pillen viser, hvem der skriver færdig, og "Afslut for alle" står ved siden af. */
    function updateUi() {
      let btn = $('#extra-end');
      const ex = !live() ? extra().filter(e => state.students.has(e.studentId)) : [];
      if (ex.length) {
        const pill = $('#lesson-pill');
        const until = Math.max(...ex.map(e => e.until));
        pill.textContent = `Ekstra tid · ${ex.length === 1 ? '1 elev' : ex.length + ' elever'} til kl. ${clock(until)}`;
        pill.title = ex.map(e => nameOf(e.studentId)).join(', ');
        pill.className = 'pill live';
        if (!btn) {
          btn = h('button', { class: 'btn', id: 'extra-end', text: 'Afslut for alle' });
          btn.addEventListener('click', async () => {
            const ok = await dialog({ title: 'Afslut den ekstra tid?', body: h('p', { text: 'Overvågningen stopper også for de elever, der skriver færdig.' }), actions: [{ label: 'Annuller', value: false }, { label: 'Afslut for alle', kind: 'danger', value: true }] });
            if (!ok) return;
            const r = await api(`/api/classes/${classId}/lesson`, { method: 'POST', body: { action: 'stop', all: true } });
            state.lesson = r.lesson;
            ctx.updateLessonUi();
          });
          const lb = $('#lesson-btn');
          lb.parentNode.insertBefore(btn, lb);
        }
        btn.hidden = false;
      } else if (btn) btn.hidden = true;
      updateDrawer(state.open);
    }
    const db = $('#d-extra');
    if (db) db.addEventListener('click', () => { if (state.open != null) extend(state.open).catch(e => toast(e.message)); });
    // Ekstra tid udløber: opdatér pillen og knapperne
    const timer = setInterval(() => { if (state.lesson && state.lesson.extra) updateUi(); }, 30_000);
    applyFeatures();

    return { features: F, watchType, startFields, pillText, hasExtra, stopDialog, updateUi, updateDrawer, cleanup: () => clearInterval(timer) };
  };
})();
