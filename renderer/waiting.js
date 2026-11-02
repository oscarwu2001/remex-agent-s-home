// "Waiting for you": every session on this computer that cannot go on
// without the user (its turn, or an approval), oldest wait first. Shown at
// the top of Running now and of the mini window's Now tab, and the source of
// the "has been waiting" notifications. Pure, so the tests can use it.

const WORDS = { 'your-turn': 'Your turn', blocked: 'Needs approval' };

// A dismissed wait comes back as soon as the session does something new.
export const waitKey = (w) => `${w.id}:${w.since}`;

export function waitingList(sessions = [], dismissed = new Set()) {
  const out = [];
  for (const s of sessions) {
    const helper = (s.agents ?? []).find((a) => a.status === 'blocked');
    const status = s.status === 'blocked' || helper ? 'blocked' : s.status === 'your-turn' ? 'your-turn' : null;
    if (!status) continue;
    const item = {
      id: s.id,
      project: s.project,
      source: s.source,
      status,
      helper: helper?.type,
      since: (helper ? helper.lastActivityAt : s.lastActivityAt) ?? s.lastActivityAt,
    };
    if (!dismissed.has(waitKey(item))) out.push(item);
  }
  return out.sort((a, b) => a.since - b.since);
}

export function waitText(w) {
  return w.status === 'blocked' ? `Needs approval${w.helper ? ` (${w.helper})` : ''}` : WORDS[w.status];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function waitFor(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// Sessions sharing one checkout: they can overwrite each other's work.
export function clashHtml(clashes = []) {
  if (!clashes.length) return '';
  return `<div class="clash" role="alert">${clashes.map((c) => `<p><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.2"/></svg>
    <span><strong>${c.count} sessions are working in the same folder of ${esc(c.project)}.</strong> They can overwrite each other's changes; give one its own worktree.</span></p>`).join('')}</div>`;
}

// glyph(x) draws a status glyph; passed in so both windows use their own.
export function waitingHtml(list, now, glyph) {
  if (!list.length) return '';
  return `<section class="waiting" aria-label="Waiting for you">
    <p class="waiting-head">Waiting for you <span class="waiting-n">${list.length}</span></p>
    <ul class="waiting-list">${list.map((w) => `<li class="wait ${w.status}">
      <button type="button" class="wait-open" data-session="${esc(w.id)}" title="${esc(`${w.project}: ${waitText(w)}, for ${waitFor(now - w.since)}`)}">
        ${glyph({ status: w.status })}<span class="wait-name">${esc(w.project)}</span>
        <span class="wait-what">${esc(waitText(w))}</span><span class="wait-for">${esc(waitFor(now - w.since))}</span></button>
      <button type="button" class="icon-act subtle wait-dismiss" data-key="${esc(waitKey(w))}" title="Hide until it changes">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg><span class="visually-hidden">Hide ${esc(w.project)} until it changes</span></button></li>`).join('')}</ul>
  </section>`;
}

// What just ended among running work and jobs, here and on other computers,
// since the last look: [{ key, text }]. `before` is the previous result's
// running set (a Map key -> label); returns the new one too.
export function endedWork(overview, before = new Map()) {
  const running = new Map();
  const finished = new Map();
  const offline = new Set();
  for (const c of overview.computers ?? []) {
    if (!c.online) {
      offline.add(c.computer); // its work is not known to have ended
      continue;
    }
    const where = c.local ? '' : ` on ${c.computer}`;
    for (const j of c.jobs ?? []) {
      const key = `job|${c.computer}|${j.name}|${j.startedAt ?? ''}`;
      const label = `${j.name}${j.project ? ` (${j.project})` : ''}${where}`;
      if (j.state === 'running') running.set(key, label);
      else finished.set(key, { label, state: j.state });
    }
    for (const w of c.work ?? []) running.set(`work|${c.computer}|${w.name}|${w.startedAt}`, `${w.name}${w.project ? ` (${w.project})` : ''}${where}`);
  }
  // Work on a computer that went quiet is carried over until it reports.
  for (const [key, label] of before) if (offline.has(key.split('|')[1])) running.set(key, label);
  const ended = [];
  for (const [key, label] of before) {
    if (running.has(key)) continue;
    const f = finished.get(key);
    const how = !f ? 'stopped running' : f.state === 'done' ? 'finished' : f.state === 'failed' ? 'failed' : f.state === 'stalled' ? 'has gone quiet for 30 minutes' : 'stopped';
    ended.push({ key, text: `${label} ${how}.` });
  }
  return { ended, running };
}


// Dismissed waits, kept per viewer in the same storage as the preferences,
// read and written in place so both windows share them.
const STORE = 'agents-home-waits';
export function loadDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE) || '[]'));
  } catch {
    return new Set(); // storage blocked or unreadable: nothing hidden
  }
}
export function dismissWait(key) {
  const keys = [...loadDismissed(), key].slice(-200);
  try {
    localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    // Storage blocked: the wait just stays in view.
  }
}
