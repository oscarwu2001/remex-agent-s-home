// The hospital: a stepped tower of rooms floating in a dawn sky, joined by
// bridges and stairs. Geometry is static and drawn once; characters walk on
// the floors and connectors defined here.

import {
  P, M, poly, box, tiledTop, cylinder, ball, splitGradients, archPoints, uprightRing, applyTheme, rivet,
  viewDepth, faceVisible,
} from './iso.js';
import { floorTones } from './themes.js';

const BASE_Z = -3; // columns hang down to here and dissolve into mist

// Rooms come from src/core/rooms.js (through the bridge's config): each has
// a grid cell, and a cell is 8 tiles, a 6-tile room plus a 2-tile gap. This
// module only decides heights, furniture and how rooms join.
// Floor top height z; floor spans [x, x+6) x [y, y+6). Tower colours come
// from the colourway (M[roomId]). Walls are not listed: a room gets a wall on
// each side that is at the back in the current view and has no doorway.
export const LAYOUT = {}; // roomId -> { x, y, z, kind? }

const SIZE = 6;
const CELL = 8;
const CORE_Z = {
  radiology: 6, 'vision-clinic': 4, laboratory: 4, 'nurses-station': 2,
  'operating-room': 2, 'research-office': 2, 'general-ward': 0,
};
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

// Where new helpers appear and finished ones leave: the middle of the station.
export const SPAWN = [11, 12.4, 2];

// Walkable joins between rooms. Points run from room a to room b. The core
// joins are fixed; each department adds one to the room it was placed next to.
const CORE_CONNECTORS = [
  { a: 'nurses-station', b: 'operating-room', kind: 'bridge', axis: 'x', from: [14, 11, 2], to: [16, 11, 2] },
  { a: 'nurses-station', b: 'research-office', kind: 'bridge', axis: 'y', from: [11, 14, 2], to: [11, 16, 2] },
  { a: 'nurses-station', b: 'vision-clinic', kind: 'stairs', axis: 'y', from: [11, 8, 2], to: [11, 6, 4] },
  { a: 'nurses-station', b: 'laboratory', kind: 'stairs', axis: 'x', from: [8, 11, 2], to: [6, 11, 4] },
  { a: 'laboratory', b: 'radiology', kind: 'stairs', axis: 'y', from: [3, 8, 4], to: [3, 6, 6] },
  { a: 'operating-room', b: 'general-ward', kind: 'stairs', axis: 'y', from: [19, 14, 2], to: [19, 16, 0] },
];
let CONNECTORS = [...CORE_CONNECTORS];

// Lays out the rooms the config lists: core rooms at their fixed heights,
// departments one step up or down from the room they join, so each gets a
// short flight of stairs.
export function configureRooms(rooms) {
  for (const k of Object.keys(LAYOUT)) delete LAYOUT[k];
  CONNECTORS = [...CORE_CONNECTORS];
  deptMaterial.clear();
  let n = 0;
  for (const room of rooms) {
    const [c, r] = room.cell;
    const x = c * CELL;
    const y = r * CELL;
    if (!room.custom) {
      LAYOUT[room.id] = { x, y, z: CORE_Z[room.id] ?? 2 };
      continue;
    }
    const via = LAYOUT[room.via];
    if (!via) continue; // validated upstream; a missing link is skipped, not guessed
    const z = via.z > 0 ? via.z - 1 : via.z + 1;
    LAYOUT[room.id] = { x, y, z, kind: room.kind };
    deptMaterial.set(room.id, DEPT_MATERIALS[n++ % DEPT_MATERIALS.length]);
    const [vc, vr] = [via.x / CELL, via.y / CELL];
    let from;
    let to;
    let axis;
    if (c === vc + 1) { axis = 'x'; from = [via.x + SIZE, via.y + 3, via.z]; to = [x, y + 3, z]; }
    else if (c === vc - 1) { axis = 'x'; from = [via.x, via.y + 3, via.z]; to = [x + SIZE, y + 3, z]; }
    else if (r === vr + 1) { axis = 'y'; from = [via.x + 3, via.y + SIZE, via.z]; to = [x + 3, y, z]; }
    else { axis = 'y'; from = [via.x + 3, via.y, via.z]; to = [x + 3, y + SIZE, z]; }
    CONNECTORS.push({ a: room.via, b: room.id, kind: from[2] === to[2] ? 'bridge' : 'stairs', axis, from, to });
  }
}

