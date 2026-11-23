'use strict';

// The plan and use card (renderer/usage-view.js) as the mini window and the
// board draw it, in both languages, from invented snapshots.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({ ...(await import('../renderer/usage-view.js')), ...(await import('../renderer/i18n.js')) });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const totals = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, fresh: total, replies: 1 });
const hit = (at, plan, window, tokens) => ({ at, plan, window, tokens });
// 3000 tokens in 5 hours against hits at 10000 and 14000: a quarter of 12000.
const snap = (hits, { paused = false, last5h = 2_627_000, week = 29_752_000, sessions = [] } = {}) => ({
  sessions,
  usage: { last5h: totals(last5h), today: totals(last5h), week: totals(week), limits: { paused, hits } },
});
const twoHits = [hit(1, 'pro', '5h', 10_000), hit(2, 'pro', '5h', 14_000)];

test('plan not set: the card points to Settings, and no estimate is made', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'none'));
  assert.match(t, /^Pick your plan in Settings/);
  assert.doesNotMatch(t, /Estimate/);
  assert.match(t, /Exact limits: Claude → Settings → Usage/);
});

test('two hits for the plan: "about N% of your 5-hour limit used", with its basis', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'pro'));
  assert.match(t, /Plan Pro/);
  assert.match(t, /Estimate: about 25% of your 5-hour limit used from 2 limit hits/);
});

test('one hit: no estimate yet, and the card says it starts after 2', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap([hit(1, 'pro', '5h', 10_000)], { last5h: 3000 }), 'pro'));
  assert.match(t, /The 5-hour estimate starts after 2 limit hits on this plan \(1 so far\)/);
  assert.doesNotMatch(t, /Estimate: about/);
});

test('another plan\'s hits make no estimate: a new plan starts its own count', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'max5'));
  assert.match(t, /Plan Max 5×/);
  assert.doesNotMatch(t, /Estimate|starts after/);
});

test('past the learned level is said in words, never as a share over 100%', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 30_000 }), 'pro'));
  assert.match(t, /Estimate: past where your 5-hour limit was reached before from 2 limit hits/);
  assert.doesNotMatch(t, /\d{3,}%/);
});

test('the weekly window has its own estimate', async () => {
  const { useCardHtml } = await load();
  const hits = [hit(1, 'max20', 'week', 40_000_000), hit(2, 'max20', 'week', 60_000_000)];
  assert.match(text(useCardHtml(snap(hits, { week: 25_000_000 }), 'max20')), /Estimate: about 50% of your weekly limit used from 2 limit hits/);
});

test('an unreadable hits file pauses the estimate, in words', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { paused: true, last5h: 3000 }), 'pro'));
  assert.match(t, /Estimate paused: usage-limits\.json could not be read \(see Needs attention\)/);
  assert.doesNotMatch(t, /about 25%/);
});

test('the fullest running session\'s context, its percent written out; idle sessions and other computers do not count', async () => {
  const { useCardHtml } = await load();
  const sessions = [
    { id: 'a', project: 'alpha', status: 'working', context: { pct: 0.412 } },
    { id: 'b', project: 'beta', status: 'blocked', context: { pct: 0.88 } },
    { id: 'c', project: 'gamma', status: 'idle', context: { pct: 0.97 } },
  ];
  const html = useCardHtml(snap([], { sessions }), 'pro');
  assert.match(text(html), /Context 88% nearly full/);
  assert.match(html, /aria-valuenow="88"/);
  assert.match(html, /title="Fullest context: beta, 88% used"/);
  assert.doesNotMatch(text(useCardHtml(snap([], { sessions: [sessions[0]] }), 'pro')), /nearly full/);
  assert.doesNotMatch(useCardHtml(snap([], { sessions: [sessions[2]] }), 'pro'), /use-ctx/, 'no running session, no bar');
});

test('tokens for the last 5 hours and 7 days', async () => {
  const { useCardHtml } = await load();
  assert.match(text(useCardHtml(snap([]), 'pro')), /Tokens 2\.6M in 5 hours · 30M in 7 days/);
  assert.doesNotMatch(useCardHtml({ sessions: [] }, 'pro'), /use-tokens/, 'not counted yet');
});

test('the card in Chinese: plan, estimate, basis and the pointer to the exact numbers', async () => {
  const { useCardHtml, setLanguage } = await load();
  setLanguage('zh-TW');
  try {
    const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'pro'));
    assert.match(t, /方案 Pro/);
    assert.match(t, /估計：5 小時上限已用約 25% 根據 2 次碰到上限/);
    assert.match(t, /精確用量：Claude → 設定 → 用量/);
    assert.match(text(useCardHtml(snap([]), 'none')), /^請在設定中選擇你的方案/);
  } finally {
    setLanguage('en');
  }
});

test('the plan shown is the one picked; the demo brings its own only until one is', async () => {
  const { shownPlan } = await load();
  const demo = { demo: true, usage: { demoPlan: 'max5' } };
  assert.equal(shownPlan({ plan: 'pro' }, demo), 'pro');
  assert.equal(shownPlan({}, demo), 'max5');
  assert.equal(shownPlan({ plan: 'none' }, demo), 'none');
  assert.equal(shownPlan({}, { usage: { demoPlan: 'max5' } }), 'none', 'never outside the demo');
  assert.equal(shownPlan({ plan: 'gold' }, {}), 'none', 'an unknown plan is not set');
});
