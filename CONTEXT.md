# Vocabulary

| Term | Meaning |
| --- | --- |
| **Session** | One Claude Code conversation: one main `.jsonl` transcript. Drawn as an attending in a white coat at the Nurses' Station. |
| **Helper** / **sub-agent** | An agent started by a `Task` (older) or `Agent` (newer) tool call. If it is one of your staff, the resident in its room does the work; otherwise a visitor walks from the station to the room and back. |
| **Staff** | Agents defined in `.claude/agents` (the roster) and agents placed in departments. Each always stands in its room, on standby until called. |
| **Agent type** | The `subagent_type` of the call (`reviewer`, `Explore`, …). Decides the room. |
| **Room** | One of the seven core places in `src/core/rooms.js`, or a department the user added. |
| **Grid / cell** | Rooms sit on a grid of cells `[col, row]`. The core 3 × 3 is cells 0..2; departments go in the ring around it (-1..3), up to 5 × 5. |
| **Department** | A room the user adds from a list of surgical-navigation specialties (or a custom name), saved in `layout.json`. It joins the room beside it (`via`) by a bridge or stairs. |
| **Decor** | What the user chose to make the hospital their own, saved in `decor.json` next to `layout.json`: a **floor** per room, a **decoration** on each of a room's three **spots**, and what grows in each **garden**. |
| **Room item** | Anything standing in a room, placed on its 6 × 6 tile grid: the furniture every room starts with, decorations and fun extras. Any item may go in any room (`suits` only orders the list); doorways stay clear. Decoration spots of earlier versions become items on the grid. |
| **Garden** / **plot** | A green island people plant: the built-in Garden and Grove (`SCENERY` in `rooms.js`) and any the user adds in the ring (`layout.gardens`, ids `plot-N`). Each is a plot of 4 × 4 tiles. Plants cover 1 tile, a bench 2, and a big tree, blossom tree, cherry blossom or fountain 2 × 2. A garden is never a room and never a way in to a department. |
| **Gust** | A burst of wind every minute or two: garden plants sway and petals (or leaves) blow across the stage. Off under reduced motion. |
| **Stream** | The entries of one actor in one file: a file's own turns, or its sidechain entries grouped by `agentId`. |
| **Linking** | Matching a sidechain stream to the `Task` call that started it, by exact prompt text, never by guessing. A stream that never links is counted as *unlinked*. |
| **Task notification** | The user-role message Claude Code writes when a background helper ends (`origin.kind: task-notification`). It ends that helper and is not a new prompt. |
| **Tokens** | A reply's `usage` (input + output + cache read + cache write), counted once per message id at its fullest, because Claude Code repeats it on every content block's line. A helper counts its own; a session's row adds every helper it called. |
| **Office pack** | `office-pack/`: Claude Code agents (writer, summariser, planner, data-helper, checker; builder, code-reviewer, test-runner; project-manager, personal-assistant) and skills (four for everyday work, plus scan-projects). Offered by the app and copied into `~/.claude` only on a yes, never over existing files. |
| **Context** | How much a session's model read in its latest reply (input + cache), against where that model was seen to auto-compact, or else its context window (`usage.js`). Flagged at 85%: save your work. |
| **Claude Code use** | Tokens across all sessions over 5 hours, today and 7 days, counted once per reply by `UsageScanner`, which reads only appended lines after its first pass. |
| **Team picture** | The report's "How your team works together" (`src/core/teamwork.js`): who called which agent, which skills ran and from where (typed, picked by Claude, inside an agent), each session's hand-off chain, and what is installed but unused. Built from transcripts only; skill names, never arguments. |
| **Live map** | The pop-up beside the hospital when a session (or one of its helpers) is clicked on the board: that session and everything it has called, in order: skills it ran and every helper, finished ones too, each with the skills it ran. What runs now pulses and says "Running now". Built from the tracker's `map` on each session in the snapshot. |
| **Team reminders** | The Office pack's hook (`office-pack/hooks/agents-home-router.sh`, a UserPromptSubmit hook): when a prompt fits an installed team agent, it adds a one-line reminder to hand the work over; otherwise it prints nothing. |
| **Update agents** | Settings → Updates: adds missing team items, turns reminders on, and refreshes pack files the user has not edited (matched against `office-pack/versions.json`). |
| **Move (an agent)** | An idle agent dragged to another room (or sent there from its chart): `moves` in `layout.json`, `{ agentName: roomId }`, beating a department's list; `rooms.json` still wins over both. |
| **System log** | `activity.log` and `errors.log` in the app's data folder (`src/core/syslog.js`): agent use and errors, names and times only. With the reminder hook's own log, it shows whether the team framework is really running. |
| **Caller** | For a helper run in the report: the skill running the parent's turn when it was launched (a typed /command, or a skill Claude loaded in that turn), else "direct". |
| **Weighted tokens** | Token cost in fresh-input equivalents: input × 1, cache write × 1.25, cache read × 0.1, output × 5 (`COST_WEIGHTS` in `src/core/costs.js`). |
| **Unattributed** | A helper transcript the report could not match to the call that started it (by agent id, then by prompt). Kept as its own row with its tokens, never dropped. |
| **Foreground / background run** | Whether the parent waited for the helper. A background run is timed to its own last transcript line or its completion notice. |
| **Source** | Where a session runs: `code` (Claude Code on this computer, any front end), `wsl` (inside a WSL distro) or `cowork` (a Cowork task of the Claude desktop app, read from its task folder). Cloud sessions keep no local files and are not shown. |
| **Running now** | The board's count of live sessions by computer and project (`renderer/overview.js`). A session or helper is *running* while working, thinking, writing up, waiting on approval or with a helper. |
| **Other computers** / **shared folder** | Off by default. Each copy of the app writes `<computer>.json` to a synced folder the user picked and reads the others (`src/core/fleet.js`); offline after 3 minutes unheard. Names, statuses and counts only. |
| **Mini window** | A small always-on-top window (`renderer/mini.html`): Now (live sessions, helpers, to-do pips) and Projects. |
| **To-do list** | The list a session keeps with TodoWrite or TaskCreate/TaskUpdate, followed by the tracker. Wording shows only with privacy mode off. |
| **Project list** | `~/.agents-home/projects.json`: the user's projects, each with `copies` (branch copies, worktrees, clones) and its own `todos`. Written by the personal-assistant (`scan-projects`), the project-manager and the app. Unconfirmed projects wait for the user's Confirm. |
| **Pips** | A to-do list drawn as one mark per item: ring (to do), half-filled ring (doing), ticked square (done). |
| **Snapshot** | What the main process sends the renderer every 500 ms: sessions, their helpers, stats, roster, problems. |
| **Privacy mode** | Hides `detail` (file names, commands, patterns, hosts) and Task descriptions. On by default. |

