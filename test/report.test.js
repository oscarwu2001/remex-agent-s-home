'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/report/agent-report');
const { prompt, toolUse, toolResult } = require('./helpers');

// Invented transcript lines, moved to `daysAgo` days before now.
function ago(entry, daysAgo, sec) {
  return { ...entry, timestamp: new Date(Date.now() - daysAgo * 86_400_000 + sec * 1000).toISOString() };
}

test('the stats-only numbers cover only the period asked for', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-'));
  fs.mkdirSync(path.join(root, 'p'));
  const lines = [
    ago(prompt(0, 'go'), 10, 0),
    ago(toolUse(1, 'old', 'Task', { subagent_type: 'planner', prompt: 'Plan it' }), 10, 1),
    ago(toolResult(30, 'old', 'done'), 10, 30),
    ago(prompt(0, 'go'), 1, 0),
    ago(toolUse(1, 'new', 'Task', { subagent_type: 'writer', prompt: 'Write it' }), 1, 1),
    ago(toolResult(30, 'new', 'done'), 1, 30),
  ];
  fs.writeFileSync(path.join(root, 'p', 'sess-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const res = run(['--days', '7', '--stats-only', '--roots', JSON.stringify([root])]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.agents.map((a) => a.name), ['writer'], 'numbers cover only the last 7 days');
});

test('report dates: impossible days, --until without --since, --days with --since and --compare outside the period are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-'));
  const r = (...a) => () => run([...a, '--stats-only', '--roots', JSON.stringify([root])]);
  assert.throws(r('--since', '2026-02-31'), /real date/);
  assert.throws(r('--until', '2026-09-30'), /needs --since/);
  assert.throws(r('--days', '7', '--since', '2026-09-01'), /either --days or --since/);
  assert.throws(r('--since', '2026-09-01', '--until', '2026-09-30', '--compare', '2026-10-05'), /not inside the period/);
  assert.equal(r('--since', '2026-09-01', '--until', '2026-09-30', '--compare', '2026-09-24')().ok, true);
});
