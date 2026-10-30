'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { coworkRoots, claudeDataDirs, readManifest } = require('../src/core/cowork');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cowork-'));
  return { dir, opts: { platform: 'linux', env: { XDG_CONFIG_HOME: dir }, home: dir } };
}

test('the Claude app\'s data folder is looked for where each platform keeps it', () => {
  assert.deepEqual(claudeDataDirs({ platform: 'win32', env: { APPDATA: 'C:\\U\\AppData\\Roaming' } }), ['C:\\U\\AppData\\Roaming\\Claude']);
  assert.deepEqual(claudeDataDirs({ platform: 'win32', env: {} }), []);
  assert.deepEqual(claudeDataDirs({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\U\\L' }, listDir: () => ['Claude_pzs8sxrjxfjjc', 'Other.App'] }),
    ['C:\\U\\L\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude'], 'the Store build too');
  assert.deepEqual(claudeDataDirs({ platform: 'darwin', home: '/Users/a' }), ['/Users/a/Library/Application Support/Claude']);
});

test('each Cowork task with transcripts is a root, with its manifest\'s title and folder name', () => {
  const { dir, opts } = home();
  const user = path.join(dir, 'Claude', 'local-agent-mode-sessions', 'org', 'user');
  fs.mkdirSync(path.join(user, 'local_a', '.claude', 'projects', 'enc'), { recursive: true });
  fs.writeFileSync(path.join(user, 'local_a.json'), JSON.stringify({ title: 'Tidy the notes', userSelectedFolders: ['/home/me/Notes/'] }));
  fs.mkdirSync(path.join(user, 'local_b'), { recursive: true }); // never started Claude Code
  fs.mkdirSync(path.join(dir, 'Claude', 'claude-code-sessions', 'org', 'user', 'local_c', '.claude', 'projects'), { recursive: true });
  const res = coworkRoots(opts);
  assert.equal(res.roots.length, 2);
  assert.deepEqual(res.tasks.get(path.join(user, 'local_a', '.claude', 'projects')), { title: 'Tidy the notes', project: 'Notes' });
  assert.deepEqual(res.problems, []);
});

test('no Claude app folder is no source and no problem; a broken manifest is reported, the task still read', () => {
  const { dir, opts } = home();
  assert.deepEqual(coworkRoots(opts), { roots: [], tasks: new Map(), problems: [] });
  const user = path.join(dir, 'Claude', 'local-agent-mode-sessions', 'org', 'user');
  fs.mkdirSync(path.join(user, 'local_a', '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(user, 'local_a.json'), '{ not json');
  const res = coworkRoots(opts);
  assert.equal(res.roots.length, 1);
  assert.match(res.problems[0].label, /not valid JSON/);
});

test('a manifest without the fields leaves them out rather than guessing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-m-')), 'm.json');
  fs.writeFileSync(file, JSON.stringify({ cwd: '/x', title: '  ' }));
  assert.deepEqual(readManifest({ readFile: (p) => fs.readFileSync(p, 'utf8') }, file), {});
});
