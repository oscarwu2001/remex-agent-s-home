'use strict';

// Batch analysis of transcripts for the performance report: every helper run
// in a date range, what it cost, how long it took and how it ended, rolled up
// per agent type by day and by week. Read-only, like the rest of the app.
//
// Only counts, durations, token numbers and one-word verdicts (PASS/FAIL,
// Approve/Block) leave this module. No prompt, result text, file name or
// command is kept.

const fs = require('fs');
const path = require('path');
const { parseLine, eventsFromEntry } = require('./transcript');

const RERUN_WINDOW_MS = 30 * 60_000;
const MIN_RUNS_FOR_SCORE = 3;

// ---- reading -------------------------------------------------------------

function listTranscripts(roots, sinceMs, problems) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push(`A transcripts folder could not be listed (${err.code})`);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(full).mtimeMs >= sinceMs) files.push(full);
        } catch (err) {
          if (err.code !== 'ENOENT') problems.push(`A transcript could not be opened (${err.code})`);
        }
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return files;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function usageSize(u) {
  return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
    + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
}

function addUsage(tokens, usage) {
  tokens.input += Number(usage.input_tokens) || 0;
  tokens.output += Number(usage.output_tokens) || 0;
  tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
  tokens.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
}

// The first word of a reviewer-style report, and nothing else of it.
function verdictOf(text) {
  if (typeof text !== 'string') return undefined;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = /^[*_#>\s`]*(PASS|FAIL|Approve|Block)\b/i.exec(first);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  return { pass: 'PASS', fail: 'FAIL', approve: 'Approve', block: 'Block' }[v];
}

// Exact prompt text only: a report must not guess which run a helper was.
function samePrompt(a, b) {
  const x = (a || '').trim();
  return Boolean(x) && x === (b || '').trim();
}

// All helper runs and main sessions found in the transcripts.
function collect(roots, { since, until = Date.now() } = {}) {
  const problems = [];
  const stats = {
    files: 0, lines: 0, malformedLines: 0, unlinkedHelpers: 0, ambiguousHelpers: 0,
    unknownNotifications: 0, untimedSessions: 0,
  };
  const sessions = new Map(); // sessionId -> session
  const runs = new Map(); // task tool_use id -> run
  const streams = new Map(); // file#agentId -> sidechain stream
  // Usage per message id: Claude Code repeats a reply's usage on every line
  // of it, so each id counts once, at the largest figure seen.
  const usageById = new Map(); // messageId -> { usage, owner }
  const orphanUsage = []; // [owner, usage] for lines with usage but no id

  const session = (id, meta) => {
    let s = sessions.get(id);
    if (!s) {
      s = { id, project: undefined, start: meta.ts, end: meta.ts, prompts: 0, toolCalls: 0, tokens: emptyTokens(), runs: [] };
      sessions.set(id, s);
    }
    if (meta.cwd && !s.project) s.project = path.basename(meta.cwd.replace(/\\/g, '/'));
    if (meta.ts !== undefined) {
      s.start = s.start === undefined ? meta.ts : Math.min(s.start, meta.ts);
      s.end = s.end === undefined ? meta.ts : Math.max(s.end, meta.ts);
    }
    return s;
  };

  const endRun = (run, ts, outcome, text) => {
    if (!run || run.end !== undefined) return;
    run.end = ts;
    run.outcome = outcome;
    run.verdict = verdictOf(text) ?? run.verdict;
  };

  for (const file of listTranscripts(roots, since, problems)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      problems.push(`A transcript could not be read (${err.code || 'error'})`);
      continue;
    }
    stats.files += 1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      stats.lines += 1;
      let entry;
      try {
        entry = parseLine(line);
      } catch {
        stats.malformedLines += 1; // counted and reported; the line is skipped
        continue;
      }
      if (!entry) continue;
      const { meta, events } = eventsFromEntry(entry);
      const sid = meta.sessionId || path.basename(file, '.jsonl');
      const sess = session(sid, meta);

      const noteUsage = (owner) => {
        if (!meta.usage) return;
        if (!meta.messageId) {
          orphanUsage.push([owner, meta.usage]);
          return;
        }
        const prev = usageById.get(meta.messageId);
        if (!prev || usageSize(meta.usage) > usageSize(prev.usage)) usageById.set(meta.messageId, { usage: meta.usage, owner });
      };

      if (meta.isSidechain) {
        const key = `${file}#${meta.agentId || 'sidechain'}`;
        let st = streams.get(key);
        if (!st) {
          st = { sessionId: sid, prompt: undefined, toolCalls: 0, toolErrors: 0, tokens: emptyTokens() };
          streams.set(key, st);
        }
        noteUsage(st.tokens);
        for (const ev of events) {
          if (ev.kind === 'user-prompt' && st.prompt === undefined) st.prompt = ev.text;
          if (ev.kind === 'tool-start' || ev.kind === 'task-start') st.toolCalls += 1;
          if (ev.kind === 'tool-end' && ev.isError) st.toolErrors += 1;
        }
        continue;
      }

      noteUsage(sess.tokens);
      for (const ev of events) {
        if (ev.via) {
          // Relayed from inside a helper (progress entries). Kept apart from
          // its own transcript's counts, so one run is never counted twice.
          const run = runs.get(ev.via);
          if (!run) continue;
          if (ev.kind === 'tool-start' || ev.kind === 'task-start') run.relayCalls += 1;
          if (ev.kind === 'tool-end' && ev.isError) run.relayErrors += 1;
          continue;
        }
        switch (ev.kind) {
          case 'task-start': {
            if (runs.has(ev.id)) break; // a resumed transcript repeats earlier lines
            const run = {
              id: ev.id, type: ev.subagentType, sessionId: sid, start: ev.ts, end: undefined,
              outcome: undefined, verdict: undefined, background: ev.background, prompt: ev.prompt,
              toolCalls: 0, toolErrors: 0, relayCalls: 0, relayErrors: 0, tokens: emptyTokens(), linked: false,
            };
            runs.set(ev.id, run);
            sess.runs.push(run);
            sess.toolCalls += 1;
            break;
          }
          case 'tool-start':
            sess.toolCalls += 1;
            break;
          case 'tool-end': {
            const run = runs.get(ev.id);
            if (run && !run.background) endRun(run, ev.ts, ev.isError ? 'failed' : 'finished', ev.text);
            break;
          }
          case 'task-notification': {
            const run = runs.get(ev.toolUseId);
            const outcome = { completed: 'finished', failed: 'failed', killed: 'stopped', stopped: 'stopped' }[ev.status];
            if (!outcome) {
              // An end we cannot read: the run stays unknown, and is counted.
              if (run) stats.unknownNotifications += 1;
              break;
            }
            endRun(run, ev.ts, outcome, undefined);
            break;
          }
          case 'user-prompt':
            sess.prompts += 1;
            for (const run of sess.runs) if (!run.background) endRun(run, ev.ts, 'stopped', undefined);
            break;
          default:
            break;
        }
      }
    }
  }

  for (const { usage, owner } of usageById.values()) addUsage(owner, usage);
  for (const [owner, usage] of orphanUsage) addUsage(owner, usage);

  // Attach helper transcripts to their runs by exact prompt, never by guess.
  // Two unlinked runs with the same prompt cannot be told apart: counted.
  for (const st of streams.values()) {
    const sess = sessions.get(st.sessionId);
    const candidates = (sess ? sess.runs : []).filter((r) => !r.linked && samePrompt(r.prompt, st.prompt));
    if (candidates.length !== 1) {
      if (candidates.length > 1) stats.ambiguousHelpers += 1;
      else stats.unlinkedHelpers += 1;
      continue;
    }
    const [run] = candidates;
    run.linked = true;
    run.toolCalls = st.toolCalls;
    run.toolErrors = st.toolErrors;
    for (const k of Object.keys(run.tokens)) run.tokens[k] += st.tokens[k];
  }
  // Runs with no transcript of their own fall back to relayed counts.
  for (const run of runs.values()) {
    if (!run.linked) {
      run.toolCalls = run.relayCalls;
      run.toolErrors = run.relayErrors;
    }
    delete run.relayCalls;
    delete run.relayErrors;
  }

  const inRange = (t) => t !== undefined && t >= since && t <= until;
  const allRuns = [...runs.values()].filter((r) => inRange(r.start));
  markReruns(allRuns);
  for (const r of allRuns) {
    r.durationMs = r.end !== undefined ? Math.max(0, r.end - r.start) : undefined;
    if (r.outcome === undefined) r.outcome = 'unknown';
    delete r.prompt; // content never leaves this module
  }
  stats.untimedSessions = [...sessions.values()].filter((s) => s.start === undefined).length;
  const allSessions = [...sessions.values()].filter((s) => inRange(s.start) || s.runs.some((r) => inRange(r.start)));
  for (const s of allSessions) s.runs = s.runs.filter((r) => inRange(r.start));

  return { runs: allRuns, sessions: allSessions, stats, problems: [...new Set(problems)] };
}

