// The creatures of the Meadow, built from blocks like the hospital itself:
// every animal is a handful of boxes drawn with the same isometric
// projection and the same three-tone shading as the towers. Ten species,
// ten looks each (colours, markings and one small accessory).

import { P, box, viewDepth, faceVisible } from './iso.js';
import { THEMES, DEFAULT_THEME, shade, mix } from './themes.js';


// Ten colourways per species: [body, belly, accent].
const PALETTES = {
  cat: [['#f6c28b', '#fff1dc', '#e0875a'], ['#bfb6d9', '#f1eefa', '#8a7fb8'], ['#5e5a73', '#d8d4e6', '#f0a6c0'], ['#fbe3c9', '#ffffff', '#f2a65a'], ['#d7d2cb', '#ffffff', '#8f8a86'],
    ['#f3a6c0', '#fde6ee', '#d06a93'], ['#9fd3c7', '#e7f7f2', '#4f9d8e'], ['#f6d36b', '#fff5d1', '#d69a2d'], ['#a8c7f0', '#eef4fd', '#5d85c7'], ['#3f3a4f', '#8b85a3', '#f6c28b']],
  dog: [['#e9b98a', '#fff1dc', '#9a6a45'], ['#f6f1ea', '#ffffff', '#c9a27e'], ['#8b6a55', '#e8d5c4', '#f3a6c0'], ['#f3d9a4', '#fffaf0', '#d6a04f'], ['#b7b9c6', '#eef0f6', '#6d7185'],
    ['#f5c0b0', '#fff0ea', '#d9796a'], ['#c9e3a8', '#f3fbe8', '#7fae5a'], ['#a9c9ec', '#eef5fd', '#5c86c0'], ['#d4b8e8', '#f6effb', '#9a74c0'], ['#4a3f3c', '#b39b8e', '#f6d36b']],
  bunny: [['#fbf6f0', '#ffffff', '#f3a6c0'], ['#e8d5c4', '#fff8f1', '#c79f86'], ['#c6c2d8', '#f3f1fa', '#8e86b5'], ['#f7d7e3', '#fff3f7', '#e27fa3'], ['#d6ecd6', '#f6fcf6', '#7fb58a'],
    ['#fde7b2', '#fffaeb', '#e3aa3f'], ['#bde0f2', '#f0f9fd', '#5ea3c8'], ['#8a7f7a', '#dcd3cf', '#f3a6c0'], ['#f2c7a8', '#fff2ea', '#d9895c'], ['#e4d9f6', '#fbf8ff', '#a28bd6']],
  fox: [['#f09a5b', '#fff3e6', '#5a4a4a'], ['#f4b35f', '#fff6e3', '#6b4f3a'], ['#e7e3ef', '#ffffff', '#8f86a8'], ['#d97a6c', '#fff0ec', '#553c3c'], ['#c9a27e', '#fbf3ea', '#4f4038'],
    ['#f6c2d2', '#fff5f8', '#b3587a'], ['#9fb7e6', '#f1f5fd', '#44558a'], ['#b6d7a1', '#f5fbef', '#4e7a3e'], ['#f6de8a', '#fffbe9', '#8a6a24'], ['#6f6680', '#d9d4e5', '#f09a5b']],
  dragon: [['#9fe3c4', '#f1fbf6', '#5bb58f'], ['#c3a8ef', '#f4eefd', '#8a6ad0'], ['#f3a6c0', '#fdeef3', '#d06a93'], ['#a9c4f5', '#eef3fd', '#5d7fcf'], ['#f6c28b', '#fff3e4', '#d9804f'],
    ['#f6de8a', '#fffbea', '#d4a72c'], ['#e98e8e', '#fdeaea', '#b24f5f'], ['#8fd3d9', '#ecf9fa', '#3f98a3'], ['#5e5a73', '#bdb7d4', '#f3a6c0'], ['#d8f09a', '#f7fce6', '#88a93a']],
  dinosaur: [['#a8dca0', '#effaec', '#5f9d57'], ['#9fcbe8', '#eef7fd', '#4e8fb8'], ['#f3b5a1', '#fdf0eb', '#cc6f5a'], ['#d5b8ef', '#f7f0fd', '#9168c6'], ['#f6d58a', '#fff8e3', '#c99a2f'],
    ['#f2a6c9', '#fdeef5', '#c55a8d'], ['#bfe8d8', '#f3fcf8', '#58a58a'], ['#e8c9a4', '#fcf5ec', '#a57a4c'], ['#c0c4d8', '#f1f2f8', '#6a6f93'], ['#ffb870', '#fff2e2', '#d2742a']],
  fish: [['#f6a26b', '#fff0e3', '#ffffff'], ['#8fd0f0', '#e9f7fe', '#f6e26b'], ['#f3a6c0', '#fff0f5', '#b986e0'], ['#f6de6b', '#fffbe0', '#5b9be0'], ['#9fe3c4', '#effbf6', '#f5a07a'],
    ['#c3a8ef', '#f5f0fd', '#f6de6b'], ['#f07f7f', '#fdeaea', '#ffffff'], ['#6fb8d9', '#e6f5fb', '#f3a6c0'], ['#ffd1a1', '#fff5ea', '#e07a5f'], ['#b2e36b', '#f5fce8', '#4fa3a0']],
  bird: [['#f9dc6b', '#fff6d6', '#f39a52'], ['#a9d8f2', '#f0f9fe', '#f39a52'], ['#f3a6c0', '#fff0f5', '#f39a52'], ['#b8e3b0', '#f2fbef', '#e8a45a'], ['#d5c2f0', '#f7f2fe', '#f2b25a'],
    ['#ffffff', '#f5f5f5', '#f39a52'], ['#f5b27a', '#fff1e5', '#8a5a3a'], ['#8ea0c8', '#e3e8f5', '#f6d36b'], ['#e97c7c', '#fde7e7', '#f6d36b'], ['#6fc2b5', '#e6f7f4', '#f39a52']],
  turtle: [['#a8d69c', '#f3e3b5', '#6a9d5c'], ['#9fcbe0', '#f1ead0', '#4f88a3'], ['#d8c29a', '#f7eed8', '#9a7b4f'], ['#c3a8ef', '#f6ecd6', '#7f5fbf'], ['#f3b5a1', '#f7ead6', '#c26b55'],
    ['#bfe0a0', '#fff1c9', '#7e9c3a'], ['#8fd3c7', '#efe7cf', '#3f8f82'], ['#f6d58a', '#f9efd3', '#b58a2a'], ['#b8bdd3', '#efe8d6', '#636a8e'], ['#f2a6c9', '#f7e8df', '#b8568a']],
  axolotl: [['#f7c3d6', '#fde8f0', '#e36a98'], ['#fbf1f4', '#ffffff', '#f08aa8'], ['#c9b6f2', '#f4efff', '#8e6ad8'], ['#a9dcf0', '#eef9fd', '#4f9fc7'], ['#f6e08f', '#fffae3', '#e59a3a'],
    ['#b8e7c7', '#effbf3', '#4fa56e'], ['#5e5a73', '#b5afca', '#f7a6c6'], ['#f5b89a', '#fff0e8', '#d9674a'], ['#dbe9a9', '#f8fce9', '#94a93a'], ['#f2d0e6', '#fcf2f8', '#b25fa0']],
};

