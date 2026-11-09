'use strict';

// Batch analysis of transcripts for the performance report: every helper run
// in a date range, what it cost, how long it took and how it ended, rolled up
// per agent type by day and by week. Read-only, like the rest of the app.
//
// Only counts, durations, token numbers, names (agents, skills, models) and
// one-word verdicts (PASS/FAIL, Approve/Block) leave this module. No result
// text, file name or command is kept. A helper's Agent-call description and
// the first line of its prompt are kept only when asked for (`details`),
// because privacy mode hides them.

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

// The verdict of a reviewer-style report, and nothing else of it: a closing
// "VERDICT: PASS|FAIL|BLOCKED" line (the verdict ledger's format) wins, else
// the report's first word. BLOCKED means the review could not be finished.
const VERDICT_WORDS = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', approve: 'Approve', block: 'Block' };
function verdictOf(text) {
  if (typeof text !== 'string') return undefined;
  const lines = text.split('\n').map((l) => l.trim().replace(/^[*_#>`\s]+|[*_`\s]+$/g, '')).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^VERDICT:\s*(PASS|FAIL|BLOCKED)\b/i.exec(lines[i]);
    if (m) return VERDICT_WORDS[m[1].toLowerCase()];
  }
  const m = /^(PASS|FAIL|BLOCKED|Approve|Block)\b/i.exec(lines[0] ?? '');
  return m ? VERDICT_WORDS[m[1].toLowerCase()] : undefined;
}

// Only a closing "VERDICT:" line: what marks an agent as a review agent.
function verdictLine(text) {
  if (typeof text !== 'string') return undefined;
  const m = /(?:^|\n)[*_#>`\s]*VERDICT:\s*(PASS|FAIL|BLOCKED)\b[^\n]*\s*$/i.exec(text.trimEnd());
  return m ? VERDICT_WORDS[m[1].toLowerCase()] : undefined;
}

// Agents whose job is a verdict. Any other agent counts too once one of its
// replies ends on an explicit VERDICT line (a first word alone, such as a
// runner's "PASS, 228 tests", does not make it one).
const REVIEW_AGENTS = new Set(['reviewer', 'code-reviewer', 'ui-reviewer', 'silent-failure-hunter']);

// An agent's maxTurns, from its definition beside the transcripts
// (<.claude>/agents/<type>.md), or undefined when it sets none.
function turnLimits(roots, problems) {
  const dirs = [...new Set(roots.map((r) => path.join(path.dirname(r), 'agents')))];
  const cache = new Map();
  return (type) => {
    if (!type || !/^[A-Za-z0-9_.-]+$/.test(type)) return undefined;
    if (cache.has(type)) return cache.get(type);
    let max;
    for (const dir of dirs) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, `${type}.md`), 'utf8');
      } catch (err) {
        // Most agents are not defined in every folder; only a real failure is reported.
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') problems.push(`An agent definition could not be read (${err.code})`);
        continue;
      }
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const m = front && /^maxTurns:\s*(\d+)\s*$/m.exec(front[1]);
      if (m) {
        max = Number(m[1]);
        break;
      }
    }
    cache.set(type, max);
    return max;
  };
}

// Exact prompt text only: a report must not guess which run a helper was.
function samePrompt(a, b) {
  const x = (a || '').trim();
  return Boolean(x) && x === (b || '').trim();
}

// All helper runs and main sessions found in the transcripts.
// The skill a Skill tool call runs: its name only (without a leading slash),
// never its arguments.
function skillName(ev) {
  if (ev.name !== 'Skill') return undefined;
  const raw = ev.input?.skill ?? ev.input?.command;
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/^\//, '').split(/\s/)[0];
  return name || undefined;
}

// The tools whose use is counted per helper run (the rest count as other).
const TOOL_KINDS = { Read: 'Read', Grep: 'Grep', Glob: 'Glob', Bash: 'Bash', WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  Edit: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit', Write: 'Write' };
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 140) ?? '';

