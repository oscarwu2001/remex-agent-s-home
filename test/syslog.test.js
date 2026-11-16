'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemLog, formatLine, logEvents, snapshotEvents, loggedSoFar, loggedFromLog, closeOnBoard, utilisation, reminderSummary } = require('../src/core/syslog');

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

const eventsIn = (log, name) => log.tail(name).map((l) => l.split(/\s+/)[2]);

test('a line that could not be written goes with the next one, in order, and each failure counts', () => {
  const blocker = path.join(tmp(), 'logs');
  fs.writeFileSync(blocker, 'x'); // a file where the folder should be
  const log = new SystemLog(blocker, { now: () => AT });
  log.write('activity', 'helper-start', { agent: 'a' });
  log.write('activity', 'helper-end', { agent: 'a' });
  assert.equal(log.failures, 2);
  fs.rmSync(blocker);
  log.write('activity', 'skill', { skill: 'tdd' });
  assert.deepEqual(eventsIn(log, 'activity'), ['helper-start', 'helper-end', 'skill']);
  log.write('activity', 'summary', {});
  assert.deepEqual(eventsIn(log, 'activity'), ['helper-start', 'helper-end', 'skill', 'summary'], 'written once each');
  assert.equal(log.failures, 2);
});

test('a log that cannot move aside keeps growing rather than lose a line', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'activity.1.log')); // a folder in the way of the move
  fs.writeFileSync(path.join(dir, 'activity.1.log', 'x'), 'x');
  const log = new SystemLog(dir, { maxBytes: 100, now: () => AT });
  for (let i = 0; i < 5; i++) log.write('activity', 'summary', { sessions: i });
  assert.equal(log.tail('activity').length, 5);
  assert.match(log.failed, /moving activity\.log aside/);
});

test('one copy of the app writes a log, and another takes it over once that copy stops', () => {
  const dir = tmp();
  const lock = path.join(dir, 'activity.lock');
  const t0 = Date.now();
  const first = new SystemLog(dir, { now: () => AT });
  assert.equal(first.claim('activity', process.pid, t0), true);
  const second = new SystemLog(dir, { now: () => AT });
  assert.equal(second.claim('activity', process.ppid, t0 + 1_000), false, 'held: touched just now, by a process that runs');
  assert.equal(second.heldBy, process.pid);
  second.write('activity', 'summary', { sessions: 1 });
  first.write('activity', 'summary', { sessions: 2 });
  assert.deepEqual(first.tail('activity').map((l) => l.split(' ').at(-1)), ['sessions=2'], 'only the holder writes');
  assert.equal(first.keep('activity', process.pid, t0 + 20_000), true, 'the holder touches its lock on each tick');
  assert.equal(second.keep('activity', process.ppid, t0 + 40_000), false, 'touched 20 s ago: still held');
  assert.equal(second.keep('activity', process.ppid, t0 + 60_000), true, 'untouched for 40 s: the holder stopped without letting go');
  second.write('activity', 'summary', { sessions: 3 });
  assert.equal(first.tail('activity').at(-1).split(' ').at(-1), 'sessions=3');
  second.release('activity', process.ppid);
  assert.ok(!fs.existsSync(lock), 'let go as it quits');
});

test('a lock left behind is taken over, even when its PID now belongs to another process', () => {
  const dir = tmp();
  const lock = path.join(dir, 'activity.lock');
  fs.writeFileSync(lock, String(process.ppid)); // left by a copy Windows shut down; its PID now another program's
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(new SystemLog(dir).claim('activity'), true);
  fs.writeFileSync(lock, '2147483646'); // left by a copy that crashed a moment ago
  assert.equal(new SystemLog(dir).claim('activity', process.ppid), true);
});

test('lines still waiting after failed writes are tried once more as the app quits', () => {
  const blocker = path.join(tmp(), 'logs');
  fs.writeFileSync(blocker, 'x');
  const log = new SystemLog(blocker, { now: () => AT });
  log.write('activity', 'helper-end', { call: 'c1' });
  fs.rmSync(blocker);
  log.flush('activity');
  assert.deepEqual(eventsIn(log, 'activity'), ['helper-end']);
  assert.equal(log.writtenAt('errors'), undefined, 'never written');
  assert.ok(Math.abs(log.writtenAt('activity') - Date.now()) < 60_000);
});

