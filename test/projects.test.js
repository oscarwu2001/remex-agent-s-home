'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/core/projects');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-projects-')), 'projects.json');
const sample = {
  version: 1,
  projects: [
    { id: 'spine', name: 'Loader tools', path: 'C:\\Users\\me\\code\\spine', copies: ['C:\\Users\\me\\code\\spine-wt-fix'], confirmed: true, note: 'kept',
      todos: [{ id: 't1', text: 'Draft the intro', done: false, by: 'agent' }, 'Plain text item', { text: '' }] },
    { name: 'Garden planner', path: '/home/me/garden-planner' },
    { path: '/nowhere' },
  ],
};

test('no file yet is an empty list, not a problem', () => {
  const res = P.loadProjects(tmpFile());
  assert.deepEqual([res.data.projects, res.problems, res.missing], [[], [], true]);
});

test('the view leaves out nameless projects and empty to-dos and says so; plain to-dos are accepted', () => {
  const { data, problems } = P.checkProjects(sample);
  assert.deepEqual(data.projects.map((p) => p.id), ['spine', 'garden-planner']);
  assert.equal(problems.length, 1);
  assert.deepEqual(data.projects[0].todos.map((t) => [t.text, t.by]), [['Draft the intro', 'agent'], ['Plain text item', 'you']]);
  assert.deepEqual([data.projects[1].status, data.projects[1].confirmed], ['active', false]);
});

test('a change from the app writes the file back as it was, apart from that change', () => {
  const raw = JSON.parse(JSON.stringify(sample));
  raw.extra = { by: 'an agent' };
  const next = P.applyChange(raw, { op: 'confirm', project: 'garden-planner' });
  assert.deepEqual(next.extra, { by: 'an agent' });
  assert.equal(next.projects.length, 3, 'the nameless project stays in the file');
  assert.deepEqual(next.projects[2], { path: '/nowhere', id: next.projects[2].id });
  assert.equal(next.projects[0].note, 'kept');
  assert.equal(next.projects[0].todos.length, 3, 'the empty to-do stays too');
  assert.equal(next.projects[1].confirmed, true);
  assert.equal(raw.projects[1].confirmed, undefined, 'the input is not changed');
});

test('ids for items without one are the same on every read, so a click removes exactly what was shown', () => {
  const raw = { projects: [{ name: 'A', todos: ['one', 'two', { text: 'three', id: 'x' }, { text: 'four', id: 'x' }] }] };
  const view = P.checkProjects(raw).data.projects[0].todos;
  assert.deepEqual(P.checkProjects(JSON.parse(JSON.stringify(raw))).data.projects[0].todos.map((t) => t.id), view.map((t) => t.id));
  assert.equal(new Set(view.map((t) => t.id)).size, 4, 'a repeated id is told apart');
  const next = P.applyChange(raw, { op: 'remove-todo', project: 'a', todo: view[3].id });
  assert.deepEqual(next.projects[0].todos.map((t) => t.text), ['one', 'two', 'three']);
  // An agent adds an item without an id at the top: what was shown keeps its id.
  const shifted = { projects: [{ name: 'A', todos: ['zero', ...raw.projects[0].todos] }] };
  const again = P.applyChange(shifted, { op: 'toggle-todo', project: 'a', todo: view[2].id });
  assert.equal(again.projects[0].todos.find((t) => t.text === 'three').done, true);
  assert.equal(again.projects[0].todos.filter((t) => t.done).length, 1);
});

test('broken JSON is reported and never overwritten', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ nope');
  const res = P.loadProjects(file);
  assert.equal(res.data, undefined);
  assert.match(res.problems[0], /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
});

