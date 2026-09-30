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

const MAX_BYTES = 2_000_000; // then the file moves to <name>.1.log and starts again

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
    this.failed = undefined; // the first write error, for "Needs attention"
  }

  file(name) {
    return path.join(this.dir, `${name}.log`);
  }

  write(name, event, fields) {
    const line = formatLine(this.now(), event, fields);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.file(name);
      try {
        if (fs.statSync(file).size > this.maxBytes) fs.renameSync(file, path.join(this.dir, `${name}.1.log`));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err; // no file yet is the normal first write
      }
      fs.appendFileSync(file, `${line}\n`);
    } catch (err) {
      if (!this.failed) this.failed = `${err.code || err.message}`;
    }
    return line;
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

// ---- what changed between two snapshots ----------------------------------------

const short = (id) => String(id).slice(0, 8);

// Every helper and skill a snapshot knows of, from each session's map (which
// keeps finished helpers) or, failing that, its current helpers.
function inventory(snap) {
  const sessions = new Map();
  const helpers = new Map();
  const skills = new Set();
  for (const s of snap?.sessions ?? []) {
    sessions.set(s.id, s);
    const steps = s.map?.steps ?? (s.agents ?? []).map((a) => ({ kind: 'agent', ...a, tokens: a.tokens?.total }));
    for (const st of steps) {
      if (st.kind === 'agent') {
        helpers.set(st.id, { ...st, session: s });
        for (const k of st.skills ?? []) skills.add(JSON.stringify([s.id, st.type, k.name, k.at]));
      } else skills.add(JSON.stringify([s.id, '', st.name, st.at]));
    }
  }
  return { sessions, helpers, skills };
}

// [{ event, fields }] for what is new or finished in `next` since `prev`.
function snapshotEvents(prev, next) {
  const a = inventory(prev);
  const b = inventory(next);
  const out = [];
  const where = (s) => ({ session: s.project, sid: short(s.id) });
  for (const [id, s] of b.sessions) if (!a.sessions.has(id)) out.push({ event: 'session-start', fields: where(s) });
  for (const [id, s] of a.sessions) if (!b.sessions.has(id)) out.push({ event: 'session-quiet', fields: where(s) });
  for (const [id, h] of b.helpers) {
    const before = a.helpers.get(id);
    if (!before) {
      out.push({ event: 'helper-start', fields: { agent: h.type, ...where(h.session), room: h.room, background: h.background ? 'yes' : undefined } });
    }
    if (h.status === 'done' && before?.status !== 'done') {
      const ms = h.endedAt && h.startedAt ? h.endedAt - h.startedAt : undefined;
      out.push({
        event: 'helper-end',
        fields: {
          agent: h.type, ...where(h.session), outcome: h.endReason ?? 'finished',
          time: ms === undefined ? undefined : `${Math.round(ms / 1000)}s`, tokens: h.tokens || undefined,
        },
      });
    }
  }
  for (const k of b.skills) {
    if (a.skills.has(k)) continue;
    const [sid, by, name] = JSON.parse(k);
    const s = b.sessions.get(sid);
    out.push({ event: 'skill', fields: { skill: name, by: by || 'session', ...(s ? where(s) : {}) } });
  }
  return out;
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

module.exports = { SystemLog, formatLine, snapshotEvents, utilisation, reminderSummary, tailFile };