test('the log read back knows each helper, skill and session it wrote', () => {
  const sid = 'abcdef12';
  const lines = [
    formatLine(AT, 'app-start', { version: '0.9.0' }),
    formatLine(AT, 'session-start', { session: 'demo project', sid }),
    formatLine(AT, 'helper-start', { agent: 'builder', session: 'demo project', sid, call: 'c1' }),
    formatLine(AT, 'helper-end', { agent: 'builder', session: 'demo project', sid, call: 'c1', outcome: 'finished', time: '40s' }),
    formatLine(AT, 'helper-end', { agent: 'runner', session: 'demo project', sid, call: 'c2', outcome: 'lost' }),
    formatLine(AT, 'helper-end-corrected', { agent: 'runner', session: 'demo project', sid, call: 'c3', outcome: 'error', was: 'finished' }),
    formatLine(AT, 'skill', { skill: 'tdd', by: 'session', session: 'demo project', sid, call: 'k1' }),
    formatLine(AT, 'session-start', { session: 'other', sid: 'fedcba98' }),
    formatLine(AT, 'session-quiet', { session: 'other', sid: 'fedcba98' }),
    'not a line of the log',
  ];
  const logged = loggedFromLog(lines);
  assert.deepEqual([...logged.started], ['c1', 'c2', 'c3']);
  assert.deepEqual([...logged.ended], ['c1', 'c2', 'c3']);
  assert.deepEqual([[...logged.lost], [...logged.corrected], [...logged.skills]], [['c2'], ['c3'], ['k1']]);
  assert.deepEqual([[...logged.sessions], [...logged.onBoard]], [[sid, 'fedcba98'], [[sid, 'demo project']]]);
});

const helper = (id, status, extra = {}) => ({ kind: 'agent', id, type: 'reviewer', room: 'operating-room', status, startedAt: 1000, at: 1000, tokens: 5000, skills: [], ...extra });
const snap = (steps, agents = []) => ({ sessions: [{ id: 'abcdef123456', project: 'demo-project', agents, map: { steps } }] });

test('snapshot changes become log events: starts, ends, skills and quiet sessions', () => {
  const first = snapshotEvents(undefined, snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'working')]));
  assert.deepEqual(first.map((e) => e.event), ['session-start', 'helper-start', 'skill']);
  assert.deepEqual(first[1].fields, { agent: 'reviewer', session: 'demo-project', sid: 'abcdef12', call: 'r1', room: 'operating-room', background: undefined });
  const a = snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'working')]);
  const b = snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'done', { endedAt: 49_000, endReason: 'finished', skills: [{ name: 'project-quality', at: 2000 }] })]);
  const second = snapshotEvents(a, b);
  assert.deepEqual(second.map((e) => e.event), ['helper-end', 'skill']);
  assert.equal(second[0].fields.time, '48s');
  assert.equal(second[1].fields.by, 'reviewer');
  assert.deepEqual(snapshotEvents(b, b), [], 'nothing new, nothing logged');
  assert.deepEqual(snapshotEvents(b, { sessions: [] }).map((e) => e.event), ['session-quiet']);
});

test('a session that leaves the board and comes back is not logged twice', () => {
  const logged = loggedSoFar();
  const s1 = snap([{ kind: 'skill', name: 'implement', at: 900 }, helper('r1', 'done', { endedAt: 49_000, endReason: 'finished' })]);
  assert.deepEqual(snapshotEvents(undefined, s1, logged).map((e) => e.event), ['session-start', 'helper-start', 'helper-end', 'skill']);
  assert.deepEqual(snapshotEvents(s1, { sessions: [] }, logged).map((e) => e.event), ['session-quiet']);
  assert.deepEqual(snapshotEvents({ sessions: [] }, s1, logged).map((e) => e.event), ['session-back']);
});

