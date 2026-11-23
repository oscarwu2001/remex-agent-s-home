'use strict';

// Limit hits (src/core/limits.js) read by the usage scanner from invented
// transcripts, kept in a hits file, and the estimate learned from them
// (renderer/plans.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { T0, say } = require('./helpers');
const { UsageScanner } = require('../src/core/usage');
const { LimitBook, hitWindow } = require('../src/core/limits');
const { en } = require('../src/core/i18n');

const plans = () => import('../renderer/plans.js');

const MIN = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
// A reply of `tokens` tokens (all fresh input) at `s` seconds after T0.
const reply = (s, id, tokens) => {
  const e = say(s, 'ok');
  e.message = { ...e.message, id, model: 'claude-sonnet-5', usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return e;
};
const limit = (s, text = '5-hour limit reached · resets 2pm') => ({ ...say(s, text, 'stop_sequence'), isApiErrorMessage: true });
const jsonl = (...entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const at = (s) => T0 + s * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  return { dir, root, file: path.join(root, 'proj', 'a.jsonl'), hitsFile: path.join(dir, 'data', 'usage-limits.json') };
}

// One pass, as the main process makes it: scan, then record the hits found.
async function pass(scanner, book, plan, nowS) {
  await scanner.scan(at(nowS));
  return book.take(scanner.limitHits(), plan, scanner);
}

// Two 5-hour hits: 6000 + 4000 tokens before the first, 8000 + 6000 before
// the second (the first's replies are more than 5 hours before it).
const twoHits = () => jsonl(
  reply(1 * HOUR, 'r1', 6000), reply(2 * HOUR, 'r2', 4000), limit(3 * HOUR),
  reply(10 * HOUR, 'r3', 8000), reply(11 * HOUR, 'r4', 6000), limit(12 * HOUR),
  reply(14 * HOUR, 'r5', 3000),
);

test('limit hits: reached is a hit, near, rate limits and extra usage are not; weekly goes to the week', () => {
  assert.equal(hitWindow('Claude usage limit reached. Your limit will reset at 5pm.'), '5h');
  assert.equal(hitWindow('5-hour limit reached · resets 2pm'), '5h');
  assert.equal(hitWindow('Weekly limit reached · resets Mon 9am'), 'week');
  assert.equal(hitWindow('Opus weekly limit reached · resets Mon 9am'), 'week');
  assert.equal(hitWindow('Approaching usage limit · resets at 2pm'), null);
  assert.equal(hitWindow('API Error: Rate limit reached'), null);
  assert.equal(hitWindow('You are out of extra usage · resets 2pm'), null);
  assert.equal(hitWindow('Something else went wrong'), null);
});

test('two hits give an estimate from the tokens before each; one hit gives none yet', async () => {
  const { estimate } = await plans();
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 6000), reply(2 * HOUR, 'r2', 4000), limit(3 * HOUR)));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(scanner, book, 'pro', 3 * HOUR + MIN), 1);
  assert.deepEqual(book.view().hits, [{ at: at(3 * HOUR), plan: 'pro', window: '5h', tokens: 10_000 }]);
  assert.deepEqual(estimate(book.view().hits, 'pro', scanner.summary(at(3 * HOUR + MIN)))['5h'], { hits: 1 });

  fs.writeFileSync(s.file, twoHits());
  assert.equal(await pass(scanner, book, 'pro', 17 * HOUR), 1);
  assert.deepEqual(book.view().hits.map((h) => h.tokens), [10_000, 14_000]);
  // Learned level: 12000 (between the two). The last 5 hours (12 h to 17 h) used 3000.
  const e = estimate(book.view().hits, 'pro', scanner.summary(at(17 * HOUR)));
  assert.deepEqual(e['5h'], { hits: 2, basis: 2, level: 12_000, used: 3000, pct: 25, over: false });
  assert.deepEqual(e.week, { hits: 0 });
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

