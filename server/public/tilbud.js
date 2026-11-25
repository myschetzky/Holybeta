/* HolyMoly – tilbud på en skolelicens (til rektor/økonomi). Beregnes i browseren og udskrives eller gemmes som PDF.
 * Felterne kan fyldes ud via adressen: /tilbud?skole=...&elever=300&aar=1&ean=...&kontakt=... */
(function () {
  'use strict';
  const S = window.HM_SITE || {};
  const $ = (id) => document.getElementById(id);
  const kr = (n) => (Math.round(n * 100) / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr.';
  const fmtDate = (d) => d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
  let price = Object.assign({ perStudent: 129, minimum: 2500, trialDays: 30 }, S.pricing || {});
  let company = (S.info && S.info.company) || {};
  const qs = new URLSearchParams(location.search);
  const today = new Date();

  // Fast tilbudsnummer for denne visning (dato + tilfældige tegn)
  const rnd = (crypto.getRandomValues(new Uint32Array(1))[0] % 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  const number = 'T-' + today.toISOString().slice(0, 10).replace(/-/g, '') + '-' + rnd;

  const inputs = { school: $('q-school'), contact: $('q-contact'), students: $('q-students'), years: $('q-years'), ean: $('q-ean'), start: $('q-start') };
  if (qs.get('skole')) inputs.school.value = qs.get('skole').slice(0, 120);
  if (qs.get('kontakt')) inputs.contact.value = qs.get('kontakt').slice(0, 100);
  if (/^\d{1,5}$/.test(qs.get('elever') || '')) inputs.students.value = qs.get('elever');
  if (['1', '2', '3'].includes(qs.get('aar'))) inputs.years.value = qs.get('aar');
  if (/^\d{13}$/.test(qs.get('ean') || '')) inputs.ean.value = qs.get('ean');

  function row(cells) {
    const tr = document.createElement('tr');
    cells.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c; if (i) td.className = 'num'; tr.append(td); });
    return tr;
  }

  function render() {
    const n = Math.max(1, Math.min(20000, Math.round(Number(inputs.students.value) || 0)));
    const years = Number(inputs.years.value) || 1;
    const yearly = n * price.perStudent;
    const lines = [];
    lines.push(row([`HolyMoly skolelicens, ${years === 1 ? '1 år' : years + ' år'} – elever`, String(n * years), kr(price.perStudent), kr(yearly * years)]));
    let sub = yearly * years;
    if (yearly < price.minimum) {
      const diff = (price.minimum - yearly) * years;
      lines.push(row([`Tillæg op til mindstepris (${kr(price.minimum)} pr. år)`, '', '', kr(diff)]));
      sub += diff;
    }
    $('q-lines').replaceChildren(...lines);
    $('q-sub').textContent = kr(sub);
    $('q-vat').textContent = kr(sub * 0.25);
    $('q-total').textContent = kr(sub * 1.25);

    $('q-no').textContent = number;
    $('q-date').textContent = fmtDate(today);
    const valid = new Date(today); valid.setDate(valid.getDate() + 30);
    $('q-valid').textContent = fmtDate(valid);

    $('q-to-school').textContent = inputs.school.value.trim() || '[Skolens navn]';
    $('q-to-contact').textContent = inputs.contact.value.trim() ? 'Att.: ' + inputs.contact.value.trim() : '';
    const ean = inputs.ean.value.replace(/\D/g, '');
    $('q-to-ean').textContent = ean ? 'EAN ' + ean : '';

    const start = inputs.start.value ? new Date(inputs.start.value + 'T12:00:00') : null;
    if (start) {
      const end = new Date(start); end.setFullYear(end.getFullYear() + years); end.setDate(end.getDate() - 1);
      $('q-period').textContent = `Licensperiode: ${fmtDate(start)} – ${fmtDate(end)}. Faktureres forud.`;
    } else {
      $('q-period').textContent = `Licensperiode: ${years === 1 ? '12 måneder' : years * 12 + ' måneder'} fra aktivering. Faktureres forud.`;
    }
    const abs = (p) => (/^https?:/.test(location.protocol) ? new URL(p, location.href).href : p);
    $('q-legal').textContent = `Vilkår og databehandleraftale: ${abs(S.pages ? 'vilkaar.html' : '/vilkaar')} og ${abs(S.pages ? 'databehandleraftale.html' : '/databehandleraftale')}.`;

    const from = [company.name || 'HolyMoly', company.cvr ? 'CVR ' + company.cvr : '', company.address, company.email].filter(Boolean);
    $('q-from').replaceChildren(...from.slice(1).map(t => { const d = document.createElement('div'); d.textContent = t; return d; }));
    document.title = 'Tilbud ' + number + (inputs.school.value.trim() ? ' – ' + inputs.school.value.trim() : '');
  }

  for (const el of Object.values(inputs)) el.addEventListener('input', render);
  $('q-print').addEventListener('click', () => { render(); window.print(); });

  if (S.pages) render();
  else {
    render();
    Promise.all([fetch('/api/pricing').then(r => r.json()).catch(() => null), fetch('/api/info').then(r => r.json()).catch(() => null)])
      .then(([p, i]) => { if (p) price = Object.assign(price, p); if (i && i.company) company = i.company; render(); });
  }
})();
