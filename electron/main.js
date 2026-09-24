'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const { ROOMS, validateOverrides } = require('../src/core/rooms');

const PUSH_MS = 500;
const ROSTER_MS = 30_000;

let win;
let tracker;
let watcher;
const problems = []; // shown in the app, newest last

function problem(message) {
  problems.push({ at: Date.now(), message });
  if (problems.length > 20) problems.shift();
}

function loadOverrides() {
  const file = path.join(app.getPath('userData'), 'rooms.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') problem(`Could not read ${file}: ${err.code}. Using the default rooms.`);
    return { file, overrides: {} };
  }
  try {
    return { file, overrides: validateOverrides(JSON.parse(text)) };
  } catch (err) {
    problem(`${path.basename(file)} ignored: ${err.message}`);
    return { file, overrides: {} };
  }
}

function rosterDirs() {
  const dirs = [{ dir: path.join(os.homedir(), '.claude', 'agents'), scope: 'user' }];
  const seen = new Set();
  for (const s of tracker.sessions.values()) {
    if (s.cwd && !seen.has(s.cwd)) {
      seen.add(s.cwd);
      dirs.push({ dir: path.join(s.cwd, '.claude', 'agents'), scope: s.project });
    }
  }
  return dirs;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: "Agent's Home",
    backgroundColor: '#f7e3d6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Local only: never navigate away, open external links in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: process.argv.includes('--demo') ? { demo: '1' } : {},
  });
}

app.whenReady().then(() => {
  const { file: overridesFile, overrides } = loadOverrides();
  tracker = new Tracker({ overrides });
  const roots = defaultRoots();
  watcher = new TranscriptWatcher({
    roots,
    onEntry: (file, entry, now) => tracker.ingest(file, entry, now),
    onMalformed: (file, err) => tracker.noteMalformed(file, err),
    onProblem: problem,
  });
  watcher.start();

  let roster = { agents: [], problems: [] };
  const refreshRoster = () => {
    roster = readRoster(rosterDirs(), overrides);
  };
  refreshRoster();
  setInterval(refreshRoster, ROSTER_MS);
  setInterval(() => tracker.prune(), 60_000);

  ipcMain.handle('home:config', () => ({
    rooms: ROOMS,
    overridesFile,
    platform: process.platform,
    version: app.getVersion(),
  }));

  createWindow();

  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('home:snapshot', {
      ...tracker.snapshot(),
      watcher: watcher.status(),
      roster: roster.agents,
      problems: [...problems.map((p) => p.message), ...roster.problems],
    });
  }, PUSH_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  watcher?.stop();
  if (process.platform !== 'darwin') app.quit();
});
