// LINE chats: what in the user's LINE group chats concerns them, from the
// exports the main process reads (src/core/linechat.js). The board shows a
// headline and the items; each can be added to a project as a to-do,
// dismissed, or sent to an agent (a sheet over the board where the user
// edits the prompt, picks the folder and presses Start Claude). Settings
// picks the folder, the chats to read and the user's names and keywords.
//
// Chat names are often people's names, so with privacy mode on (the
// default) only counts, times and the reason for each item show: no chat
// name, sender, message, folder, or the user's names and keywords.

import { boardTime } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PRIVACY_SWITCH = '“Hide file names, commands and survey answers”';
const LIMIT = 5; // items shown before "Show N more"
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

function addForm(it, projects) {
  const id = esc(it.hash);
  if (!projects.length) {
    return `<div class="line-add"><p class="hint">No projects yet: add one under Projects first.</p>
      <button type="button" class="link-btn small" data-line="cancel-add" data-hash="${id}" data-key="line-cancel-${id}">Cancel</button></div>`;
  }
  const src = it.draft?.source ?? { chat: it.chat, sender: it.sender, at: it.at };
  return `<form class="line-add" data-hash="${id}">
      <label class="field" for="line-todo-${id}">To-do
        <input id="line-todo-${id}" maxlength="300" autocomplete="off" value="${esc(it.draft?.text ?? '')}"></label>
      <p class="hint line-source">From ${esc(src.chat)} · ${esc(src.sender)} · ${esc(src.at)}</p>
      <label class="field" for="line-project-${id}">Project
        <select id="line-project-${id}">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="form-actions"><button type="submit" class="button" id="line-add-go-${id}">Add</button>
        <button type="button" class="link-btn" data-line="cancel-add" data-hash="${id}" data-key="line-cancel-${id}">Cancel</button></div>
    </form>`;
}

function itemHtml(it, { privacy, now, ui, projects }) {
  const when = `<span class="line-when">${esc(boardTime(it.ms, now))}</span>`;
  const meta = `<p class="line-meta">${reasonHtml(it, { privacy })}${when}</p>`;
  if (privacy) return `<li class="line-item">${meta}</li>`;
  const id = esc(it.hash);
  const adding = ui.adding === it.hash;
  const error = ui.error && ui.errorHash === it.hash ? `<p class="form-error" role="alert">${esc(ui.error)}</p>` : '';
  const btn = (act, words, extra = '') => `<button type="button" class="link-btn small line-act" data-line="${act}" data-hash="${id}" data-key="line-${act}-${id}"${extra}>${svg(ICONS[act])}<span>${words}</span></button>`;
  return `<li class="line-item">
    ${meta}
    <p class="line-from"><span class="line-chat">${esc(it.chat)}</span><span aria-hidden="true"> · </span><span class="line-sender">${esc(it.sender)}</span></p>
    <p class="line-text">${esc(it.text)}</p>
    <div class="line-actions">${btn('add', 'Add to project', ` aria-expanded="${adding}"`)}${btn('dismiss', 'Dismiss')}${btn('send', 'Send to agent', ' aria-haspopup="dialog"')}</div>
    ${error}${adding ? addForm(it, projects) : ''}
  </li>`;
}

