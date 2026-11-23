'use strict';

// Limit hits (src/core/limits.js) read by the usage scanner from invented
// transcripts, kept in a hits file, and the estimate learned from them
// (renderer/plans.js). The messages are invented, in the shapes Claude Code
// writes them; no real line is copied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { T0, say } = require('./helpers');
const { UsageScanner } = require('../src/core/usage');
const { LimitBook, limitMessage, hitWindow } = require('../src/core/limits');
const { en } = require('../src/core/i18n');

const plans = () => import('../renderer/plans.js');

const MIN = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
// A reply of `tokens` tokens (all fresh input) at `s` seconds after T0.
const reply = (s, id, tokens, extra) => {
  const e = say(s, 'ok', 'end_turn', extra);
  e.message = { ...e.message, id, model: 'claude-sonnet-5', usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return e;
};
const SESSION = (reset, zone = 'Europe/London') => `You've hit your session limit · resets ${reset} (${zone})`;
const limit = (s, text = SESSION('2pm'), extra) => ({ ...say(s, text, 'stop_sequence', extra), isApiErrorMessage: true });
// The old shape with no reset time: only the reply rule can join its repeats.
const BARE = 'Claude usage limit reached.';
const jsonl = (...entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const at = (s) => T0 + s * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  return { dir, root, file: path.join(root, 'proj', 'a.jsonl'), hitsFile: path.join(dir, 'data', 'usage-limits.json') };
}

// One pass, as the main process makes it: scan, then offer the hits found.
async function pass(scanner, book, plan, nowS, { ready = true, wslReading = false } = {}) {
  await scanner.scan(at(nowS));
  return book.offer(scanner.limitHits(), { plan, ready: ready && scanner.passClean, wslReading, measure: scanner, now: at(nowS) });
}
const waits = (o = {}) => ({ file: 0, pass: 0, wsl: 0, plan: 0, ...o });

// Two session-limit hits: 6000 + 4000 tokens before the first, 8000 + 6000
// before the second (the first's replies are more than 5 hours before it).
const twoHits = () => jsonl(
  reply(1 * HOUR, 'r1', 6000), reply(2 * HOUR, 'r2', 4000), limit(3 * HOUR, SESSION('6am')),
  reply(10 * HOUR, 'r3', 8000), reply(11 * HOUR, 'r4', 6000), limit(12 * HOUR, SESSION('3pm')),
  reply(14 * HOUR, 'r5', 3000),
);

test('limit shapes: the window comes from the limit\'s own name; per-model limits, spend caps and the rest are not hits', () => {
  const shape = (t) => { const m = limitMessage(t); return m && [m.shape, m.window]; };
  // Claude Code 2.1.
  assert.deepEqual(shape(SESSION('4pm')), ['session', '5h']);
  assert.deepEqual(shape('You\'ve hit your weekly limit · resets Oct 9 at 10am · progress saved'), ['weekly', 'week']);
  assert.deepEqual(shape('You\'ve hit your Opus limit · resets Oct 9 at 10am'), ['model', null]);
  assert.deepEqual(shape('You\'ve hit your Sonnet limit · resets Oct 9 at 10am'), ['model', null]);
  // A spend cap says when the weekly limit resets: still not a hit.
  assert.deepEqual(shape('You\'ve hit your monthly spend limit · your weekly limit resets Oct 9 at 10am'), ['spend-cap', null]);
  assert.deepEqual(shape('You\'ve hit your team\'s shared budget. Ask your admin to raise it'), ['shared-budget', null]);
  assert.deepEqual(shape('Now using usage credits · Your session limit resets 4pm'), ['credits', null]);
  // Names no limit and gives no reset: which window cannot be told.
  assert.deepEqual(shape('You\'ve hit your limit'), ['unnamed', null]);
  // Older versions.
  assert.deepEqual(shape('5-hour limit reached ∙ resets 2pm'), ['old-5-hour', '5h']);
  assert.deepEqual(shape('Claude usage limit reached. Your limit will reset at 5pm.'), ['old-5-hour', '5h']);
  assert.deepEqual(shape('Weekly limit reached ∙ resets Mon 9am'), ['old-weekly', 'week']);
  assert.deepEqual(shape('Opus weekly limit reached ∙ resets Mon 9am'), ['model', null]);
  // Not limits of the plan.
  for (const t of ['Approaching usage limit · resets at 2pm', 'API Error: Rate limit reached', 'Fast mode limit reached, switching back',
    'Context limit reached: compact to go on', 'Switched to Sonnet: Opus is busy']) assert.equal(hitWindow(t), null, t);
  assert.equal(limitMessage('Something else went wrong'), null);
  // One limit event says one reset time, in any session.
  assert.equal(limitMessage(SESSION('4pm'), T0).resetAt, limitMessage(`${SESSION('4pm')} · progress saved`, T0).resetAt);
  assert.equal(limitMessage(SESSION('4pm'), T0).resetAt, Date.parse('2026-01-01T16:00:00Z'));
  assert.equal(limitMessage('Claude AI usage limit reached|1760000000', T0).resetAt, 1_760_000_000_000);
});

test('the scanner takes session and weekly hits and leaves spend caps and per-model limits', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(limit(1 * HOUR), limit(2 * HOUR, 'You\'ve hit your weekly limit · resets Mon 9am'),
    limit(3 * HOUR, 'You\'ve hit your monthly spend limit · your weekly limit resets Mon 9am'), limit(4 * HOUR, 'You\'ve hit your Opus limit · resets Mon 9am')));
  const scanner = new UsageScanner({ roots: [s.root] });
  await scanner.scan(at(5 * HOUR));
  assert.deepEqual(scanner.limitHits().map((h) => [h.ts, h.window]), [[at(1 * HOUR), '5h'], [at(2 * HOUR), 'week']]);
  assert.match(scanner.summary(at(5 * HOUR)).limitNotice.text, /Opus limit/, 'the newest limit message is still passed on');
});

