'use strict';

// The verdict ledger, when the user keeps one: <.claude>/verdict-ledger/
// verdicts.tsv, written by a SubagentStop hook of their own, one row per
// review verdict, with the outcome they recorded for it later (a FAIL that
// was real, unverified or a false alarm; a PASS that missed a bug). The
// report reads it to show whether each review agent's verdicts held up.
// Read only, and counts only: project, session, commit and evidence columns
// are never kept.

const fs = require('fs');
const path = require('path');

const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'MISSING', 'UNREAD'];

// "2026-11-05T18:00:00+0800" (date's %z) as well as ISO 8601.
function timeOf(text) {
  const t = Date.parse(String(text).trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(t) ? t : undefined;
}

function emptyAgent() {
  return {
    rows: 0, PASS: 0, FAIL: 0, BLOCKED: 0, MISSING: 0, UNREAD: 0,
    real: 0, unverified: 0, falseAlarm: 0, open: 0, missed: 0,
  };
}

// claudeDirs: the folders that hold `projects` (and so maybe a ledger).
// Returns { found, agents: { name: counts }, problems }.
function readLedger(claudeDirs, { since = -Infinity, until = Infinity, fsys = fs } = {}) {
  const agents = {};
  const problems = [];
  let found = 0;
  for (const dir of [...new Set(claudeDirs)]) {
    const file = path.join(dir, 'verdict-ledger', 'verdicts.tsv');
    let text;
    try {
      text = fsys.readFileSync(file, 'utf8');
    } catch (err) {
      // No ledger is the usual case: only people who keep one have it.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') problems.push(`The verdict ledger could not be read (${err.code || 'error'})`);
      continue;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const head = (lines.shift() ?? '').split('\t');
    const col = (name) => head.indexOf(name);
    const [cT, cA, cV, cO] = [col('timestamp'), col('agent'), col('verdict'), col('outcome')];
    if (cT < 0 || cA < 0 || cV < 0) {
      problems.push('The verdict ledger has no timestamp, agent or verdict column, so it was not counted');
      continue;
    }
    found += 1;
    let odd = 0;
    for (const line of lines) {
      const f = line.split('\t');
      const t = timeOf(f[cT]);
      const agent = (f[cA] ?? '').trim();
      const verdict = (f[cV] ?? '').trim();
      if (t === undefined || !/^[A-Za-z0-9_.:-]{1,64}$/.test(agent) || !VERDICTS.includes(verdict)) {
        odd += 1;
        continue;
      }
      if (t < since || t > until) continue;
      const a = (agents[agent] ??= emptyAgent());
      a.rows += 1;
      a[verdict] += 1;
      const outcome = cO >= 0 ? (f[cO] ?? '').trim() : '';
      if (verdict === 'FAIL') {
        if (outcome === 'real') a.real += 1;
        else if (outcome === 'unverified') a.unverified += 1;
        else if (outcome === 'false-alarm') a.falseAlarm += 1;
        else a.open += 1;
      }
      if (verdict === 'PASS' && outcome === 'missed') a.missed += 1;
    }
    if (odd) problems.push(`${odd} row${odd === 1 ? '' : 's'} of the verdict ledger could not be read and ${odd === 1 ? 'was' : 'were'} skipped`);
  }
  return { found, agents, problems };
}

module.exports = { readLedger, timeOf };
