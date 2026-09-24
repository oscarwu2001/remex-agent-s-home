# Agent's Home

A little isometric hospital, drawn in the soft geometric style of *Monument
Valley*, where your Claude Code agents live and work. It's the same idea as
Pixel Agents, but the rooms are hospital departments:

- **Nurses' Station**: every Claude Code session you have open is an attending here.
- **Operating Room**: `reviewer` goes into surgery on your diff.
- **Research Office**: `Explore`, `Plan` and `general-purpose` do their research at the desks.
- **Laboratory**: `runner` runs tests and experiments.
- **Radiology**: `silent-failure-hunter` looks for what doesn't show on the surface.
- **Vision Clinic**: `ui-reviewer` checks contrast and legibility at the eye chart.
- **General Ward**: any other agent.

When a session calls a sub-agent, a figure walks out of the station, along the
bridges and up the stairs to its room. It works there, showing a status bubble,
and walks back when it returns its result.

It comes in three calm colourways inspired by *Monument Valley 3*: pastel
towers whose shaded sides turn violet, indigo or sea blue. Switch between
them at the bottom of the side panel.

| Blossom | Tide | Grove |
| --- | --- | --- |
| ![Blossom](docs/blossom.png) | ![Tide](docs/tide.png) | ![Grove](docs/grove.png) |

## Install on Windows

**Download a build.** Every push builds the Windows app on GitHub Actions. Open
the repo's **Actions** tab, then the latest **Windows build** run, and download
the **AgentsHome-windows** artifact. It contains:

- `AgentsHome-Setup-<version>.exe`: installer with a Start-menu and desktop shortcut.
- `AgentsHome-Portable-<version>.exe`: a single exe that needs no install.

Tagging a version (`git tag v0.1.0 && git push --tags`) also attaches both
files to a GitHub Release.

The exe is not code-signed, so SmartScreen will warn the first time. Choose
**More info → Run anyway**.

**Or build it yourself** with Node.js 20 or later:

```powershell
git clone https://github.com/oscarwu2001/remex-agent-s-home.git
cd remex-agent-s-home
npm ci
npm start            # run it now, against your real sessions
npm run dist:win     # or build dist\AgentsHome-Setup-0.1.0.exe
```

## Getting around

- **Turn the hospital:** drag sideways with the mouse, or press Q and E. It turns a quarter at a time and can face all four ways. Heights follow the view the way they do in Monument Valley: the side nearest you sinks lowest, the far side rises highest, and the stairs between rooms change with them as the towers rise and sink into place.
- **Visit a room:** click its sign or its floor. **Whole hospital** (or Esc) flies back out.
- **Zoom and move:** scroll to zoom. Right-drag (or Shift-drag) to move.
- **Settings** (the gear at the top of the panel): colourway, night, privacy, name tags, demo patients and the hospital layout.
- **Night:** each colourway has a night version with stars, a moon and lit windows. By day a small sun keeps watch.
- Figures act out their work: a book while reading, a pencil while writing, a bubbling flask while running commands, a magnifier while searching. They sway while thinking, hop impatiently while waiting for approval, and give a little hop of relief when they finish.

## Grow the hospital

The core hospital is a 3 × 3 block. Open **Settings** (the gear), go to **Hospital layout** and choose **Add a department**. The free spots around the hospital light up with a "+" (up to 5 × 5 in all). Pick a spot, then choose the department:

Spine Surgery · Neurosurgery · ENT · Dental Implantology · Maxillofacial (CMF) · Orthopaedics · Trauma · Sports Medicine · Pulmonology · Interventional Radiology · Cardiac Electrophysiology · Surgical Oncology, or **Your own department** with a name you choose.

Tick the agents who work there, or type a new agent's name. The department is built as its own tower, joined by stairs to the room next to it. It comes with a navigation suite (table, tracking camera, planning monitor) and a piece that marks its specialty. Its agents walk there when they are called. Corner spots open up once a neighbouring department exists.

