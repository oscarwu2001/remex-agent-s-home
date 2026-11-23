'use strict';

// The rooms of the hospital, where each one sits on the grid, and which
// room each kind of agent works in. The renderer owns how rooms are drawn;
// this module owns what rooms exist, so the main process, the renderer and
// the tests all read one list.
//
// The grid: the core 3 x 3 (cells 0..2) is fixed. Users may add departments
// in the ring around it (cells -1..3), making up to 5 x 5.
//
// Names and purposes come from the word tables (src/core/i18n.js), keyed by
// these ids, in English here; each window shows them in its own language.

const { translate } = require('./i18n');

const en = (key, params) => translate('en', key, params);

const ROOMS = [
  { id: 'nurses-station', cell: [1, 1] },
  { id: 'operating-room', cell: [2, 1] },
  { id: 'research-office', cell: [1, 2] },
  { id: 'laboratory', cell: [0, 1] },
  { id: 'radiology', cell: [0, 0] },
  { id: 'vision-clinic', cell: [1, 0] },
  { id: 'general-ward', cell: [2, 2] },
].map((r) => ({ id: r.id, name: en(`room.${r.id}.name`), purpose: en(`room.${r.id}.purpose`), cell: r.cell }));

// The two gardens built into the core. Users may add more in the ring
// (layout.gardens); every garden is a plot people can plant, never a room.
const SCENERY = [
  { id: 'garden', cell: [0, 2] },
  { id: 'grove', cell: [2, 0] },
].map((g) => ({ id: g.id, name: en(`garden.${g.id}`), cell: g.cell }));
const SCENERY_CELLS = SCENERY.map((g) => g.cell);
const GRID_MIN = -1;
const GRID_MAX = 3;

// Departments users can add: the specialties that use surgical navigation.
// 'custom' takes a name of the user's own.
const DEPARTMENT_KINDS = ['spine', 'neuro', 'ent', 'dental', 'cmf', 'ortho', 'trauma', 'sports', 'pulmonology', 'ir', 'cardio', 'oncology', 'custom']
  .map((kind) => ({ kind, name: en(`dept.${kind}.name`), purpose: en(`dept.${kind}.purpose`) }));
const KIND_BY_ID = Object.fromEntries(DEPARTMENT_KINDS.map((k) => [k.kind, k]));

const ROOM_IDS = new Set(ROOMS.map((r) => r.id));

// Exact agent names first. Names are Claude Code subagent_type values.
const DEFAULT_ASSIGNMENTS = {
  reviewer: 'operating-room',
  'code-reviewer': 'operating-room',
  'ui-reviewer': 'vision-clinic',
  'silent-failure-hunter': 'radiology',
  runner: 'laboratory',
  Explore: 'research-office',
  Plan: 'research-office',
  'general-purpose': 'research-office',
  'claude-code-guide': 'research-office',
  researcher: 'research-office',
  // The Office pack (office-pack/), the team for people who do not code.
  writer: 'research-office',
  summariser: 'radiology',
  planner: 'vision-clinic',
  'data-helper': 'laboratory',
  checker: 'operating-room',
  'code-reviewer': 'operating-room',
  'test-runner': 'laboratory',
};

// Then keyword rules, for agents the defaults do not name.
const KEYWORD_RULES = [
  [/(^|[-_ ])(ui|ux)([-_ ]|$)|design|visual|a11y|accessib/i, 'vision-clinic'],
  [/review|audit|critic/i, 'operating-room'],
  [/fail|bug|hunt|debug|diagnos/i, 'radiology'],
  [/run|test|bench|eval|gate/i, 'laboratory'],
  [/research|explor|plan|search|guide|investig/i, 'research-office'],
];

function validateOverrides(overrides, roomIds = ROOM_IDS) {
  if (overrides === undefined || overrides === null) return {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('room overrides must be an object of { agentName: roomId }');
  }
  for (const [agent, room] of Object.entries(overrides)) {
    if (!roomIds.has(room)) {
      throw new RangeError(
        `room override for "${agent}" names unknown room "${room}"; ` +
          `valid rooms are: ${[...roomIds].join(', ')}`,
      );
    }
  }
  return overrides;
}

