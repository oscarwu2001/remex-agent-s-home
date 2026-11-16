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
  assert.deepEqual(roles.find((r) => r.index === GUESSED), { header: 'How satisfied are you overall?', index: GUESSED, role: 'score', low: 1, high: 7, worse: false });
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
  assert.deepEqual(roles.find((r) => r.header === 'Ease (1-5)'), { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5, worse: false });
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

test('dates waiting for the next read are one line with a Refresh now link, and no flags line', async () => {
  const { fieldHtml, fieldSheetHtml } = await view();
  const s = { ...F.summarise(rows), datesWaiting: true, newest: null, oldest: null, newSince: null };
  const f = { ...field(s), flags: F.fieldFlags({ summary: s }) };
  for (const html of [fieldHtml(f, { privacy: true }), fieldSheetHtml(f, { privacy: true })]) {
    assert.match(html, /Dates show after the next update. <button type="button" class="link-btn" data-field="refresh">Refresh now<\/button>/);
    assert.doesNotMatch(html, /Flags show after the next update|to see them sooner/);
  }
});

// ---- flags -------------------------------------------------------------------------------------

const NOW = new Date(2026, 10, 16, 12).getTime();
// Ten answers in October, three in the last 7 days.
const flagRows = (() => {
  const head = ['Timestamp', 'How easy was the setup? (1-5)', 'What should we improve?'];
  const old = Array.from({ length: 10 }, (_, k) => [`2026-10-${String(1 + k).padStart(2, '0')} 09:00`, 4, `Earlier note number ${k} about the set-up`]);
  const fresh = [[1, 'The start-up was far too slow'], [2, 'The holder came loose twice'], [3, 'It crashed during the case']]
    .map(([v, t], k) => [`2026-11-${12 + k} 09:00`, v, t]);
  return [head, ...old, ...fresh];
})();
const flagged = () => {
  const s = F.summarise(flagRows, { now: NOW });
  return { ...field(s), flags: F.fieldFlags({ summary: s, lastError: { kind: 'share', message: 'x' } }) };
};

test('with privacy on, no flag names a question by its wording', async () => {
  const { flagsHtml, flagText } = await view();
  const f = flagged();
  assert.deepEqual(f.flags.list.map((x) => x.kind), ['low', 'falling', 'comments', 'setup']);
  const words = f.flags.list.map((x) => flagText(x, { privacy: true }));
  for (const w of words) assert.doesNotMatch(w, /How easy|setup\?|improve|slow|holder|crashed/i, w);
  assert.equal(words[0], '2 low scores on Question 1 in the last 7 days (2 or less on 1–5)');
  assert.equal(words[1], 'Question 1 average down to 2.0 of 5 in the last 7 days (was 4.0)');
  assert.equal(words[2], '3 comments in the last 7 days');
  assert.doesNotMatch(flagsHtml(f, { privacy: true }), /How easy was the setup/);
  // With privacy off, the question's own words.
  assert.equal(flagText(f.flags.list[0], { privacy: false }), '2 low scores on “How easy was the setup? (1-5)” in the last 7 days (2 or less on 1–5)');
});

test('each kind of flag has its own glyph and words, and set-up flags link to their fix', async () => {
  const { flagsHtml } = await view();
  const html = flagsHtml(flagged(), { privacy: true });
  for (const kind of ['low', 'falling', 'comments', 'setup']) assert.match(html, new RegExp(`class="ico flag-glyph flag-${kind}"`), kind);
  assert.match(html, /<button type="button" class="link-btn" data-field="settings">Open Settings<\/button>/);
});

test('where higher is worse, the flags say high scores and an average going up, with their own glyph', async () => {
  const { flagsHtml, flagText } = await view();
  const head = ['Timestamp', 'How difficult was setup? (1-5)'];
  const rows = [head, ...Array.from({ length: 10 }, (_, k) => [`2026-10-${String(1 + k).padStart(2, '0')} 09:00`, 2]), ['2026-11-12 09:00', 5], ['2026-11-13 09:00', 4], ['2026-11-14 09:00', 4]];
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: head[1], index: 1, role: 'score', low: 1, high: 5, worse: true }]);
  const s = F.summarise(rows, { now: NOW, roles });
  const f = { ...field(s), flags: F.fieldFlags({ summary: s }) };
  assert.deepEqual(f.flags.list.map((x) => flagText(x, { privacy: true })), [
    '3 high scores on Question 1 in the last 7 days (4 or more on 1–5, higher is worse)',
    'Question 1 average up to 4.3 of 5 in the last 7 days (was 2.0; higher is worse)',
  ]);
  assert.match(flagsHtml(f), /class="ico flag-glyph flag-rising"/);
});

