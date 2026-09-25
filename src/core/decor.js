'use strict';

const { SCENERY } = require('./rooms');

// What people can choose when they make the hospital their own: a floor for
// each room, every item in it (furniture and decorations, placed on the
// room's tile grid), and what grows in the gardens. This module owns the
// catalogue and the starting layouts and checks a saved choice; the renderer
// owns how each piece is drawn.

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

// A room's floor is ROOM_SIZE x ROOM_SIZE tiles; items stand on it.
const ROOM_SIZE = 6;

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

// Everything that can stand in a room: its furniture, the decorations above
// and a few pieces just for fun. Any item may go in any room; `suits` only
// puts it first in the list for the rooms it belongs in. Each covers w x d
// tiles (d x w when turned).
const R = (...ids) => ids;
const FURNITURE = [
  { id: 'station-counter', name: "Nurses' counter", w: 4, d: 1, turns: true, suits: R('nurses-station') },
  { id: 'office-chair', name: 'Office chair', w: 1, d: 1, suits: R('nurses-station', 'research-office') },
  { id: 'operating-table', name: 'Operating table and lights', w: 2, d: 3, turns: true, suits: R('operating-room') },
  { id: 'anaesthesia-machine', name: 'Anaesthesia machine', w: 2, d: 1, turns: true, suits: R('operating-room', 'department') },
  { id: 'vitals-monitor', name: 'Vital signs monitor', w: 1, d: 1, suits: R('operating-room', 'general-ward', 'department') },
  { id: 'bookshelf', name: 'Bookshelf', w: 1, d: 3, turns: true, suits: R('research-office') },
  { id: 'desk', name: 'Desk with laptop', w: 2, d: 1, turns: true, suits: R('research-office', 'nurses-station') },
  { id: 'lab-bench', name: 'Lab bench', w: 1, d: 4, turns: true, suits: R('laboratory') },
  { id: 'fume-hood', name: 'Fume hood', w: 2, d: 1, turns: true, suits: R('laboratory') },
  { id: 'centrifuge', name: 'Centrifuge', w: 1, d: 1, suits: R('laboratory') },
  { id: 'mri-scanner', name: 'MRI scanner', w: 2, d: 4, turns: true, suits: R('radiology') },
  { id: 'scanner-console', name: 'Scanner console', w: 1, d: 1, suits: R('radiology') },
  { id: 'eye-chart', name: 'Eye chart', w: 2, d: 1, turns: true, suits: R('vision-clinic') },
  { id: 'exam-chair', name: 'Exam chair', w: 1, d: 1, suits: R('vision-clinic') },
  { id: 'slit-lamp', name: 'Slit lamp', w: 1, d: 1, suits: R('vision-clinic') },
  { id: 'hospital-bed', name: 'Hospital bed', w: 3, d: 1, turns: true, suits: R('general-ward') },
  { id: 'nav-table', name: 'Navigation table', w: 2, d: 3, turns: true, suits: R('department') },
  { id: 'tracking-camera', name: 'Tracking camera', w: 1, d: 1, suits: R('department') },
  { id: 'planning-cart', name: 'Planning cart', w: 1, d: 1, suits: R('department') },
  // just for fun
  { id: 'sofa', name: 'Sofa', w: 2, d: 1, turns: true, suits: R('nurses-station') },
  { id: 'rug', name: 'Round rug', w: 2, d: 2, suits: R() },
  { id: 'coffee-table', name: 'Coffee table', w: 1, d: 1, suits: R() },
  { id: 'fish-tank', name: 'Fish tank', w: 1, d: 1, suits: R('nurses-station', 'general-ward') },
  { id: 'vending-machine', name: 'Vending machine', w: 1, d: 1, suits: R('nurses-station') },
  { id: 'floor-lamp', name: 'Floor lamp', w: 1, d: 1, suits: R('research-office') },
  { id: 'filing-cabinet', name: 'Filing cabinet', w: 1, d: 1, suits: R('research-office', 'nurses-station') },
  { id: 'printer', name: 'Printer', w: 1, d: 1, suits: R('research-office', 'nurses-station') },
];
const ROOM_ITEMS = [
  ...FURNITURE,
  ...DECORATIONS.map((d) => ({ id: d.id, name: d.name, w: 1, d: 1, suits: d.rooms === 'any' ? R() : d.rooms })),
];
const ITEM_BY_ID = Object.fromEntries(ROOM_ITEMS.map((i) => [i.id, i]));

