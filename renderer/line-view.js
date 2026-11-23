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
//
// The words come from the word tables when drawn, never when this module
// loads, so they are in the language the window set at start. What the
// main process said (its errors and notes) is put in it with said(); a
// chat, sender or message never is: those are the user's own words.

import { boardTime } from './dates.js';
import { tr, said, english } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = (key, params) => esc(tr(key, params));
const privacySwitch = () => tr('common.quoted', { text: tr('settings.private') });
// A chat the export did not name is named by the app, in the window's language.
const chatName = (name) => (name === english('said.lc.unnamed') ? tr('said.lc.unnamed') : name);
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
  mention: { get words() { return tr('lv.reason.mention'); }, glyph: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>' },
  keyword: { get words() { return tr('lv.reason.keyword'); }, glyph: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.3"/>' },
  commitment: { get words() { return tr('lv.reason.commitment'); }, glyph: '<path d="M4 5.5h16v10h-9.5L6 19v-3.5H4z"/><path d="M8.5 10.5l2.3 2.3 4.7-4.6"/>' },
};
export function reasonHtml(it, { privacy = true } = {}) {
  const r = REASONS[it.reason] ?? REASONS.keyword;
  const words = it.reason === 'keyword' && !privacy && it.matched ? tr('lv.reasonMatched', { words: r.words, matched: it.matched }) : r.words;
  return `<span class="line-reason line-${esc(it.reason)}">${svg(r.glyph, 'line-glyph')}<span>${esc(words)}</span></span>`;
}

const ICONS = {
  add: '<path d="M12 5v14M5 12h14"/>',
  dismiss: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M4 11.5L20 4l-6.5 16-2.6-6.4z"/><path d="M10.9 13.6L20 4"/>',
};
const settingsBtn = () => `<div class="form-actions"><button type="button" class="link-btn" data-line="settings" data-key="line-settings">${t('fix.settings')}</button></div>`;
// The folder's error, as what to do next (the code shows nowhere on the board).
const FOLDER_WORDS = {
  ENOENT: 'lv.folderMissing',
  ENOTDIR: 'lv.folderMissing',
};
const folderWords = (code) => tr(FOLDER_WORDS[code] ?? 'lv.folderUnreadable');

function addForm(it, projects, ui, now) {
  const id = esc(it.key);
  if (!projects.length) {
    return `<div class="line-add"><p class="hint">${t('lv.noProjects')}</p>
      <button type="button" class="link-btn small" data-line="cancel-add" data-item="${id}" data-key="line-cancel-${id}">${t('common.cancel')}</button></div>`;
  }
  const src = it.draft?.source ?? { chat: it.chat, sender: it.sender };
  const bad = ui.error && ui.errorKey === it.key;
  return `<form class="line-add" data-item="${id}">
      <label class="field" for="line-todo-${id}">${t('lv.todo')}
        <input id="line-todo-${id}" maxlength="300" autocomplete="off" value="${esc(it.draft?.text ?? '')}"${bad ? ` aria-invalid="true" aria-describedby="line-todo-err-${id}"` : ''}></label>
      ${bad ? `<p class="form-error" id="line-todo-err-${id}">${esc(said(ui.error))}</p>` : ''}
      <p class="hint line-source">${t('lv.from', { chat: chatName(src.chat), sender: src.sender, when: boardTime(it.ms, now) })}</p>
      <label class="field" for="line-project-${id}">${t('lv.project')}
        <select id="line-project-${id}">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="form-actions"><button type="submit" class="button" id="line-add-go-${id}">${t('common.add')}</button>
        <button type="button" class="link-btn" data-line="cancel-add" data-item="${id}" data-key="line-cancel-${id}">${t('common.cancel')}</button></div>
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
  const error = ui.error && ui.errorKey === it.key && !adding ? `<p class="form-error">${esc(said(ui.error))}</p>` : '';
  const btn = (act, words, extra = '', cls = '') => `<button type="button" class="link-btn small line-act${cls}" data-line="${act}" data-item="${id}" data-key="line-${act}-${id}"${extra}>${svg(ICONS[act])}<span>${words}</span></button>`;
  const more = isLong(it.text)
    ? `<button type="button" class="link-btn inline line-more" data-line="expand" data-item="${id}" data-key="line-expand-${id}" aria-expanded="${open ? 'true' : 'false'}">${open ? t('lv.showLess') : t('lv.showAll')}</button>` : '';
  return `<li class="line-item">
    ${meta}
    <p class="line-from"><span class="line-chat">${esc(chatName(it.chat))}</span><span aria-hidden="true"> · </span><span class="line-sender">${esc(it.sender)}</span></p>
    <p class="line-text${open ? ' open' : ''}">${esc(it.text)}</p>${more}
    <div class="line-actions">${btn('add', t('lv.addToProject'), ` aria-expanded="${adding}"`)}${btn('send', t('line.send.title'), ' aria-haspopup="dialog"')}${btn('dismiss', t('lv.dismiss'), '', ' line-dismiss')}</div>
    ${error}${adding ? addForm(it, projects, ui, now) : ''}
  </li>`;
}

// The board section's body. ui: { adding: key, expanded: Set of keys, all:
// show every item, error, errorKey }; projects: the shared project list.
// What the last button did goes to the section's one status line (statusHtml).
export function lineHtml(l, { privacy = true, now = Date.now(), ui = {}, projects = [] } = {}) {
  if (!l?.enabled) return '';
  const bot = botOn(l.bot) ? l.bot : null;
  if (!l.demo && !l.folder && !bot) return `<p class="empty">${t('lv.notSetUp')}</p>${settingsBtn()}`;
  // The exports folder's trouble hides nothing the bot brings in: it is said above.
  const botReading = Boolean(bot?.groups?.some((g) => g.read));
  const folderNote = l.folderError ? `<p class="form-error">${esc(folderWords(l.folderError))}</p>` : '';
  // The troubles Needs attention has the reason for, together first, with
  // one pointer there; the stand-in hint last.
  const tickedFailed = !l.readCount && l.tickedFailed;
  const troubles = [
    !bot ? '' : bot.notCollecting ? tr('lv.botNotCollecting') : bot.error ? tr('lv.botFailed') : '',
    l.scanFailed ? tr('lv.scanFailed') : '',
    tickedFailed ? tr('lv.tickedFailed') : '',
  ].filter(Boolean);
  const errors = `${folderNote}${troubles.length ? `<p class="form-error">${t('lv.seeNeeds', { what: troubles.join(tr('common.sentenceSep')) })}</p>` : ''}`;
  // A failed name lookup: Needs attention says why, as Settings points there.
  const standIns = !bot?.standIns ? '' : bot.nameProblem && !bot.tokenRefused ? `<p class="hint">${t('lv.someStandIns')}</p>`
    : `<p class="hint">${esc(standInWords(bot))}${troubles.length ? '' : t('lv.seeNeedsAfter')}</p>`;
  if (folderNote && !botReading) return `${errors}${settingsBtn()}${standIns}`;
  if (l.scanFailed || tickedFailed) return `${errors}${standIns}`;
  if (!l.readCount) {
    const found = (l.chats?.length ?? 0) + (bot?.groups?.length ?? 0);
    if (troubles.length && !found) return `${errors}${settingsBtn()}${standIns}`;
    const words = found ? tr(bot ? 'lv.foundTickGroups' : 'lv.foundTick', { n: found })
      : l.folder || !bot ? tr('lv.noChatsYet')
        : tr('lv.nothingFromBot');
    return `${errors}<p class="empty">${esc(words)}</p>${settingsBtn()}${standIns}`;
  }
  if (!l.names?.length && !l.keywords?.length) {
    return `${errors}<p class="empty">${t('lv.addNames')}</p>${settingsBtn()}${standIns}`;
  }
  const items = l.items ?? [];
  if (!items.length) return `${errors}<p class="line-head">${t('lv.nothing', { days: l.windowDays ?? 14, n: l.readCount })}</p>${standIns}`;
  const from = new Set(items.map((i) => i.chat)).size;
  const head = `<p class="line-head">${[tr('lv.items', { n: items.length }), tr('lv.fromChats', { n: from }), tr('lv.newest', { when: boardTime(items[0].ms, now) })].map(esc).join(' · ')}</p>`;
  const shown = ui.all ? items : items.slice(0, LIMIT);
  const list = `<ul class="line-items">${shown.map((it) => itemHtml(it, { privacy, now, ui, projects })).join('')}</ul>`;
  const more = items.length > LIMIT
    ? `<div class="form-actions"><button type="button" class="link-btn" data-line="${ui.all ? 'fewer' : 'more'}" data-key="line-more">${ui.all ? t('lv.showFewer') : t('lv.showMore', { n: items.length - LIMIT })}</button></div>` : '';
  const hidden = privacy
    ? `<p class="hint">${t('lv.privacyHidden', { toggle: privacySwitch() })} <button type="button" class="link-btn inline" data-line="privacy" data-key="line-privacy">${t('lv.privacySettings')}</button></p>` : '';
  return `${errors}${head}${list}${more}${hidden}${standIns}`;
}

// Why senders in the bot's groups show as stand-ins, the same words on the
// board and in Settings (Needs attention has the next step).
function standInWords(b) {
  return tr(b.tokenRefused ? 'lv.standIns.token' : b.named || b.nameProblem ? 'lv.standIns.some' : 'lv.standIns.none');
}

// The section's one status line: what the last button did, with Undo after
// a dismissal. status: { text, undo: the dismissed item's key } or null.
export function statusHtml(status) {
  if (!status?.text) return '';
  const undo = status.undo
    ? ` <button type="button" class="link-btn inline" data-line="undo" data-item="${esc(status.undo)}" data-key="line-undo">${t('lv.undo')}</button>` : '';
  return `${esc(said(status.text))}${undo}`;
}

// One labelled field with its Save, its error tied to it (aria-invalid,
// aria-describedby) after a Save it refused, and Cancel when it was opened
// over a saved value; drawn as field feedback's are (field-view.js), with
// Save on its own row under the field.
function entryForm({ id, label, input, value = null, error, hint = '', button = tr('lv.save'), filled = true, cancel = '', cancelLabel = '' }) {
  const err = error ? `<p class="form-error" id="${id}-err" role="alert">${esc(said(error))}</p>` : '';
  const hintP = hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : '';
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ');
  const field = `<input id="${id}" ${input}${value != null ? ` value="${esc(value)}"` : ''}${error ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}>`;
  const cancelBtn = cancel ? `
        <button type="button" class="link-btn" id="${id}-cancel" data-line="${cancel}" aria-label="${esc(cancelLabel || tr('common.cancel'))}">${t('common.cancel')}</button>` : '';
  return `<form class="field-entry" id="${id}-form" novalidate>
      <label class="field-entry-label" for="${id}">${esc(label)}</label>
      <div class="add-row">${field}</div>
      <div class="form-actions field-entry-actions"><button class="${filled ? 'button' : 'link-btn'}" type="submit" id="${id}-save">${esc(button)}</button>${cancelBtn}</div>${err}${hintP}</form>`;
}

// A relay link typed but refused is kept as typed for the next try, but
// not past privacy mode turning on or Settings closing: it names the
// user's relay. The part's notes and errors go with it, so none is left
// over from before. Changes state in place and returns it.
// The same for the exports part and the LINE chats switch: their errors
// go when Settings closes or privacy mode turns on.
// Names and keywords typed but not saved go too: reopened, the fields show what is saved.
export function dropLineDrafts(state) {
  return Object.assign(state, { tickError: '', switchError: '', wordsError: '', error: '', note: '', names: null, keywords: null, stopped: false });
}

// What an off deleted, said first once it is taken, under the switch that
// took it; what would not go (state.left, linebot.offLeft) as an error.
const LEFT = {
  secret: 'lv.left.secret',
  secretCopy: 'lv.left.secretCopy',
  storeCopy: 'lv.left.storeCopy',
  unlisted: 'lv.left.unlisted',
  secretUnlisted: 'lv.left.secretUnlisted',
};
function offWords(state) {
  const left = (state.left ?? []).filter((k) => LEFT[k]);
  // A copy of its saved data holds the relay link and kept messages too.
  const copies = left.includes('storeCopy') || left.includes('unlisted');
  const secretGone = !['secret', 'secretCopy', 'secretUnlisted'].some((k) => left.includes(k));
  const deleted = [copies ? '' : tr('lv.del.link'), secretGone ? tr('lv.del.secret') : '', copies ? '' : tr('lv.del.kept')].filter(Boolean);
  const list = deleted.length > 2 ? tr('common.and3', { a: deleted[0], b: deleted[1], c: deleted[2] })
    : deleted.length === 2 ? tr('common.and', { a: deleted[0], b: deleted[1] }) : deleted.join('');
  if (!left.length) return `<p class="hint" role="status">${t('lv.offDone', { list })}</p>`;
  const both = left.includes('unlisted') && left.includes('secretUnlisted');
  // Both listings failed: one phrase for the folder.
  const words = left.filter((k) => !(both && k === 'secretUnlisted')).map((k) => tr(both && k === 'unlisted' ? 'lv.left.bothUnlisted' : LEFT[k]));
  const why = words.join(tr('common.semiSep'));
  return `<p class="form-error" role="alert">${deleted.length ? t('lv.offPartly', { list, left: why }) : t('lv.offButLeft', { left: why })}</p>`;
}
// LINE chats off whose bot part could not even be started (its record
// could not be written; the snapshot's bot.notStarted, tried again by the app).
const notStartedHtml = () => `<p class="form-error" role="status">${t('lv.notStarted')}</p>`;
// The bot part as on: not while an off of it is not finished or not started.
const botOn = (b) => Boolean(b?.on) && !b?.unfinished && !b?.notStarted;
// The user's off, not finished (BotKeeper.unfinished: 'held' or 'failed'):
// nothing of the bot's was deleted yet. lineOff: said under LINE chats' switch.
const notFinished = (why, lineOff) => `<p class="form-error" role="status">${lineOff ? t('lv.lineIsOff') : ''}${t('lv.notFinished', { because: tr(why === 'failed' ? 'said.lb.unfinishedFailed' : 'said.lb.unfinishedHeld') })}</p>`;
// Off stops the app collecting, not LINE sending to the relay.
const stopWords = () => `<p class="hint" role="status">${t('lv.stopWords')}</p>`;

export function dropLineBotDrafts(state) {
  return Object.assign(state, {
    linkDraft: null, linkError: '', secretError: '', secretNote: '', note: '', scriptNote: '', scriptError: '', error: '', tickError: '', refreshError: '', stopped: false,
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
const ERR = (text) => (text ? `<p class="form-error" role="alert">${keepFileNames(esc(said(text)))}</p>` : '');
const storageNote = () => tr('lv.storageNote');

function botSettingsHtml(b, { privacy, state, now, demo, online }) {
  // An off not finished is off to the user: nothing to change until it is.
  const unfinished = b?.unfinished;
  const on = botOn(b);
  const noStore = on && b.secretStorage ? String(b.secretStorage) : '';
  const head = `<h5 class="line-part-h" id="line-bot-h">${t('lv.botHead')}</h5>
    <p class="hint">${t('lv.botHint')}</p>
    <label class="switch"><input type="checkbox" id="opt-line-bot"${on ? ' checked' : ''}${demo || !online || unfinished ? ' disabled' : ''}${noStore && !b.stuck ? ' aria-describedby="line-bot-storage"' : ''}> <span>${t('lv.botSwitch')}</span></label>${ERR(state.error)}`;
  if (unfinished) return `${head}
    ${notFinished(unfinished, false)}`;
  if (!on) {
    // Off stops the app collecting, not LINE sending to the relay: said
    // once the switch removed a relay link (state.stopped), until Settings closes.
    const stop = state.stopped ? `
    ${offWords(state)}${stopWords()}` : '';
    return `${head}${stop}`;
  }
  // Its saved data can't be read: nothing here can change until it can, but the switch can turn it off.
  if (b.stuck) return `${head}
    <p class="form-error" role="status">${t('lv.notCollecting', { why: said(b.notCollectingHere ?? '') })}</p>`;
  const steps = `<ol class="field-steps">
      <li>${t('lv.step1')}</li>
      <li>${t('lv.step2')}</li>
      <li>${t('lv.step3')}</li>
      <li>${noStore ? t('lv.step4Later', { note: storageNote() }) : t('lv.step4')}</li>
    </ol>
    <div class="form-actions"><button type="button" class="link-btn" id="line-bot-copy-script" data-line="bot-copy-script">${t('lv.copyScript')}</button></div>${b.relayOld ? `
    <p class="hint">${t('lv.relayOld')}</p>` : ''}${state.scriptNote ? `
    <p class="hint" role="status">${esc(said(state.scriptNote))}</p>` : ''}${state.scriptError ? `
    <p class="form-error" role="alert">${esc(said(state.scriptError))}</p>` : ''}`;
  const linkOpen = !b.link || Boolean(state.linkEditing);
  const typed = state.linkDraft != null ? state.linkDraft : privacy ? '' : b.link;
  const link = linkOpen
    ? entryForm({
      id: 'line-bot-link', label: tr('lv.relayLink'), error: state.linkError, value: typed, button: tr('lv.saveLink'),
      input: `type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${t('lv.endsInExec')}"`, cancel: b.link ? 'bot-cancel-link' : '', cancelLabel: tr('lv.cancelLink'),
    })
    : `<p class="field-set"><span>${privacy ? t('lv.linkSaved') : `${t('lv.relayLabel')} <span class="field-path">${esc(b.link)}</span>`}</span>
        <button type="button" class="link-btn" id="line-bot-change-link" data-line="bot-change-link">${t('lv.changeLink')}</button></p>`;
  const secretOpen = !b.secretSaved || Boolean(state.secretEditing);
  let secret;
  // No protected storage: no Secret field, one line on what is so; the reason is said once, above.
  if (noStore && b.secretSaved) secret = `<p class="field-set"><span>${t('lv.secretNoOpen', { note: storageNote() })}</span></p>`;
  else if (noStore) secret = `<p class="field-set"><span>${t('lv.secretNoKeep', { note: storageNote() })}</span></p>`;
  else if (secretOpen) {
    // The second field's Save is plain until the link is saved: one filled button at a time.
    secret = entryForm({
      id: 'line-bot-secret', label: tr('lv.secret'), error: state.secretError, button: tr('lv.saveSecret'), filled: Boolean(b.link) && !linkOpen,
      input: 'type="password" autocomplete="new-password" spellcheck="false" placeholder="READER_SECRET"', cancel: b.secretSaved ? 'bot-cancel-secret' : '', cancelLabel: tr('lv.cancelSecret'),
      hint: state.secretNote ? esc(said(state.secretNote)) : t('lv.secretKept'),
    });
  } else {
    secret = `<p class="field-set"><span>${t('lv.secretSaved')}</span>
        <button type="button" class="link-btn" id="line-bot-replace-secret" data-line="bot-replace-secret">${t('lv.replaceSecret')}</button></p>`;
  }
  const shown = { secretOpen: secretOpen && !noStore, linkOpen, noStorage: Boolean(noStore) };
  const ready = Boolean(b.link && b.secretSaved && !noStore);
  const open = linkOpen || (secretOpen && !noStore);
  // Not collecting: why, in this part's words (with no protected storage the note under the switch says it).
  const stopped = !b.busy && !noStore && b.notCollectingHere ? tr('lv.notCollectingLower', { why: said(b.notCollectingHere) }) : '';
  const lastly = b.busy ? tr('lv.collecting')
    : [b.collectedAt ? tr('lv.collectedAt', { when: boardTime(b.collectedAt, now) }) : stopped ? '' : tr('lv.notCollected'), ready && b.nextAt ? tr('lv.nextAt', { when: boardTime(Math.max(b.nextAt, now), now) }) : '', stopped].filter(Boolean).join(' · ');
  const status = `${lastly.charAt(0).toUpperCase()}${lastly.slice(1)}`;
  const why = b.error ? readOn(said(inView(b.errorHere, b.error.message, shown))) : '';
  const failed = b.error ? `<p class="form-error" role="status">${b.error.at ? t('lv.lastFailedAt', { when: boardTime(b.error.at, now), why }) : t('lv.lastFailed', { why })}</p>` : '';
  const refresh = ready ? `<div class="form-actions"><button type="button" class="${open ? 'link-btn' : 'button'}" id="line-bot-refresh" data-line="bot-refresh">${t('fix.refresh')}</button></div>` : '';
  const groups = b.groups ?? [];
  let list = '';
  if (!groups.length) list = ready ? `<p class="hint">${t('lv.noGroupYet')}</p>` : '';
  else if (privacy) {
    const ticked = groups.filter((g) => g.read).length;
    list = `<p class="hint">${t('lv.groupsFound', { n: groups.length, read: ticked })}</p>`;
  } else {
    list = `<fieldset class="line-chats"><legend>${t('lv.groupsLegend')}</legend><ul>${groups.map((g, i) => `<li class="line-chat-row">
        <label class="check" for="line-bot-read-${i}"><input type="checkbox" id="line-bot-read-${i}" data-group="${esc(g.id)}"${g.read ? ' checked' : ''}> <span class="line-chat-name">${esc(g.name)}</span></label>
        <span class="line-chat-what">${g.read ? t('lv.kept', { n: g.messages ?? 0 }) : t('lv.notKept', { n: g.count ?? 0 })}${g.lastMs ? ` · ${t('lv.lastAt', { when: boardTime(g.lastMs, now) })}` : ''}</span>
      </li>`).join('')}</ul></fieldset>${b.tokenRefused && (b.standIns || groups.some((g) => !g.named)) ? `
    <p class="hint">${esc(standInWords(b))}${t('lv.seeNeedsAfter')}</p>`
    : groups.some((g) => !g.named) && !b.named && !b.nameProblem ? `
    <p class="hint">${t('lv.noNames')}</p>`
    : b.standIns && b.nameProblem ? `
    <p class="hint">${t('lv.someStandIns')}</p>`
    : b.standIns ? `
    <p class="hint">${t('lv.someNoName')}</p>` : ''}`;
  }
  const note = state.note ? `<p class="hint" role="status">${esc(said(state.note))}</p>` : '';
  return `${head}${noStore ? `<p class="hint" id="line-bot-storage">${esc(said(noStore))}</p>` : ''}${steps}${link}${secret}${refresh}${ERR(state.refreshError)}
    <p class="hint field-status" role="status">${esc(status)}</p>${failed}${note}${list}${ERR(state.tickError)}`;
}

