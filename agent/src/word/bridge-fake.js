'use strict';
/*
 * "Skriv i Word" – en falsk Word til tests og demo. Taler præcis samme protokol som word.ps1 (se bridge.js).
 *
 *  - I samme proces: new FakeWord().handle(req) -> svar. FakeWordBridge har samme metoder som WordBridge.
 *  - Som proces: `node bridge-fake.js` læser JSON-linjer på stdin og skriver svar på stdout (som PowerShell-broen).
 *
 * Ekstra kommandoer (kun her): fake:type { text } (eleven skriver), fake:paste { text } (indsat på én gang),
 * fake:set { text, foreground, copilot, rect, minimized, open, busy }, fake:hang (svarer aldrig).
 * save og seal skriver rigtige .docx-filer, der ligner Words egne (deflate, sidefod, læsebeskyttelse).
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/* ------------------------------------------------------------ en .docx som Word laver den ------------------------------------------------------------ */
let CRC = null;
function crc32(b) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/** Zip med deflate (som Word). files: [[navn, Buffer]] */
function zipDeflate(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nb.length, 26);
    parts.push(loc, nb, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, nb);
    off += 30 + nb.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Et afsnit som Word skriver det: rsid-attributter, flere w:r, w:tab/w:br for tabulator og linjeskift. */
function wordPara(text, style) {
  const runs = [];
  for (const piece of String(text).split(/(\t|\v)/)) {
    if (piece === '\t') runs.push('<w:r><w:tab/></w:r>');
    else if (piece === '\v') runs.push('<w:r><w:br/></w:r>');
    else if (piece) {
      // Word deler ofte et afsnit i flere w:r (stavekontrol, rsid)
      const mid = Math.ceil(piece.length / 2);
      for (const x of [piece.slice(0, mid), piece.slice(mid)]) if (x) runs.push(`<w:r w:rsidRPr="00A1B2C3"><w:rPr><w:lang w:val="da-DK"/></w:rPr><w:t xml:space="preserve">${esc(x)}</w:t></w:r>`);
    }
  }
  return `<w:p w:rsidR="00D4E5F6" w:rsidRDefault="00D4E5F6">${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs.join('')}</w:p>`;
}
/**
 * En .docx som Word ville gemme den. paragraphs: ['tekst' | { text, style }].
 * opts: { footerLines, green, protect } – sidefod (som seal()) og læsebeskyttelse (wdAllowOnlyReading).
 */
function wordLikeDocx(paragraphs, opts = {}) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
  const footer = Array.isArray(opts.footerLines) && opts.footerLines.length;
  const body = paragraphs.map(p => (typeof p === 'string' ? wordPara(p) : wordPara(p.text, p.style))).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}<w:sectPr w:rsidR="00D4E5F6">${footer ? '<w:footerReference w:type="default" r:id="rId8"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1134" w:bottom="1701" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const ftr = footer ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:ftr ${W}>${opts.footerLines.map((l, i) => `<w:p><w:pPr><w:pStyle w:val="Sidefod"/></w:pPr><w:r><w:rPr>${i === 0 ? `<w:b/><w:color w:val="${opts.green ? '15803D' : '6B7280'}"/>` : '<w:color w:val="6B7280"/>'}<w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}</w:ftr>` : '';
  const prot = opts.protect ? '<w:documentProtection w:edit="readOnly" w:enforcement="1" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="' + crypto.randomBytes(64).toString('base64') + '" w:salt="' + crypto.randomBytes(16).toString('base64') + '"/>' : '';
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:settings ${W}><w:zoom w:percent="100"/>${prot}<w:defaultTabStop w:val="1304"/></w:settings>`;
  const WM = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WM}.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="${WM}.settings+xml"/>${footer ? `<Override PartName="/word/footer1.xml" ContentType="${WM}.footer+xml"/>` : ''}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${footer ? '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}</Relationships>`],
    ['word/settings.xml', settings],
    ...(footer ? [['word/footer1.xml', ftr]] : []),
  ];
  return zipDeflate(files.map(([n, s]) => [n, Buffer.from(s, 'utf8')]));
}

