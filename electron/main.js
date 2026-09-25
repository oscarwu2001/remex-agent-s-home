'use strict';

const { app, BrowserWindow, ipcMain, shell, utilityProcess, net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const { wslRoots, rootKey } = require('../src/core/wsl');
const {
  DEPARTMENT_KINDS, validateOverrides, validateLayout, roomsWith, gardensWith, overridesFrom, openCells,
} = require('../src/core/rooms');
const decorCatalogue = require('../src/core/decor');
const weatherService = require('../src/core/weather');
const officePack = require('../src/core/officepack');

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
    return { file, layout: { departments: [], gardens: [] } };
  }
  try {
    return { file, layout: validateLayout(JSON.parse(text)) };
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'it is not valid JSON' : err.message;
    startupProblems.push({ label: `layout.json ignored: ${reason}; showing the core hospital`, detail: file, count: 1 });
    return { file, layout: { departments: [], gardens: [] } };
  }
}

// Floors, room decorations and gardens, from decor.json. It is kept apart
// from layout.json so a bad decoration can never cost the user their
// departments. Entries that do not check out are left out and each one is
// reported; the file itself is only rewritten when the user changes decor.
function loadDecor(rooms, gardens) {
  const file = path.join(app.getPath('userData'), 'decor.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // No decor.json is the normal case: the default look.
    if (err.code !== 'ENOENT') {
      startupProblems.push({ label: `decor.json could not be read (${err.code}); showing the default look`, detail: file, count: 1 });
    }
    return { file, decor: decorCatalogue.checkDecor(undefined, rooms, gardens).decor };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    startupProblems.push({ label: 'decor.json ignored: it is not valid JSON; showing the default look', detail: file, count: 1 });
    return { file, decor: decorCatalogue.checkDecor(undefined, rooms, gardens).decor };
  }
  const { decor, problems: found } = decorCatalogue.checkDecor(parsed, rooms, gardens);
  for (const p of found) startupProblems.push({ label: `decor.json: ${p}; left out`, detail: file, count: 1 });
  return { file, decor };
}

