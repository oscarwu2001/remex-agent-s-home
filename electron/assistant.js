'use strict';

// Assistant mode in the main process: the user's API key (encrypted with
// the operating system's own protection, never shown back in full, never
// written in plain text), running tasks through the built-in team, and the
// part of each snapshot that shows them. Nothing here runs, and nothing
// goes online, until the user saves a key and sends a task.
//
// Answers are kept in memory only, for this run of the app: a task may
// hold text the user would not want on disk.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, safeStorage, net } = require('electron');
const Anthropic = require('@anthropic-ai/sdk');
const { runTask, continueTask, toSession } = require('../src/assistant/pipeline');
const { LEVELS, WORK_MODEL, PRICES, SPECIALISTS, SKILLS, CHECKER } = require('../src/assistant/team');
const { roomFor } = require('../src/core/rooms');
const { findIdentifiers } = require('../src/assistant/phi');

const SDK = Anthropic.default ?? Anthropic;
const KEEP_JOBS = 30;
const MAX_TASK_CHARS = 60_000;

function setupAssistant({ problem }) {
  const keyFile = path.join(app.getPath('userData'), 'assistant-key.bin');
  let key; // decrypted, in memory only
  const jobs = []; // newest last
  const controllers = new Map(); // job id -> AbortController
  let nextId = 1;

  function loadKey() {
    let blob;
    try {
      blob = fs.readFileSync(keyFile);
    } catch (err) {
      // No key yet is the normal case until the user adds one.
      if (err.code !== 'ENOENT') problem(`The saved API key could not be read (${err.code})`, keyFile);
      return;
    }
    try {
      key = safeStorage.decryptString(blob);
    } catch (err) {
      problem('The saved API key could not be decrypted (was it saved by another Windows user?); add it again in Settings → Assistant', err.message);
    }
  }

  // Requests go through Electron's own network stack, so the system proxy
  // settings apply as they do for the browser.
  const client = () => new SDK({ apiKey: key, fetch: (url, init) => net.fetch(url, init), maxRetries: 2 });

  const hint = () => (key ? `…${key.slice(-4)}` : '');

  ipcMain.handle('assistant:status', () => ({
    hasKey: Boolean(key),
    keyHint: hint(),
    canStoreKey: safeStorage.isEncryptionAvailable(),
    levels: Object.fromEntries(Object.entries(LEVELS).map(([id, l]) => [id, { name: l.name, blurb: l.blurb }])),
    prices: PRICES,
    // The built-in team, as staff standing in their rooms.
    team: [...SPECIALISTS, CHECKER, ...SKILLS.filter((k) => k.conversational).map((k) => ({ id: k.agent, name: k.agent === 'coach' ? 'Coach' : 'Teacher' }))]
      .map((a) => ({ name: a.id, title: a.name, room: roomFor(a.id) })),
    skills: SKILLS.map(({ id, name, blurb, placeholder, conversational }) => ({ id, name, blurb, placeholder, conversational: Boolean(conversational) })),
  }));

  ipcMain.handle('assistant:set-key', async (_event, candidate) => {
    const k = String(candidate ?? '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) {
      return { ok: false, error: 'That does not look like an Anthropic API key. Keys start with "sk-ant-". Create one at console.anthropic.com → API keys.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'This computer offers no secure place to keep the key, so it was not saved.' };
    }
    // Check the key with a free call before keeping it.
    try {
      await new SDK({ apiKey: k, fetch: (url, init) => net.fetch(url, init), maxRetries: 1 }).models.retrieve(WORK_MODEL);
    } catch (err) {
      if (err instanceof SDK.APIError && err.status === 401) return { ok: false, error: 'Anthropic did not accept this key. Check that it was copied in full.' };
      if (err instanceof SDK.APIError && err.status === 404) return { ok: false, error: `This key cannot use ${WORK_MODEL}. Check your Anthropic account.` };
      if (err instanceof SDK.APIConnectionError) return { ok: false, error: 'Could not reach Anthropic to check the key. Check the internet connection and try again.' };
      return { ok: false, error: `The key could not be checked: ${err.message}` };
    }
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, safeStorage.encryptString(k));
    } catch (err) {
      return { ok: false, error: `The key could not be saved (${err.code || err.message})` };
    }
    key = k;
    return { ok: true, keyHint: hint() };
  });

  ipcMain.handle('assistant:clear-key', () => {
    try {
      fs.rmSync(keyFile, { force: true });
    } catch (err) {
      return { ok: false, error: `The saved key could not be removed (${err.code || err.message})` };
    }
    key = undefined;
    return { ok: true };
  });

  // Checks run here too, not only in the page: nothing that looks like a
  // patient identifier leaves unless the user has seen it and confirmed.
  ipcMain.handle('assistant:check', (_event, text) => ({ findings: findIdentifiers(String(text ?? '').slice(0, MAX_TASK_CHARS)) }));

  ipcMain.handle('assistant:run', (_event, { text, level, skill, confirmed } = {}) => {
    if (!key) return { ok: false, error: 'Add your Anthropic API key in Settings → Assistant first.' };
    const task = String(text ?? '').trim();
    if (!task) return { ok: false, error: 'Type a task first.' };
    if (task.length > MAX_TASK_CHARS) return { ok: false, error: `That is too long for one task (${task.length.toLocaleString()} characters; the limit is ${MAX_TASK_CHARS.toLocaleString()}). Split it into parts.` };
    const findings = findIdentifiers(task);
    if (findings.length && confirmed !== true) return { ok: false, needsConfirm: true, findings };
    const id = String(nextId++);
    const controller = new AbortController();
    controllers.set(id, controller);
    const job = { id, status: 'triage', text: task, level, startedAt: Date.now(), steps: [], tokens: { total: 0 }, answer: '' };
    jobs.push(job);
    while (jobs.length > KEEP_JOBS) jobs.shift();
    runTask({ id, text: task, level, skill: skill || undefined }, {
      client: client(),
      sdk: SDK,
      signal: controller.signal,
      onUpdate: (j) => {
        const i = jobs.findIndex((x) => x.id === id);
        if (i !== -1) jobs[i] = j;
      },
    }).finally(() => controllers.delete(id));
    return { ok: true, id };
  });

  ipcMain.handle('assistant:reply', (_event, { id, text, confirmed } = {}) => {
    const job = jobs.find((j) => j.id === String(id));
    if (!key) return { ok: false, error: 'Add your Anthropic API key in Settings → Assistant first.' };
    if (!job || !job.turns || controllers.has(job.id)) return { ok: false, error: 'That task is still busy or no longer here.' };
    const reply = String(text ?? '').trim();
    if (!reply) return { ok: false, error: 'Type a reply first.' };
    if (reply.length > MAX_TASK_CHARS) return { ok: false, error: 'That reply is too long; split it into parts.' };
    const findings = findIdentifiers(reply);
    if (findings.length && confirmed !== true) return { ok: false, needsConfirm: true, findings };
    const controller = new AbortController();
    controllers.set(job.id, controller);
    continueTask(job, reply, { client: client(), sdk: SDK, signal: controller.signal }).finally(() => controllers.delete(job.id));
    return { ok: true };
  });

  ipcMain.handle('assistant:stop', (_event, id) => {
    controllers.get(String(id))?.abort();
    return { ok: true };
  });

  ipcMain.handle('assistant:forget', (_event, id) => {
    const i = jobs.findIndex((x) => x.id === String(id));
    if (i !== -1 && !controllers.has(String(id))) jobs.splice(i, 1);
    return { ok: true };
  });

  loadKey();

  // For each snapshot: the tasks for the board, and as sessions for the scene.
  return function assistantSnapshot(now = Date.now()) {
    return {
      jobs: jobs.map((j) => ({
        id: j.id, title: j.title, text: j.text, level: j.level, skill: j.skill, status: j.status, specialist: j.specialist, turns: j.turns,
        answer: j.answer, note: j.note, error: j.error, checkerChanged: j.checkerChanged,
        startedAt: j.startedAt, endedAt: j.endedAt, tokens: j.tokens, cost: j.cost,
      })),
      sessions: jobs.filter((j) => j.steps && (!j.endedAt || now - j.endedAt < 10 * 60_000)).map((j) => toSession(j, now)),
    };
  };
}

module.exports = { setupAssistant };
