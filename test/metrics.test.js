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
  const summary = { runs: 4, successRate: 0.75, rerunRate: 0.25, medianMs: 120_000, medianWeighted: 2000 };
  const baseline = { medianMs: 60_000, medianWeighted: 4000 };
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
  const sc = score({ runs: 5, successRate: 0.5, rerunRate: 0, medianMs: 60_000, medianWeighted: undefined }, { medianMs: 60_000, medianWeighted: 1000 });
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

// ---- hand-backs, rounds, turn limits, first review ------------------------

// A .claude folder of invented transcripts, with agents beside projects.
function claudeHome(files, agents = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'));
  const root = path.join(base, 'projects');
  for (const [rel, entries] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.mkdirSync(path.join(base, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(agents)) fs.writeFileSync(path.join(base, 'agents', `${name}.md`), text);
  return root;
}
const launched = (sec, id, agentId, extra) => toolResult(sec, id, `Async agent launched successfully.\nagentId: ${agentId} (internal ID)`, extra);
// How the Claude app hands a helper's report back to the main session.
const peerHandback = (sec, agentId, report) => ({
  ...prompt(sec, 'Another Claude session sent a message'), isMeta: true,
  origin: { kind: 'peer', from: agentId, name: 'helper', handback: true, handbackReportText: report },
});
const done = (sec, id) => ({ ...prompt(sec, `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>`), origin: { kind: 'task-notification' } });

test('verdicts are read from a closing VERDICT line or the first word, BLOCKED included', () => {
  assert.equal(verdictOf('Two findings below.\n\n1. a.js:3 ...\n\nVERDICT: FAIL findings=2 blocking=1 sha=abc1234'), 'FAIL');
  assert.equal(verdictOf('PASS\n\nNothing found.\n**VERDICT: PASS findings=0 blocking=0 sha=none**'), 'PASS');
  assert.equal(verdictOf('**BLOCKED**: the preview would not start'), 'BLOCKED');
  assert.equal(verdictOf('Approve. Looks right.'), 'Approve');
  assert.equal(verdictOf('The review passed in spirit'), undefined, 'no guessing from prose');
});

test('an app hand-back counts: one verdict per hand-back, rounds from SendMessage, timed to the first', () => {
  const root = claudeHome({
    'p/sess-1.jsonl': [
      prompt(0, 'review it'),
      toolUse(1, 't1', 'Agent', { subagent_type: 'reviewer', prompt: 'Review the diff' }),
      launched(2, 't1', 'rev1'),
      peerHandback(120, 'rev1', 'FAIL\n\n1. a.js:3 drops the last row'),
      done(121, 't1'),
      toolUse(300, 'sm1', 'SendMessage', { to: 'rev1', message: 'Fixed; re-check those findings' }),
      peerHandback(360, 'rev1', 'All fixed.\nVERDICT: PASS findings=0 blocking=0 sha=abc1234'),
    ],
  });
  const { runs } = collect([root], RANGE);
  const [r] = runs;
  assert.deepEqual(r.verdicts, ['FAIL', 'PASS']);
  assert.equal(r.verdict, 'FAIL', 'the first verdict stays the run\'s own');
  assert.equal(r.rounds, 2);
  assert.equal(r.durationMs, 119_000, 'to the first hand-back, not to the re-check');
  assert.deepEqual(summarise(runs).verdicts, { FAIL: 1, PASS: 1 });
});

test('a SubagentHandback call in the helper\'s own transcript gives its verdict', () => {
  const p = 'Review the restyled sidebar';
  const root = claudeHome({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'ui-reviewer', prompt: p }), launched(2, 't1', 'ui1'), done(90, 't1')],
    'p/sess-1/subagents/agent-ui1.jsonl': [
      prompt(3, p, sidechain('ui1')),
      usage(toolUse(10, 'r1', 'Read', { file_path: 'x' }, sidechain('ui1')), 'm1', 10, 1),
      toolResult(11, 'r1', 'ok', sidechain('ui1')),
      usage(toolUse(80, 'hb', 'SubagentHandback', { message: 'Could not start the preview.\nVERDICT: BLOCKED findings=0 blocking=0 sha=none' }, sidechain('ui1')), 'm2', 10, 1),
      toolResult(81, 'hb', 'delivered', sidechain('ui1')),
      usage(say(82, 'Report handed back.', 'end_turn', sidechain('ui1')), 'm3', 10, 1),
    ],
  });
  const { runs } = collect([root], RANGE);
  assert.deepEqual([runs[0].verdict, runs[0].rounds, runs[0].turns], ['BLOCKED', 1, 2]);
  assert.equal(summarise(runs).noVerdict, 0);
});

