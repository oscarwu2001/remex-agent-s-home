import {
  buildScene, labelPoint, slotPoint, routeTo, spawnPoint, LAYOUT, targetHeights, setHeights, workSpot, routeBetween, floorOutline, roomFrame, configureRooms, cellOutline,
  gardenTile, gardenOutline, gardenFrame, gardenPlot, plantPreview, plantThumb, floorThumb,
  roomItems, itemSize, roomTile, itemPreview, itemThumb, doorwayTiles,
} from './scene.js';
import { P } from './iso.js';
import { BLOSSOMING } from './decor.js';
import { setView } from './iso.js';
import { Person, bubbleMarkup } from './people.js';
import { demoSnapshot } from './demo.js';
import { overview as runningOverview, headline, headlineBadges, badge, runningBadge, helperBadge, todoPips, SOURCE_NAMES } from './overview.js';
import { statusText, activityText, glyphKey, elapsed } from './status.js';
import { projectsHtml, wireProjects, demoProjects, demoTrees, paint } from './projects-view.js';
import { installTips } from './tip.js';
import { waitingList, waitingHtml, waitText, waitFor, waitKey, endedWork, loadDismissed, dismissWait, clashHtml } from './waiting.js';
import { jobsHtml, machineHtml, workHtml } from './jobs-view.js';
import { fieldHtml, fieldSheetHtml, fieldSettingsHtml, rolesFrom, stepRows, draftWith, dropFieldDrafts, FIXES, problemLabel, age as fieldAge } from './field-view.js';
import { lineHtml, lineSettingsHtml, lineSummary, lineSheetHtml, folderChoices, statusHtml, sendDraft, takeEdits, sendStatus, nextFocus, dropLineBotDrafts, dropLineDrafts, keepFileNames } from './line-view.js';
import { tr, trHtml, raw, hasWords, textWidth, localise, setLanguage, language, LANGUAGES, resolveLanguage, onMissing, said, english } from './i18n.js';
import { placeWords, gardenWords } from './places.js';
import { clockTime } from './dates.js';

installTips();
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
let liveMapFor; // the session whose live map is open
let liveMapSig = '';
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
  budget5h: 0, notify: true, waitMin: 5, notifyEnds: true,
  private: true, names: true, theme: DEFAULT_THEME, time: 'auto', detail: 'simple', weather: 'clear', view: 0, demo: false,
  live: { on: false, place: null, unit: 'celsius' },
};
let saved = {};
let prefsUnreadable = false;
try {
  saved = JSON.parse(localStorage.getItem('agents-home-prefs') || '{}') ?? {};
  Object.assign(prefs, saved);
} catch {
  // Storage unavailable or unreadable: defaults stand, and the language,
  // which falls back to Windows', says so under Needs attention.
  prefsUnreadable = true;
}
// The language: the one picked in Settings, else Windows' (Chromium's own
// locale, which follows it). Switching reloads both windows.
const startLanguage = resolveLanguage({ saved: saved.language, unreadable: prefsUnreadable, system: navigator.languages });
setLanguage(startLanguage.id);
if (startLanguage.from !== 'saved') delete prefs.language; // keeps following Windows until one is picked
onMissing((code, key) => bridge.missingWords?.({ lang: code, key })?.catch(() => {
  // An older main process without the handler: the word has already fallen
  // back to English, which is all a missing word can do here.
}));
// The main process draws the system's own dialogs (Choose a folder) in it.
bridge.useLanguage?.(startLanguage.id)?.catch(() => {
  // An older main process: its dialogs stay English, as every word falls back.
});
localise(document);
if (new URLSearchParams(location.search).get('demo') === '1') prefs.demo = true;
if (!THEMES[prefs.theme]) prefs.theme = DEFAULT_THEME; // e.g. the retired night mode
if (prefs.detail !== 'simple' && prefs.detail !== 'detailed') prefs.detail = 'simple';
if ('night' in prefs) {
  // The old Night switch becomes a fixed night; otherwise follow the clock.
  if (prefs.night && saved.time === undefined) prefs.time = 'night';
  delete prefs.night;
}
if (prefs.time !== 'auto' && !PHASES.some((p) => p.id === prefs.time)) prefs.time = 'auto';
const WEATHERS = ['clear', 'cloudy', 'rain', 'snow', 'fog'];
const weatherName = (w) => tr(`weather.${w}`);
if (!WEATHERS.includes(prefs.weather) && prefs.weather !== 'changing') prefs.weather = 'clear';
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
    return true;
  } catch {
    // Not persisted this time; the toggle still applies. The language,
    // which needs a reload to apply, says so instead (see opt-language).
    return false;
  }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.time = phase() === 'night' ? 'night' : 'day';
  document.documentElement.dataset.phase = phase();
  document.documentElement.dataset.weather = weather();
  $('weather').className = `weather ${weather()}`;
  $('opt-weather').value = prefs.weather;
  $('opt-weather').options[5].textContent = tr('weather.changingNow', { weather: weatherName(weather(new Date())).toLowerCase() });
  document.body.classList.toggle('no-tags', !prefs.names);
  $('opt-private').checked = prefs.private;
  $('opt-names').checked = prefs.names;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === prefs.theme;
  for (const r of document.querySelectorAll('input[name="detail"]')) r.checked = r.value === prefs.detail;
  $('opt-demo').checked = prefs.demo;
  const sel = $('opt-time');
  sel.value = prefs.time;
  sel.options[0].textContent = tr('time.autoNow', { phase: tr(`phase.${phaseAt(new Date())}`).toLowerCase() });
}

