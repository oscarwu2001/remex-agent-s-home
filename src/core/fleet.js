'use strict';

// "Running now" across computers. Off until the user picks a shared folder
// (OneDrive, Dropbox, a network drive: anything that syncs on its own). Each
// copy of the app then writes one small file there, `<computer>.json`, every
// few seconds, and reads the files of the others. The app itself makes no
// network call: syncing is the folder's job.
//
// What a file holds is what the board shows in privacy mode and no more:
// the computer's name, and per session its project folder name, where it
// runs (Claude Code, Cowork, WSL), its status, its helpers' types and
// statuses, and to-do counts. Never to-do wording, task titles, file names,
// commands or prompts.

const fs = require('fs');
const path = require('path');

const FRESH_MS = 3 * 60_000; // a computer not heard from in this long is offline
const KEEP_MS = 7 * 86_400_000; // offline computers are listed for a week
// Keep in step with RUNNING in renderer/overview.js.
const RUNNING = new Set(['working', 'thinking', 'reporting', 'blocked', 'delegating']);

const isRunning = (status) => RUNNING.has(status);

// A file name for a computer: its name (letters, digits, - and _ only) and
// the random id this copy of the app keeps, so two computers with the same
// name never write the same file.
function fileFor(computer, id) {
  const safe = String(computer).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const tag = String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  return `${safe || 'computer'}${tag ? `-${tag}` : ''}.json`;
}

// This computer's sessions, trimmed to what may be shared.
function summaryOf(snapshot, computer, now = Date.now(), id = undefined) {
  return {
    app: 'agents-home',
    version: 1,
    id,
    computer,
    at: now,
    sessions: (snapshot.sessions ?? []).map((s) => ({
      project: String(s.project ?? 'session').slice(0, 80),
      source: s.source ?? 'code',
      where: s.computer ?? computer,
      status: s.status,
      agents: (s.agents ?? []).filter((a) => a.status !== 'done').map((a) => ({ type: String(a.type).slice(0, 64), status: a.status })),
      todos: s.todos ? { done: s.todos.done, doing: s.todos.doing, total: s.todos.total } : undefined,
    })),
  };
}

function writeShare(dir, summary, fsys = fs) {
  const file = path.join(dir, fileFor(summary.computer, summary.id));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsys.writeFileSync(tmp, JSON.stringify(summary));
    fsys.renameSync(tmp, file); // whole files only, so a reader never sees half of one
  } catch (err) {
    try {
      fsys.unlinkSync(tmp);
    } catch {
      // The temporary file may never have been made; the caller reports err.
    }
    throw err;
  }
  return file;
}

// Another computer's file comes from a synced folder that other people or
// other app versions may write, so every session is rebuilt from checked
// values: known statuses and sources only, short plain names, small whole
// numbers. Anything else makes the session (or the file) count as odd.
const STATUSES = new Set(['working', 'thinking', 'reporting', 'blocked', 'delegating', 'your-turn', 'idle', 'standby', 'done']);
const SOURCES = new Set(['code', 'cowork', 'wsl']);
const nameOf = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 1000 ? v : undefined);
function cleanSession(s) {
  if (!s || typeof s !== 'object') return undefined;
  const project = nameOf(s.project, 80);
  if (!project || !STATUSES.has(s.status)) return undefined;
  const agents = (Array.isArray(s.agents) ? s.agents : []).slice(0, 20)
    .filter((a) => a && nameOf(a.type, 64) && STATUSES.has(a.status))
    .map((a) => ({ type: nameOf(a.type, 64), status: a.status }));
  let todos;
  if (s.todos && typeof s.todos === 'object') {
    const [done, doing, total] = [count(s.todos.done), count(s.todos.doing) ?? 0, count(s.todos.total)];
    if (done !== undefined && total !== undefined && done + doing <= total) todos = { done, doing, total };
  }
  const lastAt = Number.isFinite(s.lastAt) ? s.lastAt : undefined;
  return { project, source: SOURCES.has(s.source) ? s.source : 'code', where: nameOf(s.where, 80), status: s.status, lastAt, agents, todos };
}

// A posted project's git line: branch, last commit time, uncommitted files.
const when = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
function cleanRepo(r) {
  const project = nameOf(r?.project, 80);
  if (!project) return undefined;
  return { project, branch: nameOf(r.branch, 80), lastCommit: when(r.lastCommit), changed: count(r.changed) ?? 0 };
}

// Hourly posts are snapshots: a session counts as running only if it was
// written to in the last few minutes, not because it was busy at post time.
const LIVE_MS = 10 * 60_000;

// The other computers' files. A file that cannot be read or makes no sense
// is reported, never guessed at.
// `self` is this copy's file name (fileFor), which is skipped.
function readShares(dir, self, now = Date.now(), fsys = fs) {
  const computers = [];
  const problems = [];
  let names;
  try {
    names = fsys.readdirSync(dir);
  } catch (err) {
    return { computers, problems: [{ label: `The shared folder could not be read (${err.code || 'error'})`, detail: dir }] };
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === self) continue;
    const file = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fsys.readFileSync(file, 'utf8'));
    } catch (err) {
      // A sync client may be half-way through replacing the file.
      if (err.code === 'ENOENT') continue;
      problems.push({ label: `A computer's status file in the shared folder could not be read (${err.code || 'not valid JSON'})`, detail: file });
      continue;
    }
    if (!data || data.app !== 'agents-home' || typeof data.computer !== 'string' || !Number.isFinite(data.at) || !Array.isArray(data.sessions)) {
      problems.push({ label: 'A file in the shared folder is not an Agent\'s Home status file', detail: file });
      continue;
    }
    if (now - data.at > KEEP_MS) continue;
    // A computer that posts every hour (the git status branch) is online
    // until a quarter past its next post is due; one in a synced folder
    // writes every few seconds, so three minutes of silence is offline.
    const every = Number.isFinite(data.every) && data.every > 0 ? Math.min(data.every, 6 * 3_600_000) : 0;
    const online = now - data.at <= Math.max(FRESH_MS, every * 1.25);
    const sessions = online ? data.sessions.slice(0, 100).map(cleanSession) : [];
    const kept = sessions.filter(Boolean);
    if (every) {
      for (const s of kept) {
        if (RUNNING.has(s.status) && now - (s.lastAt ?? data.at) > LIVE_MS) s.status = 'idle';
      }
    }
    if (kept.length < sessions.length) problems.push({ label: `${sessions.length - kept.length} session${sessions.length - kept.length === 1 ? '' : 's'} in a computer's status file did not make sense and ${sessions.length - kept.length === 1 ? 'is' : 'are'} not shown`, detail: file });
    computers.push({
      computer: nameOf(data.computer, 80) ?? 'A computer',
      at: data.at,
      online,
      every: every || undefined,
      sessions: kept,
      repos: (Array.isArray(data.repos) ? data.repos.slice(0, 50) : []).map(cleanRepo).filter(Boolean),
    });
  }
  computers.sort((a, b) => a.computer.localeCompare(b.computer));
  return { computers, problems };
}

module.exports = { summaryOf, writeShare, readShares, fileFor, isRunning, FRESH_MS };
