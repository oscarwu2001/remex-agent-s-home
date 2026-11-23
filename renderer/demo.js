// Demo patients: a scripted 60-second shift that loops, in the same shape as
// the live snapshots, so the hospital can be seen without a running session.
// Everything here is made up.

import { translate, english, tr } from './i18n.js';

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

// What each tool is doing, as src/core/activity.js words it: the label's key
// (the window says it in its own language), the kind and a made-up detail.
const DETAILS = {
  Read: ['tool.read', 'read', 'resample.py'],
  Grep: ['tool.search', 'search', 'except Exception'],
  Glob: ['tool.search', 'search', '**/*.py'],
  Bash: ['tool.run', 'run', 'uv run pytest -m "not slow"'],
  Edit: ['tool.edit', 'write', 'settings.json'],
};
const said = (key, params) => ({ label: translate('en', key, params), labelKey: key, ...(params ? { labelParams: params } : {}) });

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
    status: busy ? 'working' : 'your-turn', activity: busy ? { ...said('tool.read'), kind: 'read', detail: 'notes.md' } : null,
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
  const [key, kind, detail] = DETAILS[tool];
  return { ...said(key), kind, detail };
}

// The demo's Needs attention row for its unchosen column, in the words fieldProblems builds it with.
const fieldRow = (key) => english('said.fs.row', { what: english(key, { words: english('said.fs.needsChoice', { n: 1 }), where: english('said.fs.checkWhere') }) });

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
      act = { ...said('tool.delegate', { type: live[0].type }), kind: 'delegate', detail: live[0].description };
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
      history: [{ ts: nowMs - 4000, ...said('tool.edit'), kind: 'write', detail: 'pipeline.py' }],
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
    // Two sessions in one checkout, so the warning can be seen.
    clashes: t % 60 < 30 ? [{ project: 'spine-seg', count: 2, key: 'demo-clash', ids: ['demo-a', 'demo-x'] }] : [],
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
    // The line the main process adds for the sample's unchosen column (fieldProblems).
    problems: [{ label: fieldRow('said.fs.whereOff'), labelPrivacyOff: fieldRow('said.fs.whereOn'), detail: '', count: 1, fix: 'check' },
    // The line the main process adds when an export holds lines in a format it does not know (lineProblems).
    { label: english('said.line.row', { what: english('said.lc.oddLines', { n: 2 }) }), detail: '[LINE] Sample crew.txt', count: 1 }],
    field: demoField(nowMs),
    line: demoLine(nowMs),
    usage: {
      last5h: { input: 41_000, output: 96_000, cacheRead: 2_310_000, cacheWrite: 180_000, total: 2_627_000, fresh: 317_000, replies: 214 },
      today: { input: 88_000, output: 210_000, cacheRead: 5_020_000, cacheWrite: 390_000, total: 5_708_000, fresh: 688_000, replies: 470 },
      week: { input: 402_000, output: 1_050_000, cacheRead: 26_400_000, cacheWrite: 1_900_000, total: 29_752_000, fresh: 3_352_000, replies: 2_380 },
      // The demo's plan until one is picked in Settings, and its limit hits
      // (src/core/limits.js keeps them): two 5-hour hits give an estimate
      // (about 64%), one weekly hit says the weekly one starts after 2.
      demoPlan: 'max5',
      limits: {
        paused: false,
        hits: [
          { at: nowMs - 6 * 86_400_000, plan: 'max5', window: '5h', tokens: 3_900_000 },
          { at: nowMs - 2 * 86_400_000, plan: 'max5', window: '5h', tokens: 4_300_000 },
          { at: nowMs - 9 * 86_400_000, plan: 'max5', window: 'week', tokens: 41_000_000 },
        ],
      },
    },
  };
}

