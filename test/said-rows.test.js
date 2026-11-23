'use strict';

// The rows core and the main process really build, put in Chinese the way
// the window does (sayIn): no English may be left in them but names, codes
// and the words the Chinese table itself keeps in Latin letters.

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/core/i18n');
const linebot = require('../src/core/linebot');
const fieldsurvey = require('../src/core/fieldsurvey');
const linechat = require('../src/core/linechat');
const projects = require('../src/core/projects');
const officepack = require('../src/core/officepack');

const { en } = i18n;
const NOW = Date.parse('2026-11-20T10:00:00Z');

// Latin words the Chinese table writes itself (product names, file names,
// codes it quotes), plus what the rows below are filled with.
const latinOf = (text) => String(text).replace(/https?:\/\/\S+|%APPDATA%\\Agents Home|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\?k=/g, ' ')
  .match(/\.?[A-Za-z][A-Za-z0-9'’./-]*[A-Za-z0-9]|\.?[A-Za-z]/g) ?? [];
const ALLOWED = new Set([
  ...Object.values(i18n.TABLES['zh-TW']).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v])).flatMap((v) => latinOf(v.replace(/<[^>]+>|\{\w+\}/g, ' '))),
  'EBUSY', 'EACCES', 'EPERM', 'HTTP', 'Europe/Atlantis', 'Demo', 'Thesis', 'nothing-like-it',
]);
const english = (text) => latinOf(text).filter((w) => !ALLOWED.has(w));

function rows() {
  const out = [];
  // LINE chats' bot part: every store trouble, on and off; each rebuild; every tally, capped and not.
  const kinds = ['unreadable', 'invalid', 'unwritten', 'unremoved', 'legacyLeft', 'legacyUnread', 'damaged', 'unlisted', 'secretUnlisted', 'untickLeft', 'recordLeft', 'notStarted', 'leftover', 'prune'];
  for (const on of [true, false]) {
    for (const what of kinds) {
      for (const why of ['failed', 'held']) out.push(...linebot.botProblems({ on, store: null, storeProblems: [{ what, why, count: 2, detail: '' }], now: NOW }));
    }
    out.push(...linebot.botProblems({ on, store: null, storeProblems: [{ what: 'unlisted' }, { what: 'secretUnlisted' }], now: NOW }));
  }
  for (const rebuilt of ['update', 'damaged', 'ticks']) {
    for (const link of ['', 'https://script.google.com/macros/s/x/exec']) {
      out.push(...linebot.botProblems({ on: false, store: { ...linebot.emptyStore(), rebuilt, settings: { read: [], link } }, now: NOW }));
    }
  }
  const tallies = ['refused', 'denied', 'unchecked', 'missed', 'lost', 'notJson', 'broken', 'unusable', 'future', 'ahead', 'restarted'];
  for (const capped of [false, true]) {
    for (const n of [1, 3]) {
      const notes = tallies.map((what) => ({ what, n, at: NOW - 1000 }));
      if (capped) notes.push({ what: 'capped', n: 1, at: NOW - 1000 });
      out.push(...linebot.botProblems({ on: true, store: { ...linebot.emptyStore(), notes, relayVersion: 0 }, now: NOW }));
    }
  }
  for (const code of ['HTTP 429', 'HTTP 404', 'HTTP 500', 'HTTP 401']) {
    out.push(...linebot.botProblems({ on: true, store: { ...linebot.emptyStore(), nameProblem: { code } }, now: NOW }));
  }
  for (const why of [linebot.notCollecting({ on: true, link: '' }), linebot.notCollecting({ on: true, link: 'x', secretSaved: false }), linebot.notCollecting({ on: true, storage: 'none' })]) {
    out.push(...linebot.botProblems({ on: true, store: null, notCollecting: why, now: NOW }));
  }
  // LINE chats' exports.
  out.push(...linechat.lineProblems({ enabled: true, folder: '' }));
  // Field feedback: each kind of row, with a column wording of each kind.
  const summary = (needsChoice, fresh) => ({ needsChoice, columns: Array.from({ length: fresh }, () => ({ isNew: true })), doubtful: [{}, {}], timeZoneUnknown: 'Europe/Atlantis', timeZoneMissing: true, ambiguousDates: 2, unreadable: { scores: 2, numbers: 1 } });
  for (const [a, b] of [[0, 2], [1, 0], [2, 1], [2, 3]]) out.push(...fieldsurvey.fieldProblems({ enabled: true, cache: null, summary: summary(a, b) }));
  // The main process's own wrappers, built as main builds them.
  const listed = [projects.loadProjects('x', { readFileSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }),
    projects.loadProjects('x', { readFileSync: () => '{ not json' }),
    projects.loadProjects('x', { readFileSync: () => JSON.stringify({ projects: [{ name: '' }, { name: 'Thesis', todos: Array.from({ length: 60 }, (_, i) => ({ text: `t${i}` })) }] }) })];
  for (const p of listed) for (const label of p.problems) out.push({ label: en('said.main.projectList', { what: label }) });
  for (const label of [en('said.assistant.questions', { what: en('said.common.notRead', { code: 'EBUSY' }) }), en('said.assistant.state', { what: en('said.assistant.notJson') })]) {
    out.push({ label: en('said.main.assistant', { what: label }) });
  }
  const pack = officepack.installPack(require('path').join(__dirname, '..', 'office-pack'), require('os').tmpdir(), ['nothing-like-it']);
  for (const e of [...pack.errors, en('said.pack.notAdded', { name: 'Demo', why: 'EPERM' }), en('said.pack.notRead', { name: 'Demo', why: 'EACCES' })]) {
    out.push({ label: en('said.main.officePack', { what: e }) });
  }
  return out.map((r) => r.label);
}

