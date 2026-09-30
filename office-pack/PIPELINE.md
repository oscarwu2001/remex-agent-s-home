# The team pipeline

How work flows through the Office pack's team in Claude Code, in its two
speeds. The team reminders hook (`hooks/agents-home-router.sh`) is what steers
it; the speed is chosen in Agent's Home under **Settings → Office team for
Claude → Team speed** and kept in `~/.claude/hooks/agents-home-mode`.

## Base: one helper when one fits

Fewer tokens. Claude does the work itself and hands a part over when a helper
fits it, one at a time.

```mermaid
flowchart LR
  P[Your prompt] --> H{Team reminders:<br/>does a helper fit?}
  H -- no --> C[Claude works on it]
  H -- yes --> T[Claude hands that part<br/>to the helper]
  T --> C
  C --> R{Code changed?}
  R -- yes --> CR[code-reviewer:<br/>PASS or FAIL]
  CR -- FAIL --> C
  CR -- PASS --> D[Done]
  R -- no, text --> CK[checker, when it<br/>goes to other people]
  CK --> D
```

| Request | Helper |
| --- | --- |
| an email, letter, reply, rewrite | `writer` |
| a summary, key points, action items | `summariser` |
| a plan, schedule, checklist | `planner` |
| tables, numbers, formulas | `data-helper` |
| a second look before it goes out | `checker` |
| a code change (fix, feature, refactor) | `code-reviewer` after the change |
| tests, builds, long commands | `test-runner` |

## Fast: several helpers at the same time

Uses more tokens and finishes sooner. On top of Base, any real task (eight
words or more) gets one more reminder: split independent parts across several
helpers started together, several Task calls in one reply, then combine what
they return.

```mermaid
flowchart LR
  P[Your prompt] --> S[Claude splits it into<br/>independent parts]
  S --> A1[Explore: area 1]
  S --> A2[Explore: area 2]
  S --> A3[general-purpose:<br/>file or document 3]
  A1 --> M[Claude combines<br/>the results]
  A2 --> M
  A3 --> M
  M --> CR[code-reviewer] & TR[test-runner]
  CR --> D[Done]
  TR --> D
```

Parts that need another part's result still wait for it. Good fits for Fast:
searching several areas of a codebase, reviewing and testing at once,
summarising several documents, drafting several separate emails.

## What stays the same in both

- Claude picks helpers by their descriptions; the reminders only make it
  think of them. Nothing is forced.
- Each helper keeps its own rules: keep it simple but useful, plain words,
  never invent facts, never repeat patient identifiers.
- The reminders read the prompt and keep nothing; with nothing to remind,
  they add nothing.
