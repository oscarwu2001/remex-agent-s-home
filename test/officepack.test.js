'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPack, packStatus, installPack, updatePack, ownItems, fingerprint, packFiles } = require('../src/core/officepack');
const { spawnSync } = require('child_process');

const PACK = path.join(__dirname, '..', 'office-pack');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-pack-'));

test('the pack lists its agents and skills with a one-line summary each', () => {
  const items = listPack(PACK);
  assert.deepEqual(items.filter((i) => i.kind === 'agent').map((i) => i.name).sort(), ['builder', 'checker', 'code-reviewer', 'data-helper', 'personal-assistant', 'planner', 'project-manager', 'researcher', 'silent-failure-hunter', 'summariser', 'test-runner', 'ui-reviewer', 'writer']);
  assert.deepEqual(items.filter((i) => i.kind === 'hook').map((i) => i.name), ['team-reminders']);
  assert.deepEqual(items.filter((i) => i.kind === 'skill').map((i) => i.name).sort(), ['break-down', 'find-the-bug', 'handover', 'question-me', 'save-as-skill', 'scan-projects', 'teach-me', 'write-docs', 'write-spec']);
  for (const i of items) assert.ok(i.summary.length > 10 && i.summary.length <= 120, i.name);
});

test('a fresh .claude has nothing installed and no agents of its own', () => {
  const claude = tmp();
  const s = packStatus(PACK, claude);
  assert.equal(s.hasOwnAgents, false);
  assert.ok(s.items.every((i) => !i.installed));
});

test('installing adds the chosen items and nothing else', () => {
  const claude = tmp();
  const res = installPack(PACK, claude, ['writer', 'handover']);
  assert.deepEqual(res.installed.sort(), ['handover', 'writer']);
  assert.ok(fs.existsSync(path.join(claude, 'agents', 'writer.md')));
  assert.ok(fs.existsSync(path.join(claude, 'skills', 'handover', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(claude, 'agents', 'checker.md')));
  const s = packStatus(PACK, claude);
  assert.equal(s.items.find((i) => i.name === 'writer').installed, true);
  assert.equal(s.items.find((i) => i.name === 'checker').installed, false);
});

test('existing files are never overwritten; they are reported as already there', () => {
  const claude = tmp();
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'agents', 'writer.md'), 'my own writer');
  fs.writeFileSync(path.join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
  fs.mkdirSync(path.join(claude, 'skills', 'handover'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', 'handover', 'SKILL.md'), 'mine');
  const s = packStatus(PACK, claude);
  assert.equal(s.hasOwnAgents, true);
  const res = installPack(PACK, claude, ['writer', 'handover', 'checker']);
  assert.deepEqual(res.installed, ['checker']);
  assert.deepEqual(res.skipped.sort(), ['handover', 'writer']);
  assert.equal(fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8'), 'my own writer');
  assert.equal(fs.readFileSync(path.join(claude, 'skills', 'handover', 'SKILL.md'), 'utf8'), 'mine');
});

test('names that are not in the pack are refused, never guessed or used as paths', () => {
  const claude = tmp();
  const res = installPack(PACK, claude, ['../../evil', 'graphify']);
  assert.deepEqual(res.installed, []);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /not in the office pack/);
});

const VERSIONS = JSON.parse(fs.readFileSync(path.join(PACK, 'versions.json'), 'utf8'));
const settingsOf = (claude) => JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));

test('every pack file as it is now is recorded in versions.json (run scripts/pack-versions.js)', () => {
  for (const rel of packFiles(PACK)) {
    assert.ok((VERSIONS[rel] ?? []).includes(fingerprint(fs.readFileSync(path.join(PACK, rel), 'utf8'))), rel);
  }
});

