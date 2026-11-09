# Agent's Home: rules for this repo

A desktop app (Electron) that shows Claude Code sessions and their sub-agents
as figures in an isometric hospital drawn in a Monument Valley style, with a
mini window and a project list with to-dos. It reads the local transcript
files (`~/.claude/projects/**/*.jsonl`, WSL homes and the Claude app's Cowork
task folders), the project list, the personal assistant's questions
(`~/.agents-home/assistant/`, read only), for the report the agent
definitions beside the transcripts and the user's own verdict ledger (counts
only) and, when turned on, the shared status folder; nothing else.
Vocabulary is in `CONTEXT.md`.

## Commands

- `npm test`: the fast loop (parser, tracker, rooms, file tailer). Runs in about a second.
- `npm start`: run the app against your real transcripts.
- `npm run demo`: run the app with scripted demo patients (add `-- --mini` to open the mini window too).
- `npm run preview`: serve the renderer to a browser at `http://localhost:5178/?demo=1` (design work, screenshots).
- `npm run report`: build the agent performance report (HTML and CSV) in `out/reports/` from the real transcripts. The app builds the same report from Settings, in a utility process (`src/report/agent-report.js`), into its own data folder.
- `npm run dist:win`: build `dist/AgentsHome-Setup-<v>.exe` and the portable exe. Windows only (Linux needs Wine); CI builds it on every push.

There are no `needs_data`, `slow` or GPU markers here. Every test is fast and uses invented transcripts.

## Hard rules

