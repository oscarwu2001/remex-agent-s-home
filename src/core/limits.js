'use strict';

// Limit hits: each time Claude Code wrote into a transcript that a plan
// limit was reached, kept with the plan picked then, its window (from the
// limit's own name: the session limit is the 5 hours, the weekly limit the
// week) and the tokens used in that window just before (the `total`
// measure, see renderer/plans.js). The board learns roughly where the
// picked plan's limit lies from them (estimate in renderer/plans.js). They
// live in the app data folder (usage-limits.json), never under ~/.claude,
// written whole through a flushed temp file and a rename, and a file that
// cannot be read is never written over.

const fs = require('fs');
const path = require('path');
const { en } = require('./i18n');
const { WINDOW_MS, isPlan } = require('../../renderer/plans.js');

// The shapes of Claude Code's limit messages, as [shape, pattern, window];
// the first that matches names the message. Claude Code 2.1 writes "You've
// hit your <limit name> · resets <time>"; older versions wrote "5-hour
// limit reached ∙ resets <time>", "Weekly limit reached ∙ …" or "Claude
// usage limit reached. Your limit will reset at <time>". Only the session
// and weekly limits, which count every model, are hits. Not hits: the
// per-model limits (Opus, Sonnet), a spend cap or a shared budget (money,
// not use; a spend-cap message also says when the weekly limit resets),
// usage credits, fast mode, the context limit, a fallback to another model,
// a warning that a limit is near and an API rate limit (requests a minute).
const SHAPES = [
  ['spend-cap', /monthly spend limit|spend (?:limit|cap)/i, null],
  ['shared-budget', /shared budget|\bbudget\b/i, null],
  ['credits', /usage credit|extra usage|overage/i, null],
  ['fast-mode', /fast mode/i, null],
  ['context', /context (?:limit|window)|prompt is too long/i, null],
  ['fallback', /now using|switch(?:ed|ing)? to (?:sonnet|haiku|another model)|fall(?:ing)? ?back/i, null],
  ['approaching', /approaching|close to your/i, null],
  ['rate-limit', /rate limit/i, null],
  ['model', /hit your (?:opus|sonnet|haiku|fable) limit|(?:opus|sonnet|haiku) (?:weekly )?limit reached/i, null],
  ['session', /hit your session limit/i, '5h'],
  ['weekly', /hit your weekly limit/i, 'week'],
  ['old-weekly', /\bweekly limit reached/i, 'week'],
  ['old-5-hour', /5-hour limit reached|usage limit reached|your limit will reset/i, '5h'],
  // Names no limit: which window it was cannot be told.
  ['unnamed', /hit your limit/i, null],
];

// When the limit lifts, as the message says it ("3pm (Europe/London)", or
// the old "limit reached|<epoch seconds>"), lower-cased: messages of one
// limit event, in any session, say the same.
function resetOf(text) {
  const epoch = /limit reached\|(\d{9,11})\b/i.exec(text);
  if (epoch) return `@${epoch[1]}`;
  const m = /\breset(?:s| at| will be)?\s+(?:at\s+)?([^·∙|\n]+?)\s*(?:[·∙|.]\s|[·∙|]|$)/i.exec(text);
  return m ? m[1].replace(/[.\s]+$/, '').toLowerCase() : null;
}

// { shape, window, reset }: window is '5h' or 'week' for a hit, null for
// any other limit message; null when the message is about no limit.
function limitMessage(text) {
  const t = String(text ?? '');
  if (!/limit|budget|usage|resets?\b/i.test(t)) return null;
  for (const [shape, pattern, window] of SHAPES) {
    if (pattern.test(t)) return { shape, window, reset: window ? resetOf(t) : null };
  }
  return /limit/i.test(t) ? { shape: 'other-limit', window: null, reset: null } : null;
}

// '5h', 'week', or null when the message is not a limit hit.
const hitWindow = (text) => limitMessage(text)?.window ?? null;

// While a limit holds, every new prompt brings the same message again and
// nothing is answered. Messages of one window saying the same reset time,
// within that window's length, are one hit whatever their session or
// plan. Without a reset time, a message of the same window and plan within
// that length is the same hit when no reply came between them, in time
// order; replies finishing just after a hit (sent before it) are allowed for.
const GRACE_MS = 2 * 60_000;

const FORMAT = 1;

function readHit(h) {
  const ok = h && typeof h === 'object' && Number.isFinite(h.at) && Object.hasOwn(WINDOW_MS, h.window) && isPlan(h.plan)
    && Number.isFinite(h.tokens) && h.tokens >= 0 && Array.isArray(h.seen) && h.seen.length > 0 && h.seen.every(Number.isFinite)
    && (h.reset === undefined || h.reset === null || typeof h.reset === 'string');
  if (!ok) throw new TypeError('a hit not in the shape this version reads');
  return h;
}

const keyOf = (window, ts) => `${window}@${ts}`;

class LimitBook {
  constructor({ file }) {
    this.file = file;
    this.tmp = `${file}.tmp`;
    this.hits = [];
    this.kept = {}; // the file's other fields, written back as they came
    this.read = false; // nothing is written before the file was read in this run
    this.stamp = null; // the file as last read or written: re-read when it changed
    this.readProblem = null;
    this.saveProblem = null;
    this.leftProblem = null;
    this.leftChecked = false;
    this.waiting = new Map(); // hits found but not taken yet: key -> ts
    this.waitingFor = null; // 'plan' | 'pass' | 'file'
    this.expired = 0; // hits that left the scanner's 7 days before they could be taken
  }

