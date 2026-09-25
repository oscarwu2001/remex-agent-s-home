// The hospital: a stepped tower of rooms floating in a dawn sky, joined by
// bridges and stairs. Geometry is static and drawn once; characters walk on
// the floors and connectors defined here.

import {
  P, M, poly, box, tiledTop, cylinder, ball, splitGradients, archPoints, uprightRing, applyTheme, rivet,
  viewDepth, faceVisible, cellDepth,
} from './iso.js';
import { floorTones } from './themes.js';
import { drawItem } from './furniture.js';
import { drawFloor, drawPlant } from './decor.js';

const BASE_Z = -4; // columns hang down to here and dissolve into mist

// Rooms come from src/core/rooms.js (through the bridge's config): each has
// a grid cell, and a cell is 8 tiles, a 6-tile room plus a 2-tile gap. This
// module only decides heights, furniture and how rooms join.
// Floor top height z; floor spans [x, x+6) x [y, y+6). Tower colours come
// from the colourway (M[roomId]). Walls are not listed: a room gets a wall on
// each side that is at the back in the current view and has no doorway.
export const LAYOUT = {}; // roomId -> { x, y, z, kind? }

const SIZE = 6;
const CELL = 8;
// Heights follow the view, Monument Valley style: the cell nearest the
// viewer is lowest and the farthest is highest. Index = cellDepth + 2.
// The core runs 6, 4, 2, 2, 0 from back to front; the ring carries on.
const ELEVATION = [9, 8, 6, 4, 2, 2, 0, -1, -2];
// Mid-swing a cell's depth is fractional, and its height is read between
// the two nearest steps, so towers rise and sink as the building turns.
function elevationAt(c, r) {
  const i = Math.min(ELEVATION.length - 1, Math.max(0, cellDepth(c, r) + 2));
  const lo = Math.floor(i);
  const hi = Math.min(ELEVATION.length - 1, lo + 1);
  return ELEVATION[lo] + (ELEVATION[hi] - ELEVATION[lo]) * (i - lo);
}
// Tower colours for departments, taken in turn from the colourway.
const DEPT_MATERIALS = ['rose', 'sky', 'mint', 'lilac', 'sand', 'coral', 'teal'];
const deptMaterial = new Map(); // dept id -> material key

// Where people stand, in room-local tile coordinates.
const SLOTS = {
  'nurses-station': [[1.6, 4.4], [3, 3], [4.4, 2.2], [2.9, 5.3], [4.3, 3.9], [5.5, 2.7]],
  'operating-room': [[1.4, 3], [4.6, 3], [3, 5.2], [1.5, 5], [4.5, 5.2], [3, 0.9]],
  'research-office': [[1.8, 2.9], [4.4, 2.9], [2, 4.5], [3.7, 4.4], [5.1, 3.7], [3, 5.4]],
  laboratory: [[2.1, 2.1], [2.1, 3.6], [3.6, 2.9], [3.6, 4.6], [5, 4], [2.1, 5.2]],
  radiology: [[1.2, 3.6], [4.8, 3.6], [1.5, 5.1], [4.5, 5.1], [3, 5.5], [1.2, 1.6]],
  'vision-clinic': [[1.8, 3], [4.1, 4.2], [2.2, 4.9], [3.6, 5.4], [5.1, 4.8], [1.4, 1.6]],
  'general-ward': [[3.2, 1.1], [3.2, 2.9], [3.2, 4.7], [4.8, 2], [4.8, 3.8], [4.8, 5.4]],
  department: [[1.3, 3.2], [4.7, 3.2], [3, 5.2], [1.5, 5.1], [4.6, 5.2], [2.2, 1.4]],
};

// Where new helpers appear and finished ones leave: the middle of the
// station, which sits at the centre of every view and so never moves.
export function spawnPoint() {
  const hub = LAYOUT['nurses-station'];
  return [11, 12.4, hub ? hub.z : 2];
}

// Walkable joins between rooms: each department adds one to the room it was
// placed next to. Ends are worked out from the two cells, heights from the
// rooms at the moment of drawing, so they follow the view.
const CORE_LINKS = [
  ['nurses-station', 'operating-room'], ['nurses-station', 'research-office'],
  ['nurses-station', 'vision-clinic'], ['nurses-station', 'laboratory'],
  ['laboratory', 'radiology'], ['operating-room', 'general-ward'],
];
let CONNECTORS = [];

