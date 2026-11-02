'use strict';

// The Office pack (office-pack/ in this repo): a small team of Claude Code
// agents and skills, for office work and for coding, plus an optional
// reminder hook. This module lists it, sees what is already in the user's
// Claude folder, and copies in only what the user chose. It is the one thing
// the app ever writes under ~/.claude, only when the user says yes:
// - new files into agents/, skills/ and hooks/, never over one that is there;
// - "Update agents" replaces a pack file only when it is exactly as some
//   version of the pack shipped it (office-pack/versions.json), so a file the
//   user edited is never touched;
// - the reminder hook adds one entry to settings.json, after keeping a copy
//   of the file, and changes nothing else in it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFrontmatter } = require('./roster');

const HOOK_FILE = 'hooks/agents-home-router.sh';
const HOOK_MARK = 'agents-home-router';

// Replaces a file whole: written next to it, then renamed over it, so it is
// never half-written. A symlink is followed (the link stays, its target is
// replaced), and a failed write removes its temporary file.
function replaceFile(file, data) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // a new file: written where asked
  }
  const tmp = `${target}.agents-home-tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to remove, or it cannot be removed: the first error is the one to report.
    }
    throw err;
  }
}

// A file's fingerprint, the same whatever its line endings.
function fingerprint(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);
}

// Every file of the pack that gets copied, relative and with / separators.
function packFiles(packDir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(packDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (rel) out.push(r); // top-level files (README, versions.json) are not copied
    }
  };
  walk('');
  return out.sort();
}

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
  if (fs.existsSync(path.join(packDir, HOOK_FILE))) {
    items.push({
      kind: 'hook', name: 'team-reminders',
      summary: 'Reminds Claude to hand work to the team when a request fits (adds one entry to settings.json)',
      from: HOOK_FILE, to: HOOK_FILE,
    });
  }
  return items.filter((i) => NAME.test(i.name));
}

// ---- the reminder hook's entry in settings.json ------------------------------------

const hookCommand = (claudeDir) => `bash "${path.join(claudeDir, HOOK_FILE).split(path.sep).join('/')}"`;

function readSettings(claudeDir) {
  const file = path.join(claudeDir, 'settings.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, settings: {}, existed: false };
    throw err;
  }
  const settings = text.trim() ? JSON.parse(text) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json is not a JSON object');
  return { file, settings, existed: true, text };
}

function hookIsOn(claudeDir) {
  try {
    const { settings } = readSettings(claudeDir);
    return JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes(HOOK_MARK);
  } catch {
    return false; // unreadable settings: shown as off; turning it on reports why
  }
}

// Adds the reminder hook to settings.json: a copy of the old file is kept
// (once) as settings.json.agents-home-backup; the file is written whole
// through a temporary file, so it is never left half-written.
function turnOnHook(claudeDir) {
  let read;
  try {
    read = readSettings(claudeDir);
  } catch (err) {
    throw new Error(`settings.json could not be read (${err.code || err.message}); it was left alone`);
  }
  const { file, settings, existed, text } = read;
  if (JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes(HOOK_MARK)) return false;
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('settings.json has a "hooks" entry the app does not understand; it was left alone');
  }
  const list = settings.hooks?.UserPromptSubmit ?? [];
  if (!Array.isArray(list)) throw new Error('settings.json has a UserPromptSubmit entry the app does not understand; it was left alone');
  settings.hooks = { ...(settings.hooks ?? {}), UserPromptSubmit: [...list, { hooks: [{ type: 'command', command: hookCommand(claudeDir), timeout: 5 }] }] };
  if (existed && !fs.existsSync(`${file}.agents-home-backup`)) fs.writeFileSync(`${file}.agents-home-backup`, text, { flag: 'wx' });
  replaceFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
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
  const items = listPack(packDir).map((i) => ({
    ...i,
    installed: fs.existsSync(path.join(claudeDir, i.to)) && (i.kind !== 'hook' || hookIsOn(claudeDir)),
  }));
  return { claudeDir, hasOwnAgents, items };
}

// A pack file's text as it should be installed. Shell scripts always get
// Unix line endings: a Windows checkout may hold them with CRLF, and bash
// (Git Bash included) cannot run a script with a carriage return on every line.
function packText(packDir, rel) {
  const text = fs.readFileSync(path.join(packDir, rel), 'utf8');
  return rel.endsWith('.sh') ? text.replace(/\r\n/g, '\n') : text;
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
    if (item.kind === 'hook') {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!fs.existsSync(target)) fs.writeFileSync(target, packText(packDir, item.from), { flag: 'wx' });
        if (turnOnHook(claudeDir)) result.installed.push(name);
        else result.skipped.push(name);
      } catch (err) {
        result.errors.push(`The team reminders could not be turned on: ${err.message}`);
      }
      continue;
    }
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

// "Update agents": brings the team up to date in one go. Pack files already
// installed are replaced with the new version only when they are exactly as
// some version of the pack shipped them; a file the user edited is left as
// it is and reported. A file new to an installed skill is added. Anything
// in the pack not yet in Claude is added (never over a file that is there),
// and the reminder hook is turned on.
// The user's own agents and skills: everything in ~/.claude/agents and
// skills whose name the pack does not use. Update agents only ever reads and
// writes the pack's own files, so these are never opened; they are counted
// so the app can say so.
function ownItems(packDir, claudeDir) {
  const pack = new Set(listPack(packDir).map((i) => i.to));
  const own = { agents: [], skills: [] };
  const names = (dir) => {
    try {
      return fs.readdirSync(path.join(claudeDir, dir), { withFileTypes: true });
    } catch (err) {
      // No such folder yet: nothing of the user's own there.
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  for (const e of names('agents')) if (e.name.endsWith('.md') && !pack.has(path.join('agents', e.name))) own.agents.push(e.name.slice(0, -3));
  for (const e of names('skills')) if (!e.name.startsWith('.') && !pack.has(path.join('skills', e.name))) own.skills.push(e.name);
  return own;
}

function updatePack(packDir, claudeDir, versions) {
  // Refreshes only what the user added. A helper they never added stays
  // out, and reminders they never turned on (or turned off) stay off: the
  // user's own pipeline is theirs. `added` stays empty; kept for callers.
  const result = { updated: [], added: [], edited: [], upToDate: [], notAdded: [], errors: [], own: { agents: [], skills: [] } };
  try {
    result.own = ownItems(packDir, claudeDir);
  } catch (err) {
    result.errors.push(`your own agents and skills could not be counted (${err.code || err.message}); they were still not touched`);
  }
  const known = (rel, text) => (versions[rel] ?? []).includes(fingerprint(text));
  const files = packFiles(packDir);
  for (const item of listPack(packDir)) {
    const target = path.join(claudeDir, item.to);
    if (!fs.existsSync(target) || (item.kind === 'hook' && !hookIsOn(claudeDir))) {
      result.notAdded.push(item.name);
      continue;
    }
    const mine = item.kind === 'skill' ? files.filter((f) => f.startsWith(`${item.from.split(path.sep).join('/')}/`)) : [item.from.split(path.sep).join('/')];
    // First look at every file of the item; only if none was edited by the
    // user is anything written, so an item is never left half old, half new.
    const writes = [];
    let edited = false;
    try {
      for (const rel of mine) {
        const dest = path.join(claudeDir, rel);
        const fresh = packText(packDir, rel);
        if (!fs.existsSync(dest)) {
          writes.push([dest, fresh]);
          continue;
        }
        const now = fs.readFileSync(dest, 'utf8');
        // The same text, unless it is a script installed with CRLF (which
        // bash cannot run): that one is rewritten with Unix line endings.
        if (fingerprint(now) === fingerprint(fresh) && !(rel.endsWith('.sh') && now.includes('\r'))) continue;
        if (!known(rel, now)) edited = true;
        else writes.push([dest, fresh]);
      }
    } catch (err) {
      result.errors.push(`${item.name} could not be read (${err.code || err.message})`);
      continue;
    }
    let changed = false;
    if (!edited) {
      try {
        for (const [dest, fresh] of writes) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          replaceFile(dest, fresh);
          changed = true;
        }
      } catch (err) {
        result.errors.push(`${item.name} could not be updated (${err.code || err.message})`);
        continue;
      }
    }
    if (edited) result.edited.push(item.name);
    else if (changed) result.updated.push(item.name);
    else result.upToDate.push(item.name);
  }
  return result;
}

module.exports = { listPack, packStatus, installPack, updatePack, ownItems, fingerprint, packFiles, HOOK_FILE };
