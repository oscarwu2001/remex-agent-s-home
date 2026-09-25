// What people can choose for their hospital, drawn: room floors, the
// decorations that stand on a room's spots, and what grows in the gardens.
// The catalogue (ids, names, which room takes what) is src/core/decor.js,
// handed over in the config; this module only knows how each piece looks.
// Everything is drawn from the colourway's materials, so it follows the
// colourway and the time of day like the rest of the building.

import { P, M, poly, box, cylinder, ball, uprightRing, viewDepth, faceVisible } from './iso.js';
import { mix } from './themes.js';

const f1 = (v) => v.toFixed(1);

// A flat round dot lying on a surface: flowers, speckles, lenses.
function dot(x, y, z, r, fill) {
  const [sx, sy] = P(x, y, z);
  return `<ellipse cx="${f1(sx)}" cy="${f1(sy)}" rx="${f1(r * 45)}" ry="${f1(r * 22.6)}" fill="${fill}"/>`;
}

// A small round blob standing up: a bloom on a stem.
function bloom(x, y, z, r, fill) {
  const [sx, sy] = P(x, y, z);
  return `<circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(r * 32)}" fill="${fill}"/>`;
}

function quad(x, y, z, w, d, fill) {
  return poly([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], fill);
}

// A tiny pseudo-random sequence, so speckles and flowers sit in the same
// places on every redraw.
function seeded(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---- floors ------------------------------------------------------------------

// `body` is the room's tower material; `a`, `b` its two pale floor tints.
// Each floor is drawn over the square [x, x+w) x [y, y+d) at height z.
export function drawFloor(kind, x, y, z, w, d, { a, b, body, seed = 1 }) {
  switch (kind) {
    case 'tiles': { // big 2 x 2 tiles with a fine grout line
      let s = quad(x, y, z, w, d, mix(a, '#ffffff', 0.25));
      for (let i = 0; i < w; i += 2) {
        for (let j = 0; j < d; j += 2) {
          s += quad(x + i + 0.05, y + j + 0.05, z, 1.9, 1.9, ((i + j) / 2) % 2 ? b : a);
        }
      }
      return s;
    }
    case 'mosaic': { // half-size tiles, three tones
      const tones = [a, b, mix(a, body.left, 0.35)];
      let s = quad(x, y, z, w, d, a);
      const rnd = seeded(seed * 97);
      for (let i = 0; i < w * 2; i++) {
        for (let j = 0; j < d * 2; j++) {
          const t = tones[Math.floor(rnd() * 3)];
          if (t !== a) s += quad(x + i / 2, y + j / 2, z, 0.5, 0.5, t);
        }
      }
      return s;
    }
    case 'wood': { // boards running along x, joints staggered
      const plank = [M.sand.top, mix(M.sand.top, M.sand.left, 0.35)];
      const seam = mix(M.sand.left, M.sand.right, 0.4);
      let s = quad(x, y, z, w, d, seam);
      const rows = d * 2;
      for (let j = 0; j < rows; j++) {
        const off = (j % 3) * 0.9;
        let u = -off;
        let k = 0;
        while (u < w) {
          const u0 = Math.max(0, u);
          const u1 = Math.min(w, u + 2.6);
          if (u1 - u0 > 0.1) s += quad(x + u0 + 0.02, y + j / 2 + 0.03, z, u1 - u0 - 0.04, 0.44, plank[(j + k) % 2]);
          u += 2.6;
          k++;
        }
      }
      return s;
    }
    case 'terrazzo': { // pale stone with chips of the colourway
      let s = quad(x, y, z, w, d, mix(M.cream.top, '#ffffff', 0.2));
      const base = M.cream.top;
      const chips = [body.left, M.sand.left, M.sky.left, M.stone.right].map((c) => mix(c, base, 0.45));
      const rnd = seeded(seed * 131);
      for (let n = 0; n < w * d * 2; n++) {
        s += dot(x + 0.15 + rnd() * (w - 0.3), y + 0.15 + rnd() * (d - 0.3), z, 0.02 + rnd() * 0.03, chips[n % chips.length]);
      }
      return s;
    }
    case 'vinyl': // one colour with a darker border
      return quad(x, y, z, w, d, b) + quad(x + 0.35, y + 0.35, z, w - 0.7, d - 0.7, a);
    default: { // checker, the original
      let s = quad(x, y, z, w, d, a);
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < d; j++) if (!((i + j) % 2)) s += quad(x + i, y + j, z, 1, 1, b);
      }
      return s;
    }
  }
}