function collect(roots, { since, until = Date.now(), details = false } = {}) {
  const problems = [];
  const maxTurnsOf = turnLimits(roots, problems);
  // Hand-backs that reached the main session (the Claude app's peer
  // messages), by the helper's agent id, and SendMessage calls to a helper.
  const mainHandbacks = new Map(); // agentId -> Map(key -> { ts, text })
  const sends = new Map(); // agentId or name -> [ts]
  const sendIds = new Set(); // SendMessage tool_use ids seen (resumed files repeat lines)
  const stats = {
    files: 0, lines: 0, malformedLines: 0, unlinkedHelpers: 0, ambiguousHelpers: 0,
    unknownNotifications: 0, untimedSessions: 0, unmatchedHandbacks: 0, unplacedReviews: 0,
    helperTranscripts: 0, matchedByAgentId: 0, matchedByPrompt: 0,
  };
  const sessions = new Map(); // sessionId -> session
  const runs = new Map(); // task tool_use id -> run
  const streams = new Map(); // file#agentId -> sidechain stream
  // Usage per message id: Claude Code repeats a reply's usage on every line
  // of it, so each id counts once, at the largest figure seen.
  const usageById = new Map(); // messageId -> { usage, owner }
  const orphanUsage = []; // [owner, usage] for lines with usage but no id
  // Skill uses: by the main session (typed as /name, or picked by Claude
  // with the Skill tool) and inside helpers. Names only, never arguments.
  const skillUses = [];
  const skillById = new Map(); // Skill tool_use id -> use

  const session = (id, meta) => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, project: undefined, cwd: undefined, start: meta.ts, end: meta.ts, prompts: 0, toolCalls: 0, tokens: emptyTokens(), runs: [], steps: [],
        activeSkill: undefined, // the skill running the current turn, for a helper's caller
      };
      sessions.set(id, s);
    }
    if (meta.cwd && !s.project) {
      s.cwd = meta.cwd;
      s.project = path.basename(meta.cwd.replace(/\\/g, '/'));
    }
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
        // One stream per helper: by its agent id when known (a helper can
        // show up both inline and in its own subagents/ file), else per file.
        const fromName = /agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file);
        const agentId = meta.agentId || (fromName && fromName[1]) || undefined;
        const key = agentId ? `agent:${agentId}` : `${file}#sidechain`;
        let st = streams.get(key);
        if (!st) {
          st = {
            sessionId: sid, agentId, prompt: undefined, toolCalls: 0, toolErrors: 0,
            tokens: emptyTokens(), skills: [], tools: {}, model: undefined, firstTs: undefined, lastTs: undefined, linked: false,
            // Hand-backs, keyed so a line seen twice (a reply written as a
            // thinking line and a text line, a transcript found in two
            // places) counts once: a closing reply by its message id, a
            // SubagentHandback call by its tool id. Messages from the parent
            // (its SendMessage follow-ups) separate one round from the next.
            // Turns are counted per stretch of model calls, which ends at a
            // hand-back or a notification, so a stretch that reached the
            // agent's maxTurns can be told apart.
            handbacks: new Map(), aliases: new Map(), lastHandback: undefined, parentAt: [],
            stretches: [{ turns: new Set(), handedBack: false }], toolsSinceHandback: true,
          };
          streams.set(key, st);
        }
        noteUsage(st.tokens);
        const stretch = () => st.stretches[st.stretches.length - 1];
        const nextStretch = () => {
          if (stretch().turns.size || stretch().handedBack) st.stretches.push({ turns: new Set(), handedBack: false });
        };
        if (meta.messageId && meta.model !== '<synthetic>' && !stretch().turns.has(meta.messageId)) {
          if (stretch().handedBack) nextStretch();
          stretch().turns.add(meta.messageId);
        }
        const handBack = (key, text, call) => {
          if (!key) return;
          const known = st.handbacks.get(st.aliases.get(key) ?? key);
          if (known) {
            // Another line of the same reply: its text joins the rest.
            if (text) known.text = known.text ? `${known.text}\n${text}` : text;
            if (meta.ts !== undefined) known.ts = Math.max(known.ts ?? meta.ts, meta.ts);
            return;
          }
          // A closing reply right after a SubagentHandback call, with no
          // work in between, is that same hand-back.
          const prev = st.handbacks.get(st.lastHandback);
          if (!call && prev?.call && !st.toolsSinceHandback) {
            st.aliases.set(key, st.lastHandback);
            if (text) prev.extra = prev.extra ? `${prev.extra}\n${text}` : text;
            return;
          }
          st.handbacks.set(key, { ts: meta.ts, text: text || '', call });
          st.lastHandback = key;
          stretch().handedBack = true;
          st.toolsSinceHandback = false;
        };
        if (meta.ts !== undefined) {
          st.firstTs = st.firstTs === undefined ? meta.ts : Math.min(st.firstTs, meta.ts);
          st.lastTs = st.lastTs === undefined ? meta.ts : Math.max(st.lastTs, meta.ts);
        }
        if (meta.model && !st.model && meta.model !== '<synthetic>') st.model = meta.model;
        for (const ev of events) {
          // Reminders and interruptions inside a stretch do not end it; a
          // notification does, as maxTurns counts from there.
          if (ev.kind === 'task-notification') nextStretch();
          if (ev.kind === 'parent-message' && ev.ts !== undefined) st.parentAt.push(ev.ts);
          if (ev.kind === 'user-prompt' && st.prompt === undefined) st.prompt = ev.text;
          if (ev.kind === 'tool-start' && ev.name === 'SubagentHandback') handBack(`call:${ev.id}`, String(ev.input?.message ?? ''), true);
          else if (ev.kind === 'assistant-text' && ev.stopReason === 'end_turn') handBack(meta.messageId ? `msg:${meta.messageId}` : `line:${meta.ts}`, ev.text, false);
          else if (ev.kind === 'tool-start' || ev.kind === 'task-start') st.toolsSinceHandback = true;
          if (ev.kind === 'tool-start' || ev.kind === 'task-start') {
            st.toolCalls += 1;
            const kind = TOOL_KINDS[ev.name] ?? 'other';
            st.tools[kind] = (st.tools[kind] ?? 0) + 1;
          }
          if (ev.kind === 'tool-end' && ev.isError) st.toolErrors += 1;
          const name = ev.kind === 'tool-start' && skillName(ev);
          if (name && !skillById.has(ev.id)) {
            const use = { name, source: 'helper', by: undefined, sessionId: sid, ts: ev.ts, isError: false };
            st.skills.push(use);
            skillById.set(ev.id, use);
          }
          if (ev.kind === 'tool-end' && skillById.has(ev.id)) skillById.get(ev.id).isError = ev.isError;
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
              agentId: undefined, model: ev.model, caller: sess.activeSkill ? `/${sess.activeSkill}` : 'direct',
              tools: {}, skillLoads: [], notifiedAt: undefined, lastSeen: undefined, linkedBy: undefined,
              ...(details ? { description: ev.description || '', promptLine: firstLine(ev.prompt) } : {}),
            };
            runs.set(ev.id, run);
            sess.runs.push(run);
            sess.steps.push({ ts: ev.ts, kind: 'agent', run });
            sess.toolCalls += 1;
            break;
          }
          case 'handback': {
            if (!ev.agentId) {
              stats.unmatchedHandbacks += 1; // counted and reported
              break;
            }
            if (!mainHandbacks.has(ev.agentId)) mainHandbacks.set(ev.agentId, new Map());
            mainHandbacks.get(ev.agentId).set(`${ev.ts}`, { ts: ev.ts, text: ev.text });
            break;
          }
          case 'tool-start': {
            sess.toolCalls += 1;
            if (ev.name === 'SendMessage' && typeof ev.input?.to === 'string' && !sendIds.has(ev.id)) {
              sendIds.add(ev.id);
              if (!sends.has(ev.input.to)) sends.set(ev.input.to, []);
              sends.get(ev.input.to).push(ev.ts);
            }
            const name = skillName(ev);
            if (name) sess.activeSkill = name;
            if (name && !skillById.has(ev.id)) { // a resumed transcript repeats earlier lines
              const use = { name, source: 'claude', by: 'you', sessionId: sid, ts: ev.ts, isError: false };
              skillUses.push(use);
              skillById.set(ev.id, use);
              sess.steps.push({ ts: ev.ts, kind: 'skill', use });
            }
            break;
          }
          case 'tool-end': {
            if (skillById.has(ev.id)) skillById.get(ev.id).isError = ev.isError;
            const run = runs.get(ev.id);
            if (run && ev.agentId) run.agentId = ev.agentId;
            // A launch that went to the background returns at once: its end
            // is the helper's own last line or its notification, not this.
            if (run && ev.async) run.background = true;
            if (run && !run.background) endRun(run, ev.ts, ev.isError ? 'failed' : 'finished', ev.text);
            break;
          }
          case 'task-notification': {
            const run = runs.get(ev.toolUseId);
            if (run) run.notifiedAt = ev.ts;
            const outcome = { completed: 'finished', failed: 'failed', killed: 'stopped', stopped: 'stopped' }[ev.status];
            if (!outcome) {
              // An end we cannot read: the run stays unknown, and is counted.
              if (run) stats.unknownNotifications += 1;
              break;
            }
            endRun(run, ev.ts, outcome, undefined);
            break;
          }
          case 'user-prompt': {
            const typed = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(ev.text ?? '');
            const key = typed && `${sid}|${ev.ts}|${typed[1]}`;
            // A typed /command starts a turn run by that skill; any other
            // prompt starts a turn run by no skill.
            sess.activeSkill = typed ? typed[1] : undefined;
            if (typed && !skillById.has(key)) {
              skillById.set(key, true);
              const use = { name: typed[1], source: 'typed', by: 'you', sessionId: sid, ts: ev.ts, isError: false };
              skillUses.push(use);
              sess.steps.push({ ts: ev.ts, kind: 'skill', use });
            }
          }
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

  // Attach helper transcripts to their runs: by the helper's agent id when
  // the call's result names it, else by exact prompt in the same session,
  // never by guess. Two unlinked runs with the same prompt cannot be told
  // apart; what stays unmatched is reported as unattributed, with its tokens.
  const byAgentId = new Map([...runs.values()].filter((r) => r.agentId).map((r) => [r.agentId, r]));
  const link = (st, run, how) => {
    for (const use of st.skills) use.by = run.type;
    st.linked = true;
    run.linked = true;
    run.linkedBy = how;
    run.toolCalls = st.toolCalls;
    run.toolErrors = st.toolErrors;
    run.tools = { ...st.tools };
    run.model = st.model ?? run.model;
    run.lastSeen = st.lastTs;
    run.skillLoads = st.skills.map((u) => u.name);
    run.handbacks = [...st.handbacks.values()].map((h) => ({ ts: h.ts, text: h.extra ? `${h.text}\n${h.extra}` : h.text, call: h.call }));
    run.parentAt = st.parentAt;
    run.stretches = st.stretches;
    for (const k of Object.keys(run.tokens)) run.tokens[k] += st.tokens[k];
  };
  stats.helperTranscripts = streams.size;
  for (const st of streams.values()) {
    const run = st.agentId && byAgentId.get(st.agentId);
    if (run && !run.linked) {
      link(st, run, 'agent id');
      stats.matchedByAgentId += 1;
    }
  }
  for (const st of streams.values()) {
    if (st.linked) continue;
    const sess = sessions.get(st.sessionId);
    // Never across agent ids: a run that names a different helper is not this one.
    const candidates = (sess ? sess.runs : []).filter((r) => !r.linked && !(r.agentId && st.agentId && r.agentId !== st.agentId)
      && samePrompt(r.prompt, st.prompt));
    if (candidates.length !== 1) {
      if (candidates.length > 1) stats.ambiguousHelpers += 1;
      else stats.unlinkedHelpers += 1;
      continue;
    }
    link(st, candidates[0], 'prompt');
    stats.matchedByPrompt += 1;
  }
  // Runs with no transcript of their own fall back to relayed counts.
  for (const run of runs.values()) {
    if (!run.linked) {
      run.toolCalls = run.relayCalls;
      run.toolErrors = run.relayErrors;
    }
    delete run.relayCalls;
    delete run.relayErrors;
    // Hand-backs: from the helper's own transcript, else from the peer
    // messages that reached the main session. One verdict per round, so a
    // re-check after fixes counts as a verdict of its own.
    const sent = ((run.agentId && sends.get(run.agentId)) || []).filter((t) => t >= run.start);
    const handbacks = rounds(
      run.handbacks?.length ? run.handbacks : [...((run.agentId && mainHandbacks.get(run.agentId))?.values() ?? [])],
      [...(run.parentAt ?? []), ...sent],
    );
    if (run.agentId) mainHandbacks.delete(run.agentId);
    const said = handbacks.filter((h) => h.verdict);
    run.verdicts = said.length ? said.map((h) => h.verdict) : run.verdict ? [run.verdict] : [];
    run.verdict = run.verdicts[0];
    run.explicitVerdict = handbacks.some((h) => h.explicit);
    run.verdictTimes = said.length ? said.map((h) => [h.ts, h.verdict]) : run.verdict ? [[run.end ?? run.start, run.verdict]] : [];
    run.handbackTimes = handbacks.map((h) => h.ts).filter((t) => t !== undefined);
    run.handedBack = handbacks.length;
    run.firstHandbackAt = run.handbackTimes[0];
    run.resumes = sent.length;
    run.rounds = Math.max(1, handbacks.length, run.resumes + 1);
    // Turns up to the first hand-back, and whether a stretch before it ran
    // into the agent's maxTurns without handing back: such a run did not
    // deliver, though its notification said completed. The limit is the
    // agent file's as it is today. A run that failed or was stopped keeps
    // that outcome.
    const max = maxTurnsOf(run.type);
    let turns = 0;
    let limit = false;
    for (const s of run.stretches ?? []) {
      turns += s.turns.size;
      if (max && s.turns.size >= max && !s.handedBack) limit = true;
      if (s.handedBack || limit) break;
    }
    run.turns = run.stretches ? turns : undefined;
    run.maxTurns = max;
    if (limit && (run.outcome === undefined || run.outcome === 'finished')) run.outcome = 'turn limit';
    delete run.handbacks;
    delete run.stretches;
    delete run.parentAt;
  }
  // Peer hand-backs from helpers that match no run: counted and reported.
  for (const list of mainHandbacks.values()) stats.unmatchedHandbacks += list.size;

  const inRange = (t) => t !== undefined && t >= since && t <= until;
  const allRuns = [...runs.values()].filter((r) => inRange(r.start));
  markReruns(allRuns);
  for (const r of allRuns) {
    r.mode = r.background ? 'background' : 'foreground';
    // A background helper runs on after its launch returns: it ends with its
    // own last transcript line or its completion notice, whichever is later.
    if (r.background) {
      const ends = [r.notifiedAt, r.lastSeen].filter((t) => t !== undefined && t >= r.start);
      r.end = ends.length ? Math.max(...ends) : undefined;
    }
    // A run that handed back is timed to its first hand-back: later rounds
    // (fixing review findings after a SendMessage) and the time it sat idle
    // in between are not the first delivery.
    if (r.firstHandbackAt !== undefined && r.firstHandbackAt >= r.start) r.end = Math.min(r.end ?? Infinity, r.firstHandbackAt);
    r.durationMs = r.end !== undefined ? Math.max(0, r.end - r.start) : undefined;
    if (r.outcome === undefined) r.outcome = 'unknown';
    delete r.prompt; // content never leaves this module
  }
  firstReviews(allRuns, stats);
  stats.untimedSessions = [...sessions.values()].filter((s) => s.start === undefined).length;
  const allSessions = [...sessions.values()].filter((s) => inRange(s.start) || s.runs.some((r) => inRange(r.start)));
  for (const s of allSessions) s.runs = s.runs.filter((r) => inRange(r.start));

  // Helper skill uses whose helper could not be matched stay unattributed.
  for (const st of streams.values()) for (const use of st.skills) skillUses.push(use);
  const skills = skillUses.filter((u) => inRange(u.ts));
  for (const s of allSessions) {
    s.steps = s.steps.filter((st) => inRange(st.ts)).sort((a, b) => a.ts - b.ts)
      .map((st) => (st.kind === 'agent'
        ? { kind: 'agent', ts: st.ts, name: st.run.type, outcome: st.run.outcome, verdict: st.run.verdict }
        : { kind: 'skill', ts: st.ts, name: st.use.name, source: st.use.source }));
  }

  // Helper transcripts that match no call: kept, with their tokens.
  const unattributed = [...streams.values()].filter((st) => !st.linked && inRange(st.firstTs ?? st.lastTs)).map((st) => ({
    sessionId: st.sessionId, agentId: st.agentId, model: st.model, start: st.firstTs, end: st.lastTs,
    tokens: st.tokens, toolCalls: st.toolCalls, tools: { ...st.tools }, skillLoads: st.skills.map((u) => u.name),
  }));
  // Working folders, only to find project skills; the report never prints them.
  const cwds = [...new Set(allSessions.map((x) => x.cwd).filter(Boolean))];
  for (const x of allSessions) delete x.activeSkill;

  return { runs: allRuns, sessions: allSessions, skills, unattributed, cwds, stats, problems: [...new Set(problems)] };
}

