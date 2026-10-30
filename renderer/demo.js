// Demo patients: a scripted 60-second shift that loops, in the same shape as
// the live snapshots, so the hospital can be seen without a running session.
// Everything here is made up.

const LOOP_S = 60;

// [start s, end s, session, type, room, description, tools...]
const SCRIPT = [
  [2, 16, 'a', 'Explore', 'research-office', 'Map the loader modules', 'Grep', 'Read', 'Glob', 'Read'],
  [4, 30, 'a', 'reviewer', 'operating-room', 'Review the resampler change', 'Read', 'Grep', 'Bash', 'Read'],
  [7, 34, 'b', 'runner', 'laboratory', 'Run the fast test loop', 'Bash', 'Bash', 'Read'],
  [10, 38, 'b', 'silent-failure-hunter', 'radiology', 'Hunt swallowed errors', 'Grep', 'Read', 'Read'],
  [16, 42, 'a', 'ui-reviewer', 'vision-clinic', 'Check viewer contrast', 'Read', 'Grep', 'Read'],
  [20, 32, 'b', 'statusline-setup', 'general-ward', 'Tidy the status line', 'Read', 'Edit'],
  [30, 48, 'a', 'Plan', 'research-office', 'Plan the export step', 'Read', 'Glob', 'Read'],
  [36, 52, 'b', 'reviewer', 'operating-room', 'Second opinion on registration', 'Read', 'Read', 'Grep'],
];

const DETAILS = {
  Read: ['Reading a file', 'read', 'resample.py'],
  Grep: ['Searching the code', 'search', 'except Exception'],
  Glob: ['Searching the code', 'search', '**/*.py'],
  Bash: ['Running a command', 'run', 'uv run pytest -m "not slow"'],
  Edit: ['Editing a file', 'write', 'settings.json'],
};

const HERE = 'STUDIO-PC';
const SESSIONS = {
  a: { project: 'spine-seg', start: 0, source: 'code', computer: HERE },
  b: { project: 'carm-calib', start: 0, source: 'wsl', computer: `${HERE} · WSL Ubuntu` },
};

