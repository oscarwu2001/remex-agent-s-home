import {
  buildScene, labelPoint, slotPoint, routeTo, SPAWN, LAYOUT, floorOutline, roomFrame, configureRooms, cellOutline,
} from './scene.js';
import { setView, getView } from './iso.js';
import { Person, bubbleMarkup } from './people.js';
import { demoSnapshot } from './demo.js';
import { THEMES, DEFAULT_THEME, themeFor } from './themes.js';

const bridge = window.agentsHome ?? (await import('./preview-bridge.js')).default;
let config = await bridge.config();
let ROOM_NAMES = {};
function useConfig(next) {
  config = next;
  ROOM_NAMES = Object.fromEntries(config.rooms.map((r) => [r.id, r]));
  configureRooms(config.rooms);
}
useConfig(config);

// Layout editing state (see "hospital layout" below).
let buildMode = false;
let draft; // { cell, kind, name, agents: Set }
let layoutError = '';

const $ = (id) => document.getElementById(id);
const svg = $('scene');
const peopleLayer = $('people');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- preferences (per-viewer conveniences only) ----------------------------

const prefs = { private: true, names: true, theme: DEFAULT_THEME, night: false, view: 0, demo: false };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('agents-home-prefs') || '{}'));
} catch {
  /* storage unavailable or unreadable: defaults stand */
}
if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;
if (!THEMES[prefs.theme]) prefs.theme = DEFAULT_THEME; // e.g. the retired night mode

function savePrefs() {
  try {
    localStorage.setItem('agents-home-prefs', JSON.stringify(prefs));
  } catch {
    /* not persisted this time; the toggle still applies */
  }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.time = prefs.night ? 'night' : 'day';
  document.body.classList.toggle('no-tags', !prefs.names);
  $('opt-private').checked = prefs.private;
  $('opt-names').checked = prefs.names;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === prefs.theme;
  $('opt-demo').checked = prefs.demo;
  $('opt-night').checked = prefs.night;
}

for (const [id, key] of [['opt-private', 'private'], ['opt-names', 'names'], ['opt-demo', 'demo'], ['opt-night', 'night']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.checked;
    if (key === 'demo') demoEpoch = Date.now();
    savePrefs();
    applyPrefs();
    if (key === 'night') drawScene();
    render(true);
  });
}

// ---- scene -----------------------------------------------------------------

// Redrawn when the colourway, day/night or the view turn changes; the rooms
// themselves never move.
function drawScene() {
  const { defs, geometry } = buildScene(themeFor(prefs.theme, prefs.night));
  $('defs').innerHTML = `${defs}
    <linearGradient id="mist-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--mist)" stop-opacity="0"/>
      <stop offset="1" stop-color="var(--mist)" stop-opacity="1"/>
    </linearGradient>`;
  $('geometry').innerHTML = geometry;
  overview = frameOf($('geometry').getBBox());
  drawBackdrop();
  drawLabels();
  placeLabels();
}

function frameOf(b) {
  const pad = 36;
  return { x: b.x - pad, y: b.y - pad * 2, w: b.width + pad * 2, h: b.height + pad * 3 };
}