// A run is a re-run when the same session calls the same agent type again
// within 30 minutes after that type's previous run failed or was stopped:
// the agent did not deliver the first time. Being called again after a
// successful run is just more work, and a reviewer answering FAIL is doing
// its job, so neither counts.
// Hand-backs in time order, one per round: a hand-back with no message from
// the parent since the one before it (a report the user's hook made the
// agent send again, say) replaces that one, later time and verdict winning.
function rounds(handbacks, parentTimes) {
  const out = [];
  for (const h of [...handbacks].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    const item = { ts: h.ts, verdict: verdictOf(h.text), explicit: Boolean(verdictLine(h.text)) };
    const prev = out[out.length - 1];
    if (prev && !parentTimes.some((t) => t > (prev.ts ?? -Infinity) && t <= (h.ts ?? Infinity))) {
      out[out.length - 1] = { ts: item.ts ?? prev.ts, verdict: item.verdict ?? prev.verdict, explicit: item.explicit || prev.explicit };
    } else out.push(item);
  }
  return out;
}

// Builders' first review. A review goes to the one run that edited files
// and handed back after the session's previous review started and before
// this one did. With none, it is a re-check of what the previous review
// looked at. With several (builders running side by side), it cannot be
// placed without guessing, so it is counted instead. A run's round is how
// many times it had handed back by the verdict; it passed first time when
// its earliest reviewed round has no FAIL.
function firstReviews(runs, stats) {
  const reviewTypes = new Set([...REVIEW_AGENTS, ...runs.filter((r) => r.explicitVerdict).map((r) => r.type)]);
  for (const list of groupBy(runs, (r) => r.sessionId).values()) {
    const builds = list.filter((r) => !reviewTypes.has(r.type) && ((r.tools.Edit ?? 0) + (r.tools.Write ?? 0)) > 0)
      .map((b) => ({ b, times: b.handbackTimes.length ? b.handbackTimes : [b.end ?? b.start], seen: [] }));
    let prevStart = -Infinity;
    let prevTarget;
    let prevUnplaced = false;
    for (const rev of list.filter((r) => reviewTypes.has(r.type)).sort((a, b) => a.start - b.start)) {
      const fresh = builds.filter((x) => x.times.some((t) => t > prevStart && t <= rev.start));
      const target = fresh.length === 1 ? fresh[0] : fresh.length === 0 ? prevTarget : undefined;
      // Unplaced: several candidates, or a re-check of a review that was.
      const unplaced = !target && (fresh.length > 1 || (fresh.length === 0 && prevUnplaced));
      if (unplaced && rev.verdictTimes.length) stats.unplacedReviews += 1;
      prevStart = rev.start;
      prevTarget = target;
      prevUnplaced = unplaced;
      if (!target) continue;
      for (const [t, v] of rev.verdictTimes) {
        if (v !== 'PASS' && v !== 'FAIL') continue;
        target.seen.push({ round: target.times.filter((h) => h <= (t ?? Infinity)).length, v });
      }
    }
    for (const { b, seen } of builds) {
      b.reviewed = seen.length > 0;
      if (!b.reviewed) continue;
      const first = Math.min(...seen.map((x) => x.round));
      b.firstPass = !seen.some((x) => x.round === first && x.v === 'FAIL');
    }
  }
  for (const r of runs) {
    r.reviewAgent = reviewTypes.has(r.type);
    delete r.verdictTimes;
    delete r.handbackTimes;
    delete r.explicitVerdict;
  }
}

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
      const undelivered = prev && (prev.outcome === 'failed' || prev.outcome === 'stopped' || prev.outcome === 'turn limit');
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

