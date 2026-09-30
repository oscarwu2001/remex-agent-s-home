'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPack, packStatus, installPack, updatePack, fingerprint, packFiles } = require('../src/core/officepack');
const { spawnSync } = require('child_process');

const PACK = path.join(__dirname, '..', 'office-pack');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-pack-'));

test('the pack lists its agents and skills with a one-line summary each', () => {
  const items = listPack(PACK);
  assert.deepEqual(items.filter((i) => i.kind === 'agent').map((i) => i.name).sort(), ['checker', 'code-reviewer', 'data-helper', 'planner', 'summariser', 'test-runner', 'writer']);
  assert.deepEqual(items.filter((i) => i.kind === 'hook').map((i) => i.name), ['team-reminders']);
  assert.deepEqual(items.filter((i) => i.kind === 'skill').map((i) => i.name).sort(), ['break-down', 'handover', 'question-me', 'teach-me']);
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

test('update agents: refreshes untouched files, leaves edited ones, adds what is missing and turns reminders on', () => {
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
  assert.ok(res.added.includes('code-reviewer') && res.added.includes('test-runner') && res.added.includes('team-reminders'));
  assert.deepEqual(res.errors, []);
  assert.equal(fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8'), fs.readFileSync(path.join(PACK, 'agents', 'writer.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(claude, 'agents', 'checker.md'), 'utf8'), 'my own checker');
  assert.ok(packStatus(PACK, claude).items.every((i) => i.installed));
  const again = updatePack(PACK, claude, old);
  assert.deepEqual([again.updated, again.added], [[], []], 'a second update has nothing to do');
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
  assert.match(log[0], /^\d{4}-\d\d-\d\dT[\d:]+Z\tbase\tcode-reviewer$/);
  assert.match(log[1], /\tbase\tnone$/);
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

test('team speed: base by default; fast turns the reminders on and the hook asks for parallel work', () => {
  const { getMode, setMode } = require('../src/core/officepack');
  const claude = tmp();
  assert.equal(getMode(claude), 'base');
  const res = setMode(PACK, claude, 'fast');
  assert.deepEqual([res.mode, res.remindersAdded, res.errors], ['fast', true, []]);
  assert.equal(getMode(claude), 'fast');
  assert.equal(packStatus(PACK, claude).mode, 'fast');
  assert.throws(() => setMode(PACK, claude, 'turbo'), /unknown team speed/);
  if (hasBash) {
    const hook = path.join(claude, 'hooks', 'agents-home-router.sh');
    const run = (prompt) => spawnSync('bash', [hook], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).stdout;
    assert.match(run('Please look through the three services and tidy up how they log things'), /Fast mode/);
    assert.equal(run('thanks!'), '', 'a short message is not a task');
    setMode(PACK, claude, 'base');
    assert.doesNotMatch(run('Please look through the three services and tidy up how they log things'), /Fast mode/);
  }
});
