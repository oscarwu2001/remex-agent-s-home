'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findClashes, RECENT_MS } = require('../src/core/clashes');

const now = Date.now();
const s = (id, cwd, ago = 0, project = 'app') => ({ id, project, cwd, lastActivityAt: now - ago });

test('two recent sessions in the same checkout clash, whatever the slashes and case', () => {
  const res = findClashes([s('a', 'C:\\code\\app'), s('b', 'c:/code/app/src')], now);
  assert.deepEqual(res.map((r) => [r.project, r.count, r.ids]), [['app', 2, ['a', 'b']]]);
});

test('Claude app worktrees, sibling worktrees, other repos and old sessions do not clash', () => {
  const res = findClashes([
    s('a', 'C:\\code\\app'),
    s('c', 'C:\\code\\app\\.claude\\worktrees\\brave-otter'),
    s('c2', 'C:\\code\\app\\.claude\\worktrees\\calm-fox\\src'),
    s('d', 'C:\\code\\app-wip'),
    s('e', 'C:\\code\\other', 0, 'other'),
    s('f', 'C:\\code\\other', RECENT_MS + 1, 'other'),
  ], now);
  assert.deepEqual(res, []);
});

test('three sessions joined through a shared parent folder are one clash of three', () => {
  const res = findClashes([s('a', '/r/src'), s('b', '/r/docs'), s('c', '/r')], now);
  assert.deepEqual(res.map((r) => [r.count, r.ids]), [[3, ['a', 'b', 'c']]]);
});

test('two sessions in the same Claude app worktree do clash', () => {
  const res = findClashes([s('a', '/r/.claude/worktrees/x'), s('b', '/r/.claude/worktrees/x/lib')], now);
  assert.equal(res.length, 1);
});