test('the went-quiet guess is not logged as an end; the real end is, once, with its real time', () => {
  const logged = loggedSoFar();
  const working = snap([helper('b1', 'working', { background: true })]);
  snapshotEvents(undefined, working, logged);
  const guessed = snap([helper('b1', 'done', { background: true, endedAt: 121_000, endReason: 'went quiet' })]);
  assert.deepEqual(snapshotEvents(working, guessed, logged), []);
  const done = snap([helper('b1', 'done', { background: true, endedAt: 601_000, endReason: 'finished' })]);
  const ends = snapshotEvents(guessed, done, logged);
  assert.deepEqual(ends.map((e) => e.event), ['helper-end']);
  assert.equal(ends[0].fields.time, '600s');
  assert.equal(ends[0].fields.background, 'yes');
  assert.deepEqual(snapshotEvents(done, done, logged), []);
});

test('the end line says background even when the start line was written before the launch said so', () => {
  const logged = loggedSoFar();
  const launching = snap([helper('a1', 'working')]);
  const started = snapshotEvents(undefined, launching, logged);
  assert.equal(started.find((e) => e.event === 'helper-start').fields.background, undefined);
  const ended = snapshotEvents(launching, snap([helper('a1', 'done', { background: true, endedAt: 61_000, endReason: 'finished' })]), logged);
  assert.deepEqual(ended.map((e) => [e.event, e.fields.background]), [['helper-end', 'yes']]);
});

test('a helper that has dropped off the end of a long map is still logged when it finishes', () => {
  const logged = loggedSoFar();
  const before = snap([helper('old', 'working')], [helper('old', 'working')]);
  snapshotEvents(undefined, before, logged);
  const after = snap([{ kind: 'skill', name: 'tdd', at: 5000 }], [helper('old', 'done', { endedAt: 31_000, endReason: 'finished' })]);
  assert.deepEqual(snapshotEvents(before, after, logged).map((e) => e.event), ['helper-end', 'skill']);
});

// Views in the shape of Tracker.logView(), for logEvents.
const SID = 'abcdef123456';
const board = new Map([[SID, { id: SID, project: 'demo-project' }]]);
const viewOf = (helpers, skills = []) => new Map([[SID, { id: SID, project: 'demo-project', helpers, skills }]]);
const vh = (id, extra = {}) => ({ id, type: 'builder', room: 'workshop', background: false, launched: false, startedAt: 1_000, status: 'running', tokens: 0, skills: [], ...extra });

test('a start line waits for the launch to return, so it can say the helper went to the background', () => {
  const logged = loggedSoFar();
  assert.deepEqual(logEvents({ board, view: viewOf([vh('h1')]), logged, now: 2_000 }).map((e) => e.event), ['session-start']);
  const launched = logEvents({ prevBoard: board, board, view: viewOf([vh('h1', { launched: true, background: true })]), logged, now: 2_500 });
  assert.deepEqual(launched.map((e) => [e.event, e.fields.background]), [['helper-start', 'yes']]);
  const foreground = logEvents({ prevBoard: board, board, view: viewOf([vh('h2')]), logged, now: 6_500 });
  assert.deepEqual(foreground.map((e) => e.event), ['helper-start'], 'written once its launch has had time to return');
});

test("an end line waits a few seconds, for the helper's last token counts", () => {
  const logged = loggedSoFar();
  const done = (tokens) => viewOf([vh('h1', { launched: true, status: 'done', endedAt: 61_000, endReason: 'finished', tokens })]);
  logEvents({ board, view: viewOf([vh('h1', { launched: true })]), logged, now: 2_000 });
  assert.deepEqual(logEvents({ prevBoard: board, board, view: done(900), logged, now: 62_000 }), []);
  const ends = logEvents({ prevBoard: board, board, view: done(1_200), logged, now: 66_500 });
  assert.deepEqual(ends.map((e) => [e.event, e.fields.time, e.fields.tokens]), [['helper-end', '60s', 1_200]]);
});

