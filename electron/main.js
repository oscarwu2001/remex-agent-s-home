'use strict';

const { app, BrowserWindow, ipcMain, shell, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const { wslRoots, rootKey } = require('../src/core/wsl');
const {
  DEPARTMENT_KINDS, validateOverrides, validateLayout, roomsWith, overridesFrom, openCells,
} = require('../src/core/rooms');

const PUSH_MS = 500;
const ROSTER_MS = 30_000;
const WSL_MS = 1_500; // WSL files are read this often, each time after a running check
const WSL_IDLE_MS = 5_000; // how often to look for a distro while none is running

let win;
let tracker;
let watcher;
let wslWatcher;
let wsl = { roots: [], problems: [] };
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
  // User agents live next to each transcripts root (~/.claude, $CLAUDE_CONFIG_DIR, WSL homes).
  const dirs = [...watcher.roots, ...wslWatcher.roots].map((root) => ({ dir: path.join(path.dirname(root), 'agents'), scope: 'user' }));
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
  const sink = {
    onEntry: (file, entry, now) => tracker.ingest(file, entry, now),
    onMalformed: (file, err) => tracker.noteMalformed(file, err),
    onProblem: problem,
  };
  const roots = defaultRoots();
  watcher = new TranscriptWatcher({ roots, ...sink });
  watcher.start();

  // Sessions started in a WSL terminal live in each running distro's Linux
  // home. They get their own watcher, ticked only straight after a check
  // that the distro still runs: touching a stopped distro's files would
  // start it again. A root already watched above (CLAUDE_CONFIG_DIR) is
  // left to that watcher so no transcript is read twice.
  const known = new Set(roots.map((r) => rootKey(r)));
  wslWatcher = new TranscriptWatcher({ roots: [], ...sink });

  // The roster reads the agents folder next to each root, WSL ones included,
  // so it is refreshed from the same loop, straight after the check.
  let roster = { agents: [], problems: [] };
  let rosterAt = 0;
  function refreshRoster() {
    roster = readRoster(rosterDirs(), overrides);
    rosterAt = Date.now();
  }

  (async function followWsl() {
    try {
      wsl = await wslRoots();
      wslWatcher.setRoots(wsl.roots.filter((r) => !known.has(rootKey(r))));
      wslWatcher.tick();
      if (Date.now() - rosterAt >= ROSTER_MS) refreshRoster();
    } catch (err) {
      problem(`Following WSL sessions failed (${err.name})`, err.message);
    } finally {
      setTimeout(followWsl, wsl.roots.length ? WSL_MS : WSL_IDLE_MS);
    }
  })();

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

  // The performance report, built in a separate process so reading weeks of
  // transcripts never freezes the hospital, then shown in its own window.
  // It reads the same folders this app watches, WSL homes included.
  const reportsDir = path.join(app.getPath('userData'), 'reports');
  let lastReport;
  let reportWin;
  ipcMain.handle('home:build-report', (_event, days) => new Promise((resolve) => {
    const n = Number(days);
    if (![7, 28, 90].includes(n)) {
      resolve({ ok: false, error: 'Choose 7, 28 or 90 days.' });
      return;
    }
    const roots = [...watcher.roots, ...wslWatcher.roots];
    const child = utilityProcess.fork(path.join(__dirname, '..', 'src', 'report', 'agent-report.js'),
      ['--days', String(n), '--out', reportsDir, '--roots', JSON.stringify(roots)], { stdio: 'pipe' });
    let err = '';
    let answered = false;
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {}); // the CLI summary; nothing to show here
    child.on('message', (result) => {
      answered = true;
      if (result && result.ok) {
        lastReport = result;
        openReport(result.html);
        resolve({ ok: true, summary: result.summary, builtAt: Date.now() });
      } else {
        resolve({ ok: false, error: (result && result.error) || 'The report could not be built.' });
      }
    });
    child.on('exit', (code) => {
      if (answered) return;
      resolve({ ok: false, error: `The report could not be built (exit ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}` });
    });
  }));

  function openReport(file) {
    if (reportWin && !reportWin.isDestroyed()) {
      reportWin.loadFile(file);
      reportWin.focus();
      return;
    }
    reportWin = new BrowserWindow({
      width: 1180,
      height: 900,
      title: 'Agent performance',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    reportWin.webContents.on('will-navigate', (e) => e.preventDefault());
    reportWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    reportWin.loadFile(file);
  }

  ipcMain.handle('home:show-report-files', () => {
    if (lastReport) shell.showItemInFolder(lastReport.html);
    else shell.openPath(reportsDir);
    return true;
  });

  // Saving a layout: validate, write, then use it. Helpers already on shift
  // keep their room; new ones follow the new assignments.
  ipcMain.handle('home:save-layout', (_event, proposed) => {
    let next;
    try {
      next = validateLayout(proposed);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // rooms.json may name a department this change removes. Refuse rather
    // than send helpers to a room that no longer exists.
    try {
      validateOverrides(fileOverrides, new Set(roomsWith(next).map((r) => r.id)));
    } catch (err) {
      return { ok: false, error: `rooms.json still uses a room this change removes: ${err.message}. Edit rooms.json first.` };
    }
    try {
      fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
      fs.writeFileSync(layoutFile, `${JSON.stringify({ departments: next.departments.map(({ id, kind, name, purpose, cell, agents }) => ({ id, kind, name, purpose, cell, agents })) }, null, 2)}\n`);
    } catch (err) {
      return { ok: false, error: `The layout could not be saved (${err.code || err.message})` };
    }
    layout = next;
    overrides = { ...overridesFrom(layout), ...fileOverrides };
    tracker.overrides = overrides;
    rosterAt = 0; // re-read on the next WSL check, which is at most 5 s away
    return { ok: true, config: config() };
  });

  createWindow();

  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('home:snapshot', {
      ...tracker.snapshot(),
      watcher: (() => {
        const a = watcher.status();
        const b = wslWatcher.status();
        return { roots: [...a.roots, ...b.roots], filesTailed: a.filesTailed + b.filesTailed };
      })(),
      roster: roster.agents,
      problems: [...startupProblems, ...problems.values(), ...wsl.problems, ...roster.problems],
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
