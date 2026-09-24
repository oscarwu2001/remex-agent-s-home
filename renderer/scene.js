// The hospital: a stepped tower of rooms floating in a dawn sky, joined by
// bridges and stairs. Geometry is static and drawn once; characters walk on
// the floors and connectors defined here.

import {
  P, M, poly, box, tiledTop, cylinder, ball, splitGradients, archPoints, uprightRing,
} from './iso.js';

const BASE_Z = -3; // columns hang down to here and dissolve into mist

// Floor top height z; floor spans [x, x+6) x [y, y+6).
export const LAYOUT = {
  radiology: { x: 0, y: 0, z: 6, body: M.lilac, walls: ['north', 'west'] },
  'vision-clinic': { x: 8, y: 0, z: 4, body: M.sand, walls: ['north'] },
  laboratory: { x: 0, y: 8, z: 4, body: M.sky, walls: ['west'] },
  'nurses-station': { x: 8, y: 8, z: 2, body: M.teal, walls: [] },
  'operating-room': { x: 16, y: 8, z: 2, body: M.mint, walls: ['north'] },
  'research-office': { x: 8, y: 16, z: 2, body: M.coral, walls: ['west'] },
  'general-ward': { x: 16, y: 16, z: 0, body: M.rose, walls: ['west'] },
};

const SIZE = 6;

// Where people stand, in room-local tile coordinates.
const SLOTS = {
  'nurses-station': [[1.6, 4.4], [3, 3], [4.4, 2.2], [2.9, 5.3], [4.3, 3.9], [5.5, 2.7]],
  'operating-room': [[1.4, 3], [4.6, 3], [3, 5.2], [1.5, 5], [4.5, 5.2], [3, 0.9]],
  'research-office': [[1.8, 2.9], [4.4, 2.9], [2, 4.5], [3.7, 4.4], [5.1, 3.7], [3, 5.4]],
  laboratory: [[2.1, 2.1], [2.1, 3.6], [3.6, 2.9], [3.6, 4.6], [5, 4], [2.1, 5.2]],
  radiology: [[1.2, 3.6], [4.8, 3.6], [1.5, 5.1], [4.5, 5.1], [3, 5.5], [1.2, 1.6]],
  'vision-clinic': [[1.8, 3], [4.1, 4.2], [2.2, 4.9], [3.6, 5.4], [5.1, 4.8], [1.4, 1.6]],
  'general-ward': [[3.2, 1.1], [3.2, 2.9], [3.2, 4.7], [4.8, 2], [4.8, 3.8], [4.8, 5.4]],
};

// Where new helpers appear and finished ones leave: the middle of the station.
export const SPAWN = [11, 12.4, 2];

// Walkable joins between rooms. Points run from room a to room b.
const CONNECTORS = [
  { a: 'nurses-station', b: 'operating-room', kind: 'bridge', axis: 'x', from: [14, 11, 2], to: [16, 11, 2] },
  { a: 'nurses-station', b: 'research-office', kind: 'bridge', axis: 'y', from: [11, 14, 2], to: [11, 16, 2] },
  { a: 'nurses-station', b: 'vision-clinic', kind: 'stairs', axis: 'y', from: [11, 8, 2], to: [11, 6, 4] },
  { a: 'nurses-station', b: 'laboratory', kind: 'stairs', axis: 'x', from: [8, 11, 2], to: [6, 11, 4] },
  { a: 'laboratory', b: 'radiology', kind: 'stairs', axis: 'y', from: [3, 8, 4], to: [3, 6, 6] },
  { a: 'operating-room', b: 'general-ward', kind: 'stairs', axis: 'y', from: [19, 14, 2], to: [19, 16, 0] },
];

export function slotPoint(roomId, index) {
  const r = LAYOUT[roomId];
  const slots = SLOTS[roomId];
  const [u, v] = slots[index % slots.length];
  // Past the named slots, spread extra people out a little.
  const lap = Math.floor(index / slots.length);
  const jitter = lap ? [((lap * 37) % 7) / 10 - 0.3, ((lap * 53) % 7) / 10 - 0.3] : [0, 0];
  return [r.x + u + jitter[0], r.y + v + jitter[1], r.z];
}

