'use strict';

// The plan and use card (renderer/usage-view.js) as the mini window and the
// board draw it, in both languages, from invented snapshots.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({ ...(await import('../renderer/usage-view.js')), ...(await import('../renderer/i18n.js')) });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const totals = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, fresh: total, replies: 1 });
const hit = (at, plan, window, tokens) => ({ at, plan, window, tokens });
// 3000 tokens in 5 hours against hits at 10000 and 14000: a quarter of 12000.
const snap = (hits, { paused = false, last5h = 2_627_000, week = 29_752_000, sessions = [], waiting = 0, waitingFor = null } = {}) => ({
  sessions,
  usage: { last5h: totals(last5h), today: totals(last5h), week: totals(week), limits: { paused, hits, waiting, waitingFor, expired: 0 } },
});
const twoHits = [hit(1, 'pro', '5h', 10_000), hit(2, 'pro', '5h', 14_000)];

test('plan not set: the card\'s first line is a button to Agent\'s Home\'s Settings, and no estimate is made', async () => {
  const { useCardHtml } = await load();
  const html = useCardHtml(snap(twoHits, { last5h: 3000 }), 'none');
  assert.match(html, /^<section class="use"[^>]*><button type="button" class="use-pick" title="Opens Settings in the hospital window, at the plan picker">Pick your plan in Agent&#39;s Home&#39;s Settings<\/button>/);
  assert.doesNotMatch(text(html), /Estimate/);
  assert.match(text(html), /Exact limits: Claude app → Settings → Usage/);
});

test('plan not set, with hits waiting for one: the card says how many', async () => {
  const { useCardHtml } = await load();
  assert.match(text(useCardHtml(snap([], { waiting: 2, waitingFor: 'plan' }), 'none')), /2 limit hits are waiting for your plan/);
  assert.doesNotMatch(text(useCardHtml(snap([], { waiting: 2, waitingFor: 'pass' }), 'none')), /waiting/);
});

test('two hits for the plan: "about N% of your 5-hour limit used", its basis on its own line', async () => {
  const { useCardHtml } = await load();
  const html = useCardHtml(snap(twoHits, { last5h: 3000 }), 'pro');
  assert.match(text(html), /Plan Pro/);
  assert.match(html, /<p class="use-est use-estimate">Estimate: about 25% of your 5-hour limit used<\/p><p class="use-basis">\(learned from 2 limit hits\)<\/p>/);
});

test('one hit: no estimate yet, and the card says how many more it needs', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap([hit(1, 'pro', '5h', 10_000)], { last5h: 3000 }), 'pro'));
  assert.match(t, /5-hour estimate: after 1 more limit hit(?!s)/);
  assert.doesNotMatch(t, /Estimate: about/);
  assert.match(text(useCardHtml(snap([hit(1, 'pro', 'week', 10_000)]), 'pro')), /Weekly estimate: after 1 more limit hit/);
});

test('hits with no Claude Code use before them are said, not dropped', async () => {
  const { useCardHtml, planRowsHtml } = await load();
  const hits = [hit(1, 'pro', '5h', 10_000), hit(2, 'pro', '5h', 0)];
  const t = text(useCardHtml(snap(hits, { last5h: 3000 }), 'pro'));
  assert.match(t, /1 limit hit not counted: no Claude Code use on this computer before it/);
  assert.match(t, /5-hour estimate: after 1 more limit hit/);
  assert.match(text(planRowsHtml(snap([...hits, hit(3, 'pro', 'week', 0)]).usage, 'pro')), /2 limit hits not counted: no Claude Code use on this computer before them/);
});

test('another plan\'s hits make no estimate: a new plan starts its own count', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'max5'));
  assert.match(t, /Plan Max 5×/);
  assert.doesNotMatch(t, /Estimate|after \d more/);
});

test('past the learned level is said in words, never as a share over 100%', async () => {
  const { useCardHtml, planRowsHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { last5h: 30_000 }), 'pro'));
  assert.match(t, /Estimate: past where your 5-hour limit was reached before \(learned from 2 limit hits\)/);
  assert.doesNotMatch(t, /\d{3,}%/);
  assert.doesNotMatch(text(planRowsHtml(snap(twoHits, { last5h: 30_000 }).usage, 'pro')), /\d{3,}%/);
});

