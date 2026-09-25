import {
  buildScene, labelPoint, slotPoint, routeTo, spawnPoint, LAYOUT, targetHeights, setHeights, workSpot, routeBetween, floorOutline, roomFrame, configureRooms, cellOutline,
  decorSpots, gardenTile, gardenOutline, gardenFrame,
} from './scene.js';
import { P } from './iso.js';
import { setView } from './iso.js';
import { Person, bubbleMarkup } from './people.js';
import { demoSnapshot } from './demo.js';
import { THEMES, DEFAULT_THEME, themeFor, PHASES, phaseAt } from './themes.js';

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

// Decorating state (see "decorating" below).
let decorating = false; // the panel is open for the room or garden being visited
let plantTool = 'tulips'; // what a click on a garden tile plants, or 'remove'
let benchTurn = false;
let decorError = '';
let decorNote = ''; // what the last change did, read out to screen readers

const $ = (id) => document.getElementById(id);
const svg = $('scene');
const peopleLayer = $('people');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- preferences (per-viewer conveniences only) ----------------------------

// time: 'auto' follows the computer's clock, or a fixed part of the day.
const prefs = { private: true, names: true, theme: DEFAULT_THEME, time: 'auto', detail: 'simple', weather: 'clear', view: 0, demo: false };
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem('agents-home-prefs') || '{}');
  Object.assign(prefs, saved);
} catch {
  /* storage unavailable or unreadable: defaults stand */
}
if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;
if (!THEMES[prefs.theme]) prefs.theme = DEFAULT_THEME; // e.g. the retired night mode
if (prefs.detail !== 'simple' && prefs.detail !== 'detailed') prefs.detail = 'simple';
if ('night' in prefs) {
  // The old Night switch becomes a fixed night; otherwise follow the clock.
  if (prefs.night && saved.time === undefined) prefs.time = 'night';
  delete prefs.night;
}
if (prefs.time !== 'auto' && !PHASES.some((p) => p.id === prefs.time)) prefs.time = 'auto';
const WEATHERS = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', snow: 'Snow', fog: 'Fog' };
if (!WEATHERS[prefs.weather] && prefs.weather !== 'changing') prefs.weather = 'clear';

// The weather being shown. "Changes through the day" picks one for every
// three hours from the date, so it holds steady for a while, is the same on
// every redraw, and needs nothing from outside. Mostly fair; snow only in
// the colder months, rain otherwise.
function weather(date = new Date()) {
  if (prefs.weather !== 'changing') return prefs.weather;
  const block = Math.floor(date.getHours() / 3);
  const seed = (date.getFullYear() * 400 + date.getMonth() * 32 + date.getDate()) * 8 + block;
  const r = ((seed * 2654435761) >>> 0) / 2 ** 32;
  const cold = [10, 11, 0, 1].includes(date.getMonth());
  if (r < 0.45) return 'clear';
  if (r < 0.7) return 'cloudy';
  if (r < 0.85) return cold ? 'snow' : 'rain';
  if (r < 0.93) return 'fog';
  return 'rain';
}

// The part of the day being shown right now.
function phase() {
  return prefs.time === 'auto' ? phaseAt(new Date()) : prefs.time;
}

function savePrefs() {
  try {
    localStorage.setItem('agents-home-prefs', JSON.stringify(prefs));
  } catch {
    /* not persisted this time; the toggle still applies */
  }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.time = phase() === 'night' ? 'night' : 'day';
  document.documentElement.dataset.phase = phase();
  document.documentElement.dataset.weather = weather();
  $('weather').className = `weather ${weather()}`;
  $('opt-weather').value = prefs.weather;
  $('opt-weather').options[5].textContent = `Changes through the day (now: ${WEATHERS[weather(new Date())].toLowerCase()})`;
  document.body.classList.toggle('no-tags', !prefs.names);
  $('opt-private').checked = prefs.private;
  $('opt-names').checked = prefs.names;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === prefs.theme;
  for (const r of document.querySelectorAll('input[name="detail"]')) r.checked = r.value === prefs.detail;
  $('opt-demo').checked = prefs.demo;
  const sel = $('opt-time');
  sel.value = prefs.time;
  sel.options[0].textContent = `Follow my clock (now: ${PHASES.find((p) => p.id === phaseAt(new Date())).name.toLowerCase()})`;
}

for (const [id, key] of [['opt-private', 'private'], ['opt-names', 'names'], ['opt-demo', 'demo']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.checked;
    if (key === 'demo') demoEpoch = Date.now();
    savePrefs();
    applyPrefs();
    render(true);
  });
}

for (const radio of document.querySelectorAll('input[name="detail"]')) {
  radio.addEventListener('change', () => {
    prefs.detail = radio.value;
    savePrefs();
    drawScene();
  });
}

$('opt-weather').addEventListener('change', (e) => {
  prefs.weather = e.target.value;
  savePrefs();
  applyPrefs();
  drawScene();
  showClock();
});

// The time, the part of the day and the weather, bottom right of the map.
// Only the computer's clock is read.
function showClock() {
  const now = new Date();
  const hm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const part = PHASES.find((p) => p.id === phase()).name;
  $('clock').innerHTML = `<span class="now">${escapeXml(hm)}</span>${escapeXml(part)} · ${escapeXml(WEATHERS[weather()])}`;
}
setInterval(showClock, 10_000);

$('opt-time').addEventListener('change', (e) => {
  prefs.time = e.target.value;
  savePrefs();
  applyPrefs();
  drawScene();
});

// Following the clock: look again every minute and redraw when the part of
// the day changes.
let shownPhase;
let shownWeather;
setInterval(() => {
  if (phase() === shownPhase && weather() === shownWeather) return;
  applyPrefs();
  drawScene();
  showClock();
}, 60_000);

// ---- scene -----------------------------------------------------------------

// Redrawn when the colourway, day/night or the view turn changes, and on
// every frame while towers rise and sink after a turn.
function drawGeometry() {
  shownPhase = phase();
  shownWeather = weather();
  const cat = config.decorCatalogue;
  const { defs, geometry } = buildScene(themeFor(prefs.theme, shownPhase), {
    detail: prefs.detail, decor: config.decor, defaultGardens: cat?.defaultGardens, plants: cat?.plants,
  });
  $('defs').innerHTML = `${defs}
    <linearGradient id="mist-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--mist)" stop-opacity="0"/>
      <stop offset="1" stop-color="var(--mist)" stop-opacity="1"/>
    </linearGradient>`;
  $('geometry').innerHTML = geometry;
}

