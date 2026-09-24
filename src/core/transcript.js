'use strict';

// Turns one line of a Claude Code JSONL transcript into zero or more
// normalised events. Pure: no clock, no file system. Anything the format
// does not tell us is left undefined rather than guessed.

const TASK_TOOLS = new Set(['Task', 'Agent']);

class MalformedLineError extends Error {}

function parseLine(line) {
  const text = line.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') {
      throw new MalformedLineError('transcript line is not a JSON object');
    }
    return value;
  } catch (err) {
    if (err instanceof MalformedLineError) throw err;
    throw new MalformedLineError(`transcript line is not valid JSON: ${err.message}`);
  }
}

function timestampOf(entry) {
  const t = Date.parse(entry.timestamp);
  return Number.isFinite(t) ? t : undefined;
}

function contentBlocks(message) {
  if (!message) return [];
  if (Array.isArray(message.content)) return message.content;
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return [];
}

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

// Events from a message object ({type, message:{role, content, stop_reason}}).
// `via` is the Task tool_use id when the message was relayed from inside a
// sub-agent (progress entries); undefined for the transcript's own turns.
function messageEvents(entry, ts, via) {
  const events = [];
  const blocks = contentBlocks(entry.message);

  if (entry.type === 'assistant') {
    let sawTool = false;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        sawTool = true;
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const ev = { kind: 'tool-start', id: block.id, name: block.name, input, ts, via };
        if (TASK_TOOLS.has(block.name)) {
          ev.kind = 'task-start';
          ev.subagentType = typeof input.subagent_type === 'string' && input.subagent_type
            ? input.subagent_type
            : 'general-purpose';
          ev.description = typeof input.description === 'string' ? input.description : '';
          ev.prompt = typeof input.prompt === 'string' ? input.prompt : '';
          ev.background = input.run_in_background === true;
        }
        events.push(ev);
      }
    }
    const stopReason = entry.message ? entry.message.stop_reason : undefined;
    if (!sawTool) {
      events.push({ kind: 'assistant-text', ts, via, stopReason: stopReason || undefined });
    }
    return events;
  }

  if (entry.type === 'user') {
    let sawResult = false;
    for (const block of blocks) {
      if (block && block.type === 'tool_result') {
        sawResult = true;
        events.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          isError: block.is_error === true,
          text: toolResultText(block),
          ts,
          via,
        });
      }
    }
    if (!sawResult && !entry.isMeta) {
      const first = blocks.find((b) => b && b.type === 'text');
      events.push({ kind: 'user-prompt', ts, via, text: first ? String(first.text) : '' });
    }
    return events;
  }

  return events;
}

// entry -> { meta, events }. `meta` carries identity fields that the tracker
// uses to place the file (session, sidechain, cwd).
function eventsFromEntry(entry) {
  const ts = timestampOf(entry);
  const meta = {
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    isSidechain: entry.isSidechain === true,
    agentId: typeof entry.agentId === 'string' ? entry.agentId : undefined,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    ts,
  };

  if (entry.type === 'assistant' || entry.type === 'user') {
    return { meta, events: messageEvents(entry, ts, undefined) };
  }

  // Some Claude Code versions relay sub-agent turns into the parent
  // transcript as progress entries keyed by the Task tool_use id.
  if (entry.type === 'progress' && typeof entry.parentToolUseID === 'string') {
    const inner = entry.data && entry.data.message;
    if (inner && (inner.type === 'assistant' || inner.type === 'user')) {
      const innerTs = timestampOf(inner) ?? ts;
      return { meta, events: messageEvents(inner, innerTs, entry.parentToolUseID) };
    }
    return { meta, events: [{ kind: 'activity', ts, via: entry.parentToolUseID }] };
  }

  if (entry.type === 'system' && entry.subtype === 'turn_duration') {
    return { meta, events: [{ kind: 'turn-end', ts }] };
  }

  // Attachments, summaries, snapshots, queue operations: proof of life only.
  return { meta, events: ts !== undefined ? [{ kind: 'activity', ts }] : [] };
}

module.exports = { parseLine, eventsFromEntry, MalformedLineError, TASK_TOOLS };
