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

Remove the hourly task with
`Unregister-ScheduledTask -TaskName 'Agents Home status' -Confirm:$false`.

**On the main workstation** (pulls only): clone the same way, without the
second line, then in Agent's Home open Settings → Other computers →
**Use a git status folder** and pick `.agents-home\status-repo`.

**Running work, found by itself.** Every post lists Python scripts that are
on the GPU, or have kept a CPU core half busy for 5 minutes: the script's
name, its project, and how long it has run (e.g. `train.py · spine-seg ·
running for 2 h 10 · GPU 11 GB`). Nothing to add to your scripts. While
anything runs, the post goes out every 15 minutes.

**Optional: steps and epochs.** Copy `agents_progress.py` next to your
script (or add this folder to `sys.path`) and report progress:

```python
from agents_progress import Progress

with Progress("train-seg", project="spine-seg", total=epochs * len(loader), epochs=epochs) as p:
    for epoch in range(epochs):
        for batch in loader:
            ...
            p.update(step, epoch=epoch + 1, loss=float(loss))
```

The post then shows each job's epoch, step, percentage, ETA and up to six
metrics, and goes out every 15 minutes while a job runs. Jobs without the
helper still show up as a busy GPU or CPU on the machine line. Only job and
metric names and numbers are posted.

If you set this up before 30 Oct, run `install-task.ps1` once more to switch
the task to every 15 minutes.
