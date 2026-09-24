'use strict';

// Which room of the hospital each kind of agent works in. The renderer owns
// where the rooms are drawn; this module owns only the assignment, so the
// main process and the tests can use it without a DOM.

const ROOMS = [
  { id: 'nurses-station', name: "Nurses' Station", purpose: 'Your main Claude Code sessions' },
  { id: 'operating-room', name: 'Operating Room', purpose: 'Code review' },
  { id: 'research-office', name: 'Research Office', purpose: 'Exploring, planning, researching' },
  { id: 'laboratory', name: 'Laboratory', purpose: 'Running tests, gates and analyses' },
  { id: 'radiology', name: 'Radiology', purpose: 'Hunting silent failures' },
  { id: 'vision-clinic', name: 'Vision Clinic', purpose: 'Interface and accessibility review' },
  { id: 'general-ward', name: 'General Ward', purpose: 'Every other agent' },
];

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

function validateOverrides(overrides) {
  if (overrides === undefined || overrides === null) return {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('room overrides must be an object of { agentName: roomId }');
  }
  for (const [agent, room] of Object.entries(overrides)) {
    if (!ROOM_IDS.has(room)) {
      throw new RangeError(
        `room override for "${agent}" names unknown room "${room}"; ` +
          `valid rooms are: ${[...ROOM_IDS].join(', ')}`,
      );
    }
  }
  return overrides;
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

module.exports = { ROOMS, ROOM_IDS, DEFAULT_ASSIGNMENTS, roomFor, validateOverrides };