test('the weekly window has its own estimate', async () => {
  const { useCardHtml } = await load();
  const hits = [hit(1, 'max20', 'week', 40_000_000), hit(2, 'max20', 'week', 60_000_000)];
  assert.match(text(useCardHtml(snap(hits, { week: 25_000_000 }), 'max20')), /Estimate: about 50% of your weekly limit used \(learned from 2 limit hits\)/);
});

test('an unreadable hits file pauses the estimate, pointing to Needs attention in the hospital window', async () => {
  const { useCardHtml } = await load();
  const t = text(useCardHtml(snap(twoHits, { paused: true, last5h: 3000 }), 'pro'));
  assert.match(t, /Estimate paused: see Needs attention in the hospital window/);
  assert.doesNotMatch(t, /about 25%|usage-limits/);
});

test('the fullest running session\'s context, named and with its percent written out; idle sessions do not count', async () => {
  const { useCardHtml } = await load();
  const sessions = [
    { id: 'a', project: 'alpha', status: 'working', context: { pct: 0.412 } },
    { id: 'b', project: 'beta', status: 'blocked', context: { pct: 0.88 } },
    { id: 'c', project: 'gamma', status: 'idle', context: { pct: 0.97 } },
  ];
  const html = useCardHtml(snap([], { sessions }), 'pro');
  assert.match(text(html), /Context · beta 88% nearly full: save your work/);
  assert.match(html, /aria-valuenow="88"/);
  assert.match(html, /title="Fullest context: beta, 88% used"/);
  assert.doesNotMatch(text(useCardHtml(snap([], { sessions: [sessions[0]] }), 'pro')), /save your work/);
  assert.match(text(useCardHtml(snap([], { sessions: [{ ...sessions[0], context: { pct: 1.02 } }] }), 'pro')), /Context · alpha 102% full: save your work/);
  assert.doesNotMatch(useCardHtml(snap([], { sessions: [sessions[2]] }), 'pro'), /use-ctx/, 'no running session, no bar');
});

test('tokens for the last 5 hours and 7 days', async () => {
  const { useCardHtml } = await load();
  assert.match(text(useCardHtml(snap([]), 'pro')), /Tokens 2\.6M in 5 hours · 30M in 7 days/);
  assert.doesNotMatch(useCardHtml({ sessions: [] }, 'pro'), /use-tokens/, 'not counted yet');
});

test('the board: the plan as a row ("Not set" with none), each estimate a row with its share in bold and the basis under it', async () => {
  const { planRowsHtml } = await load();
  assert.equal(text(planRowsHtml(snap([]).usage, 'none')), 'Plan Not set');
  const html = planRowsHtml(snap(twoHits, { last5h: 3000 }).usage, 'pro');
  assert.match(html, /<div class="usage-row"><span>5-hour limit used \(estimate\)<\/span><strong>about 25%<\/strong><span class="muted">\(learned from 2 limit hits\)<\/span><\/div>/);
  assert.match(text(planRowsHtml(snap(twoHits, { last5h: 30_000 }).usage, 'pro')), /5-hour limit used \(estimate\) ⚠ past earlier limit hits/);
});

test('the card in Chinese: both apps named, plan, estimate, basis and the wait', async () => {
  const { useCardHtml, setLanguage } = await load();
  setLanguage('zh-TW');
  try {
    const t = text(useCardHtml(snap(twoHits, { last5h: 3000 }), 'pro'));
    assert.match(t, /方案 Pro/);
    assert.match(t, /估計：5 小時上限已用約 25% （依前 2 次碰到上限推算）/);
    assert.match(t, /精確用量：Claude App → 設定 → 用量/);
    assert.match(text(useCardHtml(snap([]), 'none')), /^請在 Agent's Home 的設定中選擇方案/);
    assert.match(text(useCardHtml(snap([hit(1, 'pro', 'week', 5)]), 'pro')), /每週估計：再碰到 1 次上限就開始/);
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
