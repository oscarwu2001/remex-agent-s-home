// The Meadow: a second screen, away from the hospital, where every agent in
// the user's .claude/agents lives as a small creature. The more tokens an
// agent has used (last 28 days), the bigger it grows. Clicking one shows its
// numbers in the sidebar, where its look can be changed or handed to another
// agent. The numbers are the performance report's, worked out on request.

import { SPECIES, VARIANTS, drawCreature, creatureThumb, defaultCreature, lookOf, setCreatureLight, facingOf } from './creatures.js';
import { P, box, poly, viewDepth, faceVisible, getView } from './iso.js';
import { shade, mix } from './themes.js';

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
// garden plots grown big, with a sunken pond for the fish.
const N = 12;
const X0 = 5; // tiles X0 .. X0+N-1 on both axes; the view turns about 11, 11
const POND = { x: 12, y: 11, w: 4, h: 4 };
const TREES = [[6, 7], [8, 5], [15, 6], [6, 14], [11, 8]];
const BUSHES = [[10, 5], [5, 11], [13, 16], [9, 15]];
const inPond = (x, y) => x >= POND.x && x < POND.x + POND.w && y >= POND.y && y < POND.y + POND.h;
const blocked = new Set([...TREES, ...BUSHES].map(([x, y]) => `${x},${y}`));
const walkable = (x, y) => x >= X0 && y >= X0 && x < X0 + N && y < X0 + N && !inPond(x, y) && !blocked.has(`${x},${y}`);

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

