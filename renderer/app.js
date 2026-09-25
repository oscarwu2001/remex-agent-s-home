import {
  buildScene, labelPoint, slotPoint, routeTo, spawnPoint, LAYOUT, targetHeights, setHeights, workSpot, routeBetween, floorOutline, roomFrame, configureRooms, cellOutline,
  gardenTile, gardenOutline, gardenFrame, gardenPlot, plantPreview, plantThumb, floorThumb,
  roomItems, itemSize, roomTile, itemPreview, itemThumb, doorwayTiles,
} from './scene.js';
import { P } from './iso.js';
import { BLOSSOMING } from './decor.js';
import { createMeadow } from './meadow.js';
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
  configureRooms(config.rooms, config.gardens);
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
let roomTool = 'move'; // an item kind to place, 'move' or 'remove'
let roomTurn = false;
let picked; // index of the item being moved, once clicked
let moreOpen = false; // the 'More items' list stays open once opened

const $ = (id) => document.getElementById(id);
const svg = $('scene');
const peopleLayer = $('people');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- preferences (per-viewer conveniences only) ----------------------------

// time: 'auto' follows the computer's clock, or a fixed part of the day.
// live: the real weather, off unless the user turns it on. `place` is the
// town they chose ({ name, region, country, latitude, longitude }).
const prefs = {
  budget5h: 0, notify: true, creatures: {},
  private: true, names: true, theme: DEFAULT_THEME, time: 'auto', detail: 'simple', weather: 'clear', view: 0, demo: false,
  live: { on: false, place: null, unit: 'celsius' },
};
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
if (!prefs.live || typeof prefs.live !== 'object') prefs.live = { on: false, place: null, unit: 'celsius' };
prefs.live = { on: prefs.live.on === true, place: prefs.live.place ?? null, unit: prefs.live.unit === 'fahrenheit' ? 'fahrenheit' : 'celsius' };

// The last reading of the real weather, and why the last try failed.
let liveNow; // { weather, temperature, unit, fetchedAt }
let liveError = '';
const LIVE_EVERY_MS = 30 * 60_000;
const LIVE_STALE_MS = 3 * 60 * 60_000; // an older reading no longer stands for "now"
const liveReading = () => (prefs.live.on && liveNow && Date.now() - liveNow.fetchedAt < LIVE_STALE_MS ? liveNow : undefined);

// The weather being shown. "Changes through the day" picks one for every
// three hours from the date, so it holds steady for a while, is the same on
// every redraw, and needs nothing from outside. Mostly fair; snow only in
// the colder months, rain otherwise.
function weather(date = new Date()) {
  const real = liveReading();
  if (real) return real.weather;
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
  const real = liveReading();
  const temp = real ? ` · ${real.temperature}${real.unit}` : '';
  const off = prefs.live.on && prefs.live.place && !real ? ' · real weather unavailable' : '';
  $('clock').innerHTML = `<span class="now">${escapeXml(hm)}</span>${escapeXml(part)} · ${escapeXml(WEATHERS[weather()])}${escapeXml(temp)}${escapeXml(off)}`;
  $('clock').title = real && prefs.live.place ? `Weather in ${placeName(prefs.live.place)}` : '';
}

// ---- the real weather (opt-in, online) --------------------------------------

function placeName(p) {
  return [p.name, p.region && p.region !== p.name ? p.region : '', p.country].filter(Boolean).join(', ');
}

let liveResults = []; // places found by the last search
async function refreshLive() {
  if (!prefs.live.on || !prefs.live.place || !bridge.weatherNow) return;
  const before = weather();
  const res = await bridge.weatherNow(prefs.live.place, prefs.live.unit);
  if (res.ok) {
    liveNow = { ...res.now, fetchedAt: Date.now() };
    liveError = '';
  } else {
    // Shown in Settings and on the clock; the chosen weather stands in.
    liveError = res.error;
  }
  if (weather() !== before) {
    applyPrefs();
    drawScene();
  }
  showClock();
  renderLive();
}
setInterval(refreshLive, LIVE_EVERY_MS);

function renderLive() {
  const body = $('live-body');
  const online = Boolean(bridge.weatherNow);
  $('opt-live').checked = prefs.live.on;
  $('opt-live').disabled = !online;
  body.hidden = !prefs.live.on;
  $('live-hint').textContent = !online ? 'The desktop app can read the real weather; this preview cannot.'
    : prefs.live.on ? 'Asks Open-Meteo (open-meteo.com) every 30 minutes for the weather at the place below. Only the place is sent, never anything from your sessions. The weather you chose above stands in when it cannot be reached.'
      : 'Off: the weather above is what you see, and the app stays fully offline.';
  if (!prefs.live.on) return;
  if (!prefs.live.place) {
    body.innerHTML = `
      <form class="add-row" id="live-search"><label class="visually-hidden" for="live-q">Town or city</label>
        <input id="live-q" type="search" placeholder="Your town or city" autocomplete="off">
        <button class="button" type="submit">Find</button></form>
      ${liveError ? `<p class="form-error" role="alert">${escapeXml(liveError)}</p>` : ''}
      <ul class="live-results">${liveResults.map((p, i) => `<li><button type="button" class="link-btn" data-place="${i}">${escapeXml(placeName(p))}</button></li>`).join('')}</ul>`;
    return;
  }
  const real = liveReading();
  const status = liveError ? `<p class="form-error" role="alert">Could not read the weather: ${escapeXml(liveError)}.</p>`
    : real ? `<p class="hint">Now: ${escapeXml(WEATHERS[real.weather].toLowerCase())}, ${real.temperature}${real.unit} (checked ${new Date(real.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).</p>`
      : '<p class="hint">Checking…</p>';
  body.innerHTML = `
    <p class="live-place">${escapeXml(placeName(prefs.live.place))} <button type="button" class="link-btn" id="live-change">Change place</button></p>
    <label class="field" for="live-unit">Temperature in
      <select id="live-unit"><option value="celsius" ${prefs.live.unit === 'celsius' ? 'selected' : ''}>°C</option>
        <option value="fahrenheit" ${prefs.live.unit === 'fahrenheit' ? 'selected' : ''}>°F</option></select></label>
    ${status}`;
}

