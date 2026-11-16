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

test('the reply to Save shows even when the step has no rows to draw, and with privacy on', async () => {
  const { fieldColumnsHtml } = await view();
  assert.match(fieldColumnsHtml({ summary: null }, { privacy: false, error: 'Not saved: the sheet has not been read yet.' }), /Not saved: the sheet has not been read yet\./);
  assert.match(fieldColumnsHtml(field(F.summarise(rows)), { privacy: true, note: 'Columns saved.' }), /Columns saved\./);
});

test('with privacy on, how to check the columns comes first, before the list', async () => {
  const { fieldColumnsHtml } = await view();
  const html = fieldColumnsHtml(field(F.summarise(rows)), { privacy: true });
  assert.ok(html.indexOf('Turn off') < html.indexOf('<ol'), 'the turn-off line is under the first hint');
});

test('a scale not chosen yet offers "Choose…", like the role', async () => {
  const { fieldColumnsHtml, draftWith } = await view();
  const html = fieldColumnsHtml(field(F.summarise(rows)), { privacy: false, draft: draftWith({}, GUESSED, 'role', 'score') });
  const row = html.split('<li').find((x) => x.includes('How satisfied'));
  assert.equal((row.match(/<option value="" selected>Choose…<\/option>/g) ?? []).length, 2);
});

test('a checked comment column whose answers now look like emails is tagged in the step and named in the sheet', async () => {
  const { fieldColumnsHtml, fieldSheetHtml } = await view();
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Anything else?', index: 1, role: 'comment' }]);
  const s = F.summarise([['Timestamp', 'Anything else?'], ['2026-11-10 09:00', 'a@example.org'], ['2026-11-11 09:00', 'b@example.org'], ['2026-11-12 09:00', 'Fine']], { roles });
  for (const privacy of [true, false]) {
    assert.match(fieldColumnsHtml(field(s), { privacy }), /Answers look like emails or phone numbers/);
    const sheet = fieldSheetHtml(field(s), { privacy });
    assert.match(sheet, /1 column you checked now looks like emails or phone numbers/);
    assert.doesNotMatch(sheet, /example\.org/);
  }
});

test('a column whose answers the cache does not keep is not said to have no answers', async () => {
  const { fieldColumnsHtml } = await view();
  const sheet = [['Timestamp', 'Who filled this in?'], ['2026-11-10 09:00', 'Ann Lee'], ['2026-11-11 09:00', 'Bo Chan'], ['2026-11-12 09:00', 'Cy Wu']];
  const cache = F.afterFetch(null, { rows: sheet, tab: { id: 0, title: 'T' }, timeZone: 'UTC' }, { now: 1, started: 1, link: { spreadsheetId: 'C'.repeat(30), gid: 0 } });
  const html = fieldColumnsHtml(field(F.summariseCache(cache, [])), { privacy: false });
  assert.match(html, /Needs a choice/);
  assert.doesNotMatch(html, /No answers yet/);
});

test('an ignored column read back without its answers is not promised them after the next update', async () => {
  const { fieldColumnsHtml } = await view();
  const sheet = [['Timestamp', 'Visit date'], ['2026-11-10 09:00', '2026-11-02'], ['2026-11-11 09:00', '2026-11-05'], ['2026-11-12 09:00', '2026-11-09'], ['2026-11-13 09:00', '2026-11-12']];
  const cache = F.afterFetch(null, { rows: sheet, tab: { id: 0, title: 'T' }, timeZone: 'UTC' }, { now: 1, started: 1, link: { spreadsheetId: 'C'.repeat(30), gid: 0 } });
  assert.deepEqual(cache.redacted, [1]);
  const html = fieldColumnsHtml(field(F.summariseCache(cache, [])), { privacy: false });
  assert.match(html.split('<li').find((x) => x.includes('Visit date')), /<option value="ignore" selected>/);
  assert.doesNotMatch(html, /Answers show after the next update/);
});

