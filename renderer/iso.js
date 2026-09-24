import { shade } from './themes.js';

// Isometric projection and flat-shaded primitives, Monument Valley style:
// no outlines, three tones per solid (top light, left mid, right dark).
//
// World axes: x runs toward the lower right of the screen, y toward the
// lower left, z straight up. One unit of x or y is one floor tile.

export const TW = 32; // half a tile's screen width
export const TH = 16; // half a tile's screen height
export const ZH = 35; // screen height of one unit of z

// The view: the world turned in quarter steps about its centre, so the
// tower can be walked around. Everything projects through P, so figures,
// labels and geometry all follow.
const CX = 11;
const CY = 11;
let VIEW = 0;

export function setView(quarterTurns) {
  VIEW = ((quarterTurns % 4) + 4) % 4;
}

export function getView() {
  return VIEW;
}

function turn(a, b) {
  for (let i = 0; i < VIEW; i++) [a, b] = [-b, a];
  return [a, b];
}

export function toView(x, y) {
  const [a, b] = turn(x - CX, y - CY);
  return [CX + a, CY + b];
}

// Farther from the viewer = smaller. Painter's order sorts on this.
export function viewDepth(x, y) {
  const [a, b] = toView(x, y);
  return a + b;
}

// Whether a face whose outward normal is (nx, ny) in world axes faces the
// viewer in the current view.
export function faceVisible(nx, ny) {
  const [a, b] = turn(nx, ny);
  return a > 0.5 || b > 0.5;
}

function Pv(vx, vy, z) {
  return [(vx - vy) * TW, (vx + vy) * TH - z * ZH];
}

export function P(x, y, z = 0) {
  const [vx, vy] = toView(x, y);
  return Pv(vx, vy, z);
}