test('nothing to flag only when the window was compared; otherwise the board says why', async () => {
  const { flagsHtml, fieldHtml, fieldSheetHtml } = await view();
  const s = F.summarise(rows);
  const calm = { ...field(s), flags: { why: null, earlier: true, list: [] } };
  assert.match(flagsHtml(calm), /Nothing to flag/);
  assert.match(fieldHtml(calm), /Nothing to flag/);
  assert.match(fieldSheetHtml(calm), /Nothing to flag/);
  assert.equal(flagsHtml(field(s)), '');
  const said = (why) => flagsHtml({ ...field(s), flags: { why, earlier: false, list: [] } });
  assert.match(said('unread'), /Flags show after the first update/);
  assert.match(said('waiting'), /Flags show after the next update/);
  assert.match(said('no-dates'), /No dates to compare yet\./);
  assert.match(said('no-dates'), /data-field="check">Check the columns</);
  for (const why of ['unread', 'waiting', 'no-dates']) assert.doesNotMatch(said(why), /Nothing to flag/, why);
  // A set-up problem still shows under any of them.
  assert.match(flagsHtml({ ...field(s), flags: { why: 'unread', earlier: false, list: [{ kind: 'setup', what: 'share', fix: 'settings' }] } }), /not shared/);
  // Nothing from before the window: averages wait, and the board says so.
  assert.match(flagsHtml({ ...field(s), flags: { why: null, earlier: false, list: [] } }), /No answers from before the last 7 days/);
});

test('a set-up flag for unchosen columns replaces the note above the numbers, and says the numbers are guesses', async () => {
  const { fieldHtml, fieldSheetHtml, flagText } = await view();
  const s = F.summarise(rows);
  assert.equal(s.needsChoice, 1);
  const f = { ...field(s), flags: F.fieldFlags({ summary: s }) };
  for (const html of [fieldHtml(f), fieldSheetHtml(f)]) assert.doesNotMatch(html, /Columns not checked yet/);
  assert.equal(flagText(f.flags.list.find((x) => x.what === 'choose')), '1 column needs a choice; until then the numbers are the app’s guesses');
  // Without flags worked out, the note stays.
  assert.match(fieldHtml(field(s)), /Columns not checked yet/);
});

const PAIN = [['Timestamp', 'Pain relief achieved (0-10)', 'Ease (1-5)'], ['2026-11-10 09:00', 2, 4], ['2026-11-11 09:00', 3, 5]];
const painRow = (html) => html.split('<li').find((x) => x.includes('Pain relief') || x.includes('Question 1'));

test('a guessed direction needs a choice: choosing Score alone does not settle it, the direction select does', async () => {
  const { fieldColumnsHtml, rolesFrom, draftWith } = await view();
  const s = F.summarise(PAIN);
  const f = field(s);
  const before = fieldColumnsHtml(f, { privacy: false });
  assert.match(painRow(before), /Needs a choice/);
  assert.match(painRow(before), /Direction guessed/);
  assert.match(painRow(before), /The app’s guess: Score, 0–10, higher is worse\./);
  // A score whose title says nothing of pain starts on "Higher is better".
  assert.match(before, /<select id="fc-worse-2" data-col="2" data-part="worse" aria-label="Ease \(1-5\): higher is better or worse"><option value="better" selected>Higher is better<\/option><option value="worse">Higher is worse<\/option><\/select>/);
  // Score chosen alone: the direction starts on "Choose…", the row still needs a choice, Save stays refused.
  const score = draftWith({}, 1, 'role', 'score');
  const half = fieldColumnsHtml(f, { privacy: false, draft: score });
  assert.match(painRow(half), /<select id="fc-worse-1" data-col="1" data-part="worse" aria-label="Pain relief achieved \(0-10\): higher is better or worse"><option value="" selected>Choose…<\/option><option value="better">Higher is better<\/option><option value="worse">Higher is worse<\/option><\/select>/);
  assert.match(painRow(half), /Needs a choice/);
  assert.match(painRow(half), /Direction guessed/);
  assert.match(half, /<button[^>]*id="field-check-save"[^>]*disabled/);
  assert.equal(rolesFrom(f, score).missing, 1);
  assert.deepEqual(F.checkSubmission(s, F.checkRoles([...rolesFrom(f, score).roles, { header: PAIN[0][1], index: 1, role: 'score', low: 0, high: 10 }])), { missing: 1 });
  // The direction chosen: settled, and saved either way.
  const better = draftWith(score, 1, 'worse', 'better');
  const done = fieldColumnsHtml(f, { privacy: false, draft: better });
  assert.doesNotMatch(painRow(done), /Needs a choice|Direction guessed/);
  assert.doesNotMatch(done, /<button[^>]*id="field-check-save"[^>]*disabled/);
  assert.deepEqual(rolesFrom(f, better), { roles: [
    { header: 'Timestamp', index: 0, role: 'timestamp' },
    { header: 'Pain relief achieved (0-10)', index: 1, role: 'score', low: 0, high: 10, worse: false },
    { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5, worse: false },
  ], missing: 0 });
  assert.equal(rolesFrom(f, draftWith(score, 1, 'worse', 'worse')).roles[1].worse, true);
  assert.deepEqual(F.checkSubmission(s, F.checkRoles(rolesFrom(f, better).roles)), { missing: 0 });
});

