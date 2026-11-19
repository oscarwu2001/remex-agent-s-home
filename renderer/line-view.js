// LINE chats: what in the user's LINE group chats concerns them, from the
// exports the main process reads (src/core/linechat.js). The board shows a
// headline and the items; each can be added to a project as a to-do,
// dismissed (with Undo), or sent to an agent (a sheet over the board where
// the user edits the prompt, picks the folder and where Claude runs, and
// presses Start Claude). Settings picks the folder, the chats to read and
// the user's names and keywords, and sets up the bot part: the user's own
// LINE bot, whose group messages their relay passes on (src/core/linebot.js).
// Its groups are chats like the exports' on the board.
//
// Chat names are often people's names, so with privacy mode on (the
// default) only counts, times and the reason for each item show: no chat
// or group name, sender, message, folder, relay link, or the user's names
// and keywords.
//
// Items are named by their key (the chat and the message), in ids too:
// one message can be in two chats.

import { boardTime } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PRIVACY_SWITCH = '“Hide file names, commands, survey answers and LINE chats”';
const LIMIT = 5; // items shown before "Show N more"
// The board cuts a message at six lines (styles.css .line-text). Whether it
// is cut, estimated for the narrowest board: a line holds about 34 narrow
// characters, a CJK character or emoji counts as two, and each line break
// starts a line. Errs towards offering Show all.
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}　-〿＀-￯]/u;
const PER_LINE = 34;
const CUT_AT = 6;
export function isLong(text) {
  let lines = 0;
  for (const para of String(text ?? '').split('\n')) {
    let units = 0;
    for (const ch of para) units += WIDE.test(ch) ? 2 : 1;
    lines += Math.max(1, Math.ceil(units / PER_LINE));
    if (lines > CUT_AT) return true;
  }
  return false;
}

// After Add or Dismiss hides an item: the item whose same button takes the
// focus, the next one still listed, else the one before, else null (the
// section). keys: the items in board order; pending: keys being hidden.
export function nextFocus(keys, pending, key) {
  const at = keys.indexOf(key);
  if (at < 0) return null;
  const free = (k) => k !== key && !pending.has(k);
  return keys.slice(at + 1).find(free) ?? keys.slice(0, at).reverse().find(free) ?? null;
}
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
  const more = isLong(it.text)
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
  const bot = l.bot?.on ? l.bot : null;
  if (!l.demo && !l.folder && !bot) return `<p class="empty">Not set up yet. Choose the folder you save LINE chats into, or connect your LINE bot.</p>${settingsBtn}`;
  // The exports folder's trouble hides nothing the bot brings in: it is said above.
  const botReading = Boolean(bot?.groups?.some((g) => g.read));
  const folderNote = l.folderError ? `<p class="form-error">${esc(folderWords(l.folderError))}</p>` : '';
  // The troubles Needs attention has the reason for, together first, with
  // one pointer there; the stand-in hint last.
  const tickedFailed = !l.readCount && l.tickedFailed;
  const troubles = [
    !bot ? '' : bot.notCollecting ? 'Your LINE bot is not collecting.' : bot.error ? 'The bot’s messages could not be collected.' : '',
    l.scanFailed ? 'The chats could not be read just now.' : '',
    tickedFailed ? 'The ticked chats could not be read.' : '',
  ].filter(Boolean);
  const errors = `${folderNote}${troubles.length ? `<p class="form-error">${troubles.join(' ')} See Needs attention.</p>` : ''}`;
  const standIns = bot?.standIns ? `<p class="hint">${standInWords(bot)}${troubles.length ? '' : ' See Needs attention.'}</p>` : '';
  if (folderNote && !botReading) return `${errors}${settingsBtn}${standIns}`;
  if (l.scanFailed || tickedFailed) return `${errors}${standIns}`;
  if (!l.readCount) {
    const found = (l.chats?.length ?? 0) + (bot?.groups?.length ?? 0);
    if (troubles.length && !found) return `${errors}${settingsBtn}${standIns}`;
    const words = found ? `${plural(found, 'chat')} found. Tick the chats${bot ? ' and groups' : ''} to read in Settings.`
      : l.folder || !bot ? 'No chats in the folder yet. In LINE, open a chat, then ≡ → Save chat, and save it there.'
        : 'Nothing from your bot yet. Invite it to a group: it sees what is sent there after it joins.';
    return `${errors}<p class="empty">${words}</p>${settingsBtn}${standIns}`;
  }
  if (!l.names?.length && !l.keywords?.length) {
    return `${errors}<p class="empty">Add your names in LINE, or a few keywords, in Settings, so the app can find what is for you.</p>${settingsBtn}${standIns}`;
  }
  const items = l.items ?? [];
  if (!items.length) return `${errors}<p class="line-head">Nothing for you in the last ${l.windowDays ?? 14} days · ${plural(l.readCount, 'chat')} read</p>${standIns}`;
  const from = new Set(items.map((i) => i.chat)).size;
  const head = `<p class="line-head">${plural(items.length, 'item')} for you · from ${plural(from, 'chat')} · newest ${esc(boardTime(items[0].ms, now))}</p>`;
  const shown = ui.all ? items : items.slice(0, LIMIT);
  const list = `<ul class="line-items">${shown.map((it) => itemHtml(it, { privacy, now, ui, projects })).join('')}</ul>`;
  const more = items.length > LIMIT
    ? `<div class="form-actions"><button type="button" class="link-btn" data-line="${ui.all ? 'fewer' : 'more'}" data-key="line-more">${ui.all ? 'Show fewer' : `Show ${items.length - LIMIT} more`}</button></div>` : '';
  const hidden = privacy
    ? `<p class="hint">Turn off ${PRIVACY_SWITCH} to see the chats, senders and messages and to act on them. <button type="button" class="link-btn inline" data-line="privacy" data-key="line-privacy">Privacy settings</button></p>` : '';
  return `${errors}${head}${list}${more}${hidden}${standIns}`;
}

