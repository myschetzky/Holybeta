'use strict';
/* Låst skærm. 'freeze': læreren har låst skærmen. 'review' (Gennemgang): standby med ur, dato og tid tilbage. */
(function () {
  const $ = (id) => document.getElementById(id);
  let state = { message: '', mode: 'freeze', endsAt: 0 };

  function minutesText(ms) {
    const min = Math.max(0, Math.ceil(ms / 60000));
    if (min >= 60) { const h = Math.floor(min / 60), m = min % 60; return h + ' t' + (m ? ' ' + m + ' min' : ''); }
    return min + (min === 1 ? ' minut' : ' minutter');
  }

  function tick() {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
    const d = now.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('date').textContent = d.charAt(0).toUpperCase() + d.slice(1);
    const left = state.endsAt - now.getTime();
    $('left-wrap').hidden = !state.endsAt;
    if (state.endsAt) {
      $('left').textContent = left > 0 ? minutesText(left) + ' tilbage af lektionen' : 'Lektionen er slut';
      // Bjælken viser hvor meget der er tilbage af hele lektionen
      const total = state.startedAt ? state.endsAt - state.startedAt : 0;
      $('bar').style.width = (total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 100) + '%';
    }
  }

  function render() {
    const review = state.mode === 'review';
    $('frozen').hidden = review;
    $('review').hidden = !review;
    $('msg').textContent = state.message;
    $('review-msg').textContent = state.message;
    document.title = review ? 'Gennemgang' : 'Skærmen er låst';
    if (review) tick();
  }

  window.freeze.onMessage((p) => { state = p; render(); });
  setInterval(() => { if (state.mode === 'review') tick(); }, 1000);
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