// The tower material of a room: its own colour, or a department's turn.
function bodyOf(id) {
  return M[id] ?? M[deptMaterial.get(id)] ?? M.stone;
}


export function slotPoint(roomId, index) {
  const r = LAYOUT[roomId];
  const slots = SLOTS[roomId] ?? SLOTS.department;
  const [u, v] = slots[index % slots.length];
  // Past the named slots, spread extra people out a little.
  const lap = Math.floor(index / slots.length);
  const jitter = lap ? [((lap * 37) % 7) / 10 - 0.3, ((lap * 53) % 7) / 10 - 0.3] : [0, 0];
  return [r.x + u + jitter[0], r.y + v + jitter[1], r.z];
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
  if (!prev.has(roomId)) return [SPAWN];
  const hops = [];
  for (let r = roomId; prev.get(r); r = prev.get(r).from) hops.unshift(prev.get(r));
  const points = [SPAWN];
  for (const { from, c } of hops) {
    const [p, q] = c.a === from ? [c.from, c.to] : [c.to, c.from];
    points.push(inset(p, from), p, q, inset(q, c.a === from ? c.b : c.a));
  }
  return points;
}

// A point one step inside the room from a doorway, so people do not clip walls.
function inset(p, roomId) {
  const r = LAYOUT[roomId];
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
  return tiledTop(r.x, r.y, r.z + 0.001, SIZE, SIZE, a, b);
}

