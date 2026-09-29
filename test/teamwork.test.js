'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect } = require('../src/core/metrics');
const { teamwork, readInventory } = require('../src/core/teamwork');
const { T0, prompt, toolUse, toolResult, sidechain } = require('./helpers');

function world(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-'));
  for (const [rel, entries] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  }
  return root;
}
const RANGE = { since: T0 - 1000, until: T0 + 86_400_000 };
const inv = (agents, skills) => ({ agents: new Set(agents), skills: new Set(skills) });

// One invented session: the user types /implement, Claude calls the
// reviewer (FAIL), then the reviewer again (PASS); the reviewer itself runs
// the quality skill. Claude also types-out /clear, a built-in command.
function session() {
  const p1 = 'Review the change';
  const p2 = 'Review it again';
  return world({
    'p/sess-1.jsonl': [
      prompt(0, '<command-name>/clear</command-name>'),
      prompt(1, '<command-message>implement</command-message><command-name>/implement</command-name><command-args>secret args</command-args>'),
      toolUse(2, 'k1', 'Skill', { skill: 'tdd', args: 'never shown' }),
      toolResult(3, 'k1', 'loaded'),
      toolUse(4, 'r1', 'Task', { subagent_type: 'reviewer', prompt: p1 }),
      toolResult(60, 'r1', 'FAIL\n\n1. a finding'),
      toolUse(61, 'r2', 'Task', { subagent_type: 'reviewer', prompt: p2 }),
      toolResult(120, 'r2', 'PASS'),
    ],
    'p/sess-1/subagents/agent-a.jsonl': [
      prompt(5, p1, sidechain('a')),
      toolUse(6, 'q1', 'Skill', { skill: 'project-quality' }, sidechain('a')),
      toolResult(7, 'q1', 'no such skill', sidechain('a'), true),
    ],
  });
}

test('skill uses are counted by who ran them, names only', () => {
  const data = collect([session()], RANGE);
  const names = data.skills.map((u) => `${u.source}:${u.name}:${u.by}`).sort();
  assert.deepEqual(names, ['claude:tdd:you', 'helper:project-quality:reviewer', 'typed:clear:you', 'typed:implement:you']);
  assert.ok(!JSON.stringify(data.skills).includes('args'), 'skill arguments never leave the parser');
  assert.equal(data.skills.find((u) => u.name === 'project-quality').isError, true);
});

test('the team picture: flows, a hand-off chain, and what is never used', () => {
  const t = teamwork(collect([session()], RANGE), inv(['reviewer', 'writer'], ['implement', 'tdd', 'grill-me']));
  const flow = (from, to) => t.edges.find((e) => e.from === from && e.to === to)?.count;
  assert.equal(flow('You', 'reviewer'), 2);
  assert.equal(flow('You', 'implement'), 1);
  assert.equal(flow('reviewer', 'project-quality'), 1);
  assert.equal(flow('You', 'clear'), undefined, 'a built-in command is not a skill');
  assert.deepEqual(t.chains, [{ chain: '/implement → /tdd → reviewer (FAIL) → reviewer (PASS)', count: 1 }]);
  assert.deepEqual(t.unused.map((r) => r.name), ['writer', 'grill-me']);
  const pq = t.skillRows.find((s) => s.name === 'project-quality');
  assert.deepEqual([pq.uses, pq.errorRate, pq.byHelpers], [1, 1, [['reviewer', 1]]]);
  assert.equal(t.skillRows.find((s) => s.name === 'implement').errorRate, undefined, 'typed commands have no result to fail');
});

test('repeats in a chain are folded', () => {
  const root = world({
    'p/s.jsonl': [
      prompt(0, 'go'),
      toolUse(1, 'a', 'Task', { subagent_type: 'runner', prompt: 'x' }), toolResult(2, 'a', 'ok'),
      toolUse(3, 'b', 'Task', { subagent_type: 'runner', prompt: 'y' }), toolResult(4, 'b', 'ok'),
      toolUse(5, 'c', 'Task', { subagent_type: 'reviewer', prompt: 'z' }), toolResult(6, 'c', 'PASS'),
    ],
  });
  assert.deepEqual(teamwork(collect([root], RANGE)).chains, [{ chain: 'runner ×2 → reviewer (PASS)', count: 1 }]);
});

test('the inventory reads agent names and skill folders, and a missing folder is fine', () => {
  const base = world({
    'agents/one.md': ['---', 'name: helper-one', 'description: x', '---', 'body'],
    'skills/tidy/SKILL.md': ['---', 'name: tidy', '---'],
    'skills/not-a-skill/readme.txt': ['x'],
  });
  const got = readInventory([base, path.join(base, 'missing')]);
  assert.deepEqual([[...got.agents], [...got.skills], got.problems], [['helper-one'], ['tidy'], []]);
});