// Sky furniture sits in overview space so it stays put while you zoom.
function drawBackdrop() {
  const o = overview;
  $('mist').innerHTML = `<rect x="${o.x - o.w}" y="${o.y + o.h * 0.84}" width="${o.w * 3}" height="${o.h}" fill="url(#mist-grad)"/>`;
  const clouds = [[0.12, 0.16, 1], [0.78, 0.1, 1.3], [0.86, 0.55, 0.9], [0.06, 0.62, 0.8]]
    .map(([fx, fy, k]) => `<g transform="translate(${o.x + o.w * fx} ${o.y + o.h * fy}) scale(${k})"><g class="float">
      <ellipse class="cloud" cx="0" cy="0" rx="70" ry="16"/><ellipse class="cloud" cx="-18" cy="-12" rx="30" ry="16"/>
      <ellipse class="cloud" cx="16" cy="-16" rx="34" ry="20"/></g></g>`)
    .join('');
  // Stars only come out at night; a fixed pseudo-random field, not Math.random,
  // so they do not jump on every redraw.
  let stars = '';
  if (prefs.night) {
    for (let i = 0; i < 70; i++) {
      const fx = ((i * 73) % 97) / 97;
      const fy = ((i * 41) % 89) / 89 * 0.6;
      const r = 0.8 + ((i * 29) % 7) / 5;
      stars += `<circle class="star s${i % 3}" cx="${(o.x + o.w * fx).toFixed(1)}" cy="${(o.y + o.h * fy).toFixed(1)}" r="${r.toFixed(1)}"/>`;
    }
  }
  // A cute tiny sun by day, a crescent moon by night, high in one corner.
  const [cx, cy] = [o.x + o.w * 0.9, o.y + o.h * 0.13];
  const sky = prefs.night
    ? `<g class="moon" transform="translate(${cx} ${cy})">
        <circle r="30" class="moon-glow"/>
        <path d="M6,-20 A20,20 0 1 0 20,6 A15,15 0 1 1 6,-20 Z" class="moon-face"/>
      </g>`
    : `<g transform="translate(${cx} ${cy})"><g class="sun">
        <circle r="34" class="sun-glow"/>
        <g class="sun-rays">${Array.from({ length: 8 }, (_, i) => `<rect x="-2.5" y="-31" width="5" height="9" rx="2.5" transform="rotate(${i * 45})"/>`).join('')}</g>
        <circle r="17" class="sun-face"/>
        <path d="M-8,-2 q2.5,-3 5,0 M3,-2 q2.5,-3 5,0" class="sun-eyes"/>
        <path d="M-4,5 q4,4 8,0" class="sun-eyes"/>
        <circle cx="-10" cy="4" r="2.6" class="sun-blush"/><circle cx="10" cy="4" r="2.6" class="sun-blush"/>
      </g></g>`;
  $('clouds').innerHTML = sky + stars + clouds;
}

// Room signs and floor click targets: both open that room. In build mode,
// the free spots next to the hospital show as "+" tiles.
function drawLabels() {
  const build = buildMode
    ? config.openCells.map((cell) => {
      const pts = cellOutline(cell);
      const [cx, cy] = pts.reduce(([a, b], [x, y]) => [a + x / 4, b + y / 4], [0, 0]);
      const chosen = draft && draft.cell[0] === cell[0] && draft.cell[1] === cell[1];
      return `<g class="build-cell${chosen ? ' chosen' : ''}" data-cell="${cell.join(',')}" role="button" tabindex="0"
          aria-label="Build a department here">
        <polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>
        <path d="M${cx - 12},${cy} H${cx + 12} M${cx},${cy - 12} V${cy + 12}"/></g>`;
    }).join('')
    : '';
  $('labels').innerHTML = build + config.rooms
    .filter((r) => LAYOUT[r.id])
    .map((r) => {
      const floorPts = floorOutline(r.id).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
      return `<polygon class="room-hit" data-room="${r.id}" points="${floorPts}"/>`;
    })
    .join('') + config.rooms
    .filter((r) => LAYOUT[r.id])
    .map((r) => {
      const [x, y] = labelPoint(r.id);
      const w = Math.max(r.name.length * 12.5, r.purpose.length * 8) + 28;
      return `<g class="room-label" data-room="${r.id}" role="button" tabindex="0"
          aria-label="Visit the ${escapeXml(r.name)}" data-x="${x.toFixed(1)}" data-y="${(y + 28).toFixed(1)}">
        <rect x="${-w / 2}" y="-20" width="${w}" height="46" rx="12"/>
        <text class="name" text-anchor="middle" y="1">${escapeXml(r.name)}</text>
        <text class="purpose" text-anchor="middle" y="19">${escapeXml(r.purpose)}</text></g>`;
    })
    .join('');
}

