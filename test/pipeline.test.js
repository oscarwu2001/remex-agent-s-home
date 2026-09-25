'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runTask, toSession, explain } = require('../src/assistant/pipeline');

// A stand-in for the Anthropic client: scripted replies, every request kept.
function fakeClient({ route = { specialist: 'writer', needs_check: false, title: 'Reply to supplier' }, answer = 'Dear team, thank you.', verdict = 'OK', stop = 'end_turn', fail } = {}) {
  const calls = [];
  const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  return {
    calls,
    messages: {
      async create(params) {
        calls.push({ kind: 'create', params });
        if (fail) throw fail;
        if (params.tools) {
          return { stop_reason: 'tool_use', usage: usage(300, 20), content: [{ type: 'tool_use', name: 'route', input: route }] };
        }
        return { stop_reason: 'end_turn', usage: usage(500, 10), content: [{ type: 'text', text: verdict }] };
      },
      stream(params) {
        calls.push({ kind: 'stream', params });
        const s = new EventEmitter();
        s.finalMessage = async () => {
          for (const part of answer.match(/.{1,8}/gs)) s.emit('text', part, '');
          return { stop_reason: stop, usage: usage(400, 120), content: [{ type: 'text', text: answer }] };
        };
        return s;
      },
    },
  };
}

let clock = 1_000;
const now = () => (clock += 100);

test('triage picks a specialist with a small, forced tool call, then the specialist answers', async () => {
  const client = fakeClient();
  const job = await runTask({ id: 't1', text: 'Write a thank-you note to our supplier', level: 'quick' }, { client, now });
  assert.equal(job.status, 'done');
  assert.equal(job.specialist, 'writer');
  assert.equal(job.title, 'Reply to supplier');
  assert.equal(job.answer, 'Dear team, thank you.');
  const [triage, work] = client.calls;
  assert.equal(triage.params.model, 'claude-haiku-4-5');
  assert.deepEqual(triage.params.tool_choice, { type: 'tool', name: 'route' });
  assert.equal(triage.params.tools[0].strict, true);
  assert.equal(work.params.model, 'claude-sonnet-5');
  assert.deepEqual(work.params.output_config, { effort: 'low' });
  assert.deepEqual(work.params.thinking, { type: 'adaptive' });
  assert.equal(client.calls.length, 2, 'Quick never calls the checker');
});

test('the three levels set effort and when the checker runs', async () => {
  const std = fakeClient({ route: { specialist: 'planner', needs_check: false, title: 'Plan' } });
  await runTask({ id: 't2', text: 'Plan my week', level: 'standard' }, { client: std, now });
  assert.deepEqual(std.calls[1].params.output_config, { effort: 'medium' });
  assert.equal(std.calls.length, 2, 'Standard skips the checker when triage says it is not needed');

  const stdCheck = fakeClient({ route: { specialist: 'data-helper', needs_check: true, title: 'Budget' } });
  await runTask({ id: 't3', text: 'Total these costs', level: 'standard' }, { client: stdCheck, now });
  assert.equal(stdCheck.calls.length, 3, 'Standard checks when triage asks for it');

  const deep = fakeClient({ verdict: 'Dear team, many thanks.' });
  const job = await runTask({ id: 't4', text: 'Write a note', level: 'deep' }, { client: deep, now });
  assert.deepEqual(deep.calls[1].params.output_config, { effort: 'high' });
  assert.equal(deep.calls.length, 3, 'Deep always checks');
  assert.equal(job.answer, 'Dear team, many thanks.', 'a corrected answer replaces the draft');
  assert.equal(job.checkerChanged, true);
});

test('an unknown level falls back to Standard', async () => {
  const client = fakeClient();
  const job = await runTask({ id: 't5', text: 'hi', level: 'turbo' }, { client, now });
  assert.equal(job.level, 'standard');
});

test('the answer streams in, and tokens and cost add up across the calls', async () => {
  const client = fakeClient({ answer: 'A fairly long answer that arrives in pieces.' });
  const seen = [];
  const job = await runTask({ id: 't6', text: 'Summarise this', level: 'quick' }, { client, now, onUpdate: (j) => seen.push(j.answer) });
  assert.ok(seen.some((a) => a.length > 0 && a.length < job.answer.length), 'partial answers were shown');
  assert.deepEqual(job.tokens, { input: 700, output: 140, cacheRead: 0, cacheWrite: 0, total: 840 });
  // Haiku 300 in / 20 out at $1/$5, Sonnet 5 400 in / 120 out at $2/$10.
  assert.ok(Math.abs(job.cost - (300 * 1 + 20 * 5 + 400 * 2 + 120 * 10) / 1e6) < 1e-12);
});

test('a cut-off answer is kept and says so', async () => {
  const job = await runTask({ id: 't7', text: 'Write a long report', level: 'quick' }, { client: fakeClient({ stop: 'max_tokens' }), now });
  assert.equal(job.status, 'done');
  assert.match(job.note, /length limit/);
});

