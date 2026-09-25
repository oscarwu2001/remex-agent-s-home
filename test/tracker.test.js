'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, TIMING } = require('../src/core/tracker');
const { T0, prompt, toolUse, toolResult, say, sidechain } = require('./helpers');

const MAIN = '/p/sess-1.jsonl';
const s = (sec) => T0 + sec * 1000;

function feed(tracker, file, entries) {
  for (const e of entries) tracker.ingest(file, e, Date.parse(e.timestamp));
}

test('a session reading a file is working, and names the project from cwd', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'r1', 'Read', { file_path: '/x/secret.py' })]);
  const [sess] = t.snapshot(s(2)).sessions;
  assert.equal(sess.project, 'demo-project');
  assert.equal(sess.status, 'working');
  assert.equal(sess.activity.label, 'Reading a file');
  assert.equal(sess.activity.detail, 'secret.py');
});

test('an approval-type tool that goes quiet is shown as blocked, not working', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'b1', 'Bash', { command: 'rm -rf build' })]);
  assert.equal(t.snapshot(s(1) + TIMING.approvalQuietMs - 1).sessions[0].status, 'working');
  assert.equal(t.snapshot(s(1) + TIMING.approvalQuietMs + 1).sessions[0].status, 'blocked');
});

test('a finished answer puts the session on your turn', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), say(2, 'Here you go', 'end_turn')]);
  assert.equal(t.snapshot(s(2.1)).sessions[0].status, 'your-turn');
});

test('text without a stop reason is thinking until the file goes quiet', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), say(2, 'Let me look', null)]);
  assert.equal(t.snapshot(s(3)).sessions[0].status, 'thinking');
  assert.equal(t.snapshot(s(2) + TIMING.textQuietMs + 1).sessions[0].status, 'your-turn');
});

test('a Task call spawns a helper in its room; its result sends it home', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'task1', 'Task', { subagent_type: 'reviewer', description: 'Review', prompt: 'Review the diff please' }),
  ]);
  let sess = t.snapshot(s(2)).sessions[0];
  assert.equal(sess.status, 'delegating');
  assert.deepEqual(sess.agents.map((a) => [a.type, a.room, a.status]), [['reviewer', 'operating-room', 'thinking']]);

  feed(t, MAIN, [toolResult(20, 'task1', 'PASS')]);
  sess = t.snapshot(s(21)).sessions[0];
  assert.equal(sess.agents[0].status, 'done');
  assert.equal(sess.agents[0].endReason, 'finished');
  // Gone once it has had time to walk home.
  assert.equal(t.snapshot(s(20) + TIMING.doneLingerMs + 1).sessions[0].agents.length, 0);
});

test('a sidechain file is linked to its Task call by the prompt text', () => {
  const t = new Tracker();
  const promptText = 'Run the fast test loop and report the counts please';
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'taskA', 'Task', { subagent_type: 'runner', prompt: promptText }),
    toolUse(1, 'taskB', 'Task', { subagent_type: 'Explore', prompt: 'Find the loaders in the code base please' }),
  ]);
  const SUB = '/p/sess-1/subagents/agent-abc.jsonl';
  feed(t, SUB, [
    prompt(2, promptText, sidechain('abc')),
    toolUse(3, 'in1', 'Bash', { command: 'pytest' }, sidechain('abc')),
  ]);
  const agents = t.snapshot(s(4)).sessions[0].agents;
  const runner = agents.find((a) => a.type === 'runner');
  const explore = agents.find((a) => a.type === 'Explore');
  assert.equal(runner.status, 'working');
  assert.equal(runner.activity.label, 'Running a command');
  assert.equal(explore.status, 'thinking');
});

test('a sidechain seen before its Task call is buffered, then linked', () => {
  const t = new Tracker();
  const promptText = 'Hunt for swallowed exceptions in the loader module';
  const SUB = '/p/sess-1/subagents/agent-x.jsonl';
  feed(t, SUB, [prompt(2, promptText, sidechain('x')), toolUse(3, 'g1', 'Grep', { pattern: 'except' }, sidechain('x'))]);
  feed(t, MAIN, [toolUse(1, 'taskH', 'Task', { subagent_type: 'silent-failure-hunter', prompt: promptText })]);
  const [hunter] = t.snapshot(s(4)).sessions[0].agents;
  assert.equal(hunter.room, 'radiology');
  assert.equal(hunter.activity.label, 'Searching the code');
});

test('a sidechain that matches nothing is counted, not dropped silently', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go')]);
  feed(t, '/p/sess-1/subagents/agent-q.jsonl', [prompt(1, 'orphan prompt that matches no task call at all', sidechain('q'))]);
  const snap = t.snapshot(s(1) + TIMING.unlinkedGraceMs + 1);
  assert.equal(snap.stats.unlinkedSidechains, 1);
});

test('a new prompt marks helpers still running as stopped', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'task1', 'Task', { subagent_type: 'Plan', prompt: 'plan it' }),
    prompt(5, 'never mind'),
  ]);
  const [plan] = t.snapshot(s(6)).sessions[0].agents;
  assert.equal(plan.status, 'done');
  assert.equal(plan.endReason, 'interrupted');
});

