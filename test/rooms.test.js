'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roomFor, validateOverrides } = require('../src/core/rooms');
const { parseFrontmatter } = require('../src/core/roster');

test('the four house agents land in their rooms', () => {
  assert.equal(roomFor('reviewer'), 'operating-room');
  assert.equal(roomFor('runner'), 'laboratory');
  assert.equal(roomFor('silent-failure-hunter'), 'radiology');
  assert.equal(roomFor('ui-reviewer'), 'vision-clinic');
});

test('research-type agents work in the office', () => {
  for (const name of ['Explore', 'Plan', 'general-purpose', 'deep-researcher']) {
    assert.equal(roomFor(name), 'research-office', name);
  }
});

test('keyword rules do not match inside unrelated words', () => {
  assert.equal(roomFor('build-helper'), 'general-ward'); // "ui" inside "build"
  assert.equal(roomFor('ux-audit'), 'vision-clinic');
  assert.equal(roomFor('statusline-setup'), 'general-ward');
});

test('overrides win and must name a real room', () => {
  assert.equal(roomFor('reviewer', { reviewer: 'radiology' }), 'radiology');
  assert.throws(() => validateOverrides({ reviewer: 'cafeteria' }), /unknown room "cafeteria"/);
  assert.throws(() => validateOverrides(['reviewer']), TypeError);
});

test('agent frontmatter is read from Windows and Unix line endings', () => {
  const text = '---\r\nname: reviewer\r\ndescription: Independent reviewer. Use after work.\r\ntools: Read\r\n---\r\nbody';
  assert.deepEqual(parseFrontmatter(text), {
    name: 'reviewer', description: 'Independent reviewer. Use after work.', tools: 'Read',
  });
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('block-scalar descriptions are read as text, not as "|"', () => {
  const text = '---\nname: planner\ndescription: |\n  Plans the work.\n  Then hands off.\ntools: Read\n---\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.description, 'Plans the work.\nThen hands off.');
  assert.equal(fm.tools, 'Read');
  assert.equal(parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\n---\n').description, 'one two');
});

const { validateLayout, roomsWith, overridesFrom, openCells, DEPARTMENT_KINDS } = require('../src/core/rooms');

test('a department beside the core joins the room next to it', () => {
  const layout = validateLayout({ departments: [{ kind: 'spine', cell: [3, 1], agents: ['spine-planner', ' spine-planner '] }] });
  const [d] = layout.departments;
  assert.deepEqual([d.id, d.name, d.via, d.agents], ['dept-spine-surgery', 'Spine Surgery', 'operating-room', ['spine-planner']]);
  assert.equal(roomsWith(layout).length, 8);
  assert.deepEqual(overridesFrom(layout), { 'spine-planner': 'dept-spine-surgery' });
  assert.equal(roomFor('spine-planner', overridesFrom(layout)), 'dept-spine-surgery');
});

test('corner cells are reachable only through a department placed before them', () => {
  assert.throws(() => validateLayout({ departments: [{ kind: 'ent', cell: [3, 3] }] }), /not next to any room/);
  const ok = validateLayout({ departments: [{ kind: 'ortho', cell: [3, 2] }, { kind: 'ent', cell: [3, 3] }] });
  assert.equal(ok.departments[1].via, ok.departments[0].id);
});

test('bad layouts are refused with a reason', () => {
  assert.throws(() => validateLayout({ departments: [{ kind: 'spine', cell: [1, 1] }] }), /already taken/);
  assert.throws(() => validateLayout({ departments: [{ kind: 'spine', cell: [0, 2] }] }), /already taken/); // the garden
  assert.throws(() => validateLayout({ departments: [{ kind: 'spine', cell: [4, 1] }] }), /outside the 5 x 5/);
  assert.throws(() => validateLayout({ departments: [{ kind: 'cardiac', cell: [3, 1] }] }), /unknown kind/);
  assert.throws(() => validateLayout({ departments: [{ kind: 'custom', cell: [3, 1] }] }), /needs a name/);
  assert.throws(() => validateLayout({ departments: [{ kind: 'spine', cell: [3, 1] }, { kind: 'ent', cell: [3, 1] }] }), /already taken/);
  assert.throws(() => validateLayout([]), TypeError);
});

test('custom departments keep their name; duplicate names get distinct ids', () => {
  const l = validateLayout({ departments: [
    { kind: 'custom', name: 'Hand Surgery', cell: [3, 1] },
    { kind: 'custom', name: 'Hand Surgery', cell: [1, -1] },
  ] });
  assert.deepEqual(l.departments.map((d) => d.id), ['dept-hand-surgery', 'dept-hand-surgery-2']);
  assert.equal(l.departments[0].name, 'Hand Surgery');
});

test('open cells are the free ring cells next to a room', () => {
  const core = openCells({ departments: [] });
  // 12 edge cells of the ring touch the core, minus the 4 that only touch scenery.
  assert.equal(core.length, 8);
  assert.ok(!core.some(([c, r]) => c >= 0 && c <= 2 && r >= 0 && r <= 2));
  const more = openCells(validateLayout({ departments: [{ kind: 'spine', cell: [3, 1] }] }));
  assert.ok(more.some(([c, r]) => c === 3 && r === 0)); // now reachable through the new department
  assert.ok(DEPARTMENT_KINDS.some((k) => k.kind === 'custom'));
});

test('overrides may name a department room once it exists', () => {
  const layout = validateLayout({ departments: [{ kind: 'dental', cell: [1, -1] }] });
  const ids = new Set(roomsWith(layout).map((r) => r.id));
  assert.deepEqual(validateOverrides({ 'implant-planner': 'dept-dental-implantology' }, ids), { 'implant-planner': 'dept-dental-implantology' });
  assert.throws(() => validateOverrides({ 'implant-planner': 'dept-dental-implantology' }), /unknown room/);
});

test('removing one of two same-name departments keeps the id of the other', () => {
  const first = validateLayout({ departments: [
    { kind: 'custom', name: 'Hand Surgery', cell: [3, 1] },
    { kind: 'custom', name: 'Hand Surgery', cell: [1, -1] },
  ] });
  const saved = first.departments.map(({ id, kind, name, cell }) => ({ id, kind, name, cell }));
  const after = validateLayout({ departments: [saved[1]] });
  assert.equal(after.departments[0].id, 'dept-hand-surgery-2');
  // and a new department never takes an id that is still in the file
  const added = validateLayout({ departments: [saved[1], { kind: 'custom', name: 'Hand Surgery', cell: [3, 1] }] });
  assert.deepEqual(added.departments.map((d) => d.id), ['dept-hand-surgery-2', 'dept-hand-surgery']);
});