test('triage that picks no teammate is an error, never a guess', async () => {
  const job = await runTask({ id: 't8', text: 'x', level: 'quick' }, { client: fakeClient({ route: { specialist: 'astrologer', needs_check: false, title: 't' } }), now });
  assert.equal(job.status, 'error');
  assert.match(job.error, /did not choose a teammate/);
});

test('API failures become plain words', async () => {
  class APIError extends Error { constructor(status, m) { super(m); this.status = status; } }
  class APIConnectionError extends APIError {}
  class APIUserAbortError extends APIError {}
  const sdk = { APIError, APIConnectionError, APIUserAbortError };
  assert.match(explain(new APIError(401, 'invalid x-api-key'), sdk).message, /API key was not accepted/);
  assert.match(explain(new APIError(429, 'rate'), sdk).message, /Too many requests/);
  assert.match(explain(new APIError(529, 'overloaded'), sdk).message, /busy/);
  assert.match(explain(new APIConnectionError(undefined, 'ECONNRESET'), sdk).message, /Could not reach Anthropic/);
  assert.equal(explain(new APIUserAbortError(undefined, 'aborted'), sdk).stopped, true);
  const job = await runTask({ id: 't9', text: 'x', level: 'quick' }, { client: fakeClient({ fail: new APIError(401, 'bad key') }), sdk, now });
  assert.equal(job.status, 'error');
  assert.match(job.error, /API key/);
  assert.equal(job.steps[0].status, 'error');
});

test('a running task shows as a session with its specialist in the right room', async () => {
  let snap;
  const client = fakeClient({ route: { specialist: 'summariser', needs_check: false, title: 'Summary' } });
  const originalStream = client.messages.stream;
  client.messages.stream = (p) => {
    const s = originalStream(p);
    const fm = s.finalMessage;
    s.finalMessage = async () => { snap = { ...job(), steps: job().steps.map((x) => ({ ...x })) }; return fm(); };
    return s;
  };
  let current;
  const job = () => current;
  await runTask({ id: 't10', text: 'Summarise', level: 'quick' }, { client, now, onUpdate: (j) => { current = j; } });
  const session = toSession(snap, clock);
  assert.equal(session.status, 'delegating');
  assert.equal(session.agents[0].type, 'summariser');
  assert.equal(session.agents[0].room, 'radiology');
  assert.equal(session.agents[0].status, 'working');
  const done = toSession(current, clock);
  assert.equal(done.status, 'your-turn');
  assert.equal(done.tokensWithHelpers, current.tokens.total);
});

const { continueTask } = require('../src/assistant/pipeline');

test('picking a skill skips triage and uses that skill\'s agent and instructions', async () => {
  const client = fakeClient({ answer: '**Q1. Who attends?** → Suggested answer: the whole team.' });
  const job = await runTask({ id: 's1', text: 'Move the weekly meeting to Monday', level: 'deep', skill: 'question-me' }, { client, now });
  assert.equal(client.calls.length, 1, 'no triage and, for a conversation, no checker even on Deep');
  assert.equal(client.calls[0].kind, 'stream');
  assert.match(client.calls[0].params.system[0].text, /You are the Coach/);
  assert.equal(job.specialist, 'coach');
  assert.equal(job.title, 'Question me');
  assert.deepEqual(job.turns.map((t) => t.role), ['user', 'assistant']);
});

test('an unknown skill is refused, not guessed', async () => {
  const job = await runTask({ id: 's2', text: 'x', level: 'quick', skill: 'graphify' }, { client: fakeClient(), now });
  assert.equal(job.status, 'error');
  assert.match(job.error, /skill/);
});

test('a reply continues the same conversation with the same agent', async () => {
  const client = fakeClient({ answer: 'Lesson 1 ...' });
  const job = await runTask({ id: 's3', text: 'Teach me pivot tables', level: 'standard', skill: 'teach-me' }, { client, now });
  const before = job.tokens.total;
  await continueTask(job, 'I want it for monthly reports', { client, now });
  const last = client.calls.at(-1).params;
  assert.match(last.system[0].text, /You are the Teacher/);
  assert.deepEqual(last.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(last.messages[2].content, 'I want it for monthly reports');
  assert.deepEqual(job.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(job.status, 'done');
  assert.ok(job.tokens.total > before, 'tokens keep adding up');
});

test('a follow-up works after an automatic task too', async () => {
  const client = fakeClient({ route: { specialist: 'writer', needs_check: false, title: 'Email' } });
  const job = await runTask({ id: 's4', text: 'Write an email', level: 'quick' }, { client, now });
  await continueTask(job, 'Make it shorter', { client, now });
  assert.match(client.calls.at(-1).params.system[0].text, /You are the Writer/);
  assert.equal(job.turns.length, 4);
});
