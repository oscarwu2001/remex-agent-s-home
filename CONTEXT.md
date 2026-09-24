# Vocabulary

| Term | Meaning |
| --- | --- |
| **Session** | One Claude Code conversation: one main `.jsonl` transcript. Drawn as an attending in a white coat at the Nurses' Station. |
| **Helper** / **sub-agent** | An agent started by a `Task` (older) or `Agent` (newer) tool call. Drawn as a figure who walks from the station to its room and back. |
| **Agent type** | The `subagent_type` of the call (`reviewer`, `Explore`, …). Decides the room. |
| **Room** | One of the seven places in `src/core/rooms.js`. |
| **Stream** | The entries of one actor in one file: a file's own turns, or its sidechain entries grouped by `agentId`. |
| **Linking** | Matching a sidechain stream to the `Task` call that started it, by prompt text. A stream that never links is counted as *unlinked*. |
| **Snapshot** | What the main process sends the renderer every 500 ms: sessions, their helpers, stats, roster, problems. |
| **Privacy mode** | Hides `detail` (file names, commands, patterns, hosts) and Task descriptions. On by default. |

## Statuses

| Status | Glyph | Meaning |
| --- | --- | --- |
| `working` | spinner | A tool call is running. |
| `thinking` | three dots | Waiting on the model. |
| `blocked` | red `?` | An approval-type tool (Bash, Edit, Write, WebFetch…) has been pending and the file quiet for 7 s. It is either waiting for approval or simply running long, and the label says both. |
| `delegating` | hourglass | The session is waiting on a helper. |
| `your-turn` | speech bubble | The session finished its answer. |
| `reporting` | three dots | A helper wrote text and has not returned yet. |
| `done` | check | A helper returned (or was stopped, or went quiet). It walks home and leaves. |

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