test('the reminder hook adds one entry to settings.json, keeps a copy, and changes nothing else', () => {
  const claude = tmp();
  const mine = { model: 'x', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash mine.sh' }] }], Stop: [] } };
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(mine));
  assert.deepEqual(installPack(PACK, claude, ['team-reminders']).installed, ['team-reminders']);
  const after = settingsOf(claude);
  assert.equal(after.model, 'x');
  assert.deepEqual(after.hooks.Stop, []);
  assert.equal(after.hooks.UserPromptSubmit.length, 2);
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, 'bash mine.sh');
  assert.match(after.hooks.UserPromptSubmit[1].hooks[0].command, /agents-home-router\.sh"$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, 'settings.json.agents-home-backup'), 'utf8')), mine);
  assert.ok(fs.existsSync(path.join(claude, 'hooks', 'agents-home-router.sh')));
  assert.equal(packStatus(PACK, claude).items.find((i) => i.name === 'team-reminders').installed, true);
  assert.deepEqual(installPack(PACK, claude, ['team-reminders']).skipped, ['team-reminders'], 'never added twice');
  assert.equal(settingsOf(claude).hooks.UserPromptSubmit.length, 2);
});

test('a settings.json that is not valid JSON is left exactly as it is', () => {
  const claude = tmp();
  fs.writeFileSync(path.join(claude, 'settings.json'), '{ "model": "x", // a comment }');
  const res = installPack(PACK, claude, ['team-reminders']);
  assert.equal(res.installed.length, 0);
  assert.match(res.errors[0], /left alone/);
  assert.equal(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'), '{ "model": "x", // a comment }');
});

test('update agents: refreshes untouched files, leaves edited ones, and adds nothing the user did not choose', () => {
  const claude = tmp();
  installPack(PACK, claude, ['writer', 'checker', 'handover']);
  // writer as an older pack version shipped it; checker edited by the user.
  const old = { ...VERSIONS, 'agents/writer.md': [...VERSIONS['agents/writer.md'], fingerprint('an old writer')] };
  fs.writeFileSync(path.join(claude, 'agents', 'writer.md'), 'an old writer');
  fs.writeFileSync(path.join(claude, 'agents', 'checker.md'), 'my own checker');
  const res = updatePack(PACK, claude, old);
  assert.deepEqual(res.updated, ['writer']);
  assert.deepEqual(res.edited, ['checker']);
  assert.ok(res.upToDate.includes('handover'));
  assert.deepEqual(res.added, [], 'nothing new is added');
  assert.ok(res.notAdded.includes('code-reviewer') && res.notAdded.includes('team-reminders'));
  assert.equal(fs.existsSync(path.join(claude, 'agents', 'code-reviewer.md')), false);
  assert.equal(fs.existsSync(path.join(claude, 'settings.json')), false, 'reminders stay off');
  assert.deepEqual(res.errors, []);
  assert.equal(fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8'), fs.readFileSync(path.join(PACK, 'agents', 'writer.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(claude, 'agents', 'checker.md'), 'utf8'), 'my own checker');
  assert.deepEqual(packStatus(PACK, claude).items.filter((i) => i.installed).map((i) => i.name).sort(), ['checker', 'handover', 'writer']);
  const again = updatePack(PACK, claude, old);
  assert.deepEqual([again.updated, again.added], [[], []], 'a second update has nothing to do');
});

// Every file under a folder, as path -> bytes.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return out;
}

