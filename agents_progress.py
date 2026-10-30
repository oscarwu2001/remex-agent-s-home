"""Tell Agent's Home how a long job is going: training, evaluation, export.

Drop this file next to your script (or add its folder to sys.path) and:

    from agents_progress import Progress

    with Progress("train-seg", project="spine-seg", total=epochs * len(loader), epochs=epochs) as p:
        for epoch in range(epochs):
            for batch in loader:
                ...
                p.update(step, epoch=epoch + 1, loss=float(loss))
            p.update(step, epoch=epoch + 1, val_dice=dice)

It writes ~/.agents-home/jobs/<name>.json (at most every 10 seconds, and
always at the end), which this computer's status post and Agent's Home read.
Plain Python, no packages, no network. Leaving the `with` block marks the job
done, or failed if it raised. Only the job name, project, numbers and metric
names are written: never paths, data or messages.
"""

import json
import math
import os
import re
import tempfile
import time

_DIR = os.environ.get("AGENTS_HOME_JOBS") or os.path.join(os.path.expanduser("~"), ".agents-home", "jobs")
_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


class Progress:
    def __init__(self, name, project=None, total=None, epochs=None, every=10.0):
        self.name = str(name)[:80]
        self.data = {
            "name": self.name,
            "project": None if project is None else str(project)[:80],
            "state": "running",
            "step": 0,
            "total": total,
            "epoch": None,
            "epochs": epochs,
            "metrics": {},
            "pid": os.getpid(),
            "startedAt": time.time() * 1000,
            "updatedAt": time.time() * 1000,
        }
        self.every = every
        self._last = 0.0
        self.file = os.path.join(_DIR, (_SAFE.sub("-", self.name) or "job") + ".json")
        self._write()

    def update(self, step=None, epoch=None, total=None, note=None, **metrics):
        """Record progress. Metrics are numbers (loss=0.12, val_dice=0.91)."""
        d = self.data
        if step is not None:
            d["step"] = int(step)
        if epoch is not None:
            d["epoch"] = int(epoch)
        if total is not None:
            d["total"] = int(total)
        if note is not None:
            d["note"] = str(note)[:60]  # a short stage name, e.g. "validating"
        for k, v in metrics.items():
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue  # only numbers are reported
            if math.isfinite(v) and (len(d["metrics"]) < 6 or str(k)[:24] in d["metrics"]):
                d["metrics"][str(k)[:24]] = round(v, 6)
        if time.time() - self._last >= self.every:
            self._write()

    def done(self, failed=False):
        self.data["state"] = "failed" if failed else "done"
        self._write()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is KeyboardInterrupt:
            self.data["state"] = "stopped"
            self._write()
        else:
            self.done(failed=exc_type is not None)
        return False

    def _write(self):
        self.data["updatedAt"] = time.time() * 1000
        self._last = time.time()
        try:
            os.makedirs(_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=_DIR, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.file)  # whole files only
        except OSError as err:
            # Reporting must never stop the job; say so once and carry on.
            if not getattr(self, "_warned", False):
                print(f"agents_progress: could not write {self.file}: {err}")
                self._warned = True
