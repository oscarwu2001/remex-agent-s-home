// "Detailed" room style: the same rooms furnished with realistic hospital
// equipment, still drawn in the flat Monument Valley manner. The "Simple"
// style lives in scene.js. Coordinates are room-local tiles from the room's
// corner (x, y) on its floor (z), like the simple furniture.

import { P, M, box, cylinder, ball, poly, faceVisible } from './iso.js';

// A disc lying flat, e.g. a surgical light head seen from above.
function disc(cx, cy, z, r, h, m) {
  return cylinder(cx, cy, z, r, h, m);
}

// Four legs and a top: a trolley, stool or small table.
function legs(x, y, z, w, d, h, m, t = 0.05) {
  return (
    box(x, y, z, t, t, h, m) + box(x + w - t, y, z, t, t, h, m) +
    box(x, y + d - t, z, t, t, h, m) + box(x + w - t, y + d - t, z, t, t, h, m)
  );
}

// A screen: dark bezel with a lit face on whichever side is showing.
function screen(x, y, z, w, h, d = 0.08) {
  let s = box(x, y, z, w, d, h, M.ink);
  const yy = faceVisible(0, 1) ? y + d + 0.001 : y - 0.001;
  s += poly([[x + 0.05, yy, z + 0.05], [x + w - 0.05, yy, z + 0.05], [x + w - 0.05, yy, z + h - 0.05], [x + 0.05, yy, z + h - 0.05]], '#9fd8f0');
  return s;
}

function officeChair(cx, cy, z, m = M.ink) {
  return (
    cylinder(cx, cy, z, 0.28, 0.05, M.steel) +
    box(cx - 0.03, cy - 0.03, z + 0.05, 0.06, 0.06, 0.35, M.steel) +
    box(cx - 0.25, cy - 0.25, z + 0.4, 0.5, 0.5, 0.1, m) +
    box(cx - 0.25, cy - 0.3, z + 0.5, 0.5, 0.08, 0.5, m)
  );
}

// The operating table: foot, column, frame, four padded sections, arm boards
// and side rails.
export function operatingTable(x, y, z) {
  let s =
    box(x + 2.5, y + 2.3, z, 1.0, 1.5, 0.1, M.steel) +
    box(x + 2.8, y + 2.75, z + 0.1, 0.4, 0.5, 0.55, M.steel) +
    box(x + 2.25, y + 1.6, z + 0.65, 1.5, 3.0, 0.08, M.steel);
  for (const [a, len, dz] of [[1.62, 0.4, 0], [2.06, 1.04, 0], [3.14, 0.66, 0], [3.84, 0.74, -0.06]]) {
    s += box(x + 2.3, y + a, z + 0.73 + dz, 1.4, len, 0.14, M.ink);
  }
  s += box(x + 1.55, y + 2.5, z + 0.78, 0.72, 0.3, 0.06, M.ink) + box(x + 3.73, y + 2.5, z + 0.78, 0.72, 0.3, 0.06, M.ink);
  s += box(x + 2.2, y + 1.8, z + 0.72, 0.04, 2.6, 0.05, M.steel) + box(x + 3.76, y + 1.8, z + 0.72, 0.04, 2.6, 0.05, M.steel);
  return s;
}