function writeDecor(file, decor) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(decor, null, 2)}\n`);
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
      // The spell checker downloads its dictionaries from Google.
      spellcheck: false,
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

// Local only: Chromium's own background fetches (component updates and the
// like) are turned off before the app is ready, as a backstop to the spell
// checker being switched off below. Nothing leaves the machine unless the
// user turns on the real weather or presses Update.
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');

app.whenReady().then(() => {
  // The spell checker would fetch a dictionary from Google at start; the app
  // has no text worth checking, so it is off, with no languages to fetch.
  session.defaultSession.setSpellCheckerEnabled(false);
  try {
    session.defaultSession.setSpellCheckerLanguages([]);
  } catch {
    // macOS uses the system spell checker and fetches nothing; safe to skip.
  }
  const { file: layoutFile, layout: loaded } = loadLayout();
  let layout = loaded;
  const ids = () => new Set(roomsWith(layout).map((r) => r.id));
  const { file: overridesFile, overrides: fileOverrides } = loadOverrides(ids());
  // rooms.json, written by hand, wins over assignments made in the app.
  let overrides = { ...overridesFrom(layout), ...fileOverrides };
  const { file: decorFile, decor: loadedDecor } = loadDecor(roomsWith(layout), gardensWith(layout));
  let decor = loadedDecor;
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
    gardens: gardensWith(layout),
    decor,
    decorCatalogue: {
      floors: decorCatalogue.FLOORS,
      defaultFloor: decorCatalogue.DEFAULT_FLOOR,
      spotsPerRoom: decorCatalogue.SPOTS_PER_ROOM,
      decorations: decorCatalogue.DECORATIONS,
      gardenSize: decorCatalogue.GARDEN_SIZE,
      plants: decorCatalogue.PLANTS,
      defaultGardens: decorCatalogue.DEFAULT_GARDENS,
    },
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
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
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
      fs.writeFileSync(layoutFile, `${JSON.stringify({
        departments: next.departments.map(({ id, kind, name, purpose, cell, agents }) => ({ id, kind, name, purpose, cell, agents })),
        gardens: next.gardens,
      }, null, 2)}\n`);
    } catch (err) {
      return { ok: false, error: `The layout could not be saved (${err.code || err.message})` };
    }
    layout = next;
    // A removed department takes its floor and decorations with it, so
    // decor.json never names a room that is gone.
    const gone = Object.keys(decor.rooms).filter((id) => !roomsWith(layout).some((r) => r.id === id));
    const goneGardens = Object.keys(decor.gardens).filter((id) => !gardensWith(layout).some((g) => g.id === id));
    if (gone.length || goneGardens.length) {
      decor = {
        rooms: Object.fromEntries(Object.entries(decor.rooms).filter(([id]) => !gone.includes(id))),
        gardens: Object.fromEntries(Object.entries(decor.gardens).filter(([id]) => !goneGardens.includes(id))),
      };
      try {
        writeDecor(decorFile, decor);
      } catch (err) {
        problem(`decor.json could not be updated (${err.code || err.message}); it still names a removed department`, decorFile);
      }
    }
    overrides = { ...overridesFrom(layout), ...fileOverrides };
    tracker.overrides = overrides;
    rosterAt = 0; // re-read on the next WSL check, which is at most 5 s away
    return { ok: true, config: config() };
  });

  // Saving decor: every entry must check out, or nothing is written.
  ipcMain.handle('home:save-decor', (_event, proposed) => {
    const { decor: next, problems: found } = decorCatalogue.checkDecor(proposed, roomsWith(layout), gardensWith(layout));
    if (found.length) return { ok: false, error: `That could not be saved: ${found[0]}` };
    try {
      writeDecor(decorFile, next);
    } catch (err) {
      return { ok: false, error: `Your changes could not be saved (${err.code || err.message})` };
    }
    decor = next;
    return { ok: true, decor };
  });

  // The real weather: the app's only trip online, made only when the user
  // has turned "Use the real weather" on (the renderer never asks before
  // that), only to Open-Meteo, and carrying only a place name or a rounded
  // latitude and longitude.
  async function askWeatherService(url) {
    if (!weatherService.HOSTS.has(new URL(url).host)) throw new Error('not the weather service');
    // Electron's own network stack, so the system proxy settings apply.
    const res = await net.fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
    return res.json();
  }
  const reason = (err) => (err.name === 'TimeoutError' ? 'the weather service did not answer in time'
    : /^net::ERR_/.test(err.message) ? `the weather service could not be reached (${err.message.slice(5)}); check the internet connection or proxy`
      : err.message);
  ipcMain.handle('home:weather-search', async (_event, name) => {
    try {
      return { ok: true, places: weatherService.parsePlaces(await askWeatherService(weatherService.searchUrl(name))) };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  });
  ipcMain.handle('home:weather-now', async (_event, place, unit) => {
    try {
      return { ok: true, now: weatherService.parseCurrent(await askWeatherService(weatherService.forecastUrl(place, unit))) };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  });

  // Updating: only when the user presses the button, and only for a copy run
  // from a git clone (npm start). It pulls fast-forward only, refuses when
  // the clone has local edits, and restarts on the new code. An installed
  // copy has no clone to pull into and is updated from a new installer.
  const repo = app.getAppPath();
  const git = (args, timeout = 20_000) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        const first = String(stderr || '').trim().split('\n').find((l) => l.trim()) || err.message;
        return reject(new Error(err.code === 'ENOENT' ? 'git was not found; install Git for Windows and try again' : first));
      });
  });
  function updateInfo() {
    if (app.isPackaged || !fs.existsSync(path.join(repo, '.git'))) {
      return { available: false, reason: 'This copy was installed from the setup file. To update, download the newest build from the repository’s Actions tab and run it.' };
    }
    return { available: true };
  }
  ipcMain.handle('home:update-info', async () => {
    const info = updateInfo();
    if (!info.available) return { ...info, version: app.getVersion() };
    try {
      const [branch, commit] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['rev-parse', '--short', 'HEAD'])]);
      return { ...info, version: app.getVersion(), branch, commit };
    } catch (err) {
      return { available: false, reason: `The git clone could not be read: ${err.message}`, version: app.getVersion() };
    }
  });
  ipcMain.handle('home:update', async () => {
    const info = updateInfo();
    if (!info.available) return { ok: false, error: info.reason };
    try {
      const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) {
        const n = dirty.split('\n').length;
        return { ok: false, error: `This clone has ${n} changed file${n === 1 ? '' : 's'} not yet committed. Commit or stash them first, so the update cannot overwrite your work.` };
      }
      const before = await git(['rev-parse', 'HEAD']);
      await git(['pull', '--ff-only'], 180_000);
      const after = await git(['rev-parse', 'HEAD']);
      if (after === before) return { ok: true, updated: false, message: 'Already up to date.' };
      const changed = (await git(['diff', '--name-only', before, after])).split('\n');
      const count = (await git(['rev-list', '--count', `${before}..${after}`])) || '?';
      if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
        // New or changed packages: restarting on the old ones could break
        // the app, and installing over a running Electron fails on Windows.
        return {
          ok: true, updated: true, restart: false,
          message: `Pulled ${count} new commit${count === '1' ? '' : 's'}. This update changes the app's packages: close the app, run "npm ci", then "npm start".`,
        };
      }
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 1200);
      return { ok: true, updated: true, restart: true, message: `Pulled ${count} new commit${count === '1' ? '' : 's'}. Restarting…` };
    } catch (err) {
      return { ok: false, error: `The update did not complete: ${err.message}` };
    }
  });

  // The Office pack: offered to the user, copied in only when they say yes,
  // into the Claude folder the app already reads (never over a file).
  const packDir = path.join(__dirname, '..', 'office-pack');
  const claudeDir = path.dirname(defaultRoots()[0]);
  ipcMain.handle('pack:status', () => {
    try {
      return { ok: true, ...officePack.packStatus(packDir, claudeDir) };
    } catch (err) {
      return { ok: false, error: `The Claude folder could not be read (${err.code || err.message})` };
    }
  });
  ipcMain.handle('pack:install', (_event, names) => {
    if (!Array.isArray(names) || !names.length) return { ok: false, error: 'Nothing was chosen.' };
    const res = officePack.installPack(packDir, claudeDir, names.map(String));
    for (const e of res.errors) problem(`Office pack: ${e}`, claudeDir);
    rosterAt = 0; // the new agents show in the hospital at the next check
    return { ok: res.errors.length === 0, ...res };
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
