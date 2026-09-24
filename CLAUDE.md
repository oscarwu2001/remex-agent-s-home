# Agent's Home: rules for this repo

A desktop app (Electron) that shows Claude Code sessions and their sub-agents
as figures in an isometric hospital drawn in a Monument Valley style. It reads
the local transcript files (`~/.claude/projects/**/*.jsonl`) and nothing else.
Vocabulary is in `CONTEXT.md`.

## Commands

- `npm test`: the fast loop (parser, tracker, rooms, file tailer). Runs in about a second.
- `npm start`: run the app against your real transcripts.
- `npm run demo`: run the app with scripted demo patients.
- `npm run preview`: serve the renderer to a browser at `http://localhost:5178/?demo=1` (design work, screenshots).
- `npm run report`: build the agent performance report (HTML and CSV) in `out/reports/` from the real transcripts.
- `npm run dist:win`: build `dist/AgentsHome-Setup-<v>.exe` and the portable exe. Windows only (Linux needs Wine); CI builds it on every push.

There are no `needs_data`, `slow` or GPU markers here. Every test is fast and uses invented transcripts.

## Hard rules

1. **Local only.** No network calls from the app: no telemetry, no update checks, no web fonts, no CDN scripts. The renderer's CSP must stay `default-src 'self'`.
2. **Read-only on transcripts.** The app never writes, moves or deletes anything under `~/.claude`.
3. **Privacy mode is the default.** File names, commands, patterns, URLs and Task descriptions appear only when the user turns privacy mode off. Tool *labels* ("Reading a file") are always safe to show.
4. **No real transcript content in the repo.** Tests build entries with `test/helpers.js`. Never paste lines from a real session into a test, fixture, issue or commit. A transcript may hold patient identifiers, dataset names or case paths.
5. **Nothing fails silently.** Malformed lines, unreadable folders, invalid `rooms.json` and unmatched sub-agent transcripts are counted and shown under "Needs attention". A catch block either surfaces the problem or has a comment saying why ignoring it is safe.
6. **Status is never colour alone.** Every status has its own glyph shape in the scene and a text label on the board.
7. **One source for rooms.** Room ids, names and agent assignment live in `src/core/rooms.js`. Room geometry lives in `renderer/scene.js`, keyed by those ids. Do not add a second list.

## Layout

- `src/core/`: pure Node, no Electron (`transcript.js` parse, `tracker.js` state, `watcher.js` tail, `rooms.js`, `roster.js`, `activity.js`, `metrics.js` for the report).
- `electron/`: main process and preload. The only bridge is `window.agentsHome` (`config()`, `onSnapshot()`).
- `renderer/`: plain ES modules, no bundler. `iso.js` primitives, `themes.js` colourways, `scene.js` hospital, `people.js` figures, `app.js` glue and board, `demo.js`.
- `test/`: `node:test`, one file per core module.

## Delegation

- `runner`: output goes to `out/runner/` (git-ignored). The commands that matter are `npm test` and the Electron smoke run in the README.
- `reviewer`: load `.claude/skills/project-quality` and work through it.
- `silent-failure-hunter`: the data path is `watcher.js` → `transcript.js` → `tracker.js` → snapshot → `app.js`.
- `ui-reviewer`: the medium is **web** (Electron renderer, SVG + CSS). There are three colourways (Blossom, Tide, Grove) and no dark mode. Scene colours live in `renderer/themes.js`, and the board and sky tokens are the per-colourway custom properties at the top of `renderer/styles.css`. Keep every text pair at 4.5:1 or better in all three.