// Cost weighting, in fresh-input-token equivalents. Cache reads cost about a
// tenth of fresh input, cache writes a little more than it, output several
// times it; the report states this, so heavy cache re-reads do not look like
// fresh spending.
const COST_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const weighted = (t) => Object.entries(COST_WEIGHTS).reduce((n, [k, w]) => n + (t?.[k] ?? 0) * w, 0);

// Summary of a set of runs of one agent type.
function summarise(runs) {
  const ended = runs.filter((r) => r.outcome !== 'unknown');
  const finished = ended.filter((r) => r.outcome === 'finished').length;
  // Times come from every run with a recorded end (a background run that
  // has no notification but whose transcript stops still has one).
  const durations = runs.map((r) => r.durationMs).filter((d) => d !== undefined).sort((a, b) => a - b);
  const linked = runs.filter((r) => r.linked);
  const tokens = linked.map((r) => totalTokens(r.tokens)).sort((a, b) => a - b);
  const costs = linked.map((r) => weighted(r.tokens)).sort((a, b) => a - b);
  const models = {};
  for (const r of runs) if (r.model) models[r.model] = (models[r.model] || 0) + 1;
  const toolCalls = runs.reduce((k, r) => k + r.toolCalls, 0);
  const toolErrors = runs.reduce((k, r) => k + r.toolErrors, 0);
  const verdicts = {};
  for (const r of runs) for (const v of r.verdicts ?? (r.verdict ? [r.verdict] : [])) verdicts[v] = (verdicts[v] || 0) + 1;
  const sorted = (key) => runs.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
  const reviewed = runs.filter((r) => r.reviewed).length;
  const firstPass = runs.filter((r) => r.reviewed && r.firstPass).length;
  return {
    runs: runs.length,
    ended: ended.length,
    finished,
    failed: ended.filter((r) => r.outcome === 'failed').length,
    stopped: ended.filter((r) => r.outcome === 'stopped').length,
    unknown: runs.length - ended.length,
    noEnd: runs.filter((r) => r.durationMs === undefined).length,
    successRate: ended.length ? finished / ended.length : undefined,
    rerunRate: runs.length ? runs.filter((r) => r.rerun).length / runs.length : undefined,
    medianMs: quantile(durations, 0.5),
    p90Ms: quantile(durations, 0.9),
    toolCallsPerRun: runs.length ? toolCalls / runs.length : undefined,
    toolErrorRate: toolCalls ? toolErrors / toolCalls : undefined,
    medianTokens: quantile(tokens, 0.5),
    totalTokens: tokens.reduce((a, b) => a + b, 0),
    medianWeighted: quantile(costs, 0.5),
    totalWeighted: costs.reduce((a, b) => a + b, 0),
    models,
    verdicts,
    // A run that ran into its maxTurns without handing back.
    turnLimit: ended.filter((r) => r.outcome === 'turn limit').length,
    medianTurns: quantile(sorted('turns'), 0.5),
    // Hand-backs per run: 2 means one round of fixes after a review.
    medianRounds: quantile(sorted('rounds'), 0.5),
    // Builders: runs a review agent judged, and those that passed the first round.
    reviewed,
    firstPass,
    firstPassRate: reviewed ? firstPass / reviewed : undefined,
    // Review agents that handed back with no verdict anyone could read.
    noVerdict: runs.filter((r) => r.reviewAgent && r.handedBack && !(r.verdicts ?? []).length).length,
  };
}

