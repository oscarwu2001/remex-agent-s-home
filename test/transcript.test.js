'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, eventsFromEntry, MalformedLineError } = require('../src/core/transcript');
const { T0, prompt, toolUse, toolResult, say } = require('./helpers');

test('blank lines parse to null, broken JSON throws a typed error', () => {
  assert.equal(parseLine('   '), null);
  assert.throws(() => parseLine('{"type": "user"'), MalformedLineError);
  assert.throws(() => parseLine('42'), MalformedLineError);
});

test('a Task call becomes a task-start with its agent type', () => {
  const entry = toolUse(3, 'toolu_1', 'Task', {
    subagent_type: 'reviewer', description: 'Review the parser', prompt: 'Please review',
  });
  const { meta, events } = eventsFromEntry(entry);
  assert.equal(meta.sessionId, 'sess-1');
  assert.equal(meta.cwd, '/work/demo-project');
  assert.deepEqual(events, [{
    kind: 'task-start', id: 'toolu_1', name: 'Task',
    input: { subagent_type: 'reviewer', description: 'Review the parser', prompt: 'Please review' },
    ts: T0 + 3000, via: undefined,
    subagentType: 'reviewer', description: 'Review the parser', prompt: 'Please review', background: false,
  }]);
});

test('the newer Agent tool name is recognised, and a missing type means general-purpose', () => {
  const { events } = eventsFromEntry(toolUse(1, 'toolu_2', 'Agent', { prompt: 'x' }));
  assert.equal(events[0].kind, 'task-start');
  assert.equal(events[0].subagentType, 'general-purpose');
});

test('tool results carry their id, error flag and text', () => {
  const { events } = eventsFromEntry(toolResult(5, 'toolu_1', 'boom', undefined, true));
  assert.deepEqual(events.map((e) => [e.kind, e.id, e.isError, e.text]), [['tool-end', 'toolu_1', true, 'boom']]);
});

test('plain text from the assistant keeps its stop reason', () => {
  const { events } = eventsFromEntry(say(9, 'All done', 'end_turn'));
  assert.deepEqual(events.map((e) => [e.kind, e.stopReason]), [['assistant-text', 'end_turn']]);
});

test('a typed prompt is a user-prompt; meta user lines are not', () => {
  assert.equal(eventsFromEntry(prompt(0, 'hello')).events[0].kind, 'user-prompt');
  const meta = { ...prompt(0, 'caveat'), isMeta: true };
  assert.deepEqual(eventsFromEntry(meta).events, []);
});

test('progress entries relay sub-agent tool calls with the Task id attached', () => {
  const entry = {
    type: 'progress', sessionId: 'sess-1', timestamp: new Date(T0).toISOString(), parentToolUseID: 'toolu_task',
    data: { message: toolUse(2, 'toolu_inner', 'Read', { file_path: '/a/b.py' }) },
  };
  const { events } = eventsFromEntry(entry);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool-start');
  assert.equal(events[0].via, 'toolu_task');
  assert.equal(events[0].ts, T0 + 2000);
});

test('unknown entry types are proof of life only', () => {
  const { events } = eventsFromEntry({ type: 'attachment', timestamp: new Date(T0).toISOString() });
  assert.deepEqual(events, [{ kind: 'activity', ts: T0 }]);
});
