// The mini window: a small, always-on-top view in the spirit of a music
// player's mini mode. What runs now on every computer, by project, and each
// session's to-do list, so work can be followed while prompting elsewhere.
// It only reads: the same snapshots the hospital gets, nothing more.

import { installTips } from './tip.js';
import { loadDismissed, dismissWait } from './waiting.js';
import { elapsed } from './status.js';
import { personMarkup } from './people.js';
import { demoSnapshot } from './demo.js';
import { projectsHtml, wireProjects, demoProjects, demoTrees, paint } from './projects-view.js';
import { miniHtml } from './mini-view.js';
import { shownPlan, OPEN_PLAN } from './usage-view.js';
import { tr, localise, setLanguage, resolveLanguage, onMissing, said } from './i18n.js';

const bridge = window.agentsHome ?? (await import('./preview-bridge.js')).default;
const $ = (id) => document.getElementById(id);

// The hospital window's preferences (same origin, same storage): privacy
// mode, demo, colourway, plan and language follow it, and change here when
// changed there. A new language comes with a reload: the main process
// reloads both windows; the browser preview's tab reloads itself.
const prefs = { private: true, demo: false, theme: 'blossom' };
// Returns the language the preferences ask for.
function readPrefs() {
  let saved = {};
  let unreadable = false;
  try {
    saved = JSON.parse(localStorage.getItem('agents-home-prefs') || '{}') ?? {};
    Object.assign(prefs, saved);
  } catch {
    // Storage blocked or unreadable: privacy mode stays on, which is safe,
    // and the language follows Windows' (the hospital window says so).
    unreadable = true;
  }
  if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;
  document.documentElement.dataset.theme = prefs.theme;
  return resolveLanguage({ saved: saved.language, unreadable, system: navigator.languages }).id;
}
const shownLanguage = setLanguage(readPrefs());
// The main process logs each miss once; one it did not hear (it failed, or
// it is an older one without the handler) is told again at the next miss.
onMissing((code, key) => bridge.missingWords?.({ lang: code, key }));
localise(document);
addEventListener('storage', (e) => {
  if (e.key === 'agents-home-prefs') {
    if (readPrefs() !== shownLanguage && !window.agentsHome) location.reload();
    last = '';
  }
});

$('mascot').innerHTML = personMarkup('nurses-station');

let live = { sessions: [], fleet: { computers: [] } };
bridge.onSnapshot?.((s) => { live = s; });
const demoEpoch = Date.now();
const open = new Set(); // sessions whose whole to-do list is open

let last = '';
function render() {
  const snap = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : live;
  const { list: html, head } = miniHtml(snap, { privacy: prefs.private, open, dismissed: loadDismissed(), now: Date.now(), plan: shownPlan(prefs, snap) });
  // Redraw only on change, so an open list and the scroll position stay put.
  const sig = JSON.stringify([html.replace(/(data-since="\d+">)[^<]*/g, '$1'), prefs.private]);
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
  $('foot').textContent = prefs.demo ? tr('mini.demo') : '';
}

// ---- the projects tab ----------------------------------------------------------

const projOpen = new Set();
const projTrees = new Map(); // project id -> worktrees, once looked at
let projError;
const demoProj = demoProjects();
function renderProjects() {
  if ($('projects').hidden) return;
  const snap = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : live;
  const data = prefs.demo ? demoProj.snapshot() : snap.projects;
  paint($('projects'), projectsHtml(data, snap.sessions ?? [], { privacy: prefs.private, open: projOpen, error: projError, worktrees: projTrees }));
}
wireProjects($('projects'), {
  open: projOpen,
  change: async (c) => {
    if (prefs.demo) return demoProj.change(c);
    if (!bridge.projectChange) return { ok: false, error: tr('proj.previewSave') };
    return bridge.projectChange(c).then((res) => (res.ok ? res : { ...res, error: said(res.error) }), (err) => ({ ok: false, error: err.message }));
  },
  rerender: () => { renderProjects(); setTimeout(renderProjects, 600); },
  setError: (e) => { projError = e; },
  worktrees: projTrees,
  loadWorktrees: async (id) => (prefs.demo ? demoTrees(id) : bridge.worktrees ? bridge.worktrees(id).then((res) => (res.ok ? res : { ...res, error: said(res.error) })) : { ok: false, error: tr('proj.previewTrees') }),
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
  if (e.target.closest('.use-pick')) {
    // The hospital window opens Settings at the plan picker when it sees this.
    try {
      localStorage.setItem(OPEN_PLAN, String(Date.now()));
    } catch {
      // Storage blocked: the hospital window still comes up, at its own place.
    }
    if (bridge.showMain) bridge.showMain();
    else window.open('index.html', '_blank');
    return;
  }
  const dismiss = e.target.closest('.wait-dismiss');
  if (dismiss) {
    dismissWait(dismiss.dataset.key);
    render();
    return;
  }
  if (e.target.closest('.wait-open')) {
    bridge.showMain?.();
    return;
  }
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
  $('pin').title = tr(on ? 'mini.pin' : 'mini.unpin');
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