function operatingRoom(x, y, z, ecg) {
  const [l1x, l1y] = P(x + 2.5, y + 2.7, z + 2.85);
  const [ta, tb] = [P(x + 2.3, y + 2.1, z + 0.9), P(x + 3.7, y + 3.4, z + 0.9)];
  return (
    // anaesthesia machine at the head: drawers, monitor, gas cylinders
    cylinder(x + 2.25, y + 0.75, z, 0.1, 0.95, M.mint) +
    box(x + 2.4, y + 0.45, z, 1.2, 0.6, 1.1, M.white) +
    box(x + 2.45, y + 1.051, z + 0.2, 1.1, 0.02, 0.25, M.steel) +
    box(x + 2.45, y + 1.051, z + 0.55, 1.1, 0.02, 0.25, M.steel) +
    screen(x + 2.6, y + 0.55, z + 1.12, 0.8, 0.55) +
    cylinder(x + 3.78, y + 0.75, z, 0.1, 0.95, M.white) +
    operatingTable(x, y, z) +
    // instrument trolley
    legs(x + 4.1, y + 3.0, z, 0.85, 0.55, 0.85, M.steel) +
    box(x + 4.05, y + 2.95, z + 0.85, 0.95, 0.65, 0.05, M.steel) +
    box(x + 4.15, y + 3.05, z + 0.9, 0.5, 0.05, 0.02, M.white) +
    box(x + 4.15, y + 3.25, z + 0.9, 0.6, 0.05, 0.02, M.white) +
    box(x + 4.15, y + 3.45, z + 0.9, 0.4, 0.05, 0.02, M.white) +
    // vital signs monitor on its pole
    box(x + 4.9, y + 0.9, z, 0.3, 0.3, 1.5, M.steel) +
    box(x + 4.6, y + 0.7, z + 1.5, 0.9, 0.5, 0.7, M.ink) +
    (faceVisible(0, 1)
      ? `<polyline class="ecg" points="${ecg(x + 4.62, y + 1.21, z + 1.62)}" fill="none" stroke="#8ef0c8" stroke-width="1.6" stroke-linejoin="round"/>`
      : '') +
    // twin surgical lights on ceiling arms, and their pool of light
    `<polygon points="${l1x - 24},${l1y} ${l1x + 24},${l1y} ${tb[0]},${tb[1]} ${ta[0]},${ta[1]}" fill="#fffbe6" opacity="0.3"/>` +
    box(x + 2.95, y + 2.95, z + 3.25, 0.1, 0.1, 0.5, M.steel) +
    box(x + 2.45, y + 2.95, z + 3.2, 0.55, 0.08, 0.07, M.steel) +
    box(x + 2.95, y + 3.0, z + 3.05, 0.08, 0.85, 0.07, M.steel) +
    box(x + 2.46, y + 2.66, z + 2.95, 0.06, 0.06, 0.28, M.steel) +
    disc(x + 2.5, y + 2.7, z + 2.8, 0.5, 0.15, M.white) +
    disc(x + 2.5, y + 2.7, z + 2.95, 0.18, 0.05, M.steel) +
    box(x + 2.96, y + 3.82, z + 2.8, 0.06, 0.06, 0.28, M.steel) +
    disc(x + 3.0, y + 3.85, z + 2.62, 0.4, 0.14, M.white) +
    disc(x + 3.0, y + 3.85, z + 2.76, 0.15, 0.05, M.steel) +
    // waste bin
    cylinder(x + 1.1, y + 4.9, z, 0.22, 0.45, M.sand)
  );
}

function hospitalBed(x, by, z, blanket, curtain) {
  let s = '';
  for (const [wx, wy] of [[0.6, 0.12], [2.2, 0.12], [0.6, 0.93], [2.2, 0.93]]) s += ball(x + wx, by + wy, z + 0.08, 0.08, M.ink);
  s +=
    box(x + 0.5, by + 0.05, z + 0.15, 1.8, 0.95, 0.12, M.steel) +
    box(x + 0.4, by, z + 0.15, 0.1, 1.05, 0.8, M.steel) +
    box(x + 0.55, by + 0.1, z + 0.27, 1.7, 0.85, 0.18, M.white) +
    box(x + 0.6, by + 0.22, z + 0.45, 0.4, 0.62, 0.12, M.cream) +
    box(x + 1.1, by + 0.08, z + 0.45, 1.15, 0.89, 0.06, blanket) +
    box(x + 2.3, by, z + 0.15, 0.1, 1.05, 0.5, M.steel) +
    box(x + 0.9, by + 0.99, z + 0.5, 1.0, 0.04, 0.16, M.steel) +
    // IV pole and bag
    box(x + 2.5, by + 0.05, z, 0.3, 0.3, 0.04, M.steel) +
    box(x + 2.62, by + 0.17, z, 0.06, 0.06, 1.9, M.steel) +
    box(x + 2.56, by + 0.14, z + 1.5, 0.18, 0.1, 0.32, M.sky);
  // a privacy curtain half drawn along the bed
  if (curtain) s += box(x + 0.45, by + 1.32, z + 0.1, 1.0, 0.05, 1.75, M.mint) + box(x + 0.4, by + 1.32, z + 1.9, 2.0, 0.04, 0.04, M.steel);
  return s;
}

