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