function link(aId, bId) {
  const a = LAYOUT[aId];
  const b = LAYOUT[bId];
  const [ac, ar] = a.cell;
  const [bc, br] = b.cell;
  if (bc === ac + 1) return { a: aId, b: bId, axis: 'x', fromXY: [a.x + SIZE, a.y + 3], toXY: [b.x, b.y + 3] };
  if (bc === ac - 1) return { a: aId, b: bId, axis: 'x', fromXY: [a.x, a.y + 3], toXY: [b.x + SIZE, b.y + 3] };
  if (br === ar + 1) return { a: aId, b: bId, axis: 'y', fromXY: [a.x + 3, a.y + SIZE], toXY: [b.x + 3, b.y] };
  return { a: aId, b: bId, axis: 'y', fromXY: [a.x + 3, a.y], toXY: [b.x + 3, b.y + SIZE] };
}

// The two ends of a join, with the current heights of its rooms.
function ends(c) {
  return [[...c.fromXY, LAYOUT[c.a].z], [...c.toXY, LAYOUT[c.b].z]];
}

// Garden islands (the built-in two and any the user added, from the
// config) also rise and sink with the view. Each is a plot of 4 x 4 tiles
// (GARDEN_SIZE in src/core/decor.js) starting at `at`, a tile in from the
// corner of its cell.
const SCENERY = {}; // gardenId -> { cell, at, z }
const PLOT = 4;

// What the user chose (decor.json, through the config): floors, spot
// decorations and gardens. Missing entries mean the default look.
let decorState = { rooms: {}, gardens: {} };
let defaultGardens = {};
let plantSize = {}; // kind -> [w, d], from the catalogue
let itemSizes = {}; // room item kind -> [w, d]
// The room style: 'simple' (storybook) or 'detailed' (realistic equipment).
let detail = 'simple';
let defaultRoomItems = {}; // room id (or 'department') -> starting items

// Lays out the rooms the config lists and joins each department to the room
// it was placed next to.
export function configureRooms(rooms, gardens = []) {
  for (const k of Object.keys(LAYOUT)) delete LAYOUT[k];
  for (const k of Object.keys(SCENERY)) delete SCENERY[k];
  for (const g of gardens) {
    const [c, r] = g.cell;
    SCENERY[g.id] = { cell: [c, r], at: [c * CELL + 1, r * CELL + 1], z: 0 };
  }
  CONNECTORS = [];
  deptMaterial.clear();
  let n = 0;
  for (const room of rooms) {
    const [c, r] = room.cell;
    if (room.custom && !LAYOUT[room.via]) continue; // validated upstream; never guessed
    LAYOUT[room.id] = { x: c * CELL, y: r * CELL, z: 0, cell: [c, r], kind: room.custom ? room.kind : undefined };
    if (room.custom) {
      deptMaterial.set(room.id, DEPT_MATERIALS[n++ % DEPT_MATERIALS.length]);
      CONNECTORS.push(link(room.via, room.id));
    }
  }
  for (const [a, b] of CORE_LINKS) if (LAYOUT[a] && LAYOUT[b]) CONNECTORS.unshift(link(a, b));
  setHeights(targetHeights());
}

// The heights every room and island should have in the current view.
export function targetHeights() {
  const h = {};
  for (const [id, r] of Object.entries(LAYOUT)) h[id] = elevationAt(...r.cell);
  for (const [id, s] of Object.entries(SCENERY)) h[id] = elevationAt(...s.cell) - 1;
  return h;
}

export function currentHeights() {
  const h = {};
  for (const [id, r] of Object.entries(LAYOUT)) h[id] = r.z;
  for (const [id, s] of Object.entries(SCENERY)) h[id] = s.z;
  return h;
}

export function setHeights(h) {
  for (const [id, z] of Object.entries(h)) {
    if (LAYOUT[id]) LAYOUT[id].z = z;
    else if (SCENERY[id]) SCENERY[id].z = z;
  }
}

