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
// counted, what waits first. Without a plan, only the hits waiting for one
// are said.
export function planWords(usage, plan) {
  const words = planWordsAsSeen(usage, plan);
  const waits = words.notes.filter((n) => n.kind === 'waiting');
  return { ...words, notes: [...waits, ...words.notes.filter((n) => n.kind !== 'waiting')] };
}

function planWordsAsSeen(usage, plan) {
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
        : { kind: 'estimate', window: w, text: tr(`use.estimate.${w}`, { pct: e.pct }), row, value: tr('use.row.about', { pct: e.pct }), basis, pct: e.pct });
    }
  }
  // On the card only while the estimate they would have helped still waits.
  if (zeroWaiting) note('zero', tr('use.zero', { n: zeroWaiting }), { board: false });
  if (zero) note('zero', tr('use.zero', { n: zero }), { card: false });
  if (limits.unnamed) note('unnamed', tr('use.unnamed', { n: limits.unnamed }));
  return { plan: name, lines, notes };
}

const noteHtml = (n) => `<p class="use-note">${esc(n.text)}</p>`;

// The card's plan and estimate lines (its notes come after the tokens,
// planNotesHtml). With no plan, the line is a button
// that opens the hospital window's Settings at the plan picker.
export function planLines(usage, plan) {
  const p = planWords(usage, plan);
  if (!p.plan) return `<button type="button" class="use-pick" title="${esc(tr('use.pickTitle'))}">${esc(tr('use.pick'))}</button>`;
  const lines = p.lines.map((l) => {
    const mark = l.kind === 'over' ? '<span class="use-mark" aria-hidden="true">!</span>' : '';
    const basis = l.basis ? `<p class="use-basis">${esc(l.basis)}</p>` : '';
    return `<p class="use-est use-${l.kind}">${mark}${esc(l.text)}</p>${basis}`;
  });
  return `<p class="use-plan"><span class="use-label">${esc(tr('use.plan'))}</span> <strong>${esc(p.plan)}</strong></p>${lines.join('')}`;
}

// The card's notes: what waits, expired or is not counted.
export const planNotesHtml = (usage, plan) => planWords(usage, plan).notes.filter((n) => n.card).map(noteHtml).join('');

// Claude Code's own limit message, passed on as it came; with privacy mode
// on, without its links (it can carry one, as any text can).
export function limitText(text, privacy) {
  const t = String(text ?? '');
  return privacy ? t.replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?:\/\S*)?/gi, tr('use.linkHidden')) : t;
}

const fullest = (sessions) => sessions.reduce((best, s) => (!best || s.context.pct > best.context.pct ? s : best), null);
const withContext = (sessions, keep) => (sessions ?? []).filter((s) => keep(s.status) && Number.isFinite(s.context?.pct));

// The running session whose context is fullest, on this computer (other
// computers share no context).
export const fullestContext = (sessions) => fullest(withContext(sessions, isRunning));

// The context the mini window's head shows: the fullest running session's,
// else the fullest of those waiting for your turn (the next prompt starts
// from it). Idle and finished sessions do not count.
export const shownContext = (sessions) => fullestContext(sessions) ?? fullest(withContext(sessions, (st) => st === 'your-turn'));

const METER_TOKENS = { '5h': 'last5h', week: 'week' };

// A meter's bar: its share written out for screen readers (the words beside
// it say it for everyone). With nothing to show, an empty bar keeps its
// place, so the rows never move.
const meterBar = (pct, label) => (pct === null
  ? '<span class="meter-bar none" aria-hidden="true"></span>'
  : `<span class="meter-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><span style="width:${pct}%"></span></span>`);
const mark = '<span class="use-mark" aria-hidden="true">!</span>';
const dash = '<strong class="meter-value">—</strong>';

// One row: label, value, bar, and its side (the estimate's share, or a mark
// with its word).
function meter({ kind, cls = '', title, side = '', value = dash, bar }) {
  return `<div class="meter meter-${kind}${cls}" title="${esc(title)}"><span class="meter-label">${esc(tr(`use.meter.${kind}`))}</span>${value}${bar}<span class="meter-side">${side}</span></div>`;
}

