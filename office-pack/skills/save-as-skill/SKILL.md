---
name: save-as-skill
description: Turn a way of working that just worked in this conversation into a skill Claude can follow next time, with every mistake made along the way written in as a rule. Use when the user says "save this as a skill", "make this a skill", "turn this into a skill" or "remember how to do this".
---

Save a way of working that just worked as a skill. Every step in it is one that really happened here, and every rule is a mistake that really happened. Nothing is added from imagination.

1. **Check it worked.** The user must have got the result they wanted in this conversation. If that is not clear, ask "did this come out right?" and wait. Something that never worked end to end is a plan, not a skill.
2. **Write down the run** from this conversation: the goal in the user's words, what it started from, the steps in the order they were taken (tools, commands, other skills or agents, and what was decided at each choice), and every correction: each time the user corrected you, a step failed or you went back. Scroll back for them: a missed correction is a rule the skill will not have.
3. **Look for an existing skill** that already covers it (`~/.claude/skills/` and the project's `.claude/skills/`). If there is one, add to it instead of making a second.
4. **Write the skill** as `<name>/SKILL.md`:
   - a short name in kebab-case, and a one-line description that says when to use it ("Use when the user ...");
   - the steps, made general: real names, paths and numbers from this run become placeholders or a note on how to find them; each step ends with how to tell it is done;
   - each correction as a rule under the step where it happened, written as what to do ("check X before Y"), with a few words on why;
   - one example at the end: the request that started this run, what a good result looked like, and what went wrong on the way;
   - under about 100 lines.
5. **Save it** in `~/.claude/skills/<name>/` if it is useful in any project, or in the project's `.claude/skills/<name>/` if only there. Leave out passwords, keys, server names and anything that identifies a patient, client or colleague.
6. **Show the user** the steps and rules in a short summary, and where it was saved.

When the skill goes wrong later, fix it the same way: find the step where it went wrong and add or sharpen the rule there.

Keep it simple but useful: the shortest version that still does the job, nothing extra.
