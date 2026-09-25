'use strict';

// The Office pack (office-pack/ in this repo): a small team of Claude Code
// agents and skills for people who do not code. This module lists it, sees
// what is already in the user's Claude folder, and copies in only what the
// user chose. It is the one thing the app ever writes under ~/.claude, only
// when the user says yes, only into agents/ and skills/, and it never
// overwrites a file or folder that is already there.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./roster');

const NAME = /^[a-z][a-z0-9-]{0,40}$/;

function firstSentence(text) {
  const s = String(text ?? '').split(/(?<=[.!?])\s|\s-\s/)[0].trim();
  if (s.length <= 80) return s;
  return `${s.slice(0, s.lastIndexOf(' ', 78))}…`;
}

// [{ kind: 'agent' | 'skill', name, summary, from, to }] with paths relative
// to the pack and to the Claude folder.
function listPack(packDir) {
  const items = [];
  for (const file of fs.readdirSync(path.join(packDir, 'agents')).filter((f) => f.endsWith('.md')).sort()) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(packDir, 'agents', file), 'utf8')) ?? {};
    items.push({ kind: 'agent', name: fm.name ?? file.slice(0, -3), summary: firstSentence(fm.description), from: path.join('agents', file), to: path.join('agents', file) });
  }
  for (const dir of fs.readdirSync(path.join(packDir, 'skills')).sort()) {
    const file = path.join(packDir, 'skills', dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8')) ?? {};
    items.push({ kind: 'skill', name: fm.name ?? dir, summary: firstSentence(fm.description), from: path.join('skills', dir), to: path.join('skills', dir) });
  }
  return items.filter((i) => NAME.test(i.name));
}

// What is installed already, and whether the user has agents of their own.
function packStatus(packDir, claudeDir) {
  let hasOwnAgents = false;
  try {
    hasOwnAgents = fs.readdirSync(path.join(claudeDir, 'agents')).some((f) => f.endsWith('.md'));
  } catch (err) {
    // No agents folder yet: the user has no agents of their own.
    if (err.code !== 'ENOENT') throw err;
  }
  const items = listPack(packDir).map((i) => ({ ...i, installed: fs.existsSync(path.join(claudeDir, i.to)) }));
  return { claudeDir, hasOwnAgents, items };
}

// File by file, never replacing: the packaged app reads the pack from its
// asar archive, where plain reads work but folder copies may not.
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(path.join(from, entry.name), path.join(to, entry.name));
    else fs.writeFileSync(path.join(to, entry.name), fs.readFileSync(path.join(from, entry.name)), { flag: 'wx' });
  }
}

// Copies the named items. Anything already present is skipped, not
// replaced; a name not in the pack is refused.
function installPack(packDir, claudeDir, names) {
  const items = new Map(listPack(packDir).map((i) => [i.name, i]));
  const result = { installed: [], skipped: [], errors: [] };
  for (const name of names) {
    const item = items.get(name);
    if (!item) {
      result.errors.push(`"${String(name).slice(0, 40)}" is not in the office pack`);
      continue;
    }
    const target = path.join(claudeDir, item.to);
    if (fs.existsSync(target)) {
      result.skipped.push(name);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (item.kind === 'agent') fs.writeFileSync(target, fs.readFileSync(path.join(packDir, item.from)), { flag: 'wx' });
      else copyDir(path.join(packDir, item.from), target);
      result.installed.push(name);
    } catch (err) {
      result.errors.push(`${name} could not be added (${err.code || err.message})`);
    }
  }
  return result;
}

module.exports = { listPack, packStatus, installPack };