1. **Local only.** No network calls from the app: no telemetry, no automatic update checks, no web fonts, no CDN scripts, no Chromium background fetches (the spell checker is off because it downloads dictionaries). The renderer's CSP must stay `default-src 'self'`. Two exceptions, both off until the user acts, both made from the main process: **Use the real weather** (Settings) asks Open-Meteo for the weather at a place the user typed, sending only that place (`src/core/weather.js` holds the only allowed hosts); and **Update and restart** (Settings) runs `git pull --ff-only` in the app's own clone when pressed. Nothing from a transcript is ever sent. **Other computers** (Settings, off by default) writes one status file to a folder the user picked and reads the others there; the folder's own sync moves them, never the app. The file holds only what privacy mode shows (`src/core/fleet.js`, tested). Its pull-only twin, **Use a git status folder**, runs `git pull --ff-only` every 10 minutes in a clone of the `agents-status` branch the user picked, and writes nothing; the other computers post there hourly with that branch's own `post-status.js` (plain Node, no Claude).
2. **Read-only on transcripts.** The app never writes, moves or deletes transcripts or anything else under `~/.claude`, with one exception, only when the user says yes (`src/core/officepack.js`): it copies the Office pack items (`office-pack/`) the user ticks in Settings into `~/.claude/agents`, `skills` and `hooks`, never over a file or folder that is already there (the app never offers or adds the pack on its own: people keep their own agent pipelines); **Update agents** refreshes only items the user added, adds nothing and never turns the reminders on, and replaces a pack file only when it is byte-for-byte a version the pack shipped (`office-pack/versions.json`, refreshed by `node scripts/pack-versions.js` after any pack change; a test checks it); and the team reminders add one hook entry to `~/.claude/settings.json`, after keeping a copy, changing nothing else and leaving a file it cannot parse alone. The reminder hook itself keeps `~/.claude/hooks/agents-home-router.log` (time and which reminders fired; never the prompt), which the app only reads. The app's own system log (`src/core/syslog.js`) lives in its data folder, never under `~/.claude`. The Cowork task folders under the Claude app's data folder (`src/core/cowork.js`) are read only, like `~/.claude`. The project list (`~/.agents-home/projects.json`, `src/core/projects.js`) is shared with the personal-assistant and project-manager agents: the app writes it only for the user's own changes, re-reads it before each change, writes whole files (temp file + rename), keeps fields it does not know and never touches a file it cannot parse.
3. **Privacy mode is the default.** File names, commands, patterns, URLs and Task descriptions appear only when the user turns privacy mode off. Tool *labels* ("Reading a file"), agent types and skill names (checked to be plain names, never a skill's arguments) are always safe to show.
4. **No real transcript content in the repo.** Tests build entries with `test/helpers.js`. Never paste lines from a real session into a test, fixture, issue or commit. A transcript may hold patient identifiers, dataset names or case paths.
5. **Nothing fails silently.** Malformed lines, unreadable folders, invalid `rooms.json` and unmatched sub-agent transcripts are counted and shown under "Needs attention". A catch block either surfaces the problem or has a comment saying why ignoring it is safe.
6. **Status is never colour alone.** Every status has its own glyph shape in the scene (thinking and "presumed finished" are shown by no bubble at all) and a text label on the board. Icon-only controls carry their words as a `title`, which `renderer/tip.js` shows as a quick hover label.
7. **One source for rooms.** Room ids, names and agent assignment live in `src/core/rooms.js`. Room geometry lives in `renderer/scene.js`, keyed by those ids. Do not add a second list. The same split holds for decor: which floors, room items and plants exist, their sizes and each room's starting layout are `src/core/decor.js`; how they look is `renderer/furniture.js` and `renderer/decor.js`.

## Layout

- `src/core/`: pure Node, no Electron (`transcript.js` parse, `tracker.js` state, `watcher.js` tail, `wsl.js` WSL transcript folders, `rooms.js`, `decor.js` floors, decorations and garden catalogue, `roster.js`, `activity.js`, `metrics.js` for the report (hand-backs and their verdicts, rounds, turn-limit stops, builders' first review), `ledger.js` the user's own verdict ledger, read only and counts only, `costs.js` the report's cost picture (general-purpose callers, could-be-typed flags, weighted tokens, skill loads and sources, before/after), `teamwork.js` the report's team picture (flows, hand-off chains, unused agents and skills), `weather.js` the opt-in real weather, `cowork.js` the Claude app's Cowork task folders, `fleet.js` the shared status file for other computers, `projects.js` the project list and its to-dos, `assistant.js` the personal assistant's questions and last scan (read only), `jobs.js` long jobs' progress files (`~/.agents-home/jobs`, read only) and the machine line, `clashes.js` sessions sharing one checkout, `worktrees.js` a project's worktrees on request (read-only git), `work.js` running work found by itself (Python on the GPU or a busy CPU; the agents-status branch's `work-detect.js` is the same file), `officepack.js` offers and installs the Office pack, `usage.js` Claude Code use and context windows, `syslog.js` the system log: agent activity and errors).
- `office-pack/`: a small team of Claude Code agents and skills, offered to the user by the app: office helpers, coding helpers (`builder`, `code-reviewer`, `test-runner`) and the two managers (`project-manager`, `personal-assistant` with the `scan-projects` skill).
- `electron/`: main process and preload. The only bridge is `window.agentsHome` (`config()`, `onSnapshot()`).
- `renderer/`: plain ES modules, no bundler. `iso.js` primitives, `themes.js` colourways, `scene.js` hospital, `furniture.js` every room item in both room styles (simple and detailed), `decor.js` (floors, decorations, garden plants), `people.js` figures, `app.js` glue and board, `demo.js`, `overview.js` the "Running now" numbers, icons and to-do pips, `status.js` status words, `projects-view.js` the project list (board and mini), `jobs-view.js` jobs and the GPU/CPU line, `waiting.js` the waiting-for-you list, ended-work notices and the same-folder warning, `tip.js` hover labels, `mini.html`/`mini.js`/`mini.css` the mini window. Colour tokens are `tokens.css` (both windows), shared badges and pips `icons.css`.
- `src/report/`: the performance report (HTML + CSV), run by the app or `scripts/agent-report.js`.
- `test/`: `node:test`, one file per core module.

## Delegation

- `runner`: output goes to `out/runner/` (git-ignored). The commands that matter are `npm test` and the Electron smoke run in the README.
- `reviewer`: load `.claude/skills/project-quality` and work through it.
- `silent-failure-hunter`: the data path is `watcher.js` → `transcript.js` → `tracker.js` → snapshot → `app.js`.
- `ui-reviewer`: the medium is **web** (Electron renderer, SVG + CSS). There are three colourways (Blossom, Tide, Grove) and no dark mode. Scene colours live in `renderer/themes.js`, and the board and sky tokens are the per-colourway custom properties in `renderer/tokens.css`. Keep every text pair at 4.5:1 or better in all three (`test/contrast.test.js` checks). The look is calm and airy (after molly.studio): regular-weight type, sentence case, hairlines, icons over words.
