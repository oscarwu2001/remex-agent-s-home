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
const MODE_FILE = 'hooks/agents-home-mode'; // "base" or "fast", read by the hook
const MODES = ['base', 'fast'];
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
  return { claudeDir, hasOwnAgents, items, mode: getMode(claudeDir) };
}

// Team speed: base (reminders only when a request fits a helper) or fast
// (also asks Claude to run independent parts in parallel, spending more
// tokens to finish sooner).
function getMode(claudeDir) {
  try {
    const m = fs.readFileSync(path.join(claudeDir, MODE_FILE), 'utf8').trim();
    return MODES.includes(m) ? m : 'base';
  } catch (err) {
    if (err.code === 'ENOENT') return 'base'; // never set: the default
    throw err;
  }
}

// Sets the speed; fast needs the reminders, so it turns them on if needed.
function setMode(packDir, claudeDir, mode) {
  if (!MODES.includes(mode)) throw new RangeError(`unknown team speed "${String(mode).slice(0, 20)}"`);
  const result = { mode, remindersAdded: false, errors: [] };
  if (mode === 'fast' && !hookIsOn(claudeDir)) {
    const res = installPack(packDir, claudeDir, ['team-reminders']);
    result.remindersAdded = res.installed.length > 0;
    result.errors.push(...res.errors);
    if (res.errors.length) return result;
  }
  fs.mkdirSync(path.join(claudeDir, 'hooks'), { recursive: true });
  replaceFile(path.join(claudeDir, MODE_FILE), `${mode}\n`);
  return result;
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
        if (!fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(path.join(packDir, item.from)), { flag: 'wx' });
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
function updatePack(packDir, claudeDir, versions) {
  const result = { updated: [], added: [], edited: [], upToDate: [], errors: [] };
  const known = (rel, text) => (versions[rel] ?? []).includes(fingerprint(text));
  const files = packFiles(packDir);
  const missing = [];
  for (const item of listPack(packDir)) {
    const target = path.join(claudeDir, item.to);
    if (!fs.existsSync(target) || (item.kind === 'hook' && !hookIsOn(claudeDir))) {
      missing.push(item.name);
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
        const fresh = fs.readFileSync(path.join(packDir, rel), 'utf8');
        if (!fs.existsSync(dest)) {
          writes.push([dest, fresh]);
          continue;
        }
        const now = fs.readFileSync(dest, 'utf8');
        if (fingerprint(now) === fingerprint(fresh)) continue;
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
  if (missing.length) {
    const res = installPack(packDir, claudeDir, missing);
    result.added.push(...res.installed);
    result.errors.push(...res.errors);
  }
  return result;
}

module.exports = { listPack, packStatus, installPack, updatePack, getMode, setMode, fingerprint, packFiles, HOOK_FILE, MODE_FILE };
