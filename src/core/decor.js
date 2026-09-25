'use strict';

const { SCENERY } = require('./rooms');

// What people can choose when they make the hospital their own: a floor for
// each room, a decoration on each of a room's spots, and what grows in the
// two gardens. This module owns the catalogue and checks a saved choice; the
// renderer owns how each piece is drawn and where the spots are.

// Floors any room can have.
const FLOORS = [
  { id: 'checker', name: 'Checker tiles' },
  { id: 'tiles', name: 'Large tiles' },
  { id: 'mosaic', name: 'Mosaic' },
  { id: 'wood', name: 'Wooden boards' },
  { id: 'terrazzo', name: 'Terrazzo' },
  { id: 'vinyl', name: 'Plain vinyl' },
];
const DEFAULT_FLOOR = 'checker';

// Every room has this many decoration spots, clear of its furniture, its
// doorways and where people stand.
const SPOTS_PER_ROOM = 3;

// Decorations, and the rooms they make sense in. 'any' fits every room;
// 'department' fits every department the user adds.
const DECORATIONS = [
  { id: 'plant', name: 'Potted plant', rooms: 'any' },
  { id: 'tall-plant', name: 'Tall plant', rooms: 'any' },
  { id: 'flowers', name: 'Vase of flowers', rooms: 'any' },
  { id: 'water-cooler', name: 'Water cooler', rooms: ['nurses-station', 'research-office', 'general-ward', 'laboratory'] },
  { id: 'sanitiser', name: 'Hand sanitiser stand', rooms: 'any' },
  { id: 'visitor-chair', name: 'Visitor chair', rooms: ['nurses-station', 'general-ward', 'vision-clinic', 'research-office'] },
  { id: 'waiting-bench', name: 'Waiting bench', rooms: ['nurses-station', 'vision-clinic', 'radiology'] },
  { id: 'supply-trolley', name: 'Supply trolley', rooms: ['nurses-station', 'general-ward', 'operating-room', 'department'] },
  { id: 'crash-cart', name: 'Crash cart', rooms: ['operating-room', 'general-ward', 'nurses-station', 'department'] },
  { id: 'instrument-tray', name: 'Instrument tray', rooms: ['operating-room', 'department'] },
  { id: 'scrub-sink', name: 'Scrub sink', rooms: ['operating-room', 'department'] },
  { id: 'sharps-bin', name: 'Sharps bin', rooms: ['operating-room', 'general-ward', 'laboratory', 'department'] },
  { id: 'specimen-fridge', name: 'Specimen fridge', rooms: ['laboratory'] },
  { id: 'tube-rack', name: 'Test-tube rack', rooms: ['laboratory'] },
  { id: 'eyewash', name: 'Eyewash station', rooms: ['laboratory'] },
  { id: 'apron-rack', name: 'Lead apron rack', rooms: ['radiology', 'department'] },
  { id: 'lightbox', name: 'X-ray lightbox', rooms: ['radiology', 'operating-room', 'department'] },
  { id: 'eye-model', name: 'Eye model', rooms: ['vision-clinic'] },
  { id: 'glasses-stand', name: 'Glasses display', rooms: ['vision-clinic'] },
  { id: 'bookcase', name: 'Bookcase', rooms: ['research-office', 'nurses-station'] },
  { id: 'globe', name: 'Globe', rooms: ['research-office'] },
  { id: 'armchair', name: 'Reading armchair', rooms: ['research-office', 'general-ward'] },
  { id: 'whiteboard', name: 'Whiteboard', rooms: ['research-office', 'laboratory', 'department'] },
  { id: 'wheelchair', name: 'Wheelchair', rooms: ['general-ward', 'nurses-station', 'radiology'] },
  { id: 'iv-pole', name: 'IV pole', rooms: ['general-ward', 'operating-room'] },
  { id: 'spine-model', name: 'Spine model', rooms: ['department', 'radiology'] },
];

// Gardens (the built-in two in rooms.js SCENERY, and any the user adds in
// the layout) are square plots of GARDEN_SIZE x GARDEN_SIZE tiles. A plant
// covers w x d tiles; a bench turned round covers d x w.
const GARDEN_SIZE = 4;
const PLANTS = [
  { id: 'tulips', name: 'Tulips', w: 1, d: 1 },
  { id: 'daisies', name: 'Daisies', w: 1, d: 1 },
  { id: 'lavender', name: 'Lavender', w: 1, d: 1 },
  { id: 'roses', name: 'Rose bush', w: 1, d: 1 },
  { id: 'shrub', name: 'Round shrub', w: 1, d: 1 },
  { id: 'small-tree', name: 'Small tree', w: 1, d: 1 },
  { id: 'lamp', name: 'Lamp post', w: 1, d: 1 },
  { id: 'path', name: 'Stepping stones', w: 1, d: 1 },
  { id: 'bench', name: 'Bench', w: 2, d: 1, turns: true },
  { id: 'big-tree', name: 'Big tree', w: 2, d: 2 },
  { id: 'blossom-tree', name: 'Blossom tree', w: 2, d: 2 },
  { id: 'cherry-tree', name: 'Cherry blossom', w: 2, d: 2 },
  { id: 'cherry-sapling', name: 'Young cherry', w: 1, d: 1 },
  { id: 'fountain', name: 'Fountain', w: 2, d: 2 },
];
const PLANT_BY_ID = Object.fromEntries(PLANTS.map((p) => [p.id, p]));

