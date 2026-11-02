'use strict';

// Two or more sessions working in the same checkout can overwrite each
// other's changes (it happened to this very repo). A clash is two sessions,
// both active in the last 15 minutes, whose folders are the same or one
// inside the other. The Claude app's own worktrees (.claude/worktrees/x)
// are separate checkouts, so they never clash with their repository.

const RECENT_MS = 15 * 60_000;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// Same folder, or one inside the other, unless what lies between them is a
// Claude app worktree (its own checkout inside the repository's folder).
function within(a, b) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.startsWith(`${short}/`) && !`${long.slice(short.length)}/`.includes('/.claude/worktrees/');
}

// sessions: [{ id, project, cwd, lastActivityAt }]
function findClashes(sessions, now = Date.now()) {
  const live = sessions.filter((s) => s.cwd && now - s.lastActivityAt <= RECENT_MS).map((s) => ({ ...s, dir: norm(s.cwd) }));
  const groups = [];
  for (const s of live) {
    const g = groups.find((x) => x.some((y) => within(y.dir, s.dir)));
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups.filter((g) => g.length > 1).map((g) => ({
    project: g[0].project,
    count: g.length,
    ids: g.map((s) => s.id).sort(),
    key: g.map((s) => s.id).sort().join('+'),
  }));
}

module.exports = { findClashes, RECENT_MS };
