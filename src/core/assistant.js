'use strict';

// What the personal assistant's quick scan left for the user: its open
// questions and when it last looked. The scan (~/.claude/assistant/scan.py,
// run by Windows Task Scheduler every 15 minutes on weekdays) writes these
// files; the app only reads them. A question tied to a project is also a
// to-do on that project ("Assistant asks: ..."), and ticking it here closes
// the question; the others are answered by telling the assistant in Claude.
//
//   <dir>/questions.json  { questions: [{ key, text, project, status, askedAt }] }
//   <dir>/state.json      { lastRun, failures, ... }

const fs = require('fs');
const os = require('os');
const path = require('path');

const SHOWN = 20;

function assistantDir(env = process.env, home = os.homedir()) {
  return env.AGENTS_HOME_ASSISTANT || path.join(home, '.agents-home', 'assistant');
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function readJson(file, fsys) {
  let text;
  try {
    text = fsys.readFileSync(file, 'utf8');
  } catch (err) {
    // No file is normal: the scan is not set up, or has asked nothing yet.
    if (err.code === 'ENOENT') return { missing: true };
    return { problem: `could not be read (${err.code || 'error'})` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { problem: 'are not valid JSON' };
  }
}

// { on, lastRun, failures, lastError, notes, questions: [{ key, text, project }], more, problems }
// `on` is false until the scan has run once, and then nothing is shown.
// `notes` are what the scan could not do and still went on: pop-ups that
// failed (so questions only show here) and folders git could not read.
function loadAssistant(dir, fsys = fs) {
  const q = readJson(path.join(dir, 'questions.json'), fsys);
  const s = readJson(path.join(dir, 'state.json'), fsys);
  const problems = [];
  if (q.problem) problems.push(`its questions ${q.problem}`);
  if (s.problem) problems.push(`its state files ${s.problem}`);
  const state = s.value && typeof s.value === 'object' ? s.value : {};
  const open = (Array.isArray(q.value?.questions) ? q.value.questions : [])
    .filter((x) => x && typeof x === 'object' && x.status === 'open' && str(x.text, 300))
    .map((x) => ({ key: str(x.key, 200), text: str(x.text, 300), project: str(x.project, 80) || undefined }));
  const notes = [];
  if (str(state.popupError, 200)) notes.push('Pop-ups are not working, so its questions only show here.');
  const unreadable = (Array.isArray(state.unreadable) ? state.unreadable : []).map((n) => str(n, 120)).filter(Boolean);
  if (unreadable.length) notes.push(`Git could not read a folder in ${unreadable.join(', ')}. New work there is logged once it can.`);
  const failures = Number.isInteger(state.failures) && state.failures > 0 ? state.failures : 0;
  return {
    on: !s.missing,
    lastRun: str(state.lastRun, 40) || undefined,
    failures,
    lastError: failures ? str(state.lastError, 200) || undefined : undefined,
    notes,
    questions: open.slice(0, SHOWN),
    more: Math.max(0, open.length - SHOWN),
    problems,
  };
}

module.exports = { assistantDir, loadAssistant };
