'use strict';

// Limit hits: each time Claude Code wrote into a transcript that a plan
// limit was reached, kept with the plan picked, its window (from the
// limit's own name: the session limit is the 5 hours, the weekly limit the
// week) and the tokens used in that window just before (the `total`
// measure, see renderer/plans.js). The board learns roughly where the
// picked plan's limit lies from them (estimate in renderer/plans.js). They
// live in the app data folder (usage-limits.json), never under ~/.claude,
// written whole through a flushed temp file and a rename, and a file that
// cannot be read is never written over. Hits that cannot be recorded yet
// wait there too, with what they wait for.

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
  // Names no limit ("You've hit your limit", "… your usage limit"): the
  // window is told by how far off the reset is, and with no reset it is
  // not counted (said).
  ['unnamed', /hit your (?:usage )?limit/i, 'by-reset'],
];

// ---- reset times -----------------------------------------------------------
// Claude Code writes when a limit lifts in the time zone of the computer it
// ran on, naming that zone in brackets: "Oct 9, 10am (Europe/London)" more
// than a day ahead ("Oct 9, 2027, 10am" in another year), "10am (…)" or
// "10:30pm (…)" within the day. Older versions wrote "2pm" with no zone (the
// computer's own) or "limit reached|<epoch seconds>". Each is turned into a
// moment, so the two forms of one reset meet; a form or zone that cannot be
// read gives none.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET = /\breset(?:s| at| will be)?\s+(?:at\s+)?([^·∙|\n]+?)\s*(?:[·∙|.]\s|[·∙|]|$)/i;
const WHEN = /^(?:([a-z]{3})[a-z]* (\d{1,2})(?:,? (\d{4}))?(?:,| at) )?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?$/i;

const formats = new Map();
// The zone's wall clock at `ms`: { y, mo, d, h, mi } (month from 0), or
// null for a zone this Node cannot read.
function wallClock(ms, zone) {
  let f = formats.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      f = null; // an unknown zone: no moment, and the reply rule joins its messages
    }
    formats.set(zone, f);
  }
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute };
}

// The moment a wall-clock time in `zone` is (summer time included).
function momentOf(y, mo, d, h, mi, zone) {
  const want = Date.UTC(y, mo, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i += 1) {
    const w = wallClock(guess, zone);
    if (!w) return null;
    const off = Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - guess;
    guess = want - off;
  }
  return guess;
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The moment a message written at `ts` says its limit resets, or null.
function resetMoment(text, ts, zone = localZone()) {
  const t = String(text ?? '');
  const epoch = /limit reached\|(\d{9,11})\b/i.exec(t);
  if (epoch) return Number(epoch[1]) * 1000;
  const r = RESET.exec(t);
  const m = r && WHEN.exec(r[1].replace(/[.\s]+$/, '').trim());
  if (!m) return null;
  const [, mon, day, year, hour, min, ap, named] = m;
  const z = named ? named.trim() : zone;
  const h = (Number(hour) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  const mi = Number(min ?? 0);
  if (Number(hour) > 12 || mi > 59) return null;
  const now = wallClock(ts, z);
  if (!now) return null;
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase());
    if (mo < 0) return null;
    if (year) return momentOf(Number(year), mo, Number(day), h, mi, z);
    const at = momentOf(now.y, mo, Number(day), h, mi, z);
    // A date that has passed this year is next year's (written in late December).
    return at !== null && at < ts - 12 * 3_600_000 ? momentOf(now.y + 1, mo, Number(day), h, mi, z) : at;
  }
  // A time alone is the next such time after the message.
  const today = momentOf(now.y, now.mo, now.d, h, mi, z);
  return today !== null && today <= ts ? momentOf(now.y, now.mo, now.d + 1, h, mi, z) : today;
}

// { shape, window, resetAt }: window is '5h' or 'week' for a hit, null for
// any other limit message (and for a message naming no limit and no reset
// that can be read); null when the message is about no limit. `ts` is when
// the message was written, which a reset time is counted from.
function limitMessage(text, ts = Date.now(), zone = localZone()) {
  const t = String(text ?? '');
  if (!/limit|budget|usage|resets?\b/i.test(t)) return null;
  for (const [shape, pattern, named] of SHAPES) {
    if (!pattern.test(t)) continue;
    if (!named) return { shape, window: null, resetAt: null };
    const resetAt = resetMoment(t, ts, zone);
    if (named !== 'by-reset') return { shape, window: named, resetAt };
    // The 5-hour window resets within 5 hours; the week's later.
    const window = resetAt === null ? null : resetAt - ts <= WINDOW_MS['5h'] + SAME_RESET_MS ? '5h' : 'week';
    return { shape, window, resetAt };
  }
  return /limit/i.test(t) ? { shape: 'other-limit', window: null, resetAt: null } : null;
}

// '5h', 'week', or null when the message is not a limit hit.
const hitWindow = (text, ts, zone) => limitMessage(text, ts, zone)?.window ?? null;