for (const [id, key] of [['opt-private', 'private'], ['opt-names', 'names'], ['opt-demo', 'demo']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.checked;
    if (key === 'demo') demoEpoch = Date.now();
    // A link typed but not saved shows no more once privacy mode is on.
    if (key === 'private' && prefs.private) {
      forgetFieldDrafts();
      forgetLineBotDrafts();
    }
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

// The language, picked at the top of Settings and saved with the other
// preferences. A pick reloads this window (and the mini window, which
// follows the storage); Settings opens again at the Language field.
const REOPEN_LANGUAGE = 'agents-home-reopen-language';
{
  const pick = $('opt-language');
  pick.innerHTML = LANGUAGES.map((l) => `<option value="${l.id}" lang="${l.html}">${escapeXml(l.name)}</option>`).join('');
  pick.value = language();
  const note = $('language-note');
  if (startLanguage.unreadable) {
    note.textContent = tr('language.unreadable');
    note.hidden = false;
  }
  pick.addEventListener('change', () => {
    prefs.language = pick.value;
    if (!savePrefs()) {
      if (startLanguage.from === 'saved') prefs.language = language();
      else delete prefs.language;
      pick.value = language();
      note.textContent = tr('language.notSaved');
      note.hidden = false;
      return;
    }
    note.textContent = tr('language.reloading');
    note.hidden = false;
    try {
      sessionStorage.setItem(REOPEN_LANGUAGE, '1');
    } catch {
      // Settings just opens closed after the reload; the language is saved.
    }
    // The app's windows never navigate themselves: the main process reloads
    // them. The browser preview reloads its own page.
    if (!bridge.useLanguage) {
      location.reload();
      return;
    }
    bridge.useLanguage(pick.value, { reload: true })
      .then((res) => { if (!res?.ok) throw new Error(res?.error); })
      .catch(() => { note.textContent = tr('language.restart'); });
  });
}

// The time, the part of the day and the weather, bottom right of the map.
// Only the computer's clock is read.
function showClock() {
  const now = new Date();
  const hm = clockTime(now);
  const part = tr(`phase.${phase()}`);
  const real = liveReading();
  const temp = real ? ` · ${real.temperature}${real.unit}` : '';
  const off = prefs.live.on && prefs.live.place && !real ? ` · ${tr('clock.unavailable')}` : '';
  $('clock').innerHTML = `<span class="now">${escapeXml(hm)}</span>${escapeXml(part)} · ${escapeXml(weatherName(weather()))}${escapeXml(temp)}${escapeXml(off)}`;
  $('clock').title = real && prefs.live.place ? tr('clock.weatherIn', { place: placeName(prefs.live.place) }) : '';
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
    liveError = said(res.error);
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
  $('live-hint').textContent = tr(!online ? 'live.preview' : prefs.live.on ? 'live.on' : 'live.off');
  if (!prefs.live.on) return;
  if (!prefs.live.place) {
    body.innerHTML = `
      <form class="add-row" id="live-search"><label class="visually-hidden" for="live-q">${escapeXml(tr('live.town'))}</label>
        <input id="live-q" type="search" placeholder="${escapeXml(tr('live.townPlaceholder'))}" autocomplete="off">
        <button class="button" type="submit">${escapeXml(tr('live.find'))}</button></form>
      ${liveError ? `<p class="form-error" role="alert">${escapeXml(liveError)}</p>` : ''}
      <ul class="live-results">${liveResults.map((p, i) => `<li><button type="button" class="link-btn" data-place="${i}">${escapeXml(placeName(p))}</button></li>`).join('')}</ul>`;
    return;
  }
  const real = liveReading();
  const status = liveError ? `<p class="form-error" role="alert">${escapeXml(tr('live.error', { error: liveError }))}</p>`
    : real ? `<p class="hint">${escapeXml(tr('live.now', { weather: weatherName(real.weather).toLowerCase(), temp: `${real.temperature}${real.unit}`, time: new Date(real.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))}</p>`
      : `<p class="hint">${escapeXml(tr('live.checking'))}</p>`;
  body.innerHTML = `
    <p class="live-place">${escapeXml(placeName(prefs.live.place))} <button type="button" class="link-btn" id="live-change">${escapeXml(tr('live.change'))}</button></p>
    <label class="field" for="live-unit">${escapeXml(tr('live.unit'))}
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
  liveError = res.ok ? (res.places.length ? '' : tr('live.notFound', { q: q.trim() })) : tr('live.searchFailed', { error: said(res.error) });
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
          aria-label="${escapeXml(tr('spot.build', { spot: spotName(cell) }))}">
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
      const { name, purpose } = placeWords(r);
      // Sentence-case signs: about 11px a letter for the name, 9px for the
      // purpose, and a whole em for each Chinese character.
      const w = Math.max(textWidth(name, 11.5, 20), textWidth(purpose, 9.2, 15.5)) + 40;
      return `<g class="room-label" data-room="${r.id}" role="button" tabindex="0"
          aria-label="${escapeXml(tr('scene.visit', { place: name }))}" data-x="${x.toFixed(1)}" data-y="${(y + 28).toFixed(1)}">
        <rect x="${-w / 2}" y="-24" width="${w}" height="56" rx="28"/>
        <text class="name" text-anchor="middle" y="1">${escapeXml(name)}</text>
        <text class="purpose" text-anchor="middle" y="22">${escapeXml(purpose)}</text></g>`;
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
            aria-label="${tr('scene.tile', { i: i + 1, j: j + 1 })}" points="${pointsOf(gardenTile(g.id, i, j))}"><title>${tr('scene.tile', { i: i + 1, j: j + 1 })}</title></polygon>`;
        }
      }
      return tiles;
    }
    return `<polygon class="garden-hit" data-garden="${g.id}" points="${pointsOf(gardenOutline(g.id))}"><title>${escapeXml(tr('scene.visit', { place: gardenName(g.id) }))}</title></polygon>`;
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
        aria-label="${tr('scene.tile', { i: i + 1, j: j + 1 })}" points="${pointsOf(roomTile(focusedRoom, i, j))}"><title>${tr('scene.tile', { i: i + 1, j: j + 1 })}</title></polygon>`;
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
  $('cam-where').textContent = focusedRoom ? tr('cam.in', { place: roomName(focusedRoom) })
    : focusedGarden ? tr('cam.in', { place: gardenName(focusedGarden) }) : zoomed ? tr('cam.zoomed') : '';
  $('cam-where').hidden = !zoomed;
  const place = focusedRoom || focusedGarden;
  $('cam-decorate').hidden = !place || !bridge.saveDecor;
  $('cam-decorate').setAttribute('aria-expanded', String(decorating));
  $('cam-decorate').textContent = tr(focusedGarden ? 'decor.plant' : 'decor.decorate');
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
  if (e.button === 0 && startAgentDrag(e)) return;
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
    // A panel open over the board closes first, even when focus has fallen
    // to the page (a click on its text): the map stays where it is.
    if (!$('field-sheet').hidden) setFieldSheet(false);
    else if (!$('settings').hidden) setSettings(false);
    else if (liveMapFor) openLiveMap(undefined);
    else if (decorating) setDecorating(false);
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
  if (agentDrag?.moved) return; // the click that ends a drag is not a selection
  const p = people.get(key);
  if (key.startsWith('r:') && p?.busyWith) key = p.busyWith;
  selected = selected === key ? undefined : key;
  for (const [k, p] of people) p.el.classList.toggle('selected', k === selected);
  render(true);
}

svg.addEventListener('click', (e) => {
  if (drag?.moved || agentDrag?.moved) return;
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
  // A drag takes effect at once (the roster catches up on its next read),
  // unless rooms.json places that agent: rooms.json always wins.
  for (const [name, room] of Object.entries(config.layout?.moves ?? {})) {
    if (list.has(name) && !(config.pinned ?? []).includes(name)) list.set(name, room);
  }
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
  return ROOM_NAMES[id] ? placeWords(ROOM_NAMES[id]).name : id;
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
  const tokenText = [tokens ? tr('row.tokens', { n: compact(tokens) }) : '', ctx !== undefined ? tr('row.context', { pct: ctx }) : ''].filter(Boolean).join(' · ');
  const nearlyFull = ctx !== undefined && ctx >= CONTEXT_WARN * 100;
  const detail = !prefs.private && x.activity?.detail ? ` · ${x.activity.detail}` : '';
  const warn = x.status === 'blocked' || glyphKey(x) === 'failed';
  const turn = x.status === 'your-turn';
  const who = sub ? tr('row.inRoom', { name, room: roomName(x.room) }) : name;
  // Where a session runs, when it is not plain Claude Code on this computer.
  const tag = !sub && x.source && x.source !== 'code' ? `<span class="tag tag-${escapeXml(x.source)}">${escapeXml(SOURCE_NAMES[x.source] ?? x.source)}</span>` : '';
  const todo = !sub && x.todos?.total ? `<span class="todo-count">${todoPips(x.todos)}</span>` : '';
  return `<button class="row${sub ? ' sub' : ''}" data-key="${escapeXml(key)}" aria-pressed="${key === selected}"
      title="${escapeXml(`${tr('helper.status', { type: who, status: what + detail })}${tokens ? ` · ${tr(sub ? 'row.tokens' : 'row.tokensWithHelpers', { n: tokens.toLocaleString() })}` : ''}`)}">
      ${glyph(x)}
      <span class="who"><span class="name"><span class="n">${escapeXml(name)}</span></span>
        <span class="what${warn ? ' warn' : turn ? ' turn' : ''}">${tag}${escapeXml(what + detail)}</span>${todo}</span>
      <span class="when"><span class="time" data-since="${x.startedAt}">${elapsed(x.startedAt, Date.now())}</span>
        ${tokenText ? `<span class="tokens">${tokenText}</span>` : ''}</span>
      ${nearlyFull ? `<span class="ctx-warn">${escapeXml(tr('row.ctxFull', { pct: ctx }))}</span>` : ''}
    </button>`;
}

// "Running now": this computer's sessions as cards (each with its helpers),
// grouped by where they run, then the other computers' projects as rows.
function renderSessions(s) {
  const o = runningOverview(s.sessions, s.here ?? tr('common.thisComputer'), s.fleet?.computers ?? [], { jobs: s.jobs ?? [], machine: s.machine, work: s.work ?? [] });
  const others = o.computers.filter((c) => !c.local);
  if (!s.sessions.length && !others.length && !(s.jobs ?? []).length && !(s.work ?? []).length) {
    const watching = s.watcher.roots.find((r) => r.state === 'ok');
    return `<p class="empty">${trHtml('board.emptyHtml', { noFolder: watching ? '' : tr('board.noFolder') })}</p>
      <button class="button" id="start-demo" type="button">${escapeXml(tr('board.showDemo'))}</button>`;
  }
  const card = (sess) => {
    const helpers = sess.agents.map((a) => rowHtml(`a:${a.id}`, a, a.type, true)).join('');
    return `<div class="card">${rowHtml(`s:${sess.id}`, sess, sess.project, false)}${helpers}</div>`;
  };
  const many = o.computers.length > 1;
  const local = o.computers.filter((c) => c.local).map((c) => {
    const cards = c.projects.flatMap((p) => p.sessions).map(card).join('') + jobsHtml(c.jobs) + workHtml(c.work);
    const load = machineHtml(c.machine);
    if (!cards && !load) return '';
    return many || load ? `<p class="computer-head"><span class="computer-name">${escapeXml(c.computer)}</span><span class="computer-state">${escapeXml(tr('common.thisComputer'))}</span></p>${load}${cards}` : cards;
  }).join('');
  const hm = (t) => new Date(t).toTimeString().slice(0, 5);
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? tr('time.minAgo', { n: m }) : m < 2880 ? tr('time.hAgo', { n: Math.round(m / 60) }) : tr('time.dAgo', { n: Math.round(m / 1440) }); };
  const remote = others.map((c) => {
    const state = !c.online ? tr('fleet.offlineSince', { time: hm(c.at) }) : c.every ? tr('fleet.posted', { time: hm(c.at) }) : tr('fleet.online');
    // Projects with sessions in the last post, then those with only git news.
    const names = [...new Set([...c.projects.map((p) => p.project), ...(c.repos ?? []).map((r) => r.project)])];
    const projects = names.map((name) => {
      const p = c.projects.find((x) => x.project === name);
      const r = (c.repos ?? []).find((x) => x.project === name);
      const live = p?.running ? runningBadge(p.running) : p ? badge('session', p.sessions.length, tr('fleet.sessionsHour', { n: p.sessions.length }), { quiet: true }) : '';
      const git = r ? [r.branch, r.lastCommit ? tr('proj.committed', { ago: ago(r.lastCommit) }) : '', r.changed ? tr('proj.uncommitted', { n: r.changed }) : ''].filter(Boolean).join(' · ') : '';
      return `<li class="proj"><span class="proj-name">${escapeXml(name)}${git ? `<span class="proj-git" title="${escapeXml(git)}">${escapeXml(git)}</span>` : ''}</span>
        <span class="badges">${live || `<span class="idle" title="${escapeXml(tr('fleet.noSession'))}"><span aria-hidden="true">–</span><span class="visually-hidden">${escapeXml(tr('fleet.noSession'))}</span></span>`}${p?.helpers ? helperBadge(p.helpers) : ''}</span></li>`;
    }).join('');
    return `<div class="computer${c.online ? '' : ' offline'}">
        <p class="computer-head"><span class="computer-name">${escapeXml(c.computer)}</span><span class="computer-state">${escapeXml(state)}</span></p>
        ${machineHtml(c.machine)}${jobsHtml(c.jobs)}${workHtml(c.work)}
        ${projects ? `<ul class="projects">${projects}</ul>` : (c.jobs ?? []).length || (c.work ?? []).length ? '' : `<p class="hint">${escapeXml(tr('fleet.noSessions'))}</p>`}</div>`;
  }).join('');
  const share = s.fleet?.on || s.demo ? '' : `<p class="hint">${trHtml('fleet.shareHtml', { link: raw(`<button type="button" class="link-btn inline" data-settings="fleet-h">${escapeXml(tr('fleet.shareLink'))}</button>`) })}</p>`;
  return `${local || `<p class="hint">${escapeXml(tr('board.nothingHere'))}</p>`}${remote}${share}`;
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
    [tr('chart.name'), name],
    [tr('chart.room'), roomName(room)],
    [tr('chart.status'), statusText(x)],
    parent ? [tr('chart.calledBy'), parent] : null,
    !parent && x.source ? [tr('chart.runsIn'), x.computer ? tr('common.on', { what: SOURCE_NAMES[x.source] ?? x.source, computer: x.computer }) : SOURCE_NAMES[x.source] ?? x.source] : null,
    !parent && x.title && !prefs.private ? [tr('chart.task'), x.title] : null,
    !prefs.private && x.description ? [tr('chart.task'), x.description] : null,
    x.background ? [tr('chart.mode'), tr('chart.background')] : null,
    x.startedAt ? [tr('chart.since'), clock(x.startedAt)] : null,
    x.errors ? [tr('chart.errors'), String(x.errors)] : null,
    x.tokens?.total ? [tr('chart.tokens'), tr('chart.tokenParts', { total: x.tokens.total.toLocaleString(), input: x.tokens.input.toLocaleString(), output: x.tokens.output.toLocaleString(), read: x.tokens.cacheRead.toLocaleString(), write: x.tokens.cacheWrite.toLocaleString() })] : null,
    !parent && x.tokensWithHelpers > (x.tokens?.total ?? 0) ? [tr('chart.withHelpers'), tr('row.tokens', { n: x.tokensWithHelpers.toLocaleString() })] : null,
  ].filter(Boolean);
  const history = [...x.history].reverse()
    .map((h) => `<li><span class="t">${clock(h.ts)}</span>
        <span>${escapeXml(activityText(h))}${!prefs.private && h.detail ? `<span class="d"> · ${escapeXml(h.detail)}</span>` : ''}</span></li>`)
    .join('');
  // Idle staff can be sent to another room: from here, or by dragging.
  const moveTo = found.resident && !people.get(`r:${name}`)?.busyWith
    ? `<label class="field move-to" for="move-to">${escapeXml(tr('chart.moveTo'))}
        <select id="move-to" data-agent="${escapeXml(name)}">${config.rooms.filter((r) => LAYOUT[r.id]).map((r) => `<option value="${r.id}" ${r.id === room ? 'selected' : ''}>${escapeXml(placeWords(r).name)}</option>`).join('')}</select></label>`
    : '';
  return `<dl>${rows.map(([k, v]) => `<dt>${escapeXml(k)}</dt><dd>${escapeXml(v)}</dd>`).join('')}</dl>${moveTo}${!parent ? todoListHtml(x.todos) : ''}
    <ol aria-label="${escapeXml(tr('chart.recent'))}">${history || `<li><span class="t">—</span><span>${escapeXml(tr(found.resident ? 'chart.standingBy' : 'chart.noTools'))}</span></li>`}</ol>`;
}

// A session's to-do list. The wording is the user's own, so with privacy
// mode on only the counts show.
function todoListHtml(todos) {
  if (!todos?.total) return '';
  const head = `<p class="todo-head">${escapeXml(tr(todos.doing ? 'todo.headDoing' : 'todo.head', { done: todos.done, total: todos.total, doing: todos.doing }))}</p>`;
  if (prefs.private) return `${head}<p class="hint">${escapeXml(tr('todo.private'))}</p>`;
  const items = todos.items.map((t) => `<li class="todo ${t.status}"><span class="todo-mark" aria-hidden="true"></span>
      <span>${escapeXml(t.status === 'in_progress' && t.active ? t.active : t.text || tr('todo.untitled'))}</span><span class="visually-hidden"> (${escapeXml(tr(`todo.${t.status}`))})</span></li>`).join('');
  return `${head}<ol class="todos">${items}</ol>`;
}

// The headline badges of "Running now", and what makes them change.
function renderRunning(s) {
  const o = runningOverview(s.sessions, s.here ?? tr('common.thisComputer'), s.fleet?.computers ?? [], { jobs: s.jobs ?? [], machine: s.machine, work: s.work ?? [] });
  const key = JSON.stringify([headline(o), o.computers.map((c) => [c.computer, c.online, c.projects.map((p) => [p.project, p.running, p.sessions.length, p.helpers]),
    (c.jobs ?? []).map((j) => [j.name, j.state, j.step, j.epoch, j.updatedAt]), c.machine, (c.work ?? []).map((w) => [w.name, Math.floor((Date.now() - w.startedAt) / 60_000)])])]);
  return { head: headline(o), badges: headlineBadges(o), key };
}

function renderCensus(s) {
  const n = s.sessions.length;
  const helpers = s.sessions.reduce((k, x) => k + x.agents.filter((a) => a.status !== 'done').length, 0);
  const waiting = s.sessions.filter((x) => x.status === 'your-turn').length;
  const blocked = s.sessions.reduce((k, x) => k + (x.status === 'blocked') + x.agents.filter((a) => a.status === 'blocked').length, 0);
  const parts = [tr('overview.sessions', { n }), tr('census.helpers', { n: helpers })];
  if (waiting) parts.push(tr('census.waiting', { n: waiting }));
  const full = s.sessions.filter((x) => x.context?.pct >= CONTEXT_WARN).length;
  if (full) parts.push(tr('census.full', { n: full }));
  if (blocked) parts.push(tr('census.blocked', { n: blocked }));
  const tokens = s.sessions.reduce((k, x) => k + (x.tokensWithHelpers ?? x.tokens?.total ?? 0), 0);
  if (tokens) parts.push(tr('row.tokens', { n: compact(tokens) }));
  return s.demo ? tr('census.demo', { rest: parts.join(' · ') }) : parts.join(' · ');
}

// Folder paths carry the user name, so they only show with privacy off.
function renderSource(s) {
  if (s.demo) return tr('source.demo');
  const roots = s.watcher.roots;
  if (!roots.length) return tr('source.connecting');
  const where = (list) => (prefs.private ? tr('source.private') : list.map((r) => r.path).join(tr('common.listSep')));
  const ok = roots.filter((r) => r.state === 'ok');
  const n = s.watcher.filesTailed;
  if (ok.length) return tr('source.watching', { where: where(ok), n });
  if (roots.every((r) => r.state === 'missing')) return tr('source.none', { where: where(roots) });
  return tr('source.cannot', { where: where(roots) });
}

// A transcripts folder's state in words ("unreadable: EACCES", "not a folder").
function folderState(state) {
  const m = /^unreadable: (.*)$/.exec(state);
  if (m) return tr('folderState.unreadable', { code: m[1] });
  return state === 'not a folder' ? tr('folderState.notFolder') : state;
}

// Each problem: a label that is safe on a shared screen, and a detail
// (paths, file names) that shows only with privacy off.
function renderProblems(s) {
  const list = (s.problems || []).map((p) => ({
    label: problemLabel(p, { privacy: prefs.private }),
    detail: p.detail,
    fix: FIXES[p.fix] || p.fix === 'line' ? p.fix : null, // 'line': LINE chats' own Settings
  }));
  for (const r of s.watcher.roots || []) {
    if (r.state !== 'ok' && r.state !== 'missing' && r.state !== 'pending') {
      list.push({ label: tr('problem.folder', { state: folderState(r.state) }), detail: r.path });
    }
  }
  const st = s.stats;
  if (st.malformedLines) {
    list.push({
      label: tr('problem.malformed', { n: st.malformedLines }),
      detail: st.lastProblem ? tr('problem.last', { what: st.lastProblem }) : '',
    });
  }
  if (st.unlinkedSidechains) {
    const n = st.unlinkedSidechains;
    list.push({ label: tr('problem.unlinked', { n }) });
  }
  if (st.unmatchedRelays) {
    const n = st.unmatchedRelays;
    list.push({ label: tr('problem.unmatchedRelays', { n }) });
  }
  if (homeless) {
    list.push({ label: tr('problem.homeless', { n: homeless, ward: tr('room.general-ward.name') }) });
  }
  if (st.untimedEntries) {
    list.push({ label: tr('problem.untimed', { n: st.untimedEntries }) });
  }
  if (st.strayNotifications) {
    const n = st.strayNotifications;
    list.push({ label: tr('problem.stray', { n }) });
  }
  if (startLanguage.unreadable) list.push({ label: tr('language.unreadable') });
  return list;
}

function renderDirectory(s) {
  const roster = s.roster || [];
  $('directory-count').textContent = roster.length ? `(${roster.length})` : '';
  $('directory-list').innerHTML = roster.length
    ? roster.map((a) => `<li><span class="agent">${escapeXml(a.name)}</span> · <span class="room">${escapeXml(roomName(a.room))}</span>
        <span class="summary">${escapeXml(a.summary || '')}</span></li>`).join('')
    : `<li>${trHtml('board.noAgentsHtml')}</li>`;
}

function render(force = false) {
  snapshot = prefs.demo ? demoSnapshot(Date.now(), demoEpoch) : liveSnapshot;
  checkWarnings(snapshot);
  syncPeople(snapshot);

  const chart = renderChart(snapshot);
  const problems = renderProblems(snapshot);
  const running = renderRunning(snapshot);
  const signature = JSON.stringify([
    snapshot.sessions.map((x) => [x.id, x.status, x.activity?.label, x.activity?.detail, compact(x.tokensWithHelpers ?? 0),
      x.agents.map((a) => [a.id, a.status, a.activity?.label, a.activity?.detail, compact(a.tokens?.total ?? 0)])]),
    chart, problems, (snapshot.roster || []).length, selected, prefs.private, warnings,
    snapshot.usage ? [snapshot.usage.last5h.total, snapshot.usage.today.total, snapshot.usage.limitNotice?.ts, prefs.budget5h] : null,
    snapshot.sessions.map((x) => Math.round((x.context?.pct ?? 0) * 100)),
    snapshot.sessions.map((x) => (x.todos ? [x.todos.done, x.todos.total, x.todos.doing] : 0)),
    running.key, snapshot.fleet?.on,
  ]);
  renderLiveMap();
  // The waiting list moves on its own (the minutes), so it is drawn every tick.
  paint($('waiting'), clashHtml(snapshot.clashes) + waitingHtml(waitingList(snapshot.sessions, loadDismissed()), Date.now(), glyph));
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  // Re-render, then put keyboard focus back where it was.
  const focusKey = document.activeElement?.dataset?.key;
  $('sessions').innerHTML = renderSessions(snapshot);
  $('census').textContent = renderCensus(snapshot);
  renderProjects();
  renderField();
  renderLine();
  $('running-head').innerHTML = `<span class="badges">${running.badges}</span>`;
  renderUsage(snapshot);
  $('source').textContent = renderSource(snapshot);
  $('chart').hidden = !chart;
  if (chart) $('chart-body').innerHTML = chart;
  $('problems').hidden = problems.length === 0;
  $('problem-list').innerHTML = problems
    // A fix button keeps its focus across redraws by its data-key.
    // LINE chats' fix opens its Settings (data-settings); the others are field feedback's.
    .map((p, i) => `<li>${keepFileNames(escapeXml(p.label))}${!prefs.private && p.detail ? `<span class="d"> · ${escapeXml(p.detail)}</span>` : ''}${p.fix === 'line' ? ` <button type="button" class="link-btn" data-settings="line-settings-h" data-key="problem-fix-${i}">${escapeXml(tr('fix.settings'))}</button>` : p.fix ? ` <button type="button" class="link-btn" data-field="${p.fix}" data-key="problem-fix-${i}">${FIXES[p.fix]}</button>` : ''}</li>`)
    .join('');
  renderDirectory(snapshot);
  if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

$('sessions').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) {
    const key = row.dataset.key;
    select(key);
    // A session, or one of its helpers: show that session's live map; the
    // same row clicked again closes it.
    const sess = snapshot.sessions.find((x) => `s:${x.id}` === key || x.agents.some((a) => `a:${a.id}` === key));
    openLiveMap(sess && selected ? sess.id : undefined);
  }
  if (e.target.id === 'start-demo') {
    prefs.demo = true;
    demoEpoch = Date.now();
    savePrefs();
    applyPrefs();
    render(true);
  }
});

// ---- moving idle staff to another room ----------------------------------------------
//
// Press on an idle agent standing at its post, drag it onto another room and
// let go: it walks over and works there from now on (saved with the layout,
// like a department's agents). Busy agents finish where they are first.

let agentDrag; // { name, p, x, y, moved, ghost, over }
let moveNote = '';

function startAgentDrag(e) {
  const el = e.target.closest('.person');
  const key = el?.dataset.id;
  if (!key?.startsWith('r:') || decorating || buildMode) return false;
  const p = people.get(key);
  if (!p || p.busyWith || p.leaving) return false;
  agentDrag = { name: key.slice(2), p, x: e.clientX, y: e.clientY, moved: false };
  e.preventDefault(); // no text selection while dragging
  return true;
}

function roomAt(x, y) {
  const hit = document.elementsFromPoint(x, y).find((el) => el.classList?.contains('room-hit'));
  return hit?.dataset.room;
}

window.addEventListener('pointermove', (e) => {
  if (!agentDrag) return;
  if (!agentDrag.moved && Math.hypot(e.clientX - agentDrag.x, e.clientY - agentDrag.y) < 6) return;
  if (!agentDrag.moved) {
    agentDrag.moved = true;
    agentDrag.ghost = agentDrag.p.el.cloneNode(true);
    agentDrag.ghost.classList.add('drag-ghost');
    agentDrag.ghost.removeAttribute('tabindex');
    agentDrag.ghost.setAttribute('aria-hidden', 'true');
    peopleLayer.appendChild(agentDrag.ghost);
    agentDrag.p.el.classList.add('being-moved');
    svg.classList.add('moving-agent');
    document.body.classList.add('no-select');
  }
  const m = peopleLayer.getScreenCTM();
  if (m) {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    agentDrag.ghost.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${(pt.y + 20).toFixed(1)}) scale(1.3)`);
  }
  const over = roomAt(e.clientX, e.clientY);
  if (over !== agentDrag.over) {
    document.querySelectorAll('.room-hit.drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (over && over !== agentDrag.p.roomId) document.querySelector(`.room-hit[data-room="${CSS.escape(over)}"]`)?.classList.add('drop-target');
    agentDrag.over = over;
  }
});