test('a helper the tracker lets go of is written as lost, unless it had a real end not yet written', () => {
  const logged = loggedSoFar();
  const held = viewOf([
    vh('q1', { launched: true, background: true, status: 'done', endedAt: 200_000, endReason: 'went quiet' }),
    vh('f1', { launched: true, background: true, status: 'done', endedAt: 300_000, endReason: 'finished' }),
  ]);
  logEvents({ board, view: held, logged, now: 301_000 }); // both started; f1's end still settling
  const pruned = logEvents({ prevBoard: board, board: new Map(), prevView: held, view: new Map(), logged, now: 302_000 });
  assert.deepEqual(pruned.map((e) => [e.event, e.fields.outcome ?? null, e.fields.time ?? null]),
    [['session-quiet', null, null], ['helper-end', 'lost', null], ['helper-end', 'finished', '299s']]);
});

test('after a restart, what the log has is not written again, and what it lacks is, whatever the clocks say', () => {
  const where = { session: 'demo-project', sid: 'abcdef12' };
  // The last run wrote these lines and stopped with h3's end still waiting.
  const logged = loggedFromLog([
    formatLine(AT, 'session-start', where),
    formatLine(AT, 'helper-start', { agent: 'builder', ...where, call: 'old' }),
    formatLine(AT, 'helper-end', { agent: 'builder', ...where, call: 'old', outcome: 'finished', time: '40s' }),
    formatLine(AT, 'helper-start', { agent: 'builder', ...where, call: 'h3' }),
    formatLine(AT, 'helper-start', { agent: 'runner', ...where, call: 'b1' }),
    formatLine(AT, 'helper-end', { agent: 'runner', ...where, call: 'b1', outcome: 'lost' }),
    formatLine(AT, 'helper-start', { agent: 'reviewer', ...where, call: 's1' }),
    formatLine(AT, 'helper-end', { agent: 'reviewer', ...where, call: 's1', outcome: 'finished', time: '0s' }),
    formatLine(AT, 'skill', { skill: 'tdd', by: 'session', ...where, call: 'k1' }),
  ]);
  // What the transcripts read again say now (times as old or as new as they like).
  const view = viewOf([
    vh('old', { launched: true, status: 'done', endedAt: 41_000, endReason: 'finished' }),
    vh('h3', { launched: true, status: 'done', endedAt: 90_000, endReason: 'finished' }),
    vh('b1', { launched: true, background: true, status: 'done', endedAt: 95_000, endReason: 'finished' }),
    vh('s1', { launched: true, background: true, status: 'done', endedAt: 300_000, endReason: 'error', correctedFrom: 'finished' }),
    vh('new', { launched: true, startedAt: 120_000 }),
  ], [{ id: 'k1', name: 'tdd', at: 5_000 }, { id: 'k2', name: 'grill', at: 110_000 }]);
  const out = logEvents({ board, view, logged, now: 400_000 });
  assert.deepEqual(out.map((e) => [e.event, e.fields.call, e.fields.was ?? null]), [
    ['helper-end', 'h3', null], // waiting when the app stopped
    ['helper-end-corrected', 'b1', 'lost'],
    ['helper-end-corrected', 's1', 'finished'], // a stray notification read after the restart
    ['helper-start', 'new', null],
    ['skill', 'k2', null],
  ], 'and no session line: it was on the board when the app stopped');
  assert.deepEqual(logEvents({ prevBoard: board, board, prevView: view, view, logged, now: 402_000 }), []);
  assert.deepEqual(logEvents({ board, prevView: view, view, logged, now: 404_000 }).map((e) => e.event), ['session-back'], 'leaving and coming back is news');
  const quiet = loggedFromLog([formatLine(AT, 'session-start', where), formatLine(AT, 'session-quiet', where)]);
  assert.deepEqual(logEvents({ board, view: new Map(), logged: quiet, now: 1 }).map((e) => e.event), ['session-back'], 'quiet when the app stopped');
});