// How each room starts: its furniture as it always stood. Departments share
// one layout, around their navigation table.
const DEFAULT_ROOM_ITEMS = {
  'nurses-station': [
    { kind: 'station-counter', at: [1, 1] }, { kind: 'office-chair', at: [1, 0] }, { kind: 'office-chair', at: [4, 0] },
    { kind: 'plant', at: [0, 5] }, { kind: 'plant', at: [5, 5] },
  ],
  'operating-room': [
    { kind: 'operating-table', at: [2, 2] }, { kind: 'anaesthesia-machine', at: [2, 0] },
    { kind: 'vitals-monitor', at: [5, 0] }, { kind: 'instrument-tray', at: [4, 3] },
  ],
  'research-office': [
    { kind: 'bookshelf', at: [0, 2] }, { kind: 'desk', at: [1, 1] }, { kind: 'desk', at: [3, 1] },
    { kind: 'office-chair', at: [1, 2] }, { kind: 'office-chair', at: [4, 2] },
    { kind: 'whiteboard', at: [5, 3] }, { kind: 'plant', at: [5, 5] },
  ],
  laboratory: [{ kind: 'lab-bench', at: [0, 1] }, { kind: 'fume-hood', at: [4, 0] }, { kind: 'centrifuge', at: [4, 4] }],
  radiology: [{ kind: 'mri-scanner', at: [2, 1] }, { kind: 'scanner-console', at: [4, 4] }],
  'vision-clinic': [{ kind: 'eye-chart', at: [0, 0] }, { kind: 'exam-chair', at: [2, 3] }, { kind: 'slit-lamp', at: [4, 1] }],
  'general-ward': [{ kind: 'hospital-bed', at: [0, 0] }, { kind: 'hospital-bed', at: [0, 2] }, { kind: 'hospital-bed', at: [0, 4] }],
  department: [{ kind: 'nav-table', at: [2, 2] }, { kind: 'tracking-camera', at: [5, 0] }, { kind: 'planning-cart', at: [0, 0] }],
};

// Where the three decoration spots of earlier versions were, as tiles, so a
// decor.json saved then keeps its decorations.
const LEGACY_SPOTS = {
  'nurses-station': [[0, 0], [0, 4], [5, 4]], 'operating-room': [[0, 0], [0, 5], [5, 5]],
  'research-office': [[0, 0], [5, 0], [1, 5]], laboratory: [[0, 5], [5, 2], [3, 5]], radiology: [[0, 0], [5, 0], [5, 5]],
  'vision-clinic': [[0, 4], [5, 0], [5, 5]], 'general-ward': [[5, 0], [5, 4], [1, 5]], department: [[0, 5], [5, 5], [0, 1]],
};

function defaultItemsFor(room) {
  return (DEFAULT_ROOM_ITEMS[room.custom ? 'department' : room.id] ?? []).map((i) => ({ ...i, at: [...i.at] }));
}

// Items that belong in a room first, then everything else.
function itemsFor(room) {
  const tag = room.custom ? 'department' : room.id;
  const fits = ROOM_ITEMS.filter((i) => i.suits.length === 0 || i.suits.includes(tag));
  return [...fits, ...ROOM_ITEMS.filter((i) => !fits.includes(i))];
}

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

// The tiles a planted (or placed) item covers.
function footprint(item) {
  const p = PLANT_BY_ID[item.kind] ?? ITEM_BY_ID[item.kind];
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

function checkGarden(list, where, problems, catalogue = PLANT_BY_ID, size = GARDEN_SIZE, noun = 'plot') {
  if (!Array.isArray(list)) {
    problems.push(`${where} is not a list`);
    return undefined;
  }
  const taken = new Set();
  const out = [];
  list.forEach((item, n) => {
    const at = `${where}, item ${n + 1}`;
    if (!item || typeof item !== 'object') return problems.push(`${at} is not an object`);
    if (!catalogue[item.kind]) return problems.push(`${at} has unknown kind "${item.kind}"`);
    const cell = item.at;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      return problems.push(`${at} needs a tile like [col, row]`);
    }
    const clean = { kind: item.kind, at: [cell[0], cell[1]] };
    if (item.turn === true && catalogue[item.kind].turns) clean.turn = true;
    const tiles = footprint(clean);
    if (tiles.some(([i, j]) => i < 0 || j < 0 || i >= size || j >= size)) {
      return problems.push(`${at} does not fit inside the ${size} x ${size} ${noun}`);
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
      if (entry.items !== undefined) {
        const items = checkGarden(entry.items, `room "${id}"`, problems, ITEM_BY_ID, ROOM_SIZE, 'room');
        if (items) clean.items = items;
      }
      // Earlier versions kept three decoration spots; they become items on
      // the grid, placed among the room's starting furniture.
      if (entry.spots !== undefined && clean.items === undefined) {
        if (!Array.isArray(entry.spots)) problems.push(`room "${id}" has spots that are not a list`);
        else {
          const tiles = LEGACY_SPOTS[room.custom ? 'department' : id] ?? [];
          const items = defaultItemsFor(room);
          const taken = new Set(items.flatMap((it) => footprint(it)).map((t) => t.join(',')));
          entry.spots.forEach((kind, i) => {
            if (!kind) return;
            if (!ITEM_BY_ID[kind] || !tiles[i]) return problems.push(`room "${id}", spot ${i + 1}: "${kind}" is not a known decoration`);
            if (taken.has(tiles[i].join(','))) return problems.push(`room "${id}", spot ${i + 1}: no free tile left for "${kind}"`);
            taken.add(tiles[i].join(','));
            return items.push({ kind, at: [...tiles[i]] });
          });
          clean.items = items;
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
  FLOORS, DEFAULT_FLOOR, DECORATIONS, ROOM_SIZE, ROOM_ITEMS, DEFAULT_ROOM_ITEMS, GARDEN_SIZE, PLANTS, DEFAULT_GARDENS,
  footprint, decorationsFor, itemsFor, defaultItemsFor, checkDecor,
};