window.addEventListener('pointerup', (e) => {
  if (!agentDrag) return;
  const d = agentDrag;
  if (d.moved) {
    d.ghost.remove();
    d.p.el.classList.remove('being-moved');
    svg.classList.remove('moving-agent');
    document.body.classList.remove('no-select');
    document.querySelectorAll('.room-hit.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const to = roomAt(e.clientX, e.clientY);
    if (to && to !== d.p.roomId) moveAgent(d.name, to);
    // Let the click that follows the release pass before selections resume.
    setTimeout(() => { agentDrag = undefined; }, 0);
  } else {
    agentDrag = undefined;
  }
});

// Sends an agent to work in a room: a department takes it on its list; any
// other room records a move. Saved like the rest of the layout.
async function moveAgent(name, roomId) {
  if ((config.pinned ?? []).includes(name)) {
    moveNote = tr('move.pinned', { name });
    render(true);
    return;
  }
  const depts = config.layout.departments.map((d) => ({ ...d, agents: new Set(d.agents) }));
  for (const d of depts) d.agents.delete(name);
  const moves = { ...(config.layout.moves ?? {}) };
  delete moves[name];
  const dept = depts.find((d) => d.id === roomId);
  if (dept) dept.agents.add(name);
  else moves[name] = roomId;
  const plain = depts.map(({ id, kind, name: n, purpose, cell, agents }) => ({ id, kind, name: n, purpose, cell, agents: [...agents] }));
  const result = await bridge.saveLayout({ departments: plain, gardens: config.layout.gardens ?? [], moves });
  moveNote = result.ok ? tr('move.done', { name, room: roomName(roomId) }) : tr('move.failed', { name, error: said(result.error) });
  if (result.ok) useConfig(result.config);
  $('move-status').textContent = moveNote;
  render(true);
}

$('chart-body').addEventListener('change', (e) => {
  if (e.target.id === 'move-to') moveAgent(e.target.dataset.agent, e.target.value);
});

// ---- live map: one session and everything it has called ---------------------------

function openLiveMap(id) {
  liveMapFor = id;
  liveMapSig = '';
  $('live-map').hidden = !id;
  renderLiveMap();
}

$('live-map-close').addEventListener('click', () => {
  const back = liveMapFor && document.querySelector(`[data-key="${CSS.escape(`s:${liveMapFor}`)}"]`);
  openLiveMap(undefined);
  back?.focus();
});

function mapStep(st) {
  if (st.kind === 'skill') {
    return `<li class="map-step skill${st.active ? ' live' : ''}">
      <span class="skill-mark" aria-hidden="true"></span><span class="name">/${escapeXml(st.name)}</span>
      <span class="what">${escapeXml(tr(st.active ? 'board.running' : 'map.used'))}</span></li>`;
  }
  const live = st.status !== 'done';
  const detail = live && !prefs.private && st.activity?.detail ? ` · ${st.activity.detail}` : '';
  const time = live ? `<span class="time" data-since="${st.startedAt}">${elapsed(st.startedAt, Date.now())}</span>`
    : st.endedAt ? `<span class="time">${elapsed(st.startedAt, st.endedAt)}</span>` : '';
  const skills = st.skills?.length ? `<ol>${st.skills.map((k) => mapStep({ kind: 'skill', ...k })).join('')}</ol>` : '';
  return `<li class="map-step agent${live ? ' live' : ''}">
    ${glyph(st)}<span class="name">${escapeXml(st.type)}${st.background ? ` <small>${escapeXml(tr('map.background'))}</small>` : ''}</span>
    <span class="what${glyphKey(st) === 'failed' || st.status === 'blocked' ? ' warn' : ''}">${live ? `<strong>${escapeXml(tr('map.runningNow'))}</strong> ` : ''}${escapeXml(statusText(st) + detail)}</span>
    <span class="meta">${time}${st.tokens ? `<span>${escapeXml(tr('row.tokens', { n: compact(st.tokens) }))}</span>` : ''}</span>${skills}</li>`;
}

function renderLiveMap() {
  if (!liveMapFor) return;
  const sess = snapshot.sessions.find((x) => x.id === liveMapFor);
  const steps = sess?.map?.steps ?? sess?.agents.map((a) => ({ kind: 'agent', ...a, tokens: a.tokens?.total })) ?? [];
  const sig = JSON.stringify([sess && [sess.status, sess.activity?.label, sess.activity?.detail], steps.map((st) =>
    [st.kind, st.name ?? st.id, st.status, st.endReason, st.activity?.label, st.activity?.detail, st.active, compact(st.tokens ?? 0), st.skills?.map((k) => k.active)]), prefs.private]);
  if (sig === liveMapSig) return;
  liveMapSig = sig;
  const body = $('live-map-body');
  if (!sess) {
    body.innerHTML = `<p class="hint">${escapeXml(tr('map.gone'))}</p>`;
    return;
  }
  const agents = steps.filter((st) => st.kind === 'agent');
  const running = agents.filter((a) => a.status !== 'done').length + steps.filter((st) => st.kind === 'skill' && st.active).length
    + agents.reduce((n, a) => n + (a.skills ?? []).filter((k) => k.active).length, 0);
  const failed = agents.filter((a) => glyphKey(a) === 'failed').length;
  const finished = agents.filter((a) => a.status === 'done').length - failed;
  const skills = steps.filter((st) => st.kind === 'skill').length + agents.reduce((n, a) => n + (a.skills?.length ?? 0), 0);
  const summary = [tr('map.sumRunning', { n: running }), tr('map.sumFinished', { n: finished }), failed ? tr('map.sumFailed', { n: failed }) : '', tr('map.sumSkills', { n: skills })].filter(Boolean).join(' · ');
  const detail = !prefs.private && sess.activity?.detail ? ` · ${sess.activity.detail}` : '';
  body.innerHTML = `<p class="map-summary">${escapeXml(summary)}</p>
    <ol class="map-tree">
      <li class="map-step root${sess.status === 'your-turn' ? '' : ' live'}">${glyph(sess)}<span class="name">${escapeXml(sess.project)}</span>
        <span class="what">${escapeXml(statusText(sess) + detail)}</span>
        ${steps.length ? `<ol>${sess.map?.more ? `<li class="map-step more"><span class="what">${escapeXml(tr('map.more', { n: sess.map.more }))}</span></li>` : ''}${steps.map(mapStep).join('')}</ol>`
    : `<p class="hint">${escapeXml(tr('map.nothing'))}</p>`}
      </li>
    </ol>`;
}

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
  const row = (label, t) => `<div class="usage-row"><span>${escapeXml(label)}</span><strong>${compact(t.total)}</strong>
    <span class="muted">${escapeXml(tr('usage.fresh', { n: compact(t.fresh) }))}</span></div>`;
  const budget = prefs.budget5h > 0
    ? (() => {
      const pct = Math.min(100, Math.round((u.last5h.total / prefs.budget5h) * 100));
      return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${escapeXml(tr('usage.meter'))}">
        <span style="width:${pct}%"></span></div><p class="hint">${escapeXml(tr('usage.pct', { pct, budget: compact(prefs.budget5h) }))}</p>`;
    })()
    : '';
  const limit = u.limitNotice ? `<p class="form-error">⚠ Claude Code: ${escapeXml(u.limitNotice.text)}</p>` : '';
  $('usage-body').innerHTML = `${limit}${row(tr('usage.last5h'), u.last5h)}${row(tr('date.today'), u.today)}${row(tr('settings.report.days', { n: 7 }), u.week)}${budget}`;
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
      raise(`ctx:${sess.id}`, tr('warn.context', { project: sess.project, pct: Math.round(sess.context.pct * 100) }));
    }
    if (sess.limitNotice) raise(`limit:${sess.id}:${sess.limitNotice.ts}`, tr('warn.limitSession', { project: sess.project, text: sess.limitNotice.text }));
  }
  const u = s.usage;
  if (u?.limitNotice && !s.sessions.some((x) => x.limitNotice)) raise(`limit:all:${u.limitNotice.ts}`, tr('warn.limit', { text: u.limitNotice.text }));
  if (u && prefs.budget5h > 0) {
    const window = Math.floor(Date.now() / (5 * 3_600_000));
    for (const level of [0.8, 1]) {
      if (u.last5h.total >= prefs.budget5h * level) {
        raise(`budget:${window}:${level}`, level === 1
          ? tr('warn.budgetPast', { n: compact(u.last5h.total) })
          : tr('warn.budgetNear', { pct: Math.round((u.last5h.total / prefs.budget5h) * 100) }));
      }
    }
  }
  warnings = now;
  notifyWaits(s);
}

// "Has been waiting for you" and "finished / failed / stopped" notices,
// once each. They need the notifications switch and are off in the demo.
let endWatch;
function notifyWaits(s) {
  const tell = (key, body) => {
    if (warned.has(key)) return;
    warned.add(key);
    if (prefs.notify && bridge.notify && !s.demo) bridge.notify({ title: "Agent's Home", body });
  };
  if (prefs.waitMin > 0) {
    for (const w of waitingList(s.sessions, loadDismissed())) {
      if (Date.now() - w.since >= prefs.waitMin * 60_000) tell(`wait:${waitKey(w)}`, tr('warn.waiting', { project: w.project, what: waitText(w).toLowerCase(), for: waitFor(Date.now() - w.since) }));
    }
  }
  for (const c of s.clashes ?? []) tell(`clash:${c.key}`, tr('warn.clash', { n: c.count, project: c.project }));
  const o = runningOverview(s.sessions, s.here ?? tr('common.thisComputer'), s.fleet?.computers ?? [], { jobs: s.jobs ?? [], machine: s.machine, work: s.work ?? [] });
  const { ended, running } = endedWork(o, endWatch);
  // The first look only learns what is running: nothing has ended yet.
  if (endWatch && prefs.notifyEnds) for (const e of ended) tell(`end:${e.key}`, e.text);
  endWatch = running;
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
$('opt-wait').value = String(prefs.waitMin ?? 5);
$('opt-ends').checked = prefs.notifyEnds !== false;
$('opt-wait').addEventListener('change', (e) => {
  prefs.waitMin = Number(e.target.value) || 0;
  savePrefs();
});
$('opt-ends').addEventListener('change', (e) => {
  prefs.notifyEnds = e.target.checked;
  savePrefs();
});
$('waiting').addEventListener('click', (e) => {
  const dismiss = e.target.closest('.wait-dismiss');
  if (dismiss) {
    dismissWait(dismiss.dataset.key);
    render(true);
    return;
  }
  const open = e.target.closest('.wait-open');
  if (open) {
    select(`s:${open.dataset.session}`);
    openLiveMap(open.dataset.session);
  }
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
    if (room) return tr(`spot.${dir}`, { room: placeWords(room).name });
  }
  return tr('spot.here');
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
async function saveLayout(departments, gardens = config.layout.gardens ?? [], moves = config.layout.moves ?? {}) {
  const plain = departments.map(({ id, kind, name, purpose, cell, agents }) => ({ id, kind, name, purpose, cell, agents: [...agents] }));
  const result = await bridge.saveLayout({ departments: plain, gardens, moves });
  if (!result.ok) {
    layoutError = said(result.error);
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
        ? `<span class="blocked">${escapeXml(tr('layout.blocked', { name: placeWords(child).name }))}</span>`
        : confirmRemove === d.id
          ? `<span class="confirm">${escapeXml(tr('layout.confirm', { name: placeWords(d).name }))}
              <button type="button" class="link-btn danger" data-remove-yes="${escapeXml(d.id)}">${escapeXml(tr('common.remove'))}</button>
              <button type="button" class="link-btn" data-remove-no>${escapeXml(tr('common.keep'))}</button></span>`
          : `<button type="button" class="link-btn" data-remove="${escapeXml(d.id)}">${escapeXml(tr('common.remove'))}</button>`;
      return `<li>
        <span class="agent">${escapeXml(placeWords(d).name)}</span>
        <span class="summary">${escapeXml(placeWords(d).purpose)} · ${escapeXml(d.agents.length ? d.agents.join(tr('common.listSep')) : tr('layout.noAgents'))}</span>
        <span class="actions">${action}</span>
      </li>`;
    }).join('')}</ul>`
    : plots.length ? '' : `<p class="empty">${escapeXml(tr('layout.empty'))}</p>`;
  const gardenList = plots.length
    ? `<ul class="dept-list">${plots.map((g) => {
      const action = confirmRemove === g.id
        ? `<span class="confirm">${escapeXml(tr('layout.confirmGarden', { name: gardenWords(g) }))}
            <button type="button" class="link-btn danger" data-remove-yes="${escapeXml(g.id)}">${escapeXml(tr('common.remove'))}</button>
            <button type="button" class="link-btn" data-remove-no>${escapeXml(tr('common.keep'))}</button></span>`
        : `<button type="button" class="link-btn" data-remove="${escapeXml(g.id)}">${escapeXml(tr('common.remove'))}</button>`;
      return `<li><span class="agent">${escapeXml(gardenWords(g))}</span>
        <span class="summary">${escapeXml(tr('layout.gardenAt', { spot: spotName(g.cell) }))}</span>
        <span class="actions">${action}</span></li>`;
    }).join('')}</ul>`
    : '';

  let form = '';
  if (buildMode && !draft) {
    form = `<p class="hint">${escapeXml(tr('layout.chooseSpot', { n: config.openCells.length }))}</p>`;
  } else if (draft && draft.what === 'garden') {
    form = `<form class="dept-form" id="dept-form">
      ${buildChoice()}
      <label class="field">${escapeXml(tr('layout.name'))} <input id="garden-name" maxlength="30" placeholder="${escapeXml(tr('garden.numbered', { n: (config.layout.gardens ?? []).length + 1 }))}" value="${escapeXml(draft.gardenName)}"></label>
      <p class="hint">${escapeXml(tr('layout.gardenHint'))}</p>
      <div class="form-actions">
        <button type="submit" class="button">${escapeXml(tr('layout.buildGarden'))}</button>
        <button type="button" class="link-btn" id="dept-cancel">${escapeXml(tr('common.cancel'))}</button>
      </div>
    </form>`;
  } else if (draft) {
    const kinds = config.departmentKinds.map((k) => `<option value="${k.kind}" ${k.kind === draft.kind ? 'selected' : ''}>${escapeXml(tr(`dept.${k.kind}.name`))}</option>`).join('');
    const agents = knownAgentNames().map((a) => `<label class="check"><input type="checkbox" value="${escapeXml(a)}" ${draft.agents.has(a) ? 'checked' : ''}> ${escapeXml(a)}</label>`).join('');
    form = `<form class="dept-form" id="dept-form">
      ${buildChoice()}
      <label class="field">${escapeXml(tr('layout.department'))}
        <select id="dept-kind">${kinds}</select></label>
      <label class="field" ${draft.kind === 'custom' ? '' : 'hidden'}>${escapeXml(tr('layout.name'))}
        <input id="dept-name" maxlength="40" placeholder="${escapeXml(tr('layout.namePlaceholder'))}" value="${escapeXml(draft.name)}"
          ${nameError ? 'aria-invalid="true" aria-describedby="dept-name-error"' : ''}>
        ${nameError ? `<span class="field-error" id="dept-name-error">${escapeXml(nameError)}</span>` : ''}</label>
      <fieldset class="field"><legend>${escapeXml(tr('layout.agents'))}</legend>
        <div class="checks">${agents || `<span class="muted">${escapeXml(tr('layout.noAgentsSeen'))}</span>`}</div>
        <label class="field" for="dept-agent-new">${escapeXml(tr('layout.another'))}</label>
        <div class="add-row">
          <input id="dept-agent-new" placeholder="${escapeXml(tr('layout.agentPlaceholder'))}">
          <button type="button" class="link-btn" id="dept-agent-add">${escapeXml(tr('common.add'))}</button>
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="button">${escapeXml(tr('layout.buildDept'))}</button>
        <button type="button" class="link-btn" id="dept-cancel">${escapeXml(tr('common.cancel'))}</button>
      </div>
    </form>`;
  }
  $('layout-body').innerHTML = `${list}${gardenList}
    ${layoutError ? `<p class="form-error" role="alert">${escapeXml(layoutError)}</p>` : ''}
    ${form}
    ${buildMode ? '' : `<button type="button" class="button" id="build-start" ${config.openCells.length ? '' : 'disabled'}>${escapeXml(tr('layout.start'))}</button>`}
    ${buildMode && !draft ? `<button type="button" class="link-btn" id="build-stop">${escapeXml(tr('common.done'))}</button>` : ''}`;
}

// What to build on the chosen spot.
function buildChoice() {
  const opt = (v, label) => `<label class="chip"><input type="radio" name="build-what" value="${v}" ${draft.what === v ? 'checked' : ''}>${label}</label>`;
  return `<fieldset class="chips"><legend>${escapeXml(tr('layout.buildHere'))}</legend><div class="options">${opt('department', escapeXml(tr('layout.aDept')))}${opt('garden', escapeXml(tr('layout.aGarden')))}</div></fieldset>`;
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
    nameError = tr('layout.nameNeeded');
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
  const g = config.gardens?.find((x) => x.id === id);
  const name = g ? gardenWords(g) : tr('garden.garden');
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
    decorError = said(result.error);
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
// The catalogue comes from main in English; its names are looked up by id here.
const catalogueName = (list, id, english) => (hasWords(`decor.${list}.${id}`) ? tr(`decor.${list}.${id}`) : english ?? id);
const itemName = (kind) => catalogueName('item', kind, itemOf(kind)?.name);
const plantName = (kind) => catalogueName('plant', kind, plantOf(kind)?.name);
const floorName = (id) => catalogueName('floor', id, config.decorCatalogue.floors.find((f) => f.id === id)?.name);
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
  const name = (k) => itemName(k).toLowerCase();
  if (plan.kind === 'remove') {
    if (plan.index === -1) {
      decorNote = tr('deco.nothingThere');
      renderDecorPanel();
      return;
    }
    const gone = plan.list[plan.index];
    setRoomEntry(roomId, { ...roomEntry(roomId), items: plan.list.filter((_, k) => k !== plan.index) }, tr('deco.removed', { name: name(gone.kind) }));
    return;
  }
  if (plan.kind === 'pick') {
    if (plan.index === -1) {
      decorNote = tr('deco.pickFirst');
    } else {
      picked = plan.index;
      decorNote = tr('deco.pickedUp', { name: name(plan.list[plan.index].kind) });
    }
    redrawDecorLayer();
    return;
  }
  if (plan.blocked) {
    decorNote = tr('deco.blocksDoor');
    renderDecorPanel();
    return;
  }
  if (plan.kind === 'move') {
    if (plan.clash.length) {
      decorNote = tr('deco.occupied');
      renderDecorPanel();
      return;
    }
    picked = undefined;
    setRoomEntry(roomId, { ...roomEntry(roomId), items: [...plan.others, plan.item] }, tr('deco.moved', { name: name(plan.item.kind) }));
    return;
  }
  // Placing a new item takes the place of whatever was on those tiles.
  const kept = plan.list.filter((it) => !plan.clash.includes(it));
  const others = plan.clash.map((it) => name(it.kind)).join(tr('deco.and'));
  setRoomEntry(roomId, { ...roomEntry(roomId), items: [...kept, plan.item] }, plan.clash.length ? tr('deco.placedOver', { name: name(plan.item.kind), others }) : tr('deco.placed', { name: name(plan.item.kind) }));
}

// Plants the chosen piece with its corner on the tile, nudged back inside
// the plot if it would hang over the edge; whatever it lands on is dug up.
function plantAt(gardenId, [i, j]) {
  const plan = planFor(gardenId, [i, j]);
  let next;
  let note;
  if (plan.remove) {
    if (!plan.tiles.length) {
      decorNote = tr('deco.nothingGrows', { col: i + 1, row: j + 1 });
      renderDecorPanel();
      return;
    }
    next = plan.keep;
    note = tr('deco.dugUp', { col: i + 1, row: j + 1 });
  } else {
    next = [...plan.keep, plan.item];
    note = tr('deco.planted', { name: plantName(plan.item.kind).toLowerCase(), col: plan.item.at[0] + 1, row: plan.item.at[1] + 1 });
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
    $('decorate-h').textContent = tr('deco.plantThe', { garden: gardenName(focusedGarden) });
    const chip = (id, name, extra = '', thumb = '') => `<label class="chip"><input type="radio" name="plant-tool" value="${id}" ${plantTool === id ? 'checked' : ''}>${thumb}${escapeXml(name)}${extra}</label>`;
    const size = (p) => (p.w * p.d > 1 ? ` <span class="size">${p.w}×${p.d}</span>` : '');
    const bench = plantOf(plantTool)?.turns
      ? `<label class="switch"><input type="checkbox" id="bench-turn" ${benchTurn ? 'checked' : ''}> <span>${escapeXml(tr('deco.turn'))}</span></label>` : '';
    $('decorate-body').innerHTML = `
      <fieldset class="chips"><legend>${escapeXml(tr('deco.whatToPlant'))}</legend>
        <div class="options">${cat.plants.map((p) => chip(p.id, plantName(p.id), size(p), plantThumb(p.id, p.w > 1 || p.d > 1))).join('')}${chip('remove', tr('deco.digUp'))}</div>
      </fieldset>
      ${bench}
      <p class="hint">${escapeXml(tr('deco.plotHint'))}</p>
      ${status}${error}
      <div class="form-actions">
        <button type="button" class="link-btn" id="garden-clear">${escapeXml(tr('deco.clearPlot'))}</button>
        <button type="button" class="link-btn" id="garden-default">${escapeXml(tr('deco.backToStart'))}</button>
      </div>`;
    return;
  }
  const id = focusedRoom;
  const entry = roomEntry(id);
  const floor = entry.floor ?? cat.defaultFloor;
  const { fits, rest } = itemsForRoom(id);
  const tool = (t, label) => `<button type="button" class="piece tool" data-room-tool="${t}" aria-pressed="${roomTool === t}"><span>${label}</span></button>`;
  const piece = (it) => `<button type="button" class="piece" data-room-tool="${it.id}" aria-pressed="${roomTool === it.id}">${itemThumb(it.id, id)}<span>${escapeXml(itemName(it.id))}${it.w * it.d > 1 ? ` <span class="size">${it.w}×${it.d}</span>` : ''}</span></button>`;
  const turnable = roomTool === 'move' ? picked !== undefined && itemOf(roomItems(id)[picked]?.kind)?.turns : itemOf(roomTool)?.turns;
  const hint = roomTool === 'move'
    ? (picked === undefined ? tr('deco.hint.pickInRoom') : tr('deco.hint.nowClick'))
    : roomTool === 'remove' ? tr('deco.hint.remove')
      : tr('deco.hint.place');
  $('decorate-body').innerHTML = `
    <fieldset class="chips"><legend>${escapeXml(tr('deco.floor'))}</legend>
      <div class="options">${cat.floors.map((f) => `<label class="chip floor-chip"><input type="radio" name="floor" value="${f.id}" ${floor === f.id ? 'checked' : ''}>${floorThumb(f.id, id)}${escapeXml(floorName(f.id))}</label>`).join('')}</div>
    </fieldset>
    <div class="pieces tools">${tool('move', escapeXml(tr('deco.move')))}${tool('remove', escapeXml(tr('common.remove')))}</div>
    ${turnable ? `<label class="switch"><input type="checkbox" id="room-turn" ${roomTurn ? 'checked' : ''}> <span>${escapeXml(tr('deco.turn'))}</span></label>` : ''}
    <p class="hint">${escapeXml(hint)}</p>
    <h4 class="pieces-h">${escapeXml(tr('deco.forRoom'))}</h4>
    <div class="pieces">${fits.map(piece).join('')}</div>
    <details class="more-pieces" ${moreOpen || rest.some((it) => it.id === roomTool) ? 'open' : ''}><summary>${escapeXml(tr('deco.more', { n: rest.length }))}</summary><div class="pieces">${rest.map(piece).join('')}</div></details>
    ${status}${error}
    <div class="form-actions">
      <button type="button" class="link-btn" id="room-clear">${escapeXml(tr('deco.emptyRoom'))}</button>
      <button type="button" class="link-btn" id="room-reset">${escapeXml(tr('deco.backToStart'))}</button></div>`;
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
    const name = floorName(t.value);
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), floor: t.value }, tr('deco.floorChanged', { name: name.toLowerCase() }));
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
    saveDecor({ ...config.decor, gardens: { ...config.decor.gardens, [focusedGarden]: [] } }, tr('deco.plotBare'));
  } else if (id === 'garden-default') {
    const gardens = { ...config.decor.gardens };
    delete gardens[focusedGarden];
    saveDecor({ ...config.decor, gardens }, tr('deco.gardenBack'));
  } else if (id === 'room-reset') {
    picked = undefined;
    setRoomEntry(focusedRoom, {}, tr('deco.roomBack'));
  } else if (id === 'room-clear') {
    picked = undefined;
    setRoomEntry(focusedRoom, { ...roomEntry(focusedRoom), items: [] }, tr('deco.roomEmpty'));
  }
});

