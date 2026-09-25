// Room furniture as movable items. Every piece is drawn in its own frame:
// local u runs along its width and v along its depth, both in tiles from
// the item's corner, so the same drawing stands on any tile and can be
// turned a quarter. The catalogue (ids, sizes, starting layouts) is
// src/core/decor.js; the room styles differ only in how a piece looks:
// "simple" is the storybook version, "detailed" the realistic one.

import { P, M, box, cylinder, ball, poly, viewDepth, faceVisible } from './iso.js';
import { drawDecoration } from './decor.js';

const f1 = (v) => v.toFixed(1);

// A frame for an item of W x D tiles at (ox, oy) on a floor at height z.
// Turned, local u runs along world y and local v along world -x.
function frame(ox, oy, z, W, D, turn) {
  const at = (u, v) => (turn ? [ox + (D - v), oy + u] : [ox + u, oy + v]);
  return {
    z,
    at,
    box: (u, v, zz, w, d, h, m) => (turn ? box(ox + D - v - d, oy + u, z + zz, d, w, h, m) : box(ox + u, oy + v, z + zz, w, d, h, m)),
    cyl: (u, v, zz, r, h, m) => cylinder(...at(u, v), z + zz, r, h, m),
    ball: (u, v, zz, r, m) => ball(...at(u, v), z + zz, r, m),
    poly: (pts, fill, extra) => poly(pts.map(([u, v, zz]) => [...at(u, v), z + zz]), fill, extra),
    P: (u, v, zz) => P(...at(u, v), z + zz),
    // Whether a face whose outward normal is (nu, nv) in the item's frame faces the viewer.
    face: (nu, nv) => (turn ? faceVisible(-nv, nu) : faceVisible(nu, nv)),
    depth: (u, v) => viewDepth(...at(u, v)),
  };
}

// A screen: dark bezel with a lit face on whichever side is showing.
function screen(L, u, v, zz, w, h, d = 0.08) {
  let s = L.box(u, v, zz, w, d, h, M.ink);
  const lit = [];
  if (L.face(0, 1)) lit.push(v + d + 0.001);
  else if (L.face(0, -1)) lit.push(v - 0.001);
  for (const vv of lit) s += L.poly([[u + 0.05, vv, zz + 0.05], [u + w - 0.05, vv, zz + 0.05], [u + w - 0.05, vv, zz + h - 0.05], [u + 0.05, vv, zz + h - 0.05]], '#9fd8f0');
  return s;
}

function legs(L, u, v, zz, w, d, h, m, t = 0.05) {
  return L.box(u, v, zz, t, t, h, m) + L.box(u + w - t, v, zz, t, t, h, m) + L.box(u, v + d - t, zz, t, t, h, m) + L.box(u + w - t, v + d - t, zz, t, t, h, m);
}

function chair(L, cu, cv, m = M.ink) {
  return L.cyl(cu, cv, 0, 0.28, 0.05, M.steel) + L.box(cu - 0.03, cv - 0.03, 0.05, 0.06, 0.06, 0.35, M.steel) +
    L.box(cu - 0.25, cv - 0.25, 0.4, 0.5, 0.5, 0.1, m) + L.box(cu - 0.25, cv - 0.3, 0.5, 0.5, 0.08, 0.5, m);
}

// A heartbeat trace on the +v face of a screen.
function ecg(L, u, v, zz) {
  if (!L.face(0, 1)) return '';
  const pattern = [0, 0, 0.05, -0.1, 0.25, -0.15, 0, 0, 0.05, 0];
  const pts = pattern.map((dz, i) => L.P(u + i * 0.07, v, zz + 0.25 + dz).map(f1).join(',')).join(' ');
  return `<polyline class="ecg" points="${pts}" fill="none" stroke="#8ef0c8" stroke-width="1.6" stroke-linejoin="round"/>`;
}

