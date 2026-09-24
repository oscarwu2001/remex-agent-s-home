'use strict';

// Human wording for a tool call. `label` is safe to show on a shared screen;
// `detail` may carry a file name, pattern, command or host and is hidden
// while privacy mode is on.

const path = require('path');

function basename(p) {
  return typeof p === 'string' && p ? path.basename(p.replace(/\\/g, '/')) : '';
}

function clip(s, n = 60) {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return ''; // not a URL: there is no host to show, and nothing is lost
  }
}

function describeTool(name, input = {}) {
  switch (name) {
    case 'Read':
      return { kind: 'read', label: 'Reading a file', detail: basename(input.file_path) };
    case 'Write':
      return { kind: 'write', label: 'Writing a file', detail: basename(input.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'write', label: 'Editing a file', detail: basename(input.file_path) };
    case 'NotebookEdit':
      return { kind: 'write', label: 'Editing a notebook', detail: basename(input.notebook_path) };
    case 'Bash':
    case 'PowerShell':
      return { kind: 'run', label: 'Running a command', detail: clip(input.description || input.command) };
    case 'Grep':
    case 'Glob':
      return { kind: 'search', label: 'Searching the code', detail: clip(input.pattern) };
    case 'WebFetch':
      return { kind: 'web', label: 'Reading a web page', detail: host(input.url) };
    case 'WebSearch':
      return { kind: 'web', label: 'Searching the web', detail: clip(input.query) };
    case 'Task':
    case 'Agent':
      return {
        kind: 'delegate',
        label: `Consulting ${input.subagent_type || 'general-purpose'}`,
        detail: clip(input.description),
      };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { kind: 'chart', label: 'Updating the chart', detail: '' };
    case 'Skill':
      return { kind: 'skill', label: 'Using a skill', detail: clip(input.skill || input.command) };
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        const server = name.split('__')[1] || 'a connector';
        return { kind: 'tool', label: `Using ${server}`, detail: clip(name.split('__').slice(2).join(' ')) };
      }
      return { kind: 'tool', label: `Using ${name || 'a tool'}`, detail: '' };
  }
}

// Tools that normally stop for a permission prompt. A pending call to one of
// these that has gone quiet is shown as "approval or long-running".
const APPROVAL_TOOLS = new Set([
  'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
]);

module.exports = { describeTool, APPROVAL_TOOLS, clip };