// Markings and accessories, combined differently for each species so the
// ten looks differ in more than colour.
const MARKS = ['plain', 'spots', 'stripes', 'patch', 'plain', 'spots', 'stripes', 'plain', 'patch', 'spots'];
const ACCESSORIES = ['none', 'bow', 'party-hat', 'scarf', 'crown', 'flower', 'glasses', 'sprout', 'bandana', 'headphones'];
const LOOK_NAMES = ['Honey', 'Lavender', 'Midnight', 'Peach', 'Pebble', 'Blossom', 'Mint', 'Sunny', 'Sky', 'Shadow'];

export const SPECIES = [
  { id: 'cat', name: 'Cat' }, { id: 'dog', name: 'Dog' }, { id: 'bunny', name: 'Bunny' }, { id: 'fox', name: 'Fox' },
  { id: 'dragon', name: 'Dragon' }, { id: 'dinosaur', name: 'Dinosaur' }, { id: 'fish', name: 'Fish' }, { id: 'bird', name: 'Bird' },
  { id: 'turtle', name: 'Turtle' }, { id: 'axolotl', name: 'Axolotl' },
];
export const VARIANTS = 10;

// The look of variant v of a species.
export function lookOf(species, v) {
  const s = SPECIES.findIndex((x) => x.id === species);
  const [body, belly, accent] = PALETTES[species][v % VARIANTS];
  return {
    name: LOOK_NAMES[v % VARIANTS], body, belly, accent,
    mark: MARKS[(v + s) % MARKS.length],
    accessory: ACCESSORIES[(v * 3 + s) % ACCESSORIES.length],
  };
}

