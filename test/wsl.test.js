'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runningDistros, wslRoots, rootKey, decode } = require('../src/core/wsl');

// A fake execFile answering the way wsl.exe does (UTF-16LE by default).
function fakeExec({ out = '', encoding = 'utf16le', err = null } = {}) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    setImmediate(() => cb(err, Buffer.from(out, encoding), Buffer.alloc(0)));
  };
  return { execFile, calls };
}

const errWith = (code, extra = {}) => Object.assign(new Error(String(code)), { code, ...extra });

// A fake file system: `dirs` are folders that exist; `links` are names that
// show in their folder's listing but cannot be opened (a Linux symlink).
function fakeFs(dirs, links = []) {
  const all = new Set([...dirs, ...links]);
  return {
    readdir(dir) {
      if (!dirs.includes(dir)) throw errWith('ENOENT');
      return [...all].filter((d) => path.win32.dirname(d) === dir).map((d) => path.win32.basename(d));
    },
    stat(p) {
      if (!dirs.includes(p)) throw errWith('ENOENT');
      return { isDirectory: () => true };
    },
  };
}

const base = '\\\\wsl.localhost\\Ubuntu';
const home = `${base}\\home`;

test('only running distros are listed, so a stopped one is never started', async () => {
  const { execFile, calls } = fakeExec({ out: '﻿Ubuntu\r\nDebian\r\n\r\n' });
  assert.deepEqual(await runningDistros({ platform: 'win32', execFile }), { distros: ['Ubuntu', 'Debian'], problem: null });
  assert.deepEqual(calls, [['wsl.exe', '-l', '--running', '-q']]);
});

test('UTF-8 output (WSL_UTF8=1) is read as well as UTF-16', async () => {
  const { execFile } = fakeExec({ out: 'Ubuntu\n', encoding: 'utf8' });
  assert.deepEqual((await runningDistros({ platform: 'win32', execFile })).distros, ['Ubuntu']);
  assert.equal(decode(Buffer.from('Ubuntu\r\n', 'utf16le')), 'Ubuntu\r\n');
});

test('no WSL at all is the normal case, not a problem', async () => {
  const { execFile } = fakeExec({ err: errWith('ENOENT') });
  assert.deepEqual(await runningDistros({ platform: 'win32', execFile }), { distros: [], problem: null });
});

test('a non-zero exit (nothing running) is not a problem', async () => {
  const { execFile } = fakeExec({ out: 'There are no running distributions.\r\n', err: errWith(1) });
  assert.deepEqual(await runningDistros({ platform: 'win32', execFile }), { distros: [], problem: null });
});

test('wsl.exe timing out is reported', async () => {
  const { execFile } = fakeExec({ err: errWith(null, { killed: true, signal: 'SIGTERM' }) });
  const got = await runningDistros({ platform: 'win32', execFile });
  assert.deepEqual(got.distros, []);
  assert.match(got.problem, /timed out/);
});

test('outside Windows wsl.exe is never called', async () => {
  const { execFile, calls } = fakeExec({ out: 'Ubuntu\r\n' });
  assert.deepEqual(await runningDistros({ platform: 'linux', execFile }), { distros: [], problem: null });
  assert.deepEqual(calls, []);
});

test('each WSL user with a transcripts folder becomes a root', async () => {
  const { execFile } = fakeExec({ out: 'Ubuntu\r\n' });
  const fsys = fakeFs([home, `${home}\\ada`, `${home}\\ada\\.claude`, `${home}\\ada\\.claude\\projects`, `${home}\\bob`]);
  assert.deepEqual(await wslRoots({ platform: 'win32', execFile, fsys }), {
    roots: [`${home}\\ada\\.claude\\projects`],
    problems: [],
  });
});

test('a linked .claude or projects folder Windows cannot follow is reported, not skipped', async () => {
  const { execFile } = fakeExec({ out: 'Ubuntu\r\n' });
  const fsys = fakeFs(
    [home, `${home}\\ada`, `${home}\\bob`, `${home}\\bob\\.claude`],
    [`${home}\\ada\\.claude`, `${home}\\bob\\.claude\\projects`],
  );
  const got = await wslRoots({ platform: 'win32', execFile, fsys });
  assert.deepEqual(got.roots, []);
  assert.deepEqual(got.problems.map((p) => p.detail), [`${home}\\ada\\.claude`, `${home}\\bob\\.claude\\projects`]);
  assert.ok(got.problems.every((p) => /link the app cannot follow/.test(p.label)));
});

test('a running distro whose home cannot be listed is reported', async () => {
  const { execFile } = fakeExec({ out: 'Ubuntu\r\n' });
  const fsys = { readdir: () => { throw errWith('EACCES'); }, stat: () => { throw errWith('EACCES'); } };
  const got = await wslRoots({ platform: 'win32', execFile, fsys });
  assert.deepEqual(got.roots, []);
  assert.equal(got.problems.length, 1);
  assert.match(got.problems[0].label, /EACCES/);
  assert.equal(got.problems[0].detail, home);
});

test('\\\\wsl$ and \\\\wsl.localhost name the same folder, in any case', () => {
  assert.equal(
    rootKey('\\\\wsl$\\Ubuntu\\home\\Ada\\.claude\\projects', 'win32'),
    rootKey('\\\\wsl.localhost\\ubuntu\\home\\ada\\.claude\\projects', 'win32'),
  );
  assert.equal(rootKey('/Home/a', 'linux'), '/Home/a');
});
