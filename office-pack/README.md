# Office pack

A small team for everyday office work in Claude Code, for people who do not
code. Agent's Home offers to add it to `~/.claude` (or `$CLAUDE_CONFIG_DIR`)
and never overwrites anything already there.

| Agent | Does | Room in Agent's Home |
| --- | --- | --- |
| `writer` | emails, letters, reports, rewrites | Research Office |
| `summariser` | summaries, key points, action items | Radiology |
| `planner` | plans, schedules, checklists | Vision Clinic |
| `data-helper` | tables, calculations, formulas | Laboratory |
| `checker` | a second look before anything goes out | Operating Room |

| Skill | Does | Adapted from |
| --- | --- | --- |
| `question-me` | stress-test a plan with questions | `grilling` |
| `teach-me` | short lessons with a recall quiz | `teach` |
| `handover` | a handover note for a colleague | `handoff` |
| `break-down` | a project split into small tasks | `to-tickets` |

Claude picks the right agent or skill from what you ask; you can also name
one ("use the writer", "/handover"). Start a new Claude Code session after
adding them.

To add them by hand instead, copy `agents/*.md` into `~/.claude/agents/` and
the folders in `skills/` into `~/.claude/skills/`.
