'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const min = 60_000;
const now = Date.parse('2026-11-02T03:00:00Z');

test('sessions that wait on the user are listed, oldest wait first; dismissed ones stay hidden until they move', async () => {
  const { waitingList, waitKey } = await import('../renderer/waiting.js');
  const sessions = [
    { id: 'a', project: 'docdesk', status: 'working', lastActivityAt: now, agents: [{ type: 'reviewer', status: 'blocked', lastActivityAt: now - 3 * min }] },
    { id: 'b', project: 'endo', status: 'your-turn', lastActivityAt: now - 12 * min, agents: [] },
    { id: 'c', project: 'seg', status: 'thinking', lastActivityAt: now, agents: [] },
    { id: 'd', project: 'cad', status: 'blocked', lastActivityAt: now - min, agents: [] },
  ];
  const list = waitingList(sessions);
  assert.deepEqual(list.map((w) => [w.project, w.status, w.helper]), [['endo', 'your-turn', undefined], ['docdesk', 'blocked', 'reviewer'], ['cad', 'blocked', undefined]]);
  const hidden = waitingList(sessions, new Set([waitKey(list[0])]));
  assert.deepEqual(hidden.map((w) => w.project), ['docdesk', 'cad']);
  sessions[1].lastActivityAt = now; // it did something new: back in view
  assert.equal(waitingList(sessions, new Set([waitKey(list[0])])).length, 3);
});

test('work that ends is announced once, with how it ended; an offline computer\'s work is not', async () => {
  const { endedWork } = await import('../renderer/waiting.js');
  const ov = (jobs, work, online = true) => ({ computers: [{ computer: 'PC', local: true, online: true, jobs, work }, { computer: 'RD', online, work: [{ name: 'sim.py', startedAt: 1 }] }] });
  const first = endedWork(ov([{ name: 'train', state: 'running', startedAt: 5 }], [{ name: 'eval.py', project: 'seg', startedAt: 9 }]));
  assert.deepEqual(first.ended, []);
  const second = endedWork(ov([{ name: 'train', state: 'failed', startedAt: 5 }], [], false), first.running);
  assert.deepEqual(second.ended.map((e) => e.text).sort(), ['eval.py (seg) stopped running.', 'train failed.']);
});
