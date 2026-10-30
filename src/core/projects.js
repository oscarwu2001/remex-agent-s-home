'use strict';

// The project list: every project the user is working on, each with its own
// to-do list. It lives in one plain JSON file outside Claude's folders,
// `~/.agents-home/projects.json` (or $AGENTS_HOME_PROJECTS), so three kinds
// of writer can share it:
//
//   - the personal-assistant agent, which scans the computer, groups branch
//     copies and worktrees under their main project, asks the user to
//     confirm the list and writes it (office-pack/skills/scan-projects);
//   - the project-manager agent, which adds to-dos to one project;
//   - this app, when the user types or ticks a to-do.
//
// The app re-reads the file when it changes and writes only whole files
// (write to a temporary file, then rename). Anything it cannot make sense
// of is reported and left alone: a broken file is never overwritten.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const TODO_LIMIT = 200;
const TEXT_LIMIT = 300;

function projectsFile(env = process.env, home = os.homedir()) {
  return env.AGENTS_HOME_PROJECTS || path.join(home, '.agents-home', 'projects.json');
}

const str = (v, max = TEXT_LIMIT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
const STATES = new Set(['active', 'paused', 'done']);
// A to-do's planned day, as YYYY-MM-DD (a real calendar day).
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// The file as written stays the source of truth: the app reads a clean
// view of it to show, but every save writes the file back as it was, with
// only the one change made. So projects or to-dos the view leaves out (no
// name, empty text, past the limit) and fields the app does not know all
// survive the app's writes.
//
// Ids: a project or to-do without an id, or with one already used, gets an
// id worked out from where it sits and what it says. The same file always
// gives the same ids, so what the view shows and what a change names agree,
// and the first save writes them down.
const hash = (...parts) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function withIds(raw) {
  const projects = raw.projects.map((p) => (p && typeof p === 'object' ? { ...p } : p));
  const seenP = new Set();
  projects.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    let id = str(p.id, 80) || slug(str(p.name, 120)) || `p-${hash('p', i)}`;
    if (seenP.has(id)) id = `${id}-${hash(id, i)}`;
    seenP.add(id);
    p.id = id;
    if (!Array.isArray(p.todos)) return;
    const seenT = new Set();
    p.todos = p.todos.map((t, k) => {
      const item = typeof t === 'string' ? { text: t } : t && typeof t === 'object' ? { ...t } : t;
      if (!item || typeof item !== 'object') return t;
      let tid = str(item.id, 40) || `t-${hash(id, k, str(item.text))}`;
      if (seenT.has(tid)) tid = `${tid}-${hash(tid, k)}`;
      seenT.add(tid);
      item.id = tid;
      return item;
    });
  });
  return { ...raw, projects };
}

// The view: what the board and the mini window show, plus what was odd.
function checkProjects(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.projects)) {
    return { raw: undefined, data: undefined, problems: ['it has no "projects" list'] };
  }
  const full = withIds(raw);
  const problems = [];
  const projects = [];
  full.projects.forEach((p, i) => {
    const name = str(p?.name, 120);
    if (!name) {
      problems.push(`project ${i + 1} has no name, so it is not shown (it stays in the file)`);
      return;
    }
    const list = Array.isArray(p.todos) ? p.todos : [];
    if (list.length > TODO_LIMIT) problems.push(`${name} has more than ${TODO_LIMIT} to-dos; the rest are not shown (they stay in the file)`);
    const todos = list.slice(0, TODO_LIMIT)
      .filter((t) => t && typeof t === 'object' && str(t.text))
      .map((t) => ({ id: t.id, text: str(t.text), done: t.done === true, by: t.by === 'agent' ? 'agent' : 'you', ...(isDay(t.due) ? { due: t.due } : {}) }));
    projects.push({
      id: p.id,
      name,
      path: str(p.path, 600) || undefined,
      // Branch copies, worktrees and extra clones of the same project.
      copies: (Array.isArray(p.copies) ? p.copies : []).map((c) => ({ path: str(typeof c === 'string' ? c : c?.path, 600) })).filter((c) => c.path),
      status: STATES.has(p.status) ? p.status : 'active',
      confirmed: p.confirmed === true,
      todos,
    });
  });
  return { raw, data: { version: VERSION, projects }, problems };
}

