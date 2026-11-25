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
  const KIND = { klasse: 'I timen', ekstra: 'I timen', hjemme: 'Hjemme, uden opsyn (et lavere niveau end i timen)' };
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
    // Uden id: upload først – træk filerne (eller Lectios zip) ind og find beviserne
    if (!id) { $('loading').hidden = true; $('find').hidden = false; return; }
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
      const OBS = { skrivevindue: 'skrivevinduet', word: 'Word', taster: 'tastetryk i Word (kun antal)', vagt: 'vagten' };
      $('observed').textContent = obs.map(x => OBS[x] || x).join(' og ') || '–';
      $('observed-text').hidden = false;
      const word = obs.includes('word');
      const where = word ? 'Word-dokumentet (skrevet i Word gennem HolyMoly)' : 'HolyMolys skrivevindue';
      // Word er et lavere niveau end skrivevinduet: uden talte tastetryk så HolyMoly kun, hvordan teksten voksede
      const level = !word ? '' : obs.includes('taster')
        ? ' Tastetrykkene i Word blev talt og forklarer teksten. Word er stadig et lavere niveau end skrivevinduet.'
        : ' Tastetrykkene blev ikke talt – HolyMoly så kun, hvordan teksten voksede. Det er et lavere niveau end skrivevinduet.';
      $('observed-text').textContent = (obs.includes('vagt')
        ? `${where} og HolyMoly-vagten på computeren blev fulgt.`
        : `Kun ${where} blev fulgt. Resten af computeren blev ikke overvåget af HolyMoly-vagten.`) + level;
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
    $('file').addEventListener('change', () => pick($('file').files));
    const drop = $('drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      pick(e.dataTransfer && e.dataTransfer.files);
    });
  }

  /** Én Word-fil tjekkes mod dette bevis. Flere filer eller en zip tjekkes i tabellen nedenfor. */
  function pick(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    if (files.length === 1 && !/\.zip$/i.test(files[0].name)) return checkFile(files[0]);
    $('find').hidden = false;
    checkMany(files);
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
    while (lines.length && /^(✓ Tastet i HolyMoly|✓ Tastet i Word via HolyMoly|HolyMoly HM-|Dækker skriveforløbet|Mærket viser, hvad HolyMoly målte|Testserver – må ikke bruges|HolyMoly skrive-bevis|Tjek beviset)/.test(lines[lines.length - 1])) lines.pop();
    // Med og uden titlen øverst, og med og uden "•" / "1." fra Word-lister
    const unmark = (v) => v.map(l => l.replace(/^(•|\d+\.)(\s+|$)/, '')).filter(Boolean);
    const variants = [];
    for (const v of [lines, lines.slice(1)]) for (const x of [v, unmark(v)]) { const s = HMDoc.normalizeText(x.join('\n')); if (s && !variants.includes(s)) variants.push(s); }
    try {
      const hit = await firstMatch(variants);
      show(!!hit, { text: hit || variants[0] || '' });
    } catch (e) { fail(e.message); }
  }

  /* ---------- Mange filer: upload først, opslag på serveren ud fra tekstens sha256 ---------- */
  const MAX_FILES = 200;

  /** Pak en zip (fx fra Lectio) ud til dens .docx-filer: [{ name, bytes }]. */
  async function docxFromZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const names = HMDoc.zipNames(bytes).filter(n => /\.docx$/i.test(n) && !/(^|\/)(__MACOSX\/|~\$|\.)/.test(n));
    const out = [];
    for (const n of names.slice(0, MAX_FILES)) out.push({ name: n.split('/').pop(), bytes: await HMDoc.readZipEntry(bytes, n, inflateRaw, 30 * 1024 * 1024) });
    return out;
  }

  /** Læs en Word-fil lokalt: tekstens varianter, deres sha256 og mærket i sidefoden (kun det, filen påstår). */
  async function readDocx(bytes) {
    const xml = await HMDoc.readZipEntry(bytes, 'word/document.xml', inflateRaw);
    if (!xml) throw new Error('Ikke en Word-fil (.docx)');
    const doc = HMDoc.docxText(new TextDecoder().decode(xml));
    const hashes = [];
    for (const v of doc.variants) if (v) hashes.push(await sha256(v));
    let foot = { mark: '', code: '', url: '' };
    for (const n of HMDoc.zipNames(bytes).filter(n => /^word\/footer\d*\.xml$/.test(n))) {
      const f = HMDoc.docxFooter(new TextDecoder().decode(await HMDoc.readZipEntry(bytes, n, inflateRaw)));
      if (f.code || f.mark) { foot = f; break; }
    }
    return { hashes, foot };
  }

  async function lookup(hashes) {
    const r = await fetch('/api/bevis/find', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256: hashes }) });
    const x = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(x.error || 'Serveren svarede ikke');
    return x.found || [];
  }

  function cell(text, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (text instanceof Node) td.append(text); else td.textContent = text;
    return td;
  }

  /** Én række: fil (eller elevens navn for elevens egen lærer), mærke, teksten passer, udstedt her – og evt. en advarsel. */
  function row(name, res) {
    const tr = document.createElement('tr');
    const first = document.createElement('div');
    first.textContent = name;
    if (res.hit && res.hit.student) {
      const who = document.createElement('div');
      who.className = 'muted small';
      who.textContent = res.hit.student + (res.hit.class ? ' · ' + res.hit.class : '');
      first.append(who);
    }
    for (const w of res.warn || []) {
      const p = document.createElement('div');
      p.className = 'match warn small';
      p.textContent = w;
      first.append(p);
    }
    let mark;
    if (res.hit) {
      mark = document.createElement('div');
      mark.textContent = `${res.hit.mark} · ${res.hit.code} · ${fmtDate(res.hit.date)}`;
      if (res.hit.id) { const a = document.createElement('a'); a.href = '/bevis/' + res.hit.id; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' Se beviset'; mark.append(a); }
    } else mark = res.error || (res.foot && res.foot.mark ? 'Filen påstår: ' + res.foot.mark : 'Intet mærke');
    tr.append(cell(first), cell(mark),
      cell(res.error ? '–' : res.hit ? 'Ja' : res.foot && res.foot.code ? 'Nej' : '–', res.hit ? 'match ok' : res.foot && res.foot.code ? 'match bad' : ''),
      cell(res.error ? '–' : res.hit ? 'Ja' : 'Nej'));
    return tr;
  }

  async function checkOne(name, bytes) {
    try {
      const { hashes, foot } = await readDocx(bytes);
      const found = await lookup(hashes);
      // Den mest sandsynlige variant først (samme rækkefølge som docxText)
      const hit = hashes.map(h => found.find(f => f.sha256 === h)).find(Boolean) || null;
      const warn = [];
      let other = '';
      try { if (foot.url) { const u = new URL(foot.url); if (u.host !== location.host) other = u.host; } } catch (e) { /* ugyldigt link i sidefoden */ }
      if (other) warn.push(`Sidefoden peger på en anden server (${other}). Tjek filen dér.`);
      if (hit && foot.code && foot.code !== hit.code) warn.push(`Sidefoden har koden ${foot.code}, men teksten hører til ${hit.code}.`);
      if (!hit && foot.code && !other) warn.push(`Sidefoden har koden ${foot.code}, men teksten passer ikke til et bevis her. Den er ændret, eller koden er kopieret.`);
      return { hit, foot, warn };
    } catch (e) {
      return { error: e && e.message ? e.message : 'Filen kunne ikke læses' };
    }
  }

  async function checkMany(list) {
    const rows = $('many-rows');
    rows.replaceChildren();
    $('many-wrap').hidden = false;
    let done = 0, hits = 0, total = 0;
    const status = () => { $('many-status').textContent = `${done} af ${total} filer tjekket · ${hits} med bevis fra denne server`; };
    const items = [];
    for (const f of [...list]) {
      if (/\.zip$/i.test(f.name)) {
        try { for (const x of await docxFromZip(f)) items.push(x); } catch (e) { rows.append(row(f.name, { error: e.message || 'Zip-filen kunne ikke læses' })); }
      } else if (/\.docx$/i.test(f.name)) items.push({ name: f.name, file: f });
      else rows.append(row(f.name, { error: 'Ikke en Word-fil (.docx) eller zip' }));
      if (items.length >= MAX_FILES) break;
    }
    total = items.length;
    status();
    for (const it of items.slice(0, MAX_FILES)) {
      let res;
      if (it.file && it.file.size > 30 * 1024 * 1024) res = { error: 'Filen er for stor' };
      else res = await checkOne(it.name, it.bytes || new Uint8Array(await it.file.arrayBuffer()));
      if (res.hit) hits++;
      done++;
      rows.append(row(it.name, res));
      status();
    }
  }

  const many = $('many');
  many.addEventListener('change', () => { if (many.files.length) checkMany(many.files); });
  const mdrop = $('many-drop');
  mdrop.addEventListener('dragover', (e) => { e.preventDefault(); mdrop.classList.add('over'); });
  mdrop.addEventListener('dragleave', () => mdrop.classList.remove('over'));
  mdrop.addEventListener('drop', (e) => {
    e.preventDefault();
    mdrop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) checkMany(e.dataTransfer.files);
  });

  load();
})();
