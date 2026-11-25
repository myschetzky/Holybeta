'use strict';
/*
 * "Min HolyMoly" – vinduet med elevens dokumenter (skrivevinduet og Word), "Åbn mappe", "Vedhæft til aflevering",
 * "Fortsæt i Word" og de to knapper "Skriv i HolyMoly" / "Skriv i Word". Listen bygges af mine.js.
 */
const path = require('node:path');
const M = require('./mine.js');

class MineWindow {
  /**
   * electron: { BrowserWindow, ipcMain }
   * src: { writerDocs() -> [], word: WordManager, openWriter(docId?), showInFolder(p) }
   */
  constructor({ electron, src, devTools = false }) {
    this.e = electron;
    this.src = src;
    this.devTools = devTools;
    this.win = null;
    const mine = (ev) => !!(this.win && !this.win.isDestroyed() && ev.sender === this.win.webContents);
    this.e.ipcMain.handle('mine:state', async (ev) => (mine(ev) ? this.state() : null));
    this.e.ipcMain.handle('mine:action', async (ev, a) => (mine(ev) ? this.action(a && typeof a === 'object' ? a : {}) : null));
  }

  async state() {
    const word = this.src.word;
    const info = await word.info();
    const list = M.items({ writerDocs: this.src.writerDocs(), wordDocs: word.list(), assignments: word.assignments });
    return {
      word: { available: info.available, supported: info.supported, active: !!word.s },
      items: list.map(it => Object.assign({}, it, { targets: M.attachTargets(word.assignments, it) })),
      assignments: word.assignments.filter(a => !a.submission).map(a => ({ id: a.id, title: a.title, home: a.home, due: a.due })),
      texts: M.ACTION_TEXT,
    };
  }

  /** a: { id: 'write'|'word'|'continue'|'folder'|'writer'|'attach', key, assignmentId } */
  async action(a) {
    const word = this.src.word;
    const id = String(a.id || '');
    const key = String(a.key || '');
    const [source, docId] = key.split(':');
    if (id === 'write') { this.src.openWriter(''); return { ok: true }; }
    if (id === 'word') { const r = await word.start({ assignmentId: Number(a.assignmentId) || 0 }); this.refresh(); return r; }
    if (id === 'continue' && source === 'word') { const r = await word.start({ docId }); this.refresh(); return r; }
    if (id === 'writer' && source === 'holymoly') { this.src.openWriter(docId); return { ok: true }; }
    if (id === 'folder' && source === 'word') {
      const d = word.get(docId);
      if (!d) return { ok: false, error: 'Dokumentet findes ikke' };
      this.src.showInFolder(d.sealedPath || d.path);
      return { ok: true };
    }
    if (id === 'attach' && (source === 'word' || source === 'holymoly')) {
      const r = source === 'word' ? await word.attach(docId, a.assignmentId) : await word.attachDoc(docId, a.assignmentId);
      this.refresh();
      return r;
    }
    return { ok: false, error: 'Ukendt handling' };
  }

  open() {
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); this.refresh(); return; }
    this.win = new this.e.BrowserWindow({
      width: 780, height: 640, minWidth: 480, minHeight: 400, title: 'Min HolyMoly', backgroundColor: '#eef0f3', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'mine-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: this.devTools },
    });
    this.win.removeMenu();
    this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'word-mine.html'));
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.on('closed', () => { this.win = null; });
  }
  /** Listen har ændret sig (nyt dokument, Tekst færdig, afleveringer). */
  refresh() { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('mine:changed'); }
}

module.exports = { MineWindow };