## Statuses

Every status has its own glyph silhouette in the scene and its own words on the board.

| Status | Glyph | Board says | Meaning |
| --- | --- | --- | --- |
| `working` | spinner | the tool label ("Reading a file") | A tool call is running. |
| `thinking` | none: the figure stands still, no bubble | Thinking | Waiting on the model. The absence is the sign, so nothing pops while it thinks. |
| `reporting` | sheet of notes | Writing up findings | A helper wrote text and has not returned yet. |
| `blocked` | red disc `?` | Needs approval, or a long tool is running | An approval-type tool (Bash, Edit, Write, WebFetch…) has been pending with the file quiet for 7 s. The app cannot tell which, and says so. |
| `delegating` | hourglass | With *type* | The session is waiting on a helper. |
| `your-turn` | speech bubble | Your turn | The session finished its answer. |
| `idle` | crescent | Idle | Nothing seen yet but proof of life (attachments, meta lines). |
| `standby` | small dot badge | Standby | A staff member at their post, not working on anything. |
| `done` / finished | teal disc, tick | Finished | The helper's result came back, or its task notification said *completed*. |
| `done` / went quiet | dashed ring, tick | Presumed finished (went quiet) | A background helper wrote nothing for 2 minutes. A guess, shown as one. |
| `done` / error | red diamond, cross | Failed | The result was an error, or the notification said *failed*. |
| `done` / interrupted | dark square | Stopped | A new prompt arrived while it ran, or it was killed. |

Finished helpers walk home to the station and leave.

## Rooms

| Room | Who works there |
| --- | --- |
| Nurses' Station | Every main session |
| Operating Room | `reviewer`, `code-reviewer`, anything with *review/audit* in its name |
| Research Office | `Explore`, `Plan`, `general-purpose`, `claude-code-guide`, *research/plan/search* |
| Laboratory | `runner`, *run/test/eval/gate* |
| Radiology | `silent-failure-hunter`, *fail/bug/hunt/debug* |
| Vision Clinic | `ui-reviewer`, *ui/ux/design/visual/a11y* |
| General Ward | everyone else |
