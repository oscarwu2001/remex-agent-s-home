'use strict';

// The "Check the columns" step as the board draws it (renderer/field-view.js),
// over summaries the core builds from invented sheets.

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/core/fieldsurvey');

const view = () => import('../renderer/field-view.js');
// A timestamp, a score with a guessed scale (1–7 from its answers), a score
// whose question states its scale, and a comment.
const rows = [['Timestamp', 'How satisfied are you overall?', 'Ease (1-5)', 'Anything else?'],
  ['2026-11-10 09:00', 6, 4, 'Smooth setup'], ['2026-11-11 09:00', 7, 5, 'The holder wobbles'], ['2026-11-12 09:00', 5, 3, 'Fine']];
const field = (summary) => ({ enabled: true, sheetUrl: 'x', keyName: 'k.json', summary });
const GUESSED = 1;

test('with privacy on, the step is read-only: roles in words, no form and no Save', async () => {
  const { fieldColumnsHtml } = await view();
  const html = fieldColumnsHtml(field(F.summarise(rows)), { privacy: true });
  assert.doesNotMatch(html, /<form|<select|field-check-save/);
  assert.match(html, /Turn off “Hide file names, commands and survey answers”[^<]* to check the columns/);
  assert.match(html, /Score, 1–5/);
  assert.match(html, /Needs a choice/);
  assert.doesNotMatch(html, /How satisfied|Anything else/); // wording stays hidden
});

test('with privacy off, an unchosen low-confidence row starts on "Choose…" and Save is refused with the count', async () => {
  const { fieldColumnsHtml } = await view();
  const s = F.summarise(rows);
  const html = fieldColumnsHtml(field(s), { privacy: false });
  const row = html.split('<li').find((x) => x.includes('How satisfied'));
  assert.match(row, /<option value="" selected>Choose…<\/option>/);
  assert.match(row, /Needs a choice/);
  assert.match(row, /Scale guessed/);
  assert.match(html, /<button[^>]*id="field-check-save"[^>]*disabled/);
  assert.match(html, /1 column still needs a choice/);
  // The stated scale and the timestamp are preselected, with no tag.
  const stated = html.split('<li').find((x) => x.includes('Ease (1-5)'));
  assert.match(stated, /<option value="score" selected>/);
  assert.match(stated, /<option selected>5<\/option>/);
  assert.doesNotMatch(stated, /class="tag"/);
  assert.doesNotMatch(html, /suggested/i);
});

test('choosing the role alone is not enough for a guessed scale; choosing the scale too lets Save through', async () => {
  const { fieldColumnsHtml, rolesFrom, draftWith } = await view();
  const f = field(F.summarise(rows));
  let draft = draftWith({}, GUESSED, 'role', 'score');
  const half = fieldColumnsHtml(f, { privacy: false, draft });
  assert.match(half, /<button[^>]*id="field-check-save"[^>]*disabled/);
  assert.match(half, /aria-label="How satisfied are you overall\?: scale from"/);
  assert.equal(rolesFrom(f, draft).missing, 1);
  draft = draftWith(draftWith(draft, GUESSED, 'low', '1'), GUESSED, 'high', '7');
  const done = fieldColumnsHtml(f, { privacy: false, draft });
  assert.doesNotMatch(done, /<button[^>]*id="field-check-save"[^>]*disabled/);
  assert.doesNotMatch(done, /still needs? a choice/);
  const { roles, missing } = rolesFrom(f, draft);
  assert.equal(missing, 0);
  assert.deepEqual(roles.find((r) => r.index === GUESSED), { header: 'How satisfied are you overall?', index: GUESSED, role: 'score', low: 1, high: 7 });
  assert.deepEqual(F.checkSubmission(f.summary, roles), { missing: 0 });
});

test('the roles to save leave out a row the user has not chosen, so the core refuses them', async () => {
  const { rolesFrom } = await view();
  const s = F.summarise(rows);
  const { roles, missing } = rolesFrom(field(s), {});
  assert.equal(missing, 1);
  assert.equal(roles.some((r) => r.index === GUESSED), false);
  assert.deepEqual(F.checkSubmission(s, roles), { missing: 1 });
  // The stated scale goes in as shown.
  assert.deepEqual(roles.find((r) => r.header === 'Ease (1-5)'), { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5 });
});

test('going back to an empty choice removes it from the draft instead of saving a 0', async () => {
  const { draftWith, rolesFrom } = await view();
  const f = field(F.summarise(rows));
  const draft = draftWith(draftWith(draftWith({}, GUESSED, 'role', 'score'), GUESSED, 'low', '0'), GUESSED, 'low', '');
  assert.deepEqual(draft[GUESSED], { role: 'score' });
  assert.equal(rolesFrom(f, draft).missing, 1);
});

test('a column turned into a score has no scale until the user picks one', async () => {
  const { rolesFrom, draftWith } = await view();
  const f = field(F.summarise(rows));
  const draft = draftWith(draftWith(draftWith({}, GUESSED, 'role', 'comment'), 3, 'role', 'score'), 3, 'high', '5');
  assert.equal(rolesFrom(f, draft).missing, 1);
});
