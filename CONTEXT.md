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
| **Spot** | A place on a room's floor, clear of furniture, doorways and people, that takes one decoration. Only decorations that belong in that room are offered (a specimen fridge in the Laboratory, a crash cart in the Operating Room). |
| **Garden** / **plot** | A green island people plant: the built-in Garden and Grove (`SCENERY` in `rooms.js`) and any the user adds in the ring (`layout.gardens`, ids `plot-N`). Each is a plot of 4 × 4 tiles. Plants cover 1 tile, a bench 2, and a big tree, blossom tree, cherry blossom or fountain 2 × 2. A garden is never a room and never a way in to a department. |
| **Gust** | A burst of wind every minute or two: garden plants sway and petals (or leaves) blow across the stage. Off under reduced motion. |
| **Stream** | The entries of one actor in one file: a file's own turns, or its sidechain entries grouped by `agentId`. |
| **Linking** | Matching a sidechain stream to the `Task` call that started it, by exact prompt text, never by guessing. A stream that never links is counted as *unlinked*. |
| **Task notification** | The user-role message Claude Code writes when a background helper ends (`origin.kind: task-notification`). It ends that helper and is not a new prompt. |
| **Tokens** | A reply's `usage` (input + output + cache read + cache write), counted once per message id at its fullest, because Claude Code repeats it on every content block's line. A helper counts its own; a session's row adds every helper it called. |
| **Office pack** | `office-pack/`: five Claude Code agents (writer, summariser, planner, data-helper, checker) and four skills for people who do not code. Offered by the app and copied into `~/.claude` only on a yes, never over existing files. |
| **Snapshot** | What the main process sends the renderer every 500 ms: sessions, their helpers, stats, roster, problems. |
| **Privacy mode** | Hides `detail` (file names, commands, patterns, hosts) and Task descriptions. On by default. |

## Statuses

Every status has its own glyph silhouette in the scene and its own words on the board.

| Status | Glyph | Board says | Meaning |
| --- | --- | --- | --- |
| `working` | spinner | the tool label ("Reading a file") | A tool call is running. |
| `thinking` | pill, three dots | Thinking | Waiting on the model. |
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
