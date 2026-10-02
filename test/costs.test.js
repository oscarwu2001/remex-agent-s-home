'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, rollUp } = require('../src/core/metrics');
const costs = require('../src/core/costs');
const { T0, prompt, toolUse, toolResult, say, sidechain } = require('./helpers');

function world(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-costs-'));
  for (const [rel, entries] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  }
  return root;
}
const RANGE = { since: T0 - 1000, until: T0 + 30 * 86_400_000 };
const usage = (entry, id, input, output, cacheRead = 0, cacheWrite = 0) => ({
  ...entry,
  message: { ...entry.message, id, model: 'claude-haiku-4-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
});
const asyncResult = (s, id, agentId) => ({ ...toolResult(s, id, 'Async agent launched successfully.'), toolUseResult: { isAsync: true, status: 'async_launched', agentId } });
const doneResult = (s, id, agentId, text) => ({ ...toolResult(s, id, text), toolUseResult: { status: 'completed', agentId } });

// One invented session: /grilling launches a background general-purpose
// helper that only reads; Claude loads code-review and calls a reviewer;
// a plain prompt then launches a helper directly; one helper transcript
// matches no call at all.
function session() {
  return world({
    'p/sess-1.jsonl': [
      prompt(0, '<command-name>/grilling</command-name>'),
      toolUse(1, 'g1', 'Agent', { subagent_type: 'general-purpose', description: 'Map the loader', prompt: 'Find every loader\nthen report', run_in_background: false }),
      asyncResult(2, 'g1', 'aaa111'),
      toolUse(3, 'k1', 'Skill', { skill: 'code-review' }),
      toolUse(4, 'r1', 'Agent', { subagent_type: 'reviewer', description: 'Review it', prompt: 'Review the diff' }),
      doneResult(64, 'r1', 'bbb222', 'PASS'),
      prompt(70, 'now look at the tests'),
      toolUse(71, 'g2', 'Agent', { subagent_type: 'general-purpose', description: 'Run things', prompt: 'Run the suite' }),
      doneResult(131, 'g2', 'ccc333', 'done'),
    ],
    'p/sess-1/subagents/agent-aaa111.jsonl': [
      { ...prompt(1, 'a prompt that differs from the call', sidechain('aaa111')) },
      usage(toolUse(2, 'x1', 'Read', { file_path: 'a' }, sidechain('aaa111')), 'm1', 1000, 50, 20000, 3000),
      toolUse(3, 'x2', 'Grep', { pattern: 'b' }, sidechain('aaa111')),
      toolUse(4, 'x3', 'Skill', { skill: 'task-observer' }, sidechain('aaa111')),
      say(301, 'found them', 'end_turn', sidechain('aaa111')),
    ],
    'p/sess-1/subagents/agent-bbb222.jsonl': [
      prompt(5, 'Review the diff', sidechain('bbb222')),
      usage(toolUse(6, 'y1', 'Bash', { command: 'npm test' }, sidechain('bbb222')), 'm2', 500, 100),
    ],
    'p/sess-1/subagents/agent-ccc333.jsonl': [
      prompt(72, 'Run the suite', sidechain('ccc333')),
      usage(toolUse(73, 'z1', 'Bash', { command: 'npm test' }, sidechain('ccc333')), 'm3', 300, 30),
      toolUse(74, 'z2', 'Bash', { command: 'npm run lint' }, sidechain('ccc333')),
      toolUse(75, 'z3', 'Read', { file_path: 'x' }, sidechain('ccc333')),
      toolUse(76, 'z4', 'Bash', { command: 'git status' }, sidechain('ccc333')),
    ],
    'p/sess-1/subagents/agent-zzz999.jsonl': [
      prompt(80, 'nobody called me', sidechain('zzz999')),
      usage(say(81, 'hi', 'end_turn', sidechain('zzz999')), 'm4', 700, 70),
    ],
  });
}

test('a background helper is timed to its last transcript line, not the launch returning', () => {
  const { runs } = collect([session()], RANGE);
  const g1 = runs.find((r) => r.id === 'g1');
  assert.equal(g1.mode, 'background');
  assert.equal(g1.durationMs, 300_000, 'launch at 1s, last line at 301s');
  assert.equal(runs.find((r) => r.id === 'r1').mode, 'foreground');
});

test('helper transcripts match by agent id first, then prompt; the rest are unattributed with their tokens', () => {
  const data = collect([session()], RANGE);
  const g1 = data.runs.find((r) => r.id === 'g1');
  assert.equal(g1.linkedBy, 'agent id', 'its prompt differs, but the agent id matches');
  assert.equal(g1.tokens.cacheRead, 20000);
  assert.deepEqual(g1.tools, { Read: 1, Grep: 1, other: 1 });
  assert.equal(g1.model, 'claude-haiku-4-5');
  assert.deepEqual(data.unattributed.map((u) => [u.agentId, u.tokens.input]), [['zzz999', 700]]);
  const st = data.stats;
  assert.equal(st.helperTranscripts, 4);
  assert.equal(st.matchedByAgentId + st.matchedByPrompt + data.unattributed.length, 4, 'every transcript accounted for');
});

test('the caller is the skill running the parent turn, else direct', () => {
  const { runs } = collect([session()], RANGE);
  const by = Object.fromEntries(runs.map((r) => [r.id, r.caller]));
  assert.deepEqual(by, { g1: '/grilling', r1: '/code-review', g2: 'direct' });
});

test('descriptions and prompt lines are kept only when asked for', () => {
  const plain = collect([session()], RANGE).runs.find((r) => r.id === 'g1');
  assert.equal(plain.description, undefined);
  assert.equal(plain.promptLine, undefined);
  const detailed = collect([session()], { ...RANGE, details: true }).runs.find((r) => r.id === 'g1');
  assert.deepEqual([detailed.description, detailed.promptLine], ['Map the loader', 'Find every loader']);
});

test('a run with no recorded end is counted apart and left out of the times', () => {
  const root = world({
    'p/s.jsonl': [prompt(0, 'go'), toolUse(1, 'b1', 'Agent', { subagent_type: 'runner', prompt: 'x' }), asyncResult(2, 'b1', 'nope00')],
  });
  const { runs } = collect([root], RANGE);
  assert.equal(runs[0].durationMs, undefined);
  const roll = rollUp({ runs, sessions: [] });
  assert.equal(roll.overall.runner.noEnd, 1);
  assert.equal(roll.overall.runner.medianMs, undefined);
});

test('could-have-been-typed flags come from the tool mix', () => {
  assert.equal(costs.typedAgentFor({ Read: 6, Grep: 3, Glob: 1 }), 'Explore');
  assert.equal(costs.typedAgentFor({ Read: 6, Edit: 1 }), undefined, 'edits need general-purpose');
  assert.equal(costs.typedAgentFor({ WebFetch: 4, WebSearch: 3, Read: 1 }), 'researcher');
  assert.equal(costs.typedAgentFor({ Bash: 3, Read: 1 }), 'runner');
  assert.equal(costs.typedAgentFor({ Bash: 2, Read: 2 }), undefined);
  assert.equal(costs.typedAgentFor({}), undefined);
});

test('where general-purpose goes: callers with token share, flags and the most expensive runs', () => {
  const { runs } = collect([session()], RANGE);
  const gp = costs.generalPurpose(runs);
  assert.deepEqual(gp.byCaller.map((c) => c.caller), ['/grilling', 'direct'], 'most tokens first');
  assert.ok(Math.abs(gp.byCaller.reduce((n, c) => n + c.share, 0) - 1) < 1e-9);
  assert.deepEqual(gp.flags.map((f) => f.flag), ['Explore', 'runner']);
  assert.equal(gp.expensive[0].id, 'g1');
});

test('cost weighting counts a cache read as a tenth of fresh input', () => {
  assert.equal(costs.weighted({ input: 1000, cacheRead: 10000, cacheWrite: 0, output: 0 }), 2000);
  assert.equal(costs.weighted({ input: 0, cacheRead: 0, cacheWrite: 100, output: 100 }), 625);
  const rows = costs.tokensByAgent(collect([session()], RANGE).runs, [{ tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  assert.equal(rows.at(-1).name, 'unattributed');
  assert.equal(rows.at(-1).total, 7);
});

test('skills: names without plugin prefix, sources, duplicates, and sizes for loads in helpers', () => {
  const claude = world({
    'skills/tdd/SKILL.md': ['local tdd'],
    'skills/task-observer/SKILL.md': ['x'.repeat(33_000)],
    'plugins/marketplaces/m/plugins/mattpocock-skills/skills/tdd/SKILL.md': ['plugin tdd'],
    'plugins/cache/m/mattpocock-skills/1.2.0/skills/tdd/SKILL.md': ['plugin tdd'],
    'plugins/cache/m/other/1.0.0/skills/grill/SKILL.md': ['grill'],
  });
  const project = world({ '.claude/skills/project-quality/SKILL.md': ['pq'] });
  const { skills } = costs.readSkillSources({ claudeDirs: [claude], cwds: [project], enabledPlugins: ['mattpocock-skills@m'] });
  const rows = costs.skillSourceRows(skills);
  const tdd = rows.find((r) => r.name === 'tdd');
  assert.equal(tdd.duplicate, true, 'local and an enabled plugin');
  assert.deepEqual(tdd.sources.map((s) => `${s.source}:${s.owner}`).sort(), ['local:you', 'plugin:mattpocock-skills'], 'one plugin copy despite two folders');
  assert.equal(rows.find((r) => r.name === 'grill').duplicate, false, 'a disabled plugin makes no duplicate');
  assert.equal(rows.find((r) => r.name === 'project-quality').sources[0].source, 'project');
  assert.equal(costs.baseSkill('mattpocock-skills:tdd'), 'tdd');
  const runs = [{ type: 'reviewer', start: 10, skillLoads: ['task-observer', 'mattpocock-skills:tdd'] }, { type: 'reviewer', start: 30, skillLoads: ['task-observer'] }];
  const loads = costs.skillLoadsInHelpers(runs, [], skills, 20);
  const to = loads.find((l) => l.skill === 'task-observer');
  assert.deepEqual([to.loads, to.before, to.after, to.bytesEach], [2, 1, 1, 33_001]);
  assert.equal(loads.find((l) => l.skill === 'tdd').bytesEach, 11, 'the plugin named in the load');
});

test('weeks that mix foreground and background runs are not scored', () => {
  const mk = (i, mode) => ({ type: 'runner', start: T0 + i * 1000, mode, outcome: 'finished', durationMs: 1000, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, linked: true, toolCalls: 0, toolErrors: 0 });
  const roll = rollUp({ runs: [mk(1, 'foreground'), mk(2, 'background'), mk(3, 'foreground')], sessions: [] });
  assert.match(roll.weekly[0].score.reason, /mixes foreground and background/);
});

test('before and after a date', () => {
  const r = (type, start, input) => ({ type, start, durationMs: 1000, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, skillLoads: ['a'] });
  const cmp = costs.compareAt([r('x', 1, 10), r('x', 5, 20), r('x', 9, 40)], [{ start: 2 }], 5);
  assert.deepEqual([cmp.rows[0].before.runs, cmp.rows[0].after.runs, cmp.rows[0].after.tokens], [1, 2, 60]);
  assert.deepEqual(cmp.unattributed, { before: 1, after: 0 });
});

test('a helper seen inline and in its own file is one helper, and prompts never match across agent ids', () => {
  const root = world({
    'p/s.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'a1', 'Agent', { subagent_type: 'Explore', prompt: 'Same words' }),
      doneResult(30, 'a1', 'idA', 'done'),
      toolUse(31, 'a2', 'Agent', { subagent_type: 'Explore', prompt: 'Same words' }),
      doneResult(60, 'a2', 'idB', 'done'),
      // inline copy of one of helper A's replies
      usage(say(3, 'looking', null, sidechain('idA')), 'mA', 100, 10),
    ],
    'p/s/subagents/agent-idA.jsonl': [prompt(2, 'Same words', sidechain('idA')), usage(say(3, 'looking', null, sidechain('idA')), 'mA', 100, 10), say(29, 'ok', 'end_turn', sidechain('idA'))],
    'p/s/subagents/agent-idB.jsonl': [prompt(32, 'Same words', sidechain('idB')), usage(say(59, 'ok', 'end_turn', sidechain('idB')), 'mB', 200, 20)],
  });
  const data = collect([root], RANGE);
  assert.equal(data.stats.helperTranscripts, 2, 'helper A once, though it appears in two files');
  assert.deepEqual(data.unattributed, []);
  const by = Object.fromEntries(data.runs.map((r) => [r.id, [r.linkedBy, r.tokens.input]]));
  assert.deepEqual(by, { a1: ['agent id', 100], a2: ['agent id', 200] });
});