// Made-up LINE items, so the section can be seen without exports: one of
// each reason, as src/core/linechat.js gives them (relatedToYou, draftTodo,
// promptDraft), in invented chats with invented people, and a group the
// LINE bot brings in (src/core/linebot.js botView), with one not ticked.
function demoLine(nowMs) {
  const pad = (n) => String(n).padStart(2, '0');
  const wall = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const min = 60_000;
  const item = (hash, ago, chat, sender, text, reason, matched, todo) => {
    const ms = Math.floor((nowMs - ago) / min) * min;
    const at = wall(ms);
    const prompt = [tr('lineprompt.instruction'), '', tr('lineprompt.info'), '',
      '```text', tr('lineprompt.chat', { chat }), tr('lineprompt.from', { sender, at }), '', text, '```'].join('\n');
    return { key: hash, hash, chat, at, ms, sender, text, reason, matched, draft: { text: todo, source: { chat, at, sender } }, prompt };
  };
  return {
    enabled: true, demo: true, folder: 'C:\\sample\\LINE exports', names: ['Sam'], keywords: ['calibration'], readCount: 3, folderError: null,
    scannedAt: nowMs - 8_000, windowDays: 14,
    chats: [
      { chat: 'Sample crew', files: 2, read: true, problems: 0, messages: 184 },
      { chat: '範例實驗室', files: 1, read: true, problems: 0, messages: 57 },
      { chat: 'Sample family', files: 1, read: false, problems: 0 },
    ],
    bot: {
      on: true, link: 'https://…/macros/s/sample-relay/exec', secretSaved: true, secretStorage: null, busy: false,
      collectedAt: nowMs - 2 * min, nextAt: nowMs + 3 * min, error: null, errorHere: null, named: true, windowDays: 14,
      groups: [
        { id: 'b07a5e1f00000001', name: 'Sample ward team', named: true, kind: 'group', read: true, lastMs: nowMs - 12 * min, count: 63, messages: 63 },
        { id: 'b07a5e1f00000002', name: 'Group 5e1f', named: false, kind: 'group', read: false, lastMs: nowMs - 180 * min, count: 9 },
      ],
    },
    items: [
      // From the bot's group: an item like any other.
      item('d0a1b2c3d4e5f604', 12 * min, 'Sample ward team', 'Alex', 'Sam, can you bring the spare tracker cable to theatre 3 this afternoon?', 'mention', 'Sam', 'bring the spare tracker cable to theatre 3 this afternoon?'),
      // Guessed long (isLong) but not cut on a wide board, so its Show all is hidden once drawn.
      item('d0a1b2c3d4e5f601', 25 * min, 'Sample crew', 'Robin', '@Sam could you check why the nightly export failed? The log says the tracker lost the probe twice, once just after the warm-up and once near the end, and the retry did not start on its own. No rush before lunch.', 'mention', 'Sam', 'check why the nightly export failed? The log says the tracker lost the probe twice.'),
      // Long enough to be cut at six lines, so its Show all can be seen.
      item('d0a1b2c3d4e5f602', 140 * min, '範例實驗室', '小華', '新的 calibration 報告在共用資料夾，週五前要回覆。請大家先看第二節的流程圖，再對照上週的會議紀錄，把需要修改的地方標出來；如果有不清楚的地方，直接在檔案裡留言就好。量測的部分我已經把原始數據整理成表格，放在同一個資料夾的子目錄裡，麻煩確認單位和小數點位數是否一致，有問題的話週四下午可以一起討論。', 'keyword', 'calibration', '新的 calibration 報告在共用資料夾，週五前要回覆'),
      item('d0a1b2c3d4e5f603', 26 * 60 * min, 'Sample crew', 'Sam', 'I’ll send the release note draft tomorrow morning', 'commitment', 'I’ll', 'I’ll send the release note draft tomorrow morning'),
    ],
  };
}