// ---- models -----------------------------------------------------------------------
//
// A model is a list of blocks in the creature's own frame, measured in
// tenths of a floor tile: `a` runs to the creature's right, `b` forward
// (its face is at +b), z up from the ground. a and b are block centres, z
// its underside. A block may carry `kids`, smaller blocks stuck to one of
// its faces (eyes, stripes, a hat); a kid is drawn straight after its
// parent when that face is turned toward the viewer, so it can never be
// painted over by the block it sits on.

const FIXED = {
  ink: '#3d3450', white: '#ffffff', pink: '#f59bb0', gold: '#f6cf4f', green: '#6cc47a',
  lens: '#dff3ff', band: '#5b5470', petal: '#f7a6c6', seed: '#f6d36b',
};

const blk = (a, b, z, w, d, h, c, more = {}) => ({ a, b, z, w, d, h, c, ...more });

// A kid on a face of `p`, placed by its own a / b / z; `out` is how far it
// stands proud of that face.
function on(p, face, a, z, w, h, c, out = 0.2, more = {}) {
  const front = p.b + p.d / 2 + out / 2;
  const back = p.b - p.d / 2 - out / 2;
  const kid = face === 'front' ? blk(a, front, z, w, out, h, c, more)
    : face === 'back' ? blk(a, back, z, w, out, h, c, more)
      : face === 'right' ? blk(p.a + p.w / 2 + out / 2, a, z, out, w, h, c, more)
        : blk(p.a - p.w / 2 - out / 2, a, z, out, w, h, c, more); // left: `a` is the b position
  kid.face = face;
  (p.kids ??= []).push(kid);
  return kid;
}

// A kid on top of `p` (always in view: the camera looks down).
function top(p, a, b, w, d, h, c, more = {}) {
  const kid = blk(a, b, p.z + p.h, w, d, h, c, { face: 'top', ...more });
  (p.kids ??= []).push(kid);
  return kid;
}

// A kid wrapped round `p` (a band or collar a little bigger than it).
function wrap(p, z, h, c, grow = 0.15, d = p.d + grow * 2, b = p.b) {
  const kid = blk(p.a, b, z, p.w + grow * 2, d, h, c, { face: 'wrap' });
  (p.kids ??= []).push(kid);
  return kid;
}

function face(H, { snout = 0, eye = 1 } = {}) {
  const ew = Math.max(0.45, Math.min(0.8, H.w * 0.16)) * eye;
  const ez = H.z + H.h * 0.5;
  for (const s of [-1, 1]) {
    const e = on(H, 'front', s * H.w * 0.24, ez, ew, ew * 1.25, 'ink', 0.15);
    on(e, 'front', e.a - (s * ew) / 5, ez + ew * 0.7, ew * 0.4, ew * 0.4, 'white', 0.08);
    on(H, 'front', s * H.w * 0.37, H.z + H.h * 0.26, 0.7, 0.45, 'pink', 0.1);
  }
  if (!snout) on(H, 'front', 0, H.z + H.h * 0.3, 0.5, 0.35, 'pink', 0.15);
}

function snoutOn(H, w, h, d, c = 'belly', nose = 'ink') {
  const s = on(H, 'front', 0, H.z + H.h * 0.14, w, h, c, d);
  on(s, 'front', 0, s.z + h - 0.5, 0.7, 0.45, nose, 0.12);
  return s;
}

