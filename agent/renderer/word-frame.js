(function () {
  'use strict';
  /*
   * Rammen om Word: bjælken (titel, "Gemt kl." og "Tekst færdig"), muldvarpen med skiltet og boksen efter "Tekst færdig".
   * Alt andet i vinduet er gennemsigtigt, og musen går igennem til Word. Over bjælken, muldvarpen og boksene
   * beder siden hovedprocessen om at tage imod musen (hmword.interactive).
   */
  const $ = (id) => document.getElementById(id);
  const api = window.hmword;
  let view = null;
  let liveText = '';

  // Musen: kun bjælken, muldvarpen, boblen og boksen tager imod klik
  let over = 0;
  for (const el of document.querySelectorAll('.hit')) {
    el.addEventListener('pointerenter', () => { over++; api.interactive(true); });
    el.addEventListener('pointerleave', () => { over = Math.max(0, over - 1); if (!over) api.interactive(false); });
  }

  function li(text) { const x = document.createElement('li'); x.textContent = text; return x; }

  function render(v) {
    view = v || {};
    const bar = view.bar || {};
    $('title').textContent = bar.title || 'Dokument';
    $('saved').textContent = bar.error ? bar.error : (bar.saved || '');
    $('saved-sep').hidden = !(bar.error || bar.saved);
    $('done').disabled = !!view.busy || !!(view.panel && view.panel.kind === 'busy');
    $('done').textContent = view.busy ? 'Tjekker …' : 'Tekst færdig';
    $('bar').hidden = !view.bar;

    // Skiltet
    const st = view.status || { color: 'grey', symbol: '?', text: 'Grå: Venter på Word.', notes: [] };
    const color = st.color === 'green' || st.color === 'red' ? st.color : 'grey';
    $('mole-svg').setAttribute('data-color', color);
    $('mole').title = st.text;
    $('mole').setAttribute('aria-label', 'Muldvarpen: ' + st.text);
    $('mole').hidden = !view.status;
    $('bubble-text').textContent = st.text;
    $('bubble-sym').textContent = st.symbol || { green: '✓', red: '✗', grey: '?' }[color];
    $('bubble-notes').replaceChildren(...(st.notes || []).map(li));
    $('bubble').className = 'bubble hit ' + color;
    if (st.text !== liveText) { liveText = st.text; $('live').textContent = st.text; }

    // Boksen
    const p = view.panel;
    $('panel').hidden = !p;
    if (p) {
      $('panel').className = 'panel hit ' + (p.kind || '');
      $('panel').setAttribute('aria-modal', p.actions && p.actions.length ? 'true' : 'false');
      $('p-title').textContent = p.title || '';
      $('p-text').textContent = p.text || '';
      $('p-mark').hidden = !p.mark;
      $('p-mark').textContent = p.mark || '';
      $('p-items').replaceChildren(...(p.items || []).map(li));
      $('p-note').hidden = !p.note;
      $('p-note').textContent = p.note || '';
      const btns = (p.actions || []).map((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.dataset.action = a.id;
        b.addEventListener('click', () => { b.disabled = true; api.action(a.id); });
        return b;
      });
      const key = JSON.stringify((p.actions || []).map(a => a.id)) + p.title;
      if ($('p-actions').dataset.key !== key) {
        $('p-actions').dataset.key = key;
        $('p-actions').replaceChildren(...btns);
        const first = btns.find(b => b.classList.contains('primary')) || btns[0];
        if (first) setTimeout(() => first.focus(), 0);
      }
      api.interactive(true);
    } else {
      $('p-actions').dataset.key = '';
      if (!over) api.interactive(false);
    }
  }

  $('done').addEventListener('click', () => { if (!$('done').disabled) api.action('done'); });
  // Klik på muldvarpen: boblen med årsagen
  $('mole').addEventListener('click', () => { $('bubble').hidden = !$('bubble').hidden; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('bubble').hidden) $('bubble').hidden = true;
      else if (view && view.panel && view.panel.actions && view.panel.actions.some(a => a.id === 'continue')) api.action('continue');
      else if (view && view.panel && view.panel.actions && view.panel.actions.some(a => a.id === 'close')) api.action('close');
    }
  });

  api.onView(render);
  api.view().then((v) => { if (v) render(v); });
  render(null);
})();