function drawScene() {
  drawGeometry();
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
  const overcast = ['cloudy', 'rain', 'snow'].includes(weather());
  const clouds = [[0.12, 0.16, 1], [0.78, 0.1, 1.3], [0.86, 0.55, 0.9], [0.06, 0.62, 0.8],
    ...(overcast ? [[0.35, 0.06, 1.5], [0.58, 0.14, 1.2], [0.95, 0.3, 1.1], [0.25, 0.4, 0.9], [0.5, 0.02, 1.4]] : [])]
    .map(([fx, fy, k]) => `<g transform="translate(${o.x + o.w * fx} ${o.y + o.h * fy}) scale(${k})"><g class="float">
      <ellipse class="cloud" cx="0" cy="0" rx="70" ry="16"/><ellipse class="cloud" cx="-18" cy="-12" rx="30" ry="16"/>
      <ellipse class="cloud" cx="16" cy="-16" rx="34" ry="20"/></g></g>`)
    .join('');
  // Stars only come out at night; a fixed pseudo-random field, not Math.random,
  // so they do not jump on every redraw.
  let stars = '';
  const night = phase() === 'night';
  if (night) {
    for (let i = 0; i < 70; i++) {
      const fx = ((i * 73) % 97) / 97;
      const fy = ((i * 41) % 89) / 89 * 0.6;
      const r = 0.8 + ((i * 29) % 7) / 5;
      stars += `<circle class="star s${i % 3}" cx="${(o.x + o.w * fx).toFixed(1)}" cy="${(o.y + o.h * fy).toFixed(1)}" r="${r.toFixed(1)}"/>`;
    }
  }
  // A cute tiny sun that crosses the sky through the day and a crescent
  // moon at night, drawn in the sky layer behind the building.
  $('sky-body').innerHTML = night
    ? `<svg viewBox="-48 -48 96 96"><g class="moon">
        <circle r="30" class="moon-glow"/>
        <path d="M6,-20 A20,20 0 1 0 20,6 A15,15 0 1 1 6,-20 Z" class="moon-face"/>
      </g></svg>`
    : `<svg viewBox="-48 -48 96 96"><g class="sun ${phase()}">
        <circle r="34" class="sun-glow"/>
        <g class="sun-rays">${Array.from({ length: 8 }, (_, i) => `<rect x="-2.5" y="-31" width="5" height="9" rx="2.5" transform="rotate(${i * 45})"/>`).join('')}</g>
        <circle r="17" class="sun-face"/>
        <path d="M-8,-2 q2.5,-3 5,0 M3,-2 q2.5,-3 5,0" class="sun-eyes"/>
        <path d="M-4,5 q4,4 8,0" class="sun-eyes"/>
        <circle cx="-10" cy="4" r="2.6" class="sun-blush"/><circle cx="10" cy="4" r="2.6" class="sun-blush"/>
      </g></svg>`;
  $('clouds').innerHTML = stars + clouds;
  // The weather's light, over the building but under the room signs, so
  // the signs keep their contrast. Falling rain and snow are an HTML layer
  // on top, in screen space, so drops stay the same size at any zoom.
  const big = `x="${o.x - o.w}" y="${o.y - o.h}" width="${o.w * 3}" height="${o.h * 3}"`;
  const tint = {
    cloudy: `<rect ${big} fill="#6e6e96" fill-opacity="0.1"/>`,
    rain: `<rect ${big} fill="#3c4673" fill-opacity="0.17"/>`,
    snow: `<rect ${big} fill="#ffffff" fill-opacity="0.08"/>`,
    fog: `<linearGradient id="fog-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity="0.05"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0.62"/></linearGradient>
      <rect x="${o.x - o.w}" y="${o.y}" width="${o.w * 3}" height="${o.h}" fill="url(#fog-grad)"/>
      <rect x="${o.x - o.w}" y="${o.y + o.h}" width="${o.w * 3}" height="${o.h}" fill="#fff" fill-opacity="0.62"/>`,
  }[weather()] ?? '';
  $('tint').innerHTML = tint;
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
          aria-label="Build a department ${escapeXml(spotName(cell))}">
        <title>${escapeXml(spotName(cell))}</title>
        <polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>
        <path d="M${cx - 12},${cy} H${cx + 12} M${cx},${cy - 12} V${cy + 12}"/></g>`;
    }).join('')
    : '';
  $('labels').innerHTML = build + gardenTargets() + config.rooms
    .filter((r) => LAYOUT[r.id])
    .map((r) => {
      const floorPts = floorOutline(r.id).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
      return `<polygon class="room-hit" data-room="${r.id}" points="${floorPts}"/>`;
    })
    .join('') + config.rooms
    .filter((r) => LAYOUT[r.id])
    .map((r) => {
      const [x, y] = labelPoint(r.id);
      const w = Math.max(r.name.length * 16, r.purpose.length * 9.8) + 32;
      return `<g class="room-label" data-room="${r.id}" role="button" tabindex="0"
          aria-label="Visit the ${escapeXml(r.name)}" data-x="${x.toFixed(1)}" data-y="${(y + 28).toFixed(1)}">
        <rect x="${-w / 2}" y="-24" width="${w}" height="56" rx="14"/>
        <text class="name" text-anchor="middle" y="1">${escapeXml(r.name)}</text>
        <text class="purpose" text-anchor="middle" y="22">${escapeXml(r.purpose)}</text></g>`;
    })
    .join('') + decorMarkers();
}

const pointsOf = (list) => list.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');

// The gardens open like rooms. While one is being planted, each of its tiles
// is its own target.
function gardenTargets() {
  const gardens = config.decorCatalogue?.gardens ?? [];
  return gardens.map((g) => {
    if (decorating && focusedGarden === g.id) {
      const n = config.decorCatalogue.gardenSize;
      let tiles = '';
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          tiles += `<polygon class="plot-tile" data-garden="${g.id}" data-tile="${i},${j}" role="button" tabindex="0"
            aria-label="Tile ${i + 1}, ${j + 1}" points="${pointsOf(gardenTile(g.id, i, j))}"><title>Tile ${i + 1}, ${j + 1}</title></polygon>`;
        }
      }
      return tiles;
    }
    return `<polygon class="garden-hit" data-garden="${g.id}" points="${pointsOf(gardenOutline(g.id))}"><title>Visit the ${escapeXml(g.name.toLowerCase())}</title></polygon>`;
  }).join('');
}

// Numbered markers on a room's decoration spots while it is being decorated.
function decorMarkers() {
  if (!decorating || !focusedRoom) return '';
  return decorSpots(focusedRoom).map(([x, y, z], i) => {
    // A ring on the floor and a numbered pin above whatever stands there.
    const [sx, sy] = P(x, y, z);
    const top = P(x, y, z + 2.3)[1] - sy;
    return `<g class="spot-mark" transform="translate(${sx.toFixed(1)} ${sy.toFixed(1)})" aria-hidden="true">
      <ellipse rx="24" ry="12"/><line x1="0" y1="0" x2="0" y2="${(top + 12).toFixed(1)}"/>
      <circle cy="${top.toFixed(1)}" r="12"/><text text-anchor="middle" y="${(top + 5).toFixed(1)}">${i + 1}</text></g>`;
  }).join('');
}

// ---- camera: zoom, pan, visit a room, turn the tower ------------------------

let overview;
let focusedRoom;
let focusedGarden; // a garden being visited, like a room
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
    g.classList.toggle('hidden', Boolean(focusedGarden) || (Boolean(focusedRoom) && g.dataset.room !== focusedRoom));
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
    else updateCameraUi();
  };
  tween = requestAnimationFrame(stepTo);
}

function visitRoom(id) {
  const moved = focusedRoom !== id;
  focusedRoom = id;
  focusedGarden = undefined;
  if (moved) redrawDecorLayer();
  placeLabels();
  const f = roomFrame(id);
  const pad = 0.4;
  flyTo(clearOfPanel({ x: f.x - f.w * pad, y: f.y - f.h * pad, w: f.w * (1 + 2 * pad), h: f.h * (1 + 2 * pad) }));
  updateCameraUi();
}

function visitGarden(id) {
  const moved = focusedGarden !== id;
  focusedGarden = id;
  focusedRoom = undefined;
  if (moved) redrawDecorLayer();
  placeLabels();
  const f = gardenFrame(id);
  const pad = 0.2;
  flyTo(clearOfPanel({ x: f.x - f.w * pad, y: f.y - f.h * pad, w: f.w * (1 + 2 * pad), h: f.h * (1 + 2 * pad) }));
  updateCameraUi();
}

// While the decorating panel is open it covers the left of the stage, so
// the camera widens the frame to the left and the place sits in the clear
// part on the right.
function clearOfPanel(b) {
  if (!decorating) return b;
  const stage = svg.getBoundingClientRect();
  const panel = $('decorate').getBoundingClientRect();
  const covered = panel.right - stage.left + 16;
  if (!(covered > 0 && covered < stage.width * 0.7)) return b;
  // The svg letterboxes the frame into the stage, so fit it first.
  const scale = Math.max(b.w / stage.width, b.h / stage.height);
  const w = stage.width * scale;
  const h = stage.height * scale;
  const fitted = { x: b.x - (w - b.w) / 2, y: b.y - (h - b.h) / 2, w, h };
  const k = stage.width / (stage.width - covered);
  return { x: fitted.x - fitted.w * (k - 1), y: fitted.y - (fitted.h * (k - 1)) / 2, w: fitted.w * k, h: fitted.h * k };
}

// Leaving a place (for the overview, or by zooming or moving away) closes
// the decorating panel with it.
function leavePlace() {
  const was = focusedRoom || focusedGarden;
  focusedRoom = undefined;
  focusedGarden = undefined;
  if (was) redrawDecorLayer();
}

function showOverview() {
  leavePlace();
  placeLabels();
  flyTo(overview);
  updateCameraUi();
}

// Turning. The whole building swings round smoothly, and because heights are
// worked out from the angle, towers rise and sink and the stairs change
// during the swing itself. It always comes to rest facing one of the four
// directions. `angle` counts quarter turns without wrapping, so a swing
// never takes the long way round.
let angle = 0;
let swing;
let drawQueued = false;

function showAngle(a) {
  setView(a);
  setHeights(targetHeights());
  drawGeometry();
  drawLabels();
  placeLabels();
}

// Walks in progress end at once: their routes were planned for other heights.
function settleWalkers() {
  for (const p of people.values()) {
    if (p.walking && !p.leaving) {
      p.path = [];
      if (p.seat) p.pos = p.seat.slice();
    }
  }
}

// Turned part-way, the building is wider than when square on, so the
// camera steps back a little for the swing and comes in again after.
function swingRoom() {
  if (focusedRoom || focusedGarden || cam.w < overview.w * 0.95) return;
  const k = 1.22;
  flyTo({ x: overview.x - (overview.w * (k - 1)) / 2, y: overview.y - (overview.h * (k - 1)) / 2, w: overview.w * k, h: overview.h * k }, 250);
}

function turnTo(target, ms = 900) {
  cancelAnimationFrame(swing);
  settleWalkers();
  swingRoom();
  const from = angle;
  const start = performance.now();
  const dur = reducedMotion.matches ? 0 : ms * Math.min(1, Math.abs(target - from) || 1);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const stepTo = (now) => {
    const t = dur ? Math.min(1, (now - start) / dur) : 1;
    angle = from + (target - from) * ease(t);
    showAngle(angle);
    if (t < 1) {
      swing = requestAnimationFrame(stepTo);
      return;
    }
    angle = target;
    prefs.view = ((target % 4) + 4) % 4;
    savePrefs();
    drawScene();
    if (focusedRoom) visitRoom(focusedRoom);
    else if (focusedGarden) visitGarden(focusedGarden);
    else flyTo(overview, 350);
    updateCameraUi();
  };
  swing = requestAnimationFrame(stepTo);
}

function turnView(step) {
  turnTo(Math.round(angle) + step);
}

function frameCamera() {
  if (focusedRoom) visitRoom(focusedRoom);
  else if (focusedGarden) visitGarden(focusedGarden);
  else setViewBox(overview);
  updateCameraUi();
}

function updateCameraUi() {
  const zoomed = focusedRoom || focusedGarden || cam.w < overview.w * 0.95;
  $('cam-overview').disabled = !zoomed;
  $('cam-where').textContent = focusedRoom ? `In the ${ROOM_NAMES[focusedRoom]?.name ?? ''}`
    : focusedGarden ? `In the ${gardenName(focusedGarden).toLowerCase()}` : zoomed ? 'Zoomed in' : '';
  $('cam-where').hidden = !zoomed;
  const place = focusedRoom || focusedGarden;
  $('cam-decorate').hidden = !place || !bridge.saveDecor;
  $('cam-decorate').setAttribute('aria-expanded', String(decorating));
  $('cam-decorate').textContent = focusedGarden ? 'Plant' : 'Decorate';
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
  if (!decorating) leavePlace();
  updateCameraUi();
}, { passive: false });

// Drag sideways to swing the building round; it follows the mouse and, on
// release, settles on the nearest of the four directions. Right-drag, or
// Shift-drag, moves the view instead.
const PX_PER_QUARTER = 260;
let drag;
svg.addEventListener('contextmenu', (e) => e.preventDefault());
svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  const mode = e.button === 2 || e.shiftKey ? 'pan' : 'turn';
  drag = { mode, x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false, angle };
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) svg.setPointerCapture?.(e.pointerId);
  drag.moved = true;
  svg.classList.add(drag.mode === 'pan' ? 'dragging' : 'turning-drag');
  if (drag.mode === 'turn') {
    if (!drag.swinging) {
      drag.swinging = true;
      cancelAnimationFrame(swing);
      settleWalkers();
      swingRoom();
      drag.angle = angle;
    }
    angle = drag.angle - dx / PX_PER_QUARTER;
    if (!drawQueued) {
      drawQueued = true;
      requestAnimationFrame(() => {
        drawQueued = false;
        showAngle(angle);
      });
    }
    return;
  }
  const [, , scale] = toSvgPoint(0, 0);
  cancelAnimationFrame(tween);
  setViewBox({ ...drag.cam, x: drag.cam.x - dx * scale, y: drag.cam.y - dy * scale });
  if (!decorating) leavePlace();
  updateCameraUi();
});
window.addEventListener('pointerup', () => {
  svg.classList.remove('dragging', 'turning-drag');
  if (drag?.swinging) turnTo(Math.round(angle), 450);
  // Let the click that follows this pointerup see whether it was a drag.
  setTimeout(() => { drag = undefined; }, 0);
});
$('cam-overview').addEventListener('click', showOverview);
$('labels').addEventListener('keydown', (e) => {
  const cell = e.target.closest('[data-cell]');
  if (cell && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    chooseCell(cell.dataset.cell.split(',').map(Number));
    return;
  }
  const tile = e.target.closest('[data-tile]');
  if (tile && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    plantAt(tile.dataset.garden, tile.dataset.tile.split(',').map(Number));
    return;
  }
  const label = e.target.closest('.room-label');
  if (label && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    visitRoom(label.dataset.room);
  }
});
window.addEventListener('keydown', (e) => {
  // Shortcuts only when nothing that takes typing or keys has focus.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, select, textarea, summary, [contenteditable]')) return;
  if (e.key === 'q' || e.key === 'Q') turnView(-1);
  else if (e.key === 'e' || e.key === 'E') turnView(1);
  else if (e.key === 'Escape') {
    if (decorating) setDecorating(false);
    else showOverview();
  }
});

angle = prefs.view ?? 0;
setView(angle);
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
let homeless = 0;
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
  const p = people.get(key);
  if (key.startsWith('r:') && p?.busyWith) key = p.busyWith;
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
  const tile = e.target.closest('[data-tile]');
  if (tile) {
    plantAt(tile.dataset.garden, tile.dataset.tile.split(',').map(Number));
    return;
  }
  const garden = e.target.closest('[data-garden]');
  if (garden && !e.target.closest('.person')) {
    visitGarden(garden.dataset.garden);
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
    for (const a of s.agents) wanted.set(`a:${a.id}`, { kind: 'agent', room: a.room, data: a, name: a.type, session: s.id });
  }

  // A helper whose room is gone (a department removed while it was on
  // shift) is shown in the General Ward, and counted.
  homeless = 0;
  const staff = staffList(snapshot);
  for (const w of wanted.values()) {
    if (!LAYOUT[w.room]) {
      w.room = 'general-ward';
      homeless += 1;
    }
  }
  syncStaff(staff, wanted);

  for (const [key, w] of wanted) {
    if (w.resident) continue; // a staff member at their post is doing this one
    let p = people.get(key);
    if (!p) {
      const seat = takeSeat(w.room, key);
      const home = slotPoint(w.room, seat);
      p = new Person({
        id: key,
        roomId: w.room,
        layer: peopleLayer,
        at: w.kind === 'session' ? home : spawnPoint(),
        onSelect: select,
      });
      p.seat = home;
      p.home = home.slice();
      if (w.kind === 'agent') {
        p.walk([...routeTo(w.room), home]);
        escort(people.get(`s:${w.session}`), w.room);
      }
      people.set(key, p);
    }
    if (p.roomId !== w.room && !p.leaving) {
      freeSeat(p.roomId, key);
      p.roomId = w.room;
      p.seat = slotPoint(w.room, takeSeat(w.room, key));
      p.walk([p.seat]);
    }
    p.setStatus(glyphKey(w.data));
    p.setActivity(w.data.activity?.kind);
    if (w.kind === 'session' && !p.leaving) steer(p, w.data, sessionIndex(key, snapshot));
    p.setLabel(w.name, statusText(w.data));
    p.el.classList.toggle('selected', key === selected);
    if (w.kind === 'agent' && w.data.status === 'done' && !p.leaving) {
      freeSeat(p.roomId, key);
      p.leave([...routeTo(p.roomId).reverse(), spawnPoint()]);
    }
  }

  for (const [key, p] of people) {
    if (key.startsWith('r:')) continue; // staff are handled in syncStaff
    if (!wanted.has(key) && !p.leaving) {
      freeSeat(p.roomId, key);
      p.leave(key.startsWith('a:') ? [...routeTo(p.roomId).reverse()] : []);
    }
  }
}

// ---- resident staff -----------------------------------------------------------

// Your staff are the agents you have defined (.claude/agents) and the ones
// you placed in departments. Each stands at a post in their own room all the
// time. When called, the attending brings the task over and they do it right
// there; when done they stay. Agents with no post (Explore, Plan...) walk in
// as visitors and leave again, as before.
function staffList(snap) {
  const list = new Map(); // name -> room
  for (const a of snap.roster || []) list.set(a.name, a.room);
  for (const d of config.layout?.departments || []) for (const a of d.agents) if (!list.has(a)) list.set(a, d.id);
  for (const [name, room] of list) if (!LAYOUT[room]) list.set(name, 'general-ward');
  return list;
}

function syncStaff(staff, wanted) {
  // Retire posts that no longer exist.
  for (const [key, p] of people) {
    if (!key.startsWith('r:') || p.leaving) continue;
    if (!staff.has(key.slice(2))) {
      freeSeat(p.roomId, key);
      p.leave([]);
    }
  }
  for (const [name, room] of staff) {
    const key = `r:${name}`;
    let p = people.get(key);
    if (!p || p.leaving) {
      const home = slotPoint(room, takeSeat(room, key));
      p = new Person({ id: key, roomId: room, layer: peopleLayer, at: home, onSelect: select });
      p.seat = home;
      p.home = home.slice();
      people.set(key, p);
    } else if (p.roomId !== room) {
      // Moved to another room (a new department, or rooms.json): walk over.
      freeSeat(p.roomId, key);
      const home = slotPoint(room, takeSeat(room, key));
      p.walk([...routeBetween(p.roomId, room), home]);
      p.roomId = room;
      p.seat = home;
      p.home = home.slice();
    }
    // Take on a helper of this type: keep the one already held, else the
    // first new one. Any others of the same type walk in as visitors.
    if (p.busyWith && !wanted.has(p.busyWith)) p.busyWith = undefined;
    if (!p.busyWith) {
      for (const [k, w] of wanted) {
        if (w.kind !== 'agent' || w.name !== name || w.resident || people.has(k)) continue;
        p.busyWith = k;
        escort(people.get(`s:${w.session}`), room);
        break;
      }
    }
    const job = p.busyWith && wanted.get(p.busyWith);
    if (job) job.resident = p;
    const x = job ? job.data : { status: 'standby' };
    p.setStatus(glyphKey(x));
    p.setActivity(x.activity?.kind);
    p.setLabel(name, statusText(x));
    p.el.classList.toggle('selected', selected === key || (job && selected === p.busyWith));
  }
}

// ---- the attending goes where its work is ------------------------------------

const DWELL_MS = 4000; // the same kind of work this long before it moves

function sessionIndex(key, snap) {
  return Math.max(0, snap.sessions.findIndex((s) => `s:${s.id}` === key));
}

// What the attending should be doing, as a place: its desk at the station,
// the Research Office shelf, the Laboratory bench, or the front of the
// counter when it is your turn.
function wantedPlace(x) {
  if (x.status === 'your-turn') return 'counter';
  if (x.status === 'working') {
    const k = x.activity?.kind;
    if (k === 'read' || k === 'search' || k === 'web') return 'shelf';
    if (k === 'run') return 'bench';
    return 'desk';
  }
  return undefined; // thinking, waiting on a helper or on approval: stay put
}

function goTo(p, place, index) {
  const spot = place === 'desk' ? { room: 'nurses-station', point: p.home } : workSpot(place, index);
  if (!spot) return;
  const from = p.roomId;
  p.walk([...routeBetween(from, spot.room), spot.point]);
  p.roomId = spot.room;
  p.seat = spot.point.slice();
  p.place = place;
}

function steer(p, x, index) {
  if (p.escorting && p.walking) return;
  p.escorting = false;
  const want = wantedPlace(x);
  if (!want) return;
  const now = performance.now();
  if (want !== p.wantPlace) {
    p.wantPlace = want;
    p.wantSince = now;
  }
  const settled = want === 'counter' || now - p.wantSince >= DWELL_MS;
  if (settled && want !== (p.place ?? 'desk') && !p.walking) goTo(p, want, index);
}

// Handing over: the attending walks the new helper to the door of its room,
// then comes back to wait at its desk.
function escort(p, room) {
  if (!p || p.leaving || room === 'nurses-station') return;
  const toDoor = routeBetween(p.roomId, room).slice(0, -1); // stop at the doorway
  if (toDoor.length < 2) return;
  const back = routeTo(room).slice(0, -1).reverse();
  p.walk([...toDoor, ...back, p.home]);
  p.roomId = 'nurses-station';
  p.seat = p.home.slice();
  p.place = 'desk';
  p.escorting = true;
}

let last = performance.now();
function frame(nowMs) {
  const dt = Math.min(0.1, (nowMs - last) / 1000);
  last = nowMs;
  const t = nowMs / 1000;
  for (const [key, p] of people) {
    // Seated people ride their floor up and down as the heights change.
    const floorZ = LAYOUT[p.roomId]?.z;
    if (floorZ !== undefined && !p.walking && !p.leaving) {
      p.pos[2] = floorZ;
      if (p.seat) p.seat[2] = floorZ;
    }
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
    case 'standby': return 'Standby';
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

// 1234 -> "1.2k", 3456789 -> "3.5M".
function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

// A session row counts its helpers' tokens too; a helper row its own.
function rowTokens(x, sub) {
  return sub ? x.tokens?.total : x.tokensWithHelpers ?? x.tokens?.total;
}

function rowHtml(key, x, name, sub) {
  const what = statusText(x);
  const tokens = rowTokens(x, sub);
  const tokenText = tokens ? `${compact(tokens)} tokens` : '';
  const detail = !prefs.private && x.activity?.detail ? ` · ${x.activity.detail}` : '';
  const warn = x.status === 'blocked' || x.status === 'your-turn' || glyphKey(x) === 'failed';
  const where = sub ? ` in the ${roomName(x.room)}` : '';
  return `<button class="row${sub ? ' sub' : ''}" data-key="${escapeXml(key)}" aria-pressed="${key === selected}"
      title="${escapeXml(`${name}${where}: ${what}${detail}${tokens ? ` · ${tokens.toLocaleString()} tokens${sub ? '' : ' with helpers'}` : ''}`)}">
      ${glyph(x)}
      <span class="who"><span class="name">${escapeXml(name)}</span>
        <span class="what${warn ? ' warn' : ''}">${escapeXml(what + detail)}</span></span>
      <span class="when"><span class="time" data-since="${x.startedAt}">${elapsed(x.startedAt, Date.now())}</span>
        ${tokenText ? `<span class="tokens">${tokenText}</span>` : ''}</span>
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
  if (selected?.startsWith('r:')) {
    const name = selected.slice(2);
    const room = staffList(s).get(name);
    if (room) return { x: { status: 'standby', history: [] }, name, room, resident: true };
  }
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
    x.startedAt ? ['On shift since', clock(x.startedAt)] : null,
    x.errors ? ['Tool errors', String(x.errors)] : null,
    x.tokens?.total ? ['Tokens', `${x.tokens.total.toLocaleString()} (in ${x.tokens.input.toLocaleString()} · out ${x.tokens.output.toLocaleString()} · cache read ${x.tokens.cacheRead.toLocaleString()} · cache write ${x.tokens.cacheWrite.toLocaleString()})`] : null,
    !parent && x.tokensWithHelpers > (x.tokens?.total ?? 0) ? ['With helpers', `${x.tokensWithHelpers.toLocaleString()} tokens`] : null,
  ].filter(Boolean);
  const history = [...x.history].reverse()
    .map((h) => `<li><span class="t">${clock(h.ts)}</span>
        <span>${escapeXml(h.label)}${!prefs.private && h.detail ? `<span class="d"> · ${escapeXml(h.detail)}</span>` : ''}</span></li>`)
    .join('');
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeXml(v)}</dd>`).join('')}</dl>
    <ol aria-label="Recent activity">${history || `<li><span class="t">—</span><span>${found.resident ? 'Standing by in their room' : 'No tool calls yet'}</span></li>`}</ol>`;
}