// ---- room decorations ------------------------------------------------------------

function pot(x, y, z, r = 0.24) {
  return cylinder(x, y, z, r, r * 1.5, M.coral);
}

const PIECES = {
  plant: (x, y, z) => pot(x, y, z) + ball(x, y, z + 0.72, 0.34, M.leaf),
  'tall-plant': (x, y, z) =>
    pot(x, y, z, 0.26) + box(x - 0.03, y - 0.03, z + 0.39, 0.06, 0.06, 0.8, M.sand) +
    ball(x - 0.08, y, z + 1.1, 0.3, M.leaf) + ball(x + 0.12, y + 0.05, z + 1.4, 0.26, M.leaf) + ball(x, y - 0.05, z + 1.66, 0.2, M.leaf),
  flowers: (x, y, z) => {
    let s = box(x - 0.3, y - 0.3, z, 0.6, 0.6, 0.62, M.sand) + cylinder(x, y, z + 0.62, 0.1, 0.28, M.sky);
    const colours = [M.coral.left, M.rose.left, M.sand.left, M.lilac.left, M.white.top];
    [[0, 0], [-0.1, 0.06], [0.1, -0.04], [0.04, 0.12], [-0.06, -0.1]].forEach(([dx, dy], i) => {
      s += bloom(x + dx, y + dy, z + 1.02 + (i % 2) * 0.08, 0.075, colours[i]);
    });
    return s;
  },
  'water-cooler': (x, y, z) =>
    box(x - 0.25, y - 0.25, z, 0.5, 0.5, 0.95, M.white) + cylinder(x, y, z + 0.95, 0.2, 0.45, M.sky) +
    box(x - 0.08, y + 0.24, z + 0.62, 0.16, 0.04, 0.08, M.ink),
  sanitiser: (x, y, z) =>
    box(x - 0.18, y - 0.18, z, 0.36, 0.36, 0.05, M.steel) + box(x - 0.03, y - 0.03, z + 0.05, 0.06, 0.06, 1.05, M.steel) +
    box(x - 0.11, y - 0.09, z + 1.1, 0.22, 0.18, 0.3, M.white) + box(x - 0.06, y - 0.04, z + 1.4, 0.12, 0.08, 0.06, M.teal),
  'visitor-chair': (x, y, z) => chair(x, y, z, M.teal),
  'waiting-bench': (x, y, z) => {
    let s = box(x - 0.45, y - 0.2, z, 0.9, 0.4, 0.05, M.steel);
    for (const dx of [-0.4, 0.35]) s += box(x + dx, y - 0.15, z, 0.05, 0.3, 0.38, M.steel);
    return s + box(x - 0.45, y - 0.22, z + 0.38, 0.9, 0.44, 0.08, M.teal) + box(x - 0.45, y - 0.24, z + 0.46, 0.9, 0.08, 0.42, M.teal);
  },
  'supply-trolley': (x, y, z) => {
    let s = '';
    for (const [dx, dy] of [[-0.25, -0.2], [0.25, -0.2], [-0.25, 0.2], [0.25, 0.2]]) s += ball(x + dx, y + dy, z + 0.05, 0.05, M.ink);
    for (const h of [0.15, 0.5, 0.85]) s += box(x - 0.32, y - 0.25, z + h, 0.64, 0.5, 0.05, M.steel);
    s += box(x - 0.3, y - 0.23, z + 0.2, 0.04, 0.04, 0.7, M.steel) + box(x + 0.26, y + 0.19, z + 0.2, 0.04, 0.04, 0.7, M.steel);
    return s + box(x - 0.2, y - 0.15, z + 0.9, 0.2, 0.25, 0.14, M.sky) + box(x + 0.05, y - 0.1, z + 0.9, 0.18, 0.2, 0.1, M.white) +
      box(x - 0.15, y - 0.15, z + 0.55, 0.3, 0.3, 0.12, M.mint);
  },
  'crash-cart': (x, y, z) => {
    let s = box(x - 0.3, y - 0.25, z + 0.06, 0.6, 0.5, 0.85, M.coral);
    for (const h of [0.3, 0.52, 0.74]) s += box(x - 0.31, y - 0.26, z + h, 0.62, 0.52, 0.02, M.white);
    return s + box(x - 0.22, y - 0.15, z + 0.91, 0.38, 0.3, 0.16, M.ink) + box(x - 0.17, y + 0.16, z + 0.95, 0.28, 0.02, 0.08, M.mint);
  },
  'instrument-tray': (x, y, z) =>
    box(x - 0.15, y - 0.15, z, 0.3, 0.3, 0.04, M.steel) + box(x - 0.03, y - 0.03, z + 0.04, 0.06, 0.06, 0.85, M.steel) +
    box(x - 0.35, y - 0.25, z + 0.89, 0.7, 0.5, 0.05, M.steel) +
    box(x - 0.25, y - 0.15, z + 0.94, 0.5, 0.04, 0.02, M.white) + box(x - 0.25, y, z + 0.94, 0.4, 0.04, 0.02, M.white) +
    box(x - 0.25, y + 0.12, z + 0.94, 0.45, 0.04, 0.02, M.white),
  'scrub-sink': (x, y, z) =>
    box(x - 0.4, y - 0.25, z, 0.8, 0.5, 0.8, M.steel) + box(x - 0.32, y - 0.17, z + 0.72, 0.64, 0.34, 0.08, M.white) +
    box(x - 0.03, y - 0.22, z + 0.8, 0.06, 0.06, 0.35, M.steel) + box(x - 0.03, y - 0.22, z + 1.12, 0.06, 0.2, 0.05, M.steel),
  'sharps-bin': (x, y, z) =>
    box(x - 0.18, y - 0.18, z, 0.36, 0.36, 0.5, M.sand) + box(x - 0.2, y - 0.2, z + 0.5, 0.4, 0.4, 0.08, M.coral),
  'specimen-fridge': (x, y, z) =>
    box(x - 0.35, y - 0.3, z, 0.7, 0.6, 1.7, M.white) + box(x - 0.28, y + 0.3, z + 0.15, 0.56, 0.01, 1.4, M.sky) +
    box(x + 0.18, y + 0.31, z + 0.7, 0.04, 0.04, 0.4, M.steel),
  'tube-rack': (x, y, z) => {
    let s = box(x - 0.3, y - 0.3, z, 0.6, 0.6, 0.7, M.white) + box(x - 0.25, y - 0.1, z + 0.7, 0.5, 0.2, 0.1, M.steel);
    const colours = [M.coral, M.mint, M.lilac, M.sky, M.sand];
    colours.forEach((m, i) => { s += cylinder(x - 0.2 + i * 0.1, y, z + 0.8, 0.035, 0.25, m); });
    return s;
  },
  eyewash: (x, y, z) =>
    box(x - 0.03, y - 0.03, z, 0.06, 0.06, 1.0, M.mint) + cylinder(x, y, z + 1.0, 0.22, 0.06, M.mint) +
    box(x - 0.2, y + 0.1, z + 1.5, 0.4, 0.3, 0.04, M.mint) + box(x - 0.02, y + 0.15, z + 1.05, 0.04, 0.04, 0.45, M.mint),
  'apron-rack': (x, y, z) => {
    let s = box(x - 0.3, y - 0.12, z, 0.6, 0.24, 0.05, M.steel) + box(x - 0.03, y - 0.03, z + 0.05, 0.06, 0.06, 1.5, M.steel) +
      box(x - 0.35, y - 0.05, z + 1.5, 0.7, 0.1, 0.05, M.steel);
    [M.sky, M.coral, M.teal].forEach((m, i) => { s += box(x - 0.32 + i * 0.22, y - 0.02, z + 0.75, 0.2, 0.12, 0.72, m); });
    return s;
  },
  lightbox: (x, y, z) =>
    box(x - 0.2, y - 0.2, z, 0.4, 0.4, 0.05, M.steel) + box(x - 0.03, y - 0.03, z + 0.05, 0.06, 0.06, 0.95, M.steel) +
    box(x - 0.4, y - 0.05, z + 1.0, 0.8, 0.1, 0.6, M.ink) +
    (faceVisible(0, 1) ? poly([[x - 0.34, y + 0.051, z + 1.06], [x + 0.34, y + 0.051, z + 1.06], [x + 0.34, y + 0.051, z + 1.54], [x - 0.34, y + 0.051, z + 1.54]], '#eef6ff') : '') +
    (faceVisible(0, -1) ? poly([[x - 0.34, y - 0.051, z + 1.06], [x + 0.34, y - 0.051, z + 1.06], [x + 0.34, y - 0.051, z + 1.54], [x - 0.34, y - 0.051, z + 1.54]], '#eef6ff') : ''),
  'eye-model': (x, y, z) =>
    box(x - 0.25, y - 0.25, z, 0.5, 0.5, 0.7, M.sand) + ball(x, y, z + 1.0, 0.25, M.white) +
    dot(x + 0.12, y + 0.12, z + 1.05, 0.08, M.sky.right) + dot(x + 0.14, y + 0.14, z + 1.05, 0.035, M.ink.left),
  'glasses-stand': (x, y, z) => {
    let s = box(x - 0.3, y - 0.2, z, 0.6, 0.4, 1.45, M.white);
    for (let row = 0; row < 3; row++) {
      for (const dx of [-0.14, 0.14]) {
        s += dot(x + dx - 0.05, y + 0.2, z + 0.5 + row * 0.35, 0.05, M.ink.left) + dot(x + dx + 0.05, y + 0.2, z + 0.5 + row * 0.35, 0.05, M.ink.left);
      }
    }
    return s;
  },
  bookcase: (x, y, z) => {
    let s = box(x - 0.4, y - 0.2, z, 0.8, 0.4, 1.6, M.sand);
    const colours = ['#e3877a', '#6fb5ae', '#f0c27a', '#a88fc6', '#86a9d6'];
    for (let shelf = 0; shelf < 3; shelf++) {
      for (let i = 0; i < 5; i++) {
        const zz = z + 0.15 + shelf * 0.5;
        const top = zz + 0.3 + (i % 2) * 0.06;
        const xx = x - 0.34 + i * 0.14;
        for (const side of [1, -1]) {
          if (!faceVisible(0, side)) continue;
          const yy = y + 0.201 * side;
          s += poly([[xx, yy, zz], [xx + 0.11, yy, zz], [xx + 0.11, yy, top], [xx, yy, top]], colours[(i + shelf * 2) % 5]);
        }
      }
    }
    return s;
  },
  globe: (x, y, z) =>
    box(x - 0.18, y - 0.18, z, 0.36, 0.36, 0.08, M.sand) + box(x - 0.03, y - 0.03, z + 0.08, 0.06, 0.06, 0.55, M.sand) +
    ball(x, y, z + 0.9, 0.3, M.sky) + dot(x + 0.05, y + 0.1, z + 1.0, 0.1, M.leaf.left) + dot(x - 0.1, y - 0.02, z + 0.84, 0.07, M.leaf.left),
  armchair: (x, y, z) =>
    box(x - 0.35, y - 0.35, z, 0.7, 0.7, 0.4, M.lilac) + box(x - 0.35, y - 0.35, z + 0.4, 0.7, 0.18, 0.45, M.lilac) +
    box(x - 0.35, y - 0.17, z + 0.4, 0.12, 0.52, 0.18, M.lilac) + box(x + 0.23, y - 0.17, z + 0.4, 0.12, 0.52, 0.18, M.lilac) +
    box(x - 0.2, y - 0.1, z + 0.4, 0.4, 0.4, 0.06, M.cream),
  whiteboard: (x, y, z) => {
    let s = '';
    for (const dx of [-0.38, 0.34]) s += box(x + dx, y - 0.2, z, 0.04, 0.4, 0.05, M.steel) + box(x + dx, y - 0.02, z, 0.04, 0.04, 1.0, M.steel);
    s += box(x - 0.45, y - 0.04, z + 0.7, 0.9, 0.08, 0.75, M.white);
    for (const side of [1, -1]) {
      if (!faceVisible(0, side)) continue;
      const yy = y + 0.041 * side;
      s += poly([[x - 0.3, yy, z + 1.2], [x + 0.1, yy, z + 1.2], [x + 0.1, yy, z + 1.24], [x - 0.3, yy, z + 1.24]], M.sky.right) +
        poly([[x - 0.3, yy, z + 1.05], [x + 0.25, yy, z + 1.05], [x + 0.25, yy, z + 1.09], [x - 0.3, yy, z + 1.09]], M.coral.left) +
        poly([[x - 0.3, yy, z + 0.9], [x, yy, z + 0.9], [x, yy, z + 0.94], [x - 0.3, yy, z + 0.94]], M.ink.top);
    }
    return s;
  },
  wheelchair: (x, y, z) =>
    uprightRing(x, y - 0.28, z + 0.3, 0.3, 0.24, 0.05, M.ink) +
    box(x - 0.25, y - 0.24, z + 0.3, 0.5, 0.48, 0.06, M.sky) + box(x - 0.25, y - 0.24, z + 0.36, 0.5, 0.06, 0.45, M.sky) +
    box(x - 0.25, y + 0.2, z + 0.1, 0.04, 0.04, 0.2, M.steel) + box(x + 0.21, y + 0.2, z + 0.1, 0.04, 0.04, 0.2, M.steel) +
    uprightRing(x, y + 0.28, z + 0.3, 0.3, 0.24, 0.05, M.ink),
  'iv-pole': (x, y, z) =>
    box(x - 0.2, y - 0.2, z, 0.4, 0.4, 0.04, M.steel) + box(x - 0.03, y - 0.03, z + 0.04, 0.06, 0.06, 1.9, M.steel) +
    box(x - 0.2, y - 0.02, z + 1.9, 0.4, 0.04, 0.04, M.steel) + box(x - 0.2, y - 0.06, z + 1.45, 0.14, 0.1, 0.34, M.sky) +
    box(x + 0.08, y - 0.06, z + 1.5, 0.12, 0.08, 0.28, M.sand),
  'spine-model': (x, y, z) => {
    let s = box(x - 0.25, y - 0.25, z, 0.5, 0.5, 0.08, M.ink) + box(x - 0.02, y - 0.02, z + 0.08, 0.04, 0.04, 0.3, M.steel);
    for (let i = 0; i < 7; i++) {
      const bend = Math.sin(i / 2) * 0.05;
      s += box(x - 0.1 + bend, y - 0.08, z + 0.4 + i * 0.17, 0.2, 0.16, 0.12, M.cream);
    }
    return s + box(x - 0.18, y - 0.1, z + 0.3, 0.36, 0.2, 0.12, M.cream);
  },
};

