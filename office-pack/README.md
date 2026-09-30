# Office pack

A small team for Claude Code: everyday office work for people who do not
code, and two helpers for people who do. Agent's Home offers to add it to `~/.claude` (or `$CLAUDE_CONFIG_DIR`)
and never overwrites anything already there.

| Agent | Does | Room in Agent's Home |
| --- | --- | --- |
| `writer` | emails, letters, reports, rewrites | Research Office |
| `summariser` | summaries, key points, action items | Radiology |
| `planner` | plans, schedules, checklists | Vision Clinic |
| `data-helper` | tables, calculations, formulas | Laboratory |
| `checker` | a second look before anything goes out | Operating Room |
| `code-reviewer` | checks a code change before it is called done | Operating Room |
| `test-runner` | runs tests and builds, reports only what matters | Laboratory |

| Skill | Does | Adapted from |
| --- | --- | --- |
| `question-me` | stress-test a plan with questions | `grilling` |
| `teach-me` | short lessons with a recall quiz | `teach` |
| `handover` | a handover note for a colleague | `handoff` |
| `break-down` | a project split into small tasks | `to-tickets` |

Every agent and skill follows the same few rules:

- **Keep it simple but useful:** the shortest version that still does the job, nothing extra.
- Plain words for someone who is not technical, in the language the user wrote in.
- Never invent facts, figures, names or sources; ask for what is missing.
- Never repeat identifiers of real patients unless the task needs them.

**Team reminders** (`hooks/agents-home-router.sh`): a hook that, when a
request fits an installed agent, reminds Claude to hand it over; it adds
nothing otherwise. Agent's Home turns it on by adding one entry to
`settings.json` (a copy of the old file is kept).

Claude picks the right agent or skill from what you ask; you can also name
one ("use the writer", "/handover"). Start a new Claude Code session after
adding them.

To add them by hand instead, copy `agents/*.md` into `~/.claude/agents/` and
the folders in `skills/` into `~/.claude/skills/`.