The layout is saved in `%APPDATA%\Agents Home\layout.json`. Assignments written by hand in `rooms.json` still win over ones made in the app.

## Performance report

```powershell
npm run report                 # last 28 days
npm run report -- --days 7     # last week
```

This reads your transcripts (read-only) and writes `out/reports/agent-report-<date>.html`, a self-contained page that opens offline. It also writes `runs`, `daily` and `weekly` CSV files for your own analysis. The page shows:

- **Headline numbers:** helper runs, the share that finished, median helper time and tokens used, each compared with the period before.
- **Scorecard per agent:** runs, a score out of 100, finished %, re-runs, median and p90 time, tokens per run, tool calls per run, tool error rate, PASS/FAIL or Approve/Block verdicts, and a 14-day sparkline.
- **Charts:** runs per day, weekly score per agent, and how long each agent takes.

The **score** is reliability (40), right first time (20), speed (20) and efficiency (20). Speed and efficiency are measured against the same agent's own history, never against other agents. A reviewer answering FAIL is doing its job and is never marked down for it. The report keeps no prompts, results, file names or commands. Sessions appear as `s1`, `s2`…, and project names appear only if you ask with `--by-project`.

## How it works

Claude Code writes every conversation to a JSONL transcript under
`%USERPROFILE%\.claude\projects\` (or `$CLAUDE_CONFIG_DIR\projects`). The app
polls that folder, tails files written in the last 30 minutes, and turns each
line into events: a tool call starts, a tool returns, a `Task`/`Agent` call
spawns a helper, the answer ends. From those events it decides what each
figure is doing:

| Bubble | Board says | Meaning |
| --- | --- | --- |
| spinner | *Reading a file*, *Running a command*… | working |
| three dots | Thinking | waiting on the model |
| sheet of notes | Writing up findings | a helper is writing its report |
| red **?** | Needs approval, or a long tool is running | a Bash/Edit/Write/Web call has been pending for 7 s. The app can't tell which of the two it is, so it says both |
| hourglass | With *reviewer* | the session is waiting on a helper |
| speech bubble | Your turn | the session has finished its answer |
| tick | Finished | a helper returned and is walking home |
| dashed tick | Presumed finished | a background helper went quiet for 2 minutes |
| red diamond | Failed | a helper returned an error |
| dark square | Stopped | a helper was interrupted |

Click a figure or a row on the board to open its **chart**, which shows its
recent tool calls.

**Privacy.** The app is local only. It makes no network requests and never
writes to `.claude`. **Hide file names and commands** is on by default. With
it on, the board shows "Reading a file" but not the file's name, and it hides
task descriptions and folder paths too. Error messages never quote the
contents of a transcript line. Turn privacy off when you're not sharing your
screen.

**Your own agents.** Agents in `~/.claude/agents/*.md` and in each open
project's `.claude/agents/` are listed in the **Staff directory** with the room
they'll use. To move an agent, create `rooms.json` in the app's data folder
(`%APPDATA%\Agents Home\rooms.json`):

```json
{ "my-security-auditor": "operating-room", "doc-writer": "research-office" }
```

Room ids are `nurses-station`, `operating-room`, `research-office`,
`laboratory`, `radiology`, `vision-clinic` and `general-ward`. A typo is
reported under **Needs attention**, not silently ignored.

## Develop

```bash
npm ci
npm test          # fast unit tests for the parser, tracker, rooms and tailer
npm run demo      # the app with scripted demo patients
npm run preview   # the renderer in a browser: http://localhost:5178/?demo=1
```

`CLAUDE.md` has the rules for this repo. `CONTEXT.md` has the vocabulary.
`.claude/agents/` holds the `reviewer`, `runner`, `silent-failure-hunter` and
`ui-reviewer` agents, and `.claude/skills/project-quality/` holds the
reviewer's checklist for this project.

## Credits

The idea comes from [Pixel Agents](https://github.com/pablodelucca/pixel-agents).
The art style is a homage to *Monument Valley* by ustwo games. All artwork here
is original and drawn in code; no assets from the game are used.

MIT licence.