// While a limit holds, every new prompt brings the same message again and
// nothing is answered. Messages of one window whose resets are the same
// moment are one hit, whatever their session or plan. When a reset cannot
// be read, a message of the same window and plan within that window's
// length is the same hit when no reply came between them, in time order;
// replies finishing just after a hit (sent before it) are allowed for.
const GRACE_MS = 2 * 60_000;
const SAME_RESET_MS = 5 * 60_000;
const WEEK_MS = WINDOW_MS.week;

const FORMAT = 1;

// What a hit can wait for, in the order it is said: the file to read,
// a pass that read every folder, WSL to run (its use was read before), and
// a plan to be picked.
const WAITS = ['file', 'pass', 'wsl', 'plan'];

const finite = Number.isFinite;
const resetOk = (r) => r === undefined || r === null || finite(r);

function readHit(h) {
  const ok = h && typeof h === 'object' && finite(h.at) && Object.hasOwn(WINDOW_MS, h.window) && isPlan(h.plan)
    && finite(h.tokens) && h.tokens >= 0 && Array.isArray(h.seen) && h.seen.length > 0 && h.seen.every(finite) && resetOk(h.resetAt);
  if (!ok) throw new TypeError('a hit not in the shape this version reads');
  return h;
}
function readWaiting(w) {
  const ok = w && typeof w === 'object' && finite(w.at) && Object.hasOwn(WINDOW_MS, w.window) && isPlan(w.plan) && resetOk(w.resetAt)
    && (w.why === null || WAITS.includes(w.why));
  if (!ok) throw new TypeError('a waiting hit not in the shape this version reads');
  return w;
}
function readExpired(e) {
  const ok = e && typeof e === 'object' && finite(e.at) && finite(e.gone) && WAITS.includes(e.why);
  if (!ok) throw new TypeError('an expired hit not in the shape this version reads');
  return e;
}

const keyOf = (window, ts) => `${window}@${ts}`;