// The tower material of a room: its own colour, or a department's turn.
function bodyOf(id) {
  return M[id] ?? M[deptMaterial.get(id)] ?? M.stone;
}


export function slotPoint(roomId, index) {
  const r = LAYOUT[roomId] ?? LAYOUT['general-ward'];
  const slots = SLOTS[roomId] ?? SLOTS.department;
  const [u, v] = slots[index % slots.length];
  // Past the named slots, spread extra people out a little.
  const lap = Math.floor(index / slots.length);
  const jitter = lap ? [((lap * 37) % 7) / 10 - 0.3, ((lap * 53) % 7) / 10 - 0.3] : [0, 0];
  return [r.x + u + jitter[0], r.y + v + jitter[1], r.z];
}

// Where an attending goes to do a kind of work, in room-local tiles; the
// index spreads several attendings out.
const WORK_SPOTS = {
  shelf: ['research-office', (i) => [1.5, 3.3 + (i % 3) * 0.8]], // the bookshelf
  bench: ['laboratory', (i) => [1.9, 1.7 + (i % 4) * 0.9]], // the lab bench
  counter: ['nurses-station', (i) => [1.6 + (i % 4) * 1.1, 2.2]], // front of the counter
};

export function workSpot(kind, index) {
  const [room, at] = WORK_SPOTS[kind];
  const r = LAYOUT[room];
  if (!r) return undefined;
  const [u, v] = at(index);
  return { room, point: [r.x + u, r.y + v, r.z] };
}

// The route from one room to another, through the station.
export function routeBetween(fromRoom, toRoom) {
  return [...routeTo(fromRoom).reverse(), ...routeTo(toRoom).slice(1)];
}

export function slotCount(roomId) {
  return (SLOTS[roomId] ?? SLOTS.department).length;
}

// Waypoints from the station spawn point to a room (or back, reversed).
export function routeTo(roomId) {
  const prev = new Map([['nurses-station', null]]);
  const queue = ['nurses-station'];
  while (queue.length) {
    const cur = queue.shift();
    for (const c of CONNECTORS) {
      const next = c.a === cur ? c.b : c.b === cur ? c.a : null;
      if (next && !prev.has(next)) {
        prev.set(next, { from: cur, c });
        queue.push(next);
      }
    }
  }
  if (!prev.has(roomId)) return [spawnPoint()];
  const hops = [];
  for (let r = roomId; prev.get(r); r = prev.get(r).from) hops.unshift(prev.get(r));
  const points = [spawnPoint()];
  for (const { from, c } of hops) {
    const [f, t] = ends(c);
    const [p, q] = c.a === from ? [f, t] : [t, f];
    points.push(inset(p, from), p, q, inset(q, c.a === from ? c.b : c.a));
  }
  return points;
}

// A point one step inside the room from a doorway, so people do not clip walls.
function inset(p, roomId) {
  const r = LAYOUT[roomId] ?? LAYOUT['general-ward'];
  const cx = r.x + SIZE / 2;
  const cy = r.y + SIZE / 2;
  const dx = Math.sign(cx - p[0]) * 0.8;
  const dy = Math.sign(cy - p[1]) * 0.8;
  const onX = p[0] === r.x || p[0] === r.x + SIZE;
  return onX ? [p[0] + dx, p[1], r.z] : [p[0], p[1] + dy, r.z];
}

// ---- drawing -------------------------------------------------------------

function column(id, r) {
  const { x, y, z } = r;
  const body = bodyOf(id);
  return (
    box(x + 0.25, y + 0.25, BASE_Z, SIZE - 0.5, SIZE - 0.5, z - 0.5 - BASE_Z, body) +
    // a thin band where MV towers change material
    box(x + 0.2, y + 0.2, z - 1.6, SIZE - 0.4, SIZE - 0.4, 0.25, M.cream) +
    box(x, y, z - 0.5, SIZE, SIZE, 0.5, M.stone) +
    rivets(x, y, z)
  );
}