test('a helper cut off by its maxTurns did not finish, whatever the notification said', () => {
  const p = 'Build the export, Done check: npm test';
  const root = claudeHome({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'builder', prompt: p }), launched(2, 't1', 'b1'), done(200, 't1')],
    'p/sess-1/subagents/agent-b1.jsonl': [
      prompt(3, p, sidechain('b1')),
      ...[1, 2, 3].flatMap((i) => [
        usage(toolUse(10 * i, `e${i}`, 'Edit', { file_path: 'x' }, sidechain('b1')), `m${i}`, 10, 1),
        toolResult(10 * i + 1, `e${i}`, 'ok', sidechain('b1')),
      ]),
    ],
  }, { builder: '---\nname: builder\nmaxTurns: 3\n---\nBuild it.\n' });
  const { runs } = collect([root], RANGE);
  assert.deepEqual([runs[0].outcome, runs[0].turns, runs[0].maxTurns], ['turn limit', 3, 3]);
  const sum = summarise(runs);
  assert.deepEqual([sum.turnLimit, sum.successRate], [1, 0]);
});

test('a builder passes first time only when its first review round has no FAIL', () => {
  const brief = (n) => `Build piece ${n}. Done check: npm test`;
  const builder = (sess, n, agentId, handbacks) => [
    prompt(3, brief(n), { ...sidechain(agentId), sessionId: sess }),
    usage(toolUse(5, `${agentId}e`, 'Edit', { file_path: 'x' }, { ...sidechain(agentId), sessionId: sess }), `${agentId}m1`, 10, 1),
    toolResult(6, `${agentId}e`, 'ok', { ...sidechain(agentId), sessionId: sess }),
    ...handbacks.map((sec, i) => usage(say(sec, `Changed: x\nDone check: green (${i})`, 'end_turn', { ...sidechain(agentId), sessionId: sess }), `${agentId}h${i}`, 10, 1)),
  ];
  const root = claudeHome({
    // Session 1: FAIL from the reviewer, fixed after SendMessage, then PASS.
    'p/s1.jsonl': [
      prompt(0, 'go', { sessionId: 's1' }),
      toolUse(1, 'b1', 'Agent', { subagent_type: 'builder', prompt: brief(1) }, { sessionId: 's1' }), launched(2, 'b1', 'bAAA1', { sessionId: 's1' }),
      toolUse(60, 'r1', 'Agent', { subagent_type: 'reviewer', prompt: 'Review' }, { sessionId: 's1' }), toolResult(90, 'r1', 'FAIL\n\n1. x:1', { sessionId: 's1' }),
      toolUse(100, 'sm', 'SendMessage', { to: 'bAAA1', message: 'Fix finding 1' }, { sessionId: 's1' }),
      toolUse(200, 'r2', 'Agent', { subagent_type: 'reviewer', prompt: 'Re-check' }, { sessionId: 's1' }), toolResult(220, 'r2', 'PASS', { sessionId: 's1' }),
    ],
    'p/s1/subagents/agent-bAAA1.jsonl': builder('s1', 1, 'bAAA1', [50, 150]),
    // Session 2: the first review passes.
    'p/s2.jsonl': [
      prompt(0, 'go', { sessionId: 's2' }),
      toolUse(1, 'b2', 'Agent', { subagent_type: 'builder', prompt: brief(2) }, { sessionId: 's2' }), launched(2, 'b2', 'bBBB2', { sessionId: 's2' }),
      toolUse(60, 'r3', 'Agent', { subagent_type: 'reviewer', prompt: 'Review' }, { sessionId: 's2' }), toolResult(90, 'r3', 'PASS', { sessionId: 's2' }),
    ],
    'p/s2/subagents/agent-bBBB2.jsonl': builder('s2', 2, 'bBBB2', [50]),
  });
  const { runs } = collect([root], RANGE);
  const b1 = runs.find((r) => r.type === 'builder' && r.sessionId === 's1');
  const b2 = runs.find((r) => r.type === 'builder' && r.sessionId === 's2');
  assert.deepEqual([b1.reviewed, b1.firstPass, b1.rounds], [true, false, 2]);
  assert.deepEqual([b2.reviewed, b2.firstPass, b2.rounds], [true, true, 1]);
  const sum = summarise(runs.filter((r) => r.type === 'builder'));
  assert.deepEqual([sum.reviewed, sum.firstPass, sum.firstPassRate], [2, 1, 0.5]);
  assert.ok(runs.filter((r) => r.type === 'reviewer').every((r) => r.reviewed === undefined), 'a reviewer is not itself reviewed');
});