// Why senders in the bot's groups show as stand-ins, the same words on the
// board and in Settings (Needs attention has the next step).
function standInWords(b) {
  const why = b.tokenRefused ? 'Senders in your bot’s groups show as stand-ins because LINE refused the relay’s LINE_TOKEN (see Needs attention)'
    : b.named ? 'Some senders in your bot’s groups show as stand-ins because LINE gave no name for them'
      : 'Senders in your bot’s groups show as stand-ins (the relay sends no names)';
  return `${why}, so your own promises there can’t be found and your own messages may show as mentions.`;
}

// The section's one status line: what the last button did, with Undo after
// a dismissal. status: { text, undo: the dismissed item's key } or null.
export function statusHtml(status) {
  if (!status?.text) return '';
  const undo = status.undo
    ? ` <button type="button" class="link-btn inline" data-line="undo" data-item="${esc(status.undo)}" data-key="line-undo">Undo</button>` : '';
  return `${esc(status.text)}${undo}`;
}

// One labelled field with its Save, its error tied to it (aria-invalid,
// aria-describedby) after a Save it refused, and Cancel when it was opened
// over a saved value; drawn as field feedback's are (field-view.js), with
// Save on its own row under the field.
function entryForm({ id, label, input, value = null, error, hint = '', button = 'Save', filled = true, cancel = '', cancelLabel = '' }) {
  const err = error ? `<p class="form-error" id="${id}-err" role="alert">${esc(error)}</p>` : '';
  const hintP = hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : '';
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ');
  const field = `<input id="${id}" ${input}${value != null ? ` value="${esc(value)}"` : ''}${error ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}>`;
  const cancelBtn = cancel ? `
        <button type="button" class="link-btn" id="${id}-cancel" data-line="${cancel}" aria-label="${esc(cancelLabel || 'Cancel')}">Cancel</button>` : '';
  return `<form class="field-entry" id="${id}-form" novalidate>
      <label class="field-entry-label" for="${id}">${label}</label>
      <div class="add-row">${field}</div>
      <div class="form-actions field-entry-actions"><button class="${filled ? 'button' : 'link-btn'}" type="submit" id="${id}-save">${button}</button>${cancelBtn}</div>${err}${hintP}</form>`;
}

