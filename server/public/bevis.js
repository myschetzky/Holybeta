'use strict';
/*
 * Offentligt tjek af et HolyMoly-skrivebevis. Alt indsættes som tekst (aldrig HTML).
 * Siden siger først, at beviset er ægte, når teksten er sammenlignet: et bevis gælder én bestemt tekst.
 * Word-filen læses i browseren (zip + word/document.xml) og sendes ingen steder hen.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const id = (location.pathname.match(/^\/bevis\/([A-Za-z0-9_-]{16})$/) || [])[1];
  const fmt = (ts) => new Date(ts).toLocaleString('da-DK', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const WORD_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  const PLACE = { lektion: 'I timen', hjemme: 'Hjemme uden opsyn', 'lektion og hjemme': 'I timen og hjemme uden opsyn' };
  // v3: kind. Ekstra tid efter timen vises som "I timen" (forlængelsen står aldrig på beviset).
  const KIND = { klasse: 'I timen', ekstra: 'I timen', hjemme: 'Hjemme' };
  const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; };

  async function sha256(text) {
    if (!(window.crypto && crypto.subtle)) throw new Error('Din browser kan kun tjekke teksten over en sikker forbindelse (https).');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function fact(dl, k, v) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }

  function verdict(cls, text) {
    const v = $('verdict');
    v.className = 'proof-head' + (cls ? ' ' + cls : '');
    v.textContent = text;
  }

  let p = null;
  let notMine = false; // en indlogget lærer ser et bevis, der tilhører en anden lærers elev

  async function load() {
    if (!id) { $('loading').hidden = true; $('missing').hidden = false; return; }
    let c;
    try {
      const r = await fetch('/api/bevis/' + id, { credentials: 'same-origin' });
      // 410: id'et er udstedt her, men beviset er udløbet efter skolens frist
      if (r.status === 410) {
        const x = await r.json().catch(() => ({}));
        $('loading').hidden = true;
        $('expired').hidden = false;
        if (x.created) $('expired-text').textContent = `Beviset blev udstedt her ${fmt(x.created)}, men skolens frist for at gemme det er nået.`;
        return;
      }
      if (!r.ok) throw new Error();
      c = await r.json();
    } catch (e) { $('loading').hidden = true; $('missing').hidden = false; return; }
    $('loading').hidden = true;
    $('proof').hidden = false;
    // Gravsten: teksten er slettet efter skolens frist, men beviset gælder stadig
    if (c.docDeleted && c.valid && !c.legacy) {
      $('deleted').hidden = false;
      $('deleted').textContent = `Beviset er gyldigt. Skolen har slettet teksten efter sin frist (${fmt(c.docDeleted)}). Upload filen for at tjekke den.`;
    }
    const dl = $('facts');
    if (c.owner) {
      $('owner').hidden = false;
      fact($('owner-facts'), 'Elev', c.owner.student || '–');
      fact($('owner-facts'), 'Klasse', c.owner.class || '–');
      if (c.owner.title) fact($('owner-facts'), 'Titel', c.owner.title);
    }

    // Ældre bevis (med navne i klartekst): kun gyldig/ugyldig og dato
    if (c.legacy) {
      verdict(c.valid ? 'ok' : 'bad', c.valid ? '✓ Signaturen er gyldig (ældre bevis)' : '✗ Signaturen passer ikke – beviset er ikke gyldigt');
      $('mark').hidden = true;
      $('observed').textContent = 'Står ikke i dette ældre bevis';
      fact(dl, 'Afleveret', fmt(c.submitted));
      $('check-wrap').hidden = true;
      $('checks').replaceChildren();
      $('checks').previousElementSibling.hidden = true;
      $('limits').textContent = 'Et ældre bevis viser kun, at det er udstedt af HolyMoly, og hvornår teksten blev afleveret. Teksten kan ikke tjekkes her.';
      $('tech').hidden = true;
      return;
    }

    p = c.payload;
    notMine = !!c.notMine;
    const v3 = p.v === 3;
    if (p.test === true || /Testserver/.test(String(p.issuer || ''))) $('testserver').hidden = false;
    if (!c.valid) {
      verdict('bad', '✗ Signaturen passer ikke – beviset er ikke gyldigt');
      $('check-wrap').hidden = true;
    } else {
      verdict('', 'Beviset findes – tjek at teksten passer');
    }
    $('mark').textContent = v3 ? HMDoc.label(p.kind, { observed: Array.isArray(p.observed) ? p.observed : [], test: p.test === true }) : HMDoc.label(p.place);
    fact(dl, 'Kode', 'HM-' + p.id.slice(0, 8).toUpperCase());
    fact(dl, 'Afleveret', fmt(p.submitted));
    fact(dl, 'Omfang', `${p.words} ord`);
    fact(dl, 'Skrevet', v3 ? (KIND[p.kind] || String(p.kind || '–')) : (PLACE[p.place] || String(p.place || '–')));
    fact(dl, 'Udstedt af', String(p.issuer || '–'));
    $('checks').replaceChildren(...(p.checks || []).map(t => { const li = document.createElement('li'); li.textContent = t; return li; }));
    // Hvad betyder mærket: forbeholdet, hvad der blev målt og hvornår afleveringen blev oprettet
    $('limit-text').textContent = HMDoc.LIMIT_TEXT;
    if (v3) {
      const obs = (Array.isArray(p.observed) ? p.observed : []).map(String);
      $('observed').textContent = obs.join(' og ') || '–';
      $('observed-text').hidden = false;
      $('observed-text').textContent = obs.includes('vagt')
        ? 'HolyMolys skrivevindue og HolyMoly-vagten på computeren blev fulgt.'
        : 'Kun HolyMolys skrivevindue blev fulgt. Resten af computeren blev ikke overvåget af HolyMoly-vagten.';
      const d = fmtDate(p.assignmentCreated);
      if (d) { $('asg-created').hidden = false; $('asg-created').textContent = `Skrevet til en aflevering oprettet ${d}.`; }
      $('limits').hidden = true;
    } else {
      $('observed').textContent = 'Står ikke i dette ældre bevis';
      $('limits').textContent = p.limits || '';
    }
    $('keyid').textContent = p.keyId;
    $('signed').textContent = c.signed + '\n\nSignatur (Ed25519, base64): ' + c.sig;
    $('pubkey').textContent = c.publicKey;

    let t;
    $('text').addEventListener('input', () => { clearTimeout(t); t = setTimeout(checkPasted, 250); });
    $('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) checkFile(f); });
    const drop = $('drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) checkFile(f);
    });
  }
  // En fil sluppet ved siden af feltet må ikke åbne filen i browseren
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /** Pak "deflate"-data ud med browserens egen DecompressionStream (ingen eksterne biblioteker). */
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Vis resultatet: overskrift, linje under feltet og hvad der blev sammenlignet. */
  function show(ok, info) {
    // Passer teksten, men tilhører beviset en anden lærers elev, siges det i gult
    const warn = ok && notMine;
    verdict(warn ? 'warn' : ok ? 'ok' : 'bad', warn ? '✓ Passer – men tilhører ikke en af dine elever' : ok ? '✓ Teksten passer til beviset' : '✗ Teksten passer IKKE');
    const out = $('match');
    out.hidden = false;
    out.className = 'match ' + (warn ? 'warn' : ok ? 'ok' : 'bad');
    out.textContent = warn ? 'Teksten er præcis den, beviset gælder for. Beviset er udstedt til en elev, der ikke er en af dine.' : ok ? 'Teksten er præcis den, beviset gælder for.' : 'Teksten er ikke den samme som i beviset. Den er ændret, eller noget mangler.';
    const dl = $('file-facts');
    dl.replaceChildren();
    if (!info) { dl.hidden = true; return; }
    const words = info.text.match(WORD_RE) || [];
    if (info.name) fact(dl, 'Fil', info.name);
    if (info.title) fact(dl, 'Titel i filen', info.title);
    fact(dl, 'Antal ord', `${words.length} i teksten · ${p.words} i beviset`);
    if (words.length) {
      fact(dl, 'Begynder', words.slice(0, 8).join(' ') + (words.length > 8 ? ' …' : ''));
      if (words.length > 8) fact(dl, 'Slutter', '… ' + words.slice(-8).join(' '));
    }
    dl.hidden = false;
  }

  function fail(msg) {
    verdict('', 'Beviset findes – tjek at teksten passer');
    const out = $('match');
    out.hidden = false;
    out.className = 'match bad';
    out.textContent = msg;
    $('file-facts').hidden = true;
  }

  async function firstMatch(variants) {
    for (const v of variants) if ((await sha256(v)) === p.sha256) return v;
    return null;
  }

  async function checkFile(file) {
    if (!p) return;
    $('drop-text').textContent = file.name;
    try {
      if (!/\.docx$/i.test(file.name)) throw new Error('Vælg en Word-fil (.docx).');
      if (file.size > 30 * 1024 * 1024) throw new Error('Filen er for stor.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const xml = await HMDoc.readZipEntry(bytes, 'word/document.xml', inflateRaw);
      if (!xml) throw new Error('Filen er ikke en Word-fil (.docx).');
      // Samme normalisering som da beviset blev udstedt (HMDoc.normalizeText)
      const doc = HMDoc.docxText(new TextDecoder().decode(xml));
      const hit = await firstMatch(doc.variants);
      show(!!hit, { name: file.name, title: doc.title, text: hit || doc.text });
    } catch (e) {
      fail(e && e.message ? e.message : 'Filen kunne ikke læses.');
    }
  }

  async function checkPasted() {
    if (!p) return;
    const raw = $('text').value;
    if (!raw.trim()) { $('match').hidden = true; $('file-facts').hidden = true; verdict('', 'Beviset findes – tjek at teksten passer'); return; }
    const lines = HMDoc.normalizeText(raw).split('\n');
    // Sidefoden fra Word-filen er ikke en del af teksten
    while (lines.length && /^(✓ Tastet i HolyMoly|Dækker skriveforløbet|Mærket viser, hvad HolyMoly målte|Testserver – må ikke bruges|HolyMoly skrive-bevis|Tjek beviset)/.test(lines[lines.length - 1])) lines.pop();
    // Med og uden titlen øverst, og med og uden "•" / "1." fra Word-lister
    const unmark = (v) => v.map(l => l.replace(/^(•|\d+\.)(\s+|$)/, '')).filter(Boolean);
    const variants = [];
    for (const v of [lines, lines.slice(1)]) for (const x of [v, unmark(v)]) { const s = HMDoc.normalizeText(x.join('\n')); if (s && !variants.includes(s)) variants.push(s); }
    try {
      const hit = await firstMatch(variants);
      show(!!hit, { text: hit || variants[0] || '' });
    } catch (e) { fail(e.message); }
  }

  load();
})();