test('the message repeated while the limit holds is the same hit; one after replies again is a new hit', async () => {
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 5000), limit(2 * HOUR), limit(2 * HOUR + 20 * MIN), limit(2 * HOUR + 50 * MIN),
    // The limit lifted: replies, then a new hit within 5 hours of the first.
    reply(4 * HOUR, 'r2', 7000), limit(5 * HOUR)));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'pro', 6 * HOUR), 2);
  // 1 h to 5 h before the second hit: both replies.
  assert.deepEqual(book.view().hits.map((h) => [h.at, h.tokens]), [[at(2 * HOUR), 5000], [at(5 * HOUR), 12_000]]);
  assert.equal(JSON.parse(fs.readFileSync(s.hitsFile, 'utf8')).hits[0].seen.length, 3);
});

test('a plan change starts a new count; the old plan\'s hits are kept', async () => {
  const { estimate } = await plans();
  const s = setup();
  fs.writeFileSync(s.file, jsonl(reply(1 * HOUR, 'r1', 6000), limit(2 * HOUR)));
  const scanner = new UsageScanner({ roots: [s.root] });
  const book = new LimitBook({ file: s.hitsFile });
  await pass(scanner, book, 'pro', 3 * HOUR);
  fs.appendFileSync(s.file, jsonl(reply(8 * HOUR, 'r2', 9000), limit(9 * HOUR)));
  await pass(scanner, book, 'max5', 10 * HOUR);
  fs.appendFileSync(s.file, jsonl(reply(15 * HOUR, 'r3', 9000), limit(16 * HOUR)));
  await pass(scanner, book, 'max5', 17 * HOUR);
  assert.deepEqual(book.view().hits.map((h) => h.plan), ['pro', 'max5', 'max5']);
  const usage = scanner.summary(at(17 * HOUR));
  assert.deepEqual(estimate(book.view().hits, 'pro', usage)['5h'], { hits: 1 });
  assert.equal(estimate(book.view().hits, 'max5', usage)['5h'].basis, 2);
  assert.equal(estimate(book.view().hits, 'none', usage), null, 'no plan, no estimate');
});

test('a weekly message goes to the weekly window, counted over the whole week before it, even at the first scan', async () => {
  const s = setup();
  // The hit is 3 days before the scan; the week before it reaches 10 days back.
  fs.writeFileSync(s.file, jsonl(reply(0, 'r1', 2000), reply(5 * DAY, 'r2', 3000), reply(6 * DAY, 'r3', 4000),
    limit(7 * DAY - HOUR, 'Weekly limit reached · resets Mon 9am')));
  const book = new LimitBook({ file: s.hitsFile });
  assert.equal(await pass(new UsageScanner({ roots: [s.root] }), book, 'max20', 10 * DAY - HOUR), 1);
  assert.deepEqual(book.view().hits, [{ at: at(7 * DAY - HOUR), plan: 'max20', window: 'week', tokens: 9000 }]);
});

test('past the learned level the estimate says over, never a share above 100', async () => {
  const { estimate } = await plans();
  const hits = [{ at: 1, plan: 'pro', window: '5h', tokens: 10_000 }, { at: 2, plan: 'pro', window: '5h', tokens: 10_000 }];
  assert.deepEqual(estimate(hits, 'pro', { last5h: { total: 13_000 }, week: { total: 13_000 } })['5h'], { hits: 2, basis: 2, level: 10_000, used: 13_000, pct: 130, over: true });
  assert.equal(estimate(hits, 'pro', { last5h: { total: 10_000 }, week: { total: 0 } })['5h'].over, false, 'at the level is not past it');
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
  assert.deepEqual(book.view(), { paused: true, hits: [] });
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

test('a hits file that cannot be opened is said with its code; one that cannot be saved keeps the hits and says so', async () => {
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
  assert.match(unsaved.problems()[0].label, /^usage-limits\.json could not be saved \(E[A-Z]+\)/);
  // Saved once it can be, with no hit counted twice.
  fs.rmSync(path.join(t.dir, 'data'));
  assert.equal(await pass(scanner, unsaved, 'pro', 17 * HOUR), 0);
  assert.deepEqual(unsaved.problems(), []);
  assert.equal(JSON.parse(fs.readFileSync(t.hitsFile, 'utf8')).hits.length, 2);
});
