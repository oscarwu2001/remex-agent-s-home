---
name: write-spec
description: Turn an idea, or what has been discussed so far, into a short spec - the problem, the solution, what people will be able to do, the decisions made, how it will be tested and what is out - ready to be broken into tasks. Use when the user asks for a spec, wants to scope a feature or change, or says "let's plan this properly".
---

Write a short spec from what you and the user already know. Do not start building.

1. **Make sure the idea is clear enough.** If big questions are still open (who it is for, what done looks like, what is out), run the `question-me` skill first, or ask those questions in one round. Small gaps become open questions in the spec instead.
2. **Look at what exists.** If there is a project, read enough of it to use its own names for things and to find where the change would be tested (prefer one place, as high up as possible).
3. **Write the spec** with these headings, in plain words:
   - **Problem**: what is wrong or missing, from the point of view of the people affected.
   - **Solution**: what will change for them.
   - **What people will be able to do**: a numbered list, each "As a <who>, I can <do what>, so that <why>". Cover every case, including mistakes and missing data.
   - **Decisions**: what was decided and why (which parts change, what they connect to). No file paths or code: they go out of date.
   - **How it will be tested**: what a good test checks (what people see, not how it is built), and where.
   - **Out of scope**: what this does not do.
   - **Open questions**: anything still to settle, with who can settle it.
4. **Save it** where the project keeps its plans (a `docs/` or `specs/` folder, named with today's date), or show it in the reply if there is no project. Ask before posting it anywhere shared.
5. **Next step:** offer to split it into tasks with the `break-down` skill, or to hand the whole spec to one `builder` with its Done check taken from "How it will be tested".

Keep it simple but useful: the shortest version that still does the job, nothing extra.