class LimitBook {
  constructor({ file }) {
    this.file = file;
    this.tmp = `${file}.tmp`;
    this.hits = [];
    this.waiting = new Map(); // key -> { at, window, resetAt, plan (in force when seen), why }
    this.expired = []; // [{ at, window, why, gone }]: left the scanner's 7 days waiting, said for 7 days
    this.wslSeen = false; // WSL transcripts were read in some run: hold hits while none are
    this.kept = {}; // the file's other fields, written back as they came
    this.read = false; // nothing is written before the file was read in this run
    this.stamp = null; // the file as last read or written: re-read when it changed
    this.readProblem = null;
    this.saveProblem = null;
    this.leftProblem = null;
    this.leftChecked = false;
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
      // The user removed the file: no hits. With no file yet, anything held
      // is waiting for its first save.
      if (this.stamp !== null) Object.assign(this, { hits: [], waiting: new Map(), expired: [], wslSeen: false, kept: {} });
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
      const waiting = new Map((data.waiting ?? []).map(readWaiting).map((w) => [keyOf(w.window, w.at), w]));
      const expired = (data.expired ?? []).map(readExpired);
      if (data.wslSeen !== undefined && typeof data.wslSeen !== 'boolean') throw new TypeError('wslSeen');
      const kept = { ...data };
      for (const k of ['hits', 'waiting', 'expired', 'wslSeen', 'format']) delete kept[k];
      Object.assign(this, { hits, waiting, expired, wslSeen: data.wslSeen === true, kept });
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

  countedKeys() {
    return new Set(this.hits.flatMap((h) => h.seen.map((ts) => keyOf(h.window, ts))));
  }

  // Each pass's hits ([{ ts, window, resetAt }], the scanner's 7 days) join
  // the waiting list, with the plan in force when first seen. They are
  // recorded from a pass whose token totals are whole (`ready`: after the
  // first WSL check, every folder listed and every file read), with WSL's
  // transcripts read when they were read before (`wslReading`), and the
  // file read; each under the plan it was seen with, or, seen while no plan
  // was picked, the plan picked now. A waiting hit older than 7 days can no
  // longer be measured: it is dropped and said with what it waited for.
  // Returns how many new hits were recorded.
  offer(found, { plan, ready, wslReading, measure, now = Date.now() }) {
    const readable = this.load();
    let changed = false;
    if (readable && ready && wslReading && !this.wslSeen) {
      this.wslSeen = true;
      changed = true;
    }
    const counted = this.countedKeys();
    for (const [key, w] of this.waiting) {
      if (counted.has(key)) this.waiting.delete(key);
      else if (now - w.at > WEEK_MS) {
        this.waiting.delete(key);
        this.expired.push({ at: w.at, window: w.window, why: w.why ?? 'pass', gone: now });
      } else continue;
      changed = true;
    }
    for (const f of found) {
      const key = keyOf(f.window, f.ts);
      if (counted.has(key) || this.waiting.has(key) || now - f.ts > WEEK_MS) continue;
      this.waiting.set(key, { at: f.ts, window: f.window, resetAt: f.resetAt ?? null, plan: isPlan(plan) ? plan : 'none', why: null });
      changed = true;
    }
    const planOf = (w) => (w.plan !== 'none' ? w.plan : isPlan(plan) ? plan : 'none');
    const reason = !readable ? 'file' : !ready ? 'pass' : this.wslSeen && !wslReading ? 'wsl' : null;
    let added = 0;
    if (!reason) {
      const due = [...this.waiting].filter(([, w]) => planOf(w) !== 'none');
      if (due.length) {
        added = this.take(due.map(([, w]) => ({ ts: w.at, window: w.window, resetAt: w.resetAt, plan: planOf(w) })), measure);
        for (const [key] of due) this.waiting.delete(key);
        changed = true;
      }
    }
    for (const w of this.waiting.values()) {
      const why = planOf(w) === 'none' ? 'plan' : reason;
      if (w.why !== why) {
        w.why = why;
        changed = true;
      }
    }
    const kept = this.expired.filter((e) => now - e.gone <= WEEK_MS);
    if (kept.length !== this.expired.length) {
      this.expired = kept;
      changed = true;
    }
    if (readable && (changed || this.saveProblem)) this.save();
    return added;
  }

  // Records `items` ([{ ts, window, resetAt, plan }]) not counted before.
  // `measure` gives the tokens used in [from, to) and whether any reply came
  // in (from, to): the UsageScanner. Returns how many were new.
  take(items, measure) {
    const counted = this.countedKeys();
    let added = 0;
    // No reply between a message and the hit's nearest message, in time order.
    const quiet = (h, ts) => {
      const first = Math.min(...h.seen);
      const last = Math.max(...h.seen);
      if (ts >= last) return !measure.repliedBetween(last + GRACE_MS, ts);
      if (ts <= first) return !measure.repliedBetween(ts + GRACE_MS, first);
      return true; // inside the run of messages already taken as one hit
    };
    for (const f of [...items].sort((a, b) => a.ts - b.ts)) {
      if (!isPlan(f.plan) || f.plan === 'none') throw new TypeError(`not a plan to record under: ${f.plan}`);
      const key = keyOf(f.window, f.ts);
      if (counted.has(key)) continue;
      counted.add(key);
      const span = WINDOW_MS[f.window];
      const both = (h) => finite(h.resetAt) && finite(f.resetAt);
      const same = this.hits.find((h) => h.window === f.window && (both(h)
        ? Math.abs(h.resetAt - f.resetAt) <= SAME_RESET_MS
        : Math.abs(f.ts - h.at) < span && h.plan === f.plan && quiet(h, f.ts)));
      if (same) {
        same.seen.push(f.ts);
        // An earlier message of the hit, found later: the hit starts there.
        if (f.ts < same.at) Object.assign(same, { at: f.ts, tokens: measure.tokensBetween(f.ts - span, f.ts) });
        if (!finite(same.resetAt) && finite(f.resetAt)) same.resetAt = f.resetAt;
      } else {
        this.hits.push({ at: f.ts, plan: f.plan, window: f.window, tokens: measure.tokensBetween(f.ts - span, f.ts), seen: [f.ts], ...(finite(f.resetAt) ? { resetAt: f.resetAt } : {}) });
        added += 1;
      }
    }
    return added;
  }

  save() {
    const data = {
      ...this.kept, format: FORMAT, wslSeen: this.wslSeen, hits: this.hits, waiting: [...this.waiting.values()], expired: this.expired,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(this.tmp, 'w');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
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
  // estimate is paused (the file could not be read), how many hits wait for
  // each thing, and how many expired waiting for a plan (said on the card).
  view() {
    const waiting = Object.fromEntries(WAITS.map((why) => [why, 0]));
    for (const w of this.waiting.values()) if (w.why) waiting[w.why] += 1;
    return {
      paused: Boolean(this.readProblem),
      hits: this.hits.map((h) => ({ at: h.at, plan: h.plan, window: h.window, tokens: h.tokens })),
      waiting,
      expiredPlan: this.expired.filter((e) => e.why === 'plan').length,
    };
  }

  // Needs attention: the file's troubles, and hits that expired waiting for
  // anything but a plan (that one is the card's), each with its reason.
  problems() {
    const out = [this.readProblem, this.saveProblem, this.leftProblem].filter(Boolean);
    for (const why of WAITS.filter((w) => w !== 'plan')) {
      const n = this.expired.filter((e) => e.why === why).length;
      if (n) out.push({ label: en(`said.limits.expired.${why}`, { n }), detail: '' });
    }
    return out;
  }
}

module.exports = { limitMessage, hitWindow, resetMoment, LimitBook, GRACE_MS, SAME_RESET_MS, SHAPES, WAITS, isPlan };
