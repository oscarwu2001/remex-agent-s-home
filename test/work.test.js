'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/core/work');

const now = Date.parse('2026-10-30T07:00:00Z');
const min = 60_000;

test('the script is found in a Python command line, never its arguments or path', () => {
  assert.deepEqual(W.scriptOf('"C:\\\\Py\\\\python.exe" "C:\\\\Users\\\\me\\\\code\\\\seg\\\\train.py" --data D:\\\\secret'), { name: 'train.py', file: 'C:\\\\Users\\\\me\\\\code\\\\seg\\\\train.py' });
  assert.deepEqual(W.scriptOf('python -u -m ultralytics.yolo train data=x.yaml'), { name: '-m ultralytics.yolo' });
  assert.equal(W.scriptOf('python'), undefined, 'an interactive Python is not a job');
  assert.equal(W.scriptOf('python -c "print(1)"'), undefined);
});

test('work is what is on the GPU, or has kept half a core busy for 5 minutes; idle Pythons are left out', () => {
  const procs = [
    { pid: 1, startedAt: now - 130 * min, cpuMs: 10 * min, cmdline: 'python C:/code/spine-seg/train.py' }, // on the GPU
    { pid: 2, startedAt: now - 60 * min, cpuMs: 50 * min, cmdline: 'python /home/me/sim/run_sim.py' }, // busy CPU
    { pid: 3, startedAt: now - 300 * min, cpuMs: 2 * min, cmdline: 'python c:/x/lsp_server.py' }, // idle helper
    { pid: 4, startedAt: now - 2 * min, cpuMs: 2 * min, cmdline: 'python /a/b/quick.py' }, // too young to judge
  ];
  const gpu = new Map([[1, 11264]]);
  const projects = [{ name: 'Spine seg', path: 'c:\\code\\spine-seg' }];
  const work = W.pickWork(procs, gpu, now, projects);
  assert.deepEqual(work.map((w) => [w.name, w.project, w.on, w.gpuMem]), [['train.py', 'Spine seg', 'gpu', 11264], ['run_sim.py', 'sim', 'cpu', undefined]]);
});

test('Windows process lists and nvidia-smi output are read', () => {
  const ps = JSON.stringify([{ ProcessId: 7, CreationDate: '/Date(1793340000000)/', CommandLine: 'python t.py', KernelModeTime: 10_000_000, UserModeTime: 50_000_000 }]);
  assert.deepEqual(W.parseWindows(ps), [{ pid: 7, startedAt: 1793340000000, cpuMs: 6000, cmdline: 'python t.py' }]);
  assert.equal(W.parseWindows(JSON.stringify({ ProcessId: 8, CreationDate: '/Date(5)/', CommandLine: 'x', KernelModeTime: 0, UserModeTime: 0 })).length, 1, 'one process comes as an object');
  assert.deepEqual(W.parseWindows(''), []);
  assert.deepEqual([...W.parseGpuApps('1234, 11264\n5678, [N/A]\n').entries()], [[1234, 11264], [5678, 0]]);
});

test('a status post\'s running work is rebuilt from checked values', () => {
  const J = require('../src/core/jobs');
  assert.deepEqual(J.cleanWork({ name: 'train.py', project: 'seg', on: 'gpu', startedAt: 5, gpuMem: 100, pid: 9, extra: 'x' }), { name: 'train.py', project: 'seg', on: 'gpu', startedAt: 5, gpuMem: 100 });
  assert.equal(J.cleanWork({ name: 'x' }), undefined, 'no start time, no row');
  assert.equal(J.cleanWork({ name: 'x', startedAt: 5, on: 'evil' }).on, 'cpu');
});

test('the work row says what runs, where, and for how long', async () => {
  const { workHtml } = await import('../renderer/jobs-view.js');
  const html = workHtml([{ name: 'train.py', project: 'seg', on: 'gpu', startedAt: now - 130 * min, gpuMem: 11264 }], now);
  for (const bit of ['train.py', 'seg', 'running for 2 h 10', 'GPU · 11.0 GB']) assert.ok(html.includes(bit), bit);
  assert.ok(workHtml([{ name: 'x.py', on: 'cpu', startedAt: now - 7 * min }], now).includes('running for 7 min · CPU'));
});

test('the work row says what runs, where, and for how long', async () => {
  const { workHtml } = await import('../renderer/jobs-view.js');
  const html = workHtml([{ name: 'train.py', project: 'seg', on: 'gpu', startedAt: now - 130 * min, gpuMem: 11264 }], now);
  for (const bit of ['train.py', 'seg', 'running for 2 h 10', 'GPU · 11.0 GB']) assert.ok(html.includes(bit), bit);
  assert.ok(workHtml([{ name: 'x.py', on: 'cpu', startedAt: now - 7 * min }], now).includes('running for 7 min · CPU'));
});
