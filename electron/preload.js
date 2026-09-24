'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentsHome', {
  config: () => ipcRenderer.invoke('home:config'),
  onSnapshot: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on('home:snapshot', handler);
    return () => ipcRenderer.removeListener('home:snapshot', handler);
  },
});