// A run is a re-run when the same session calls the same agent type again
// within 30 minutes after that type's previous run failed or was stopped:
// the agent did not deliver the first time. Being called again after a
// successful run is just more work, and a reviewer answering FAIL is doing
// its job, so neither counts.
function markReruns(runs) {
  const bySessionType = new Map();
  for (const r of runs) {
    const k = `${r.sessionId}|${r.type}`;
    if (!bySessionType.has(k)) bySessionType.set(k, []);
    bySessionType.get(k).push(r);
  }
  for (const list of bySessionType.values()) {
    list.sort((a, b) => a.start - b.start);
    list.forEach((r, i) => {
      const prev = list[i - 1];
      const prevEnd = prev ? prev.end ?? prev.start : undefined;
      const undelivered = prev && (prev.outcome === 'failed' || prev.outcome === 'stopped');
      r.rerun = Boolean(undelivered && r.start - prevEnd <= RERUN_WINDOW_MS);
    });
  }
}

// ---- rolling up -------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function totalTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

// Summary of a set of runs of one agent type.
function summarise(runs) {
  const ended = runs.filter((r) => r.outcome !== 'unknown');
  const finished = ended.filter((r) => r.outcome === 'finished').length;
  const durations = ended.map((r) => r.durationMs).filter((d) => d !== undefined).sort((a, b) => a - b);
  const tokens = runs.filter((r) => r.linked).map((r) => totalTokens(r.tokens)).sort((a, b) => a - b);
  const toolCalls = runs.reduce((k, r) => k + r.toolCalls, 0);
  const toolErrors = runs.reduce((k, r) => k + r.toolErrors, 0);
  const verdicts = {};
  for (const r of runs) if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
  return {
    runs: runs.length,
    ended: ended.length,
    finished,
    failed: ended.filter((r) => r.outcome === 'failed').length,
    stopped: ended.filter((r) => r.outcome === 'stopped').length,
    unknown: runs.length - ended.length,
    successRate: ended.length ? finished / ended.length : undefined,
    rerunRate: runs.length ? runs.filter((r) => r.rerun).length / runs.length : undefined,
    medianMs: quantile(durations, 0.5),
    p90Ms: quantile(durations, 0.9),
    toolCallsPerRun: runs.length ? toolCalls / runs.length : undefined,
    toolErrorRate: toolCalls ? toolErrors / toolCalls : undefined,
    medianTokens: quantile(tokens, 0.5),
    totalTokens: tokens.reduce((a, b) => a + b, 0),
    verdicts,
  };
}

