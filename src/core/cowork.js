'use strict';

// Cowork tasks run by the Claude desktop app keep Claude Code transcripts of
// their own, one folder per task, inside the app's data folder:
//
//   <Claude data>/local-agent-mode-sessions/<org>/<user>/<task>/.claude/projects/<cwd>/<id>.jsonl
//   <Claude data>/local-agent-mode-sessions/<org>/<user>/<task>.json   (the task's manifest)
//
// Newer app versions may use `claude-code-sessions` in place of
// `local-agent-mode-sessions`; both are looked for. The layout is not
// documented by Anthropic, so everything here is read defensively: a folder
// that is not there is simply not a source, and one that cannot be read is
// reported. Nothing under the Claude data folder is ever written.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = ['local-agent-mode-sessions', 'claude-code-sessions'];

// Where the Claude desktop app keeps its data on each platform. On Windows
// the Store (MSIX) build keeps it under its package folder instead, so each
// Claude package there is looked at too.
function claudeDataDirs({ platform = process.platform, env = process.env, home = os.homedir(), listDir = (d) => fs.readdirSync(d) } = {}) {
  if (platform === 'win32') {
    const dirs = env.APPDATA ? [path.win32.join(env.APPDATA, 'Claude')] : [];
    if (env.LOCALAPPDATA) {
      const packages = path.win32.join(env.LOCALAPPDATA, 'Packages');
      let names = [];
      try {
        names = listDir(packages).filter((n) => /^Claude[_.]/i.test(n) || /^AnthropicPBC\.Claude/i.test(n));
      } catch {
        // No Packages folder (or not readable): no Store build to look at.
      }
      for (const n of names) dirs.push(path.win32.join(packages, n, 'LocalCache', 'Roaming', 'Claude'));
    }
    return dirs;
  }
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude')];
  return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')];
}

const realFs = {
  readdir: (d) => fs.readdirSync(d, { withFileTypes: true }),
  stat: (p) => fs.statSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
};

const dirsIn = (fsys, dir) => fsys.readdir(dir).filter((e) => e.isDirectory()).map((e) => e.name);

// What the manifest says about a task, kept to what the board can use. The
// title is the task's own name (often drawn from the prompt), so the board
// shows it only with privacy mode off. Fields that are missing stay missing.
function readManifest(fsys, file) {
  let raw;
  try {
    raw = JSON.parse(fsys.readFile(file));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    return { problem: err.code ? `unreadable (${err.code})` : 'not valid JSON' };
  }
  if (!raw || typeof raw !== 'object') return { problem: 'not a JSON object' };
  const out = {};
  if (typeof raw.title === 'string' && raw.title.trim()) out.title = raw.title.trim().slice(0, 120);
  // The folders the user gave the task, when the manifest names them: the
  // first one's name is the task's project.
  const folders = [raw.userSelectedFolders, raw.selectedFolders, raw.folders].find(Array.isArray) ?? [];
  const first = folders.map((f) => (typeof f === 'string' ? f : f && typeof f.path === 'string' ? f.path : '')).find(Boolean);
  if (first) out.project = path.basename(first.replace(/\\/g, '/').replace(/\/+$/, '')) || undefined;
  return out;
}

// Every Cowork task folder that holds transcripts, with what its manifest
// says. `roots` are `.../<task>/.claude/projects` folders, ready for the
// watcher; `tasks` maps each root to { title, project }.
function coworkRoots(opts = {}) {
  const fsys = opts.fsys ?? realFs;
  const roots = [];
  const tasks = new Map();
  const problems = [];
  const note = (label, detail) => problems.push({ label, detail });
  for (const data of claudeDataDirs(opts)) {
    for (const kind of KINDS) {
      const base = path.join(data, kind);
      let orgs;
      try {
        orgs = dirsIn(fsys, base);
      } catch (err) {
        // Not there: this app version (or this computer) has no Cowork tasks.
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') note(`The Claude app's task folder could not be listed (${err.code || 'error'})`, base);
        continue;
      }
      for (const org of orgs) {
        let users;
        try {
          users = dirsIn(fsys, path.join(base, org));
        } catch (err) {
          note(`A Claude app task folder could not be listed (${err.code || 'error'})`, path.join(base, org));
          continue;
        }
        for (const user of users) {
          const userDir = path.join(base, org, user);
          let taskDirs;
          try {
            taskDirs = dirsIn(fsys, userDir);
          } catch (err) {
            note(`A Claude app task folder could not be listed (${err.code || 'error'})`, userDir);
            continue;
          }
          for (const task of taskDirs) {
            const root = path.join(userDir, task, '.claude', 'projects');
            try {
              if (!fsys.stat(root).isDirectory()) continue;
            } catch (err) {
              // A task that never started Claude Code has no transcripts.
              if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') note(`A Cowork task's transcripts could not be read (${err.code || 'error'})`, root);
              continue;
            }
            const manifest = readManifest(fsys, path.join(userDir, `${task}.json`));
            if (manifest.problem) note(`A Cowork task's details file is ${manifest.problem}`, path.join(userDir, `${task}.json`));
            roots.push(root);
            tasks.set(root, { title: manifest.title, project: manifest.project });
          }
        }
      }
    }
  }
  return { roots, tasks, problems };
}

module.exports = { coworkRoots, claudeDataDirs, readManifest, KINDS };
