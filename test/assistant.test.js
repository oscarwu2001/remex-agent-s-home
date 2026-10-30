'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/core/assistant');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-assistant-'));
const put = (dir, name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

test('the folder is ~/.agents-home/assistant unless AGENTS_HOME_ASSISTANT says otherwise', () => {
  assert.equal(A.assistantDir({}, '/home/me'), path.join('/home/me', '.agents-home', 'assistant'));
  assert.equal(A.assistantDir({ AGENTS_HOME_ASSISTANT: '/x' }, '/home/me'), '/x');
});

test('no scan yet shows nothing and is not a problem', () => {
  const a = A.loadAssistant(tmpDir());
  assert.deepEqual([a.on, a.questions, a.problems], [false, [], []]);
});

test('only open questions with words are shown, with their project', () => {
  const dir = tmpDir();
  put(dir, 'state.json', { lastRun: '2026-10-30T11:15:02+08:00', failures: 0, folders: {} });
  put(dir, 'questions.json', { version: 1, questions: [
    { key: 'pause:spine:2026-10', project: 'spine', text: 'spine has had no commits for 15 days. Mark it paused?', status: 'open' },
    { key: 'new:c:\\x\\garden', project: null, text: 'I found a project folder that is not on your list: garden (in x). Add it?', status: 'open' },
    { key: 'old', text: 'Answered already', status: 'answered' },
    { key: 'blank', text: '  ', status: 'open' },
    'not a question',
  ] });
  const a = A.loadAssistant(dir);
  assert.equal(a.on, true);
  assert.equal(a.lastRun, '2026-10-30T11:15:02+08:00');
  assert.deepEqual(a.questions.map((q) => [q.key, q.project]), [['pause:spine:2026-10', 'spine'], ['new:c:\\x\\garden', undefined]]);
  assert.deepEqual(a.problems, []);
});

test('a failing scan is counted with its last error, so the board can say so', () => {
  const dir = tmpDir();
  put(dir, 'state.json', { failures: 3, failureNoticed: true, lastError: 'claude exited 1: offline' });
  const a = A.loadAssistant(dir);
  assert.deepEqual([a.failures, a.lastError], [3, 'claude exited 1: offline']);
  put(dir, 'state.json', { failures: 0, lastError: 'an old one' });
  assert.equal(A.loadAssistant(dir).lastError, undefined);
});

test('what the scan could not do but went on with is shown as notes', () => {
  const dir = tmpDir();
  put(dir, 'state.json', { popupError: 'notification failed: blocked', unreadable: ['endo', 'Agent\'s Home'] });
  assert.deepEqual(A.loadAssistant(dir).notes, [
    'Pop-ups are not working, so its questions only show here.',
    'Git could not read a folder in endo, Agent\'s Home. New work there is logged once it can.',
  ]);
});

test('a file that will not parse is a problem, never a silent empty list', () => {
  const dir = tmpDir();
  put(dir, 'state.json', { lastRun: '2026-10-30T11:15:02+08:00' });
  put(dir, 'questions.json', '{not json');
  const a = A.loadAssistant(dir);
  assert.deepEqual([a.on, a.questions, a.problems], [true, [], ['its questions are not valid JSON']]);
});

test('a long queue shows the first 20 and counts the rest', () => {
  const dir = tmpDir();
  put(dir, 'state.json', {});
  put(dir, 'questions.json', { questions: Array.from({ length: 23 }, (_, i) => ({ key: `k${i}`, text: `Question ${i}`, status: 'open' })) });
  const a = A.loadAssistant(dir);
  assert.deepEqual([a.questions.length, a.more], [20, 3]);
});