// The board section's body. ui: { adding: hash, all: show every item,
// error, errorHash, note }; projects: the shared project list.
export function lineHtml(l, { privacy = true, now = Date.now(), ui = {}, projects = [] } = {}) {
  if (!l?.enabled) return '';
  if (!l.demo && !l.folder) return `<p class="empty">Not set up yet. Choose the folder you save LINE chats into.</p>${settingsBtn}`;
  if (l.folderError) return `<p class="form-error" role="status">The exports folder could not be read (${esc(l.folderError)}).</p>${settingsBtn}`;
  if (!l.readCount) {
    const words = l.chats?.length ? `${plural(l.chats.length, 'chat')} found. Tick the chats to read in Settings.`
      : 'No chats in the folder yet. In LINE, open a chat, then ≡ → Save chat, and save it there.';
    return `<p class="empty">${words}</p>${settingsBtn}`;
  }
  if (!l.names?.length && !l.keywords?.length) {
    return `<p class="empty">Add your names in LINE, or a few keywords, in Settings, so the app can find what is for you.</p>${settingsBtn}`;
  }
  const items = l.items ?? [];
  const note = ui.note ? `<p class="hint" role="status">${esc(ui.note)}</p>` : '';
  if (!items.length) return `<p class="line-head">Nothing for you in the last ${l.windowDays ?? 14} days · ${plural(l.readCount, 'chat')} read</p>${note}`;
  const from = new Set(items.map((i) => i.chat)).size;
  const head = `<p class="line-head">${plural(items.length, 'item')} for you · from ${plural(from, 'chat')} · newest ${esc(boardTime(items[0].ms, now))}</p>`;
  const shown = ui.all ? items : items.slice(0, LIMIT);
  const list = `<ul class="line-items">${shown.map((it) => itemHtml(it, { privacy, now, ui, projects })).join('')}</ul>`;
  const more = items.length > LIMIT
    ? `<div class="form-actions"><button type="button" class="link-btn" data-line="${ui.all ? 'fewer' : 'more'}" data-key="line-more">${ui.all ? 'Show fewer' : `Show ${items.length - LIMIT} more`}</button></div>` : '';
  const hidden = privacy
    ? `<p class="hint">Turn off ${PRIVACY_SWITCH} to see the chats, senders and messages and to act on them. <button type="button" class="link-btn inline" data-line="privacy" data-key="line-privacy">Privacy settings</button></p>` : '';
  return `${head}${note}${list}${more}${hidden}`;
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
  const how = '<p class="hint">In LINE: open the chat, then ≡ → Save chat, and save the file in this folder. Save it again to bring it up to date; the app never changes or removes it.</p>';
  if (!l.folder) return `${sample}${folder}${how}${err}`;
  const chats = l.chats ?? [];
  const toPrivacy = `<button type="button" class="link-btn inline" data-line="privacy">Privacy settings</button>`;
  let list;
  if (!chats.length) list = `<p class="hint">${l.folderError ? `The folder could not be read (${esc(l.folderError)}).` : 'No chats in the folder yet.'}</p>`;
  else if (privacy) {
    list = `<p class="hint">${plural(chats.length, 'chat')} found, ${l.readCount} read. Turn off ${PRIVACY_SWITCH} to choose which chats to read. ${toPrivacy}</p>`;
  } else {
    list = `<fieldset class="line-chats"><legend>Chats in the folder (only ticked chats are read)</legend><ul>${chats.map((c, i) => `<li class="line-chat-row">
        <span class="line-chat-name">${esc(c.chat)}</span>
        <span class="line-chat-what">${plural(c.files, 'export')}${c.read && c.messages != null ? ` · ${plural(c.messages, 'message')}` : ''}${c.problems ? ` · ${plural(c.problems, 'problem')}, see Needs attention` : ''}</span>
        <label class="check" for="line-read-${i}"><input type="checkbox" id="line-read-${i}" data-chat="${esc(c.chat)}"${c.read ? ' checked' : ''}> Read this chat</label>
      </li>`).join('')}</ul></fieldset>`;
  }
  const words = privacy
    ? `<p class="hint">${plural(l.names?.length ?? 0, 'name')} and ${plural(l.keywords?.length ?? 0, 'keyword')} saved. Turn off ${PRIVACY_SWITCH} to change them.</p>`
    : `<form class="line-words" id="line-words-form">
        <label class="field" for="line-names">Your names in LINE (comma-separated)
          <input id="line-names" autocomplete="off" spellcheck="false" value="${esc((l.names ?? []).join(', '))}"></label>
        <label class="field" for="line-keywords">Keywords (comma-separated)
          <input id="line-keywords" autocomplete="off" spellcheck="false" value="${esc((l.keywords ?? []).join(', '))}"></label>
        <div class="form-actions"><button type="submit" class="button">Save</button></div>
      </form>`;
  const status = [l.scannedAt ? `Read ${boardTime(l.scannedAt, now)}` : 'Not read yet', `items from the last ${l.windowDays ?? 14} days`, state.note].filter(Boolean).join(' · ');
  return `${sample}${folder}${how}${err}${list}${words}<p class="hint" role="status">${esc(status)}</p>`;
}

// The closed Connections group's words for LINE: counts only.
export function lineSummary(l) {
  if (!l?.enabled) return 'LINE off';
  if (!l.demo && !l.folder) return 'LINE on · no folder yet';
  return `LINE: ${plural(l.readCount ?? 0, 'chat')} read · ${plural(l.items?.length ?? 0, 'item')} for you`;
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

// The Send to agent sheet's body. send: { prompt, cwd, session, status:
// { ok, text }, busy }; targets: { sessions, why } once asked, else null.
export function lineSheetHtml(send, { folders = [], targets = null } = {}) {
  const opts = folders.map((f) => `<option value="${esc(f.path)}"${f.path === send.cwd ? ' selected' : ''}>${esc(f.label)} — ${esc(f.path)}</option>`).join('');
  let where;
  if (!targets) where = '<p class="hint" role="status">Looking for tmux sessions in WSL…</p>';
  else if (targets.sessions?.length) {
    where = `<p class="line-where">${svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>')}<span>New tmux window in WSL</span></p>
      <label class="field" for="line-session">tmux session
        <select id="line-session">${targets.sessions.map((s) => `<option value="${esc(s)}"${s === send.session ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`;
  } else {
    where = `<p class="line-where">${svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>')}<span>New Windows Terminal tab</span></p>
      ${targets.why ? `<p class="hint">${esc(targets.why)}</p>` : ''}`;
  }
  const status = send.status
    ? `<p class="${send.status.ok ? 'hint' : 'form-error'}" role="${send.status.ok ? 'status' : 'alert'}" id="line-send-status">${esc(send.status.text)}</p>` : '';
  return `<form class="line-send" id="line-send-form">
      <label class="field" for="line-prompt">Prompt (edit it as you like)
        <textarea id="line-prompt" rows="12" maxlength="20000" spellcheck="false">${esc(send.prompt)}</textarea></label>
      <p class="hint">Claude starts in its ask-first mode: it asks before it edits a file or runs a command.</p>
      <div class="line-folder-row">
        <label class="field" for="line-cwd">Folder
          <select id="line-cwd"><option value=""${send.cwd ? '' : ' selected'}>Choose a folder…</option>${opts}</select></label>
        <button type="button" class="link-btn" data-line="browse" id="line-browse">Browse…</button>
      </div>
      <fieldset class="field line-run"><legend>Where it runs</legend>${where}</fieldset>
      <div class="form-actions"><button type="submit" class="button" id="line-start"${!targets || send.busy ? ' disabled' : ''}>${send.busy ? 'Starting…' : 'Start Claude'}</button></div>
      ${status}
    </form>`;
}
