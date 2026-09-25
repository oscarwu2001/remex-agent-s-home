'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPack, packStatus, installPack } = require('../src/core/officepack');

const PACK = path.join(__dirname, '..', 'office-pack');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-pack-'));

test('the pack lists its agents and skills with a one-line summary each', () => {
  const items = listPack(PACK);
  assert.deepEqual(items.filter((i) => i.kind === 'agent').map((i) => i.name).sort(), ['checker', 'data-helper', 'planner', 'summariser', 'writer']);
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
