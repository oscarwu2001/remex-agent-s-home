// The creatures of the Meadow: each agent can be shown as a cute animal.
// Ten species, ten looks each (colours, markings and one small accessory).
// Every drawing stands on (0, 0) and faces the viewer, about 100 units tall.

const f1 = (v) => v.toFixed(1);

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

// ---- shared parts ---------------------------------------------------------------

const ellipse = (cx, cy, rx, ry, fill, extra = '') => `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="${fill}" ${extra}/>`;
const circle = (cx, cy, r, fill, extra = '') => `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="${fill}" ${extra}/>`;
const path = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`;
const INK = '#3d3450';

function face(cx, cy, s = 1, { mouth = 'smile' } = {}) {
  const dx = 9 * s;
  let out = circle(cx - dx, cy, 3.6 * s, INK) + circle(cx + dx, cy, 3.6 * s, INK) +
    circle(cx - dx + 1.2 * s, cy - 1.3 * s, 1.2 * s, '#fff') + circle(cx + dx + 1.2 * s, cy - 1.3 * s, 1.2 * s, '#fff') +
    ellipse(cx - dx - 4 * s, cy + 6 * s, 4 * s, 2.4 * s, '#f59ab0', 'opacity="0.55"') + ellipse(cx + dx + 4 * s, cy + 6 * s, 4 * s, 2.4 * s, '#f59ab0', 'opacity="0.55"');
  if (mouth === 'smile') out += path(`M${f1(cx - 3 * s)},${f1(cy + 5 * s)} q${f1(3 * s)},${f1(3 * s)} ${f1(6 * s)},0`, 'none', `stroke="${INK}" stroke-width="${f1(1.6 * s)}" stroke-linecap="round"`);
  if (mouth === 'cat') out += path(`M${f1(cx - 4 * s)},${f1(cy + 5 * s)} q${f1(2 * s)},${f1(2.5 * s)} ${f1(4 * s)},0 q${f1(2 * s)},${f1(2.5 * s)} ${f1(4 * s)},0`, 'none', `stroke="${INK}" stroke-width="${f1(1.5 * s)}" stroke-linecap="round"`);
  if (mouth === 'wide') out += path(`M${f1(cx - 8 * s)},${f1(cy + 5 * s)} q${f1(8 * s)},${f1(6 * s)} ${f1(16 * s)},0`, 'none', `stroke="${INK}" stroke-width="${f1(1.6 * s)}" stroke-linecap="round"`);
  return out;
}

// Markings on a round body at (cx, cy) with radii rx, ry.
function marks(kind, cx, cy, rx, ry, color, id) {
  const clip = `<clipPath id="${id}"><ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}"/></clipPath>`;
  let inner = '';
  if (kind === 'spots') for (const [dx, dy, r] of [[-0.5, -0.3, 0.18], [0.35, -0.45, 0.14], [0.55, 0.2, 0.16], [-0.2, 0.4, 0.12]]) inner += circle(cx + dx * rx, cy + dy * ry, r * rx, color, 'opacity="0.7"');
  if (kind === 'stripes') for (const dx of [-0.45, 0, 0.45]) inner += path(`M${f1(cx + dx * rx)},${f1(cy - ry)} q${f1(-0.12 * rx)},${f1(0.6 * ry)} 0,${f1(0.9 * ry)}`, 'none', `stroke="${color}" stroke-width="${f1(rx * 0.1)}" stroke-linecap="round" opacity="0.45"`);
  if (kind === 'patch') inner += ellipse(cx + 0.45 * rx, cy - 0.35 * ry, 0.45 * rx, 0.35 * ry, color, 'opacity="0.65"');
  return inner ? `${clip}<g clip-path="url(#${id})">${inner}</g>` : '';
}