// ---- departments --------------------------------------------------------------

const key = ([c, r]) => `${c},${r}`;
const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dept';
}

// Checks a saved layout ({ departments: [...] }) and returns a clean copy.
// Each department must sit in the ring, on a free cell, next to a room that
// is already there (the core, or a department listed before it), because
// that is the room its bridge or stairs joins.
function validateLayout(layout) {
  if (layout === undefined || layout === null) return { departments: [], gardens: [], moves: {} };
  if (typeof layout !== 'object' || !Array.isArray(layout.departments)) {
    throw new TypeError('layout must be an object with a "departments" list');
  }
  if (layout.gardens !== undefined && !Array.isArray(layout.gardens)) throw new TypeError('"gardens" must be a list');
  const taken = new Map(ROOMS.map((r) => [key(r.cell), r.id]));
  for (const c of SCENERY_CELLS) taken.set(key(c), 'scenery');
  // Gardens first: they only need a free cell, and departments must then
  // steer clear of them. A garden is never a way in to a department.
  const gardens = checkGardens(layout.gardens ?? [], taken);
  const ids = new Set(ROOM_IDS);
  // Ids already written in the file, so a new department never takes one.
  const reserved = new Set(layout.departments.map((d) => d && d.id).filter((x) => typeof x === 'string'));
  const departments = layout.departments.map((d, i) => {
    const where = `department ${i + 1}`;
    if (!d || typeof d !== 'object') throw new TypeError(`${where} is not an object`);
    const kind = KIND_BY_ID[d.kind];
    if (!kind) throw new RangeError(`${where} has unknown kind "${d.kind}"`);
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 40) : kind.name;
    if (d.kind === 'custom' && !(typeof d.name === 'string' && d.name.trim())) {
      throw new RangeError(`${where} is a custom department and needs a name`);
    }
    const cell = d.cell;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      throw new TypeError(`${where} needs a cell like [col, row]`);
    }
    const [c, r] = cell;
    if (c < GRID_MIN || c > GRID_MAX || r < GRID_MIN || r > GRID_MAX) {
      throw new RangeError(`${where} is outside the 5 x 5 grid`);
    }
    if (taken.has(key(cell))) throw new RangeError(`${where} sits on a cell that is already taken`);
    const via = NEIGHBOURS.map(([dc, dr]) => taken.get(key([c + dc, r + dr])))
      .find((id) => id && id !== 'scenery');
    if (!via) throw new RangeError(`${where} is not next to any room, so nothing can reach it`);
    // Ids are kept once given, so removing one department never renames
    // another (helpers on shift and rooms.json refer to rooms by id).
    let id = typeof d.id === 'string' && /^dept-[a-z0-9-]{1,60}$/.test(d.id) && !ids.has(d.id) ? d.id : undefined;
    if (!id) {
      id = `dept-${slug(name)}`;
      for (let n = 2; ids.has(id) || reserved.has(id); n++) id = `dept-${slug(name)}-${n}`;
    }
    ids.add(id);
    taken.set(key(cell), id);
    const agents = Array.isArray(d.agents)
      ? [...new Set(d.agents.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))]
      : [];
    return {
      id, kind: d.kind, name, purpose: d.kind === 'custom' ? (typeof d.purpose === 'string' && d.purpose.trim() ? d.purpose.trim().slice(0, 60) : en('dept.ownPurpose')) : kind.purpose,
      cell: [c, r], via, agents,
    };
  });
  const moves = checkMoves(layout.moves, new Set([...ROOM_IDS, ...departments.map((d) => d.id)]));
  return { departments, gardens, moves };
}

