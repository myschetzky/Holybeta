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
 *  - AI-spor: de ordrette chatbot-fraser fra shared/doc.js (aiTraces). Forsvinder, når teksten fjernes.
 *  - Copilot: 'on' = rød, 'unknown' = grå, 'off' = intet.
 *  - Serveren: ingen forbindelse/ingen lektion = grå. Elevens egen lampe (my-lamp) og serverens prøve-vurdering
 *    (doc-saved.preview) tæller med, så skiltet siger det samme som serveren.
 *
 * Serveren har sine egne tjek (vækstbudget, lampe, AI-fraser) og udsteder beviset. Det her er elevens skilt
 * og det, appen melder til serveren (stats: pasteInserted, pasteBlocked, focusLostMs, copilot).
 */
const D = require('../doc.js');

const BURST_CHARS = 60;   // så meget ny, sammenhængende tekst …
const BURST_MS = 2000;    // … på så kort tid er ikke skrevet af et menneske
const HUMAN_CPS = 15;     // ved længere tid mellem to målinger: højst 15 tegn/sek.
const MAX_GAP_MS = 5000;  // tid uden for Word tælles højst 5 sek. pr. måling
const SEEN_MAX = 300_000; // højst så mange tre-ords-sekvenser huskes

const WORD_RE = /[\p{L}\p{N}]+/gu;

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
  /** opts: { burstChars, burstMs, humanCps, clock(t) -> 'hh.mm' } */
  constructor(opts = {}) {
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

  /**
   * Hvor lang er den længste sammenhængende stribe ny tekst (tegn) i cur, som ikke fandtes i det, økten har set?
   * Kun området, der er ændret siden prev, undersøges.
   */
  novelRun(prev, cur) {
    if (prev === cur) return 0;
    let p = 0;
    const max = Math.min(prev.length, cur.length);
    while (p < max && prev[p] === cur[p]) p++;
    let s = 0;
    while (s < max - p && prev[prev.length - 1 - s] === cur[cur.length - 1 - s]) s++;
    const from = p, to = cur.length - s;
    if (to <= from) return 0; // kun slettet
    const tk = tokens(cur);
    let best = 0, runStart = -1, runEnd = -1;
    const known = (i) => {
      if (tk[i].e - tk[i].s >= 12 && this.seen.has('1 ' + tk[i].w)) return true;
      for (let a = Math.max(0, i - 2); a <= i && a + 2 < tk.length; a++) if (this.seen.has(key3(tk, a))) return true;
      return false;
    };
    for (let i = 0; i < tk.length; i++) {
      if (tk[i].e <= from || tk[i].s >= to) { if (runStart >= 0) { best = Math.max(best, runEnd - runStart); runStart = -1; } continue; }
      if (known(i)) { if (runStart >= 0) { best = Math.max(best, runEnd - runStart); runStart = -1; } continue; }
      if (runStart < 0) runStart = tk[i].s;
      runEnd = tk[i].e;
    }
    if (runStart >= 0) best = Math.max(best, runEnd - runStart);
    // Tegn uden ord (fx en lang række tal-tegn eller symboler) tæller også, hvis hele ændringen er ny
    if (!tk.some(t => t.e > from && t.s < to)) best = Math.max(best, to - from > this.burstChars ? to - from : 0);
    return best;
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

  /** En måling fra Word: { t, text (Range.Text), copilot, foreground, error } */
  snapshot(s) {
    const t = Number(s.t) || Date.now();
    if (s.error) { this.readError = String(s.error).slice(0, 160); return this.status(t); }
    this.readError = '';
    if (s.copilot === 'on' || s.copilot === 'off' || s.copilot === 'unknown') this.copilot = s.copilot;
    const rank = { '': 0, off: 1, unknown: 2, on: 3 };
    if (rank[this.copilot] > rank[this.copilotWorst]) this.copilotWorst = this.copilot;
    if (this.text == null) return this.start(s.text, t);
    const dt = Math.max(0, t - this.lastT);
    if (s.foreground === false) this.focusLostMs += Math.min(dt, MAX_GAP_MS);
    else this.activeMs += Math.min(dt, MAX_GAP_MS);
    this.foreground = s.foreground !== false;
    const text = wordText(s.text);
    if (text !== this.text) {
      const run = this.novelRun(this.text, text);
      const limit = Math.max(this.burstChars, this.humanCps * dt / 1000);
      if (run > limit && this.inserts.length < 50) this.inserts.push({ t, chars: run });
      this._learn(text);
      this.text = text;
    }
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

  /** Til serveren (doc.stats): kun tal og copilot-status – aldrig tekst. */
  stats() {
    return { pasteInserted: this.inserts.length, pasteBlocked: this.cleared, focusLostMs: Math.round(this.focusLostMs), activeMs: Math.round(this.activeMs), copilot: this.copilotWorst || this.copilot };
  }

  /**
   * Skiltet: { color: 'green'|'red'|'grey', symbol: '✓'|'✗'|'?', text, notes: [] }.
   * text er en hel sætning (tooltip og aria-live), fx 'Rød: tekst indsat fra et andet program kl. 10.14'.
   */
  status() {
    const notes = [];
    const out = (color, text) => ({ color, symbol: color === 'green' ? '✓' : color === 'red' ? '✗' : '?', text, notes });
    const clean = (x) => String(x || '').trim().replace(/[.…\s]+$/u, '').slice(0, 160);
    const pv = this.srv.preview;
    const cats = pv && Array.isArray(pv.categories) ? pv.categories : [];
    const short = cats.find(c => c.key === 'kort');
    if (short) notes.push(short.text);
    if (this.inserts.length) notes.push('Dokumentet kan ikke få mærket. Du kan skrive et nyt dokument eller gemme dette uden mærke.');
    if (this.inserts.length) return out('red', `Rød: tekst indsat fra et andet program kl. ${this.clock(this.inserts[0].t)}`);
    if (this.outside) return out('red', 'Rød: dokumentet er ændret uden for HolyMoly');
    if (this.copilot === 'on') return out('red', "Rød: Word's AI (Copilot) er slået til");
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
    if (this.copilot !== 'off') return out('grey', "Grå: HolyMoly kan ikke se, om Word's AI (Copilot) er slået fra. Spørg skolens IT.");
    if (!lamp || !lamp.color) return out('grey', 'Grå: Venter på HolyMoly.');
    if (lamp.color !== 'green') return out('grey', `Grå: ${clean(lamp.reason) || 'Venter på HolyMoly'}.`);
    return out('green', 'Grøn – teksten tæller med');
  }
}

module.exports = { WordCheck, wordTextToBlocks, wordText, tokens, clock, BURST_CHARS, BURST_MS, HUMAN_CPS };