// Sample field feedback, made up and labelled as a sample on the board, so
// the section can be seen without a sheet or a key.
function demoField(nowMs) {
  const h = 3_600_000;
  const day = 24 * h;
  const at = (ms) => new Date(nowMs - ms).toISOString();
  // The columns were checked once; one added to the form since, with a
  // scale guessed from its answers, waits for the user's choice in the step
  // and stays out of the average and the score flags, as with a real sheet.
  const col = (index, header, role, extra = {}, confidence = 'high') => ({
    index, header, role, confirmed: confidence !== 'low', isNew: confidence === 'low', answers: 24, needsChoice: confidence === 'low',
    suggested: { role, confidence, ...extra }, ...extra, ...(role === 'score' && confidence !== 'low' ? { worse: false } : {}),
  });
  return {
    enabled: true, demo: true, sheetUrl: '', keyName: 'sample-key.json', clientEmail: 'sample-reader@sample-project.iam.gserviceaccount.com',
    busy: false, fetchedAt: nowMs - 2 * h, lastAttemptAt: nowMs - 2 * h, error: null, errorKind: null, errorAt: null,
    sinceFetchedAt: nowMs - 2 * day - 2 * h, tab: 'Sample responses', nextAt: nowMs + 2 * day - 2 * h,
    // One flag of each kind, as fieldFlags (src/core/fieldsurvey.js) gives them:
    // question 5's three answers of the last 7 days are lower, two of them low.
    // Question 4 is not checked, so it raises no score flag (unchecked).
    flags: {
      why: null, earlier: true, unchecked: 1,
      list: [
        { kind: 'low', index: 5, no: 5, question: 'Sample: how well did the tracking keep up? (-3..3)', low: -3, high: 3, worse: false, count: 2, mark: -2 },
        { kind: 'falling', index: 5, no: 5, question: 'Sample: how well did the tracking keep up? (-3..3)', low: -3, high: 3, worse: false, recentN: 3, recentMean: -1.7, earlierMean: 0.6 },
        { kind: 'comments', count: 2 },
        { kind: 'setup', what: 'choose', count: 1, fix: 'check' },
      ],
    },
    summary: {
      responses: 24, blankRows: 0, timestampColumn: 'Timestamp', timeZone: 'local', timeZoneUnknown: null,
      newest: at(5 * h), oldest: at(26 * day), since: at(2 * day + 9 * h), newSince: 3,
      // Checked once, with a column added since: the board's flag says so
      // and links to Settings → Check the columns.
      checked: false, saved: true, needsChoice: 1, newColumns: ['Sample: how clear was the screen in theatre?'],
      columns: [
        col(0, 'Timestamp', 'timestamp'),
        col(1, 'Email address', 'identifying', { reason: 'header' }),
        col(2, 'Your name', 'identifying', { reason: 'header' }),
        col(3, 'Sample: how easy was the setup? (-3..3)', 'score', { low: -3, high: 3, scaleFrom: 'header' }),
        col(4, 'Sample: how clear was the screen in theatre?', 'score', { low: 1, high: 5, scaleFrom: 'answers' }, 'low'),
        col(5, 'Sample: how well did the tracking keep up? (-3..3)', 'score', { low: -3, high: 3, scaleFrom: 'header' }),
        col(6, 'Sample: how many times did you restart it?', 'number', { reason: 'count' }),
        col(7, 'Sample: your role', 'choice'),
        col(8, 'Sample: what should we improve?', 'comment'),
        col(9, 'Sample: anything else?', 'comment'),
      ],
      questions: [
        { question: 'Sample: how easy was the setup? (-3..3)', index: 3, n: 24, mean: 0.2, low: -3, high: 3, scaleFrom: 'confirmed', guessed: false, confirmed: true, notChecked: false, unreadable: 0 },
        { question: 'Sample: how clear was the screen in theatre?', index: 4, n: 23, mean: 3.8, low: 1, high: 5, scaleFrom: 'answers', guessed: true, confirmed: false, notChecked: true, unreadable: 0 },
        { question: 'Sample: how well did the tracking keep up? (-3..3)', index: 5, n: 24, mean: -1.0, low: -3, high: 3, scaleFrom: 'confirmed', guessed: false, confirmed: true, notChecked: false, unreadable: 0 },
      ],
      numbers: [{ question: 'Sample: how many times did you restart it?', index: 6, n: 24, mean: 0.6, unreadable: 0 }],
      // The two checked scores only, both on −3 to 3: (0.2 × 24 + (−1.0) × 24) / 48.
      overall: { mean: -0.4, low: -3, high: 3, rescaled: false, n: 48 }, scalesGuessed: 1,
      comments: [
        { question: 'Sample: what should we improve?', text: 'Sample comment: a larger font for the distance readout.', at: at(5 * h) },
        { question: 'Sample: what should we improve?', text: 'Sample comment: the start-up check took a while.', at: at(day + 3 * h) },
        { question: 'Sample: anything else?', text: 'Sample comment: the new holder clips on easily.', at: at(4 * day) },
      ],
      commentCount: 9,
      choices: [{ question: 'Sample: your role', n: 24, answers: [{ answer: 'Surgeon', count: 11 }, { answer: 'Nurse', count: 8 }, { answer: 'Engineer', count: 5 }] }],
      identifying: ['Email address', 'Your name'], skipped: [],
      unreadable: { scores: 0, numbers: 0, timestamps: 0 }, ambiguousDates: 0,
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
