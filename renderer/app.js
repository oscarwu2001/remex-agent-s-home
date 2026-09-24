import { buildScene, labelPoint, slotPoint, routeTo, SPAWN, LAYOUT } from './scene.js';
import { Person, bubbleMarkup } from './people.js';
import { demoSnapshot } from './demo.js';

const bridge = window.agentsHome ?? (await import('./preview-bridge.js')).default;
const config = await bridge.config();
const ROOM_NAMES = Object.fromEntries(config.rooms.map((r) => [r.id, r]));

const $ = (id) => document.getElementById(id);
const svg = $('scene');
const peopleLayer = $('people');

// ---- preferences (per-viewer conveniences only) ----------------------------

const prefs = { private: true, names: true, night: matchMedia('(prefers-color-scheme: dark)').matches, demo: false };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('agents-home-prefs') || '{}'));
} catch {
  /* storage unavailable or unreadable: defaults stand */
}
if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;

function savePrefs() {
  try {
    localStorage.setItem('agents-home-prefs', JSON.stringify(prefs));
  } catch {
    /* not persisted this time; the toggle still applies */
  }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.night ? 'night' : 'day';
  document.body.classList.toggle('no-tags', !prefs.names);
  $('opt-private').checked = prefs.private;
  $('opt-names').checked = prefs.names;
  $('opt-night').checked = prefs.night;
  $('opt-demo').checked = prefs.demo;
}

for (const [id, key] of [['opt-private', 'private'], ['opt-names', 'names'], ['opt-night', 'night'], ['opt-demo', 'demo']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.checked;
    if (key === 'demo') demoEpoch = Date.now();
    savePrefs();
    applyPrefs();
    render(true);
  });
}

// ---- scene -----------------------------------------------------------------

const { defs, geometry } = buildScene();
$('defs').innerHTML = `${defs}
  <linearGradient id="mist-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--mist)" stop-opacity="0"/>
    <stop offset="1" stop-color="var(--mist)" stop-opacity="1"/>
  </linearGradient>`;
$('geometry').innerHTML = geometry;
// Frame whatever was drawn, with room for labels and bubbles.
const bounds = (() => {
  const b = $('geometry').getBBox();
  const pad = 36;
  return { x: b.x - pad, y: b.y - pad * 2, w: b.width + pad * 2, h: b.height + pad * 3 };
})();
svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
$('mist').innerHTML = `<rect x="${bounds.x}" y="${bounds.y + bounds.h * 0.84}" width="${bounds.w}" height="${bounds.h * 0.16 + 2}" fill="url(#mist-grad)"/>`;
$('clouds').innerHTML = [
  [bounds.x + bounds.w * 0.12, bounds.y + bounds.h * 0.16, 1],
  [bounds.x + bounds.w * 0.78, bounds.y + bounds.h * 0.1, 1.3],
  [bounds.x + bounds.w * 0.86, bounds.y + bounds.h * 0.55, 0.9],
  [bounds.x + bounds.w * 0.06, bounds.y + bounds.h * 0.62, 0.8],
]
  .map(([x, y, k]) => `<g transform="translate(${x} ${y}) scale(${k})"><g class="float">
      <ellipse class="cloud" cx="0" cy="0" rx="70" ry="16"/><ellipse class="cloud" cx="-18" cy="-12" rx="30" ry="16"/>
      <ellipse class="cloud" cx="16" cy="-16" rx="34" ry="20"/></g></g>`)
  .join('');

$('labels').innerHTML = config.rooms
  .filter((r) => LAYOUT[r.id])
  .map((r) => {
    const [x, y] = labelPoint(r.id);
    const w = Math.max(r.name.length * 12.5, r.purpose.length * 8) + 28;
    return `<g class="room-label" transform="translate(${x} ${y + 28})">
      <rect x="${-w / 2}" y="-20" width="${w}" height="46" rx="12"/>
      <text class="name" text-anchor="middle" y="1">${escapeXml(r.name)}</text>
      <text class="purpose" text-anchor="middle" y="19">${escapeXml(r.purpose)}</text></g>`;
  })
  .join('');

// ---- people ----------------------------------------------------------------

const people = new Map(); // key -> Person
const seats = new Map(); // roomId -> [key | undefined]
let selected;

