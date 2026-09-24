'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const { ROOMS, validateOverrides } = require('../src/core/rooms');

const PUSH_MS = 500;
const ROSTER_MS = 30_000;

let win;
let tracker;
let watcher;
// Problems shown under "Needs attention". `label` is safe on a shared
// screen; `detail` may hold a path and is hidden in privacy mode. Repeats are
// counted, not re-added, so a noisy folder cannot push others off the list.
const startupProblems = [];
const problems = new Map(); // label|detail -> { label, detail, count, at }
const PROBLEM_LIMIT = 20;

function problem(label, detail = '') {
  const key = `${label}|${detail}`;
  const p = problems.get(key);
  if (p) {
    p.count += 1;
    p.at = Date.now();
    return;
  }
  problems.set(key, { label, detail, count: 1, at: Date.now() });
  if (problems.size > PROBLEM_LIMIT) problems.delete(problems.keys().next().value);
}

function loadOverrides() {
  const file = path.join(app.getPath('userData'), 'rooms.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // No rooms.json is the normal case: the default rooms apply.
    if (err.code !== 'ENOENT') {
      startupProblems.push({ label: `rooms.json could not be read (${err.code}); using the default rooms`, detail: file, count: 1 });
    }
    return { file, overrides: {} };
  }
  try {
    return { file, overrides: validateOverrides(JSON.parse(text)) };
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'it is not valid JSON' : err.message;
    startupProblems.push({ label: `rooms.json ignored: ${reason}; using the default rooms`, detail: file, count: 1 });
    return { file, overrides: {} };
  }
}

function rosterDirs() {
  // User agents live next to each transcripts root (~/.claude, $CLAUDE_CONFIG_DIR).
  const dirs = defaultRoots().map((root) => ({ dir: path.join(path.dirname(root), 'agents'), scope: 'user' }));
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
      problems: [...startupProblems, ...problems.values(), ...roster.problems],
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
