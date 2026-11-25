'use strict';
// Broen til "Min HolyMoly" (word-mine.html). Kun disse funktioner er tilgængelige for siden.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hmmine', {
  state: () => ipcRenderer.invoke('mine:state'),
  action: (a) => ipcRenderer.invoke('mine:action', {
    id: String((a && a.id) || ''), key: String((a && a.key) || ''), assignmentId: Number(a && a.assignmentId) || 0,
  }),
  onChange: (cb) => ipcRenderer.on('mine:changed', () => cb()),
});