test('a score saved before the direction was asked keeps its role and scale, and asks only the direction', async () => {
  const { fieldColumnsHtml, rolesFrom } = await view();
  const old = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: PAIN[0][1], index: 1, role: 'score', low: 0, high: 10 }, { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5 }]);
  const f = field(F.summarise(PAIN, { roles: old }));
  const r = painRow(fieldColumnsHtml(f, { privacy: false }));
  assert.match(r, /<option value="score" selected>/);
  assert.match(r, /<option selected>10<\/option>/);
  assert.match(r, /data-part="worse"[^>]*><option value="" selected>Choose…/);
  assert.match(r, /Needs a choice/);
  assert.match(r, /Direction guessed/);
  assert.match(r, /The app’s guess: higher is worse\./);
  assert.equal(rolesFrom(f, {}).missing, 1);
});

test('with privacy on, the read-only rows say each score\'s direction in words', async () => {
  const { fieldColumnsHtml } = await view();
  const what = (roles) => [...fieldColumnsHtml(field(F.summarise(PAIN, { roles })), { privacy: true }).matchAll(/<p class="field-col-what">([^<]*)<\/p>/g)].map((m) => m[1]);
  const ts = { header: 'Timestamp', index: 0, role: 'timestamp' };
  const ease = { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5, worse: false };
  assert.deepEqual(what(F.checkRoles([ts, { header: PAIN[0][1], index: 1, role: 'score', low: 0, high: 10, worse: true }, ease])), ['When answered', 'Score, 0–10, higher is worse', 'Score, 1–5, higher is better']);
  assert.deepEqual(what(F.checkRoles([ts, { header: PAIN[0][1], index: 1, role: 'score', low: 0, high: 10 }, ease])), ['When answered', 'Score, 0–10, direction not chosen', 'Score, 1–5, higher is better']);
});

test('the direction select comes after the scale in each score row, a plain select with its own name', async () => {
  const { fieldColumnsHtml, draftWith } = await view();
  const html = painRow(fieldColumnsHtml(field(F.summarise(PAIN)), { privacy: false, draft: draftWith({}, 1, 'role', 'score') }));
  const at = (id) => html.indexOf(`id="${id}"`);
  assert.ok(at('fc-role-1') < at('fc-low-1') && at('fc-low-1') < at('fc-high-1') && at('fc-high-1') < at('fc-worse-1'), 'role, from, to, direction');
  assert.doesNotMatch(html, /tabindex|type="checkbox"/);
  // The keys pick the options' values, which the draft takes as they come.
  assert.deepEqual([draftWith({}, 1, 'worse', 'worse')[1], draftWith({}, 1, 'worse', 'better')[1], draftWith({ 1: { worse: true } }, 1, 'worse', '')[1]], [{ worse: true }, { worse: false }, {}]);
});

test('the read-only step links to the privacy switch that opens it', async () => {
  const { fieldColumnsHtml, FIXES } = await view();
  assert.match(fieldColumnsHtml(field(F.summarise(rows)), { privacy: true }), /<button type="button" class="link-btn" id="field-goto-switch" data-field="privacy-switch">Go to the switch<\/button>/);
  assert.deepEqual(Object.keys(FIXES), ['check', 'settings', 'refresh']);
});

test('before the first read, or when the summary failed, the section has no Flags block', async () => {
  const { fieldHtml } = await view();
  const unread = { enabled: true, sheetUrl: 'x', keyName: 'k.json', summary: null, flags: { why: 'unread', earlier: false, list: [{ kind: 'setup', what: 'share', fix: 'settings' }] } };
  assert.doesNotMatch(fieldHtml(unread), /Flags|not shared/);
  assert.doesNotMatch(fieldHtml({ ...unread, summaryError: 'The answers kept could not be summarised.' }), /Flags/);
});

