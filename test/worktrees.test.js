'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const W = require('../src/core/worktrees');

const hasGit = spawnSync('git', ['--version']).status === 0;

test('git worktree list is read: the first is the main checkout, branch names lose refs/heads', () => {
  const list = W.parseWorktreeList('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r-fix\nHEAD def\nbranch refs/heads/fix/x\n\nworktree /r-old\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(list.map((w) => [w.path, w.branch, w.main, w.detached, w.prunable]), [['/r', 'main', true, false, false], ['/r-fix', 'fix/x', false, false, false], ['/r-old', undefined, false, true, true]]);
});

test('worktrees: merged and clean ones are safe to remove, ones with work are not, the main one never', { skip: !hasGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wt-'));
  const repo = path.join(dir, 'app');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { stdio: 'pipe' });
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  g(repo, 'worktree', 'add', '-q', '-b', 'done-feature', path.join(dir, 'app-done'));
  g(repo, 'worktree', 'add', '-q', '-b', 'wip', path.join(dir, 'app-wip'));
  g(path.join(dir, 'app-wip'), 'commit', '-q', '--allow-empty', '-m', 'not merged yet');
  g(repo, 'worktree', 'add', '-q', '-b', 'dirty', path.join(dir, 'app-dirty'));
  fs.writeFileSync(path.join(dir, 'app-dirty', 'note.txt'), 'x');
  const res = await W.inspectWorktrees(repo);
  assert.equal(res.ok, true);
  assert.equal(res.base, 'main');
  const by = Object.fromEntries(res.trees.map((t) => [t.name, t]));
  assert.deepEqual([by.app.main, by.app.safe], [true, false]);
  assert.deepEqual([by['app-done'].merged, by['app-done'].safe], [true, true]);
  assert.deepEqual([by['app-wip'].merged, by['app-wip'].safe], [false, false]);
  assert.deepEqual([by['app-dirty'].changed, by['app-dirty'].safe], [1, false]);
  assert.equal(res.trees[res.trees.length - 1].name, 'app-done', 'safe ones are listed last');
});

test('a folder that is not a repository says so', async () => {
  assert.equal((await W.inspectWorktrees(path.join(os.tmpdir(), 'no-such-repo-xyz'))).ok, false);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-plain-'));
  if (hasGit) assert.match((await W.inspectWorktrees(plain)).error, /not a git repository/);
});
