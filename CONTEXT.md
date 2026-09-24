# Vocabulary

| Term | Meaning |
| --- | --- |
| **Session** | One Claude Code conversation: one main `.jsonl` transcript. Drawn as an attending in a white coat at the Nurses' Station. |
| **Helper** / **sub-agent** | An agent started by a `Task` (older) or `Agent` (newer) tool call. Drawn as a figure who walks from the station to its room and back. |
| **Agent type** | The `subagent_type` of the call (`reviewer`, `Explore`, …). Decides the room. |
| **Room** | One of the seven places in `src/core/rooms.js`. |
| **Stream** | The entries of one actor in one file: a file's own turns, or its sidechain entries grouped by `agentId`. |
| **Linking** | Matching a sidechain stream to the `Task` call that started it, by exact prompt text, never by guessing. A stream that never links is counted as *unlinked*. |
| **Task notification** | The user-role message Claude Code writes when a background helper ends (`origin.kind: task-notification`). It ends that helper and is not a new prompt. |
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