function legs(list, spread, front, back, w, d, h, c = 'body') {
  for (const sa of [-1, 1]) {
    for (const [sb, bb] of [[1, front], [-1, back]]) {
      list.push(blk(sa * spread, bb, 0, w, d, h, c, { leg: sa * sb > 0 ? 0 : 1 }));
    }
  }
}

const BUILD = {
  cat(L) {
    const parts = [];
    legs(parts, 1.3, 1.5, -1.9, 1.2, 1.2, 1.6);
    const body = blk(0, -0.3, 1.6, 3.8, 5, 2.6, 'body');
    on(body, 'front', 0, 1.9, 2.2, 1.6, 'belly');
    const head = blk(0, 2.6, 3.0, 4.4, 3.4, 3.4, 'body');
    snoutOn(head, 2.2, 1.2, 0.3, 'belly', 'pink');
    face(head, { snout: 1 });
    for (const s of [-1, 1]) {
      const ear = top(head, s * 1.4, 2.4, 1.2, 0.8, 1.2, 'body');
      on(ear, 'front', ear.a, ear.z + 0.15, 0.6, 0.7, 'pink', 0.08);
    }
    const tail = blk(0, -3.2, 2.8, 0.8, 0.8, 3.2, 'body', { wag: 1 });
    top(tail, 0, -3.2, 0.8, 0.8, 0.8, 'accent');
    parts.push(body, head, tail);
    return { parts, body, head };
  },
  dog(L) {
    const parts = [];
    legs(parts, 1.4, 1.6, -2.0, 1.3, 1.3, 1.6);
    const body = blk(0, -0.3, 1.6, 4.2, 5.4, 2.8, 'body');
    on(body, 'front', 0, 1.9, 2.4, 1.8, 'belly');
    const head = blk(0, 2.8, 3.0, 4.4, 3.6, 3.4, 'body');
    snoutOn(head, 2.4, 1.4, 1.0);
    face(head, { snout: 1 });
    for (const side of ['left', 'right']) on(head, side, head.b, head.z + head.h - 2.6, 1.6, 2.6, 'accent', 0.5);
    const tail = blk(0, -3.4, 3.4, 0.8, 1.2, 1.8, 'accent', { wag: 1 });
    parts.push(body, head, tail);
    return { parts, body, head };
  },
  bunny(L) {
    const parts = [];
    legs(parts, 1.2, 1.3, -1.5, 1.2, 1.4, 1.0);
    const body = blk(0, -0.2, 1.0, 3.8, 4.2, 2.8, 'body');
    on(body, 'front', 0, 1.2, 2.2, 1.8, 'belly');
    const head = blk(0, 2.2, 2.6, 4.0, 3.4, 3.2, 'body');
    snoutOn(head, 1.6, 0.8, 0.2, 'belly', 'pink');
    face(head, { snout: 1 });
    for (const s of [-1, 1]) {
      const ear = top(head, s * 1.0, 1.9, 1.0, 0.7, 3.2, 'body');
      on(ear, 'front', ear.a, ear.z + 0.4, 0.5, 2.2, 'accent', 0.08);
    }
    parts.push(body, head, blk(0, -2.7, 1.8, 1.4, 1.2, 1.4, 'belly', { wag: 1 }));
    return { parts, body, head };
  },
  fox(L) {
    const parts = [];
    legs(parts, 1.2, 1.6, -1.9, 1.1, 1.1, 1.8, 'accent');
    const body = blk(0, -0.2, 1.8, 3.6, 5.2, 2.4, 'body');
    on(body, 'front', 0, 2.0, 2.0, 1.6, 'belly');
    const head = blk(0, 2.8, 3.2, 4.2, 3.2, 3.0, 'body');
    snoutOn(head, 1.8, 1.2, 1.0);
    face(head, { snout: 1 });
    for (const s of [-1, 1]) {
      const ear = top(head, s * 1.35, 2.6, 1.2, 0.6, 1.6, 'body');
      top(ear, ear.a, ear.b, 0.8, 0.6, 0.5, 'accent');
    }
    parts.push(body, head,
      blk(0, -4.2, 2.6, 1.8, 3.2, 1.8, 'body', { wag: 1 }),
      blk(0, -6.3, 2.7, 1.5, 1.0, 1.6, 'belly', { wag: 1 }));
    return { parts, body, head };
  },
  dragon(L) {
    const parts = [];
    legs(parts, 1.5, 1.6, -1.9, 1.3, 1.3, 1.4);
    const body = blk(0, -0.3, 1.4, 4.2, 5.2, 3.0, 'body');
    on(body, 'front', 0, 1.6, 2.6, 2.2, 'belly');
    for (const b of [-2, -0.6, 0.8]) top(body, 0, b, 0.8, 0.8, 0.7, 'accent');
    const head = blk(0, 3.0, 3.4, 3.8, 3.6, 3.2, 'body');
    const snout = on(head, 'front', 0, head.z + 0.3, 2.6, 1.4, 'body', 1.0);
    for (const s of [-1, 1]) on(snout, 'front', s * 0.6, snout.z + 0.8, 0.35, 0.35, 'ink', 0.1);
    face(head, { snout: 1 });
    for (const s of [-1, 1]) top(head, s * 1.2, 2.0, 0.6, 0.6, 1.2, 'belly');
    for (const s of [-1, 1]) parts.push(blk(s * 2.5, -0.6, 3.4, 0.4, 3.0, 2.4, 'accent', { flap: 1 }));
    parts.push(body, head,
      blk(0, -3.7, 1.8, 1.6, 2.6, 1.4, 'body', { wag: 1 }),
      blk(0, -5.5, 1.9, 1.1, 1.2, 1.1, 'accent', { wag: 1.5 }));
    return { parts, body, head };
  },
  dinosaur(L) {
    const parts = [];
    for (const s of [-1, 1]) parts.push(blk(s * 1.3, -0.6, 0, 1.6, 1.8, 2.0, 'body', { leg: s > 0 ? 0 : 1 }));
    const body = blk(0, -0.4, 2.0, 4.2, 5.0, 3.6, 'body');
    on(body, 'front', 0, 2.3, 2.6, 2.6, 'belly');
    for (const s of [-1, 1]) on(body, 'front', s * 1.3, 4.0, 0.6, 0.6, 'body', 1.0);
    for (const b of [-1.8, -0.2, 1.4]) top(body, 0, b, 0.6, 1.0, 1.0, 'accent');
    const head = blk(0, 2.6, 5.0, 4.0, 4.4, 3.2, 'body');
    on(head, 'front', 0, 5.3, 3.0, 0.8, 'belly', 0.2);
    face(head, { snout: 1 });
    parts.push(body, head,
      blk(0, -4.6, 2.4, 2.0, 3.6, 2.0, 'body', { wag: 0.6 }),
      blk(0, -7.2, 2.4, 1.2, 1.8, 1.2, 'accent', { wag: 1.2 }));
    return { parts, body, head };
  },
  fish(L) {
    const body = blk(0, 0, 0.6, 2.4, 4.4, 3.2, 'body');
    wrap(body, 1.2, 1.2, 'belly', 0.05, 1.0, 0.6);
    top(body, 0, -0.4, 0.4, 1.8, 0.9, 'accent');
    for (const side of ['left', 'right']) on(body, side, 0.4, 1.4, 1.0, 0.7, 'accent', 0.3);
    face(body, { eye: 0.9 });
    return { parts: [body, blk(0, -2.9, 0.8, 0.4, 1.6, 2.8, 'accent', { wag: 2 })], body, head: body };
  },
  bird(L) {
    const parts = [];
    for (const s of [-1, 1]) parts.push(blk(s * 0.8, 0, 0, 0.4, 0.4, 1.2, 'accent', { leg: s > 0 ? 0 : 1 }));
    const body = blk(0, 0, 1.2, 3.6, 3.8, 3.2, 'body');
    on(body, 'front', 0, 1.5, 2.4, 2.0, 'belly');
    const head = blk(0, 0.6, 4.4, 3.2, 3.0, 2.6, 'body');
    on(head, 'front', 0, head.z + 0.6, 1.0, 0.6, 'accent', 1.0);
    face(head, { snout: 1 });
    top(head, 0, 0.4, 0.4, 0.8, 0.9, 'accent');
    for (const s of [-1, 1]) parts.push(blk(s * 2.0, -0.4, 2.2, 0.4, 2.4, 1.8, 'body', { flap: 1 }));
    parts.push(body, head, blk(0, -2.4, 3.0, 1.6, 1.2, 0.8, 'body', { wag: 0.5 }));
    return { parts, body, head };
  },
  turtle(L) {
    const parts = [];
    legs(parts, 1.6, 1.4, -1.6, 1.2, 1.2, 0.9, 'belly');
    const body = blk(0, -0.2, 0.7, 4.6, 4.6, 2.0, 'body');
    wrap(body, 0.7, 0.4, 'belly', 0.1);
    const cap = top(body, 0, -0.2, 3.2, 3.2, 0.7, 'body');
    for (const [a, b] of [[-0.8, -1], [0.8, -1], [-0.8, 0.6], [0.8, 0.6]]) top(cap, a, b, 1.0, 1.0, 0.12, 'accent');
    const head = blk(0, 3.0, 1.2, 2.4, 2.2, 2.0, 'belly');
    face(head, { eye: 0.9 });
    parts.push(body, head, blk(0, -2.9, 0.9, 0.8, 1.0, 0.6, 'belly', { wag: 1 }));
    return { parts, body, head };
  },
  axolotl(L) {
    const parts = [];
    legs(parts, 1.4, 1.4, -1.6, 0.9, 0.9, 0.8);
    const body = blk(0, -0.4, 0.8, 3.2, 5.0, 1.8, 'body');
    const head = blk(0, 3.0, 0.8, 4.6, 3.0, 2.4, 'body');
    face(head);
    for (const side of ['left', 'right']) {
      for (const [b, dz] of [[2.2, 0.6], [3.0, 1.3], [3.8, 0.6]]) on(head, side, b, head.z + dz + 0.6, 0.4, 0.4, 'accent', 0.9);
    }
    const tail = blk(0, -4.6, 1.0, 0.6, 3.4, 1.8, 'body', { wag: 1.5 });
    top(tail, 0, -4.8, 0.6, 2.6, 0.4, 'accent');
    parts.push(body, head, tail);
    return { parts, body, head };
  },
};

