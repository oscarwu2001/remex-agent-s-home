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
    this.files = new Map(); // abs path -> { offset, remainder, mtimeMs }
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

  status() {
    return {
      roots: this.roots.map((r) => ({ path: r, state: this.rootState.get(r) || 'pending' })),
      filesTailed: this.files.size,
    };
  }

  tick(now = Date.now()) {
    if (now - this.lastListAt >= this.opt.listEveryMs) {
      this.lastListAt = now;
      for (const root of this.roots) this.listRoot(root, now);
    }
    for (const [file, state] of this.files) this.readNew(file, state, now);
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
    this.walk(root, 0, now);
  }

  walk(dir, depth, now) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') this.onProblem(`Cannot list ${dir}: ${err.code || err.message}`);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < this.opt.maxDepth) this.walk(full, depth + 1, now);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl') && !this.files.has(full)) {
        this.consider(full, now);
      }
    }
  }

  consider(file, now) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') this.onProblem(`Cannot read ${path.basename(file)}: ${err.code}`);
      return;
    }
    if (now - stat.mtimeMs > this.opt.activeWindowMs) return;
    const start = Math.max(0, stat.size - this.opt.maxInitialBytes);
    // Starting mid-file: the first partial line is dropped, not parsed.
    this.files.set(file, { offset: start, remainder: Buffer.alloc(0), mtimeMs: 0, skipFirst: start > 0 });
  }

  readNew(file, state, now) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      this.files.delete(file);
      if (err.code !== 'ENOENT') this.onProblem(`Stopped reading ${path.basename(file)}: ${err.code}`);
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
    const buf = Buffer.alloc(length);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, buf, 0, length, state.offset);
      state.offset += read;
      this.consume(file, state, buf.subarray(0, read), now);
    } catch (err) {
      this.onProblem(`Read failed for ${path.basename(file)}: ${err.code || err.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    state.mtimeMs = stat.mtimeMs;
  }

  consume(file, state, chunk, now) {
    let data = state.remainder.length ? Buffer.concat([state.remainder, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      const line = data.subarray(start, i).toString('utf8');
      start = i + 1;
      if (state.skipFirst) {
        state.skipFirst = false;
        continue;
      }
      this.emitLine(file, line, now);
    }
    // Bytes after the last newline are an unfinished line; keep them.
    state.remainder = Buffer.from(data.subarray(start));
  }

  emitLine(file, line, now) {
    let entry;
    try {
      entry = parseLine(line);
    } catch (err) {
      this.onMalformed(file, err);
      return;
    }
    if (entry) this.onEntry(file, entry, now);
  }
}

function defaultRoots(env = process.env, home = require('os').homedir()) {
  const roots = [];
  if (env.CLAUDE_CONFIG_DIR) roots.push(path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  roots.push(path.join(home, '.claude', 'projects'));
  return [...new Set(roots)];
}

module.exports = { TranscriptWatcher, defaultRoots, DEFAULTS };
