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
//   npm run report -- --lang zh-TW                the page in Traditional Chinese (en, zh-TW)
//
// The report holds counts, durations, token numbers, names and one-word
// verdicts. It never holds results, file names, commands or project names
// (add --by-project for project names in runs.csv). Agent-call descriptions
// and the first line of a helper's prompt appear only with --details, the
// way privacy mode works in the app.

// Words this run missed (a key, or a sentence's mark): sent back with the
// answer, so the app logs them like its own.
const missedWords = [];
// The error's name, code and first line, for the app, which takes the paths
// out before it logs it or shows it.
const failureOf = (err) => ({ name: err?.name, code: err?.code, message: String(err?.message ?? err).split('\n')[0] });

// Started by the app: a failure before the answer (a module that will not
// load) is answered too.
if (process.parentPort) {
  process.on('uncaughtException', (err) => {
    process.parentPort.postMessage({ ok: false, failure: failureOf(err), missingWords: missedWords });
    setTimeout(() => process.exit(1), 50);
  });
}

const fs = require('fs');
const path = require('path');
const { collect, rollUp, summarise, dayKey, totalTokens } = require('../core/metrics');
const { teamwork, readInventory, YOU } = require('../core/teamwork');
const costs = require('../core/costs');
const { readLedger } = require('../core/ledger');
const { execFileSync } = require('child_process');
const { defaultRoots } = require('../core/watcher');
const { roomFor, validateLayout, roomsWith, overridesFrom, validateOverrides } = require('../core/rooms');
const { translate, trHtmlIn, raw, sayIn, en, languageInfo, onMissing, LANGUAGES, DEFAULT_LANGUAGE } = require('../core/i18n');
const { placeWords } = require('../../renderer/places.js');
const os = require('os');

onMissing((l, key) => { missedWords.push({ lang: l, key }); });

// ---- arguments ---------------------------------------------------------------

