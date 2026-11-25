'use strict';
/*
 * "Skriv i Word" – rammen om Word: et gennemsigtigt vindue uden ramme, altid øverst, der følger Word-vinduet.
 * Musen går lige igennem til Word (setIgnoreMouseEvents(true, { forward: true })) – undtagen over HolyMoly-bjælken
 * øverst, muldvarpen nederst til højre og en evt. boks (resultat eller valg). Vinduet tager ikke fokus fra Word,
 * medmindre der er en boks, eleven skal svare på.
 * WordManager kalder update(view) ca. hvert sekund; view er beskrevet i manager.js (view()).
 */
const path = require('node:path');

class WordOverlay {
  /** electron: { BrowserWindow, ipcMain, screen }, onAction(id) */
  constructor({ electron, onAction, devTools = false }) {
    this.e = electron;
    this.onAction = onAction || (() => {});
    this.devTools = devTools;
    this.win = null;
    this.lastView = null;
    this.interactive = false;
    this.e.ipcMain.on('word-frame:interactive', (ev, on) => {
      if (!this._mine(ev)) return;
      this.interactive = !!on;
      this.win.setIgnoreMouseEvents(!this.interactive, { forward: true });
    });
    this.e.ipcMain.handle('word-frame:action', (ev, id) => (this._mine(ev) ? this.onAction(String(id || '').slice(0, 20)) : null));
    this.e.ipcMain.handle('word-frame:view', (ev) => (this._mine(ev) ? this.lastView : null));
  }
  _mine(ev) { return !!(this.win && !this.win.isDestroyed() && ev.sender === this.win.webContents); }

  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new this.e.BrowserWindow({
      show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, focusable: false, alwaysOnTop: true, title: 'HolyMoly – Word',
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'frame-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: this.devTools },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'word-frame.html'));
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.on('closed', () => { this.win = null; });
    return this.win;
  }

  /** Word-vinduets fysiske pixels (fra Win32) -> Electrons koordinater. */
  _bounds(rect) {
    let r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(200, Math.round(rect.w)), height: Math.max(150, Math.round(rect.h)) };
    try { if (process.platform === 'win32' && this.e.screen.screenToDipRect) r = this.e.screen.screenToDipRect(null, r); } catch (e) { /* */ }
    return r;
  }

  update(view) {
    this.lastView = view;
    if (!view || !view.visible || !view.rect) { this.hide(); return; }
    const win = this._ensure();
    const b = this._bounds(view.rect);
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) win.setBounds(b);
    // En boks, eleven skal svare på: vinduet må tage fokus (tastatur), ellers aldrig
    const ask = !!(view.panel && view.panel.actions && view.panel.actions.length);
    win.setFocusable(ask);
    if (!win.isVisible()) { win.showInactive(); win.setAlwaysOnTop(true, 'floating'); }
    if (ask && !this._asked) { this._asked = true; win.focus(); }
    if (!ask) this._asked = false;
    win.webContents.send('word-frame:view', view);
  }
  focused() { return !!(this.win && !this.win.isDestroyed() && this.win.isFocused()); }
  hide() { if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide(); }
  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { WordOverlay };
