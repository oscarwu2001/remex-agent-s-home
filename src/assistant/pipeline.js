'use strict';

// Runs one Assistant-mode task through the team: triage picks a specialist,
// the specialist answers (streamed, so the answer appears as it is written),
// and the checker looks it over when the level calls for it. The Anthropic
// client is passed in, so tests run with a stand-in and spend nothing.

const { TRIAGE_MODEL, WORK_MODEL, LEVELS, SPECIALISTS, SKILLS, TRIAGE, CHECKER, costOf } = require('./team');
const { roomFor } = require('../core/rooms');

const cached = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addUsage(tokens, u) {
  if (!u) return;
  tokens.input += Number(u.input_tokens) || 0;
  tokens.output += Number(u.output_tokens) || 0;
  tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
  tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

// Plain words for what went wrong. `sdk` is the Anthropic module, whose
// typed errors carry an HTTP status.
function explain(err, sdk) {
  if (err?.name === 'AbortError' || (sdk?.APIUserAbortError && err instanceof sdk.APIUserAbortError)) return { stopped: true, message: 'Stopped.' };
  if (sdk?.APIConnectionError && err instanceof sdk.APIConnectionError) {
    return { message: 'Could not reach Anthropic. Check the internet connection (or proxy) and try again.' };
  }
  if (sdk?.APIError && err instanceof sdk.APIError) {
    switch (err.status) {
      case 401: return { message: 'The API key was not accepted. Check it in Settings → Assistant.' };
      case 403: return { message: 'This API key is not allowed to use these models. Check your Anthropic account.' };
      case 402: return { message: 'Your Anthropic account has no credit left. Add credit in the Anthropic Console.' };
      case 429: return { message: 'Too many requests at once for this key. Wait a minute and try again.' };
      case 400: return { message: `Anthropic could not accept this task: ${err.message}` };
      default:
        if (err.status >= 500) return { message: 'Anthropic is busy or having trouble. Try again in a moment.' };
        return { message: `Anthropic answered with an error (${err.status}): ${err.message}` };
    }
  }
  return { message: `The task did not complete: ${err?.message ?? err}` };
}

function newJob({ id, text, level, skill }, now) {
  return {
    id, text, level, skill, title: '', status: 'triage', startedAt: now, endedAt: undefined,
    turns: [{ role: 'user', text }], agent: undefined, system: undefined,
    specialist: undefined, needsCheck: false, answer: '', note: '', error: '', checkerChanged: false,
    steps: [], tokens: emptyTokens(), cost: 0,
  };
}

function startStep(job, agent, model, now) {
  const step = { agent, model, status: 'running', startedAt: now, endedAt: undefined, tokens: emptyTokens(), cost: 0 };
  job.steps.push(step);
  return step;
}

function endStep(job, step, usage, now, status = 'done') {
  addUsage(step.tokens, usage);
  addUsage(job.tokens, usage);
  step.cost = costOf(step.model, usage);
  job.cost += step.cost;
  step.status = status;
  step.endedAt = now;
}

// The specialist (or skill agent) answers the conversation so far, streamed.
async function answer(job, L, { client, onUpdate, opts, now }) {
  const step = startStep(job, job.specialist, WORK_MODEL, now());
  job.answer = '';
  const stream = client.messages.stream({
    model: WORK_MODEL,
    max_tokens: L.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: L.effort },
    system: cached(job.system),
    messages: job.turns.map((t) => ({ role: t.role, content: t.text })),
  }, opts);
  stream.on('text', (delta) => {
    job.answer += delta;
    onUpdate(job);
  });
  const reply = await stream.finalMessage();
  endStep(job, step, reply.usage, now());
  if (reply.stop_reason === 'refusal') throw Object.assign(new Error('The assistant declined this task.'), { plain: true });
  job.answer = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  job.note = reply.stop_reason === 'max_tokens' ? 'The answer reached this level\'s length limit and may be cut short. Try Deep for longer work.' : '';
  return step;
}

function fail(job, err, sdk, now) {
  const running = job.steps.find((x) => x.status === 'running');
  if (running) endStep(job, running, undefined, now(), 'error');
  const why = err?.plain ? { message: err.message } : explain(err, sdk);
  job.status = why.stopped ? 'stopped' : 'error';
  job.error = why.message;
}

