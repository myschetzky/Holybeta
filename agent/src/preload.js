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
});
