'use strict';

// Claude Code usage, from the transcripts: how full each session's context
// is, and how many tokens all sessions used over the last 5 hours, today
// and the last 7 days. Plan limits (Pro, Max) are not written anywhere
// locally, so none are assumed here: the user can set their own warning
// level, and Claude Code's own limit messages are passed on as they are.

const fs = require('fs');
const path = require('path');

// The context window of a model when no compaction has shown where it
// really stops. Current models read 1M tokens; Haiku 4.5 and older models
// read 200k (Claude Code may compact before either).
function contextWindowFor(model) {
  const m = String(model ?? '');
  if (/haiku|claude-3|opus-4-[015]\b|opus-4-[015]-|sonnet-4-[05]\b|sonnet-4-[05]-|sonnet-4-2|opus-4-2/.test(m)) return 200_000;
  if (!m) return 200_000;
  return 1_000_000;
}

// What the model read in one reply: new input plus both kinds of cache.
function contextOf(usage) {
  return (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
}

const LIMIT_TEXT = /usage limit|limit (?:reached|will reset|resets)|rate limit|out of (?:extra )?usage|approaching .*limit/i;

const WEEK_MS = 7 * 24 * 3_600_000;
const FIVE_H_MS = 5 * 3_600_000;
const CHUNK = 1 << 20;

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, fresh: 0, replies: 0 };
}

function add(t, u) {
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheWrite += cacheWrite;
  t.total += input + output + cacheRead + cacheWrite;
  // "Fresh" leaves out cache reads, which are cheap and dominate the total.
  t.fresh += input + output + cacheWrite;
  t.replies += 1;
}

// Reads every transcript touched in the last 7 days under the given
// projects folders, once in full and then only what was appended, and keeps
// each reply's usage (once per message id, at its fullest).
class UsageScanner {
  constructor({ roots = [] } = {}) {
    this.roots = roots;
    this.files = new Map(); // path -> { offset, remainder }
    this.replies = new Map(); // message id -> { ts, usage }
    this.loose = []; // [{ ts, usage }] replies without an id
    this.limitNotice = undefined;
    this.unreadable = 0;
    this.problems = new Map(); // folder -> message
  }

  setRoots(roots) {
    this.roots = roots;
  }

  async listFiles(root) {
    let names;
    try {
      names = await fs.promises.readdir(root, { recursive: true });
    } catch (err) {
      // A folder that does not exist yet has no usage in it.
      if (err.code !== 'ENOENT') this.problems.set(root, `could not be listed (${err.code})`);
      return [];
    }
    this.problems.delete(root);
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(root, n));
  }

  async readNew(file, state) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size < state.offset) Object.assign(state, { offset: 0, remainder: '' }); // rewritten
      while (state.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - state.offset));
        const { bytesRead } = await handle.read(buf, 0, buf.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const text = state.remainder + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        state.remainder = lines.pop();
        for (const l of lines) this.take(l);
      }
    } finally {
      await handle.close();
    }
  }

  take(line) {
    // Most lines carry no usage; skip them before parsing.
    const usageLine = line.includes('"usage"');
    const errorLine = line.includes('"isApiErrorMessage":true');
    if (!usageLine && !errorLine) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      this.unreadable += 1;
      return;
    }
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) return;
    const m = e.message;
    if (errorLine && e.isApiErrorMessage === true && m) {
      const text = (Array.isArray(m.content) ? m.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim();
      if (LIMIT_TEXT.test(text) && (!this.limitNotice || ts > this.limitNotice.ts)) this.limitNotice = { ts, text: text.slice(0, 200) };
      return;
    }
    if (e.type !== 'assistant' || !m || !m.usage || typeof m.usage !== 'object') return;
    if (typeof m.id !== 'string') {
      this.loose.push({ ts, usage: m.usage });
      return;
    }
    const prev = this.replies.get(m.id);
    const size = (u) => contextOf(u) + (Number(u.output_tokens) || 0);
    if (!prev || size(m.usage) > size(prev.usage)) this.replies.set(m.id, { ts, usage: m.usage });
  }

  async scan(now = Date.now()) {
    const since = now - WEEK_MS;
    for (const root of this.roots) {
      for (const file of await this.listFiles(root)) {
        let stat;
        try {
          stat = await fs.promises.stat(file);
        } catch (err) {
          // Removed between listing and reading: nothing left to count.
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        if (stat.mtimeMs < since) continue;
        const state = this.files.get(file) ?? { offset: 0, remainder: '' };
        this.files.set(file, state);
        try {
          await this.readNew(file, state);
        } catch (err) {
          this.problems.set(file, `could not be read (${err.code || err.message})`);
        }
      }
    }
    for (const [id, r] of this.replies) if (r.ts < since) this.replies.delete(id);
    this.loose = this.loose.filter((r) => r.ts >= since);
  }

  summary(now = Date.now()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const out = { last5h: emptyTotals(), today: emptyTotals(), week: emptyTotals() };
    for (const r of [...this.replies.values(), ...this.loose]) {
      if (r.ts > now) continue;
      if (now - r.ts <= WEEK_MS) add(out.week, r.usage);
      if (r.ts >= midnight.getTime()) add(out.today, r.usage);
      if (now - r.ts <= FIVE_H_MS) add(out.last5h, r.usage);
    }
    const notice = this.limitNotice && now - this.limitNotice.ts <= FIVE_H_MS ? this.limitNotice : undefined;
    return { ...out, limitNotice: notice, unreadable: this.unreadable, problems: [...this.problems].map(([where, what]) => ({ where, what })) };
  }
}

module.exports = { contextWindowFor, contextOf, LIMIT_TEXT, UsageScanner };
