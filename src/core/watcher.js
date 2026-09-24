'use strict';

// Tails Claude Code transcript files by polling. Polling rather than
// fs.watch because it behaves the same on Windows, macOS and Linux and on
// network or synced folders, and the load is small: directories are listed
// every few seconds, and only recently written files are read each tick.

const fs = require('fs');
const path = require('path');
const { parseLine } = require('./transcript');

const DEFAULTS = {
  tickMs: 750,
  listEveryMs: 4_000,
  activeWindowMs: 30 * 60_000, // pick up files written within this window
  forgetAfterMs: 60 * 60_000, // stop tailing files quiet this long
  maxInitialBytes: 4 * 1024 * 1024, // replay at most this much of a new file
  maxDepth: 4, // projects/<project>/<session>/subagents/<file>
};

class TranscriptWatcher {
  constructor({ roots, onEntry, onMalformed, onProblem, options = {} }) {
    this.roots = roots;
    this.onEntry = onEntry;
    this.onMalformed = onMalformed;
    this.onProblem = onProblem;
    this.opt = { ...DEFAULTS, ...options };
    this.files = new Map(); // abs path -> { root, offset, remainder, mtimeMs }
    this.lastListAt = 0;
    this.timer = undefined;
    this.rootState = new Map(); // root -> 'ok' | 'missing' | error message
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opt.tickMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Roots change while running when a WSL distro starts or stops. Files under
  // a dropped root are left untouched but keep their read position, so when
  // the root comes back nothing is read, and counted, twice.
  setRoots(roots) {
    const next = [...new Set(roots)];
    if (next.join('\n') === this.roots.join('\n')) return;
    for (const root of this.roots) {
      if (!next.includes(root)) this.rootState.delete(root);
    }
    this.roots = next;
    this.lastListAt = 0; // list the new roots on the next tick
  }

  status() {
    const active = new Set(this.roots);
    return {
      roots: this.roots.map((r) => ({ path: r, state: this.rootState.get(r) || 'pending' })),
      filesTailed: [...this.files.values()].filter((s) => active.has(s.root)).length,
    };
  }

  tick(now = Date.now()) {
    if (now - this.lastListAt >= this.opt.listEveryMs) {
      this.lastListAt = now;
      for (const root of this.roots) this.listRoot(root, now);
    }
    const active = new Set(this.roots);
    for (const [file, state] of this.files) {
      if (active.has(state.root)) this.readNew(file, state, now);
    }
  }

  listRoot(root, now) {
    let stat;
    try {
      stat = fs.statSync(root);
    } catch (err) {
      this.rootState.set(root, err.code === 'ENOENT' ? 'missing' : `unreadable: ${err.code || err.message}`);
      return;
    }
    if (!stat.isDirectory()) {
      this.rootState.set(root, 'not a folder');
      return;
    }
    this.rootState.set(root, 'ok');
    this.walk(root, 0, now, root);
  }

  walk(dir, depth, now, root) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') this.onProblem(`A transcript folder could not be listed (${err.code || 'error'})`, dir);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < this.opt.maxDepth) this.walk(full, depth + 1, now, root);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl') && !this.files.has(full)) {
        this.consider(full, now, root);
      }
    }
  }

  consider(file, now, root) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') this.onProblem(`A transcript could not be opened (${err.code || 'error'})`, file);
      return;
    }
    if (now - stat.mtimeMs > this.opt.activeWindowMs) return;
    const start = Math.max(0, stat.size - this.opt.maxInitialBytes);
    // Starting mid-file: drop the partial first line, unless we happen to
    // start exactly on a line boundary.
    this.files.set(file, {
      root, offset: start, remainder: Buffer.alloc(0), mtimeMs: 0, skipFirst: start > 0 && !startsAtLine(file, start),
    });
  }

  readNew(file, state, now) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      this.files.delete(file);
      if (err.code !== 'ENOENT') this.onProblem(`Stopped reading a transcript (${err.code || 'error'})`, file);
      return;
    }
    if (stat.size < state.offset) {
      // Truncated or replaced: start again from the top.
      state.offset = 0;
      state.remainder = Buffer.alloc(0);
      state.skipFirst = false;
    }
    if (stat.size === state.offset) {
      if (now - stat.mtimeMs > this.opt.forgetAfterMs) this.files.delete(file);
      return;
    }

    const length = stat.size - state.offset;
    let buf = Buffer.alloc(length);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, buf, 0, length, state.offset);
      buf = buf.subarray(0, read);
      state.offset += read;
    } catch (err) {
      this.onProblem(`Reading a transcript failed (${err.code || 'error'})`, file);
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    state.mtimeMs = stat.mtimeMs;
    for (const line of this.split(state, buf)) this.emitLine(file, line, now);
  }

  // Complete lines from a chunk; the unfinished tail is kept for next time.
  // State is settled before any line is handed on, so a failure downstream
  // cannot desynchronise the tail.
  split(state, chunk) {
    const data = state.remainder.length ? Buffer.concat([state.remainder, chunk]) : chunk;
    const lines = [];
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      if (state.skipFirst) state.skipFirst = false;
      else lines.push(data.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
    state.remainder = Buffer.from(data.subarray(start));
    return lines;
  }

  emitLine(file, line, now) {
    let entry;
    try {
      entry = parseLine(line);
    } catch (err) {
      this.onMalformed(file, err);
      return;
    }
    if (!entry) return;
    try {
      this.onEntry(file, entry, now);
    } catch (err) {
      this.onProblem(`A transcript line could not be processed (${err.name})`, `${path.basename(file)}: ${err.message}`);
    }
  }
}

function startsAtLine(file, pos) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, pos - 1);
    return b[0] === 0x0a;
  } catch {
    return false; // unknown: dropping one line is the safe choice
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function defaultRoots(env = process.env, home = require('os').homedir()) {
  const roots = [];
  if (env.CLAUDE_CONFIG_DIR) roots.push(path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  roots.push(path.join(home, '.claude', 'projects'));
  return [...new Set(roots)];
}

module.exports = { TranscriptWatcher, defaultRoots, DEFAULTS };