test('right first time uses the first review once 3 runs were reviewed', () => {
  const sum = { runs: 4, successRate: 1, rerunRate: 0, reviewed: 4, firstPassRate: 0.25 };
  assert.equal(score(sum, null).parts.rightFirst, 5);
  assert.equal(score({ ...sum, reviewed: 2 }, null).parts.rightFirst, 20, 'too few reviews: the re-run rate stands in');
});

// ---- the review's cases: one hand-back counted once, rounds, attribution ----

const thinkingThenText = (sec, id, text, extra) => [
  usage({ ...say(sec, '', 'end_turn', extra), message: { ...say(sec, '', 'end_turn', extra).message, content: [{ type: 'thinking', thinking: '…' }] } }, id, 10, 1),
  usage(say(sec + 1, text, 'end_turn', extra), id, 10, 1),
];
const fromParent = (sec, extra) => ({ ...prompt(sec, 'The coordinator sent a follow-up', extra), isMeta: true, origin: { kind: 'coordinator' } });

test('a reply written as a thinking line and a text line is one hand-back, its verdict read from the text', () => {
  const p = 'Review the diff of the parser';
  const root = claudeHome({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'reviewer', prompt: p }), toolResult(100, 't1', 'FAIL\n1. x')],
    'p/sess-1/subagents/agent-rev00001.jsonl': [
      prompt(2, p, sidechain('rev00001')),
      usage(toolUse(10, 'r1', 'Read', { file_path: 'x' }, sidechain('rev00001')), 'm1', 10, 1),
      toolResult(11, 'r1', 'ok', sidechain('rev00001')),
      ...thinkingThenText(98, 'm2', 'FAIL\n1. x', sidechain('rev00001')),
    ],
  });
  const [r] = collect([root], RANGE).runs;
  assert.deepEqual([r.verdicts, r.rounds, r.durationMs], [['FAIL'], 1, 98_000]);
});

test('a helper transcript found twice, and a resumed main file, count each hand-back once', () => {
  const p = 'Review the export change';
  const helper = [prompt(3, p, sidechain('rev00002')), ...thinkingThenText(50, 'mA', 'VERDICT: FAIL findings=1 blocking=1 sha=abc1234', sidechain('rev00002'))];
  const main = [
    prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'reviewer', prompt: p }), launched(2, 't1', 'rev00002'),
    toolUse(60, 'sm1', 'SendMessage', { to: 'rev00002', message: 're-check' }),
    peerHandback(90, 'rev00002', 'PASS'),
  ];
  const root = claudeHome({
    'p/sess-1.jsonl': [...main, ...main.slice(3)], // a resumed file repeats its earlier lines
    'p/sess-1/subagents/agent-rev00002.jsonl': helper,
    'q/sess-9/subagents/agent-rev00002.jsonl': helper, // the same helper, copied elsewhere
  });
  const [r] = collect([root], RANGE).runs;
  assert.deepEqual([r.verdicts, r.rounds, r.resumes], [['FAIL'], 2, 1]);
});

