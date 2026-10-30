#!/usr/bin/env node
'use strict';
// Posts this computer's work status to the agents-status branch, for Agent's
// Home on the main workstation to pull. Plain Node and git: no Claude call,
// no tokens. Run hourly by the scheduled task (install-task.ps1), 9:00-19:00.
//
//   node post-status.js            post now (skips outside 9:00-19:00)
//   node post-status.js --force    post at any hour
//   node post-status.js --dry      print the status, change nothing
//
// It writes status/<computer>.md (for people) and status/<computer>.json
// (for the app) and pushes them. What it holds: project folder names,
// branches, commit times, counts. Never file names, prompts, commit messages
// or to-do wording.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOURS = [9, 19]; // post from 9:00 up to and including 19:00
const RECENT_MS = 60 * 60_000; // sessions with a write in the last hour
const LIVE_MS = 5 * 60_000; // a write this recent counts as running
const args = new Set(process.argv.slice(2));
const repo = __dirname;
const home = os.homedir();
const computer = os.hostname();
const now = Date.now();

const hour = new Date(now).getHours();
if (!args.has('--force') && !args.has('--dry') && (hour < HOURS[0] || hour > HOURS[1])) process.exit(0);

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return ''; } }; // a folder that is not (or no longer) a repo has nothing to say

// ---- Claude sessions written to in the last hour ----------------------------

function transcriptRoots() {
  const roots = [{ dir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'), cowork: false }];
  const data = process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude') : path.join(home, '.config', 'Claude');
  for (const kind of ['local-agent-mode-sessions', 'claude-code-sessions']) {
    const walk = (dir, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // no Cowork tasks here
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (depth === 2) { const r = path.join(p, '.claude', 'projects'); if (fs.existsSync(r)) roots.push({ dir: r, cowork: true }); } else walk(p, depth + 1);
      }
    };
    walk(path.join(data, kind), 0);
  }
  return roots;
}

function recentFiles({ dir: root, cowork }) {
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // a root that is not there
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 1) walk(p, depth + 1); continue; } // projects/<cwd>/<session>.jsonl only
      if (!e.name.endsWith('.jsonl')) continue;
      const st = fs.statSync(p);
      if (now - st.mtimeMs <= RECENT_MS) out.push({ file: p, at: st.mtimeMs, cowork });
    }
  };
  walk(root, 0);
  return out;
}

// The session's folder and its latest to-do list (TodoWrite), read from the
// last 2 MB of the transcript. Only counts leave this computer.
function readSession(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(size, 2 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  let cwd;
  let todos;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.includes('"cwd"') && !line.includes('TodoWrite')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // the first line may be cut in half by the 2 MB window
    if (typeof e.cwd === 'string') cwd = e.cwd;
    for (const b of e.message?.content ?? []) {
      if (b?.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        const t = b.input.todos;
        todos = { total: t.length, done: t.filter((x) => x.status === 'completed').length, doing: t.filter((x) => x.status === 'in_progress').length };
      }
    }
  }
  return { cwd, todos };
}

// ---- the project list's projects found on this computer ----------------------