function markings(L, body) {
  const t = body.z + body.h;
  if (L.mark === 'spots') {
    top(body, -body.w * 0.2, body.b - body.d * 0.2, 0.9, 0.9, 0.1, 'accent');
    top(body, body.w * 0.22, body.b + body.d * 0.12, 0.7, 0.7, 0.1, 'accent');
  } else if (L.mark === 'stripes') {
    for (const f of [-0.28, -0.05, 0.18]) wrap(body, body.z + body.h * 0.35, body.h * 0.65 + 0.05, 'accent', 0.05, 0.5, body.b + body.d * f);
  } else if (L.mark === 'patch') {
    top(body, body.w * 0.15, body.b - body.d * 0.15, body.w * 0.5, body.d * 0.4, 0.1, 'accent');
  }
  return t;
}

function accessory(L, H) {
  const t = H.z + H.h;
  switch (L.accessory) {
    case 'bow': {
      const a = H.w * 0.24;
      top(H, a, H.b, 0.6, 0.6, 0.6, 'pink');
      top(H, a - 0.7, H.b, 0.8, 0.6, 0.8, 'pink');
      top(H, a + 0.7, H.b, 0.8, 0.6, 0.8, 'pink');
      break;
    }
    case 'party-hat': {
      const a1 = top(H, -H.w * 0.12, H.b, 2.0, 2.0, 0.8, 'accent');
      const a2 = top(a1, a1.a, a1.b, 1.4, 1.4, 0.8, 'belly');
      const a3 = top(a2, a2.a, a2.b, 0.8, 0.8, 0.8, 'accent');
      top(a3, a3.a, a3.b, 0.5, 0.5, 0.5, 'white');
      break;
    }
    case 'scarf': {
      wrap(H, H.z, 0.7, 'accent', 0.2);
      on(H, 'front', H.w * 0.25, H.z - 1.1, 0.7, 1.2, 'accent', 0.4);
      break;
    }
    case 'crown': {
      const ring = top(H, 0, H.b, H.w * 0.6, H.d * 0.6, 0.5, 'gold');
      for (const [sa, sb] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) top(ring, sa * (ring.w / 2 - 0.2), ring.b + sb * (ring.d / 2 - 0.2), 0.4, 0.4, 0.5, 'gold');
      break;
    }
    case 'flower': {
      const a = -H.w * 0.26;
      const b = H.b + H.d * 0.1;
      for (const [da, db] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) top(H, a + da, b + db, 0.5, 0.5, 0.35, 'petal');
      top(H, a, b, 0.5, 0.5, 0.45, 'seed');
      break;
    }
    case 'glasses': {
      on(H, 'front', 0, H.z + H.h * 0.62, 1.0, 0.2, 'ink', 0.3);
      for (const s of [-1, 1]) {
        const frame = on(H, 'front', s * H.w * 0.24, H.z + H.h * 0.42, 1.3, 1.2, 'ink', 0.3);
        const lens = on(frame, 'front', frame.a, frame.z + 0.2, 0.9, 0.8, 'lens', 0.06);
        on(lens, 'front', lens.a, lens.z + 0.2, 0.4, 0.4, 'ink', 0.06);
      }
      break;
    }
    case 'sprout': {
      const stem = top(H, 0, H.b, 0.3, 0.3, 1.0, 'green');
      top(stem, -0.45, H.b, 0.7, 0.35, 0.35, 'green');
      top(stem, 0.45, H.b, 0.7, 0.35, 0.35, 'green');
      break;
    }
    case 'bandana':
      wrap(H, t - 0.8, 0.8, 'accent', 0.12);
      break;
    case 'headphones': {
      wrap(H, t, 0.35, 'band', 0.25, 0.6);
      for (const side of ['left', 'right']) {
        const cup = on(H, side, H.b, H.z + H.h * 0.3, 1.4, 1.4, 'accent', 0.45);
        on(H, side, H.b, cup.z + cup.h, 0.5, t + 0.35 - (cup.z + cup.h), 'band', 0.3);
      }
      break;
    }
    default:
  }
}

