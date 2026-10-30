'use strict';

// Long jobs (training, evaluation, export) report their progress with
// agents_progress.py into ~/.agents-home/jobs/<name>.json (or
// $AGENTS_HOME_JOBS). This reads them for this computer, and checks the
// same shape when it arrives from another computer's status post. Only
// names and numbers: never paths or data.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = new Set(['running', 'done', 'failed', 'stopped', 'stalled']);
const STALL_MS = 30 * 60_000; // a running job silent this long is stalled
const KEEP_MS = 24 * 3_600_000; // finished jobs are listed for a day
const LIMIT = 12;

function jobsDir(env = process.env, home = os.homedir()) {
  return env.AGENTS_HOME_JOBS || path.join(home, '.agents-home', 'jobs');
}

const num = (v, max = 1e12) => (Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
const name = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// One job in the shape both windows draw, or undefined if it makes no sense.
function cleanJob(j) {
  if (!j || typeof j !== 'object') return undefined;
  const jobName = name(j.name, 80);
  const updatedAt = num(j.updatedAt, 1e14);
  if (!jobName || !updatedAt) return undefined;
  const metrics = {};
  if (j.metrics && typeof j.metrics === 'object') {
    for (const [k, v] of Object.entries(j.metrics).slice(0, 6)) {
      if (Number.isFinite(v) && name(k, 24)) metrics[name(k, 24)] = v;
    }
  }
  const step = num(j.step);
  const total = num(j.total);
  return {
    name: jobName,
    project: name(j.project, 80),
    state: STATES.has(j.state) ? j.state : 'running',
    step,
    total: total && total > 0 ? total : undefined,
    epoch: num(j.epoch, 1e7),
    epochs: num(j.epochs, 1e7),
    note: name(j.note, 60),
    metrics,
    startedAt: num(j.startedAt, 1e14),
    updatedAt,
    eta: num(j.eta, 1e11),
  };
}

const realAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, but another user's process
  }
};

// This computer's jobs: running ones whose process has ended are
// "stopped", running ones silent for 30 minutes "stalled".
function readJobs(dir = jobsDir(), now = Date.now(), { fsys = fs, alive = realAlive } = {}) {
  const problems = [];
  let names;
  try {
    names = fsys.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    // No jobs folder is normal: nothing reports progress on this computer.
    if (err.code !== 'ENOENT') problems.push({ label: `The jobs folder could not be read (${err.code || 'error'})`, detail: dir, count: 1 });
    return { jobs: [], problems };
  }
  const jobs = [];
  for (const n of names) {
    let raw;
    try {
      raw = JSON.parse(fsys.readFileSync(path.join(dir, n), 'utf8'));
    } catch (err) {
      // A job writes whole files, so a broken one is worth saying once.
      if (err.code !== 'ENOENT') problems.push({ label: 'A job progress file could not be read', detail: path.join(dir, n), count: 1 });
      continue;
    }
    const job = cleanJob(raw);
    if (!job || now - job.updatedAt > KEEP_MS) continue;
    // Kept on this computer only, so its process is not listed twice.
    if (Number.isInteger(raw.pid)) Object.defineProperty(job, 'pid', { value: raw.pid, enumerable: false });
    if (job.state === 'running') {
      if (alive(raw.pid) === false) job.state = 'stopped';
      else if (now - job.updatedAt > STALL_MS) job.state = 'stalled';
    }
    const elapsed = job.updatedAt - (job.startedAt ?? job.updatedAt);
    if (job.state === 'running' && job.step > 0 && job.total > job.step && elapsed > 0) {
      job.eta = Math.round(((job.total - job.step) * elapsed) / job.step);
    }
    jobs.push(job);
  }
  return { jobs: sortJobs(jobs).slice(0, LIMIT), problems };
}

const sortJobs = (jobs) => [...jobs].sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || b.updatedAt - a.updatedAt);

// The machine line from a post: GPUs and CPU, numbers only.
function cleanMachine(m) {
  if (!m || typeof m !== 'object') return undefined;
  const gpus = (Array.isArray(m.gpus) ? m.gpus.slice(0, 4) : [])
    .map((g) => ({ name: name(g?.name, 40) ?? 'GPU', util: num(g?.util, 100), memUsed: num(g?.memUsed, 1e7), memTotal: num(g?.memTotal, 1e7), temp: num(g?.temp, 150) }))
    .filter((g) => g.util !== undefined || g.memUsed !== undefined);
  const out = { gpus, cpu: num(m.cpu, 100), memUsed: num(m.memUsed, 1e8), memTotal: num(m.memTotal, 1e8) };
  return gpus.length || out.cpu !== undefined ? out : undefined;
}

// One piece of running work from a post (src/core/work.js): script name,
// project, CPU or GPU, start time, GPU memory. The process id stays home.
function cleanWork(w) {
  if (!w || typeof w !== 'object') return undefined;
  const workName = name(w.name, 64);
  const startedAt = num(w.startedAt, 1e14);
  if (!workName || !startedAt) return undefined;
  return { name: workName, project: name(w.project, 80), on: w.on === 'gpu' ? 'gpu' : 'cpu', startedAt, gpuMem: num(w.gpuMem, 1e7) };
}

module.exports = { jobsDir, readJobs, cleanJob, cleanMachine, cleanWork, sortJobs, STALL_MS };
