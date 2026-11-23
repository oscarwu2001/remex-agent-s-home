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
const snap = (hits, { paused = false, last5h = 2_627_000, week = 29_752_000, sessions = [], waiting = {}, expiredPlan = 0, unnamed = 0 } = {}) => ({
  sessions,
  usage: { last5h: totals(last5h), today: totals(last5h), week: totals(week),
    limits: { paused, hits, waiting: { file: 0, pass: 0, wsl: 0, plan: 0, ...waiting }, expiredPlan, unnamed } },
});
const twoHits = [hit(1, 'pro', '5h', 10_000), hit(2, 'pro', '5h', 14_000)];

test('plan not set: the card\'s first line is a button to Agent\'s Home\'s Settings, and no estimate is made', async () => {
  const { useCardHtml } = await load();
  const html = useCardHtml(snap(twoHits, { last5h: 3000 }), 'none');
  assert.match(html, /^<section class="use"[^>]*><button type="button" class="use-pick" title="Opens Settings in the hospital window, at the plan picker">Pick your plan in Agent&#39;s Home Settings<\/button>/);
  assert.doesNotMatch(text(html), /Estimate/);
  assert.match(text(html), /Exact limits: Claude app → Settings → Usage/);
});

test('plan not set, with hits waiting for one: the card says how many', async () => {
  const { useCardHtml } = await load();
  assert.match(text(useCardHtml(snap([], { waiting: { plan: 2 } }), 'none')), /2 limit hits are waiting for your plan/);
  assert.doesNotMatch(text(useCardHtml(snap([], { waiting: { pass: 2 } }), 'none')), /wait/);
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
  // Once the window's estimate stands, the card no longer says it; the board does.
  const learned = [...twoHits, hit(3, 'pro', '5h', 0)];
  assert.doesNotMatch(text(useCardHtml(snap(learned, { last5h: 3000 }), 'pro')), /not counted/);
  assert.match(text(planRowsHtml(snap(learned, { last5h: 3000 }).usage, 'pro')), /1 limit hit not counted/);
});

test('hits waiting for WSL or for every folder to be read are said with a count, on the card and the board', async () => {
  const { useCardHtml, planRowsHtml } = await load();
  const s = snap(twoHits, { last5h: 3000, waiting: { wsl: 2, pass: 1 } });
  for (const t of [text(useCardHtml(s, 'pro')), text(planRowsHtml(s.usage, 'pro'))]) {
    assert.match(t, /2 limit hits wait until WSL is running, so WSL's use can be counted/);
    assert.match(t, /1 limit hit waits until all your sessions have been read/);
  }
});

test('limit messages that named no limit are said as not counted; hits that waited over 7 days for a plan are said on the card only', async () => {
  const { useCardHtml, planRowsHtml } = await load();
  const s = snap(twoHits, { last5h: 3000, unnamed: 3, expiredPlan: 1 });
  const card = text(useCardHtml(s, 'pro'));
  assert.match(card, /3 limit hits not counted: their messages did not say which limit/);
  assert.match(card, /1 limit hit not counted: it waited over 7 days for you to pick a plan/);
  const board = text(planRowsHtml(s.usage, 'pro'));
  assert.match(board, /3 limit hits not counted: their messages did not say which limit/);
  assert.doesNotMatch(board, /pick a plan/);
});

test('the notes come after the tokens line on the card, just before Exact limits, and after the rows on the board', async () => {
  const { useCardHtml, planRowsHtml } = await load();
  const s = snap(twoHits, { last5h: 3000, waiting: { wsl: 1 }, unnamed: 2 });
  const card = text(useCardHtml(s, 'pro'));
  const order = ['Estimate:', 'Tokens', 'until WSL is running', 'not counted', 'Exact limits'].map((w) => card.indexOf(w));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), card);
  const board = text(planRowsHtml(s.usage, 'pro'));
  assert.ok(board.indexOf('learned from') < board.indexOf('until WSL is running'), board);
});

test('the board says what waits for a plan under its plan row', async () => {
  const { planRowsHtml } = await load();
  assert.equal(text(planRowsHtml(snap([], { waiting: { plan: 1 } }).usage, 'none')), 'Plan Not set 1 limit hit is waiting for your plan');
});

test('with privacy on, Claude Code\'s limit message is passed on without its links', async () => {
  const { limitText } = await load();
  const msg = 'You\'ve hit your session limit · resets 6pm (Europe/London). See https://example.test/upgrade or claude.ai/settings, or www.example.test.';
  assert.equal(limitText(msg, true), 'You\'ve hit your session limit · resets 6pm (Europe/London). See [link hidden] or [link hidden] or [link hidden]');
  assert.equal(limitText(msg, false), msg);
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
    assert.match(text(useCardHtml(snap([hit(1, 'pro', '5h', 10), hit(2, 'pro', '5h', 0)]), 'pro')), /有 1 次碰到上限沒有計入/);
    assert.match(t, /精確用量：\s?Claude App → 設定 → 用量/);
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
