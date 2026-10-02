#!/usr/bin/env node
'use strict';

// Agent performance report: reads your Claude Code transcripts (read-only)
// and writes a self-contained HTML report plus CSV files. Run from the app
// (Settings > Performance report) or from the command line.
//
//   npm run report                                last 28 days
//   npm run report -- --days 7                    last 7 days
//   npm run report -- --since 2026-09-01 --until 2026-09-30
//   npm run report -- --compare 2026-09-24        before / after a change
//   npm run report -- --details                   show Agent-call descriptions
//   npm run report -- --out dir                   somewhere other than out/reports
//
// The report holds counts, durations, token numbers, names and one-word
// verdicts. It never holds results, file names, commands or project names
// (add --by-project for project names in runs.csv). Agent-call descriptions
// and the first line of a helper's prompt appear only with --details, the
// way privacy mode works in the app.

const fs = require('fs');
const path = require('path');
const { collect, rollUp, summarise, dayKey, totalTokens } = require('../core/metrics');
const { teamwork, readInventory, YOU } = require('../core/teamwork');
const costs = require('../core/costs');
const { execFileSync } = require('child_process');
const { defaultRoots } = require('../core/watcher');
const { roomFor, validateLayout, roomsWith, overridesFrom, validateOverrides } = require('../core/rooms');
const os = require('os');

// ---- arguments ---------------------------------------------------------------

function args(argv) {
  const opt = { days: 28, out: path.join(process.cwd(), 'out', 'reports'), byProject: false, roots: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') {
      opt.days = Number(argv[++i]);
      opt.daysGiven = true;
    }
    else if (a === '--out') opt.out = path.resolve(argv[++i]);
    else if (a === '--by-project') opt.byProject = true;
    else if (a === '--roots') opt.roots = JSON.parse(argv[++i]); // the app passes its own (WSL included)
    else if (a === '--json') opt.json = true; // one JSON line on stdout, for the app
    else if (a === '--stats-only') opt.statsOnly = true; // numbers per agent, no files (the creature screen)
    else if (a === '--since') opt.since = dateArg('--since', argv[++i]);
    else if (a === '--until') opt.until = endOfDay(dateArg('--until', argv[++i]));
    else if (a === '--compare') opt.compare = dateArg('--compare', argv[++i]);
    else if (a === '--details') opt.details = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  if (!Number.isInteger(opt.days) || opt.days < 1 || opt.days > 365) {
    throw new Error('--days must be a whole number from 1 to 365');
  }
  if (opt.until !== undefined && opt.since === undefined) throw new Error('--until needs --since');
  if (opt.since !== undefined && opt.daysGiven) throw new Error('use either --days or --since, not both');
  if (opt.since !== undefined) {
    const until = opt.until ?? Date.now();
    if (until < opt.since) throw new Error('--until is before --since');
    opt.days = Math.max(1, Math.round((new Date(until).setHours(0, 0, 0, 0) - opt.since) / 86_400_000) + 1);
    if (opt.days > 366) throw new Error('--since and --until may be at most a year apart');
  }
  return opt;
}

// YYYY-MM-DD, as local midnight.
function dateArg(name, value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
  // 2026-02-31 must not quietly become 3 March.
  if (!d || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new Error(`${name} needs a real date like 2026-09-24`);
  }
  return d.getTime();
}

// The last moment of a day, whatever its length (summer-time changes).
function endOfDay(t) {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime() - 1;
}

// Which machine and set-up a report comes from: two laptops can have the
// same transcripts layout but different agents, skills and plugins.
function machineInfo(claudeDirs) {
  const dirs = claudeDirs.map((dir) => {
    let commit;
    try {
      commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      commit = undefined; // not a git folder, or git is not installed: shown as such
    }
    let plugins = [];
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      plugins = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([name]) => name).sort();
    } catch {
      plugins = []; // no settings.json, or unreadable: no plugins named
    }
    return { dir, commit, plugins };
  });
  return { host: os.hostname(), dirs };
}

// ---- formatting ----------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
const num = (x, d = 0) => (x === undefined ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d }));