function renderCensus(s) {
  const n = s.sessions.length;
  const helpers = s.sessions.reduce((k, x) => k + x.agents.filter((a) => a.status !== 'done').length, 0);
  const waiting = s.sessions.filter((x) => x.status === 'your-turn').length;
  const blocked = s.sessions.reduce((k, x) => k + (x.status === 'blocked') + x.agents.filter((a) => a.status === 'blocked').length, 0);
  const parts = [`${n} session${n === 1 ? '' : 's'}`, `${helpers} helper${helpers === 1 ? '' : 's'} at work`];
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (blocked) parts.push(`${blocked} may need approval`);
  const tokens = s.sessions.reduce((k, x) => k + (x.tokensWithHelpers ?? x.tokens?.total ?? 0), 0);
  if (tokens) parts.push(`${compact(tokens)} tokens`);
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
  if (homeless) {
    list.push({ label: `${homeless} helper${homeless === 1 ? ' is' : 's are'} working in a department that has been removed, so ${homeless === 1 ? 'it is' : 'they are'} shown in the General Ward` });
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
    snapshot.sessions.map((x) => [x.id, x.status, x.activity?.label, x.activity?.detail, compact(x.tokensWithHelpers ?? 0),
      x.agents.map((a) => [a.id, a.status, a.activity?.label, a.activity?.detail, compact(a.tokens?.total ?? 0)])]),
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

// "east of the Operating Room": which room a free spot joins, in words.
function spotName([c, r]) {
  const sides = [[-1, 0, 'east'], [1, 0, 'west'], [0, -1, 'south'], [0, 1, 'north']];
  for (const [dc, dr, dir] of sides) {
    const room = config.rooms.find((x) => x.cell[0] === c + dc && x.cell[1] === r + dr);
    if (room) return `${dir} of the ${room.name}`;
  }
  return 'here';
}

let confirmRemove; // department id awaiting a yes
let nameError = '';

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
  nameError = '';
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
  const plain = departments.map(({ id, kind, name, purpose, cell, agents }) => ({ id, kind, name, purpose, cell, agents: [...agents] }));
  const result = await bridge.saveLayout({ departments: plain });
  if (!result.ok) {
    layoutError = result.error;
    renderLayoutEditor();
    return false;
  }
  useConfig(result.config);
  drawScene();
  leavePlace();
  setViewBox(overview);
  updateCameraUi();
  return true;
}

function renderLayoutEditor() {
  const depts = config.layout.departments;
  $('layout-count').textContent = depts.length ? `(${depts.length})` : '';
  const reachedThrough = (id) => depts.find((x) => x.via === id);
  const list = depts.length
    ? `<ul class="dept-list">${depts.map((d) => {
      const child = reachedThrough(d.id);
      const action = child
        ? `<span class="blocked">Remove ${escapeXml(child.name)} first: it is reached through here.</span>`
        : confirmRemove === d.id
          ? `<span class="confirm">Remove ${escapeXml(d.name)}?
              <button type="button" class="link-btn danger" data-remove-yes="${escapeXml(d.id)}">Remove</button>
              <button type="button" class="link-btn" data-remove-no>Keep</button></span>`
          : `<button type="button" class="link-btn" data-remove="${escapeXml(d.id)}">Remove</button>`;
      return `<li>
        <span class="agent">${escapeXml(d.name)}</span>
        <span class="summary">${escapeXml(d.purpose)}${d.agents.length ? ` · ${escapeXml(d.agents.join(', '))}` : ' · no agents yet'}</span>
        <span class="actions">${action}</span>
      </li>`;
    }).join('')}</ul>`
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
        <input id="dept-name" maxlength="40" placeholder="e.g. Hand Surgery" value="${escapeXml(draft.name)}"
          ${nameError ? 'aria-invalid="true" aria-describedby="dept-name-error"' : ''}>
        ${nameError ? `<span class="field-error" id="dept-name-error">${escapeXml(nameError)}</span>` : ''}</label>
      <fieldset class="field"><legend>Agents who work here</legend>
        <div class="checks">${agents || '<span class="muted">No agents seen yet.</span>'}</div>
        <label class="field" for="dept-agent-new">Another agent, by its name in .claude/agents</label>
        <div class="add-row">
          <input id="dept-agent-new" placeholder="e.g. spine-planner">
          <button type="button" class="link-btn" id="dept-agent-add">Add</button>
        </div>
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

function addTypedAgent() {
  const input = $('dept-agent-new');
  const name = input?.value.trim();
  if (!draft || !name) return;
  draft.agents.add(name);
  renderLayoutEditor();
  $('dept-agent-new')?.focus();
}

$('layout-body').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'build-start') setBuildMode(true);
  else if (t.id === 'build-stop' || t.id === 'dept-cancel') setBuildMode(false);
  else if (t.id === 'dept-agent-add') addTypedAgent();
  else if (t.dataset.remove) {
    confirmRemove = t.dataset.remove;
    renderLayoutEditor();
    document.querySelector('[data-remove-no]')?.focus();
  } else if (t.hasAttribute('data-remove-no')) {
    confirmRemove = undefined;
    renderLayoutEditor();
  } else if (t.dataset.removeYes) {
    confirmRemove = undefined;
    const keep = config.layout.departments.filter((d) => d.id !== t.dataset.removeYes);
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
    addTypedAgent();
  }
});