test('every row core and main build reads in Chinese, with no English left but names and codes', () => {
  const labels = rows();
  assert.ok(labels.length > 80, `rows built: ${labels.length}`);
  const left = labels.map((label) => [label, i18n.sayIn('zh-TW', label)]).filter(([, zh]) => english(zh).length);
  assert.deepEqual(left.map(([label, zh]) => `${label}\n  -> ${zh}\n  left: ${english(zh).join(' ')}`), []);
});

test('a wrapper is never read into the part it wraps', () => {
  const wrapped = en('said.main.projectList', { what: en('said.projects.unreadable', { code: 'EBUSY' }) });
  assert.equal(i18n.sayIn('zh-TW', wrapped), `${i18n.translate('zh-TW', 'said.main.projectList', { what: i18n.translate('zh-TW', 'said.projects.unreadable', { code: 'EBUSY' }) })}`);
  const capped = en('said.line.row', { what: en('said.lb.lost', { n: 2, count: en('said.lb.atLeast', { n: 2 }), days: en('said.lb.lastDays', { n: 14 }) }) });
  assert.match(i18n.sayIn('zh-TW', capped), /^LINE 聊天：/, 'the wrapper stays the wrapper');
});

test('text a person or a program wrote keeps its brackets and words', () => {
  const name = 'Thesis (draft)';
  const row = en('said.main.projectList', { what: en('said.projects.tooManyTodos', { name, n: 50 }) });
  assert.ok(i18n.sayIn('zh-TW', row).includes(name), 'the project name as written');
});

test('every wrapped row reads back as its wrapper, never as the sentence it wraps', () => {
  const wrappers = ['said.line.row', 'said.fs.row', 'said.main.projectList', 'said.main.assistant', 'said.main.officePack']
    .map((key) => ({ key, lead: i18n.translate('en', key, { what: '' }) }));
  const labels = rows();
  for (const label of labels) {
    const wrapper = wrappers.find((w) => label.startsWith(w.lead));
    assert.ok(wrapper, `a wrapper for: ${label}`);
    assert.equal(i18n.unsay(label)?.key, wrapper.key, label);
  }
});

test('an Office pack row reads as the wrapper around what could not be added, read or updated', () => {
  const zh = (key, params) => i18n.translate('zh-TW', key, params);
  for (const key of ['said.pack.notAdded', 'said.pack.notRead', 'said.pack.notUpdated']) {
    const row = en('said.main.officePack', { what: en(key, { name: 'builder', why: 'EPERM' }) });
    assert.equal(i18n.sayIn('zh-TW', row), zh('said.main.officePack', { what: zh(key, { name: 'builder', why: 'EPERM' }) }), key);
  }
});