$('opt-live').addEventListener('change', (e) => {
  prefs.live.on = e.target.checked;
  liveError = '';
  if (!prefs.live.on) liveNow = undefined;
  savePrefs();
  applyPrefs();
  drawScene();
  showClock();
  renderLive();
  if (prefs.live.on) refreshLive();
  if (prefs.live.on && !prefs.live.place) $('live-q')?.focus();
});
$('live-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('live-q').value;
  const res = await bridge.weatherSearch(q);
  liveResults = res.ok ? res.places : [];
  liveError = res.ok ? (res.places.length ? '' : `No place called “${q.trim()}” was found`) : `Could not search: ${res.error}`;
  renderLive();
  $('live-body').querySelector('[data-place]')?.focus();
});
$('live-body').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-place]');
  if (pick) {
    prefs.live.place = liveResults[Number(pick.dataset.place)];
    liveResults = [];
    liveNow = undefined;
    savePrefs();
    renderLive();
    refreshLive();
  } else if (e.target.id === 'live-change') {
    prefs.live.place = null;
    liveNow = undefined;
    liveError = '';
    savePrefs();
    applyPrefs();
    drawScene();
    showClock();
    renderLive();
    $('live-q')?.focus();
  }
});
$('live-body').addEventListener('change', (e) => {
  if (e.target.id !== 'live-unit') return;
  prefs.live.unit = e.target.value;
  savePrefs();
  refreshLive();
});
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
    roomItems: cat?.roomItems, defaultRoomItems: cat?.defaultRoomItems,
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
          aria-label="Build here: ${escapeXml(spotName(cell))}">
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
  const gardens = config.gardens ?? [];
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
    return `<polygon class="garden-hit" data-garden="${g.id}" points="${pointsOf(gardenOutline(g.id))}"><title>Visit the ${escapeXml(gardenName(g.id))}</title></polygon>`;
  }).join('');
}

