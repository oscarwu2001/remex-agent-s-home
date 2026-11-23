'use strict';

// Human wording for a tool call. `label` is safe to show on a shared screen;
// `detail` may carry a file name, pattern, command or host and is hidden
// while privacy mode is on. The label is in English (the system log's);
// `labelKey` and `labelParams` let each window say it in its own language.

const path = require('path');
const { translate } = require('./i18n');

const said = (key, params) => ({ label: translate('en', key, params), labelKey: key, ...(params ? { labelParams: params } : {}) });

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
      return { kind: 'read', ...said('tool.read'), detail: basename(input.file_path) };
    case 'Write':
      return { kind: 'write', ...said('tool.write'), detail: basename(input.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'write', ...said('tool.edit'), detail: basename(input.file_path) };
    case 'NotebookEdit':
      return { kind: 'write', ...said('tool.notebook'), detail: basename(input.notebook_path) };
    case 'Bash':
    case 'PowerShell':
      return { kind: 'run', ...said('tool.run'), detail: clip(input.description || input.command) };
    case 'Grep':
    case 'Glob':
      return { kind: 'search', ...said('tool.search'), detail: clip(input.pattern) };
    case 'WebFetch':
      return { kind: 'web', ...said('tool.webRead'), detail: host(input.url) };
    case 'WebSearch':
      return { kind: 'web', ...said('tool.webSearch'), detail: clip(input.query) };
    case 'Task':
    case 'Agent':
      return {
        kind: 'delegate',
        ...said('tool.delegate', { type: input.subagent_type || 'general-purpose' }),
        detail: clip(input.description),
      };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { kind: 'chart', ...said('tool.chart'), detail: '' };
    case 'Skill':
      return { kind: 'skill', ...said('tool.skill'), detail: clip(input.skill || input.command) };
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        const server = name.split('__')[1];
        return { kind: 'tool', ...(server ? said('tool.using', { name: server }) : said('tool.usingConnector')), detail: clip(name.split('__').slice(2).join(' ')) };
      }
      return { kind: 'tool', ...(name ? said('tool.using', { name }) : said('tool.usingTool')), detail: '' };
  }
}

// Tools that normally stop for a permission prompt. A pending call to one of
// these that has gone quiet is shown as "approval or long-running".
const APPROVAL_TOOLS = new Set([
  'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
]);

module.exports = { describeTool, APPROVAL_TOOLS, clip };
