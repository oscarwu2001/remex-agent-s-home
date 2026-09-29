'use strict';

// How the team works together, from what the transcripts show happened:
// who called which agent, which skills ran and from where, the usual
// hand-off chains, and what is installed but never used. It reads no
// one's routing rules, so it fits any set-up. Names only; never prompts,
// descriptions or skill arguments.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./roster');

const YOU = 'You';
const MAX_CHAIN = 6;

// Installed agents and skills in the given .claude folders (read only).
function readInventory(claudeDirs) {
  const agents = new Set();
  const skills = new Set();
  const problems = [];
  const list = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A missing folder is normal: not everyone has agents or skills.
      if (err.code !== 'ENOENT') problems.push(`A folder of agents or skills could not be listed (${err.code})`);
      return [];
    }
  };
  for (const base of claudeDirs) {
    for (const d of list(path.join(base, 'agents'))) {
      if (!d.isFile() || !d.name.endsWith('.md')) continue;
      let name = d.name.slice(0, -3);
      try {
        name = parseFrontmatter(fs.readFileSync(path.join(base, 'agents', d.name), 'utf8'))?.name || name;
      } catch (err) {
        problems.push(`An agent definition could not be read (${err.code || 'error'})`);
      }
      agents.add(name);
    }
    for (const d of list(path.join(base, 'skills'))) {
      if (d.isDirectory() && fs.existsSync(path.join(base, 'skills', d.name, 'SKILL.md'))) skills.add(d.name);
    }
  }
  return { agents, skills, problems };
}

// Typed /commands that are Claude Code's own (/clear, /model...) are not
// skills. A typed name counts when it is an installed skill, a plugin skill
// (plugin:name), or a skill Claude also ran with the Skill tool.
function isSkill(name, inventory, calledByClaude) {
  return inventory.skills.has(name) || name.includes(':') || calledByClaude.has(name);
}

function teamwork({ runs, sessions, skills }, inventory = { agents: new Set(), skills: new Set() }) {
  const calledByClaude = new Set(skills.filter((u) => u.source !== 'typed').map((u) => u.name));
  const uses = skills.filter((u) => u.source !== 'typed' || isSkill(u.name, inventory, calledByClaude));

  // Flows: You -> agents and skills; agents -> the skills they used.
  const flows = new Map();
  const flow = (from, to, kind) => {
    const k = `${from}\u0000${to}\u0000${kind}`;
    flows.set(k, (flows.get(k) ?? 0) + 1);
  };
  for (const r of runs) flow(YOU, r.type, 'agent');
  for (const u of uses) flow(u.source === 'helper' ? u.by ?? 'a helper' : YOU, u.name, 'skill');
  const edges = [...flows].map(([k, count]) => {
    const [from, to, kind] = k.split('\u0000');
    return { from, to, kind, count };
  }).sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));

  // Per skill: who ran it and how often it ended in an error.
  const bySkill = new Map();
  for (const u of uses) {
    let s = bySkill.get(u.name);
    if (!s) {
      s = { name: u.name, uses: 0, typed: 0, byClaude: 0, byHelpers: new Map(), errors: 0, last: 0 };
      bySkill.set(u.name, s);
    }
    s.uses += 1;
    if (u.source === 'typed') s.typed += 1;
    else if (u.source === 'claude') s.byClaude += 1;
    else s.byHelpers.set(u.by ?? 'a helper', (s.byHelpers.get(u.by ?? 'a helper') ?? 0) + 1);
    if (u.isError) s.errors += 1;
    s.last = Math.max(s.last, u.ts ?? 0);
  }
  const skillRows = [...bySkill.values()]
    .map((s) => {
      // Typed commands have no result to fail; the rate covers tool calls only.
      const called = s.uses - s.typed;
      return { ...s, byHelpers: [...s.byHelpers].sort((a, b) => b[1] - a[1]), errorRate: called ? s.errors / called : undefined };
    })
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

  // Hand-off chains: each session's steps in order, repeats folded (x2),
  // cut at MAX_CHAIN steps. Only sessions with two or more steps.
  const label = (st) => (st.kind === 'agent'
    ? `${st.name}${st.verdict ? ` (${st.verdict})` : st.outcome === 'failed' || st.outcome === 'stopped' ? ` (${st.outcome})` : ''}`
    : `/${st.name}`);
  const chainCounts = new Map();
  let withSteps = 0;
  for (const s of sessions) {
    const steps = (s.steps ?? []).filter((st) => st.kind === 'agent' || uses.some((u) => u.name === st.name));
    if (!steps.length) continue;
    withSteps += 1;
    const folded = [];
    for (const st of steps) {
      const l = label(st);
      const last = folded.at(-1);
      if (last && last.label === l) last.n += 1;
      else folded.push({ label: l, n: 1 });
    }
    if (folded.length < 2) continue;
    const parts = folded.slice(0, MAX_CHAIN).map((f) => (f.n > 1 ? `${f.label} ×${f.n}` : f.label));
    const key = parts.join(' → ') + (folded.length > MAX_CHAIN ? ' → …' : '');
    chainCounts.set(key, (chainCounts.get(key) ?? 0) + 1);
  }
  const chains = [...chainCounts].map(([chain, count]) => ({ chain, count }))
    .sort((a, b) => b.count - a.count || a.chain.localeCompare(b.chain));

  // Installed and used: every installed agent and skill, and anything used
  // that is not installed here (built-in agents, plugin skills).
  const agentRuns = new Map();
  for (const r of runs) agentRuns.set(r.type, (agentRuns.get(r.type) ?? 0) + 1);
  const inventoryRows = [
    ...[...new Set([...inventory.agents, ...agentRuns.keys()])].map((name) => ({
      kind: 'agent', name, installed: inventory.agents.has(name), uses: agentRuns.get(name) ?? 0,
    })),
    ...[...new Set([...inventory.skills, ...bySkill.keys()])].map((name) => ({
      kind: 'skill', name, installed: inventory.skills.has(name), uses: bySkill.get(name)?.uses ?? 0,
    })),
  ].sort((a, b) => b.uses - a.uses || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return {
    edges, skillRows, chains, sessionsWithSteps: withSteps, inventoryRows,
    unused: inventoryRows.filter((r) => r.installed && r.uses === 0),
  };
}

module.exports = { teamwork, readInventory, YOU };
