---
name: scan-projects
description: Find every project on the computer, group branch copies, worktrees and extra clones under their main project, ask the user to confirm the list, then save it to the shared project list that Agent's Home shows. Use when the user asks to scan the computer or a drive for projects, to organise their projects, or to work out what they are working on.
---

Build the user's project list in four steps. Save nothing before step 3.

**1. Find candidates.** Look where the user said; otherwise in their home folder's usual places (Desktop, Documents, `source`, `code`, `projects`, `repos`, `dev`, `GitHub`, and any folder in the Claude app the user has shared). Look at most 4 folders deep. Skip `node_modules`, `.venv`, `venv`, `AppData`, `Library`, `.cache`, `dist`, `build`, `.git` internals and anything under `.claude`.
A folder is a project when it holds a `.git` (a folder, or a file for a worktree). Without git, count a folder only if it has a clear project file (`package.json`, `pyproject.toml`, `*.sln`, `CMakeLists.txt`, `*.SLDPRT`-heavy CAD folders) and say it has no git.
Use commands that list, never ones that change: `git -C <dir> rev-parse --git-common-dir`, `git -C <dir> remote get-url origin`, `git -C <dir> branch --show-current`, `git -C <dir> log -1 --format=%cI`.

**2. Find the main one of each group.** Folders belong to the same project when they share a git common dir (worktrees), or the same `origin` remote (extra clones, branch copies), or one is plainly a copy of the other (`name-old`, `name-v2`, `name-backup`, `name-wt-<branch>`). The main one is, in order: the one that is not a worktree; then the one on the default branch (`main` or `master`); then the most recently committed. Every other folder goes in its `copies`, with its `branch` and `kind` (`worktree`, `clone` or `copy`).
A project is **active** when it had a commit, or a file changed, in the last 14 days.

**3. Ask the user.** Show one short table: # | Project | Main folder | Copies | Last work | Active?. Then say: "I found N projects; M look active. Is that right?" and ask them to confirm, rename, merge, mark paused or drop any. Wait for the answer. If they do not answer, save nothing.

**4. Save.** Write `~/.agents-home/projects.json` (or the file in `AGENTS_HOME_PROJECTS`):
`{ "version": 1, "projects": [ { "id", "name", "path", "copies": [{ "path", "branch", "kind" }], "status": "active" | "paused" | "done", "confirmed": true, "todos": [] } ] }`.
Read the file again right before you write (the user may have ticked to-dos in Agent's Home while you waited for their answer) and merge: match by `path` (or a copy's path), keep every existing project's `todos` and any field you do not know, and add the new ones. Write the whole file at once: a temporary file in the same folder, then rename it over the old one. If the file is not valid JSON, stop and tell the user.

End with one line: how many projects were saved, how many active, and that they now show in Agent's Home under Projects, where to-dos can be added.

Keep it simple but useful: the shortest version that still does the job, nothing extra. Never read the contents of files beyond what is needed to tell a project apart, and never repeat what is in them.
