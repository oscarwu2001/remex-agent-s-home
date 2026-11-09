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
# A background helper reporting back is not the user asking for something.
case "$prompt" in '<task-notification'*) exit 0 ;; esac

tips=""
fired=""
fits() { printf '%s' "$prompt" | grep -Eq "$1"; }
tip() { [ -f "$dir/agents/$1.md" ] && tips="$tips
- $2" && fired="$fired${fired:+,}$1"; }
skilltip() { [ -f "$dir/skills/$1/SKILL.md" ] && tips="$tips
- $2" && fired="$fired${fired:+,}$1"; }

# Coding reminders. "fix" alone is left out on purpose: it is in almost every
# prompt of a debugging loop, and a review after each small fix costs a
# review per round for the same change.
fits '\b(implement|refactor|bug|feature|endpoint|pull request|merge request|commit|change the code|add (a|an|the) (function|method|class|test))\b' \
  && tip code-reviewer 'When the whole code change is finished (not after each small fix), have the code-reviewer agent review it once (not also /code-review): give it what was asked and the diff, not the builder'"'"'s report. Send all its findings back to whoever built it in one round (the same builder, with SendMessage), then ask it to re-check only those.'
# The report showed general-purpose helpers taking most of the cost: whole
# changes handed off on the biggest model. One typed builder on Sonnet per
# change, with a brief that says how to tell it is done, does the same job;
# splitting a change into many helpers loses what each piece knew.
# A change that touches data, or a screen, gets a second reviewer alongside,
# on the same diff: each catches what the code review passes.
if fits '\b(implement|refactor|bug|feature|endpoint|pull request|merge request|commit|change the code|migrat(e|ion))\b'; then
  fits '\b(pars(e|er|ing)|loader|load(s|ing)? (the )?(data|file)|import(er)?|export(er)?|convert(er|ing)?|serialis|serializ|csv|json|dataset|pipeline|database|sav(e|es|ing) (the )?(file|data|results?)|calculat(e|ion))' \
    && tip silent-failure-hunter 'This change touches how data is read, converted or saved: have the silent-failure-hunter agent look at the same diff alongside the code-reviewer, for errors that would stay hidden.'
  fits '\b(ui|ux|screens?|layout|css|styl(e|es|ing)|restyle|buttons?|colou?rs?|fonts?|dark mode|responsive|landing page|dialog|sidebar|menu)\b' \
    && tip ui-reviewer 'This change is about how something looks: have the ui-reviewer agent check it (a screenshot if the project can make one) alongside the code-reviewer.'
fi
fits '\b(bug|crash(es|ed|ing)?|traceback|stack trace|exception|regression|broken|(doesn.t|does not|stopped|isn.t) work(ing)?)\b' \
  && skilltip find-the-bug 'If the cause is not known yet, follow the find-the-bug skill: first one command that shows it failing, then the cause, then the fix and a test.'
fits '\b(research|look (it |this |that )?up|find out (if|whether|how|which)|which (library|package|tool|version|model)|compare (the )?(libraries|packages|tools|options|frameworks)|latest version|official doc(s|umentation))\b' \
  && tip researcher 'For a question that needs looking up, send it to the researcher agent (one question each), so the searching stays out of this conversation.'
fits '\b(implement|refactor|migrate|migration|port (it|this|the)|scaffold|build (the|a|an) (feature|page|screen|module|app)|in the background|across (the|all|every) files?)\b' \
  && tip builder 'For anything bigger than a small edit, hand the whole change to one builder agent (not a general-purpose helper, not one helper per piece). Its brief: the goal, Done check: (how to tell it works), Scope: (which files) and Checked by: (code-reviewer). Small edits stay here.'
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
# Planner and data-helper only on an explicit ask: "plan" and "calculate"
# are in many coding prompts, where these helpers do not fit.
fits '\b((make|write|draft|build|prepare|create) (me )?(a |an |the )?(project |work |weekly |study )?(plan|schedule|timeline|checklist|roadmap)|meeting schedule|milestones)\b' \
  && tip planner 'For a plan, schedule or checklist, use the planner agent.'
fits '\b(spreadsheet|excel|formulas?|pivot( table)?|vlookup|xlookup)\b' \
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
