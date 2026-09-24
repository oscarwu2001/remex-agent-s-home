'use strict';

// Builders for synthetic transcript entries. All content is invented; no real
// session is ever copied into the tests.

const T0 = Date.parse('2026-01-01T09:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

const base = (s, extra = {}) => ({
  sessionId: 'sess-1',
  cwd: '/work/demo-project',
  timestamp: at(s),
  isSidechain: false,
  ...extra,
});

const prompt = (s, text, extra) => ({ ...base(s, extra), type: 'user', message: { role: 'user', content: text } });

const toolUse = (s, id, name, input = {}, extra) => ({
  ...base(s, extra),
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
});

const toolResult = (s, id, text = 'ok', extra, isError = false) => ({
  ...base(s, extra),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
});

const say = (s, text, stop = 'end_turn', extra) => ({
  ...base(s, extra),
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop },
});

const sidechain = (agentId) => ({ isSidechain: true, agentId });

module.exports = { T0, at, prompt, toolUse, toolResult, say, sidechain };
