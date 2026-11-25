(function () {
  'use strict';
  /*
   * "Skriv i Word" i skrivevinduet: knapperne ved siden af skrivevinduets egne. Holdes i sin egen fil, så write.js
   * næsten ikke ændres. Knapperne vises kun, når Word-broen siger supported og Word findes.
   *  - Øverst: "Skriv i Word" og "Min HolyMoly".
   *  - Afleveringer: "Skriv i Word" ved hver aflevering (li[data-asg] fra write.js).
   *  - Skrivetime: "Skriv i Word" under banneret.
   */
  const api = window.hmw;
  if (!api || !api.wordInfo) return;
  const $ = (id) => document.getElementById(id);
  let available = false;
  let toastT;
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 4000);
  }
  function button(text, cls) { const b = document.createElement('button'); b.type = 'button'; b.className = cls || 'btn'; b.textContent = text; return b; }
  async function startWord(b, assignmentId) {
    b.disabled = true;
    const r = await api.word(assignmentId);
    b.disabled = false;
    toast(r && r.ok ? 'Word åbner. Tryk "Tekst færdig" i HolyMoly-bjælken, når du er færdig.' : ((r && r.error) || 'Word kunne ikke åbne'));
    if (r && r.ok && $('asg') && $('asg').open) $('asg').close();
  }

  // Øverst i skrivevinduet
  const top = button('Skriv i Word');
  top.id = 'word-new';
  top.hidden = true;
  top.addEventListener('click', () => startWord(top, 0));
  const mineBtn = button('Min HolyMoly');
  mineBtn.id = 'word-mine';
  mineBtn.addEventListener('click', () => api.mine());
  const anchor = $('new');
  if (anchor) anchor.after(top, mineBtn);

  // Afleveringer: én "Skriv i Word" pr. aflevering
  function decorate() {
    if (!available) return;
    for (const li of document.querySelectorAll('#asg-list li[data-asg]')) {
      if (li.querySelector('.word-btn')) continue;
      const row = li.querySelector('.row');
      const first = row && row.querySelector('button');
      if (!row || !first) continue;
      const b = button('Skriv i Word', 'btn word-btn');
      b.disabled = first.disabled;
      b.title = first.title;
      b.addEventListener('click', () => startWord(b, Number(li.dataset.asg)));
      first.after(b);
    }
  }
  if ($('asg-list')) new MutationObserver(decorate).observe($('asg-list'), { childList: true });

  // Skrivetime: valget under banneret
  const choice = document.createElement('div');
  choice.className = 'notice write-lesson';
  choice.id = 'word-choice';
  choice.hidden = true;
  const choiceText = document.createElement('span');
  choiceText.textContent = 'Du kan også skrive opgaven i Word. ';
  const choiceBtn = button('Skriv i Word');
  choice.append(choiceText, choiceBtn);
  if ($('write-banner')) $('write-banner').after(choice);
  let lessonAsg = 0;
  choiceBtn.addEventListener('click', () => startWord(choiceBtn, lessonAsg));
  function setLesson(w) {
    lessonAsg = w && w.assignmentId ? Number(w.assignmentId) : 0;
    choice.hidden = !(available && lessonAsg);
  }
  api.onWriteLesson(setLesson);

  api.wordInfo().then((i) => {
    available = !!(i && i.available);
    top.hidden = !available;
    decorate();
    return api.wordWriteLesson();
  }).then(setLesson).catch(() => {});
})();
