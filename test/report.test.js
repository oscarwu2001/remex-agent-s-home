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

test('the report page is in the language asked for, with the report\'s own problems; English is as before; an unknown language is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-'));
  fs.mkdirSync(path.join(root, 'p'));
  const lines = [ago(prompt(0, 'go'), 1, 0), ago(toolUse(1, 'w', 'Task', { subagent_type: 'writer', prompt: 'Write it' }), 1, 1), ago(toolResult(30, 'w', 'done'), 1, 30)];
  fs.writeFileSync(path.join(root, 'p', 'sess-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  // The app's own folder, invented: a layout.json the report cannot read.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-app-'));
  fs.mkdirSync(path.join(appData, 'Agents Home'));
  fs.writeFileSync(path.join(appData, 'Agents Home', 'layout.json'), '{ not json');
  const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.APPDATA = appData;
  process.env.XDG_CONFIG_HOME = appData;
  try {
    const page = (...lang) => {
      const res = run(['--days', '7', '--roots', JSON.stringify([root]), '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-out-')), '--json', ...lang]);
      return fs.readFileSync(res.html, 'utf8');
    };
    const zh = page('--lang', 'zh-TW');
    assert.match(zh, /<html lang="zh-Hant-TW">/);
    assert.match(zh, /<h1>代理績效<\/h1>/);
    assert.match(zh, /<h2>計分卡<\/h2>/);
    assert.match(zh, /無法讀取 layout\.json，所以使用預設的房間/, 'a problem the report found, in Chinese');
    assert.doesNotMatch(zh, /Agent performance|Scorecard|How the score works|Notes on the data|could not be read/);
    const en = page();
    assert.match(en, /<html lang="en">/);
    assert.match(en, /<h1>Agent performance<\/h1>/);
    assert.match(en, /layout\.json could not be read, so the default rooms are used/);
    assert.throws(() => run(['--lang', 'fr', '--stats-only', '--roots', JSON.stringify([root])]), /--lang must be one of en, zh-TW/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
