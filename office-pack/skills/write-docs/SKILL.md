---
name: write-docs
description: Write or update documentation that is checked against the code - a README, a how-to guide, a tutorial, a reference page, an explanation, docstrings or a changelog. Use when the user asks to document something, write or fix docs, or update a README.
---

Write documentation where every statement can be traced to the code, a command you ran, or a decision someone wrote down. A wrong doc gets believed, so being right matters more than being complete.

1. **Pick one reader and one kind of page.** Name the reader in a line (a new colleague, someone using the API, future you), then the kind of page:
   - *Tutorial*: they want to learn by doing. One path that is sure to work, start to finish.
   - *How-to*: they want a task done. Numbered steps for one goal, what is needed first at the top.
   - *Reference*: they want to look something up. Complete, plain, laid out like the code it describes.
   - *Explanation*: they want to know why. Prose on the design and its trade-offs.
   One page, one kind. A request that needs two becomes two pages that link to each other.
2. **Find what already exists**: the README, a `docs/` folder, a changelog, the style of docstrings nearby. Update the page that owns the topic instead of adding a second one, and link to a fact rather than repeating it.
3. **Check every claim in the code**, not from memory: search for the exact name and read around it. Copy names, defaults, options and error messages exactly. Where the reason for something is not written down, say what the code does and ask the user why.
4. **Write.** Start with what the reader does or gets, in the first two lines. One name for each thing throughout. Examples that can be copied and run as they are. Versions and what is needed first, once, near the top.
5. **Run what you wrote.** Run every example and command that only reads or is safe to repeat. Never run one that changes shared things (deploys, deletes, publishes): mark it "not run" instead. Where an example and the code disagree, fix the doc; changing the code is the user's call. Check that every link and path in the page exists.

Say in your reply which examples you ran and which you could not.

Keep it simple but useful: the shortest version that still does the job, nothing extra.
