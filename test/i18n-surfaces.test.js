'use strict';

// Settings and the mini window in Traditional Chinese: their fixed markup,
// drawn with the word tables, and the mini window's lists, drawn from
// invented data whose own values are Chinese too, so any Latin word left
// is the app's own and must be on the allow-list (product names, "token",
// file names, units and a few git words).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const load = () => import('../renderer/i18n.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');

const ALLOW = new Set([
  'Claude', 'Code', 'LINE', "Agent's", 'Home', 'Cowork', 'WSL', 'GPU', 'CPU', 'GB', 'token', 'App', 'Windows',
  'Google', 'Cloud', 'OneDrive', 'Dropbox', 'GitHub', 'Open-Meteo', 'open-meteo.com', 'claude.ai', 'Esc', 'ID', 'CMF',
  'git', 'Git', 'clone', 'worktree', 'Worktree', 'hook', 'settings.json', 'scan.log', '.claude/agents', 'agents-status',
  'Token', 'rooms.json', 'claude', // the command
  'helper-end-corrected', // a system log event's name
  'spine-planner', // an example agent name: those are lower-case identifiers in every language
  'layout.json', 'decor.json', 'fleet.json', 'activity.log', 'line-prompts', 'JSON', 'README', // files and folders by name
  'Agents', // "Agents Home", the program's own name in Task Manager
  'npm', 'ci', 'start', 'stash', 'tmux', // commands
  'Actions', 'Terminal', // GitHub's Actions tab, Windows Terminal
  "Agent’s", 'Apps', 'Script', 'Inbox', 'Developers', 'Webhook', 'Linux', 'GNOME', 'Keyring', 'KWallet', // names as their makers write them
  'https', 'MB', 'exec', // a link's parts: https, /exec, ?k=
  'line-bot.json', 'line-bot-store.json', 'line-bot-secret.json', 'line-bot-store.untick.json', 'line-bot-store-off.json', '.tmp',
]);
// Script properties (READER_SECRET, LINE_TOKEN) and a link's ?k= are typed as they are.
const latin = (text) => (String(text).replace(/°[CF]/g, ' ').replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\?k=/g, ' ').match(/\.?[A-Za-z][A-Za-z0-9'’./-]*[A-Za-z0-9]|\.?[A-Za-z]/g) ?? []).filter((w) => !ALLOW.has(w));
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// What a page shows: its text, and the words in its title, aria-label and placeholder attributes.
function shown(html) {
  const attrs = [...html.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)].map((m) => decode(m[1]));
  const text = decode(html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' '));
  return [text, ...attrs].join(' ');
}

// The fixed markup as localise() draws it, without a DOM: each data-i18n
// element gets its words, each data-i18n-<attr> its attribute.
function drawStatic(html, tr, trHtml) {
  return html
    .replace(/<([a-z0-9]+)([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>/g, (m, tag, a, key, b) => {
      const n = /data-i18n-n="(\d+)"/.exec(a + b);
      return `<${tag}${a}${b}>${tr(key, n ? { n: Number(n[1]) } : {})}`;
    })
    .replace(/<([a-z0-9]+)([^>]*?)\sdata-i18n-html="([^"]+)"([^>]*)>/g, (m, tag, a, key, b) => `<${tag}${a}${b}>${trHtml(key)}`)
    .replace(/\sdata-i18n-(title|aria-label|placeholder)="([^"]+)"/g, (m, attr, key) => ` ${attr}="${tr(key)}"`);
}

const body = (html) => html.slice(html.indexOf('<body'), html.indexOf('</body>'));