function laboratory(x, y, z) {
  let s =
    // bench with cupboards and a sink
    box(x + 0.35, y + 0.9, z, 0.9, 4.2, 0.9, M.white) +
    box(x + 0.33, y + 0.88, z + 0.9, 0.94, 4.24, 0.08, M.steel) +
    box(x + 0.5, y + 1.15, z + 0.975, 0.6, 0.6, 0.01, M.ink);
  if (faceVisible(1, 0)) {
    for (let i = 0; i < 4; i++) {
      const yy = y + 1.0 + i * 1.02;
      s += poly([[x + 1.251, yy, z + 0.12], [x + 1.251, yy + 0.9, z + 0.12], [x + 1.251, yy + 0.9, z + 0.8], [x + 1.251, yy, z + 0.8]], M.steel.left);
    }
  }
  s +=
    box(x + 0.4, y + 1.4, z + 0.98, 0.05, 0.05, 0.35, M.steel) + box(x + 0.4, y + 1.4, z + 1.3, 0.3, 0.05, 0.05, M.steel) +
    // microscope
    box(x + 0.55, y + 3.0, z + 0.98, 0.45, 0.35, 0.06, M.ink) +
    box(x + 0.6, y + 3.05, z + 1.04, 0.08, 0.08, 0.45, M.ink) +
    cylinder(x + 0.8, y + 3.17, z + 1.2, 0.07, 0.35, M.steel) +
    cylinder(x + 0.8, y + 3.17, z + 1.55, 0.05, 0.12, M.ink) +
    // test tubes in a rack
    box(x + 0.55, y + 4.2, z + 0.98, 0.5, 0.25, 0.1, M.sand) +
    cylinder(x + 0.65, y + 4.32, z + 1.08, 0.04, 0.25, M.coral) +
    cylinder(x + 0.8, y + 4.32, z + 1.08, 0.04, 0.3, M.mint) +
    cylinder(x + 0.95, y + 4.32, z + 1.08, 0.04, 0.22, M.lilac) +
    // fume hood in the corner
    box(x + 3.7, y + 0.35, z, 1.9, 0.8, 0.9, M.white) +
    `<g opacity="0.55">${box(x + 3.7, y + 0.35, z + 0.9, 1.9, 0.8, 1.1, M.sky)}</g>` +
    box(x + 3.65, y + 0.3, z + 2.0, 2.0, 0.9, 0.3, M.white) +
    // centrifuge and a stool
    cylinder(x + 4.8, y + 4.6, z, 0.5, 0.75, M.steel) +
    cylinder(x + 4.8, y + 4.6, z + 0.75, 0.3, 0.08, M.ink) +
    cylinder(x + 2.1, y + 2.5, z, 0.18, 0.05, M.steel) +
    box(x + 2.07, y + 2.47, z + 0.05, 0.06, 0.06, 0.55, M.steel) +
    cylinder(x + 2.1, y + 2.5, z + 0.6, 0.25, 0.08, M.ink);
  return s;
}

function radiology(x, y, z) {
  // MRI gantry: a big housing with the bore opening on its front face.
  let s = box(x + 1.7, y + 1.4, z, 2.6, 1.3, 2.4, M.cream) + box(x + 1.6, y + 1.35, z + 2.4, 2.8, 1.4, 0.12, M.white);
  const face = faceVisible(0, 1) ? y + 2.701 : faceVisible(0, -1) ? y + 1.399 : undefined;
  if (face !== undefined) {
    const ring = (r) => Array.from({ length: 32 }, (_, i) => {
      const a = (2 * Math.PI * i) / 32;
      return [x + 3 + r * Math.cos(a), face, z + 1.25 + r * Math.sin(a)];
    });
    s += poly(ring(0.95), M.lilac.top) + poly(ring(0.72), M.ink.left) + poly(ring(0.5), M.ink.right);
  }
  // patient table and cradle sliding into the bore
  s +=
    box(x + 2.55, y + 3.0, z, 0.9, 1.9, 0.55, M.steel) +
    box(x + 2.5, y + 2.2, z + 0.55, 1.0, 2.9, 0.12, M.white) +
    box(x + 2.6, y + 3.4, z + 0.67, 0.8, 1.2, 0.1, M.lilac) +
    // operator console
    box(x + 4.6, y + 4.2, z, 1.0, 0.6, 0.9, M.white) +
    screen(x + 4.7, y + 4.3, z + 0.9, 0.8, 0.5);
  return s;
}

function visionClinic(x, y, z, eyeChart) {
  return (
    eyeChart(x, y, z) +
    // exam chair with headrest and arms
    cylinder(x + 3, y + 3.6, z, 0.35, 0.12, M.steel) +
    box(x + 2.95, y + 3.55, z + 0.12, 0.1, 0.1, 0.35, M.steel) +
    box(x + 2.6, y + 3.2, z + 0.47, 0.8, 0.8, 0.15, M.ink) +
    box(x + 2.6, y + 3.1, z + 0.62, 0.8, 0.18, 0.85, M.ink) +
    box(x + 2.8, y + 3.05, z + 1.47, 0.4, 0.2, 0.25, M.ink) +
    box(x + 2.5, y + 3.3, z + 0.7, 0.1, 0.6, 0.08, M.ink) + box(x + 3.4, y + 3.3, z + 0.7, 0.1, 0.6, 0.08, M.ink) +
    // phoropter on its arm, in front of the patient's eyes
    box(x + 2.2, y + 2.4, z, 0.1, 0.1, 1.9, M.steel) +
    box(x + 2.2, y + 2.4, z + 1.8, 0.8, 0.08, 0.08, M.steel) +
    cylinder(x + 2.85, y + 2.5, z + 1.45, 0.14, 0.32, M.steel) +
    cylinder(x + 3.15, y + 2.5, z + 1.45, 0.14, 0.32, M.steel) +
    // slit lamp on its table
    legs(x + 4.4, y + 1.6, z, 1.1, 0.8, 0.8, M.steel) +
    box(x + 4.35, y + 1.55, z + 0.8, 1.2, 0.9, 0.06, M.white) +
    box(x + 4.85, y + 1.9, z + 0.86, 0.12, 0.12, 0.5, M.ink) +
    cylinder(x + 4.91, y + 1.8, z + 1.3, 0.08, 0.1, M.steel) +
    box(x + 4.6, y + 1.7, z + 0.86, 0.6, 0.15, 0.04, M.ink)
  );
}

