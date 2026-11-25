'use strict';
/*
 * "Skriv i Word" – tekst-tjekket (ren logik, ingen Electron og ingen Word).
 *
 * Elev-appen læser Word-dokumentets tekst ca. hvert sekund (bridge.state()) og giver den til WordCheck.snapshot().
 * WordCheck afgør løbende, hvad muldvarpens skilt viser: grøn ✓, rød ✗ eller grå ?, og hvorfor.
 *
 *  - Indsat tekst udefra: teksten vokser i ét spring med mere ny tekst, end et menneske kan skrive
 *    (mere end 60 sammenhængende tegn på under 2 sek. – ved længere tid mellem to målinger 15 tegn/sek.).
 *    Tekst, der allerede har stået i dokumentet (flyttet, kopieret, fortrudt), er tilladt. Det afgøres med
 *    tre-ords-sekvenser fra alle de tekster, økten har set. Et spring er permanent: dokumentet får ikke mærket.
 *  - Tekst, der ikke er tastet: kan broen tælle tastetryk i Word-vinduet (snapshot.keys), skal ny tekst (tegn i ord, der
 *    ikke har stået i dokumentet før) kunne forklares af tastetrykkene – med samme margin som serveren til autokorrektur
 *    (D.wordKeyMargin: max(20 tegn, 3 %)). Fortryd, kopi og flyt af egen tekst kræver ingen tastetryk (tekst, der har stået i
 *    dokumentet, må komme igen). Kan tastetrykkene ikke forklare teksten, er muldvarpen rød – permanent, som et spring.
 *  - AI-spor: de ordrette chatbot-fraser fra shared/doc.js (aiTraces). Forsvinder, når teksten fjernes.
 *  - Copilot med tastetryk: 'on' = grå med en note (brug af Copilot fanges af tastetjekket), 'unknown' = grå, 'off' = intet.
 *    Uden tastetryk (keys: null): 'on' = rød, 'unknown' = grå, 'off' = intet.
 *  - Serveren: ingen forbindelse/ingen lektion = grå. Elevens egen lampe (my-lamp) og serverens prøve-vurdering
 *    (doc-saved.preview) tæller med, så skiltet siger det samme som serveren.
 *
 * Serveren har sine egne tjek (vækstbudget, lampe, AI-fraser) og udsteder beviset. Det her er elevens skilt
 * og det, appen melder til serveren (stats: pasteInserted, pasteBlocked, focusLostMs, copilot – og med tastetryk
 * keys: true, typed, deleted, restored, pasteKeys, injected, undo, keystrokes, tempoet og untyped). Tallene lægges oven i
 * tallene fra dokumentets tidligere økter (opts.base), så serveren altid får hele dokumentets tal.
 */
const D = require('../doc.js');

const BURST_CHARS = 60;   // så meget ny, sammenhængende tekst …
const BURST_MS = 2000;    // … på så kort tid er ikke skrevet af et menneske
const HUMAN_CPS = 15;     // ved længere tid mellem to målinger: højst 15 tegn/sek.
const MAX_GAP_MS = 5000;  // tid uden for Word tælles højst 5 sek. pr. måling
const SEEN_MAX = 300_000; // højst så mange tre-ords-sekvenser huskes

const WORD_RE = /[\p{L}\p{N}]+/gu;
const KEY_SUM = ['typed', 'deleted', 'pasteKeys', 'injected', 'undo', 'keystrokes'];
const KEY_MAX = ['maxCps', 'burst', 'fastShare'];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * Word-tekst (Range.Text) -> HolyMoly-blokke: ét afsnit pr. blok.
 * \r (afsnit) og \x07 (celle-slut) deler afsnit. Linjeskift (\v), sideskift (\f) og spalteskift (\x0e) er mellemrum,
 * som i Word-filen (<w:br/>). Andre kontroltegn (fodnotemærker, billeder, felttegn) fjernes.
 */
function wordTextToBlocks(raw) {
  const out = [];
  for (let line of String(raw || '').split(/[\r\n\x07]+/)) {
    line = line.replace(/[\v\f\x0e]/g, ' ').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    if (!line.trim()) continue;
    if (out.length >= D.LIMITS.blocks) break;
    out.push({ t: 'p', r: [{ x: line }] });
  }
  return out;
}
/** Den normaliserede tekst (samme som serveren og tjek-siden bruger). */
function wordText(raw) { return D.normalizeText(D.textOf(wordTextToBlocks(raw))); }