// Agents the user dragged to another room: { agentName: roomId }. A move to
// a room that is no longer there is dropped: that agent simply goes back to
// its usual room, which is what removing the room should mean.
function checkMoves(moves, roomIds) {
  if (moves === undefined || moves === null) return {};
  if (typeof moves !== 'object' || Array.isArray(moves)) throw new TypeError('"moves" must be an object of { agentName: roomId }');
  const out = {};
  for (const [agent, room] of Object.entries(moves)) {
    const name = agent.trim();
    if (!name || name.length > 64) throw new RangeError(`a moved agent needs a name of 1 to 64 characters, not "${agent.slice(0, 20)}"`);
    if (typeof room !== 'string') throw new TypeError(`the room for "${name}" must be a room id`);
    if (roomIds.has(room)) out[name] = room;
  }
  return out;
}

function checkGardens(list, taken) {
  const used = new Set(list.map((g) => g && g.id).filter((id) => typeof id === 'string' && /^plot-[0-9]{1,4}$/.test(id)));
  const ids = new Set();
  let next = 1;
  return list.map((g, i) => {
    const where = `garden ${i + 1}`;
    if (!g || typeof g !== 'object') throw new TypeError(`${where} is not an object`);
    const cell = g.cell;
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      throw new TypeError(`${where} needs a cell like [col, row]`);
    }
    const [c, r] = cell;
    if (c < GRID_MIN || c > GRID_MAX || r < GRID_MIN || r > GRID_MAX) throw new RangeError(`${where} is outside the 5 x 5 grid`);
    if (taken.has(key(cell))) throw new RangeError(`${where} sits on a cell that is already taken`);
    // Ids are kept once given, so a garden keeps its planting when another goes.
    let id = typeof g.id === 'string' && /^plot-[0-9]{1,4}$/.test(g.id) && !ids.has(g.id) ? g.id : undefined;
    if (!id) {
      while (used.has(`plot-${next}`) || ids.has(`plot-${next}`)) next++;
      id = `plot-${next}`;
    }
    ids.add(id);
    taken.set(key(cell), 'scenery');
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 30) : en('garden.numbered', { n: id.slice(5) });
    return { id, name, cell: [c, r] };
  });
}

// Every garden, the built-in two first.
function gardensWith(layout) {
  return [...SCENERY.map((g) => ({ ...g, cell: [...g.cell] })), ...(layout.gardens ?? []).map((g) => ({ ...g, cell: [...g.cell] }))];
}

// Every room, core first, then departments.
function roomsWith(layout) {
  return [
    ...ROOMS.map((r) => ({ ...r })),
    ...layout.departments.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, cell: d.cell, kind: d.kind, via: d.via, custom: true })),
  ];
}

// Agents the user placed in departments, or dragged to a room, as room
// overrides. A drag is the newer choice, so it wins.
function overridesFrom(layout) {
  const out = {};
  for (const d of layout.departments) for (const a of d.agents) out[a] = d.id;
  return { ...out, ...(layout.moves ?? {}) };
}

// Free ring cells where a department could go now.
function openCells(layout) {
  const taken = new Map(roomsWith(layout).map((r) => [key(r.cell), r.id]));
  for (const g of gardensWith(layout)) taken.set(key(g.cell), 'scenery');
  const open = [];
  for (let r = GRID_MIN; r <= GRID_MAX; r++) {
    for (let c = GRID_MIN; c <= GRID_MAX; c++) {
      if (taken.has(key([c, r]))) continue;
      const touches = NEIGHBOURS.some(([dc, dr]) => {
        const id = taken.get(key([c + dc, r + dr]));
        return id && id !== 'scenery';
      });
      if (touches) open.push([c, r]);
    }
  }
  return open;
}

function roomFor(agentType, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, agentType)) return overrides[agentType];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_ASSIGNMENTS, agentType)) {
    return DEFAULT_ASSIGNMENTS[agentType];
  }
  for (const [pattern, room] of KEYWORD_RULES) {
    if (pattern.test(agentType)) return room;
  }
  return 'general-ward';
}

module.exports = {
  ROOMS, ROOM_IDS, DEFAULT_ASSIGNMENTS, DEPARTMENT_KINDS, SCENERY, SCENERY_CELLS, GRID_MIN, GRID_MAX,
  roomFor, validateOverrides, validateLayout, roomsWith, gardensWith, overridesFrom, openCells,
};