function nursesStation(x, y, z, plant) {
  return (
    officeChair(x + 2.0, y + 0.45, z) +
    officeChair(x + 4.0, y + 0.45, z) +
    box(x + 5.35, y + 0.4, z, 0.5, 0.5, 1.1, M.steel) +
    // two-level counter: a desk behind a raised front ledge
    box(x + 1, y + 0.8, z, 4.4, 0.75, 0.8, M.white) +
    screen(x + 1.6, y + 0.95, z + 0.95, 0.7, 0.45) + box(x + 1.9, y + 0.9, z + 0.8, 0.1, 0.1, 0.15, M.steel) +
    screen(x + 3.8, y + 0.95, z + 0.95, 0.7, 0.45) + box(x + 4.1, y + 0.9, z + 0.8, 0.1, 0.1, 0.15, M.steel) +
    box(x + 1, y + 1.55, z, 4.4, 0.25, 1.15, M.teal) +
    box(x + 0.95, y + 1.5, z + 1.15, 4.5, 0.4, 0.06, M.white) +
    plant(x + 5.4, y + 5.4, z) +
    plant(x + 0.6, y + 5.4, z)
  );
}

function researchOffice(x, y, z, books, desk, plant) {
  return (
    box(x + 0.35, y + 2.6, z, 0.6, 3, 2, M.sand) +
    (faceVisible(1, 0) ? books(x + 0.95, y + 2.75, z) : '') +
    desk(x + 1, y + 1, z) +
    desk(x + 3.6, y + 1, z) +
    officeChair(x + 1.8, y + 2.35, z, M.coral) +
    officeChair(x + 4.4, y + 2.35, z, M.coral) +
    // whiteboard on a stand
    legs(x + 4.9, y + 4.1, z, 0.9, 0.3, 0.9, M.steel) +
    box(x + 4.85, y + 4.2, z + 0.9, 1.0, 0.06, 0.9, M.white) +
    plant(x + 5.3, y + 5.5, z)
  );
}

// Every navigated department: the operating table, an optical tracking camera
// on a wheeled tower, and a planning workstation on a cart.
export function navSuiteDetailed(r, specialty) {
  const { x, y, z } = r;
  let s = operatingTable(x, y, z);
  for (const [wx, wy] of [[4.75, 0.6], [5.45, 0.6], [4.75, 1.3], [5.45, 1.3]]) s += ball(x + wx, y + wy, z + 0.07, 0.07, M.ink);
  s +=
    box(x + 4.7, y + 0.55, z + 0.1, 0.8, 0.8, 0.12, M.steel) +
    box(x + 5.05, y + 0.9, z + 0.22, 0.1, 0.1, 1.9, M.steel) +
    box(x + 4.5, y + 0.85, z + 2.1, 1.2, 0.25, 0.28, M.ink) +
    cylinder(x + 4.65, y + 1.11, z + 2.16, 0.08, 0.02, M.sky) +
    cylinder(x + 5.55, y + 1.11, z + 2.16, 0.08, 0.02, M.sky) +
    box(x + 0.5, y + 0.7, z, 0.8, 0.6, 0.85, M.white) +
    box(x + 0.85, y + 0.95, z + 0.85, 0.08, 0.08, 0.3, M.steel) +
    screen(x + 0.45, y + 0.9, z + 1.15, 0.9, 0.6);
  return s + specialty;
}

export function detailedFurniture(id, r, kit) {
  const { x, y, z } = r;
  switch (id) {
    case 'nurses-station': return nursesStation(x, y, z, kit.plant);
    case 'operating-room': return operatingRoom(x, y, z, kit.ecg);
    case 'research-office': return researchOffice(x, y, z, kit.books, kit.desk, kit.plant);
    case 'laboratory': return laboratory(x, y, z);
    case 'radiology': return radiology(x, y, z);
    case 'vision-clinic': return visionClinic(x, y, z, kit.eyeChart);
    case 'general-ward': {
      let s = '';
      [M.sky, M.mint, M.lilac].forEach((blanket, i) => { s += hospitalBed(x, y + 0.5 + i * 1.85, z, blanket, i < 2); });
      return s;
    }
    default:
      return undefined; // departments: scene.js adds the suite around its specialty piece
  }
}

