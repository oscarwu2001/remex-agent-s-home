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