// Three rivets on each tower face turned toward the viewer, under the band.
function rivets(x, y, z) {
  const zz = z - 2.5;
  const lo = 0.25 - 0.001;
  const hi = SIZE - 0.25 + 0.001;
  const faces = [
    { n: [0, 1], along: (u, h) => [x + 0.25 + u, y + hi, h] },
    { n: [1, 0], along: (u, h) => [x + hi, y + 0.25 + u, h] },
    { n: [0, -1], along: (u, h) => [x + 0.25 + u, y + lo, h] },
    { n: [-1, 0], along: (u, h) => [x + lo, y + 0.25 + u, h] },
  ];
  let s = '';
  for (const f of faces) {
    if (!faceVisible(...f.n)) continue;
    for (const u of [1.6, 2.75, 3.9]) s += rivet(f.along, u, zz, 0.34, M.sand.left, M.lilac.right);
  }
  return s;
}

let activeTheme;

function floor(id, r) {
  const body = bodyOf(id);
  const [a, b] = floorTones(body.base ?? body.left, activeTheme);
  const kind = decorState.rooms[id]?.floor ?? 'checker';
  return drawFloor(kind, r.x, r.y, r.z + 0.001, SIZE, SIZE, { a, b, body, seed: r.x * 31 + r.y * 7 + 1 });
}


// Sides with a doorway (a bridge or stairs lands there) never get a wall.
function doorways(id) {
  const r = LAYOUT[id];
  const sides = new Set();
  for (const c of CONNECTORS) {
    for (const [room, p] of [[c.a, c.fromXY], [c.b, c.toXY]]) {
      if (room !== id) continue;
      if (p[1] === r.y) sides.add('north');
      if (p[1] === r.y + SIZE) sides.add('south');
      if (p[0] === r.x) sides.add('west');
      if (p[0] === r.x + SIZE) sides.add('east');
    }
  }
  return sides;
}

function walls(id, r) {
  const H = 2.3;
  const T = 0.3;
  const open = doorways(id);
  const sides = {
    // inward normal, wall box, a point on the inner face at (u, z)
    north: { n: [0, 1], box: [r.x, r.y, SIZE, T], along: (u, zz) => [r.x + u, r.y + T + 0.001, zz] },
    south: { n: [0, -1], box: [r.x, r.y + SIZE - T, SIZE, T], along: (u, zz) => [r.x + u, r.y + SIZE - T - 0.001, zz] },
    west: { n: [1, 0], box: [r.x, r.y, T, SIZE], along: (u, zz) => [r.x + T + 0.001, r.y + u, zz] },
    east: { n: [-1, 0], box: [r.x + SIZE - T, r.y, T, SIZE], along: (u, zz) => [r.x + SIZE - T - 0.001, r.y + u, zz] },
  };
  let s = '';
  for (const [name, w] of Object.entries(sides)) {
    if (open.has(name) || !faceVisible(...w.n)) continue;
    const [bx, by, bw, bd] = w.box;
    s += box(bx, by, r.z, bw, bd, H, M.cream);
    for (const u0 of [1.1, 3.6]) s += poly(archPoints(w.along, u0, 1.3, r.z + 0.7, 1.35), 'url(#window)');
  }
  return s;
}

function stairs(c) {
  const [[ax, ay, az], [bx, by, bz]] = ends(c);
  const n = 8;
  const steps = [];
  const low = Math.min(az, bz);
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    // step i covers [t0, t1] along the run; its tread sits at the higher end
    const zTop = az + (bz - az) * (bz > az ? t1 : t0);
    let x0; let y0; let w; let d;
    if (c.axis === 'x') {
      const xa = ax + (bx - ax) * t0;
      const xb = ax + (bx - ax) * t1;
      x0 = Math.min(xa, xb); w = Math.abs(xb - xa); y0 = ay - 1; d = 2;
    } else {
      const ya = ay + (by - ay) * t0;
      const yb = ay + (by - ay) * t1;
      y0 = Math.min(ya, yb); d = Math.abs(yb - ya); x0 = ax - 1; w = 2;
    }
    steps.push({ key: viewDepth(x0 + w / 2, y0 + d / 2), s: box(x0, y0, low - 1.2, w, d, zTop - (low - 1.2), M.stone) });
  }
  steps.sort((p, q) => p.key - q.key);
  return steps.map((p) => p.s).join('');
}