/* ------------------------------------------------------------ den falske Word ------------------------------------------------------------ */
class FakeWord {
  constructor(opts = {}) {
    this.word = opts.word !== false;
    this.doc = null; // { path, paras: [], saved, sealed }
    this.foreground = true;
    this.copilot = opts.copilot || 'off';
    this.minimized = false;
    this.rect = { x: 100, y: 80, w: 1200, h: 800 };
    this.busy = false;
    this.log = [];
  }
  _text() { return this.doc ? this.doc.paras.join('\r') + '\r' : ''; }
  _write(file, opts) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, wordLikeDocx(this.doc.paras, opts)); }

  /** Én forespørgsel -> svar (uden id). Svarer null på fake:hang. */
  handle(req) {
    const cmd = String(req.cmd || '');
    this.log.push(cmd);
    if (cmd === 'fake:hang') return null;
    if (this.busy && !cmd.startsWith('fake:') && cmd !== 'probe') return { ok: false, error: 'Opkaldet blev afvist af den kaldte part (Word er optaget)' };
    switch (cmd) {
      case 'probe': return { ok: true, word: this.word, version: '16.0' };
      case 'open': {
        if (!this.word) return { ok: false, error: 'Word findes ikke' };
        const p = String(req.path || '');
        if (!p) return { ok: false, error: 'Ingen sti' };
        if (req.create) {
          this.doc = { path: p, paras: [''], saved: true };
          this._write(p);
        } else {
          if (!fs.existsSync(p)) return { ok: false, error: 'Filen findes ikke' };
          this.doc = { path: p, paras: this.doc && this.doc.path === p ? this.doc.paras : (this.stored && this.stored[p]) || [''], saved: true };
        }
        this.foreground = true;
        return { ok: true, path: p };
      }
      case 'state': {
        if (!this.doc) return { ok: true, open: false };
        return { ok: true, open: true, path: this.doc.path, text: this._text(), saved: this.doc.saved, minimized: this.minimized, rect: this.minimized ? null : Object.assign({}, this.rect), foreground: this.foreground && !this.minimized, copilot: this.copilot };
      }
      case 'save': {
        if (!this.doc) return { ok: false, error: 'Intet dokument er åbent' };
        this._write(this.doc.path);
        (this.stored = this.stored || {})[this.doc.path] = this.doc.paras.slice();
        this.doc.saved = true;
        return { ok: true, path: this.doc.path, saved: true };
      }
      case 'seal': {
        if (!this.doc) return { ok: false, error: 'Intet dokument er åbent' };
        const p = String(req.path || '');
        if (!p) return { ok: false, error: 'Ingen sti' };
        if (!req.password) return { ok: false, error: 'Ingen adgangskode' };
        this._write(p, { footerLines: Array.isArray(req.footerLines) ? req.footerLines.map(String) : [], green: !!req.green, protect: true });
        this.sealed = { path: p, footerLines: req.footerLines, green: !!req.green };
        this.doc = null;
        return { ok: true, path: p };
      }
      case 'close': {
        if (this.doc && req.save) this._write(this.doc.path);
        this.doc = null;
        return { ok: true };
      }
      // Kun den falske Word: eleven skriver/indsætter, og testen ændrer forholdene
      case 'fake:type':
      case 'fake:paste': {
        if (!this.doc) return { ok: false, error: 'Intet dokument er åbent' };
        const add = String(req.text || '').split('\r');
        this.doc.paras[this.doc.paras.length - 1] += add[0];
        this.doc.paras.push(...add.slice(1));
        this.doc.saved = false;
        return { ok: true };
      }
      case 'fake:set': {
        if ('text' in req && this.doc) { this.doc.paras = String(req.text).replace(/\r$/, '').split('\r'); this.doc.saved = false; }
        for (const k of ['foreground', 'copilot', 'minimized', 'busy']) if (k in req) this[k] = req[k];
        if (req.rect) this.rect = req.rect;
        if (req.open === false) this.doc = null;
        return { ok: true };
      }
      default: return { ok: false, error: 'Ukendt kommando' };
    }
  }
}

/** Samme metoder som WordBridge, men i samme proces (til tests og demo uden PowerShell). */
class FakeWordBridge {
  constructor(opts = {}) { this.fake = new FakeWord(opts); this.supported = true; }
  async _req(cmd, args = {}) { const r = this.fake.handle(Object.assign({}, args, { cmd })); return r || { ok: false, error: 'Word svarer ikke', timeout: true }; }
  async start() { return { supported: true, word: this.fake.word, version: '16.0' }; }
  async probe() { return { supported: true, word: this.fake.word, version: '16.0' }; }
  request(cmd, args) { return this._req(cmd, args); }
  open(p, create) { return this._req('open', { path: p, create }); }
  state() { return this._req('state'); }
  save() { return this._req('save'); }
  seal(o) { return this._req('seal', o); }
  close(save) { return this._req('close', { save }); }
  stop() {}
  on() { return this; }
}

/* ------------------------------------------------------------ som proces (samme protokol som word.ps1) ------------------------------------------------------------ */
if (require.main === module) {
  const { asciiJson } = require('./bridge.js');
  const w = new FakeWord({ word: process.env.HM_FAKE_NO_WORD !== '1' });
  const out = (o) => process.stdout.write(asciiJson(o) + '\n');
  out({ ready: true, word: w.word, version: '16.0' });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let req, id = 0;
      try { req = JSON.parse(line); id = req.id; } catch (e) { out({ id: 0, ok: false, error: 'Ugyldig JSON' }); continue; }
      if (req.cmd === 'fake:exit') process.exit(3);
      let res;
      try { res = w.handle(req); } catch (e) { res = { ok: false, error: e.message }; }
      if (res) out(Object.assign({ id }, res));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { FakeWord, FakeWordBridge, wordLikeDocx, zipDeflate };
