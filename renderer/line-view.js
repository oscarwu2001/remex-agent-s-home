// LINE chats: what in the user's LINE group chats concerns them, from the
// exports the main process reads (src/core/linechat.js). The board shows a
// headline and the items; each can be added to a project as a to-do,
// dismissed (with Undo), or sent to an agent (a sheet over the board where
// the user edits the prompt, picks the folder and where Claude runs, and
// presses Start Claude). Settings picks the folder, the chats to read and
// the user's names and keywords.
//
// Chat names are often people's names, so with privacy mode on (the
// default) only counts, times and the reason for each item show: no chat
// name, sender, message, folder, or the user's names and keywords.
//
// Items are named by their key (the chat and the message), in ids too:
// one message can be in two chats.

import { boardTime } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PRIVACY_SWITCH = '“Hide file names, commands and survey answers”';
const LIMIT = 5; // items shown before "Show N more"
// A message longer than this is cut at six lines on the board, with its own Show all.
const LONG = 280;
const svg = (paths, cls = '') => `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

// Why an item is listed: a glyph of its own and words, never colour alone.
export const REASONS = {
  mention: { words: 'Mentions you', glyph: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>' },
  keyword: { words: 'Matches a keyword', glyph: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.3"/>' },
  commitment: { words: 'You said you would', glyph: '<path d="M4 5.5h16v10h-9.5L6 19v-3.5H4z"/><path d="M8.5 10.5l2.3 2.3 4.7-4.6"/>' },
};
export function reasonHtml(it, { privacy = true } = {}) {
  const r = REASONS[it.reason] ?? REASONS.keyword;
  const words = it.reason === 'keyword' && !privacy && it.matched ? `${r.words}: ${it.matched}` : r.words;
  return `<span class="line-reason line-${esc(it.reason)}">${svg(r.glyph, 'line-glyph')}<span>${esc(words)}</span></span>`;
}

const ICONS = {
  add: '<path d="M12 5v14M5 12h14"/>',
  dismiss: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M4 11.5L20 4l-6.5 16-2.6-6.4z"/><path d="M10.9 13.6L20 4"/>',
};
const settingsBtn = '<div class="form-actions"><button type="button" class="link-btn" data-line="settings" data-key="line-settings">Open Settings</button></div>';
// The folder's error, as what to do next (the code shows nowhere on the board).
const FOLDER_WORDS = {
  ENOENT: 'The exports folder is missing. Choose it again in Settings.',
  ENOTDIR: 'The exports folder is missing. Choose it again in Settings.',
};
const folderWords = (code) => FOLDER_WORDS[code] ?? 'The exports folder can’t be read. Check that it still exists and that you can open it in Explorer.';

function addForm(it, projects, ui, now) {
  const id = esc(it.key);
  if (!projects.length) {
    return `<div class="line-add"><p class="hint">No projects yet: add one under Projects first.</p>
      <button type="button" class="link-btn small" data-line="cancel-add" data-item="${id}" data-key="line-cancel-${id}">Cancel</button></div>`;
  }
  const src = it.draft?.source ?? { chat: it.chat, sender: it.sender };
  const bad = ui.error && ui.errorKey === it.key;
  return `<form class="line-add" data-item="${id}">
      <label class="field" for="line-todo-${id}">To-do
        <input id="line-todo-${id}" maxlength="300" autocomplete="off" value="${esc(it.draft?.text ?? '')}"${bad ? ` aria-invalid="true" aria-describedby="line-todo-err-${id}"` : ''}></label>
      ${bad ? `<p class="form-error" id="line-todo-err-${id}">${esc(ui.error)}</p>` : ''}
      <p class="hint line-source">From ${esc(src.chat)} · ${esc(src.sender)} · ${esc(boardTime(it.ms, now))}</p>
      <label class="field" for="line-project-${id}">Project
        <select id="line-project-${id}">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="form-actions"><button type="submit" class="button" id="line-add-go-${id}">Add</button>
        <button type="button" class="link-btn" data-line="cancel-add" data-item="${id}" data-key="line-cancel-${id}">Cancel</button></div>
    </form>`;
}

function itemHtml(it, { privacy, now, ui, projects }) {
  const when = `<span class="line-when">${esc(boardTime(it.ms, now))}</span>`;
  const meta = `<p class="line-meta">${reasonHtml(it, { privacy })}${when}</p>`;
  if (privacy) return `<li class="line-item">${meta}</li>`;
  const id = esc(it.key);
  const adding = ui.adding === it.key;
  const open = ui.expanded?.has?.(it.key);
  // The add form shows its own error at the field; any other sits under the buttons.
  const error = ui.error && ui.errorKey === it.key && !adding ? `<p class="form-error">${esc(ui.error)}</p>` : '';
  const btn = (act, words, extra = '', cls = '') => `<button type="button" class="link-btn small line-act${cls}" data-line="${act}" data-item="${id}" data-key="line-${act}-${id}"${extra}>${svg(ICONS[act])}<span>${words}</span></button>`;
  const more = String(it.text ?? '').length > LONG
    ? `<button type="button" class="link-btn inline line-more" data-line="expand" data-item="${id}" data-key="line-expand-${id}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Show less' : 'Show all'}</button>` : '';
  return `<li class="line-item">
    ${meta}
    <p class="line-from"><span class="line-chat">${esc(it.chat)}</span><span aria-hidden="true"> · </span><span class="line-sender">${esc(it.sender)}</span></p>
    <p class="line-text${open ? ' open' : ''}">${esc(it.text)}</p>${more}
    <div class="line-actions">${btn('add', 'Add to project', ` aria-expanded="${adding}"`)}${btn('send', 'Send to agent', ' aria-haspopup="dialog"')}${btn('dismiss', 'Dismiss', '', ' line-dismiss')}</div>
    ${error}${adding ? addForm(it, projects, ui, now) : ''}
  </li>`;
}