// A relay link typed but refused is kept as typed for the next try, but
// not past privacy mode turning on or Settings closing: it names the
// user's relay. The part's notes and errors go with it, so none is left
// over from before. Changes state in place and returns it.
// The same for the exports part and the LINE chats switch: their errors
// go when Settings closes or privacy mode turns on.
export function dropLineDrafts(state) {
  return Object.assign(state, { tickError: '', switchError: '', wordsError: '', error: '', note: '' });
}

// Off stops the app collecting, not LINE sending to the relay.
const STOP_WORDS = '<p class="hint">Stopped using the bot? In the LINE Developers console, turn off Use webhook (or remove the bot from its groups) so LINE stops sending to your relay, and delete the relay’s Google Sheet, then empty Drive’s trash, which clears its version history (it can hold past messages).</p>';

export function dropLineBotDrafts(state) {
  return Object.assign(state, {
    linkDraft: null, linkError: '', secretError: '', secretNote: '', note: '', scriptNote: '', scriptError: '', error: '', tickError: '', refreshError: '',
  });
}

// A message from the main process as Settings shows it: errorHere names
// the control in view (linebot.js settingsWords: the Secret field open
// '1', folded '0' or not drawn 'n', then the link field open or folded).
const inView = (words, message, { secretOpen, linkOpen, noStorage }) => (words && typeof words === 'object' && words[`${noStorage ? 'n' : secretOpen ? 1 : 0}${linkOpen ? 1 : 0}`]) || message;
const NAMES = /^(?:Google|Apps Script|READER_SECRET|LINE)\b/;
const readOn = (m) => (NAMES.test(m) ? m : `${m.charAt(0).toLowerCase()}${m.slice(1)}`);

// The bot part of Settings: its switch, then (on) the set-up steps and
// Copy relay script, the Relay link, the Secret, Refresh now with when it
// last collected, and the groups the relay has brought, each with a tick
// (off by default; only ticked groups keep their messages). The secret
// never comes back from the main process: once saved, only "Secret saved"
// and Replace secret. state: { linkEditing, linkDraft, linkError,
// secretEditing, secretError, secretNote, scriptNote, scriptError, note,
// error (the switch's), tickError, refreshError }. Each error sits under
// what caused it.
const ERR = (text) => (text ? `<p class="form-error" role="alert">${esc(text)}</p>` : '');
const STORAGE_NOTE = 'see the note under Collect from my LINE bot';