function takeSeat(roomId, key) {
  const list = seats.get(roomId) || [];
  seats.set(roomId, list);
  let i = list.findIndex((k) => k === undefined);
  if (i === -1) i = list.push(undefined) - 1;
  list[i] = key;
  return i;
}

function freeSeat(roomId, key) {
  const list = seats.get(roomId) || [];
  const i = list.indexOf(key);
  if (i !== -1) list[i] = undefined;
}

function select(key) {
  selected = selected === key ? undefined : key;
  for (const [k, p] of people) p.el.classList.toggle('selected', k === selected);
  render(true);
}

svg.addEventListener('click', (e) => {
  if (!e.target.closest('.person') && selected) select(selected);
});

function syncPeople(snapshot) {
  const wanted = new Map();
  for (const s of snapshot.sessions) {
    wanted.set(`s:${s.id}`, { kind: 'session', room: 'nurses-station', data: s, name: s.project });
    for (const a of s.agents) wanted.set(`a:${a.id}`, { kind: 'agent', room: a.room, data: a, name: a.type });
  }

  for (const [key, w] of wanted) {
    let p = people.get(key);
    if (!p) {
      const seat = takeSeat(w.room, key);
      const home = slotPoint(w.room, seat);
      p = new Person({
        id: key,
        roomId: w.room,
        layer: peopleLayer,
        at: w.kind === 'session' ? home : SPAWN,
        onSelect: select,
      });
      p.seat = home;
      if (w.kind === 'agent') p.walk([...routeTo(w.room), home]);
      people.set(key, p);
    }
    p.setStatus(glyphKey(w.data));
    p.setLabel(w.name, statusText(w.data));
    p.el.classList.toggle('selected', key === selected);
    if (w.kind === 'agent' && w.data.status === 'done' && !p.leaving) {
      freeSeat(p.roomId, key);
      p.leave([...routeTo(p.roomId).reverse(), SPAWN]);
    }
  }

  for (const [key, p] of people) {
    if (!wanted.has(key) && !p.leaving) {
      freeSeat(p.roomId, key);
      p.leave(key.startsWith('a:') ? [...routeTo(p.roomId).reverse()] : []);
    }
  }
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let last = performance.now();
function frame(nowMs) {
  const dt = Math.min(0.1, (nowMs - last) / 1000);
  last = nowMs;
  const t = nowMs / 1000;
  for (const [key, p] of people) {
    p.step(dt, t, reducedMotion.matches);
    if (p.gone) {
      p.remove();
      people.delete(key);
      if (selected === key) selected = undefined;
    }
  }
  // Nearer figures paint over farther ones.
  const order = [...people.values()].sort((a, b) => a.depth() - b.depth());
  let prev = null;
  for (const p of order) {
    if (p.el.previousSibling !== prev) peopleLayer.insertBefore(p.el, prev ? prev.nextSibling : peopleLayer.firstChild);
    prev = p.el;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- words -----------------------------------------------------------------

// Distinct words lead each status, so they can be told apart at a glance.
function statusText(x) {
  switch (x.status) {
    case 'working': return x.activity ? x.activity.label : 'Working';
    case 'delegating': return x.activity ? x.activity.label.replace('Consulting', 'With') : 'With a helper';
    case 'blocked': return 'Needs approval, or a long tool is running';
    case 'thinking': return 'Thinking';
    case 'reporting': return 'Writing up findings';
    case 'your-turn': return 'Your turn';
    case 'done':
      if (x.endReason === 'interrupted') return 'Stopped';
      if (x.endReason === 'error') return 'Failed';
      if (x.endReason === 'went quiet') return 'Presumed finished (went quiet)';
      return 'Finished';
    default: return 'Idle';
  }
}

// A finished helper's glyph says how it finished, not just that it did.
function glyphKey(x) {
  if (x.status !== 'done') return x.status;
  return { error: 'failed', interrupted: 'stopped', 'went quiet': 'quiet' }[x.endReason] ?? 'done';
}

function elapsed(fromMs, nowMs) {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function clock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function glyph(x) {
  return `<svg class="glyph" viewBox="-16 -16 32 32" aria-hidden="true">${bubbleMarkup(glyphKey(x))}</svg>`;
}

function roomName(id) {
  return ROOM_NAMES[id]?.name ?? id;
}

// ---- board -----------------------------------------------------------------

let snapshot = { sessions: [], stats: {}, watcher: { roots: [] }, roster: [], problems: [] };
let liveSnapshot = snapshot;
let demoEpoch = Date.now();
let lastSignature = '';

bridge.onSnapshot?.((s) => {
  liveSnapshot = s;
});

function rowHtml(key, x, name, sub) {
  const what = statusText(x);
  const detail = !prefs.private && x.activity?.detail ? ` · ${x.activity.detail}` : '';
  const warn = x.status === 'blocked' || x.status === 'your-turn' || glyphKey(x) === 'failed';
  const where = sub ? ` in the ${roomName(x.room)}` : '';
  return `<button class="row${sub ? ' sub' : ''}" data-key="${escapeXml(key)}" aria-pressed="${key === selected}"
      title="${escapeXml(`${name}${where}: ${what}${detail}`)}">
      ${glyph(x)}
      <span class="who"><span class="name">${escapeXml(name)}</span>
        <span class="what${warn ? ' warn' : ''}">${escapeXml(what + detail)}</span></span>
      <span class="time" data-since="${x.startedAt}">${elapsed(x.startedAt, Date.now())}</span>
    </button>`;
}

function renderSessions(s) {
  if (!s.sessions.length) {
    const watching = s.watcher.roots.find((r) => r.state === 'ok');
    return `<p class="empty">Nobody is on shift. Agents appear here within a second of a Claude Code
      session writing to its transcript${watching ? '' : ' (no transcript folder found yet)'}.
      Start <code>claude</code> in a terminal, or look around with the demo.</p>
      <button class="button" id="start-demo" type="button">Show demo patients</button>`;
  }
  return s.sessions
    .map((sess) => {
      const helpers = sess.agents
        .map((a) => rowHtml(`a:${a.id}`, a, a.type, true))
        .join('');
      return `<div class="card">${rowHtml(`s:${sess.id}`, sess, sess.project, false)}${helpers}</div>`;
    })
    .join('');
}

function findSelected(s) {
  for (const sess of s.sessions) {
    if (`s:${sess.id}` === selected) return { x: sess, name: sess.project, room: 'nurses-station' };
    for (const a of sess.agents) if (`a:${a.id}` === selected) return { x: a, name: a.type, room: a.room, parent: sess.project };
  }
  return null;
}

function renderChart(s) {
  const found = findSelected(s);
  if (!found) return null;
  const { x, name, room, parent } = found;
  const rows = [
    ['Name', name],
    ['Room', roomName(room)],
    ['Status', statusText(x)],
    parent ? ['Called by', parent] : null,
    !prefs.private && x.description ? ['Task', x.description] : null,
    x.background ? ['Mode', 'Background'] : null,
    ['On shift since', clock(x.startedAt)],
    x.errors ? ['Tool errors', String(x.errors)] : null,
  ].filter(Boolean);
  const history = [...x.history].reverse()
    .map((h) => `<li><span class="t">${clock(h.ts)}</span>
        <span>${escapeXml(h.label)}${!prefs.private && h.detail ? `<span class="d"> · ${escapeXml(h.detail)}</span>` : ''}</span></li>`)
    .join('');
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeXml(v)}</dd>`).join('')}</dl>
    <ol aria-label="Recent activity">${history || '<li><span class="t">—</span><span>No tool calls yet</span></li>'}</ol>`;
}

function renderCensus(s) {
  const n = s.sessions.length;
  const helpers = s.sessions.reduce((k, x) => k + x.agents.filter((a) => a.status !== 'done').length, 0);
  const waiting = s.sessions.filter((x) => x.status === 'your-turn').length;
  const blocked = s.sessions.reduce((k, x) => k + (x.status === 'blocked') + x.agents.filter((a) => a.status === 'blocked').length, 0);
  const parts = [`${n} session${n === 1 ? '' : 's'}`, `${helpers} helper${helpers === 1 ? '' : 's'} at work`];
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (blocked) parts.push(`${blocked} may need approval`);
  return (s.demo ? 'Demo · ' : '') + parts.join(' · ');
}

// Folder paths carry the user name, so they only show with privacy off.
function renderSource(s) {
  if (s.demo) return 'Showing demo patients. Turn off “Demo patients” to see your own sessions.';
  const roots = s.watcher.roots;
  if (!roots.length) return 'Connecting…';
  const where = (list) => (prefs.private ? 'your Claude Code transcripts folder' : list.map((r) => r.path).join(', '));
  const ok = roots.filter((r) => r.state === 'ok');
  const n = s.watcher.filesTailed;
  if (ok.length) return `Watching ${where(ok)} · ${n} transcript${n === 1 ? '' : 's'} open`;
  if (roots.every((r) => r.state === 'missing')) {
    return `No transcripts yet in ${where(roots)}. They appear after your first Claude Code session.`;
  }
  return `Cannot read ${where(roots)}. See “Needs attention”.`;
}

// Each problem: a label that is safe on a shared screen, and a detail
// (paths, file names) that shows only with privacy off.
function renderProblems(s) {
  const plural = (n, one, many) => (n === 1 ? one : many);
  const list = (s.problems || []).map((p) => ({
    label: p.count > 1 ? `${p.label} (×${p.count})` : p.label,
    detail: p.detail,
  }));
  for (const r of s.watcher.roots || []) {
    if (r.state !== 'ok' && r.state !== 'missing' && r.state !== 'pending') {
      list.push({ label: `A transcripts folder is ${r.state}`, detail: r.path });
    }
  }
  const st = s.stats;
  if (st.malformedLines) {
    list.push({
      label: `${st.malformedLines} transcript ${plural(st.malformedLines, 'line', 'lines')} could not be read`,
      detail: st.lastProblem ? `last: ${st.lastProblem}` : '',
    });
  }
  if (st.unlinkedSidechains) {
    const n = st.unlinkedSidechains;
    list.push({ label: `${n} helper ${plural(n, 'transcript', 'transcripts')} could not be matched to the call that started ${plural(n, 'it', 'them')}, so ${plural(n, 'it is', 'they are')} not shown` });
  }
  if (st.unmatchedRelays) {
    const n = st.unmatchedRelays;
    list.push({ label: `${n} relayed helper ${plural(n, 'update', 'updates')} named a call that is not in view, so ${plural(n, 'it is', 'they are')} not shown` });
  }
  if (st.untimedEntries) {
    list.push({ label: `${st.untimedEntries} transcript ${plural(st.untimedEntries, 'entry has', 'entries have')} no timestamp and did not count as activity` });
  }
  return list;
}

function renderDirectory(s) {
  const roster = s.roster || [];
  $('directory-count').textContent = roster.length ? `(${roster.length})` : '';
  $('directory-list').innerHTML = roster.length
    ? roster.map((a) => `<li><span class="agent">${escapeXml(a.name)}</span> · <span class="room">${escapeXml(roomName(a.room))}</span>
        <span class="summary">${escapeXml(a.summary || '')}</span></li>`).join('')
    : `<li>No agent definitions found. Agents you add to <code>.claude/agents</code> are listed here with the room they work in.</li>`;
}

function render(force = false) {
  snapshot = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : liveSnapshot;
  syncPeople(snapshot);

  const chart = renderChart(snapshot);
  const problems = renderProblems(snapshot);
  const signature = JSON.stringify([
    snapshot.sessions.map((x) => [x.id, x.status, x.activity?.label, x.activity?.detail,
      x.agents.map((a) => [a.id, a.status, a.activity?.label, a.activity?.detail])]),
    chart, problems, (snapshot.roster || []).length, selected, prefs.private,
  ]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  // Re-render, then put keyboard focus back where it was.
  const focusKey = document.activeElement?.dataset?.key;
  $('sessions').innerHTML = renderSessions(snapshot);
  $('census').textContent = renderCensus(snapshot);
  $('source').textContent = renderSource(snapshot);
  $('chart').hidden = !chart;
  if (chart) $('chart-body').innerHTML = chart;
  $('problems').hidden = problems.length === 0;
  $('problem-list').innerHTML = problems
    .map((p) => `<li>${escapeXml(p.label)}${!prefs.private && p.detail ? `<span class="d"> · ${escapeXml(p.detail)}</span>` : ''}</li>`)
    .join('');
  renderDirectory(snapshot);
  if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

$('sessions').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) select(row.dataset.key);
  if (e.target.id === 'start-demo') {
    prefs.demo = true;
    demoEpoch = Date.now();
    savePrefs();
    applyPrefs();
    render(true);
  }
});

// Elapsed timers tick every second without a re-render.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = elapsed(Number(el.dataset.since), now);
}, 1000);

applyPrefs();
render(true);
setInterval(render, 250);
