'use strict';

const { SCENERY } = require('./rooms');
const { en } = require('./i18n');

// What people can choose when they make the hospital their own: a floor for
// each room, every item in it (furniture and decorations, placed on the
// room's tile grid), and what grows in the gardens. This module owns the
// catalogue and the starting layouts and checks a saved choice; the renderer
// owns how each piece is drawn.

// Floors any room can have.
const FLOORS = [
  { id: 'checker', name: en('decor.floor.checker') },
  { id: 'tiles', name: en('decor.floor.tiles') },
  { id: 'mosaic', name: en('decor.floor.mosaic') },
  { id: 'wood', name: en('decor.floor.wood') },
  { id: 'terrazzo', name: en('decor.floor.terrazzo') },
  { id: 'vinyl', name: en('decor.floor.vinyl') },
];
const DEFAULT_FLOOR = 'checker';

// A room's floor is ROOM_SIZE x ROOM_SIZE tiles; items stand on it.
const ROOM_SIZE = 6;

// Decorations, and the rooms they make sense in. 'any' fits every room;
// 'department' fits every department the user adds.
const DECORATIONS = [
  { id: 'plant', name: en('decor.item.plant'), rooms: 'any' },
  { id: 'tall-plant', name: en('decor.item.tall-plant'), rooms: 'any' },
  { id: 'flowers', name: en('decor.item.flowers'), rooms: 'any' },
  { id: 'water-cooler', name: en('decor.item.water-cooler'), rooms: ['nurses-station', 'research-office', 'general-ward', 'laboratory'] },
  { id: 'sanitiser', name: en('decor.item.sanitiser'), rooms: 'any' },
  { id: 'visitor-chair', name: en('decor.item.visitor-chair'), rooms: ['nurses-station', 'general-ward', 'vision-clinic', 'research-office'] },
  { id: 'waiting-bench', name: en('decor.item.waiting-bench'), rooms: ['nurses-station', 'vision-clinic', 'radiology'] },
  { id: 'supply-trolley', name: en('decor.item.supply-trolley'), rooms: ['nurses-station', 'general-ward', 'operating-room', 'department'] },
  { id: 'crash-cart', name: en('decor.item.crash-cart'), rooms: ['operating-room', 'general-ward', 'nurses-station', 'department'] },
  { id: 'instrument-tray', name: en('decor.item.instrument-tray'), rooms: ['operating-room', 'department'] },
  { id: 'scrub-sink', name: en('decor.item.scrub-sink'), rooms: ['operating-room', 'department'] },
  { id: 'sharps-bin', name: en('decor.item.sharps-bin'), rooms: ['operating-room', 'general-ward', 'laboratory', 'department'] },
  { id: 'specimen-fridge', name: en('decor.item.specimen-fridge'), rooms: ['laboratory'] },
  { id: 'tube-rack', name: en('decor.item.tube-rack'), rooms: ['laboratory'] },
  { id: 'eyewash', name: en('decor.item.eyewash'), rooms: ['laboratory'] },
  { id: 'apron-rack', name: en('decor.item.apron-rack'), rooms: ['radiology', 'department'] },
  { id: 'lightbox', name: en('decor.item.lightbox'), rooms: ['radiology', 'operating-room', 'department'] },
  { id: 'eye-model', name: en('decor.item.eye-model'), rooms: ['vision-clinic'] },
  { id: 'glasses-stand', name: en('decor.item.glasses-stand'), rooms: ['vision-clinic'] },
  { id: 'bookcase', name: en('decor.item.bookcase'), rooms: ['research-office', 'nurses-station'] },
  { id: 'globe', name: en('decor.item.globe'), rooms: ['research-office'] },
  { id: 'armchair', name: en('decor.item.armchair'), rooms: ['research-office', 'general-ward'] },
  { id: 'whiteboard', name: en('decor.item.whiteboard'), rooms: ['research-office', 'laboratory', 'department'] },
  { id: 'wheelchair', name: en('decor.item.wheelchair'), rooms: ['general-ward', 'nurses-station', 'radiology'] },
  { id: 'iv-pole', name: en('decor.item.iv-pole'), rooms: ['general-ward', 'operating-room'] },
  { id: 'spine-model', name: en('decor.item.spine-model'), rooms: ['department', 'radiology'] },
];