test('background helpers outlive the immediate tool result and end when quiet', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'bg', 'Agent', { subagent_type: 'runner', prompt: 'long run', run_in_background: true }),
    toolResult(1.5, 'bg', 'Launched in the background'),
  ]);
  assert.equal(t.snapshot(s(10)).sessions[0].agents[0].status, 'thinking');
  const later = t.snapshot(s(1) + TIMING.backgroundQuietMs + 1).sessions[0];
  assert.equal(later.agents[0].status, 'done');
  assert.equal(later.agents[0].endReason, 'went quiet');
});

test('sessions quiet past the stale limit leave the board', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), say(1, 'bye')]);
  assert.equal(t.snapshot(s(1) + TIMING.staleSessionMs + 1).sessions.length, 0);
});

test('malformed lines are counted with the file they came from', () => {
  const t = new Tracker();
  t.noteMalformed('/p/sess-9.jsonl', new Error('bad json'));
  const snap = t.snapshot(s(0));
  assert.equal(snap.stats.malformedLines, 1);
  assert.match(snap.stats.lastProblem, /sess-9\.jsonl: bad json/);
});

test('room overrides move an agent type', () => {
  const t = new Tracker({ overrides: { reviewer: 'general-ward' } });
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'k', 'Task', { subagent_type: 'reviewer', prompt: 'p' })]);
  assert.equal(t.snapshot(s(2)).sessions[0].agents[0].room, 'general-ward');
});

test('legacy layout: sidechain lines inside the parent file drive the helper', () => {
  const t = new Tracker();
  const p = 'Explore the loader modules and list their entry points';
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'taskE', 'Task', { subagent_type: 'Explore', prompt: p }),
    prompt(2, p, sidechain(undefined)),
    toolUse(3, 'in1', 'Glob', { pattern: '**/*.py' }, sidechain(undefined)),
  ]);
  const [sess] = t.snapshot(s(4)).sessions;
  assert.equal(sess.status, 'delegating'); // the sidechain prompt did not interrupt it
  assert.equal(sess.agents[0].status, 'working');
  assert.equal(sess.agents[0].activity.label, 'Searching the code');
});

test('progress relays drive the helper they name; unknown ones are counted', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'taskR', 'Task', { subagent_type: 'reviewer', prompt: 'r' })]);
  const relay = (sec, parent, inner) => ({
    type: 'progress', sessionId: 'sess-1', timestamp: new Date(s(sec)).toISOString(),
    parentToolUseID: parent, data: { message: inner },
  });
  feed(t, MAIN, [
    relay(2, 'taskR', toolUse(2, 'x1', 'Read', { file_path: '/a.py' })),
    relay(3, 'taskNobody', toolUse(3, 'x2', 'Read', {})),
    relay(3.5, 'taskNobody', toolUse(3.5, 'x3', 'Read', {})),
  ]);
  const snap = t.snapshot(s(4));
  assert.equal(snap.sessions[0].agents[0].activity.label, 'Reading a file');
  assert.equal(snap.stats.unmatchedRelays, 1);
});

test('without an exact prompt match a sidechain is never guessed onto a helper', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'only', 'Task', { subagent_type: 'runner', prompt: 'Run the tests' })]);
  feed(t, '/p/sess-1/subagents/agent-z.jsonl', [
    prompt(2, 'A completely different prompt that belongs to someone else', sidechain('z')),
    toolUse(3, 'b', 'Bash', { command: 'x' }, sidechain('z')),
  ]);
  const snap = t.snapshot(s(2) + TIMING.unlinkedGraceMs + 1);
  assert.equal(snap.sessions[0].agents[0].history.length, 0);
  assert.equal(snap.stats.unlinkedSidechains, 1);
});

test('a task notification ends a background helper with the right reason', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'bg1', 'Agent', { subagent_type: 'runner', prompt: 'a', run_in_background: true }),
    toolUse(1, 'bg2', 'Agent', { subagent_type: 'reviewer', prompt: 'b', run_in_background: true }),
    toolResult(1.2, 'bg1', 'launched'), toolResult(1.2, 'bg2', 'launched'),
  ]);
  const note = (sec, id, status) => ({
    ...prompt(sec, `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>`),
    origin: { kind: 'task-notification' },
  });
  feed(t, MAIN, [note(30, 'bg1', 'completed')]);
  const agents = t.snapshot(s(31)).sessions[0].agents;
  assert.deepEqual(agents.map((a) => [a.type, a.status, a.endReason]),
    [['runner', 'done', 'finished'], ['reviewer', 'thinking', undefined]]);
  feed(t, MAIN, [note(40, 'bg2', 'failed')]);
  assert.equal(t.snapshot(s(41)).sessions[0].agents.find((a) => a.type === 'reviewer').endReason, 'error');
});