function chair(x, y, z, m) {
  return (
    box(x - 0.22, y - 0.22, z, 0.04, 0.04, 0.4, M.steel) + box(x + 0.18, y - 0.22, z, 0.04, 0.04, 0.4, M.steel) +
    box(x - 0.22, y + 0.18, z, 0.04, 0.04, 0.4, M.steel) + box(x + 0.18, y + 0.18, z, 0.04, 0.04, 0.4, M.steel) +
    box(x - 0.25, y - 0.25, z + 0.4, 0.5, 0.5, 0.08, m) + box(x - 0.25, y - 0.25, z + 0.48, 0.5, 0.07, 0.45, m)
  );
}

export function drawDecoration(id, x, y, z) {
  return PIECES[id] ? PIECES[id](x, y, z) : '';
}

export const DRAWN_DECORATIONS = Object.keys(PIECES);

// ---- garden plants -------------------------------------------------------------

function flowerBed(x, y, z, colours, seed, tall = 0.18) {
  const rnd = seeded(seed);
  let s = dot(x + 0.5, y + 0.5, z + 0.01, 0.38, M.leaf.right);
  const spots = [];
  for (let n = 0; n < 7; n++) spots.push([x + 0.2 + rnd() * 0.6, y + 0.2 + rnd() * 0.6, rnd()]);
  spots.sort((p, q) => viewDepth(p[0], p[1]) - viewDepth(q[0], q[1]));
  for (const [fx, fy, r] of spots) {
    const h = tall * (0.8 + r * 0.5);
    s += box(fx - 0.015, fy - 0.015, z, 0.03, 0.03, h, M.leaf);
    s += bloom(fx, fy, z + h + 0.04, 0.07, colours[Math.floor(r * colours.length)]);
  }
  return s;
}

