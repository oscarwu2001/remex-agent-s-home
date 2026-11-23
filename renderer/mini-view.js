// The mini window's Now tab and headline, as markup: what runs now on
// every computer, by project, and each session's to-do list. Pure, so
// mini.js draws it and the tests can read it in each language.

import { overview, headlineBadges, runningBadge, helperBadge, todoPips, SOURCE_NAMES, isRunning, icon } from './overview.js';
import { waitingList, waitingHtml, clashHtml } from './waiting.js';
import { jobsHtml, machineHtml, workHtml } from './jobs-view.js';
import { statusText, glyphKey, elapsed } from './status.js';
import { bubbleMarkup } from './people.js';
import { fieldBadge } from './field-view.js';
import { useCardHtml, metersHtml } from './usage-view.js';
import { tr, escapeHtml as esc } from './i18n.js';

export const glyph = (x) => `<svg class="glyph" viewBox="-16 -16 32 32" aria-hidden="true">${bubbleMarkup(glyphKey(x))}</svg>`;

function todoBlock(s, key, { privacy, open }) {
  const t = s.todos;
  if (!t?.total) return '';
  const pips = `<div class="todo-sum">${todoPips(t)}</div>`;
  // Wording is the user's own: only with privacy mode off, and only for
  // this computer's sessions (others share counts only).
  if (privacy || !t.items) return pips;
  const now = t.items.find((i) => i.status === 'in_progress') ?? t.items.find((i) => i.status === 'pending');
  const nowText = now ? `<p class="todo-now">${esc(now.status === 'in_progress' && now.active ? now.active : now.text)}</p>` : '';
  const isOpen = open.has(key);
  const toggle = `<button type="button" class="todo-toggle" data-key="${esc(key)}" aria-expanded="${isOpen}" title="${esc(tr(isOpen ? 'mini.hideList' : 'mini.wholeList'))}"><span class="visually-hidden">${esc(tr('mini.wholeListFor', { project: s.project }))}</span></button>`;
  const list = isOpen ? `<ol class="todo-all">${t.items.map((i) => `<li class="${i.status}"><span class="pip ${i.status}" aria-hidden="true"></span><span>${esc(i.text || tr('todo.untitled'))}</span></li>`).join('')}</ol>` : '';
  return `<div class="todo-row">${pips}${toggle}</div>${isOpen ? '' : nowText}${list}`;
}

// A short word for each status: the glyph's shape says the rest.
const SHORT = new Set(['working', 'thinking', 'reporting', 'blocked', 'delegating', 'your-turn', 'idle']);

function sessionCard(s, local, opts) {
  const key = `${s.computer ?? ''}|${s.id ?? s.project}`;
  const tag = s.source && s.source !== 'code' ? `<span class="tag">${esc(SOURCE_NAMES[s.source] ?? s.source)}</span>` : '';
  const helpers = (s.agents ?? []).filter((a) => a.status !== 'done');
  // Helpers as their status glyphs; the name is on hover and for screen readers.
  // A thinking helper has no bubble: it shows as a plain person mark.
  const helperMark = (a) => (a.status === 'thinking' ? `<span class="glyph-quiet">${icon('helper')}</span>` : glyph(a));
  const helperWords = (a) => esc(tr('helper.status', { type: a.type, status: statusText(a) }));
  const helperLine = helpers.length ? `<span class="helpers">${helpers.slice(0, 5).map((a) => `<span class="helper" title="${helperWords(a)}">${helperMark(a)}<span class="visually-hidden">${helperWords(a)}</span></span>`).join('')}${helpers.length > 5 ? `<span class="more">+${helpers.length - 5}</span>` : ''}</span>` : '';
  const since = local && s.startedAt ? `<span class="since" data-since="${s.startedAt}">${elapsed(s.startedAt, opts.now)}</span>` : '';
  const full = local ? statusText(s) : statusText({ status: s.status });
  return `<li class="sess${isRunning(s.status) ? ' running' : ''}" title="${esc(full)}">
      ${glyph(s)}
      <div class="sess-body">
        <p class="sess-top"><span class="sess-what">${esc(SHORT.has(s.status) ? tr(`short.${s.status}`) : full)}</span>${tag}${helperLine}${since}</p>
        ${todoBlock(s, key, opts)}
      </div></li>`;
}

// opts: { privacy, open: Set of sessions whose whole list is open,
// dismissed: waits hidden, now, plan: the plan shown }. Returns { list, head,
// meters: context, 5 hours and 7 days for the window's head }.
export function miniHtml(snap, { privacy = true, open = new Set(), dismissed = new Set(), now = Date.now(), plan = 'none' } = {}) {
  const o = overview(snap.sessions ?? [], snap.here ?? tr('common.thisComputer'), snap.fleet?.computers ?? [], { jobs: snap.jobs ?? [], machine: snap.machine, work: snap.work ?? [] });
  const opts = { privacy, open, now };
  const groups = o.computers.filter((c) => c.sessions || c.local || (c.jobs ?? []).length || (c.work ?? []).length).map((c) => {
    const projects = c.projects.map((p) => `<li class="proj"><p class="proj-head"><span class="proj-name">${esc(p.project)}</span><span class="badges">${p.running ? runningBadge(p.running) : ''}${p.helpers ? helperBadge(p.helpers) : ''}</span></p>
        <ul class="sessions">${p.sessions.map((s) => sessionCard(s, c.local, opts)).join('')}</ul></li>`).join('');
    const state = c.local ? '' : tr(c.online ? 'mini.online' : 'mini.offline');
    return `<section class="computer${c.online ? '' : ' offline'}"><h2>${esc(c.computer)}${state ? ` <span class="state">${esc(state)}</span>` : ''}</h2>
        ${machineHtml(c.machine)}${jobsHtml(c.jobs, now)}${workHtml(c.work, now)}${projects ? `<ul class="projects">${projects}</ul>` : (c.jobs ?? []).length || (c.work ?? []).length ? '' : `<p class="empty">${esc(tr('mini.nothingHere'))}</p>`}</section>`;
  }).join('');
  const waits = clashHtml(snap.clashes) + waitingHtml(waitingList(snap.sessions ?? [], dismissed), now, glyph);
  return {
    list: waits + useCardHtml(snap, plan) + (groups || `<p class="empty">${esc(tr('mini.noSessions'))}</p>`),
    head: headlineBadges(o) + fieldBadge(snap.field, now),
    meters: metersHtml(snap, plan),
  };
}