function fmt(list, project) {
  return list
    .map((p) => project(p[0], p[1], p[2]))
    .map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`)
    .join(' ');
}

export function pts(list) {
  return fmt(list, P);
}

// A seam-free face: stroke in the fill colour closes hairline gaps.
export function poly(list, fill, extra = '') {
  return `<polygon points="${pts(list)}" fill="${fill}" stroke="${fill}" stroke-width="0.6" stroke-linejoin="round" ${extra}/>`;
}

// Materials: top / left / right tones, filled in from the active colourway
// by applyTheme() before the scene is drawn. Keys are the material names
// in themes.js plus one per room id (that room's tower colour).
export const M = {};

export function applyTheme(theme) {
  for (const k of Object.keys(M)) delete M[k];
  for (const [k, base] of Object.entries(theme.materials)) M[k] = shade(base, theme);
  for (const [room, base] of Object.entries(theme.rooms)) M[room] = { ...shade(base, theme), base };
}

// Faces are worked out in view space, so the lit and shaded sides are
// always the ones facing the viewer, whichever way the tower is turned.
export function box(x, y, z, w, d, h, m, extra = '') {
  const corners = [toView(x, y), toView(x + w, y), toView(x, y + d), toView(x + w, y + d)];
  const vx = Math.min(...corners.map((c) => c[0]));
  const vy = Math.min(...corners.map((c) => c[1]));
  const vw = Math.max(...corners.map((c) => c[0])) - vx;
  const vd = Math.max(...corners.map((c) => c[1])) - vy;
  const t = z + h;
  const face = (list, fill) =>
    `<polygon points="${fmt(list, Pv)}" fill="${fill}" stroke="${fill}" stroke-width="0.6" stroke-linejoin="round"/>`;
  return (
    `<g ${extra}>` +
    face([[vx, vy + vd, t], [vx + vw, vy + vd, t], [vx + vw, vy + vd, z], [vx, vy + vd, z]], m.left) +
    face([[vx + vw, vy, t], [vx + vw, vy + vd, t], [vx + vw, vy + vd, z], [vx + vw, vy, z]], m.right) +
    face([[vx, vy, t], [vx + vw, vy, t], [vx + vw, vy + vd, t], [vx, vy + vd, t]], m.top) +
    '</g>'
  );
}

// Floor with a quiet two-tone tile pattern.
export function tiledTop(x, y, z, w, d, a, b) {
  let s = poly([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], a);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      if ((i + j) % 2) continue;
      s += poly([[x + i, y + j, z], [x + i + 1, y + j, z], [x + i + 1, y + j + 1, z], [x + i, y + j + 1, z]], b);
    }
  }
  return s;
}

// Upright cylinder; a hard-split gradient gives the lit / shaded halves.
export function cylinder(cx, cy, z, r, h, m) {
  const [x0, y0] = P(cx, cy, z);
  const [, y1] = P(cx, cy, z + h);
  const rx = r * Math.SQRT2 * TW;
  const ry = r * Math.SQRT2 * TH;
  const id = gradId(m);
  return (
    `<path d="M${x0 - rx},${y1} L${x0 - rx},${y0} A${rx},${ry} 0 0 0 ${x0 + rx},${y0} L${x0 + rx},${y1} Z" fill="url(#${id})"/>` +
    `<ellipse cx="${x0}" cy="${y1}" rx="${rx}" ry="${ry}" fill="${m.top}"/>`
  );
}

// A round lollipop crown or a ball.
export function ball(cx, cy, z, r, m) {
  const [x, y] = P(cx, cy, z);
  return `<circle cx="${x}" cy="${y}" r="${r * TW}" fill="url(#${gradId(m)})"/>`;
}

export function gradId(m) {
  const key = Object.keys(M).find((k) => M[k] === m) || 'stone';
  return `split-${key.replace(/[^\w-]/g, '')}`;
}

export function splitGradients() {
  return Object.entries(M)
    .map(
      ([k, m]) =>
        `<linearGradient id="split-${k.replace(/[^\w-]/g, '')}" x1="0" x2="1" y1="0" y2="0">` +
        `<stop offset="0.5" stop-color="${m.left}"/><stop offset="0.5" stop-color="${m.right}"/>` +
        '</linearGradient>',
    )
    .join('');
}

// Points of an arch (rectangle with a round top) in a vertical wall plane.
// along(u, z) maps wall-local u and height to a world point.
export function archPoints(along, u0, width, zBase, height, steps = 12) {
  const r = width / 2;
  const cu = u0 + r;
  const springZ = zBase + height - r * 0.9;
  const out = [along(u0, zBase)];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI - (Math.PI * i) / steps;
    out.push(along(cu + r * Math.cos(a), springZ + r * 0.9 * Math.sin(a)));
  }
  out.push(along(u0 + width, zBase));
  return out;
}

// Ring standing in the plane y = cy (the MRI bore).
export function uprightRing(cx, cy, cz, R, r, depth, m) {
  const layers = 6;
  // Extrude from the far face to the near one, whichever that is now.
  const ys = Array.from({ length: layers + 1 }, (_, k) => cy - depth / 2 + (depth * k) / layers)
    .sort((a, b) => viewDepth(cx, a) - viewDepth(cx, b));
  let s = '';
  ys.forEach((yy, k) => {
    const fill = k === layers ? m.top : k > layers / 2 ? m.left : m.right;
    s += `<path fill-rule="evenodd" fill="${fill}" d="${ringPath(cx, yy, cz, R)} ${ringPath(cx, yy, cz, r)}"/>`;
  });
  return s;
}

function ringPath(cx, y, cz, R) {
  const n = 40;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    const [sx, sy] = P(cx + R * Math.cos(t), y, cz + R * Math.sin(t));
    d += `${i ? 'L' : 'M'}${sx.toFixed(1)},${sy.toFixed(1)}`;
  }
  return `${d}Z`;
}

// A round rivet on a vertical face, the MV3 wall ornament. `along(u, z)`
// maps face coordinates to world points.
export function rivet(along, u, z, r, ring, core) {
  const outer = [];
  const inner = [];
  for (let i = 0; i < 20; i++) {
    const a = (2 * Math.PI * i) / 20;
    outer.push(along(u + r * Math.cos(a), z + r * 0.95 * Math.sin(a)));
    inner.push(along(u + r * 0.5 * Math.cos(a), z + r * 0.48 * Math.sin(a)));
  }
  return poly(outer, ring) + poly(inner, core);
}
