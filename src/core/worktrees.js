'use strict';

// A project's worktrees, looked at when the user asks (Projects → a project
// → Worktrees): each one's branch, whether that branch is already merged
// into the main branch, uncommitted files and last activity, and which are
// safe to remove (merged, nothing uncommitted, not the main checkout). Read
// only: git commands that look, never ones that change anything, and no
// network (nothing is fetched).

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };

function git(cwd, args, run = execFile) {
  return new Promise((resolve, reject) => {
    run('git', ['-C', cwd, ...args], { timeout: 20_000, windowsHide: true, env: ENV, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? 'git was not found' : String(stderr || err.message).trim().split('\n').pop()));
      else resolve(String(out));
    });
  });
}

// `git worktree list --porcelain` -> [{ path, branch, main, bare, detached, prunable }]
function parseWorktreeList(text) {
  const out = [];
  let cur;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: undefined, main: out.length === 0, detached: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out.filter((w) => !w.bare);
}

// The branch other work is merged into: origin's HEAD, else main, master or dev.
async function defaultBranch(repo, run) {
  try {
    return (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], run)).trim().replace(/^origin\//, '');
  } catch {
    // No remote HEAD recorded: look for the usual names below.
  }
  const local = (await git(repo, ['branch', '--format=%(refname:short)'], run)).split(/\r?\n/).filter(Boolean);
  return ['main', 'master', 'dev', 'develop'].find((b) => local.includes(b)) ?? local[0];
}

async function inspectWorktrees(repo, { run = execFile, now = Date.now() } = {}) {
  if (!repo || !fs.existsSync(repo)) return { ok: false, error: 'The project folder is not on this computer.' };
  let list;
  try {
    list = parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain'], run));
  } catch (err) {
    return { ok: false, error: `This folder is not a git repository, or git could not read it (${err.message}).` };
  }
  const base = await defaultBranch(repo, run).catch(() => undefined);
  let merged = new Set();
  if (base) {
    try {
      merged = new Set((await git(repo, ['branch', '--merged', base, '--format=%(refname:short)'], run)).split(/\r?\n/).filter(Boolean));
    } catch {
      // Unknown: no branch is called merged, so none is called safe.
    }
  }
  const trees = await Promise.all(list.map(async (w) => {
    const t = { name: path.basename(w.path.replace(/[\\/]+$/, '')), path: w.path, branch: w.branch, main: w.main, detached: w.detached, missing: w.prunable };
    if (w.prunable || !fs.existsSync(w.path)) return { ...t, missing: true };
    try {
      t.changed = (await git(w.path, ['status', '--porcelain'], run)).split(/\r?\n/).filter(Boolean).length;
      t.lastCommit = Number((await git(w.path, ['log', '-1', '--format=%ct'], run)).trim()) * 1000 || undefined;
    } catch (err) {
      t.error = err.message;
    }
    try {
      t.touched = fs.statSync(w.path).mtimeMs;
    } catch {
      // The folder's own time is a hint only.
    }
    t.merged = Boolean(w.branch && base && w.branch !== base && merged.has(w.branch));
    t.safe = !w.main && !t.error && t.changed === 0 && t.merged;
    return t;
  }));
  const order = (t) => (t.main ? 0 : t.missing ? 3 : t.safe ? 2 : 1);
  trees.sort((a, b) => order(a) - order(b) || (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
  return { ok: true, base, trees, at: now };
}

module.exports = { inspectWorktrees, parseWorktreeList };
