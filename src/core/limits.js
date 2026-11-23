'use strict';

// Limit hits: each time Claude Code wrote into a transcript that a plan
// limit was reached, kept with the plan picked then, its window (the week
// when the message says weekly, else the 5 hours) and the tokens used in
// that window just before (the `total` measure, see renderer/plans.js).
// The board learns roughly where the picked plan's limit lies from them
// (estimate in renderer/plans.js). They live in the app data folder
// (usage-limits.json), never under ~/.claude, written whole through a temp
// file and a rename, and a file that cannot be read is never written over.

const fs = require('fs');
const path = require('path');
const { en } = require('./i18n');
const { WINDOW_MS, isPlan } = require('../../renderer/plans.js');

// A message saying a limit was reached. Not a hit: a warning that one is
// near, an API rate limit (requests per minute, not the plan's limit) or
// running out of extra usage (already past the plan's limit).
const HIT_TEXT = /usage limit|limit (?:reached|will reset|resets)|hit your (?:usage )?limit|out of usage/i;
const NOT_A_HIT = /approaching|rate limit|extra usage/i;

// '5h', 'week', or null when the message is not a limit hit.
function hitWindow(text) {
  const t = String(text ?? '');
  if (!HIT_TEXT.test(t) || NOT_A_HIT.test(t)) return null;
  return /weekly/i.test(t) ? 'week' : '5h';
}

// While a limit holds, every new prompt brings the same message again and
// nothing is answered: a message of the same window and plan, within that
// window's length of a hit and with no reply in between, is the same hit.
// Replies finishing just after the hit (sent before it) are allowed for.
const GRACE_MS = 2 * 60_000;

const FORMAT = 1;

function readHit(h) {
  const ok = h && typeof h === 'object' && Number.isFinite(h.at) && Object.hasOwn(WINDOW_MS, h.window) && isPlan(h.plan)
    && Number.isFinite(h.tokens) && h.tokens >= 0 && Array.isArray(h.seen) && h.seen.length > 0 && h.seen.every(Number.isFinite);
  if (!ok) throw new TypeError('a hit not in the shape this version reads');
  return h;
}

class LimitBook {
  constructor({ file }) {
    this.file = file;
    this.hits = [];
    this.kept = {}; // the file's other fields, written back as they came
    this.read = false; // nothing is written before the file was read in this run
    this.stamp = null; // the file as last read or written: re-read when it changed
    this.readProblem = null;
    this.saveProblem = null;
  }

  // Reads the file when it was not read yet or changed since; true when what
  // is held is the file's. A file that cannot be read pauses the estimate
  // and is left as it is.
  load() {
    let stamp;
    try {
      const st = fs.statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return this.unread(en('said.limits.notRead', { code: err.code || err.name }));
      // The user removed the file: no hits. With no file yet, any hits held
      // are waiting for their first save.
      if (this.stamp !== null) Object.assign(this, { hits: [], kept: {} });
      return this.isRead(null);
    }
    if (this.read && stamp === this.stamp) return true;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      return this.unread(err instanceof SyntaxError ? en('said.limits.notShape') : en('said.limits.notRead', { code: err.code || err.name }));
    }
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.hits)) throw new TypeError('no hits list');
      if (Number(data.format) > FORMAT) throw new TypeError('written by a newer version');
      const hits = data.hits.map(readHit);
      const kept = { ...data };
      delete kept.hits;
      Object.assign(this, { hits, kept });
    } catch {
      return this.unread(en('said.limits.notShape'));
    }
    return this.isRead(stamp);
  }

  unread(label) {
    this.read = false;
    this.readProblem = { label, detail: this.file };
    return false;
  }

  isRead(stamp) {
    this.read = true;
    this.stamp = stamp;
    this.readProblem = null;
    return true;
  }

  // Records the hits in `found` ([{ ts, window }]) not counted before, under
  // `plan`. `measure` gives the tokens used in [from, to) and whether any
  // reply came in (from, to): the UsageScanner. Returns how many were new.
  take(found, plan, measure) {
    if (!isPlan(plan)) throw new TypeError(`not a plan: ${plan}`);
    if (!this.load()) return 0;
    const counted = new Set(this.hits.flatMap((h) => h.seen.map((ts) => `${h.window}@${ts}`)));
    let added = 0;
    let changed = false;
    for (const f of [...found].sort((a, b) => a.ts - b.ts)) {
      const key = `${f.window}@${f.ts}`;
      if (counted.has(key)) continue;
      counted.add(key);
      const span = WINDOW_MS[f.window];
      const same = this.hits.find((h) => h.window === f.window && h.plan === plan && Math.abs(f.ts - h.at) < span
        && !measure.repliedBetween(Math.max(...h.seen) + GRACE_MS, f.ts));
      if (same) same.seen.push(f.ts);
      else {
        this.hits.push({ at: f.ts, plan, window: f.window, tokens: measure.tokensBetween(f.ts - span, f.ts), seen: [f.ts] });
        added += 1;
      }
      changed = true;
    }
    if (changed || this.saveProblem) this.save();
    return added;
  }

  save() {
    // A fixed temp name: one left by a crash is written over by the next save.
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ ...this.kept, format: FORMAT, hits: this.hits }, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
      const st = fs.statSync(this.file);
      this.stamp = `${st.mtimeMs}:${st.size}`;
      this.saveProblem = null;
    } catch (err) {
      // The hits stay counted here and the next pass saves them again.
      this.saveProblem = { label: en('said.limits.notSaved', { code: err.code || err.name }), detail: this.file };
    }
  }

  // For the snapshot: the hits without their message times, and whether
  // the estimate is paused (the file could not be read).
  view() {
    return {
      paused: Boolean(this.readProblem),
      hits: this.hits.map((h) => ({ at: h.at, plan: h.plan, window: h.window, tokens: h.tokens })),
    };
  }

  problems() {
    return [this.readProblem, this.saveProblem].filter(Boolean);
  }
}

module.exports = { hitWindow, LimitBook, GRACE_MS, isPlan };