// What the gardens hold until someone plants their own.
const DEFAULT_GARDENS = {
  garden: [
    { kind: 'small-tree', at: [1, 1] },
    { kind: 'small-tree', at: [3, 2] },
    { kind: 'small-tree', at: [1, 3] },
    { kind: 'bench', at: [2, 3] },
  ],
  grove: [
    { kind: 'small-tree', at: [1, 1] },
    { kind: 'small-tree', at: [2, 2] },
  ],
};

// The tiles a planted item covers.
function footprint(item) {
  const p = PLANT_BY_ID[item.kind];
  const [w, d] = item.turn ? [p.d, p.w] : [p.w, p.d];
  const out = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) out.push([item.at[0] + i, item.at[1] + j]);
  return out;
}

// Decorations that make sense in a room. `room` is an entry of roomsWith().
function decorationsFor(room) {
  const tag = room.custom ? 'department' : room.id;
  return DECORATIONS.filter((d) => d.rooms === 'any' || d.rooms.includes(tag));
}

function checkGarden(list, where, problems) {
  if (!Array.isArray(list)) {
    problems.push(`${where} is not a list`);
    return undefined;
  }
  const taken = new Set();
  const out = [];
  list.forEach((item, n) => {
    const at = `${where}, item ${n + 1}`;
    if (!item || typeof item !== 'object') return problems.push(`${at} is not an object`);
    if (!PLANT_BY_ID[item.kind]) return problems.push(`${at} has unknown kind "${item.kind}"`);
    const cell = item.at;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      return problems.push(`${at} needs a tile like [col, row]`);
    }
    const clean = { kind: item.kind, at: [cell[0], cell[1]] };
    if (item.turn === true && PLANT_BY_ID[item.kind].turns) clean.turn = true;
    const tiles = footprint(clean);
    if (tiles.some(([i, j]) => i < 0 || j < 0 || i >= GARDEN_SIZE || j >= GARDEN_SIZE)) {
      return problems.push(`${at} does not fit inside the ${GARDEN_SIZE} x ${GARDEN_SIZE} plot`);
    }
    if (tiles.some((t) => taken.has(t.join(',')))) return problems.push(`${at} overlaps something planted before it`);
    for (const t of tiles) taken.add(t.join(','));
    return out.push(clean);
  });
  return out;
}

// Checks a saved decor.json against the rooms and gardens that exist now
// (roomsWith / gardensWith of the layout) and returns a
// clean copy plus a list of what was left out and why. Nothing is guessed:
// a bad entry is dropped and reported, never repaired into something else.
// Rooms the file names that no longer exist are dropped too, and reported.
function checkDecor(input, rooms, gardens = SCENERY) {
  const problems = [];
  const decor = { rooms: {}, gardens: {} };
  if (input === undefined || input === null) return { decor, problems };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { decor, problems: ['decor must be an object with "rooms" and "gardens"'] };
  }
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const roomsIn = input.rooms ?? {};
  if (typeof roomsIn !== 'object' || Array.isArray(roomsIn)) problems.push('"rooms" is not an object');
  else {
    for (const [id, entry] of Object.entries(roomsIn)) {
      const room = byId.get(id);
      if (!room) {
        problems.push(`room "${id}" does not exist`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`room "${id}" is not an object`);
        continue;
      }
      const clean = {};
      if (entry.floor !== undefined) {
        if (FLOORS.some((f) => f.id === entry.floor)) clean.floor = entry.floor;
        else problems.push(`room "${id}" has unknown floor "${entry.floor}"`);
      }
      if (entry.spots !== undefined) {
        if (!Array.isArray(entry.spots) || entry.spots.length > SPOTS_PER_ROOM) {
          problems.push(`room "${id}" needs at most ${SPOTS_PER_ROOM} spots in a list`);
        } else {
          const fits = new Set(decorationsFor(room).map((d) => d.id));
          clean.spots = entry.spots.map((s, i) => {
            if (s === null || s === undefined) return null;
            if (fits.has(s)) return s;
            problems.push(`room "${id}", spot ${i + 1}: "${s}" is not a decoration for this room`);
            return null;
          });
        }
      }
      decor.rooms[id] = clean;
    }
  }
  const gardensIn = input.gardens ?? {};
  if (typeof gardensIn !== 'object' || Array.isArray(gardensIn)) problems.push('"gardens" is not an object');
  else {
    for (const [id, list] of Object.entries(gardensIn)) {
      if (!gardens.some((g) => g.id === id)) {
        problems.push(`garden "${id}" does not exist`);
        continue;
      }
      const clean = checkGarden(list, `garden "${id}"`, problems);
      if (clean) decor.gardens[id] = clean;
    }
  }
  return { decor, problems };
}

module.exports = {
  FLOORS, DEFAULT_FLOOR, SPOTS_PER_ROOM, DECORATIONS, GARDEN_SIZE, PLANTS, DEFAULT_GARDENS,
  footprint, decorationsFor, checkDecor,
};
