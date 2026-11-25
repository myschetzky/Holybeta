'use strict';
// Broen til skrive-vinduet ("Skriv i HolyMoly"). Kun disse funktioner er tilgængelige for siden.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hmw', {
  state: () => ipcRenderer.invoke('write:state'),
  create: (opts) => ipcRenderer.invoke('write:create', opts && typeof opts === 'object' ? { assignmentId: Number(opts.assignmentId) || 0 } : null),
  assignments: () => ipcRenderer.invoke('write:assignments'),
  session: (assignmentId, on) => ipcRenderer.invoke('write:session', { assignmentId: Number(assignmentId) || 0, on: !!on }),
  attach: (assignmentId, docId) => ipcRenderer.invoke('write:attach', { assignmentId: Number(assignmentId) || 0, docId: String(docId || '') }),
  onAssignments: (cb) => ipcRenderer.on('write:assignments', (_e, list) => cb(list)),
  onShowAssignments: (cb) => ipcRenderer.on('write:show-assignments', () => cb()),
  load: (id) => ipcRenderer.invoke('write:load', String(id || '')),
  save: (doc) => ipcRenderer.invoke('write:save', doc),
  remove: (id) => ipcRenderer.invoke('write:delete', String(id || '')),
  submit: (id, force) => ipcRenderer.invoke('write:submit', { id: String(id || ''), force: force === true }),
  docx: (id) => ipcRenderer.invoke('write:docx', String(id || '')),
  onSaved: (cb) => ipcRenderer.on('write:saved', (_e, r) => cb(r)),
  onLesson: (cb) => ipcRenderer.on('write:lesson', (_e, live) => cb(!!live)),
});
