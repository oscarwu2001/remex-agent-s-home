'use strict';

// Finds work running on this computer without any change to the scripts:
// Python processes that are on the GPU (nvidia-smi), or that have kept at
// least half a CPU core busy for five minutes or more. Each one is reported
// as its script's name, the project folder it belongs to, how long it has
// run and its GPU memory. Never the full command line, arguments or paths.
//
// The same file is Agent's Home's src/core/work.js; keep the two in step.

const { execFile, execFileSync } = require('child_process');
const path = require('path');

const MIN_AGE_MS = 5 * 60_000;
const BUSY_CORES = 0.5; // average CPU use, in cores, that counts as working
const LIMIT = 12;

// The script a Python command line runs: "train.py", or "-m pkg.mod".
function scriptOf(cmdline) {
  const tokens = String(cmdline ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const words = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '-m' && words[i + 1]) return { name: `-m ${words[i + 1].slice(0, 60)}` };
    if (/\.pyw?$/i.test(words[i])) return { name: path.win32.basename(path.posix.basename(words[i])).slice(0, 60), file: words[i] };
  }
  return undefined; // an interactive or embedded Python: not a job
}

// The project a script belongs to: the listed project whose folder holds it,
// or the folder it sits in.
function projectOf(file, projects = []) {
  if (!file || !/[\\/]/.test(file)) return undefined;
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = norm(file);
  const hit = projects.find((p) => [p.path, ...(p.copies ?? []).map((c) => c.path ?? c)].filter(Boolean).some((d) => f.startsWith(`${norm(d)}/`)));
  if (hit) return hit.name;
  return path.posix.basename(path.posix.dirname(file.replace(/\\/g, '/'))) || undefined;
}

// procs: [{ pid, startedAt (ms), cpuMs (user + kernel), cmdline }]
// gpu: Map pid -> MB of GPU memory (or 0 when the driver does not say)
function pickWork(procs, gpu, now, projects) {
  const out = [];
  for (const p of procs) {
    const script = scriptOf(p.cmdline);
    if (!script || !Number.isFinite(p.startedAt)) continue;
    const age = now - p.startedAt;
    const onGpu = gpu.has(p.pid);
    const busy = age >= MIN_AGE_MS && Number.isFinite(p.cpuMs) && p.cpuMs / age >= BUSY_CORES;
    if (!onGpu && !busy) continue;
    out.push({
      name: script.name,
      project: projectOf(script.file, projects),
      on: onGpu ? 'gpu' : 'cpu',
      startedAt: p.startedAt,
      gpuMem: onGpu && gpu.get(p.pid) > 0 ? gpu.get(p.pid) : undefined,
      pid: p.pid,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt).slice(0, LIMIT);
}

// ---- reading the process list --------------------------------------------------

const PS = "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Select-Object ProcessId,CreationDate,CommandLine,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";

function parseWindows(json) {
  if (!String(json).trim()) return [];
  const data = JSON.parse(json);
  return (Array.isArray(data) ? data : [data]).map((p) => {
    const ms = /\/Date\((\d+)\)\//.exec(String(p.CreationDate))?.[1] ?? Date.parse(p.CreationDate?.DateTime ?? p.CreationDate);
    return { pid: p.ProcessId, startedAt: Number(ms), cpuMs: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 10_000, cmdline: p.CommandLine };
  });
}

function parseGpuApps(csv) {
  const map = new Map();
  for (const line of String(csv).split('\n')) {
    const [pid, mem] = line.split(',').map((s) => s.trim());
    if (/^\d+$/.test(pid)) map.set(Number(pid), Number(mem) || 0);
  }
  return map;
}

function readLinux(fsys = require('fs'), now = Date.now()) {
  const hz = 100;
  const uptime = Number(fsys.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const bootMs = now - uptime * 1000;
  const procs = [];
  for (const d of fsys.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fsys.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!/python/i.test(path.posix.basename(cmd[0] ?? ''))) continue;
      const stat = fsys.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.push({ pid: Number(d), startedAt: bootMs + (Number(f[19]) / hz) * 1000, cpuMs: ((Number(f[11]) + Number(f[12])) / hz) * 1000, cmdline: cmd.join(' ') });
    } catch {
      // The process ended while we looked: nothing to report.
    }
  }
  return procs;
}

const GPU_ARGS = ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'];
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

// Synchronous, for the status post. Errors come back as `problem`.
function detectWorkSync({ platform = process.platform, now = Date.now(), projects = [] } = {}) {
  let gpu = new Map();
  try {
    gpu = parseGpuApps(run('nvidia-smi', GPU_ARGS));
  } catch {
    // No NVIDIA GPU or driver: CPU work is still found.
  }
  try {
    const procs = platform === 'win32' ? parseWindows(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS])) : readLinux();
    return { work: pickWork(procs, gpu, now, projects) };
  } catch (err) {
    return { work: [], problem: `Running work could not be listed (${err.code || err.message})` };
  }
}

// Asynchronous, for the app (never blocks the window).
function detectWork({ platform = process.platform, projects = [] } = {}, done) {
  const now = Date.now();
  execFile('nvidia-smi', GPU_ARGS, { timeout: 15_000, windowsHide: true }, (gErr, gOut) => {
    const gpu = gErr ? new Map() : parseGpuApps(gOut); // no GPU: CPU work is still found
    const finish = (err, procs) => {
      if (err) done({ work: [], problem: `Running work could not be listed (${err.code || err.message})` });
      else done({ work: pickWork(procs, gpu, Date.now() || now, projects) });
    };
    if (platform !== 'win32') {
      try {
        finish(null, readLinux());
      } catch (err) {
        finish(err);
      }
      return;
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { timeout: 20_000, windowsHide: true }, (err, out) => {
      if (err) return finish(err);
      try {
        return finish(null, parseWindows(out));
      } catch (e) {
        return finish(e);
      }
    });
  });
}

module.exports = { detectWork, detectWorkSync, pickWork, scriptOf, projectOf, parseWindows, parseGpuApps, MIN_AGE_MS };
