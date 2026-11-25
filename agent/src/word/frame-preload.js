'use strict';
// Broen til rammen om Word (word-frame.html). Kun disse funktioner er tilgængelige for siden.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hmword', {
  view: () => ipcRenderer.invoke('word-frame:view'),
  onView: (cb) => ipcRenderer.on('word-frame:view', (_e, v) => cb(v && typeof v === 'object' ? v : null)),
  interactive: (on) => ipcRenderer.send('word-frame:interactive', !!on),
  action: (id) => ipcRenderer.invoke('word-frame:action', String(id || '')),
});
