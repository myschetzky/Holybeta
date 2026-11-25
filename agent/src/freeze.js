'use strict';
/* Frysning: dækker alle skærme med et vindue der ikke kan lukkes eller skubbes væk. */
const path = require('node:path');
const { BrowserWindow, screen, globalShortcut } = require('electron');

/** Vinduets HWND som decimal-tekst (samme form som PowerShells [string]$hwnd). */
function hwndOf(w) {
  try {
    const b = w.getNativeWindowHandle();
    return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString();
  } catch (e) { return ''; }
}

class Freezer {
  constructor() {
    this.windows = [];
    this.timer = null;
    this.message = '';
    this.mode = 'freeze';
    this.endsAt = 0;
    this.on = false;
  }

  set(on, message, opts = {}) {
    if (on) this.freeze(message, opts); else this.unfreeze();
  }

  /** Det skærmen viser: besked + tilstand ('freeze' = låst, 'review' = gennemgang med ur og tid tilbage). */
  _payload() {
    return { message: this.message, mode: this.mode, endsAt: this.endsAt, startedAt: this.startedAt };
  }

  freeze(message, opts = {}) {
    this.message = String(message || '').slice(0, 200);
    this.mode = opts.mode === 'review' ? 'review' : 'freeze';
    this.endsAt = Number(opts.endsAt) || 0;
    this.startedAt = Number(opts.startedAt) || 0;
    if (this.on) {
      for (const w of this.windows) if (!w.isDestroyed()) w.webContents.send('freeze-message', this._payload());
      return;
    }
    this.on = true;
    this._open();
    screen.on('display-added', this._reopen);
    screen.on('display-removed', this._reopen);
    // Hold vinduerne øverst – genvinder fokus hvis eleven prøver at skifte væk.
    this.timer = setInterval(() => {
      for (const w of this.windows) {
        if (w.isDestroyed()) continue;
        w.setAlwaysOnTop(true, 'screen-saver');
        if (!w.isFocused()) { w.show(); w.moveTop(); }
      }
      if (this.windows.length && this.windows.every(w => !w.isFocused())) {
        const w = this.windows[0];
        if (w && !w.isDestroyed()) w.focus();
      }
    }, 400);
    // Spærre almindelige genveje mens skærmen er frosset (virker ikke for Ctrl+Alt+Del).
    for (const acc of ['Alt+Tab', 'CommandOrControl+Tab', 'Super+Tab', 'Alt+F4', 'CommandOrControl+W', 'CommandOrControl+Q', 'CommandOrControl+H', 'CommandOrControl+M', 'Super+D', 'Super+Down',
      // Skift af virtuelt skrivebord / Mission Control (kan ikke altid spærres – så flyttes skærmen med i stedet)
      'Super+Control+Left', 'Super+Control+Right', 'Super+Control+D', 'Super+Control+F4', 'Control+Left', 'Control+Right', 'Control+Up', 'Control+Down', 'F3']) {
      try { globalShortcut.register(acc, () => {}); } catch (e) { /* ikke alle kan registreres */ }
    }
  }

  /**
   * Windows: et vindue kan ikke vises på alle virtuelle skriveborde. Skifter eleven skrivebord (Win+Ctrl+→,
   * fire fingre på touchpad, Opgavevisning), åbnes skærmen igen – nye vinduer kommer på det aktive skrivebord.
   * list: [{ hwnd, onCurrent }] fra overvågningen.
   */
  checkDesktops(list) {
    if (!this.on || process.platform !== 'win32') return false;
    const away = new Set(list.filter(x => x.onCurrent === 0).map(x => x.hwnd));
    if (!away.size) return false;
    const mine = this.windows.filter(w => !w.isDestroyed()).map(w => hwndOf(w));
    if (!mine.some(h => away.has(h))) return false;
    this._reopen();
    return true;
  }

  _reopen = () => {
    if (!this.on) return;
    this._closeWindows();
    this._open();
  };

  _open() {
    for (const d of screen.getAllDisplays()) {
      const w = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, fullscreen: true, kiosk: process.platform !== 'darwin', alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
        closable: false, focusable: true, show: false, backgroundColor: '#101317',
        webPreferences: { preload: path.join(__dirname, 'freeze-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      w.on('close', (e) => { if (this.on) e.preventDefault(); });
      w.webContents.on('before-input-event', (e, input) => {
        if (input.alt || input.meta || input.control) e.preventDefault();
      });
      w.loadFile(path.join(__dirname, '..', 'renderer', 'freeze.html'));
      w.webContents.once('did-finish-load', () => w.webContents.send('freeze-message', this._payload()));
      w.once('ready-to-show', () => { w.show(); w.focus(); });
      this.windows.push(w);
    }
  }

  _closeWindows() {
    for (const w of this.windows) {
      if (!w.isDestroyed()) { w.setClosable(true); w.destroy(); }
    }
    this.windows = [];
  }

  unfreeze() {
    if (!this.on) return;
    this.on = false;
    clearInterval(this.timer);
    screen.removeListener('display-added', this._reopen);
    screen.removeListener('display-removed', this._reopen);
    globalShortcut.unregisterAll();
    this._closeWindows();
  }
}

module.exports = { Freezer };
