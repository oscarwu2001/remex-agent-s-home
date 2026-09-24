'use strict';

// Reads the agent definitions (.claude/agents/*.md) the user has installed,
// so the staff directory can list agents before they are ever called.

const fs = require('fs');
const path = require('path');
const { roomFor } = require('./rooms');

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][-+]?$/.test(value)) {
      // YAML block scalar: the indented lines that follow.
      const block = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && !/^[A-Za-z_][\w-]*:/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    }
    fields[kv[1]] = value.replace(/^["']|["']$/g, '').trim();
  }
  return fields;
}

function firstSentence(s = '') {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return m ? m[1] : s;
}

// dirs: [{ dir, scope }] where scope is 'user' or a project name.
function readRoster(dirs, overrides = {}) {
  const agents = new Map();
  const problems = [];
  for (const { dir, scope } of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch (err) {
      // A missing agents folder is normal: most projects have none.
      if (err.code !== 'ENOENT') problems.push({ label: `An agents folder could not be listed (${err.code})`, detail: dir });
      continue;
    }
    for (const n of names) {
      let fm;
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
      } catch (err) {
        problems.push({ label: `An agent definition could not be read (${err.code || 'error'})`, detail: n });
        continue;
      }
      if (!fm || !fm.name) {
        problems.push({ label: 'An agent definition has no "name" in its frontmatter', detail: n });
        continue;
      }
      // Project agents override user agents of the same name, as in Claude Code.
      agents.set(fm.name, {
        name: fm.name,
        summary: firstSentence(fm.description),
        scope,
        room: roomFor(fm.name, overrides),
      });
    }
  }
  return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

module.exports = { readRoster, parseFrontmatter };