$('layout-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!draft) return;
  draft.name = $('dept-name')?.value ?? draft.name;
  const extra = $('dept-agent-new')?.value.trim();
  if (extra) draft.agents.add(extra);
  if (draft.kind === 'custom' && !draft.name.trim()) {
    nameError = 'Give your department a name.';
    renderLayoutEditor();
    $('dept-name')?.focus();
    return;
  }
  nameError = '';
  const existing = config.layout.departments.map((d) => ({ ...d, agents: new Set(d.agents) }));
  const added = { kind: draft.kind, name: draft.kind === 'custom' ? draft.name.trim() : undefined, cell: draft.cell, agents: draft.agents };
  if (await saveLayout([...existing, added])) setBuildMode(false);
});

renderLayoutEditor();

// ---- decorating: floors, room decorations and gardens ------------------------------

function gardenName(id) {
  return config.decorCatalogue?.gardens.find((g) => g.id === id)?.name ?? 'Garden';
}

function redrawDecorLayer() {
  if (!focusedRoom && !focusedGarden) decorating = false;
  drawLabels();
  placeLabels();
  renderDecorPanel();
  updateCameraUi();
}

function setDecorating(on) {
  decorating = on && Boolean(focusedRoom || focusedGarden);
  decorError = '';
  decorNote = '';
  redrawDecorLayer();
  if (focusedRoom) visitRoom(focusedRoom);
  else if (focusedGarden) visitGarden(focusedGarden);
  if (decorating) $('decorate-body').querySelector('input, select, button')?.focus();
  else $('cam-decorate').focus();
}
$('cam-decorate').addEventListener('click', () => setDecorating(!decorating));
$('decorate-close').addEventListener('click', () => setDecorating(false));
$('decorate').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    setDecorating(false);
  }
});

