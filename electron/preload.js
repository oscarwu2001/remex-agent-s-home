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
  assistant: {
    status: () => ipcRenderer.invoke('assistant:status'),
    setKey: (key) => ipcRenderer.invoke('assistant:set-key', key),
    clearKey: () => ipcRenderer.invoke('assistant:clear-key'),
    check: (text) => ipcRenderer.invoke('assistant:check', text),
    run: (task) => ipcRenderer.invoke('assistant:run', task),
    reply: (msg) => ipcRenderer.invoke('assistant:reply', msg),
    stop: (id) => ipcRenderer.invoke('assistant:stop', id),
    forget: (id) => ipcRenderer.invoke('assistant:forget', id),
  },
  buildReport: (days) => ipcRenderer.invoke('home:build-report', days),
  showReportFiles: () => ipcRenderer.invoke('home:show-report-files'),
  onSnapshot: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on('home:snapshot', handler);
    return () => ipcRenderer.removeListener('home:snapshot', handler);
  },
});