test('update agents never touches the user\'s own agents, skills or hooks, even one with a pack name', () => {
  const claude = tmp();
  installPack(PACK, claude, ['writer', 'handover']);
  const own = {
    'agents/rca-skeptic.md': '---\nname: rca-skeptic\nmodel: opus\n---\nmine',
    'agents/team/nested.md': 'mine, in a subfolder',
    'agents/planner.md': '---\nname: planner\n---\nmy own planner, same name as the pack one',
    'skills/my-skill/SKILL.md': '---\nname: my-skill\n---\nmine',
    'skills/my-skill/notes.md': 'mine',
    'skills/handover/my-notes.md': 'my file inside a pack skill folder',
    'hooks/my-hook.sh': 'echo mine',
    'CLAUDE.md': 'my rules',
  };
  for (const [rel, text] of Object.entries(own)) {
    fs.mkdirSync(path.dirname(path.join(claude, rel)), { recursive: true });
    fs.writeFileSync(path.join(claude, rel), text);
  }
  // writer as an older pack version shipped it, so it gets refreshed.
  fs.writeFileSync(path.join(claude, 'agents', 'writer.md'), 'an old writer');
  const versions = { ...VERSIONS, 'agents/writer.md': [...VERSIONS['agents/writer.md'], fingerprint('an old writer')] };
  const before = snapshot(claude);
  const res = updatePack(PACK, claude, versions);
  const after = snapshot(claude);

  for (const rel of Object.keys(own)) assert.equal(after[rel], before[rel], `${rel} unchanged`);
  assert.deepEqual(res.edited, ['planner'], 'the same-name agent is reported, not replaced');
  assert.deepEqual(res.own, { agents: ['rca-skeptic'], skills: ['my-skill'] });
  // Whatever changed is one of the pack files the user added; nothing new
  // appears, and settings.json is not created.
  const pack = new Set(packFiles(PACK));
  assert.deepEqual(Object.keys(after).filter((rel) => !(rel in before)), [], 'nothing added');
  const touched = Object.keys(after).filter((rel) => after[rel] !== before[rel]);
  assert.ok(touched.includes('agents/writer.md'));
  assert.deepEqual(touched.filter((rel) => !pack.has(rel)), [], 'nothing outside the pack');
  assert.deepEqual(Object.keys(before).filter((rel) => !(rel in after)), [], 'nothing removed');
});

test('own items: none when the folders are missing', () => {
  assert.deepEqual(ownItems(PACK, tmp()), { agents: [], skills: [] });
});

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
test('the reminder hook names only installed helpers that fit, and is silent otherwise', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['code-reviewer', 'team-reminders']);
  const run = (prompt) => spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], {
    input: JSON.stringify({ session_id: 's', cwd: '/work/test-project', prompt }), encoding: 'utf8',
  });
  const fix = run('Please fix the bug in the parser and run the tests');
  assert.equal(fix.status, 0);
  assert.match(fix.stdout, /code-reviewer/);
  assert.doesNotMatch(fix.stdout, /test-runner/, 'not installed, so not mentioned');
  assert.equal(run('What is the weather like?').stdout, '');
  // Its own log: one line per run, agent names only, never the prompt.
  const log = fs.readFileSync(path.join(claude, 'hooks', 'agents-home-router.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.match(log[0], /^\d{4}-\d\d-\d\dT[\d:]+Z\tcode-reviewer$/);
  assert.match(log[1], /\tnone$/);
  assert.ok(!log.join('\n').includes('parser'), 'the prompt is never written');
});

// A pack of our own, to test what the real one does not have (a skill with
// several files, one in a subfolder).
function miniPack(files) {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  return dir;
}

test('a skill with an edited file is left whole; an untouched one gets every file, new subfolders too', () => {
  const skill = '---\nname: tidy\ndescription: Tidies things up nicely.\n---\nv2';
  const pack = miniPack({ 'skills/tidy/SKILL.md': skill, 'skills/tidy/ref/extra.md': 'new in v2', 'skills/tidy/notes.md': 'notes v2' });
  const versions = { 'skills/tidy/SKILL.md': [fingerprint('v1 skill')], 'skills/tidy/notes.md': [fingerprint('notes v1')] };
  const setUp = (notes) => {
    const claude = tmp();
    fs.mkdirSync(path.join(claude, 'skills', 'tidy'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'skills', 'tidy', 'SKILL.md'), 'v1 skill');
    fs.writeFileSync(path.join(claude, 'skills', 'tidy', 'notes.md'), notes);
    return claude;
  };
  const edited = setUp('my own notes');
  const r1 = updatePack(pack, edited, versions);
  assert.deepEqual(r1.edited, ['tidy']);
  assert.equal(fs.readFileSync(path.join(edited, 'skills', 'tidy', 'SKILL.md'), 'utf8'), 'v1 skill', 'nothing written');
  assert.ok(!fs.existsSync(path.join(edited, 'skills', 'tidy', 'ref')));
  const clean = setUp('notes v1');
  const r2 = updatePack(pack, clean, versions);
  assert.deepEqual([r2.updated, r2.errors], [['tidy'], []]);
  assert.equal(fs.readFileSync(path.join(clean, 'skills', 'tidy', 'ref', 'extra.md'), 'utf8'), 'new in v2');
  assert.equal(fs.readdirSync(path.join(clean, 'skills', 'tidy')).filter((f) => f.includes('agents-home-tmp')).length, 0);
});