async function saveDecor(next, note) {
  const result = await bridge.saveDecor(next);
  if (!result.ok) {
    decorError = result.error;
    decorNote = '';
    renderDecorPanel();
    return;
  }
  config.decor = result.decor;
  decorError = '';
  decorNote = note;
  drawGeometry();
  drawLabels();
  placeLabels();
  renderDecorPanel();
}

const plantOf = (kind) => config.decorCatalogue.plants.find((p) => p.id === kind);
function plantSize(item) {
  const p = plantOf(item.kind);
  return item.turn ? [p.d, p.w] : [p.w, p.d];
}
function plantTiles(item) {
  const [w, d] = plantSize(item);
  const out = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) out.push([item.at[0] + i, item.at[1] + j]);
  return out;
}
const covers = (item, [i, j]) => plantTiles(item).some(([a, b]) => a === i && b === j);

function gardenList(id) {
  const cat = config.decorCatalogue;
  return (config.decor.gardens[id] ?? cat.defaultGardens[id] ?? []).map((it) => ({ ...it, at: [...it.at] }));
}

// Plants the chosen piece with its corner on the tile, nudged back inside
// the plot if it would hang over the edge; whatever it lands on is dug up.
function plantAt(gardenId, [i, j]) {
  const n = config.decorCatalogue.gardenSize;
  const list = gardenList(gardenId);
  let next;
  let note;
  if (plantTool === 'remove') {
    next = list.filter((it) => !covers(it, [i, j]));
    if (next.length === list.length) {
      decorNote = `Nothing grows on tile ${i + 1}, ${j + 1}.`;
      renderDecorPanel();
      return;
    }
    note = `Dug up tile ${i + 1}, ${j + 1}.`;
  } else {
    const p = plantOf(plantTool);
    const item = { kind: plantTool, at: [0, 0] };
    if (benchTurn && p.turns) item.turn = true;
    const [w, d] = plantSize(item);
    item.at = [Math.min(i, n - w), Math.min(j, n - d)];
    const tiles = plantTiles(item);
    next = list.filter((it) => !tiles.some((t) => covers(it, t)));
    next.push(item);
    note = `Planted ${p.name.toLowerCase()} on tile ${item.at[0] + 1}, ${item.at[1] + 1}.`;
  }
  saveDecor({ ...config.decor, gardens: { ...config.decor.gardens, [gardenId]: next } }, note);
}