test('a report sent again with no word from the parent replaces the first: one round, the later verdict', () => {
  const p = 'Review the loader';
  const root = claudeHome({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'reviewer', prompt: p }), launched(2, 't1', 'rev00003'), done(100, 't1')],
    'p/sess-1/subagents/agent-rev00003.jsonl': [
      prompt(3, p, sidechain('rev00003')),
      usage(say(49, 'FAIL\n1. loader drops a row', 'end_turn', sidechain('rev00003')), 'm1', 10, 1),
      // the user's hook asked for the VERDICT line; the same report again
      usage(say(99, 'FAIL\n1. loader drops a row\nVERDICT: FAIL findings=1 blocking=1 sha=abc1234', 'end_turn', sidechain('rev00003')), 'm2', 10, 1),
      // a real follow-up from the parent starts a second round
      fromParent(150, sidechain('rev00003')),
      usage(say(180, 'VERDICT: PASS findings=0 blocking=0 sha=def5678', 'end_turn', sidechain('rev00003')), 'm3', 10, 1),
    ],
  });
  const [r] = collect([root], RANGE).runs;
  assert.deepEqual([r.verdicts, r.rounds, r.durationMs], [['FAIL', 'PASS'], 2, 98_000]);
});

test('each review goes to the build that handed back last before the reviewer started', () => {
  const brief = (n) => `Build part ${n}. Done check: npm test`;
  const build = (id, handback) => [
    prompt(3, brief(id), sidechain(id)),
    usage(toolUse(5, `${id}e`, 'Edit', { file_path: 'x' }, sidechain(id)), `${id}m`, 10, 1),
    toolResult(6, `${id}e`, 'ok', sidechain(id)),
    usage(say(handback, 'Changed: x', 'end_turn', sidechain(id)), `${id}h`, 10, 1),
  ];
  const root = claudeHome({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'ba', 'Agent', { subagent_type: 'builder', prompt: brief('buildA1') }), launched(2, 'ba', 'buildA1'),
      toolUse(1, 'bb', 'Agent', { subagent_type: 'builder', prompt: brief('buildB2') }), launched(2, 'bb', 'buildB2'),
      // A hands back at 50 and its review starts at 55; B hands back at 70.
      toolUse(55, 'ra', 'Agent', { subagent_type: 'reviewer', prompt: 'Review A' }), toolResult(90, 'ra', 'FAIL\n1. a'),
      toolUse(75, 'rb', 'Agent', { subagent_type: 'reviewer', prompt: 'Review B' }), toolResult(95, 'rb', 'PASS'),
    ],
    'p/sess-1/subagents/agent-buildA1.jsonl': build('buildA1', 50),
    'p/sess-1/subagents/agent-buildB2.jsonl': build('buildB2', 70),
  });
  const { runs } = collect([root], RANGE);
  const a = runs.find((r) => r.agentId === 'buildA1');
  const b = runs.find((r) => r.agentId === 'buildB2');
  assert.deepEqual([a.reviewed, a.firstPass], [true, false]);
  assert.deepEqual([b.reviewed, b.firstPass], [true, true]);
});

test('a runner answering "PASS" is not made a review agent, and other agents are never "with no verdict"', () => {
  const root = claudeHome({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'r1', 'Agent', { subagent_type: 'runner', prompt: 'Run the tests' }), toolResult(20, 'r1', 'PASS, 228 tests'),
      toolUse(30, 'g1', 'Agent', { subagent_type: 'general-purpose', prompt: 'Look around' }), toolResult(40, 'g1', 'Found three loaders'),
    ],
  });
  const { runs } = collect([root], RANGE);
  assert.ok(runs.every((r) => !r.reviewAgent));
  assert.equal(summarise(runs).noVerdict, 0);
});