// The board section's body. ui: { adding: key, expanded: Set of keys, all:
// show every item, error, errorKey }; projects: the shared project list.
// What the last button did goes to the section's one status line (statusHtml).
export function lineHtml(l, { privacy = true, now = Date.now(), ui = {}, projects = [] } = {}) {
  if (!l?.enabled) return '';
  if (!l.demo && !l.folder) return `<p class="empty">Not set up yet. Choose the folder you save LINE chats into.</p>${settingsBtn}`;
  if (l.folderError) return `<p class="form-error">${esc(folderWords(l.folderError))}</p>${settingsBtn}`;
  if (l.scanFailed) return '<p class="form-error">The chats could not be read just now. See Needs attention.</p>';
  if (!l.readCount) {
    if (l.tickedFailed) return '<p class="form-error">The ticked chats could not be read. See Needs attention.</p>';
    const words = l.chats?.length ? `${plural(l.chats.length, 'chat')} found. Tick the chats to read in Settings.`
      : 'No chats in the folder yet. In LINE, open a chat, then ≡ → Save chat, and save it there.';
    return `<p class="empty">${words}</p>${settingsBtn}`;
  }
  if (!l.names?.length && !l.keywords?.length) {
    return `<p class="empty">Add your names in LINE, or a few keywords, in Settings, so the app can find what is for you.</p>${settingsBtn}`;
  }
  const items = l.items ?? [];
  if (!items.length) return `<p class="line-head">Nothing for you in the last ${l.windowDays ?? 14} days · ${plural(l.readCount, 'chat')} read</p>`;
  const from = new Set(items.map((i) => i.chat)).size;
  const head = `<p class="line-head">${plural(items.length, 'item')} for you · from ${plural(from, 'chat')} · newest ${esc(boardTime(items[0].ms, now))}</p>`;
  const shown = ui.all ? items : items.slice(0, LIMIT);
  const list = `<ul class="line-items">${shown.map((it) => itemHtml(it, { privacy, now, ui, projects })).join('')}</ul>`;
  const more = items.length > LIMIT
    ? `<div class="form-actions"><button type="button" class="link-btn" data-line="${ui.all ? 'fewer' : 'more'}" data-key="line-more">${ui.all ? 'Show fewer' : `Show ${items.length - LIMIT} more`}</button></div>` : '';
  const hidden = privacy
    ? `<p class="hint">Turn off ${PRIVACY_SWITCH} to see the chats, senders and messages and to act on them. <button type="button" class="link-btn inline" data-line="privacy" data-key="line-privacy">Privacy settings</button></p>` : '';
  return `${head}${list}${more}${hidden}`;
}

// The section's one status line: what the last button did, with Undo after
// a dismissal. status: { text, undo: the dismissed item's key } or null.
export function statusHtml(status) {
  if (!status?.text) return '';
  const undo = status.undo
    ? ` <button type="button" class="link-btn inline" data-line="undo" data-item="${esc(status.undo)}" data-key="line-undo">Undo</button>` : '';
  return `${esc(status.text)}${undo}`;
}

