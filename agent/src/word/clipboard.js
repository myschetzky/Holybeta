'use strict';
/*
 * "Skriv i Word" – udklipsholderen. Mens en Word-økt er åben og Word er i forgrunden, tømmes udklipsholderen,
 * hvis den har fået indhold fra et andet program end Word. Kopi og flyt af elevens egen tekst i Word er tilladt.
 * Uden for Word rører HolyMoly ikke udklipsholderen (eleven kan kopiere mellem andre programmer).
 *
 * Hvor indholdet kom fra, afgøres sådan (Electron kan ikke se, hvilket program der kopierede):
 *  - Teksten har stået i dokumentet i denne økt (WordCheck.knows) -> fra Word.
 *  - Ændret, mens Word var i forgrunden, og højst 60 tegn -> fra Word (eleven kopierede noget, der lige er skrevet).
 *  - Alt andet -> fra et andet program. Tømmes, så snart Word er i forgrunden.
 * Ren logik: clipboard er Electrons clipboard (readText, availableFormats, clear) eller en attrap i testene.
 */
const SHORT = 60;

class ClipboardGuard {
  /** opts: { clipboard, knows(text) -> bool, onClear({ chars }) } */
  constructor(opts) {
    this.cb = opts.clipboard;
    this.knows = opts.knows || (() => false);
    this.onClear = opts.onClear || (() => {});
    this.key = null;      // seneste indhold (tekst + formater)
    this.foreign = false; // indholdet kom fra et andet program
  }

  _read() {
    let text = '', formats = [];
    try { text = String(this.cb.readText() || ''); } catch (e) { /* */ }
    try { formats = (this.cb.availableFormats() || []).map(String); } catch (e) { /* */ }
    return { text, formats, key: text + '\u0000' + formats.join(',') };
  }

  /** Kaldes hvert 500 ms, mens Word-økten er åben. wordForeground: Word (eller HolyMolys ramme) har fokus. */
  tick({ wordForeground }) {
    const c = this._read();
    if (this.key === null) {
      // Første kig: det, der lå i udklipsholderen, før økten startede, kom ikke fra dokumentet
      this.key = c.key;
      this.foreign = !!(c.text || c.formats.length) && !(c.text && this.knows(c.text));
    } else if (c.key !== this.key) {
      this.key = c.key;
      const empty = !c.text && !c.formats.length;
      const own = empty || (c.text ? this.knows(c.text) || (wordForeground && c.text.length <= SHORT) : wordForeground);
      this.foreign = !own;
    }
    if (this.foreign && wordForeground) {
      const chars = c.text.length;
      try { this.cb.clear(); } catch (e) { return false; }
      this.key = this._read().key;
      this.foreign = false;
      this.onClear({ chars });
      return true;
    }
    return false;
  }
}

module.exports = { ClipboardGuard };