test('a flagged column read back from the cache is not promised its answers either', async () => {
  const { fieldColumnsHtml } = await view();
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Anything else?', index: 1, role: 'comment' }]);
  const sheet = [['Timestamp', 'Anything else?'], ['2026-11-10 09:00', 'a@example.org'], ['2026-11-11 09:00', 'b@example.org'], ['2026-11-12 09:00', 'Fine']];
  const cache = F.afterFetch(null, { rows: sheet, tab: { id: 0, title: 'T' }, timeZone: 'UTC' }, { now: 1, started: 1, link: { spreadsheetId: 'C'.repeat(30), gid: 0 }, roles });
  const html = fieldColumnsHtml(field(F.summariseCache(cache, roles)), { privacy: false });
  assert.match(html, /Answers look like emails or phone numbers/);
  assert.doesNotMatch(html, /Answers show after the next update/);
});

test('dates waiting for the next read say so on the board and in the sheet', async () => {
  const { fieldHtml, fieldSheetHtml } = await view();
  const s = { ...F.summarise(rows), datesWaiting: true, newest: null, oldest: null, newSince: null };
  for (const html of [fieldHtml(field(s), { privacy: true }), fieldSheetHtml(field(s), { privacy: true })]) {
    assert.match(html, /Dates show after the next update\. Refresh now to see them sooner\./);
  }
});

// ---- flags -------------------------------------------------------------------------------------

const flagRows = (() => {
  const head = ['Timestamp', 'How easy was the setup? (1-5)', 'What should we improve?'];
  const old = Array.from({ length: 10 }, (_, k) => [`2026-11-${String(1 + k).padStart(2, '0')} 09:00`, 4, `Earlier note number ${k} about the set-up`]);
  const fresh = [[1, 'The start-up was far too slow'], [2, 'The holder came loose twice'], [3, 'It crashed during the case']]
    .map(([v, t], k) => [`2026-11-${12 + k} 09:00`, v, t]);
  return [head, ...old, ...fresh];
})();
const flagged = () => {
  const s = F.summarise(flagRows, { since: new Date(2026, 10, 10, 12).toISOString() });
  return { ...field(s), sinceFetchedAt: new Date(2026, 10, 16, 8).getTime(), flags: F.fieldFlags({ summary: s, lastError: { kind: 'share', message: 'x' } }) };
};

test('with privacy on, no flag names a question by its wording', async () => {
  const { flagsHtml, flagText } = await view();
  const f = flagged();
  assert.deepEqual(f.flags.map((x) => x.kind), ['low', 'falling', 'comments', 'setup']);
  const words = f.flags.map((x) => flagText(x, { privacy: true, since: f.sinceFetchedAt }));
  for (const w of words) assert.doesNotMatch(w, /How easy|setup\?|improve|slow|holder|crashed/i, w);
  assert.match(words[0], /^2 low scores on Question 1 since /);
  const html = flagsHtml(f, { privacy: true });
  assert.doesNotMatch(html, /How easy was the setup/);
  // With privacy off, the question's own words.
  assert.match(flagText(f.flags[0], { privacy: false, since: f.sinceFetchedAt }), /^2 low scores on “How easy was the setup\? \(1-5\)” since /);
});

test('each kind of flag has its own glyph and words, and set-up flags link to their fix', async () => {
  const { flagsHtml } = await view();
  const html = flagsHtml(flagged(), { privacy: true });
  for (const kind of ['low', 'falling', 'comments', 'setup']) assert.match(html, new RegExp(`class="ico flag-glyph flag-${kind}"`), kind);
  assert.match(html, /<button type="button" class="link-btn" data-field="settings">Open Settings<\/button>/);
  assert.match(html, /3 new comments since /);
});

test('no flags is one calm line; no flags computed is no list at all', async () => {
  const { flagsHtml, fieldHtml, fieldSheetHtml } = await view();
  const calm = { ...field(F.summarise(rows)), flags: [] };
  assert.match(flagsHtml(calm), /Nothing to flag/);
  assert.match(fieldHtml(calm), /Nothing to flag/);
  assert.match(fieldSheetHtml(calm), /Nothing to flag/);
  assert.equal(flagsHtml(field(F.summarise(rows))), '');
});