// ---- performance report --------------------------------------------------------

if (!bridge.buildReport) {
  // The browser preview cannot read transcripts; the desktop app can.
  $('report-open').disabled = true;
  $('report-files').hidden = true;
  $('report-status').textContent = tr('report.desktopOnly');
}

$('report-open').addEventListener('click', async () => {
  const button = $('report-open');
  button.disabled = true;
  const status = $('report-status');
  status.textContent = tr('report.reading');
  try {
    const res = await bridge.buildReport(Number($('report-days').value), !prefs.private);
    if (!res.ok) {
      status.textContent = said(res.error);
      return;
    }
    const x = res.summary;
    const pctText = x.successRate === undefined ? '' : tr('report.finishedPct', { pct: Math.round(x.successRate * 100) });
    status.textContent = tr('report.opened', { days: x.days, n: x.runs, pct: pctText });
  } catch (err) {
    status.textContent = tr('report.failed', { error: err.message });
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
    $('update-version').textContent = tr('update.preview');
    $('update-run').disabled = true;
    updateSummary = tr('update.summaryPreview');
    return;
  }
  const info = await bridge.updateInfo();
  $('update-version').textContent = info.available
    ? tr('update.version', { version: info.version, branch: info.branch, commit: info.commit })
    : tr('update.versionOff', { version: info.version, reason: said(info.reason) });
  $('update-run').disabled = !info.available;
  updateSummary = tr(info.available ? 'update.summaryOn' : 'update.summaryOff', { version: info.version });
  if (!$('settings').hidden) renderGroupSummaries();
}

$('update-run').addEventListener('click', async () => {
  const button = $('update-run');
  const status = $('update-status');
  button.disabled = true;
  status.classList.remove('form-error');
  status.textContent = tr('update.getting');
  try {
    const res = await bridge.update();
    status.textContent = res.ok ? said(res.message) : said(res.error);
    status.classList.toggle('form-error', !res.ok);
    if (!res.ok || !res.restart) {
      button.disabled = false;
      showUpdateInfo();
    }
  } catch (err) {
    status.textContent = tr('update.failed', { error: err.message });
    status.classList.add('form-error');
    button.disabled = false;
  }
});

// Update agents: refreshes the team helpers the user added. Adds nothing
// new and turns nothing on.
if (!bridge.packUpdate) $('update-agents').disabled = true;
// "Your own 3 agents and 2 skills were not touched." Only the counts: the
// names are the user's and Settings already lists the team's own.
function ownText(own) {
  const n = (k) => (own?.[k]?.length ? tr(`pack.${k}`, { n: own[k].length }) : '');
  const [a, b] = [n('agents'), n('skills')];
  const what = a && b ? tr('common.and', { a, b }) : a || b;
  return what ? tr('pack.own', { what, n: own.agents.length + own.skills.length }) : '';
}

$('update-agents').addEventListener('click', async () => {
  const button = $('update-agents');
  const status = $('update-status');
  button.disabled = true;
  status.classList.remove('form-error');
  status.textContent = tr('pack.updating');
  try {
    const res = await bridge.packUpdate();
    if (!res.updated) {
      status.textContent = said(res.error);
      status.classList.add('form-error');
      return;
    }
    const list = (names) => names.map(packLabel).join(tr('common.listSep'));
    const parts = [
      res.updated.length ? tr('pack.updated', { list: list(res.updated) }) : '',
      res.edited.length ? tr('pack.edited', { list: list(res.edited) }) : '',
      tr(res.updated.length ? 'pack.newSession' : res.upToDate.length || res.edited.length ? 'pack.upToDate' : 'pack.noneAdded'),
      ownText(res.own),
      res.errors.length ? tr('pack.problems', { list: res.errors.join(tr('common.semiSep')) }) : '',
    ].filter(Boolean);
    status.textContent = parts.join(tr('common.sentenceSep'));
    status.classList.toggle('form-error', res.errors.length > 0);
    await loadPack();
  } catch (err) {
    status.textContent = tr('pack.updateFailed', { error: err.message });
    status.classList.add('form-error');
  } finally {
    button.disabled = false;
  }
});

// ---- system log --------------------------------------------------------------------

// Errors in this window go to the log too (the main process keeps it).
window.addEventListener('error', (e) => bridge.logError?.({ message: e.message, where: `${String(e.filename).split('/').pop()}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => bridge.logError?.({ message: String(e.reason?.message ?? e.reason), where: 'promise' }));

async function showLogStatus() {
  const line = $('log-reminders');
  if (!bridge.logTail) {
    line.textContent = tr('log.preview');
    for (const id of ['log-activity', 'log-errors', 'log-open']) $(id).disabled = true;
    return;
  }
  const res = await bridge.logTail('reminders');
  if (!res.ok) {
    line.textContent = said(res.error);
    return;
  }
  const { summary: s, team } = res;
  if (team.reminders !== 'on') {
    line.textContent = tr('log.remindersOff', { team: team.team });
  } else if (!s.runs) {
    line.textContent = tr('log.remindersIdle');
  } else {
    const last = s.last ? tr('log.remindersLast', { time: clock(s.last.time), fired: s.last.fired.split(',').join(tr('common.listSep')) }) : '';
    line.textContent = tr('log.remindersWorking', { n: s.runs, reminded: s.reminded, last });
  }
}

async function showLog(which) {
  const view = $('log-view');
  const res = await bridge.logTail(which);
  view.hidden = false;
  view.textContent = res.ok
    ? res.lines.length ? res.lines.join('\n') : tr(`log.empty.${which}`)
    : said(res.error);
  view.scrollTop = view.scrollHeight;
  showLogStatus();
}
$('log-activity').addEventListener('click', () => showLog('activity'));
$('log-errors').addEventListener('click', () => showLog('errors'));
$('log-open').addEventListener('click', async () => {
  const res = await bridge.logOpen();
  if (!res.ok) $('log-reminders').textContent = tr('log.openFailed', { error: said(res.error) });
});

// ---- the Office pack: a ready-made team offered to Claude ---------------------------

// Asked once in a short card on the board: "Not now" is remembered until the
// pack has something new. The same list stays in Settings.
const packLabel = (name) => (hasWords(`pack.name.${name}`) ? tr(`pack.name.${name}`) : name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
// What a pack item does, from the tables (the pack's own first sentence in
// English, test/i18n-surfaces checks), else the item's own words.
const packSummary = (i) => (hasWords(`pack.summary.${i.name}`) ? tr(`pack.summary.${i.name}`) : i.summary);
let pack; // { hasOwnAgents, items: [{ kind, name, summary, installed }] }
let packNote = '';
let packError = '';

async function loadPack() {
  if (!bridge.packStatus) return;
  const res = await bridge.packStatus();
  if (!res.ok) {
    packError = said(res.error);
    pack = undefined;
  } else {
    pack = res;
  }
  renderPack();
}

// The card shows names only; Settings adds what each one does.
function packChoices(id, withSummary) {
  return pack.items.filter((i) => !i.installed).map((i) => `<label class="check">
    <input type="checkbox" name="${id}" value="${escapeXml(i.name)}">
    <span><strong>${escapeXml(packLabel(i.name))}</strong>${withSummary ? ` <span class="muted">${escapeXml(packSummary(i))}</span>` : ''}</span></label>`).join('');
}

function renderPack() {
  const offer = $('pack-offer');
  const settings = $('pack-settings');
  if (!bridge.packStatus) {
    offer.hidden = true;
    settings.innerHTML = `<p class="hint">${escapeXml(tr('pack.preview'))}</p>`;
    return;
  }
  if (!pack) {
    offer.hidden = true;
    settings.innerHTML = packError ? `<p class="form-error">${escapeXml(packError)}</p>` : '';
    return;
  }
  const missing = pack.items.filter((i) => !i.installed);
  const note = packNote ? `<p class="hint" role="status">${escapeXml(packNote)}</p>` : '';
  const err = packError ? `<p class="form-error" role="alert">${escapeXml(packError)}</p>` : '';
  // No card on the board: people keep their own agent pipelines, so the
  // office team is only ever offered in Settings, with nothing ticked.
  offer.hidden = true;
  settings.innerHTML = `
    ${pack.items.map((i) => `<p class="pack-row">${i.installed ? '✓' : '○'} <strong>${escapeXml(packLabel(i.name))}</strong>
      <span class="muted">${escapeXml(tr(i.installed ? 'pack.inClaude' : 'pack.notAdded'))}</span></p>`).join('')}
    ${missing.length ? `<p class="hint">${escapeXml(tr('pack.optional'))}</p>
      <div class="checks">${packChoices('pack-pick-settings', true)}</div>
      <button type="button" class="button" id="pack-add-settings">${escapeXml(tr('pack.addTicked'))}</button>` : `<p class="hint">${escapeXml(tr('pack.allIn'))}</p>`}
    ${err}${note}`;
}

async function addPack(names) {
  if (!names.length) return;
  packError = '';
  const res = await bridge.packInstall(names);
  const added = res.installed?.length ?? 0;
  packNote = added ? tr('pack.added', { n: added }) : '';
  if (res.errors?.length) packError = res.errors.join('; ');
  else if (!res.ok) packError = said(res.error);
  await loadPack();
}

document.addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'pack-add-settings') {
    addPack([...document.querySelectorAll('input[name="pack-pick-settings"]:checked')].map((x) => x.value));
  }
});

loadPack();

// ---- the Report button ------------------------------------------------------------

{
  const button = $('cam-report');

  button.addEventListener('click', async () => {
    // The browser preview cannot build it: show where it lives instead.
    if (!bridge.buildReport) {
      showInSettings('report-h', 'center');
      return;
    }
    button.disabled = true;
    button.textContent = tr('stage.building');
    const res = await bridge.buildReport(Number($('report-days').value), !prefs.private).catch((err) => ({ ok: false, error: tr('report.failed', { error: err.message }) }));
    button.disabled = false;
    button.textContent = tr('stage.report');
    if (!res.ok) {
      // Shown where the report's other messages go, not lost.
      $('report-status').textContent = said(res.error);
      showInSettings('report-h', 'center');
    }
  });
}

// ---- the project list -------------------------------------------------------------

const projOpen = new Set();
const projTrees = new Map(); // project id -> worktrees, once looked at
let projError;
const demoProj = demoProjects();
function renderProjects() {
  const data = prefs.demo ? demoProj.snapshot() : snapshot.projects;
  paint($('projects-body'), projectsHtml(data, snapshot.sessions ?? [], { privacy: prefs.private, open: projOpen, error: projError, worktrees: projTrees }));
}
wireProjects($('projects-body'), {
  open: projOpen,
  change: async (c) => {
    if (prefs.demo) return demoProj.change(c);
    if (!bridge.projectChange) return { ok: false, error: tr('proj.previewSave') };
    return bridge.projectChange(c).then((res) => (res.ok ? res : { ...res, error: said(res.error) }), (err) => ({ ok: false, error: err.message }));
  },
  // The app's list arrives with the next snapshot, half a second later.
  rerender: () => { renderProjects(); setTimeout(renderProjects, 600); },
  setError: (e) => { projError = e; },
  worktrees: projTrees,
  loadWorktrees: async (id) => (prefs.demo ? demoTrees(id) : bridge.worktrees ? bridge.worktrees(id).then((res) => (res.ok ? res : { ...res, error: said(res.error) })) : { ok: false, error: tr('proj.previewTrees') }),
});
$('projects-file').addEventListener('click', async () => {
  const res = await bridge.projectsShow?.();
  $('projects-file-status').textContent = !res ? tr('proj.previewFile') : !res.ok ? said(res.error) : !prefs.private ? tr('proj.fileIs', { file: res.file }) : '';
});
setInterval(renderProjects, 1000);

// ---- field feedback -------------------------------------------------------------
//
// The field survey's answers (snapshot.field, or the demo's sample). The
// main process fetches; this only shows and passes on the user's changes.

// editing: the link field is open. error/note: the reply to the last button.
// draft: the column roles being changed in "Check the columns".
// linkError/linkDraft: the sheet link's refusal and the link as typed then.
// readerEditing/secretEditing: the reader's link or secret field is open
// again; readerError/readerDraft/secretError: what its last Save was
// refused for (and the link as typed). secretNote: why the secret is asked
// again. scriptNote/scriptError: Copy reader script's reply. sourceError:
// How to connect's. pendingSource: the way picked while Settings asks
// whether to switch. focusAfter: the control to focus once the snapshot has
// drawn it. The secret itself is never kept here.
const fieldUi = {
  editing: false, error: '', note: '', draft: {}, checkNote: '', checkError: '', linkError: '', linkDraft: null,
  readerEditing: false, readerError: '', readerDraft: null, secretEditing: false, secretError: '', secretNote: '',
  scriptNote: '', scriptError: '', sourceError: '', pendingSource: null, focusAfter: '',
};
let fieldSwitchedAt = 0; // the switch was just pressed: wait for the snapshot before echoing it back
let fieldOpener;
function renderField() {
  const f = snapshot.field;
  $('field').hidden = !f?.enabled;
  if (f?.enabled) paint($('field-body'), fieldHtml(f, { privacy: prefs.private }));
  if (!$('field-sheet').hidden) {
    if (!f?.enabled) setFieldSheet(false);
    else paint($('field-sheet-body'), fieldSheetHtml(f, { privacy: prefs.private }));
  }
}
function renderFieldSettings() {
  const f = snapshot.field;
  const online = Boolean(bridge.fieldSet);
  if (Date.now() - fieldSwitchedAt > 1500) $('opt-field').checked = Boolean(f?.enabled);
  $('opt-field').disabled = !online || Boolean(f?.demo);
  paint($('field-settings'), fieldSettingsHtml(f, { privacy: prefs.private, online, state: fieldUi }));
  // After a Save, focus goes to what replaced the field, once it is drawn.
  if (fieldUi.focusAfter && $(fieldUi.focusAfter)) {
    $(fieldUi.focusAfter).focus({ preventScroll: true });
    fieldUi.focusAfter = '';
  }
}
// Links typed but not saved go (privacy mode turned on, or Settings
// closed): the drafts kept after a refusal, and what is in the fields now.
// Drawn afresh, with focus already off the fields, so paint keeps nothing.
function forgetFieldDrafts() {
  dropFieldDrafts(fieldUi);
  $('field-settings').dataset.sig = '';
  renderFieldSettings();
}
// How to connect, switched: another way starts afresh, so every field's state goes.
async function setFieldSource(source) {
  const res = await bridge.fieldSet({ source }).catch((err) => ({ ok: false, error: err.message }));
  Object.assign(fieldUi, {
    pendingSource: null, sourceError: res.ok ? '' : res.error, note: '', editing: false, linkError: '', linkDraft: null,
    readerEditing: false, readerError: '', readerDraft: null, secretEditing: false, secretError: '', secretNote: '', scriptNote: '', scriptError: '',
  });
  if (res.ok) fieldUi.focusAfter = `field-source-${source}`;
  renderFieldSettings();
  setTimeout(() => { renderField(); renderFieldSettings(); }, 600);
}
// The sheet is modal: the board and the map behind it are inert until it
// closes, so Tab and Shift+Tab stay inside it.
function setFieldSheet(open) {
  if (open === !$('field-sheet').hidden) return;
  $('field-sheet').hidden = !open;
  for (const el of document.querySelectorAll('.board, .stage')) el.inert = open;
  if (open) {
    fieldOpener = document.activeElement;
    paint($('field-sheet-body'), fieldSheetHtml(snapshot.field, { privacy: prefs.private }));
    $('field-sheet-close').focus();
  } else {
    (fieldOpener?.isConnected ? fieldOpener : $('field-open'))?.focus();
    fieldOpener = undefined;
  }
}
function openFieldCheck() {
  setFieldSheet(false);
  showInSettings('field-check-h');
  // With privacy mode on the step only reads: its link to the switch that opens it.
  if (prefs.private) {
    $('field-goto-switch')?.focus({ preventScroll: true });
    return;
  }
  // The first row that needs a choice, else the first one not checked.
  const rows = stepRows(snapshot.field, fieldUi.draft);
  const row = rows.find((r) => r.missing) ?? rows.find((r) => !r.c.confirmed);
  if (row) $(`fc-role-${row.c.index}`)?.focus({ preventScroll: true });
}
async function fieldAction(act) {
  if (act === 'open') setFieldSheet(true);
  else if (act === 'check') openFieldCheck();
  else if (act === 'settings') showInSettings('field-settings-h');
  else if (act === 'privacy-switch') {
    showInSettings('screen-h');
    $('opt-private').focus();
  } else if (act === 'change-link') {
    fieldUi.editing = true;
    renderFieldSettings();
    $('field-link')?.focus();
  } else if (act === 'refresh') {
    fieldUi.error = '';
    if (snapshot.demo || !bridge.fieldRefresh) {
      fieldUi.note = snapshot.demo ? english('said.ui.demoNoSheet') : english('said.ui.previewNoSheet');
    } else {
      fieldUi.note = '';
      // The outcome arrives with the snapshot (updating, then the rows or
      // the error); only a failed call to the main process is shown here.
      await bridge.fieldRefresh().catch((err) => { fieldUi.error = english('said.ui.sheetNotRead', { why: err.message }); });
    }
    renderFieldSettings();
    renderField();
  } else if (act === 'copy-reader') {
    const address = snapshot.field?.clientEmail;
    const res = bridge.fieldCopyReader ? await bridge.fieldCopyReader().catch((err) => ({ ok: false, error: err.message }))
      : await navigator.clipboard.writeText(address ?? '').then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message }));
    fieldUi.note = res.ok ? english('said.ui.addressCopied') : '';
    fieldUi.error = res.ok ? '' : english('said.ui.addressNotCopied', { why: res.error });
    renderFieldSettings();
  } else if (act === 'choose-key') {
    if (!bridge.fieldChooseKey) return;
    const res = await bridge.fieldChooseKey().catch((err) => ({ ok: false, error: err.message }));
    fieldUi.error = res.ok || res.canceled ? '' : res.error;
    renderFieldSettings();
    setTimeout(renderFieldSettings, 600);
  } else if (act === 'change-reader') {
    fieldUi.readerEditing = true;
    renderFieldSettings();
    $('field-reader-link')?.focus();
  } else if (act === 'replace-secret') {
    fieldUi.secretEditing = true;
    renderFieldSettings();
    $('field-secret')?.focus();
  } else if (act === 'cancel-reader' || act === 'cancel-secret' || act === 'cancel-link') {
    // Back to what is saved, and to the button that opened the field.
    if (act === 'cancel-reader') Object.assign(fieldUi, { readerEditing: false, readerError: '', readerDraft: null });
    if (act === 'cancel-secret') Object.assign(fieldUi, { secretEditing: false, secretError: '' });
    if (act === 'cancel-link') Object.assign(fieldUi, { editing: false, linkError: '', linkDraft: null });
    renderFieldSettings();
    $({ 'cancel-reader': 'field-reader-change', 'cancel-secret': 'field-secret-replace', 'cancel-link': 'field-change' }[act])?.focus();
  } else if (act === 'switch-source') {
    if (bridge.fieldSet && fieldUi.pendingSource) await setFieldSource(fieldUi.pendingSource);
  } else if (act === 'keep-source') {
    fieldUi.pendingSource = null;
    renderFieldSettings();
    document.querySelector('input[name="field-source"]:checked')?.focus();
  } else if (act === 'copy-script') {
    if (!bridge.fieldCopyScript) return;
    const res = await bridge.fieldCopyScript().catch((err) => ({ ok: false, error: err.message }));
    fieldUi.scriptNote = res.ok ? english('said.ui.readerScriptCopied') : '';
    fieldUi.scriptError = res.ok ? '' : res.error;
    renderFieldSettings();
  }
}
for (const id of ['field-body', 'field-settings', 'field-sheet-body', 'problem-list']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-field]');
    if (b && !b.disabled) fieldAction(b.dataset.field);
  });
}
// "Check the columns": each choice goes into the draft, and the row redraws
// (a score shows its scale).
$('field-settings').addEventListener('change', async (e) => {
  // How to connect: the reader script or the key file. Another way starts
  // afresh, so with checked columns Settings asks first, in place; focus
  // stays on the radio (arrow keys move within the group).
  if (e.target.name === 'field-source') {
    if (!bridge.fieldSet) return;
    const saved = snapshot.field?.source;
    if (e.target.value === saved) {
      fieldUi.pendingSource = null;
      renderFieldSettings();
    } else if ((snapshot.field?.checkedColumns ?? 0) > 0) {
      fieldUi.pendingSource = e.target.value;
      renderFieldSettings();
    } else await setFieldSource(e.target.value);
    return;
  }
  const el = e.target.closest('select[data-col]');
  if (!el) return;
  const col = Number(el.dataset.col);
  fieldUi.draft = draftWith(fieldUi.draft, col, el.dataset.part, el.value);
  fieldUi.checkNote = '';
  renderFieldSettings();
});
$('field-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'field-check-form') {
    fieldUi.checkError = '';
    fieldUi.checkNote = '';
    // Save is disabled while a row has no choice; this holds if it is sent anyway.
    const { roles, missing } = rolesFrom(snapshot.field, fieldUi.draft);
    if (missing) {
      fieldUi.checkError = english('said.fs.stillNeed', { n: missing });
      renderFieldSettings();
      return;
    }
    if (snapshot.demo || !bridge.fieldSet) {
      fieldUi.checkNote = snapshot.demo ? english('said.ui.demoColumns') : english('said.ui.previewNoSave');
      renderFieldSettings();
      return;
    }
    const res = await bridge.fieldSet({ columns: roles }).catch((err) => ({ ok: false, error: err.message }));
    if (res.ok) {
      fieldUi.draft = {};
      fieldUi.checkNote = res.note ?? english('said.fs.columnsSaved'); // or "Kept hidden: …" from the main process
    } else fieldUi.checkError = res.error;
    renderFieldSettings();
    setTimeout(renderFieldSettings, 600);
    return;
  }
  if (e.target.id === 'field-reader-link-form') {
    if (!bridge.fieldSet) return;
    const typed = $('field-reader-link').value;
    const res = await bridge.fieldSet({ readerUrl: typed }).catch((err) => ({ ok: false, error: err.message }));
    // Refused: the link stays as typed, to be put right.
    Object.assign(fieldUi, res.ok
      ? { readerError: '', readerDraft: null, readerEditing: false, focusAfter: 'field-reader-change', secretNote: res.secretNote ?? '' }
      : { readerError: res.error, readerDraft: typed });
    renderFieldSettings();
    if (!res.ok) $('field-reader-link')?.focus();
    setTimeout(renderFieldSettings, 600);
    return;
  }
  if (e.target.id === 'field-secret-form') {
    if (!bridge.fieldSaveSecret) return;
    // Read once and cleared at once: the secret stays in no field or state.
    const input = $('field-secret');
    const secret = input.value;
    input.value = '';
    const res = await bridge.fieldSaveSecret(secret).catch((err) => ({ ok: false, error: err.message }));
    Object.assign(fieldUi, res.ok
      ? { secretError: '', secretEditing: false, secretNote: '', focusAfter: 'field-secret-replace' }
      : { secretError: res.error });
    renderFieldSettings();
    if (!res.ok) $('field-secret')?.focus();
    setTimeout(renderFieldSettings, 600);
    return;
  }
  if (!bridge.fieldSet) return;
  const typed = $('field-link').value;
  const res = await bridge.fieldSet({ sheetUrl: typed }).catch((err) => ({ ok: false, error: err.message }));
  Object.assign(fieldUi, res.ok
    // "Same sheet: kept the tab you had."
    ? { linkError: '', linkDraft: null, editing: false, note: res.note ?? '', focusAfter: 'field-change' }
    : { linkError: res.error, linkDraft: typed });
  renderFieldSettings();
  if (!res.ok) $('field-link')?.focus();
  setTimeout(renderFieldSettings, 600);
});
$('opt-field').addEventListener('change', async (e) => {
  if (!bridge.fieldSet) return;
  fieldSwitchedAt = Date.now();
  const res = await bridge.fieldSet({ enabled: e.target.checked }).catch((err) => ({ ok: false, error: err.message }));
  fieldUi.error = res.ok ? '' : res.error;
  if (!res.ok) fieldSwitchedAt = 0;
  renderFieldSettings();
  setTimeout(() => { renderField(); renderFieldSettings(); }, 600);
});
$('field-sheet-close').addEventListener('click', () => setFieldSheet(false));
// A press outside the open sheet (on the inert board or map) closes it.
document.addEventListener('pointerdown', (e) => {
  if ($('field-sheet').hidden || $('field-sheet').contains(e.target)) return;
  const back = fieldOpener?.isConnected ? fieldOpener : $('field-open');
  setFieldSheet(false);
  // The press then moves focus to the page itself; put it back where the
  // sheet was opened from, unless the press landed on a control.
  setTimeout(() => {
    if (document.activeElement === document.body) back?.focus({ preventScroll: true });
  }, 0);
});
$('field-sheet').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    setFieldSheet(false);
  } else if (e.key === 'Tab') {
    // Tab and Shift+Tab go round inside the sheet: with everything behind
    // it inert, the browser would otherwise drop focus on the page itself.
    const stops = [...$('field-sheet').querySelectorAll('button, a[href], select, input, [tabindex="0"]')].filter((el) => !el.disabled && el.offsetParent);
    if (!stops.length) return;
    const [first, last] = [stops[0], stops[stops.length - 1]];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === $('field-sheet'))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
setInterval(() => {
  renderField();
  if (!$('settings').hidden) renderFieldSettings();
}, 1000);

// ---- LINE chats -----------------------------------------------------------------
//
// What in the user's LINE chats concerns them (snapshot.line, or the demo's
// sample). The main process reads the exports and starts Claude; this
// shows the items and passes on the user's choices. Items are named by
// their key (chat + message).

// adding: the item whose add form is open, with what is typed in it;
// expanded: items whose whole message shows; all: every item shown;
// error/errorKey: the last button's failure, at its item.
const lineUi = { adding: null, todo: null, project: null, expanded: new Set(), all: false, error: '', errorKey: null };
let lineStatus = null; // the section's one status line: { text, undo }
// names/keywords: what is typed in Settings, kept across redraws until saved.
const lineSettingsUi = { error: '', switchError: '', tickError: '', wordsError: '', note: '', names: null, keywords: null };
// The bot part's Settings: which field is open, a link refused (kept as
// typed), the last replies, and the switch as pressed until the snapshot
// agrees (pendingOn). The secret is never kept here.
const lineBotUi = {
  linkEditing: false, linkDraft: null, linkError: '', secretEditing: false, secretError: '', secretNote: '', scriptNote: '', scriptError: '', note: '', error: '',
  tickError: '', refreshError: '', pendingOn: null, pendingAt: 0, focusAfter: '',
};
let lineOffSeen = null; // the last later-finished off said (snapshot bot.offDone.n)
const lineDemoMarks = new Set(); // the demo's added and dismissed items, until it is turned off
// Items added or dismissed whose mark is saved but which the snapshot still
// lists: hidden at once, and no longer pending once a snapshot drops them.
const linePending = new Set();
const lineDrafts = new Map(); // item key -> its sheet as last left (prompt, folder, where)
let lineSwitchedAt = 0;
let lineSend = null; // the open sheet's draft
let lineTargets = null; // { sessions, why } once asked
let lineOpener;
const lineState = () => {
  const s = snapshot.line;
  const l = s?.demo && s.items ? { ...s, items: s.items.filter((it) => !lineDemoMarks.has(it.key)) } : s;
  if (!l?.items) {
    linePending.clear(); // off: turning it on again starts with no marks
    return l;
  }
  if (!linePending.size) return l;
  for (const k of linePending) if (!l.items.some((it) => it.key === k)) linePending.delete(k);
  return { ...l, items: l.items.filter((it) => !linePending.has(it.key)) };
};
// The bridge failing: its reason goes to the system log, the user gets what to do.
function lineLog(err) {
  // Nothing is left to report to when the log cannot be written either.
  bridge.logError?.({ message: String(err?.message ?? err), where: 'line-chats' })?.catch?.(() => {});
}
function lineNoAnswer(err) {
  lineLog(err);
  return { ok: false, error: english('said.ui.noAnswer') };
}
const lineProjects = () => (prefs.demo ? demoProj.snapshot() : snapshot.projects)?.list ?? [];
function setLineStatus(status) {
  lineStatus = status;
  paint($('line-status'), statusHtml(status));
}
function renderLine() {
  const l = lineState();
  $('line').hidden = !l?.enabled;
  // Privacy on: nothing to read or act on, so open forms and the sheet close.
  if (prefs.private || !l?.enabled) {
    lineUi.adding = null;
    if (!$('line-sheet').hidden) setLineSheet(false);
  }
  if (!l?.enabled) return;
  if (lineUi.adding && !l.items.some((it) => it.key === lineUi.adding)) lineUi.adding = null;
  // The add form shows what the user typed, not the draft, once they type.
  const item = l.items?.find((it) => it.key === lineUi.adding);
  const shown = item && lineUi.todo != null ? { ...l, items: l.items.map((it) => (it === item ? { ...it, draft: { ...it.draft, text: lineUi.todo } } : it)) } : l;
  paint($('line-body'), lineHtml(shown, { privacy: prefs.private, ui: lineUi, projects: lineProjects() }));
  const sel = lineUi.adding && $(`line-project-${lineUi.adding}`);
  if (sel && lineUi.project && sel.value !== lineUi.project) sel.value = lineUi.project;
  fitLineMore();
}
// isLong() guesses which messages the board cuts; once drawn, a Show all
// whose message fits after all is hidden (and shown again if a narrower
// window cuts it). A message not laid out (height 0) keeps the guess.
function fitLineMore() {
  for (const b of $('line-body').querySelectorAll('.line-more[aria-expanded="false"]')) {
    const text = b.previousElementSibling;
    if (!text?.classList.contains('line-text') || !text.clientHeight) continue;
    b.hidden = text.scrollHeight <= text.clientHeight;
  }
}
let lineFitFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(lineFitFrame);
  lineFitFrame = requestAnimationFrame(fitLineMore);
});
function renderLineSettings() {
  const l = snapshot.line;
  const online = Boolean(bridge.lineSet);
  if (Date.now() - lineSwitchedAt > 1500) $('opt-line').checked = Boolean(l?.enabled);
  $('opt-line').disabled = !online || Boolean(l?.demo);
  if (lineBotUi.pendingOn != null && (l?.bot?.on === lineBotUi.pendingOn || Date.now() - lineBotUi.pendingAt > 1500)) lineBotUi.pendingOn = null;
  // An off that finished later: said as one finished at once, under the switch in view, until Settings closes.
  const done = l?.bot?.offDone;
  if (done && done.n !== lineOffSeen) {
    lineOffSeen = done.n;
    Object.assign(l.enabled ? lineBotUi : lineSettingsUi, { stopped: true, left: done.left ?? [], unfinished: '', notStarted: false });
  }
  const shown = l?.enabled ? {
    ...l,
    ...(l.bot && lineBotUi.pendingOn != null ? { bot: { ...l.bot, on: lineBotUi.pendingOn } } : {}),
    names: lineSettingsUi.names != null ? [lineSettingsUi.names] : l.names,
    keywords: lineSettingsUi.keywords != null ? [lineSettingsUi.keywords] : l.keywords,
  } : l;
  // A field in focus that the "can't be read" line replaces: focus goes to the switch.
  if (l?.bot?.stuck && document.activeElement?.id?.startsWith('line-bot-')) lineBotUi.focusAfter = 'opt-line-bot';
  paint($('line-settings'), lineSettingsHtml(shown, { privacy: prefs.private, online, state: lineSettingsUi, bot: lineBotUi }));
  // After a Save, focus goes to what replaced the field, once it is drawn.
  if (lineBotUi.focusAfter && $(lineBotUi.focusAfter)) {
    $(lineBotUi.focusAfter).focus({ preventScroll: true });
    lineBotUi.focusAfter = '';
  }
}
// A relay link typed but not saved goes (privacy mode turned on, or
// Settings closed), drawn afresh with focus already off the fields. The
// words on stopping LINE sending to the relay hold nothing private: they
// stay until Settings closes.
function forgetLineBotDrafts({ closing = false } = {}) {
  const stopped = [lineBotUi.stopped, lineSettingsUi.stopped];
  dropLineBotDrafts(lineBotUi);
  dropLineDrafts(lineSettingsUi);
  if (!closing) [lineBotUi.stopped, lineSettingsUi.stopped] = stopped;
  // No signature, so even an empty section is drawn again.
  delete $('line-settings').dataset.sig;
  renderLineSettings();
}
// The bot part's buttons. Its outcome (collecting, then when, or why it
// failed) comes with the snapshot; only a refusal before collecting is
// said here.
async function lineBotAction(act) {
  const cannot = snapshot.demo ? english('said.ui.demoBot') : english('said.ui.previewCannot');
  if (act === 'bot-copy-script') {
    const res = bridge.lineBotCopyScript ? await bridge.lineBotCopyScript().catch(lineNoAnswer) : { ok: false, error: english('said.ui.previewCopy') };
    lineBotUi.scriptNote = res.ok ? english('said.ui.scriptCopied') : '';
    lineBotUi.scriptError = res.ok ? '' : res.error;
    renderLineSettings();
  } else if (act === 'bot-change-link') {
    lineBotUi.linkEditing = true;
    renderLineSettings();
    $('line-bot-link')?.focus();
  } else if (act === 'bot-replace-secret') {
    lineBotUi.secretEditing = true;
    renderLineSettings();
    $('line-bot-secret')?.focus();
  } else if (act === 'bot-cancel-link' || act === 'bot-cancel-secret') {
    // Back to what is saved, and to the button that opened the field.
    if (act === 'bot-cancel-link') Object.assign(lineBotUi, { linkEditing: false, linkError: '', linkDraft: null });
    else Object.assign(lineBotUi, { secretEditing: false, secretError: '' });
    renderLineSettings();
    $(act === 'bot-cancel-link' ? 'line-bot-change-link' : 'line-bot-replace-secret')?.focus();
  } else if (act === 'bot-refresh') {
    if (snapshot.demo || !bridge.lineBotRefresh) {
      lineBotUi.note = cannot;
      renderLineSettings();
      return;
    }
    Object.assign(lineBotUi, { note: '', refreshError: '' });
    renderLineSettings();
    const res = await bridge.lineBotRefresh().catch(lineNoAnswer);
    if (!res.ok && !res.collected) lineBotUi.refreshError = res.error;
    renderLineSettings();
    renderLine();
  }
}
// After Add or Dismiss the item hides at once (linePending) and focus moves
// to the same action on the next item still listed, else the one before
// it, else the section's heading. order: the items' keys when the button
// was pressed (the demo, or a snapshot meanwhile, may have dropped the item).
const lineKeys = () => (lineState()?.items ?? []).map((it) => it.key);
function hideLineItem(act, key, order) {
  linePending.add(key);
  renderLine();
  const listed = new Set(lineKeys());
  const next = nextFocus(order, new Set(order.filter((k) => !listed.has(k))), key);
  const to = next && $('line-body').querySelector(`[data-key="line-${act}-${CSS.escape(next)}"]`);
  (to ?? $('line-h'))?.focus({ preventScroll: true });
}

// ---- the Send to agent sheet: modal like the field feedback one (the board
// and the map behind it are inert until it closes), one draft per item.
function lineForm() {
  const form = $('line-send-form');
  if (!form) return null;
  return {
    key: form.dataset.key,
    prompt: $('line-prompt').value,
    cwd: $('line-cwd').value,
    session: $('line-session')?.value,
    target: document.querySelector('input[name="line-target"]:checked')?.value,
  };
}
function paintLineStatus() {
  const s = sendStatus(lineSend);
  $('line-send-status').setAttribute('aria-live', s.ok ? 'polite' : 'assertive');
  $('line-send-status').textContent = s.text;
  $('line-send-status').classList.toggle('is-error', !s.ok);
}
// The sheet is drawn only when something in it changes (never on a timer),
// after taking what the user typed or chose, so nothing they edit is lost.
function paintLineSheet() {
  if (!lineSend) return;
  lineSend = takeEdits(lineSend, lineForm());
  const at = document.activeElement?.id;
  $('line-sheet-body').innerHTML = lineSheetHtml(lineSend, { folders: folderChoices(lineProjects(), lineSend.browsed), targets: lineTargets });
  paintLineStatus();
  if (at && $(at) && $('line-sheet').contains($(at))) $(at).focus({ preventScroll: true });
}
function setLineSheet(open) {
  if (open === !$('line-sheet').hidden) return;
  $('line-sheet').hidden = !open;
  for (const el of document.querySelectorAll('.board, .stage')) el.inert = open;
  if (open) {
    lineOpener = document.activeElement;
    paintLineSheet();
    $('line-prompt')?.focus();
    $('line-prompt')?.setSelectionRange(0, 0);
  } else {
    // The item's draft is kept, and the sheet emptied, so the next item's
    // sheet starts from its own.
    if (lineSend) lineDrafts.set(lineSend.key, { ...takeEdits(lineSend, lineForm()), status: null, errors: null, busy: false });
    lineSend = null;
    $('line-sheet-body').innerHTML = '';
    $('line-send-status').textContent = '';
    // The board may have been redrawn meanwhile: find the opener by its key.
    const key = lineOpener?.dataset?.key;
    const back = lineOpener?.isConnected ? lineOpener : key && $('line-body').querySelector(`[data-key="${CSS.escape(key)}"]`);
    (back || $('line-body').querySelector('button'))?.focus();
    lineOpener = undefined;
  }
}
async function openLineSend(key) {
  const item = lineState()?.items?.find((it) => it.key === key);
  if (!item || prefs.private) return;
  if (!$('line-sheet').hidden) setLineSheet(false);
  lineSend = sendDraft(lineDrafts, item);
  lineTargets = null;
  setLineSheet(true);
  const targets = snapshot.demo || !bridge.lineTargets ? { sessions: ['work', 'notes'], why: null }
    : await bridge.lineTargets().catch((err) => {
      lineLog(err);
      return { sessions: [], why: english('said.ui.noSessionsAsked') };
    });
  if (!lineSend || lineSend.key !== key) return; // closed, or another item's sheet, meanwhile
  lineTargets = targets;
  if (!lineSend.session || !targets.sessions.includes(lineSend.session)) lineSend.session = targets.sessions[0] ?? '';
  paintLineSheet();
}
async function lineMark(key, what) {
  if (snapshot.demo) {
    lineDemoMarks.add(key);
    return { ok: true };
  }
  if (!bridge.lineSet) return { ok: false, error: english('said.ui.previewSave') };
  return bridge.lineSet({ mark: { key, what } }).catch(lineNoAnswer);
}
async function lineAction(act, key) {
  lineUi.error = '';
  if (act?.startsWith('bot-')) {
    await lineBotAction(act);
    return;
  }
  if (act === 'settings') showInSettings('line-settings-h');
  else if (act === 'choose-folder' && (snapshot.demo || !bridge.lineChooseFolder)) {
    lineSettingsUi.note = snapshot.demo ? english('said.ui.demoNoFolder') : english('said.ui.previewFolder');
    renderLineSettings();
    return;
  } else if (act === 'privacy') {
    showInSettings('screen-h');
    $('opt-private').focus();
  } else if (act === 'more' || act === 'fewer') lineUi.all = act === 'more';
  else if (act === 'expand') {
    if (lineUi.expanded.has(key)) lineUi.expanded.delete(key);
    else lineUi.expanded.add(key);
  } else if (act === 'add') {
    const open = lineUi.adding === key;
    Object.assign(lineUi, { adding: open ? null : key, todo: null, project: null });
    renderLine();
    if (!open) $(`line-todo-${key}`)?.focus();
    return;
  } else if (act === 'cancel-add') {
    lineUi.adding = null;
    renderLine();
    document.querySelector(`[data-key="line-add-${CSS.escape(key)}"]`)?.focus();
    return;
  } else if (act === 'dismiss') {
    const order = lineKeys();
    const res = await lineMark(key, 'dismissed');
    if (res.ok) {
      setLineStatus({ text: english('said.ui.dismissed'), undo: key });
      hideLineItem('dismiss', key, order);
    } else {
      Object.assign(lineUi, { error: english('said.ui.notDismissed', { why: res.error }), errorKey: key });
      renderLine();
    }
    return;
  } else if (act === 'undo') {
    let res = { ok: true };
    if (snapshot.demo) lineDemoMarks.delete(key);
    else if (!bridge.lineSet) res = { ok: false, error: english('said.ui.previewSave') };
    else res = await bridge.lineSet({ unmark: { key } }).catch(lineNoAnswer);
    setLineStatus({ text: res.ok ? english('said.ui.listedAgain') : english('said.ui.notUndone', { why: res.error }) });
    if (res.ok) linePending.delete(key);
    renderLine();
    setTimeout(renderLine, 600);
    if (res.ok) setTimeout(() => document.querySelector(`[data-key="line-dismiss-${CSS.escape(key)}"]`)?.focus({ preventScroll: true }), 650);
    return;
  } else if (act === 'send') {
    openLineSend(key);
    return;
  } else if (act === 'choose-folder') {
    const res = await bridge.lineChooseFolder().catch(lineNoAnswer);
    lineSettingsUi.error = res.ok || res.canceled ? '' : res.error;
    renderLineSettings();
    setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
    return;
  }
  renderLine();
  setTimeout(renderLine, 600);
}
for (const id of ['line-body', 'line-settings', 'line-status']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-line]');
    if (b && !b.disabled) lineAction(b.dataset.line, b.dataset.item);
  });
}
// What is typed in the add form survives the board's redraws.
$('line-body').addEventListener('input', (e) => {
  if (e.target.id?.startsWith('line-todo-')) lineUi.todo = e.target.value;
});
$('line-body').addEventListener('change', (e) => {
  if (e.target.id?.startsWith('line-project-')) lineUi.project = e.target.value;
});
$('line-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('form.line-add');
  if (!form) return;
  const key = form.dataset.item;
  const text = $(`line-todo-${key}`).value.trim();
  const project = $(`line-project-${key}`).value;
  if (!text) {
    Object.assign(lineUi, { error: english('said.projects.typeTodo'), errorKey: key });
    renderLine();
    $(`line-todo-${key}`)?.focus();
    return;
  }
  const order = lineKeys();
  let res;
  if (snapshot.demo) {
    res = await demoProj.change({ op: 'add-todo', project, text });
    if (res.ok) lineDemoMarks.add(key);
  } else if (!bridge.lineAdd) res = { ok: false, error: english('said.ui.previewProjects') };
  else res = await bridge.lineAdd({ key, project, text }).catch(lineNoAnswer);
  if (res.ok) {
    const name = lineProjects().find((p) => p.id === project)?.name ?? english('said.ui.theProject');
    Object.assign(lineUi, { adding: null, todo: null, project: null });
    setLineStatus({ text: res.note ?? english('said.ui.addedTo', { name }) });
    renderProjects();
    // Added but not noted (stays): the item stays listed, as the note says.
    if (res.stays) {
      renderLine();
      document.querySelector(`[data-key="line-add-${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    } else hideLineItem('add', key, order);
    setTimeout(renderProjects, 600);
  } else {
    Object.assign(lineUi, { error: res.error, errorKey: key });
    renderLine();
    $(`line-todo-${key}`)?.focus();
  }
});
$('line-settings').addEventListener('input', (e) => {
  if (e.target.id === 'line-names') lineSettingsUi.names = e.target.value;
  if (e.target.id === 'line-keywords') lineSettingsUi.keywords = e.target.value;
});
$('line-settings').addEventListener('change', async (e) => {
  // The bot part's switch: on starts its set-up; off deletes its secret and kept messages.
  if (e.target.id === 'opt-line-bot') {
    if (snapshot.demo || !bridge.lineBotSet) return;
    Object.assign(lineBotUi, { pendingOn: e.target.checked, pendingAt: Date.now() });
    const res = await bridge.lineBotSet({ on: e.target.checked }).catch(lineNoAnswer);
    Object.assign(lineBotUi, {
      linkEditing: false, linkDraft: null, linkError: '', secretEditing: false, secretError: '', secretNote: '', scriptNote: '', scriptError: '', note: '', tickError: '', refreshError: '',
      error: res.ok ? '' : res.error, ...(res.ok ? {} : { pendingOn: null }), focusAfter: 'opt-line-bot', stopped: Boolean(res.stop), left: res.left ?? [], unfinished: res.unfinished ?? '', notStarted: Boolean(res.notStarted),
    });
    renderLineSettings();
    setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
    return;
  }
  const group = e.target.closest('input[type="checkbox"][data-group]');
  if (group) {
    if (snapshot.demo || !bridge.lineBotSet) {
      group.checked = !group.checked;
      lineBotUi.note = snapshot.demo ? english('said.ui.demoTickGroup') : english('said.ui.previewNoSave');
      renderLineSettings();
      return;
    }
    const res = await bridge.lineBotSet({ tick: { id: group.dataset.group, on: group.checked } }).catch(lineNoAnswer);
    Object.assign(lineBotUi, { tickError: res.ok ? '' : res.error, note: res.note ?? '' });
    if (!res.ok) group.checked = !group.checked;
    renderLineSettings();
    setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
    return;
  }
  const tick = e.target.closest('input[type="checkbox"][data-chat]');
  if (!tick) return;
  if (snapshot.demo || !bridge.lineSet) {
    tick.checked = !tick.checked;
    lineSettingsUi.note = snapshot.demo ? english('said.ui.demoTickChat') : english('said.ui.previewNoSave');
    renderLineSettings();
    return;
  }
  const res = await bridge.lineSet({ tick: { chat: tick.dataset.chat, on: tick.checked } }).catch(lineNoAnswer);
  // Said under the chats list, in the main process's own words.
  lineSettingsUi.tickError = res.ok ? '' : res.error;
  if (!res.ok) tick.checked = !tick.checked;
  renderLineSettings();
  setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
});
$('line-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'line-bot-link-form') {
    const typed = $('line-bot-link').value;
    if (snapshot.demo || !bridge.lineBotSet) {
      lineBotUi.note = snapshot.demo ? english('said.ui.demoLink') : english('said.ui.previewNoSave');
      renderLineSettings();
      return;
    }
    const res = await bridge.lineBotSet({ link: typed }).catch(lineNoAnswer);
    // Refused: the link stays as typed, to be put right.
    Object.assign(lineBotUi, res.ok
      ? { linkError: '', linkDraft: null, linkEditing: false, focusAfter: 'line-bot-change-link', secretNote: res.secretNote ?? '' }
      : { linkError: res.error, linkDraft: typed });
    renderLineSettings();
    if (!res.ok) $('line-bot-link')?.focus();
    setTimeout(renderLineSettings, 600);
    return;
  }
  if (e.target.id === 'line-bot-secret-form') {
    // Read once and cleared at once: the secret stays in no field or state.
    const input = $('line-bot-secret');
    const secret = input.value;
    input.value = '';
    if (snapshot.demo || !bridge.lineBotSaveSecret) {
      lineBotUi.note = snapshot.demo ? english('said.ui.demoSecret') : english('said.ui.previewNoSave');
      renderLineSettings();
      return;
    }
    const res = await bridge.lineBotSaveSecret(secret).catch(lineNoAnswer);
    Object.assign(lineBotUi, res.ok
      ? { secretError: '', secretEditing: false, secretNote: '', focusAfter: 'line-bot-replace-secret' }
      : { secretError: res.error });
    renderLineSettings();
    if (!res.ok) $('line-bot-secret')?.focus();
    setTimeout(renderLineSettings, 600);
    return;
  }
  if (e.target.id !== 'line-words-form') return;
  if (snapshot.demo || !bridge.lineSet) {
    lineSettingsUi.note = snapshot.demo ? english('said.ui.demoWords') : english('said.ui.previewNoSave');
    renderLineSettings();
    return;
  }
  const res = await bridge.lineSet({ names: $('line-names').value, keywords: $('line-keywords').value }).catch(lineNoAnswer);
  // Said under the form's Save, in the main process's own words (they say it was not saved).
  lineSettingsUi.wordsError = res.ok ? '' : res.error;
  // "Saved 10 names; the rest were left out." when there were more.
  if (res.ok) Object.assign(lineSettingsUi, { names: null, keywords: null, note: res.note ?? english('said.ui.wordsSaved') });
  renderLineSettings();
  setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
});
$('opt-line').addEventListener('change', async (e) => {
  if (!bridge.lineSet) return;
  lineSwitchedAt = Date.now();
  const res = await bridge.lineSet({ enabled: e.target.checked }).catch(lineNoAnswer);
  // Said under the switch, even while LINE chats stays off.
  lineSettingsUi.switchError = res.ok ? '' : res.error;
  if (!res.ok) lineSwitchedAt = 0;
  Object.assign(lineSettingsUi, { names: null, keywords: null, note: '', wordsError: '', tickError: '', stopped: Boolean(res.stop), left: res.left ?? [], unfinished: res.unfinished ?? '', notStarted: Boolean(res.notStarted), ...(res.ok ? { error: '' } : {}) });
  Object.assign(lineBotUi, {
    linkEditing: false, linkDraft: null, linkError: '', secretEditing: false, secretError: '', secretNote: '', scriptNote: '', scriptError: '', note: '', error: '', tickError: '', refreshError: '', pendingOn: null,
  });
  Object.assign(lineUi, { adding: null, todo: null, project: null, error: '' });
  lineDrafts.clear();
  setLineStatus(null);
  renderLineSettings();
  setTimeout(() => { renderLine(); renderLineSettings(); }, 600);
});
$('line-sheet-body').addEventListener('change', (e) => {
  // Choosing where it runs shows or hides the session list.
  if (e.target.name === 'line-target' && lineSend) paintLineSheet();
});
$('line-sheet-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-line="browse"]');
  if (!b || !lineSend) return;
  const res = snapshot.demo || !bridge.lineBrowse ? { ok: false, error: snapshot.demo ? english('said.ui.demoBrowse') : english('said.ui.previewBrowse') }
    : await bridge.lineBrowse().catch(lineNoAnswer);
  if (res.canceled || !lineSend) return;
  lineSend = takeEdits(lineSend, lineForm()); // take what is typed first
  if (res.ok) {
    lineSend = { ...lineSend, browsed: [...new Set([...(lineSend.browsed ?? []), res.path])], cwd: res.path, status: null, errors: null };
  } else lineSend.status = { ok: false, text: res.error };
  $('line-sheet-body').innerHTML = lineSheetHtml(lineSend, { folders: folderChoices(lineProjects(), lineSend.browsed), targets: lineTargets });
  paintLineStatus();
  $('line-browse')?.focus();
});
$('line-sheet-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!lineSend || lineSend.busy) return;
  lineSend = takeEdits(lineSend, lineForm());
  const target = lineSend.target === 'wt' || !lineTargets?.sessions?.length ? 'wt' : 'tmux';
  const req = { key: lineSend.key, prompt: lineSend.prompt, cwd: lineSend.cwd, target, session: lineSend.session };
  // Each missing piece is said at its own field, and focus goes there.
  const errors = {
    ...(req.prompt.trim() ? {} : { prompt: english('said.ui.writePrompt') }),
    ...(req.cwd ? {} : { cwd: english('said.lc.folderFirst') }),
  };
  lineSend.errors = Object.keys(errors).length ? errors : null;
  lineSend.status = null;
  if (lineSend.errors) {
    paintLineSheet();
    $(errors.prompt ? 'line-prompt' : 'line-cwd')?.focus();
    return;
  }
  if (snapshot.demo || !bridge.lineStart) {
    lineSend.status = { ok: true, text: snapshot.demo ? english('said.ui.demoStart', { where: target === 'tmux' ? english('said.ui.tmuxIn', { session: req.session }) : english('said.lc.newTab') }) : english('said.ui.previewStart') };
    paintLineSheet();
    return;
  }
  lineSend.busy = true;
  paintLineSheet();
  const res = await bridge.lineStart(req).catch(lineNoAnswer);
  if (!lineSend || lineSend.key !== req.key) return;
  lineSend.busy = false;
  lineSend.status = res.ok ? { ok: true, text: english('said.ui.startedIn', { where: res.label }) } : { ok: false, text: res.error };
  paintLineSheet();
  $('line-start')?.focus();
});
$('line-sheet-close').addEventListener('click', () => setLineSheet(false));
document.addEventListener('pointerdown', (e) => {
  if ($('line-sheet').hidden || $('line-sheet').contains(e.target)) return;
  setLineSheet(false);
  // The press then moves focus to the page itself; put it back on what
  // setLineSheet just focused, unless the press landed on a control.
  const back = document.activeElement;
  setTimeout(() => {
    if (document.activeElement === document.body) back?.focus({ preventScroll: true });
  }, 0);
});
$('line-sheet').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    setLineSheet(false);
  } else if (e.key === 'Tab') {
    // Tab and Shift+Tab go round inside the sheet.
    const stops = [...$('line-sheet').querySelectorAll('button, select, input, textarea, [tabindex="0"]')]
      .filter((el) => !el.disabled && el.offsetParent && !(el.type === 'radio' && !el.checked));
    if (!stops.length) return;
    const [first, last] = [stops[0], stops[stops.length - 1]];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === $('line-sheet'))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