function roomEntry(id) {
  return config.decor.rooms[id] ?? {};
}

function setRoomEntry(id, entry, note) {
  const rooms = { ...config.decor.rooms };
  const clean = {};
  if (entry.floor && entry.floor !== config.decorCatalogue.defaultFloor) clean.floor = entry.floor;
  if (entry.spots?.some(Boolean)) clean.spots = entry.spots.map((x) => x || null);
  if (Object.keys(clean).length) rooms[id] = clean;
  else delete rooms[id];
  saveDecor({ ...config.decor, rooms }, note);
}

// Decorations that make sense in this room; the same rule as src/core/decor.js.
function decorationsFor(id) {
  const room = ROOM_NAMES[id];
  const tag = room?.custom ? 'department' : id;
  return config.decorCatalogue.decorations.filter((d) => d.rooms === 'any' || d.rooms.includes(tag));
}

function renderDecorPanel() {
  const panel = $('decorate');
  panel.hidden = !decorating;
  if (!decorating) return;
  const cat = config.decorCatalogue;
  const error = decorError ? `<p class="form-error" role="alert">${escapeXml(decorError)}</p>` : '';
  const status = `<p class="hint decor-status" aria-live="polite">${escapeXml(decorNote)}</p>`;
  if (focusedGarden) {
    $('decorate-h').textContent = `Plant the ${gardenName(focusedGarden).toLowerCase()}`;
    const chip = (id, name, extra = '') => `<label class="chip"><input type="radio" name="plant-tool" value="${id}" ${plantTool === id ? 'checked' : ''}>${escapeXml(name)}${extra}</label>`;
    const size = (p) => (p.w * p.d > 1 ? ` <span class="size">${p.w}×${p.d}</span>` : '');
    const bench = plantOf(plantTool)?.turns
      ? `<label class="switch"><input type="checkbox" id="bench-turn" ${benchTurn ? 'checked' : ''}> <span>Turn it the other way</span></label>` : '';
    $('decorate-body').innerHTML = `
      <fieldset class="chips"><legend>What to plant</legend>
        <div class="options">${cat.plants.map((p) => chip(p.id, p.name, size(p))).join('')}${chip('remove', 'Dig up')}</div>
      </fieldset>
      ${bench}
      <p class="hint">Click a tile on the plot. Pieces marked 2×2 take four tiles; whatever they land on is dug up.</p>
      ${status}${error}
      <div class="form-actions">
        <button type="button" class="link-btn" id="garden-clear">Clear the plot</button>
        <button type="button" class="link-btn" id="garden-default">Back to how it was</button>
      </div>`;
    return;
  }
  const id = focusedRoom;
  const entry = roomEntry(id);
  const floor = entry.floor ?? cat.defaultFloor;
  const fits = decorationsFor(id);
  $('decorate-h').textContent = `Decorate the ${ROOM_NAMES[id]?.name ?? 'room'}`;
  const spots = Array.from({ length: cat.spotsPerRoom }, (_, i) => {
    const chosen = entry.spots?.[i] ?? '';
    return `<label class="field">Spot ${i + 1}
      <select data-spot="${i}">
        <option value="" ${chosen ? '' : 'selected'}>Nothing</option>
        ${fits.map((d) => `<option value="${d.id}" ${chosen === d.id ? 'selected' : ''}>${escapeXml(d.name)}</option>`).join('')}
      </select></label>`;
  }).join('');
  $('decorate-body').innerHTML = `
    <fieldset class="chips"><legend>Floor</legend>
      <div class="options">${cat.floors.map((f) => `<label class="chip"><input type="radio" name="floor" value="${f.id}" ${floor === f.id ? 'checked' : ''}>${escapeXml(f.name)}</label>`).join('')}</div>
    </fieldset>
    <p class="hint">The numbered spots on the floor take a decoration each. Only pieces that belong in this room are offered.</p>
    <div class="spot-fields">${spots}</div>
    ${status}${error}
    <div class="form-actions"><button type="button" class="link-btn" id="room-reset">Back to the plain room</button></div>`;
}

