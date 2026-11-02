'use strict';

const { app, BrowserWindow, ipcMain, shell, utilityProcess, net, session, Notification, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { Tracker } = require('../src/core/tracker');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');
const { readRoster } = require('../src/core/roster');
const { wslRoots, rootKey } = require('../src/core/wsl');
const { coworkRoots } = require('../src/core/cowork');
const fleet = require('../src/core/fleet');
const projectList = require('../src/core/projects');
const jobFiles = require('../src/core/jobs');
const workFinder = require('../src/core/work');
const { findClashes } = require('../src/core/clashes');
const { inspectWorktrees } = require('../src/core/worktrees');
const assistantFiles = require('../src/core/assistant');
const {
  DEPARTMENT_KINDS, validateOverrides, validateLayout, roomsWith, gardensWith, overridesFrom, openCells,
} = require('../src/core/rooms');
const decorCatalogue = require('../src/core/decor');
const weatherService = require('../src/core/weather');
const officePack = require('../src/core/officepack');
const { UsageScanner } = require('../src/core/usage');
const { SystemLog, snapshotEvents, utilisation, reminderSummary, tailFile } = require('../src/core/syslog');

const PUSH_MS = 500;
const ROSTER_MS = 30_000;
const WSL_MS = 1_500; // WSL files are read this often, each time after a running check
const WSL_IDLE_MS = 5_000; // how often to look for a distro while none is running
const COWORK_MS = 30_000; // how often to look for new Cowork tasks
const FLEET_MS = 5_000; // how often to write and read the shared folder
const HERE = os.hostname() || 'This computer';

let win;
let tracker;
let syslog; // the system log, in the app's data folder (see src/core/syslog.js)
let watcher;
let wslWatcher;
let wsl = { roots: [], problems: [] };
let coworkWatcher;
let cowork = { roots: [], tasks: new Map(), problems: [] };
let mini; // the mini window, when open
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
  syslog?.write('errors', 'problem', { what: label, detail });
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

// Every transcripts folder the app reads: ~/.claude, WSL homes, Cowork tasks.
const allRoots = () => [...watcher.roots, ...wslWatcher.roots, ...coworkWatcher.roots];

// Where one transcript came from, for the board, the mini window and the
// shared folder. Paths on Windows ignore case.
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function sourceOf(file) {
  const f = norm(file);
  for (const root of coworkWatcher?.roots ?? []) {
    if (f.startsWith(norm(root))) {
      const t = cowork.tasks.get(root) ?? {};
      return { source: 'cowork', computer: HERE, title: t.title, project: t.project };
    }
  }
  for (const root of wslWatcher?.roots ?? []) {
    if (f.startsWith(norm(root))) {
      const distro = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(root)?.[1];
      return { source: 'wsl', computer: `${HERE} · WSL${distro ? ` ${distro}` : ''}` };
    }
  }
  return { source: 'code', computer: HERE };
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

  // Launch option: --demo shows scripted patients.
  const query = {};
  if (process.argv.includes('--demo')) query.demo = '1';
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query });
}

// Local only: Chromium's own background fetches (component updates and the
// like) are turned off before the app is ready, as a backstop to the spell
// checker being switched off below. Nothing leaves the machine unless the
// user turns on the real weather or presses Update.
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');

// Crashes in the main process are logged and shown under "Needs attention"
// rather than lost.
function crashed(kind, err) {
  const first = String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ');
  syslog?.write('errors', kind, { where: 'main', error: first });
  problem(`Something went wrong inside the app (${kind}); see the system log`, String(err?.message ?? err).slice(0, 120));
}
process.on('uncaughtException', (err) => crashed('crash', err));
process.on('unhandledRejection', (err) => crashed('unhandled', err));