// An accessory on a head at (cx, cy) of radius r.
function accessory(kind, cx, cy, r, accent) {
  switch (kind) {
    case 'bow':
      return path(`M${f1(cx + r * 0.3)},${f1(cy - r * 0.95)} l${f1(-r * 0.35)},${f1(-r * 0.22)} v${f1(r * 0.44)} z M${f1(cx + r * 0.3)},${f1(cy - r * 0.95)} l${f1(r * 0.35)},${f1(-r * 0.22)} v${f1(r * 0.44)} z`, '#f06a8f') + circle(cx + r * 0.3, cy - r * 0.95, r * 0.09, '#d24d74');
    case 'party-hat':
      return path(`M${f1(cx - r * 0.3)},${f1(cy - r * 0.8)} L${f1(cx + r * 0.05)},${f1(cy - r * 1.75)} L${f1(cx + r * 0.4)},${f1(cy - r * 0.8)} z`, accent) + circle(cx + r * 0.05, cy - r * 1.78, r * 0.12, '#fff5b8') +
        path(`M${f1(cx - r * 0.2)},${f1(cy - r * 1.05)} L${f1(cx + r * 0.3)},${f1(cy - r * 1.05)}`, 'none', 'stroke="#fff" stroke-width="2" opacity="0.8"');
    case 'scarf':
      return path(`M${f1(cx - r * 0.75)},${f1(cy + r * 0.72)} q${f1(r * 0.75)},${f1(r * 0.35)} ${f1(r * 1.5)},0 l0,${f1(r * 0.22)} q${f1(-r * 0.75)},${f1(r * 0.35)} ${f1(-r * 1.5)},0 z`, '#f0786e') + path(`M${f1(cx + r * 0.4)},${f1(cy + r * 0.95)} l${f1(r * 0.12)},${f1(r * 0.55)} l${f1(r * 0.25)},${f1(-r * 0.08)} l${f1(-r * 0.1)},${f1(-r * 0.5)} z`, '#e0594f');
    case 'crown':
      return path(`M${f1(cx - r * 0.4)},${f1(cy - r * 0.85)} l0,${f1(-r * 0.45)} l${f1(r * 0.2)},${f1(r * 0.22)} l${f1(r * 0.2)},${f1(-r * 0.3)} l${f1(r * 0.2)},${f1(r * 0.3)} l${f1(r * 0.2)},${f1(-r * 0.22)} l0,${f1(r * 0.45)} z`, '#f6cf4f') + circle(cx, cy - r * 1.02, r * 0.07, '#e36a8f');
    case 'flower': {
      let s = '';
      for (let k = 0; k < 5; k++) {
        const a = (k * 2 * Math.PI) / 5;
        s += circle(cx - r * 0.55 + Math.cos(a) * r * 0.16, cy - r * 0.75 + Math.sin(a) * r * 0.16, r * 0.13, '#fbd3e0');
      }
      return s + circle(cx - r * 0.55, cy - r * 0.75, r * 0.1, '#f6cf4f');
    }
    case 'glasses':
      return circle(cx - r * 0.36, cy - r * 0.02, r * 0.26, 'none', `stroke="${INK}" stroke-width="2"`) + circle(cx + r * 0.36, cy - r * 0.02, r * 0.26, 'none', `stroke="${INK}" stroke-width="2"`) +
        path(`M${f1(cx - r * 0.1)},${f1(cy - r * 0.02)} h${f1(r * 0.2)}`, 'none', `stroke="${INK}" stroke-width="2"`);
    case 'sprout':
      return path(`M${f1(cx)},${f1(cy - r * 0.95)} q${f1(r * 0.05)},${f1(-r * 0.3)} 0,${f1(-r * 0.45)}`, 'none', 'stroke="#5fa35a" stroke-width="2.5" stroke-linecap="round"') +
        ellipse(cx - r * 0.15, cy - r * 1.4, r * 0.18, r * 0.09, '#7fcf7a', `transform="rotate(-25 ${f1(cx - r * 0.15)} ${f1(cy - r * 1.4)})"`) +
        ellipse(cx + r * 0.15, cy - r * 1.45, r * 0.18, r * 0.09, '#7fcf7a', `transform="rotate(25 ${f1(cx + r * 0.15)} ${f1(cy - r * 1.45)})"`);
    case 'bandana':
      return path(`M${f1(cx - r * 0.85)},${f1(cy - r * 0.45)} q${f1(r * 0.85)},${f1(-r * 0.75)} ${f1(r * 1.7)},0 l0,${f1(r * 0.12)} q${f1(-r * 0.85)},${f1(-r * 0.5)} ${f1(-r * 1.7)},0 z`, accent) + circle(cx + r * 0.9, cy - r * 0.36, r * 0.1, accent);
    case 'headphones':
      return path(`M${f1(cx - r * 0.85)},${f1(cy - r * 0.1)} q0,${f1(-r * 1.15)} ${f1(r * 0.85)},${f1(-r * 1.15)} q${f1(r * 0.85)},0 ${f1(r * 0.85)},${f1(r * 1.15)}`, 'none', `stroke="${INK}" stroke-width="3"`) +
        ellipse(cx - r * 0.88, cy, r * 0.16, r * 0.24, accent) + ellipse(cx + r * 0.88, cy, r * 0.16, r * 0.24, accent);
    default:
      return '';
  }
}