test('two hits give an estimate from the tokens before each; one hit gives none yet', async () => {
  const { estimate } = await plans();
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 6000), reply(2 * HOUR, 'r2', 4000), limit(3 * HOUR, SESSION('6am'))));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 3 * HOUR + MIN), 1);
  assert.deepEqual(book.view().hits, [{ at: at(3 * HOUR), plan: 'pro', window: '5h', tokens: 10_000 }]);
  assert.deepEqual(estimate(book.view().hits, 'pro', scanner.summary(at(3 * HOUR + MIN)))['5h'], { hits: 1, zero: 0 });

  fs.writeFileSync(s.file, twoHits());
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 1);
  assert.deepEqual(book.view().hits.map((h) => h.tokens), [10_000, 14_000]);
  // Learned level: 12000 (between the two). The last 5 hours (12 h to 17 h) used 3000.
  const e = estimate(book.view().hits, 'pro', scanner.summary(at(17 * HOUR)));
  assert.deepEqual(e['5h'], { hits: 2, zero: 0, basis: 2, level: 12_000, used: 3000, pct: 25, over: false });
  assert.deepEqual(e.week, { hits: 0, zero: 0 });
});

test('the same limit message read twice counts once: on a rescan, from a copied transcript, and by a new scanner after a restart', async () => {
  const s = setup();
  fs.writeFileSync(s.file, twoHits());
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 2);
  fs.appendFileSync(s.file, jsonl(reply(15 * HOUR, 'r6', 100)));
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 0, 'a rescan');
  // A resumed session's new file repeats the earlier lines.
  fs.writeFileSync(path.join(s.root, 'proj', 'b.jsonl'), twoHits());
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 0, 'a copy');

  const again = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), again, 'pro', 18 * HOUR), 0, 'a restart');
  assert.equal(again.view().hits.length, 2);
  // Read back after a restart under another plan: still counted once, as the plan it was.
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), new LimitBook({ file: s.hitsFile }), 'max5', 18 * HOUR), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits.map((h) => h.plan), ['pro', 'pro']);
});