// ---- camera: zoom, pan, visit a room, turn the tower ------------------------

let overview;
let focusedRoom;
const cam = { x: 0, y: 0, w: 1, h: 1 };
let tween;

function setViewBox(b) {
  Object.assign(cam, b);
  svg.setAttribute('viewBox', `${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)}`);
  placeLabels();
}

// Room signs keep the same size on screen at any zoom. Inside a room only
// its own sign shows.
function placeLabels() {
  const k = cam.w > 1 ? Math.min(1, cam.w / overview.w) : 1;
  for (const g of document.querySelectorAll('.room-label')) {
    g.setAttribute('transform', `translate(${g.dataset.x} ${g.dataset.y}) scale(${k.toFixed(3)})`);
    g.classList.toggle('hidden', Boolean(focusedRoom) && g.dataset.room !== focusedRoom);
  }
}

function flyTo(target, ms = 450) {
  if (reducedMotion.matches) ms = 0;
  const from = { ...cam };
  const start = performance.now();
  cancelAnimationFrame(tween);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const stepTo = (now) => {
    const t = ms ? Math.min(1, (now - start) / ms) : 1;
    const k = ease(t);
    setViewBox({
      x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k,
      w: from.w + (target.w - from.w) * k, h: from.h + (target.h - from.h) * k,
    });
    if (t < 1) tween = requestAnimationFrame(stepTo);
  };
  tween = requestAnimationFrame(stepTo);
}

function visitRoom(id) {
  focusedRoom = id;
  placeLabels();
  const f = roomFrame(id);
  const pad = 0.4;
  flyTo({ x: f.x - f.w * pad, y: f.y - f.h * pad, w: f.w * (1 + 2 * pad), h: f.h * (1 + 2 * pad) });
  updateCameraUi();
}

function showOverview() {
  focusedRoom = undefined;
  placeLabels();
  flyTo(overview);
  updateCameraUi();
}

function turnView(step) {
  setView(getView() + step);
  prefs.view = getView();
  savePrefs();
  svg.classList.add('turning');
  drawScene();
  requestAnimationFrame(() => svg.classList.remove('turning'));
  if (focusedRoom) visitRoom(focusedRoom);
  else setViewBox(overview);
}

function updateCameraUi() {
  const zoomed = focusedRoom || cam.w < overview.w * 0.95;
  $('cam-overview').disabled = !zoomed;
  $('cam-where').textContent = focusedRoom ? `In the ${ROOM_NAMES[focusedRoom]?.name ?? ''}` : zoomed ? 'Zoomed in' : '';
  $('cam-where').hidden = !zoomed;
}

// Wheel zooms about the pointer; drag pans. A drag never counts as a click.
function toSvgPoint(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  const scale = Math.max(cam.w / r.width, cam.h / r.height);
  const ox = cam.x + (cam.w - r.width * scale) / 2;
  const oy = cam.y + (cam.h - r.height * scale) / 2;
  return [ox + (clientX - r.left) * scale, oy + (clientY - r.top) * scale, scale];
}

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  cancelAnimationFrame(tween);
  const [px, py] = toSvgPoint(e.clientX, e.clientY);
  const k = Math.exp(e.deltaY * 0.0015);
  const w = Math.min(overview.w * 1.4, Math.max(overview.w * 0.12, cam.w * k));
  const f = w / cam.w;
  setViewBox({ x: px - (px - cam.x) * f, y: py - (py - cam.y) * f, w, h: cam.h * f });
  focusedRoom = undefined;
  updateCameraUi();
}, { passive: false });

let drag;
svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) svg.setPointerCapture?.(e.pointerId);
  drag.moved = true;
  svg.classList.add('dragging');
  const [, , scale] = toSvgPoint(0, 0);
  cancelAnimationFrame(tween);
  setViewBox({ ...drag.cam, x: drag.cam.x - dx * scale, y: drag.cam.y - dy * scale });
  focusedRoom = undefined;
  updateCameraUi();
});
window.addEventListener('pointerup', () => {
  svg.classList.remove('dragging');
  // Let the click that follows this pointerup see whether it was a drag.
  setTimeout(() => { drag = undefined; }, 0);
});