// Settings → Connections → LINE chats, under its switch: the exports part,
// the bot part, then the user's names and keywords, which both share.
export function lineSettingsHtml(l, { privacy = true, online = true, now = Date.now(), state = {}, bot: botState = {} } = {}) {
  // The demo shows its sample chats as Settings would, saving nothing.
  const sample = l?.demo ? `<p class="hint">${t('lv.demo')}</p>` : '';
  if (!l?.demo && !online) return `<p class="hint">${t('lv.preview')}</p>`;
  // Under the "Read my LINE chats" switch, on or off: why turning it on or off failed.
  const switchErr = ERR(state.switchError);
  // Off, with a relay link set or just removed: how to stop LINE sending to
  // it, as the bot's own switch says. The bot's off not finished is said
  // from the snapshot, so it stays said after Settings is reopened.
  if (!l?.enabled) {
    // From the snapshot, so a window opened afresh says the same; an off's
    // words only for an off taken (never while its data is still there).
    const offSaid = l?.bot?.unfinished ? notFinished(l.bot.unfinished, true) : l?.bot?.notStarted ? notStartedHtml()
      : state.stopped && !state.unfinished && !state.notStarted ? offWords(state) : '';
    // Not started: nothing of the bot's is off yet, so no advice on stopping LINE.
    return `${switchErr}${offSaid}${!l?.bot?.notStarted && (l?.bot?.linkSet || state.stopped) ? stopWords() : ''}`;
  }
  const err = state.error ? `<p class="form-error" role="alert">${esc(said(state.error))}</p>` : '';
  const folder = l.folder
    ? `<p class="field-set"><span>${privacy ? t('lv.folderChosen') : `${t('lv.folderLabel')} <span class="field-path">${esc(l.folder)}</span>`}</span>
        <button type="button" class="link-btn" data-line="choose-folder" id="line-folder">${t('lv.chooseAnother')}</button></p>`
    : `<div class="form-actions"><button type="button" class="button" data-line="choose-folder" id="line-folder">${t('lv.chooseFolder')}</button></div>`;
  const how = `<p class="hint">${t('lv.how')}</p>`;
  const exportsHead = `<h5 class="line-part-h" id="line-exports-h">${t('lv.savedChats')}</h5>`;
  const botPart = botSettingsHtml(l.bot, { privacy, state: botState, now, demo: Boolean(l.demo), online });
  const chats = l.chats ?? [];
  const exportsRead = chats.filter((c) => c.read && c.messages != null).length;
  let list;
  let words;
  const wordsHead = `<h5 class="line-part-h" id="line-words-h">${t('lv.wordsHead')}</h5>`;
  if (privacy) {
    // Counts only, each in its own part; one line says what is hidden.
    list = l.folder && chats.length ? `<p class="hint">${t('lv.chatsFound', { n: chats.length, read: exportsRead })}</p>` : '';
    words = `<p class="hint">${t('lv.namesKeywords', { names: tr('lv.names', { n: l.names?.length ?? 0 }), keywords: tr('lv.keywords', { n: l.keywords?.length ?? 0 }) })}</p>`;
  } else {
    list = !l.folder ? '' : !chats.length ? `<p class="hint">${l.folderError ? esc(folderWords(l.folderError)) : t('lv.noChatsInFolder')}</p>`
      : `<fieldset class="line-chats"><legend>${t('lv.chatsLegend')}</legend><ul>${chats.map((c, i) => `<li class="line-chat-row">
        <label class="check" for="line-read-${i}"><input type="checkbox" id="line-read-${i}" data-chat="${esc(c.chat)}"${c.read ? ' checked' : ''}> <span class="line-chat-name">${esc(chatName(c.chat))}</span></label>
        <span class="line-chat-what">${t('lv.exports', { n: c.files })}${c.read && c.messages != null ? ` · ${t('lv.messages', { n: c.messages })}` : ''}${c.problems ? ` · ${t('lv.problems', { n: c.problems })}` : ''}</span>
      </li>`).join('')}</ul></fieldset>`;
    words = `<form class="line-words" id="line-words-form">
        <label class="field" for="line-names">${t('lv.namesField')}
          <input id="line-names" autocomplete="off" spellcheck="false" value="${esc((l.names ?? []).join(', '))}"></label>
        <label class="field" for="line-keywords">${t('lv.keywordsField')}
          <input id="line-keywords" autocomplete="off" spellcheck="false" value="${esc((l.keywords ?? []).join(', '))}"></label>
        <div class="form-actions"><button type="submit" class="button" id="line-words-save">${t('lv.save')}</button></div>${ERR(state.wordsError)}
      </form>`;
  }
  // With no folder and no bot nothing has been read: no time to give.
  const reading = Boolean(l.folder || botOn(l.bot) || l.demo);
  const status = [reading ? (l.scannedAt ? tr('lv.readAt', { when: boardTime(l.scannedAt, now) }) : tr('lv.notRead')) : '', reading ? tr('lv.itemsFrom', { days: l.windowDays ?? 14 }) : '', said(state.note)].filter(Boolean).join(' · ');
  const statusP = status ? `<p class="hint" role="status">${esc(status)}</p>` : '';
  const exportsPart = `${exportsHead}${folder}${how}${err}${list}${privacy ? '' : ERR(state.tickError)}`;
  // Names and keywords count for both parts.
  const groups = botOn(l.bot) && l.bot.groups?.length;
  const hidden = privacy && reading
    ? `<p class="hint">${t(groups ? 'lv.privacyChatsGroups' : 'lv.privacyChats', { toggle: privacySwitch() })} <button type="button" class="link-btn inline" data-line="privacy" data-key="line-settings-privacy">${t('lv.privacySettings')}</button></p>` : '';
  const shared = reading ? `${wordsHead}${words}` : '';
  return `${switchErr}${sample}${hidden}${exportsPart}${botPart}${shared}${statusP}`;
}