function projectList() {
  const file = process.env.AGENTS_HOME_PROJECTS || path.join(home, '.agents-home', 'projects.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? []; } catch { return []; } // no list on this computer: sessions still post
}
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function projectOf(cwd, projects) {
  if (!cwd) return undefined;
  const c = `${norm(cwd)}/`;
  return projects.find((p) => [p.path, ...(p.copies ?? []).map((x) => x.path ?? x)].filter(Boolean).some((d) => c.startsWith(`${norm(d)}/`)));
}

// The repository a folder belongs to. The Claude app runs each Code session
// in a worktree with a made-up name (<repo>/.claude/worktrees/<name>), and
// other worktrees live anywhere, so the name comes from the main checkout.
function repoRoot(cwd) {
  if (!cwd) return undefined;
  const p = cwd.replace(/\\/g, '/');
  const m = /^(.*?)\/\.claude\/worktrees\/[^/]+/.exec(p);
  if (m) return m[1];
  const common = tryGit(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (common) return path.dirname(common.replace(/\\/g, '/').replace(/\/\.git\/?$/, '/.git'));
  return p;
}

const projects = projectList().filter((p) => p.path && fs.existsSync(p.path));
const sessions = transcriptRoots().flatMap(recentFiles).map(({ file, at, cowork }) => {
  const { cwd, todos } = readSession(file);
  const root = repoRoot(cwd);
  const p = projectOf(cwd, projects) ?? projectOf(root, projects);
  return {
    root,
    project: p?.name ?? (root ? path.basename(root) : 'session'),
    source: cowork ? 'cowork' : 'code',
    status: now - at <= LIVE_MS ? 'working' : 'idle',
    lastAt: at,
    agents: [],
    todos,
  };
});

// Repositories to report: the project list's, or (with no list on this
// computer) the ones the last hour's sessions worked in.
const repoList = projects.length
  ? projects.filter((p) => p.status !== 'done').map((p) => ({ name: p.name, path: p.path }))
  : [...new Set(sessions.map((s) => s.root).filter((r) => r && fs.existsSync(r)))].map((r) => ({ name: path.basename(r), path: r }));
for (const s of sessions) delete s.root; // the folder itself never leaves this computer
const repos = repoList.map((p) => {
  const last = Number(tryGit(p.path, 'log', '-1', '--format=%ct')) * 1000 || undefined;
  const changed = tryGit(p.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
  return { project: p.name, branch: tryGit(p.path, 'branch', '--show-current') || undefined, lastCommit: last, changed };
}).filter((r) => r.lastCommit || r.changed);

// ---- write -----------------------------------------------------------------

const ago = (t) => { const m = Math.round((now - t) / 60_000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const hhmm = new Date(now).toTimeString().slice(0, 5);
const md = [
  `# ${computer} · ${new Date(now).toISOString().slice(0, 10)} ${hhmm}`,
  '',
  sessions.length ? `**${sessions.filter((s) => s.status === 'working').length} running · ${sessions.length} session(s) in the last hour**` : '**No Claude sessions in the last hour**',
  '',
  ...[...new Set(sessions.map((s) => s.project))].map((name) => {
    const mine = sessions.filter((s) => s.project === name);
    const live = mine.filter((s) => s.status === 'working').length;
    const todos = mine.filter((s) => s.todos).reduce((t, s) => ({ done: t.done + s.todos.done, total: t.total + s.todos.total }), { done: 0, total: 0 });
    return `- ${live ? '▶' : '·'} ${name}${mine.length > 1 ? ` · ${mine.length} sessions` : ''}${mine.some((s) => s.source === 'cowork') ? ' (Cowork)' : ''}${todos.total ? ` · to-dos ${todos.done}/${todos.total}` : ''}`;
  }),
  ...(repos.length ? ['', '| Project | Branch | Last commit | Uncommitted |', '|---|---|---|---|',
    ...repos.sort((a, b) => (b.lastCommit ?? 0) - (a.lastCommit ?? 0)).map((r) => `| ${r.project} | ${r.branch ?? '–'} | ${r.lastCommit ? ago(r.lastCommit) : '–'} | ${r.changed || '–'} |`)] : []),
  '',
].join('\n');

const safe = computer.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'computer';
const json = { app: 'agents-home', version: 1, id: safe, computer, at: now, every: 60 * 60_000, sessions, repos };

if (args.has('--dry')) { process.stdout.write(md); process.exit(0); }
fs.mkdirSync(path.join(repo, 'status'), { recursive: true });
fs.writeFileSync(path.join(repo, 'status', `${safe}.md`), md);
fs.writeFileSync(path.join(repo, 'status', `${safe}.json`), `${JSON.stringify(json, null, 1)}\n`);
try {
  git(repo, 'add', 'status');
  if (tryGit(repo, 'diff', '--cached', '--name-only')) git(repo, 'commit', '-q', '-m', `status: ${computer} ${hhmm}`);
  git(repo, 'pull', '-q', '--rebase');
  git(repo, 'push', '-q');
} catch (err) {
  console.error(`Status written but not pushed: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
  process.exit(1);
}
