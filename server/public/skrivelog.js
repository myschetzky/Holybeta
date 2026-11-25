/*
 * Skrivelogen: hvordan en afleveret tekst blev skrevet (GET /api/docs/:id/log).
 * HM.skrivelog.render(ctx, log, opts) bygger visningen; app.js bruger den i lærerens dokumentvisning og i afleveringerne.
 *   ctx:  { h } (app.js' h – al tekst sættes som tekst, aldrig som HTML)
 *   opts: { seek(ts) } – "Vis i afspilningen" springer til tidspunktet i den eksisterende afspilning
 *
 * Opsummering, indsatte udsnit (med selve teksten) og forløbet: skrivning pr. minut som søjler (ren HTML/CSS,
 * med en tabel og en aria-label som tekst), rettelser (fold ud med det fjernede), flytninger og lampeskift.
 * Tonen er neutral: indsatte udsnit er ikke i sig selv bevis for snyd.
 */
(function () {
  'use strict';
  window.HM = window.HM || {};

  const clock = (ts) => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  const day = (ts) => new Date(ts).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short' });
  const n = (x) => Number(x || 0).toLocaleString('da-DK');
  const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;
  /** 134 -> '2 t 14 min', 45 -> '45 min' */
  function duration(min) {
    min = Math.max(0, Math.round(Number(min) || 0));
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} t` + (min % 60 ? ` ${min % 60} min` : '');
  }

  const REASON = {
    start: 'Stod i dokumentet, første gang HolyMoly så det',
    offline: 'Kom ind, mens HolyMoly ikke kunne følge med',
    hurtigt: 'Kom ind hurtigere, end man kan taste',
    paste: 'Elev-appen meldte tekst indsat fra et andet program',
    word: 'Kom ind i Word på én gang',
  };
  const LAMP = { red: 'Rød lampe', grey: 'Grå lampe', green: 'Grøn lampe igen' };

  /** 'Skrevet over 3 skriveøkter · 2 t 14 min · 1.240 ord · 2 indsatte udsnit (318 tegn) · 14 rettelser' */
  function summaryText(s) {
    const parts = [s.sessions > 1 ? `Skrevet over ${n(s.sessions)} skriveøkter` : 'Skrevet i 1 skriveøkt'];
    if (s.minutesWriting) parts.push(duration(s.minutesWriting));
    parts.push(plural(s.words, 'ord', 'ord'));
    parts.push(s.pastes ? `${plural(s.pastes, 'indsat udsnit', 'indsatte udsnit')} (${n(s.pastedChars)} tegn)` : 'ingen indsatte udsnit');
    parts.push(plural(s.corrections, 'rettelse', 'rettelser'));
    if (s.moves) parts.push(plural(s.moves, 'flytning', 'flytninger'));
    return parts.join(' · ');
  }

  /** Skriveøkter: [{ start, end, place, events }] – begivenhederne grupperet efter 'start'. */
  function sessionsOf(events) {
    const out = [];
    let cur = null;
    for (const e of events) {
      if (e.kind === 'start' || !cur) {
        cur = { start: e.ts, end: e.ts, place: (e.detail && e.detail.place) || '', events: [] };
        out.push(cur);
        if (e.kind === 'start') continue;
      }
      cur.events.push(e);
      if (e.kind !== 'afleveret') cur.end = Math.max(cur.end, e.ts, (e.detail && Number(e.detail.last)) || 0);
    }
    return out;
  }

  /** Skrivning pr. minut i en økt: [{ ts, added, removed, paste }] fra første til sidste minut (højst 120 søjler). */
  function minutesOf(sess) {
    const M = 60_000;
    const first = Math.floor(sess.start / M) * M, last = Math.floor(sess.end / M) * M;
    const span = Math.max(1, Math.round((last - first) / M) + 1);
    const step = Math.ceil(span / 120) * M; // lange økter: 2, 3 … minutter pr. søjle
    const bins = [];
    for (let t = first; t <= last; t += step) bins.push({ ts: t, added: 0, removed: 0, paste: 0 });
    const at = (ts) => bins[Math.min(bins.length - 1, Math.max(0, Math.floor((ts - first) / step)))];
    for (const e of sess.events) {
      if (e.kind === 'skrivning') { const b = at(e.ts); b.added += (e.detail && e.detail.added) || e.chars || 0; b.removed += (e.detail && e.detail.removed) || 0; }
      if (e.kind === 'indsat') at(e.ts).paste += e.chars || 0;
    }
    return { bins, step };
  }

  function render(ctx, log, opts = {}) {
    const { h } = ctx;
    const s = log.summary || {};
    const word = s.source === 'word';
    const root = h('div', { class: 'slog' });
    root.append(h('h3', { text: 'Skrivelog' }));
    if (s.expired) {
      root.append(h('p', { class: 'muted small', text: 'Skrivelogen er slettet efter skolens frist. Kun minuttallene er tilbage.' }));
      return root;
    }
    root.append(h('p', { class: 'slog-sum', text: summaryText(s) }));
    const extra = [];
    if (s.typed != null) extra.push(`${n(s.typed)} tegn tastet, ${n(s.deleted)} slettet`);
    if (word) extra.push('skrevet i Word');
    if (s.started) extra.push(`startet ${day(s.started)} kl. ${clock(s.started)}`);
    if (s.submitted) extra.push(`afleveret ${day(s.submitted)} kl. ${clock(s.submitted)}`);
    if (extra.length) root.append(h('p', { class: 'muted small', text: extra.join(' · ') }));
    root.append(h('p', { class: 'muted small', text: 'Indsatte udsnit er ikke i sig selv bevis for snyd – tal med eleven.' }));

    // Indsatte udsnit: klokkeslæt, grund og selve teksten
    const pastes = log.pastes || [];
    root.append(h('h4', { text: 'Indsatte udsnit' }));
    if (!pastes.length) {
      root.append(h('p', { class: 'small', text: word ? 'Ingen tekst er kommet ind i dokumentet uden at være skrevet i Word.' : 'Ingen tekst er kommet ind i dokumentet uden at være tastet.' }));
    } else {
      root.append(h('ol', { class: 'slog-list' }, ...pastes.map((p, i) => h('li', {},
        h('div', { class: 'small' }, h('b', { text: `kl. ${clock(p.ts)}` }), ` · ${n(p.chars)} tegn` + (REASON[p.reason] ? ` · ${REASON[p.reason]}` : '')),
        h('blockquote', { class: 'slog-paste', 'aria-label': `Indsat udsnit ${i + 1}`, text: p.excerpt }),
        opts.seek ? h('button', { class: 'btn small', type: 'button', text: 'Vis i afspilningen', onclick: () => opts.seek(p.ts) }) : null))));
    }

    // Forløbet pr. skriveøkt
    root.append(h('h4', { text: 'Forløb' }));
    const sessions = sessionsOf(log.events || []);
    if (sessions.length) root.append(h('p', { class: 'muted small', text: 'Søjlerne viser skrevne og slettede tegn pr. minut. Indsat tekst er brun.' }));
    if (!sessions.length) root.append(h('p', { class: 'small muted', text: 'Der er ingen skrivelog for dette dokument. Den findes kun for dokumenter skrevet, efter skrivelogen kom til.' }));
    sessions.forEach((sess, i) => root.append(renderSession(h, sess, i, sessions.length, word)));
    return root;
  }

  function renderSession(h, sess, i, count, word) {
    const where = sess.place === 'hjemme' ? ' · hjemme' : sess.place === 'lektion' ? ' · i timen' : '';
    const box = h('section', { class: 'slog-session', 'aria-label': `Skriveøkt ${i + 1}` });
    box.append(h('h5', { text: `${count > 1 ? `Skriveøkt ${i + 1}: ` : ''}${day(sess.start)} kl. ${clock(sess.start)}–${clock(sess.end)}${where}` }));
    // Søjlediagram: skrivning pr. minut (tekst-alternativ: aria-label og en tabel)
    const { bins, step } = minutesOf(sess);
    const max = Math.max(1, ...bins.map(b => b.added + b.removed + b.paste));
    const total = bins.reduce((a, b) => a + b.added, 0), peak = Math.max(0, ...bins.map(b => b.added));
    const per = step > 60_000 ? `${step / 60_000} minutter` : 'minut';
    if (bins.some(b => b.added || b.removed || b.paste)) {
      box.append(h('div', { class: 'slog-chart', role: 'img', 'aria-label': `Skrivning pr. ${per} fra kl. ${clock(bins[0].ts)} til ${clock(bins[bins.length - 1].ts)}: ${n(total)} tegn skrevet, højst ${n(peak)} tegn på et ${per === 'minut' ? 'minut' : 'interval'}.` },
        ...bins.map(b => {
          const t = b.added + b.removed;
          return h('span', { class: 'slog-bar', title: `kl. ${clock(b.ts)}: ${n(b.added)} skrevet, ${n(b.removed)} slettet` + (b.paste ? `, ${n(b.paste)} indsat` : '') },
            t ? h('span', { class: 'slog-seg', style: `height:${Math.max(4, Math.round(t / max * 100))}%` }) : null,
            b.paste ? h('span', { class: 'slog-seg paste', style: `height:${Math.max(4, Math.round(b.paste / max * 100))}%` }) : null);
        })));
      const rows = bins.filter(b => b.added || b.removed || b.paste);
      box.append(h('details', { class: 'slog-table' }, h('summary', { class: 'small', text: 'Vis som tabel' }),
        h('table', { class: 'report-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Kl.' }), h('th', { scope: 'col', text: 'Skrevet' }), h('th', { scope: 'col', text: 'Slettet' }), h('th', { scope: 'col', text: 'Indsat' }))),
          h('tbody', {}, ...rows.map(b => h('tr', {}, h('td', { text: clock(b.ts) }), h('td', { text: n(b.added) }), h('td', { text: n(b.removed) }), h('td', { text: b.paste ? n(b.paste) : '' })))))));
    }
    // Begivenhederne (skrivning pr. minut står i diagrammet)
    const items = sess.events.filter(e => e.kind !== 'skrivning').map(e => eventItem(h, e, word)).filter(Boolean);
    if (items.length) box.append(h('ol', { class: 'slog-events' }, ...items));
    return box;
  }

  function eventItem(h, e, word) {
    const t = h('span', { class: 't', text: `kl. ${clock(e.ts)}` });
    const d = e.detail || {};
    switch (e.kind) {
      case 'indsat':
        return h('li', { class: 'warn' }, t, `Indsat udsnit: ${n(e.chars)} tegn (se Indsatte udsnit)`);
      case 'rettelse':
        return h('li', {}, h('details', {}, h('summary', {}, t, `Rettelse: ${n(e.chars)} tegn fjernet` + (d.replaced ? ` og erstattet med ${n(d.replaced)} tegn` : '')),
          h('blockquote', { class: 'slog-removed', text: e.excerpt || '' })));
      case 'flyttet':
        return h('li', {}, t, `${n(e.chars)} tegn flyttet eller kopieret fra et andet sted i teksten`);
      case 'blokeret':
        return h('li', {}, t, word ? `Udklipsholderen blev tømt (tekst fra et andet program)${d.n > 1 ? ` – ${n(d.n)} gange` : ''}` : `Indsæt blev blokeret${d.n > 1 ? ` (${n(d.n)} gange)` : ''}`);
      case 'lampe': {
        const between = Array.isArray(d.between) ? ` mellem kl. ${clock(d.between[0])} og ${clock(d.between[1])}` : '';
        return h('li', { class: d.color === 'red' ? 'red' : '' }, t, (LAMP[d.color] || 'Lampen skiftede') + between + (d.why ? `: ${d.why}` : ''));
      }
      case 'slut':
        return h('li', { class: 'muted' }, t, 'Skriveøkten slutter');
      case 'afleveret':
        return h('li', {}, t, h('b', { text: 'Afleveret' }));
      default:
        return null;
    }
  }

  window.HM.skrivelog = { render, summaryText, duration, sessionsOf, minutesOf };
})();