test('while the error line shows, the share and failed flags are not said again', async () => {
  const { fieldHtml } = await view();
  const s = F.summarise(rows);
  for (const [kind, what] of [['share', 'share'], ['network', 'failed']]) {
    const f = { ...field(s), error: 'Share the sheet with the key’s reader address…', errorKind: kind, flags: F.fieldFlags({ summary: s, lastError: { kind, message: 'x' } }) };
    const html = fieldHtml(f);
    assert.equal((html.match(/The last update failed/g) ?? []).length, 1, what);
    assert.doesNotMatch(html, /not shared with the key/, what);
    // The sheet has no error line, so there the flag stays.
    assert.ok(f.flags.list.some((x) => x.what === what));
  }
});

test('the board says why the window could not be compared, each in its own words', async () => {
  const { flagsHtml } = await view();
  const s = F.summarise(rows);
  const said = (flags) => flagsHtml({ ...field(s), flags: { earlier: false, list: [], ...flags } });
  assert.match(said({ why: 'empty' }), /The sheet has no answers yet/);
  assert.match(said({ why: 'quiet', newest: new Date(2026, 10, 2, 9).toISOString() }), /No answers in the last 7 days \(newest: [^)]+\)/);
  const noDates = said({ why: 'no-dates' });
  assert.match(noDates, /<p class="field-calm">No dates to compare yet\.<\/p><p class="field-fix"><button type="button" class="link-btn" data-field="check">Check the columns<\/button><\/p>/);
  for (const why of ['empty', 'quiet', 'no-dates']) assert.doesNotMatch(said({ why }), /Nothing to flag/, why);
});

test('in the sheet a higher-is-worse question is tagged, says what it counts as, and fills from the right; a guessed direction is left out', async () => {
  const { fieldSheetHtml } = await view();
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'How difficult was setup? (1-5)', index: 1, role: 'score', low: 1, high: 5, worse: true }]);
  const head = [['Timestamp', 'How difficult was setup? (1-5)', 'Pain relief achieved (0-10)'], ['2026-11-10 09:00', 2, 8], ['2026-11-11 09:00', 1, 9]];
  const html = fieldSheetHtml(field(F.summarise(head, { roles })), { privacy: true });
  const [hard, pain] = html.split('<li class="field-q">').slice(1);
  // Difficulty 2 and 1: 1.5 of 5, counted as 4.5 (1 + 5 - 1.5).
  assert.match(hard, /<span class="field-q-name">Question 1 <span class="tag">Higher is worse<\/span><\/span>/);
  assert.match(hard, /higher is worse: counts as 4\.5 in the average/);
  assert.match(hard, /<div class="meter from-right" role="img" aria-label="1\.5 of 5, higher is worse"><span style="width:13%"><\/span><\/div>/);
  assert.doesNotMatch(pain, /class="tag"|from-right|counts as/);
  assert.match(pain, /direction guessed<\/span>, not in the average/);
});

test('after a failed update, nothing to flag says how old the answers are', async () => {
  const { flagsHtml, fieldHtml } = await view();
  const f = { ...field(F.summarise(rows)), fetchedAt: NOW - 3 * 86_400_000, error: 'No network.', errorKind: 'network',
    flags: { why: null, earlier: true, list: [{ kind: 'setup', what: 'failed', fix: 'refresh' }] } };
  assert.match(fieldHtml(f, { now: NOW }), /<p class="field-calm">Nothing to flag in the answers read 3 days ago<\/p>/);
  assert.match(flagsHtml({ ...f, flags: { ...f.flags, list: [] } }, { now: NOW }), /Nothing to flag in the answers read 3 days ago/);
  assert.match(flagsHtml({ ...f, error: null, flags: { ...f.flags, list: [] } }, { now: NOW }), /<p class="field-calm">Nothing to flag<\/p>/);
});

test('the average\'s dash says why when only a direction is guessed', async () => {
  const { fieldHtml } = await view();
  const s = F.summarise([['Timestamp', 'Pain relief achieved (0-10)'], ['2026-11-10 09:00', 2], ['2026-11-11 09:00', 3]]);
  assert.deepEqual([s.overall, s.scalesGuessed, s.directionsGuessed], [null, 0, 1]);
  assert.match(fieldHtml(field(s)), /<dt class="stat-label" title="[^"]+">Average score<\/dt>/);
});
