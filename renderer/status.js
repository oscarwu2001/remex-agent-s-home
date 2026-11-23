// Status words and timings shared by the hospital window and the mini window.

import { tr } from './i18n.js';

// What a tool call is doing, in the window's language. A label without a
// key (from an older copy of the app) is shown as it came.
export const activityText = (a) => (a.labelKey ? tr(a.labelKey, a.labelParams) : a.label);

// Distinct words lead each status, so they can be told apart at a glance.
export function statusText(x) {
  switch (x.status) {
    case 'standby': return tr('status.standby');
    case 'working': return x.activity ? activityText(x.activity) : tr('status.working');
    case 'delegating':
      if (!x.activity) return tr('status.withHelper');
      return x.activity.labelKey === 'tool.delegate' ? tr('status.with', x.activity.labelParams) : x.activity.label.replace('Consulting', 'With');
    case 'blocked': return tr('status.blocked');
    case 'thinking': return tr('status.thinking');
    case 'reporting': return tr('status.reporting');
    case 'your-turn': return tr('status.your-turn');
    case 'done':
      if (x.endReason === 'interrupted') return tr('status.stopped');
      if (x.endReason === 'error') return tr('status.failed');
      if (x.endReason === 'went quiet') return tr('status.quiet');
      return tr('status.finished');
    default: return tr('status.idle');
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
