'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../src/core/jobs');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-jobs-'));
const write = (d, name, job) => fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(job));

test('a running job gets an ETA; a dead process is stopped, a silent one stalled, old ones dropped', () => {
  const d = dir();
  const now = Date.now();
  write(d, 'a', { name: 'train', project: 'seg', state: 'running', step: 2500, total: 10000, pid: 11, startedAt: now - 3_600_000, updatedAt: now - 5000, metrics: { loss: 0.1, path: 'x', inf: null } });
  write(d, 'b', { name: 'dead', state: 'running', step: 1, total: 2, pid: 22, updatedAt: now - 5000 });
  write(d, 'c', { name: 'quiet', state: 'running', pid: 11, updatedAt: now - J.STALL_MS - 1 });
  write(d, 'd', { name: 'old', state: 'done', updatedAt: now - 2 * 86_400_000 });
  fs.writeFileSync(path.join(d, 'e.json'), '{ broken');
  const alive = (pid) => pid === 11;
  const { jobs, problems } = J.readJobs(d, now, { alive });
  assert.deepEqual(jobs.map((j) => [j.name, j.state]), [['train', 'running'], ['dead', 'stopped'], ['quiet', 'stalled']]);
  assert.ok(Math.abs(jobs[0].eta - 3 * (3_600_000 - 5000)) < 1000, 'three quarters left at the same pace');
  assert.deepEqual(jobs[0].metrics, { loss: 0.1 });
  assert.equal(problems.length, 1);
});

test('no jobs folder is nothing to show and nothing wrong', () => {
  assert.deepEqual(J.readJobs(path.join(os.tmpdir(), 'no-such-jobs-dir-xyz')), { jobs: [], problems: [] });
});

test('jobs and machine load from another computer are rebuilt from checked values', () => {
  assert.equal(J.cleanJob({ name: '' , updatedAt: 1 }), undefined);
  const j = J.cleanJob({ name: 'x<y>', state: 'evil', step: -4, total: 1e20, updatedAt: 5, metrics: { a: 1, b: 'no' } });
  assert.deepEqual([j.state, j.step, j.total, j.metrics], ['running', undefined, undefined, { a: 1 }]);
  assert.deepEqual(J.cleanMachine({ gpus: [{ name: 'RTX', util: 97, memUsed: 1, memTotal: 2, temp: 70 }, { name: 'bad' }], cpu: 250 }),
    { gpus: [{ name: 'RTX', util: 97, memUsed: 1, memTotal: 2, temp: 70 }], cpu: undefined, memUsed: undefined, memTotal: undefined });
  assert.equal(J.cleanMachine({ gpus: 'x' }), undefined);
});

test('a posting computer\'s jobs come through the shared folder, and stop counting as running when it goes offline', () => {
  const fleet = require('../src/core/fleet');
  const d = dir();
  const now = Date.now();
  const post = (name, ago) => write(d, name, { app: 'agents-home', computer: name, at: now - ago, every: 900_000, sessions: [],
    jobs: [{ name: 'train', state: 'running', step: 5, total: 10, updatedAt: now - ago }], machine: { gpus: [{ name: 'RTX', util: 99 }], cpu: 40 } });
  post('on', 60_000);
  post('off', 3 * 3_600_000);
  const cs = fleet.readShares(d, 'me.json', now).computers;
  assert.deepEqual(cs.map((c) => [c.computer, c.jobs[0].state, Boolean(c.machine)]), [['off', 'stalled', false], ['on', 'running', true]]);
});

test('the job view draws a bar, the numbers and a state word for every state', async () => {
  const { jobsHtml, machineHtml, JOB_STATES } = await import('../renderer/jobs-view.js');
  const html = jobsHtml([{ name: 'train', project: 'seg', state: 'running', step: 3400, total: 10000, epoch: 17, epochs: 50, metrics: { loss: 0.1234 }, updatedAt: Date.now(), eta: 7_000_000 }]);
  for (const bit of ['34%', 'epoch 17/50', 'step 3,400/10,000', '1 h 57 left', 'loss</span> 0.123', 'aria-valuenow="34"']) assert.ok(html.includes(bit), bit);
  for (const [state, { word }] of Object.entries(JOB_STATES)) assert.ok(jobsHtml([{ name: 'x', state, updatedAt: Date.now() }]).includes(word), state);
  assert.ok(machineHtml({ gpus: [{ name: 'RTX', util: 96, memUsed: 12400, memTotal: 16380 }], cpu: 34 }).includes('GPU 96% · 12.1/16 GB'));
  assert.equal(machineHtml(undefined), '');
});