// ---- the species ---------------------------------------------------------------------

const DRAW = {
  cat: (L, id) =>
    path('M24,-18 q14,-6 12,-26', 'none', `stroke="${L.body}" stroke-width="7" stroke-linecap="round"`) +
    ellipse(0, -18, 22, 17, L.body) + marks(L.mark, 0, -18, 22, 17, L.accent, `${id}b`) + ellipse(0, -14, 12, 11, L.belly) +
    ellipse(-10, -2, 6, 3.5, L.body) + ellipse(10, -2, 6, 3.5, L.body) +
    path('M-22,-58 l4,-20 l12,12 z', L.body) + path('M22,-58 l-4,-20 l-12,12 z', L.body) + path('M-19,-62 l2,-10 l6,6 z', '#f7b8c8') + path('M19,-62 l-2,-10 l-6,6 z', '#f7b8c8') +
    circle(0, -52, 24, L.body) + marks(L.mark, 0, -52, 24, 24, L.accent, `${id}h`) + ellipse(0, -44, 11, 8, L.belly) +
    face(0, -54, 1, { mouth: 'cat' }) + path('M-26,-47 l-10,-2 M-26,-44 l-10,2 M26,-47 l10,-2 M26,-44 l10,2', 'none', `stroke="${INK}" stroke-width="1" opacity="0.5"`) +
    accessory(L.accessory, 0, -52, 24, L.accent),
  dog: (L, id) =>
    path('M22,-22 q12,-4 14,-16', 'none', `stroke="${L.body}" stroke-width="6" stroke-linecap="round"`) +
    ellipse(0, -18, 21, 17, L.body) + marks(L.mark, 0, -18, 21, 17, L.accent, `${id}b`) + ellipse(0, -14, 11, 11, L.belly) +
    ellipse(-10, -2, 6, 3.5, L.body) + ellipse(10, -2, 6, 3.5, L.body) +
    circle(0, -52, 24, L.body) + marks(L.mark, 0, -52, 24, 24, L.accent, `${id}h`) +
    ellipse(-24, -48, 8, 15, L.accent, 'transform="rotate(18 -24 -48)"') + ellipse(24, -48, 8, 15, L.accent, 'transform="rotate(-18 24 -48)"') +
    ellipse(0, -42, 12, 9, L.belly) + ellipse(0, -46, 4, 3, INK) + face(0, -55, 1, { mouth: 'none' }) +
    path('M-4,-40 q4,4 8,0', 'none', `stroke="${INK}" stroke-width="1.6" stroke-linecap="round"`) + ellipse(2, -36, 3, 4, '#f37d8f') +
    accessory(L.accessory, 0, -52, 24, L.accent),
  bunny: (L, id) =>
    circle(20, -14, 7, '#ffffff') + ellipse(0, -18, 20, 17, L.body) + marks(L.mark, 0, -18, 20, 17, L.accent, `${id}b`) + ellipse(0, -14, 11, 11, L.belly) +
    ellipse(-9, -2, 6, 3.5, L.body) + ellipse(9, -2, 6, 3.5, L.body) +
    ellipse(-10, -84, 7, 22, L.body, 'transform="rotate(-8 -10 -84)"') + ellipse(10, -84, 7, 22, L.body, 'transform="rotate(8 10 -84)"') +
    ellipse(-10, -84, 3.5, 16, '#f7b8c8', 'transform="rotate(-8 -10 -84)"') + ellipse(10, -84, 3.5, 16, '#f7b8c8', 'transform="rotate(8 10 -84)"') +
    circle(0, -50, 22, L.body) + marks(L.mark, 0, -50, 22, 22, L.accent, `${id}h`) + face(0, -50, 1) + ellipse(0, -45, 2.5, 1.8, '#f37d8f') +
    accessory(L.accessory, 0, -50, 22, L.accent),
  fox: (L, id) =>
    path('M16,-14 q30,-6 26,-34 q-6,14 -24,18 z', L.body) + path('M36,-44 q6,-6 6,-10 q-6,4 -12,6 z', '#ffffff') +
    ellipse(0, -18, 19, 16, L.body) + marks(L.mark, 0, -18, 19, 16, L.accent, `${id}b`) + ellipse(0, -14, 10, 11, L.belly) +
    ellipse(-9, -2, 5.5, 3.5, L.accent) + ellipse(9, -2, 5.5, 3.5, L.accent) +
    path('M-22,-60 l2,-24 l14,14 z', L.body) + path('M22,-60 l-2,-24 l-14,14 z', L.body) + path('M-19,-64 l1,-12 l7,7 z', L.accent) + path('M19,-64 l-1,-12 l-7,7 z', L.accent) +
    circle(0, -52, 23, L.body) + path('M-23,-50 q10,18 23,16 q13,2 23,-16 q-10,10 -23,8 q-13,2 -23,-8 z', L.belly) +
    face(0, -54, 1, { mouth: 'none' }) + ellipse(0, -44, 3.5, 2.5, INK) + accessory(L.accessory, 0, -52, 23, L.accent),
  dragon: (L, id) =>
    path('M18,-12 q26,4 30,-16 l6,-4 l-4,8 l6,2 l-8,2 q-8,16 -30,14 z', L.body) +
    path('M-16,-34 q-26,-24 -34,-10 q10,0 12,8 q6,-8 12,-2 q4,-6 10,4 z', L.accent) + path('M16,-34 q26,-24 34,-10 q-10,0 -12,8 q-6,-8 -12,-2 q-4,-6 -10,4 z', L.accent) +
    ellipse(0, -20, 21, 19, L.body) + marks(L.mark, 0, -20, 21, 19, L.accent, `${id}b`) + ellipse(0, -15, 12, 13, L.belly) +
    path('M-6,-14 h12 M-7,-8 h14 M-6,-20 h12', 'none', `stroke="${L.accent}" stroke-width="1.2" opacity="0.5"`) +
    ellipse(-10, -2, 6, 3.5, L.body) + ellipse(10, -2, 6, 3.5, L.body) +
    path('M-13,-72 l-6,-12 l12,6 z', '#fff4d6') + path('M13,-72 l6,-12 l-12,6 z', '#fff4d6') +
    circle(0, -54, 23, L.body) + marks(L.mark, 0, -54, 23, 23, L.accent, `${id}h`) + ellipse(0, -44, 13, 8, L.belly) +
    circle(-4, -46, 1.4, INK) + circle(4, -46, 1.4, INK) + face(0, -56, 1, { mouth: 'none' }) +
    path('M-5,-40 q5,3 10,0', 'none', `stroke="${INK}" stroke-width="1.5" stroke-linecap="round"`) + accessory(L.accessory, 0, -54, 23, L.accent),
  dinosaur: (L, id) =>
    path('M16,-14 q28,4 36,-6 q-8,16 -34,16 z', L.body) +
    path('M-4,-80 l6,-10 l6,10 z M8,-76 l7,-9 l4,11 z M-14,-76 l4,-10 l6,9 z', L.accent) +
    ellipse(0, -20, 20, 19, L.body) + marks(L.mark, 0, -20, 20, 19, L.accent, `${id}b`) + ellipse(0, -15, 12, 13, L.belly) +
    ellipse(-10, -2, 7, 4, L.body) + ellipse(10, -2, 7, 4, L.body) + ellipse(-12, -26, 4, 7, L.body, 'transform="rotate(30 -12 -26)"') + ellipse(12, -26, 4, 7, L.body, 'transform="rotate(-30 12 -26)"') +
    ellipse(0, -56, 25, 22, L.body) + marks(L.mark, 0, -56, 25, 22, L.accent, `${id}h`) + ellipse(0, -47, 15, 9, L.belly) +
    face(0, -60, 1, { mouth: 'wide' }) + accessory(L.accessory, 0, -58, 23, L.accent),
  fish: (L, id) =>
    path('M22,-40 l20,-16 q-4,16 0,32 z', L.accent) + path('M-4,-66 q10,-14 20,-4 z', L.accent) + path('M-2,-18 q8,12 16,2 z', L.accent) +
    ellipse(0, -42, 28, 22, L.body) + marks(L.mark, 0, -42, 28, 22, L.accent, `${id}b`) + ellipse(-4, -34, 18, 10, L.belly) +
    path('M-10,-58 q-6,16 0,32', 'none', `stroke="${L.accent}" stroke-width="2" opacity="0.5"`) +
    circle(-14, -46, 5, '#fff') + circle(-15, -46, 3.2, INK) + circle(-14, -47.5, 1.1, '#fff') +
    ellipse(-12, -36, 3.5, 2, '#f59ab0', 'opacity="0.55"') + path('M-26,-38 q3,3 6,0', 'none', `stroke="${INK}" stroke-width="1.5" stroke-linecap="round"`) +
    circle(-34, -60, 3, '#e8f7ff', 'opacity="0.8"') + circle(-38, -70, 2, '#e8f7ff', 'opacity="0.7"') + accessory(L.accessory, 0, -48, 20, L.accent),
  bird: (L, id) =>
    ellipse(-6, -2, 3, 4, L.accent) + ellipse(6, -2, 3, 4, L.accent) +
    path('M-4,-86 q4,-10 10,-6 q-6,2 -4,8 z', L.body) +
    circle(0, -38, 32, L.body) + marks(L.mark, 0, -38, 32, 32, L.accent, `${id}b`) + ellipse(0, -24, 20, 16, L.belly) +
    ellipse(-28, -34, 8, 14, L.body, 'transform="rotate(20 -28 -34)"') + ellipse(28, -34, 8, 14, L.body, 'transform="rotate(-20 28 -34)"') +
    face(0, -46, 1, { mouth: 'none' }) + path('M-5,-40 l5,7 l5,-7 z', L.accent) + accessory(L.accessory, 0, -48, 26, L.accent),
  turtle: (L, id) => {
    let s = ellipse(-22, -6, 7, 5, L.body) + ellipse(22, -6, 7, 5, L.body) + ellipse(-16, -2, 6, 4, L.body) + ellipse(16, -2, 6, 4, L.body) +
      circle(0, -48, 17, L.body) + face(0, -50, 0.8) + accessory(L.accessory, 0, -50, 17, L.accent) +
      path('M-30,-14 q0,-34 30,-34 q30,0 30,34 z', L.accent) + path('M-26,-14 q0,-28 26,-28 q26,0 26,28 z', L.belly);
    for (const [cx, cy] of [[0, -30], [-14, -22], [14, -22], [-6, -18], [8, -36]]) s += circle(cx, cy, 5.5, L.accent, 'opacity="0.55"');
    return s + marks(L.mark, 0, -26, 26, 14, L.body, `${id}b`);
  },
  axolotl: (L, id) => {
    let s = path('M16,-14 q22,2 26,-12 q-6,18 -26,20 z', L.body) + ellipse(0, -18, 20, 15, L.body) + marks(L.mark, 0, -18, 20, 15, L.accent, `${id}b`) + ellipse(0, -14, 11, 9, L.belly) +
      ellipse(-10, -2, 6, 3, L.body) + ellipse(10, -2, 6, 3, L.body);
    for (const [side, dy, rot] of [[-1, -8, -30], [-1, 0, -10], [-1, 8, 10], [1, -8, 30], [1, 0, 10], [1, 8, -10]]) {
      s += ellipse(side * 30, -52 + dy, 9, 4, L.accent, `transform="rotate(${rot} ${side * 30} ${-52 + dy})"`);
    }
    return s + ellipse(0, -50, 27, 20, L.body) + marks(L.mark, 0, -50, 27, 20, L.accent, `${id}h`) + face(0, -52, 1, { mouth: 'wide' }) + accessory(L.accessory, 0, -52, 22, L.accent);
  },
};

let uid = 0;
// One creature, `scale` times its usual size, standing on (0, 0).
export function drawCreature(species, variant, scale = 1) {
  const L = lookOf(species, variant);
  const id = `cr${++uid}`;
  return `<g transform="scale(${f1(scale * 10) / 10})">${ellipse(0, 0, 26, 6, '#000', 'opacity="0.1"')}${DRAW[species](L, id)}</g>`;
}

// A small picture of a look, for the chooser.
export function creatureThumb(species, variant) {
  return `<svg class="thumb" viewBox="-50 -100 100 106" aria-hidden="true">${drawCreature(species, variant, 1)}</svg>`;
}

// The same agent always gets the same creature until someone picks another.
export function defaultCreature(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { species: SPECIES[h % SPECIES.length].id, variant: (h >>> 8) % VARIANTS };
}