setInterval(() => {
  renderLine();
  if (!$('settings').hidden) renderLineSettings();
}, 1000);

// ---- the mini window and other computers --------------------------------------

$('cam-mini').addEventListener('click', () => {
  // The browser preview has no second window: open the page in a new tab.
  if (bridge.openMini) bridge.openMini();
  else window.open(`mini.html${prefs.demo ? '?demo=1' : ''}`, '_blank', 'width=360,height=540');
});

function showFleet() {
  const on = Boolean(snapshot.fleet?.on);
  $('fleet-off').hidden = !on || snapshot.demo;
  $('fleet-choose').textContent = tr(on ? 'settings.fleet.another' : 'settings.fleet.choose');
  const others = (snapshot.fleet?.computers ?? []).length;
  const f = snapshot.fleet ?? {};
  const where = prefs.private || !f.dir ? '' : tr('fleet.where', { dir: f.dir });
  const pulled = f.lastPull ? (f.lastPull.ok ? tr('fleet.lastPull', { time: clock(f.lastPull.at) }) : tr('fleet.pullFailed', { error: said(f.lastPull.error) })) : '';
  const found = (none) => (others ? tr('fleet.found', { n: others }) : tr(none));
  $('fleet-status').textContent = snapshot.demo ? tr('fleet.demo')
    : !on ? tr('fleet.off')
      : f.mode === 'git' ? tr('fleet.git', { where, pulled, found: found('fleet.noneGit') })
        : tr('fleet.sharing', { where, found: found('fleet.noneFolder') });
}
$('fleet-choose').addEventListener('click', async () => {
  if (!bridge.fleetChoose) {
    $('fleet-status').textContent = tr('fleet.preview');
    return;
  }
  const res = await bridge.fleetChoose();
  if (!res.ok && !res.canceled) $('fleet-status').textContent = said(res.error);
});
$('fleet-git').addEventListener('click', async () => {
  if (!bridge.fleetGitChoose) {
    $('fleet-status').textContent = tr('fleet.preview');
    return;
  }
  const res = await bridge.fleetGitChoose();
  if (!res.ok && !res.canceled) $('fleet-status').textContent = said(res.error);
});
$('fleet-off').addEventListener('click', async () => {
  const res = await bridge.fleetOff?.();
  if (res && !res.ok) $('fleet-status').textContent = said(res.error);
});
setInterval(() => { if (!$('settings').hidden) showFleet(); }, 1000);

