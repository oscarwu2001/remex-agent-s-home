// Long jobs (training, evaluation) and the machine line, as both windows
// draw them under a computer in "Running now". Each job: its state as a mark
// with its own shape and a word, a progress bar, and one quiet line of
// numbers (epoch, step, ETA, the latest metrics).

import { icon } from './overview.js';
import { tr } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Each state's mark, and its word (job.<state> in the word tables) in the
// window's language.
const MARKS = {
  running: '<path d="M9 7.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  done: '<path d="M6.5 12.5l3.5 3.5 7.5-8"/>',
  failed: '<path d="M8 8l8 8M16 8l-8 8"/>',
  stopped: '<rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  stalled: '<path d="M12 7.5v5M12 15.8v.2"/>',
};
export const JOB_STATES = Object.fromEntries(Object.entries(MARKS).map(([state, mark]) => [state, { mark, get word() { return tr(`job.${state}`); } }]));

export function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return tr('time.min', { n: m });
  const h = Math.floor(m / 60);
  return h < 48 ? tr('time.hm', { h, mm: String(m % 60).padStart(2, '0') }) : tr('time.d', { n: Math.round(h / 24) });
}

const short = (v) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v)) : String(Number(v.toPrecision(3))));

export function jobLine(j) {
  const parts = [];
  if (j.epoch != null) parts.push(j.epochs ? tr('job.epochOf', { n: j.epoch, of: j.epochs }) : tr('job.epoch', { n: j.epoch }));
  if (j.step != null) parts.push(j.total ? tr('job.stepOf', { n: j.step.toLocaleString(), of: j.total.toLocaleString() }) : tr('job.step', { n: j.step.toLocaleString() }));
  if (j.note) parts.push(j.note);
  if (j.state === 'running' && j.eta) parts.push(tr('job.left', { time: duration(j.eta) }));
  return parts.join(' · ');
}

export function jobsHtml(jobs = [], now = Date.now()) {
  if (!jobs.length) return '';
  return `<ul class="jobs">${jobs.map((j) => {
    const st = JOB_STATES[j.state] ?? JOB_STATES.running;
    const word = st.word;
    const pct = j.total ? Math.max(0, Math.min(100, Math.round((100 * (j.step ?? 0)) / j.total))) : undefined;
    const metrics = Object.entries(j.metrics ?? {}).map(([k, v]) => `<span class="metric"><span class="k">${esc(k)}</span> ${esc(short(v))}</span>`).join('');
    const when = j.state === 'running' ? tr('job.updated', { time: duration(now - j.updatedAt) }) : tr('job.endedAgo', { state: word.toLowerCase(), time: duration(now - j.updatedAt) });
    const name = j.project ? tr('common.withProject', { name: j.name, project: j.project }) : j.name;
    return `<li class="job ${esc(j.state)}" title="${esc(tr('job.tip', { name, state: word, when }))}">
      <span class="job-mark" aria-hidden="true"><svg viewBox="0 0 24 24">${st.mark}</svg></span>
      <div class="job-body">
        <p class="job-top"><span class="job-name">${esc(j.name)}</span>${j.project ? `<span class="job-proj">${esc(j.project)}</span>` : ''}<span class="job-pct">${pct != null ? `${pct}%` : esc(word)}</span></p>
        ${pct != null ? `<div class="job-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(j.name)}"><span style="width:${pct}%"></span></div>` : ''}
        <p class="job-line"><span class="visually-hidden">${esc(word)}. </span>${esc(jobLine(j))}${metrics ? `<span class="metrics">${metrics}</span>` : ''}</p>
      </div></li>`;
  }).join('')}</ul>`;
}

// "GPU RTX 2000 Ada 97% · 12/16 GB" and "CPU 34%", as small chips.
export function machineHtml(m) {
  if (!m) return '';
  const chips = [
    ...(m.gpus ?? []).map((g) => `<span class="load${g.util >= 80 ? ' busy' : ''}" title="${esc(`${tr('machine.gpuTip', { name: g.name, util: g.util ?? '?' })}${g.memTotal ? tr('machine.gpuMem', { used: (g.memUsed / 1024).toFixed(1), total: (g.memTotal / 1024).toFixed(0) }) : ''}${g.temp != null ? `, ${g.temp} °C` : ''}`)}">${icon('chip')}GPU ${g.util ?? '?'}%${g.memTotal ? ` · ${(g.memUsed / 1024).toFixed(1)}/${(g.memTotal / 1024).toFixed(0)} GB` : ''}</span>`),
    m.cpu != null ? `<span class="load${m.cpu >= 80 ? ' busy' : ''}" title="${esc(`${tr('machine.cpuTip', { n: m.cpu })}${m.memTotal ? tr('machine.cpuMem', { used: (m.memUsed / 1024).toFixed(1), total: (m.memTotal / 1024).toFixed(0) }) : ''}`)}">CPU ${m.cpu}%</span>` : '',
  ].filter(Boolean).join('');
  return chips ? `<p class="machine">${chips}</p>` : '';
}

// Work found running without the helper: just what it is and for how long.
export function workHtml(work = [], now = Date.now()) {
  if (!work.length) return '';
  return `<ul class="jobs work">${work.map((w) => {
    const ran = tr('work.ran', { time: duration(now - w.startedAt) });
    const where = w.on === 'gpu' ? `GPU${w.gpuMem ? ` · ${(w.gpuMem / 1024).toFixed(1)} GB` : ''}` : 'CPU';
    return `<li class="job running" title="${esc(tr('work.tip', { name: w.project ? tr('common.withProject', { name: w.name, project: w.project }) : w.name, ran, where }))}">
      <span class="job-mark" aria-hidden="true"><svg viewBox="0 0 24 24">${JOB_STATES.running.mark}</svg></span>
      <div class="job-body">
        <p class="job-top"><span class="job-name">${esc(w.name)}</span>${w.project ? `<span class="job-proj">${esc(w.project)}</span>` : ''}<span class="job-pct">${esc(duration(now - w.startedAt))}</span></p>
        <p class="job-line">${esc(ran)} · ${esc(where)}</p>
      </div></li>`;
  }).join('')}</ul>`;
}