// Each demo session's to-do list, ticking along with the loop.
const TODOS = {
  a: ['Map the loader modules', 'Review the resampler change', 'Check viewer contrast', 'Plan the export step', 'Write the release note'],
  b: ['Run the fast test loop', 'Hunt swallowed errors', 'Second opinion on registration'],
};
function demoTodos(key, t) {
  const list = TODOS[key];
  const done = Math.min(list.length - 1, Math.floor((t / 60) * list.length));
  const items = list.map((text, i) => ({ text, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));
  return { items, total: items.length, done, doing: 1 };
}

// A Cowork task of the Claude app and a second computer sharing its status,
// so "Running now" has several places to show.
function coworkSession(nowMs, epochMs, t) {
  const busy = t % 30 < 22;
  return {
    id: 'demo-c', project: 'weekly-report', projectId: 'weekly-report', source: 'cowork', computer: HERE, title: 'Summarise this week',
    room: 'nurses-station', startedAt: epochMs - 3 * 60_000, lastActivityAt: nowMs, errors: 0,
    status: busy ? 'working' : 'your-turn', activity: busy ? { label: 'Reading a file', kind: 'read', detail: 'notes.md' } : null,
    tokens: demoTokens(40_000 + t * 300, 2), tokensWithHelpers: 0,
    context: { tokens: 52_000, model: 'claude-sonnet-5-5', window: 200_000, source: 'model', pct: 0.26 },
    history: [], agents: [], map: { steps: [], more: 0 },
    todos: { items: [{ text: 'Collect the logs', status: 'completed' }, { text: 'Draft the summary', active: 'Drafting the summary', status: busy ? 'in_progress' : 'completed' }, { text: 'Send to the team', status: 'pending' }], total: 3, done: busy ? 1 : 2, doing: busy ? 1 : 0 },
  };
}
const OTHER_COMPUTERS = (nowMs) => [
  { computer: 'LAB-LAPTOP', online: true, at: nowMs - 14 * 60_000, every: 3_600_000,
    jobs: [],
    work: [{ name: '-m ultralytics', project: 'garden-planner', on: 'gpu', startedAt: nowMs - 46 * 60_000, gpuMem: 20100 }, { name: 'run_sim.py', project: 'recipe-book', on: 'cpu', startedAt: nowMs - 25 * 60_000 }],
    machine: { gpus: [{ name: 'RTX 4090', util: 88, memUsed: 20100, memTotal: 24564, temp: 66 }], cpu: 22 },
    repos: [{ project: 'garden-planner', branch: 'main', lastCommit: nowMs - 2 * 3_600_000, changed: 3 }, { project: 'recipe-book', branch: 'draft', lastCommit: nowMs - 26 * 3_600_000, changed: 0 }],
    sessions: [
    { project: 'garden-planner', source: 'code', status: 'working', agents: [{ type: 'code-reviewer', status: 'working' }], todos: { done: 2, doing: 1, total: 6 } },
    { project: 'recipe-book', source: 'cowork', status: 'your-turn', agents: [] },
  ] },
];

// Skills on the live map: [second, session, name, helper type or '' for the
// session itself, how long it runs].
const SKILLS = [
  [1, 'a', 'implement', '', 1.5],
  [1, 'b', 'diagnosing-bugs', '', 2],
  [6, 'a', 'project-quality', 'reviewer', 3],
  [26, 'b', 'tdd', '', 2],
  [39, 'b', 'project-quality', 'reviewer', 3],
];

function activity(tool) {
  const [label, kind, detail] = DETAILS[tool];
  return { label, kind, detail };
}

export function demoSnapshot(nowMs, epochMs) {
  const elapsed = (nowMs - epochMs) / 1000;
  const loop = Math.floor(elapsed / LOOP_S);
  const t = elapsed % LOOP_S;
  const loopStart = epochMs + loop * LOOP_S * 1000;
  const at = (s) => loopStart + s * 1000;

  const sessions = Object.entries(SESSIONS).map(([key, s]) => {
    const agents = [];
    const steps = [];
    const skill = ([s0, , name, , len]) => ({ name, at: at(s0), active: t >= s0 && t < s0 + len });
    for (const row of SKILLS) if (row[1] === key && row[3] === '' && t >= row[0]) steps.push({ kind: 'skill', ...skill(row) });
    for (const [i, row] of SCRIPT.entries()) {
      const [start, end, sess, type, room, description, ...tools] = row;
      if (sess !== key || t < start) continue;
      const lingering = t <= end + 6;
      const done = t > end;
      const span = (end - start) / tools.length;
      const idx = Math.min(tools.length - 1, Math.floor((t - start) / span));
      const inStep = (t - start) % span;
      let status = 'working';
      if (done) status = 'done';
      else if (inStep < 1.2) status = 'thinking';
      else if (t > end - 1.5) status = 'reporting';
      else if (type === 'runner' && t > 14 && t < 19) status = 'blocked';
      const history = tools.slice(0, idx + 1).map((tool, k) => ({
        ts: at(start + k * span), ...activity(tool),
      }));
      const agent = {
        id: `demo-${loop}-${i}`,
        type,
        room,
        description,
        background: false,
        startedAt: at(start),
        lastActivityAt: at(Math.min(t, end)),
        endedAt: done ? at(end) : undefined,
        // one helper fails, so every way of finishing is on show
        endReason: done ? (type === 'statusline-setup' ? 'error' : 'finished') : undefined,
        errors: 0,
        tokens: demoTokens((Math.min(t, end) - start) * 900, i + 1),
        status,
        activity: status === 'working' || status === 'blocked' ? activity(tools[idx]) : null,
        history,
      };
      steps.push({
        kind: 'agent', ...agent, at: agent.startedAt, tokens: agent.tokens.total,
        skills: SKILLS.filter((k) => k[1] === key && k[3] === type && k[0] >= start && k[0] <= end && t >= k[0]).map(skill),
      });
      if (lingering) agents.push(agent);
    }
    steps.sort((x, y) => x.at - y.at);
    const live = agents.filter((a) => a.status !== 'done');
    let status;
    let act = null;
    if (live.length) {
      status = 'delegating';
      act = { label: `Consulting ${live[0].type}`, kind: 'delegate', detail: live[0].description };
    } else if (t % 20 < 6) {
      status = 'your-turn';
    } else {
      status = t % 4 < 1 ? 'thinking' : 'working';
      act = status === 'working' ? activity(t % 8 < 4 ? 'Edit' : 'Read') : null;
    }
    const own = demoTokens((nowMs - (epochMs - (key === 'a' ? 14 : 6) * 60_000)) / 1000 * 60, key === 'a' ? 3 : 5);
    return {
      id: `demo-${key}`,
      tokens: own,
      tokensWithHelpers: own.total + agents.reduce((n, a) => n + a.tokens.total, 0),
      // One demo session is nearly out of context, to show the warning.
      context: { tokens: key === 'a' ? 176_000 : 412_000, model: key === 'a' ? 'claude-haiku-4-5' : 'claude-opus-5-5', window: key === 'a' ? 200_000 : 1_000_000, source: 'model', pct: key === 'a' ? 0.88 : 0.412 },
      project: s.project,
      projectId: s.project,
      source: s.source,
      computer: s.computer,
      todos: demoTodos(key, t),
      room: 'nurses-station',
      startedAt: epochMs - (key === 'a' ? 14 : 6) * 60_000,
      lastActivityAt: nowMs,
      errors: 0,
      status,
      activity: act,
      history: [{ ts: nowMs - 4000, label: 'Editing a file', kind: 'write', detail: 'pipeline.py' }],
      agents,
      map: { steps, more: 0 },
    };
  });

  sessions.push(coworkSession(nowMs, epochMs, t));
  return {
    generatedAt: nowMs,
    demo: true,
    here: HERE,
    // A training run on this computer and its machine line.
    jobs: [],
    work: [{ name: 'train.py', project: 'spine-seg', on: 'gpu', startedAt: nowMs - 130 * 60_000, gpuMem: 11264 }],
    machine: { gpus: [{ name: 'RTX 2000 Ada', util: 96, memUsed: 12400, memTotal: 16380, temp: 71 }], cpu: 34, memUsed: 11200, memTotal: 16000 },
    fleet: { on: true, computers: OTHER_COMPUTERS(nowMs) },
    sources: { cowork: 1 },
    sessions,
    stats: { malformedLines: 0, unlinkedSidechains: 0 },
    watcher: { roots: [], filesTailed: 0 },
    // The demo's own staff, standing at their posts.
    roster: [
      { name: 'reviewer', room: 'operating-room', summary: 'Independent code-quality reviewer.' },
      { name: 'runner', room: 'laboratory', summary: 'Runs tests, gates and analyses.' },
      { name: 'silent-failure-hunter', room: 'radiology', summary: 'Hunts silent failures.' },
      { name: 'ui-reviewer', room: 'vision-clinic', summary: 'Independent interface reviewer.' },
    ],
    problems: [],
    usage: {
      last5h: { input: 41_000, output: 96_000, cacheRead: 2_310_000, cacheWrite: 180_000, total: 2_627_000, fresh: 317_000, replies: 214 },
      today: { input: 88_000, output: 210_000, cacheRead: 5_020_000, cacheWrite: 390_000, total: 5_708_000, fresh: 688_000, replies: 470 },
      week: { input: 402_000, output: 1_050_000, cacheRead: 26_400_000, cacheWrite: 1_900_000, total: 29_752_000, fresh: 3_352_000, replies: 2_380 },
    },
  };
}

// Made-up token counts that grow while an actor works: mostly cache reads,
// as real sessions are.
function demoTokens(size, seed) {
  const n = Math.max(0, Math.round(size));
  const input = Math.round(n * 0.02 * (1 + (seed % 3) / 10));
  const output = Math.round(n * 0.06);
  const cacheWrite = Math.round(n * 0.08);
  const cacheRead = n * 1;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