test('one limit event in two sessions is one hit: the same reset time, though a reply landed in between', async () => {
  const SIX = '5-hour limit reached ∙ resets 6pm';
  const s = setup();
  // Session a hits the limit; session b's reply, sent before, lands 3 minutes later; a tries again.
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 5000), limit(3 * HOUR, SIX), limit(3 * HOUR + 10 * MIN, SIX)));
  fs.writeFileSync(path.join(s.root, 'proj', 'b.jsonl'), jsonl(reply(3 * HOUR + 3 * MIN, 'b1', 900, { sessionId: 'sess-2' }),
    limit(3 * HOUR + 12 * MIN, SIX, { sessionId: 'sess-2' })));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 4 * HOUR), 1);
  assert.deepEqual(book.view().hits.map((h) => [h.at, h.tokens]), [[at(3 * HOUR), 5000]]);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits[0].seen.length, 3);
});

test('with no reset time, a message repeated while the limit holds is the same hit; one after replies again is a new hit', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 5000), limit(2 * HOUR, BARE), limit(2 * HOUR + 20 * MIN, BARE), limit(2 * HOUR + 50 * MIN, BARE),
    // The limit lifted: replies, then a new hit within 5 hours of the first.
    reply(4 * HOUR, 'r2', 7000), limit(5 * HOUR, BARE)));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 6 * HOUR), 2);
  // 1 h to 5 h before the second hit: both replies.
  assert.deepEqual(book.view().hits.map((h) => [h.at, h.tokens]), [[at(2 * HOUR), 5000], [at(5 * HOUR), 12_000]]);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits[0].seen.length, 3);
});

test('an earlier message found on a later pass is read in time order: a new hit when replies came between, else the hit starts there', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(4 * HOUR, 'r1', 3000), limit(5 * HOUR, BARE)));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 6 * HOUR), 1);
  // Another folder turns up with an earlier hit, and replies after it.
  const late = path.join(s.dir, 'late');
  fs.mkdirSync(path.join(late, 'p'), { recursive: true });
  fs.writeFileSync(path.join(late, 'p', 'c.jsonl'), jsonl(reply(1 * HOUR, 'c1', 2000), limit(2 * HOUR, BARE), reply(3 * HOUR, 'c2', 1000)));
  scanner.setRoots([s.root, late]);
  assert.equal(await pass(scanner, book, 'pro', 6 * HOUR), 1, 'a reply came between: two hits');
  assert.deepEqual(book.view().hits.map((h) => h.at).sort(), [at(2 * HOUR), at(5 * HOUR)]);

  // With nothing answered between them, the earlier message is where the hit starts.
  const t = setup();
  fs.writeFileSync(t.file, jsonl(reply(1 * HOUR, 'r1', 3000), limit(4 * HOUR, BARE)));
  const sc = new UsageScanner({ roots: [t.root] });
  const b = new LimitBook({ file: t.hitsFile });
  await pass(sc, b, 'pro', 5 * HOUR);
  fs.writeFileSync(path.join(t.root, 'proj', 'd.jsonl'), jsonl(reply(30 * MIN, 'd1', 500), limit(3 * HOUR, BARE)));
  assert.equal(await pass(sc, b, 'pro', 5 * HOUR), 0);
  assert.deepEqual(b.view().hits.map((h) => [h.at, h.tokens]), [[at(3 * HOUR), 3500]]);
});