test('changes from the app: add, tick, remove a to-do, confirm and add a project; saved and read back', () => {
  const file = tmpFile();
  let data = JSON.parse(JSON.stringify(sample));
  data = P.applyChange(data, { op: 'add-todo', project: 'garden-planner', text: '  Export the drawing  ' });
  const added = data.projects[1].todos[0];
  assert.deepEqual([added.text, added.by, added.done], ['Export the drawing', 'you', false]);
  data = P.applyChange(data, { op: 'toggle-todo', project: 'garden-planner', todo: added.id });
  data = P.applyChange(data, { op: 'remove-todo', project: 'spine', todo: 't1' });
  data = P.applyChange(data, { op: 'confirm', project: 'garden-planner' });
  data = P.applyChange(data, { op: 'add-project', name: 'Weekly log' });
  P.saveProjects(file, data);
  const back = P.loadProjects(file).data;
  assert.equal(back.projects[1].todos[0].done, true);
  assert.equal(back.projects[1].confirmed, true);
  assert.equal(back.projects[0].todos.length, 1);
  assert.equal(back.projects[2].name, 'Weekly log');
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1, 'no temporary file left behind');
  assert.throws(() => P.applyChange(P.loadProjects(file).raw, { op: 'add-todo', project: 'gone', text: 'x' }), /no longer on the list/);
  assert.throws(() => P.applyChange(P.loadProjects(file).raw, { op: 'add-todo', project: 'spine', text: '  ' }), /Type the to-do/);
  assert.throws(() => P.applyChange(P.loadProjects(file).raw, { op: 'add-project', name: 'weekly LOG' }), /already/);
});

test('a session belongs to the project whose folder or copy holds it, whatever the slashes and case', () => {
  const { data } = P.checkProjects(sample);
  assert.deepEqual(P.projectFor('c:/users/me/code/spine/src', data.projects), { id: 'spine', copy: false });
  assert.deepEqual(P.projectFor('C:\\Users\\me\\code\\spine-wt-fix', data.projects), { id: 'spine', copy: true });
  assert.equal(P.projectFor('C:\\Users\\me\\code\\spine2', data.projects), undefined);
  assert.equal(P.projectFor(undefined, data.projects), undefined);
});

test('the file lives outside the .claude folder unless the user says otherwise', () => {
  assert.equal(P.projectsFile({}, '/home/me'), path.join('/home/me', '.agents-home', 'projects.json'));
  assert.equal(P.projectsFile({ AGENTS_HOME_PROJECTS: '/x/p.json' }, '/home/me'), '/x/p.json');
});

test('a to-do can be given a day, changed and cleared; nonsense dates are refused', () => {
  const raw = { projects: [{ id: 'a', name: 'A', todos: [{ id: 't1', text: 'one' }, { id: 't2', text: 'two', due: '2026-02-31' }] }] };
  let next = P.applyChange(raw, { op: 'set-date', project: 'a', todo: 't1', date: '2026-11-03' });
  assert.equal(next.projects[0].todos[0].due, '2026-11-03');
  assert.equal(P.checkProjects(next).data.projects[0].todos[0].due, '2026-11-03');
  assert.equal(P.checkProjects(next).data.projects[0].todos[1].due, undefined, 'an impossible day is not shown');
  next = P.applyChange(next, { op: 'set-date', project: 'a', todo: 't1', date: '' });
  assert.equal('due' in next.projects[0].todos[0], false);
  assert.throws(() => P.applyChange(next, { op: 'set-date', project: 'a', todo: 't1', date: 'tomorrow' }), /not a date/);
});

test('projects with open to-dos come first (soonest day first), then those with none; to-dos sort by day', async () => {
  const { sortProjects, sortTodos, dueLabel } = await import('../renderer/projects-view.js');
  const p = (name, todos, status = 'active') => ({ name, status, todos });
  const list = [p('Empty', []), p('Later', [{ text: 'x', due: '2026-12-01' }]), p('Undated', [{ text: 'y' }]), p('Soon', [{ text: 'z', due: '2026-11-01' }]), p('Done only', [{ text: 'w', done: true }])];
  assert.deepEqual(sortProjects(list).map((x) => x.name), ['Soon', 'Later', 'Undated', 'Done only', 'Empty']);
  const todos = [{ text: 'a' }, { text: 'b', due: '2026-11-05' }, { text: 'c', done: true, due: '2026-10-01' }, { text: 'd', due: '2026-11-02' }, { text: 'e' }];
  assert.deepEqual(sortTodos(todos).map((t) => t.text), ['d', 'b', 'a', 'e', 'c']);
  const today = new Date(2026, 9, 30);
  assert.equal(dueLabel('2026-10-30', today).text, 'Today');
  assert.equal(dueLabel('2026-10-31', today).text, 'Tomorrow');
  assert.equal(dueLabel('2026-10-29', today).when, 'overdue');
});
