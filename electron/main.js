'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const {
  DEPARTMENT_KINDS, validateOverrides, validateLayout, roomsWith, overridesFrom, openCells,
} = require('../src/core/rooms');

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

// The user's departments, from layout.json next to rooms.json. A broken file
// is reported and the core hospital is used; it is never overwritten until
// the user saves a new layout.
function loadLayout() {
  const file = path.join(app.getPath('userData'), 'layout.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // No layout.json is the normal case: just the core hospital.
    if (err.code !== 'ENOENT') {
      startupProblems.push({ label: `layout.json could not be read (${err.code}); showing the core hospital`, detail: file, count: 1 });
    }
    return { file, layout: { departments: [] } };
  }
  try {
    return { file, layout: validateLayout(JSON.parse(text)) };
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'it is not valid JSON' : err.message;
    startupProblems.push({ label: `layout.json ignored: ${reason}; showing the core hospital`, detail: file, count: 1 });
    return { file, layout: { departments: [] } };
  }
}

function loadOverrides(roomIds) {
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
    return { file, overrides: validateOverrides(JSON.parse(text), roomIds) };
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
  const { file: layoutFile, layout: loaded } = loadLayout();
  let layout = loaded;
  const ids = () => new Set(roomsWith(layout).map((r) => r.id));
  const { file: overridesFile, overrides: fileOverrides } = loadOverrides(ids());
  // rooms.json, written by hand, wins over assignments made in the app.
  let overrides = { ...overridesFrom(layout), ...fileOverrides };
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
  function refreshRoster() {
    roster = readRoster(rosterDirs(), overrides);
  }
  refreshRoster();
  setInterval(refreshRoster, ROSTER_MS);
  setInterval(() => tracker.prune(), 60_000);

  const config = () => ({
    rooms: roomsWith(layout),
    layout,
    departmentKinds: DEPARTMENT_KINDS,
    openCells: openCells(layout),
    overridesFile,
    layoutFile,
    platform: process.platform,
    version: app.getVersion(),
  });
  ipcMain.handle('home:config', config);

  // Saving a layout: validate, write, then use it. Helpers already on shift
  // keep their room; new ones follow the new assignments.
  ipcMain.handle('home:save-layout', (_event, proposed) => {
    let next;
    try {
      next = validateLayout(proposed);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    try {
      fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
      fs.writeFileSync(layoutFile, `${JSON.stringify({ departments: next.departments.map(({ kind, name, purpose, cell, agents }) => ({ kind, name, purpose, cell, agents })) }, null, 2)}\n`);
    } catch (err) {
      return { ok: false, error: `The layout could not be saved (${err.code || err.message})` };
    }
    layout = next;
    overrides = { ...overridesFrom(layout), ...fileOverrides };
    tracker.overrides = overrides;
    refreshRoster();
    return { ok: true, config: config() };
  });

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
