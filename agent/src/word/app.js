'use strict';
/*
 * "Skriv i Word" i elev-appen: binder Word-broen, økten (manager.js), rammen (overlay.js) og "Min HolyMoly"
 * (mine-window.js) sammen med Electron. main.js kalder createWordMode() én gang og sender serverens beskeder videre.
 *
 * Under udvikling kan den falske Word bruges (HOLYMOLY_WORD_FAKE=1, kun i en app, der ikke er pakket),
 * så rammen og muldvarpen kan ses uden Windows og Word.
 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen, clipboard, shell } = require('electron');
const { WordBridge } = require('./bridge.js');
const { FakeWordBridge } = require('./bridge-fake.js');
const { WordManager } = require('./manager.js');
const { WordOverlay } = require('./overlay.js');
const { MineWindow } = require('./mine-window.js');

/**
 * opts: { send(msg) -> bool, lessonActive(), online(), serverUrl() -> string, writer() -> Writer|null, onChange() }
 * Returnerer { manager, mine }.
 */
function createWordMode(opts) {
  const fake = process.env.HOLYMOLY_WORD_FAKE === '1' && !app.isPackaged;
  const bridge = fake ? new FakeWordBridge() : new WordBridge();
  let manager = null;
  let mine = null;
  const devTools = !app.isPackaged;
  const overlay = new WordOverlay({ electron: { BrowserWindow, ipcMain, screen }, onAction: (id) => manager.action(id), devTools });

  /** Skrivevinduet med et bestemt dokument (eller bare åbent). */
  const openWriter = (docId) => {
    const w = opts.writer();
    if (!w) return;
    if (docId && w.win && !w.win.isDestroyed()) { w.open(); w.win.webContents.send('write:open-doc', docId); return; }
    if (docId) w.pendingOpen = docId;
    w.open();
  };
  const writerDocs = () => {
    const w = opts.writer();
    if (!w) return [];
    return w._summary().map(s => Object.assign({}, s, { updated: (w._get(s.id) || {}).updated || s.submitted || 0 }));
  };

  manager = new WordManager({
    bridge, overlay, clipboard,
    send: opts.send, lessonActive: opts.lessonActive, online: opts.online,
    get serverUrl() { return opts.serverUrl(); },
    dir: path.join(app.getPath('documents'), 'HolyMoly'),
    dataDir: app.getPath('userData'),
    showInFolder: (p) => { try { shell.showItemInFolder(p); } catch (e) { /* */ } },
    onChange: () => { if (mine) mine.refresh(); if (opts.onChange) opts.onChange(); },
    onOpenMine: () => mine.open(),
  });
  mine = new MineWindow({ electron: { BrowserWindow, ipcMain }, src: { word: manager, writerDocs, openWriter, showInFolder: (p) => { try { shell.showItemInFolder(p); } catch (e) { /* */ } } }, devTools });

  // Skrivevinduet ("Skriv i Word"-knapperne, word-writer.js) og hovedvinduet
  ipcMain.handle('word:info', () => manager.info());
  ipcMain.handle('word:start', (_e, o) => manager.start({ assignmentId: Number(o && o.assignmentId) || 0 }));
  ipcMain.handle('word:mine', () => { mine.open(); return true; });
  ipcMain.handle('word:write-lesson', () => { const w = opts.writer(); return (w && w.writeAsg) || null; });
  return { manager, mine, openWriter };
}

module.exports = { createWordMode };