// A ring standing across the v axis at depth cv (a scanner bore, a C-arm),
// extruded from the far face to the near one.
function ring(L, cu, cv, cz, R, r, depth, m) {
  const layers = 6;
  const vs = Array.from({ length: layers + 1 }, (_, k) => cv - depth / 2 + (depth * k) / layers)
    .sort((a, b) => L.depth(cu, a) - L.depth(cu, b));
  const path = (vv, rad) => {
    let d = '';
    for (let i = 0; i <= 40; i++) {
      const t = (2 * Math.PI * i) / 40;
      const [sx, sy] = L.P(cu + rad * Math.cos(t), vv, cz + rad * Math.sin(t));
      d += `${i ? 'L' : 'M'}${f1(sx)},${f1(sy)}`;
    }
    return `${d}Z`;
  };
  return vs.map((vv, k) => `<path fill-rule="evenodd" fill="${k === layers ? m.top : k > layers / 2 ? m.left : m.right}" d="${path(vv, R)} ${path(vv, r)}"/>`).join('');
}

function surgicalLight(L, u, v, h, r) {
  const [lx, ly] = L.P(u, v, h);
  return `<ellipse cx="${f1(lx)}" cy="${f1(ly)}" rx="${f1(r * 60)}" ry="${f1(r * 24)}" fill="#e9eef3"/>` +
    `<ellipse cx="${f1(lx)}" cy="${f1(ly + 2)}" rx="${f1(r * 40)}" ry="${f1(r * 14)}" fill="#fff8d6"/>`;
}

function operatingTable(L, detail) {
  if (!detail) {
    return L.box(0.6, 0.8, 0, 0.8, 1.4, 0.7, M.steel) + L.box(0.1, 0.3, 0.7, 1.8, 2.4, 0.22, M.white) +
      L.box(0.3, 0.4, 0.92, 1.4, 0.6, 0.15, M.mint);
  }
  let s = L.box(0.5, 0.7, 0, 1.0, 1.5, 0.1, M.steel) + L.box(0.8, 1.15, 0.1, 0.4, 0.5, 0.55, M.steel) + L.box(0.25, 0, 0.65, 1.5, 3.0, 0.08, M.steel);
  for (const [a, len, dz] of [[0.02, 0.4, 0], [0.46, 1.04, 0], [1.54, 0.66, 0], [2.24, 0.74, -0.06]]) s += L.box(0.3, a, 0.73 + dz, 1.4, len, 0.14, M.ink);
  s += L.box(-0.3, 0.9, 0.78, 0.55, 0.3, 0.06, M.ink) + L.box(1.75, 0.9, 0.78, 0.55, 0.3, 0.06, M.ink);
  s += L.box(0.2, 0.2, 0.72, 0.04, 2.6, 0.05, M.steel) + L.box(1.76, 0.2, 0.72, 0.04, 2.6, 0.05, M.steel);
  return s;
}

// The specialty piece a navigated department keeps on or by its table.
function specialty(L, kind) {
  const top = 0.87;
  switch (kind) {
    case 'spine': {
      let s = '';
      for (let i = 0; i < 5; i++) s += L.box(0.8, 0.8 + i * 0.4, top, 0.4, 0.3, 0.18, M.cream);
      return s;
    }
    case 'neuro':
    case 'ent':
      return ring(L, 1, 0.35, top + 0.45, 0.45, 0.3, 0.2, M.steel);
    case 'dental':
      return L.box(0.3, 1.5, top, 1.4, 0.7, 0.25, M.mint) + L.box(0.3, 0.3, top, 1.4, 0.35, 0.8, M.mint);
    case 'cmf':
      return L.ball(1, 0.9, top + 0.4, 0.4, M.cream) + L.box(0.75, 1.0, top, 0.5, 0.35, 0.2, M.cream);
    case 'ortho':
    case 'sports':
    case 'trauma':
    case 'ir':
      return ring(L, 1, 1.5, top + 0.6, 1.2, 0.95, 0.35, M.lilac);
    case 'pulmonology':
      return L.box(0.1, 2.3, 0, 0.6, 0.6, 1.6, M.white) + L.box(0.12, 2.9, 1.1, 0.56, 0.04, 0.4, M.ink);
    case 'cardio':
      return L.box(1.2, 2.4, 0, 0.7, 0.45, 1.3, M.ink) + ecg(L, 1.25, 2.851, 0.8);
    case 'oncology':
      return L.box(1.2, 2.3, 0, 0.7, 0.6, 0.9, M.steel) + L.box(1.25, 2.35, 0.9, 0.6, 0.5, 0.05, M.white);
    default:
      return L.cyl(1.7, 2.7, 0, 0.22, 0.33, M.coral) + L.ball(1.7, 2.7, 0.62, 0.3, M.leaf);
  }
}

