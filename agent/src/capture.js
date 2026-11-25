'use strict';
/* Skærmbilleder til miniaturer, live-visning og dokumentation ved overtrædelser. */
const { desktopCapturer, screen, systemPreferences } = require('electron');

function screenPermission() {
  if (process.platform !== 'darwin') return true;
  try { return systemPreferences.getMediaAccessStatus('screen') === 'granted'; } catch (e) { return true; }
}

function screenCount() {
  try { return screen.getAllDisplays().length; } catch (e) { return 1; }
}

/** Returnerer et JPEG-buffer af skærm nr. `index` med max bredde `maxWidth`. */
async function grab(index, maxWidth, quality) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const d = displays[index] || primary;
  const scale = Math.min(1, maxWidth / d.size.width);
  const thumbnailSize = { width: Math.max(1, Math.round(d.size.width * scale)), height: Math.max(1, Math.round(d.size.height * scale)) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
  if (!sources.length) return null;
  const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[index] || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  return src.thumbnail.toJPEG(quality);
}

function encodeFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(5 + h.length + payload.length);
  out[0] = 1;
  out.writeUInt32BE(h.length, 1);
  h.copy(out, 5);
  payload.copy(out, 5 + h.length);
  return out;
}

/**
 * Billeder af elevens skærm sendes KUN når læreren har klikket på eleven (live),
 * eller når læreren tager et skærmbillede / der sker en overtrædelse (dokumentation).
 *  off  – ingen billeder
 *  live – læreren kigger: billeder så hurtigt som forbindelsen kan klare (maks ~4/s).
 *         Næste billede sendes først når læreren har modtaget det forrige.
 */
class Streamer {
  constructor(conn) {
    this.conn = conn;
    this.mode = 'off';
    this.screen = 0;
    this.timer = null;
    this.waitingAck = false;
    this.lastSent = 0;
    this.width = 1280;
    this.quality = 60;
    this.busy = false;
    this.onLiveChange = () => {};
  }

  setMode(mode, screenIdx) {
    const wasLive = this.mode === 'live';
    this.mode = mode;
    this.screen = Number(screenIdx) || 0;
    this.waitingAck = false;
    clearTimeout(this.timer);
    if (wasLive !== (mode === 'live')) this.onLiveChange(mode === 'live');
    this._schedule(mode === 'live' ? 0 : 2000);
  }

  ack() {
    if (!this.waitingAck) return;
    const rtt = Date.now() - this.lastSent;
    this.waitingAck = false;
    // Tilpas størrelse/kvalitet til forbindelsen
    if (this.mode === 'live') {
      if (rtt > 1500) { this.width = Math.max(640, this.width - 160); this.quality = Math.max(40, this.quality - 5); }
      else if (rtt < 400) { this.width = Math.min(1600, this.width + 80); this.quality = Math.min(70, this.quality + 2); }
      this._schedule(Math.max(0, 250 - rtt));
    }
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    if (this.mode === 'off') return;
    this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (this.mode === 'off' || this.busy) return;
    if (!this.conn.online) return this._schedule(3000);
    this.busy = true;
    try {
      if (this.mode === 'live') {
        if (this.waitingAck && Date.now() - this.lastSent < 6000) return this._schedule(200);
        const jpg = await grab(this.screen, this.width, this.quality);
        if (jpg && this.conn.sendBinary(encodeFrame({ kind: 'live', screen: this.screen, screens: screenCount() }, jpg))) {
          this.waitingAck = true;
          this.lastSent = Date.now();
          this._schedule(6000); // fallback hvis kvitteringen aldrig kommer
        } else {
          this._schedule(500);
        }
      }
    } catch (e) {
      this._schedule(5000);
    } finally {
      this.busy = false;
    }
  }

  async evidence(reason, meta, opts = {}) {
    try {
      const jpg = await grab(opts.screen || 0, opts.width || 1280, opts.quality || 65);
      if (jpg) this.conn.sendBinary(encodeFrame(Object.assign({ kind: 'evidence', reason }, meta || {}), jpg), 2_000_000);
    } catch (e) { /* ignorer */ }
  }

  stop() { this.mode = 'off'; clearTimeout(this.timer); }
}

/** Tjekker lokalt at skærmoptagelse virker (billedet sendes ikke). */
async function captureWorks() {
  try {
    const jpg = await grab(0, 64, 30);
    return !!(jpg && jpg.length > 100);
  } catch (e) { return false; }
}

module.exports = { Streamer, screenPermission, screenCount, grab, captureWorks };
