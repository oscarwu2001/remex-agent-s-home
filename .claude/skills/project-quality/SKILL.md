---
name: project-quality
description: "Review checklist for Agent's Home, the Electron hospital map of Claude Code agents; the reviewer agent works through it before issuing PASS/FAIL on any change to src/core, electron/ or renderer/."
---

# project-quality: review checklist for Agent's Home

The reviewer works through every item and reports PASS only if all hold.
Findings are listed with file:line and a one-sentence reason.

## Correctness
- [ ] The change does what the *original request* asked, not what the implementer's summary claims.
- [ ] Both transcript layouts still work: sub-agents inside the parent file (`isSidechain` lines) and sub-agents in `<session>/subagents/*.jsonl`. `Task` and `Agent` tool names both start a helper.
- [ ] Time-based statuses (`blocked`, `your-turn`, background end, stale) use the entry timestamps and the `now` passed in, never `Date.now()` inside the tracker's logic.

## Regressions
- [ ] `npm test` passes; report the counts.
- [ ] No test was weakened, skipped or deleted to go green.
- [ ] The snapshot shape (`sessions[].agents[]`, `stats`, `watcher`, `roster`, `problems`) is unchanged, or `renderer/app.js` and `renderer/demo.js` were updated with it.
- [ ] The demo still runs: `npm run preview`, open `/?demo=1`, no console errors.

## Project rules (from CLAUDE.md)
- [ ] No network access added anywhere; CSP unchanged.
- [ ] Nothing writes under `~/.claude`.
- [ ] New displayed text that can carry a path, command, pattern, URL or task description is `detail` and hidden in privacy mode.
- [ ] New failure paths surface under "Needs attention" or carry a comment saying why ignoring them is safe.
- [ ] Every new status has a distinct glyph shape and a text label.
- [ ] Room ids and assignment are only in `src/core/rooms.js`.

## Tests
- [ ] New behaviour in `src/core` has a test; changed behaviour has an updated one.
- [ ] Expected values come from the entries the test wrote, not from re-running the code's own arithmetic.

## Privacy / data
- [ ] No usernames, machine names, absolute paths, patient identifiers, dataset filenames or real transcript lines in code, tests, screenshots or commit messages.
- [ ] No large or generated files (`dist/`, `node_modules/`, `out/`) added to git.
