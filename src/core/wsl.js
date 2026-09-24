'use strict';

// Claude Code run inside WSL writes its transcripts to the Linux home folder,
// which Windows reaches as \\wsl.localhost\<distro>\home\<user>\.claude.
// Only running distros are looked at: opening a stopped distro's path starts
// it, and a viewer should not boot a Linux VM. The caller reads WSL files
// only straight after a fresh check (see electron/main.js).

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const UNC = '\\\\wsl.localhost';

// wsl.exe prints UTF-16LE, or UTF-8 when the user has set WSL_UTF8=1.
function decode(buf) {
  return (buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8'))
    .replace(/[\ufeff\0]/g, '');
}

function runningDistros({ platform = process.platform, execFile = childProcess.execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve({ distros: [], problem: null });
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-l', '--running', '-q'], { encoding: 'buffer', timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err && err.code === 'ENOENT') {
        // No wsl.exe means WSL is not installed: nothing to watch, nothing wrong.
        resolve({ distros: [], problem: null });
      } else if (err && typeof err.code === 'number') {
        // A non-zero exit is how wsl.exe says "no running distributions". It
        // could also mean WSL itself is broken, but then no WSL session can
        // be running either, so nothing that could be shown is hidden.
        resolve({ distros: [], problem: null });
      } else if (err) {
        resolve({ distros: [], problem: `WSL could not be asked for its running distros (${err.killed ? 'timed out' : err.code || err.message})` });
      } else {
        const distros = decode(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        resolve({ distros, problem: null });
      }
    });
  });
}

const realFs = {
  readdir: (d) => fs.readdirSync(d),
  stat: (p) => fs.statSync(p),
};

// Transcript roots for every user in every running distro that has one.
async function wslRoots({ platform, execFile, fsys = realFs } = {}) {
  const { distros, problem } = await runningDistros({ platform, execFile });
  const roots = [];
  const problems = problem ? [{ label: problem, detail: '' }] : [];
  const listed = (dir, name) => {
    try {
      return fsys.readdir(dir).includes(name);
    } catch {
      return false; // only asked after a failed stat, to explain it
    }
  };
  for (const distro of distros) {
    const home = path.win32.join(UNC, distro, 'home');
    let users;
    try {
      users = fsys.readdir(home);
    } catch (err) {
      // A distro stopping between the check and here gives ENOENT: fine.
      if (err.code !== 'ENOENT') problems.push({ label: `A WSL home folder could not be listed (${err.code || 'error'})`, detail: home });
      continue;
    }
    for (const user of users) {
      const claude = path.win32.join(home, user, '.claude');
      const root = path.win32.join(claude, 'projects');
      try {
        if (fsys.stat(root).isDirectory()) roots.push(root);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
          problems.push({ label: `A WSL transcripts folder could not be read (${err.code || 'error'})`, detail: root });
        } else if (listed(path.win32.dirname(claude), '.claude') && !safeIsDir(fsys, claude)) {
          // Windows cannot follow a Linux symlink, so it looks missing.
          problems.push({ label: 'A WSL .claude folder is a Linux link the app cannot follow', detail: claude });
        } else if (listed(claude, 'projects')) {
          problems.push({ label: 'A WSL transcripts folder is a Linux link the app cannot follow', detail: root });
        }
        // Otherwise this user has never run Claude Code: not a root.
      }
    }
  }
  return { roots, problems };
}

function safeIsDir(fsys, p) {
  try {
    return fsys.stat(p).isDirectory();
  } catch {
    return false; // the caller reports why
  }
}

// One key per folder: \\wsl$\ and \\wsl.localhost\ name the same share, and
// Windows paths ignore case.
function rootKey(p, platform = process.platform) {
  if (platform !== 'win32') return p;
  return p.replace(/^\\\\wsl\$\\/i, `${UNC}\\`).toLowerCase();
}

module.exports = { runningDistros, wslRoots, rootKey, decode };
