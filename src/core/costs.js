'use strict';

// What the performance report needs to drive cost fixes: where
// general-purpose helpers go and which could have been a cheaper typed
// agent, token counts by type with a cost weighting, skills loaded inside
// helpers, where each skill comes from, and before/after a change.
// Pure apart from readSkillSources, which only reads the skills folders.

const fs = require('fs');
const path = require('path');
const { totalTokens, COST_WEIGHTS, weighted } = require('./metrics');

// The cost weighting (COST_WEIGHTS, weighted) lives in metrics.js, which
// scores efficiency on it; it is re-exported here for the report.

function quantile(sorted, q) {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const times = (runs) => runs.map((r) => r.durationMs).filter((d) => d !== undefined).sort((a, b) => a - b);

// ---- "could have been typed" ----------------------------------------------------

// Which typed agent a run's tool mix looks like (70% or more), or nothing:
//   mostly Read/Grep/Glob and no edits -> Explore
//   mostly WebFetch/WebSearch          -> researcher
//   mostly Bash and no edits           -> runner
const MOSTLY = 0.7;
function typedAgentFor(tools = {}) {
  const n = (k) => tools[k] ?? 0;
  // Shares of the eight working tools only: loading a skill or writing a
  // to-do list says nothing about which agent the work needed.
  const total = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write'].reduce((a, k) => a + n(k), 0);
  if (!total) return undefined;
  const edits = n('Edit') + n('Write');
  if ((n('WebFetch') + n('WebSearch')) / total >= MOSTLY) return 'researcher';
  if (edits) return undefined;
  if ((n('Read') + n('Grep') + n('Glob')) / total >= MOSTLY) return 'Explore';
  if (n('Bash') / total >= MOSTLY) return 'runner';
  return undefined;
}

// ---- where general-purpose goes -------------------------------------------------

function generalPurpose(runs, { top = 10 } = {}) {
  const gp = runs.filter((r) => r.type === 'general-purpose');
  const all = gp.reduce((n, r) => n + totalTokens(r.tokens), 0);
  const share = (t) => (all ? t / all : undefined);
  const group = (keyFn) => {
    const m = new Map();
    for (const r of gp) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const byCaller = [...group((r) => r.caller ?? 'direct')].map(([caller, list]) => {
    const tokens = list.reduce((n, r) => n + totalTokens(r.tokens), 0);
    const t = times(list);
    return {
      caller, runs: list.length, tokens, weighted: list.reduce((n, r) => n + weighted(r.tokens), 0), share: share(tokens),
      medianMs: quantile(t, 0.5), p90Ms: quantile(t, 0.9), background: list.filter((r) => r.mode === 'background').length,
    };
  }).sort((a, b) => b.tokens - a.tokens);
  const flags = [...group((r) => typedAgentFor(r.tools) ?? 'none')].map(([flag, list]) => {
    const tokens = list.reduce((n, r) => n + totalTokens(r.tokens), 0);
    return { flag, runs: list.length, tokens, share: share(tokens) };
  }).sort((a, b) => (a.flag === 'none') - (b.flag === 'none') || b.tokens - a.tokens);
  const expensive = [...gp].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)).slice(0, top)
    .map((r) => ({ ...r, flag: typedAgentFor(r.tools) }));
  return { runs: gp.length, tokens: all, byCaller, flags, expensive };
}

// ---- tokens by type and timing by mode ------------------------------------------

function tokensByAgent(runs, unattributed = []) {
  const rows = new Map();
  const add = (name, t) => {
    const row = rows.get(name) ?? { name, runs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    row.runs += 1;
    for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) row[k] += t[k] ?? 0;
    rows.set(name, row);
  };
  for (const r of runs) add(r.type, r.tokens);
  const list = [...rows.values()];
  // Helper transcripts that match no call still cost tokens: one row, last.
  if (unattributed.length) {
    const row = { name: 'unattributed', runs: unattributed.length, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unattributed: true };
    for (const u of unattributed) for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) row[k] += u.tokens[k] ?? 0;
    list.push(row);
  }
  for (const row of list) {
    row.total = totalTokens(row);
    row.weighted = weighted(row);
  }
  return list.sort((a, b) => (a.unattributed === true) - (b.unattributed === true) || b.weighted - a.weighted);
}

function timingByMode(runs) {
  const out = new Map();
  for (const r of runs) {
    const row = out.get(r.type) ?? { type: r.type, foreground: [], background: [], noEnd: 0 };
    if (r.durationMs === undefined) row.noEnd += 1;
    else row[r.mode === 'background' ? 'background' : 'foreground'].push(r.durationMs);
    out.set(r.type, row);
  }
  return [...out.values()].map((row) => {
    const sum = (list) => {
      const s = [...list].sort((a, b) => a - b);
      return { runs: s.length, medianMs: quantile(s, 0.5), p90Ms: quantile(s, 0.9) };
    };
    return { type: row.type, foreground: sum(row.foreground), background: sum(row.background), noEnd: row.noEnd };
  }).sort((a, b) => a.type.localeCompare(b.type));
}

// ---- skills: names, sources, sizes, loads inside helpers ------------------------

// "mattpocock-skills:tdd" and "tdd" are the same skill.
const baseSkill = (name) => String(name).split(':').pop();
const pluginOf = (name) => (String(name).includes(':') ? String(name).split(':')[0] : undefined);
const VERSIONISH = /^(v?\d+(\.\d+)*([-.+][\w.]+)?|latest|[0-9a-f]{7,40})$/i;