test('hits wait for a whole pass: none from a pass before the WSL check, nor from one that could not read a file', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, '5-hour limit reached ∙ resets 2pm')));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  // The first pass runs before the WSL homes are known.
  assert.equal(await pass(scanner, book, 'pro', 4 * HOUR, { ready: false }), 0, 'nothing taken before the WSL check');
  assert.deepEqual(book.view(), { paused: false, hits: [], waiting: waits({ pass: 1 }), expiredPlan: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits, [], 'no hit written, only what waits');
  // The WSL home turns up, with use before the hit, and a folder that cannot be listed.
  const wslHome = path.join(s.dir, 'wsl');
  fs.mkdirSync(path.join(wslHome, 'p'), { recursive: true });
  fs.writeFileSync(path.join(wslHome, 'p', 'w.jsonl'), jsonl(reply(2 * HOUR, 'w1', 2500)));
  const unlisted = path.join(s.dir, 'not-a-folder');
  fs.writeFileSync(unlisted, 'a file where a projects folder should be');
  scanner.setRoots([s.root, wslHome, unlisted]);
  assert.equal(await pass(scanner, book, 'pro', 4 * HOUR), 0);
  assert.equal(scanner.passClean, false);
  assert.deepEqual(book.view().waiting, waits({ pass: 1 }));
  // Read in full: the hit counts both homes' use.
  scanner.setRoots([s.root, wslHome]);
  assert.equal(await pass(scanner, book, 'pro', 4 * HOUR), 1);
  assert.equal(scanner.passClean, true);
  assert.deepEqual(book.view().hits.map((h) => h.tokens), [6500]);
  assert.deepEqual(book.view().waiting, waits());
});

test('hits found while no plan is picked wait, and are filed under the plan picked; those that pass 7 days waiting are said', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR)));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'none', 4 * HOUR), 0);
  assert.deepEqual(book.view(), { paused: false, hits: [], waiting: waits({ plan: 1 }), expiredPlan: 0 });
  assert.equal(await pass(scanner, book, 'max5', 4 * HOUR), 1);
  assert.deepEqual(book.view().hits.map((h) => h.plan), ['max5']);

  const t = setup();
  fs.writeFileSync(t.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR)));
  const sc = new UsageScanner({ roots: [t.root] });
  const waiting = new LimitBook({ file: t.hitsFile });
  await pass(sc, waiting, 'none', 4 * HOUR);
  await pass(sc, waiting, 'none', 8 * DAY);
  // Expired waiting for a plan: the card's line, not Needs attention.
  assert.deepEqual(waiting.view(), { paused: false, hits: [], waiting: waits(), expiredPlan: 1 });
  assert.deepEqual(waiting.problems(), []);
});

test('a plan change starts a new count; the old plan\'s hits are kept', async () => {
  const { estimate } = await plans();
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 6000), limit(2 * HOUR, SESSION('6am'))));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  await pass(scanner, book, 'pro', 3 * HOUR);
  fs.appendFileSync(s.file, jsonl(reply(8 * HOUR, 'r2', 9000), limit(9 * HOUR, SESSION('1pm'))));
  await pass(scanner, book, 'max5', 10 * HOUR);
  fs.appendFileSync(s.file, jsonl(reply(15 * HOUR, 'r3', 9000), limit(16 * HOUR, SESSION('8pm'))));
  await pass(scanner, book, 'max5', 17 * HOUR);
  assert.deepEqual(book.view().hits.map((h) => h.plan), ['pro', 'max5', 'max5']);
  const usage = scanner.summary(at(17 * HOUR));
  assert.deepEqual(estimate(book.view().hits, 'pro', usage)['5h'], { hits: 1, zero: 0 });
  assert.equal(estimate(book.view().hits, 'max5', usage)['5h'].basis, 2);
  assert.equal(estimate(book.view().hits, 'none', usage), null, 'no plan, no estimate');
});

test('a weekly hit goes to the weekly window, counted over the whole week before it, even at the first scan', async () => {
  const s = setup();
  // The hit is 3 days before the scan; the week before it reaches 10 days back.
  fs.writeFileSync(s.file, jsonl(reply(0, 'r1', 2000), reply(5 * DAY, 'r2', 3000), reply(6 * DAY, 'r3', 4000),
    limit(7 * DAY - HOUR, 'You\'ve hit your weekly limit · resets Mon 9am')));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'max20', 10 * DAY - HOUR), 1);
  assert.deepEqual(book.view().hits, [{ at: at(7 * DAY - HOUR), plan: 'max20', window: 'week', tokens: 9000 }]);
});