const models = new Map();
function modelOf(species, variant) {
  const key = `${species}:${variant}`;
  if (!models.has(key)) {
    const L = lookOf(species, variant);
    const m = BUILD[species](L);
    markings(L, m.body);
    accessory(L, m.head);
    let height = 0;
    const reach = (p) => {
      height = Math.max(height, p.z + p.h);
      for (const k of p.kids ?? []) reach(k);
    };
    m.parts.forEach(reach);
    models.set(key, { ...m, L, height, length: Math.max(...m.parts.map((p) => p.b + p.d / 2)) - Math.min(...m.parts.map((p) => p.b - p.d / 2)) });
  }
  return models.get(key);
}

// ---- drawing ------------------------------------------------------------------------

// Colours follow the scene: shade() from the colourway's light and shadow,
// and at night each colour sinks toward the night air like the stone does.
let THEME = THEMES[DEFAULT_THEME];
let TONE = (c) => c;
const mats = new Map();

export function setCreatureLight(theme, phase) {
  THEME = theme;
  const n = phase === 'night' ? theme.night : null;
  TONE = n ? (c) => mix(c, n.tint, n.amount * 0.8) : (c) => c;
  mats.clear();
}

function material(L, c) {
  const hex = L[c] ?? FIXED[c] ?? c;
  if (!mats.has(hex)) mats.set(hex, shade(TONE(hex), THEME));
  return mats.get(hex);
}