// Settings → Connections → LINE chats, under its switch.
export function lineSettingsHtml(l, { privacy = true, online = true, now = Date.now(), state = {} } = {}) {
  // The demo shows its sample chats as Settings would, saving nothing.
  const sample = l?.demo ? '<p class="hint">The demo shows made-up LINE chats; nothing here is saved. Turn off “Demo patients” to set up your own folder.</p>' : '';
  if (!l?.demo && !online) return '<p class="hint">The desktop app reads the folder; this preview cannot.</p>';
  if (!l?.enabled) return '';
  const err = state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : '';
  const folder = l.folder
    ? `<p class="field-set"><span>${privacy ? 'A folder is chosen.' : `Folder: <span class="field-path">${esc(l.folder)}</span>`}</span>
        <button type="button" class="link-btn" data-line="choose-folder" id="line-folder">Choose another…</button></p>`
    : '<div class="form-actions"><button type="button" class="button" data-line="choose-folder" id="line-folder">Choose folder…</button></div>';
  const how = '<p class="hint">In LINE: open the chat, then ≡ → Save chat, and save the file in this folder. Save it again to bring it up to date.</p>';
  if (!l.folder) return `${sample}${folder}${how}${err}`;
  const chats = l.chats ?? [];
  let list;
  let words;
  if (privacy) {
    // One line for what privacy mode hides here.
    const found = chats.length ? `${plural(chats.length, 'chat')} found, ${l.readCount} read; ` : '';
    list = `<p class="hint">${found}${plural(l.names?.length ?? 0, 'name')} and ${plural(l.keywords?.length ?? 0, 'keyword')} saved. Turn off ${PRIVACY_SWITCH} to choose chats or change them. <button type="button" class="link-btn inline" data-line="privacy">Privacy settings</button></p>`;
    words = '';
  } else {
    list = !chats.length ? `<p class="hint">${l.folderError ? esc(folderWords(l.folderError)) : 'No chats in the folder yet.'}</p>`
      : `<fieldset class="line-chats"><legend>Chats in the folder (only ticked chats are read)</legend><ul>${chats.map((c, i) => `<li class="line-chat-row">
        <span class="line-chat-name">${esc(c.chat)}</span>
        <span class="line-chat-what">${plural(c.files, 'export')}${c.read && c.messages != null ? ` · ${plural(c.messages, 'message')}` : ''}${c.problems ? ` · ${plural(c.problems, 'problem')}, see Needs attention` : ''}</span>
        <label class="check" for="line-read-${i}"><input type="checkbox" id="line-read-${i}" data-chat="${esc(c.chat)}"${c.read ? ' checked' : ''}> Read “${esc(c.chat)}”</label>
      </li>`).join('')}</ul></fieldset>`;
    words = `<form class="line-words" id="line-words-form">
        <label class="field" for="line-names">Your names in LINE (comma-separated, up to 10)
          <input id="line-names" autocomplete="off" spellcheck="false" value="${esc((l.names ?? []).join(', '))}"></label>
        <label class="field" for="line-keywords">Keywords (comma-separated, up to 30)
          <input id="line-keywords" autocomplete="off" spellcheck="false" value="${esc((l.keywords ?? []).join(', '))}"></label>
        <div class="form-actions"><button type="submit" class="button" id="line-words-save">Save</button></div>
      </form>`;
  }
  const status = [l.scannedAt ? `Read ${boardTime(l.scannedAt, now)}` : 'Not read yet', `items from the last ${l.windowDays ?? 14} days`, state.note].filter(Boolean).join(' · ');
  return `${sample}${folder}${how}${err}${list}${words}<p class="hint" role="status">${esc(status)}</p>`;
}

// The closed Connections group's words for LINE: on or off, and counts only.
export function lineSummary(l) {
  if (!l?.enabled) return 'LINE off';
  if (!l.demo && !l.folder) return 'LINE on · no folder yet';
  return `LINE on · ${plural(l.readCount ?? 0, 'chat')} read`;
}

// The folders Claude can start in: each project's folder and copies, then
// those the user browsed to. [{ label, path }]
export function folderChoices(projects = [], browsed = []) {
  const out = [];
  const seen = new Set();
  const add = (label, p) => {
    if (!p || seen.has(p.toLowerCase())) return;
    seen.add(p.toLowerCase());
    out.push({ label, path: p });
  };
  for (const p of projects) {
    add(p.name, p.path);
    for (const c of p.copies ?? []) add(`${p.name} (copy)`, c.path);
  }
  for (const b of browsed) add('Chosen folder', b);
  return out;
}