function loadProjects(file, fsys = fs) {
  let text;
  try {
    text = fsys.readFileSync(file, 'utf8');
  } catch (err) {
    // No file yet is normal: nobody has scanned or added a project.
    if (err.code === 'ENOENT') return { raw: { version: VERSION, projects: [] }, data: { version: VERSION, projects: [] }, problems: [], missing: true };
    return { raw: undefined, data: undefined, problems: [`the project list could not be read (${err.code || 'error'})`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { raw: undefined, data: undefined, problems: ['the project list is not valid JSON; fix or remove it, it is left as it is'] };
  }
  return checkProjects(raw);
}

function saveProjects(file, raw, fsys = fs) {
  fsys.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsys.writeFileSync(tmp, `${JSON.stringify({ ...raw, version: raw.version ?? VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    fsys.renameSync(tmp, file);
  } catch (err) {
    try {
      fsys.unlinkSync(tmp);
    } catch {
      // The temporary file may never have been made; the caller reports err.
    }
    throw err;
  }
}

// One change from the app, made to the file as written (see above): add,
// tick or remove a to-do, confirm a project, set its status, or add one by
// hand. Returns the new file contents or throws a reason fit to show.
function applyChange(raw, change) {
  const full = withIds(raw);
  const find = (id) => {
    const hits = full.projects.filter((x) => x && typeof x === 'object' && x.id === id);
    if (hits.length !== 1) throw new Error('That project is no longer on the list.');
    return hits[0];
  };
  const findTodo = (p, id) => {
    const hits = (Array.isArray(p.todos) ? p.todos : []).filter((t) => t && typeof t === 'object' && t.id === id);
    if (hits.length !== 1) throw new Error('That to-do is no longer on the list.');
    return hits[0];
  };
  switch (change?.op) {
    case 'add-todo': {
      const p = find(change.project);
      const text = str(change.text);
      if (!text) throw new Error('Type the to-do first.');
      if (!Array.isArray(p.todos)) p.todos = [];
      if (p.todos.length >= TODO_LIMIT) throw new Error(`A project holds at most ${TODO_LIMIT} to-dos.`);
      p.todos.push({ id: newId('t'), text, done: false, by: 'you', at: new Date().toISOString() });
      break;
    }
    case 'toggle-todo': {
      const t = findTodo(find(change.project), change.todo);
      t.done = t.done !== true;
      if (t.done) t.doneAt = new Date().toISOString();
      break;
    }
    case 'set-date': {
      const t = findTodo(find(change.project), change.todo);
      if (change.date === '' || change.date == null) delete t.due;
      else if (isDay(change.date)) t.due = change.date;
      else throw new Error('That is not a date.');
      break;
    }
    case 'remove-todo': {
      const p = find(change.project);
      const t = findTodo(p, change.todo);
      p.todos = p.todos.filter((x) => x !== t);
      break;
    }
    case 'confirm': {
      find(change.project).confirmed = true;
      break;
    }
    case 'status': {
      if (!STATES.has(change.status)) throw new Error('Unknown status.');
      find(change.project).status = change.status;
      break;
    }
    case 'add-project': {
      const name = str(change.name, 120);
      if (!name) throw new Error('Give the project a name.');
      if (full.projects.some((p) => str(p?.name, 120).toLowerCase() === name.toLowerCase())) throw new Error('A project of that name is already on the list.');
      full.projects.push({ id: newId('p'), name, status: 'active', confirmed: true, copies: [], todos: [] });
      break;
    }
    default:
      throw new Error('Unknown change.');
  }
  return full;
}

// Which project a session belongs to, from its working folder: the project
// whose folder (or one of its copies) holds it, the deepest match winning.
// Windows paths ignore case and use either slash.
function projectFor(cwd, projects) {
  if (!cwd) return undefined;
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = `${norm(cwd)}/`;
  let best;
  for (const p of projects) {
    for (const dir of [p.path, ...p.copies.map((x) => x.path)].filter(Boolean)) {
      const d = `${norm(dir)}/`;
      if (c.startsWith(d) && (!best || d.length > best.len)) best = { id: p.id, len: d.length, copy: dir !== p.path };
    }
  }
  return best && { id: best.id, copy: best.copy };
}

module.exports = { projectsFile, loadProjects, saveProjects, checkProjects, applyChange, projectFor, VERSION };