// Sides with a doorway (a bridge or stairs lands there) never get a wall.
function doorways(id) {
  const r = LAYOUT[id];
  const sides = new Set();
  for (const c of CONNECTORS) {
    for (const [room, p] of [[c.a, c.from], [c.b, c.to]]) {
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
  const [ax, ay, az] = c.from;
  const [bx, by, bz] = c.to;
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
  const [ax, ay, z] = c.from;
  const [bx, by] = c.to;
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

function tree(x, y, z, scale = 1) {
  return (
    box(x - 0.06, y - 0.06, z, 0.12, 0.12, 0.9 * scale, M.sand) +
    ball(x, y, z + 1.25 * scale, 0.55 * scale, M.leaf)
  );
}

function plant(x, y, z) {
  return cylinder(x, y, z, 0.28, 0.4, M.coral) + ball(x, y, z + 0.75, 0.38, M.leaf);
}

function furniture(id, r) {
  const { x, y, z } = r;
  switch (id) {
    case 'nurses-station':
      return (
        box(x + 1, y + 0.8, z, 4.4, 0.9, 1.05, M.white) +
        box(x + 1, y + 0.8, z + 1.05, 4.4, 0.9, 0.12, M.teal) +
        box(x + 1.5, y + 0.95, z + 1.17, 0.7, 0.45, 0.45, M.ink) +
        box(x + 3.8, y + 0.95, z + 1.17, 0.7, 0.45, 0.45, M.ink) +
        plant(x + 5.4, y + 5.4, z) +
        plant(x + 0.6, y + 5.4, z)
      );
    case 'operating-room': {
      const [lx, ly] = P(x + 3, y + 3, z + 2.9);
      const [ta, tb] = [P(x + 2, y + 2, z + 0.95), P(x + 4, y + 4, z + 0.95)];
      return (
        box(x + 2.6, y + 2.3, z, 0.8, 1.4, 0.7, M.steel) +
        box(x + 2.1, y + 1.8, z + 0.7, 1.8, 2.4, 0.22, M.white) +
        box(x + 2.3, y + 1.9, z + 0.92, 1.4, 0.6, 0.15, M.mint) +
        box(x + 4.9, y + 0.9, z, 0.3, 0.3, 1.5, M.steel) +
        box(x + 4.6, y + 0.7, z + 1.5, 0.9, 0.5, 0.7, M.ink) +
        (faceVisible(0, 1)
          ? `<polyline class="ecg" points="${ecg(x + 4.62, y + 1.21, z + 1.62)}" fill="none" stroke="#8ef0c8" stroke-width="1.6" stroke-linejoin="round"/>`
          : '') +
        `<polygon points="${lx - 26},${ly} ${lx + 26},${ly} ${tb[0]},${tb[1]} ${ta[0]},${ta[1]}" fill="#fffbe6" opacity="0.35"/>` +
        `<ellipse cx="${lx}" cy="${ly}" rx="30" ry="12" fill="#e9eef3"/>` +
        `<ellipse cx="${lx}" cy="${ly + 2}" rx="20" ry="7" fill="#fff8d6"/>` +
        box(x + 2.95, y + 2.95, z + 2.95, 0.1, 0.1, 1.2, M.steel)
      );
    }
    case 'research-office':
      return (
        box(x + 0.35, y + 2.6, z, 0.6, 3, 2, M.sand) +
        (faceVisible(1, 0) ? books(x + 0.95, y + 2.75, z) : '') +
        desk(x + 1, y + 1, z) +
        desk(x + 3.6, y + 1, z) +
        plant(x + 5.3, y + 5.3, z)
      );
    case 'laboratory':
      return (
        box(x + 0.35, y + 0.9, z, 0.9, 4.2, 0.95, M.white) +
        box(x + 0.35, y + 0.9, z + 0.95, 0.9, 4.2, 0.1, M.sky) +
        cylinder(x + 0.8, y + 1.5, z + 1.05, 0.14, 0.45, M.coral) +
        cylinder(x + 0.8, y + 2.3, z + 1.05, 0.12, 0.6, M.mint) +
        cylinder(x + 0.8, y + 3.1, z + 1.05, 0.16, 0.35, M.lilac) +
        cylinder(x + 0.8, y + 3.9, z + 1.05, 0.12, 0.55, M.sand) +
        cylinder(x + 4.6, y + 1.5, z, 0.55, 0.9, M.steel) +
        cylinder(x + 4.6, y + 1.5, z + 0.9, 0.3, 0.12, M.ink)
      );
    case 'radiology':
      return (
        box(x + 2.45, y + 1.1, z, 1.1, 3.9, 0.55, M.white) +
        box(x + 2.55, y + 3.6, z + 0.55, 0.9, 0.5, 0.15, M.lilac) +
        uprightRing(x + 3, y + 2.4, z + 1.3, 1.45, 0.8, 1.1, M.cream)
      );
    case 'vision-clinic':
      return (
        eyeChart(x, y, z) +
        box(x + 2.6, y + 3.1, z, 0.9, 0.9, 0.5, M.ink) +
        box(x + 2.6, y + 3.1, z + 0.5, 0.9, 0.25, 0.9, M.ink) +
        box(x + 4.4, y + 1.6, z, 1.1, 0.9, 0.8, M.white) +
        cylinder(x + 4.95, y + 2.05, z + 0.8, 0.2, 0.5, M.steel)
      );
    case 'general-ward': {
      let s = '';
      [M.sky, M.mint, M.lilac].forEach((blanket, i) => {
        const by = y + 0.5 + i * 1.85;
        s += box(x + 0.45, by, z, 1.9, 1.05, 0.45, M.white) +
          box(x + 1.05, by + 0.02, z + 0.45, 1.3, 1.01, 0.12, blanket) +
          box(x + 0.5, by + 0.15, z + 0.45, 0.45, 0.75, 0.18, M.cream);
      });
      return s;
    }
    default:
      return r.kind ? navSuite(r) : '';
  }
}

// Every navigated department shares the kit of surgical navigation: a table,
// an optical tracking camera on its stand, and a planning monitor. One piece
// on top says which specialty it is.
function navSuite(r) {
  const { x, y, z } = r;
  let s =
    box(x + 2.55, y + 2.2, z, 0.9, 1.6, 0.65, M.steel) +
    box(x + 2.1, y + 1.7, z + 0.65, 1.8, 2.6, 0.2, M.white) +
    // tracking camera: a pole and a bar with two lenses, looking at the table
    box(x + 5.05, y + 0.85, z, 0.16, 0.16, 2.3, M.steel) +
    box(x + 4.5, y + 0.8, z + 2.3, 1.2, 0.26, 0.3, M.ink) +
    cylinder(x + 4.65, y + 1.07, z + 2.37, 0.08, 0.02, M.sky) +
    cylinder(x + 5.55, y + 1.07, z + 2.37, 0.08, 0.02, M.sky) +
    // planning monitor on a cart
    box(x + 0.6, y + 0.8, z, 0.7, 0.5, 0.8, M.white) +
    box(x + 0.55, y + 0.95, z + 0.8, 0.8, 0.12, 0.6, M.ink);
  const top = z + 0.85;
  switch (r.kind) {
    case 'spine': // a column of vertebrae on a stand
      for (let i = 0; i < 5; i++) s += box(x + 2.8, y + 2.1 + i * 0.4, top, 0.4, 0.3, 0.18, M.cream);
      break;
    case 'neuro': // a head clamp ring at the head of the table
    case 'ent':
      s += uprightRing(x + 3, y + 1.9, top + 0.45, 0.45, 0.3, 0.2, M.steel);
      break;
    case 'dental': // a reclining dental chair and its lamp
      s += box(x + 2.3, y + 3.2, top, 1.4, 0.7, 0.25, M.mint) + box(x + 2.3, y + 1.9, top, 1.4, 0.35, 0.8, M.mint) +
        box(x + 1.4, y + 2.4, z + 1.9, 0.5, 0.5, 0.12, M.sand);
      break;
    case 'cmf': // a skull model
      s += ball(x + 3, y + 2.5, top + 0.4, 0.4, M.cream) + box(x + 2.75, y + 2.6, top, 0.5, 0.35, 0.2, M.cream);
      break;
    case 'ortho':
    case 'sports':
    case 'trauma':
    case 'ir': // a C-arm over the table
      s += uprightRing(x + 3, y + 3, top + 0.6, 1.2, 0.95, 0.35, M.lilac);
      break;
    case 'pulmonology': // a bronchoscope tower
      s += box(x + 4.6, y + 4.4, z, 0.7, 0.7, 1.6, M.white) + box(x + 4.62, y + 5.05, z + 1.1, 0.6, 0.06, 0.4, M.ink);
      break;
    case 'cardio': // an ECG monitor
      s += box(x + 4.5, y + 4.3, z, 0.9, 0.5, 1.3, M.ink) +
        (faceVisible(0, 1) ? `<polyline class="ecg" points="${ecg(x + 4.55, y + 4.81, z + 0.8)}" fill="none" stroke="#8ef0c8" stroke-width="1.6"/>` : '');
      break;
    case 'oncology': // a tray of instruments
      s += box(x + 4.3, y + 4.4, z, 1, 0.6, 0.9, M.steel) + box(x + 4.35, y + 4.45, z + 0.9, 0.9, 0.5, 0.05, M.white);
      break;
    default: // your own department: a plant to make it homely
      s += plant(x + 5.2, y + 5.2, z);
      break;
  }
  return s;
}

function desk(x, y, z) {
  return (
    box(x, y, z, 1.6, 1, 0.75, M.sand) +
    box(x + 0.4, y + 0.25, z + 0.75, 0.7, 0.5, 0.05, M.ink) +
    box(x + 0.4, y + 0.22, z + 0.8, 0.7, 0.06, 0.4, M.ink)
  );
}

function books(x, y, z) {
  const colors = ['#e3877a', '#6fb5ae', '#f0c27a', '#a88fc6', '#86a9d6'];
  let s = '';
  for (let shelf = 0; shelf < 3; shelf++) {
    for (let i = 0; i < 5; i++) {
      const yy = y + 0.1 + i * 0.52;
      const zz = z + 0.2 + shelf * 0.62;
      s += poly([[x, yy, zz], [x, yy + 0.4, zz], [x, yy + 0.4, zz + 0.45], [x, yy, zz + 0.45]],
        colors[(i + shelf * 2) % colors.length]);
    }
  }
  return s;
}

// A chart board on a thin stand, lettered on whichever face is showing.
function eyeChart(x, y, z) {
  let s = box(x + 0.7, y + 0.25, z + 0.8, 1.1, 0.12, 1.3, M.white) + box(x + 1.2, y + 0.27, z, 0.1, 0.08, 0.8, M.steel);
  const yy = faceVisible(0, 1) ? y + 0.371 : y + 0.249;
  const rows = [0.8, 0.62, 0.46, 0.34, 0.24];
  rows.forEach((w, i) => {
    const zz = z + 1.9 - i * 0.24;
    const x0 = x + 1.25 - w / 2;
    s += poly([[x0, yy, zz], [x0 + w, yy, zz], [x0 + w, yy, zz - 0.1], [x0, yy, zz - 0.1]], M.ink.left);
  });
  return s;
}

function ecg(x, y, z) {
  const pattern = [0, 0, 0.05, -0.1, 0.25, -0.15, 0, 0, 0.05, 0];
  return pattern
    .map((dz, i) => {
      const [sx, sy] = P(x + i * 0.07, y, z + 0.25 + dz);
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    })
    .join(' ');
}

// Scenery: a garden island to the lower left and a low grove island to the
// upper right.
function garden() {
  let s = '';
  s += box(1.5, 17.5, BASE_Z + 1, 4, 4, 3.3 - BASE_Z - 1, M.leaf);
  s += box(1.2, 17.2, 0.6, 4.6, 4.6, 0.4, M.stone);
  s += tiledTop(1.2, 17.2, 1.001, 4.6, 4.6, M.mint.top, M.mint.left);
  s += tree(2.4, 18.4, 1, 1.1) + tree(4.4, 19.2, 1, 0.9) + tree(2.8, 20.6, 1, 0.8);
  s += box(3.6, 20.4, 1, 1.2, 0.4, 0.3, M.sand);
  return s;
}

function grove() {
  let s = '';
  s += box(17.8, 1.8, BASE_Z + 2, 2.8, 2.8, 4.2 - BASE_Z - 2, M.leaf);
  s += box(17.5, 1.5, 4.2, 3.4, 3.4, 0.35, M.stone);
  s += tiledTop(17.5, 1.5, 4.551, 3.4, 3.4, M.mint.top, M.mint.left);
  s += tree(18.6, 2.5, 4.55, 1) + tree(19.9, 3.6, 4.55, 0.8);
  return s;
}

// Floating cubes in empty ring cells; a department built there moves them on.
function floaters() {
  const taken = new Set(Object.values(LAYOUT).map((r) => `${r.x / CELL},${r.y / CELL}`));
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
export function buildScene(theme) {
  activeTheme = theme;
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
    items.push({ depth, s: c.kind === 'stairs' ? stairs(c) : bridge(c) });
  }
  items.push({ depth: viewDepth(3.5, 19.5), s: garden() }, { depth: viewDepth(19.2, 3.2), s: grove() });
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
