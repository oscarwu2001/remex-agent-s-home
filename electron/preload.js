'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentsHome', {
  config: () => ipcRenderer.invoke('home:config'),
  saveLayout: (layout) => ipcRenderer.invoke('home:save-layout', layout),
  saveDecor: (decor) => ipcRenderer.invoke('home:save-decor', decor),
  weatherSearch: (name) => ipcRenderer.invoke('home:weather-search', name),
  weatherNow: (place, unit) => ipcRenderer.invoke('home:weather-now', place, unit),
  updateInfo: () => ipcRenderer.invoke('home:update-info'),
  update: () => ipcRenderer.invoke('home:update'),
  notify: (n) => ipcRenderer.invoke('home:notify', n),
  packStatus: () => ipcRenderer.invoke('pack:status'),
  packInstall: (names) => ipcRenderer.invoke('pack:install', names),
  buildReport: (days) => ipcRenderer.invoke('home:build-report', days),
  showReportFiles: () => ipcRenderer.invoke('home:show-report-files'),
  onSnapshot: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on('home:snapshot', handler);
    return () => ipcRenderer.removeListener('home:snapshot', handler);
  },
});
