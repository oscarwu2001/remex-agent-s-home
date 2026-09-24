'use strict';

// Folds transcript entries into the live state of every session and
// sub-agent, and derives a display status for each one at a given time.
//
// Streams: a transcript file's own turns form one stream; sidechain entries
// (a sub-agent's turns) form another, keyed by file + agentId. That covers
// both layouts Claude Code has used: sub-agents written into the parent file
// and sub-agents written to their own file.

const path = require('path');
const { eventsFromEntry } = require('./transcript');
const { describeTool, APPROVAL_TOOLS } = require('./activity');
const { roomFor } = require('./rooms');

const TIMING = {
  approvalQuietMs: 7_000, // pending approval-type tool, file quiet this long
  textQuietMs: 4_000, // text with no tool after it, quiet this long -> your turn
  staleSessionMs: 10 * 60_000, // session hidden after this long without a write
  doneLingerMs: 7_000, // finished sub-agent stays visible (walks home)
  backgroundQuietMs: 120_000, // background sub-agent presumed finished
  unlinkedGraceMs: 15_000, // sidechain with no matching Task call -> counted
};

const HISTORY_LIMIT = 12;

function newActor(startedAt) {
  return {
    pending: new Map(), // tool_use id -> { name, input, startedAt }
    lastKind: undefined, // 'tool' | 'result' | 'text' | 'prompt' | 'turn-end'
    stopReason: undefined,
    lastAt: startedAt,
    startedAt,
    history: [],
    errors: 0,
  };
}

function pushHistory(actor, item) {
  actor.history.push(item);
  if (actor.history.length > HISTORY_LIMIT) actor.history.shift();
}

class Tracker {
  constructor({ overrides = {}, timing = {} } = {}) {
    this.overrides = overrides;
    this.timing = { ...TIMING, ...timing };
    this.sessions = new Map(); // sessionId -> session
    this.streams = new Map(); // streamKey -> { role, sessionId, taskId?, buffer?, firstSeen }
    this.stats = { malformedLines: 0, unlinkedSidechains: 0, lastProblem: undefined };
  }

  // ---- input -------------------------------------------------------------

  noteMalformed(fileKey, err) {
    this.stats.malformedLines += 1;
    this.stats.lastProblem = `${path.basename(fileKey)}: ${err.message}`;
  }

  ingest(fileKey, entry, receivedAt = Date.now()) {
    const { meta, events } = eventsFromEntry(entry);
    const isSidechain = meta.isSidechain;
    const streamKey = isSidechain ? `${fileKey}#${meta.agentId || 'sidechain'}` : fileKey;
    const sessionId = meta.sessionId || path.basename(fileKey, '.jsonl');

    let stream = this.streams.get(streamKey);
    if (!stream) {
      stream = { role: isSidechain ? 'sidechain' : 'main', sessionId, firstSeen: receivedAt, buffer: [] };
      this.streams.set(streamKey, stream);
    }

    const session = this.ensureSession(sessionId, meta, receivedAt);
    if (meta.cwd && !session.cwd) {
      session.cwd = meta.cwd;
      session.project = path.basename(meta.cwd.replace(/\\/g, '/')) || session.project;
    }

    for (const raw of events) {
      const ev = { ...raw, ts: raw.ts ?? receivedAt };
      if (stream.role === 'main') this.applyMain(session, ev);
      else this.applySidechain(session, stream, ev);
    }
  }

