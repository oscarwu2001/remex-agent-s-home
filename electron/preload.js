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
  packUpdate: () => ipcRenderer.invoke('pack:update'),
  logTail: (which) => ipcRenderer.invoke('home:log-tail', which),
  logOpen: () => ipcRenderer.invoke('home:log-open'),
  logError: (info) => ipcRenderer.invoke('home:log-error', info),
  buildReport: (days, details) => ipcRenderer.invoke('home:build-report', days, details),
  showReportFiles: () => ipcRenderer.invoke('home:show-report-files'),
  fleetChoose: () => ipcRenderer.invoke('home:fleet-choose'),
  fleetOff: () => ipcRenderer.invoke('home:fleet-off'),
  fleetGitChoose: () => ipcRenderer.invoke('home:fleet-git-choose'),
  openMini: () => ipcRenderer.invoke('home:mini-open'),
  miniPin: (on) => ipcRenderer.invoke('home:mini-pin', on),
  showMain: () => ipcRenderer.invoke('home:show-main'),
  projectChange: (change) => ipcRenderer.invoke('home:project-change', change),
  projectsShow: () => ipcRenderer.invoke('home:projects-show'),
  onSnapshot: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on('home:snapshot', handler);
    return () => ipcRenderer.removeListener('home:snapshot', handler);
  },
});