async function runTask(input, { client, sdk, onUpdate = () => {}, signal, now = () => Date.now() }) {
  const level = LEVELS[input.level] ? input.level : 'standard';
  const L = LEVELS[level];
  const job = newJob({ ...input, level }, now());
  const opts = signal ? { signal } : undefined;
  let step;
  onUpdate(job);
  try {
    const skill = input.skill ? SKILLS.find((k) => k.id === input.skill) : undefined;
    if (input.skill && !skill) throw Object.assign(new Error(`There is no skill called "${input.skill}".`), { plain: true });
    if (skill) {
      // The user chose how to work: no triage needed.
      job.specialist = skill.agent;
      job.system = skill.system;
      job.title = skill.name;
    } else {
      // 1. Triage: one small call that must answer with the route tool.
      step = startStep(job, 'triage', TRIAGE_MODEL, now());
      const t = await client.messages.create({
        model: TRIAGE_MODEL,
        max_tokens: 400,
        system: cached(TRIAGE.system),
        tools: [TRIAGE.tool],
        tool_choice: { type: 'tool', name: TRIAGE.tool.name },
        messages: [{ role: 'user', content: job.text }],
      }, opts);
      endStep(job, step, t.usage, now());
      if (t.stop_reason === 'refusal') throw Object.assign(new Error('Triage declined this task.'), { plain: true });
      const route = t.content.find((b) => b.type === 'tool_use' && b.name === TRIAGE.tool.name)?.input;
      const specialist = SPECIALISTS.find((x) => x.id === route?.specialist);
      if (!specialist) throw Object.assign(new Error('Triage did not choose a teammate. Try rewording the task.'), { plain: true });
      job.specialist = specialist.id;
      job.system = specialist.system;
      job.needsCheck = route.needs_check === true;
      job.title = String(route.title ?? '').trim().slice(0, 60) || 'Task';
    }
    job.status = 'working';
    onUpdate(job);

    // 2. The specialist writes the answer.
    await answer(job, L, { client, onUpdate, opts, now });

    // 3. The checker, when the level calls for it.
    const conversational = SKILLS.find((k) => k.id === job.skill)?.conversational;
    if (!conversational && (L.check === 'always' || (L.check === 'when-needed' && job.needsCheck))) {
      job.status = 'checking';
      onUpdate(job);
      step = startStep(job, CHECKER.id, WORK_MODEL, now());
      const c = await client.messages.create({
        model: WORK_MODEL,
        max_tokens: L.maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: L.effort },
        system: cached(CHECKER.system),
        messages: [{ role: 'user', content: `The user's task:\n${job.text}\n\nThe draft answer:\n${job.answer}` }],
      }, opts);
      endStep(job, step, c.usage, now());
      const verdict = c.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      // A declined or cut-off check leaves the draft as it was, and says so.
      if (c.stop_reason === 'refusal' || c.stop_reason === 'max_tokens') {
        job.note = [job.note, 'The checker could not finish its look over this answer.'].filter(Boolean).join(' ');
      } else if (verdict && verdict !== 'OK') {
        job.answer = verdict;
        job.checkerChanged = true;
      }
    }
    job.turns.push({ role: 'assistant', text: job.answer });
    job.status = 'done';
  } catch (err) {
    fail(job, err, sdk, now);
  }
  job.endedAt = now();
  onUpdate(job);
  return job;
}

// A reply or follow-up: the same agent carries on the same conversation.
// No triage and no checker: the user is steering now.
async function continueTask(job, text, { client, sdk, onUpdate = () => {}, signal, now = () => Date.now() }) {
  const L = LEVELS[job.level] ?? LEVELS.standard;
  const opts = signal ? { signal } : undefined;
  job.turns.push({ role: 'user', text });
  job.status = 'working';
  job.error = '';
  job.endedAt = undefined;
  onUpdate(job);
  try {
    await answer(job, L, { client, onUpdate, opts, now });
    job.turns.push({ role: 'assistant', text: job.answer });
    job.status = 'done';
  } catch (err) {
    // The reply that got no answer is taken back out, so sending it again
    // does not put it in the conversation twice.
    if (job.turns.at(-1)?.role === 'user') job.turns.pop();
    fail(job, err, sdk, now);
  }
  job.endedAt = now();
  onUpdate(job);
  return job;
}

// ---- how a task looks on the board and in the hospital ----------------------

const LINGER_MS = 7_000; // a finished helper walks home, as in Monitor mode

const ACTIVITY = {
  writer: { label: 'Writing a draft', kind: 'write' },
  summariser: { label: 'Reading and summarising', kind: 'read' },
  planner: { label: 'Making a plan', kind: 'write' },
  'data-helper': { label: 'Working with the numbers', kind: 'run' },
  helper: { label: 'Working on an answer', kind: 'write' },
  checker: { label: 'Checking the answer', kind: 'read' },
};

function tokensWithTotal(t) {
  return { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite };
}

// A job as a session with helpers, the shape the renderer already draws.
function toSession(job, nowMs) {
  const agents = job.steps
    .filter((s) => s.agent !== 'triage')
    .filter((s) => s.status === 'running' || nowMs - s.endedAt < LINGER_MS)
    .map((s) => ({
      id: `${job.id}-${s.agent}`,
      type: s.agent,
      room: roomFor(s.agent),
      description: '',
      background: false,
      startedAt: s.startedAt,
      lastActivityAt: s.endedAt ?? nowMs,
      endedAt: s.endedAt,
      endReason: s.status === 'error' ? 'error' : s.status === 'done' ? 'finished' : undefined,
      errors: s.status === 'error' ? 1 : 0,
      status: s.status === 'running' ? 'working' : 'done',
      activity: s.status === 'running' ? ACTIVITY[s.agent] : null,
      history: [],
      tokens: tokensWithTotal(s.tokens),
    }));
  const running = job.steps.find((s) => s.status === 'running' && s.agent !== 'triage');
  const triage = job.steps.find((s) => s.agent === 'triage');
  let status;
  let activity = null;
  if (job.status === 'triage') {
    status = 'working';
    activity = { label: 'Reading your task', kind: 'read' };
  } else if (running) {
    status = 'delegating';
    activity = { label: `With ${running.agent}`, kind: 'delegate' };
  } else if (job.status === 'error') {
    status = 'your-turn';
  } else {
    status = job.status === 'done' || job.status === 'stopped' ? 'your-turn' : 'thinking';
  }
  return {
    id: `job-${job.id}`,
    project: job.title || 'New task',
    room: 'nurses-station',
    startedAt: job.startedAt,
    lastActivityAt: job.endedAt ?? nowMs,
    errors: job.status === 'error' ? 1 : 0,
    status,
    activity,
    history: [],
    tokens: triage ? tokensWithTotal(triage.tokens) : emptyTokens(),
    tokensWithHelpers: job.tokens.total,
    agents,
  };
}

module.exports = { runTask, continueTask, toSession, explain, LINGER_MS };