// ---- settings groups -----------------------------------------------------------
//
// Settings is five groups (index.html), each closed to its name and a
// one-line summary of what is set; one opens at a time, and the last one
// opened opens again next time.

const SETTINGS_GROUPS = ['look', 'privacy', 'connect', 'agents', 'app'];
const GROUP_KEY = 'agents-home-settings-group';
let updateSummary = tr('summary.app');

function rememberedGroup() {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return SETTINGS_GROUPS.includes(g) ? g : null;
  } catch {
    return null; // storage blocked: Settings just opens with every group closed
  }
}
// name: the group to open, or null for all closed.
function openGroup(name, { remember = true } = {}) {
  for (const g of SETTINGS_GROUPS) {
    const open = g === name;
    $(`group-${g}-body`).hidden = !open;
    $(`group-${g}-btn`).setAttribute('aria-expanded', String(open));
  }
  if (!remember) return;
  try {
    localStorage.setItem(GROUP_KEY, name ?? '');
  } catch {
    // Storage blocked or full: the group is not remembered for next time,
    // which changes nothing else.
  }
}
for (const g of SETTINGS_GROUPS) {
  $(`group-${g}-btn`).addEventListener('click', (e) => {
    openGroup(e.currentTarget.getAttribute('aria-expanded') === 'true' ? null : g);
  });
}
// Settings opened at the group holding an element, scrolled to it.
function showInSettings(id, block = 'start') {
  if ($('settings').hidden) setSettings(true);
  const group = $(id)?.closest('[data-group]')?.dataset.group;
  if (group) openGroup(group);
  $(id)?.scrollIntoView({ block });
  // Keyboard users land where the link pointed (headings carry tabindex="-1").
  $(id)?.focus({ preventScroll: true });
}
// Any button with data-settings="<id>" (outside the field section's own
// actions) is a link into Settings.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-settings]');
  if (b && !b.disabled) showInSettings(b.dataset.settings);
});