function bridge(c) {
  const [[ax, ay, z], [bx, by]] = ends(c);
  let s;
  if (c.axis === 'x') {
    s = box(Math.min(ax, bx), ay - 1, z - 0.45, Math.abs(bx - ax), 2, 0.45, M.stone);
    for (const px of [ax + 0.4, bx - 0.6]) s += box(px, ay - 1.05, z, 0.2, 0.2, 0.55, M.cream);
  } else {
    s = box(ax - 1, Math.min(ay, by), z - 0.45, 2, Math.abs(by - ay), 0.45, M.stone);
    for (const py of [ay + 0.4, by - 0.6]) s += box(ax + 0.85, py, z, 0.2, 0.2, 0.55, M.cream);
  }
  return s;
}

// A room's items: what the user placed, or the room's starting furniture.
export function roomItems(id) {
  const r = LAYOUT[id];
  return decorState.rooms[id]?.items ?? defaultRoomItems[r?.kind ? 'department' : id] ?? [];
}

// The size of an item on the floor, turned or not: [w, d] in tiles.
export function itemSize(item) {
  const size = itemSizes[item.kind] ?? [1, 1];
  return item.turn ? [size[1], size[0]] : size;
}

// Every item in a room, back to front in the current view.
function furniture(id, r) {
  return roomItems(id)
    .map((it, n) => {
      const [w, d] = itemSize(it);
      return { depth: viewDepth(r.x + it.at[0] + w / 2, r.y + it.at[1] + d / 2), s: drawItem(it, itemSizes[it.kind] ?? [1, 1], { ox: r.x, oy: r.y, z: r.z, detail, room: r, seed: n }) };
    })
    .sort((p, q) => p.depth - q.depth)
    .map((p) => p.s)
    .join('');
}

// Tiles a doorway lands on (the middle two of a side with a bridge or
// stairs): kept clear so nobody walks into a wardrobe.
export function doorwayTiles(id) {
  const out = [];
  for (const side of doorways(id)) {
    for (const k of [2, 3]) {
      if (side === 'north') out.push([k, 0]);
      if (side === 'south') out.push([k, SIZE - 1]);
      if (side === 'west') out.push([0, k]);
      if (side === 'east') out.push([SIZE - 1, k]);
    }
  }
  return out;
}

// Screen outline of one floor tile of a room, for placing items.
export function roomTile(id, i, j) {
  const r = LAYOUT[id];
  const [x, y] = [r.x + i, r.y + j];
  return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([a, b]) => P(a, b, r.z));
}

// A see-through preview of an item about to be placed, and the tiles it
// covers; `remove` outlines what would be taken away instead.
export function itemPreview(id, { kind, at, turn, tiles, remove, blocked }) {
  const r = LAYOUT[id];
  if (!r) return '';
  const cls = remove ? 'ghost-foot remove' : blocked ? 'ghost-foot remove' : 'ghost-foot';
  let s = tiles.map(([i, j]) => `<polygon class="${cls}" points="${roomTile(id, i, j).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`).join('');
  if (!remove && kind) s += `<g class="ghost-plant">${drawItem({ kind, at, turn }, itemSizes[kind] ?? [1, 1], { ox: r.x, oy: r.y, z: r.z, detail, room: r })}</g>`;
  return s;
}

// A small picture of an item, for the decorating panel.
export function itemThumb(kind, roomId) {
  const [w, d] = itemSizes[kind] ?? [1, 1];
  const [cx, cy] = P(w / 2, d / 2, 0.8);
  const span = 70 + Math.max(w, d) * 45;
  const room = roomId ? LAYOUT[roomId] : undefined;
  return `<svg class="thumb" viewBox="${(cx - span / 2).toFixed(1)} ${(cy - span / 2).toFixed(1)} ${span.toFixed(0)} ${span.toFixed(0)}" aria-hidden="true">${drawItem({ kind, at: [0, 0] }, [w, d], { ox: 0, oy: 0, z: 0, detail, room })}</svg>`;
}

// Scenery: two garden islands, one to the lower left and a lower one to
// the upper right. Each is a plot of tiles people can plant.
function gardenItems(id) {
  return decorState.gardens[id] ?? defaultGardens[id] ?? [];
}

