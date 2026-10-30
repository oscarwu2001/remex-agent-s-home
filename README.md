# Agents status

Each work computer posts a short status here every hour from 9:00 to 19:00:
`status/<computer>.md` to read, `status/<computer>.json` for Agent's Home.
No Claude is involved, so it costs no tokens. Project names, branches,
commit times and counts only; never file names, prompts or commit messages.

**On a computer that posts** (needs Node and git):

```powershell
git clone -b agents-status --single-branch https://github.com/oscarwu2001/remex-agent-s-home "$HOME\.agents-home\status-repo"
powershell -ExecutionPolicy Bypass -File "$HOME\.agents-home\status-repo\install-task.ps1"
```

**On the main workstation** (pulls only): clone the same way, without the
second line, then in Agent's Home open Settings → Other computers →
**Use a git status folder** and pick `.agents-home\status-repo`.