function tokens(text) {
  const out = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) out.push({ w: m[0].toLocaleLowerCase('da'), s: m.index, e: m.index + m[0].length });
  return out;
}
const key3 = (tk, i) => tk[i].w + ' ' + tk[i + 1].w + ' ' + tk[i + 2].w;

/** Kl. 10.14 (dansk) */
function clock(t) {
  try { return new Date(t).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' }).replace(':', '.'); } catch (e) { return ''; }
}

class WordCheck {
  /** opts: { burstChars, burstMs, humanCps, clock(t) -> 'hh.mm', base: stats fra dokumentets tidligere økter } */
  constructor(opts = {}) {
    this.base = opts.base && typeof opts.base === 'object' ? opts.base : null;
    this.keys = null;          // seneste tastetællere fra broen (denne økt) – kun tal
    this.keysAvail = null;     // null: ved ikke endnu, true: tælles, false: kan ikke tælles (resten af økten)
    this.novel = 0;            // ny tekst (tegn i ord, der ikke har stået i dokumentet) siden tællingen startede
    this.restored = 0;         // tekst, der kom igen (fortryd, kopi og flyt af egen tekst)
    this.untyped = [];         // [{ t, chars, paste }] – tekst, som tastetrykkene ikke kan forklare (permanent)
    this.missFlagged = 0;
    this.pasteSeen = 0;
    this.burstChars = opts.burstChars || BURST_CHARS;
    this.burstMs = opts.burstMs || BURST_MS;
    this.humanCps = opts.humanCps || HUMAN_CPS;
    this.clock = opts.clock || clock;
    this.seen = new Set();
    this.text = null;          // seneste normaliserede tekst
    this.lastT = 0;
    this.inserts = [];         // [{ t, chars }] – tekst indsat fra et andet program (permanent)
    this.outside = false;      // dokumentet var ændret uden for HolyMoly, da økten startede
    this.copilot = 'unknown';
    this.copilotWorst = '';    // det værste, økten har set: 'on' > 'unknown' > 'off'
    this.readError = '';
    this.foreground = true;
    this.focusLostMs = 0;
    this.activeMs = 0;
    this.cleared = 0;          // gange udklipsholderen blev tømt
    this.srv = { live: false, online: false, lamp: null, preview: null };
  }

  _learn(text) {
    if (this.seen.size > SEEN_MAX) return;
    const tk = tokens(text);
    for (let i = 0; i + 2 < tk.length; i++) this.seen.add(key3(tk, i));
    for (const t of tk) if (t.e - t.s >= 12) this.seen.add('1 ' + t.w); // lange enkeltord (fx en adresse)
  }

  /** Hvor lang er den længste sammenhængende stribe ny tekst (tegn) i cur, som ikke fandtes i det, økten har set? */
  novelRun(prev, cur) { return this._scan(prev, cur).run; }

  /**
   * Det ændrede område i cur (siden prev):
   *  run:   den længste sammenhængende stribe ny tekst (tegn)
   *  novel: tegn i tekst, der ikke har stået i dokumentet før (ord og mellemrum/tegn mellem to nye ord)
   *  known: tegn i tekst, der har stået i dokumentet før (ord og mellemrum/tegn mellem to kendte ord)
   *  Tegn uden et ord på begge sider (fx en streg "-----" eller mellemrummet mellem et nyt og et kendt ord) tæller ikke.
   */
  _scan(prev, cur) {
    const out = { run: 0, novel: 0, known: 0 };
    if (prev === cur) return out;
    let p = 0;
    const max = Math.min(prev.length, cur.length);
    while (p < max && prev[p] === cur[p]) p++;
    let s = 0;
    while (s < max - p && prev[prev.length - 1 - s] === cur[cur.length - 1 - s]) s++;
    const from = p, to = cur.length - s;
    if (to <= from) return out; // kun slettet
    const tk = tokens(cur);
    let best = 0, runStart = -1, runEnd = -1;
    const known = (i) => {
      if (tk[i].e - tk[i].s >= 12 && this.seen.has('1 ' + tk[i].w)) return true;
      for (let a = Math.max(0, i - 2); a <= i && a + 2 < tk.length; a++) if (this.seen.has(key3(tk, a))) return true;
      return false;
    };
    const inside = (i) => i < tk.length && tk[i].e > from && tk[i].s < to;
    let nextKnown = null; // known(i + 1), regnet ud én gang
    for (let i = 0; i < tk.length; i++) {
      if (!inside(i)) { nextKnown = null; if (runStart >= 0) { best = Math.max(best, runEnd - runStart); runStart = -1; } continue; }
      const kn = nextKnown != null ? nextKnown : known(i);
      nextKnown = inside(i + 1) ? known(i + 1) : null;
      const a = Math.max(tk[i].s, from);
      if (kn) {
        // Kendt ord: også mellemrummet til næste ord, hvis det også er kendt (en kopieret sætning tæller hele vejen)
        out.known += Math.max(0, Math.min(nextKnown === true ? tk[i + 1].s : tk[i].e, to) - a);
        if (runStart >= 0) { best = Math.max(best, runEnd - runStart); runStart = -1; }
        continue;
      }
      // Nyt ord: også mellemrummet til næste ord, hvis det også er nyt (det er tastet med mellemrumstasten)
      out.novel += Math.max(0, Math.min(nextKnown === false ? tk[i + 1].s : tk[i].e, to) - a);
      if (runStart < 0) runStart = tk[i].s;
      runEnd = tk[i].e;
    }
    if (runStart >= 0) best = Math.max(best, runEnd - runStart);
    // Tegn uden ord (fx en lang række tal-tegn eller symboler) tæller også, hvis hele ændringen er ny
    if (!tk.some(t => t.e > from && t.s < to)) best = Math.max(best, to - from > this.burstChars ? to - from : 0);
    out.run = best;
    return out;
  }

  /** Tælles tastetryk i hele dokumentet? (Denne økt kan tælle, og tidligere økter kunne også.) */
  keysCounted() { return this.keysAvail === true && !(this.base && this.base.keys === false); }

  /** Tastetællerne fra broen: et objekt (tællerne), null (kan ikke tælles) eller undefined (ved ikke endnu). */
  _keys(k) {
    if (k === undefined || this.keysAvail === false) return;
    if (k && typeof k === 'object') {
      this.keysAvail = true;
      const prev = this.keys || {};
      // Tællerne går kun opad i en økt
      const next = {};
      for (const f of [...KEY_SUM, ...KEY_MAX]) next[f] = Math.max(num(prev[f]), num(k[f]));
      next.regularity = k.regularity == null || !Number.isFinite(Number(k.regularity)) ? null : Number(k.regularity);
      this.keys = next;
    } else this.keysAvail = false; // tællingen er ikke komplet resten af økten
  }

  /**
   * Første måling i økten. expected: den tekst, HolyMoly sidst så i dokumentet (null for et nyt dokument).
   * Er der kommet ny tekst til, siden HolyMoly sidst så dokumentet, er det skrevet uden for HolyMoly.
   */
  start(raw, t = Date.now(), expected = null) {
    const text = wordText(raw);
    if (expected != null) {
      const exp = D.normalizeText(expected);
      this._learn(exp);
      if (this.novelRun(exp, text) > this.burstChars) this.outside = true;
    }
    this._learn(text);
    this.text = text;
    this.lastT = t;
    return this.status(t);
  }

  /** En måling fra Word: { t, text (Range.Text), copilot, foreground, error, keys } */
  snapshot(s) {
    const t = Number(s.t) || Date.now();
    if (s.error) { this.readError = String(s.error).slice(0, 160); return this.status(t); }
    this.readError = '';
    if (s.copilot === 'on' || s.copilot === 'off' || s.copilot === 'unknown') this.copilot = s.copilot;
    const rank = { '': 0, off: 1, unknown: 2, on: 3 };
    if (rank[this.copilot] > rank[this.copilotWorst]) this.copilotWorst = this.copilot;
    if ('keys' in s) this._keys(s.keys);
    if (this.text == null) { this.pasteSeen = this.keys ? this.keys.pasteKeys : 0; return this.start(s.text, t); }
    const dt = Math.max(0, t - this.lastT);
    if (s.foreground === false) this.focusLostMs += Math.min(dt, MAX_GAP_MS);
    else this.activeMs += Math.min(dt, MAX_GAP_MS);
    this.foreground = s.foreground !== false;
    const text = wordText(s.text);
    if (text !== this.text) {
      const sc = this._scan(this.text, text);
      const limit = Math.max(this.burstChars, this.humanCps * dt / 1000);
      if (sc.run > limit && this.inserts.length < 50) this.inserts.push({ t, chars: sc.run });
      const growth = text.length - this.text.length;
      if (this.keysAvail === true) {
        this.novel += sc.novel;
        if (growth > 0) this.restored += Math.min(growth, sc.known);
      } else if (growth > 0) this.restored += growth; // før tælleren var klar: kan ikke afgøres – tæller ikke imod
      if (this.keysCounted()) {
        // Kan tastetrykkene forklare den nye tekst? (Tællerne er læst efter teksten, så de er aldrig bagud.)
        const miss = this.novel - this.keys.typed;
        const margin = D.wordKeyMargin(text.length);
        const paste = this.keys.pasteKeys > this.pasteSeen;
        if (miss > margin && miss > this.missFlagged + margin && this.untyped.length < 50) {
          this.untyped.push({ t, chars: Math.round(miss), paste });
          this.missFlagged = miss;
        }
      }
      this._learn(text);
      this.text = text;
    }
    if (this.keys) this.pasteSeen = this.keys.pasteKeys;
    this.lastT = t;
    return this.status(t);
  }

  /** Serverens side: { live, online, lamp: { color, reason }, preview: { ok, categories } }. Felter, der mangler, beholdes. */
  server(info) {
    if (!info || typeof info !== 'object') return this.status();
    for (const k of ['live', 'online', 'lamp', 'preview']) if (k in info) this.srv[k] = info[k];
    return this.status();
  }

  /** Udklipsholderen blev tømt (tekst fra et andet program). */
  clipboardCleared() { this.cleared++; }

  /** Har teksten stået i dokumentet i denne økt? (Til udklipsholderen: kopi fra Word er tilladt.) */
  knows(raw) {
    const text = D.normalizeText(raw);
    if (!text) return true;
    if (this.text && this.text.includes(text)) return true;
    const tk = tokens(text);
    if (!tk.length) return text.length <= 20;
    if (tk.length < 3) return tk.every(t => (this.text || '').toLocaleLowerCase('da').includes(t.w));
    for (let i = 0; i + 2 < tk.length; i++) if (!this.seen.has(key3(tk, i))) return false;
    return true;
  }

  /**
   * Til serveren (doc.stats): kun tal og copilot-status – aldrig tekst og aldrig hvilke taster.
   * Lagt oven i dokumentets tidligere økter (base). keys: true kun, når tastetryk er talt i hele dokumentet.
   */
  stats() {
    const b = this.base || {};
    const rank = { '': 0, off: 1, unknown: 2, on: 3 };
    const mine = this.copilotWorst || this.copilot;
    const out = {
      pasteInserted: num(b.pasteInserted) + this.inserts.length, pasteBlocked: num(b.pasteBlocked) + this.cleared,
      focusLostMs: Math.round(num(b.focusLostMs) + this.focusLostMs), activeMs: Math.round(num(b.activeMs) + this.activeMs),
      copilot: (rank[b.copilot] || 0) > (rank[mine] || 0) ? b.copilot : mine,
    };
    if (this.keysAvail === null && !('keys' in b)) return out; // ingen oplysninger om tastetryk endnu
    out.keys = this.keysCounted();
    if (!out.keys) return out;
    const k = this.keys;
    for (const f of KEY_SUM) out[f] = num(b[f]) + k[f];
    out.restored = Math.round(num(b.restored) + this.restored);
    out.untyped = num(b.untyped) + this.untyped.length;
    for (const f of KEY_MAX) out[f] = Math.max(num(b[f]), k[f]);
    const regs = [b.regularity, k.regularity].filter(x => x != null && Number.isFinite(Number(x))).map(Number);
    out.regularity = regs.length ? Math.min(...regs) : null; // den mest jævne (værste) økt
    return out;
  }

  /**
   * Skiltet: { color: 'green'|'red'|'grey', symbol: '✓'|'✗'|'?', text, notes: [] }.
   * text er en hel sætning (tooltip og aria-live), fx 'Rød: tekst indsat fra et andet program kl. 10.14'.
   */
  status() {
    const notes = [];
    // En note, der siger det samme som skiltet, vises ikke to gange
    const out = (color, text) => ({ color, symbol: color === 'green' ? '✓' : color === 'red' ? '✗' : '?', text, notes: notes.filter(n => text !== 'Grå: ' + n) });
    const clean = (x) => String(x || '').trim().replace(/[.…\s]+$/u, '').slice(0, 160);
    const pv = this.srv.preview;
    const cats = pv && Array.isArray(pv.categories) ? pv.categories : [];
    const short = cats.find(c => c.key === 'kort');
    if (short) notes.push(short.text);
    const keys = this.keysCounted();
    if (this.keysAvail === false) notes.push(D.WORD_NO_KEYS + '.');
    else if (this.keysAvail === true && !keys) notes.push('Tastetryk blev ikke talt, da dokumentet blev påbegyndt. Det vurderes uden tastetryk.');
    if (this.copilot === 'on' && keys) notes.push(D.WORD_COPILOT_ON + '.');
    if (this.untyped.length) notes.push('Fx indsat, Copilot, diktering eller autotekst.');
    if (this.inserts.length || this.untyped.length) notes.push('Dokumentet kan ikke få mærket. Du kan skrive et nyt dokument eller gemme dette uden mærke.');
    if (this.inserts.length) return out('red', `Rød: tekst indsat fra et andet program kl. ${this.clock(this.inserts[0].t)}`);
    if (this.untyped.length) {
      const u = this.untyped[0];
      return out('red', u.paste ? `Rød: tekst indsat med Ctrl+V, som ikke er tastet, kl. ${this.clock(u.t)}` : `Rød: der er kommet tekst, som ikke er tastet, kl. ${this.clock(u.t)}`);
    }
    if (this.outside) return out('red', 'Rød: dokumentet er ændret uden for HolyMoly');
    // Uden tastetryk kan HolyMoly ikke se, om Copilot er brugt. Med tastetryk fanges brugen af tastetjekket.
    if (this.copilot === 'on' && !keys) return out('red', "Rød: Word's AI (Copilot) er slået til");
    const ai = this.text ? D.aiTraces(this.text) : [];
    if (ai.length) return out('red', 'Rød: ' + ai[0]);
    const lamp = this.srv.lamp;
    if (this.srv.live && this.srv.online && lamp && lamp.color === 'red') return out('red', `Rød: ${clean(lamp.reason) || 'Et forbudt program'} er åben. Luk det.`);
    const bad = cats.find(c => c.key !== 'kort');
    if (bad) return out('red', 'Rød: ' + clean(bad.text));
    if (!this.srv.live) return out('grey', 'Grå: Ingen lektion eller skriveøkt. Det, du skriver nu, tæller ikke med.');
    if (!this.srv.online) return out('grey', 'Grå: Ingen forbindelse til HolyMoly. Skriv videre – teksten gemmes i Word.');
    if (this.readError) return out('grey', 'Grå: HolyMoly kan ikke læse dokumentet i Word lige nu.');
    if (this.text == null) return out('grey', 'Grå: Venter på Word.');
    if (this.copilot === 'on') return out('grey', 'Grå: ' + D.WORD_COPILOT_ON + '.');
    if (this.copilot !== 'off') return out('grey', "Grå: HolyMoly kan ikke se, om Word's AI (Copilot) er slået fra. Spørg skolens IT.");
    if (!lamp || !lamp.color) return out('grey', 'Grå: Venter på HolyMoly.');
    if (lamp.color !== 'green') return out('grey', `Grå: ${clean(lamp.reason) || 'Venter på HolyMoly'}.`);
    return out('green', 'Grøn – teksten tæller med');
  }
}

module.exports = { WordCheck, wordTextToBlocks, wordText, tokens, clock, BURST_CHARS, BURST_MS, HUMAN_CPS };
