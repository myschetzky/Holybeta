'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('freeze', {
  onMessage: (cb) => ipcRenderer.on('freeze-message', (_e, m) => {
    const p = m && typeof m === 'object' ? m : { message: m };
    cb({ message: String(p.message || ''), mode: p.mode === 'review' ? 'review' : 'freeze', endsAt: Number(p.endsAt) || 0, startedAt: Number(p.startedAt) || 0 });
  }),
});
