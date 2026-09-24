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

const SESSIONS = {
  a: { project: 'spine-seg', start: 0 },
  b: { project: 'carm-calib', start: 0 },
};

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
    for (const [i, row] of SCRIPT.entries()) {
      const [start, end, sess, type, room, description, ...tools] = row;
      if (sess !== key || t < start || t > end + 6) continue;
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
      agents.push({
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
        status,
        activity: status === 'working' || status === 'blocked' ? activity(tools[idx]) : null,
        history,
      });
    }
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
    return {
      id: `demo-${key}`,
      project: s.project,
      room: 'nurses-station',
      startedAt: epochMs - (key === 'a' ? 14 : 6) * 60_000,
      lastActivityAt: nowMs,
      errors: 0,
      status,
      activity: act,
      history: [{ ts: nowMs - 4000, label: 'Editing a file', kind: 'write', detail: 'pipeline.py' }],
      agents,
    };
  });

  return {
    generatedAt: nowMs,
    demo: true,
    sessions,
    stats: { malformedLines: 0, unlinkedSidechains: 0 },
    watcher: { roots: [], filesTailed: 0 },
    roster: [],
    problems: [],
  };
}