$('decorate-body').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'plant-tool') {
    plantTool = t.value;
    decorNote = '';
    renderDecorPanel();
    $('decorate-body').querySelector(`input[name="plant-tool"][value="${plantTool}"]`)?.focus();
  } else if (t.id === 'bench-turn') {
    benchTurn = t.checked;
  } else if (t.name === 'floor') {
    const name = config.decorCatalogue.floors.find((f) => f.id === t.value)?.name ?? t.value;
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), floor: t.value }, `Floor changed to ${name.toLowerCase()}.`);
  } else if (t.dataset.spot !== undefined) {
    const spots = Array.from({ length: config.decorCatalogue.spotsPerRoom }, (_, i) => roomEntry(focusedRoom).spots?.[i] ?? null);
    spots[Number(t.dataset.spot)] = t.value || null;
    const name = t.selectedOptions[0]?.textContent ?? '';
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), spots }, t.value ? `${name} placed on spot ${Number(t.dataset.spot) + 1}.` : `Spot ${Number(t.dataset.spot) + 1} cleared.`);
  }
});

$('decorate-body').addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'garden-clear') {
    saveDecor({ ...config.decor, gardens: { ...config.decor.gardens, [focusedGarden]: [] } }, 'The plot is bare.');
  } else if (id === 'garden-default') {
    const gardens = { ...config.decor.gardens };
    delete gardens[focusedGarden];
    saveDecor({ ...config.decor, gardens }, 'The garden is back to how it was.');
  } else if (id === 'room-reset') {
    setRoomEntry(focusedRoom, {}, 'The room is back to its plain floor, with no decorations.');
  }
});

