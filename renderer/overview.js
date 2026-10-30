// "Running now": every live session, on this computer and on the others
// sharing a folder, grouped by computer and then by project. Pure, so the
// board, the mini window and the tests all use the same numbers.

// A session or helper counts as running in these states; "your turn",
// idle and finished do not. Keep in step with RUNNING in src/core/fleet.js.
export const RUNNING = new Set(['working', 'thinking', 'reporting', 'blocked', 'delegating']);
export const isRunning = (status) => RUNNING.has(status);

export const SOURCE_NAMES = { code: 'Claude Code', cowork: 'Cowork', wsl: 'WSL' };

export function overview(localSessions, here, others = []) {
  const groups = [];
  const add = (computer, sessions, { local = false, online = true, at } = {}) => {
    const byProject = new Map();
    for (const s of sessions) {
      const p = byProject.get(s.project) ?? { project: s.project, sessions: [], running: 0, helpers: 0 };
      p.sessions.push(s);
      if (isRunning(s.status)) p.running += 1;
      p.helpers += (s.agents ?? []).filter((a) => a.status !== 'done').length;
      byProject.set(s.project, p);
    }
    const projects = [...byProject.values()].sort((a, b) => b.running - a.running || a.project.localeCompare(b.project));
    groups.push({
      computer, local, online, at,
      sessions: sessions.length,
      running: sessions.filter((s) => isRunning(s.status)).length,
      helpers: projects.reduce((n, p) => n + p.helpers, 0),
      projects,
    });
  };
  // This computer's sessions may run in several places (Windows, WSL): each
  // `computer` label is its own group, this computer's first.
  const byWhere = new Map([[here, []]]);
  for (const s of localSessions) {
    const where = s.computer ?? here;
    byWhere.set(where, [...(byWhere.get(where) ?? []), s]);
  }
  for (const [where, sessions] of byWhere) if (sessions.length || where === here) add(where, sessions, { local: true });
  for (const o of others) add(o.computer, o.sessions ?? [], { online: o.online, at: o.at });
  return {
    computers: groups,
    sessions: groups.reduce((n, g) => n + g.sessions, 0),
    running: groups.reduce((n, g) => n + g.running, 0),
    helpers: groups.reduce((n, g) => n + g.helpers, 0),
    projects: new Set(groups.flatMap((g) => g.projects.map((p) => `${g.computer}\u0000${p.project}`))).size,
  };
}

// "3 running · 2 projects · 1 computer": the one line both windows lead with.
export function headline(o) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const computers = o.computers.filter((c) => c.sessions || c.local).length;
  const parts = [o.running ? `${o.running} running` : 'Nothing running', n(o.sessions, 'session', 'sessions'), n(o.projects, 'project', 'projects')];
  if (computers > 1) parts.push(n(computers, 'computer', 'computers'));
  return parts.join(' · ');
}

// ---- icons ------------------------------------------------------------------
// Small line icons for counts, so the numbers read at a glance with few words.
// Every badge carries its words too, as a tooltip and for screen readers.

const PATHS = {
  running: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.6v6.8l5.6-3.4z" fill="currentColor" stroke="none"/>',
  session: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l2.5 2.2-2.5 2.2M12 15h4"/>',
  live: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  helper: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/>',
  project: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  computer: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  branch: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="8" r="2.2"/><path d="M7 8.2v7.6M17 10.2c0 3.5-4 3.2-8.6 6.4"/>',
  agent: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4.5V8M9.5 12.5h.01M14.5 12.5h.01" stroke-width="2.2"/>',
  check: '<path d="M5 12.5l4.2 4L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  waiting: '<path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-8l-4 3v-3H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.6"/>',
};

export function icon(name) {
  return `<svg class="ico ico-${name}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// An icon and a number, e.g. ▶ 3 for "3 running".
export function badge(name, n, words, { quiet = false } = {}) {
  return `<span class="badge badge-${name}${quiet || !n ? ' quiet' : ''}" title="${escAttr(words)}">${icon(name)}<span aria-hidden="true">${n}</span><span class="visually-hidden">${escAttr(words)}</span></span>`;
}

export const runningBadge = (n) => badge('running', n, `${n} running`);
export const helperBadge = (n) => badge('helper', n, plural(n, 'helper'));

// The overview as a row of badges: running, sessions, projects, computers.
export function headlineBadges(o) {
  const computers = o.computers.filter((c) => c.sessions || c.local).length;
  return [
    badge('running', o.running, `${o.running} running`),
    badge('session', o.sessions, plural(o.sessions, 'session'), { quiet: true }),
    badge('live', o.projects, `${plural(o.projects, 'project')} with sessions`, { quiet: true }),
    computers > 1 ? badge('computer', computers, plural(computers, 'computer'), { quiet: true }) : '',
  ].join('');
}

// A to-do list as pips, one per item: a ring (to do), a half-filled ring
// (doing now) and a ticked square (done): shapes, not just colours. Long
// lists fall back to a thin bar. Counts are enough, so other computers'
// sessions (which share counts only) draw the same way.
export const PIP_LIMIT = 14;
export function todoPips(todos) {
  if (!todos?.total) return '';
  const total = Math.max(0, Math.min(Math.floor(Number(todos.total) || 0), 10_000));
  const done = Math.max(0, Math.min(Math.floor(Number(todos.done) || 0), total));
  const doing = Math.max(0, Math.min(Math.floor(Number(todos.doing) || 0), total - done));
  const words = `To-do list: ${done} of ${total} done${doing ? `, ${doing} in progress` : ''}`;
  const STATES = new Set(['completed', 'in_progress', 'pending']);
  let marks;
  if (total <= PIP_LIMIT) {
    const states = todos.items?.length === total
      ? todos.items.map((t) => (STATES.has(t.status) ? t.status : 'pending'))
      : [...Array(total)].map((_, i) => (i < done ? 'completed' : i < done + doing ? 'in_progress' : 'pending'));
    marks = `<span class="pips">${states.map((st) => `<span class="pip ${st}"></span>`).join('')}</span>`;
  } else {
    // Long lists: a thin bar, with a half ring when something is in progress.
    marks = `<span class="pip-bar"><span style="width:${Math.round((done / total) * 100)}%"></span></span>${doing ? '<span class="pip in_progress"></span>' : ''}`;
  }
  return `<span class="todo-pips" role="img" aria-label="${escAttr(words)}" title="${escAttr(words)}">${marks}<span class="pip-n" aria-hidden="true">${done}/${total}</span></span>`;
}
