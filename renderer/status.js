// Status words and timings shared by the hospital window and the mini window.

// Distinct words lead each status, so they can be told apart at a glance.
export function statusText(x) {
  switch (x.status) {
    case 'standby': return 'Standby';
    case 'working': return x.activity ? x.activity.label : 'Working';
    case 'delegating': return x.activity ? x.activity.label.replace('Consulting', 'With') : 'With a helper';
    case 'blocked': return 'Needs approval, or a long tool is running';
    case 'thinking': return 'Thinking';
    case 'reporting': return 'Writing up findings';
    case 'your-turn': return 'Your turn';
    case 'done':
      if (x.endReason === 'interrupted') return 'Stopped';
      if (x.endReason === 'error') return 'Failed';
      if (x.endReason === 'went quiet') return 'Presumed finished (went quiet)';
      return 'Finished';
    default: return 'Idle';
  }
}

// A finished helper's glyph says how it finished, not just that it did.
export function glyphKey(x) {
  if (x.status !== 'done') return x.status;
  return { error: 'failed', interrupted: 'stopped', 'went quiet': 'quiet' }[x.endReason] ?? 'done';
}

export function elapsed(fromMs, nowMs) {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
