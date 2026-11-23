// The plan and Claude Code use, as markup: the mini window's card and the
// board's plan rows. Pure, so the windows draw them and the tests read
// them in each language. The estimate itself is renderer/plans.js's.

import { tr, trHtml, raw, escapeHtml as esc } from './i18n.js';
import { estimate, isPlan, HITS_NEEDED, WINDOWS } from './plans.js';
import { isRunning } from './overview.js';

// The storage key by which the mini window's "Pick your plan" asks the
// hospital window for Settings at the plan picker (its value: when asked).
export const OPEN_PLAN = 'agents-home-open-plan';

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

// What the card and the board say about the plan: its name (null when none
// is picked), a line for each window with hits ({ kind: 'estimate' | 'over'
// | 'wait', window, text, row, value, basis }), and notes ({ kind, text,
// card, board }: where each is said) on hits that wait, expired or are not
// counted. Without a plan, only the hits waiting for one are said.
export function planWords(usage, plan) {
  const limits = usage?.limits;
  const notes = [];
  const note = (kind, text, { card = true, board = true } = {}) => notes.push({ kind, text, card, board });
  const waiting = limits?.waiting ?? {};
  if (waiting.plan) note('waiting', tr('use.waitingPlan', { n: waiting.plan }));
  if (limits?.expiredPlan) note('expired', tr('use.expiredPlan', { n: limits.expiredPlan }), { board: false });
  if (!isPlan(plan) || plan === 'none') return { plan: null, lines: [], notes };
  const name = tr(`plan.${plan}`);
  if (!limits) return { plan: name, lines: [], notes };
  if (limits.paused) return { plan: name, lines: [], notes: [...notes, { kind: 'paused', text: tr('use.paused'), card: true, board: true }] };
  if (waiting.wsl) note('waiting', tr('use.waitingWsl', { n: waiting.wsl }));
  if (waiting.pass) note('waiting', tr('use.waitingPass', { n: waiting.pass }));
  const est = estimate(limits.hits, plan, usage);
  const lines = [];
  let zeroWaiting = 0;
  let zero = 0;
  for (const w of WINDOWS) {
    const e = est[w];
    zero += e.zero;
    if (e.hits < HITS_NEEDED) zeroWaiting += e.zero;
    if (e.hits && e.hits < HITS_NEEDED) lines.push({ kind: 'wait', window: w, text: tr(`use.after.${w}`, { n: HITS_NEEDED - e.hits }) });
    else if (e.pct !== undefined) {
      const basis = tr('use.basis', { n: e.basis });
      const row = tr(`use.row.${w}`);
      lines.push(e.over
        ? { kind: 'over', window: w, text: tr(`use.over.${w}`), row, value: tr('use.row.over'), basis }
        : { kind: 'estimate', window: w, text: tr(`use.estimate.${w}`, { pct: e.pct }), row, value: tr('use.row.about', { pct: e.pct }), basis });
    }
  }
  // On the card only while the estimate they would have helped still waits.
  if (zeroWaiting) note('zero', tr('use.zero', { n: zeroWaiting }), { board: false });
  if (zero) note('zero', tr('use.zero', { n: zero }), { card: false });
  if (limits.unnamed) note('unnamed', tr('use.unnamed', { n: limits.unnamed }));
  return { plan: name, lines, notes };
}

const noteHtml = (n) => `<p class="use-note">${esc(n.text)}</p>`;

// The card's plan and estimate lines. With no plan, the line is a button
// that opens the hospital window's Settings at the plan picker.
export function planLines(usage, plan) {
  const p = planWords(usage, plan);
  const notes = p.notes.filter((n) => n.card).map(noteHtml).join('');
  if (!p.plan) return `<button type="button" class="use-pick" title="${esc(tr('use.pickTitle'))}">${esc(tr('use.pick'))}</button>${notes}`;
  const lines = p.lines.map((l) => {
    const mark = l.kind === 'over' ? '<span class="use-mark" aria-hidden="true">!</span>' : '';
    const basis = l.basis ? `<p class="use-basis">${esc(l.basis)}</p>` : '';
    return `<p class="use-est use-${l.kind}">${mark}${esc(l.text)}</p>${basis}`;
  });
  return `<p class="use-plan"><span class="use-label">${esc(tr('use.plan'))}</span> <strong>${esc(p.plan)}</strong></p>${lines.join('')}${notes}`;
}

// Claude Code's own limit message, passed on as it came; with privacy mode
// on, without its links (it can carry one, as any text can).
export function limitText(text, privacy) {
  const t = String(text ?? '');
  return privacy ? t.replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?:\/\S*)?/gi, tr('use.linkHidden')) : t;
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
  const state = s.context.pct >= 1 ? 'use.full' : s.context.pct >= CONTEXT_WARN ? 'use.nearlyFull' : null;
  const words = tr('use.contextOf', { project: s.project, pct });
  return `<div class="use-ctx${state ? ' full' : ''}" title="${esc(words)}">
      <p class="use-ctx-head"><span class="use-label">${esc(tr('use.context', { project: s.project }))}</span><strong class="use-pct">${pct}%</strong></p>
      <span class="use-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct)}" aria-label="${esc(words)}"><span style="width:${Math.min(100, pct)}%"></span></span>
      ${state ? `<p class="use-full">${esc(tr(state))}</p>` : ''}</div>`;
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
      <p class="use-exact">${exactHtml()}</p></section>`;
}

// Where the exact numbers are, the path kept on one line.
export const exactHtml = () => trHtml('use.exact', { path: raw(`<span class="use-path">${esc(tr('use.exactPath'))}</span>`) });

// The board's rows: the plan, what waits for it, then each window's
// estimate as a row with its share in bold, the basis under it; other
// lines and notes as hints.
export function planRowsHtml(usage, plan) {
  const p = planWords(usage, plan);
  const row = (label, value, basis = '') => `<div class="usage-row"><span>${esc(label)}</span><strong>${value}</strong>${basis ? `<span class="muted">${esc(basis)}</span>` : ''}</div>`;
  const hint = (n) => `<p class="hint">${esc(n.text)}</p>`;
  const notes = p.notes.filter((n) => n.board);
  const lines = p.lines.map((l) => {
    if (l.kind === 'estimate') return row(l.row, esc(l.value), l.basis);
    if (l.kind === 'over') return row(l.row, `⚠ ${esc(l.value)}`, l.basis);
    return hint(l);
  });
  return row(tr('use.plan'), esc(p.plan ?? tr('plan.none'))) + notes.filter((n) => n.kind === 'waiting').map(hint).join('')
    + lines.join('') + notes.filter((n) => n.kind !== 'waiting').map(hint).join('');
}
