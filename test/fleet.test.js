'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleet = require('../src/core/fleet');

const snap = {
  sessions: [
    { project: 'spine', source: 'code', computer: 'pc-a', status: 'working', title: 'secret title',
      agents: [{ type: 'Explore', status: 'thinking', description: 'secret desc' }, { type: 'old', status: 'done' }],
      todos: { items: [{ text: 'secret todo', status: 'pending' }], total: 1, done: 0, doing: 0 } },
    { project: 'spine', source: 'cowork', computer: 'pc-a', status: 'your-turn', agents: [] },
    { project: 'paper', source: 'wsl', computer: 'pc-a · WSL Ubuntu', status: 'delegating', agents: [] },
  ],
};

test('the shared summary holds names, statuses and counts, never wording, titles or descriptions', () => {
  const sum = fleet.summaryOf(snap, 'pc-a', 1000);
  const text = JSON.stringify(sum);
  for (const secret of ['secret title', 'secret desc', 'secret todo']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(sum.sessions[0].agents, [{ type: 'Explore', status: 'thinking' }]);
  assert.deepEqual(sum.sessions[0].todos, { done: 0, doing: 0, total: 1 });
});

test('the overview counts what runs now per computer and project', async () => {
  const { overview, headline } = await import('../renderer/overview.js');
  const o = overview(snap.sessions, 'pc-a', [{ computer: 'laptop', online: true, at: 1, sessions: [{ project: 'cad', status: 'thinking', agents: [] }] }]);
  assert.deepEqual([o.sessions, o.running, o.helpers, o.computers.length], [4, 3, 1, 3]);
  const here = o.computers.find((c) => c.computer === 'pc-a');
  assert.deepEqual(here.projects.map((p) => [p.project, p.sessions.length, p.running]), [['spine', 2, 1]]);
  assert.equal(o.computers.find((c) => c.computer === 'laptop').local, false);
  assert.equal(headline(o), '3 running · 4 sessions · 3 projects · 3 computers');
  assert.equal(headline(overview([], 'pc-a')), 'Nothing running · 0 sessions · 0 projects');
});

test('this computer writes its file and reads the others; stale ones are offline, odd ones reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-'));
  const now = Date.now();
  fleet.writeShare(dir, fleet.summaryOf(snap, 'pc-a', now, 'aaaa1111'));
  fleet.writeShare(dir, fleet.summaryOf(snap, 'pc-a', now, 'bbbb2222')); // another computer with the same name
  fleet.writeShare(dir, fleet.summaryOf({ sessions: [{ project: 'cad', status: 'working', agents: [] }] }, 'laptop', now - 1000, 'cccc3333'));
  fleet.writeShare(dir, fleet.summaryOf({ sessions: [{ project: 'x', status: 'working', agents: [] }] }, 'old-box', now - fleet.FRESH_MS - 1, 'dddd4444'));
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"hello":1}');
  const { computers, problems } = fleet.readShares(dir, fleet.fileFor('pc-a', 'aaaa1111'), now);
  assert.deepEqual(computers.map((c) => [c.computer, c.online, c.sessions.length]), [['laptop', true, 1], ['old-box', false, 0], ['pc-a', true, 3]]);
  assert.equal(problems.length, 1);
  assert.equal(fleet.fileFor('my pc/../x', 'ab12'), 'my-pc-x-ab12.json');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('a status file from the shared folder is rebuilt from checked values, never trusted as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-'));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'odd.json'), JSON.stringify({ app: 'agents-home', computer: 'odd', at: now, sessions: [
    { project: 'ok', status: 'working', agents: 'x', todos: { done: 1, total: 1e9 } },
    { project: 'p<b>', status: 'working', agents: [{ type: 'a', status: 'thinking', extra: '<i>' }, { type: 5, status: 'working' }], todos: { done: '1', total: 3 }, source: 'evil' },
    { project: 'bad', status: '<script>' },
  ] }));
  const { computers, problems } = fleet.readShares(dir, 'me.json', now);
  const [a, b] = computers[0].sessions;
  assert.deepEqual(a, { project: 'ok', source: 'code', where: undefined, status: 'working', agents: [], todos: undefined });
  assert.deepEqual(b.agents, [{ type: 'a', status: 'thinking' }]);
  assert.equal(b.source, 'code');
  assert.equal(b.todos, undefined);
  assert.equal(computers[0].sessions.length, 2);
  assert.match(problems[0].label, /did not make sense/);
});

test('a shared folder that cannot be read is a problem, not an empty list', () => {
  const res = fleet.readShares(path.join(os.tmpdir(), 'no-such-agents-folder-xyz'), 'pc', Date.now());
  assert.match(res.problems[0].label, /could not be read/);
});