// File names in words (line-bot-store.json.*.tmp) kept whole on one line,
// not broken at their hyphens. html: already escaped.
export function keepFileNames(html) {
  return String(html).replace(/\b[a-z]+(?:-[a-z]+)+\.json(?:\.\*\.tmp)?/g, (name) => `<span class="file-name">${name}</span>`);
}

// The closed Connections group's words for LINE: on or off, and counts only.
export function lineSummary(l) {
  if (!l?.enabled) return tr('lv.summaryOff');
  if (!l.demo && !l.folder && !botOn(l.bot)) return tr('lv.summaryNoFolder');
  return tr('lv.summaryRead', { n: l.readCount ?? 0 });
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
    for (const c of p.copies ?? []) add(tr('lv.copyOf', { name: p.name }), c.path);
  }
  for (const b of browsed) add(tr('lv.chosenFolder'), b);
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
  if (send?.busy) return { text: tr('lv.starting'), ok: true };
  return send?.status ? { text: said(send.status.text), ok: send.status.ok } : { text: '', ok: true };
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
  const fieldError = (what) => (errors[what] ? `<p class="field-error" id="line-${what}-err">${esc(said(errors[what]))}</p>` : '');
  let where;
  if (!targets) where = `<p class="hint">${t('lv.lookingTmux')}</p>`;
  else {
    const tmuxOk = Boolean(targets.sessions?.length);
    const target = send.target === 'wt' || !tmuxOk ? 'wt' : 'tmux';
    const session = tmuxOk && target === 'tmux'
      ? `<label class="field line-session" for="line-session">${t('lv.tmuxSession')}
          <select id="line-session">${targets.sessions.map((s) => `<option value="${esc(s)}"${s === send.session ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : '';
    where = `<label class="check" for="line-target-tmux"><input type="radio" name="line-target" value="tmux" id="line-target-tmux"${tmuxOk ? '' : ' disabled aria-describedby="line-tmux-why"'}${target === 'tmux' ? ' checked' : ''}> ${TERMINAL}${t('lv.newTmux')}</label>
      ${tmuxOk ? '' : `<p class="hint" id="line-tmux-why">${esc(said(targets.why) || tr('said.lc.noSession'))}</p>`}${session}
      <label class="check" for="line-target-wt"><input type="radio" name="line-target" value="wt" id="line-target-wt"${target === 'wt' ? ' checked' : ''}> ${TERMINAL}${t('lv.newTab')}</label>`;
  }
  return `<form class="line-send" id="line-send-form" data-key="${esc(send.key)}">
      <label class="field" for="line-prompt">${t('lv.promptField')}
        <textarea id="line-prompt" rows="12" maxlength="20000" spellcheck="false"${invalid('prompt')}>${esc(send.prompt)}</textarea></label>
      ${fieldError('prompt')}
      <p class="hint">${t('lv.askFirst')}</p>
      <div class="line-folder-row">
        <label class="field" for="line-cwd">${t('lv.folder')}
          <select id="line-cwd"${invalid('cwd')}><option value=""${send.cwd ? '' : ' selected'}>${t('lv.chooseAFolder')}</option>${opts}</select></label>
        ${fieldError('cwd')}
        <button type="button" class="link-btn" data-line="browse" id="line-browse">${t('lv.browse')}</button>
      </div>
      <fieldset class="field line-run"><legend>${t('lv.whereRuns')}</legend>${where}</fieldset>
      <div class="form-actions"><button type="submit" class="button" id="line-start"${!targets || send.busy ? ' disabled' : ''}>${send.busy ? t('lv.starting') : t('lv.startClaude')}</button></div>
    </form>`;
}