// ---- performance report --------------------------------------------------------

if (!bridge.buildReport) {
  // The browser preview cannot read transcripts; the desktop app can.
  $('report-open').disabled = true;
  $('report-files').hidden = true;
  $('report-status').textContent = 'The report is built by the desktop app.';
}

$('report-open').addEventListener('click', async () => {
  const button = $('report-open');
  button.disabled = true;
  const status = $('report-status');
  status.textContent = 'Reading your transcripts…';
  try {
    const res = await bridge.buildReport(Number($('report-days').value));
    if (!res.ok) {
      status.textContent = res.error;
      return;
    }
    const x = res.summary;
    const pctText = x.successRate === undefined ? '' : `, ${Math.round(x.successRate * 100)}% finished`;
    status.textContent = `Opened: last ${x.days} days, ${x.runs} helper run${x.runs === 1 ? '' : 's'}${pctText}.`;
  } catch (err) {
    status.textContent = `The report could not be built: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
$('report-files').addEventListener('click', () => bridge.showReportFiles?.());

// ---- settings panel ------------------------------------------------------------

function setSettings(open) {
  $('settings').hidden = !open;
  $('settings-open').setAttribute('aria-expanded', String(open));
  if (open) $('settings-close').focus();
  else {
    if (buildMode) setBuildMode(false);
    $('settings-open').focus();
  }
}
$('settings-open').addEventListener('click', () => setSettings($('settings').hidden));
$('settings-close').addEventListener('click', () => setSettings(false));
$('settings').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    setSettings(false);
  }
});

applyPrefs();
showClock();
render(true);
setInterval(render, 250);