test('the windows\' fixed markup holds no words of its own: every word comes from the tables', async () => {
  const { TABLES } = await load();
  for (const file of ['index.html', 'mini.html']) {
    const html = read(file);
    assert.deepEqual([...body(html).matchAll(/\s(title|aria-label|placeholder)="[^"]*"/g)].map((m) => m[0]), [], `${file}: attributes written in place`);
    assert.deepEqual(latin(shown(body(html))).filter((w) => w !== "Agent's" && w !== 'Home'), [], `${file}: words written in place`);
    for (const [, key] of html.matchAll(/data-i18n(?:-html|-title|-aria-label|-placeholder)?="([^"]+)"/g)) assert.ok(key in TABLES.en, `${file}: ${key} is in the tables`);
  }
});

test('Settings and the mini window\'s fixed parts read in Chinese, with only allowed Latin words', async () => {
  const { tr, trHtml, setLanguage } = await load();
  setLanguage('zh-TW');
  try {
    const index = read('index.html');
    const settings = index.slice(index.indexOf('<section class="settings"'), index.indexOf('</aside>'));
    for (const [name, html] of [['Settings', settings], ['the hospital window', body(index)], ['the mini window', body(read('mini.html'))]]) {
      const drawn = shown(drawStatic(html, tr, trHtml));
      assert.deepEqual(latin(drawn), [], `${name} in Chinese`);
      assert.match(drawn, /[一-鿿]/, `${name} shows Chinese`);
    }
  } finally {
    setLanguage('en');
  }
});

test('every Chinese entry is Chinese: Latin words only from the allow-list', async () => {
  const { TABLES } = await load();
  const bad = Object.entries(TABLES['zh-TW'])
    .flatMap(([key, value]) => (typeof value === 'object' ? Object.values(value) : [value]).map((v) => [key, latin(v.replace(/<[^>]+>|\{\w+\}/g, ' '))]))
    .filter(([, words]) => words.length);
  assert.deepEqual(bad, []);
});

// Invented data, its own values in Chinese, covering each state the mini window draws.
const now = Date.parse('2026-11-20T10:00:00Z');
const min = 60_000;
function snapshot() {
  const todos = { total: 3, done: 1, doing: 1, items: [{ status: 'completed', text: '待辦甲' }, { status: 'in_progress', text: '待辦乙', active: '做乙中' }, { status: 'pending', text: '待辦丙' }] };
  const helper = (type, status, extra = {}) => ({ type, status, lastActivityAt: now - 2 * min, ...extra });
  return {
    here: '工作站',
    sessions: [
      { id: 's1', project: '專案甲', status: 'working', activity: { kind: 'read', label: 'Reading a file', labelKey: 'tool.read' }, startedAt: now - 30 * min, lastActivityAt: now, todos, agents: [helper('審查員', 'thinking'), helper('研究員', 'blocked'), helper('測試員', 'reporting'), helper('甲', 'working', { activity: { labelKey: 'tool.run', label: 'Running a command' } }), helper('乙', 'delegating', { activity: { labelKey: 'tool.delegate', labelParams: { type: '丙' }, label: 'Consulting 丙' } }), helper('丁', 'idle')] },
      { id: 's2', project: '專案乙', source: 'cowork', status: 'your-turn', startedAt: now - 90 * min, lastActivityAt: now - 12 * min, agents: [] },
      { id: 's3', project: '專案乙', source: 'wsl', status: 'delegating', activity: { labelKey: 'tool.delegate', labelParams: { type: '審查員' }, label: 'Consulting 審查員' }, startedAt: now - 3 * min, lastActivityAt: now, agents: [helper('審查員', 'working')] },
      { id: 's4', project: '專案丙', status: 'blocked', startedAt: now - 5 * min, lastActivityAt: now - 4 * min, agents: [] },
      { id: 's5', project: '專案丁', status: 'thinking', startedAt: now - 5 * min, lastActivityAt: now, agents: [] },
      { id: 's6', project: '專案戊', status: 'idle', startedAt: now - 5 * min, lastActivityAt: now, agents: [] },
    ],
    clashes: [{ key: 'k', count: 2, project: '專案甲' }],
    jobs: ['running', 'done', 'failed', 'stopped', 'stalled'].map((state, i) => ({ name: `訓練${i}`, project: '專案甲', state, step: 340, total: 1000, epoch: 3, epochs: 9, eta: 3_000_000, updatedAt: now - 7 * min, startedAt: now - 60 * min })),
    machine: { gpus: [{ name: '顯示卡', util: 90, memUsed: 9000, memTotal: 16000, temp: 70 }], cpu: 40, memUsed: 8000, memTotal: 32000 },
    work: [{ name: '腳本', project: '專案甲', on: 'gpu', gpuMem: 2048, startedAt: now - 130 * min }, { name: '腳本二', on: 'cpu', startedAt: now - 20 * min }],
    fleet: { computers: [
      { computer: '筆電', online: true, at: now - min, sessions: [{ project: '專案己', status: 'working', todos: { total: 2, done: 1 }, agents: [] }] },
      { computer: '桌機', online: false, at: now - 90 * min, sessions: [] },
    ] },
    field: { enabled: true, summary: { newSince: 3 }, fetchedAt: now - 30 * min, error: '失敗' },
  };
}

test('the mini window\'s Now tab and headline read in Chinese, privacy mode on and off', async () => {
  const { setLanguage } = await load();
  const { miniHtml } = await import('../renderer/mini-view.js');
  setLanguage('zh-TW');
  try {
    for (const privacy of [true, false]) {
      const { list, head } = miniHtml(snapshot(), { privacy, now });
      assert.deepEqual(latin(shown(list + head)), [], `privacy ${privacy}`);
      assert.match(list, /等你處理/);
      assert.match(list, /輪到你了/);
      assert.equal(list.includes('做乙中'), !privacy, 'to-do wording only with privacy off');
      const opened = miniHtml(snapshot(), { privacy, open: new Set(['|s1']), now }).list;
      assert.deepEqual(latin(shown(opened)), [], `privacy ${privacy}, the whole list open`);
      assert.equal(opened.includes('待辦丙'), !privacy, 'the whole list only with privacy off');
    }
  } finally {
    setLanguage('en');
  }
});

test('the mini window\'s Projects tab reads in Chinese, privacy mode on and off', async () => {
  const { setLanguage } = await load();
  const { projectsHtml } = await import('../renderer/projects-view.js');
  const day = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const projects = {
    ok: true,
    assistant: { on: true, lastRun: new Date().toISOString(), failures: 2, lastError: '錯誤', more: 2, notes: [], questions: [{ project: 'p1', text: '問題甲？' }] },
    list: [
      { id: 'p1', name: '專案甲', path: '路徑', confirmed: true, status: 'active', copies: [{}, {}], todos: [
        { id: 'a', text: '待辦甲', done: false, by: 'agent', due: day(0) }, { id: 'b', text: '待辦乙', done: false, due: day(1) },
        { id: 'c', text: '待辦丙', done: false, due: day(-3) }, { id: 'd', text: '待辦丁', done: false, due: day(9) }, { id: 'e', text: '待辦戊', done: true }] },
      { id: 'p2', name: '專案乙', confirmed: false, status: 'paused', copies: [], todos: [] },
      { id: 'p3', name: '專案丙', confirmed: true, status: 'done', copies: [], todos: [] },
    ],
  };
  const trees = new Map([['p1', { ok: true, base: '主線', trees: [
    { name: '甲', path: '路徑甲', branch: '主線', main: true, changed: 2, lastCommit: Date.now() - 3_600_000 },
    { name: '乙', path: '路徑乙', detached: true, missing: true, ignored: 3, error: '錯' },
    { name: '丙', path: '路徑丙', branch: '分支', merged: true, safe: true, lastCommit: Date.now() - 4 * 86_400_000 },
  ] }]]);
  setLanguage('zh-TW');
  try {
    for (const privacy of [true, false]) {
      const html = projectsHtml(projects, [{ projectId: 'p1', status: 'working' }], { privacy, open: new Set(['p1']), worktrees: trees, error: { where: 'new', text: '錯誤' } });
      assert.deepEqual(latin(shown(html)), [], `privacy ${privacy}`);
      assert.equal(html.includes('待辦甲'), !privacy, 'to-do wording only with privacy off');
    }
    const empty = projectsHtml({ ok: true, list: [] }, [], { privacy: true, open: new Set() });
    assert.deepEqual(latin(shown(empty)), []);
    assert.deepEqual(latin(shown(projectsHtml({ ok: false, list: [] }, [], { privacy: true, open: new Set() }))), []);
  } finally {
    setLanguage('en');
  }
});

test('the office team\'s words in the tables are the pack\'s own, for every item it ships', async () => {
  const { TABLES } = await load();
  const { listPack } = require('../src/core/officepack');
  for (const item of listPack(path.join(__dirname, '..', 'office-pack'))) {
    assert.equal(TABLES.en[`pack.summary.${item.name}`], item.summary, item.name);
    assert.ok(TABLES.en[`pack.name.${item.name}`], `${item.name} has a name`);
  }
});