test('past the learned level the estimate says over, never a share above 100; hits with no tokens before them are counted apart', async () => {
  const { estimate } = await plans();
  const hits = [{ at: 1, plan: 'pro', window: '5h', tokens: 10_000 }, { at: 2, plan: 'pro', window: '5h', tokens: 10_000 }];
  assert.deepEqual(estimate(hits, 'pro', { last5h: { total: 13_000 }, week: { total: 13_000 } })['5h'], { hits: 2, zero: 0, basis: 2, level: 10_000, used: 13_000, pct: 130, over: true });
  assert.equal(estimate(hits, 'pro', { last5h: { total: 10_000 }, week: { total: 0 } })['5h'].over, false, 'at the level is not past it');
  const withZero = [...hits, { at: 3, plan: 'pro', window: '5h', tokens: 0 }];
  assert.deepEqual(estimate(withZero, 'pro', { last5h: { total: 5000 }, week: { total: 0 } })['5h'], { hits: 2, zero: 1, basis: 2, level: 10_000, used: 5000, pct: 50, over: false });
});

test('an unreadable hits file is said under Needs attention, left as it is, and the estimate pauses until it reads', async () => {
  const s = setup();
  fs.writeFileSync(s.file, twoHits());
  fs.mkdirSync(path.dirname(s.hitsFile), { recursive: true });
  const broken = '{"hits": [ {"at": 1, "plan": "pro"';
  fs.writeFileSync(s.hitsFile, broken);
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 0);
  assert.deepEqual(book.view(), { paused: true, hits: [], waiting: waits({ file: 2 }), expiredPlan: 0 });
  assert.deepEqual(book.problems(), [{ label: en('said.limits.notShape'), detail: s.hitsFile }]);
  assert.equal(fs.readFileSync(s.hitsFile, 'utf8'), broken, 'left as it is');

  // Not in a shape this version reads: the same.
  const odd = JSON.stringify({ hits: [{ at: 1, plan: 'pro', window: 'month', tokens: 5, seen: [1] }] });
  fs.writeFileSync(s.hitsFile, odd);
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 0);
  assert.equal(book.view().paused, true);
  assert.equal(fs.readFileSync(s.hitsFile, 'utf8'), odd);

  // Mended: the hits seen meanwhile are recorded, and the file's own hits and fields kept.
  const kept = { at: at(-DAY), plan: 'team', window: 'week', tokens: 77, seen: [at(-DAY)], note: 'mine' };
  fs.writeFileSync(s.hitsFile, JSON.stringify({ format: 1, owner: 'me', hits: [kept] }));
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 2);
  assert.deepEqual(book.problems(), []);
  assert.equal(book.view().paused, false);
  const saved = JSON.parse(fs.readFileSync(s.hitsFile, 'utf8'));
  assert.equal(saved.owner, 'me');
  assert.deepEqual(saved.hits[0], kept);
  assert.equal(saved.hits.length, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(s.hitsFile)), ['usage-limits.json'], 'no temp file left');
});

test('a hits file that cannot be opened is said with its code; one that cannot be saved keeps the hits until the app quits and says so', async () => {
  const s = setup();
  fs.writeFileSync(s.file, twoHits());
  fs.mkdirSync(s.hitsFile, { recursive: true }); // a folder where the file should be
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 17 * HOUR), 0);
  assert.equal(book.view().paused, true);
  assert.match(book.problems()[0].label, /^usage-limits\.json could not be read \(E[A-Z]+\)/);

  const t = setup();
  fs.writeFileSync(t.file, twoHits());
  fs.writeFileSync(path.join(t.dir, 'data'), 'a file where the folder should be');
  const unsaved = new LimitBook({ file: t.hitsFile });
  const scanner = new UsageScanner({ roots: [t.root] });
  assert.equal(await pass(scanner, unsaved, 'pro', 17 * HOUR), 2);
  assert.equal(unsaved.view().paused, false);
  assert.equal(unsaved.view().hits.length, 2, 'kept while unsaved');
  assert.match(unsaved.problems()[0].label, /^usage-limits\.json could not be saved \(E[A-Z]+\): the new limit hits are kept only until the app quits/);
  // Saved once it can be, with no hit counted twice.
  fs.rmSync(path.join(t.dir, 'data'));
  assert.equal(await pass(scanner, unsaved, 'pro', 17 * HOUR), 0);
  assert.deepEqual(unsaved.problems(), []);
  assert.equal(JSON.parse(fs.readFileSync(t.hitsFile, 'utf8')).hits.length, 2);
});