// Score out of 100, always shown with its parts. Speed and efficiency are
// judged against the same agent's own baseline, never against other agents:
// a reviewer is not "slower" than a runner, it does a different job.
//   reliability 40  finished / ended
//   right first 20  1 - re-run rate
//   speed       20  baseline median duration / this median, capped at 1
//   efficiency  20  baseline median tokens / this median, capped at 1
//
// A part that cannot be measured (no finished run with a time, no linked
// token data, no baseline) is left out, never given full marks, and the
// score is scaled over the parts that were measured.
const WEIGHTS = { reliability: 40, rightFirst: 20, speed: 20, efficiency: 20 };

function score(summary, baseline) {
  if (summary.runs < MIN_RUNS_FOR_SCORE) return { value: undefined, reason: `fewer than ${MIN_RUNS_FOR_SCORE} runs` };
  if (summary.successRate === undefined) return { value: undefined, reason: 'no run has ended yet' };
  const ratio = (base, now) => (base > 0 && now > 0 ? Math.min(1, base / now) : undefined);
  const fraction = {
    reliability: summary.successRate,
    rightFirst: summary.rerunRate === undefined ? undefined : 1 - summary.rerunRate,
    speed: baseline ? ratio(baseline.medianMs, summary.medianMs) : undefined,
    efficiency: baseline ? ratio(baseline.medianTokens, summary.medianTokens) : undefined,
  };
  const parts = {};
  let got = 0;
  let possible = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (fraction[k] === undefined) continue;
    parts[k] = w * fraction[k];
    got += parts[k];
    possible += w;
  }
  const missing = Object.keys(WEIGHTS).filter((k) => !(k in parts));
  return { value: Math.round((100 * got) / possible), parts, missing };
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ISO week, e.g. 2026-W39 (weeks start on Monday).
function weekKey(ms) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// Everything the report shows.
function rollUp({ runs, sessions }) {
  const types = [...new Set(runs.map((r) => r.type))].sort();
  const overall = Object.fromEntries(
    [...groupBy(runs, (r) => r.type)].map(([type, list]) => [type, summarise(list)]),
  );
  const period = (keyFn) => {
    const out = [];
    for (const [key, list] of [...groupBy(runs, (r) => keyFn(r.start))].sort()) {
      for (const [type, rs] of groupBy(list, (r) => r.type)) {
        const summary = summarise(rs);
        out.push({ period: key, type, ...summary, score: score(summary, overall[type]) });
      }
    }
    return out;
  };
  const sessionDays = [...groupBy(sessions.filter((s) => s.start !== undefined), (s) => dayKey(s.start))].sort().map(([day, list]) => ({
    period: day,
    sessions: list.length,
    prompts: list.reduce((k, s) => k + s.prompts, 0),
    helperRuns: list.reduce((k, s) => k + s.runs.length, 0),
    tokens: list.reduce((k, s) => k + totalTokens(s.tokens), 0),
  }));
  return {
    types,
    // The whole period has no baseline of its own, so only reliability and
    // right-first-time count toward its score.
    overall: Object.fromEntries(types.map((t) => [t, { ...overall[t], score: score(overall[t], null) }])),
    daily: period(dayKey),
    weekly: period(weekKey),
    sessionDays,
  };
}

module.exports = {
  collect, rollUp, summarise, score, verdictOf, dayKey, weekKey, totalTokens, MIN_RUNS_FOR_SCORE,
};