// What each closed group says. Only settings and states, never a file,
// sheet or folder name, so privacy mode changes nothing here.
function groupSummaries() {
  const theme = document.querySelector(`input[name="theme"][value="${CSS.escape(prefs.theme)}"]`)?.parentElement?.textContent.trim() || prefs.theme;
  const time = prefs.time === 'auto' ? tr('summary.time.auto') : ($('opt-time').selectedOptions[0]?.textContent.toLowerCase() ?? prefs.time);
  const wait = Number(prefs.waitMin ?? 5);
  const f = snapshot?.field;
  const field = tr(!f?.enabled ? 'summary.field.off'
    : f.demo ? 'summary.field.demo'
      : !f.sheetUrl || !f.keyName ? 'summary.field.notSet'
        : f.error ? 'summary.field.failed'
          : f.fetchedAt ? 'summary.field.updated' : 'summary.field.notYet', { age: f?.fetchedAt ? fieldAge(f.fetchedAt) : '' });
  return {
    look: `${theme} · ${time}`,
    privacy: `${tr(prefs.private ? 'summary.privacy.on' : 'summary.privacy.off')} · ${wait ? tr('summary.wait', { n: wait }) : tr('summary.noWait')}`,
    connect: `${field} · ${lineSummary(lineState())} · ${tr(snapshot?.fleet?.on ? 'summary.fleet.on' : 'summary.fleet.off')}`,
    agents: tr('summary.report', { period: $('report-days').selectedOptions[0]?.textContent.toLowerCase() ?? tr('settings.report.days', { n: 28 }).toLowerCase() }),
    app: `${updateSummary}${prefs.demo ? ` · ${tr('summary.demoOn')}` : ''}`,
  };
}
function renderGroupSummaries() {
  for (const [g, words] of Object.entries(groupSummaries())) $(`group-${g}-summary`).textContent = words;
}
setInterval(() => { if (!$('settings').hidden) renderGroupSummaries(); }, 1000);

// ---- settings panel ------------------------------------------------------------

function setSettings(open) {
  $('settings').hidden = !open;
  $('settings-open').setAttribute('aria-expanded', String(open));
  if (open) {
    openGroup(rememberedGroup(), { remember: false });
    showUpdateInfo();
    showLogStatus();
    showFleet();
    renderFieldSettings();
    renderLineSettings();
    renderGroupSummaries();
    $('settings-close').focus();
  }
  else {
    if (buildMode) setBuildMode(false);
    $('settings-open').focus();
    // A link typed but not saved is not kept past Settings.
    forgetFieldDrafts();
    forgetLineBotDrafts({ closing: true });
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
try {
  if (sessionStorage.getItem(REOPEN_LANGUAGE)) {
    sessionStorage.removeItem(REOPEN_LANGUAGE);
    setSettings(true);
    $('opt-language').focus();
  }
} catch {
  // Storage blocked: Settings stays closed after the switch, as on any start.
}