function botSettingsHtml(b, { privacy, state, now, demo, online }) {
  const on = Boolean(b?.on);
  const noStore = on && b.secretStorage ? String(b.secretStorage) : '';
  const head = `<h5 class="line-part-h" id="line-bot-h">Your LINE bot</h5>
    <p class="hint">For groups only: a LINE Official Account bot you invite to a group passes on what is said there, after it joins, through a relay of yours (a Google Sheet and a script). It cannot see one-to-one chats.</p>
    <label class="switch"><input type="checkbox" id="opt-line-bot"${on ? ' checked' : ''}${demo || !online ? ' disabled' : ''}${noStore ? ' aria-describedby="line-bot-storage"' : ''}> <span>Collect from my LINE bot (goes online, to my relay only)</span></label>${ERR(state.error)}`;
  if (!on) {
    // Off stops the app collecting, not LINE sending to the relay.
    const stop = b?.link ? `
    ${STOP_WORDS}` : '';
    return `${head}${stop}`;
  }
  const steps = `<ol class="field-steps">
      <li>Press Copy relay script. In a new Google Sheet, open Extensions → Apps Script, paste it, and run makeSecrets once.</li>
      <li>Deploy it as a web app (Execute as: Me; Who has access: Anyone), and copy the Web app link into Relay link.</li>
      <li>In the LINE Developers console, set the bot’s webhook link to that link followed by ?k= and WEBHOOK_KEY, turn on Use webhook and turn off redelivery. Verify shows “302 Found”: that is expected.</li>
      <li>${noStore ? `Once this computer can keep the secret (${STORAGE_NOTE}), copy` : 'Copy'} READER_SECRET from the script’s Project Settings → Script properties into Secret.</li>
    </ol>
    <div class="form-actions"><button type="button" class="link-btn" id="line-bot-copy-script" data-line="bot-copy-script">Copy relay script</button></div>${b.relayOld ? `
    <p class="hint">Your relay is an older version. To update it, press Copy relay script, paste it over the relay’s script, then Deploy → Manage deployments → edit → Version: New version → Deploy. The link stays the same.</p>` : ''}${state.scriptNote ? `
    <p class="hint" role="status">${esc(state.scriptNote)}</p>` : ''}${state.scriptError ? `
    <p class="form-error" role="alert">${esc(state.scriptError)}</p>` : ''}`;
  const linkOpen = !b.link || Boolean(state.linkEditing);
  const typed = state.linkDraft != null ? state.linkDraft : privacy ? '' : b.link;
  const link = linkOpen
    ? entryForm({
      id: 'line-bot-link', label: 'Relay link', error: state.linkError, value: typed, button: 'Save link',
      input: 'type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Ends in /exec"', cancel: b.link ? 'bot-cancel-link' : '', cancelLabel: 'Cancel link change',
    })
    : `<p class="field-set"><span>${privacy ? 'A relay link is saved.' : `Relay: <span class="field-path">${esc(b.link)}</span>`}</span>
        <button type="button" class="link-btn" id="line-bot-change-link" data-line="bot-change-link">Change link</button></p>`;
  const secretOpen = !b.secretSaved || Boolean(state.secretEditing);
  let secret;
  // No protected storage: no Secret field, one line on what is so; the reason is said once, above.
  if (noStore && b.secretSaved) secret = `<p class="field-set"><span>A secret is saved, but this computer can’t open it now (${STORAGE_NOTE}).</span></p>`;
  else if (noStore) secret = `<p class="field-set"><span>This computer can’t keep the secret (${STORAGE_NOTE}).</span></p>`;
  else if (secretOpen) {
    // The second field's Save is plain until the link is saved: one filled button at a time.
    secret = entryForm({
      id: 'line-bot-secret', label: 'Secret', error: state.secretError, button: 'Save secret', filled: Boolean(b.link) && !linkOpen,
      input: 'type="password" autocomplete="new-password" spellcheck="false" placeholder="READER_SECRET"', cancel: b.secretSaved ? 'bot-cancel-secret' : '', cancelLabel: 'Cancel secret change',
      hint: state.secretNote ? esc(state.secretNote) : 'Kept encrypted with this computer’s own protection, and never shown again.',
    });
  } else {
    secret = `<p class="field-set"><span>Secret saved.</span>
        <button type="button" class="link-btn" id="line-bot-replace-secret" data-line="bot-replace-secret">Replace secret</button></p>`;
  }
  const shown = { secretOpen: secretOpen && !noStore, linkOpen, noStorage: Boolean(noStore) };
  const ready = Boolean(b.link && b.secretSaved && !noStore);
  const open = linkOpen || (secretOpen && !noStore);
  // Not collecting: why, in this part's words (with no protected storage the note under the switch says it).
  const stopped = !b.busy && !noStore && b.notCollectingHere ? `not collecting: ${b.notCollectingHere}.` : '';
  const said = b.busy ? 'Collecting…'
    : [b.collectedAt ? `Collected ${boardTime(b.collectedAt, now)}` : stopped ? '' : 'Not collected yet', ready && b.nextAt ? `next ${boardTime(Math.max(b.nextAt, now), now)}` : '', stopped].filter(Boolean).join(' · ');
  const status = `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
  const failed = b.error ? `<p class="form-error" role="status">Last collection failed${b.error.at ? ` (${esc(boardTime(b.error.at, now))})` : ''}: ${esc(readOn(inView(b.errorHere, b.error.message, shown)))}</p>` : '';
  const refresh = ready ? `<div class="form-actions"><button type="button" class="${open ? 'link-btn' : 'button'}" id="line-bot-refresh" data-line="bot-refresh">Refresh now</button></div>` : '';
  const groups = b.groups ?? [];
  let list = '';
  if (!groups.length) list = ready ? '<p class="hint">No group has sent anything yet. Invite the bot to a group: it sees what is sent there after it joins.</p>' : '';
  else if (privacy) {
    const ticked = groups.filter((g) => g.read).length;
    list = `<p class="hint">${plural(groups.length, 'group')} found, ${ticked} read.</p>`;
  } else {
    list = `<fieldset class="line-chats"><legend>Groups your bot is in (only ticked groups keep their messages, from when they are ticked)</legend><ul>${groups.map((g, i) => `<li class="line-chat-row">
        <label class="check" for="line-bot-read-${i}"><input type="checkbox" id="line-bot-read-${i}" data-group="${esc(g.id)}"${g.read ? ' checked' : ''}> <span class="line-chat-name">${esc(g.name)}</span></label>
        <span class="line-chat-what">${g.read ? `${plural(g.messages ?? 0, 'message')} kept` : `${plural(g.count ?? 0, 'message')}, not kept`}${g.lastMs ? ` · last ${esc(boardTime(g.lastMs, now))}` : ''}</span>
      </li>`).join('')}</ul></fieldset>${b.tokenRefused && (b.standIns || groups.some((g) => !g.named)) ? `
    <p class="hint">${standInWords(b)}</p>`
    : groups.some((g) => !g.named) && !b.named ? `
    <p class="hint">The relay sends no names (no LINE_TOKEN in its Script properties): groups and senders show as stand-ins, so your own promises there can’t be found and your own messages may show as mentions. Put the channel access token in the relay’s Script properties as LINE_TOKEN to turn names on.</p>`
    : b.standIns ? `
    <p class="hint">Some senders show as stand-ins because LINE gave no name for them, so your own promises there can’t be found and your own messages may show as mentions.</p>` : ''}`;
  }
  const note = state.note ? `<p class="hint" role="status">${esc(state.note)}</p>` : '';
  return `${head}${noStore ? `<p class="hint" id="line-bot-storage">${esc(noStore)}</p>` : ''}${steps}${link}${secret}${refresh}${ERR(state.refreshError)}
    <p class="hint field-status" role="status">${esc(status)}</p>${failed}${note}${list}${ERR(state.tickError)}`;
}

// Settings → Connections → LINE chats, under its switch: the exports part,
// the bot part, then the user's names and keywords, which both share.
export function lineSettingsHtml(l, { privacy = true, online = true, now = Date.now(), state = {}, bot: botState = {} } = {}) {
  // The demo shows its sample chats as Settings would, saving nothing.
  const sample = l?.demo ? '<p class="hint">The demo shows made-up LINE chats; nothing here is saved. Turn off “Demo patients” to set up your own folder.</p>' : '';
  if (!l?.demo && !online) return '<p class="hint">The desktop app reads the folder; this preview cannot.</p>';
  // Under the "Read my LINE chats" switch, on or off: why turning it on or off failed.
  const switchErr = ERR(state.switchError);
  // Off, with a relay link kept: how to stop LINE sending to it, as the bot part's own switch says.
  if (!l?.enabled) return `${switchErr}${l?.bot?.link ? STOP_WORDS : ''}`;
  const err = state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : '';
  const folder = l.folder
    ? `<p class="field-set"><span>${privacy ? 'A folder is chosen.' : `Folder: <span class="field-path">${esc(l.folder)}</span>`}</span>
        <button type="button" class="link-btn" data-line="choose-folder" id="line-folder">Choose another…</button></p>`
    : '<div class="form-actions"><button type="button" class="button" data-line="choose-folder" id="line-folder">Choose folder…</button></div>';
  const how = '<p class="hint">In LINE: open the chat, then ≡ → Save chat, and save the file in this folder. Save it again to bring it up to date.</p>';
  const exportsHead = '<h5 class="line-part-h" id="line-exports-h">Saved chats</h5>';
  const botPart = botSettingsHtml(l.bot, { privacy, state: botState, now, demo: Boolean(l.demo), online });
  const chats = l.chats ?? [];
  const exportsRead = chats.filter((c) => c.read && c.messages != null).length;
  let list;
  let words;
  const wordsHead = '<h5 class="line-part-h" id="line-words-h">Your names and keywords</h5>';
  if (privacy) {
    // Counts only, each in its own part; one line says what is hidden.
    list = l.folder && chats.length ? `<p class="hint">${plural(chats.length, 'chat')} found, ${exportsRead} read.</p>` : '';
    words = `<p class="hint">${plural(l.names?.length ?? 0, 'name')} and ${plural(l.keywords?.length ?? 0, 'keyword')} saved.</p>`;
  } else {
    list = !l.folder ? '' : !chats.length ? `<p class="hint">${l.folderError ? esc(folderWords(l.folderError)) : 'No chats in the folder yet.'}</p>`
      : `<fieldset class="line-chats"><legend>Chats in the folder (only ticked chats are read)</legend><ul>${chats.map((c, i) => `<li class="line-chat-row">
        <label class="check" for="line-read-${i}"><input type="checkbox" id="line-read-${i}" data-chat="${esc(c.chat)}"${c.read ? ' checked' : ''}> <span class="line-chat-name">${esc(c.chat)}</span></label>
        <span class="line-chat-what">${plural(c.files, 'export')}${c.read && c.messages != null ? ` · ${plural(c.messages, 'message')}` : ''}${c.problems ? ` · ${plural(c.problems, 'problem')}, see Needs attention` : ''}</span>
      </li>`).join('')}</ul></fieldset>`;
    words = `<form class="line-words" id="line-words-form">
        <label class="field" for="line-names">Your names in LINE (comma-separated, up to 10)
          <input id="line-names" autocomplete="off" spellcheck="false" value="${esc((l.names ?? []).join(', '))}"></label>
        <label class="field" for="line-keywords">Keywords (comma-separated, up to 30)
          <input id="line-keywords" autocomplete="off" spellcheck="false" value="${esc((l.keywords ?? []).join(', '))}"></label>
        <div class="form-actions"><button type="submit" class="button" id="line-words-save">Save</button></div>${ERR(state.wordsError)}
      </form>`;
  }
  // With no folder and no bot nothing has been read: no time to give.
  const reading = Boolean(l.folder || l.bot?.on || l.demo);
  const status = [reading ? (l.scannedAt ? `Read ${boardTime(l.scannedAt, now)}` : 'Not read yet') : '', reading ? `items from the last ${l.windowDays ?? 14} days` : '', state.note].filter(Boolean).join(' · ');
  const statusP = status ? `<p class="hint" role="status">${esc(status)}</p>` : '';
  const exportsPart = `${exportsHead}${folder}${how}${err}${list}${privacy ? '' : ERR(state.tickError)}`;
  // Names and keywords count for both parts.
  const groups = l.bot?.on && l.bot.groups?.length;
  const hidden = privacy && reading
    ? `<p class="hint">Turn off ${PRIVACY_SWITCH} to choose chats${groups ? ' and groups' : ''} and to change your names and keywords. <button type="button" class="link-btn inline" data-line="privacy" data-key="line-settings-privacy">Privacy settings</button></p>` : '';
  const shared = reading ? `${wordsHead}${words}` : '';
  return `${switchErr}${sample}${hidden}${exportsPart}${botPart}${shared}${statusP}`;
}

// The closed Connections group's words for LINE: on or off, and counts only.
export function lineSummary(l) {
  if (!l?.enabled) return 'LINE off';
  if (!l.demo && !l.folder && !l.bot?.on) return 'LINE on · no folder yet';
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
