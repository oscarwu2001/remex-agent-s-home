// The mini window: a small, always-on-top view in the spirit of a music
// player's mini mode. What runs now on every computer, by project, and each
// session's to-do list, so work can be followed while prompting elsewhere.
// It only reads: the same snapshots the hospital gets, nothing more.

import { overview, headline, headlineBadges, runningBadge, helperBadge, todoPips, SOURCE_NAMES, isRunning, icon } from './overview.js';
import { installTips } from './tip.js';
import { jobsHtml, machineHtml } from './jobs-view.js';
import { statusText, glyphKey, elapsed } from './status.js';
import { bubbleMarkup, personMarkup } from './people.js';
import { demoSnapshot } from './demo.js';
import { projectsHtml, wireProjects, demoProjects, paint } from './projects-view.js';

const bridge = window.agentsHome ?? (await import('./preview-bridge.js')).default;
const $ = (id) => document.getElementById(id);

// The hospital window's preferences (same origin, same storage): privacy
// mode, demo and colourway follow it, and change here when changed there.
const prefs = { private: true, demo: false, theme: 'blossom' };
function readPrefs() {
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem('agents-home-prefs') || '{}'));
  } catch {
    // Storage blocked or unreadable: privacy mode stays on, which is safe.
  }
  if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;
  document.documentElement.dataset.theme = prefs.theme;
}
readPrefs();
addEventListener('storage', (e) => {
  if (e.key === 'agents-home-prefs') {
    readPrefs();
    last = '';
  }
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const glyph = (x) => `<svg class="glyph" viewBox="-16 -16 32 32" aria-hidden="true">${bubbleMarkup(glyphKey(x))}</svg>`;

$('mascot').innerHTML = personMarkup('nurses-station');

let live = { sessions: [], here: 'This computer', fleet: { computers: [] } };
bridge.onSnapshot?.((s) => { live = s; });
const demoEpoch = Date.now();
const open = new Set(); // sessions whose whole to-do list is open

function todoBlock(s, key) {
  const t = s.todos;
  if (!t?.total) return '';
  const pips = `<div class="todo-sum">${todoPips(t)}</div>`;
  // Wording is the user's own: only with privacy mode off, and only for
  // this computer's sessions (others share counts only).
  if (prefs.private || !t.items) return pips;
  const now = t.items.find((i) => i.status === 'in_progress') ?? t.items.find((i) => i.status === 'pending');
  const nowText = now ? `<p class="todo-now">${esc(now.status === 'in_progress' && now.active ? now.active : now.text)}</p>` : '';
  const isOpen = open.has(key);
  const toggle = `<button type="button" class="todo-toggle" data-key="${esc(key)}" aria-expanded="${isOpen}" title="${isOpen ? 'Hide the list' : 'Whole list'}"><span class="visually-hidden">Whole to-do list for ${esc(s.project)}</span></button>`;
  const list = isOpen ? `<ol class="todo-all">${t.items.map((i) => `<li class="${i.status}"><span class="pip ${i.status}" aria-hidden="true"></span><span>${esc(i.text || 'Untitled')}</span></li>`).join('')}</ol>` : '';
  return `<div class="todo-row">${pips}${toggle}</div>${isOpen ? '' : nowText}${list}`;
}

// A short word for each status: the glyph's shape says the rest.
const SHORT = { working: 'Working', thinking: 'Thinking', reporting: 'Writing up', blocked: 'Needs you?', delegating: 'With helpers', 'your-turn': 'Your turn', idle: 'Idle' };

function sessionCard(s, local) {
  const key = `${s.computer ?? ''}|${s.id ?? s.project}`;
  const tag = s.source && s.source !== 'code' ? `<span class="tag">${esc(SOURCE_NAMES[s.source] ?? s.source)}</span>` : '';
  const helpers = (s.agents ?? []).filter((a) => a.status !== 'done');
  // Helpers as their status glyphs; the name is on hover and for screen readers.
  // A thinking helper has no bubble: it shows as a plain person mark.
  const helperMark = (a) => (a.status === 'thinking' ? `<span class="glyph-quiet">${icon('helper')}</span>` : glyph(a));
  const helperLine = helpers.length ? `<span class="helpers">${helpers.slice(0, 5).map((a) => `<span class="helper" title="${esc(`${a.type}: ${statusText(a)}`)}">${helperMark(a)}<span class="visually-hidden">${esc(`${a.type}: ${statusText(a)}`)}</span></span>`).join('')}${helpers.length > 5 ? `<span class="more">+${helpers.length - 5}</span>` : ''}</span>` : '';
  const since = local && s.startedAt ? `<span class="since" data-since="${s.startedAt}">${elapsed(s.startedAt, Date.now())}</span>` : '';
  const full = local ? statusText(s) : statusText({ status: s.status });
  return `<li class="sess${isRunning(s.status) ? ' running' : ''}" title="${esc(full)}">
      ${glyph(s)}
      <div class="sess-body">
        <p class="sess-top"><span class="sess-what">${esc(SHORT[s.status] ?? full)}</span>${tag}${helperLine}${since}</p>
        ${todoBlock(s, key)}
      </div></li>`;
}

let last = '';
function render() {
  const snap = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : live;
  const o = overview(snap.sessions ?? [], snap.here ?? 'This computer', snap.fleet?.computers ?? [], { jobs: snap.jobs ?? [], machine: snap.machine });
  const groups = o.computers.filter((c) => c.sessions || c.local || (c.jobs ?? []).length).map((c) => {
    const projects = c.projects.map((p) => `<li class="proj"><p class="proj-head"><span class="proj-name">${esc(p.project)}</span><span class="badges">${p.running ? runningBadge(p.running) : ''}${p.helpers ? helperBadge(p.helpers) : ''}</span></p>
        <ul class="sessions">${p.sessions.map((s) => sessionCard(s, c.local)).join('')}</ul></li>`).join('');
    const state = c.local ? '' : c.online ? 'online' : 'offline';
    return `<section class="computer${c.online ? '' : ' offline'}"><h2>${esc(c.computer)}${state ? ` <span class="state">${state}</span>` : ''}</h2>
        ${machineHtml(c.machine)}${jobsHtml(c.jobs)}${projects ? `<ul class="projects">${projects}</ul>` : (c.jobs ?? []).length ? '' : '<p class="empty">Nothing running here.</p>'}</section>`;
  }).join('');
  const html = groups || '<p class="empty">No sessions yet.</p>';
  // Redraw only on change, so an open list and the scroll position stay put.
  const sig = JSON.stringify([html.replace(/(data-since="\d+">)[^<]*/g, '$1'), prefs.private]);
  const head = headlineBadges(o);
  if ($('headline').dataset.sig !== head) {
    $('headline').innerHTML = `<span class="badges">${head}</span>`;
    $('headline').dataset.sig = head;
  }
  if (sig !== last) {
    last = sig;
    paint($('list'), html); // keeps keyboard focus on the same control
  } else {
    // Same picture: only the elapsed times move on.
    for (const el of $('list').querySelectorAll('.since')) el.textContent = elapsed(Number(el.dataset.since), Date.now());
  }
  $('foot').textContent = prefs.demo ? 'Demo' : '';
}

// ---- the projects tab ----------------------------------------------------------

const projOpen = new Set();
let projError;
const demoProj = demoProjects();
function renderProjects() {
  if ($('projects').hidden) return;
  const snap = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : live;
  const data = prefs.demo ? demoProj.snapshot() : snap.projects;
  paint($('projects'), projectsHtml(data, snap.sessions ?? [], { privacy: prefs.private, open: projOpen, error: projError }));
}
wireProjects($('projects'), {
  open: projOpen,
  change: async (c) => {
    if (prefs.demo) return demoProj.change(c);
    if (!bridge.projectChange) return { ok: false, error: 'The browser preview cannot save the project list; this works in the app.' };
    return bridge.projectChange(c).catch((err) => ({ ok: false, error: err.message }));
  },
  rerender: () => { renderProjects(); setTimeout(renderProjects, 600); },
  setError: (e) => { projError = e; },
});
function showTab(which) {
  const projects = which === 'projects';
  $('tab-now').setAttribute('aria-selected', String(!projects));
  $('tab-projects').setAttribute('aria-selected', String(projects));
  // Only the chosen tab is in the Tab order; arrows, Home and End move between them.
  $('tab-now').tabIndex = projects ? -1 : 0;
  $('tab-projects').tabIndex = projects ? 0 : -1;
  $('list').hidden = projects;
  $('projects').hidden = !projects;
  renderProjects();
}
$('tab-now').addEventListener('click', () => showTab('now'));
$('tab-projects').addEventListener('click', () => showTab('projects'));
$('mascot').parentElement.addEventListener('keydown', (e) => {
  if (e.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 'tab-now' : e.key === 'End' ? 'tab-projects' : e.target.id === 'tab-now' ? 'tab-projects' : 'tab-now';
  $(next).focus();
  showTab(next === 'tab-now' ? 'now' : 'projects');
});

installTips();
setInterval(() => { render(); renderProjects(); }, 500);
render();

$('list').addEventListener('click', (e) => {
  const b = e.target.closest('.todo-toggle');
  if (!b) return;
  const key = b.dataset.key;
  if (open.has(key)) open.delete(key);
  else open.add(key);
  render();
  $('list').querySelector(`.todo-toggle[data-key="${CSS.escape(key)}"]`)?.focus();
});

$('pin').addEventListener('click', () => {
  const on = $('pin').getAttribute('aria-pressed') !== 'true';
  $('pin').setAttribute('aria-pressed', String(on));
  $('pin').title = on ? 'Keep this window on top' : 'Let other windows cover this one';
  bridge.miniPin?.(on);
});
$('close').addEventListener('click', () => {
  if (bridge.miniClose) bridge.miniClose();
  else window.close();
});
$('open-main').addEventListener('click', () => {
  if (bridge.showMain) bridge.showMain();
  else window.open('index.html', '_blank');
});