function tree(x, y, z, scale, crown) {
  return box(x - 0.06 * scale, y - 0.06 * scale, z, 0.12 * scale, 0.12 * scale, 0.9 * scale, M.sand) +
    ball(x, y, z + 1.25 * scale, 0.55 * scale, crown);
}

// (x, y) is the item's lowest corner in the world; `turn` swaps its sides.
const PLANT_PIECES = {
  tulips: (x, y, z, n) => flowerBed(x, y, z, [M.coral.left, M.rose.left, mix(M.coral.left, '#ffffff', 0.3)], n, 0.25),
  daisies: (x, y, z, n) => flowerBed(x, y, z, ['#ffffff', M.cream.top, M.sand.top], n, 0.12),
  lavender: (x, y, z, n) => {
    const rnd = seeded(n);
    let s = dot(x + 0.5, y + 0.5, z + 0.01, 0.36, M.leaf.right);
    for (let k = 0; k < 6; k++) {
      const fx = x + 0.2 + rnd() * 0.6;
      const fy = y + 0.2 + rnd() * 0.6;
      s += box(fx - 0.02, fy - 0.02, z, 0.04, 0.04, 0.2, M.leaf) + box(fx - 0.04, fy - 0.04, z + 0.2, 0.08, 0.08, 0.22, M.lilac);
    }
    return s;
  },
  roses: (x, y, z) => {
    let s = ball(x + 0.5, y + 0.5, z + 0.35, 0.34, M.leaf);
    for (const [dx, dy, dz] of [[0.35, 0.6, 0.55], [0.6, 0.4, 0.62], [0.5, 0.7, 0.4], [0.7, 0.62, 0.45]]) s += bloom(x + dx, y + dy, z + dz, 0.07, M.coral.left);
    return s;
  },
  shrub: (x, y, z) => ball(x + 0.5, y + 0.5, z + 0.32, 0.36, M.leaf),
  'small-tree': (x, y, z) => tree(x + 0.5, y + 0.5, z, 0.85, M.leaf),
  lamp: (x, y, z) =>
    box(x + 0.4, y + 0.4, z, 0.2, 0.2, 0.08, M.ink) + box(x + 0.47, y + 0.47, z + 0.08, 0.06, 0.06, 1.3, M.ink) +
    box(x + 0.4, y + 0.4, z + 1.38, 0.2, 0.2, 0.22, M.sand) + box(x + 0.38, y + 0.38, z + 1.6, 0.24, 0.24, 0.05, M.ink),
  path: (x, y, z) =>
    box(x + 0.12, y + 0.14, z, 0.36, 0.32, 0.05, M.stone) + box(x + 0.55, y + 0.5, z, 0.32, 0.36, 0.05, M.stone) +
    box(x + 0.18, y + 0.6, z, 0.26, 0.24, 0.05, M.stone),
  bench: (x, y, z, n, turn) => {
    const [w, d] = turn ? [0.5, 1.6] : [1.6, 0.5];
    const x0 = x + (turn ? 0.25 : 0.2);
    const y0 = y + (turn ? 0.2 : 0.25);
    let s = '';
    const legs = turn ? [[0.05, 0.1], [0.35, 0.1], [0.05, 1.4], [0.35, 1.4]] : [[0.1, 0.05], [0.1, 0.35], [1.4, 0.05], [1.4, 0.35]];
    for (const [lx, ly] of legs) s += box(x0 + lx, y0 + ly, z, 0.08, 0.08, 0.3, M.ink);
    s += box(x0, y0, z + 0.3, w, d, 0.08, M.sand);
    s += turn ? box(x0, y0, z + 0.38, 0.08, d, 0.35, M.sand) : box(x0, y0, z + 0.38, w, 0.08, 0.35, M.sand);
    return s;
  },
  'big-tree': (x, y, z) => tree(x + 1, y + 1, z, 1.7, M.leaf),
  'blossom-tree': (x, y, z) =>
    tree(x + 1, y + 1, z, 1.55, M.rose) + ball(x + 0.7, y + 1.2, z + 1.85, 0.45, M.coral) + ball(x + 1.3, y + 0.8, z + 2.2, 0.4, M.rose),
  fountain: (x, y, z) =>
    cylinder(x + 1, y + 1, z, 0.85, 0.3, M.stone) + dot(x + 1, y + 1, z + 0.3, 0.72, M.sky.top) +
    cylinder(x + 1, y + 1, z + 0.3, 0.14, 0.55, M.stone) + cylinder(x + 1, y + 1, z + 0.85, 0.36, 0.1, M.stone) +
    dot(x + 1, y + 1, z + 0.95, 0.28, M.sky.top) + bloom(x + 1, y + 1, z + 1.15, 0.08, M.white.top),
};

export function drawPlant(kind, x, y, z, seed = 1, turn = false) {
  return PLANT_PIECES[kind] ? PLANT_PIECES[kind](x, y, z, seed, turn) : '';
}

export const DRAWN_PLANTS = Object.keys(PLANT_PIECES);
