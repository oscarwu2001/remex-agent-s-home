'use strict';

// The rooms of the hospital, where each one sits on the grid, and which
// room each kind of agent works in. The renderer owns how rooms are drawn;
// this module owns what rooms exist, so the main process, the renderer and
// the tests all read one list.
//
// The grid: the core 3 x 3 (cells 0..2) is fixed. Users may add departments
// in the ring around it (cells -1..3), making up to 5 x 5.

const ROOMS = [
  { id: 'nurses-station', name: "Nurses' Station", purpose: 'Your main Claude Code sessions', cell: [1, 1] },
  { id: 'operating-room', name: 'Operating Room', purpose: 'Code review', cell: [2, 1] },
  { id: 'research-office', name: 'Research Office', purpose: 'Exploring, planning, researching', cell: [1, 2] },
  { id: 'laboratory', name: 'Laboratory', purpose: 'Running tests, gates and analyses', cell: [0, 1] },
  { id: 'radiology', name: 'Radiology', purpose: 'Hunting silent failures', cell: [0, 0] },
  { id: 'vision-clinic', name: 'Vision Clinic', purpose: 'Interface and accessibility review', cell: [1, 0] },
  { id: 'general-ward', name: 'General Ward', purpose: 'Every other agent', cell: [2, 2] },
];

// Core cells holding scenery (a garden and a grove), not rooms.
const SCENERY_CELLS = [[0, 2], [2, 0]];
const GRID_MIN = -1;
const GRID_MAX = 3;

// Departments users can add: the specialties that use surgical navigation.
// 'custom' takes a name of the user's own.
const DEPARTMENT_KINDS = [
  { kind: 'spine', name: 'Spine Surgery', purpose: 'Navigated spinal fixation' },
  { kind: 'neuro', name: 'Neurosurgery', purpose: 'Cranial navigation' },
  { kind: 'ent', name: 'ENT', purpose: 'Sinus and skull-base navigation' },
  { kind: 'dental', name: 'Dental Implantology', purpose: 'Guided implant placement' },
  { kind: 'cmf', name: 'Maxillofacial (CMF)', purpose: 'Jaw and facial reconstruction' },
  { kind: 'ortho', name: 'Orthopaedics', purpose: 'Joint replacement and alignment' },
  { kind: 'trauma', name: 'Trauma', purpose: 'Navigated fracture fixation' },
  { kind: 'sports', name: 'Sports Medicine', purpose: 'Ligament reconstruction' },
  { kind: 'pulmonology', name: 'Pulmonology', purpose: 'Navigated bronchoscopy' },
  { kind: 'ir', name: 'Interventional Radiology', purpose: 'Needle and biopsy guidance' },
  { kind: 'cardio', name: 'Cardiac Electrophysiology', purpose: 'Catheter mapping' },
  { kind: 'oncology', name: 'Surgical Oncology', purpose: 'Tumour resection margins' },
  { kind: 'custom', name: 'Your own department', purpose: 'Named by you' },
];
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
  if (layout === undefined || layout === null) return { departments: [] };
  if (typeof layout !== 'object' || !Array.isArray(layout.departments)) {
    throw new TypeError('layout must be an object with a "departments" list');
  }
  const taken = new Map(ROOMS.map((r) => [key(r.cell), r.id]));
  for (const c of SCENERY_CELLS) taken.set(key(c), 'scenery');
  const ids = new Set(ROOM_IDS);
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
    let id = `dept-${slug(name)}`;
    for (let n = 2; ids.has(id); n++) id = `dept-${slug(name)}-${n}`;
    ids.add(id);
    taken.set(key(cell), id);
    const agents = Array.isArray(d.agents)
      ? [...new Set(d.agents.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))]
      : [];
    return {
      id, kind: d.kind, name, purpose: d.kind === 'custom' ? (typeof d.purpose === 'string' && d.purpose.trim() ? d.purpose.trim().slice(0, 60) : 'Your department') : kind.purpose,
      cell: [c, r], via, agents,
    };
  });
  return { departments };
}

// Every room, core first, then departments.
function roomsWith(layout) {
  return [
    ...ROOMS.map((r) => ({ ...r })),
    ...layout.departments.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, cell: d.cell, kind: d.kind, via: d.via, custom: true })),
  ];
}

// Agents the user placed in departments, as room overrides.
function overridesFrom(layout) {
  const out = {};
  for (const d of layout.departments) for (const a of d.agents) out[a] = d.id;
  return out;
}

// Free ring cells where a department could go now.
function openCells(layout) {
  const taken = new Map(roomsWith(layout).map((r) => [key(r.cell), r.id]));
  for (const c of SCENERY_CELLS) taken.set(key(c), 'scenery');
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
  ROOMS, ROOM_IDS, DEFAULT_ASSIGNMENTS, DEPARTMENT_KINDS, SCENERY_CELLS, GRID_MIN, GRID_MAX,
  roomFor, validateOverrides, validateLayout, roomsWith, overridesFrom, openCells,
};
