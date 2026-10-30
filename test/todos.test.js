'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/core/tracker');
const { T0, prompt, toolUse, toolResult, sidechain } = require('./helpers');

const MAIN = '/p/sess-1.jsonl';
const s = (sec) => T0 + sec * 1000;
const feed = (t, file, entries) => { for (const e of entries) t.ingest(file, e, Date.parse(e.timestamp)); };

test('a TodoWrite list is the session\'s to-do list, replaced on each write', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'w1', 'TodoWrite', { todos: [{ content: 'Draft intro', status: 'pending', activeForm: 'Drafting intro' }, { content: 'Check refs', status: 'pending' }] }),
    toolResult(2, 'w1'),
    toolUse(3, 'w2', 'TodoWrite', { todos: [{ content: 'Draft intro', status: 'completed' }, { content: 'Check refs', status: 'in_progress', activeForm: 'Checking refs' }] }),
  ]);
  const { todos } = t.snapshot(s(4)).sessions[0];
  assert.deepEqual([todos.total, todos.done, todos.doing], [2, 1, 1]);
  assert.equal(todos.items[1].active, 'Checking refs');
});

test('TaskCreate adds items, its result names the id, and TaskUpdate moves or deletes them', () => {
  const t = new Tracker();
  feed(t, MAIN, [
    prompt(0, 'go'),
    toolUse(1, 'c1', 'TaskCreate', { subject: 'Write parser', description: 'x' }),
    toolResult(2, 'c1', 'Task #1 created successfully: Write parser'),
    toolUse(3, 'c2', 'TaskCreate', { subject: 'Write tests', description: 'x' }),
    toolResult(4, 'c2', 'Task #2 created successfully: Write tests'),
    toolUse(5, 'u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    toolUse(6, 'u2', 'TaskUpdate', { taskId: '2', status: 'deleted' }),
    toolUse(7, 'u3', 'TaskUpdate', { taskId: '9', status: 'completed' }),
  ]);
  const { todos } = t.snapshot(s(8)).sessions[0];
  assert.deepEqual(todos.items.map((i) => [i.text, i.status]), [['Write parser', 'completed']]);
  assert.equal(todos.done, 1);
});

test('a session that never kept a list has no to-dos, and a helper\'s list stays its own', () => {
  const t = new Tracker();
  feed(t, MAIN, [prompt(0, 'go'), toolUse(1, 'r1', 'Read', { file_path: '/x' })]);
  assert.equal(t.snapshot(s(2)).sessions[0].todos, undefined);
  feed(t, MAIN, [
    toolUse(3, 'task1', 'Task', { subagent_type: 'planner', prompt: 'Plan the week for the team' }),
    prompt(4, 'Plan the week for the team', sidechain('ag1')),
    toolUse(5, 'hw', 'TodoWrite', { todos: [{ content: 'helper item', status: 'pending' }] }, sidechain('ag1')),
  ]);
  assert.equal(t.snapshot(s(6)).sessions[0].todos, undefined);
});

test('each session says where it runs, and a Cowork task takes its project from its details', () => {
  const t = new Tracker({
    sourceOf: (file) => (file.startsWith('/cowork/') ? { source: 'cowork', computer: 'pc', title: 'Tidy the notes', project: 'Notes' } : { source: 'code', computer: 'pc' }),
  });
  feed(t, MAIN, [prompt(0, 'go')]);
  feed(t, '/cowork/a/sess-2.jsonl', [prompt(0, 'go', { sessionId: 'sess-2', cwd: '/sessions/x/outputs' })]);
  const [a, b] = t.snapshot(s(1)).sessions;
  assert.deepEqual([a.source, a.project, a.computer], ['code', 'demo-project', 'pc']);
  assert.deepEqual([b.source, b.project, b.title], ['cowork', 'Notes', 'Tidy the notes']);
});

test('a Cowork task with no project in its details is called a Cowork task, not its scratch folder', () => {
  const t = new Tracker({ sourceOf: () => ({ source: 'cowork', computer: 'pc' }) });
  feed(t, '/cowork/a/sess-3.jsonl', [prompt(0, 'go', { sessionId: 'sess-3', cwd: '/sessions/x/outputs' })]);
  assert.equal(t.snapshot(s(1)).sessions[0].project, 'Cowork task');
});
