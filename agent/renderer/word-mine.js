(function () {
  'use strict';
  // "Min HolyMoly": elevens dokumenter fra skrivevinduet og Word (listen bygges i agent/src/word/mine.js)
  const $ = (id) => document.getElementById(id);
  const api = window.hmmine;
  const fmt = (t) => (t ? new Date(t).toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  let toastT;
  function toast(msg) { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { $('toast').hidden = true; }, 4000); }

  async function run(btn, a, okText) {
    btn.disabled = true;
    const r = await api.action(a);
    btn.disabled = false;
    if (r && r.ok === false) toast(r.error || 'Det lykkedes ikke');
    else if (okText) toast(okText);
    return r;
  }

  async function render() {
    const s = await api.state();
    if (!s) return;
    $('new-word').hidden = !s.word.available;
    $('new-word').disabled = !!s.word.active;
    $('word-note').hidden = !s.word.active;
    $('word-note').textContent = 'Du har et Word-dokument åbent. Tryk "Tekst færdig" i Word, når du er færdig.';
    const ul = $('list');
    if (!s.items.length) { ul.replaceChildren(el('li', 'empty', 'Du har ingen dokumenter endnu.')); return; }
    ul.replaceChildren(...s.items.map((it) => {
      const li = el('li');
      li.dataset.key = it.key;
      const head = el('div', 'head');
      head.append(el('span', 't', it.title), el('span', 'src ' + it.source, it.sourceText), el('span', 'meta', [it.words ? it.words + ' ord' : '', fmt(it.updated)].filter(Boolean).join(' · ')));
      li.append(head, el('div', 'st ' + it.kind, it.status));
      if (it.attachedTo) li.append(el('div', 'muted', `Afleveret til "${it.attachedTo}"`));
      if (it.note) li.append(el('div', 'note', it.note));
      const row = el('div', 'row');
      for (const id of it.actions) {
        if (id === 'attach') {
          if (!it.targets.length) continue;
          const sel = el('select');
          sel.setAttribute('aria-label', 'Vælg aflevering til ' + it.title);
          for (const t of it.targets) { const o = el('option', null, t.text + (t.current ? ' – afleveret' : '')); o.value = t.id; sel.append(o); }
          const cur = it.targets.find(t => t.current);
          if (cur) sel.value = String(cur.id);
          const b = el('button', 'btn primary', s.texts.attach);
          b.type = 'button';
          b.addEventListener('click', () => run(b, { id: 'attach', key: it.key, assignmentId: Number(sel.value) }, 'Vedhæftet til afleveringen'));
          row.append(sel, b);
          continue;
        }
        const b = el('button', 'btn', s.texts[id] || id);
        b.type = 'button';
        b.dataset.action = id;
        b.addEventListener('click', () => run(b, { id, key: it.key }));
        row.append(b);
      }
      if (row.children.length) li.append(row);
      return li;
    }));
  }

  $('new-holymoly').addEventListener('click', () => api.action({ id: 'write' }));
  $('new-word').addEventListener('click', () => run($('new-word'), { id: 'word' }));
  api.onChange(render);
  render();
})();