// One draft per item: the sheet for an item opens with what was last
// typed in it, else its prompt draft. drafts: Map key -> send.
export function sendDraft(drafts, item) {
  return drafts.get(item.key) ?? { key: item.key, prompt: item.prompt ?? '', cwd: '', session: '', target: null, browsed: [] };
}
// What the user typed or chose on the sheet, taken into its draft only
// when the form on screen is that item's (form.key): a sheet just opened
// for another item never takes the last one's fields.
export function takeEdits(send, form) {
  if (!form || form.key !== send.key) return send;
  return { ...send, prompt: form.prompt, cwd: form.cwd, session: form.session ?? send.session, target: form.target ?? send.target };
}
// The sheet's one status line (outside its body, so it is never redrawn).
export function sendStatus(send) {
  if (send?.busy) return { text: 'Starting…', ok: true };
  return send?.status ? { text: send.status.text, ok: send.status.ok } : { text: '', ok: true };
}

const TERMINAL = svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>');
// The Send to agent sheet's body. send: { key, prompt, cwd, session,
// target, errors: { cwd, prompt }, busy }; targets: { sessions, why } once
// asked, else null. Where it runs is the user's choice: tmux when a session
// runs (and first), else Windows Terminal, with tmux shown unavailable and why.
export function lineSheetHtml(send, { folders = [], targets = null } = {}) {
  const opts = folders.map((f) => `<option value="${esc(f.path)}"${f.path === send.cwd ? ' selected' : ''}>${esc(f.label)} — ${esc(f.path)}</option>`).join('');
  const errors = send.errors ?? {};
  const invalid = (what) => (errors[what] ? ` aria-invalid="true" aria-describedby="line-${what}-err"` : '');
  const fieldError = (what) => (errors[what] ? `<p class="field-error" id="line-${what}-err">${esc(errors[what])}</p>` : '');
  let where;
  if (!targets) where = '<p class="hint">Looking for tmux sessions in WSL…</p>';
  else {
    const tmuxOk = Boolean(targets.sessions?.length);
    const target = send.target === 'wt' || !tmuxOk ? 'wt' : 'tmux';
    const session = tmuxOk && target === 'tmux'
      ? `<label class="field line-session" for="line-session">tmux session
          <select id="line-session">${targets.sessions.map((s) => `<option value="${esc(s)}"${s === send.session ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : '';
    where = `<label class="check" for="line-target-tmux"><input type="radio" name="line-target" value="tmux" id="line-target-tmux"${tmuxOk ? '' : ' disabled aria-describedby="line-tmux-why"'}${target === 'tmux' ? ' checked' : ''}> ${TERMINAL}New tmux window in WSL</label>
      ${tmuxOk ? '' : `<p class="hint" id="line-tmux-why">${esc(targets.why || 'No tmux session is running in WSL.')}</p>`}${session}
      <label class="check" for="line-target-wt"><input type="radio" name="line-target" value="wt" id="line-target-wt"${target === 'wt' ? ' checked' : ''}> ${TERMINAL}New Windows Terminal tab</label>`;
  }
  return `<form class="line-send" id="line-send-form" data-key="${esc(send.key)}">
      <label class="field" for="line-prompt">Prompt (edit it as you like)
        <textarea id="line-prompt" rows="12" maxlength="20000" spellcheck="false"${invalid('prompt')}>${esc(send.prompt)}</textarea></label>
      ${fieldError('prompt')}
      <p class="hint">Claude starts in its ask-first mode: it asks before it edits a file or runs a command.</p>
      <div class="line-folder-row">
        <label class="field" for="line-cwd">Folder
          <select id="line-cwd"${invalid('cwd')}><option value=""${send.cwd ? '' : ' selected'}>Choose a folder…</option>${opts}</select></label>
        ${fieldError('cwd')}
        <button type="button" class="link-btn" data-line="browse" id="line-browse">Browse…</button>
      </div>
      <fieldset class="field line-run"><legend>Where it runs</legend>${where}</fieldset>
      <div class="form-actions"><button type="submit" class="button" id="line-start"${!targets || send.busy ? ' disabled' : ''}>${send.busy ? 'Starting…' : 'Start Claude'}</button></div>
    </form>`;
}
