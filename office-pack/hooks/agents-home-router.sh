#!/usr/bin/env bash
# Agent's Home team reminders (a Claude Code UserPromptSubmit hook).
#
# When a prompt fits one of the team's agents, prints a one-line reminder to
# hand the work over; Claude Code adds it to the conversation. When nothing
# fits it prints nothing, so it costs no tokens. It reads the prompt from
# stdin, keeps nothing and sends nothing. Only agents that are installed are
# mentioned. Each run adds one line to agents-home-router.log beside it: the
# time and which reminders fired (agent names only, never the prompt), so
# Agent's Home can show that the reminders are working.

dir="$(cd "$(dirname "$0")/.." && pwd)"
input="$(cat)"
# The prompt field of the hook's JSON input, lower-cased, with escaped line
# breaks and tabs turned into spaces (no jq needed; works with GNU and BSD sed).
prompt="$(printf '%s' "$input" | tr '\n' ' ' | sed -En 's/.*"prompt"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' \
  | sed -E 's/\\[nrt]/ /g' | tr '[:upper:]' '[:lower:]')"
[ -n "$prompt" ] || exit 0

tips=""
fired=""
fits() { printf '%s' "$prompt" | grep -Eq "$1"; }
tip() { [ -f "$dir/agents/$1.md" ] && tips="$tips
- $2" && fired="$fired${fired:+,}$1"; }

# Coding reminders. "fix" alone is left out on purpose: it is in almost every
# prompt of a debugging loop, and a review after each small fix costs a
# review per round for the same change.
fits '\b(implement|refactor|bug|feature|endpoint|pull request|merge request|commit|change the code|add (a|an|the) (function|method|class|test))\b' \
  && tip code-reviewer 'When the whole code change is finished (not after each small fix), review it once: the code-reviewer agent or the /code-review skill, not both. Fix what it finds and ask it to re-check only those findings.'
# The report showed general-purpose helpers taking most of the cost: whole
# changes handed off on the biggest model. A typed builder on Sonnet with a
# narrow brief does the same job.
fits '\b(implement|refactor|migrate|migration|port (it|this|the)|scaffold|build (the|a|an) (feature|page|screen|module|app)|in the background|across (the|all|every) files?)\b' \
  && tip builder 'To hand off a whole code change, use the builder agent (Sonnet), not a general-purpose helper: give it what to change, which files, and the check that proves it is done.'
fits '\b(run (the )?tests?|tests? (fail|fails|failing|failed|pass)|test suite|unit tests?|pytest|jest|vitest|npm (run )?test|lint(er|ing)?|eslint|ruff|mypy|tsc|(the )?build (fails|failed|failing|is broken|breaks))\b' \
  && tip test-runner 'Run tests, builds and linters through the test-runner agent: the tests for this change first, the full suite only when needed.'
fits '\b(e-?mails?|letter|draft|rewrite|reword|announcement|reply|translate|tone)\b' \
  && tip writer 'For writing or rewriting text, use the writer agent.'
fits '\b(summari[sz]e|summary|key points|minutes|action items|tl;?dr)\b' \
  && tip summariser 'For a summary, key points or action items, use the summariser agent.'
fits '\b(where (are|is) (we|it|this|the project)|project status|status of (the|this|my) project|what.s (left|next)|next steps?|(add|tick|update|clean up) (a |the |my )?to-?dos?|to-?do list)\b' \
  && tip project-manager 'For where this project stands, what is next, or its to-do list, use the project-manager agent (it keeps the list Agent'"'"'s Home shows).'
fits '\b(my day|today.s (plan|work)|this week|what should i (do|work on)|what am i working on|scan (my |the )?(computer|pc|laptop|drive|disk|folders?)|(organi[sz]e|list|find) (all )?(my )?projects|all my projects|daily (plan|log))\b' \
  && tip personal-assistant 'For your day across projects, or to scan and organise your projects, use the personal-assistant agent (it follows the scan-projects skill and asks you to confirm before saving).'
fits '\b(plan|schedule|timeline|checklist|roadmap|milestones?)\b' \
  && tip planner 'For a plan, schedule or checklist, use the planner agent.'
fits '\b(spreadsheet|excel|csv|formula|calculate|average|percent(age)?|pivot)\b' \
  && tip data-helper 'For tables, numbers and formulas, use the data-helper agent.'
fits '\b(proofread|double-check|check (this|my|it)|before (i )?send)\b' \
  && tip checker 'Before this goes out, have the checker agent give it a second look.'

# The log: kept to the last 1000 runs. A failure to write it never gets in
# the way of the prompt.
log="$dir/hooks/agents-home-router.log"
{
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${fired:-none}" >> "$log"
  if [ "$(wc -l < "$log")" -gt 1200 ]; then tail -n 1000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; fi
} 2>/dev/null

[ -n "$tips" ] && printf "Agent's Home team: a helper fits this request (use the Task tool):%s\n" "$tips"
exit 0