const BLANKETS = ['sky', 'mint', 'lilac'];

const ITEMS = {
  'station-counter': (L, o) => (o.detail
    ? L.box(0, 0, 0, 4, 0.6, 0.8, M.white) + screen(L, 0.5, 0.1, 0.95, 0.7, 0.45) + L.box(0.8, 0.05, 0.8, 0.1, 0.1, 0.15, M.steel) +
      screen(L, 2.8, 0.1, 0.95, 0.7, 0.45) + L.box(3.1, 0.05, 0.8, 0.1, 0.1, 0.15, M.steel) +
      L.box(0, 0.65, 0, 4, 0.25, 1.15, M.teal) + L.box(-0.05, 0.6, 1.15, 4.1, 0.4, 0.06, M.white)
    : L.box(0.05, 0.05, 0, 3.9, 0.9, 1.05, M.white) + L.box(0.05, 0.05, 1.05, 3.9, 0.9, 0.12, M.teal) +
      L.box(0.5, 0.2, 1.17, 0.7, 0.45, 0.45, M.ink) + L.box(2.8, 0.2, 1.17, 0.7, 0.45, 0.45, M.ink)),
  'office-chair': (L) => chair(L, 0.5, 0.55),
  'operating-table': (L, o) => {
    let s = operatingTable(L, o.detail);
    // the light pool and the lamp heads above the table
    const [ta, tb] = [L.P(0.3, 0.5, 0.95), L.P(1.7, 1.8, 0.95)];
    const [lx, ly] = L.P(1, 1.4, 2.9);
    s += `<polygon points="${f1(lx - 26)},${f1(ly)} ${f1(lx + 26)},${f1(ly)} ${f1(tb[0])},${f1(tb[1])} ${f1(ta[0])},${f1(ta[1])}" fill="#fffbe6" opacity="0.32"/>`;
    s += L.box(0.95, 1.35, 2.95, 0.1, 0.1, 1.2, M.steel) + surgicalLight(L, 1, 1.4, 2.9, 0.5);
    if (o.detail) s += L.box(1.45, 2.25, 2.95, 0.08, 0.08, 1.2, M.steel) + surgicalLight(L, 1.5, 2.3, 2.7, 0.4);
    return s;
  },
  'anaesthesia-machine': (L) =>
    L.cyl(0.25, 0.55, 0, 0.1, 0.95, M.mint) + L.box(0.4, 0.3, 0, 1.2, 0.6, 1.1, M.white) +
    L.box(0.45, 0.901, 0.2, 1.1, 0.02, 0.25, M.steel) + L.box(0.45, 0.901, 0.55, 1.1, 0.02, 0.25, M.steel) +
    screen(L, 0.6, 0.4, 1.12, 0.8, 0.55) + L.cyl(1.78, 0.55, 0, 0.1, 0.95, M.white),
  'vitals-monitor': (L) => L.box(0.4, 0.4, 0, 0.2, 0.2, 1.5, M.steel) + L.box(0.1, 0.25, 1.5, 0.8, 0.5, 0.7, M.ink) + ecg(L, 0.15, 0.751, 1.62),
  bookshelf: (L) => {
    let s = L.box(0.3, 0, 0, 0.6, 3, 2, M.sand);
    if (!L.face(1, 0)) return s;
    const colors = ['#e3877a', '#6fb5ae', '#f0c27a', '#a88fc6', '#86a9d6'];
    for (let shelf = 0; shelf < 3; shelf++) {
      for (let i = 0; i < 5; i++) {
        const vv = 0.15 + i * 0.52;
        const zz = 0.2 + shelf * 0.62;
        s += L.poly([[0.901, vv, zz], [0.901, vv + 0.4, zz], [0.901, vv + 0.4, zz + 0.45], [0.901, vv, zz + 0.45]], colors[(i + shelf * 2) % colors.length]);
      }
    }
    return s;
  },
  desk: (L) => L.box(0.2, 0, 0, 1.6, 1, 0.75, M.sand) + L.box(0.6, 0.25, 0.75, 0.7, 0.5, 0.05, M.ink) + L.box(0.6, 0.22, 0.8, 0.7, 0.06, 0.4, M.ink),
  'lab-bench': (L, o) => {
    if (!o.detail) {
      return L.box(0.05, 0, 0, 0.9, 4, 0.95, M.white) + L.box(0.05, 0, 0.95, 0.9, 4, 0.1, M.sky) +
        L.cyl(0.5, 0.5, 1.05, 0.14, 0.45, M.coral) + L.cyl(0.5, 1.3, 1.05, 0.12, 0.6, M.mint) +
        L.cyl(0.5, 2.1, 1.05, 0.16, 0.35, M.lilac) + L.cyl(0.5, 2.9, 1.05, 0.12, 0.55, M.sand);
    }
    let s = L.box(0.05, 0, 0, 0.9, 4, 0.9, M.white) + L.box(0.03, -0.02, 0.9, 0.94, 4.04, 0.08, M.steel) + L.box(0.2, 0.25, 0.975, 0.6, 0.6, 0.01, M.ink);
    if (L.face(1, 0)) for (let i = 0; i < 4; i++) s += L.poly([[0.951, 0.1 + i * 0.98, 0.12], [0.951, 0.95 + i * 0.98, 0.12], [0.951, 0.95 + i * 0.98, 0.8], [0.951, 0.1 + i * 0.98, 0.8]], M.steel.left);
    return s + L.box(0.1, 0.5, 0.98, 0.05, 0.05, 0.35, M.steel) + L.box(0.1, 0.5, 1.3, 0.3, 0.05, 0.05, M.steel) +
      L.box(0.25, 2.1, 0.98, 0.45, 0.35, 0.06, M.ink) + L.box(0.3, 2.15, 1.04, 0.08, 0.08, 0.45, M.ink) +
      L.cyl(0.5, 2.27, 1.2, 0.07, 0.35, M.steel) + L.cyl(0.5, 2.27, 1.55, 0.05, 0.12, M.ink) +
      L.box(0.25, 3.3, 0.98, 0.5, 0.25, 0.1, M.sand) + L.cyl(0.35, 3.42, 1.08, 0.04, 0.25, M.coral) +
      L.cyl(0.5, 3.42, 1.08, 0.04, 0.3, M.mint) + L.cyl(0.65, 3.42, 1.08, 0.04, 0.22, M.lilac);
  },
  'fume-hood': (L) => L.box(0.05, 0.1, 0, 1.9, 0.8, 0.9, M.white) + `<g opacity="0.55">${L.box(0.05, 0.1, 0.9, 1.9, 0.8, 1.1, M.sky)}</g>` + L.box(0, 0.05, 2.0, 2.0, 0.9, 0.3, M.white),
  centrifuge: (L) => L.cyl(0.5, 0.5, 0, 0.45, 0.75, M.steel) + L.cyl(0.5, 0.5, 0.75, 0.28, 0.08, M.ink),
  'mri-scanner': (L, o) => {
    if (!o.detail) {
      return L.box(0.45, 0.1, 0, 1.1, 3.9, 0.55, M.white) + L.box(0.55, 2.6, 0.55, 0.9, 0.5, 0.15, M.lilac) + ring(L, 1, 1.4, 1.3, 1.0, 0.62, 1.0, M.cream);
    }
    let s = L.box(0, 0.4, 0, 2.0, 1.3, 2.2, M.cream) + L.box(-0.05, 0.35, 2.2, 2.1, 1.4, 0.12, M.white);
    const face = L.face(0, 1) ? 1.701 : L.face(0, -1) ? 0.399 : undefined;
    if (face !== undefined) {
      const circle = (r) => Array.from({ length: 32 }, (_, i) => [1 + r * Math.cos((2 * Math.PI * i) / 32), face, 1.15 + r * Math.sin((2 * Math.PI * i) / 32)]);
      s += L.poly(circle(0.85), M.lilac.top) + L.poly(circle(0.64), M.ink.left) + L.poly(circle(0.45), M.ink.right);
    }
    return s + L.box(0.55, 2.0, 0, 0.9, 1.9, 0.55, M.steel) + L.box(0.5, 1.2, 0.55, 1.0, 2.75, 0.12, M.white) + L.box(0.6, 2.4, 0.67, 0.8, 1.2, 0.1, M.lilac);
  },
  'scanner-console': (L) => L.box(0.1, 0.2, 0, 0.8, 0.6, 0.9, M.white) + screen(L, 0.2, 0.3, 0.9, 0.6, 0.45),
  'eye-chart': (L) => {
    let s = L.box(0.45, 0.25, 0.8, 1.1, 0.12, 1.3, M.white) + L.box(0.95, 0.27, 0, 0.1, 0.08, 0.8, M.steel);
    const vv = L.face(0, 1) ? 0.371 : 0.249;
    [0.8, 0.62, 0.46, 0.34, 0.24].forEach((w, i) => {
      const zz = 1.9 - i * 0.24;
      const u0 = 1 - w / 2;
      s += L.poly([[u0, vv, zz], [u0 + w, vv, zz], [u0 + w, vv, zz - 0.1], [u0, vv, zz - 0.1]], M.ink.left);
    });
    return s;
  },
  'exam-chair': (L, o) => (o.detail
    ? L.cyl(0.5, 0.55, 0, 0.35, 0.12, M.steel) + L.box(0.45, 0.5, 0.12, 0.1, 0.1, 0.35, M.steel) +
      L.box(0.1, 0.15, 0.47, 0.8, 0.8, 0.15, M.ink) + L.box(0.1, 0.05, 0.62, 0.8, 0.18, 0.85, M.ink) + L.box(0.3, 0.0, 1.47, 0.4, 0.2, 0.25, M.ink) +
      L.box(0.0, 0.25, 0.7, 0.1, 0.6, 0.08, M.ink) + L.box(0.9, 0.25, 0.7, 0.1, 0.6, 0.08, M.ink) +
      L.box(0.02, -0.4, 1.8, 0.8, 0.08, 0.08, M.steel) + L.cyl(0.35, -0.3, 1.45, 0.12, 0.3, M.steel) + L.cyl(0.65, -0.3, 1.45, 0.12, 0.3, M.steel)
    : L.box(0.05, 0.05, 0, 0.9, 0.9, 0.5, M.ink) + L.box(0.05, 0.05, 0.5, 0.9, 0.25, 0.9, M.ink)),
  'slit-lamp': (L, o) => (o.detail
    ? legs(L, 0.0, 0.1, 0, 1.0, 0.8, 0.8, M.steel) + L.box(-0.02, 0.08, 0.8, 1.04, 0.84, 0.06, M.white) +
      L.box(0.45, 0.4, 0.86, 0.12, 0.12, 0.5, M.ink) + L.cyl(0.51, 0.3, 1.3, 0.08, 0.1, M.steel) + L.box(0.2, 0.2, 0.86, 0.6, 0.15, 0.04, M.ink)
    : L.box(0.05, 0.1, 0, 0.9, 0.8, 0.8, M.white) + L.cyl(0.5, 0.5, 0.8, 0.2, 0.5, M.steel)),
  'hospital-bed': (L, o) => {
    const blanket = M[BLANKETS[o.seed % 3]];
    if (!o.detail) {
      return L.box(0.1, 0, 0, 1.9, 1.05, 0.45, M.white) + L.box(0.7, 0.02, 0.45, 1.3, 1.01, 0.12, blanket) + L.box(0.15, 0.15, 0.45, 0.45, 0.75, 0.18, M.cream);
    }
    let s = '';
    for (const [wu, wv] of [[0.6, 0.12], [2.2, 0.12], [0.6, 0.93], [2.2, 0.93]]) s += L.ball(wu, wv, 0.08, 0.08, M.ink);
    return s + L.box(0.5, 0.05, 0.15, 1.8, 0.95, 0.12, M.steel) + L.box(0.4, 0, 0.15, 0.1, 1.05, 0.8, M.steel) +
      L.box(0.55, 0.1, 0.27, 1.7, 0.85, 0.18, M.white) + L.box(0.6, 0.22, 0.45, 0.4, 0.62, 0.12, M.cream) +
      L.box(1.1, 0.08, 0.45, 1.15, 0.89, 0.06, blanket) + L.box(2.3, 0, 0.15, 0.1, 1.05, 0.5, M.steel) +
      L.box(0.9, 0.99, 0.5, 1.0, 0.04, 0.16, M.steel) + L.box(2.5, 0.05, 0, 0.3, 0.3, 0.04, M.steel) +
      L.box(2.62, 0.17, 0, 0.06, 0.06, 1.9, M.steel) + L.box(2.56, 0.14, 1.5, 0.18, 0.1, 0.32, M.sky);
  },
  'nav-table': (L, o) => (o.detail ? operatingTable(L, true)
    : L.box(0.55, 0.5, 0, 0.9, 1.6, 0.65, M.steel) + L.box(0.1, 0.0, 0.65, 1.8, 2.6, 0.2, M.white)) + specialty(L, o.room?.kind),
  'tracking-camera': (L, o) => {
    let s = '';
    if (o.detail) {
      for (const [wu, wv] of [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) s += L.ball(wu, wv, 0.07, 0.07, M.ink);
      s += L.box(0.1, 0.1, 0.1, 0.8, 0.8, 0.12, M.steel);
    }
    return s + L.box(0.42, 0.42, 0, 0.16, 0.16, 2.3, M.steel) + L.box(-0.1, 0.35, 2.3, 1.2, 0.26, 0.3, M.ink) +
      L.cyl(0.05, 0.62, 2.37, 0.08, 0.02, M.sky) + L.cyl(0.95, 0.62, 2.37, 0.08, 0.02, M.sky);
  },
  'planning-cart': (L, o) => L.box(0.15, 0.2, 0, 0.7, 0.6, 0.85, M.white) + L.box(0.46, 0.46, 0.85, 0.08, 0.08, 0.3, M.steel) +
    (o.detail ? screen(L, 0.05, 0.45, 1.15, 0.9, 0.6) : L.box(0.1, 0.45, 0.85, 0.8, 0.12, 0.6, M.ink)),
  // ---- just for fun --------------------------------------------------------
  sofa: (L) => L.box(0.05, 0.1, 0, 1.9, 0.8, 0.4, M.lilac) + L.box(0.05, 0.1, 0.4, 1.9, 0.22, 0.45, M.lilac) +
    L.box(0.05, 0.3, 0.4, 0.2, 0.6, 0.2, M.lilac) + L.box(1.75, 0.3, 0.4, 0.2, 0.6, 0.2, M.lilac) +
    L.box(0.3, 0.35, 0.4, 0.65, 0.5, 0.1, M.cream) + L.box(1.05, 0.35, 0.4, 0.65, 0.5, 0.1, M.cream),
  rug: (L) => {
    const circle = (r) => Array.from({ length: 28 }, (_, i) => [1 + r * Math.cos((2 * Math.PI * i) / 28), 1 + r * Math.sin((2 * Math.PI * i) / 28), 0.01]);
    return L.poly(circle(0.95), M.coral.left) + L.poly(circle(0.75), M.cream.top) + L.poly(circle(0.5), M.rose.left) + L.poly(circle(0.2), M.cream.top);
  },
  'coffee-table': (L) => legs(L, 0.15, 0.15, 0, 0.7, 0.7, 0.4, M.sand) + L.box(0.1, 0.1, 0.4, 0.8, 0.8, 0.06, M.sand) + L.cyl(0.45, 0.45, 0.46, 0.08, 0.12, M.white),
  'fish-tank': (L) => {
    let s = L.box(0.1, 0.2, 0, 0.8, 0.6, 0.6, M.ink) + `<g opacity="0.6">${L.box(0.1, 0.2, 0.6, 0.8, 0.6, 0.55, M.sky)}</g>`;
    for (const [u, zz, c] of [[0.35, 0.85, M.coral.left], [0.62, 0.98, M.sand.left], [0.5, 0.75, M.rose.left]]) {
      const [sx, sy] = L.P(u, 0.5, zz);
      s += `<ellipse cx="${f1(sx)}" cy="${f1(sy)}" rx="5" ry="3" fill="${c}"/>`;
    }
    return s + L.box(0.2, 0.3, 0.6, 0.06, 0.06, 0.35, M.leaf) + L.box(0.08, 0.18, 1.15, 0.84, 0.64, 0.05, M.ink);
  },
  'vending-machine': (L) => {
    let s = L.box(0.1, 0.2, 0, 0.8, 0.7, 1.9, M.coral);
    const vv = L.face(0, 1) ? 0.901 : L.face(0, -1) ? 0.199 : undefined;
    if (vv !== undefined) {
      s += L.poly([[0.18, vv, 0.8], [0.62, vv, 0.8], [0.62, vv, 1.75], [0.18, vv, 1.75]], '#dff3fb');
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) s += L.poly([[0.24 + c * 0.2, vv, 1.1 + r * 0.22], [0.36 + c * 0.2, vv, 1.1 + r * 0.22], [0.36 + c * 0.2, vv, 1.25 + r * 0.22], [0.24 + c * 0.2, vv, 1.25 + r * 0.22]], [M.mint.left, M.sand.left, M.sky.left][(r + c) % 3]);
    }
    return s;
  },
  'floor-lamp': (L) => L.cyl(0.5, 0.5, 0, 0.22, 0.05, M.ink) + L.box(0.47, 0.47, 0.05, 0.06, 0.06, 1.55, M.ink) + L.cyl(0.5, 0.5, 1.5, 0.28, 0.35, M.sand),
  'filing-cabinet': (L) => {
    let s = L.box(0.15, 0.2, 0, 0.7, 0.65, 1.3, M.steel);
    if (L.face(0, 1)) for (let i = 0; i < 3; i++) s += L.box(0.4, 0.851, 0.3 + i * 0.4, 0.2, 0.02, 0.05, M.ink);
    return s;
  },
  printer: (L) => L.box(0.1, 0.1, 0, 0.8, 0.8, 0.6, M.steel) + L.box(0.15, 0.15, 0.6, 0.7, 0.7, 0.3, M.white) + L.box(0.3, 0.05, 0.62, 0.4, 0.3, 0.02, M.cream),
};

// Draws one placed item. `size` is its [w, d] from the catalogue; `room` is
// the room's layout entry (for the department kind).
export function drawItem(item, size, { ox, oy, z, detail, room, seed = 0 }) {
  const [w, d] = size;
  const x = ox + item.at[0];
  const y = oy + item.at[1];
  if (ITEMS[item.kind]) return ITEMS[item.kind](frame(x, y, z, w, d, item.turn), { detail: detail === 'detailed', room, seed });
  return drawDecoration(item.kind, x + 0.5, y + 0.5, z); // the 1 x 1 decorations
}

export const DRAWN_ITEMS = Object.keys(ITEMS);
