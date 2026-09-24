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