  ensureSession(sessionId, meta, receivedAt) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const startedAt = meta.ts ?? receivedAt;
      s = {
        id: sessionId,
        cwd: undefined,
        project: 'session',
        actor: newActor(startedAt),
        subagents: new Map(), // Task tool_use id -> sub
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  applyMain(session, ev) {
    if (ev.via) {
      // Relayed from inside a sub-agent (progress entry).
      const sub = session.subagents.get(ev.via);
      if (sub) this.applyActor(sub.actor, ev);
      session.actor.lastAt = Math.max(session.actor.lastAt, ev.ts);
      return;
    }

    if (ev.kind === 'task-start') {
      session.subagents.set(ev.id, {
        id: ev.id,
        type: ev.subagentType,
        room: roomFor(ev.subagentType, this.overrides),
        description: ev.description,
        prompt: ev.prompt,
        background: ev.background,
        linked: false,
        endedAt: undefined,
        endReason: undefined,
        // It has just been handed its prompt, so it starts out thinking.
        actor: { ...newActor(ev.ts), lastKind: 'prompt' },
      });
      this.retryLinks(session);
    }

    if (ev.kind === 'tool-end') {
      const sub = session.subagents.get(ev.id);
      // A background launch returns at once; its end is inferred later.
      if (sub && !sub.background && sub.endedAt === undefined) {
        sub.endedAt = ev.ts;
        sub.endReason = ev.isError ? 'error' : 'finished';
      }
    }

    if (ev.kind === 'user-prompt') {
      // A new prompt interrupts anything the previous turn left running.
      for (const sub of session.subagents.values()) {
        if (!sub.background && sub.endedAt === undefined) {
          sub.endedAt = ev.ts;
          sub.endReason = 'interrupted';
        }
      }
    }

    this.applyActor(session.actor, ev);
  }

  applySidechain(session, stream, ev) {
    if (stream.taskId === undefined) {
      stream.buffer.push(ev);
      if (ev.kind === 'user-prompt' && stream.prompt === undefined) stream.prompt = ev.text;
      this.tryLink(session, stream);
      return;
    }
    const sub = session.subagents.get(stream.taskId);
    if (sub) this.applyActor(sub.actor, ev);
  }

  tryLink(session, stream) {
    if (stream.taskId !== undefined || stream.prompt === undefined) return false;
    const open = [...session.subagents.values()].filter((s) => !s.linked);
    const exact = open.filter((s) => s.prompt && samePrompt(s.prompt, stream.prompt));
    let match;
    if (exact.length === 1) match = exact[0];
    else if (exact.length === 0) {
      const running = open.filter((s) => s.endedAt === undefined);
      if (running.length === 1) match = running[0];
    }
    if (!match) return false;

    match.linked = true;
    stream.taskId = match.id;
    if (stream.counted) {
      this.stats.unlinkedSidechains -= 1;
      stream.counted = false;
    }
    for (const ev of stream.buffer) this.applyActor(match.actor, ev);
    stream.buffer = [];
    return true;
  }

  retryLinks(session) {
    for (const stream of this.streams.values()) {
      if (stream.role === 'sidechain' && stream.sessionId === session.id) this.tryLink(session, stream);
    }
  }

  applyActor(actor, ev) {
    actor.lastAt = Math.max(actor.lastAt, ev.ts);
    switch (ev.kind) {
      case 'tool-start':
      case 'task-start': {
        actor.pending.set(ev.id, { name: ev.name, input: ev.input, startedAt: ev.ts });
        actor.lastKind = 'tool';
        const d = describeTool(ev.name, ev.input);
        pushHistory(actor, { ts: ev.ts, kind: d.kind, label: d.label, detail: d.detail });
        break;
      }
      case 'tool-end':
        actor.pending.delete(ev.id);
        actor.lastKind = 'result';
        if (ev.isError) actor.errors += 1;
        break;
      case 'assistant-text':
        actor.lastKind = 'text';
        actor.stopReason = ev.stopReason;
        break;
      case 'user-prompt':
        actor.pending.clear();
        actor.lastKind = 'prompt';
        actor.stopReason = undefined;
        break;
      case 'turn-end':
        actor.pending.clear();
        actor.lastKind = 'turn-end';
        break;
      default:
        break; // 'activity': proof of life only
    }
  }

  // ---- output ------------------------------------------------------------

  statusOf(actor, now, { isSession = false } = {}) {
    const quiet = now - actor.lastAt;
    if (actor.pending.size > 0) {
      const [, newest] = [...actor.pending.entries()].reduce((a, b) =>
        b[1].startedAt >= a[1].startedAt ? b : a,
      );
      const d = describeTool(newest.name, newest.input);
      if (d.kind === 'delegate') return { status: 'delegating', activity: d };
      if (APPROVAL_TOOLS.has(newest.name) && quiet > this.timing.approvalQuietMs) {
        return { status: 'blocked', activity: d };
      }
      return { status: 'working', activity: d };
    }
    switch (actor.lastKind) {
      case 'text':
        if (actor.stopReason === 'end_turn' || quiet > this.timing.textQuietMs) {
          return { status: isSession ? 'your-turn' : 'reporting', activity: null };
        }
        return { status: 'thinking', activity: null };
      case 'turn-end':
        return { status: isSession ? 'your-turn' : 'reporting', activity: null };
      case 'prompt':
      case 'result':
      case 'tool':
        return { status: 'thinking', activity: null };
      default:
        return { status: 'idle', activity: null };
    }
  }

  snapshot(now = Date.now()) {
    const t = this.timing;
    const sessions = [];

    for (const stream of this.streams.values()) {
      if (stream.role === 'sidechain' && stream.taskId === undefined && !stream.counted &&
          now - stream.firstSeen > t.unlinkedGraceMs) {
        stream.counted = true;
        this.stats.unlinkedSidechains += 1;
      }
    }

    for (const session of this.sessions.values()) {
      const agents = [];
      for (const sub of session.subagents.values()) {
        if (sub.background && sub.endedAt === undefined &&
            now - sub.actor.lastAt > t.backgroundQuietMs) {
          // Ended when we noticed, so it still gets its walk home.
          sub.endedAt = now;
          sub.endReason = 'went quiet';
        }
        if (sub.endedAt !== undefined && now - sub.endedAt > t.doneLingerMs) continue;
        const st = sub.endedAt !== undefined
          ? { status: 'done', activity: null }
          : this.statusOf(sub.actor, now);
        agents.push({
          id: sub.id,
          type: sub.type,
          room: sub.room,
          description: sub.description,
          background: sub.background,
          startedAt: sub.actor.startedAt,
          lastActivityAt: sub.actor.lastAt,
          endedAt: sub.endedAt,
          endReason: sub.endReason,
          errors: sub.actor.errors,
          ...st,
          history: sub.actor.history.slice(),
        });
      }

      const lastAt = Math.max(session.actor.lastAt, ...agents.map((a) => a.lastActivityAt));
      if (now - lastAt > t.staleSessionMs) continue;

      sessions.push({
        id: session.id,
        project: session.project,
        room: 'nurses-station',
        startedAt: session.actor.startedAt,
        lastActivityAt: lastAt,
        errors: session.actor.errors,
        ...this.statusOf(session.actor, now, { isSession: true }),
        history: session.actor.history.slice(),
        agents,
      });
    }

    sessions.sort((a, b) => a.startedAt - b.startedAt);
    return { generatedAt: now, sessions, stats: { ...this.stats } };
  }

  // Drop state for sessions that have been stale a long time.
  prune(now = Date.now()) {
    const cutoff = this.timing.staleSessionMs * 3;
    for (const [id, s] of this.sessions) {
      if (now - s.actor.lastAt > cutoff) {
        this.sessions.delete(id);
        for (const [key, stream] of this.streams) {
          if (stream.sessionId === id) this.streams.delete(key);
        }
      }
    }
  }
}

function samePrompt(a, b) {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  const n = Math.min(x.length, y.length, 400);
  return n >= 40 && x.slice(0, n) === y.slice(0, n);
}

module.exports = { Tracker, TIMING };
