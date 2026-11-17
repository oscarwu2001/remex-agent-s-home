'use strict';

const { app, BrowserWindow, ipcMain, shell, utilityProcess, net, session, Notification, dialog, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { Tracker, TIMING } = require('../src/core/tracker');
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
const fieldSurvey = require('../src/core/fieldsurvey');
const lineChat = require('../src/core/linechat');
const officePack = require('../src/core/officepack');
const { UsageScanner } = require('../src/core/usage');
const { SystemLog, logEvents, loggedSoFar, loggedFromLog, closeOnBoard, utilisation, reminderSummary, tailFile } = require('../src/core/syslog');

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
// As the app goes: writes what the log still waits to write and lets go of it.
let stopLog = () => {};
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

// fix: what the board links the line to ('check', 'settings' or 'refresh'), if any.
function problem(label, detail = '', fix = null) {
  const key = `${label}|${detail}`;
  const p = problems.get(key);
  if (p) {
    p.count += 1;
    p.at = Date.now();
    return;
  }
  problems.set(key, { label, detail, count: 1, at: Date.now(), ...(fix ? { fix } : {}) });
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

  // Windows shutting down or logging off: no quit events follow (stopLog).
  win.on('session-end', () => stopLog());

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
// user turns on the real weather or field feedback, or presses Update.
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
  // When the last run last wrote activity.log, taken before this run writes to it.
  const lastRunWrote = syslog.writtenAt('activity');
  for (const p of startupProblems) syslog.write('errors', 'problem', { what: p.label, detail: p.detail });
  // One copy of the app writes activity.log (SystemLog.claim): a second, such
  // as a build run from source beside the installed app, would write
  // everything again. It takes the log over once the first has stopped.
  let heldElsewhere; // the problem shown while another copy writes it
  if (!syslog.claim('activity')) {
    heldElsewhere = `Another copy of Agents Home (process ${syslog.heldBy}) is writing the system log, so this one leaves activity.log alone until that copy stops`;
    problem(heldElsewhere, syslog.dir);
  }
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
    holds: (file) => tracker.holds(file),
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

  // ---- field feedback -------------------------------------------------------
  // The answers to the user's field survey, from a Google Sheet they shared
  // with their own service account, or through the reader script attached
  // to it (its link and secret). Off until turned on in Settings; then
  // fetched from here only, on Monday, Wednesday and Friday at 08:00 (and on
  // start when a slot was missed), after a passing failure, and on Refresh
  // now, only from the hosts named in src/core/fieldsurvey.js. The key file
  // stays where the user keeps it: only its path is saved, and the key is
  // read for each fetch, never copied or logged. The reader's secret is kept
  // encrypted by the system (safeStorage) in its own file, read for each
  // fetch, never logged, never sent back to the window and deleted when the
  // feature is turned off. The rows are kept in the app's data folder
  // without identifying answers, so the board has them after a restart, and
  // deleted when the feature is turned off. The
  // decisions (when to read, what to keep, what to report) are in
  // fieldsurvey.js; this keeps the timers, the files, the requests and the IPC.
  const fieldFile = path.join(app.getPath('userData'), 'field-survey.json');
  const fieldCacheFile = path.join(app.getPath('userData'), 'field-survey-cache.json');
  // The encrypted secret with the reader it belongs to (fieldsurvey.sealSecret).
  const fieldSecretFile = path.join(app.getPath('userData'), 'field-reader-secret.json');
  const FIELD_CHECK_MS = 10 * 60_000; // how often to look whether a slot has come (a timer can miss one across sleep)
  const FIELD_TIMEOUT_MS = 20_000;
  const FIELD_STALE = 'The link, key or secret changed while reading; reading again.';
  // { enabled, source, sheetUrl, keyPath, readerUrl, columns: the user's
  // checked column roles }. source and readerUrl only once set.
  let field = { enabled: false, sheetUrl: '', keyPath: '', columns: [] };
  let fieldSecretSaved = fs.existsSync(fieldSecretFile);
  // The reader the saved secret belongs to (not secret), or null.
  let fieldSecretFor = null;
  if (fieldSecretSaved) {
    try {
      fieldSecretFor = fieldSurvey.secretFor(fs.readFileSync(fieldSecretFile, 'utf8'));
    } catch {
      fieldSecretFor = null; // unreadable now: the next read says so (secretFileError), and saving again replaces it
    }
  }
  // Whether this computer can keep the secret at all (safeStorage): null, or why not.
  const fieldStorageProblem = fieldSurvey.secretStorage({
    available: safeStorage.isEncryptionAvailable(), backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
  });
  // A read was asked for (a new secret, or a read that found its settings
  // changed under it): made at once (fieldsurvey.planFetch's asked).
  let fieldAsked = false;
  let fieldCache = null;
  let fieldSummary = null;
  let fieldSummaryError = null;
  let fieldKey = { clientEmail: null, error: null }; // read from the key file, for Settings
  let fieldRun = null; // the fetch under way
  let fieldGeneration = 0; // bumped when the link or key changes, so a fetch for the old ones is dropped
  let fieldTimer;
  let fieldLogged = '';
  let fieldSummarisedAt = 0; // the flags' 7-day window is as of then
  const writeJsonFile = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  // The saved link of the source in use, or null: no link yet, or one that
  // no longer reads (a read then says why, from the link's parser itself).
  const fieldLink = () => {
    try {
      return fieldSurvey.sourceLink(field);
    } catch {
      return null; // refreshField parses it again and reports the reason
    }
  };
  const fieldSource = () => fieldSurvey.sourceOf(field);
  try {
    const saved = JSON.parse(fs.readFileSync(fieldFile, 'utf8'));
    if (!saved || typeof saved !== 'object') throw new SyntaxError('not an object');
    let columns = [];
    try {
      columns = fieldSurvey.checkRoles(saved.columns ?? []);
    } catch {
      problem('The checked field feedback columns could not be read; check them again in Settings → Connections → Field feedback', fieldFile, 'check');
    }
    field = {
      enabled: saved.enabled === true,
      sheetUrl: typeof saved.sheetUrl === 'string' ? saved.sheetUrl : '',
      keyPath: typeof saved.keyPath === 'string' ? saved.keyPath : '',
      ...(fieldSurvey.SOURCES.includes(saved.source) ? { source: saved.source } : {}),
      ...(typeof saved.readerUrl === 'string' && saved.readerUrl ? { readerUrl: saved.readerUrl } : {}),
      columns,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') problem('The field feedback settings could not be read; field feedback is off until it is set again in Settings → Connections → Field feedback', fieldFile, 'settings');
  }
  function dropFieldCache() {
    fieldCache = null;
    fieldSummary = null;
    try {
      fs.rmSync(fieldCacheFile, { force: true });
    } catch (err) {
      problem(`The saved field feedback could not be removed (${err.code || err.message})`, fieldCacheFile);
    }
  }
  // Off keeps no secret, and another reader link drops the old reader's.
  // One that cannot be removed is said under Needs attention, and still
  // counts as saved, as it is.
  function dropFieldSecret() {
    try {
      fs.rmSync(fieldSecretFile, { force: true });
    } catch (err) {
      problem(`The saved reader secret could not be removed (${err.code || 'error'}); remove it from the app's data folder`, fieldSecretFile);
    }
    fieldSecretSaved = fs.existsSync(fieldSecretFile);
    if (!fieldSecretSaved) fieldSecretFor = null;
  }
  if (!field.enabled && fieldSecretSaved) dropFieldSecret();
  {
    // An earlier build kept the secret in field-reader-secret.bin, tied to
    // no reader. It is never read: it goes at start, and the reader asks for
    // its secret again. force: one already gone is no error.
    const legacy = path.join(app.getPath('userData'), 'field-reader-secret.bin');
    try {
      fs.rmSync(legacy, { force: true });
    } catch (err) {
      problem(`An old saved reader secret could not be removed (${err.code || 'error'}); remove field-reader-secret.bin from the app's data folder`, legacy);
    }
  }
  {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(fieldCacheFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        problem('The saved field feedback could not be read; the sheet is read again', fieldCacheFile);
        dropFieldCache();
      }
    }
    const checked = fieldSurvey.validCache(raw, fieldLink());
    if (checked.problem) problem(checked.problem, fieldCacheFile);
    if (checked.cache && field.enabled) {
      fieldCache = checked.cache;
      // An older format's "new since", carried without its rows: written in
      // its place now, so the old rows leave the disk before any read.
      if (checked.carried) saveFieldCache();
    } else if (raw != null) {
      // Not this sheet's, not whole, an older format, or the feature is off:
      // nothing of it is kept.
      dropFieldCache();
    }
  }
  function summariseField() {
    try {
      fieldSummarisedAt = Date.now();
      fieldSummary = fieldSurvey.summariseCache(fieldCache, field.columns, { now: fieldSummarisedAt });
      fieldSummaryError = null;
    } catch (err) {
      // Never stops the app: the section shows no numbers and says why.
      fieldSummary = null;
      fieldSummaryError = 'The answers kept could not be summarised; press Refresh now, and see the system log if it stays.';
      syslog?.write('errors', 'field-feedback', { error: String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ') });
    }
  }
  function saveFieldCache() {
    try {
      writeJsonFile(fieldCacheFile, fieldCache);
    } catch (err) {
      problem(`The field feedback could not be saved (${err.code || err.message}); it shows until the app closes`, fieldCacheFile);
    }
  }
  function readFieldKey() {
    if (!field.keyPath) throw new fieldSurvey.FieldSurveyError('setup', 'Choose the key file in Settings → Connections → Field feedback.');
    let text;
    try {
      text = fs.readFileSync(field.keyPath, 'utf8');
    } catch (err) {
      throw fieldSurvey.keyFileError(err); // gone: wait for the user; busy or locked: try again later
    }
    try {
      return fieldSurvey.readKey(text);
    } catch (err) {
      throw new fieldSurvey.FieldSurveyError('key', err.message);
    }
  }
  function checkFieldKey() {
    if (!field.keyPath) {
      fieldKey = { clientEmail: null, error: null };
      return;
    }
    try {
      fieldKey = { clientEmail: readFieldKey().clientEmail, error: null };
    } catch (err) {
      fieldKey = { clientEmail: null, error: err.message };
    }
  }
  // Electron's own network stack (the system proxy applies), and only to
  // the hosts in fieldsurvey.HOSTS: checkUrl refuses anything else.
  async function askGoogle(url, init) {
    fieldSurvey.checkUrl(url);
    return net.fetch(url, { ...init, signal: AbortSignal.timeout(FIELD_TIMEOUT_MS) });
  }
  // The reader's secret, decrypted for one read of this reader (link) only.
  // Never logged or returned to the window; the caller drops it with the
  // request.
  function readFieldSecret(link) {
    let text;
    try {
      text = fs.readFileSync(fieldSecretFile, 'utf8');
    } catch (err) {
      throw fieldSurvey.secretFileError(err); // none saved or not the app's to open: wait for the user; busy just now: try again later
    }
    const sealed = fieldSurvey.openSecret(text, link.deploymentId); // another reader's, or not the app's file: says so
    try {
      return safeStorage.decryptString(sealed);
    } catch {
      throw fieldSurvey.secretLocked(); // the system's key changed: only a new secret helps
    }
  }
  // The reader's requests: Electron's own network stack (the system proxy
  // applies), no cookies or sign-in of the app's, and never a redirect
  // followed here. net.fetch cannot hand back a redirect's address (with
  // redirect 'manual' it only fails), so this uses net.request, whose
  // 'redirect' event gives it: the request stops there and
  // fieldsurvey.readerHop decides the one hop. -> { status, location,
  // contentType, text() }, as fetchReaderRows expects. The timeout covers
  // the answer's body too, and a body past fieldsurvey.READER_MAX_BYTES is
  // cut off there (TooLargeError) rather than held.
  function askReader(url, init) {
    fieldSurvey.checkUrl(url);
    return new Promise((resolve, reject) => {
      const req = net.request({ url, method: init.method, redirect: 'manual', credentials: 'omit', useSessionCookies: false });
      for (const [name, value] of Object.entries(init.headers ?? {})) req.setHeader(name, value);
      let answered = false;
      let failBody = null;
      const timer = setTimeout(() => {
        const err = Object.assign(new Error('The reader did not answer in time'), { name: 'TimeoutError' });
        if (!answered) {
          answered = true;
          reject(err);
        } else failBody?.(err);
        req.abort();
      }, FIELD_TIMEOUT_MS);
      req.on('redirect', (status, _method, location) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        resolve({ status, location, contentType: null, text: async () => '' });
        req.abort(); // not followed: the next address is checked before it is asked
      });
      req.on('response', (res) => {
        if (answered) return;
        answered = true;
        const chunks = [];
        let bytes = 0;
        const body = new Promise((ok, fail) => {
          failBody = fail;
          res.on('data', (chunk) => {
            if (!failBody) return; // already cut off
            bytes += chunk.length;
            if (!fieldSurvey.tooLarge(bytes)) {
              chunks.push(chunk);
              return;
            }
            clearTimeout(timer);
            chunks.length = 0;
            failBody = null;
            fail(Object.assign(new Error('The answer is over the size the app reads'), { name: 'TooLargeError' }));
            req.abort();
          });
          res.on('end', () => {
            clearTimeout(timer);
            // Whatever goes wrong here ends the read, so the busy guard always clears.
            try {
              ok(Buffer.concat(chunks).toString('utf8'));
            } catch (err) {
              fail(err);
            }
          });
          res.on('aborted', () => fail(new Error('The answer was cut off')));
          res.on('error', (err) => fail(err));
        });
        // text() awaits it; this only keeps a body nobody reads (an answer
        // already refused by its status) from being an unhandled rejection.
        body.catch(() => {});
        const type = res.headers['content-type'];
        resolve({ status: res.statusCode, location: undefined, contentType: Array.isArray(type) ? type[0] : type ?? null, text: () => body });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        if (!answered) {
          answered = true;
          reject(err);
        } else failBody?.(err); // after a redirect was taken, the request's own abort lands here, and changes nothing
      });
      req.end(init.body);
    });
  }
  function refreshField() {
    if (fieldRun) return fieldRun;
    const generation = fieldGeneration;
    const started = Date.now();
    const source = fieldSource();
    fieldRun = (async () => {
      let link = null;
      try {
        try {
          link = fieldSurvey.sourceLink(field);
        } catch (err) {
          throw new fieldSurvey.FieldSurveyError('setup', err.message);
        }
        let got;
        let key = null;
        if (source === 'reader') {
          got = await fieldSurvey.fetchReaderRows({ link, secret: readFieldSecret(link), send: askReader });
        } else {
          key = readFieldKey();
          got = await fieldSurvey.fetchRows({ link, key, fetch: askGoogle, now: started });
        }
        // The settings changed under this read: it is dropped, and the new
        // ones are read as soon as it ends (fieldTick, asked).
        if (generation !== fieldGeneration) {
          fieldAsked = true;
          return { ok: false, error: FIELD_STALE };
        }
        fieldCache = fieldSurvey.afterFetch(fieldCache, got, { now: Date.now(), started, link, roles: field.columns });
        if (key) fieldKey = { clientEmail: key.clientEmail, error: null };
      } catch (err) {
        if (generation !== fieldGeneration) {
          fieldAsked = true;
          return { ok: false, error: FIELD_STALE };
        }
        if (!(err instanceof fieldSurvey.FieldSurveyError)) {
          syslog?.write('errors', 'field-feedback', { error: String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ') });
        } else if (err.code) {
          // The reader's code for the trouble (an HTTP status, the reader's
          // own word): never the secret or the link (fieldsurvey.js, tested).
          syslog?.write('errors', 'field-feedback', { route: source, kind: err.kind, code: err.code });
        }
        fieldCache = fieldSurvey.afterFailure(fieldCache, err, { now: Date.now(), started, link });
        const kind = fieldCache.lastError.kind;
        // A key file that could not be read just now keeps the address it had.
        if (source === 'key' && (kind === 'key' || kind === 'keyfile')) {
          fieldKey = { clientEmail: kind === 'keyfile' ? fieldKey.clientEmail : null, error: fieldCache.lastError.message };
        }
        if (kind === 'setup' && source === 'reader') fieldSecretSaved = fs.existsSync(fieldSecretFile);
      }
      saveFieldCache();
      summariseField();
      return fieldCache.lastError ? { ok: false, error: fieldCache.lastError.message } : { ok: true };
    })().finally(() => {
      fieldRun = null;
      fieldTick();
    });
    return fieldRun;
  }
  // What planFetch needs: the settings, and whether a secret is saved.
  const fieldPlanSettings = () => ({ ...field, secretSaved: fieldSecretSaved });
  function fieldTick() {
    clearTimeout(fieldTimer);
    const plan = fieldSurvey.planFetch({ now: Date.now(), settings: fieldPlanSettings(), cache: fieldCache, busy: Boolean(fieldRun), asked: fieldAsked });
    if (plan.fetch) {
      fieldAsked = false;
      refreshField();
      return;
    }
    // setTimeout cannot wait more than ~24 days.
    if (plan.wakeAt != null) fieldTimer = setTimeout(fieldTick, Math.min(Math.max(plan.wakeAt - Date.now() + 1_000, 1_000), 2 ** 31 - 1));
  }
  setInterval(() => {
    // The window moves with the clock between reads: summarise again hourly.
    if (fieldCache && Date.now() - fieldSummarisedAt > 60 * 60_000) summariseField();
    fieldTick();
  }, FIELD_CHECK_MS);
  checkFieldKey();
  summariseField();
  fieldTick();
  ipcMain.handle('home:field-set', (_event, change = {}) => {
    // Columns are checked against the sheet as last read: a column with no
    // choice refuses the save.
    const res = fieldSurvey.changeSettings(field, change, { summary: fieldSummary });
    if (res.error) return { ok: false, error: res.error };
    try {
      writeJsonFile(fieldFile, res.settings);
    } catch (err) {
      return { ok: false, error: `The setting could not be saved (${err.code || err.message})` };
    }
    const turnedOff = field.enabled && !res.settings.enabled;
    field = res.settings;
    // A secret is never sent to another reader than its own: a link to
    // another reader drops it, and the reply says why.
    const secretStale = fieldSecretSaved && fieldSurvey.secretStale(fieldSecretFor, field);
    // Whether the old reader's secret is really gone, after the attempt (one
    // that could not be removed is said under Needs attention instead).
    let secretRemoved = false;
    if (res.sheetChanged || turnedOff) {
      // Another sheet or reader starts afresh; off keeps nothing, the
      // reader's secret included.
      fieldGeneration += 1;
      dropFieldCache();
      if (turnedOff || secretStale) {
        dropFieldSecret();
        secretRemoved = !fieldSecretSaved;
      }
      if (change && 'source' in change) checkFieldKey();
    } else if (change && 'columns' in change && fieldCache) {
      // A column now marked identifying loses its answers from the cache too.
      fieldCache = fieldSurvey.reroleCache(fieldCache, field.columns);
      saveFieldCache();
    }
    summariseField();
    fieldTick(); // reads now when on, set up and due
    // After a columns save, the reply says if one stays hidden (its answers
    // read as emails or phones) whatever was chosen for it.
    const note = change && 'columns' in change ? fieldSurvey.columnsReply(fieldSummary) : res.note;
    return {
      ok: true, ...(note ? { note } : {}),
      ...(secretStale && secretRemoved && !turnedOff ? { secretNote: 'The saved secret was the old reader’s, so it was removed: save this reader’s secret.' } : {}),
    };
  });
  ipcMain.handle('home:field-choose-key', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the service account key (JSON) that can read the survey sheet',
      properties: ['openFile'],
      filters: [{ name: 'Key file (JSON)', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    let key;
    try {
      key = fieldSurvey.readKey(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { ok: false, error: err.code ? `The file could not be read (${err.code})` : err.message };
    }
    const next = { ...field, keyPath: file };
    try {
      writeJsonFile(fieldFile, next);
    } catch (err) {
      return { ok: false, error: `The setting could not be saved (${err.code || err.message})` };
    }
    field = next;
    fieldGeneration += 1;
    fieldKey = { clientEmail: key.clientEmail, error: null };
    // A new key may be the fix for the last refusal: try again without waiting.
    if (fieldCache?.lastError) fieldCache = { ...fieldCache, lastAttemptAt: null };
    fieldTick();
    return { ok: true };
  });
  // The reader's secret, from the Secret field: checked (fieldsurvey.js
  // checkSecret), encrypted by the system and written with the reader it
  // belongs to. With no protected storage it is refused, never kept as
  // plain text. The reply says only whether it was saved; the window never
  // gets it back.
  ipcMain.handle('home:field-save-secret', (_event, text) => {
    if (!field.enabled) return { ok: false, error: 'Turn field feedback on first.' };
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
    const checked = fieldSurvey.checkSecret(text, {
      available: safeStorage.isEncryptionAvailable(), backend, saved: fieldSecretSaved, readerUrl: fieldSource() === 'reader' ? field.readerUrl : '',
    });
    if (checked.error) return { ok: false, error: checked.error };
    const tmp = `${fieldSecretFile}.${process.pid}.tmp`;
    try {
      const sealed = safeStorage.encryptString(checked.secret);
      fs.mkdirSync(path.dirname(fieldSecretFile), { recursive: true });
      fs.writeFileSync(tmp, fieldSurvey.sealSecret(checked.deploymentId, sealed), { mode: 0o600 });
      fs.renameSync(tmp, fieldSecretFile);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Only the half-written copy is left, encrypted; the save's own error is what is said and logged.
      }
      syslog?.write('errors', 'field-feedback', { route: 'reader', code: `secret not saved ${err?.code || 'error'}` });
      return { ok: false, error: 'The secret could not be saved; see the system log, then try again.' };
    }
    fieldSecretSaved = true;
    fieldSecretFor = checked.deploymentId;
    fieldGeneration += 1;
    // A new secret may be the fix for the last refusal, or the first step
    // that lets the reader be read: read now, slot or not.
    if (fieldCache) fieldCache = { ...fieldCache, lastAttemptAt: null };
    fieldAsked = true;
    fieldTick();
    return { ok: true };
  });
  // The reader script the user pastes into the sheet's Apps Script editor,
  // as shipped with the app (docs/field-feedback-reader.gs, in the build).
  ipcMain.handle('home:field-copy-script', () => {
    let code;
    try {
      code = fs.readFileSync(path.join(app.getAppPath(), 'docs', 'field-feedback-reader.gs'), 'utf8');
    } catch (err) {
      syslog?.write('errors', 'field-feedback', { route: 'reader', code: `script not read ${err?.code || 'error'}` });
      return { ok: false, error: 'The reader script that comes with the app is missing from this copy. Update the app (Settings → App → Updates) or install it again, then copy it.' };
    }
    clipboard.writeText(code);
    return { ok: true };
  });
  // Refresh now reads the settings as they are: a read that started before
  // they changed is dropped (FIELD_STALE), and this waits for the new one.
  ipcMain.handle('home:field-refresh', async () => {
    if (!field.enabled) return { ok: false, error: 'Turn field feedback on first.' };
    const res = await refreshField();
    return res.error === FIELD_STALE ? refreshField() : res;
  });
  // The reader address goes to the clipboard from here, so it can be pasted
  // into the sheet's Share box while privacy mode keeps it off the screen.
  ipcMain.handle('home:field-copy-reader', () => {
    if (!fieldKey.clientEmail) return { ok: false, error: 'Choose the key file first.' };
    clipboard.writeText(fieldKey.clientEmail);
    return { ok: true };
  });
  // When the next read happens, by the same plan the timer follows (a retry
  // after a passing trouble comes sooner than the next Mon/Wed/Fri 08:00).
  function nextFieldRead() {
    const now = Date.now();
    const plan = fieldSurvey.planFetch({ now, settings: fieldPlanSettings(), cache: fieldCache, busy: Boolean(fieldRun) });
    return plan.fetch ? now : plan.wakeAt;
  }
  // The key file's trouble matters only while the key file is in use.
  const fieldKeyError = () => (fieldSource() === 'key' ? fieldKey.error : null);
  function fieldState() {
    const c = fieldCache ?? {};
    return {
      enabled: field.enabled,
      source: fieldSource(),
      // URLs and a file name: the board shows them only with privacy off.
      sheetUrl: field.sheetUrl,
      readerUrl: field.readerUrl ?? '',
      // Whether a secret is saved, never the secret; and, when this computer
      // cannot keep one, why (Settings says so before anything is typed).
      secretSaved: fieldSecretSaved,
      secretStorage: fieldStorageProblem,
      // Columns the user checked: switching how to connect asks first when there are any.
      checkedColumns: field.columns.length,
      keyName: field.keyPath ? path.basename(field.keyPath) : '',
      clientEmail: fieldKey.clientEmail,
      keyError: fieldKeyError(),
      // The same two as Settings words them, naming its controls (the board keeps the Settings path).
      keyErrorHere: fieldKeyError() ? fieldSurvey.inSettings(fieldKeyError()) : null,
      errorHere: c.lastError ? fieldSurvey.inSettings(c.lastError.message) : null,
      busy: Boolean(fieldRun),
      fetchedAt: c.fetchedAt ?? null,
      lastAttemptAt: c.lastAttemptAt ?? null,
      error: c.lastError?.message ?? null,
      errorDetail: c.lastError?.detail ?? null,
      errorKind: c.lastError?.kind ?? null,
      errorAt: c.lastError?.at ?? null,
      sinceFetchedAt: c.sinceFetchedAt ?? null,
      tab: c.tab?.title ?? null,
      nextAt: nextFieldRead(),
      summary: field.enabled ? fieldSummary : null,
      summaryError: field.enabled ? fieldSummaryError : null,
      // What needs a look (src/core/fieldsurvey.js fieldFlags); the board words them.
      // { why, earlier, list }: why is set when the window could not be compared.
      flags: field.enabled ? fieldSurvey.fieldFlags({ summary: fieldSummary, lastError: fieldCache?.lastError ?? null, keyError: fieldKeyError() }) : null,
    };
  }
  function fieldProblems() {
    const out = fieldSurvey.fieldProblems({ enabled: field.enabled, cache: fieldCache, summary: fieldSummary, summaryError: fieldSummaryError, keyError: fieldKeyError() })
      .map((p) => ({ ...p, count: 1 }));
    // Each new set of problems goes to the system log once (labels only).
    const text = out.map((p) => p.label).join(' | ');
    if (text && text !== fieldLogged) for (const p of out) syslog?.write('errors', 'problem', { what: p.label });
    fieldLogged = text;
    return out;
  }

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
        stopLog(); // app.exit skips the quit events that would
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
      return { ok: false, error: 'The worktrees could not be read.', detail: err.message };
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

  // ---- LINE chats ------------------------------------------------------------
  // The user's LINE group chats, from the text files LINE desktop's "Save
  // chat" writes into a folder they picked. Off until turned on in
  // Settings; only the chats the user ticks are read past their header; the
  // exports are only read, never written, moved or deleted, and nothing goes
  // online. The decisions (parsing, what concerns the user, the command
  // that starts Claude) are in src/core/linechat.js; this keeps the
  // settings file, the scan timer and the IPC, and runs Send to agent's one
  // command when the user presses Start Claude. Error words name the next
  // step; raw error codes go only to the system log or a problem's detail.
  const lineFile = path.join(app.getPath('userData'), 'line-chats.json');
  const linePromptDir = path.join(app.getPath('userData'), 'line-prompts');
  const LINE_SCAN_MS = 10_000;
  const LINE_PRUNE_MS = 60 * 60_000;
  let line = lineChat.changeSettings(undefined, {}).settings;
  let lineScan = null; // { error, files } from the last look at the folder
  let lineFiles = new Map(); // file -> its entry, reused while it is unchanged
  let lineChats = []; // the ticked chats, re-exports merged
  let lineItems = []; // what concerns the user, newest first
  let lineScannedAt = null; // the last scan that worked
  let lineScanError = null;
  let lineTmux = { sessions: [], why: null }; // as last asked, when the sheet opened
  let lineLogged = '';
  const lineCode = (err) => err?.code ?? (err?.killed ? 'timeout' : 'error');
  const lineLog = (what, err) => syslog?.write('errors', 'line-chats', { error: `${what}: ${lineCode(err)}` });
  const LINE_SAVE_ERROR = 'The setting could not be saved. Try again; if it keeps failing, the system log has the reason.';
  try {
    line = lineChat.changeSettings(JSON.parse(fs.readFileSync(lineFile, 'utf8')), {}).settings;
  } catch (err) {
    if (err.code !== 'ENOENT') problem('LINE chats: its settings could not be read; it is off until it is set again in Settings → Connections → LINE chats', lineFile, 'line');
  }
  function scanLine() {
    if (!line.enabled || !line.folder) {
      [lineScan, lineFiles, lineChats, lineItems, lineScanError, lineScannedAt] = [null, new Map(), [], [], null, null];
      return;
    }
    try {
      lineScan = lineChat.scanFolder(line.folder, { read: new Set(line.read), prev: lineFiles });
      lineFiles = new Map(lineScan.files.map((f) => [f.file, f]));
      lineChats = lineChat.mergeChats(lineScan.files.filter((f) => f.read && f.messages));
      const since = Date.now() - lineChat.WINDOW_DAYS * 86_400_000;
      const hits = lineChats.flatMap((c) => lineChat.relatedToYou(c.messages, { names: line.names, keywords: line.keywords, since }));
      // Marks an earlier version saved under the message's hash move to the
      // item's key, so an added or dismissed item stays gone.
      const moved = lineChat.migrateMarks(line.marks, hits);
      if (moved.changed) {
        line = { ...line, marks: moved.marks };
        try {
          writeJsonFile(lineFile, line);
        } catch (err) {
          // Kept for this run; the move is tried again at the next start.
          lineLog('marks not moved to item keys', err);
        }
      }
      lineItems = hits
        .filter((h) => !line.marks[h.key])
        .sort((a, b) => b.ms - a.ms)
        .map((h) => ({ ...h, draft: lineChat.draftTodo(h), prompt: lineChat.promptDraft(h) }));
      lineScanError = null;
      lineScannedAt = Date.now();
    } catch (err) {
      // Not a file problem the scan words itself: a bug. Nothing old stays
      // on the board as if just read; the stack (no chat text: the parser
      // keeps none in its errors) goes to the system log.
      [lineChats, lineItems] = [[], []];
      lineScanError = 'LINE chats: the exports could not be read. The app tries again in 10 seconds; the system log has the reason';
      syslog?.write('errors', 'line-chats', { error: String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ') });
    }
  }
  setInterval(scanLine, LINE_SCAN_MS);
  scanLine();
  // Prompt files hold a chat's words: each goes a day after it was written
  // (looked at as the app starts and every hour), all of them while the
  // feature is off. What stays is said under Needs attention: files that
  // could not go and files dated in the future (they would never come of
  // age), as of the last prune; and a prompt a failed start (or a failed
  // write) could not remove, retried at any age every hour and said until
  // it is gone. Those leftovers' names are kept in line-leftovers.json in
  // the app's data folder, so a restart still retries and lists them.
  let linePruneProblems = [];
  const lineLeftoverFile = path.join(app.getPath('userData'), 'line-leftovers.json');
  const loadedLeftovers = lineChat.readLeftovers(lineLeftoverFile);
  const lineLeftovers = loadedLeftovers.leftovers; // prompt file name -> the code it could not be removed with
  if (loadedLeftovers.error) {
    lineLog('leftover prompt list not read', { code: loadedLeftovers.error });
    problem('LINE chats: the list of saved prompts a failed start left could not be read; the app still removes every saved prompt a day after it was written', lineLeftoverFile, 'line');
  }
  let leftoversSaved = JSON.stringify(lineChat.leftoverJson(lineLeftovers));
  function saveLeftovers() {
    const data = lineChat.leftoverJson(lineLeftovers);
    if (JSON.stringify(data) === leftoversSaved) return;
    try {
      writeJsonFile(lineLeftoverFile, data);
      leftoversSaved = JSON.stringify(data);
    } catch (err) {
      // This run still lists and retries them; the save is tried again at
      // the next change or prune.
      lineLog('leftover prompt list not saved', err);
    }
  }
  const PRUNE_AGAIN = 'the app tries again within the hour';
  function pruneLinePrompts(maxAgeMs) {
    const gone = lineChat.prunePrompts(linePromptDir, { ...(maxAgeMs == null ? {} : { maxAgeMs }), retry: [...lineLeftovers.keys()] });
    const n = gone.failed.length;
    const out = [];
    if (gone.folderError) {
      // The leftovers cannot be looked at either: they stay said.
      out.push({ label: `LINE chats: the app's folder of saved prompts could not be opened to remove old ones; ${PRUNE_AGAIN}. If this stays, restart the app`, detail: `${linePromptDir} (${gone.folderError})` });
    } else {
      lineLeftovers.clear();
      for (const s of gone.stuck) lineLeftovers.set(s.name, s.code);
    }
    saveLeftovers();
    if (n) {
      out.push({ label: `LINE chats: ${n === 1 ? '1 saved prompt' : `${n} saved prompts`} could not be removed; close any app using the app's line-prompts folder, and ${PRUNE_AGAIN}`,
        detail: `${linePromptDir} (${[...new Set(gone.failed)].join(', ')})` });
    }
    if (gone.future) {
      const f = gone.future;
      out.push({ label: `LINE chats: ${f === 1 ? '1 saved prompt is' : `${f} saved prompts are`} dated in the future, so the app does not remove ${f === 1 ? 'it' : 'them'} after a day; check the computer's date, or turn LINE chats off to remove every saved prompt`,
        detail: linePromptDir });
    }
    linePruneProblems = out;
  }
  const leftoverProblem = () => {
    const n = lineLeftovers.size;
    if (!n) return [];
    return [{
      label: `LINE chats: ${n === 1 ? 'a saved prompt' : `${n} saved prompts`} could not be removed after Claude did not start; close any app using the app's line-prompts folder, and the app tries again every hour`,
      detail: [...lineLeftovers].map(([name, code]) => `${path.join(linePromptDir, name)} (${code})`).join(', '),
    }];
  };
  const pruneLineNow = () => pruneLinePrompts(line.enabled ? undefined : 0);
  pruneLineNow();
  setInterval(pruneLineNow, LINE_PRUNE_MS);
  function saveLine(next) {
    writeJsonFile(lineFile, next);
    const turnedOff = line.enabled && !next.enabled;
    line = next;
    if (turnedOff) {
      lineTmux = { sessions: [], why: null };
      pruneLinePrompts(0);
    }
    scanLine();
  }
  ipcMain.handle('home:line-set', (_event, change = {}) => {
    // The folder is set only through the folder dialog below.
    const allowed = Object.fromEntries(Object.entries(change ?? {}).filter(([k]) => ['enabled', 'names', 'keywords', 'tick', 'mark', 'unmark'].includes(k)));
    const res = lineChat.changeSettings(line, allowed);
    if (res.error) return { ok: false, error: res.error };
    try {
      saveLine(res.settings);
    } catch (err) {
      lineLog('settings not saved', err);
      return { ok: false, error: LINE_SAVE_ERROR };
    }
    return { ok: true, ...(res.note ? { note: res.note } : {}) };
  });
  ipcMain.handle('home:line-choose-folder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the folder you save LINE chats into',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    try {
      saveLine(lineChat.changeSettings(line, { folder: res.filePaths[0] }).settings);
    } catch (err) {
      lineLog('settings not saved', err);
      return { ok: false, error: LINE_SAVE_ERROR };
    }
    return { ok: true };
  });
  const lineItem = (key) => lineItems.find((h) => h.key === key);
  // Add to project: the to-do goes through projects.js (read afresh, written
  // whole, unknown fields kept); then the item is remembered as added.
  ipcMain.handle('home:line-add', (_event, { key, project, text } = {}) => {
    if (!line.enabled) return { ok: false, error: 'Turn LINE chats on first.' };
    if (!lineItem(key)) return { ok: false, error: 'That item is no longer listed; it may have been added or dismissed already.' };
    try {
      lineChat.addTodo(projectsPath, { project, text });
    } catch (err) {
      if (!err.code) return { ok: false, error: err.message }; // projects.js's own words, which say what to do
      const verb = err.stage === 'read' ? 'read' : 'saved';
      lineLog(`project list not ${verb}`, err);
      return {
        ok: false,
        error: ['EBUSY', 'EPERM', 'EACCES'].includes(err.code) ? 'The project list is in use. Close other apps using it and try again.'
          : `The project list could not be ${verb}. Try again; if it keeps failing, the system log has the reason.`,
      };
    }
    readProjects(true);
    try {
      saveLine(lineChat.changeSettings(line, { mark: { key, what: 'added' } }).settings);
    } catch (err) {
      lineLog('added item not noted', err);
      return { ok: true, stays: true, note: 'Added. The app could not note that it was, so the item stays listed: dismiss it when you are done.' };
    }
    return { ok: true };
  });
  // Where Send to agent can start Claude: the user's tmux sessions in WSL
  // (asked only when WSL is already running), else a Windows Terminal tab.
  ipcMain.handle('home:line-targets', async () => {
    const { sessions, why, code } = await lineChat.tmuxSessions();
    if (code) lineLog('tmux sessions not asked', { code });
    lineTmux = { sessions, why };
    return lineTmux;
  });
  ipcMain.handle('home:line-browse', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder Claude works in', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });
  // Start Claude: only on the user's press, with the prompt they edited,
  // where they chose. The prompt goes to a file; launchPlan builds the one
  // command. For tmux, WSL is first asked which distro it runs (tmux is
  // there) and whether the folder is there.
  ipcMain.handle('home:line-start', async (_event, req = {}) => {
    if (!line.enabled) return { ok: false, error: 'Turn LINE chats on first.' };
    if (req.target !== 'tmux' && req.target !== 'wt') return { ok: false, error: 'Choose where Claude runs.' };
    let distro = null;
    if (req.target === 'tmux') {
      if (!lineTmux.sessions.includes(req.session)) return { ok: false, error: 'That tmux session is not listed any more. Close this sheet and open it again to see the sessions running now.' };
      let target;
      try {
        target = lineChat.wslTarget(req.cwd);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const probe = await lineChat.wslProbe(target.path);
      if (probe.error) {
        lineLog('WSL not asked', { code: probe.code });
        return { ok: false, error: probe.error };
      }
      if (!probe.exists) return { ok: false, error: 'That folder is not there in WSL. Choose another folder.' };
      distro = probe.distro;
    } else if (typeof req.cwd === 'string' && /^[A-Za-z]:[\\/]|^\\\\/.test(req.cwd)) {
      let isDir = false;
      try {
        isDir = fs.statSync(req.cwd).isDirectory();
      } catch {
        isDir = false; // missing or unreadable: said below
      }
      if (!isDir) return { ok: false, error: 'That folder is not there any more. Choose another folder.' };
    }
    const promptFile = path.join(linePromptDir, `${Date.now()}-${require('crypto').randomBytes(3).toString('hex')}.txt`);
    let plan;
    try {
      plan = lineChat.launchPlan({ target: req.target, session: req.session, cwd: req.cwd, prompt: req.prompt, promptFile, name: lineChat.windowName(), distro });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    pruneLinePrompts();
    // A write that fails partway leaves no chat words behind: the partial
    // file is removed, or, when it cannot be, retried and listed.
    const wrote = lineChat.writePrompt(plan.write.file, plan.write.text);
    if (!wrote.ok) {
      lineLog('prompt not saved', { code: wrote.code });
      if (wrote.leftover) {
        lineLeftovers.set(path.basename(plan.write.file), wrote.leftover);
        saveLeftovers();
      }
      return { ok: false, error: 'The prompt could not be saved in the app’s data folder. Try again; if it keeps failing, the system log has the reason.' };
    }
    return new Promise((resolve) => {
      // wsl.exe is a console program: hidden. wt.exe opens the terminal
      // itself, which hiding could hide too.
      execFile(plan.file, plan.args, { timeout: 15_000, windowsHide: req.target === 'tmux' }, (err) => {
        if (!err) return resolve({ ok: true, label: plan.label });
        // Nothing started: the prompt (a chat's words) does not stay behind.
        fs.rm(plan.write.file, { force: true }, (rmErr) => {
          if (!rmErr) return;
          lineLeftovers.set(path.basename(plan.write.file), lineCode(rmErr));
          saveLeftovers();
        });
        lineLog(`start failed (${req.target})`, err);
        const tmux = req.target === 'tmux';
        const why = err.code === 'ENOENT'
          ? (tmux ? 'WSL is not installed. Choose New Windows Terminal tab instead.' : 'Windows Terminal is not installed. Install it, or start a tmux session in WSL and open this sheet again.')
          : err.killed ? 'Starting Claude took too long. Try again; if it keeps happening, the system log has the reason.'
            : tmux ? 'tmux could not open the window. Check that the session is still running, then open this sheet again.'
              : 'Windows Terminal could not open the tab. Try again; if it keeps failing, the system log has the reason.';
        return resolve({ ok: false, error: why });
      });
    });
  });
  function lineState() {
    if (!line.enabled) return { enabled: false };
    const byChat = new Map();
    for (const f of lineScan?.files ?? []) {
      const c = byChat.get(f.chat) ?? { chat: f.chat, files: 0, read: line.read.includes(f.chat), problems: 0 };
      c.files += 1;
      if (f.problem) c.problems += 1;
      byChat.set(f.chat, c);
    }
    for (const c of lineChats) if (byChat.has(c.chat)) byChat.get(c.chat).messages = c.messages.length;
    const chats = [...byChat.values()].sort((a, b) => a.chat.localeCompare(b.chat));
    return {
      enabled: true,
      // A path and the user's own words: the board shows them only with privacy off.
      folder: line.folder,
      names: line.names,
      keywords: line.keywords,
      chats,
      readCount: lineChats.length,
      // Ticked chats in the folder none of whose exports could be read.
      tickedFailed: chats.filter((c) => c.read && c.messages == null).length,
      scanFailed: Boolean(lineScanError),
      folderError: lineScan?.error ? lineScan.error.code : null,
      scannedAt: lineScannedAt,
      windowDays: lineChat.WINDOW_DAYS,
      // Chat names, senders and words: shown only with privacy off.
      items: lineItems.map(({ key, hash, chat, at, ms, sender, text, reason, matched, draft, prompt }) => ({ key, hash, chat, at, ms, sender, text, reason, matched, draft, prompt })),
    };
  }
  function lineProblemsNow() {
    const out = [
      ...lineChat.lineProblems({
        enabled: line.enabled, folder: line.folder, scan: lineScan, read: line.read,
        olderOnly: lineChats.reduce((n, c) => n + (c.olderOnly ?? 0), 0),
      }),
      ...(lineScanError ? [{ label: lineScanError, detail: '' }] : []),
      ...linePruneProblems,
      ...leftoverProblem(),
    ].map((p) => ({ ...p, count: 1 }));
    // Each new set of problems goes to the system log once (labels only).
    const text = out.map((p) => p.label).join(' | ');
    if (text && text !== lineLogged) for (const p of out) syslog?.write('errors', 'problem', { what: p.label });
    lineLogged = text;
    return out;
  }

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
    mini.on('session-end', () => stopLog()); // Windows shutting down or logging off
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

  // The system log runs on its own, whether or not a window is open, from
  // everything the tracker holds (logEvents in src/core/syslog.js).
  const LOG_MS = 2_000;
  const SUMMARY_MS = 5 * 60_000;
  // What activity.log has said, so it is never said twice: read back from the
  // log itself, since a restart reads the recent transcripts again.
  const readBack = () => {
    try {
      return loggedFromLog(syslog.lines('activity'));
    } catch (err) {
      problem(`activity.log could not be read back (${err.code || err.message}), so what the app read again may be written twice`, logDir);
      return loggedSoFar();
    }
  };
  let logged = readBack();
  // Sessions the log last saw on the board (it never saw them go quiet).
  // After a brief stop, seeing them again as the app starts is no news (WSL
  // transcripts come within seconds), and those not back within a minute
  // went quiet. After a longer one, they all went quiet while it was off.
  // (closeOnBoard in src/core/syslog.js; `board`: the sessions on it now.)
  const closeBoard = (board) => {
    for (const { event, fields } of closeOnBoard(logged, board)) syslog.write('activity', event, fields);
  };
  if (Date.now() - lastRunWrote <= TIMING.staleSessionMs) setTimeout(() => closeBoard(lastBoard), 60_000);
  else closeBoard();
  // The tracker's counts shown under "Needs attention", by their name in errors.log.
  const COUNTS = { malformedLines: 'malformed', unlinkedSidechains: 'unlinked', unmatchedRelays: 'relays', untimedEntries: 'untimed', strayNotifications: 'stray' };
  let lastCounts = {};
  let shownFailure;
  let lastBoard = new Map();
  let lastView = new Map();
  let lastSummary = 0;
  let lastSummaryText = '';
  // `last`: the app is quitting, so what still waits (an end waits 5 s for
  // its last token counts) is written now rather than left to the next start.
  const writeActivity = (now, last = false) => {
    // The lock is touched while this copy writes the log. A copy left out
    // takes the log over once the one that wrote it has stopped, reading it
    // back first, so it writes what that copy did not.
    const wasMuted = syslog.muted.has('activity');
    if (syslog.keep('activity') && wasMuted) {
      logged = readBack();
      closeBoard(lastBoard); // what the stopped copy left open and this one does not see
      problems.delete(`${heldElsewhere}|${syslog.dir}`);
    }
    const snap = tracker.snapshot(now);
    const board = new Map(snap.sessions.map((s) => [s.id, s]));
    const view = tracker.logView();
    for (const { event, fields } of logEvents({ prevBoard: lastBoard, board, prevView: lastView, view, logged, now: last ? Infinity : now })) {
      syslog.write('activity', event, fields);
    }
    lastBoard = board;
    lastView = view;
    return snap;
  };
  stopLog = () => {
    writeActivity(Date.now(), true);
    syslog.flush('activity');
    syslog.flush('errors');
    syslog.release('activity');
  };
  app.on('before-quit', () => stopLog());
  setInterval(() => {
    const now = Date.now();
    const snap = writeActivity(now);
    // Who is working: every few minutes while anyone is, and once when
    // everyone has stopped. The tracker's counts go to errors.log at the same
    // pace, whenever one has grown.
    if (now - lastSummary >= SUMMARY_MS) {
      const u = utilisation(snap);
      const text = JSON.stringify(u);
      if (u.sessions || text !== lastSummaryText) syslog.write('activity', 'summary', { ...u, ...teamState() });
      lastSummary = now;
      lastSummaryText = text;
      if (Object.keys(COUNTS).some((k) => (snap.stats[k] ?? 0) > (lastCounts[k] ?? 0))) {
        syslog.write('errors', 'counts', Object.fromEntries(Object.entries(COUNTS).map(([k, name]) => [name, snap.stats[k] || undefined])));
      }
      lastCounts = snap.stats;
    }
    // A line that could not be written waits for the next write (SystemLog);
    // each new kind of failure is shown once.
    if (syslog.failed && syslog.failed !== shownFailure) {
      shownFailure = syslog.failed;
      problem(`The system log could not be written (${syslog.failed})`, logDir);
    }
  }, LOG_MS);

  const seenProblems = new Set();
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
      field: fieldState(),
      line: lineState(),
      problems: [
        ...fieldProblems(),
        ...lineProblemsNow(),
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
