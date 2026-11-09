---
name: find-the-bug
description: Find the cause of a bug before fixing it - first one command that shows it failing, then the cause, then the fix and a test that keeps it fixed. Use when something is broken and the cause is not known yet (a crash, a wrong result, an error message, it stopped working).
---

Find the cause of the bug before changing any code.

1. **Make it fail on purpose.** Find one command that shows the bug every time: a test, a script, a call with the input that breaks it. Do not form a theory until this command is red. If you cannot make it fail, say so and ask for what is missing (the input, the steps, the error text).
2. **Narrow it down.** Shrink the input or the steps until the failure is as small as it gets. Read the error and the code it points to. Check the most likely cause first, and test each guess with the command, not by reading alone.
3. **Name the cause** in one sentence: what goes wrong, where (`file:line`), and why. If two causes fit, find a check that tells them apart.
4. **Fix it, and keep it fixed.** Turn the failing command into a test if it is not one already. Make the smallest change that turns it green, then run the project's quick tests. A bigger fix goes to the builder agent, with the test as its Done check.

Report: the command that showed it, the cause, the fix and the test, in a few lines.

Keep it simple but useful: the shortest version that still does the job, nothing extra.
