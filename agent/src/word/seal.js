'use strict';
/*
 * "Skriv i Word" – forseglingen (ren logik + filer, ingen Electron og ingen Word).
 *
 *  - footerFor(): sidefodens linjer i det forseglede dokument – de samme tekster som HolyMolys egen Word-fil (D.footerLines).
 *  - docxBlocks(): teksten i den .docx, Word har gemt, som HolyMoly-blokke. Afleveringen bruger teksten fra filen,
 *    så beviset gælder præcis det, tjek-siden læser i den forseglede fil (sidefoden er ikke brødtekst).
 *  - verifySealed(): passer den forseglede fils brødtekst til beviset (sha256)? Samme læsning som tjek-siden (D.docxText).
 *  - paths(): hvor dokumentet ligger: Dokumenter/HolyMoly/{titel}.docx og {titel} – forseglet.docx.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const D = require('../doc.js');

const inflateRaw = async (bytes) => new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/** Bevis-koden, som den står i sidefoden: HM-XXXXXXXX */
const codeOf = (certId) => 'HM-' + String(certId || '').slice(0, 8).toUpperCase();

/**
 * Sidefoden: result fra serveren (doc-result: certId, facts.place, observed, test), url til tjek-siden, antal ord.
 * Returnerer { lines, green }.
 */
function footerFor(result, url, words) {
  const r = result || {};
  const mark = { code: codeOf(r.certId), url: String(url || ''), place: String((r.facts && r.facts.place) || r.place || ''), observed: Array.isArray(r.observed) ? r.observed.map(String) : undefined, test: !!r.test };
  return { lines: D.footerLines(mark, words), green: D.markGreen(mark) };
}

/** Afsnittene i en .docx som HolyMoly-blokke (overskrifter som h1/h2, listepunkter som ul, ellers p). */
async function docxBlocks(bytes) {
  const xml = await D.readZipEntry(bytes, 'word/document.xml', inflateRaw);
  if (!xml) throw new Error('Filen er ikke en Word-fil (.docx)');
  const out = [];
  for (const p of D.docxParagraphs(new TextDecoder().decode(xml))) {
    const x = p.text.replace(/[\r\n]+/g, ' ');
    if (!D.normalizeText(x)) continue;
    if (out.length >= D.LIMITS.blocks) break;
    const t = /^(heading|overskrift)1$/i.test(p.style) ? 'h1' : /^(heading|overskrift)2$/i.test(p.style) ? 'h2' : p.list ? 'ul' : 'p';
    out.push({ t, r: [{ x }] });
  }
  return D.validateBlocks(out);
}

/** Den tekst, beviset gælder for (samme som serveren: normalizeText(textOf(blocks))). */
const textOfBlocks = (blocks) => D.normalizeText(D.textOf(blocks));

/** Passer den forseglede fil til beviset? Læses præcis som på tjek-siden. { ok, text, protected } */
async function verifySealed(bytes, expectedSha) {
  const xml = await D.readZipEntry(bytes, 'word/document.xml', inflateRaw);
  if (!xml) return { ok: false, error: 'Filen er ikke en Word-fil (.docx)' };
  const doc = D.docxText(new TextDecoder().decode(xml));
  const hit = doc.variants.find(v => sha256(v) === expectedSha);
  const settings = await D.readZipEntry(bytes, 'word/settings.xml', inflateRaw).catch(() => null);
  const prot = !!(settings && /<w:documentProtection\b[^>]*w:edit="readOnly"[^>]*w:enforcement="(1|true|on)"/.test(new TextDecoder().decode(settings)));
  return { ok: !!hit, text: hit || doc.text, protected: prot };
}

/** Et filnavn, Windows accepterer. */
function safeName(title) {
  const s = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').replace(/[. ]+$/, '').trim().slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? s + '_' : s || 'Dokument';
}
/** Første ledige navn: navn.docx, navn (2).docx, … */
function freePath(dir, base, exists = fs.existsSync) {
  for (let n = 1; n < 1000; n++) {
    const p = path.join(dir, base + (n > 1 ? ` (${n})` : '') + '.docx');
    if (!exists(p)) return p;
  }
  return path.join(dir, base + ' ' + Date.now() + '.docx');
}
/** Hvor et nyt Word-dokument og dets forseglede udgave ligger. */
function paths(dir, title, exists = fs.existsSync) {
  const base = safeName(title);
  return { draft: freePath(dir, base, exists), sealed: freePath(dir, base + ' – forseglet', exists) };
}

module.exports = { footerFor, docxBlocks, textOfBlocks, verifySealed, sha256, safeName, freePath, paths, codeOf, inflateRaw };