test('sessions the log left open are closed, saying they went quiet while the app was off', () => {
  const logged = loggedFromLog([
    formatLine(AT, 'session-start', { session: 'here', sid: 'abcdef12' }),
    formatLine(AT, 'session-back', { session: 'gone', sid: '11112222' }),
  ]);
  assert.deepEqual(closeOnBoard(logged, board).map((e) => [e.event, e.fields.session, e.fields.sid, e.fields.while]),
    [['session-quiet', 'gone', '11112222', 'app-off']], 'the one on the board now stays open');
  assert.equal(logged.onBoard.size, 0);
  assert.deepEqual(logEvents({ board, view: new Map(), logged, now: 1 }).map((e) => e.event), ['session-back'], 'seen again later: it is news');
});

test('as the app quits, what still waits is written', () => {
  const logged = loggedSoFar();
  const view = viewOf([vh('h1', { status: 'done', endedAt: 9_000, endReason: 'finished' }), vh('h2', { startedAt: 9_500 })]);
  assert.deepEqual(logEvents({ board, view, logged, now: 10_000 }).map((e) => [e.event, e.fields.call ?? null]),
    [['session-start', null], ['helper-start', 'h1']], 'its end waits for its tokens; h2 waits for its launch');
  assert.deepEqual(logEvents({ prevBoard: board, board, prevView: view, view, logged, now: Infinity }).map((e) => [e.event, e.fields.call]),
    [['helper-end', 'h1'], ['helper-start', 'h2']]);
});

test('an end that turns out wrong is corrected once, saying what was written first', () => {
  const logged = loggedSoFar();
  const atLaunch = viewOf([vh('h1', { launched: true, status: 'done', endedAt: 1_200, endReason: 'finished' })]);
  assert.deepEqual(logEvents({ board, view: atLaunch, logged, now: 10_000 }).map((e) => [e.event, e.fields.time ?? null]),
    [['session-start', null], ['helper-start', null], ['helper-end', '0s']]);
  const notified = viewOf([vh('h1', { launched: true, background: true, status: 'done', endedAt: 601_000, endReason: 'error', correctedFrom: 'finished' })]);
  const fixed = logEvents({ prevBoard: board, board, prevView: atLaunch, view: notified, logged, now: 610_000 });
  assert.deepEqual(fixed.map((e) => [e.event, e.fields.call, e.fields.outcome, e.fields.time, e.fields.was, e.fields.background]),
    [['helper-end-corrected', 'h1', 'error', '600s', 'finished', 'yes']]);
  assert.deepEqual(logEvents({ prevBoard: board, board, prevView: notified, view: notified, logged, now: 620_000 }), []);
});

test('a notification that comes before the end line is written leaves one end line, the right one', () => {
  const logged = loggedSoFar();
  logEvents({ board, view: viewOf([vh('h1', { launched: true })]), logged, now: 2_000 });
  const notified = viewOf([vh('h1', { launched: true, background: true, status: 'done', endedAt: 4_000, endReason: 'finished', correctedFrom: 'interrupted' })]);
  assert.deepEqual(logEvents({ prevBoard: board, board, view: notified, logged, now: 10_000 }).map((e) => [e.event, e.fields.outcome]), [['helper-end', 'finished']]);
  assert.deepEqual(logEvents({ prevBoard: board, board, view: notified, logged, now: 20_000 }), []);
});

test('a helper written as lost gets its real end as a correction when its session is read again', () => {
  const logged = loggedSoFar();
  const held = viewOf([vh('b1', { launched: true, background: true })]);
  logEvents({ board, view: held, logged, now: 2_000 });
  const pruned = logEvents({ prevBoard: board, board: new Map(), prevView: held, view: new Map(), logged, now: 90_000_000 });
  assert.deepEqual(pruned.map((e) => [e.event, e.fields.outcome ?? null]), [['session-quiet', null], ['helper-end', 'lost']]);
  const readAgain = viewOf([vh('b1', { launched: true, background: true, status: 'done', endedAt: 95_000_000, endReason: 'finished' })]);
  const late = logEvents({ board, view: readAgain, logged, now: 95_010_000 });
  assert.deepEqual(late.map((e) => [e.event, e.fields.outcome ?? null, e.fields.was ?? null]),
    [['session-back', null, null], ['helper-end-corrected', 'finished', 'lost']]);
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