export function createMeadow({ bridge, prefs, savePrefs, getSnapshot, getLight, onEnter, onExit }) {
  let open = false;
  let stats = { names: new Map(), seen: [], error: '', loading: false, at: 0 };
  let selected;

  const creatureOf = (name) => prefs.creatures?.[name] ?? defaultCreature(name);

  // Everyone who lives here: the agents installed in .claude/agents, every
  // agent called in the transcripts read for the numbers, anyone at work
  // right now, and anyone met before (remembered, so an agent that has been
  // quiet for months still has its spot).
  function agents() {
    const snap = getSnapshot();
    const names = new Set(prefs.meadowSeen ?? []);
    for (const a of snap.roster ?? []) names.add(a.name);
    for (const sess of snap.sessions ?? []) for (const a of sess.agents ?? []) if (a.type) names.add(a.type);
    for (const n of stats.seen) names.add(n);
    for (const n of stats.names.keys()) names.add(n);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  function remember(names) {
    if (getSnapshot().demo) return; // the demo's made-up staff are not the user's agents
    const known = new Set(prefs.meadowSeen ?? []);
    if (names.every((n) => known.has(n))) return;
    prefs.meadowSeen = [...new Set([...known, ...names])].sort();
    savePrefs();
  }

  async function loadStats() {
    if (getSnapshot().demo) {
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
    stats = res.ok
      ? { names: new Map(res.agents.map((a) => [a.name, a])), seen: res.seen ?? [], error: '', loading: false, at: Date.now() }
      : { ...stats, error: res.error, loading: false, at: Date.now() };
  }

  // Size from tokens used: the busiest agent is about twice the quietest.
  function scales(names) {
    const tokens = names.map((n) => stats.names.get(n)?.totalTokens ?? 0);
    const lo = Math.log10(Math.max(1, Math.min(...tokens) || 1));
    const hi = Math.log10(Math.max(10, ...tokens));
    return new Map(names.map((n, i) => {
      const t = Math.log10(Math.max(1, tokens[i]));
      const k = hi > lo ? (t - lo) / (hi - lo) : 0.5;
      return [n, 0.75 + 0.75 * Math.max(0, Math.min(1, k))];
    }));
  }

  // ---- the creatures wander, like mobs in a block game ------------------------------
  //
  // Each picks a free tile, walks there along the grid (one leg of the trip
  // along x, the other along y), turning to face the way it goes, stops for
  // a moment and sets off again. Fish do the same inside the pond.

  const walkers = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function freeTiles(fish) {
    const out = [];
    for (let x = X0; x < X0 + N; x++) for (let y = X0; y < X0 + N; y++) if (fish ? inPond(x, y) : walkable(x, y)) out.push([x, y]);
    return out;
  }
  const LAND = freeTiles(false);
  const WATER = freeTiles(true);

  function settle(names) {
    const size = scales(names);
    const taken = new Set();
    for (const n of [...walkers.keys()]) if (!names.includes(n)) walkers.delete(n);
    for (const n of names) {
      const fish = creatureOf(n).species === 'fish';
      const w = walkers.get(n);
      if (w && w.fish === fish) {
        w.scale = size.get(n) ?? 1;
        continue;
      }
      // A starting tile from the name, moved along until it is free.
      const tiles = fish ? WATER : LAND;
      let i = hashOf(n) % tiles.length;
      for (let tries = 0; tries < tiles.length && taken.has(String(tiles[i])); tries++) i = (i + 1) % tiles.length;
      taken.add(String(tiles[i]));
      const [x, y] = tiles[i];
      walkers.set(n, { fish, x: x + 0.5, y: y + 0.5, path: [], pause: (hashOf(n) % 30) / 10, facing: hashOf(n) % 4, step: 0, scale: size.get(n) ?? 1 });
    }
  }

  // The tiles a straight walk from (x0, y0) to (x1, y1) crosses, all free?
  function clear(fish, x0, y0, x1, y1) {
    const ok = fish ? inPond : walkable;
    const [ax, ay, bx, by] = [Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1)];
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) if (!ok(x, y)) return false;
    return true;
  }

  function plan(w) {
    const tiles = w.fish ? WATER : LAND;
    for (let tries = 0; tries < 8; tries++) {
      const [tx, ty] = tiles[Math.floor(Math.random() * tiles.length)];
      // Not too far: a few tiles each trip.
      if (Math.abs(tx + 0.5 - w.x) + Math.abs(ty + 0.5 - w.y) > 7) continue;
      const [gx, gy] = [tx + 0.5, ty + 0.5];
      const xFirst = Math.random() < 0.5;
      const mid = xFirst ? [gx, w.y] : [w.x, gy];
      if (clear(w.fish, w.x, w.y, ...mid) && clear(w.fish, ...mid, gx, gy)) {
        w.path = [mid, [gx, gy]];
        return;
      }
    }
    w.pause = 1; // hemmed in: try again in a moment
  }

  function tick(w, dt, still) {
    if (still) return;
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
    const speed = (w.fish ? 0.9 : 1.2) / Math.sqrt(w.scale);
    if (dist < 1e-3) {
      w.path.shift();
      if (!w.path.length) w.pause = 1 + Math.random() * 3;
      return;
    }
    w.facing = facingOf(dx, dy);
    const move = Math.min(dist, speed * dt);
    w.x += (dx / dist) * move;
    w.y += (dy / dist) * move;
    w.step += dt * 9 * Math.sqrt(1 / w.scale);
  }

  // ---- drawing ------------------------------------------------------------------

  let groundKey = '';
  let hits = []; // [{ name, depth, x0, y0, x1, y1 }] from the last frame
  function drawGround() {
    const { theme, phase } = getLight();
    setCreatureLight(theme, phase);
    const mat = (hex) => shade(hex, theme);
    // Greener than the stone's shading would make it: warmed less by the light.
    const grass = { ...mat(theme.materials.mint), top: mix(theme.materials.mint, theme.light, 0.3) };
    const stone = mat(theme.materials.stone);
    const water = mat(theme.materials.sky);
    const tone = (c) => (phase === 'night' ? mix(c, theme.night.tint, theme.night.amount) : c);
    let s = box(X0 + 1.5, X0 + 1.5, -4.4, N - 3, N - 3, 1.2, stone);
    s += box(X0 + 0.5, X0 + 0.5, -3.4, N - 1, N - 1, 1.2, stone);
    s += box(X0, X0, -2.2, N, N, 1.8, stone);
    s += box(X0, X0, -0.4, N, N, 0.4, grass);
    const light = mix(grass.top, '#ffffff', 0.18);
    for (let x = X0; x < X0 + N; x++) {
      for (let y = X0; y < X0 + N; y++) {
        if (inPond(x, y) || (x + y) % 2) continue;
        s += poly([[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]], light);
      }
    }
    // The pond: water a little below the grass, its far banks showing.
    const { x: px, y: py, w: pw, h: ph } = POND;
    const wz = -0.25;
    s += poly([[px, py, wz], [px + pw, py, wz], [px + pw, py + ph, wz], [px, py + ph, wz]], water.left);
    s += poly([[px + 0.6, py + 1, wz], [px + 2.4, py + 1, wz], [px + 2.4, py + 1.2, wz], [px + 0.6, py + 1.2, wz]], mix(water.left, '#ffffff', 0.5));
    s += poly([[px + 1.4, py + 2.4, wz], [px + 3.2, py + 2.4, wz], [px + 3.2, py + 2.6, wz], [px + 1.4, py + 2.6, wz]], mix(water.left, '#ffffff', 0.35));
    const banks = [
      [[1, 0], [[px, py], [px, py + ph]]], [[-1, 0], [[px + pw, py], [px + pw, py + ph]]],
      [[0, 1], [[px, py], [px + pw, py]]], [[0, -1], [[px, py + ph], [px + pw, py + ph]]],
    ];
    for (const [[nx, ny], [[ax, ay], [bx, by]]] of banks) {
      if (!faceVisible(nx, ny)) continue;
      s += poly([[ax, ay, 0], [bx, by, 0], [bx, by, wz], [ax, ay, wz]], nx ? grass.left : grass.right);
    }
    for (const [x, y, c] of FLOWERS) {
      s += box(x, y, 0, 0.06, 0.06, 0.18, mat(tone('#6cc47a')));
      s += box(x - 0.05, y - 0.05, 0.18, 0.16, 0.16, 0.12, mat(tone(c)));
    }
    return s;
  }

  function scenery() {
    const { theme } = getLight();
    const leaf = shade(theme.materials.leaf, theme);
    const bush = shade(theme.materials.teal, theme);
    const trunk = shade(theme.materials.sand, theme);
    const items = [];
    for (const [x, y] of TREES) {
      const svg = box(x + 0.4, y + 0.4, 0, 0.2, 0.2, 0.9, trunk) + box(x + 0.05, y + 0.05, 0.9, 0.9, 0.9, 0.8, leaf)
        + box(x + 0.25, y + 0.25, 1.7, 0.5, 0.5, 0.4, leaf);
      items.push({ depth: viewDepth(x + 0.5, y + 0.5), svg });
    }
    for (const [x, y] of BUSHES) items.push({ depth: viewDepth(x + 0.5, y + 0.5), svg: box(x + 0.15, y + 0.15, 0, 0.7, 0.7, 0.55, bush) });
    return items;
  }

  // Fit the view to the island as it is turned now.
  function frame() {
    const corners = [];
    for (const [x, y] of [[X0, X0], [X0 + N, X0], [X0 + N, X0 + N], [X0, X0 + N]]) corners.push(P(x, y, 2.4), P(x, y, -4.4));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const pad = 30;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    return `${x0.toFixed(0)} ${y0.toFixed(0)} ${(Math.max(...xs) - x0 + pad).toFixed(0)} ${(Math.max(...ys) - y0 + pad).toFixed(0)}`;
  }

  function renderScene() {
    const names = agents();
    settle(names);
    const svg = $('meadow');
    const key = `${getView()}|${getLight().theme.name}|${getLight().phase}`;
    if (key !== groundKey || !svg.querySelector('#meadow-ground')) {
      groundKey = key;
      svg.setAttribute('viewBox', frame());
      svg.innerHTML = `<title>The Meadow: your agents as creatures</title><g id="meadow-ground">${drawGround()}</g><g id="meadow-things"></g><g id="meadow-names"></g>
        ${names.length ? '' : `<text class="meadow-empty" x="${P(11, 11, 0)[0]}" y="${P(11, 11, 0)[1]}" text-anchor="middle">No agents yet</text>`}`;
    }
    const items = scenery();
    hits = [];
    let labels = '';
    for (const [n, w] of walkers) {
      const c = creatureOf(n);
      const moving = w.pause <= 0 && w.path.length > 0;
      const z = w.fish ? -0.25 + 0.04 * Math.sin(performance.now() / 400 + w.x) : 0;
      const pose = { x: w.x, y: w.y, z, scale: w.fish ? w.scale * 0.8 : w.scale, facing: w.facing, step: moving ? w.step : null };
      const { svg: body, height, pts } = drawCreature(c.species, c.variant, pose);
      // Where it is on screen this frame, a little padded, for picking.
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      hits.push({ name: n, depth: viewDepth(w.x, w.y), x0: Math.min(...xs) - 6, y0: Math.min(...ys) - 6, x1: Math.max(...xs) + 6, y1: Math.max(...ys) + 6 });
      const ring = n === selected
        ? `<polygon class="critter-ring" points="${[[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]].map(([a, b]) => P(w.x + a * w.scale, w.y + b * w.scale, z).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`
        : '';
      items.push({
        depth: viewDepth(w.x, w.y),
        svg: `<g class="critter${n === selected ? ' chosen' : ''}" data-agent="${esc(n)}">${ring}${body}</g>`,
      });
      const [lx, ly] = P(w.x, w.y, height + 0.25);
      const half = n.length * 4 + 10;
      hits.push({ name: n, depth: 1e6, x0: lx - half, y0: ly - 16, x1: lx + half, y1: ly + 5 });
      labels += `<text class="critter-name${n === selected ? ' chosen' : ''}" data-agent="${esc(n)}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${n === selected ? '▸ ' : ''}${esc(n)}</text>`;
    }
    items.sort((a, b) => a.depth - b.depth);
    svg.querySelector('#meadow-things').innerHTML = items.map((i) => i.svg).join('');
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
    for (const [n, w] of walkers) tick(w, dt, still || n === selected);
    renderScene();
    if (!still) raf = requestAnimationFrame(loop);
  }
  function start() {
    last = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function statRow(label, value) {
    return `<div class="usage-row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function renderPanel() {
    const el = $('meadow-body');
    const names = agents();
    // The creatures never stand still, so they can also be picked by name.
    const picker = names.length
      ? `<div class="options critter-pick" role="group" aria-label="Agents">${names.map((n) => `<button type="button" class="chip" data-pick="${esc(n)}" aria-pressed="${n === selected}">${esc(n)}</button>`).join('')}</div>`
      : '';
    if (!selected || !names.includes(selected)) {
      el.innerHTML = `<p class="hint">${names.length
        ? 'Each creature is one of your agents, and every agent that has ever been called lives here. The more tokens it used in the last 28 days, the bigger it is. Click one, or its name below, to see how it is doing.'
        : 'Agents you add to .claude/agents (or the Office pack in Settings), and any agent Claude calls, move in here.'}</p>
        ${picker}
        ${stats.loading ? '<p class="hint">Working out the numbers…</p>' : ''}${stats.error ? `<p class="form-error">${esc(stats.error)}</p>` : ''}`;
      return;
    }
    const c = creatureOf(selected);
    const L = lookOf(c.species, c.variant);
    const a = stats.names.get(selected);
    const verdicts = a && Object.keys(a.verdicts ?? {}).length ? Object.entries(a.verdicts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '';
    const bars = a?.daily?.length
      ? (() => {
        const max = Math.max(1, ...a.daily.map((d) => d.runs));
        return `<div class="spark" aria-label="Runs per day">${a.daily.slice(-14).map((d) => `<span style="height:${Math.round((d.runs / max) * 100)}%" title="${esc(d.day)}: ${d.runs} runs"></span>`).join('')}</div>`;
      })()
      : '';
    const numbers = a
      ? `${statRow('Score', a.score === undefined || a.score === null ? `– <span class="muted">(${esc(a.scoreReason ?? 'not enough runs')})</span>` : `${a.score} / 100`)}
         ${statRow('Runs, last 28 days', a.runs)}${statRow('Finished', pct(a.successRate))}${statRow('Called again after a failure', pct(a.rerunRate))}
         ${statRow('Median time', dur(a.medianMs))}${statRow('Tokens used', compact(a.totalTokens ?? 0))}${statRow('Tokens per run (median)', a.medianTokens ? compact(Math.round(a.medianTokens)) : '–')}
         ${statRow('Tool errors', pct(a.toolErrorRate))}${verdicts ? statRow('Verdicts', verdicts) : ''}${bars}`
      : `<p class="hint">${stats.loading ? 'Working out the numbers…' : stats.error ? esc(stats.error) : 'No runs in the last 28 days yet.'}</p>`;
    const others = agents().filter((n) => n !== selected);
    el.innerHTML = `
      ${picker}
      <div class="critter-head">${creatureThumb(c.species, c.variant)}
        <div><h3>${esc(selected)}</h3><p class="hint">${esc(L.name)} ${esc(SPECIES.find((x) => x.id === c.species)?.name ?? '')}</p></div></div>
      ${numbers}
      <details class="more-pieces"><summary>Change the look</summary>
        <fieldset class="chips"><legend>Animal</legend><div class="options">${SPECIES.map((sp) => `<label class="chip"><input type="radio" name="critter-species" value="${sp.id}" ${sp.id === c.species ? 'checked' : ''}>${esc(sp.name)}</label>`).join('')}</div></fieldset>
        <div class="pieces critter-looks">${Array.from({ length: VARIANTS }, (_, v) => `<button type="button" class="piece" data-look="${v}" aria-pressed="${v === c.variant}">${creatureThumb(c.species, v)}<span>${esc(lookOf(c.species, v).name)}</span></button>`).join('')}</div>
      </details>
      ${others.length ? `<label class="field" for="critter-swap">Give this creature to another agent
        <select id="critter-swap"><option value="">Choose an agent…</option>${others.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>` : ''}`;
  }

  function setCreature(name, look) {
    prefs.creatures = { ...(prefs.creatures ?? {}), [name]: look };
    savePrefs();
    renderScene();
    renderPanel();
  }

  function select(name) {
    selected = name;
    renderScene();
    renderPanel();
  }

  // Picked on press, not on release: the creature may have walked on by
  // then. The scene is redrawn every frame, so the pointer is matched
  // against where each creature (or its name) was last drawn rather than
  // against elements that may already have been replaced.
  $('meadow').addEventListener('pointerdown', (e) => {
    const m = $('meadow').querySelector('#meadow-things')?.getScreenCTM();
    if (!m) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const hit = hits
      .filter((h) => pt.x >= h.x0 && pt.x <= h.x1 && pt.y >= h.y0 && pt.y <= h.y1)
      .sort((a, b) => b.depth - a.depth)[0];
    select(hit?.name);
  });
  $('meadow-body').addEventListener('change', (e) => {
    if (!selected) return;
    const c = creatureOf(selected);
    if (e.target.name === 'critter-species') setCreature(selected, { species: e.target.value, variant: c.variant });
    if (e.target.id === 'critter-swap' && e.target.value) {
      // The two agents trade creatures.
      const other = e.target.value;
      const theirs = creatureOf(other);
      prefs.creatures = { ...(prefs.creatures ?? {}), [other]: c, [selected]: theirs };
      savePrefs();
      selected = other;
      renderScene();
      renderPanel();
    }
    const details = $('meadow-body').querySelector('details');
    if (details && e.target.name === 'critter-species') details.open = true;
  });
  $('meadow-body').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const name = pick.dataset.pick;
      select(selected === name ? undefined : name);
      $('meadow-body').querySelector(`[data-pick="${CSS.escape(name)}"]`)?.focus();
      return;
    }
    const b = e.target.closest('[data-look]');
    if (!b || !selected) return;
    setCreature(selected, { species: creatureOf(selected).species, variant: Number(b.dataset.look) });
    const details = $('meadow-body').querySelector('details');
    if (details) details.open = true;
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
