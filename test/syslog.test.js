'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemLog, formatLine, snapshotEvents, utilisation, reminderSummary } = require('../src/core/syslog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-log-'));
const AT = new Date(2026, 8, 30, 14, 3, 12);

test('a log line is readable: time, event, key=value, quoted when needed, never split', () => {
  assert.equal(formatLine(AT, 'helper-end', { agent: 'reviewer', outcome: 'finished', time: '48s', note: 'two words', gone: undefined }),
    '2026-09-30 14:03:12  helper-end     agent=reviewer outcome=finished time=48s note="two words"');
  assert.ok(!formatLine(AT, 'x', { what: 'a\nb' }).includes('\n'));
});

test('lines are appended, read back newest last, and the file moves aside when it grows too big', () => {
  const dir = tmp();
  const log = new SystemLog(dir, { maxBytes: 200, now: () => AT });
  for (let i = 0; i < 6; i++) log.write('activity', 'summary', { sessions: i });
  assert.ok(fs.existsSync(path.join(dir, 'activity.1.log')));
  assert.match(log.tail('activity', 1)[0], /sessions=5$/);
  assert.deepEqual(new SystemLog(tmp()).tail('errors'), [], 'no log yet is not an error');
});

test('a log that cannot be written remembers why, instead of throwing', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const log = new SystemLog(path.join(blocker, 'logs'));
  log.write('errors', 'problem', { what: 'x' });
  assert.ok(log.failed);
});

const helper = (id, status, extra = {}) => ({ kind: 'agent', id, type: 'reviewer', room: 'operating-room', status, startedAt: 1000, at: 1000, tokens: 5000, skills: [], ...extra });
const snap = (steps, agents = []) => ({ sessions: [{ id: 'abcdef123456', project: 'demo-project', agents, map: { steps } }] });

test('snapshot changes become log events: starts, ends, skills and quiet sessions', () => {
  const first = snapshotEvents(undefined, snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'working')]));
  assert.deepEqual(first.map((e) => e.event), ['session-start', 'helper-start', 'skill']);
  assert.deepEqual(first[1].fields, { agent: 'reviewer', session: 'demo-project', sid: 'abcdef12', room: 'operating-room', background: undefined });
  const a = snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'working')]);
  const b = snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'done', { endedAt: 49_000, endReason: 'finished', skills: [{ name: 'project-quality', at: 2000 }] })]);
  const second = snapshotEvents(a, b);
  assert.deepEqual(second.map((e) => e.event), ['helper-end', 'skill']);
  assert.equal(second[0].fields.time, '48s');
  assert.equal(second[1].fields.by, 'reviewer');
  assert.deepEqual(snapshotEvents(b, b), [], 'nothing new, nothing logged');
  assert.deepEqual(snapshotEvents(b, { sessions: [] }).map((e) => e.event), ['session-quiet']);
});

test('the summary counts sessions and who is working now', () => {
  const s = { sessions: [{ id: 'a', agents: [{ type: 'runner', status: 'working' }, { type: 'runner', status: 'thinking' }, { type: 'reviewer', status: 'done' }] }, { id: 'b', agents: [] }] };
  assert.deepEqual(utilisation(s), { sessions: 2, helpers: 2, working: 'runnerx2' });
  assert.deepEqual(utilisation({ sessions: [] }), { sessions: 0, helpers: 0, working: undefined });
});

test('the reminder log shows whether the reminders run and fire', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const lines = ['2026-09-28T10:00:00Z\twriter', '2026-09-30T09:00:00Z\tnone', '2026-09-30T11:00:00Z\tbase\tcode-reviewer,test-runner', 'garbage'];
  assert.deepEqual(reminderSummary(lines, now), { runs: 2, reminded: 1, last: { time: Date.parse('2026-09-30T11:00:00Z'), fired: 'code-reviewer,test-runner' } });
});
