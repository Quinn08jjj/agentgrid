'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('grid', {
  load: () => ipcRenderer.invoke('state:load'),
  save: (s) => ipcRenderer.send('state:save', s),
  sync: (p) => ipcRenderer.send('sync', p),
  cmd: (p) => ipcRenderer.send('tile:cmd', p),
  addMenu: (p) => ipcRenderer.send('menu:add', p),
  remove: (p) => ipcRenderer.invoke('tile:remove', p),
  setKey: (p) => ipcRenderer.send('key:set', p),
  chat: { send: (p) => ipcRenderer.send('chat:send', p), stop: (p) => ipcRenderer.send('chat:stop', p) },
  models: (p) => ipcRenderer.invoke('models:list', p),
  presets: () => ipcRenderer.invoke('presets:get'),
  tileMenu: (p) => ipcRenderer.send('menu:tile', p),
  pickFolder: (l) => ipcRenderer.invoke('pickFolder', l),
  pty: {
    start: (p) => ipcRenderer.send('pty:start', p),
    input: (p) => ipcRenderer.send('pty:input', p),
    resize: (p) => ipcRenderer.send('pty:resize', p),
    kill: (p) => ipcRenderer.send('pty:kill', p),
  },
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