// Score out of 100, always shown with its parts. Speed and efficiency are
// judged against the same agent's own baseline, never against other agents:
// a reviewer is not "slower" than a runner, it does a different job.
//   reliability 40  finished / ended (a run stopped by its turn limit did not finish)
//   right first 20  builders with 3+ reviewed runs: first review passed;
//                   others: 1 - re-run rate
//   speed       20  baseline median duration / this median, capped at 1
//   efficiency  20  baseline median weighted tokens / this median, capped at 1
//
// A part that cannot be measured (no finished run with a time, no linked
// token data, no baseline) is left out, never given full marks, and the
// score is scaled over the parts that were measured.
const WEIGHTS = { reliability: 40, rightFirst: 20, speed: 20, efficiency: 20 };

function ratio(base, now) {
  return base > 0 && now > 0 ? Math.min(1, base / now) : undefined;
}

// `byMode`, when given, replaces the speed and efficiency fractions: a
// period's foreground runs are judged against the agent's foreground median
// and its background runs against its background median, then the two are
// weighted by how many runs each fraction covers.
function score(summary, baseline, byMode) {
  if (summary.runs < MIN_RUNS_FOR_SCORE) return { value: undefined, reason: `fewer than ${MIN_RUNS_FOR_SCORE} runs` };
  if (summary.successRate === undefined) return { value: undefined, reason: 'no run has ended yet' };
  const fraction = {
    reliability: summary.successRate,
    // A builder that is reviewed is right first time when its first review
    // passes; any other agent when it is not called again after failing.
    rightFirst: summary.reviewed >= MIN_RUNS_FOR_SCORE ? summary.firstPassRate
      : summary.rerunRate === undefined ? undefined : 1 - summary.rerunRate,
    speed: byMode ? byMode.speed : baseline ? ratio(baseline.medianMs, summary.medianMs) : undefined,
    efficiency: byMode ? byMode.efficiency : baseline ? ratio(baseline.medianWeighted, summary.medianWeighted) : undefined,
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
  // Foreground and background times are not comparable, so each mode has
  // its own baseline and a period is judged mode by mode (see score).
  const modeOf = (r) => r.mode ?? 'foreground';
  const baselines = new Map(
    [...groupBy(runs, (r) => `${r.type}\t${modeOf(r)}`)].map(([k, list]) => [k, summarise(list)]),
  );
  const byMode = (type, rs) => {
    const acc = { speed: [0, 0], efficiency: [0, 0] };
    for (const [mode, list] of groupBy(rs, modeOf)) {
      const now = summarise(list);
      const base = baselines.get(`${type}\t${mode}`);
      const timed = list.filter((r) => r.durationMs !== undefined).length;
      const counted = list.filter((r) => r.linked).length;
      const speed = ratio(base.medianMs, now.medianMs);
      const efficiency = ratio(base.medianWeighted, now.medianWeighted);
      if (speed !== undefined) { acc.speed[0] += speed * timed; acc.speed[1] += timed; }
      if (efficiency !== undefined) { acc.efficiency[0] += efficiency * counted; acc.efficiency[1] += counted; }
    }
    const mean = ([sum, n]) => (n ? sum / n : undefined);
    return { speed: mean(acc.speed), efficiency: mean(acc.efficiency) };
  };
  const period = (keyFn) => {
    const out = [];
    for (const [key, list] of [...groupBy(runs, (r) => keyFn(r.start))].sort()) {
      for (const [type, rs] of groupBy(list, (r) => r.type)) {
        const summary = summarise(rs);
        const mixed = new Set(rs.map(modeOf)).size > 1;
        const sc = score(summary, overall[type], byMode(type, rs));
        out.push({ period: key, type, ...summary, mixed, score: sc });
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
  collect, rollUp, summarise, score, verdictOf, dayKey, weekKey, totalTokens, COST_WEIGHTS, weighted, MIN_RUNS_FOR_SCORE,
};