test('a reminder in the middle of a run does not hide that it hit its turn limit', () => {
  const p = 'Build the importer, Done check: npm test';
  const root = claudeHome({
    'p/sess-1.jsonl': [prompt(0, 'go'), toolUse(1, 't1', 'Agent', { subagent_type: 'builder', prompt: p }), launched(2, 't1', 'build0003'), done(200, 't1')],
    'p/sess-1/subagents/agent-build0003.jsonl': [
      prompt(3, p, sidechain('build0003')),
      ...[1, 2].flatMap((i) => [usage(toolUse(10 * i, `e${i}`, 'Edit', { file_path: 'x' }, sidechain('build0003')), `m${i}`, 10, 1), toolResult(10 * i + 1, `e${i}`, 'ok', sidechain('build0003'))]),
      prompt(35, '<system-reminder>a reminder</system-reminder>', sidechain('build0003')),
      ...[3, 4].flatMap((i) => [usage(toolUse(10 * i, `e${i}`, 'Edit', { file_path: 'x' }, sidechain('build0003')), `m${i}`, 10, 1), toolResult(10 * i + 1, `e${i}`, 'ok', sidechain('build0003'))]),
    ],
  }, { builder: '---\nname: builder\nmaxTurns: 4\n---\n' });
  assert.equal(collect([root], RANGE).runs[0].outcome, 'turn limit');
});

test('a review that could be for either of two builders is counted, not guessed', () => {
  const brief = (n) => `Build part ${n}. Done check: npm test`;
  const build = (id, handback) => [
    prompt(3, brief(id), sidechain(id)),
    usage(toolUse(5, `${id}e`, 'Edit', { file_path: 'x' }, sidechain(id)), `${id}m`, 10, 1),
    toolResult(6, `${id}e`, 'ok', sidechain(id)),
    usage(say(handback, 'Changed: x', 'end_turn', sidechain(id)), `${id}h`, 10, 1),
  ];
  const root = claudeHome({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'ba', 'Agent', { subagent_type: 'builder', prompt: brief('buildC1') }), launched(2, 'ba', 'buildC1'),
      toolUse(1, 'bb', 'Agent', { subagent_type: 'builder', prompt: brief('buildD2') }), launched(2, 'bb', 'buildD2'),
      // Both hand back (50, 60) before either review starts (100, 140).
      toolUse(100, 'ra', 'Agent', { subagent_type: 'reviewer', prompt: 'Review C' }), toolResult(130, 'ra', 'FAIL\n1. c'),
      toolUse(140, 'rb', 'Agent', { subagent_type: 'reviewer', prompt: 'Review D' }), toolResult(170, 'rb', 'PASS'),
    ],
    'p/sess-1/subagents/agent-buildC1.jsonl': build('buildC1', 50),
    'p/sess-1/subagents/agent-buildD2.jsonl': build('buildD2', 60),
  });
  const { runs, stats } = collect([root], RANGE);
  assert.ok(runs.filter((r) => r.type === 'builder').every((r) => !r.reviewed));
  assert.equal(stats.unplacedReviews, 2, 'the second follows the first, which could not be placed');
});

test('two reviewers on one build share it; hand-backs from no known helper are counted', () => {
  const p = 'Build the parser. Done check: npm test';
  const root = claudeHome({
    'p/sess-1.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'b1', 'Agent', { subagent_type: 'builder', prompt: p }), launched(2, 'b1', 'buildE1'),
      toolUse(60, 'r1', 'Agent', { subagent_type: 'reviewer', prompt: 'Review' }), toolResult(90, 'r1', 'PASS'),
      toolUse(61, 's1', 'Agent', { subagent_type: 'silent-failure-hunter', prompt: 'Hunt' }), toolResult(95, 's1', 'FAIL\n1. swallowed error'),
      peerHandback(200, 'nobody01', 'PASS'),
    ],
    'p/sess-1/subagents/agent-buildE1.jsonl': [
      prompt(3, p, sidechain('buildE1')),
      usage(toolUse(5, 'e1', 'Edit', { file_path: 'x' }, sidechain('buildE1')), 'm1', 10, 1),
      toolResult(6, 'e1', 'ok', sidechain('buildE1')),
      usage(say(50, 'Changed: x', 'end_turn', sidechain('buildE1')), 'm2', 10, 1),
    ],
  });
  const { runs, stats } = collect([root], RANGE);
  const b = runs.find((r) => r.type === 'builder');
  assert.deepEqual([b.reviewed, b.firstPass], [true, false], 'the hunter\'s FAIL in the same round counts');
  assert.equal(stats.unmatchedHandbacks, 1);
});