export function slotCount(roomId) {
  return SLOTS[roomId].length;
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

function column(r) {
  const { x, y, z, body } = r;
  return (
    box(x + 0.25, y + 0.25, BASE_Z, SIZE - 0.5, SIZE - 0.5, z - 0.5 - BASE_Z, body) +
    // a thin band where MV towers change material
    box(x + 0.2, y + 0.2, z - 1.6, SIZE - 0.4, SIZE - 0.4, 0.25, M.cream) +
    box(x, y, z - 0.5, SIZE, SIZE, 0.5, M.stone)
  );
}

function floor(r, tone) {
  return tiledTop(r.x, r.y, r.z + 0.001, SIZE, SIZE, tone[0], tone[1]);
}

const FLOOR_TONES = {
  radiology: ['#f1e9f3', '#e9def0'],
  'vision-clinic': ['#fbf2e2', '#f6e8d0'],
  laboratory: ['#eef4fa', '#e2ecf6'],
  'nurses-station': ['#eef7f4', '#e1f0eb'],
  'operating-room': ['#eef8f3', '#def0e7'],
  'research-office': ['#fcefe9', '#f7e1d8'],
  'general-ward': ['#fcf0f0', '#f6e1e2'],
};

function walls(r) {
  let s = '';
  const H = 2.3;
  const T = 0.3;
  if (r.walls.includes('west')) {
    s += box(r.x, r.y, r.z, T, SIZE, H, M.cream);
    // arched windows on the inner face (x = r.x + T)
    const along = (u, zz) => [r.x + T + 0.001, r.y + u, zz];
    for (const u0 of [0.9, 3.6]) {
      s += poly(archPoints(along, u0, 1.3, r.z + 0.7, 1.35), 'url(#window)');
    }
  }
  if (r.walls.includes('north')) {
    s += box(r.x, r.y, r.z, SIZE, T, H, M.cream);
    const along = (u, zz) => [r.x + u, r.y + T + 0.001, zz];
    for (const u0 of r.walls.includes('west') ? [2.1, 4.1] : [0.9, 3.6]) {
      s += poly(archPoints(along, u0, 1.3, r.z + 0.7, 1.35), 'url(#window)');
    }
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
    steps.push({ key: x0 + y0, s: box(x0, y0, low - 1.2, w, d, zTop - (low - 1.2), M.stone) });
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
        `<polyline class="ecg" points="${ecg(x + 4.62, y + 1.21, z + 1.62)}" fill="none" stroke="#8ef0c8" stroke-width="1.6" stroke-linejoin="round"/>` +
        `<polygon points="${lx - 26},${ly} ${lx + 26},${ly} ${tb[0]},${tb[1]} ${ta[0]},${ta[1]}" fill="#fffbe6" opacity="0.35"/>` +
        `<ellipse cx="${lx}" cy="${ly}" rx="30" ry="12" fill="#e9eef3"/>` +
        `<ellipse cx="${lx}" cy="${ly + 2}" rx="20" ry="7" fill="#fff8d6"/>` +
        box(x + 2.95, y + 2.95, z + 2.95, 0.1, 0.1, 1.2, M.steel)
      );
    }
    case 'research-office':
      return (
        box(x + 0.35, y + 2.6, z, 0.6, 3, 2, M.sand) +
        books(x + 0.95, y + 2.75, z) +
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
      return '';
  }
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

function eyeChart(x, y, z) {
  const yy = y + 0.301;
  let s = poly([[x + 0.7, yy, z + 0.8], [x + 1.8, yy, z + 0.8], [x + 1.8, yy, z + 2.1], [x + 0.7, yy, z + 2.1]], '#ffffff');
  const rows = [0.8, 0.62, 0.46, 0.34, 0.24];
  rows.forEach((w, i) => {
    const zz = z + 1.9 - i * 0.24;
    const x0 = x + 1.25 - w / 2;
    s += poly([[x0, yy, zz], [x0 + w, yy, zz], [x0 + w, yy, zz - 0.1], [x0, yy, zz - 0.1]], '#585c7c');
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

// Scenery: a garden island to the lower left and a slim tower carrying the
// cross emblem to the upper right.
function garden() {
  let s = '';
  s += box(1.5, 17.5, BASE_Z + 1, 4, 4, 3.3 - BASE_Z - 1, M.leaf);
  s += box(1.2, 17.2, 0.6, 4.6, 4.6, 0.4, M.stone);
  s += tiledTop(1.2, 17.2, 1.001, 4.6, 4.6, '#dff0e2', '#d2e9d6');
  s += tree(2.4, 18.4, 1, 1.1) + tree(4.4, 19.2, 1, 0.9) + tree(2.8, 20.6, 1, 0.8);
  s += box(3.6, 20.4, 1, 1.2, 0.4, 0.3, M.sand);
  return s;
}

function emblemTower() {
  let s = '';
  s += box(17.5, 1.5, BASE_Z + 2, 3, 3, 7.5 - BASE_Z - 2, M.coral);
  s += box(17.2, 1.2, 7.5, 3.6, 3.6, 0.35, M.stone);
  s += cylinder(19, 3, 7.85, 1.1, 0.25, M.cream);
  return s;
}

function floaters() {
  return (
    `<g class="float f1">${box(-4, 4, 3, 0.8, 0.8, 0.8, M.coral)}</g>` +
    `<g class="float f2">${box(24, 13, 5, 0.6, 0.6, 0.6, M.sky)}</g>` +
    `<g class="float f3">${box(6, 25, 0.5, 0.7, 0.7, 0.7, M.lilac)}</g>`
  );
}

function crossEmblem() {
  const [x, y] = P(19, 3, 9.6);
  return (
    `<g transform="translate(${x} ${y})"><g class="emblem">` +
    '<rect x="-9" y="-30" width="18" height="60" rx="3" fill="#ea9380"/>' +
    '<rect x="-30" y="-9" width="60" height="18" rx="3" fill="#ea9380"/>' +
    '<rect x="-9" y="-30" width="9" height="60" rx="3" fill="#f5b4a3"/>' +
    '<rect x="-30" y="-9" width="30" height="9" rx="3" fill="#f5b4a3"/>' +
    '</g></g>'
  );
}

// Draw order: back to front by room centre depth; connectors just before
// the nearer of their two rooms so stairs tuck under floors correctly.
export function buildScene() {
  const items = [];
  for (const [id, r] of Object.entries(LAYOUT)) {
    const depth = r.x + r.y + SIZE;
    items.push({ depth, s: column(r) + floor(r, FLOOR_TONES[id]) + walls(r) + furniture(id, r) });
  }
  for (const c of CONNECTORS) {
    const ra = LAYOUT[c.a];
    const rb = LAYOUT[c.b];
    const depth = Math.max(ra.x + ra.y, rb.x + rb.y) + SIZE - 0.5;
    items.push({ depth, s: c.kind === 'stairs' ? stairs(c) : bridge(c) });
  }
  items.push({ depth: 23, s: garden() }, { depth: 22, s: emblemTower() });
  items.sort((p, q) => p.depth - q.depth);
  return {
    defs: `${splitGradients()}
      <linearGradient id="window" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--window-top)"/><stop offset="1" stop-color="var(--window-bottom)"/>
      </linearGradient>`,
    geometry: floaters() + items.map((i) => i.s).join('') + crossEmblem(),
  };
}

// Label anchors: above the back corner of each floor.
export function labelPoint(roomId) {
  const r = LAYOUT[roomId];
  return P(r.x + SIZE, r.y + SIZE, r.z - 0.9);
}