test('a file with Windows line endings has the same fingerprint', () => {
  assert.equal(fingerprint('a\r\nb\r\n'), fingerprint('a\nb\n'));
});

test('reminders on: no settings.json yet, or an empty one, is fine; a "hooks" that is not an object is refused', () => {
  const none = tmp();
  assert.deepEqual(installPack(PACK, none, ['team-reminders']).installed, ['team-reminders']);
  assert.equal(settingsOf(none).hooks.UserPromptSubmit.length, 1);
  assert.ok(!fs.existsSync(path.join(none, 'settings.json.agents-home-backup')), 'nothing to back up');
  const empty = tmp();
  fs.writeFileSync(path.join(empty, 'settings.json'), '');
  assert.deepEqual(installPack(PACK, empty, ['team-reminders']).installed, ['team-reminders']);
  const odd = tmp();
  fs.writeFileSync(path.join(odd, 'settings.json'), '{"hooks":["x"]}');
  assert.match(installPack(PACK, odd, ['team-reminders']).errors[0], /left alone/);
  assert.equal(fs.readFileSync(path.join(odd, 'settings.json'), 'utf8'), '{"hooks":["x"]}');
});

test('a settings.json that is a symlink stays a symlink; its target gets the entry', { skip: process.platform === 'win32' && 'symlinks need admin rights on Windows' }, () => {
  const claude = tmp();
  const real = path.join(tmp(), 'real-settings.json');
  fs.writeFileSync(real, '{"model":"x"}');
  fs.symlinkSync(real, path.join(claude, 'settings.json'));
  assert.deepEqual(installPack(PACK, claude, ['team-reminders']).installed, ['team-reminders']);
  assert.ok(fs.lstatSync(path.join(claude, 'settings.json')).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.UserPromptSubmit.length, 1);
});

test('the coding reminders fire on a finished change or a test run, not on every fix or every log', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['code-reviewer', 'test-runner', 'team-reminders']);
  const fired = (prompt) => {
    const out = spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).stdout;
    return ['code-reviewer', 'test-runner'].filter((a) => out.includes(a));
  };
  assert.deepEqual(fired('fix the typo on line 3'), [], 'a small fix is not a whole change');
  assert.deepEqual(fired('check the logs from last night'), []);
  assert.deepEqual(fired('build a new feature for the export'), ['code-reviewer']);
  assert.deepEqual(fired('run the tests please'), ['test-runner']);
  assert.deepEqual(fired('the build fails after the refactor'), ['code-reviewer', 'test-runner']);
  assert.match(spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], { input: JSON.stringify({ prompt: 'implement it' }), encoding: 'utf8' }).stdout,
    /once/, 'the reviewer is asked for once per change');
});