$('cam-left').addEventListener('click', () => turnView(-1));
$('cam-right').addEventListener('click', () => turnView(1));
$('cam-overview').addEventListener('click', showOverview);
$('labels').addEventListener('keydown', (e) => {
  const cell = e.target.closest('[data-cell]');
  if (cell && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    chooseCell(cell.dataset.cell.split(',').map(Number));
    return;
  }
  const label = e.target.closest('.room-label');
  if (label && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    visitRoom(label.dataset.room);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, button, .row, .person, .room-label')) return;
  if (e.key === 'q' || e.key === 'Q') turnView(-1);
  else if (e.key === 'e' || e.key === 'E') turnView(1);
  else if (e.key === 'Escape') showOverview();
});

setView(prefs.view ?? 0);
drawScene();
setViewBox(overview);
updateCameraUi();

for (const radio of document.querySelectorAll('input[name="theme"]')) {
  radio.addEventListener('change', () => {
    prefs.theme = radio.value;
    savePrefs();
    applyPrefs();
    drawScene();
  });
}

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
  if (drag?.moved) return;
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    chooseCell(cell.dataset.cell.split(',').map(Number));
    return;
  }
  const room = e.target.closest('[data-room]');
  if (room && !e.target.closest('.person')) {
    visitRoom(room.dataset.room);
    return;
  }
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
    p.setActivity(w.data.activity?.kind);
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

// ---- hospital layout: add and remove departments ----------------------------