function gardenIsland(id) {
  const g = SCENERY[id];
  const [x, y] = g.at;
  const z = g.z;
  let s = '';
  s += box(x + 0.3, y + 0.3, BASE_Z + 1, PLOT - 0.6, PLOT - 0.6, z - 0.4 - BASE_Z - 1, M.leaf);
  s += box(x - 0.2, y - 0.2, z - 0.4, PLOT + 0.4, PLOT + 0.4, 0.4, M.stone);
  s += tiledTop(x, y, z + 0.001, PLOT, PLOT, M.mint.top, M.mint.left);
  const items = gardenItems(id)
    .map((it, n) => {
      const size = plantSize[it.kind] ?? [1, 1];
      const [w, d] = it.turn ? [size[1], size[0]] : size;
      const cx = x + it.at[0] + w / 2;
      const cy = y + it.at[1] + d / 2;
      return { d: viewDepth(cx, cy), s: drawPlant(it.kind, x + it.at[0], y + it.at[1], z, n + 1 + it.at[0] * 5 + it.at[1] * 11, it.turn) };
    })
    .sort((p, q) => p.d - q.d);
  return s + items.map((p) => p.s).join('');
}

// Screen outline of one garden tile, for planting.
export function gardenTile(id, i, j) {
  const g = SCENERY[id];
  const [x, y] = [g.at[0] + i, g.at[1] + j];
  return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([a, b]) => P(a, b, g.z));
}

// The garden plot's outline, for clicking it.
export function gardenOutline(id) {
  const g = SCENERY[id];
  const [x, y] = g.at;
  return [[x, y], [x + PLOT, y], [x + PLOT, y + PLOT], [x, y + PLOT]].map(([a, b]) => P(a, b, g.z));
}

// Where a garden plot is: { cell, at, z }, or undefined.
export function gardenPlot(id) {
  const g = SCENERY[id];
  return g ? { cell: [...g.cell], at: [...g.at], z: g.z } : undefined;
}

// A see-through preview of a piece about to be planted: its footprint and
// the piece itself. `tiles` are the plot tiles it covers; `remove` outlines
// what digging up would take instead.
export function plantPreview(id, { kind, at, turn, tiles, remove }) {
  const g = SCENERY[id];
  if (!g) return '';
  const cls = remove ? 'ghost-foot remove' : 'ghost-foot';
  let s = tiles.map(([i, j]) => `<polygon class="${cls}" points="${gardenTile(id, i, j).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`).join('');
  if (!remove && kind) s += `<g class="ghost-plant">${drawPlant(kind, g.at[0] + at[0], g.at[1] + at[1], g.z, 1, turn)}</g>`;
  return s;
}

// A small picture of a piece, for the planting chips: an svg viewBox around
// the piece drawn at the world origin in the current view.
export function plantThumb(kind, big) {
  const c = big ? 1 : 0.5;
  const [cx, cy] = P(c, c, big ? 1.1 : 0.55);
  const w = big ? 150 : 80;
  return `<svg class="thumb" viewBox="${(cx - w / 2).toFixed(1)} ${(cy - w / 2).toFixed(1)} ${w} ${w}" aria-hidden="true">${drawPlant(kind, 0, 0, 0, 3, false)}</svg>`;
}

// A swatch of a floor in a room's own colours.
export function floorThumb(kind, roomId) {
  const body = bodyOf(roomId);
  const [a, b] = floorTones(body.base ?? body.left, activeTheme);
  const [cx, cy] = P(1.5, 1.5, 0);
  return `<svg class="thumb" viewBox="${(cx - 100).toFixed(1)} ${(cy - 50).toFixed(1)} 200 100" aria-hidden="true">${drawFloor(kind, 0, 0, 0, 3, 3, { a, b, body, seed: 7 })}</svg>`;
}

