/*
 * HolyMoly-dokumenter ("Skriv i HolyMoly") – fælles for server, elev-app og lærer-dashboard.
 *
 *  - Dokumentformat: blokke i stedet for HTML (kan ikke indeholde scripts):
 *      [{ t: 'p'|'h1'|'h2'|'ul'|'ol', r: [{ x: 'tekst', b: 1, i: 1, u: 1 }] }]
 *    ul/ol er ét punkt hver; punkter efter hinanden er én liste.
 *  - normalizeText(): den tekst skrive-beviset dækker (samme resultat overalt).
 *  - aiTraces(): ordrette chatbot-fraser i teksten (lokalt, ingen API). Kun hårde spor – aldrig gæt.
 *    aiHints(): svagere spor (fx at teksten nævner ChatGPT). Kun til læreren – aldrig et afslag.
 *  - label(place, { observed, test }): mærket på et dokument med bevis. Samme tekst overalt.
 *  - footerLines(mark, words): sidefodens linjer med mærket (toDocx og forseglede Word-dokumenter).
 *  - toDocx(): Word-fil (.docx) uden eksterne biblioteker.
 *  - readZipEntry() / docxText(): læs teksten i en .docx (bruges på tjek-siden i browseren).
 *  - zipNames() / docxFooter(): filerne i en zip (Lectio) og mærket i en Word-fils sidefod (tjek-siden).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMDoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = new Set(['p', 'h1', 'h2', 'ul', 'ol']);
  const LIMITS = { blocks: 3000, runs: 300, chars: 200_000, title: 120 };

  /** Strikt validering af et dokument fra elev-appen. Kaster ved ugyldigt input. */
  function validateBlocks(input) {
    if (!Array.isArray(input)) throw new Error('Ugyldigt dokument');
    if (input.length > LIMITS.blocks) throw new Error('Dokumentet er for langt');
    let total = 0;
    const out = [];
    for (const b of input) {
      if (!b || typeof b !== 'object' || !TYPES.has(b.t) || !Array.isArray(b.r)) throw new Error('Ugyldigt dokument');
      if (b.r.length > LIMITS.runs) throw new Error('Ugyldigt dokument');
      const runs = [];
      for (const r of b.r) {
        if (!r || typeof r.x !== 'string') throw new Error('Ugyldigt dokument');
        // Ingen kontroltegn (undtagen tab), ingen usynlige retnings-tegn
        const x = r.x.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
        total += x.length;
        if (total > LIMITS.chars) throw new Error('Dokumentet er for langt');
        if (!x) continue;
        const run = { x };
        if (r.b) run.b = 1;
        if (r.i) run.i = 1;
        if (r.u) run.u = 1;
        runs.push(run);
      }
      out.push({ t: b.t, r: runs });
    }
    return out;
  }

  /** Ren tekst: én linje pr. blok. */
  function textOf(blocks) {
    return blocks.map(b => b.r.map(r => r.x).join('')).join('\n');
  }

  /** Den tekst beviset gælder for: NFC, ens mellemrum, ingen tomme linjer. Bruges også på tjek-siden. */
  function normalizeText(text) {
    return String(text || '').normalize('NFC').replace(/\r\n?/g, '\n')
      .split('\n').map(l => l.replace(/[\s ​]+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  function wordCount(text) {
    const m = String(text || '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu);
    return m ? m.length : 0;
  }

  /*
   * Ordrette fraser fra en AI-chat. Kun sætninger, en elev ikke skriver selv om sin egen opgave.
   * (At afgøre om en tekst "lyder som AI" kan ikke gøres sikkert – det gør HolyMoly derfor ikke.
   *  Beviset bygger på skriveforløbet; dette er et ekstra tjek for åbenlyse spor.)
   * Kun disse giver afslag. En ærlig tekst om AI må gerne nævne ChatGPT eller bruge overskrifter.
   */
  const TRACES = [
    [/\bjeg er (en|bare en) (ai|sprogmodel|chatbot|kunstig intelligens)\b/i, 'Teksten indeholder "jeg er en AI/sprogmodel"'],
    [/\bas an ai( language model)?\b/i, 'Teksten indeholder "as an AI language model"'],
    [/\bi(?:'|’)?m (just )?an ai\b/i, 'Teksten indeholder "I\'m an AI"'],
    [/\b(as of|pr\.?) (my|min) (last )?(knowledge (cutoff|update)|vidensopdatering|træningsdata)\b/i, 'Teksten henviser til en AI-models "vidensgrænse"'],
    [/^\s*(regenerate response|generér svar igen|copy code|kopiér kode)\s*$/im, 'Teksten indeholder knap-tekst fra en AI-chat'],
  ];
  /* Svagere spor: vises for læreren som en oplysning. Giver aldrig afslag. */
  const HINTS = [
    [/\bsom (en )?(ai|kunstig intelligens|sprogmodel)\b[^.\n]{0,40}\b(kan jeg|har jeg|er jeg|jeg)\b/i, 'Teksten indeholder "som en AI/sprogmodel … jeg" (kan være et citat)'],
    [/\b(chatgpt|openai|claude\.ai|gemini\.google|perplexity\.ai|copilot\.microsoft)\b.{0,30}\b(sagde|skrev|svarede|said|wrote)\b/i, 'Teksten nævner, hvad en AI-chat sagde'],
    [/^\s*(#{1,4} |\*\*[^*\n]{2,60}\*\*\s*$)/m, 'Teksten indeholder Markdown-tegn (### / **fed**)'],
  ];
  function aiTraces(text) {
    const t = String(text || '');
    const out = [];
    for (const [re, why] of TRACES) if (re.test(t)) out.push(why);
    return out;
  }
  function aiHints(text) {
    const t = String(text || '');
    const out = [];
    for (const [re, why] of HINTS) if (re.test(t)) out.push(why);
    return out;
  }

  /*
   * Grænserne for skrive-beviset. De er offentlige (SIKKERHED.md): at skjule dem ville være teater.
   * Eleven ser stadig kun kategorier – aldrig sine egne tal.
   */
  const PROOF = {
    MIN_WORDS: 100,           // kortere tekster får ikke et bevis
    MAX_HUMAN_CPS: 15,        // vedvarende tegn/sek (5 sek. vindue)
    MAX_BURST: 30,            // tegn inden for ét sekund
    MAX_FAST_SHARE: 0.25,     // andel tastetryk hurtigere end en finger kan (< 12 ms)
    MIN_REGULARITY: 0.25,     // variationskoefficient for tastetryk – lavere = maskinelt jævnt
    MAX_DICTATED_SHARE: 0.10, // mere dikteret tekst end dette kan ikke bevises som tastet
    WORD_KEY_MARGIN: 20,      // Word: så mange tegn må teksten have ud over tastetrykkene (autokorrektur) …
    WORD_KEY_SHARE: 0.03,     // … eller 3 % af teksten, hvis det er mere
    MAX_INJECTED: 20,         // Word: flere taster sendt af et program (autotyper, makro) end dette giver 'tempo'
  };
  /** Word: hvor meget tekst ud over tastetrykkene der godtages (autokorrektur, autoformat). */
  function wordKeyMargin(len) {
    return Math.max(PROOF.WORD_KEY_MARGIN, Math.ceil(PROOF.WORD_KEY_SHARE * (Number(len) > 0 ? Number(len) : 0)));
  }
  /* Word med tastestatistik: tekst, der ikke kan forklares af tastetryk (samme tekst i muldvarpen, hos læreren og eleven) */
  const WORD_UNTYPED = 'Der er kommet tekst i Word, som ikke er tastet (fx indsat, Copilot, diktering eller autotekst)';
  const WORD_NO_KEYS = 'Tastetryk kan ikke tælles på denne computer';
  const WORD_COPILOT_ON = 'Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket';
  /* Hvorfor beviset mangler – i elevens sprog og uden tal (kort: se categoryText). Rækkefølgen er den, eleven ser. */
  const CATEGORY_TEXT = {
    kort: `Teksten er for kort. Et bevis kræver mindst ${PROOF.MIN_WORDS} ord.`,
    rod: 'Lampen var rød, mens du skrev.',
    forbindelse: 'HolyMoly kunne ikke følge hele skriveforløbet (grå lampe eller ingen forbindelse).',
    indsat: 'Der er tekst, som ikke er tastet i HolyMoly.',
    tempo: 'Skrivetempoet ligner ikke et menneskes.',
    ai: 'Teksten indeholder en ordret sætning fra en AI-chat.',
    hjaelpemiddel: 'Diktering kan ikke bevises som tastet. Aflever alligevel – du får ingen ulempe.',
  };
  /* Samme kategorier for et dokument skrevet i Word (kun dem, der lyder anderledes) */
  const CATEGORY_TEXT_WORD = { indsat: WORD_UNTYPED + '.' };
  const AIDS = ['ordforslag', 'diktering'];
  /** Elevens hjælpemidler: kun de kendte, i fast rækkefølge. */
  function cleanAids(v) {
    const list = Array.isArray(v) ? v.map(String) : [];
    return AIDS.filter(a => list.includes(a));
  }

  /*
   * Den del af vurderingen, der kun bygger på teksten og elevens egne tal fra skrivevinduet.
   * Bruges af serveren (docs.evaluate) og lokalt af øvedokumentet i skrivevinduet.
   * Lampen, forbindelsen og serverens eget vækst-tjek ligger kun hos serveren.
   * opts: { minWords, aids: ['ordforslag', 'diktering'], word }. Med hjælpemidler bliver jævnhed, byger og hurtige tastetryk til noter.
   * word: dokumentet er skrevet i Word gennem HolyMoly. Med stats.keys === true (appen talte tastetryk i Word-vinduet)
   * gælder tastetjekkene med en margin til autokorrektur (wordKeyMargin); ellers kun vækst, indsat tekst og Copilot-reglen.
   * Returnerer { reasons, notes, cats: [nøgle, …], found: [{ cat, why }] } – reasons/notes er til læreren, cats til eleven.
   */
  function evaluateStats(text, stats, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const s = stats && typeof stats === 'object' ? stats : {};
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const t = String(text || '');
    const minWords = Number(o.minWords) > 0 ? Number(o.minWords) : PROOF.MIN_WORDS;
    const aids = cleanAids(o.aids).length > 0;
    const word = !!o.word; // Word via HolyMoly
    // Word: tastetryk tælles kun, når elev-appen kunne tælle dem i hele dokumentet (stats.keys === true).
    // Ellers findes der ingen tastestatistik – kun hvordan teksten voksede – og de gamle regler gælder.
    const keys = !word || s.keys === true;
    const reasons = [], notes = [], cats = [], found = [];
    const no = (cat, why) => { reasons.push(why); found.push({ cat, why }); if (!cats.includes(cat)) cats.push(cat); };
    // Med hjælpemidler er tempo-fund kun en oplysning (ordforslag og diktering giver ujævne byger)
    const tempo = (why) => { if (aids) notes.push(why + ' – eleven har hjælpemidler, så skrivetempoet vurderes ikke'); else no('tempo', why); };
    if (wordCount(t) < minWords) no('kort', `Teksten er for kort til et bevis (mindst ${minWords} ord)`);
    if (n(s.pasteInserted) > 0) no('indsat', word ? 'Der er indsat tekst fra et andet program i Word' : 'Der er indsat tekst, som ikke er tastet');
    if (!word) {
      // Tastet minus slettet (plus fortrudt) skal kunne forklare teksten
      if (n(s.typed) - n(s.deleted) + n(s.restored) + 20 < t.length) no('indsat', 'Der er mere tekst, end der er tastet');
    } else if (keys) {
      // Word: tastet minus slettet (plus tekst, der har stået i dokumentet før: fortryd, kopi og flyt af egen tekst)
      // skal kunne forklare teksten – med plads til autokorrektur. untyped: appen så det undervejs (muldvarpen blev rød).
      const short = n(s.typed) - n(s.deleted) + n(s.restored) + wordKeyMargin(t.length) < t.length;
      if (short || n(s.untyped) > 0) {
        no('indsat', WORD_UNTYPED);
        if (n(s.pasteKeys) > 0) no('indsat', `Der er brugt Ctrl+V (${Math.round(n(s.pasteKeys))} gange), og teksten voksede mere, end tastetrykkene kan forklare`);
      }
      if (n(s.injected) > PROOF.MAX_INJECTED) tempo(`Taster sendt af et program (${Math.round(n(s.injected))} taster, fx en autotyper eller makro)`);
    } else notes.push(WORD_NO_KEYS + ' – teksten er vurderet uden tastestatistik');
    if (keys && n(s.maxCps) > PROOF.MAX_HUMAN_CPS) no('tempo', `Skrevet hurtigere end et menneske kan (${Math.round(n(s.maxCps))} tegn/sek.)`);
    if (keys && n(s.burst) > PROOF.MAX_BURST) tempo(`${Math.round(n(s.burst))} tegn kom på under ét sekund (et program, ikke et menneske)`);
    if (keys && n(s.keystrokes) >= 200 && n(s.fastShare) > PROOF.MAX_FAST_SHARE) tempo('Mange tastetryk kom hurtigere, end en finger kan trykke');
    if (keys && s.regularity != null && n(s.keystrokes) >= 300 && n(s.regularity) < PROOF.MIN_REGULARITY) tempo('Tastetrykkene kom i et maskinelt jævnt tempo');
    // Diktering kan ikke bevises som tastet: over 10 % dikteret tekst giver den neutrale kategori 'hjaelpemiddel'
    if (t.length > 0 && n(s.dictated) / t.length > PROOF.MAX_DICTATED_SHARE) no('hjaelpemiddel', `Over ${Math.round(PROOF.MAX_DICTATED_SHARE * 100)} % af teksten er dikteret (hjælpemiddel)`);
    else if (n(s.dictated) > 0) notes.push(`${Math.round(n(s.dictated))} tegn er dikteret (hjælpemiddel)`);
    if (n(s.predicted) > 0) notes.push(`${Math.round(n(s.predicted))} tegn kom fra ordforslag (hjælpemiddel)`);
    for (const x of aiTraces(t)) no('ai', x);
    // Copilot slået til: med tastetryk fanges BRUG af Copilot af tastetjekket (tekst uden tastetryk) – kun en note.
    // Uden tastetryk kan HolyMoly ikke se, om Copilot er brugt: afslag.
    if (word && s.copilot === 'on' && keys) notes.push(WORD_COPILOT_ON + ' (tjekket med tastetryk) – kun en oplysning, ikke et afslag');
    if (word && s.copilot === 'on' && !keys) no('ai', "Word's AI (Copilot) var slået til, mens teksten blev skrevet");
    if (word && s.copilot === 'unknown') notes.push("HolyMoly kunne ikke se, om Word's AI (Copilot) var slået fra – kun en oplysning, ikke et afslag");
    for (const x of aiHints(t)) notes.push(x + ' – kun en oplysning, ikke et afslag');
    if (n(s.pasteBlocked) + n(s.dropBlocked) > 0) notes.push(word ? `Udklipsholderen blev tømt ${n(s.pasteBlocked) + n(s.dropBlocked)} gange (tekst fra et andet program)` : `${n(s.pasteBlocked) + n(s.dropBlocked)} forsøg på at indsætte tekst blev blokeret`);
    return { reasons, notes, cats, found };
  }

  /*
   * Mærket på et dokument med bevis. Det siger præcis, hvad HolyMoly har målt, og intet mere:
   * at teksten er tastet i HolyMoly uden indsat tekst, om det skete i timen eller hjemme,
   * om kun skrivevinduet blev fulgt (ingen HolyMoly-vagt på computeren) – og om beviset kommer fra en testserver.
   * place: 'lektion' | 'klasse' | 'ekstra' | 'hjemme' | 'lektion og hjemme' (v2: place, v3: kind). Ukendt sted: intet sted i mærket.
   * opts: { observed: ['skrivevindue' | 'word', 'vagt'?], test } fra et v3-bevis ('word' = skrevet i Word via HolyMoly). Uden observed (v2 og ældre) er teksten som før.
   */
  const MARK = '\u2713 Tastet i HolyMoly \u2013 intet indsat';
  // Skrevet i Word gennem HolyMoly ("Skriv i Word", observed indeholder 'word')
  const WORD_MARK = '\u2713 Tastet i Word via HolyMoly \u2013 intet indsat';
  // "Tjek altid teksten på linket" står på alle mærker: en sidefod og en kode kan kopieres – teksten kan ikke
  const LIMIT_TEXT = 'M\u00e6rket viser, hvad HolyMoly m\u00e5lte p\u00e5 elevens computer. Det d\u00e6kker ikke afskrift fra telefon eller papir, og en computer, eleven selv har \u00e6ndret, eller en maskine, der taster som et menneske, kan ikke udelukkes. Mangler m\u00e6rket, er det ikke et tegn p\u00e5 snyd. Tjek altid teksten p\u00e5 linket.';
  const TEST_TEXT = 'Testserver \u2013 m\u00e5 ikke bruges til bed\u00f8mmelse.';
  function label(place, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const p = String(place || '');
    const v3 = Array.isArray(o.observed);
    const word = v3 && o.observed.includes('word');
    let s = word ? WORD_MARK : MARK;
    // Hjemme er et lavere niveau end i timen: ingen lærer var til stede
    if (p) s += ' \u00b7 ' + (/hjemme/.test(p) ? (v3 ? 'hjemme, uden opsyn' : 'hjemme uden opsyn') : 'i timen');
    if (v3 && !o.observed.includes('vagt')) s += word ? ' \u00b7 kun Word' : ' \u00b7 kun skrivevinduet';
    if (o.test) s += ' \u00b7 TESTSERVER';
    return s;
  }
  /** Grønt mærke kun i timen, når vagten var med og beviset ikke er fra en testserver. Ellers gråt (fx hjemme, uden opsyn). */
  function markGreen(mark) {
    if (!mark || mark.test) return false;
    if (/hjemme/.test(String(mark.place || mark.kind || ''))) return false;
    return !Array.isArray(mark.observed) || mark.observed.includes('vagt');
  }

  /**
   * Sidefodens linjer i en Word-fil med mærket – de samme i HolyMolys egen Word-fil (toDocx) og i et dokument,
   * der er skrevet og forseglet i Word ("Skriv i Word"). mark: { code, url, place, observed, test }, words: antal ord.
   * [0] mærket, [1] koden og tjek-linket, [2] forbeholdet og antal ord, [3] kun fra en testserver.
   */
  function footerLines(mark, words) {
    if (!mark || !mark.code) return [];
    const out = [
      label(mark.place, { observed: mark.observed, test: mark.test }),
      `HolyMoly ${mark.code}${mark.url ? '  \u00b7  Tjek: ' + mark.url : ''}`,
      `${LIMIT_TEXT} ${Number(words) || 0} ord.`,
    ];
    if (mark.test) out.push(TEST_TEXT);
    return out;
  }

  /* ---------------------------------------------------------------- .docx ---------------------------------------------------------------- */
  const enc = (s) => new TextEncoder().encode(s);
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** Minimal ZIP (uden komprimering) – nok til en .docx. */
  function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of files) {
      const nameB = enc(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameB.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true); dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
      local.set(nameB, 30);
      parts.push(local, data);
      const cen = new Uint8Array(46 + nameB.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
      cen.set(nameB, 46);
      central.push(cen);
      offset += local.length + data.length;
    }
    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  function runXml(r, extra) {
    const props = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (r.u ? '<w:u w:val="single"/>' : '') + (extra || '');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.x)}</w:t></w:r>`;
  }

  /**
   * Word-dokument (.docx).
   * meta: { title, author, mark: { code, url, place, observed, test } – mærket i sidefoden (se label()), readOnly: skrivebeskyttet }
   * Mærket er grønt (15803D) med vagt og gråt (6B7280) uden vagt eller fra en testserver. En testserver får en ekstra linje.
   * Skrivebeskyttelsen i Word kan slås fra af en, der vil; om teksten er ændret, afgøres altid på tjek-siden (url).
   */
  function toDocx(blocks, meta = {}) {
    let n = 0;
    const paras = [];
    if (meta.title) paras.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runXml({ x: meta.title })}</w:p>`);
    for (const b of blocks) {
      if (b.t !== 'ol') n = 0;
      const style = b.t === 'h1' ? 'Heading1' : b.t === 'h2' ? 'Heading2' : '';
      const prefix = b.t === 'ul' ? '\u2022 ' : b.t === 'ol' ? (++n) + '. ' : '';
      const ind = b.t === 'ul' || b.t === 'ol' ? '<w:ind w:left="360" w:hanging="360"/>' : '';
      const pPr = style || ind ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${ind}</w:pPr>` : '';
      paras.push(`<w:p>${pPr}${prefix ? runXml({ x: prefix }) : ''}${b.r.map(r => runXml(r)).join('')}</w:p>`);
    }
    const mark = meta.mark && meta.mark.code ? meta.mark : null;
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const footerRef = mark ? '<w:footerReference w:type="default" r:id="rId3"/>' : '';
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${paras.join('')}<w:sectPr>${footerRef}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    // Sidefod på hver side: mærket · HolyMoly HM-XXXX · Tjek: <link>, og på næste linje forbeholdet og antal ord
    const words = wordCount(normalizeText(textOf(blocks)));
    const lines = footerLines(mark, words);
    const markText = mark ? lines[0] : '';
    const markColor = markGreen(mark) ? '15803D' : '6B7280';
    const footer = mark ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="0"/></w:pPr>`
      + runXml({ x: markText, b: 1 }, `<w:color w:val="${markColor}"/><w:sz w:val="18"/>`)
      + runXml({ x: '  \u00b7  ' + lines[1] }, '<w:color w:val="6B7280"/><w:sz w:val="16"/>')
      + '</w:p><w:p>'
      + runXml({ x: lines[2] }, '<w:color w:val="6B7280"/><w:sz w:val="16"/>')
      + '</w:p>'
      + (lines[3] ? '<w:p>' + runXml({ x: lines[3], b: 1 }, '<w:color w:val="6B7280"/><w:sz w:val="16"/>') + '</w:p>' : '')
      + '</w:ftr>' : '';
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}>${meta.readOnly ? '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>' : ''}<w:defaultTabStop w:val="708"/></w:settings>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:lang w:val="da-DK"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(meta.title || '')}</dc:title><dc:creator>${xmlEsc(meta.author || '')}</dc:creator>${mark ? `<dc:description>${xmlEsc(markText + ' - HolyMoly ' + mark.code + (mark.url ? ' - ' + mark.url : '') + ' - ' + LIMIT_TEXT + (mark.test ? ' ' + TEST_TEXT : ''))}</dc:description>` : ''}</cp:coreProperties>`;
    const WM = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
    return zip([
      ['[Content_Types].xml', enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WM}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${WM}.styles+xml"/><Override PartName="/word/settings.xml" ContentType="${WM}.settings+xml"/>${mark ? `<Override PartName="/word/footer1.xml" ContentType="${WM}.footer+xml"/>` : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`)],
      ['_rels/.rels', enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')],
      ['word/_rels/document.xml.rels', enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${mark ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}</Relationships>`)],
      ['word/document.xml', enc(document)],
      ['word/styles.xml', enc(styles)],
      ['word/settings.xml', enc(settings)],
      ...(mark ? [['word/footer1.xml', enc(footer)]] : []),
      ['docProps/core.xml', enc(core)],
    ]);
  }

  /* ------------------------------------------------------ læs en .docx (tjek-siden) ------------------------------------------------------ */
  /**
   * Hent én fil fra en zip (fx word/document.xml fra en .docx). Læser zip'ens centrale katalog selv.
   * inflateRaw(bytes) -> Promise<Uint8Array> pakker "deflate"-data ud (browser: DecompressionStream('deflate-raw')).
   * Returnerer null, hvis filen ikke findes. Kaster ved en ødelagt eller for stor zip.
   */
  async function readZipEntry(bytes, name, inflateRaw, maxSize = 20 * 1024 * 1024) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Filen er ikke en Word-fil (.docx)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Word-filen er ødelagt');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const entry = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (entry !== name) continue;
      if (usize > maxSize || csize > maxSize) throw new Error('Filen er for stor');
      if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) throw new Error('Word-filen er ødelagt');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + csize);
      if (data.length !== csize) throw new Error('Word-filen er ødelagt');
      if (method === 0) return data;
      if (method === 8) {
        const out = await inflateRaw(data);
        if (out.length > maxSize) throw new Error('Filen er for stor');
        return out;
      }
      throw new Error('Word-filen bruger en ukendt komprimering');
    }
    return null;
  }

  const xmlUnesc = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const c = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(c); } catch (x) { return ''; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });

  /** Afsnittene i word/document.xml: [{ style, list, text }]. */
  function docxParagraphs(xml) {
    const out = [];
    const re = /<w:p(?=[\s>\/])[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
    let m;
    while ((m = re.exec(String(xml)))) {
      const inner = m[1] || '';
      const pPr = (inner.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/) || [''])[0];
      const style = (pPr.match(/<w:pStyle\b[^>]*\bw:val="([^"]*)"/) || [])[1] || '';
      const list = /<w:numPr\b|<w:ind\b[^>]*\bw:hanging="/.test(pPr);
      const body = inner.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, '');
      let text = '';
      const tre = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g;
      let t;
      while ((t = tre.exec(body))) text += t[1] != null ? xmlUnesc(t[1]) : t[2] === 'tab' ? '\t' : ' ';
      out.push({ style, list, text });
    }
    return out;
  }

  /**
   * Teksten i en .docx, normaliseret præcis som da beviset blev udstedt (normalizeText).
   * HolyMolys Word-fil har titlen øverst (typografien "Title") og "•" / "1." foran listepunkter –
   * de er ikke en del af den tekst, beviset dækker. variants: de mulige udgaver af teksten (den første er den mest sandsynlige).
   */
  function docxText(xml) {
    const ps = docxParagraphs(xml).map(p => Object.assign(p, { line: normalizeText(p.text) })).filter(p => p.line);
    const titleP = ps.find(p => /^(title|titel)$/i.test(p.style));
    const body = ps.filter(p => p !== titleP);
    const strip = (p) => (p.list ? p.line.replace(/^(\u2022|\d+\.)(\s+|$)/, '') : p.line);
    const variants = [];
    const add = (lines) => { const t = normalizeText(lines.join('\n')); if (!variants.includes(t)) variants.push(t); };
    add(body.map(strip)); add(body.map(p => p.line)); add(ps.map(strip)); add(ps.map(p => p.line));
    return { title: titleP ? titleP.line : '', text: variants[0], variants };
  }

  /** Navnene på filerne i en zip (fx en Lectio-zip med elevernes .docx). Læser det centrale katalog. */
  function zipNames(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Filen er ikke en zip-fil');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Zip-filen er ødelagt');
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      out.push(dec.decode(u8.subarray(p + 46, p + 46 + nlen)));
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  /**
   * Mærket i en Word-fils sidefod (word/footer*.xml): { mark, code, url }. Det er kun det, filen påstår –
   * tjek-siden sammenligner altid teksten med serveren, før der står grønt.
   */
  function docxFooter(xml) {
    const lines = docxParagraphs(xml).map(p => normalizeText(p.text)).filter(Boolean);
    // Koden kan stå i samme afsnit som mærket (HolyMolys egen Word-fil) – den er ikke en del af mærket
    const mark = (lines.find(l => /^\u2713 Tastet i (HolyMoly|Word via HolyMoly)/.test(l)) || '').replace(/\s*\u00b7\s*HolyMoly HM-[\s\S]*$/, '');
    let code = '', url = '';
    for (const l of lines) {
      const m = /HolyMoly (HM-[A-Z0-9_-]{8})/.exec(l);
      if (m && !code) code = m[1];
      const u = /Tjek: (https?:\/\/\S+)/.exec(l);
      if (u && !url) url = u[1];
    }
    return { mark, code, url };
  }

  return { validateBlocks, textOf, normalizeText, wordCount, aiTraces, aiHints, evaluateStats, cleanAids, PROOF, AIDS, CATEGORY_TEXT, CATEGORY_TEXT_WORD, wordKeyMargin, WORD_UNTYPED, WORD_NO_KEYS, WORD_COPILOT_ON, label, markGreen, footerLines, MARK, WORD_MARK, LIMIT_TEXT, TEST_TEXT, toDocx, readZipEntry, docxParagraphs, docxText, zipNames, docxFooter, LIMITS };
});
