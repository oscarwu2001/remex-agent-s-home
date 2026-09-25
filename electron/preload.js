'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentsHome', {
  config: () => ipcRenderer.invoke('home:config'),
  saveLayout: (layout) => ipcRenderer.invoke('home:save-layout', layout),
  saveDecor: (decor) => ipcRenderer.invoke('home:save-decor', decor),
  buildReport: (days) => ipcRenderer.invoke('home:build-report', days),
  showReportFiles: () => ipcRenderer.invoke('home:show-report-files'),
  onSnapshot: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on('home:snapshot', handler);
    return () => ipcRenderer.removeListener('home:snapshot', handler);
  },
});