test('a temp file an earlier save left is removed at the first read, or said when it cannot be', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.hitsFile), { recursive: true });
  fs.writeFileSync(`${s.hitsFile}.tmp`, '{"hits": [');
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(book.load(), true);
  assert.equal(fs.existsSync(`${s.hitsFile}.tmp`), false);
  assert.deepEqual(book.problems(), []);

  const t = setup();
  fs.mkdirSync(path.join(`${t.hitsFile}.tmp`, 'inside'), { recursive: true }); // a folder in its place
  const stuck = new LimitBook({ file: t.hitsFile });
  stuck.load();
  assert.match(stuck.problems()[0].label, /^usage-limits\.json\.tmp, left by an earlier save, could not be removed/);
  assert.equal(stuck.problems()[0].detail, `${t.hitsFile}.tmp`);
});

// ---- round 3: reset moments, unnamed limits, WSL, waiting across restarts ----

test('a reset is a moment: one weekly event retried across the day before it resets is one hit, in both of its forms', async () => {
  const s = setup();
  // T0 is 1 Jan 09:00 UTC (London's winter time is UTC). More than a day ahead Claude Code
  // writes the date; within the last day, the time alone.
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 7000),
    limit(1 * DAY, 'You\'ve hit your weekly limit · resets Jan 6, 10am (Europe/London)'),
    limit(4 * DAY + 3 * HOUR, 'You\'ve hit your weekly limit · resets 10am (Europe/London)')));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'max5', 4 * DAY + 4 * HOUR), 1);
  assert.deepEqual(book.view().hits.map((h) => [h.window, h.at, h.tokens]), [['week', at(1 * DAY), 7000]]);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits[0].resetAt, Date.parse('2026-01-06T10:00:00Z'));
});

test('a reset is a moment: two weekly events six days apart, both saying "9am", are two hits', async () => {
  const s = setup();
  // Etc/GMT-8 is 8 hours ahead of UTC: 9am there is 01:00 UTC, the next one after each message.
  fs.writeFileSync(s.file, jsonl(limit(18 * HOUR, 'You\'ve hit your weekly limit · resets 9am (Etc/GMT-8)'),
    limit(6 * DAY + 18 * HOUR, 'You\'ve hit your weekly limit · resets 9am (Etc/GMT-8)')));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'max5', 7 * DAY), 2);
  const saved = JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits.map((h) => h.resetAt);
  assert.deepEqual(saved, [Date.parse('2026-01-03T01:00:00Z'), Date.parse('2026-01-09T01:00:00Z')]);
});

test('a reset in a time zone Node cannot read falls back to the reply rule', async () => {
  const s = setup();
  const MARS = SESSION('5pm', 'Mars/Olympus');
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(2 * HOUR, MARS), reply(2 * HOUR + 10 * MIN, 'r2', 300), limit(2 * HOUR + 20 * MIN, MARS),
    limit(2 * HOUR + 40 * MIN, MARS)));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 3 * HOUR), 2, 'a reply came between the first two');
  assert.deepEqual(book.view().hits.map((h) => h.at), [at(2 * HOUR), at(2 * HOUR + 20 * MIN)]);
  assert.equal(limitMessage(MARS, at(2 * HOUR)).resetAt, null);
});