// While a room is being decorated, each floor tile is its own target, and
// the item picked up to move is outlined.
function decorMarkers() {
  if (!decorating || !focusedRoom) return '';
  const n = config.decorCatalogue.roomSize;
  let out = '';
  const moving = picked !== undefined ? roomItems(focusedRoom)[picked] : undefined;
  const lifted = new Set(moving ? tilesOf(moving).map((t) => t.join(',')) : []);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out += `<polygon class="plot-tile${lifted.has(`${i},${j}`) ? ' lifted' : ''}" data-room-tile="${i},${j}" role="button" tabindex="0"
        aria-label="Tile ${i + 1}, ${j + 1}" points="${pointsOf(roomTile(focusedRoom, i, j))}"><title>Tile ${i + 1}, ${j + 1}</title></polygon>`;
    }
  }
  return out;
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
    : focusedGarden ? `In the ${gardenName(focusedGarden)}` : zoomed ? 'Zoomed in' : '';
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
  const floorTile = e.target.closest('[data-room-tile]');
  if (floorTile && focusedRoom && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    placeInRoom(focusedRoom, floorTile.dataset.roomTile.split(',').map(Number));
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
  const floorTile = e.target.closest('[data-room-tile]');
  if (floorTile && focusedRoom) {
    placeInRoom(focusedRoom, floorTile.dataset.roomTile.split(',').map(Number));
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

const CONTEXT_WARN = 0.85; // share of the context at which a session is flagged

function rowHtml(key, x, name, sub) {
  const what = statusText(x);
  const tokens = rowTokens(x, sub);
  const ctx = !sub && x.context?.pct ? Math.round(x.context.pct * 100) : undefined;
  const tokenText = [tokens ? `${compact(tokens)} tokens` : '', ctx !== undefined ? `context ${ctx}%` : ''].filter(Boolean).join(' · ');
  const nearlyFull = ctx !== undefined && ctx >= CONTEXT_WARN * 100;
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
      ${nearlyFull ? `<span class="ctx-warn">⚠ Context ${ctx}% full: save your work</span>` : ''}
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
  const full = s.sessions.filter((x) => x.context?.pct >= CONTEXT_WARN).length;
  if (full) parts.push(`${full} nearly out of context`);
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
  checkWarnings(snapshot);
  syncPeople(snapshot);

  const chart = renderChart(snapshot);
  const problems = renderProblems(snapshot);
  const signature = JSON.stringify([
    snapshot.sessions.map((x) => [x.id, x.status, x.activity?.label, x.activity?.detail, compact(x.tokensWithHelpers ?? 0),
      x.agents.map((a) => [a.id, a.status, a.activity?.label, a.activity?.detail, compact(a.tokens?.total ?? 0)])]),
    chart, problems, (snapshot.roster || []).length, selected, prefs.private, warnings,
    snapshot.usage ? [snapshot.usage.last5h.total, snapshot.usage.today.total, snapshot.usage.limitNotice?.ts, prefs.budget5h] : null,
    snapshot.sessions.map((x) => Math.round((x.context?.pct ?? 0) * 100)),
  ]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  meadow.refresh();

  // Re-render, then put keyboard focus back where it was.
  const focusKey = document.activeElement?.dataset?.key;
  $('sessions').innerHTML = renderSessions(snapshot);
  $('census').textContent = renderCensus(snapshot);
  renderUsage(snapshot);
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

// ---- Claude Code use and warnings -------------------------------------------------

function renderUsage(s) {
  const u = s.usage;
  const box = $('usage');
  box.hidden = !u || s.assistantMode;
  if (box.hidden) return;
  const row = (label, t) => `<div class="usage-row"><span>${label}</span><strong>${compact(t.total)}</strong>
    <span class="muted">${compact(t.fresh)} without cache reads</span></div>`;
  const budget = prefs.budget5h > 0
    ? (() => {
      const pct = Math.min(100, Math.round((u.last5h.total / prefs.budget5h) * 100));
      return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Your 5-hour warning level used">
        <span style="width:${pct}%"></span></div><p class="hint">${pct}% of your warning level (${compact(prefs.budget5h)} in 5 hours).</p>`;
    })()
    : '';
  const limit = u.limitNotice ? `<p class="form-error">⚠ Claude Code: ${escapeXml(u.limitNotice.text)}</p>` : '';
  $('usage-body').innerHTML = `${limit}${row('Last 5 hours', u.last5h)}${row('Today', u.today)}${row('Last 7 days', u.week)}${budget}`;
}

// Warnings are raised once each: per session when its context passes the
// line, per limit message, and per 5-hour window for the user's own level.
const warned = new Set();
let warnings = [];
function checkWarnings(s) {
  const now = [];
  const raise = (key, text) => {
    now.push(text);
    if (warned.has(key)) return;
    warned.add(key);
    if (prefs.notify && bridge.notify && !s.demo) bridge.notify({ title: "Agent's Home", body: text });
  };
  for (const sess of s.sessions) {
    if (sess.context?.pct >= CONTEXT_WARN) {
      raise(`ctx:${sess.id}`, `${sess.project} has used ${Math.round(sess.context.pct * 100)}% of its context. Save what you are working on: Claude Code will compact it soon.`);
    }
    if (sess.limitNotice) raise(`limit:${sess.id}:${sess.limitNotice.ts}`, `Claude Code (${sess.project}): ${sess.limitNotice.text} Save what you are working on.`);
  }
  const u = s.usage;
  if (u?.limitNotice && !s.sessions.some((x) => x.limitNotice)) raise(`limit:all:${u.limitNotice.ts}`, `Claude Code: ${u.limitNotice.text} Save what you are working on.`);
  if (u && prefs.budget5h > 0) {
    const window = Math.floor(Date.now() / (5 * 3_600_000));
    for (const level of [0.8, 1]) {
      if (u.last5h.total >= prefs.budget5h * level) {
        raise(`budget:${window}:${level}`, level === 1
          ? `Claude Code has used ${compact(u.last5h.total)} tokens in 5 hours, past your warning level. Save what you are working on.`
          : `Claude Code has used ${Math.round((u.last5h.total / prefs.budget5h) * 100)}% of your 5-hour warning level. Consider saving your work soon.`);
      }
    }
  }
  warnings = now;
}

$('opt-budget').value = prefs.budget5h > 0 ? String(prefs.budget5h) : '';
$('opt-notify').checked = prefs.notify !== false;
$('opt-budget').addEventListener('change', (e) => {
  const n = Math.round(Number(e.target.value));
  prefs.budget5h = Number.isFinite(n) && n > 0 ? n : 0;
  e.target.value = prefs.budget5h ? String(prefs.budget5h) : '';
  savePrefs();
  render(true);
});
$('opt-notify').addEventListener('change', (e) => {
  prefs.notify = e.target.checked;
  savePrefs();
});

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
  draft = { cell, what: 'department', kind: config.departmentKinds[0].kind, name: '', gardenName: '', agents: new Set() };
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

// Departments carry their agents as a Set while being edited.
async function saveLayout(departments, gardens = config.layout.gardens ?? []) {
  const plain = departments.map(({ id, kind, name, purpose, cell, agents }) => ({ id, kind, name, purpose, cell, agents: [...agents] }));
  const result = await bridge.saveLayout({ departments: plain, gardens });
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
  const plots = config.layout.gardens ?? [];
  $('layout-count').textContent = depts.length + plots.length ? `(${depts.length + plots.length})` : '';
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
    : plots.length ? '' : '<p class="empty">Only the core hospital so far. Add a department for each specialty your agents serve, or a garden to plant.</p>';
  const gardenList = plots.length
    ? `<ul class="dept-list">${plots.map((g) => {
      const action = confirmRemove === g.id
        ? `<span class="confirm">Remove ${escapeXml(g.name)} and all that grows there?
            <button type="button" class="link-btn danger" data-remove-yes="${escapeXml(g.id)}">Remove</button>
            <button type="button" class="link-btn" data-remove-no>Keep</button></span>`
        : `<button type="button" class="link-btn" data-remove="${escapeXml(g.id)}">Remove</button>`;
      return `<li><span class="agent">${escapeXml(g.name)}</span>
        <span class="summary">A garden ${escapeXml(spotName(g.cell))}</span>
        <span class="actions">${action}</span></li>`;
    }).join('')}</ul>`
    : '';

  let form = '';
  if (buildMode && !draft) {
    form = `<p class="hint">Choose a “+” spot next to the hospital. ${config.openCells.length} ${config.openCells.length === 1 ? 'spot is' : 'spots are'} free.</p>`;
  } else if (draft && draft.what === 'garden') {
    form = `<form class="dept-form" id="dept-form">
      ${buildChoice()}
      <label class="field">Name <input id="garden-name" maxlength="30" placeholder="Garden ${(config.layout.gardens ?? []).length + 1}" value="${escapeXml(draft.gardenName)}"></label>
      <p class="hint">A floating garden of 4 × 4 tiles. Once it is built, click it and press Plant.</p>
      <div class="form-actions">
        <button type="submit" class="button">Build garden</button>
        <button type="button" class="link-btn" id="dept-cancel">Cancel</button>
      </div>
    </form>`;
  } else if (draft) {
    const kinds = config.departmentKinds.map((k) => `<option value="${k.kind}" ${k.kind === draft.kind ? 'selected' : ''}>${escapeXml(k.name)}</option>`).join('');
    const agents = knownAgentNames().map((a) => `<label class="check"><input type="checkbox" value="${escapeXml(a)}" ${draft.agents.has(a) ? 'checked' : ''}> ${escapeXml(a)}</label>`).join('');
    form = `<form class="dept-form" id="dept-form">
      ${buildChoice()}
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
  $('layout-body').innerHTML = `${list}${gardenList}
    ${layoutError ? `<p class="form-error" role="alert">${escapeXml(layoutError)}</p>` : ''}
    ${form}
    ${buildMode ? '' : `<button type="button" class="button" id="build-start" ${config.openCells.length ? '' : 'disabled'}>Add a department or garden</button>`}
    ${buildMode && !draft ? '<button type="button" class="link-btn" id="build-stop">Done</button>' : ''}`;
}

// What to build on the chosen spot.
function buildChoice() {
  const opt = (v, label) => `<label class="chip"><input type="radio" name="build-what" value="${v}" ${draft.what === v ? 'checked' : ''}>${label}</label>`;
  return `<fieldset class="chips"><legend>Build here</legend><div class="options">${opt('department', 'A department')}${opt('garden', 'A garden')}</div></fieldset>`;
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
    const id = t.dataset.removeYes;
    const keep = config.layout.departments.filter((d) => d.id !== id);
    const plots = (config.layout.gardens ?? []).filter((g) => g.id !== id);
    if (await saveLayout(keep.map((d) => ({ ...d, agents: new Set(d.agents) })), plots)) renderLayoutEditor();
  }
});

$('layout-body').addEventListener('change', (e) => {
  if (!draft) return;
  if (e.target.name === 'build-what') {
    draft.what = e.target.value;
    renderLayoutEditor();
    document.querySelector(`input[name="build-what"][value="${draft.what}"]`)?.focus();
  } else if (e.target.id === 'garden-name') {
    draft.gardenName = e.target.value;
  } else if (e.target.id === 'dept-kind') {
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
  if (draft.what === 'garden') {
    const name = ($('garden-name')?.value ?? draft.gardenName).trim();
    const existing = config.layout.departments.map((d) => ({ ...d, agents: new Set(d.agents) }));
    const plots = [...(config.layout.gardens ?? []), { cell: draft.cell, ...(name ? { name } : {}) }];
    if (await saveLayout(existing, plots)) setBuildMode(false);
    return;
  }
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

// "the garden", "the grove", but "Rose court" as the user wrote it.
function gardenName(id) {
  const name = config.gardens?.find((g) => g.id === id)?.name ?? 'Garden';
  return id === 'garden' || id === 'grove' ? name.toLowerCase() : name;
}

function redrawDecorLayer() {
  if (!focusedRoom && !focusedGarden) decorating = false;
  if (!decorating) hoverTile = undefined;
  showGhost();
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
  showGhost();
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

// What a click on a tile would do: the piece and where it lands, or for
// "Dig up", what it would remove. Shared by the preview and the click.
function planFor(gardenId, [i, j]) {
  const n = config.decorCatalogue.gardenSize;
  const list = gardenList(gardenId);
  if (plantTool === 'remove') {
    const hit = list.filter((it) => covers(it, [i, j]));
    return { remove: true, tiles: hit.flatMap(plantTiles), list, keep: list.filter((it) => !covers(it, [i, j])) };
  }
  const item = { kind: plantTool, at: [0, 0] };
  if (benchTurn && plantOf(plantTool).turns) item.turn = true;
  const [w, d] = plantSize(item);
  item.at = [Math.min(i, n - w), Math.min(j, n - d)];
  const tiles = plantTiles(item);
  return { item, tiles, list, keep: list.filter((it) => !tiles.some((t) => covers(it, t))) };
}

// The see-through preview under the pointer (or keyboard focus).
let hoverTile; // { garden, tile: [i, j] }
function showGhost() {
  if (decorating && focusedRoom && hoverTile?.room === focusedRoom) {
    $('ghost').innerHTML = itemPreview(focusedRoom, planRoom(focusedRoom, hoverTile.tile).preview);
    return;
  }
  if (!decorating || !focusedGarden || !hoverTile || hoverTile.garden !== focusedGarden) {
    $('ghost').innerHTML = '';
    return;
  }
  const plan = planFor(hoverTile.garden, hoverTile.tile);
  $('ghost').innerHTML = plantPreview(hoverTile.garden, plan.remove
    ? { remove: true, tiles: plan.tiles }
    : { kind: plan.item.kind, at: plan.item.at, turn: plan.item.turn, tiles: plan.tiles });
}
function hoverOn(el) {
  if (el?.dataset.roomTile) hoverTile = { room: focusedRoom, tile: el.dataset.roomTile.split(',').map(Number) };
  else hoverTile = el ? { garden: el.dataset.garden, tile: el.dataset.tile.split(',').map(Number) } : undefined;
  showGhost();
}
$('labels').addEventListener('pointerover', (e) => hoverOn(e.target.closest('[data-tile], [data-room-tile]')));
$('labels').addEventListener('pointerleave', () => hoverOn(undefined));
$('labels').addEventListener('focusin', (e) => hoverOn(e.target.closest('[data-tile], [data-room-tile]')));

// ---- rooms: place, move and remove items on the floor grid ------------------------

const itemOf = (kind) => config.decorCatalogue.roomItems.find((i) => i.id === kind);
function tilesOf(item) {
  const [w, d] = itemSize(item);
  const out = [];
  for (let a = 0; a < w; a++) for (let b = 0; b < d; b++) out.push([item.at[0] + a, item.at[1] + b]);
  return out;
}
const coversTile = (item, [i, j]) => tilesOf(item).some(([a, b]) => a === i && b === j);

// What a click on a room tile would do, and how to preview it.
function planRoom(roomId, [i, j]) {
  const n = config.decorCatalogue.roomSize;
  const list = roomItems(roomId).map((it) => ({ ...it, at: [...it.at] }));
  const doors = new Set(doorwayTiles(roomId).map((t) => t.join(',')));
  const hit = list.findIndex((it) => coversTile(it, [i, j]));
  if (roomTool === 'remove') {
    return { kind: 'remove', index: hit, list, preview: { remove: true, tiles: hit === -1 ? [] : tilesOf(list[hit]) } };
  }
  let item;
  let others = list;
  if (roomTool === 'move') {
    if (picked === undefined) {
      // Nothing in hand yet: point at an item to pick it up.
      return { kind: 'pick', index: hit, list, preview: { remove: false, tiles: hit === -1 ? [] : tilesOf(list[hit]) } };
    }
    const moving = list[picked];
    item = { kind: moving.kind, at: [0, 0], ...(moving.turn || (roomTurn && itemOf(moving.kind)?.turns) ? { turn: true } : {}) };
    if (roomTurn && itemOf(moving.kind)?.turns) item.turn = !moving.turn;
    else if (moving.turn) item.turn = true;
    others = list.filter((_, k) => k !== picked);
  } else {
    item = { kind: roomTool, at: [0, 0] };
    if (roomTurn && itemOf(roomTool)?.turns) item.turn = true;
  }
  const [w, d] = itemSize(item);
  item.at = [Math.min(i, n - w), Math.min(j, n - d)];
  const tiles = tilesOf(item);
  const blocked = tiles.some((t) => doors.has(t.join(',')));
  const clash = others.filter((it) => tiles.some((t) => coversTile(it, t)));
  return {
    kind: roomTool === 'move' ? 'move' : 'place', item, list, others, clash, blocked,
    preview: { kind: item.kind, at: item.at, turn: item.turn, tiles, blocked: blocked || (roomTool === 'move' && clash.length > 0) },
  };
}

function placeInRoom(roomId, tile) {
  const plan = planRoom(roomId, tile);
  const name = (k) => (itemOf(k)?.name ?? k).toLowerCase();
  if (plan.kind === 'remove') {
    if (plan.index === -1) {
      decorNote = 'Nothing stands on that tile.';
      renderDecorPanel();
      return;
    }
    const gone = plan.list[plan.index];
    setRoomEntry(roomId, { ...roomEntry(roomId), items: plan.list.filter((_, k) => k !== plan.index) }, `Removed the ${name(gone.kind)}.`);
    return;
  }
  if (plan.kind === 'pick') {
    if (plan.index === -1) {
      decorNote = 'Click an item to pick it up, then click where it should go.';
    } else {
      picked = plan.index;
      decorNote = `Picked up the ${name(plan.list[plan.index].kind)}. Click where it should go.`;
    }
    redrawDecorLayer();
    return;
  }
  if (plan.blocked) {
    decorNote = 'That would block a doorway. Choose another tile.';
    renderDecorPanel();
    return;
  }
  if (plan.kind === 'move') {
    if (plan.clash.length) {
      decorNote = 'Something is already there. Move or remove it first.';
      renderDecorPanel();
      return;
    }
    picked = undefined;
    setRoomEntry(roomId, { ...roomEntry(roomId), items: [...plan.others, plan.item] }, `Moved the ${name(plan.item.kind)}.`);
    return;
  }
  // Placing a new item takes the place of whatever was on those tiles.
  const kept = plan.list.filter((it) => !plan.clash.includes(it));
  const replaced = plan.clash.length ? ` in place of the ${plan.clash.map((it) => name(it.kind)).join(' and ')}` : '';
  setRoomEntry(roomId, { ...roomEntry(roomId), items: [...kept, plan.item] }, `Placed the ${name(plan.item.kind)}${replaced}.`);
}

// Plants the chosen piece with its corner on the tile, nudged back inside
// the plot if it would hang over the edge; whatever it lands on is dug up.
function plantAt(gardenId, [i, j]) {
  const plan = planFor(gardenId, [i, j]);
  let next;
  let note;
  if (plan.remove) {
    if (!plan.tiles.length) {
      decorNote = `Nothing grows on tile ${i + 1}, ${j + 1}.`;
      renderDecorPanel();
      return;
    }
    next = plan.keep;
    note = `Dug up tile ${i + 1}, ${j + 1}.`;
  } else {
    next = [...plan.keep, plan.item];
    note = `Planted ${plantOf(plan.item.kind).name.toLowerCase()} on tile ${plan.item.at[0] + 1}, ${plan.item.at[1] + 1}.`;
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
  if (Array.isArray(entry.items)) clean.items = entry.items;
  if (Object.keys(clean).length) rooms[id] = clean;
  else delete rooms[id];
  saveDecor({ ...config.decor, rooms }, note);
}

// Items that belong in this room first, then the rest (the rule of itemsFor
// in src/core/decor.js).
function itemsForRoom(id) {
  const tag = ROOM_NAMES[id]?.custom ? 'department' : id;
  const all = config.decorCatalogue.roomItems;
  const fits = all.filter((i) => i.suits.length === 0 || i.suits.includes(tag));
  return { fits, rest: all.filter((i) => !fits.includes(i)) };
}

function renderDecorPanel() {
  const panel = $('decorate');
  panel.hidden = !decorating;
  if (!decorating) return;
  const cat = config.decorCatalogue;
  const error = decorError ? `<p class="form-error" role="alert">${escapeXml(decorError)}</p>` : '';
  const status = `<p class="hint decor-status" aria-live="polite">${escapeXml(decorNote)}</p>`;
  if (focusedGarden) {
    $('decorate-h').textContent = `Plant the ${gardenName(focusedGarden)}`;
    const chip = (id, name, extra = '', thumb = '') => `<label class="chip"><input type="radio" name="plant-tool" value="${id}" ${plantTool === id ? 'checked' : ''}>${thumb}${escapeXml(name)}${extra}</label>`;
    const size = (p) => (p.w * p.d > 1 ? ` <span class="size">${p.w}×${p.d}</span>` : '');
    const bench = plantOf(plantTool)?.turns
      ? `<label class="switch"><input type="checkbox" id="bench-turn" ${benchTurn ? 'checked' : ''}> <span>Turn it the other way</span></label>` : '';
    $('decorate-body').innerHTML = `
      <fieldset class="chips"><legend>What to plant</legend>
        <div class="options">${cat.plants.map((p) => chip(p.id, p.name, size(p), plantThumb(p.id, p.w > 1 || p.d > 1))).join('')}${chip('remove', 'Dig up')}</div>
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
  const { fits, rest } = itemsForRoom(id);
  const tool = (t, label) => `<button type="button" class="piece tool" data-room-tool="${t}" aria-pressed="${roomTool === t}"><span>${label}</span></button>`;
  const piece = (it) => `<button type="button" class="piece" data-room-tool="${it.id}" aria-pressed="${roomTool === it.id}">${itemThumb(it.id, id)}<span>${escapeXml(it.name)}${it.w * it.d > 1 ? ` <span class="size">${it.w}×${it.d}</span>` : ''}</span></button>`;
  const turnable = roomTool === 'move' ? picked !== undefined && itemOf(roomItems(id)[picked]?.kind)?.turns : itemOf(roomTool)?.turns;
  const hint = roomTool === 'move'
    ? (picked === undefined ? 'Click an item in the room to pick it up, then click where it should go.' : 'Now click where it should go.')
    : roomTool === 'remove' ? 'Click an item to take it out of the room.'
      : 'Point at the floor to see it there, then click to place it. Whatever it lands on is replaced; doorways stay clear.';
  $('decorate-body').innerHTML = `
    <fieldset class="chips"><legend>Floor</legend>
      <div class="options">${cat.floors.map((f) => `<label class="chip floor-chip"><input type="radio" name="floor" value="${f.id}" ${floor === f.id ? 'checked' : ''}>${floorThumb(f.id, id)}${escapeXml(f.name)}</label>`).join('')}</div>
    </fieldset>
    <div class="pieces tools">${tool('move', 'Move')}${tool('remove', 'Remove')}</div>
    ${turnable ? `<label class="switch"><input type="checkbox" id="room-turn" ${roomTurn ? 'checked' : ''}> <span>Turn it the other way</span></label>` : ''}
    <p class="hint">${hint}</p>
    <h4 class="pieces-h">For this room</h4>
    <div class="pieces">${fits.map(piece).join('')}</div>
    <details class="more-pieces" ${moreOpen || rest.some((it) => it.id === roomTool) ? 'open' : ''}><summary>More items (${rest.length})</summary><div class="pieces">${rest.map(piece).join('')}</div></details>
    ${status}${error}
    <div class="form-actions">
      <button type="button" class="link-btn" id="room-clear">Empty the room</button>
      <button type="button" class="link-btn" id="room-reset">Back to how it was</button></div>`;
}

$('decorate-body').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'plant-tool') {
    plantTool = t.value;
    decorNote = '';
    renderDecorPanel();
    showGhost();
    $('decorate-body').querySelector(`input[name="plant-tool"][value="${plantTool}"]`)?.focus();
  } else if (t.id === 'bench-turn') {
    benchTurn = t.checked;
    showGhost();
  } else if (t.name === 'floor') {
    const name = config.decorCatalogue.floors.find((f) => f.id === t.value)?.name ?? t.value;
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), floor: t.value }, `Floor changed to ${name.toLowerCase()}.`);
  } else if (t.id === 'room-turn') {
    roomTurn = t.checked;
    showGhost();
  }
});

$('decorate-body').addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('more-pieces')) moreOpen = e.target.open;
}, true);

// Choosing what the next click on the floor does.
$('decorate-body').addEventListener('click', (e) => {
  const el = e.target.closest('[data-room-tool]');
  if (!el || !focusedRoom) return;
  roomTool = el.dataset.roomTool;
  picked = undefined;
  decorNote = '';
  redrawDecorLayer();
  $('decorate-body').querySelector(`[data-room-tool="${CSS.escape(roomTool)}"]`)?.focus();
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
    picked = undefined;
    setRoomEntry(focusedRoom, {}, 'The room is back to how it was.');
  } else if (id === 'room-clear') {
    picked = undefined;
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), items: [] }, 'The room is empty.');
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

// ---- wind ------------------------------------------------------------------------

// Now and then a gust blows through: garden trees and flowers bend, and
// petals (or leaves, if nothing is in blossom) blow off the trees and across
// the hospital. Nothing happens for people who ask for reduced motion.
function gardenItemsOf(id) {
  return config.decor.gardens[id] ?? config.decorCatalogue?.defaultGardens?.[id] ?? [];
}

function gust() {
  if (reducedMotion.matches || document.hidden) return;
  const geometry = $('geometry');
  geometry.classList.remove('gust');
  void geometry.getBoundingClientRect(); // restart the animation
  geometry.classList.add('gust');
  setTimeout(() => geometry.classList.remove('gust'), 3600);

  // Where the blossoming trees are on screen: petals start there.
  const stage = $('gust').getBoundingClientRect();
  const ctm = svg.getScreenCTM();
  const sources = [];
  for (const g of config.gardens ?? []) {
    const plot = gardenPlot(g.id);
    if (!plot) continue;
    for (const it of gardenItemsOf(g.id)) {
      if (!BLOSSOMING.has(it.kind)) continue;
      const big = it.kind !== 'cherry-sapling';
      const [x, y] = P(plot.at[0] + it.at[0] + (big ? 1 : 0.5), plot.at[1] + it.at[1] + (big ? 1 : 0.5), plot.z + (big ? 2.3 : 1.2));
      if (ctm) sources.push([ctm.a * x + ctm.c * y + ctm.e - stage.left, ctm.b * x + ctm.d * y + ctm.f - stage.top]);
    }
  }
  const leaves = sources.length === 0;
  const n = leaves ? 14 : 30;
  let html = '';
  for (let i = 0; i < n; i++) {
    const from = !leaves && i % 3 !== 0 ? sources[i % sources.length] : [-20, stage.height * (0.1 + Math.random() * 0.7)];
    const jitter = !leaves && i % 3 !== 0 ? 30 : 0;
    const x0 = from[0] + (Math.random() - 0.5) * jitter;
    const y0 = from[1] + (Math.random() - 0.5) * jitter;
    const dx = stage.width * (0.35 + Math.random() * 0.5) + (from[0] < 0 ? stage.width * 0.2 : 0);
    const dy = 40 + Math.random() * 160;
    html += `<span class="petal${leaves ? ' leaf' : ''}" style="left:${x0.toFixed(0)}px;top:${y0.toFixed(0)}px;--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--dur:${(3 + Math.random() * 2).toFixed(2)}s;--delay:${(Math.random() * 1.6).toFixed(2)}s"></span>`;
  }
  $('gust').innerHTML = html;
  setTimeout(() => { $('gust').innerHTML = ''; }, 7000);
}

(function windLoop() {
  setTimeout(() => {
    gust();
    windLoop();
  }, 45_000 + Math.random() * 75_000);
}());
setTimeout(gust, 12_000); // a first one soon after opening

// ---- updates -------------------------------------------------------------------

async function showUpdateInfo() {
  if (!bridge.updateInfo) {
    $('update-version').textContent = 'The desktop app updates itself from its git clone; this preview cannot.';
    $('update-run').disabled = true;
    return;
  }
  const info = await bridge.updateInfo();
  $('update-version').textContent = info.available
    ? `Version ${info.version}, ${info.branch} at ${info.commit}. Pulls the newest code from GitHub, then restarts.`
    : `Version ${info.version}. ${info.reason}`;
  $('update-run').disabled = !info.available;
}

$('update-run').addEventListener('click', async () => {
  const button = $('update-run');
  const status = $('update-status');
  button.disabled = true;
  status.classList.remove('form-error');
  status.textContent = 'Getting the newest version…';
  try {
    const res = await bridge.update();
    status.textContent = res.ok ? res.message : res.error;
    status.classList.toggle('form-error', !res.ok);
    if (!res.ok || !res.restart) {
      button.disabled = false;
      showUpdateInfo();
    }
  } catch (err) {
    status.textContent = `The update did not complete: ${err.message}`;
    status.classList.add('form-error');
    button.disabled = false;
  }
});

// ---- the Office pack: a ready-made team offered to Claude ---------------------------

// Asked once in a short card on the board: "Not now" is remembered until the
// pack has something new. The same list stays in Settings.
const packLabel = (name) => ({ handover: 'Handover note', 'break-down': 'Break into tasks' }[name]
  ?? name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
let pack; // { hasOwnAgents, items: [{ kind, name, summary, installed }] }
let packNote = '';
let packError = '';

async function loadPack() {
  if (!bridge.packStatus) return;
  const res = await bridge.packStatus();
  if (!res.ok) {
    packError = res.error;
    pack = undefined;
  } else {
    pack = res;
  }
  renderPack();
}

// The card shows names only; Settings adds what each one does.
function packChoices(id, withSummary) {
  return pack.items.filter((i) => !i.installed).map((i) => `<label class="check">
    <input type="checkbox" name="${id}" value="${escapeXml(i.name)}" checked>
    <span><strong>${escapeXml(packLabel(i.name))}</strong>${withSummary ? ` <span class="muted">${escapeXml(i.summary)}</span>` : ''}</span></label>`).join('');
}

function renderPack() {
  const offer = $('pack-offer');
  const settings = $('pack-settings');
  if (!bridge.packStatus) {
    offer.hidden = true;
    settings.innerHTML = '<p class="hint">The desktop app can add the office team to Claude; this preview cannot.</p>';
    return;
  }
  if (!pack) {
    offer.hidden = true;
    settings.innerHTML = packError ? `<p class="form-error">${escapeXml(packError)}</p>` : '';
    return;
  }
  const missing = pack.items.filter((i) => !i.installed);
  const key = missing.map((i) => i.name).join(',');
  const note = packNote ? `<p class="hint" role="status">${escapeXml(packNote)}</p>` : '';
  const err = packError ? `<p class="form-error" role="alert">${escapeXml(packError)}</p>` : '';
  // The board card: short. A new Claude folder gets one button; one that
  // already has agents gets the list to choose from.
  offer.hidden = !(missing.length && prefs.packDismissed !== key) && !packNote;
  if (!offer.hidden) {
    offer.innerHTML = missing.length && prefs.packDismissed !== key ? `
      <h2 id="pack-h">Add the office team to Claude?</h2>
      ${pack.hasOwnAgents ? `<div class="checks pack-names">${packChoices('pack-pick', false)}</div>` : '<p class="hint">Helpers for emails, summaries, plans and numbers.</p>'}
      ${err}<div class="form-actions">
        <button type="button" class="button" id="pack-add">${pack.hasOwnAgents ? 'Add selected' : 'Add'}</button>
        <button type="button" class="link-btn" id="pack-later">Not now</button></div>`
      : `<h2 id="pack-h">Office team</h2>${note}<div class="form-actions"><button type="button" class="link-btn" id="pack-ok">OK</button></div>`;
  }
  settings.innerHTML = `${pack.items.map((i) => `<p class="pack-row">${i.installed ? '✓' : '○'} <strong>${escapeXml(packLabel(i.name))}</strong>
      <span class="muted">${i.installed ? 'in Claude' : 'not added'}</span></p>`).join('')}
    ${missing.length ? `<div class="checks">${packChoices('pack-pick-settings', true)}</div>
      <button type="button" class="button" id="pack-add-settings">Add to Claude</button>` : '<p class="hint">All of the office team is in Claude.</p>'}
    ${err}${note}`;
}

async function addPack(names, fromCard = false) {
  if (!names.length) return;
  packError = '';
  const res = await bridge.packInstall(names);
  // From the card, whatever was left unticked counts as "not now".
  if (fromCard) {
    prefs.packDismissed = pack.items.filter((i) => !i.installed && !names.includes(i.name)).map((i) => i.name).join(',');
    savePrefs();
  }
  const added = res.installed?.length ?? 0;
  packNote = added ? `Added to Claude. Start a new Claude session to use ${added === 1 ? 'it' : 'them'}.` : '';
  if (res.errors?.length) packError = res.errors.join('; ');
  else if (!res.ok) packError = res.error;
  await loadPack();
}

document.addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'pack-add') {
    const picks = pack.hasOwnAgents ? [...document.querySelectorAll('input[name="pack-pick"]:checked')].map((x) => x.value)
      : pack.items.filter((i) => !i.installed).map((i) => i.name);
    addPack(picks, true);
  } else if (id === 'pack-add-settings') {
    addPack([...document.querySelectorAll('input[name="pack-pick-settings"]:checked')].map((x) => x.value));
  } else if (id === 'pack-later') {
    prefs.packDismissed = pack.items.filter((i) => !i.installed).map((i) => i.name).join(',');
    savePrefs();
    renderPack();
  } else if (id === 'pack-ok') {
    packNote = '';
    renderPack();
  }
});

loadPack();

// ---- the Meadow: agents as creatures -------------------------------------------------

const meadow = createMeadow({
  bridge,
  prefs,
  savePrefs,
  getSnapshot: () => snapshot,
  getLight: () => ({ theme: themeFor(prefs.theme, shownPhase ?? phase()), phase: shownPhase ?? phase() }),
  onEnter: () => {
    if (decorating) setDecorating(false);
    if (buildMode) setBuildMode(false);
  },
});

// ---- settings panel ------------------------------------------------------------

function setSettings(open) {
  $('settings').hidden = !open;
  $('settings-open').setAttribute('aria-expanded', String(open));
  if (open) {
    showUpdateInfo();
    $('settings-close').focus();
  }
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
renderLive();
refreshLive();
render(true);
setInterval(render, 250);
