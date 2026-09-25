'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageScanner, contextWindowFor } = require('../src/core/usage');

const HOUR = 3_600_000;
const NOW = Date.parse('2026-03-10T15:00:00');
const line = (msAgo, id, input, output, extra = {}) => `${JSON.stringify({
  type: 'assistant', timestamp: new Date(NOW - msAgo).toISOString(), sessionId: 's',
  message: { id, model: 'claude-sonnet-5', role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
  ...extra,
})}\n`;

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  fs.mkdirSync(path.join(r, 'proj', 'sess', 'subagents'), { recursive: true });
  return r;
}

test('context windows: current models 1M, Haiku and older ones 200k', () => {
  assert.equal(contextWindowFor('claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
  assert.equal(contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
});

test('usage is summed per window, each reply once at its fullest', async () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'proj', 'a.jsonl'),
    line(1 * HOUR, 'm1', 100, 10) + line(1 * HOUR, 'm1', 100, 40) // same reply, fuller
    + line(7 * HOUR, 'm2', 200, 20) // outside 5 h, still today
    + line(3 * 24 * HOUR, 'm3', 300, 30) // this week
    + line(9 * 24 * HOUR, 'm4', 999, 999)); // too old
  fs.writeFileSync(path.join(r, 'proj', 'sess', 'subagents', 'agent-x.jsonl'), line(2 * HOUR, 'h1', 50, 5));
  const scanner = new UsageScanner({ roots: [r] });
  await scanner.scan(NOW);
  const u = scanner.summary(NOW);
  assert.deepEqual(u.last5h, { input: 150, output: 45, cacheRead: 2000, cacheWrite: 0, total: 2195, fresh: 195, replies: 2 });
  assert.equal(u.today.replies, 3);
  assert.equal(u.week.replies, 4);
  assert.equal(u.week.input, 650);
});

test('a later scan reads only what was added, and a limit message is kept', async () => {
  const r = root();
  const file = path.join(r, 'proj', 'a.jsonl');
  fs.writeFileSync(file, line(HOUR, 'm1', 100, 10));
  const scanner = new UsageScanner({ roots: [r] });
  await scanner.scan(NOW);
  fs.appendFileSync(file, line(0, 'm2', 1, 1) + `${JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, timestamp: new Date(NOW - 60_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Claude usage limit reached. Your limit will reset at 6pm.' }] },
  })}\n`);
  await scanner.scan(NOW);
  const u = scanner.summary(NOW);
  assert.equal(u.last5h.replies, 2);
  assert.match(u.limitNotice.text, /limit reached/);
});

test('unreadable lines are counted, not dropped silently', async () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'proj', 'a.jsonl'), '{"usage": broken\n' + line(HOUR, 'm1', 1, 1));
  const scanner = new UsageScanner({ roots: [r] });
  await scanner.scan(NOW);
  assert.equal(scanner.summary(NOW).unreadable, 1);
  assert.equal(scanner.summary(NOW).last5h.replies, 1);
});

test('a missing folder is simply empty', async () => {
  const scanner = new UsageScanner({ roots: [path.join(os.tmpdir(), 'no-such-folder-xyz')] });
  await scanner.scan(NOW);
  assert.equal(scanner.summary(NOW).week.replies, 0);
});
