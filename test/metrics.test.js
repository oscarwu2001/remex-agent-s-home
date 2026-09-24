'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, rollUp, summarise, score, verdictOf, weekKey } = require('../src/core/metrics');
const { T0, prompt, toolUse, toolResult, say, sidechain } = require('./helpers');

const s = (sec) => T0 + sec * 1000;

// Writes invented transcripts into a temporary projects folder.
function world(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-metrics-'));
  for (const [rel, entries] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  }
  return root;
}

const usage = (entry, id, input, output) => ({ ...entry, message: { ...entry.message, id, usage: { input_tokens: input, output_tokens: output } } });
const RANGE = { since: T0 - 1000, until: T0 + 7 * 86_400_000 };

test('a helper run gets its type, duration, outcome and verdict', () => {
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 't1', 'Task', { subagent_type: 'reviewer', prompt: 'Review the diff' }),
      toolResult(61, 't1', 'FAIL\n\n1. tracker.js:12 ...'),
    ],
  });
  const { runs } = collect([root], RANGE);
  assert.equal(runs.length, 1);
  const [r] = runs;
  assert.deepEqual([r.type, r.durationMs, r.outcome, r.verdict], ['reviewer', 60_000, 'finished', 'FAIL']);
  assert.equal(r.prompt, undefined, 'prompt text never leaves the module');
});

test('helper tokens come from its own transcript, counted once per message', () => {
  const p = 'Run the fast tests and report the counts, please';
  const root = world({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 'r1', 'Task', { subagent_type: 'runner', prompt: p }), toolResult(30, 'r1', 'ok')],
    'p/sess-1/subagents/agent-a.jsonl': [
      prompt(2, p, sidechain('a')),
      // one reply split over two lines, both repeating the same usage
      usage(toolUse(3, 'b1', 'Bash', { command: 'x' }, sidechain('a')), 'msg_1', 100, 20),
      usage(say(3, 'running', null, sidechain('a')), 'msg_1', 100, 20),
      toolResult(10, 'b1', 'boom', sidechain('a'), true),
      usage(say(20, 'done', 'end_turn', sidechain('a')), 'msg_2', 50, 10),
    ],
  });
  const { runs, stats } = collect([root], RANGE);
  assert.equal(stats.unlinkedHelpers, 0);
  assert.equal(runs[0].linked, true);
  assert.deepEqual([runs[0].tokens.input, runs[0].tokens.output], [150, 30]);
  assert.deepEqual([runs[0].toolCalls, runs[0].toolErrors], [1, 1]);
});

test('background runs end on their notification; unfinished ones stay unknown', () => {
  const note = (sec, id, status) => ({
    ...prompt(sec, `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>`),
    origin: { kind: 'task-notification' },
  });
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'b1', 'Agent', { subagent_type: 'runner', prompt: 'a', run_in_background: true }),
      toolUse(1, 'b2', 'Agent', { subagent_type: 'runner', prompt: 'b', run_in_background: true }),
      toolResult(1.1, 'b1', 'launched'), toolResult(1.1, 'b2', 'launched'),
      note(41, 'b1', 'failed'),
    ],
  });
  const { runs } = collect([root], RANGE);
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.deepEqual([byId.b1.outcome, byId.b1.durationMs], ['failed', 40_000]);
  assert.equal(byId.b2.outcome, 'unknown');
  const sum = summarise(runs);
  assert.equal(sum.successRate, 0); // 0 of 1 ended run finished; the unknown one is left out
  assert.equal(sum.unknown, 1);
});

test('a new prompt stops foreground helpers still running', () => {
  const root = world({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 'x', 'Task', { subagent_type: 'Plan', prompt: 'p' }), prompt(9, 'stop')],
  });
  assert.equal(collect([root], RANGE).runs[0].outcome, 'stopped');
});

test('a re-run is a call soon after the same agent failed, not after a FAIL verdict', () => {
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'a', 'Task', { subagent_type: 'reviewer', prompt: 'one' }), toolResult(60, 'a', 'FAIL'),
      toolUse(120, 'b', 'Task', { subagent_type: 'reviewer', prompt: 'two' }), toolResult(180, 'b', 'crashed', undefined, true),
      toolUse(240, 'c', 'Task', { subagent_type: 'reviewer', prompt: 'three' }), toolResult(300, 'c', 'PASS'),
      toolUse(9000, 'd', 'Task', { subagent_type: 'reviewer', prompt: 'four' }), toolResult(9060, 'd', 'PASS'),
    ],
  });
  const runs = collect([root], RANGE).runs.sort((x, y) => x.start - y.start);
  // b follows a FAIL verdict (the reviewer did its job): not a re-run.
  // c follows b, which errored: a re-run.
  assert.deepEqual(runs.map((r) => r.rerun), [false, false, true, false]);
  const sum = summarise(runs);
  assert.deepEqual(sum.verdicts, { FAIL: 1, PASS: 2 });
  assert.equal(sum.rerunRate, 1 / 4);
});