test('reset moments: the date and time forms, the year, minutes, an hour past noon, and the old epoch form', () => {
  const ts = Date.parse('2026-12-30T20:00:00Z');
  const resetAt = (t) => limitMessage(`You've hit your weekly limit · resets ${t}`, ts).resetAt;
  assert.equal(resetAt('Jan 2, 10am (Europe/London)'), Date.parse('2027-01-02T10:00:00Z'), 'a date past this year is next year\'s');
  assert.equal(resetAt('Jan 2, 2027, 3:30pm (Asia/Taipei)'), Date.parse('2027-01-02T07:30:00Z'));
  assert.equal(resetAt('9:15pm (America/New_York)'), Date.parse('2026-12-31T02:15:00Z'), 'the next 9:15pm there');
  assert.equal(resetAt('12am (UTC)'), Date.parse('2026-12-31T00:00:00Z'));
  assert.equal(resetAt('Jul 4, 10am (America/New_York)'), Date.parse('2027-07-04T14:00:00Z'), 'summer time');
  assert.equal(resetAt('Mon 9am'), null, 'a weekday names no moment');
  assert.equal(limitMessage('Claude AI usage limit reached|1767344400', ts).resetAt, 1767344400 * 1000);
});

test('a message naming no limit takes its window from its reset; with no reset it is not a hit, and is counted', async () => {
  const s = setup();
  // 10:00 UTC: 1pm is 3 hours on (the 5 hours); Jan 9 is a week on.
  fs.writeFileSync(s.file, jsonl(limit(1 * HOUR, 'You\'ve hit your limit · resets 1pm (Europe/London)'),
    limit(2 * HOUR, 'You\'ve hit your usage limit · resets Jan 8, 5pm (Europe/London)'),
    limit(3 * HOUR, 'You\'ve hit your limit')));
  const scanner = new UsageScanner({ roots: [s.root] });
  await scanner.scan(at(4 * HOUR));
  assert.deepEqual(scanner.limitHits().map((h) => [h.ts, h.window]), [[at(1 * HOUR), '5h'], [at(2 * HOUR), 'week']]);
  assert.equal(scanner.unnamedMessages(), 1);
  await scanner.scan(at(9 * DAY));
  assert.equal(scanner.unnamedMessages(), 0, 'counted for 7 days, like the hits');
});

test('once WSL\'s transcripts were read, hits wait while they are not, and are said; a computer that never had them is not held', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 4 * HOUR, { wslReading: true }), 1);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).wslSeenAt, at(4 * HOUR));
  // After a restart WSL is not running: a new hit whose 5 hours reach back to that read waits, and says so.
  fs.appendFileSync(s.file, jsonl(reply(6 * HOUR, 'r2', 5000), limit(8 * HOUR, SESSION('3pm'))));
  const restarted = new LimitBook({ file: s.hitsFile });
  const sc = new UsageScanner({ roots: [s.root] });
  assert.equal(await pass(sc, restarted, 'pro', 9 * HOUR), 0);
  assert.deepEqual(restarted.view().waiting, waits({ wsl: 1 }));
  assert.equal(await pass(sc, restarted, 'pro', 10 * HOUR, { wslReading: true }), 1);
  assert.deepEqual(restarted.view().waiting, waits());

  const t = setup();
  fs.writeFileSync(t.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  assert.equal(await pass(new UsageScanner({ roots: [t.root] }), new LimitBook({ file: t.hitsFile }), 'pro', 4 * HOUR), 1, 'never had WSL: not held');
});

test('waiting hits survive a restart with the plan in force when first seen; those seen with no plan take the plan picked', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am')), limit(5 * HOUR, SESSION('8am'))));
  const book = new LimitBook({ file: s.hitsFile });
  // Seen under Pro while the pass could not be trusted; then the user picks Max 5×.
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 6 * HOUR, { ready: false }), 0);
  const saved = JSON.parse(fs.readFileSync(s.hitsFile, 'utf8'));
  assert.deepEqual(saved.waiting.map((w) => [w.at, w.plan, w.why]), [[at(3 * HOUR), 'pro', 'pass'], [at(5 * HOUR), 'pro', 'pass']]);
  const restarted = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), restarted, 'max5', 7 * HOUR), 2);
  assert.deepEqual(restarted.view().hits.map((h) => h.plan), ['pro', 'pro']);
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), new LimitBook({ file: s.hitsFile }), 'max5', 7 * HOUR), 0, 'not counted again');

  const t = setup();
  fs.writeFileSync(t.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  await pass(new UsageScanner({ roots: [t.root] }), new LimitBook({ file: t.hitsFile }), 'none', 4 * HOUR);
  const later = new LimitBook({ file: t.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [t.root] }), later, 'team', 5 * HOUR), 1);
  assert.deepEqual(later.view().hits.map((h) => h.plan), ['team']);
});

