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
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
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
      if (err.code !== 'ENOENT') problems.push(`Cannot list agents in ${dir}: ${err.code}`);
      continue;
    }
    for (const n of names) {
      let fm;
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
      } catch (err) {
        problems.push(`Cannot read agent ${n}: ${err.code || err.message}`);
        continue;
      }
      if (!fm || !fm.name) {
        problems.push(`Agent file ${n} has no "name" in its frontmatter`);
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
