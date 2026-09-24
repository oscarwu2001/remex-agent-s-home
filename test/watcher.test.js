'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TranscriptWatcher, defaultRoots } = require('../src/core/watcher');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'));
}

function collect(root, options = {}) {
  const got = { entries: [], malformed: [], problems: [] };
  const w = new TranscriptWatcher({
    roots: [root],
    onEntry: (file, entry) => got.entries.push([path.basename(file), entry.n]),
    onMalformed: (file, err) => got.malformed.push([path.basename(file), err.message]),
    onProblem: (m) => got.problems.push(m),
    options: { listEveryMs: 0, ...options },
  });
  return { w, got };
}

test('tails appended lines and holds back a half-written one', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":');
  const { w, got } = collect(root);
  w.tick();
  assert.deepEqual(got.entries, [['s.jsonl', 1]]);
  fs.appendFileSync(file, '2}\n{"n":3}\n');
  w.tick();
  assert.deepEqual(got.entries, [['s.jsonl', 1], ['s.jsonl', 2], ['s.jsonl', 3]]);
  assert.deepEqual(got.malformed, []);
});

test('finds sub-agent files nested under a session folder', () => {
  const root = tmpRoot();
  const sub = path.join(root, 'proj', 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{"n":7}\n');
  const { w, got } = collect(root);
  w.tick();
  assert.deepEqual(got.entries, [['agent-1.jsonl', 7]]);
});

test('malformed lines are reported, and reading carries on', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 'a.jsonl'), 'not json\n{"n":2}\n');
  const { w, got } = collect(root);
  w.tick();
  assert.equal(got.malformed.length, 1);
  assert.deepEqual(got.entries, [['a.jsonl', 2]]);
});

test('files older than the active window are left alone', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'p'));
  const file = path.join(root, 'p', 'old.jsonl');
  fs.writeFileSync(file, '{"n":1}\n');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(file, old, old);
  const { w, got } = collect(root);
  w.tick();
  assert.deepEqual(got.entries, []);
});

test('a large file is replayed from its tail, dropping the partial first line', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'p'));
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(20) }));
  fs.writeFileSync(path.join(root, 'p', 'big.jsonl'), `${lines.join('\n')}\n`);
  const { w, got } = collect(root, { maxInitialBytes: 200 });
  w.tick();
  assert.ok(got.entries.length > 0 && got.entries.length < 50);
  assert.equal(got.entries.at(-1)[1], 49);
  assert.deepEqual(got.malformed, []);
});

test('a missing root is reported as missing, not as an error', () => {
  const { w, got } = collect(path.join(tmpRoot(), 'nope'));
  w.tick();
  assert.equal(w.status().roots[0].state, 'missing');
  assert.deepEqual(got.problems, []);
});

test('CLAUDE_CONFIG_DIR adds a root ahead of the home folder', () => {
  const roots = defaultRoots({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u');
  assert.deepEqual(roots, [path.join('/cfg', 'projects'), path.join('/home/u', '.claude', 'projects')]);
});

test('starting exactly on a line boundary keeps that first line', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'p'));
  const a = '{"n":1}\n';
  fs.writeFileSync(path.join(root, 'p', 'b.jsonl'), `${a}{"n":2}\n`);
  const { w, got } = collect(root, { maxInitialBytes: Buffer.byteLength('{"n":2}\n') });
  w.tick();
  assert.deepEqual(got.entries, [['b.jsonl', 2]]);
});

test('an error while handling one line is reported and the rest still arrive', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 'c.jsonl'), '{"n":1}\n{"n":2}\n{"n":3}\n');
  const seen = [];
  const problems = [];
  const w = new TranscriptWatcher({
    roots: [root],
    onEntry: (file, e) => {
      if (e.n === 2) throw new Error('boom');
      seen.push(e.n);
    },
    onMalformed: () => {},
    onProblem: (label, detail) => problems.push([label, detail]),
    options: { listEveryMs: 0 },
  });
  w.tick();
  assert.deepEqual(seen, [1, 3]);
  assert.equal(problems.length, 1);
  assert.doesNotMatch(problems[0][0], /c\.jsonl|\//); // the label carries no path
});