test('the reminders stay quiet on background reports, and planner and data-helper wait to be asked', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['builder', 'code-reviewer', 'planner', 'data-helper', 'team-reminders']);
  const out = (prompt) => spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).stdout;
  assert.equal(out('<task-notification>\n<status>completed</status>\nimplement the refactor'), '', 'a helper reporting back is not a request');
  assert.equal(out('plan how to fix the parser, then calculate the offsets'), '', 'coding words, no office helper');
  assert.match(out('make me a plan for the launch week'), /planner/);
  assert.match(out('add a pivot table to the spreadsheet'), /data-helper/);
  assert.match(out('implement the export feature'), /Done check:.*Scope:.*Checked by:/, 'the builder brief asks for the done check, scope and checker');
});

test('data and screen changes bring their own reviewer; bugs and questions get theirs', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['code-reviewer', 'silent-failure-hunter', 'ui-reviewer', 'researcher', 'find-the-bug', 'team-reminders']);
  const fired = (prompt) => {
    const out = spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).stdout;
    return ['silent-failure-hunter', 'ui-reviewer', 'find-the-bug', 'researcher'].filter((a) => out.includes(a));
  };
  assert.deepEqual(fired('implement the CSV export for the results'), ['silent-failure-hunter']);
  assert.deepEqual(fired('refactor the sidebar layout and its colours'), ['ui-reviewer']);
  assert.deepEqual(fired('the export crashes with a traceback'), ['find-the-bug']);
  assert.deepEqual(fired('which library should we use for PDF parsing? find out which version is current'), ['researcher']);
  assert.deepEqual(fired('save the file as a csv'), [], 'data words alone, with no code change, ask for no reviewer');
});

test('the planning, docs and save-as-skill reminders fire on an explicit ask', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['write-spec', 'write-docs', 'save-as-skill', 'researcher', 'team-reminders']);
  const fired = (prompt) => {
    const out = spawnSync('bash', [path.join(claude, 'hooks', 'agents-home-router.sh')], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).stdout;
    return ['write-spec', 'write-docs', 'save-as-skill', 'researcher'].filter((a) => out.includes(a));
  };
  assert.deepEqual(fired('write a spec for the export button'), ['write-spec']);
  assert.deepEqual(fired('update the readme with the new install steps'), ['write-docs']);
  assert.deepEqual(fired('that worked, save this as a skill'), ['save-as-skill']);
  assert.deepEqual(fired('check the official documentation for the latest version'), ['researcher'], 'reading docs is research, not writing them');
  assert.deepEqual(fired('fix the parser'), []);
});

test('the reminder hook exits 0 on empty or broken input, and reads past an escaped line break', { skip: !hasBash && 'no bash here' }, () => {
  const claude = tmp();
  installPack(PACK, claude, ['test-runner', 'team-reminders']);
  const hook = path.join(claude, 'hooks', 'agents-home-router.sh');
  for (const input of ['', 'not json', '{"prompt":']) {
    const r = spawnSync('bash', [hook], { input, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [0, ''], JSON.stringify(input));
  }
  const r = spawnSync('bash', [hook], { input: JSON.stringify({ prompt: 'fix it\ntests fail' }), encoding: 'utf8' });
  assert.match(r.stdout, /test-runner/);
});

test('the reminder script is installed with Unix line endings even from a Windows checkout, and a CRLF copy is mended', () => {
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pack-'));
  fs.cpSync(PACK, pack, { recursive: true });
  const hook = path.join(pack, 'hooks', 'agents-home-router.sh');
  fs.writeFileSync(hook, fs.readFileSync(hook, 'utf8').replace(/\n/g, '\r\n'));
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-'));
  installPack(pack, claude, ['team-reminders']);
  const installed = path.join(claude, 'hooks', 'agents-home-router.sh');
  assert.ok(!fs.readFileSync(installed, 'utf8').includes('\r'));
  // An older install that was copied with CRLF gets fixed by Update agents.
  fs.writeFileSync(installed, fs.readFileSync(installed, 'utf8').replace(/\n/g, '\r\n'));
  updatePack(pack, claude, VERSIONS);
  assert.ok(!fs.readFileSync(installed, 'utf8').includes('\r'));
});
