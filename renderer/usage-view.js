// The plan and Claude Code use, as markup: the mini window's card and the
// board's plan lines. Pure, so the windows draw them and the tests read
// them in each language. The estimate itself is renderer/plans.js's.

import { tr, escapeHtml as esc } from './i18n.js';
import { estimate, isPlan, HITS_NEEDED, WINDOWS } from './plans.js';
import { isRunning } from './overview.js';

// A session is flagged at this share of its context (the board's line too).
export const CONTEXT_WARN = 0.85;

// 1234 -> "1.2k", 3456789 -> "3.5M".
export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

// The plan to show: the one picked in Settings. The demo brings its own
// until one is picked, so it shows a plan and its estimate out of the box.
export function shownPlan(prefs, snap) {
  if (isPlan(prefs?.plan)) return prefs.plan;
  if (snap?.demo && isPlan(snap.usage?.demoPlan)) return snap.usage.demoPlan;
  return 'none';
}

// The plan, then each window's estimate or how far it is from one.
export function planLines(usage, plan) {
  if (!isPlan(plan) || plan === 'none') return `<p class="use-plan use-pick">${esc(tr('use.pickPlan'))}</p>`;
  const head = `<p class="use-plan"><span class="use-label">${esc(tr('use.plan'))}</span> <strong>${esc(tr(`plan.${plan}`))}</strong></p>`;
  const limits = usage?.limits;
  if (!limits) return head;
  if (limits.paused) return `${head}<p class="use-est use-paused">${esc(tr('use.paused'))}</p>`;
  const est = estimate(limits.hits, plan, usage);
  const lines = WINDOWS.map((w) => {
    const e = est[w];
    if (!e.hits) return '';
    if (e.hits < HITS_NEEDED || e.pct === undefined) return `<p class="use-est use-wait">${esc(tr(`use.after.${w}`, { need: HITS_NEEDED, n: e.hits }))}</p>`;
    const words = e.over ? tr(`use.over.${w}`) : tr(`use.estimate.${w}`, { pct: e.pct });
    return `<p class="use-est${e.over ? ' use-over' : ''}">${e.over ? '<span class="use-mark" aria-hidden="true">!</span>' : ''}${esc(words)} <span class="use-basis">${esc(tr('use.basis', { n: e.basis }))}</span></p>`;
  });
  return head + lines.join('');
}

// The running session whose context is fullest, on this computer (other
// computers share no context).
export function fullestContext(sessions) {
  return (sessions ?? []).filter((s) => isRunning(s.status) && Number.isFinite(s.context?.pct))
    .reduce((best, s) => (!best || s.context.pct > best.context.pct ? s : best), null);
}

function contextLine(s) {
  if (!s) return '';
  const pct = Math.round(s.context.pct * 100);
  const full = s.context.pct >= CONTEXT_WARN;
  const words = tr('use.contextOf', { project: s.project, pct });
  return `<div class="use-ctx${full ? ' full' : ''}" title="${esc(words)}"><span class="use-label">${esc(tr('use.context'))}</span>
      <span class="use-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct)}" aria-label="${esc(words)}"><span style="width:${Math.min(100, pct)}%"></span></span>
      <strong class="use-pct">${pct}%</strong>${full ? `<span class="use-full">${esc(tr('use.nearlyFull'))}</span>` : ''}</div>`;
}

function tokensLine(usage) {
  if (!usage?.last5h || !usage?.week) return '';
  return `<p class="use-tokens"><span class="use-label">${esc(tr('use.tokens'))}</span> <span>${esc(tr('use.tokens5h', { n: compact(usage.last5h.total) }))}</span>
      <span class="use-sep" aria-hidden="true">·</span> <span>${esc(tr('use.tokensWeek', { n: compact(usage.week.total) }))}</span></p>`;
}

// The mini window's card: plan and estimate, the fullest context, tokens
// over 5 hours and 7 days, and where the exact numbers are.
export function useCardHtml(snap, plan) {
  const usage = snap?.usage;
  return `<section class="use" aria-label="${esc(tr('use.title'))}">${planLines(usage, plan)}${contextLine(fullestContext(snap?.sessions))}${tokensLine(usage)}
      <p class="use-exact">${esc(tr('use.exact'))}</p></section>`;
}