test('runs outside the range are left out', () => {
  const root = world({ 'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 'a', 'Task', { subagent_type: 'x', prompt: 'p' })] });
  assert.equal(collect([root], { since: s(10), until: s(20) }).runs.length, 0);
});

test('malformed lines are counted, not fatal', () => {
  const root = world({ 'p/sess-1.jsonl': ['{"broken', prompt(0, 'go')] });
  assert.equal(collect([root], RANGE).stats.malformedLines, 1);
});

test('score parts: reliability, right first time, and speed/efficiency against the own baseline', () => {
  const summary = { runs: 4, successRate: 0.75, rerunRate: 0.25, medianMs: 120_000, medianTokens: 2000 };
  const baseline = { medianMs: 60_000, medianTokens: 4000 };
  const sc = score(summary, baseline);
  assert.deepEqual(sc.parts, { reliability: 30, rightFirst: 15, speed: 10, efficiency: 20 });
  assert.equal(sc.value, 75);
  assert.equal(score({ ...summary, runs: 2 }, baseline).value, undefined);
});

test('verdicts are read from the first line only', () => {
  assert.equal(verdictOf('PASS\n\nall good'), 'PASS');
  assert.equal(verdictOf('**FAIL**'), 'FAIL');
  assert.equal(verdictOf('Block. Two HIGH findings'), 'Block');
  assert.equal(verdictOf('The tests PASS'), undefined);
  assert.equal(verdictOf(undefined), undefined);
});

test('ISO weeks start on Monday', () => {
  assert.equal(weekKey(new Date(2026, 0, 1).getTime()), '2026-W01'); // a Thursday
  assert.equal(weekKey(new Date(2025, 11, 29).getTime()), '2026-W01'); // the Monday before
  assert.equal(weekKey(new Date(2025, 11, 28).getTime()), '2025-W52'); // the Sunday before
});

test('rollUp gives daily and weekly rows per agent', () => {
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      ...[0, 1, 2].flatMap((i) => [
        toolUse(10 + i * 100, `r${i}`, 'Task', { subagent_type: 'runner', prompt: `p${i}` }),
        toolResult(40 + i * 100, `r${i}`, 'ok'),
      ]),
    ],
  });
  const data = collect([root], RANGE);
  const roll = rollUp(data);
  assert.deepEqual(roll.types, ['runner']);
  assert.equal(roll.daily.length, 1);
  assert.equal(roll.daily[0].runs, 3);
  assert.equal(roll.weekly[0].score.value, 100);
  assert.equal(roll.sessionDays[0].helperRuns, 3);
});

test('a part that could not be measured is left out, not given full marks', () => {
  const sc = score({ runs: 5, successRate: 0.5, rerunRate: 0, medianMs: 60_000, medianTokens: undefined }, { medianMs: 60_000, medianTokens: 1000 });
  assert.deepEqual(sc.missing, ['efficiency']);
  // reliability 20/40 + right first 20/20 + speed 20/20 = 60 of 80 possible
  assert.equal(sc.value, 75);
  assert.equal(score({ runs: 5, successRate: undefined }, null).reason, 'no run has ended yet');
});

test('a notification with an unreadable status leaves the run unknown and is counted', () => {
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'b', 'Agent', { subagent_type: 'runner', prompt: 'x', run_in_background: true }),
      { ...prompt(9, '<task-notification>\n<tool-use-id>b</tool-use-id>\n<status>paused</status>'), origin: { kind: 'task-notification' } },
    ],
  });
  const { runs, stats } = collect([root], RANGE);
  assert.equal(runs[0].outcome, 'unknown');
  assert.equal(stats.unknownNotifications, 1);
});

test('two runs with the same prompt are not guessed between', () => {
  const p = 'Review the change please, carefully and completely';
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'a', 'Task', { subagent_type: 'reviewer', prompt: p }),
      toolUse(1, 'b', 'Task', { subagent_type: 'reviewer', prompt: p }),
    ],
    'p/sess-1/subagents/agent-z.jsonl': [prompt(2, p, sidechain('z')), toolUse(3, 'r', 'Read', {}, sidechain('z'))],
    'p/sess-1/subagents/agent-q.jsonl': [prompt(2, `${p} (and more)`, sidechain('q'))],
  });
  const { runs, stats } = collect([root], RANGE);
  assert.ok(runs.every((r) => !r.linked));
  assert.equal(stats.ambiguousHelpers, 1); // z matches both
  assert.equal(stats.unlinkedHelpers, 1); // q matches neither: prefixes do not count
});

test('tool calls come from one source: the helper transcript, else the relays', () => {
  const p = 'Explore the code base and summarise the loaders';
  const relay = (sec, parent, inner) => ({
    type: 'progress', sessionId: 'sess-1', timestamp: new Date(s(sec)).toISOString(), parentToolUseID: parent, data: { message: inner },
  });
  const root = world({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'e', 'Task', { subagent_type: 'Explore', prompt: p }),
      relay(2, 'e', toolUse(2, 'r1', 'Read', {})),
      toolUse(5, 'f', 'Task', { subagent_type: 'Plan', prompt: 'plan it' }),
      relay(6, 'f', toolUse(6, 'r2', 'Read', {})),
      relay(7, 'f', toolUse(7, 'r3', 'Grep', {})),
    ],
    'p/sess-1/subagents/agent-e.jsonl': [prompt(2, p, sidechain('e')), toolUse(2, 'r1', 'Read', {}, sidechain('e'))],
  });
  const byType = Object.fromEntries(collect([root], RANGE).runs.map((r) => [r.type, r.toolCalls]));
  assert.deepEqual(byType, { Explore: 1, Plan: 2 });
});

test('a resumed transcript repeating a Task call counts it once', () => {
  const call = toolUse(1, 'dup', 'Task', { subagent_type: 'runner', prompt: 'p' });
  const root = world({ 'p/sess-1.jsonl': [prompt(0, 'go'), call, call, toolResult(9, 'dup', 'ok')] });
  const { runs, sessions } = collect([root], RANGE);
  assert.equal(runs.length, 1);
  assert.equal(sessions[0].runs.length, 1);
});
