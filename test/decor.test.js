'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkDecor, decorationsFor, footprint, DECORATIONS, DEFAULT_GARDENS, GARDEN_SIZE, SPOTS_PER_ROOM,
} = require('../src/core/decor');
const { roomsWith, validateLayout } = require('../src/core/rooms');

const rooms = roomsWith(validateLayout({ departments: [{ kind: 'spine', cell: [3, 1] }] }));
const spine = rooms.find((r) => r.kind === 'spine');

test('nothing saved means no decor and no problems', () => {
  assert.deepEqual(checkDecor(undefined, rooms), { decor: { rooms: {}, gardens: {} }, problems: [] });
});

test('a valid choice comes back as it was', () => {
  const input = {
    rooms: {
      'operating-room': { floor: 'terrazzo', spots: ['crash-cart', null, 'plant'] },
      [spine.id]: { floor: 'wood', spots: ['spine-model'] },
    },
    gardens: { garden: [{ kind: 'big-tree', at: [0, 0] }, { kind: 'bench', at: [3, 0], turn: true }] },
  };
  const { decor, problems } = checkDecor(input, rooms);
  assert.deepEqual(problems, []);
  assert.deepEqual(decor, input);
});

test('decorations only go where they make sense', () => {
  const ids = (room) => decorationsFor(room).map((d) => d.id);
  const lab = rooms.find((r) => r.id === 'laboratory');
  const office = rooms.find((r) => r.id === 'research-office');
  assert.ok(ids(lab).includes('specimen-fridge'));
  assert.ok(!ids(office).includes('specimen-fridge'));
  assert.ok(ids(spine).includes('spine-model'), 'departments get the department pieces');
  assert.ok(ids(office).includes('plant'), 'the everyday pieces fit every room');
  const { decor, problems } = checkDecor({ rooms: { 'research-office': { spots: ['specimen-fridge', 'globe'] } } }, rooms);
  assert.deepEqual(decor.rooms['research-office'].spots, [null, 'globe']);
  assert.match(problems[0], /spot 1: "specimen-fridge" is not a decoration for this room/);
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

test('too many spots is refused', () => {
  const spots = Array(SPOTS_PER_ROOM + 1).fill('plant');
  const { problems } = checkDecor({ rooms: { laboratory: { spots } } }, rooms);
  assert.match(problems[0], /at most 3 spots/);
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