// The four ways a creature can face, as its forward step in world axes.
export const FACINGS = [[0, 1], [-1, 0], [0, -1], [1, 0]];

export function facingOf(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 3 : 1;
  return dy > 0 ? 0 : 2;
}

// The facing whose front is most turned toward the viewer.
export function facingViewer() {
  let best = 0;
  let gain = -Infinity;
  FACINGS.forEach(([fx, fy], i) => {
    const g = viewDepth(fx, fy) - viewDepth(0, 0) - i * 1e-6;
    if (g > gain) [best, gain] = [i, g];
  });
  return best;
}

// Place a creature. `pose` = { x, y, z, scale, facing, step } where step is
// the walk cycle in radians (legs lift in turn, wings flap, tails wag), or
// null when standing still. Returns SVG, the height in world units, and
// the screen points it covers (for thumbnails).
export function drawCreature(species, variant, pose) {
  const { x, y, z = 0, scale = 1, facing = 0, step = null } = pose;
  const m = modelOf(species, variant);
  const k = scale * 0.13;
  const [fx, fy] = FACINGS[facing];
  const [rx, ry] = [fy, -fx]; // the creature's right hand
  const hop = step === null ? 0 : Math.abs(Math.sin(step)) * 0.9;
  const pts = [];

  const world = (a, b) => [x + (a * rx + b * fx) * k, y + (a * ry + b * fy) * k];
  const normal = { front: [fx, fy], back: [-fx, -fy], right: [rx, ry], left: [-rx, -ry] };

  function place(p, da, dz) {
    const [x0, y0] = world(p.a + da - p.w / 2, p.b - p.d / 2);
    const [x1, y1] = world(p.a + da + p.w / 2, p.b + p.d / 2);
    const wx = Math.min(x0, x1);
    const wy = Math.min(y0, y1);
    const wz = z + (p.z + dz) * k;
    return [wx, wy, wz, Math.abs(x1 - x0), Math.abs(y1 - y0), p.h * k];
  }

  function emit(p, da, dz) {
    const b = place(p, da, dz);
    let s = box(...b, material(m.L, p.c));
    pts.push(P(b[0], b[1], b[2]), P(b[0] + b[3], b[1] + b[4], b[2]), P(b[0] + b[3], b[1], b[2] + b[5]), P(b[0], b[1] + b[4], b[2] + b[5]));
    for (const kid of p.kids ?? []) {
      if (normal[kid.face] && !faceVisible(...normal[kid.face])) continue;
      s += emit(kid, da, dz);
    }
    return s;
  }

  const moving = step !== null;
  const offset = (p) => {
    let dz = p.leg === undefined ? hop : 0;
    let da = 0;
    if (moving && p.leg !== undefined) dz = Math.max(0, Math.sin(step + p.leg * Math.PI)) * 0.8;
    if (p.flap) dz += Math.sin(step ?? 0) * (moving ? 0.6 : 0);
    if (p.wag) da = Math.sin((step ?? 0) * 1.5) * p.wag * (moving ? 0.5 : 0);
    return [da, dz];
  };

  const order = m.parts
    .map((p) => {
      const [cx, cy] = world(p.a, p.b);
      return { p, key: (p.leg !== undefined ? -100 : 0) + viewDepth(cx, cy) };
    })
    .sort((u, v) => u.key - v.key);

  // A soft shadow on the ground under the body.
  const [s0x, s0y] = world(-m.body.w * 0.6, m.body.b - m.length * 0.45);
  const [s1x, s1y] = world(m.body.w * 0.6, m.body.b + m.length * 0.45);
  const [gx, gy] = [Math.min(s0x, s1x), Math.min(s0y, s1y)];
  const [gw, gd] = [Math.abs(s1x - s0x), Math.abs(s1y - s0y)];
  const sh = `<polygon class="critter-shadow" fill="#2a2350" opacity="0.14" points="${[[gx, gy], [gx + gw, gy], [gx + gw, gy + gd], [gx, gy + gd]]
    .map(([a, b]) => P(a, b, z > 0.05 ? 0 : z).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`;
  const svg = sh + order.map(({ p }) => emit(p, ...offset(p))).join('');
  return { svg, height: z + (m.height + hop) * k, pts };
}

// A small picture of a look, for the chooser: facing the viewer.
export function creatureThumb(species, variant) {
  const { svg, pts } = drawCreature(species, variant, { x: 0, y: 0, facing: facingViewer() });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const side = Math.max(w, h) + 6;
  return `<svg class="thumb" viewBox="${(x0 + w / 2 - side / 2).toFixed(1)} ${(y0 + h / 2 - side / 2).toFixed(1)} ${side.toFixed(1)} ${side.toFixed(1)}" aria-hidden="true">${svg}</svg>`;
}

// The same agent always gets the same creature until someone picks another.
export function defaultCreature(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { species: SPECIES[h % SPECIES.length].id, variant: (h >>> 8) % VARIANTS };
}