test('prune keeps a session whose helper is still writing', () => {
  const t = new Tracker();
  const p = 'Review the whole registration module very carefully';
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'long', 'Task', { subagent_type: 'reviewer', prompt: p })]);
  const SUB = '/p/sess-1/subagents/agent-long.jsonl';
  feed(t, SUB, [prompt(2, p, sidechain('long'))]);
  const late = 40 * 60; // 40 minutes of helper work
  feed(t, SUB, [toolUse(late, 'r', 'Read', {}, sidechain('long'))]);
  t.prune(s(late + 1));
  const [sess] = t.snapshot(s(late + 1)).sessions;
  assert.equal(sess.agents[0].status, 'working');
  assert.equal(t.snapshot(s(late + 1)).stats.unlinkedSidechains, 0);
});

test('prune drops long-stale sessions and their unlinked counts', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go')]);
  feed(t, '/p/sess-1/subagents/agent-o.jsonl', [prompt(1, 'orphan prompt with no matching call anywhere', sidechain('o'))]);
  assert.equal(t.snapshot(s(1) + TIMING.unlinkedGraceMs + 1).stats.unlinkedSidechains, 1);
  t.prune(s(1) + TIMING.staleSessionMs * 3 + 1);
  assert.equal(t.sessions.size, 0);
  assert.equal(t.snapshot(s(1) + TIMING.staleSessionMs * 3 + 2).stats.unlinkedSidechains, 0);
});

test('entries without a timestamp are counted and do not freshen a session', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), say(1, 'done')]);
  const noTime = { ...toolUse(0, 'u', 'Read', {}) };
  delete noTime.timestamp;
  const later = s(1) + TIMING.staleSessionMs + 5_000;
  t.ingest(MAIN, noTime, later);
  const snap = t.snapshot(later + 1);
  assert.equal(snap.stats.untimedEntries, 1);
  assert.equal(snap.sessions.length, 0);
});

test('one prompt shared by helpers of different types is not guessed', () => {
  const t = new Tracker();
  const p = 'Check the registration module for problems of any kind';
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'k1', 'Task', { subagent_type: 'reviewer', prompt: p }),
    toolUse(1, 'k2', 'Task', { subagent_type: 'silent-failure-hunter', prompt: p }),
  ]);
  feed(t, '/p/sess-1/subagents/agent-s.jsonl', [prompt(2, p, sidechain('s')), toolUse(3, 'g', 'Grep', {}, sidechain('s'))]);
  const snap = t.snapshot(s(2) + TIMING.unlinkedGraceMs + 1);
  assert.ok(snap.sessions[0].agents.every((a) => a.history.length === 0));
  assert.equal(snap.stats.unlinkedSidechains, 1);
});

// An assistant line carrying usage, as Claude Code writes it: the same
// message id and usage repeated on each content block's line.
const withUsage = (entry, id, usage) => ({ ...entry, message: { ...entry.message, id, usage } });

test('tokens are counted once per reply, keeping the fullest figure', () => {
  const t = new Tracker();
  const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  const u1later = { ...u1, output_tokens: 40 };
  feed(t, MAIN, [
    prompt(0, 'go'),
    withUsage(say(1, 'thinking about it', null), 'msg-1', u1),
    withUsage(toolUse(1, 'r1', 'Read', { file_path: '/x/a.py' }), 'msg-1', u1later), // same reply, next block
    toolResult(2, 'r1'),
    withUsage(say(3, 'done'), 'msg-2', { input_tokens: 1, output_tokens: 2 }),
  ]);
  const [sess] = t.snapshot(s(4)).sessions;
  assert.deepEqual(sess.tokens, { input: 11, output: 42, cacheRead: 100, cacheWrite: 20, total: 173 });
});

test('a helper counts its own tokens, including lines seen before it was linked', () => {
  const t = new Tracker();
  const promptText = 'Hunt for swallowed exceptions in the loader module';
  const SUB = '/p/sess-1/subagents/agent-x.jsonl';
  feed(t, SUB, [
    prompt(2, promptText, sidechain('x')),
    withUsage(toolUse(3, 'g1', 'Grep', { pattern: 'except' }, sidechain('x')), 'msg-h', { input_tokens: 7, output_tokens: 3 }),
  ]);
  feed(t, MAIN, [
    withUsage(toolUse(1, 'taskH', 'Task', { subagent_type: 'silent-failure-hunter', prompt: promptText }), 'msg-m', { input_tokens: 2, output_tokens: 1 }),
  ]);
  const [sess] = t.snapshot(s(4)).sessions;
  assert.equal(sess.tokens.total, 3, 'the session counts only its own replies');
  assert.equal(sess.tokensWithHelpers, 13, 'and, separately, its helpers too');
  assert.deepEqual(sess.agents[0].tokens, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 });
});

test('a reply with usage but no id still counts, once per line', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), { ...say(1, 'hi'), message: { ...say(1, 'hi').message, usage: { output_tokens: 4 } } }]);
  assert.equal(t.snapshot(s(2)).sessions[0].tokens.total, 4);
});