test('a hit that waited over 7 days for a clean pass, WSL or the file is said under Needs attention with what it waited for', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  await pass(scanner, book, 'pro', 4 * HOUR, { ready: false });
  await pass(scanner, book, 'pro', 8 * DAY, { ready: false });
  assert.deepEqual(book.problems(), [{ label: en('said.limits.expired.pass', { n: 1 }), detail: '' }]);
  assert.match(book.problems()[0].label, /waited over 7 days for every transcript folder to be read/);
  // Said for 7 days after, then let go.
  await pass(scanner, book, 'pro', 16 * DAY);
  assert.deepEqual(book.problems(), []);
});

// ---- round 4 ----

test('a bare reset time just passed is that day\'s: a message written a little after 9pm saying "9pm" is the same hit, and a 5-hour one', async () => {
  const s = setup();
  // T0 + 12 h is 21:00 UTC, London's time in winter.
  const NINE = SESSION('9pm');
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 3000), limit(12 * HOUR - 2 * MIN, NINE), reply(12 * HOUR + 10, 'r2', 200),
    limit(12 * HOUR + 20, NINE)));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 13 * HOUR), 1);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits[0].resetAt, Date.parse('2026-01-01T21:00:00Z'));
  const unnamed = limitMessage('You\'ve hit your limit · resets 9pm (Europe/London)', at(12 * HOUR + 20));
  assert.deepEqual([unnamed.window, unnamed.resetAt], ['5h', Date.parse('2026-01-01T21:00:00Z')]);
  // More than 15 minutes on, the same words are the next day's.
  assert.equal(limitMessage(NINE, at(12 * HOUR + 20 * MIN)).resetAt, Date.parse('2026-01-02T21:00:00Z'));
});

test('once WSL is read in this run, new hits are not held when it stops', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 4 * HOUR, { wslReading: true }), 1);
  // WSL stops; its use up to now was read in this run.
  fs.appendFileSync(s.file, jsonl(reply(6 * HOUR, 'r2', 5000), limit(8 * HOUR, SESSION('3pm'))));
  assert.equal(await pass(scanner, book, 'pro', 9 * HOUR), 1);
  assert.deepEqual(book.view().waiting, waits());
});

test('after a restart, only hits whose window reaches back to WSL\'s last read wait: past 5 hours the 5-hour ones go on, past 7 days the weekly ones', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 4000), limit(3 * HOUR, SESSION('6am'))));
  await pass(new UsageScanner({ roots: [s.root] }), new LimitBook({ file: s.hitsFile }), 'pro', 4 * HOUR, { wslReading: true });
  // 6 hours after WSL's last read, with WSL stopped: a 5-hour hit goes on, a weekly one waits.
  fs.appendFileSync(s.file, jsonl(reply(9 * HOUR, 'r2', 5000), limit(10 * HOUR, SESSION('11pm')),
    limit(10 * HOUR + MIN, 'You\'ve hit your weekly limit · resets Jan 6, 10am (Europe/London)')));
  const restarted = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), restarted, 'pro', 11 * HOUR), 1);
  assert.deepEqual(restarted.view().hits.map((h) => [h.window, h.at]), [['5h', at(3 * HOUR)], ['5h', at(10 * HOUR)]]);
  assert.deepEqual(restarted.view().waiting, waits({ wsl: 1 }));
  // A weekly hit more than 7 days after WSL's last read goes on too.
  fs.appendFileSync(s.file, jsonl(reply(7 * DAY + 4 * HOUR, 'r3', 5000), limit(7 * DAY + 5 * HOUR, 'You\'ve hit your weekly limit · resets Jan 14, 10am (Europe/London)')));
  const later = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), later, 'pro', 7 * DAY + 6 * HOUR), 1);
  assert.deepEqual(later.view().hits.filter((h) => h.window === 'week').map((h) => h.at), [at(7 * DAY + 5 * HOUR)]);
});