function knownAgentNames() {
  const names = new Set((snapshot.roster || []).map((a) => a.name));
  for (const sess of snapshot.sessions) for (const a of sess.agents) names.add(a.type);
  for (const d of config.layout.departments) for (const a of d.agents) names.add(a);
  if (draft) for (const a of draft.agents) names.add(a);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function chooseCell(cell) {
  draft = { cell, kind: config.departmentKinds[0].kind, name: '', agents: new Set() };
  layoutError = '';
  drawLabels();
  placeLabels();
  renderLayoutEditor();
  $('dept-kind')?.focus();
}

function setBuildMode(on) {
  buildMode = on;
  if (!on) draft = undefined;
  layoutError = '';
  drawLabels();
  placeLabels();
  renderLayoutEditor();
  if (on && !focusedRoom) showOverview();
}

async function saveLayout(departments) {
  const plain = departments.map(({ kind, name, purpose, cell, agents }) => ({ kind, name, purpose, cell, agents: [...agents] }));
  const result = await bridge.saveLayout({ departments: plain });
  if (!result.ok) {
    layoutError = result.error;
    renderLayoutEditor();
    return false;
  }
  useConfig(result.config);
  drawScene();
  setViewBox(overview);
  return true;
}

function renderLayoutEditor() {
  const depts = config.layout.departments;
  $('layout-count').textContent = depts.length ? `(${depts.length})` : '';
  const needed = new Set(depts.map((d) => d.via));
  const list = depts.length
    ? `<ul class="dept-list">${depts.map((d) => `<li>
        <span class="agent">${escapeXml(d.name)}</span>
        <span class="summary">${escapeXml(d.purpose)}${d.agents.length ? ` · ${escapeXml(d.agents.join(', '))}` : ' · no agents yet'}</span>
        <button type="button" class="link-btn" data-remove="${escapeXml(d.id)}" ${needed.has(d.id) ? 'disabled title="Another department is reached through this one"' : ''}>Remove</button>
      </li>`).join('')}</ul>`
    : '<p class="empty">Only the core hospital so far. Add a department for each specialty your agents serve.</p>';

  let form = '';
  if (buildMode && !draft) {
    form = `<p class="hint">Choose a “+” spot next to the hospital. ${config.openCells.length} ${config.openCells.length === 1 ? 'spot is' : 'spots are'} free.</p>`;
  } else if (draft) {
    const kinds = config.departmentKinds.map((k) => `<option value="${k.kind}" ${k.kind === draft.kind ? 'selected' : ''}>${escapeXml(k.name)}</option>`).join('');
    const agents = knownAgentNames().map((a) => `<label class="check"><input type="checkbox" value="${escapeXml(a)}" ${draft.agents.has(a) ? 'checked' : ''}> ${escapeXml(a)}</label>`).join('');
    form = `<form class="dept-form" id="dept-form">
      <label class="field">Department
        <select id="dept-kind">${kinds}</select></label>
      <label class="field" ${draft.kind === 'custom' ? '' : 'hidden'}>Name
        <input id="dept-name" maxlength="40" placeholder="e.g. Hand Surgery" value="${escapeXml(draft.name)}"></label>
      <fieldset class="field"><legend>Agents who work here</legend>
        <div class="checks">${agents || '<span class="muted">No agents seen yet.</span>'}</div>
        <input id="dept-agent-new" placeholder="Add an agent by name, e.g. spine-planner">
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="button">Build department</button>
        <button type="button" class="link-btn" id="dept-cancel">Cancel</button>
      </div>
    </form>`;
  }
  $('layout-body').innerHTML = `${list}
    ${layoutError ? `<p class="form-error" role="alert">${escapeXml(layoutError)}</p>` : ''}
    ${form}
    ${buildMode ? '' : `<button type="button" class="button" id="build-start" ${config.openCells.length ? '' : 'disabled'}>Add a department</button>`}
    ${buildMode && !draft ? '<button type="button" class="link-btn" id="build-stop">Done</button>' : ''}`;
}

$('layout-body').addEventListener('click', async (e) => {
  if (e.target.id === 'build-start') setBuildMode(true);
  else if (e.target.id === 'build-stop' || e.target.id === 'dept-cancel') setBuildMode(false);
  else if (e.target.dataset.remove) {
    const keep = config.layout.departments.filter((d) => d.id !== e.target.dataset.remove);
    if (await saveLayout(keep.map((d) => ({ ...d, agents: new Set(d.agents) })))) renderLayoutEditor();
  }
});

$('layout-body').addEventListener('change', (e) => {
  if (!draft) return;
  if (e.target.id === 'dept-kind') {
    draft.kind = e.target.value;
    renderLayoutEditor();
    if (draft.kind === 'custom') $('dept-name')?.focus();
  } else if (e.target.id === 'dept-name') {
    draft.name = e.target.value;
  } else if (e.target.type === 'checkbox') {
    if (e.target.checked) draft.agents.add(e.target.value);
    else draft.agents.delete(e.target.value);
  }
});

$('layout-body').addEventListener('keydown', (e) => {
  if (e.target.id === 'dept-agent-new' && e.key === 'Enter') {
    e.preventDefault();
    const name = e.target.value.trim();
    if (name) {
      draft.agents.add(name);
      renderLayoutEditor();
      $('dept-agent-new')?.focus();
    }
  }
});

$('layout-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!draft) return;
  draft.name = $('dept-name')?.value ?? draft.name;
  const extra = $('dept-agent-new')?.value.trim();
  if (extra) draft.agents.add(extra);
  if (draft.kind === 'custom' && !draft.name.trim()) {
    layoutError = 'Give your department a name.';
    renderLayoutEditor();
    $('dept-name')?.focus();
    return;
  }
  const existing = config.layout.departments.map((d) => ({ ...d, agents: new Set(d.agents) }));
  const added = { kind: draft.kind, name: draft.kind === 'custom' ? draft.name.trim() : undefined, cell: draft.cell, agents: draft.agents };
  if (await saveLayout([...existing, added])) setBuildMode(false);
});

renderLayoutEditor();

applyPrefs();
render(true);
setInterval(render, 250);
