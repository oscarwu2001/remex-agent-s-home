'use strict';

// The system log, for checking the team works and for debugging: plain text
// files in the app's own data folder (never under ~/.claude), one line per
// event, easy to read and to search.
//
// - activity.log: sessions and helpers starting and finishing, skills used,
//   a short summary of who is working every few minutes, and team changes.
// - errors.log: everything shown under "Needs attention", and crashes.
//
// Names, rooms, statuses, times and token counts only: never prompts, task
// descriptions, file names or commands.

const fs = require('fs');
const path = require('path');
const { WENT_QUIET } = require('./tracker');

const MAX_BYTES = 2_000_000; // then the file moves to <name>.1.log and starts again
const WAITING_LIMIT = 5_000; // lines kept for a log that cannot be written; the oldest go first
const LOCK_STALE_MS = 30_000; // a lock its holder has not touched for this long was left behind (claim)

const pad = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A value as written in a line: plain words stay as they are, anything with
// a space or quote is quoted, line breaks never get through.
function value(v) {
  const s = String(v).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  return /^[\w.:/@+,-]*$/.test(s) && s ? s : JSON.stringify(s);
}

function formatLine(date, event, fields = {}) {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${value(v)}`);
  return `${stamp(date)}  ${event.padEnd(14)} ${parts.join(' ')}`.trimEnd();
}

class SystemLog {
  constructor(dir, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.now = now;
    this.failed = undefined; // the latest write error, for "Needs attention" (main.js)
    this.failures = 0;
    this.waiting = new Map(); // name -> lines not written yet, tried again with the next one
    this.muted = new Set(); // logs another copy of the app holds (claim)
  }

  file(name) {
    return path.join(this.dir, `${name}.log`);
  }

  // Every line of a log, oldest first: the file it moved aside, then its own.
  lines(name) {
    return [...tailFile(path.join(this.dir, `${name}.1.log`), Infinity), ...tailFile(this.file(name), Infinity)];
  }

  // One copy of the app writes a log. A second (a build run from source
  // shares the installed app's data folder) would write every event again,
  // so it writes nothing to that log and claim() says false. A lock is held
  // while its holder keeps touching it (keep) and still runs; one left by a
  // copy that stopped without letting go (Windows shuts down without telling
  // the app) is taken over once it is LOCK_STALE_MS old. Its PID alone
  // proves nothing: after a restart, another process may have it.
  claim(name, pid = process.pid, now = Date.now()) {
    const lock = path.join(this.dir, `${name}.lock`);
    let holder;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (let tries = 0; tries < 2; tries++) {
        try {
          fs.writeFileSync(lock, String(pid), { flag: 'wx' });
          return this.unmute(name);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        holder = Number.parseInt(readOr(lock, ''), 10);
        if (holder === pid) return this.unmute(name);
        if (now - mtimeOr(lock, -Infinity) < LOCK_STALE_MS && holder > 0 && alive(holder)) break;
        fs.rmSync(lock, { force: true }); // left by a copy that has stopped
      }
    } catch (err) {
      this.fail(err, ` locking ${name}.log`); // shown under "Needs attention"; this copy writes anyway
      return this.unmute(name);
    }
    this.muted.add(name);
    this.heldBy = holder; // the PID of the copy that writes it, for the message
    return false;
  }

  // On every log tick: the holder touches its lock, and a copy left out
  // tries again, so it takes the log over once the holder has stopped.
  // True while this copy writes the log.
  keep(name, pid = process.pid, now = Date.now()) {
    if (this.muted.has(name)) return this.claim(name, pid, now);
    const lock = path.join(this.dir, `${name}.lock`);
    try {
      if (Number.parseInt(readOr(lock, ''), 10) !== pid) return this.claim(name, pid, now); // gone or taken: claim again
      fs.utimesSync(lock, new Date(now), new Date(now));
    } catch (err) {
      this.fail(err, ` keeping ${name}.lock`); // shown under "Needs attention"; this copy goes on writing
    }
    return true;
  }

  unmute(name) {
    this.muted.delete(name);
    return true;
  }

  release(name, pid = process.pid) {
    const lock = path.join(this.dir, `${name}.lock`);
    try {
      if (Number.parseInt(readOr(lock, ''), 10) === pid) fs.rmSync(lock, { force: true });
    } catch (err) {
      this.fail(err, ` unlocking ${name}.log`); // shown; a lock left behind is taken over at the next start
    }
  }

  // When a log was last written (ms since 1970), or undefined if never.
  writtenAt(name) {
    try {
      return mtimeOr(this.file(name), undefined);
    } catch (err) {
      this.fail(err, ` reading ${name}.log`); // shown; the log then counts as long unwritten
      return undefined;
    }
  }

  write(name, event, fields) {
    const line = formatLine(this.now(), event, fields);
    if (!this.muted.has(name)) this.append(name, [line]);
    return line;
  }

  // Lines still waiting after a failed write are tried once more (as the app quits).
  flush(name) {
    if (this.waiting.has(name) && !this.muted.has(name)) this.append(name, []);
  }

  append(name, fresh) {
    const lines = [...(this.waiting.get(name) ?? []), ...fresh];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.file(name);
      this.moveAside(name, file);
      fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
      this.waiting.delete(name);
    } catch (err) {
      // Kept, in order and with their own times, for the next write; the
      // failure is shown under "Needs attention". Past WAITING_LIMIT the
      // oldest go: by then the log has been failing for hours, and says so.
      this.fail(err);
      this.waiting.set(name, lines.slice(-WAITING_LIMIT));
    }
  }

  // A log over maxBytes moves aside to <name>.1.log. If it cannot (on Windows
  // another program may have the file open), it grows until it can: no line
  // is lost for this.
  moveAside(name, file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      if (err.code === 'ENOENT') return; // no file yet is the normal first write
      throw err;
    }
    if (size <= this.maxBytes) return;
    try {
      fs.renameSync(file, path.join(this.dir, `${name}.1.log`));
    } catch (err) {
      this.fail(err, ` moving ${name}.log aside`);
    }
  }

  fail(err, what = '') {
    this.failures += 1;
    this.failed = `${err.code || err.message}${what}`;
  }

  // The last n lines of a log (newest last); none if it does not exist yet.
  tail(name, n = 60) {
    return tailFile(this.file(name), n);
  }
}

function tailFile(file, n) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter(Boolean).slice(-n);
}

// A file's text, or `fallback` when there is none (a lock already gone).
function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// When a file was last written, or `fallback` when there is none.
function mtimeOr(file, fallback) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Whether a process is running (signal 0 only checks; EPERM: it runs as another user).
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---- what changed between two snapshots ----------------------------------------

const short = (id) => String(id).slice(0, 8);
// A helper's or skill's short id (`call` in a line): the end of the id of the
// call that ran it, since those all begin alike.
const callId = (id) => String(id).slice(-8);

// The sessions on the board in a snapshot.
const boardOf = (snap) => new Map((snap?.sessions ?? []).map((s) => [s.id, s]));

// A snapshot in the shape of Tracker.logView(): each session's map (which keeps
// finished helpers) plus its current helpers, which still hold a helper that
// has dropped off the end of a long map, while it runs and just after.
function viewOfSnapshot(snap) {
  const view = new Map();
  for (const s of snap?.sessions ?? []) {
    const steps = [...(s.map?.steps ?? [])];
    const onMap = new Set(steps.filter((st) => st.kind === 'agent').map((st) => st.id));
    for (const a of s.agents ?? []) if (!onMap.has(a.id)) steps.push({ kind: 'agent', ...a, tokens: a.tokens?.total });
    view.set(s.id, {
      id: s.id,
      project: s.project,
      skills: steps.filter((st) => st.kind !== 'agent'),
      helpers: steps.filter((st) => st.kind === 'agent'),
    });
  }
  return view;
}

// What the log has already said, so nothing is said twice: not when a session
// leaves the board and comes back, not when the transcript of a session the
// tracker let go of is read again, and not after a restart, which reads the
// recent transcripts again (loggedFromLog). Sessions are known by `sid`,
// helpers and skills by `call`, as their lines show them. `lost` holds the
// helpers written as lost, `corrected` those whose end has been corrected.
// Kept while the app runs: a few dozen bytes per helper or skill.
function loggedSoFar() {
  return {
    sessions: new Set(), started: new Set(), ended: new Set(), corrected: new Set(), lost: new Set(), skills: new Set(), onBoard: new Map(),
  };
}

// The same, read back from activity.log's lines as the app starts.
// `onBoard`: sid -> session name, for the sessions whose last line says they
// were on the board when the app stopped, so seeing them again is no news.
function loggedFromLog(lines) {
  const logged = loggedSoFar();
  for (const line of lines) {
    const m = /^\S+ \S+ +(\S+)(.*)$/.exec(line.trimEnd());
    if (!m) continue; // not a line this app wrote (an edit by hand): it says nothing to rebuild
    const [, event, rest] = m;
    const f = fieldsOf(rest);
    if (f.sid && (event === 'session-start' || event === 'session-back')) {
      logged.sessions.add(f.sid);
      logged.onBoard.set(f.sid, f.session);
    } else if (f.sid && event === 'session-quiet') {
      logged.onBoard.delete(f.sid);
    } else if (f.call && event === 'helper-start') {
      logged.started.add(f.call);
    } else if (f.call && (event === 'helper-end' || event === 'helper-end-corrected')) {
      logged.started.add(f.call);
      logged.ended.add(f.call);
      if (event === 'helper-end-corrected') logged.corrected.add(f.call);
      else if (f.outcome === 'lost') logged.lost.add(f.call);
    } else if (f.call && event === 'skill') {
      logged.skills.add(f.call);
    }
  }
  return logged;
}

// Closes what the log left open: the sessions it last saw on the board
// (`logged.onBoard`) that are not on `board` now went quiet while no copy of
// the app was watching, some time before the line (so it says
// `while=app-off`). Afterwards seeing any of them again is news.
function closeOnBoard(logged, board = new Map()) {
  const here = new Set([...board.keys()].map(short));
  const out = [];
  for (const [sid, session] of logged.onBoard) {
    if (!here.has(sid)) out.push({ event: 'session-quiet', fields: { session, sid, while: 'app-off' } });
  }
  logged.onBoard.clear();
  return out;
}

// The key=value fields of a line, as formatLine writes them.
function fieldsOf(text) {
  const out = {};
  for (const [, k, v] of text.matchAll(/(\w[\w-]*)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
    if (!v.startsWith('"')) {
      out[k] = v;
      continue;
    }
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v.slice(1, -1); // kept as written: the fields read back (sid, call, outcome) are never quoted
    }
  }
  return out;
}

// "Went quiet" is the board's guess that a background helper has finished, so
// the log waits for the real end, which replaces the guess (see tracker.js).
const realEnd = (h) => h.status === 'done' && h.endReason !== WENT_QUIET;

// A skill by its call; one without (from a snapshot's map) by what and when.
const skillKey = (sid, by, k) => (k.id !== undefined ? callId(k.id) : JSON.stringify([sid, by, k.name, k.at]));

// What one earlier board and view show was said, for a caller that keeps no
// memory of its own.
function loggedIn(board, view) {
  const logged = loggedSoFar();
  for (const id of board.keys()) logged.sessions.add(short(id));
  for (const s of view.values()) {
    for (const h of s.helpers) {
      logged.started.add(callId(h.id));
      if (realEnd(h)) logged.ended.add(callId(h.id));
      for (const k of h.skills ?? []) logged.skills.add(skillKey(s.id, h.type, k));
    }
    for (const k of s.skills) logged.skills.add(skillKey(s.id, '', k));
  }
  return logged;
}

// How long a line waits for what it says to settle: a start for the launch's
// result (which says whether the helper went to the background), an end for
// the helper's last token counts, often read just after its notification.
const SETTLE_MS = 5_000;

// [{ event, fields }] for the system log, each thing said once (`logged`):
// - sessions, from the board (the sessions in two snapshots): starting, going
//   quiet, and coming back ('session-back');
// - helpers and skills, from two views of what the tracker holds
//   (Tracker.logView()). A start waits for the launch's result or SETTLE_MS;
//   an end waits SETTLE_MS, and the went-quiet guess is never an end. A
//   helper the tracker lets go of (prune) without the log seeing it end is
//   said to be 'lost', unless `lost` is false. An end that turns out wrong (a
//   notification after it, or the real end after 'lost') is corrected once
//   ('helper-end-corrected', `was` the end said first).
// `now` is the time of the newer view; Infinity says everything that waits
// (as the app quits, so nothing is left for a later start to find).
function logEvents({ prevBoard = new Map(), board, prevView = new Map(), view, logged, now = Date.now(), lost = true }) {
  const out = [];
  const where = (s) => ({ session: s.project, sid: short(s.id) });
  const say = (set, key, line) => {
    out.push(line);
    set.add(key);
  };
  const who = (s, h) => ({ agent: h.type, ...where(s), call: callId(h.id) });
  const start = (s, h) => ({ event: 'helper-start', fields: { ...who(s, h), room: h.room, background: h.background ? 'yes' : undefined } });
  const ending = (s, h, outcome) => {
    const ms = outcome === 'lost' ? NaN : h.endedAt - h.startedAt;
    return {
      ...who(s, h), outcome,
      time: Number.isNaN(ms) ? undefined : `${Math.round(ms / 1000)}s`, tokens: h.tokens || undefined,
      background: h.background ? 'yes' : undefined,
    };
  };
  const end = (s, h, outcome = h.endReason ?? 'finished') => ({ event: 'helper-end', fields: ending(s, h, outcome) });
  const correction = (s, h, was) => ({ event: 'helper-end-corrected', fields: { ...ending(s, h, h.endReason ?? 'finished'), was } });
  const settled = (at) => at === undefined || now - at >= SETTLE_MS;
  const skill = (s, by, k) => {
    const key = skillKey(s.id, by, k);
    if (!logged.skills.has(key)) {
      say(logged.skills, key, { event: 'skill', fields: { skill: k.name, by: by || 'session', ...where(s), call: k.id !== undefined ? callId(k.id) : undefined } });
    }
  };

  for (const [id, s] of board) {
    if (prevBoard.has(id)) continue;
    const sid = short(id);
    if (logged.onBoard?.delete(sid)) continue; // on the board when the app last stopped: no news
    say(logged.sessions, sid, { event: logged.sessions.has(sid) ? 'session-back' : 'session-start', fields: where(s) });
  }
  for (const [id, s] of prevBoard) if (!board.has(id)) out.push({ event: 'session-quiet', fields: where(s) });

  for (const s of view.values()) {
    for (const h of s.helpers) {
      const key = callId(h.id);
      if (!logged.started.has(key) && (h.launched !== false || h.status === 'done' || settled(h.startedAt))) {
        say(logged.started, key, start(s, h));
      }
      if (logged.started.has(key) && realEnd(h) && settled(h.endedAt)) {
        const was = h.correctedFrom ?? (logged.lost.has(key) ? 'lost' : undefined);
        if (!logged.ended.has(key)) {
          say(logged.ended, key, end(s, h));
          if (was !== undefined) logged.corrected.add(key); // its one end line is already the right one
        } else if (was !== undefined && !logged.corrected.has(key)) {
          say(logged.corrected, key, correction(s, h, was));
        }
      }
      for (const k of h.skills ?? []) skill(s, h.type, k);
    }
    for (const k of s.skills) skill(s, '', k);
  }

  if (lost) {
    for (const s of prevView.values()) {
      const kept = new Set((view.get(s.id)?.helpers ?? []).map((h) => h.id));
      for (const h of s.helpers) {
        const key = callId(h.id);
        if (kept.has(h.id) || logged.ended.has(key)) continue;
        if (!logged.started.has(key)) say(logged.started, key, start(s, h));
        if (realEnd(h)) {
          say(logged.ended, key, end(s, h));
          if (h.correctedFrom !== undefined) logged.corrected.add(key);
        } else {
          say(logged.ended, key, end(s, h, 'lost'));
          logged.lost.add(key); // its real end may still come, if its session is read again
        }
      }
    }
  }
  return out;
}

// The same from two snapshots alone: helpers and skills come from each
// session's map and current helpers, and are said at once. Without `logged`,
// what `prev` shows counts as said.
function snapshotEvents(prev, next, logged) {
  const prevBoard = boardOf(prev);
  const prevView = viewOfSnapshot(prev);
  return logEvents({
    prevBoard, board: boardOf(next), prevView, view: viewOfSnapshot(next),
    logged: logged ?? loggedIn(prevBoard, prevView), now: Infinity, lost: false,
  });
}

// Who is working right now, for the periodic summary line.
function utilisation(snap) {
  const running = new Map();
  let sessions = 0;
  for (const s of snap?.sessions ?? []) {
    sessions += 1;
    for (const a of s.agents ?? []) if (a.status !== 'done') running.set(a.type, (running.get(a.type) ?? 0) + 1);
  }
  const helpers = [...running.values()].reduce((x, y) => x + y, 0);
  return {
    sessions, helpers,
    working: [...running].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t, n]) => (n > 1 ? `${t}x${n}` : t)).join(',') || undefined,
  };
}

// The reminder hook's own log (~/.claude/hooks/agents-home-router.log):
// "time<TAB>what fired" (the last column is what fired). A summary for the
// last `hours`.
function reminderSummary(lines, now = Date.now(), hours = 24) {
  let runs = 0;
  let reminded = 0;
  let last;
  const since = now - hours * 3_600_000;
  for (const line of lines) {
    const cols = line.split('\t');
    const [time, fired] = [cols[0], cols.length > 1 ? cols.at(-1) : undefined];
    const t = Date.parse(time);
    if (!Number.isFinite(t) || t < since) continue;
    runs += 1;
    if (fired && fired !== 'none') {
      reminded += 1;
      last = { time: t, fired };
    }
  }
  return { runs, reminded, last };
}

module.exports = { SystemLog, formatLine, logEvents, snapshotEvents, loggedSoFar, loggedFromLog, closeOnBoard, utilisation, reminderSummary, tailFile };