function dur(ms) {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function compact(n) {
  if (n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

// The app's own settings folder (Electron's userData for "Agents Home"), so
// the report puts agents in the same rooms the app does.
function appDataDir() {
  const name = 'Agents Home';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

function readJson(file, problems) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(`${path.basename(file)} could not be read, so the default rooms are used`);
    return undefined;
  }
}

function roomSetup(problems) {
  const dir = appDataDir();
  let layout = { departments: [] };
  try {
    layout = validateLayout(readJson(path.join(dir, 'layout.json'), problems));
  } catch (err) {
    problems.push(`layout.json ignored: ${err.message}`);
  }
  const rooms = roomsWith(layout);
  let fromFile = {};
  try {
    fromFile = validateOverrides(readJson(path.join(dir, 'rooms.json'), problems), new Set(rooms.map((r) => r.id)));
  } catch (err) {
    problems.push(`rooms.json ignored: ${err.message}`);
  }
  return { names: Object.fromEntries(rooms.map((r) => [r.id, r.name])), overrides: { ...overridesFrom(layout), ...fromFile } };
}
let roomName = {};
let roomOverrides = {};

// Categorical slots, in fixed order, light and dark steps (validated set).
const SERIES = [
  ['#2a78d6', '#3987e5'], ['#eb6834', '#d95926'], ['#1baf7a', '#199e70'], ['#eda100', '#c98500'],
  ['#e87ba4', '#d55181'], ['#008300', '#008300'], ['#4a3aa7', '#9085e9'],
];
const OTHER = ['#a3a29c', '#6f6e69'];

// ---- charts (inline SVG, no libraries) ----------------------------------------

// Runs per day, stacked by agent type. Colour follows the agent, not its rank.
function dailyColumns(days, daily, typeSlot) {
  const W = 760;
  const H = 220;
  const pad = { l: 36, r: 8, t: 10, b: 28 };
  const byDay = new Map(days.map((d) => [d, []]));
  for (const row of daily) if (byDay.has(row.period)) byDay.get(row.period).push(row);
  const max = Math.max(1, ...[...byDay.values()].map((rows) => rows.reduce((k, r) => k + r.runs, 0)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bandW = (W - pad.l - pad.r) / days.length;
  const barW = Math.min(24, bandW * 0.7);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  let s = '';
  for (let v = 0; v <= top; v += step) {
    s += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  days.forEach((d, i) => {
    const x = pad.l + bandW * i + (bandW - barW) / 2;
    let base = 0;
    const rows = byDay.get(d).sort((a, b) => typeSlot(a.type) - typeSlot(b.type));
    rows.forEach((r, k) => {
      const y0 = y(base);
      const y1 = y(base + r.runs);
      const isTop = k === rows.length - 1;
      const h = Math.max(0, y0 - y1 - (k ? 2 : 0)); // 2px surface gap between segments
      const yTop = y1;
      s += `<path class="mark s${typeSlot(r.type)}" d="${barPath(x, yTop, barW, h, isTop)}"><title>${esc(r.type)} · ${d}: ${r.runs} run${r.runs === 1 ? '' : 's'}</title></path>`;
      base += r.runs;
    });
    if (days.length <= 14 || i % Math.ceil(days.length / 14) === 0) {
      s += `<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });
  s += `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Helper runs per day, stacked by agent">${s}</svg>`;
}

// Column with a 4px rounded top when it is the top segment, square base.
function barPath(x, y, w, h, roundTop) {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
}

// Median to p90 duration per agent: one hue, a dot at the median.
function durationRanges(types, overall) {
  const rows = types.filter((t) => overall[t].medianMs !== undefined);
  if (!rows.length) return '<p class="muted">No finished runs yet.</p>';
  const W = 760;
  const rowH = 30;
  const pad = { l: 170, r: 170, t: 8, b: 26 };
  const H = pad.t + pad.b + rows.length * rowH;
  const longest = Math.max(...rows.map((t) => overall[t].p90Ms ?? overall[t].medianMs));
  // Ticks on round durations: 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h…
  const tick = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((v) => v * 1000)
    .find((v) => longest / v <= 5) ?? 14_400_000;
  const max = Math.ceil(longest / tick) * tick;
  const x = (ms) => pad.l + (W - pad.l - pad.r) * (ms / max);
  let s = '';
  for (let v = 0; v <= max; v += tick) {
    s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    s += `<text class="tick" x="${x(v)}" y="${H - 8}" text-anchor="middle">${dur(v)}</text>`;
  }
  rows.forEach((t, i) => {
    const o = overall[t];
    const cy = pad.t + rowH * i + rowH / 2;
    s += `<text class="label" x="${pad.l - 10}" y="${cy + 4}" text-anchor="end">${esc(t)}</text>`;
    if (o.p90Ms !== undefined) s += `<line class="range" x1="${x(o.medianMs)}" x2="${x(o.p90Ms)}" y1="${cy}" y2="${cy}"/>`;
    s += `<circle class="dot" cx="${x(o.medianMs)}" cy="${cy}" r="5"><title>${esc(t)}: median ${dur(o.medianMs)}, p90 ${dur(o.p90Ms)}</title></circle>`;
    s += `<text class="value" x="${x(o.p90Ms ?? o.medianMs) + 10}" y="${cy + 4}">${dur(o.medianMs)} median · ${dur(o.p90Ms)} p90</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Median and 90th percentile run time per agent">${s}</svg>`;
}

// Weekly score per agent: lines, one colour per agent, labelled at the end.
function weeklyScores(weekly, typeSlot) {
  const weeks = [...new Set(weekly.map((r) => r.period))].sort();
  const series = new Map();
  for (const r of weekly) {
    if (r.score.value === undefined) continue;
    if (!series.has(r.type)) series.set(r.type, []);
    series.get(r.type).push(r);
  }
  if (!series.size) return `<p class="muted">Scores appear once an agent has ${3} runs in a week.</p>`;
  const W = 760;
  const H = 260;
  const pad = { l: 36, r: 190, t: 12, b: 28 };
  // The axis spans the scores actually seen (in steps of 10), so close lines
  // separate; the ticks say where it starts.
  const values = [...series.values()].flat().map((r) => r.score.value);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10);
  const x = (w) => pad.l + (weeks.length === 1 ? (W - pad.l - pad.r) / 2 : ((W - pad.l - pad.r) * weeks.indexOf(w)) / (weeks.length - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (100 - lo));
  let s = '';
  for (let v = lo; v <= 100; v += lo >= 60 ? 10 : 20) {
    s += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  weeks.forEach((w) => { s += `<text class="tick" x="${x(w)}" y="${H - 8}" text-anchor="middle">${w.slice(5)}</text>`; });
  const ends = [];
  for (const [type, rows] of series) {
    const slot = typeSlot(type);
    const pts = rows.sort((a, b) => a.period.localeCompare(b.period)).map((r) => [x(r.period), y(r.score.value), r]);
    if (pts.length > 1) s += `<polyline class="line s${slot}" points="${pts.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`;
    for (const [px, py, r] of pts) {
      s += `<circle class="pt s${slot}" cx="${px}" cy="${py}" r="4"><title>${esc(type)} · ${r.period}: ${r.score.value} (${r.runs} runs)</title></circle>`;
    }
    const last = pts[pts.length - 1];
    ends.push({ type, y: last[1], x: last[0], slot, value: last[2].score.value });
  }
  // End labels in text ink, spread so they never overlap.
  ends.sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const e of ends) {
    const ly = Math.max(e.y, prev + 14);
    prev = ly;
    s += `<line class="leader" x1="${e.x + 6}" y1="${e.y}" x2="${W - pad.r + 8}" y2="${ly}"/>`;
    s += `<rect class="mark s${e.slot}" x="${W - pad.r + 12}" y="${ly - 5}" width="10" height="10" rx="3"/>`;
    s += `<text class="label" x="${W - pad.r + 28}" y="${ly + 4}">${esc(e.type)} ${e.value}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly score per agent">${s}</svg>`;
}

function sparkline(values) {
  const W = 84;
  const H = 22;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(W * i) / Math.max(1, values.length - 1)},${H - 2 - ((H - 4) * v) / max}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts.join(' ')}"/></svg>`;
}

// ---- page --------------------------------------------------------------------

function kpi(label, value, delta) {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${delta ? `<div class="tile-delta">${delta}</div>` : ''}</div>`;
}

// The models an agent ran on, most-used first: "sonnet-5-5 ×5, opus-5-5 ×2".
// Only names; a run with no model on record is left out.
function modelsText(models) {
  const list = Object.entries(models ?? {}).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '—';
  const short = (m) => m.replace(/^claude-/, '');
  return list.length === 1 ? short(list[0][0]) : list.map(([m, n]) => `${short(m)} ×${n}`).join(', ');
}

function deltaText(now, before, fmt, upIsGood = true) {
  if (now === undefined || before === undefined) return 'no earlier period to compare';
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return 'same as the period before';
  const good = diff > 0 === upIsGood;
  return `<span class="${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))}, ${good ? 'better' : 'worse'}</span> than the period before`;
}

// Who called whom: You on the left, the agents and skills you (or Claude
// for you) called in the middle, and the skills those agents ran on the
// right. Line width is the number of calls; every node carries its name and
// count, and the tables below hold the same numbers.
function flowChart(team) {
  const FIRST = 12;
  const fromYou = team.edges.filter((e) => e.from === YOU);
  if (!fromYou.length) return '<p class="muted">No agents or skills were called in this period.</p>';
  const shown = fromYou.slice(0, FIRST);
  const rest = fromYou.slice(FIRST);
  const middle = [...shown.map((e) => ({ name: e.to, kind: e.kind, count: e.count }))];
  if (rest.length) middle.push({ name: `${rest.length} more`, kind: 'more', count: rest.reduce((a, e) => a + e.count, 0) });
  const agentsShown = new Set(shown.filter((e) => e.kind === 'agent').map((e) => e.to));
  const inner = team.edges.filter((e) => e.from !== YOU && agentsShown.has(e.from)).slice(0, FIRST);
  const right = [...new Set(inner.map((e) => e.to))];

  const ROW = 34;
  const NODE_H = 26;
  const rows = Math.max(middle.length, right.length, 1);
  const H = rows * ROW + 16;
  const W = 960;
  const col = [16, 330, 690];
  const NODE_W = [120, 230, 230];
  const max = Math.max(...team.edges.map((e) => e.count));
  const width = (n) => 1.5 + 12 * Math.sqrt(n / max);
  const yMid = (i, n) => 8 + (H - 16 - n * ROW) / 2 + i * ROW + ROW / 2;
  const youY = H / 2;
  const midY = new Map(middle.map((m, i) => [m.name, yMid(i, middle.length)]));
  const rightY = new Map(right.map((r, i) => [r, yMid(i, right.length)]));
  const link = (x1, y1, x2, y2, n, title) => {
    const mx = (x1 + x2) / 2;
    return `<path class="flow" d="M${x1},${y1.toFixed(1)} C${mx},${y1.toFixed(1)} ${mx},${y2.toFixed(1)} ${x2},${y2.toFixed(1)}" stroke-width="${width(n).toFixed(1)}"><title>${esc(title)}</title></path>`;
  };
  const node = (x, y, w, text, kind, title) => `<g class="node ${kind}"><title>${esc(title)}</title>
    <rect x="${x}" y="${(y - NODE_H / 2).toFixed(1)}" width="${w}" height="${NODE_H}" rx="${kind === 'skill' ? 4 : 13}"/>
    <text class="label" x="${x + 10}" y="${(y + 4).toFixed(1)}">${esc(text)}</text></g>`;
  let links = '';
  for (const m of middle) links += link(col[0] + NODE_W[0], youY, col[1], midY.get(m.name), m.count, `You → ${m.name}: ${m.count}`);
  for (const e of inner) links += link(col[1] + NODE_W[1], midY.get(e.from), col[2], rightY.get(e.to), e.count, `${e.from} → /${e.to}: ${e.count}`);
  const nodes = [
    node(col[0], youY, NODE_W[0], 'You', 'you', 'Your sessions (you, or Claude working for you)'),
    ...middle.map((m) => node(col[1], midY.get(m.name), NODE_W[1],
      `${m.kind === 'skill' ? '/' : ''}${m.name} · ${m.count}`, m.kind, `${m.kind === 'agent' ? 'Agent' : m.kind === 'skill' ? 'Skill' : 'Others'}: ${m.count} call${m.count === 1 ? '' : 's'}`)),
    ...right.map((r) => node(col[2], rightY.get(r), NODE_W[2], `/${r} · ${inner.filter((e) => e.to === r).reduce((a, e) => a + e.count, 0)}`, 'skill', 'Skill run inside an agent')),
  ].join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Who called whom: you, the agents and skills you called, and the skills those agents used">${links}${nodes}</svg>`;
}

function teamSection(team, opt) {
  const chains = team.chains.slice(0, 8).map((c) => `<tr><td>${esc(c.chain)}</td><td class="num">${c.count}</td></tr>`).join('');
  const skills = team.skillRows.map((r) => `<tr><th scope="row">/${esc(r.name)}</th><td class="num">${r.uses}</td><td class="num">${r.typed || '—'}</td>
    <td class="num">${r.byClaude || '—'}</td><td>${r.byHelpers.length ? esc(r.byHelpers.map(([a, n]) => `${a} ${n}`).join(', ')) : '—'}</td>
    <td class="num">${pct(r.errorRate)}</td></tr>`).join('');
  const unusedOf = (kind) => team.unused.filter((r) => r.kind === kind).map((r) => `${kind === 'skill' ? '/' : ''}${esc(r.name)}`).join(', ');
  const unusedAgents = unusedOf('agent');
  const unusedSkills = unusedOf('skill');
  return `<section class="card">
    <h2>How your team works together</h2>
    <p class="muted">From what the transcripts show happened, not from anyone's routing rules, so it fits any set-up. Rounded boxes are agents, square ones skills; line width is the number of calls. Hover for the numbers.</p>
    ${flowChart(team)}
    <h3>Usual hand-off chains</h3>
    <p class="muted">The agents and skills each session used, in order. Repeats are folded (×2); a verdict or a failure is shown in brackets.${team.sessionsWithSteps ? ` ${team.sessionsWithSteps} session${team.sessionsWithSteps === 1 ? '' : 's'} used at least one.` : ''}</p>
    <table><thead><tr><th>Chain</th><th class="num">Sessions</th></tr></thead>
      <tbody>${chains || '<tr><td colspan="2" class="muted">No session used two or more steps.</td></tr>'}</tbody></table>
    <h3>Skills</h3>
    <table><thead><tr><th>Skill</th><th class="num">Uses</th><th class="num">Typed by you</th><th class="num">Picked by Claude</th>
      <th>Inside agents</th><th class="num">Errors</th></tr></thead>
      <tbody>${skills || '<tr><td colspan="6" class="muted">No skills were used in this period.</td></tr>'}</tbody></table>
    <h3>Installed, not used in these ${opt.days} days</h3>
    ${unusedAgents || unusedSkills
    ? `<dl class="score">${unusedAgents ? `<dt>Agents</dt><dd>${unusedAgents}</dd>` : ''}${unusedSkills ? `<dt>Skills</dt><dd>${unusedSkills}</dd>` : ''}</dl>
       <p class="muted">Worth a look: an agent or skill nobody calls may have a description that never matches, or may no longer be needed.</p>`
    : '<p class="muted">Everything installed was used.</p>'}
  </section>`;
}

// ---- the cost sections ----------------------------------------------------------

const k = (n) => (n === undefined ? '—' : compact(Math.round(n)));
const bytes = (n) => (n === undefined ? '—' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

// A path shown with the home folder as ~, so the report does not name the user.
const tilde = (p) => {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : `…${path.sep}${path.basename(p)}`;
};

function machineLine(machine) {
  const dirs = machine.dirs.map((d) => `${esc(tilde(d.dir))} at <code>${d.commit ? esc(d.commit) : 'not a git folder'}</code>${d.plugins.length
    ? `, plugins: ${d.plugins.map(esc).join(', ')}` : ', no plugins enabled'}`).join(' · ');
  return `<p class="sub">Machine <strong>${esc(machine.host)}</strong> · ${dirs}</p>`;
}

function costSections({ cost, opt, stats, days }) {
  const gp = cost.gp;
  const callerRows = gp.byCaller.map((c) => `<tr><th scope="row">${esc(c.caller)}</th><td class="num">${c.runs}</td>
    <td class="num">${k(c.tokens)}</td><td class="num">${pct(c.share)}</td><td class="num">${k(c.weighted)}</td>
    <td class="num">${dur(c.medianMs)}</td><td class="num">${dur(c.p90Ms)}</td><td class="num">${c.background || '—'}</td></tr>`).join('');
  const flagName = { Explore: 'Explore (mostly Read/Grep/Glob, no edits)', researcher: 'researcher (mostly WebFetch/WebSearch)', runner: 'runner (mostly Bash, no edits)', none: 'needs general-purpose (mixed, or edits)' };
  const flagRows = gp.flags.map((f) => `<tr><th scope="row">${esc(flagName[f.flag] ?? f.flag)}</th><td class="num">${f.runs}</td>
    <td class="num">${k(f.tokens)}</td><td class="num">${pct(f.share)}</td></tr>`).join('');
  const what = (r) => (opt.details
    ? `${esc(r.description || '—')}${r.promptLine ? `<div class="muted small">${esc(r.promptLine)}</div>` : ''}`
    : '<span class="muted">hidden (add --details, or turn privacy mode off in the app)</span>');
  const topRows = gp.expensive.map((r) => `<tr><td>${what(r)}</td><td>${esc(r.caller)}</td><td>${esc(r.mode)}</td><td>${esc(r.model ?? '—')}</td>
    <td class="num">${k(totalTokens(r.tokens))}</td><td class="num">${k(costs.weighted(r.tokens))}</td><td class="num">${dur(r.durationMs)}</td>
    <td>${r.flag ? esc(r.flag) : '—'}</td></tr>`).join('');

  const tokenRows = cost.tokens.map((t) => `<tr${t.unattributed ? ' class="muted-row"' : ''}><th scope="row">${esc(t.name)}</th><td class="num">${t.runs}</td>
    <td class="num">${k(t.input)}</td><td class="num">${k(t.cacheWrite)}</td><td class="num">${k(t.cacheRead)}</td><td class="num">${k(t.output)}</td>
    <td class="num">${k(t.total)}</td><td class="num"><strong>${k(t.weighted)}</strong></td></tr>`).join('');
  const matched = stats.matchedByAgentId + stats.matchedByPrompt;
  const reconcile = `${stats.helperTranscripts} helper transcript${stats.helperTranscripts === 1 ? '' : 's'} read in all: ${stats.matchedByAgentId} matched by agent id,
    ${stats.matchedByPrompt} by prompt, ${stats.helperTranscripts - matched} unattributed (${cost.unattributed.length} of them in this period, in the row above).`;

  const tm = (x) => (x.runs ? `${dur(x.medianMs)} / ${dur(x.p90Ms)} <span class="muted">(${x.runs})</span>` : '—');
  const timingRows = cost.timing.map((t) => `<tr><th scope="row">${esc(t.type)}</th><td class="num">${tm(t.foreground)}</td>
    <td class="num">${tm(t.background)}</td><td class="num">${t.noEnd || '—'}</td></tr>`).join('');

  const split = opt.compare !== undefined;
  // Big skills (20 KB or more each) stand out: they are the costly loads.
  const loadRows = cost.loads.map((l) => `<tr${(l.bytesEach ?? 0) >= 20 * 1024 ? ' class="hl"' : ''}><th scope="row">${esc(l.agent)}</th><td>${esc(l.skill)}</td>
    <td class="num">${l.loads}</td>${split ? `<td class="num">${l.before}</td><td class="num">${l.after}</td>` : ''}
    <td class="num">${bytes(l.bytesEach)}</td><td class="num">${bytes(l.bytes)}</td></tr>`).join('');
  const loadTotal = cost.loads.reduce((n, l) => n + (l.bytes ?? 0), 0);

  // Project names only with --by-project, as everywhere else in the report.
  const srcText = (s) => (s.source === 'local' ? 'local' : s.source === 'plugin' ? `plugin ${s.owner}${s.enabled ? '' : ' (disabled)'}`
    : opt.byProject ? `project ${s.owner}` : 'project');
  const dupes = cost.sources.filter((r) => r.duplicate);
  const srcRow = (r) => `<tr><th scope="row">${esc(r.name)}</th><td>${r.sources.map((x) => esc(srcText(x))).join(', ')}</td>
    <td>${r.duplicate ? '<strong>⚠ installed twice</strong>' : '—'}</td><td class="num">${bytes(r.sources[0]?.bytes)}</td></tr>`;

  const cmp = cost.compare;
  const cmpRows = cmp ? cmp.rows.map((r) => `<tr><th scope="row">${esc(r.type)}</th>
    <td class="num">${r.before.runs}</td><td class="num">${r.after.runs}</td>
    <td class="num">${k(r.before.weighted)}</td><td class="num">${k(r.after.weighted)}</td>
    <td class="num">${dur(r.before.medianMs)}</td><td class="num">${dur(r.after.medianMs)}</td>
    <td class="num">${r.before.skillLoads}</td><td class="num">${r.after.skillLoads}</td></tr>`).join('') : '';
  const cmpDate = cmp ? dayKey(cmp.at) : '';

  return `
  <section class="card">
    <h2>Where general-purpose goes</h2>
    <p class="muted">${gp.runs} general-purpose run${gp.runs === 1 ? '' : 's'}, ${k(gp.tokens)} tokens. The caller is the skill running the parent's turn when the helper was launched (a typed /command, or a skill Claude loaded in that turn), else "direct".</p>
    <table><thead><tr><th>Caller</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Share</th><th class="num">Weighted</th>
      <th class="num">Median time</th><th class="num">p90 time</th><th class="num">Background</th></tr></thead>
      <tbody>${callerRows || '<tr><td colspan="8" class="muted">No general-purpose runs in this period.</td></tr>'}</tbody></table>
    <h3>Could have been a typed agent</h3>
    <p class="muted">From each run's tool mix (70% or more of its calls). A typed agent has a narrower prompt and tool set, and usually a smaller model.</p>
    <table><thead><tr><th>Looks like</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Share of general-purpose</th></tr></thead>
      <tbody>${flagRows || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
    <h3>The ${gp.expensive.length || 10} most expensive runs</h3>
    <table><thead><tr><th>Description and first line</th><th>Caller</th><th>Mode</th><th>Model</th><th class="num">Tokens</th><th class="num">Weighted</th>
      <th class="num">Time</th><th>Could be</th></tr></thead>
      <tbody>${topRows || '<tr><td colspan="8" class="muted">—</td></tr>'}</tbody></table>
  </section>

  <section class="card">
    <h2>Tokens by type</h2>
    <p class="muted">Weighted = fresh input × ${costs.COST_WEIGHTS.input} + cache write × ${costs.COST_WEIGHTS.cacheWrite} + cache read × ${costs.COST_WEIGHTS.cacheRead} + output × ${costs.COST_WEIGHTS.output}, in fresh-input-token equivalents. Cache reads cost about a tenth of fresh input, so heavy cache re-reading does not look like fresh spending. Each run's own figures are in runs.csv.</p>
    <table><thead><tr><th>Agent</th><th class="num">Runs</th><th class="num">Fresh input</th><th class="num">Cache write</th><th class="num">Cache read</th>
      <th class="num">Output</th><th class="num">Total</th><th class="num">Weighted</th></tr></thead>
      <tbody>${tokenRows || '<tr><td colspan="8" class="muted">—</td></tr>'}</tbody></table>
    <p class="muted">${reconcile}</p>
  </section>

  <section class="card">
    <h2>Foreground and background times</h2>
    <p class="muted">Median / p90 (runs). A background run is timed from its launch to the helper's last transcript line or its completion notice, whichever is later, not to the launch's immediate return. Runs with no recorded end are counted on their own and left out of the times. The score compares foreground runs only with foreground runs, and background with background.</p>
    <table><thead><tr><th>Agent</th><th class="num">Foreground</th><th class="num">Background</th><th class="num">No recorded end</th></tr></thead>
      <tbody>${timingRows || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
  </section>

  <section class="card">
    <h2>Skills loaded inside helpers</h2>
    <p class="muted">Each load reads the skill's SKILL.md into the helper's context; the size is that file's, and skills of 20 KB or more are highlighted. ${bytes(loadTotal)} loaded in all.${split ? ` Before and after ${cmpDate}.` : ''}</p>
    <table><thead><tr><th>Agent</th><th>Skill</th><th class="num">Loads</th>${split ? `<th class="num">Before ${cmpDate}</th><th class="num">From ${cmpDate}</th>` : ''}
      <th class="num">Size each</th><th class="num">Total</th></tr></thead>
      <tbody>${loadRows || `<tr><td colspan="${split ? 7 : 5}" class="muted">No skill was loaded inside a helper in this period.</td></tr>`}</tbody></table>
  </section>

  <section class="card">
    <h2>Where skills come from</h2>
    <p class="muted">Names are matched without their plugin prefix (mattpocock-skills:tdd and tdd are one skill). ${dupes.length ? `${dupes.length} skill${dupes.length === 1 ? ' is' : 's are'} installed from more than one place.` : 'No skill is installed twice.'}</p>
    ${dupes.length ? `<table><thead><tr><th>Skill</th><th>Sources</th><th>Duplicate</th><th class="num">Size</th></tr></thead><tbody>${dupes.map(srcRow).join('')}</tbody></table>` : ''}
    <details><summary>Every installed skill (${cost.sources.length})</summary>
      <table><thead><tr><th>Skill</th><th>Sources</th><th>Duplicate</th><th class="num">Size</th></tr></thead><tbody>${cost.sources.map(srcRow).join('')}</tbody></table>
    </details>
  </section>
  ${cmp ? `
  <section class="card">
    <h2>Before and after ${cmpDate}</h2>
    <p class="muted">The period split at ${cmpDate}. Unattributed helper transcripts: ${cmp.unattributed.before} before, ${cmp.unattributed.after} after.</p>
    <table><thead><tr><th>Agent</th><th class="num">Runs before</th><th class="num">Runs after</th><th class="num">Weighted before</th><th class="num">Weighted after</th>
      <th class="num">Median before</th><th class="num">Median after</th><th class="num">Skill loads before</th><th class="num">Skill loads after</th></tr></thead>
      <tbody>${cmpRows}</tbody></table>
  </section>` : ''}`;
}

function page({ opt, roll, runs, prevRuns, days, stats, problems, team, cost, machine }) {
  const all = summarise(runs);
  const before = summarise(prevRuns);
  const typeOrder = [...roll.types].sort((a, b) => roll.overall[b].runs - roll.overall[a].runs);
  const slotOf = new Map(typeOrder.map((t, i) => [t, i < SERIES.length ? i : SERIES.length]));
  const typeSlot = (t) => slotOf.get(t) ?? SERIES.length;

  const seriesCss = SERIES.map(([l], i) => `--s${i}: ${l};`).join(' ') + ` --s${SERIES.length}: ${OTHER[0]};`;
  const seriesDark = SERIES.map(([, d], i) => `--s${i}: ${d};`).join(' ') + ` --s${SERIES.length}: ${OTHER[1]};`;
  const seriesRules = [...SERIES, OTHER].map((_, i) => `.s${i} { --c: var(--s${i}); }`).join('\n');

  const legend = typeOrder.map((t) => `<span class="key"><span class="swatch s${typeSlot(t)}"></span>${esc(t)}</span>`).join('');

  const dailyByType = new Map();
  for (const r of roll.daily) {
    if (!dailyByType.has(r.type)) dailyByType.set(r.type, new Map());
    dailyByType.get(r.type).set(r.period, r.runs);
  }

  const scoreCell = (sc, mixed) => {
    if (sc.value === undefined) return `<td class="num muted" title="Not scored: ${esc(sc.reason)}">—</td>`;
    const p = sc.parts;
    const label = { reliability: 'Reliability', rightFirst: 'Right first time', speed: 'Speed', efficiency: 'Efficiency' };
    const max = { reliability: 40, rightFirst: 20, speed: 20, efficiency: 20 };
    const title = Object.keys(label)
      .map((k) => (k in p ? `${label[k]} ${p[k].toFixed(0)}/${max[k]}` : `${label[k]} not measured`))
      .join(' · ') + (mixed ? ' · foreground and background runs each judged against their own median' : '');
    return `<td class="num" title="${title}"><strong>${sc.value}</strong></td>`;
  };

  const rows = typeOrder.map((t) => {
    const o = roll.overall[t];
    const lastWeek = roll.weekly.filter((w) => w.type === t).sort((a, b) => a.period.localeCompare(b.period)).at(-1);
    const verdicts = Object.entries(o.verdicts).map(([k, n]) => `${n} ${k}`).join(', ') || '—';
    const spark = days.slice(-14).map((d) => dailyByType.get(t)?.get(d) ?? 0);
    return `<tr>
      <th scope="row"><span class="swatch s${typeSlot(t)}"></span>${esc(t)}</th>
      <td>${esc(roomName[roomFor(t, roomOverrides)] ?? '')}</td>
      <td>${esc(modelsText(o.models))}</td>
      <td class="num">${o.runs}</td>
      ${scoreCell(lastWeek ? lastWeek.score : o.score, lastWeek?.mixed)}
      <td class="num">${pct(o.successRate)}</td>
      <td class="num">${pct(o.rerunRate)}</td>
      <td class="num">${dur(o.medianMs)}</td>
      <td class="num">${dur(o.p90Ms)}</td>
      <td class="num" title="${compact(o.medianTokens)} raw">${compact(o.medianWeighted)}</td>
      <td class="num">${num(o.toolCallsPerRun, 1)}</td>
      <td class="num">${pct(o.toolErrorRate)}</td>
      <td>${esc(verdicts)}</td>
      <td>${sparkline(spark)}</td>
    </tr>`;
  }).join('');

  const weeklyRows = roll.weekly.sort((a, b) => a.period.localeCompare(b.period) || a.type.localeCompare(b.type)).map((w) => `<tr>
      <td>${w.period}</td><th scope="row">${esc(w.type)}</th><td class="num">${w.runs}</td>
      <td class="num">${w.score.value ?? '—'}</td><td class="num">${pct(w.successRate)}</td><td class="num">${pct(w.rerunRate)}</td>
      <td class="num">${dur(w.medianMs)}</td><td class="num">${compact(w.medianWeighted)}</td></tr>`).join('');

  const notes = [
    'Counts below cover every file read, which includes the period before this one (used for the comparisons).',
    stats.ambiguousHelpers ? `${stats.ambiguousHelpers} helper transcript${stats.ambiguousHelpers === 1 ? '' : 's'} matched more than one run with the same prompt and ${stats.ambiguousHelpers === 1 ? 'was' : 'were'} not counted, rather than guessed.` : '',
    stats.unknownNotifications ? `${stats.unknownNotifications} background run${stats.unknownNotifications === 1 ? '' : 's'} ended with a status the report does not recognise and ${stats.unknownNotifications === 1 ? 'is' : 'are'} treated as unknown.` : '',
    stats.malformedLines ? `${stats.malformedLines} transcript line${stats.malformedLines === 1 ? '' : 's'} could not be read and were skipped.` : '',
    stats.unlinkedHelpers ? `${stats.unlinkedHelpers} helper transcript${stats.unlinkedHelpers === 1 ? '' : 's'} could not be matched to the call that started ${stats.unlinkedHelpers === 1 ? 'it' : 'them'}; their tokens and tool calls are not counted.` : '',
    all.unknown ? `${all.unknown} run${all.unknown === 1 ? ' has' : 's have'} no recorded end (still running, or the transcript stops) and ${all.unknown === 1 ? 'is' : 'are'} left out of success rates and times.` : '',
    ...problems,
  ].filter(Boolean);
  if (notes.length === 1) notes.length = 0; // only the preamble: nothing to note

  const generated = new Date();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Agent performance</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --page: #f9f9f7; --ink: #0b0b0b; --ink-2: #52514e; --muted: #6b6a65;
  --grid: #e1e0d9; --axis: #c3c2b7; --up: #006300; --down: #b3261e; --ring: rgba(11,11,11,0.10); ${seriesCss} }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --surface: #1a1a19; --page: #0d0d0d; --ink: #ffffff; --ink-2: #c3c2b7;
  --muted: #a3a29c; --grid: #2c2c2a; --axis: #383835; --up: #3fcf3f; --down: #ff8a80; --ring: rgba(255,255,255,0.10); ${seriesDark} } }
${seriesRules}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.sub, .muted { color: var(--ink-2); }
.card { background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--ring); padding: 20px; margin-top: 16px; overflow-x: auto; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 20px; }
.tile { background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--ring); padding: 16px; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 30px; font-weight: 600; margin-top: 2px; }
.tile-delta { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.up { color: var(--up); font-weight: 600; } .down { color: var(--down); font-weight: 600; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.label { fill: var(--ink); font-size: 12px; }
.value { fill: var(--ink-2); font-size: 12px; }
.mark { fill: var(--c); }
.line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.pt { fill: var(--c); stroke: var(--surface); stroke-width: 2; }
.leader { stroke: var(--muted); stroke-width: 1; }
.range { stroke: var(--s0); stroke-width: 2; stroke-linecap: round; opacity: 0.45; }
.dot { fill: var(--s0); stroke: var(--surface); stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 8px 0 12px; color: var(--ink-2); font-size: 13px; }
.key { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--c); margin-right: 6px; vertical-align: -1px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 8px 8px; border-bottom: 1px solid var(--grid); text-align: left; }
td.num, th.num, tbody th { white-space: nowrap; }
thead th { color: var(--ink-2); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody th { font-weight: 600; }
.spark { width: 84px; height: 22px; }
.spark polyline { fill: none; stroke: var(--ink-2); stroke-width: 1.5; }
details summary { cursor: pointer; color: var(--ink-2); margin-top: 12px; }
.notes li { color: var(--ink-2); }
.small { font-size: 12px; }
tr.hl th, tr.hl td { background: rgba(179, 38, 30, 0.08); }
tr.muted-row th, tr.muted-row td { color: var(--ink-2); font-style: italic; }
code { font-size: 12px; }
h3 { font-size: 14px; font-weight: 600; margin: 20px 0 4px; }
.flow { fill: none; stroke: var(--s0); stroke-opacity: 0.35; stroke-linecap: round; }
.flow:hover { stroke-opacity: 0.7; }
.node rect { fill: var(--surface); stroke: var(--axis); stroke-width: 1; }
.node.you rect { stroke: var(--ink-2); stroke-width: 1.5; }
.node.more rect { stroke-dasharray: 4 3; }
dl.score { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 0; }
dl.score dt { font-weight: 600; }
dl.score dd { margin: 0; color: var(--ink-2); }
</style>
</head>
<body>
<main>
  <h1>Agent performance</h1>
  <p class="sub">${opt.since !== undefined ? 'Period' : `Last ${opt.days} day${opt.days === 1 ? '' : 's'}`} · ${days[0]} to ${days.at(-1)} · generated ${generated.toLocaleString()} from ${stats.files} transcript file${stats.files === 1 ? '' : 's'}</p>
  ${machine ? machineLine(machine) : ''}

  <section class="kpis" aria-label="Headline numbers">
    ${kpi('Helper runs', num(all.runs), prevRuns.length
    ? `${all.runs >= before.runs ? '▲' : '▼'} ${num(Math.abs(all.runs - before.runs))} vs the period before` : 'no earlier period to compare')}
    ${kpi('Finished successfully', pct(all.successRate), deltaText(all.successRate, before.successRate, (d) => `${Math.round(d * 100)} pts`))}
    ${kpi('Median helper time', dur(all.medianMs), deltaText(all.medianMs, before.medianMs, dur, false))}
    ${kpi('Helper cost, weighted tokens', compact(all.totalWeighted), `${compact(all.totalTokens)} raw, mostly cache re-reads at a tenth of the price${prevRuns.length
    ? ` · ${all.totalWeighted >= before.totalWeighted ? '▲' : '▼'} ${compact(Math.abs(all.totalWeighted - before.totalWeighted))} vs the period before` : ''}`)}
  </section>

  <section class="card">
    <h2>Scorecard</h2>
    <p class="muted">Score is for each agent's latest week; hover a score to see its four parts. Times and tokens are medians over the whole period. Weighted tokens count what a run costs (cache re-reads at a tenth); hover one for the raw count. Model is what the helper ran on.</p>
    <table>
      <thead><tr><th>Agent</th><th>Room</th><th>Model</th><th class="num">Runs</th><th class="num">Score</th><th class="num">Finished</th>
        <th class="num">Re-runs</th><th class="num">Median time</th><th class="num">p90 time</th><th class="num">Weighted / run</th>
        <th class="num">Tool calls / run</th><th class="num">Tool errors</th><th>Verdicts</th><th>Last 14 days</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="14" class="muted">No helper runs in this period.</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>Helper runs per day</h2>
    <div class="legend">${legend}</div>
    ${dailyColumns(days, roll.daily, typeSlot)}
  </section>

  <section class="card">
    <h2>Weekly score</h2>
    <div class="legend">${legend}</div>
    ${weeklyScores(roll.weekly, typeSlot)}
    <details><summary>Show the weekly numbers</summary>
      <table><thead><tr><th>Week</th><th>Agent</th><th class="num">Runs</th><th class="num">Score</th><th class="num">Finished</th>
        <th class="num">Re-runs</th><th class="num">Median time</th><th class="num">Weighted / run</th></tr></thead>
      <tbody>${weeklyRows}</tbody></table>
    </details>
  </section>

  <section class="card">
    <h2>How long each agent takes</h2>
    <p class="muted">Dot: median run. Line: out to the slowest 10% (p90).</p>
    ${durationRanges(typeOrder, roll.overall)}
  </section>

  ${teamSection(team, opt)}
  ${cost ? costSections({ cost, opt, stats, days }) : ''}

  <section class="card">
    <h2>How the score works</h2>
    <dl class="score">
      <dt>Reliability, 40</dt><dd>Share of ended runs that finished (not failed, not stopped).</dd>
      <dt>Right first time, 20</dt><dd>Share of runs that were not a re-run: the same session calling the same agent again within 30 minutes of it failing or being stopped.</dd>
      <dt>Speed, 20</dt><dd>This week's median time against the agent's own median for the period. Foreground and background runs are each compared with their own kind, so a week that mixes them is fair. Agents are never compared with each other.</dd>
      <dt>Efficiency, 20</dt><dd>This week's median weighted tokens per run against the agent's own median for the period, again kind by kind.</dd>
    </dl>
    <p class="muted">An agent needs at least 3 runs in a week to be scored. Treat the score as a prompt to look closer, not a verdict: a reviewer that answers FAIL is doing its job, so its verdicts never lower its score.</p>
  </section>

  ${notes.length ? `<section class="card"><h2>Notes on the data</h2><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
</main>
</body>
</html>`;
}

// ---- CSV -----------------------------------------------------------------------

function csv(rows, cols) {
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
}

// ---- main ----------------------------------------------------------------------

function run(argv) {
  const opt = args(argv);
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const now = opt.until ?? Date.now();
  const start = new Date(now - (opt.days - 1) * 86_400_000);
  start.setHours(0, 0, 0, 0);
  const since = opt.since ?? start.getTime();
  const prevSince = since - opt.days * 86_400_000;
  if (opt.compare !== undefined && (opt.compare <= since || opt.compare > now)) {
    throw new Error(`--compare ${dayKey(opt.compare)} is not inside the period (${dayKey(since)} to ${dayKey(now)})`);
  }

  const setupProblems = [];
  ({ names: roomName, overrides: roomOverrides } = roomSetup(setupProblems));
  const roots = Array.isArray(opt.roots) && opt.roots.length ? opt.roots : defaultRoots();
  const data = collect(roots, { since: prevSince, until: now, details: Boolean(opt.details) });
  data.problems.push(...setupProblems);
  const runs = data.runs.filter((r) => r.start >= since);
  const prevRuns = data.runs.filter((r) => r.start < since);
  const sessions = data.sessions.filter((s) => (s.start ?? 0) >= since);
  const roll = rollUp({ runs, sessions });
  const days = Array.from({ length: opt.days }, (_, i) => dayKey(since + i * 86_400_000 + 3_600_000));

  // Per agent, for the app's creature screen: counts only, nothing identifying.
  const agents = roll.types.map((t) => {
    const o = roll.overall[t];
    return {
      name: t, runs: o.runs, finished: o.finished, failed: o.failed, stopped: o.stopped, successRate: o.successRate,
      rerunRate: o.rerunRate, medianMs: o.medianMs, p90Ms: o.p90Ms, medianTokens: o.medianTokens, totalTokens: o.totalTokens,
      toolErrorRate: o.toolErrorRate, verdicts: o.verdicts, score: o.score.value, scoreReason: o.score.reason,
      daily: roll.daily.filter((d) => d.type === t).map((d) => ({ day: d.period, runs: d.runs, score: d.score.value })),
    };
  });
  if (opt.statsOnly) {
    // Every agent called in the two windows read (twice --days), so the
    // Meadow keeps agents that were busy before but quiet lately.
    const seen = [...new Set(data.runs.map((r) => r.type).filter(Boolean))].sort();
    // Tokens per agent per day over the same span, so the Meadow can keep a
    // running total that outlives the window (it merges days it already has).
    const tokensByDay = {};
    for (const r of data.runs) {
      if (!r.type || r.start === undefined) continue;
      const day = dayKey(r.start);
      const byDay = (tokensByDay[r.type] ??= {});
      byDay[day] = (byDay[day] ?? 0) + totalTokens(r.tokens);
    }
    const result = { ok: true, days: opt.days, agents, seen, tokensByDay, notes: data.stats.malformedLines + data.stats.unlinkedHelpers + data.problems.length };
    if (opt.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  fs.mkdirSync(opt.out, { recursive: true });
  const stamp = dayKey(now);
  const htmlFile = path.join(opt.out, `agent-report-${stamp}.html`);
  // The team picture covers this period only; the installed agents and
  // skills are read from the .claude folder beside each projects folder.
  const inventory = readInventory([...new Set(roots.map((r) => path.dirname(r)))]);
  data.problems.push(...inventory.problems);
  const team = teamwork({
    runs,
    sessions: sessions.map((x) => ({ ...x, steps: (x.steps ?? []).filter((st) => st.ts >= since) })),
    skills: (data.skills ?? []).filter((u) => u.ts >= since),
  }, inventory);
  // The cost picture: this period's runs and unattributed helper transcripts.
  const claudeDirs = [...new Set(roots.map((r) => path.dirname(r)))];
  const machine = machineInfo(claudeDirs);
  const unattributed = (data.unattributed ?? []).filter((u) => (u.start ?? 0) >= since);
  const sources = costs.readSkillSources({ claudeDirs, cwds: data.cwds ?? [], enabledPlugins: machine.dirs.flatMap((d) => d.plugins) });
  data.problems.push(...sources.problems);
  const cost = {
    gp: costs.generalPurpose(runs),
    tokens: costs.tokensByAgent(runs, unattributed),
    timing: costs.timingByMode(runs),
    loads: costs.skillLoadsInHelpers(runs, unattributed, sources.skills, opt.compare),
    sources: costs.skillSourceRows(sources.skills),
    compare: opt.compare !== undefined ? costs.compareAt(runs, unattributed, opt.compare) : undefined,
    unattributed,
  };
  fs.writeFileSync(htmlFile, page({ opt, roll, runs, prevRuns, days, stats: data.stats, problems: data.problems, team, cost, machine }));

  // Sessions get anonymous handles; project names only on request.
  const handle = new Map([...new Set(runs.map((r) => r.sessionId))].map((id, i) => [id, `s${i + 1}`]));
  const projectOf = new Map(data.sessions.map((s) => [s.id, s.project]));
  const runRows = runs.map((r) => ({
    session: handle.get(r.sessionId),
    project: opt.byProject ? projectOf.get(r.sessionId) : undefined,
    agent: r.type,
    room: roomFor(r.type, roomOverrides),
    started: new Date(r.start).toISOString(),
    seconds: r.durationMs === undefined ? undefined : Math.round(r.durationMs / 1000),
    outcome: r.outcome,
    verdict: r.verdict,
    rerun: r.rerun ? 1 : 0,
    background: r.background ? 1 : 0,
    tool_calls: r.toolCalls,
    tool_errors: r.toolErrors,
    tokens: r.linked ? totalTokens(r.tokens) : undefined,
    input_tokens: r.linked ? r.tokens.input : undefined,
    output_tokens: r.linked ? r.tokens.output : undefined,
    cache_read_tokens: r.linked ? r.tokens.cacheRead : undefined,
    cache_write_tokens: r.linked ? r.tokens.cacheWrite : undefined,
    weighted_tokens: r.linked ? Math.round(costs.weighted(r.tokens)) : undefined,
    mode: r.mode,
    caller: r.caller,
    model: r.model,
    matched_by: r.linkedBy ?? 'unmatched',
    ...Object.fromEntries(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'other'].map((k) => [`tool_${k.toLowerCase()}`, r.tools?.[k] ?? 0])),
    could_be: r.type === 'general-purpose' ? costs.typedAgentFor(r.tools) : undefined,
    skill_loads: (r.skillLoads ?? []).map(costs.baseSkill).join(';'),
    description: opt.details ? r.description : undefined,
    prompt_first_line: opt.details ? r.promptLine : undefined,
  }));
  const runCols = ['session', ...(opt.byProject ? ['project'] : []), 'agent', 'room', 'started', 'seconds', 'outcome', 'verdict',
    'rerun', 'background', 'mode', 'caller', 'model', 'matched_by', 'tool_calls', 'tool_errors',
    'tool_read', 'tool_grep', 'tool_glob', 'tool_bash', 'tool_webfetch', 'tool_websearch', 'tool_edit', 'tool_write', 'tool_other',
    'could_be', 'skill_loads', 'tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'weighted_tokens',
    ...(opt.details ? ['description', 'prompt_first_line'] : [])];
  const periodRow = (r) => ({
    period: r.period, agent: r.type, runs: r.runs, finished: r.finished, failed: r.failed, stopped: r.stopped, unknown: r.unknown,
    success_rate: r.successRate?.toFixed(3), rerun_rate: r.rerunRate?.toFixed(3),
    median_seconds: r.medianMs === undefined ? undefined : Math.round(r.medianMs / 1000),
    p90_seconds: r.p90Ms === undefined ? undefined : Math.round(r.p90Ms / 1000),
    median_tokens: r.medianTokens === undefined ? undefined : Math.round(r.medianTokens),
    median_weighted_tokens: r.medianWeighted === undefined ? undefined : Math.round(r.medianWeighted),
    models: modelsText(r.models), mixed_modes: r.mixed ? 'yes' : 'no',
    tool_error_rate: r.toolErrorRate?.toFixed(3), score: r.score.value,
  });
  const periodCols = ['period', 'agent', 'runs', 'finished', 'failed', 'stopped', 'unknown', 'success_rate', 'rerun_rate',
    'median_seconds', 'p90_seconds', 'median_tokens', 'median_weighted_tokens', 'models', 'mixed_modes', 'tool_error_rate', 'score'];
  fs.writeFileSync(path.join(opt.out, `runs-${stamp}.csv`), csv(runRows, runCols));
  fs.writeFileSync(path.join(opt.out, `daily-${stamp}.csv`), csv(roll.daily.map(periodRow), periodCols));
  fs.writeFileSync(path.join(opt.out, `weekly-${stamp}.csv`), csv(roll.weekly.map(periodRow), periodCols));

  const all = summarise(runs);
  const summary = {
    runs: all.runs, successRate: all.successRate, medianMs: all.medianMs, days: opt.days,
    notes: data.stats.malformedLines + data.stats.unlinkedHelpers + data.problems.length,
  };
  const result = { ok: true, html: htmlFile, dir: opt.out, summary, agents };
  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  console.log(`Agent report, last ${opt.days} days: ${all.runs} helper runs, ${pct(all.successRate)} finished, median ${dur(all.medianMs)}.`);
  for (const t of roll.types) {
    const o = roll.overall[t];
    console.log(`  ${t.padEnd(24)} ${String(o.runs).padStart(4)} runs  ${pct(o.successRate).padStart(4)} finished  median ${dur(o.medianMs)}`);
  }
  if (data.stats.malformedLines || data.stats.unlinkedHelpers || data.problems.length) {
    console.log(`Notes: ${data.stats.malformedLines} unreadable lines, ${data.stats.unlinkedHelpers} unmatched helper transcripts${data.problems.length ? `, ${data.problems.join('; ')}` : ''}.`);
  }
  console.log(`Report: ${htmlFile}`);
  console.log(`CSV:    ${opt.out}`);
  return result;
}

module.exports = { run };

// Started by the app as an Electron utility process: answer over the parent
// port, then exit (a utility process otherwise stays alive for messages).
if (process.parentPort) {
  let reply;
  try {
    reply = run(process.argv.slice(2).filter((a) => a !== '--json'));
  } catch (err) {
    reply = { ok: false, error: err.message };
  }
  process.parentPort.postMessage(reply);
  setTimeout(() => process.exit(0), 50);
} else if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    run(argv);
  } catch (err) {
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    else console.error(`Could not build the report: ${err.message}`);
    process.exitCode = 1;
  }
}
