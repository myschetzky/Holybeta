'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hm', {
  getState: () => ipcRenderer.invoke('state:get'),
  enroll: (code, name, pin, accept) => ipcRenderer.invoke('enroll', String(code || ''), name ? String(name) : '', pin ? String(pin) : '', accept === true),
  enrollUniLogin: (code) => ipcRenderer.invoke('enroll-unilogin', String(code || '')),
  cancelUniLogin: () => ipcRenderer.invoke('enroll-unilogin-cancel'),
  setServer: (url) => ipcRenderer.invoke('server:set', String(url || '').slice(0, 200)),
  action: (id) => ipcRenderer.invoke('action', String(id || '')),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onAddClass: (cb) => ipcRenderer.on('add-class', () => cb()),
  // Afleveringssiden (agent/renderer/afleveringer.js ↔ agent/src/verified.js)
  verified: {
    overview: () => ipcRenderer.invoke('verified:overview'),
    list: () => ipcRenderer.invoke('verified:list'),
    write: (assignmentId) => ipcRenderer.invoke('verified:write', { assignmentId: Number(assignmentId) || 0 }),
    attach: (assignmentId, docId) => ipcRenderer.invoke('verified:attach', { assignmentId: Number(assignmentId) || 0, docId: String(docId || '') }),
    open: (docId) => ipcRenderer.invoke('verified:open', String(docId || '')),
    docx: (docId) => ipcRenderer.invoke('verified:docx', String(docId || '')),
    page: (open) => ipcRenderer.invoke('verified:page', open === true),
  },
  onShowAssignments: (cb) => ipcRenderer.on('show-assignments', () => cb()),
});