app.whenReady().then(() => {
  syslog = new SystemLog(path.join(app.getPath('userData'), 'logs'));
  for (const p of startupProblems) syslog.write('errors', 'problem', { what: p.label, detail: p.detail });
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
  tracker = new Tracker({ overrides, sourceOf });
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

  // Cowork tasks of the Claude desktop app: their own transcripts folders,
  // looked for again every half minute as new tasks start. Roots the other
  // watchers already read are left to them.
  coworkWatcher = new TranscriptWatcher({ roots: [], ...sink });
  coworkWatcher.start();
  (function followCowork() {
    try {
      cowork = coworkRoots();
      const taken = new Set([...watcher.roots, ...wslWatcher.roots].map((r) => rootKey(r)));
      coworkWatcher.setRoots(cowork.roots.filter((r) => !taken.has(rootKey(r))));
    } catch (err) {
      problem(`Looking for Cowork tasks failed (${err.name})`, err.message);
    } finally {
      setTimeout(followCowork, COWORK_MS);
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
      roomSize: decorCatalogue.ROOM_SIZE,
      roomItems: decorCatalogue.ROOM_ITEMS,
      defaultRoomItems: decorCatalogue.DEFAULT_ROOM_ITEMS,
      gardenSize: decorCatalogue.GARDEN_SIZE,
      plants: decorCatalogue.PLANTS,
      defaultGardens: decorCatalogue.DEFAULT_GARDENS,
    },
    overridesFile,
    layoutFile,
    // Agents rooms.json places: dragging them would have no effect.
    pinned: Object.keys(fileOverrides),
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
  // `details`: privacy mode is off, so Agent-call descriptions may show.
  ipcMain.handle('home:build-report', (_event, days, details) => new Promise((resolve) => {
    const n = Number(days);
    if (![7, 28, 90].includes(n)) {
      resolve({ ok: false, error: 'Choose 7, 28 or 90 days.' });
      return;
    }
    const roots = allRoots();
    const child = utilityProcess.fork(path.join(__dirname, '..', 'src', 'report', 'agent-report.js'),
      ['--days', String(n), '--out', reportsDir, '--roots', JSON.stringify(roots), ...(details === true ? ['--details'] : [])], { stdio: 'pipe' });
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
        moves: next.moves,
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

  // Claude Code use over 5 hours, today and 7 days, from every transcript
  // folder the app watches. A pass reads only lines added since the last.
  const usage = new UsageScanner({ roots: [] });
  let usageSummary;
  (async function followUsage() {
    try {
      usage.setRoots(allRoots());
      await usage.scan();
      usageSummary = usage.summary();
    } catch (err) {
      problem(`Counting Claude Code use failed (${err.code || err.name})`, err.message);
    } finally {
      setTimeout(followUsage, 60_000);
    }
  })();

  // Desktop notifications, asked for by the page (context nearly full, a
  // usage limit, the user's own warning level). Shown by Windows, locally.
  ipcMain.handle('home:notify', (_event, { title, body } = {}) => {
    if (!Notification.isSupported()) return { ok: false };
    new Notification({ title: String(title ?? '').slice(0, 80), body: String(body ?? '').slice(0, 240), silent: false }).show();
    return { ok: true };
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
    syslog.write('activity', 'team-install', { added: res.installed.join(','), skipped: res.skipped.join(','), errors: res.errors.length || undefined });
    rosterAt = 0; // the new agents show in the hospital at the next check
    return { ok: res.errors.length === 0, ...res };
  });
  ipcMain.handle('pack:update', () => {
    let versions;
    try {
      versions = JSON.parse(fs.readFileSync(path.join(packDir, 'versions.json'), 'utf8'));
    } catch (err) {
      return { ok: false, error: `The app's list of team versions could not be read (${err.code || err.message})` };
    }
    const res = officePack.updatePack(packDir, claudeDir, versions);
    for (const e of res.errors) problem(`Office pack: ${e}`, claudeDir);
    syslog.write('activity', 'team-update', {
      added: res.added.join(','), updated: res.updated.join(','), edited: res.edited.join(','),
      ownAgents: res.own.agents.length, ownSkills: res.own.skills.length, errors: res.errors.length || undefined,
    });
    rosterAt = 0;
    return { ok: res.errors.length === 0, ...res };
  });

  // ---- the system log ------------------------------------------------------------
  const logDir = path.join(app.getPath('userData'), 'logs');
  const reminderLog = path.join(claudeDir, officePack.HOOK_FILE.replace(/\.sh$/, '.log'));
  const teamState = () => {
    try {
      const st = officePack.packStatus(packDir, claudeDir);
      return {
        reminders: st.items.find((i) => i.kind === 'hook')?.installed ? 'on' : 'off',
        team: `${st.items.filter((i) => i.kind !== 'hook' && i.installed).length}/${st.items.filter((i) => i.kind !== 'hook').length}`,
      };
    } catch (err) {
      return { team: `unreadable (${err.code || err.message})` };
    }
  };
  syslog.write('activity', 'app-start', { version: app.getVersion(), ...teamState() });
  ipcMain.handle('home:log-tail', (_event, which) => {
    try {
      if (which === 'reminders') {
        const lines = tailFile(reminderLog, 1000);
        return { ok: true, lines: lines.slice(-60), summary: reminderSummary(lines), team: teamState() };
      }
      if (which !== 'activity' && which !== 'errors') return { ok: false, error: 'Unknown log' };
      return { ok: true, lines: syslog.tail(which, 80), dir: logDir };
    } catch (err) {
      return { ok: false, error: `The log could not be read (${err.code || err.message})` };
    }
  });
  ipcMain.handle('home:log-open', () => {
    fs.mkdirSync(logDir, { recursive: true });
    return shell.openPath(logDir).then((error) => ({ ok: !error, error }));
  });
  let rendererErrors = 0;
  ipcMain.handle('home:log-error', (_event, { message, where } = {}) => {
    // Capped, so a renderer stuck in a loop cannot fill the disk.
    if (++rendererErrors > 50) return { ok: false };
    syslog.write('errors', 'renderer-error', { where: String(where ?? '').slice(0, 120), error: String(message ?? '').slice(0, 300) });
    return { ok: true };
  });

  // ---- running now, on every computer ------------------------------------
  // Off until the user picks a shared folder; see src/core/fleet.js for what
  // the status file holds (never more than privacy mode shows).
  const fleetFile = path.join(app.getPath('userData'), 'fleet.json');
  let fleetDir;
  // 'folder': write this computer's file and read the others (a synced
  // folder). 'git': pull only, from a clone of the agents-status branch that
  // the other computers post to every hour (see that branch's README).
  let fleetMode = 'folder';
  let lastPull;
  // This copy's own id, so computers with the same name keep apart.
  let fleetId;
  try {
    const saved = JSON.parse(fs.readFileSync(fleetFile, 'utf8'));
    if (typeof saved.dir === 'string' && saved.dir) fleetDir = saved.dir;
    if (saved.mode === 'git') fleetMode = 'git';
    if (typeof saved.id === 'string' && /^[a-f0-9]{8,16}$/.test(saved.id)) fleetId = saved.id;
  } catch (err) {
    if (err.code !== 'ENOENT') problem('fleet.json could not be read; sharing with other computers is off', fleetFile);
  }
  if (!fleetId) {
    fleetId = require('crypto').randomBytes(5).toString('hex');
    // Kept straight away when sharing is on, so a restart writes the same file.
    if (fleetDir) {
      try {
        fs.writeFileSync(fleetFile, `${JSON.stringify({ dir: fleetDir, id: fleetId, mode: fleetMode }, null, 2)}\n`);
      } catch (err) {
        problem(`fleet.json could not be saved (${err.code || err.message})`, fleetFile);
      }
    }
  }
  let fleetState = { computers: [], problems: [] };
  const saveFleet = () => {
    fs.mkdirSync(path.dirname(fleetFile), { recursive: true });
    fs.writeFileSync(fleetFile, `${JSON.stringify({ dir: fleetDir ?? null, id: fleetId, mode: fleetMode }, null, 2)}\n`);
  };
  const statusDir = () => (fleetMode === 'git' ? path.join(fleetDir, 'status') : fleetDir);
  // Pull only: fast-forward, quietly, at most every 10 minutes. The one trip
  // online this mode makes, and only once the user has picked the folder.
  function pullStatus() {
    if (fleetMode !== 'git' || !fleetDir) return;
    // Never a sign-in window for a background pull (Git Credential
    // Manager would ask which account to use): a failure shows under
    // "Needs attention" instead.
    execFile('git', ['-C', fleetDir, 'pull', '--ff-only', '-q'], { timeout: 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } },
      (err, _out, stderr) => {
        lastPull = err
          ? { at: Date.now(), ok: false, error: err.code === 'ENOENT' ? 'git was not found' : String(stderr || err.message).trim().split('\n').pop() }
          : { at: Date.now(), ok: true };
      });
  }
  setInterval(pullStatus, 10 * 60_000);
  pullStatus();
  ipcMain.handle('home:fleet-git-choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Pick your clone of the agents-status branch',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    const dir = res.filePaths[0];
    if (!fs.existsSync(path.join(dir, '.git')) || !fs.existsSync(path.join(dir, 'post-status.js'))) {
      return { ok: false, error: 'That is not a clone of the agents-status branch (see its README for the one-line clone).' };
    }
    fleetDir = dir;
    fleetMode = 'git';
    try {
      saveFleet();
    } catch (err) {
      return { ok: false, error: `The setting could not be saved (${err.code || err.message})` };
    }
    pullStatus();
    return { ok: true, dir };
  });
  ipcMain.handle('home:fleet-choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Pick a folder your computers share (OneDrive, Dropbox, a network drive)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    try {
      fleetDir = path.join(res.filePaths[0], 'agents-home-status');
      fleetMode = 'folder';
      fs.mkdirSync(fleetDir, { recursive: true });
      saveFleet();
      return { ok: true, dir: fleetDir };
    } catch (err) {
      fleetDir = undefined;
      return { ok: false, error: `That folder cannot be used (${err.code || err.message})` };
    }
  });
  ipcMain.handle('home:fleet-off', () => {
    // This computer's file is left for the others to see go offline.
    fleetDir = undefined;
    fleetState = { computers: [], problems: [] };
    try {
      saveFleet();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `The setting could not be saved (${err.code || err.message})` };
    }
  });
  setInterval(() => {
    if (!fleetDir) return;
    const now = Date.now();
    const problemsNow = [];
    if (fleetMode === 'folder') {
      try {
        fleet.writeShare(fleetDir, fleet.summaryOf(tracker.snapshot(now), HERE, now, fleetId));
      } catch (err) {
        problemsNow.push({ label: `This computer's status could not be written to the shared folder (${err.code || 'error'})`, detail: fleetDir, count: 1 });
      }
    } else if (lastPull && !lastPull.ok) {
      problemsNow.push({ label: `The status branch could not be pulled (${lastPull.error})`, detail: fleetDir, count: 1 });
    }
    const read = fleet.readShares(statusDir(), fleet.fileFor(HERE, fleetId), now);
    fleetState = { computers: read.computers, problems: [...problemsNow, ...read.problems.map((p) => ({ ...p, count: 1 }))] };
  }, FLEET_MS);

  // ---- the project list ------------------------------------------------------
  // ~/.agents-home/projects.json, written by the personal-assistant and
  // project-manager agents and by the user here. Re-read when it changes;
  // every change from the app is made to a fresh read, so nothing an agent
  // wrote a moment ago is lost.
  const projectsPath = projectList.projectsFile();
  let projects = { data: { projects: [] }, problems: [], missing: true };
  let projectsStamp = '';
  function readProjects(force = false) {
    let stamp = 'missing';
    try {
      const st = fs.statSync(projectsPath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (err.code !== 'ENOENT') stamp = `error:${err.code}`;
    }
    if (!force && stamp === projectsStamp) return;
    projectsStamp = stamp;
    projects = projectList.loadProjects(projectsPath);
  }
  // The personal assistant's open questions and last scan, shown above the
  // project list. Read only: the assistant writes these files.
  const assistantPath = assistantFiles.assistantDir();
  let assistant = assistantFiles.loadAssistant(assistantPath);
  readProjects(true);
  setInterval(() => {
    readProjects();
    assistant = assistantFiles.loadAssistant(assistantPath);
  }, 2_000);
  ipcMain.handle('home:project-change', (_event, change) => {
    readProjects(true);
    if (!projects.raw) return { ok: false, error: `The project list cannot be changed: ${projects.problems[0]}` };
    try {
      const next = projectList.applyChange(projects.raw, change);
      projectList.saveProjects(projectsPath, next);
    } catch (err) {
      return { ok: false, error: err.code ? `The project list could not be saved (${err.code})` : err.message };
    }
    readProjects(true);
    return { ok: true };
  });
  // A project's worktrees, looked at only when the user opens them.
  ipcMain.handle('home:worktrees', async (_event, id) => {
    const p = (projects.data?.projects ?? []).find((x) => x.id === id);
    if (!p?.path) return { ok: false, error: 'This project has no folder on this computer.' };
    try {
      return await inspectWorktrees(p.path);
    } catch (err) {
      return { ok: false, error: `The worktrees could not be read (${err.message})` };
    }
  });
  ipcMain.handle('home:projects-show', async () => {
    if (fs.existsSync(projectsPath)) {
      shell.showItemInFolder(projectsPath);
      return { ok: true, file: projectsPath };
    }
    // No list yet: open the folder it will live in, made if need be.
    try {
      fs.mkdirSync(path.dirname(projectsPath), { recursive: true });
    } catch (err) {
      return { ok: false, file: projectsPath, error: `The folder for the project list could not be made (${err.code || err.message})` };
    }
    const error = await shell.openPath(path.dirname(projectsPath));
    return error ? { ok: false, file: projectsPath, error: `The folder could not be opened: ${error}` } : { ok: true, file: projectsPath };
  });

  // ---- long jobs and the machine ------------------------------------------------
  // Jobs report with agents_progress.py into ~/.agents-home/jobs (read every
  // 2 s). The machine line: CPU from the system's own counters, GPU from
  // nvidia-smi every 30 s when it is installed. Local, read only.
  let jobs = { jobs: [], problems: [] };
  setInterval(() => { jobs = jobFiles.readJobs(); }, 2_000);
  jobs = jobFiles.readJobs();
  let machine;
  let cpuPrev = os.cpus();
  let noGpu = false;
  function sampleMachine() {
    const cpus = os.cpus();
    let total = 0;
    let idle = 0;
    cpus.forEach((c, i) => {
      const p = cpuPrev[i]?.times ?? c.times;
      const t = c.times;
      total += Object.keys(t).reduce((n, k) => n + t[k] - (p[k] ?? 0), 0);
      idle += t.idle - p.idle;
    });
    cpuPrev = cpus;
    const base = { cpu: total > 0 ? Math.round(100 * (1 - idle / total)) : undefined, memUsed: Math.round((os.totalmem() - os.freemem()) / 2 ** 20), memTotal: Math.round(os.totalmem() / 2 ** 20) };
    if (noGpu) {
      machine = { ...base, gpus: [] };
      return;
    }
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 5_000, windowsHide: true },
      (err, out) => {
        if (err) {
          // No NVIDIA GPU or driver: stop asking, show CPU only.
          noGpu = err.code === 'ENOENT';
          machine = { ...base, gpus: [] };
          return;
        }
        machine = jobFiles.cleanMachine({ ...base, gpus: String(out).trim().split('\n').filter(Boolean).map((l) => {
          const [name, util, used, totalMem, temp] = l.split(',').map((x) => x.trim());
          return { name: name.replace(/^NVIDIA\s+/, ''), util: Number(util), memUsed: Number(used), memTotal: Number(totalMem), temp: Number(temp) };
        }) });
      });
  }
  setInterval(sampleMachine, 30_000);
  setTimeout(sampleMachine, 3_000);

  // Running work found without any help from the scripts (src/core/work.js),
  // every 30 s. A process that reports as a job is shown once, as the job.
  let work = { work: [] };
  let looking = false;
  function findWork() {
    if (looking) return;
    looking = true;
    workFinder.detectWork({ projects: projects.data?.projects ?? [] }, (res) => {
      looking = false;
      work = res;
    });
  }
  setInterval(findWork, 30_000);
  setTimeout(findWork, 4_000);

  // ---- the mini window ------------------------------------------------------
  // A small window that stays on top, like a music player's mini mode: what
  // runs now, per computer and project, and each session's to-do list.
  const miniFile = path.join(app.getPath('userData'), 'mini.json');
  function openMini() {
    if (mini && !mini.isDestroyed()) {
      mini.show();
      mini.focus();
      return;
    }
    let bounds = {};
    try {
      bounds = JSON.parse(fs.readFileSync(miniFile, 'utf8'));
    } catch {
      // No saved place yet (or an unreadable one): open at the default size.
    }
    mini = new BrowserWindow({
      width: Number(bounds.width) || 360,
      height: Number(bounds.height) || 520,
      ...(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 280,
      minHeight: 200,
      alwaysOnTop: true,
      // No system title bar: the window's own header moves it, and has a close button.
      frame: false,
      roundedCorners: true,
      title: "Agent's Home · mini",
      backgroundColor: '#fbfaf8',
      autoHideMenuBar: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    mini.setAlwaysOnTop(true, 'floating');
    mini.webContents.on('will-navigate', (e) => e.preventDefault());
    mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mini.on('close', () => {
      try {
        fs.writeFileSync(miniFile, JSON.stringify(mini.getBounds()));
      } catch (err) {
        problem(`The mini window's place could not be saved (${err.code || err.message})`, miniFile);
      }
    });
    mini.on('closed', () => { mini = undefined; });
    mini.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'), { query: process.argv.includes('--demo') ? { demo: '1' } : {} });
  }
  ipcMain.handle('home:mini-open', () => {
    openMini();
    return { ok: true };
  });
  ipcMain.handle('home:mini-close', () => {
    if (mini && !mini.isDestroyed()) mini.close();
    return { ok: true };
  });
  ipcMain.handle('home:mini-pin', (_event, on) => {
    if (mini && !mini.isDestroyed()) mini.setAlwaysOnTop(on !== false, 'floating');
    return { ok: true };
  });
  ipcMain.handle('home:show-main', () => {
    if (!win || win.isDestroyed()) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return { ok: true };
  });
  if (process.argv.includes('--mini')) openMini();

  createWindow();

  let lastSnap;
  let lastSummary = 0;
  let lastSummaryText = '';
  const seenProblems = new Set();
  const SUMMARY_MS = 5 * 60_000;
  setInterval(() => {
    const mainOpen = win && !win.isDestroyed();
    const miniOpen = mini && !mini.isDestroyed();
    if (!mainOpen && !miniOpen) return;
    const snap = tracker.snapshot();
    // Which listed project each session works in, from its folder (the
    // folder itself is never sent).
    for (const s of snap.sessions) {
      const hit = projectList.projectFor(tracker.sessions.get(s.id)?.cwd, projects.data?.projects ?? []);
      if (hit) {
        s.projectId = hit.id;
        s.inCopy = hit.copy;
      }
    }
    // What changed since the last push, then who is working (every few
    // minutes while anyone is, and once when everyone has stopped).
    for (const { event, fields } of snapshotEvents(lastSnap, snap)) syslog.write('activity', event, fields);
    lastSnap = snap;
    const now = Date.now();
    if (now - lastSummary >= SUMMARY_MS) {
      const u = utilisation(snap);
      const text = JSON.stringify(u);
      if (u.sessions || text !== lastSummaryText) syslog.write('activity', 'summary', { ...u, ...teamState() });
      lastSummary = now;
      lastSummaryText = text;
    }
    if (syslog.failed && !seenProblems.has('log')) {
      seenProblems.add('log');
      problem(`The system log could not be written (${syslog.failed})`, logDir);
    }
    const payload = {
      ...snap,
      here: HERE,
      fleet: { on: Boolean(fleetDir), dir: fleetDir, mode: fleetMode, lastPull, computers: fleetState.computers },
      jobs: jobs.jobs,
      machine,
      work: work.work.filter((w) => !jobs.jobs.some((j) => j.pid === w.pid)),
      // Sessions working in the same checkout (their folders stay here).
      clashes: findClashes(snap.sessions.map((s) => ({ id: s.id, project: s.project, lastActivityAt: s.lastActivityAt, cwd: tracker.sessions.get(s.id)?.cwd }))),
      projects: {
        file: projectsPath, missing: Boolean(projects.missing), ok: Boolean(projects.data),
        list: projects.data?.projects ?? [],
        assistant,
      },
      sources: { cowork: coworkWatcher.roots.length },
      watcher: (() => {
        const a = watcher.status();
        const b = wslWatcher.status();
        const c = coworkWatcher.status();
        return { roots: [...a.roots, ...b.roots, ...c.roots], filesTailed: a.filesTailed + b.filesTailed + c.filesTailed };
      })(),
      roster: roster.agents,
      usage: usageSummary,
      problems: [
        ...startupProblems, ...problems.values(), ...wsl.problems, ...roster.problems,
        ...cowork.problems.map((p) => ({ ...p, count: 1 })), ...fleetState.problems, ...jobs.problems,
        ...(work.problem ? [{ label: work.problem, detail: '', count: 1 }] : []),
        ...projects.problems.map((label) => ({ label: `Project list: ${label}`, detail: projectsPath, count: 1 })),
        ...assistant.problems.map((label) => ({ label: `Personal assistant: ${label}`, detail: assistantPath, count: 1 })),
        ...(usageSummary?.problems ?? []).map((p) => ({ label: `A transcript ${p.what} while counting use`, detail: p.where, count: 1 })),
        ...(usageSummary?.unreadable ? [{ label: 'Lines that could not be read while counting use', detail: '', count: usageSummary.unreadable }] : []),
      ],
    };
    if (mainOpen) win.webContents.send('home:snapshot', payload);
    if (miniOpen) mini.webContents.send('home:snapshot', payload);
    // Problems that do not come through problem() go to the log once each.
    for (const p of [...wsl.problems, ...roster.problems]) {
      const key = `${p.label}|${p.detail ?? ''}`;
      if (seenProblems.has(key)) continue;
      seenProblems.add(key);
      syslog.write('errors', 'problem', { what: p.label, detail: p.detail });
    }
  }, PUSH_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  watcher?.stop();
  coworkWatcher?.stop();
  if (process.platform !== 'darwin') app.quit();
});
