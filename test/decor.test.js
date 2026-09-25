'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkDecor, decorationsFor, itemsFor, defaultItemsFor, footprint, DECORATIONS, ROOM_ITEMS, DEFAULT_GARDENS, GARDEN_SIZE,
} = require('../src/core/decor');
const { roomsWith, validateLayout } = require('../src/core/rooms');

const rooms = roomsWith(validateLayout({ departments: [{ kind: 'spine', cell: [3, 1] }] }));
const spine = rooms.find((r) => r.kind === 'spine');

test('nothing saved means no decor and no problems', () => {
  assert.deepEqual(checkDecor(undefined, rooms), { decor: { rooms: {}, gardens: {} }, problems: [] });
});

test('every decoration fits at least one room', () => {
  for (const d of DECORATIONS) {
    assert.ok(rooms.some((r) => decorationsFor(r).includes(d)), d.id);
  }
});

test('unknown floors, rooms and gardens are dropped and reported, never guessed', () => {
  const { decor, problems } = checkDecor({
    rooms: { laboratory: { floor: 'lava' }, cafeteria: { floor: 'wood' } },
    gardens: { orchard: [] },
  }, rooms);
  assert.deepEqual(decor, { rooms: { laboratory: {} }, gardens: {} });
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /unknown floor "lava"/);
  assert.match(problems.join('\n'), /room "cafeteria" does not exist/);
  assert.match(problems.join('\n'), /garden "orchard" does not exist/);
});

test('a big tree covers four tiles and a turned bench runs the other way', () => {
  assert.deepEqual(footprint({ kind: 'big-tree', at: [1, 1] }), [[1, 1], [1, 2], [2, 1], [2, 2]]);
  assert.deepEqual(footprint({ kind: 'bench', at: [0, 0] }), [[0, 0], [1, 0]]);
  assert.deepEqual(footprint({ kind: 'bench', at: [0, 0], turn: true }), [[0, 0], [0, 1]]);
  assert.deepEqual(footprint({ kind: 'tulips', at: [0, 0], turn: true }), [[0, 0]]);
});

test('garden items must fit the plot and not overlap', () => {
  const { decor, problems } = checkDecor({
    gardens: {
      grove: [
        { kind: 'fountain', at: [GARDEN_SIZE - 1, 0] }, // hangs off the edge
        { kind: 'big-tree', at: [0, 0] },
        { kind: 'tulips', at: [1, 1] }, // under the tree
        { kind: 'daisies', at: [2.5, 1] },
        { kind: 'weeds', at: [3, 3] },
        { kind: 'lavender', at: [3, 3] },
      ],
    },
  }, rooms);
  assert.deepEqual(decor.gardens.grove, [{ kind: 'big-tree', at: [0, 0] }, { kind: 'lavender', at: [3, 3] }]);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /does not fit inside the 4 x 4 plot/);
  assert.match(problems.join('\n'), /overlaps something planted before it/);
  assert.match(problems.join('\n'), /needs a tile like \[col, row\]/);
  assert.match(problems.join('\n'), /unknown kind "weeds"/);
});

test('the default gardens are themselves valid', () => {
  const { problems } = checkDecor({ gardens: DEFAULT_GARDENS }, rooms);
  assert.deepEqual(problems, []);
});

test('a malformed file is one problem, not a crash', () => {
  assert.deepEqual(checkDecor([], rooms).problems, ['decor must be an object with "rooms" and "gardens"']);
  assert.match(checkDecor({ rooms: [] }, rooms).problems[0], /"rooms" is not an object/);
  assert.match(checkDecor({ gardens: { garden: 'x' } }, rooms).problems[0], /is not a list/);
});

test('a garden added in the layout can be planted; one that is gone cannot', () => {
  const { gardensWith } = require('../src/core/rooms');
  const layout = validateLayout({ departments: [], gardens: [{ cell: [3, 1] }] });
  const gardens = gardensWith(layout);
  const input = { gardens: { 'plot-1': [{ kind: 'cherry-tree', at: [1, 1] }] } };
  assert.deepEqual(checkDecor(input, roomsWith(layout), gardens).problems, []);
  assert.match(checkDecor(input, roomsWith(layout)).problems[0], /garden "plot-1" does not exist/);
});

test('a valid choice comes back as it was', () => {
  const input = {
    rooms: {
      'operating-room': { floor: 'terrazzo', items: [{ kind: 'operating-table', at: [0, 0], turn: true }, { kind: 'crash-cart', at: [5, 5] }] },
      [spine.id]: { floor: 'wood', items: [{ kind: 'spine-model', at: [2, 2] }] },
    },
    gardens: { garden: [{ kind: 'big-tree', at: [0, 0] }, { kind: 'bench', at: [3, 0], turn: true }] },
  };
  const { decor, problems } = checkDecor(input, rooms);
  assert.deepEqual(problems, []);
  assert.deepEqual(decor, input);
});

test('every room starts with its own furniture, which checks out', () => {
  for (const room of rooms) {
    const items = defaultItemsFor(room);
    assert.ok(items.length > 0, room.id);
    const { problems } = checkDecor({ rooms: { [room.id]: { items } } }, rooms);
    assert.deepEqual(problems, [], room.id);
  }
});

test('any item may go in any room; the ones that belong are listed first', () => {
  const lab = rooms.find((r) => r.id === 'laboratory');
  const list = itemsFor(lab).map((i) => i.id);
  assert.equal(list.length, ROOM_ITEMS.length);
  assert.ok(list.indexOf('lab-bench') < list.indexOf('hospital-bed'));
  const { problems } = checkDecor({ rooms: { laboratory: { items: [{ kind: 'hospital-bed', at: [0, 0] }] } } }, rooms);
  assert.deepEqual(problems, []);
});

test('room items must fit the 6 x 6 floor and not overlap', () => {
  const { decor, problems } = checkDecor({ rooms: { 'general-ward': { items: [
    { kind: 'hospital-bed', at: [4, 0] }, // 3 wide from column 4: off the floor
    { kind: 'hospital-bed', at: [0, 0] },
    { kind: 'plant', at: [1, 0] }, // on the bed
    { kind: 'rocket', at: [5, 5] },
  ] } } }, rooms);
  assert.deepEqual(decor.rooms['general-ward'].items, [{ kind: 'hospital-bed', at: [0, 0] }]);
  assert.match(problems.join('\n'), /does not fit inside the 6 x 6 room/);
  assert.match(problems.join('\n'), /overlaps/);
  assert.match(problems.join('\n'), /unknown kind "rocket"/);
});

test('decorations saved on the old spots move onto the grid', () => {
  const { decor, problems } = checkDecor({ rooms: { 'operating-room': { spots: ['crash-cart', null, 'plant'] } } }, rooms);
  assert.deepEqual(problems, []);
  const items = decor.rooms['operating-room'].items;
  assert.ok(items.some((i) => i.kind === 'operating-table'), 'the furniture stays');
  assert.deepEqual(items.filter((i) => i.kind === 'crash-cart'), [{ kind: 'crash-cart', at: [0, 0] }]);
  assert.deepEqual(items.filter((i) => i.kind === 'plant'), [{ kind: 'plant', at: [5, 5] }]);
});