function args(argv) {
  const opt = { days: 28, out: path.join(process.cwd(), 'out', 'reports'), byProject: false, roots: undefined, json: false, lang: DEFAULT_LANGUAGE };
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
    else if (a === '--stats-only') opt.statsOnly = true; // numbers per agent as JSON, no files
    else if (a === '--since') opt.since = dateArg('--since', argv[++i]);
    else if (a === '--until') opt.until = endOfDay(dateArg('--until', argv[++i]));
    else if (a === '--compare') opt.compare = dateArg('--compare', argv[++i]);
    else if (a === '--details') opt.details = true;
    else if (a === '--lang') opt.lang = argv[++i]; // the page's language; the app passes its own
    else if (a === '--help' || a === '-h') opt.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  if (!Number.isInteger(opt.days) || opt.days < 1 || opt.days > 365) {
    throw new Error('--days must be a whole number from 1 to 365');
  }
  if (!LANGUAGES.some((l) => l.id === opt.lang)) throw new Error(`--lang must be one of ${LANGUAGES.map((l) => l.id).join(', ')}`);
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

// The page's language: run() sets it from --lang before anything is drawn.
// The CSV columns and the command line's own lines stay English.
let lang = DEFAULT_LANGUAGE;
const words = (key, params) => translate(lang, key, params);
const english = (key, params) => translate(DEFAULT_LANGUAGE, key, params);
const html = (key, params) => esc(words(key, params));
const markup = (key, params) => trHtmlIn(lang, key, params);

// `say`: the page's words, or English for the command line's own lines.
function dur(ms, say = words) {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return say('report.dur.s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return say('report.dur.ms', { m, s: String(s % 60).padStart(2, '0') });
  return say('report.dur.hm', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
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
    if (err.code !== 'ENOENT') problems.push(en('said.report.fileUnreadable', { file: path.basename(file) }));
    return undefined;
  }
}

function roomSetup(problems) {
  const dir = appDataDir();
  let layout = { departments: [] };
  try {
    layout = validateLayout(readJson(path.join(dir, 'layout.json'), problems));
  } catch (err) {
    problems.push(en('said.report.layoutIgnored', { why: err.message }));
  }
  const rooms = roomsWith(layout);
  let fromFile = {};
  try {
    fromFile = validateOverrides(readJson(path.join(dir, 'rooms.json'), problems), new Set(rooms.map((r) => r.id)));
  } catch (err) {
    problems.push(en('said.report.roomsIgnored', { why: err.message }));
  }
  return { names: Object.fromEntries(rooms.map((r) => [r.id, r])), overrides: { ...overridesFrom(layout), ...fromFile } };
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
      s += `<path class="mark s${typeSlot(r.type)}" d="${barPath(x, yTop, barW, h, isTop)}"><title>${html('report.daily.title', { agent: r.type, day: d, n: r.runs })}</title></path>`;
      base += r.runs;
    });
    if (days.length <= 14 || i % Math.ceil(days.length / 14) === 0) {
      s += `<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });
  s += `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${html('report.daily.aria')}">${s}</svg>`;
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
  if (!rows.length) return `<p class="muted">${html('report.durations.none')}</p>`;
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
    s += `<circle class="dot" cx="${x(o.medianMs)}" cy="${cy}" r="5"><title>${html('report.durations.title', { agent: t, median: dur(o.medianMs), p90: dur(o.p90Ms) })}</title></circle>`;
    s += `<text class="value" x="${x(o.p90Ms ?? o.medianMs) + 10}" y="${cy + 4}">${html('report.durations.value', { median: dur(o.medianMs), p90: dur(o.p90Ms) })}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${html('report.durations.aria')}">${s}</svg>`;
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
  if (!series.size) return `<p class="muted">${html('report.weekly.none', { n: 3 })}</p>`;
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
      s += `<circle class="pt s${slot}" cx="${px}" cy="${py}" r="4"><title>${html('report.weekly.title', { agent: type, week: r.period, score: r.score.value, n: r.runs })}</title></circle>`;
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
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${html('report.weekly.aria')}">${s}</svg>`;
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
function modelsText(models, sep = ', ') {
  const list = Object.entries(models ?? {}).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '—';
  const short = (m) => m.replace(/^claude-/, '');
  return list.length === 1 ? short(list[0][0]) : list.map(([m, n]) => `${short(m)} ×${n}`).join(sep);
}

function deltaText(now, before, fmt, upIsGood = true) {
  if (now === undefined || before === undefined) return html('report.kpi.noEarlier');
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return html('report.delta.same');
  const good = diff > 0 === upIsGood;
  return markup(`report.delta.${diff > 0 ? 'up' : 'down'}${good ? 'Better' : 'Worse'}`, { arrow: diff > 0 ? '▲' : '▼', diff: fmt(Math.abs(diff)) });
}

// Who called whom: You on the left, the agents and skills you (or Claude
// for you) called in the middle, and the skills those agents ran on the
// right. Line width is the number of calls; every node carries its name and
// count, and the tables below hold the same numbers.
function flowChart(team) {
  const FIRST = 12;
  const fromYou = team.edges.filter((e) => e.from === YOU);
  if (!fromYou.length) return `<p class="muted">${html('report.flow.none')}</p>`;
  const shown = fromYou.slice(0, FIRST);
  const rest = fromYou.slice(FIRST);
  const middle = [...shown.map((e) => ({ name: e.to, kind: e.kind, count: e.count }))];
  if (rest.length) middle.push({ name: words('report.flow.more', { n: rest.length }), kind: 'more', count: rest.reduce((a, e) => a + e.count, 0) });
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
  for (const m of middle) links += link(col[0] + NODE_W[0], youY, col[1], midY.get(m.name), m.count, words('report.flow.youTo', { to: m.name, n: m.count }));
  for (const e of inner) links += link(col[1] + NODE_W[1], midY.get(e.from), col[2], rightY.get(e.to), e.count, `${e.from} → /${e.to}: ${e.count}`);
  const nodes = [
    node(col[0], youY, NODE_W[0], words('report.flow.you'), 'you', words('report.flow.youTitle')),
    ...middle.map((m) => node(col[1], midY.get(m.name), NODE_W[1],
      `${m.kind === 'skill' ? '/' : ''}${m.name} · ${m.count}`, m.kind, words(m.kind === 'agent' ? 'report.flow.agentCalls' : m.kind === 'skill' ? 'report.flow.skillCalls' : 'report.flow.otherCalls', { n: m.count }))),
    ...right.map((r) => node(col[2], rightY.get(r), NODE_W[2], `/${r} · ${inner.filter((e) => e.to === r).reduce((a, e) => a + e.count, 0)}`, 'skill', words('report.flow.innerSkill'))),
  ].join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${html('report.flow.aria')}">${links}${nodes}</svg>`;
}

function teamSection(team, opt) {
  const chains = team.chains.slice(0, 8).map((c) => `<tr><td>${esc(c.chain)}</td><td class="num">${c.count}</td></tr>`).join('');
  const skills = team.skillRows.map((r) => `<tr><th scope="row">/${esc(r.name)}</th><td class="num">${r.uses}</td><td class="num">${r.typed || '—'}</td>
    <td class="num">${r.byClaude || '—'}</td><td>${r.byHelpers.length ? esc(r.byHelpers.map(([a, n]) => `${a} ${n}`).join(words('common.listSep'))) : '—'}</td>
    <td class="num">${pct(r.errorRate)}</td></tr>`).join('');
  const unusedOf = (kind) => team.unused.filter((r) => r.kind === kind).map((r) => `${kind === 'skill' ? '/' : ''}${esc(r.name)}`).join(html('common.listSep'));
  const unusedAgents = unusedOf('agent');
  const unusedSkills = unusedOf('skill');
  return `<section class="card">
    <h2>${html('report.team.h')}</h2>
    <p class="muted">${html('report.team.intro')}</p>
    ${flowChart(team)}
    <h3>${html('report.team.chainsH')}</h3>
    <p class="muted">${html('report.team.chainsIntro')}${team.sessionsWithSteps ? `${html('common.sentenceSep')}${html('report.team.chainsUsed', { n: team.sessionsWithSteps })}` : ''}</p>
    <table><thead><tr><th>${html('report.col.chain')}</th><th class="num">${html('report.col.sessions')}</th></tr></thead>
      <tbody>${chains || `<tr><td colspan="2" class="muted">${html('report.team.noChains')}</td></tr>`}</tbody></table>
    <h3>${html('report.team.skillsH')}</h3>
    <table><thead><tr><th>${html('report.col.skill')}</th><th class="num">${html('report.col.uses')}</th><th class="num">${html('report.col.typed')}</th><th class="num">${html('report.col.byClaude')}</th>
      <th>${html('report.col.insideAgents')}</th><th class="num">${html('report.col.errors')}</th></tr></thead>
      <tbody>${skills || `<tr><td colspan="6" class="muted">${html('report.team.noSkills')}</td></tr>`}</tbody></table>
    <h3>${html('report.team.unusedH', { days: opt.days })}</h3>
    ${unusedAgents || unusedSkills
    ? `<dl class="score">${unusedAgents ? `<dt>${html('report.team.agents')}</dt><dd>${unusedAgents}</dd>` : ''}${unusedSkills ? `<dt>${html('report.team.skills')}</dt><dd>${unusedSkills}</dd>` : ''}</dl>
       <p class="muted">${html('report.team.worthALook')}</p>`
    : `<p class="muted">${html('report.team.allUsed')}</p>`}
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
  const dirs = machine.dirs.map((d) => {
    const where = raw(markup('report.machine.dir', { dir: tilde(d.dir), commit: raw(d.commit ? `<code>${esc(d.commit)}</code>` : markup('report.machine.noGit')) }));
    return d.plugins.length ? markup('report.machine.plugins', { where, list: d.plugins.join(words('common.listSep')) }) : markup('report.machine.noPlugins', { where });
  }).join(' · ');
  return `<p class="sub">${markup('report.machine.line', { host: raw(`<strong>${esc(machine.host)}</strong>`), dirs: raw(dirs) })}</p>`;
}

function costSections({ cost, opt, stats, days }) {
  const gp = cost.gp;
  const callerRows = gp.byCaller.map((c) => `<tr><th scope="row">${esc(c.caller)}</th><td class="num">${c.runs}</td>
    <td class="num">${k(c.tokens)}</td><td class="num">${pct(c.share)}</td><td class="num">${k(c.weighted)}</td>
    <td class="num">${dur(c.medianMs)}</td><td class="num">${dur(c.p90Ms)}</td><td class="num">${c.background || '—'}</td></tr>`).join('');
  const flagName = (flag) => (['Explore', 'researcher', 'runner', 'none'].includes(flag) ? words(`report.flag.${flag}`) : flag);
  const flagRows = gp.flags.map((f) => `<tr><th scope="row">${esc(flagName(f.flag))}</th><td class="num">${f.runs}</td>
    <td class="num">${k(f.tokens)}</td><td class="num">${pct(f.share)}</td></tr>`).join('');
  const what = (r) => (opt.details
    ? `${esc(r.description || '—')}${r.promptLine ? `<div class="muted small">${esc(r.promptLine)}</div>` : ''}`
    : `<span class="muted">${html('report.gp.hidden')}</span>`);
  const topRows = gp.expensive.map((r) => `<tr><td>${what(r)}</td><td>${esc(r.caller)}</td><td>${esc(r.mode)}</td><td>${esc(r.model ?? '—')}</td>
    <td class="num">${k(totalTokens(r.tokens))}</td><td class="num">${k(costs.weighted(r.tokens))}</td><td class="num">${dur(r.durationMs)}</td>
    <td>${r.flag ? esc(r.flag) : '—'}</td></tr>`).join('');

  const tokenRows = cost.tokens.map((t) => `<tr${t.unattributed ? ' class="muted-row"' : ''}><th scope="row">${esc(t.name)}</th><td class="num">${t.runs}</td>
    <td class="num">${k(t.input)}</td><td class="num">${k(t.cacheWrite)}</td><td class="num">${k(t.cacheRead)}</td><td class="num">${k(t.output)}</td>
    <td class="num">${k(t.total)}</td><td class="num"><strong>${k(t.weighted)}</strong></td></tr>`).join('');
  const matched = stats.matchedByAgentId + stats.matchedByPrompt;
  const reconcile = words('report.tokens.reconcile', { n: stats.helperTranscripts, byId: stats.matchedByAgentId, byPrompt: stats.matchedByPrompt,
    none: stats.helperTranscripts - matched, inPeriod: cost.unattributed.length });

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
  const srcText = (s) => (s.source === 'local' ? words('report.src.local') : s.source === 'plugin' ? words(s.enabled ? 'report.src.plugin' : 'report.src.pluginOff', { owner: s.owner })
    : opt.byProject ? words('report.src.project', { owner: s.owner }) : words('report.src.projectAny'));
  const dupes = cost.sources.filter((r) => r.duplicate);
  const srcHead = `<tr><th>${html('report.col.skill')}</th><th>${html('report.col.sources')}</th><th>${html('report.col.duplicate')}</th><th class="num">${html('report.col.size')}</th></tr>`;
  const srcRow = (r) => `<tr><th scope="row">${esc(r.name)}</th><td>${r.sources.map((x) => esc(srcText(x))).join(html('common.listSep'))}</td>
    <td>${r.duplicate ? `<strong>${html('report.src.twice')}</strong>` : '—'}</td><td class="num">${bytes(r.sources[0]?.bytes)}</td></tr>`;

  const cmp = cost.compare;
  const cmpRows = cmp ? cmp.rows.map((r) => `<tr><th scope="row">${esc(r.type)}</th>
    <td class="num">${r.before.runs}</td><td class="num">${r.after.runs}</td>
    <td class="num">${k(r.before.weighted)}</td><td class="num">${k(r.after.weighted)}</td>
    <td class="num">${dur(r.before.medianMs)}</td><td class="num">${dur(r.after.medianMs)}</td>
    <td class="num">${r.before.skillLoads}</td><td class="num">${r.after.skillLoads}</td></tr>`).join('') : '';
  const cmpDate = cmp ? dayKey(cmp.at) : '';

  return `
  <section class="card">
    <h2>${html('report.gp.h')}</h2>
    <p class="muted">${html('report.gp.intro', { n: gp.runs, tokens: k(gp.tokens) })}</p>
    <table><thead><tr><th>${html('report.col.caller')}</th><th class="num">${html('report.col.runs')}</th><th class="num">${html('report.col.tokens')}</th><th class="num">${html('report.col.share')}</th><th class="num">${html('report.col.weighted')}</th>
      <th class="num">${html('report.col.medianTime')}</th><th class="num">${html('report.col.p90Time')}</th><th class="num">${html('report.col.background')}</th></tr></thead>
      <tbody>${callerRows || `<tr><td colspan="8" class="muted">${html('report.gp.none')}</td></tr>`}</tbody></table>
    <h3>${html('report.gp.typedH')}</h3>
    <p class="muted">${html('report.gp.typedIntro')}</p>
    <table><thead><tr><th>${html('report.col.looksLike')}</th><th class="num">${html('report.col.runs')}</th><th class="num">${html('report.col.tokens')}</th><th class="num">${html('report.col.shareGp')}</th></tr></thead>
      <tbody>${flagRows || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
    <h3>${html('report.gp.topH', { n: gp.expensive.length || 10 })}</h3>
    <table><thead><tr><th>${html('report.col.description')}</th><th>${html('report.col.caller')}</th><th>${html('report.col.mode')}</th><th>${html('report.col.model')}</th><th class="num">${html('report.col.tokens')}</th><th class="num">${html('report.col.weighted')}</th>
      <th class="num">${html('report.col.time')}</th><th>${html('report.col.couldBe')}</th></tr></thead>
      <tbody>${topRows || '<tr><td colspan="8" class="muted">—</td></tr>'}</tbody></table>
  </section>

  <section class="card">
    <h2>${html('report.tokens.h')}</h2>
    <p class="muted">${html('report.tokens.intro', { input: costs.COST_WEIGHTS.input, write: costs.COST_WEIGHTS.cacheWrite, read: costs.COST_WEIGHTS.cacheRead, output: costs.COST_WEIGHTS.output })}</p>
    <table><thead><tr><th>${html('report.col.agent')}</th><th class="num">${html('report.col.runs')}</th><th class="num">${html('report.col.freshInput')}</th><th class="num">${html('report.col.cacheWrite')}</th><th class="num">${html('report.col.cacheRead')}</th>
      <th class="num">${html('report.col.output')}</th><th class="num">${html('report.col.total')}</th><th class="num">${html('report.col.weighted')}</th></tr></thead>
      <tbody>${tokenRows || '<tr><td colspan="8" class="muted">—</td></tr>'}</tbody></table>
    <p class="muted">${esc(reconcile)}</p>
  </section>

  <section class="card">
    <h2>${html('report.timing.h')}</h2>
    <p class="muted">${html('report.timing.intro')}</p>
    <table><thead><tr><th>${html('report.col.agent')}</th><th class="num">${html('report.col.foreground')}</th><th class="num">${html('report.col.background')}</th><th class="num">${html('report.col.noEnd')}</th></tr></thead>
      <tbody>${timingRows || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
  </section>

  <section class="card">
    <h2>${html('report.loads.h')}</h2>
    <p class="muted">${split ? html('report.loads.introSplit', { total: bytes(loadTotal), date: cmpDate }) : html('report.loads.intro', { total: bytes(loadTotal) })}</p>
    <table><thead><tr><th>${html('report.col.agent')}</th><th>${html('report.col.skill')}</th><th class="num">${html('report.col.loads')}</th>${split ? `<th class="num">${html('report.col.beforeDate', { date: cmpDate })}</th><th class="num">${html('report.col.fromDate', { date: cmpDate })}</th>` : ''}
      <th class="num">${html('report.col.sizeEach')}</th><th class="num">${html('report.col.total')}</th></tr></thead>
      <tbody>${loadRows || `<tr><td colspan="${split ? 7 : 5}" class="muted">${html('report.loads.none')}</td></tr>`}</tbody></table>
  </section>

  <section class="card">
    <h2>${html('report.src.h')}</h2>
    <p class="muted">${html('report.src.intro')}${html('common.sentenceSep')}${dupes.length ? html('report.src.dupes', { n: dupes.length }) : html('report.src.noDupes')}</p>
    ${dupes.length ? `<table><thead>${srcHead}</thead><tbody>${dupes.map(srcRow).join('')}</tbody></table>` : ''}
    <details><summary>${html('report.src.every', { n: cost.sources.length })}</summary>
      <table><thead>${srcHead}</thead><tbody>${cost.sources.map(srcRow).join('')}</tbody></table>
    </details>
  </section>
  ${cmp ? `
  <section class="card">
    <h2>${html('report.cmp.h', { date: cmpDate })}</h2>
    <p class="muted">${html('report.cmp.intro', { date: cmpDate, before: cmp.unattributed.before, after: cmp.unattributed.after })}</p>
    <table><thead><tr><th>${html('report.col.agent')}</th><th class="num">${html('report.col.runsBefore')}</th><th class="num">${html('report.col.runsAfter')}</th><th class="num">${html('report.col.weightedBefore')}</th><th class="num">${html('report.col.weightedAfter')}</th>
      <th class="num">${html('report.col.medianBefore')}</th><th class="num">${html('report.col.medianAfter')}</th><th class="num">${html('report.col.loadsBefore')}</th><th class="num">${html('report.col.loadsAfter')}</th></tr></thead>
      <tbody>${cmpRows}</tbody></table>
  </section>` : ''}`;
}

// The user's own verdict ledger, when they keep one: how each review
// agent's verdicts held up. Counts only.
function ledgerSection(ledger) {
  if (!ledger?.found) return '';
  const names = Object.keys(ledger.agents).sort((a, b) => ledger.agents[b].rows - ledger.agents[a].rows);
  const rows = names.map((n) => {
    const a = ledger.agents[n];
    const judged = a.PASS + a.FAIL;
    const labelled = a.real + a.unverified + a.falseAlarm;
    return `<tr><th scope="row">${esc(n)}</th><td class="num">${a.rows}</td>
      <td class="num">${judged ? pct(a.FAIL / judged) : '—'}</td>
      <td class="num">${a.real}</td><td class="num">${a.unverified}</td><td class="num">${a.falseAlarm}</td><td class="num">${a.open}</td>
      <td class="num" title="${labelled ? html('report.ledger.realOf', { pct: pct(a.real / labelled) }) : html('report.ledger.noLabel')}">${labelled ? pct(a.real / labelled) : '—'}</td>
      <td class="num">${a.missed}</td><td class="num">${a.BLOCKED}</td><td class="num">${a.MISSING + a.UNREAD}</td></tr>`;
  }).join('');
  return `<section class="card">
    <h2>${html('report.ledger.h')}</h2>
    <p class="muted">${html('report.ledger.intro')}</p>
    <table><thead><tr><th>${html('report.col.agent')}</th><th class="num">${html('report.col.verdicts')}</th><th class="num">${html('report.col.fails')}</th><th class="num">${html('report.col.real')}</th><th class="num">${html('report.col.unverified')}</th>
      <th class="num">${html('report.col.falseAlarm')}</th><th class="num">${html('report.col.notLabelled')}</th><th class="num">${html('report.col.realOfLabelled')}</th><th class="num">${html('report.col.missedPass')}</th>
      <th class="num">${html('report.col.blocked')}</th><th class="num">${html('report.col.noVerdictLine')}</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="11" class="muted">${html('report.ledger.none')}</td></tr>`}</tbody></table>
  </section>`;
}

function page({ opt, roll, runs, prevRuns, days, stats, problems, team, cost, machine, ledger }) {
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
    if (sc.value === undefined) return `<td class="num muted" title="${html('report.score.notScored', { why: sayIn(lang, sc.reason) })}">—</td>`;
    const p = sc.parts;
    const max = { reliability: 40, rightFirst: 20, speed: 20, efficiency: 20 };
    const title = Object.keys(max)
      .map((k) => { const label = words(`report.part.${k}`); return k in p ? words('report.score.part', { label, value: p[k].toFixed(0), max: max[k] }) : words('report.score.notMeasured', { label }); })
      .join(' · ') + (mixed ? ` · ${words('report.score.mixed')}` : '');
    return `<td class="num" title="${esc(title)}"><strong>${sc.value}</strong></td>`;
  };

  const rows = typeOrder.map((t) => {
    const o = roll.overall[t];
    const lastWeek = roll.weekly.filter((w) => w.type === t).sort((a, b) => a.period.localeCompare(b.period)).at(-1);
    const verdicts = [Object.entries(o.verdicts).map(([k, n]) => `${n} ${k}`).join(words('common.listSep')),
      o.noVerdict ? words('report.verdicts.none', { n: o.noVerdict }) : ''].filter(Boolean).join(' · ') || '—';
    const spark = days.slice(-14).map((d) => dailyByType.get(t)?.get(d) ?? 0);
    return `<tr>
      <th scope="row"><span class="swatch s${typeSlot(t)}"></span>${esc(t)}</th>
      <td class="room">${esc(placeWords(roomName[roomFor(t, roomOverrides)], lang).name)}</td>
      <td>${esc(modelsText(o.models, words('common.listSep')))}</td>
      <td class="num">${o.runs}</td>
      ${scoreCell(lastWeek ? lastWeek.score : o.score, lastWeek?.mixed)}
      <td class="num"${o.turnLimit ? ` title="${html('report.turnLimit.title', { n: o.turnLimit })}"` : ''}>${pct(o.successRate)}${o.turnLimit ? ` <span class="muted">${html('report.turnLimit.note', { n: o.turnLimit })}</span>` : ''}</td>
      <td class="num">${pct(o.rerunRate)}</td>
      <td class="num" title="${o.reviewed ? html('report.firstPass.title', { pass: o.firstPass, n: o.reviewed }) : html('report.firstPass.none')}">${o.reviewed ? pct(o.firstPassRate) : '—'}</td>
      <td class="num">${o.medianRounds === undefined ? '—' : num(o.medianRounds, 1)}</td>
      <td class="num">${dur(o.medianMs)}</td>
      <td class="num">${dur(o.p90Ms)}</td>
      <td class="num" title="${html('report.raw', { n: compact(o.medianTokens) })}">${compact(o.medianWeighted)}</td>
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
    words('report.notes.preamble'),
    stats.ambiguousHelpers ? words('report.notes.ambiguous', { n: stats.ambiguousHelpers }) : '',
    stats.unplacedReviews ? words('report.notes.unplaced', { n: stats.unplacedReviews }) : '',
    stats.unmatchedHandbacks ? words('report.notes.unmatched', { n: stats.unmatchedHandbacks }) : '',
    stats.unknownNotifications ? words('report.notes.unknownStatus', { n: stats.unknownNotifications }) : '',
    stats.malformedLines ? words('report.notes.malformed', { n: stats.malformedLines }) : '',
    stats.unlinkedHelpers ? words('report.notes.unlinked', { n: stats.unlinkedHelpers }) : '',
    all.unknown ? words('report.notes.noEnd', { n: all.unknown }) : '',
    ...problems.map((p) => sayIn(lang, p)),
  ].filter(Boolean);
  if (notes.length === 1) notes.length = 0; // only the preamble: nothing to note

  const generated = new Date();
  return `<!doctype html>
<html lang="${languageInfo(lang).html}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${html('report.title')}</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --page: #f9f9f7; --ink: #0b0b0b; --ink-2: #52514e; --muted: #6b6a65;
  --grid: #e1e0d9; --axis: #c3c2b7; --up: #006300; --down: #b3261e; --ring: rgba(11,11,11,0.10); ${seriesCss} }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --surface: #1a1a19; --page: #0d0d0d; --ink: #ffffff; --ink-2: #c3c2b7;
  --muted: #a3a29c; --grid: #2c2c2a; --axis: #383835; --up: #3fcf3f; --down: #ff8a80; --ring: rgba(255,255,255,0.10); ${seriesDark} } }
${seriesRules}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
/* Chinese: running text at 1.6, and a room's name on one line. */
:root:lang(zh) body { line-height: 1.6; }
:root:lang(zh) td.room { white-space: nowrap; }
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
  <h1>${html('report.title')}</h1>
  <p class="sub">${html('report.sub', { period: opt.since !== undefined ? words('report.period') : words('report.lastDays', { n: opt.days }), from: days[0], to: days.at(-1),
    when: generated.toLocaleString(languageInfo(lang).dates), files: words('report.files', { n: stats.files }) })}</p>
  ${machine ? machineLine(machine) : ''}

  <section class="kpis" aria-label="${html('report.kpis')}">
    ${kpi(html('report.kpi.runs'), num(all.runs), prevRuns.length
    ? html(all.runs >= before.runs ? 'report.kpi.up' : 'report.kpi.down', { arrow: all.runs >= before.runs ? '▲' : '▼', diff: num(Math.abs(all.runs - before.runs)) }) : html('report.kpi.noEarlier'))}
    ${kpi(html('report.kpi.success'), pct(all.successRate), deltaText(all.successRate, before.successRate, (d) => words('report.kpi.pts', { d: Math.round(d * 100) })))}
    ${kpi(html('report.kpi.median'), dur(all.medianMs), deltaText(all.medianMs, before.medianMs, dur, false))}
    ${kpi(html('report.kpi.cost'), compact(all.totalWeighted), `${html('report.kpi.raw', { raw: compact(all.totalTokens) })}${prevRuns.length
    ? ` · ${html(all.totalWeighted >= before.totalWeighted ? 'report.kpi.up' : 'report.kpi.down', { arrow: all.totalWeighted >= before.totalWeighted ? '▲' : '▼', diff: compact(Math.abs(all.totalWeighted - before.totalWeighted)) })}` : ''}`)}
  </section>

  <section class="card">
    <h2>${html('report.score.h')}</h2>
    <p class="muted">${html('report.score.intro')}</p>
    <table>
      <thead><tr><th>${html('report.col.agent')}</th><th>${html('report.col.room')}</th><th>${html('report.col.model')}</th><th class="num">${html('report.col.runs')}</th><th class="num">${html('report.col.score')}</th><th class="num">${html('report.col.finished')}</th>
        <th class="num">${html('report.col.reruns')}</th><th class="num">${html('report.col.firstPass')}</th><th class="num">${html('report.col.rounds')}</th><th class="num">${html('report.col.medianTime')}</th><th class="num">${html('report.col.p90Time')}</th><th class="num">${html('report.col.weightedRun')}</th>
        <th class="num">${html('report.col.toolCalls')}</th><th class="num">${html('report.col.toolErrors')}</th><th>${html('report.col.verdicts')}</th><th>${html('report.col.last14')}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="16" class="muted">${html('report.score.none')}</td></tr>`}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>${html('report.daily.h')}</h2>
    <div class="legend">${legend}</div>
    ${dailyColumns(days, roll.daily, typeSlot)}
  </section>

  <section class="card">
    <h2>${html('report.weekly.h')}</h2>
    <div class="legend">${legend}</div>
    ${weeklyScores(roll.weekly, typeSlot)}
    <details><summary>${html('report.weekly.show')}</summary>
      <table><thead><tr><th>${html('report.col.week')}</th><th>${html('report.col.agent')}</th><th class="num">${html('report.col.runs')}</th><th class="num">${html('report.col.score')}</th><th class="num">${html('report.col.finished')}</th>
        <th class="num">${html('report.col.reruns')}</th><th class="num">${html('report.col.medianTime')}</th><th class="num">${html('report.col.weightedRun')}</th></tr></thead>
      <tbody>${weeklyRows}</tbody></table>
    </details>
  </section>

  <section class="card">
    <h2>${html('report.durations.h')}</h2>
    <p class="muted">${html('report.durations.intro')}</p>
    ${durationRanges(typeOrder, roll.overall)}
  </section>

  ${ledgerSection(ledger)}
  ${teamSection(team, opt)}
  ${cost ? costSections({ cost, opt, stats, days }) : ''}

  <section class="card">
    <h2>${html('report.how.h')}</h2>
    <dl class="score">
      <dt>${html('report.how.reliability')}</dt><dd>${markup('report.how.reliabilityDd', { maxTurns: raw('<code>maxTurns</code>') })}</dd>
      <dt>${html('report.how.rightFirst')}</dt><dd>${html('report.how.rightFirstDd')}</dd>
      <dt>${html('report.how.speed')}</dt><dd>${html('report.how.speedDd')}</dd>
      <dt>${html('report.how.efficiency')}</dt><dd>${html('report.how.efficiencyDd')}</dd>
    </dl>
    <p class="muted">${html('report.how.note')}</p>
  </section>

  ${notes.length ? `<section class="card"><h2>${html('report.notes.h')}</h2><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
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
  lang = opt.lang;
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
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

  // Per agent, for --stats-only: counts only, nothing identifying.
  const agents = roll.types.map((t) => {
    const o = roll.overall[t];
    return {
      name: t, runs: o.runs, finished: o.finished, failed: o.failed, stopped: o.stopped, successRate: o.successRate,
      rerunRate: o.rerunRate, medianMs: o.medianMs, p90Ms: o.p90Ms, medianTokens: o.medianTokens, totalTokens: o.totalTokens,
      toolErrorRate: o.toolErrorRate, verdicts: o.verdicts, score: o.score.value, scoreReason: o.score.reason,
      turnLimit: o.turnLimit, reviewed: o.reviewed, firstPassRate: o.firstPassRate, medianRounds: o.medianRounds, noVerdict: o.noVerdict,
      daily: roll.daily.filter((d) => d.type === t).map((d) => ({ day: d.period, runs: d.runs, score: d.score.value })),
    };
  });
  if (opt.statsOnly) {
    const result = { ok: true, days: opt.days, agents, notes: data.stats.malformedLines + data.stats.unlinkedHelpers + data.problems.length };
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
  const ledger = readLedger(claudeDirs, { since, until: now });
  data.problems.push(...ledger.problems);
  fs.writeFileSync(htmlFile, page({ opt, roll, runs, prevRuns, days, stats: data.stats, problems: data.problems, team, cost, machine, ledger }));

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
    verdicts: (r.verdicts ?? []).join(';'),
    rounds: r.rounds,
    turns: r.turns,
    max_turns: r.maxTurns,
    first_review: r.reviewed ? (r.firstPass ? 'pass' : 'fail') : undefined,
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
    'verdicts', 'rounds', 'turns', 'max_turns', 'first_review', 'rerun', 'background', 'mode', 'caller', 'model', 'matched_by', 'tool_calls', 'tool_errors',
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
    turn_limit: r.turnLimit, reviewed: r.reviewed, first_pass_rate: r.firstPassRate?.toFixed(3),
    median_rounds: r.medianRounds, median_turns: r.medianTurns,
  });
  const periodCols = ['period', 'agent', 'runs', 'finished', 'failed', 'stopped', 'unknown', 'success_rate', 'rerun_rate',
    'median_seconds', 'p90_seconds', 'median_tokens', 'median_weighted_tokens', 'models', 'mixed_modes', 'tool_error_rate', 'score',
    'turn_limit', 'reviewed', 'first_pass_rate', 'median_rounds', 'median_turns'];
  fs.writeFileSync(path.join(opt.out, `runs-${stamp}.csv`), csv(runRows, runCols));
  fs.writeFileSync(path.join(opt.out, `daily-${stamp}.csv`), csv(roll.daily.map(periodRow), periodCols));
  fs.writeFileSync(path.join(opt.out, `weekly-${stamp}.csv`), csv(roll.weekly.map(periodRow), periodCols));

  const all = summarise(runs);
  const summary = {
    runs: all.runs, successRate: all.successRate, medianMs: all.medianMs, days: opt.days,
    notes: data.stats.malformedLines + data.stats.unlinkedHelpers + data.problems.length,
  };
  const result = { ok: true, html: htmlFile, dir: opt.out, summary, agents, missingWords: missedWords };
  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  console.log(`Agent report, last ${opt.days} days: ${all.runs} helper runs, ${pct(all.successRate)} finished, median ${dur(all.medianMs, english)}.`);
  for (const t of roll.types) {
    const o = roll.overall[t];
    console.log(`  ${t.padEnd(24)} ${String(o.runs).padStart(4)} runs  ${pct(o.successRate).padStart(4)} finished  median ${dur(o.medianMs, english)}`);
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
    reply = { ok: false, error: err.message, failure: failureOf(err), missingWords: missedWords };
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
