#!/usr/bin/env bash
# Agent's Home team reminders (a Claude Code UserPromptSubmit hook).
#
# When a prompt fits one of the team's agents, prints a one-line reminder to
# hand the work over; Claude Code adds it to the conversation. When nothing
# fits it prints nothing, so it costs no tokens. It reads the prompt from
# stdin, keeps nothing and sends nothing. Only agents that are installed are
# mentioned. In fast mode (see below) it also asks for work in parallel.

dir="$(cd "$(dirname "$0")/.." && pwd)"
input="$(cat)"
# The prompt field of the hook's JSON input, lower-cased, with escaped line
# breaks and tabs turned into spaces (no jq needed; works with GNU and BSD sed).
prompt="$(printf '%s' "$input" | tr '\n' ' ' | sed -En 's/.*"prompt"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' \
  | sed -E 's/\\[nrt]/ /g' | tr '[:upper:]' '[:lower:]')"
[ -n "$prompt" ] || exit 0

tips=""
fits() { printf '%s' "$prompt" | grep -Eq "$1"; }
tip() { [ -f "$dir/agents/$1.md" ] && tips="$tips
- $2"; }

fits '\b(implement|refactor|fix|bug|feature|endpoint|pull request|merge request|commit|change the code|add (a|an|the) (function|method|class|test))\b' \
  && tip code-reviewer 'After you change code, give the change to the code-reviewer agent and fix what it finds before you say it is done.'
fits '\b(tests?|pytest|jest|vitest|build|lint|ci|failing|traceback|stack trace|logs?)\b' \
  && tip test-runner 'Run tests, builds and long commands through the test-runner agent and work from its summary.'
fits '\b(e-?mails?|letter|draft|rewrite|reword|announcement|reply|translate|tone)\b' \
  && tip writer 'For writing or rewriting text, use the writer agent.'
fits '\b(summari[sz]e|summary|key points|minutes|action items|tl;?dr)\b' \
  && tip summariser 'For a summary, key points or action items, use the summariser agent.'
fits '\b(plan|schedule|timeline|checklist|roadmap|milestones?)\b' \
  && tip planner 'For a plan, schedule or checklist, use the planner agent.'
fits '\b(spreadsheet|excel|csv|formula|calculate|average|percent(age)?|pivot)\b' \
  && tip data-helper 'For tables, numbers and formulas, use the data-helper agent.'
fits '\b(proofread|double-check|check (this|my|it)|before (i )?send)\b' \
  && tip checker 'Before this goes out, have the checker agent give it a second look.'

# Team speed, set in Agent's Home: "base" (the default) or "fast". Fast
# spends more tokens to finish sooner: for any real task (8 words or more)
# it asks Claude to split independent parts across agents working at once.
mode="base"
[ -f "$dir/hooks/agents-home-mode" ] && mode="$(tr -d '[:space:]' < "$dir/hooks/agents-home-mode")"
if [ "$mode" = "fast" ] && [ "$(printf '%s' "$prompt" | wc -w)" -ge 8 ]; then
  tips="$tips
- Fast mode: split independent parts of this across several agents started together (several Task calls in one reply), for example one Explore agent per area to search, code-reviewer and test-runner side by side, or one general-purpose agent per independent file or document. Start the next one without waiting unless it needs the other's result, then combine what they return."
fi

[ -n "$tips" ] && printf "Agent's Home team: a helper fits this request (use the Task tool):%s\n" "$tips"
exit 0
