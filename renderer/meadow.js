// The Meadow: a second screen, away from the hospital, where every agent
// lives as a creature it raised itself. Each agent starts as an egg; the
// tokens it uses hatch it (you pick one of three starters), grow it, and
// evolve it twice. Good work earns it rarity (R, SR, SSR). Clicking one
// shows its numbers in the sidebar. The numbers are the performance
// report's, worked out on request; the growing up is renderer/growth.js.

import { SPECIES, VARIANTS, drawCreature, creatureThumb, defaultCreature, lookOf, setCreatureLight, facingOf, STAGE_NAMES, drawEgg, eggThumb, eggSeed } from './creatures.js';
import { P, box, poly, viewDepth, faceVisible, getView } from './iso.js';
import { shade, mix } from './themes.js';
import { HATCH_AT, STAGES, mergeLedger, lifetimeTokens, lifeOf, sizeOf, rarityFrom, bestRarity, starterChoices, flies } from './growth.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compact = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`);
const pct = (v) => (v === undefined || v === null ? '–' : `${Math.round(v * 100)}%`);
function dur(ms) {
  if (ms === undefined || ms === null) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Made-up numbers for the demo's four staff, so the Meadow has something to show.
function demoStats(names) {
  return names.map((name, i) => {
    const runs = [42, 17, 9, 26][i % 4];
    return {
      name, runs, successRate: [0.93, 0.82, 1, 0.88][i % 4], rerunRate: [0.05, 0.12, 0, 0.08][i % 4],
      medianMs: [48_000, 190_000, 72_000, 64_000][i % 4], medianTokens: [38_000, 120_000, 55_000, 41_000][i % 4],
      totalTokens: [1_900_000, 2_600_000, 480_000, 1_100_000][i % 4], toolErrorRate: [0.02, 0.06, 0.01, 0.03][i % 4],
      verdicts: i % 4 === 0 ? { PASS: 30, FAIL: 8 } : {}, score: [88, 71, 94, 80][i % 4],
      daily: Array.from({ length: 14 }, (_, d) => ({ day: `d${d}`, runs: (d * 7 + i * 3) % 5 })),
    };
  });
}

// The island: a floating block of grass tiles, like one of the hospital's

// The demo's creatures, to show every part of growing up (kept in memory only).
const DEMO_NEST = {
  Explore: { species: 'dragon', variant: 3, stage: 3, rarity: 'SSR' },
  reviewer: { species: 'cat', variant: 1, stage: 2, rarity: 'SR' },
  runner: { species: 'fish', variant: 1, stage: 1, rarity: 'R' },
};
const DEMO_TOKENS = { Explore: 9_000_000, reviewer: 2_600_000, runner: 1_200_000, 'silent-failure-hunter': 130_000, 'ui-reviewer': 42_000 };

// ---- the island ---------------------------------------------------------------------
//
// Nine 4 x 4 plots at different heights, stepping down toward the front like
// Monument Valley terraces. Neighbouring plots differ by half a block at
// most, so creatures hop from one to the next. The lowest holds the pond.

const N = 12;
const X0 = 5; // tiles X0 .. X0+N-1 on both axes; the view turns about 11, 11
const PLOT = 4;
const HEIGHTS = [ // [row along y][column along x]
  [1.5, 1.0, 0.5],
  [1.0, 0.5, 0.0],
  [0.5, 0.0, 0.0],
];
const BASE = -2.2;
const POND = { x: 13, y: 13, w: 3, h: 3 };
const WATER = -0.25; // below the pond plot's grass
const TREES = [[6, 7], [8, 5], [15, 6], [6, 14], [11, 8]];
const BUSHES = [[10, 5], [5, 11], [13, 16], [9, 15]];
const plotOf = (x, y) => [Math.floor((x - X0) / PLOT), Math.floor((y - X0) / PLOT)];
const onIsland = (x, y) => x >= X0 && y >= X0 && x < X0 + N && y < X0 + N;
const groundAt = (x, y) => {
  const [c, r] = plotOf(Math.floor(x), Math.floor(y));
  return HEIGHTS[Math.max(0, Math.min(2, r))][Math.max(0, Math.min(2, c))];
};
const inPond = (x, y) => x >= POND.x && x < POND.x + POND.w && y >= POND.y && y < POND.y + POND.h;
const blocked = new Set([...TREES, ...BUSHES].map(([x, y]) => `${x},${y}`));
const walkable = (x, y) => onIsland(x, y) && !inPond(x, y) && !blocked.has(`${x},${y}`);

function hashOf(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// Flowers on a fixed scatter of free tiles.
const FLOWERS = [];
for (let i = 0; i < 22; i++) {
  const h = hashOf(`flower${i}`);
  const x = X0 + (h % N);
  const y = X0 + ((h >>> 8) % N);
  if (walkable(x, y)) FLOWERS.push([x + 0.2 + ((h >>> 16) % 6) / 10, y + 0.2 + ((h >>> 20) % 6) / 10, ['#f7b8c8', '#fff4b8', '#c9b6f2', '#ffffff'][i % 4]]);
}

const tilesWhere = (ok) => {
  const out = [];
  for (let x = X0; x < X0 + N; x++) for (let y = X0; y < X0 + N; y++) if (ok(x, y)) out.push([x, y]);
  return out;
};
const LAND = tilesWhere(walkable);
const POOL = tilesWhere(inPond);
const SKY = tilesWhere(onIsland);

const RARITY_TEXT = { R: '', SR: '★ SR', SSR: '★★ SSR' };

export function createMeadow({ bridge, prefs, savePrefs, getSnapshot, getLight, onEnter, onExit }) {
  let open = false;
  let stats = { names: new Map(), seen: [], error: '', loading: false, at: 0 };
  let selected;
  let notice = ''; // a line for the panel after hatching or evolving
  const demoNest = structuredClone(DEMO_NEST);

  const demo = () => Boolean(getSnapshot().demo);
  // What was kept in the preferences, checked once: an entry for a kind of
  // creature this version does not have (or a damaged one) goes back to
  // being an egg rather than breaking the drawing loop.
  const kinds = new Set(SPECIES.map((sp) => sp.id));
  if (!prefs.nest || typeof prefs.nest !== 'object' || Array.isArray(prefs.nest)) prefs.nest = {};
  for (const [name, e] of Object.entries(prefs.nest)) {
    const ok = e && kinds.has(e.species) && Number.isInteger(e.stage) && e.stage >= 1 && e.stage <= STAGES;
    if (!ok) delete prefs.nest[name];
    else {
      if (!Number.isInteger(e.variant) || e.variant < 0 || e.variant >= VARIANTS) delete e.variant;
      if (!['R', 'SR', 'SSR'].includes(e.rarity)) e.rarity = 'R';
    }
  }
  if (!prefs.ledger || typeof prefs.ledger !== 'object' || Array.isArray(prefs.ledger)) prefs.ledger = {};
  // What each agent has hatched into; nothing while it is still an egg.
  const nest = () => (demo() ? demoNest : prefs.nest);
  const saveNest = () => { if (!demo()) savePrefs(); };
  const tokensOf = (name) => (demo() ? DEMO_TOKENS[name] ?? 0 : lifetimeTokens(prefs.ledger, name));
  const entryOf = (name) => nest()[name];
  const lifeFor = (name) => lifeOf(tokensOf(name), entryOf(name));
  const looks = (name) => {
    const e = entryOf(name);
    return { species: e.species, variant: e.variant ?? defaultCreature(name).variant, stage: e.stage ?? 1, rarity: e.rarity ?? 'R' };
  };

  // Everyone who lives here: the agents installed in .claude/agents, every
  // agent called in the transcripts read for the numbers, anyone at work
  // right now, and anyone met before (remembered, so an agent that has been
  // quiet for months still has its spot).
  function agents() {
    const snap = getSnapshot();
    const names = new Set(demo() ? [] : prefs.meadowSeen ?? []);
    for (const a of snap.roster ?? []) names.add(a.name);
    for (const sess of snap.sessions ?? []) for (const a of sess.agents ?? []) if (a.type) names.add(a.type);
    for (const n of stats.seen) names.add(n);
    for (const n of stats.names.keys()) names.add(n);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  function remember(names) {
    if (demo()) return; // the demo's made-up staff are not the user's agents
    const known = new Set(prefs.meadowSeen ?? []);
    if (names.every((n) => known.has(n))) return;
    prefs.meadowSeen = [...new Set([...known, ...names])].sort();
    savePrefs();
  }

  // Rarity is earned from the numbers and kept once earned.
  function earnRarity() {
    let changed = false;
    for (const [name, e] of Object.entries(nest())) {
      const r = bestRarity(e.rarity, rarityFrom(stats.names.get(name)));
      if (r !== e.rarity) {
        e.rarity = r;
        changed = true;
      }
    }
    if (changed) saveNest();
  }

  async function loadStats() {
    if (demo()) {
      const names = agents();
      stats = { names: new Map(demoStats(names).map((a) => [a.name, a])), seen: [], error: '', loading: false, at: Date.now() };
      return;
    }
    if (!bridge.agentStats) {
      stats = { ...stats, error: 'The numbers come from the desktop app; this preview cannot work them out.', loading: false, at: Date.now() };
      return;
    }
    stats = { ...stats, loading: true };
    renderPanel();
    const res = await bridge.agentStats();
    if (res.ok) {
      stats = { names: new Map(res.agents.map((a) => [a.name, a])), seen: res.seen ?? [], error: '', loading: false, at: Date.now() };
      prefs.ledger = mergeLedger(prefs.ledger, res.tokensByDay);
      savePrefs();
      earnRarity();
    } else {
      stats = { ...stats, error: res.error, loading: false, at: Date.now() };
    }
  }

  // ---- the creatures wander, like mobs in a block game ------------------------------
  //
  // Each picks a free tile, walks there along the grid (one leg of the trip
  // along x, the other along y), turning to face the way it goes, hopping up
  // or down between terraces, stops for a moment and sets off again. Fish
  // swim in the pond; grown dragons and birds fly anywhere. Eggs sit in
  // their nests.

  const walkers = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function kindOf(name) {
    const e = entryOf(name);
    if (!e) return 'egg';
    if (e.species === 'fish') return 'fish';
    return flies(e.species, e.stage) ? 'flyer' : 'land';
  }
  const tilesFor = (kind) => (kind === 'fish' ? POOL : kind === 'flyer' ? SKY : LAND);

  function settle(names) {
    for (const n of [...walkers.keys()]) if (!names.includes(n)) walkers.delete(n);
    const taken = new Set([...walkers.values()].map((w) => `${Math.floor(w.x)},${Math.floor(w.y)}`));
    for (const n of names) {
      const kind = kindOf(n);
      const w = walkers.get(n);
      if (w && w.kind === kind) continue;
      // A starting tile from the name, moved along until it is free; a
      // creature that has just hatched or evolved stays where it was.
      const tiles = tilesFor(kind === 'egg' ? 'land' : kind);
      let [x, y] = [];
      if (w && (kind !== 'fish' || inPond(Math.floor(w.x), Math.floor(w.y)))) [x, y] = [Math.floor(w.x), Math.floor(w.y)];
      else {
        let i = hashOf(n) % tiles.length;
        for (let tries = 0; tries < tiles.length && taken.has(String(tiles[i])); tries++) i = (i + 1) % tiles.length;
        [x, y] = tiles[i];
      }
      taken.add(`${x},${y}`);
      const ground = groundAt(x, y) + (kind === 'fish' ? WATER : 0);
      walkers.set(n, {
        kind, x: x + 0.5, y: y + 0.5, z: ground + (kind === 'flyer' ? 2.2 : 0), path: [], pause: (hashOf(n) % 30) / 10,
        facing: hashOf(n) % 4, step: 0, flash: w?.flash ?? 0,
      });
    }
  }

  // Can a walk go straight from (x0, y0) to (x1, y1)? Every tile on the way
  // must be free, and each step up or down at most half a block.
  function clear(kind, x0, y0, x1, y1) {
    if (kind === 'flyer') return true;
    const ok = kind === 'fish' ? inPond : walkable;
    const [ax, ay, bx, by] = [Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1)];
    const sx = Math.sign(bx - ax);
    const sy = Math.sign(by - ay);
    let [x, y] = [ax, ay];
    for (;;) {
      if (!ok(x, y)) return false;
      if (x === bx && y === by) return true;
      const [nx, ny] = [x + sx, y + sy];
      if (Math.abs(groundAt(nx, ny) - groundAt(x, y)) > 0.5) return false;
      [x, y] = [nx, ny];
    }
  }

  function plan(w) {
    const tiles = tilesFor(w.kind);
    for (let tries = 0; tries < 8; tries++) {
      const [tx, ty] = tiles[Math.floor(Math.random() * tiles.length)];
      if (Math.abs(tx + 0.5 - w.x) + Math.abs(ty + 0.5 - w.y) > (w.kind === 'flyer' ? 10 : 7)) continue;
      const [gx, gy] = [tx + 0.5, ty + 0.5];
      if (w.kind === 'flyer') {
        w.path = [[gx, gy]];
        return;
      }
      const mid = Math.random() < 0.5 ? [gx, w.y] : [w.x, gy];
      if (clear(w.kind, w.x, w.y, ...mid) && clear(w.kind, ...mid, gx, gy)) {
        w.path = [mid, [gx, gy]];
        return;
      }
    }
    w.pause = 1; // hemmed in: try again in a moment
  }

  function tick(w, dt, still, scale) {
    if (w.flash > 0) w.flash = Math.max(0, w.flash - dt);
    const floor = groundAt(w.x, w.y) + (w.kind === 'fish' ? WATER : 0);
    if (w.kind === 'flyer') w.z += (floor + 2.2 + 0.25 * Math.sin(performance.now() / 600) - w.z) * Math.min(1, dt * 3);
    else w.z += (floor - w.z) * Math.min(1, dt * 14); // a quick hop up or down a terrace
    if (still || w.kind === 'egg') return;
    if (w.kind === 'flyer') w.step += dt * 6; // wings beat even while hovering
    if (w.pause > 0) {
      w.pause -= dt;
      if (w.pause <= 0) plan(w);
      return;
    }
    if (!w.path.length) {
      w.pause = 1 + Math.random() * 3;
      return;
    }
    const [gx, gy] = w.path[0];
    const dx = gx - w.x;
    const dy = gy - w.y;
    const dist = Math.hypot(dx, dy);
    const speed = ({ fish: 0.9, flyer: 1.8, land: 1.2 })[w.kind] / Math.sqrt(scale);
    if (dist < 1e-3) {
      w.path.shift();
      if (!w.path.length) w.pause = 1 + Math.random() * 3;
      return;
    }
    w.facing = facingOf(dx, dy);
    const move = Math.min(dist, speed * dt);
    w.x += (dx / dist) * move;
    w.y += (dy / dist) * move;
    if (w.kind !== 'flyer') w.step += dt * 9 * Math.sqrt(1 / scale);
  }

  // ---- drawing ------------------------------------------------------------------

  let groundKey = '';
  let under = ''; // the island's stone underside
  let plots = []; // [{ c, r, svg }] each terrace with what grows on it
  let hits = []; // [{ name, depth, x0, y0, x1, y1 }] from the last frame

  function buildGround() {
    const { theme, phase } = getLight();
    setCreatureLight(theme, phase);
    const mat = (hex) => shade(hex, theme);
    // Greener than the stone's shading would make it: warmed less by the light.
    const grass = { ...mat(theme.materials.mint), top: mix(theme.materials.mint, theme.light, 0.3) };
    const stone = mat(theme.materials.stone);
    const water = mat(theme.materials.sky);
    const leaf = mat(theme.materials.leaf);
    const bush = mat(theme.materials.teal);
    const trunk = mat(theme.materials.sand);
    const tone = (c) => (phase === 'night' ? mix(c, theme.night.tint, theme.night.amount) : c);
    const light = mix(grass.top, '#ffffff', 0.18);
    under = box(X0 + 1.5, X0 + 1.5, BASE - 2.2, N - 3, N - 3, 1.2, stone) + box(X0 + 0.5, X0 + 0.5, BASE - 1.2, N - 1, N - 1, 1.2, stone);
    plots = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const h = HEIGHTS[r][c];
        const [px, py] = [X0 + c * PLOT, X0 + r * PLOT];
        let s = box(px, py, BASE, PLOT, PLOT, h - 0.4 - BASE, stone) + box(px, py, h - 0.4, PLOT, PLOT, 0.4, grass);
        for (let x = px; x < px + PLOT; x++) {
          for (let y = py; y < py + PLOT; y++) {
            if (inPond(x, y) || (x + y) % 2) continue;
            s += poly([[x, y, h], [x + 1, y, h], [x + 1, y + 1, h], [x, y + 1, h]], light);
          }
        }
        if (inPond(px + 1, py + 1)) {
          // The pond: water a little below the grass, its far banks showing.
          const { x: qx, y: qy, w: qw, h: qh } = POND;
          const wz = h + WATER;
          s += poly([[qx, qy, wz], [qx + qw, qy, wz], [qx + qw, qy + qh, wz], [qx, qy + qh, wz]], water.left);
          s += poly([[qx + 0.5, qy + 0.8, wz], [qx + 2.0, qy + 0.8, wz], [qx + 2.0, qy + 1.0, wz], [qx + 0.5, qy + 1.0, wz]], mix(water.left, '#ffffff', 0.5));
          s += poly([[qx + 1.1, qy + 2.0, wz], [qx + 2.6, qy + 2.0, wz], [qx + 2.6, qy + 2.2, wz], [qx + 1.1, qy + 2.2, wz]], mix(water.left, '#ffffff', 0.35));
          const banks = [
            [[1, 0], [[qx, qy], [qx, qy + qh]]], [[-1, 0], [[qx + qw, qy], [qx + qw, qy + qh]]],
            [[0, 1], [[qx, qy], [qx + qw, qy]]], [[0, -1], [[qx, qy + qh], [qx + qw, qy + qh]]],
          ];
          for (const [[nx, ny], [[ax, ay], [bx, by]]] of banks) {
            if (!faceVisible(nx, ny)) continue;
            s += poly([[ax, ay, h], [bx, by, h], [bx, by, wz], [ax, ay, wz]], nx ? grass.left : grass.right);
          }
        }
        for (const [x, y, col] of FLOWERS) {
          if (plotOf(Math.floor(x), Math.floor(y)).join() !== `${c},${r}`) continue;
          s += box(x, y, h, 0.06, 0.06, 0.18, mat(tone('#6cc47a')));
          s += box(x - 0.05, y - 0.05, h + 0.18, 0.16, 0.16, 0.12, mat(tone(col)));
        }
        // Trees and bushes are drawn with the creatures, in depth order.
        const things = [];
        for (const [x, y] of TREES) {
          if (plotOf(x, y).join() !== `${c},${r}`) continue;
          things.push({ depth: viewDepth(x + 0.5, y + 0.5), svg: box(x + 0.4, y + 0.4, h, 0.2, 0.2, 0.9, trunk) + box(x + 0.05, y + 0.05, h + 0.9, 0.9, 0.9, 0.8, leaf) + box(x + 0.25, y + 0.25, h + 1.7, 0.5, 0.5, 0.4, leaf) });
        }
        for (const [x, y] of BUSHES) {
          if (plotOf(x, y).join() === `${c},${r}`) things.push({ depth: viewDepth(x + 0.5, y + 0.5), svg: box(x + 0.15, y + 0.15, h, 0.7, 0.7, 0.55, bush) });
        }
        plots.push({ c, r, depth: viewDepth(px + PLOT / 2, py + PLOT / 2), svg: s, things });
      }
    }
    plots.sort((a, b) => a.depth - b.depth);
  }

  // Fit the view to the island as it is turned now, with room for fliers.
  function frame() {
    const corners = [];
    for (const [x, y] of [[X0, X0], [X0 + N, X0], [X0 + N, X0 + N], [X0, X0 + N]]) corners.push(P(x, y, 4.2), P(x, y, BASE - 2.2));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const pad = 24;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    return `${x0.toFixed(0)} ${y0.toFixed(0)} ${(Math.max(...xs) - x0 + pad).toFixed(0)} ${(Math.max(...ys) - y0 + pad).toFixed(0)}`;
  }

  function labelFor(n) {
    const e = entryOf(n);
    if (!e) return lifeFor(n).ready ? `${n} · hatch!` : `${n} · egg`;
    const r = RARITY_TEXT[e.rarity ?? 'R'];
    return `${n}${r ? ` ${r}` : ''}${lifeFor(n).ready ? ' · evolve!' : ''}`;
  }

  function renderScene() {
    const names = agents();
    settle(names);
    const svg = $('meadow');
    const time = performance.now() / 1000;
    const key = `${getView()}|${getLight().theme.name}|${getLight().phase}`;
    if (key !== groundKey || !svg.querySelector('#meadow-land')) {
      groundKey = key;
      buildGround();
      svg.setAttribute('viewBox', frame());
      svg.innerHTML = `<title>The Meadow: your agents as creatures</title><g id="meadow-under">${under}</g><g id="meadow-land"></g><g id="meadow-names"></g>
        ${names.length ? '' : `<text class="meadow-empty" x="${P(11, 11, 1)[0]}" y="${P(11, 11, 1)[1]}" text-anchor="middle">No agents yet</text>`}`;
    }
    hits = [];
    const onPlot = new Map(plots.map((p) => [`${p.c},${p.r}`, [...p.things]]));
    const sky = [];
    let labels = '';
    for (const [n, w] of walkers) {
      const life = lifeFor(n);
      const scale = sizeOf(life);
      const moving = w.kind === 'flyer' || (w.pause <= 0 && w.path.length > 0);
      let drawn;
      if (w.kind === 'egg') {
        drawn = drawEgg(eggSeed(n), { x: w.x, y: w.y, z: w.z, scale: scale * 1.1, facing: 1, progress: life.progress, ready: life.ready, time });
      } else {
        const L = looks(n);
        const bob = w.kind === 'fish' ? 0.04 * Math.sin(time * 2.5 + w.x) : 0;
        drawn = drawCreature(L.species, L.variant, {
          x: w.x, y: w.y, z: w.z + bob, ground: groundAt(w.x, w.y) + (w.kind === 'fish' ? WATER : 0),
          scale: w.kind === 'fish' ? scale * 0.85 : scale, facing: w.facing, step: moving ? w.step : null,
          flying: w.kind === 'flyer', stage: L.stage, rarity: life.ready ? 'ready' : L.rarity, time, glow: Math.min(1, w.flash / 1.2),
        });
      }
      const xs = drawn.pts.map((q) => q[0]);
      const ys = drawn.pts.map((q) => q[1]);
      hits.push({ name: n, depth: viewDepth(w.x, w.y) + (w.kind === 'flyer' ? 100 : 0), x0: Math.min(...xs) - 6, y0: Math.min(...ys) - 6, x1: Math.max(...xs) + 6, y1: Math.max(...ys) + 6 });
      const ring = n === selected
        ? `<polygon class="critter-ring" points="${[[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]].map(([a, b]) => P(w.x + a * scale, w.y + b * scale, groundAt(w.x, w.y)).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`
        : '';
      const item = { depth: viewDepth(w.x, w.y), svg: `<g class="critter${n === selected ? ' chosen' : ''}" data-agent="${esc(n)}">${ring}${drawn.svg}</g>` };
      if (w.kind === 'flyer') sky.push(item);
      else {
        const [c, r] = plotOf(Math.floor(w.x), Math.floor(w.y));
        onPlot.get(`${Math.max(0, Math.min(2, c))},${Math.max(0, Math.min(2, r))}`).push(item);
      }
      const text = labelFor(n);
      const [lx, ly] = P(w.x, w.y, drawn.height + 0.25);
      const half = text.length * 3.8 + 10;
      hits.push({ name: n, depth: 1e6, x0: lx - half, y0: ly - 16, x1: lx + half, y1: ly + 5 });
      labels += `<text class="critter-name${n === selected ? ' chosen' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${n === selected ? '▸ ' : ''}${esc(text)}</text>`;
    }
    // Each terrace, then what stands on it, back to front; fliers last.
    let land = '';
    for (const p of plots) {
      land += p.svg;
      land += onPlot.get(`${p.c},${p.r}`).sort((a, b) => a.depth - b.depth).map((i) => i.svg).join('');
    }
    land += sky.sort((a, b) => a.depth - b.depth).map((i) => i.svg).join('');
    svg.querySelector('#meadow-land').innerHTML = land;
    svg.querySelector('#meadow-names').innerHTML = labels;
  }

  let raf = 0;
  let last = 0;
  function loop(now) {
    raf = 0;
    if (!open) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const still = reduced.matches;
    for (const [n, w] of walkers) tick(w, dt, still || n === selected, sizeOf(lifeFor(n)));
    renderScene();
    if (!still) raf = requestAnimationFrame(loop);
  }
  function start() {
    last = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // ---- the sidebar ------------------------------------------------------------------

  function statRow(label, value) {
    return `<div class="usage-row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  const bar = (done, label) => `<div class="grow-bar" aria-hidden="true"><span style="width:${Math.round(done * 100)}%"></span></div><p class="hint">${esc(label)}</p>`;

  function numbersFor(name) {
    const a = stats.names.get(name);
    if (!a) return `<p class="hint">${stats.loading ? 'Working out the numbers…' : stats.error ? esc(stats.error) : 'No runs in the last 28 days yet.'}</p>`;
    const verdicts = Object.keys(a.verdicts ?? {}).length ? Object.entries(a.verdicts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '';
    const bars = a.daily?.length
      ? (() => {
        const max = Math.max(1, ...a.daily.map((d) => d.runs));
        return `<div class="spark" aria-label="Runs per day">${a.daily.slice(-14).map((d) => `<span style="height:${Math.round((d.runs / max) * 100)}%" title="${esc(d.day)}: ${d.runs} runs"></span>`).join('')}</div>`;
      })()
      : '';
    return `${statRow('Score', a.score === undefined || a.score === null ? `– <span class="muted">(${esc(a.scoreReason ?? 'not enough runs')})</span>` : `${a.score} / 100`)}
      ${statRow('Runs, last 28 days', a.runs)}${statRow('Finished', pct(a.successRate))}${statRow('Called again after a failure', pct(a.rerunRate))}
      ${statRow('Median time', dur(a.medianMs))}${statRow('Tokens used', compact(a.totalTokens ?? 0))}${statRow('Tokens per run (median)', a.medianTokens ? compact(Math.round(a.medianTokens)) : '–')}
      ${statRow('Tool errors', pct(a.toolErrorRate))}${verdicts ? statRow('Verdicts', verdicts) : ''}${bars}`;
  }

  const speciesName = (id) => SPECIES.find((x) => x.id === id)?.name ?? '';

  function eggPanel(name) {
    const life = lifeFor(name);
    const tokens = tokensOf(name);
    const head = `<div class="critter-head">${eggThumb(eggSeed(name), life.progress)}
      <div><h3>${esc(name)}</h3><p class="hint">An egg${life.ready ? ', ready to hatch!' : ''}</p></div></div>`;
    if (!life.ready) {
      return `${head}${bar(life.progress, `${compact(tokens)} of ${compact(HATCH_AT)} tokens to hatch`)}
        <p class="hint">Every agent starts as an egg. It hatches once the agent has used ${compact(HATCH_AT)} tokens, and then you choose one of three creatures.</p>`;
    }
    const choices = starterChoices(name, SPECIES.map((s) => s.id));
    const v = defaultCreature(name).variant;
    return `${head}<p class="hint">Choose who hatches. It starts as a baby and grows as ${esc(name)} works.</p>
      <div class="pieces starters" role="group" aria-label="Choose a starter">${choices.map((sp) => `<button type="button" class="piece" data-hatch="${sp}">${creatureThumb(sp, v, 1)}<span>${esc(STAGE_NAMES[sp][0])}<br><small>${esc(speciesName(sp))}</small></span></button>`).join('')}</div>`;
  }

  function creaturePanel(name) {
    const L = looks(name);
    const life = lifeFor(name);
    const tokens = tokensOf(name);
    const stageName = STAGE_NAMES[L.species][L.stage - 1];
    const growth = life.stage < STAGES
      ? life.ready
        ? `<button type="button" class="button evolve" data-evolve>Evolve into ${esc(STAGE_NAMES[L.species][L.stage])}</button>`
        : bar(life.progress, `${compact(tokens)} of ${compact(life.next)} tokens to evolve into ${STAGE_NAMES[L.species][L.stage]}`)
      : bar(life.progress, life.progress >= 1 ? 'Fully grown' : `${compact(tokens)} of ${compact(life.next)} tokens to full size`);
    return `<div class="critter-head">${creatureThumb(L.species, L.variant, L.stage)}
        <div><h3>${esc(name)}</h3><p class="hint">${esc(stageName)} · ${esc(lookOf(L.species, L.variant).name)} ${esc(speciesName(L.species))} · stage ${L.stage} of ${STAGES}</p>
        <p class="rarity rarity-${L.rarity.toLowerCase()}">${L.rarity === 'R' ? 'R · common' : `${RARITY_TEXT[L.rarity]} · ${L.rarity === 'SR' ? 'rare' : 'super rare'}`}</p></div></div>
      ${notice ? `<p class="grow-note">${esc(notice)}</p>` : ''}
      ${growth}
      ${numbersFor(name)}
      <details class="more-pieces"><summary>Rarity and looks</summary>
        <p class="hint">Rarity is earned by good work and kept once earned: SR at a score of 80 over 5 or more runs, SSR at 90 over 10 or more.</p>
        <div class="pieces critter-looks">${Array.from({ length: VARIANTS }, (_, v) => `<button type="button" class="piece" data-look="${v}" aria-pressed="${v === L.variant}">${creatureThumb(L.species, v, L.stage)}<span>${esc(lookOf(L.species, v).name)}</span></button>`).join('')}</div>
      </details>`;
  }

  function renderPanel() {
    const el = $('meadow-body');
    const names = agents();
    // The creatures never stand still, so they can also be picked by name.
    const picker = names.length
      ? `<div class="options critter-pick" role="group" aria-label="Agents">${names.map((n) => `<button type="button" class="chip" data-pick="${esc(n)}" aria-pressed="${n === selected}">${esc(n)}${!entryOf(n) && lifeFor(n).ready ? ' · hatch!' : entryOf(n) && lifeFor(n).ready ? ' · evolve!' : ''}</button>`).join('')}</div>`
      : '';
    if (!selected || !names.includes(selected)) {
      el.innerHTML = `<p class="hint">${names.length
        ? `Every agent that has ever been called lives here, starting as an egg. Its tokens hatch it (${compact(HATCH_AT)}), grow it and evolve it twice; good work earns it rarity. Click one, or its name below.`
        : 'Agents you add to .claude/agents (or the Office pack in Settings), and any agent Claude calls, move in here as eggs.'}</p>
        ${picker}
        ${stats.loading ? '<p class="hint">Working out the numbers…</p>' : ''}${stats.error ? `<p class="form-error">${esc(stats.error)}</p>` : ''}`;
      return;
    }
    el.innerHTML = picker + (entryOf(selected) ? creaturePanel(selected) : eggPanel(selected));
  }

  function select(name) {
    if (name !== selected) notice = '';
    selected = name;
    renderScene();
    renderPanel();
  }

  function celebrate(name, text) {
    const w = walkers.get(name);
    notice = text;
    $('meadow-live').textContent = text; // a lasting live region, so it is read out
    renderScene(); // takes the new form
    const nw = walkers.get(name);
    if (nw) nw.flash = 1.2;
    else if (w) w.flash = 1.2;
    renderPanel();
    if (reduced.matches) renderScene();
  }

  // Picked on press, not on release: the creature may have walked on by
  // then. The scene is redrawn every frame, so the pointer is matched
  // against where each creature (or its name) was last drawn rather than
  // against elements that may already have been replaced.
  $('meadow').addEventListener('pointerdown', (e) => {
    const m = $('meadow').querySelector('#meadow-land')?.getScreenCTM();
    if (!m) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const hit = hits
      .filter((h) => pt.x >= h.x0 && pt.x <= h.x1 && pt.y >= h.y0 && pt.y <= h.y1)
      .sort((a, b) => b.depth - a.depth)[0];
    select(hit?.name);
  });
  $('meadow-body').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const name = pick.dataset.pick;
      select(selected === name ? undefined : name);
      $('meadow-body').querySelector(`[data-pick="${CSS.escape(name)}"]`)?.focus();
      return;
    }
    if (!selected) return;
    const hatch = e.target.closest('[data-hatch]');
    if (hatch && !entryOf(selected) && lifeFor(selected).ready) {
      const species = hatch.dataset.hatch;
      nest()[selected] = { species, variant: defaultCreature(selected).variant, stage: 1, rarity: rarityFrom(stats.names.get(selected)) };
      saveNest();
      celebrate(selected, `${STAGE_NAMES[species][0]} hatched!`);
      $('meadow-body').querySelector('[data-pick][aria-pressed="true"]')?.focus();
      return;
    }
    if (e.target.closest('[data-evolve]')) {
      const entry = entryOf(selected);
      if (!entry || !lifeFor(selected).ready) return;
      const from = STAGE_NAMES[entry.species][entry.stage - 1];
      entry.stage += 1;
      saveNest();
      celebrate(selected, `${from} evolved into ${STAGE_NAMES[entry.species][entry.stage - 1]}!`);
      $('meadow-body').querySelector('[data-pick][aria-pressed="true"]')?.focus();
      return;
    }
    const b = e.target.closest('[data-look]');
    if (b && entryOf(selected)) {
      entryOf(selected).variant = Number(b.dataset.look);
      saveNest();
      renderPanel();
      if (reduced.matches) renderScene();
      const details = $('meadow-body').querySelector('details');
      if (details) details.open = true;
    }
  });

  async function enter() {
    open = true;
    document.body.classList.add('in-meadow');
    $('meadow-panel').hidden = false;
    onEnter?.();
    shown = agents().join('|');
    groundKey = '';
    remember(agents());
    renderScene();
    renderPanel();
    start();
    $('meadow-back').focus();
    await loadStats();
    remember(agents());
    renderScene();
    renderPanel();
  }

  function exit() {
    open = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.body.classList.remove('in-meadow');
    $('meadow-panel').hidden = true;
    onExit?.();
  }

  $('cam-meadow').addEventListener('click', enter);
  $('meadow-back').addEventListener('click', exit);
  $('meadow-back-stage').addEventListener('click', exit);

  // An agent called for the first time moves in straight away, and is
  // remembered even while the Meadow is closed. The panel is redrawn only
  // when the agents change, not on every snapshot, so it keeps still enough
  // to use; the scene redraws itself every frame while open.
  let shown = '';
  function refresh() {
    const key = agents().join('|');
    if (key === shown) return;
    shown = key;
    remember(agents());
    if (!open) return;
    renderPanel();
    if (reduced.matches) renderScene();
    loadStats().then(() => {
      renderPanel();
      if (reduced.matches) renderScene();
    });
  }

  return { enter, exit, isOpen: () => open, refresh };
}