// Everything that can stand in a room: its furniture, the decorations above
// and a few pieces just for fun. Any item may go in any room; `suits` only
// puts it first in the list for the rooms it belongs in. Each covers w x d
// tiles (d x w when turned).
const R = (...ids) => ids;
const FURNITURE = [
  { id: 'station-counter', name: en('decor.item.station-counter'), w: 4, d: 1, turns: true, suits: R('nurses-station') },
  { id: 'office-chair', name: en('decor.item.office-chair'), w: 1, d: 1, suits: R('nurses-station', 'research-office') },
  { id: 'operating-table', name: en('decor.item.operating-table'), w: 2, d: 3, turns: true, suits: R('operating-room') },
  { id: 'anaesthesia-machine', name: en('decor.item.anaesthesia-machine'), w: 2, d: 1, turns: true, suits: R('operating-room', 'department') },
  { id: 'vitals-monitor', name: en('decor.item.vitals-monitor'), w: 1, d: 1, suits: R('operating-room', 'general-ward', 'department') },
  { id: 'bookshelf', name: en('decor.item.bookshelf'), w: 1, d: 3, turns: true, suits: R('research-office') },
  { id: 'desk', name: en('decor.item.desk'), w: 2, d: 1, turns: true, suits: R('research-office', 'nurses-station') },
  { id: 'lab-bench', name: en('decor.item.lab-bench'), w: 1, d: 4, turns: true, suits: R('laboratory') },
  { id: 'fume-hood', name: en('decor.item.fume-hood'), w: 2, d: 1, turns: true, suits: R('laboratory') },
  { id: 'centrifuge', name: en('decor.item.centrifuge'), w: 1, d: 1, suits: R('laboratory') },
  { id: 'mri-scanner', name: en('decor.item.mri-scanner'), w: 2, d: 4, turns: true, suits: R('radiology') },
  { id: 'scanner-console', name: en('decor.item.scanner-console'), w: 1, d: 1, suits: R('radiology') },
  { id: 'eye-chart', name: en('decor.item.eye-chart'), w: 2, d: 1, turns: true, suits: R('vision-clinic') },
  { id: 'exam-chair', name: en('decor.item.exam-chair'), w: 1, d: 1, suits: R('vision-clinic') },
  { id: 'slit-lamp', name: en('decor.item.slit-lamp'), w: 1, d: 1, suits: R('vision-clinic') },
  { id: 'hospital-bed', name: en('decor.item.hospital-bed'), w: 3, d: 1, turns: true, suits: R('general-ward') },
  { id: 'nav-table', name: en('decor.item.nav-table'), w: 2, d: 3, turns: true, suits: R('department') },
  { id: 'tracking-camera', name: en('decor.item.tracking-camera'), w: 1, d: 1, suits: R('department') },
  { id: 'planning-cart', name: en('decor.item.planning-cart'), w: 1, d: 1, suits: R('department') },
  // just for fun
  { id: 'sofa', name: en('decor.item.sofa'), w: 2, d: 1, turns: true, suits: R('nurses-station') },
  { id: 'rug', name: en('decor.item.rug'), w: 2, d: 2, suits: R() },
  { id: 'coffee-table', name: en('decor.item.coffee-table'), w: 1, d: 1, suits: R() },
  { id: 'fish-tank', name: en('decor.item.fish-tank'), w: 1, d: 1, suits: R('nurses-station', 'general-ward') },
  { id: 'vending-machine', name: en('decor.item.vending-machine'), w: 1, d: 1, suits: R('nurses-station') },
  { id: 'floor-lamp', name: en('decor.item.floor-lamp'), w: 1, d: 1, suits: R('research-office') },
  { id: 'filing-cabinet', name: en('decor.item.filing-cabinet'), w: 1, d: 1, suits: R('research-office', 'nurses-station') },
  { id: 'printer', name: en('decor.item.printer'), w: 1, d: 1, suits: R('research-office', 'nurses-station') },
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
  { id: 'tulips', name: en('decor.plant.tulips'), w: 1, d: 1 },
  { id: 'daisies', name: en('decor.plant.daisies'), w: 1, d: 1 },
  { id: 'lavender', name: en('decor.plant.lavender'), w: 1, d: 1 },
  { id: 'roses', name: en('decor.plant.roses'), w: 1, d: 1 },
  { id: 'shrub', name: en('decor.plant.shrub'), w: 1, d: 1 },
  { id: 'small-tree', name: en('decor.plant.small-tree'), w: 1, d: 1 },
  { id: 'lamp', name: en('decor.plant.lamp'), w: 1, d: 1 },
  { id: 'path', name: en('decor.plant.path'), w: 1, d: 1 },
  { id: 'bench', name: en('decor.plant.bench'), w: 2, d: 1, turns: true },
  { id: 'big-tree', name: en('decor.plant.big-tree'), w: 2, d: 2 },
  { id: 'blossom-tree', name: en('decor.plant.blossom-tree'), w: 2, d: 2 },
  { id: 'cherry-tree', name: en('decor.plant.cherry-tree'), w: 2, d: 2 },
  { id: 'cherry-sapling', name: en('decor.plant.cherry-sapling'), w: 1, d: 1 },
  { id: 'fountain', name: en('decor.plant.fountain'), w: 2, d: 2 },
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