// Screen box around a garden, for zooming in.
export function gardenFrame(id) {
  const g = SCENERY[id];
  const [x, y] = g.at;
  const pts = [];
  for (const [a, b] of [[x, y], [x + PLOT, y], [x, y + PLOT], [x + PLOT, y + PLOT]]) pts.push(P(a, b, g.z - 0.6), P(a, b, g.z + 3.2));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Floating cubes in empty ring cells; a department built there moves them on.
function floaters() {
  const taken = new Set([...Object.values(LAYOUT), ...Object.values(SCENERY)].map((r) => r.cell.join(',')));
  return [
    [-4, 4, 3, 0.8, M.coral, 'f1'], [24, 13, 5, 0.6, M.sky, 'f2'], [6, 25, 0.5, 0.7, M.lilac, 'f3'],
  ]
    .filter(([x, y]) => !taken.has(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`))
    .map(([x, y, z, k, m, f]) => `<g class="float ${f}">${box(x, y, z, k, k, k, m)}</g>`)
    .join('');
}

// Screen outline of an empty grid cell, for the "build here" markers.
export function cellOutline([c, r]) {
  const x = c * CELL;
  const y = r * CELL;
  return [[x, y], [x + SIZE, y], [x + SIZE, y + SIZE], [x, y + SIZE]].map(([a, b]) => P(a, b, 0));
}

// Draw order: back to front by room centre depth; connectors just before
// the nearer of their two rooms so stairs tuck under floors correctly.
export function buildScene(theme, options = {}) {
  activeTheme = theme;
  detail = options.detail === 'detailed' ? 'detailed' : 'simple';
  decorState = options.decor ?? { rooms: {}, gardens: {} };
  defaultGardens = options.defaultGardens ?? {};
  plantSize = Object.fromEntries((options.plants ?? []).map((p) => [p.id, [p.w, p.d]]));
  itemSizes = Object.fromEntries((options.roomItems ?? []).map((p) => [p.id, [p.w, p.d]]));
  defaultRoomItems = options.defaultRoomItems ?? {};
  applyTheme(theme);
  const items = [];
  for (const [id, r] of Object.entries(LAYOUT)) {
    const depth = viewDepth(r.x + SIZE / 2, r.y + SIZE / 2);
    items.push({ depth, s: column(id, r) + floor(id, r) + walls(id, r) + furniture(id, r) });
  }
  for (const c of CONNECTORS) {
    const ra = LAYOUT[c.a];
    const rb = LAYOUT[c.b];
    const depth = Math.max(viewDepth(ra.x + SIZE / 2, ra.y + SIZE / 2), viewDepth(rb.x + SIZE / 2, rb.y + SIZE / 2)) - 0.5;
    const [f, t] = ends(c);
    items.push({ depth, s: Math.abs(f[2] - t[2]) < 0.01 ? bridge(c) : stairs(c) });
  }
  for (const id of Object.keys(SCENERY)) {
    const [x, y] = SCENERY[id].at;
    items.push({ depth: viewDepth(x + PLOT / 2, y + PLOT / 2), s: gardenIsland(id) });
  }
  items.sort((p, q) => p.depth - q.depth);
  const geometry = floaters() + items.map((i) => i.s).join('');
  return {
    geometry,
    defs: `${splitGradients()}
      <linearGradient id="window" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--window-top)"/><stop offset="1" stop-color="var(--window-bottom)"/>
      </linearGradient>`,
  };
}

// Label anchors: above the back corner of each floor.
// Label anchors: under the floor corner nearest the viewer.
export function labelPoint(roomId) {
  const r = LAYOUT[roomId];
  const corners = [[r.x, r.y], [r.x + SIZE, r.y], [r.x, r.y + SIZE], [r.x + SIZE, r.y + SIZE]];
  const [cx, cy] = corners.reduce((a, b) => (viewDepth(...b) > viewDepth(...a) ? b : a));
  return P(cx, cy, r.z - 0.9);
}

// The floor outline of a room, for click targets.
export function floorOutline(roomId) {
  const r = LAYOUT[roomId];
  return [[r.x, r.y], [r.x + SIZE, r.y], [r.x + SIZE, r.y + SIZE], [r.x, r.y + SIZE]].map(([x, y]) => P(x, y, r.z));
}

// Screen box around a room with its walls and people, for zooming in.
export function roomFrame(roomId) {
  const r = LAYOUT[roomId];
  const pts = [];
  for (const [x, y] of [[r.x, r.y], [r.x + SIZE, r.y], [r.x, r.y + SIZE], [r.x + SIZE, r.y + SIZE]]) {
    pts.push(P(x, y, r.z - 1.2), P(x, y, r.z + 3.4));
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