function contextMeter(s) {
  if (!s) return meter({ kind: 'context', title: tr('use.meter.noContext'), bar: meterBar(null) });
  const pct = Math.round(s.context.pct * 100);
  const warn = s.context.pct >= CONTEXT_WARN;
  const words = tr('use.contextOf', { project: s.project, pct });
  return meter({ kind: 'context', cls: warn ? ' warn' : '', title: words, side: warn ? mark : '', value: `<strong class="meter-value">${pct}%</strong>`, bar: meterBar(Math.min(100, pct), words) });
}

// Why a window shows no share yet: no plan, the estimate paused, how many
// more limit hits it needs.
function whyNoShare(w, p, plan, usage) {
  if (!isPlan(plan) || plan === 'none') return tr('use.meter.whyPlan');
  if (usage?.limits?.paused) return tr('use.paused');
  return p.lines.find((l) => l.window === w && l.kind === 'wait')?.text ?? tr('use.meter.whyHits', { n: HITS_NEEDED });
}

function windowMeter(w, usage, p, plan) {
  const total = usage?.[METER_TOKENS[w]]?.total;
  if (!Number.isFinite(total)) return meter({ kind: w, title: tr('use.meter.notYet'), bar: meterBar(null) });
  const amount = compact(total);
  const tokens = tr(`use.meter.tokens.${w}`, { n: total, amount });
  const value = `<strong class="meter-value">${esc(amount)} <span class="meter-unit">${esc(tr('use.meter.unit', { n: total }))}</span></strong>`;
  const line = p.lines.find((l) => l.window === w && l.kind !== 'wait');
  if (!line) return meter({ kind: w, title: tr('use.meter.titleWith', { tokens, estimate: whyNoShare(w, p, plan, usage) }), value, bar: meterBar(null) });
  const title = tr('use.meter.titleWith', { tokens, estimate: line.text });
  if (line.kind === 'over') return meter({ kind: w, cls: ' over', title, side: `${mark}${esc(tr('use.meter.over'))}`, value, bar: meterBar(100, line.text) });
  return meter({ kind: w, title, side: esc(tr('use.meter.about', { pct: line.pct })), value, bar: meterBar(line.pct, line.text) });
}

// The line under the rows, always there so the head never changes height:
// whose context the first row is, or that it is nearly full, in words.
function contextCaption(s) {
  if (!s) return `<p class="meters-note">${esc(tr('use.meter.noContextShort'))}</p>`;
  const state = s.context.pct >= 1 ? 'use.meter.full' : s.context.pct >= CONTEXT_WARN ? 'use.meter.nearlyFull' : null;
  if (!state) return `<p class="meters-note">${esc(tr('use.meter.whose', { project: s.project }))}</p>`;
  const words = tr(state, { project: s.project });
  return `<p class="meters-note warn" title="${esc(words)}">${mark}<span>${esc(words)}</span></p>`;
}

// The mini window's head: context, 5 hours and 7 days, always the same
// three rows and the line under them, on both tabs. Tokens always; a
// window's estimate share and its bar once it has one (its hover says why
// not yet); past the learned level, a mark and a word.
export function metersHtml(snap, plan) {
  const usage = snap?.usage;
  const s = shownContext(snap?.sessions);
  const p = planWords(usage, plan);
  return `<div class="meters-row" role="group" aria-label="${esc(tr('use.meters'))}">${contextMeter(s)}${WINDOWS.map((w) => windowMeter(w, usage, p, plan)).join('')}</div>${contextCaption(s)}`;
}

// The mini window's card: plan and estimate, what waits or is not counted,
// and where the exact numbers are. Context and tokens are in the head
// (metersHtml), always in view.
export function useCardHtml(snap, plan) {
  const usage = snap?.usage;
  return `<section class="use" aria-label="${esc(tr('use.title'))}">${planLines(usage, plan)}${planNotesHtml(usage, plan)}
      <p class="use-exact">${exactHtml()}</p></section>`;
}

// Where the exact numbers are, the path kept on one line.
export const exactHtml = () => trHtml('use.exact', { path: raw(`<span class="use-path">${esc(tr('use.exactPath'))}</span>`) });

// The board's rows: the plan, then each window's estimate as a row with
// its share in bold, the basis under it; other lines, then the notes, as hints.
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
  return row(tr('use.plan'), esc(p.plan ?? tr('plan.none'))) + lines.join('') + notes.map(hint).join('');
}
