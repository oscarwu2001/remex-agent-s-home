'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/growth.js');

test('the ledger keeps the larger count for a day and never adds a day twice', async () => {
  const { mergeLedger, lifetimeTokens } = await load();
  let ledger = mergeLedger({}, { writer: { '2026-09-01': 500, '2026-09-02': 300 } });
  ledger = mergeLedger(ledger, { writer: { '2026-09-02': 800, '2026-09-03': 100 } });
  ledger = mergeLedger(ledger, { writer: { '2026-09-03': 100 } });
  assert.equal(lifetimeTokens(ledger, 'writer'), 500 + 800 + 100);
  assert.equal(lifetimeTokens(ledger, 'nobody'), 0);
});

test('an egg hatches at the threshold, then each stage grows and can evolve at its top', async () => {
  const { lifeOf, HATCH_AT, SPAN } = await load();
  assert.deepEqual(lifeOf(HATCH_AT / 2, undefined), { stage: 0, progress: 0.5, ready: false, next: HATCH_AT });
  assert.equal(lifeOf(HATCH_AT, undefined).ready, true);
  const baby = lifeOf(HATCH_AT, { species: 'cat', stage: 1 });
  assert.deepEqual([baby.stage, baby.progress, baby.ready], [1, 0, false]);
  assert.equal(lifeOf(SPAN[1][1], { species: 'cat', stage: 1 }).ready, true);
  const evolved = lifeOf(SPAN[1][1], { species: 'cat', stage: 2 });
  assert.deepEqual([evolved.progress, evolved.ready], [0, false], 'an evolved creature starts its stage small');
  assert.equal(lifeOf(1e12, { species: 'cat', stage: 3 }).ready, false, 'the last stage does not evolve');
});

test('evolving makes a creature small again, but each stage ends bigger', async () => {
  const { lifeOf, sizeOf, SPAN } = await load();
  const top1 = sizeOf(lifeOf(SPAN[1][1], { species: 'cat', stage: 1 }));
  const start2 = sizeOf(lifeOf(SPAN[1][1], { species: 'cat', stage: 2 }));
  const top2 = sizeOf(lifeOf(SPAN[2][1], { species: 'cat', stage: 2 }));
  const top3 = sizeOf(lifeOf(SPAN[3][1], { species: 'cat', stage: 3 }));
  assert.ok(start2 < top1);
  assert.ok(top1 < top2 && top2 < top3);
});

test('rarity is earned by good work and kept once earned', async () => {
  const { rarityFrom, bestRarity } = await load();
  assert.equal(rarityFrom(undefined), 'R');
  assert.equal(rarityFrom({ score: 95, runs: 3 }), 'R', 'too few runs to tell');
  assert.equal(rarityFrom({ score: 84, runs: 6 }), 'SR');
  assert.equal(rarityFrom({ score: 93, runs: 12 }), 'SSR');
  assert.equal(bestRarity('SSR', 'R'), 'SSR');
  assert.equal(bestRarity(undefined, 'SR'), 'SR');
});

test('each egg offers three different starters, the same three every time', async () => {
  const { starterChoices } = await load();
  const ids = ['cat', 'dog', 'bunny', 'fox', 'dragon', 'dinosaur', 'fish', 'bird', 'turtle', 'axolotl'];
  const a = starterChoices('reviewer', ids);
  assert.equal(new Set(a).size, 3);
  assert.deepEqual(starterChoices('reviewer', ids), a);
  assert.ok(a.every((s) => ids.includes(s)));
});

test('only fully grown dragons and birds fly', async () => {
  const { flies } = await load();
  assert.equal(flies('dragon', 3), true);
  assert.equal(flies('bird', 3), true);
  assert.equal(flies('dragon', 2), false);
  assert.equal(flies('cat', 3), false);
});

test('a point for every 15 minutes the app is open, and none for time asleep', async () => {
  const { earn, WELCOME_POINTS } = await load();
  let play = earn(undefined, 0);
  assert.deepEqual(play, { points: WELCOME_POINTS, minutes: 0, last: 0 });
  for (let t = 60_000; t <= 30 * 60_000; t += 60_000) play = earn(play, t);
  assert.equal(play.points, WELCOME_POINTS + 2);
  play = earn(play, play.last + 8 * 3_600_000); // the laptop slept for 8 hours
  assert.equal(Math.round(play.minutes), 32, 'a long gap counts as two minutes at most');
  assert.equal(earn(play, play.last - 1000).minutes, play.minutes, 'a clock set back adds nothing');
});

test('a mystery creature grows with time in the app: an hour hatches it', async () => {
  const { wildTokens, lifeOf, HATCH_AT } = await load();
  assert.equal(lifeOf(wildTokens({ minutes: 100 }, 50), undefined).ready, false);
  assert.equal(wildTokens({ minutes: 110 }, 50), HATCH_AT);
});

test('mystery eggs roll rarity by the odds, and kind and look evenly', async () => {
  const { rollMystery } = await load();
  const ids = ['cat', 'dog'];
  const seq = (...xs) => () => xs.shift();
  assert.deepEqual(rollMystery(ids, 10, seq(0.01, 0.6, 0.35)), { species: 'dog', variant: 3, rarity: 'SSR' });
  assert.deepEqual(rollMystery(ids, 10, seq(0.2, 0.1, 0.99)), { species: 'cat', variant: 9, rarity: 'SR' });
  assert.equal(rollMystery(ids, 10, seq(0.9, 0, 0)).rarity, 'R');
});

test('the index keeps each form found, its best rarity and the looks seen', async () => {
  const { noteInDex } = await load();
  let dex = noteInDex({}, { species: 'cat', stage: 1, variant: 2, rarity: 'R' });
  dex = noteInDex(dex, { species: 'cat', stage: 1, variant: 5, rarity: 'SSR' });
  dex = noteInDex(dex, { species: 'cat', stage: 1, variant: 2, rarity: 'SR' });
  assert.deepEqual(dex, { 'cat:1': { rarity: 'SSR', looks: [2, 5] } });
  assert.equal(noteInDex(dex, { species: 'cat', stage: 1, variant: 5, rarity: 'R' }), dex, 'unchanged when nothing is new');
});