// Every installed skill and where it comes from: the user's own folder
// (local), a plugin, or a project's .claude folder. Read only.
function readSkillSources({ claudeDirs = [], cwds = [], enabledPlugins = [] } = {}) {
  const found = [];
  const problems = [];
  const enabled = new Set(enabledPlugins.map((p) => String(p).split('@')[0]));
  const add = (name, source, owner, file) => {
    let bytes;
    try {
      bytes = fs.statSync(file).size;
    } catch (err) {
      problems.push(`A skill could not be measured (${err.code})`);
    }
    found.push({ name, source, owner, bytes, enabled: source !== 'plugin' || enabled.has(owner) });
  };
  const listDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => {
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        // A skill folder linked in from elsewhere counts too.
        try {
          return fs.statSync(path.join(dir, d.name)).isDirectory();
        } catch (err) {
          problems.push(`A linked skill folder could not be followed (${err.code})`);
          return false;
        }
      }).map((d) => d.name);
    } catch (err) {
      // Most folders have no skills folder: that is normal.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') problems.push(`A skills folder could not be listed (${err.code})`);
      return [];
    }
  };
  const skillsIn = (dir, source, owner) => {
    for (const name of listDirs(dir)) {
      const file = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(file)) add(name, source, owner, file);
    }
  };
  for (const base of claudeDirs) {
    skillsIn(path.join(base, 'skills'), 'local', 'you');
    // Plugins: any skills/<name>/SKILL.md under plugins/, named after the
    // folder holding skills/ (or its parent, when that is a version folder).
    const seen = new Set();
    const walk = (dir, depth) => {
      if (depth > 6) return;
      for (const sub of listDirs(dir)) {
        const full = path.join(dir, sub);
        if (sub === 'skills') {
          const holder = path.basename(dir);
          const plugin = VERSIONISH.test(holder) ? path.basename(path.dirname(dir)) : holder;
          for (const name of listDirs(full)) {
            const file = path.join(full, name, 'SKILL.md');
            if (!fs.existsSync(file) || seen.has(`${plugin}:${name}`)) continue;
            seen.add(`${plugin}:${name}`);
            add(name, 'plugin', plugin, file);
          }
        } else if (!sub.startsWith('.') && sub !== 'node_modules') walk(full, depth + 1);
      }
    };
    walk(path.join(base, 'plugins'), 0);
  }
  for (const cwd of cwds) skillsIn(path.join(cwd, '.claude', 'skills'), 'project', path.basename(cwd.replace(/\\/g, '/')));
  return { skills: found, problems };
}

// One row per skill name: its sources, and whether it is installed twice.
// A disabled plugin is listed but cannot make a duplicate.
function skillSourceRows(sources) {
  const rows = new Map();
  for (const s of sources) {
    const row = rows.get(s.name) ?? { name: s.name, sources: [] };
    row.sources.push(s);
    rows.set(s.name, row);
  }
  return [...rows.values()].map((row) => {
    const live = new Set(row.sources.filter((s) => s.enabled).map((s) => `${s.source}:${s.owner}`));
    return { ...row, duplicate: live.size > 1 };
  }).sort((a, b) => b.duplicate - a.duplicate || a.name.localeCompare(b.name));
}

// The size of the SKILL.md a load would read: the plugin named in the load,
// else the user's own, else a project's, else an enabled plugin's.
function skillSize(name, sources) {
  const base = baseSkill(name);
  const plugin = pluginOf(name);
  const cands = sources.filter((s) => s.name === base);
  const pick = (plugin && cands.find((s) => s.source === 'plugin' && s.owner === plugin))
    ?? cands.find((s) => s.source === 'local') ?? cands.find((s) => s.source === 'project')
    ?? cands.find((s) => s.source === 'plugin' && s.enabled) ?? cands[0];
  return pick?.bytes;
}

// Skill loads inside helpers, per agent and skill, optionally split at a date.
function skillLoadsInHelpers(runs, unattributed, sources, splitAt) {
  const rows = new Map();
  const add = (agent, name, start) => {
    const skill = baseSkill(name);
    const k = `${agent}\u0000${skill}`;
    const row = rows.get(k) ?? { agent, skill, loads: 0, before: 0, after: 0, bytesEach: skillSize(name, sources) };
    row.loads += 1;
    if (splitAt !== undefined) row[start < splitAt ? 'before' : 'after'] += 1;
    rows.set(k, row);
  };
  for (const r of runs) for (const name of r.skillLoads ?? []) add(r.type, name, r.start);
  for (const u of unattributed) for (const name of u.skillLoads ?? []) add('unattributed', name, u.start);
  return [...rows.values()].map((row) => ({ ...row, bytes: row.bytesEach === undefined ? undefined : row.bytesEach * row.loads }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.loads - a.loads);
}

// ---- before / after ------------------------------------------------------------

function compareAt(runs, unattributed, at) {
  const halves = { before: runs.filter((r) => r.start < at), after: runs.filter((r) => r.start >= at) };
  const types = [...new Set(runs.map((r) => r.type))].sort();
  const sum = (list) => {
    const t = times(list);
    return {
      runs: list.length, tokens: list.reduce((n, r) => n + totalTokens(r.tokens), 0), weighted: list.reduce((n, r) => n + weighted(r.tokens), 0),
      medianMs: quantile(t, 0.5), skillLoads: list.reduce((n, r) => n + (r.skillLoads?.length ?? 0), 0),
    };
  };
  return {
    at,
    rows: types.map((type) => ({ type, before: sum(halves.before.filter((r) => r.type === type)), after: sum(halves.after.filter((r) => r.type === type)) })),
    unattributed: { before: unattributed.filter((u) => u.start < at).length, after: unattributed.filter((u) => u.start >= at).length },
  };
}

module.exports = {
  COST_WEIGHTS, weighted, typedAgentFor, generalPurpose, tokensByAgent, timingByMode,
  baseSkill, readSkillSources, skillSourceRows, skillSize, skillLoadsInHelpers, compareAt,
};