  // Reads the file when it was not read yet or changed since; true when what
  // is held is the file's. A file that cannot be read pauses the estimate
  // and is left as it is.
  load() {
    this.removeLeftover();
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

  // A temp file a crash or a failed save left behind, once a run: removed,
  // or said when it cannot be (the next save that works writes over it).
  removeLeftover() {
    if (this.leftChecked) return;
    this.leftChecked = true;
    try {
      fs.rmSync(this.tmp, { force: true });
    } catch (err) {
      this.leftProblem = { label: en('said.limits.tmpLeft', { code: err.code || err.name }), detail: this.tmp };
    }
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

  // Each pass's hits ([{ ts, window, reset }], the scanner's 7 days). They
  // are taken only from a pass whose token totals are whole (`ready`: after
  // the first WSL check, every folder listed and every file read), with a
  // plan picked and the file read; until then they wait in the scanner, and
  // those that leave its 7 days meanwhile are counted as expired. Returns
  // how many new hits were recorded.
  offer(found, { plan, ready, measure }) {
    const counted = this.countedKeys();
    for (const [key] of this.waiting) {
      if (!counted.has(key) && !found.some((f) => keyOf(f.window, f.ts) === key)) this.expired += 1;
    }
    let added = 0;
    const readable = this.load();
    if (!isPlan(plan) || plan === 'none') this.waitingFor = 'plan';
    else if (!ready) this.waitingFor = 'pass';
    else if (!readable) this.waitingFor = 'file';
    else {
      this.waitingFor = null;
      added = this.take(found, plan, measure);
    }
    const now = this.countedKeys();
    this.waiting = new Map(found.filter((f) => !now.has(keyOf(f.window, f.ts))).map((f) => [keyOf(f.window, f.ts), f.ts]));
    if (!this.waiting.size) this.waitingFor = null;
    return added;
  }

  countedKeys() {
    return new Set(this.hits.flatMap((h) => h.seen.map((ts) => keyOf(h.window, ts))));
  }

  // Records the hits in `found` not counted before, under `plan`. `measure`
  // gives the tokens used in [from, to) and whether any reply came in
  // (from, to): the UsageScanner. Returns how many were new.
  take(found, plan, measure) {
    if (!isPlan(plan)) throw new TypeError(`not a plan: ${plan}`);
    if (!this.load()) return 0;
    const counted = this.countedKeys();
    let added = 0;
    let changed = false;
    // No reply between a message and the hit's nearest message, in time order.
    const quiet = (h, ts) => {
      const first = Math.min(...h.seen);
      const last = Math.max(...h.seen);
      if (ts >= last) return !measure.repliedBetween(last + GRACE_MS, ts);
      if (ts <= first) return !measure.repliedBetween(ts + GRACE_MS, first);
      return true; // inside the run of messages already taken as one hit
    };
    for (const f of [...found].sort((a, b) => a.ts - b.ts)) {
      const key = keyOf(f.window, f.ts);
      if (counted.has(key)) continue;
      counted.add(key);
      const span = WINDOW_MS[f.window];
      const near = (h) => h.window === f.window && Math.abs(f.ts - h.at) < span;
      const same = f.reset
        ? this.hits.find((h) => near(h) && h.reset === f.reset)
        : this.hits.find((h) => near(h) && h.plan === plan && quiet(h, f.ts));
      if (same) {
        same.seen.push(f.ts);
        // An earlier message of the hit, found later: the hit starts there.
        if (f.ts < same.at) Object.assign(same, { at: f.ts, tokens: measure.tokensBetween(f.ts - span, f.ts) });
      } else {
        this.hits.push({ at: f.ts, plan, window: f.window, tokens: measure.tokensBetween(f.ts - span, f.ts), seen: [f.ts], ...(f.reset ? { reset: f.reset } : {}) });
        added += 1;
      }
      changed = true;
    }
    if (changed || this.saveProblem) this.save();
    return added;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(this.tmp, 'w');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ ...this.kept, format: FORMAT, hits: this.hits }, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(this.tmp, this.file);
    } catch (err) {
      // The hits stay counted here until the app quits; each pass tries again.
      this.saveProblem = { label: en('said.limits.notSaved', { code: err.code || err.name }), detail: this.file };
      return;
    }
    this.saveProblem = null;
    this.leftProblem = null; // a temp file left before was written over and renamed
    try {
      const st = fs.statSync(this.file);
      this.stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // Saved; with no stamp the next pass reads the file back, which holds the same hits.
      this.stamp = null;
    }
  }

  // For the snapshot: the hits without their message times, whether the
  // estimate is paused (the file could not be read), how many hits wait and
  // for what, and how many expired waiting.
  view() {
    return {
      paused: Boolean(this.readProblem),
      hits: this.hits.map((h) => ({ at: h.at, plan: h.plan, window: h.window, tokens: h.tokens })),
      waiting: this.waiting.size,
      waitingFor: this.waitingFor,
      expired: this.expired,
    };
  }

  problems() {
    const out = [this.readProblem, this.saveProblem, this.leftProblem].filter(Boolean);
    if (this.expired) out.push({ label: en('said.limits.expired', { n: this.expired }), detail: '' });
    return out;
  }
}

module.exports = { limitMessage, hitWindow, resetOf, LimitBook, GRACE_MS, SHAPES, isPlan };
