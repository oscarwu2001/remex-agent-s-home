// Field feedback: the field survey's answers, from the Google Sheet the
// main process reads (src/core/fieldsurvey.js). The board shows a summary
// line and three numbers; a sheet over the board shows each question's
// average and the newest comments; Settings sets it up and has the one-time
// "Check the columns" step, where the user confirms what each column is.
// With privacy mode on (the default) only counts, scores and dates show:
// question wording, comments and chosen answers are the survey's own words
// and can name a site or a case, so they show only with privacy off, like
// Task descriptions. Identifying columns (names, emails, phones, patient or
// case numbers) are hidden whatever the setting: only how many there are
// is shown.

import { boardTime, boardDay } from './projects-view.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DASH = '<span class="none"><span aria-hidden="true">–</span><span class="visually-hidden">none</span></span>';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PRIVACY_SWITCH = '“Hide file names, commands and survey answers”';
export const ROLE_WORDS = {
  timestamp: 'When answered', score: 'Score', number: 'Number (not a score)', choice: 'Multiple choice',
  comment: 'Comment', identifying: 'Identifying (hidden)', ignore: 'Ignore',
};

export function age(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const mean1 = (v) => (v == null || !Number.isFinite(v) ? null : v.toFixed(1));
// Where an average sits on its scale, 0–100; 0 for a scale with one value.
const along = (q) => (q.mean == null || !(q.high > q.low) ? 0 : Math.max(0, Math.min(100, Math.round(((q.mean - q.low) / (q.high - q.low)) * 100))));

// "Question 3": a column's place among the columns that are not the
// timestamp, the label used while privacy mode hides the wording.
function questionNumbers(s) {
  return new Map((s?.columns ?? []).filter((c) => c.role !== 'timestamp').map((c, k) => [c.index, k + 1]));
}

const refreshBtn = (id, cls = 'button') => `<button type="button" class="${cls}" id="${id}" data-field="refresh">Refresh now</button>`;
const checkLink = (words) => `<button type="button" class="link-btn" id="field-check-link" data-field="check">${words}</button>`;

// What the section says before there is anything to count.
function setupStep(f) {
  if (!f.sheetUrl) return 'First paste the sheet’s link in Settings → Field feedback.';
  if (!f.keyName) return 'Now choose the service account’s key file in Settings → Field feedback.';
  return '';
}

// "Columns not checked yet": until the user has confirmed every column, the
// numbers are the app's guesses, and the board says so.
function checkNote(s) {
  if (!s || s.checked || !s.columns?.length) return '';
  const n = s.newColumns?.length ?? 0;
  const words = n ? `${n === 1 ? 'A new column is' : `${n} new columns are`} not checked yet.` : 'Columns not checked yet: these numbers are the app’s guesses.';
  return `<p class="field-note">${words} ${checkLink('Check the columns')}</p>`;
}

// The section's body. f: snapshot.field.
export function fieldHtml(f, { privacy = true, now = Date.now() } = {}) {
  if (!f?.enabled) return '';
  const step = f.demo ? '' : setupStep(f);
  if (step) {
    return `<p class="empty">Not set up yet. ${esc(step)}</p>
      <div class="form-actions"><button type="button" class="link-btn" id="field-goto" data-field="settings">Open Settings</button></div>`;
  }
  const s = f.summary;
  if (!s) {
    if (f.busy) return '<p class="empty" role="status">Updating…</p>';
    const why = f.summaryError ?? (f.error ? `The sheet could not be read. ${f.error}` : null);
    if (why) return `<p class="form-error" role="status">${esc(why)}</p><div class="form-actions">${refreshBtn('field-try')}</div>`;
    return `<p class="empty">Not updated yet.</p><div class="form-actions">${refreshBtn('field-try')}</div>`;
  }
  const updated = f.fetchedAt
    ? `<span title="Updated ${esc(boardTime(f.fetchedAt, now))}">Updated ${esc(age(f.fetchedAt, now))}</span>` : '';
  const line = [
    f.demo ? '<span class="tag">Sample</span>' : '',
    updated,
    f.busy ? ' · <span role="status">updating…</span>' : '',
  ].join('');
  const failed = f.error
    ? `<div class="field-failed"><p class="form-error" role="status">The last update failed: ${esc(f.error)}</p>${refreshBtn('field-try', 'link-btn')}</div>`
    : '';
  const avg = s.overall ? mean1(s.overall.mean) : null;
  const guessedOnly = !s.overall && s.scalesGuessed > 0;
  const newLabel = f.sinceFetchedAt ? `New since <span class="nowrap">${esc(boardDay(f.sinceFetchedAt))}</span>` : 'New since the last update';
  // Each label comes first for screen readers; the number shows above it.
  const stats = `<dl class="stats">
      <div class="stat"><dt class="stat-label">Responses</dt><dd class="stat-n">${s.responses}</dd></div>
      <div class="stat"><dt class="stat-label"${guessedOnly ? ' title="Every scale is a guess until the columns are checked"' : ''}>Average score</dt><dd class="stat-n">${avg != null ? `${avg}<small> / ${s.overall.high}</small>` : DASH}</dd></div>
      <div class="stat"><dt class="stat-label">${newLabel}</dt><dd class="stat-n">${s.newSince != null ? s.newSince : DASH}</dd></div>
    </dl>`;
  const open = s.responses
    ? `<div class="form-actions"><button type="button" class="link-btn" id="field-open" data-field="open" aria-haspopup="dialog">${privacy ? 'See the score for each question' : 'See each question and the comments'}</button></div>`
    : '';
  return `<p class="field-line">${line}</p>${failed}${checkNote(s)}${stats}${open}`;
}

// The detail sheet's body.
export function fieldSheetHtml(f, { privacy = true, now = Date.now() } = {}) {
  const s = f?.summary;
  if (!s) return '<p class="empty">Nothing has been updated from the sheet yet.</p>';
  const qNo = questionNumbers(s);
  const label = (q) => esc(privacy ? `Question ${qNo.get(q.index) ?? ''}`.trim() : q.question);
  const range = s.newest
    ? `answers from ${esc(boardDay(Date.parse(s.oldest)))} to ${esc(boardTime(Date.parse(s.newest), now))}`
    : 'no answer has a date';
  const head = `<p class="field-line">${f.demo ? '<span class="tag">Sample</span>' : ''}${plural(s.responses, 'response')} · ${s.responses ? range : 'none yet'}${f.fetchedAt ? ` · updated ${esc(age(f.fetchedAt, now))}` : ''}${!privacy && f.tab ? ` · tab “${esc(f.tab)}”` : ''}</p>`;
  const hint = privacy ? `<p class="hint">Question wording, comments and chosen answers are hidden while ${PRIVACY_SWITCH} is on (Settings → On screen).</p>` : '';

  const questions = s.questions.length
    ? `<ol class="field-qs">${s.questions.map((q) => {
      const m = mean1(q.mean);
      return `<li class="field-q">
        <p class="field-q-top"><span class="field-q-name">${label(q)}</span>
          <span class="field-q-n">${m != null ? `${m}<small> / ${q.high}</small>` : DASH}</span></p>
        <div class="meter" role="img" aria-label="${m != null ? `${m} of ${q.high}` : 'no answers'}"><span style="width:${along(q)}%"></span></div>
        <p class="muted">${plural(q.n, 'answer')} on a ${q.low}–${q.high} scale${q.guessed ? ' · <span class="field-guess">scale guessed</span>, not in the average' : ''}${q.unreadable ? ` · ${plural(q.unreadable, 'answer')} not readable` : ''}</p>
      </li>`;
    }).join('')}</ol>`
    : '<p class="empty">No question with scores was found yet.</p>';

  const numbers = s.numbers?.length
    ? `<h3 class="field-h">Numbers (not scores)</h3><ol class="field-qs">${s.numbers.map((q) => `<li class="field-q">
        <p class="field-q-top"><span class="field-q-name">${label(q)}</span><span class="field-q-n">${mean1(q.mean) ?? DASH}</span></p>
        <p class="muted">average of ${plural(q.n, 'answer')}${q.unreadable ? ` · ${plural(q.unreadable, 'answer')} not readable` : ''}</p></li>`).join('')}</ol>`
    : '';

  let comments;
  if (!s.commentCount) comments = '<p class="empty">No comments yet.</p>';
  else if (privacy) comments = `<p class="hint">${plural(s.commentCount, 'comment')}, hidden.</p>`;
  else {
    comments = `<ol class="field-comments">${s.comments.map((c) => `<li class="field-comment">
        <p class="field-comment-text">${esc(c.text)}</p>
        <p class="muted">${esc(c.question)}${c.at ? ` · ${esc(boardTime(Date.parse(c.at), now))}` : ''}</p></li>`).join('')}</ol>
      ${s.commentCount > s.comments.length ? `<p class="hint">The newest ${s.comments.length} of ${s.commentCount}. The rest are in the sheet.</p>` : ''}`;
  }

  let choices = '';
  if (s.choices?.length) {
    choices = `<h3 class="field-h">Chosen answers</h3>${privacy ? `<p class="hint">${plural(s.choices.length, 'multiple-choice question')}, hidden.</p>`
      : s.choices.map((c) => `<p class="field-choice"><span class="field-q-name">${esc(c.question)}</span>
          <span class="muted">${c.answers.map((a) => `${esc(a.answer)} ${a.count}`).join(' · ')}</span></p>`).join('')}`;
  }

  const left = [];
  if (s.identifying?.length) left.push(`${plural(s.identifying.length, 'column')} with names, emails, phone numbers or patient and case numbers ${s.identifying.length === 1 ? 'is' : 'are'} hidden.`);
  if (s.skipped?.length) {
    const why = { 'no answers': 'no answers yet', dates: 'dates', ignored: 'set to ignore' };
    left.push(privacy ? `${plural(s.skipped.length, 'other column')} not summarised.`
      : `Not summarised: ${s.skipped.map((k) => `${esc(k.question)} (${esc(why[k.reason] ?? k.reason)})`).join(', ')}.`);
  }
  const unread = (s.unreadable?.scores ?? 0) + (s.unreadable?.numbers ?? 0) + (s.unreadable?.timestamps ?? 0);
  if (unread) left.push(`${plural(unread, 'answer')} could not be read and ${unread === 1 ? 'is' : 'are'} left out (see Needs attention).`);

  return `${head}${hint}${checkNote(s)}
    <h3 class="field-h">Average per question</h3>${questions}
    ${numbers}
    <h3 class="field-h">Newest comments</h3>${comments}
    ${choices}
    ${left.length ? `<h3 class="field-h">Not shown</h3>${left.map((t) => `<p class="hint">${t}</p>`).join('')}` : ''}`;
}

// "Check the columns": one row per column, its suggested role preselected
// (or the one the user saved), editable. draft: { [index]: { role, low,
// high } } while the user changes them.
export function fieldColumnsHtml(f, { privacy = true, draft = {}, note = '', error = '' } = {}) {
  const s = f?.summary;
  if (!s?.columns?.length) return '';
  const qNo = questionNumbers(s);
  const todo = s.columns.filter((c) => !c.confirmed).length;
  const rows = s.columns.map((c) => {
    const d = draft[c.index] ?? {};
    const role = d.role ?? c.role;
    const low = d.low ?? c.low ?? c.suggested?.low ?? 1;
    const high = d.high ?? c.high ?? c.suggested?.high ?? 5;
    const name = privacy ? (c.role === 'timestamp' ? 'Timestamp' : `Question ${qNo.get(c.index)}`) : c.header;
    const tags = [
      c.isNew ? '<span class="tag">new column, not checked</span>' : '',
      draft[c.index] ? '<span class="tag">changed, not saved</span>' : !c.confirmed && !c.isNew ? '<span class="tag">suggested</span>' : '',
      role === 'score' && (d.role ? false : c.scaleFrom === 'answers') ? '<span class="tag">scale guessed</span>' : '',
      c.hidden && role !== 'identifying' ? '<span class="tag">answers show after the next update</span>' : '',
    ].join('');
    const opts = Object.entries(ROLE_WORDS).map(([v, w]) => `<option value="${v}"${v === role ? ' selected' : ''}>${w}</option>`).join('');
    const scale = role === 'score' ? `<span class="field-scale">
        <label>from <select id="fc-low-${c.index}" data-col="${c.index}" data-part="low">${[0, 1].map((v) => `<option${v === low ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>to <select id="fc-high-${c.index}" data-col="${c.index}" data-part="high">${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `<option${v === high ? ' selected' : ''}>${v}</option>`).join('')}</select></label></span>` : '';
    return `<li class="field-col${c.isNew ? ' is-new' : ''}">
      <p class="field-col-name"><span>${esc(name)}</span>${tags}</p>
      <div class="field-col-role"><label class="visually-hidden" for="fc-role-${c.index}">What ${esc(name)} is</label>
        <select id="fc-role-${c.index}" data-col="${c.index}" data-part="role">${opts}</select>${scale}</div>
      ${!privacy && c.answers === 0 ? '<p class="muted">No answers yet.</p>' : ''}</li>`;
  }).join('');
  return `<section class="field-check-step" aria-labelledby="field-check-h">
    <h4 id="field-check-h">Check the columns</h4>
    <p class="hint">${todo ? `${plural(todo, 'column')} not checked. ` : 'All columns checked. '}The app suggested what each column is; check each once. Your choice is kept, and a column added to the form later is flagged. Only scores with a checked scale, or one written in the question, count in the average.</p>
    ${privacy ? `<p class="hint">Question wording is hidden while ${PRIVACY_SWITCH} is on; turn it off to see it.</p>` : ''}
    <form id="field-check-form"><ol class="field-cols">${rows}</ol>
      <div class="form-actions"><button class="button" type="submit" id="field-check-save">Save the columns</button></div></form>
    ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}${note ? `<p class="hint" role="status">${esc(note)}</p>` : ''}
  </section>`;
}

// Settings → Field feedback, below the switch. state: { editing, error, note, draft, checkNote, checkError }.
export function fieldSettingsHtml(f, { privacy = true, online = true, state = {}, now = Date.now() } = {}) {
  if (f?.demo) {
    return `<p class="hint">The demo shows made-up sample feedback. Turn off “Demo patients” to set up your own sheet.</p>
      ${fieldColumnsHtml(f, { privacy, draft: state.draft, note: state.checkNote, error: state.checkError })}`;
  }
  if (!online) return '<p class="hint">The desktop app can read the sheet; this preview cannot.</p>';
  if (!f?.enabled) return '';
  const showLink = !f.sheetUrl || state.editing;
  const link = showLink
    ? `<form class="add-row" id="field-link-form">
        <label class="visually-hidden" for="field-link">Sheet link</label>
        <input id="field-link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…" value="${privacy ? '' : esc(f.sheetUrl)}">
        <button class="button" type="submit">Save</button></form>
        ${f.sheetUrl ? '<p class="hint">Leave it empty to keep the saved link.</p>' : ''}`
    : `<p class="field-set">${privacy ? 'A sheet link is saved.' : `Sheet: <span class="field-path">${esc(f.sheetUrl)}</span>`}
        <button type="button" class="link-btn" id="field-change" data-field="change-link">Change link</button></p>`;
  // One filled button at a time: Save until a link is saved, then the key.
  const key = f.keyName
    ? `<p class="field-set">${privacy ? 'A key file is chosen.' : `Key file: <span class="field-path">${esc(f.keyName)}</span>`}
        <button type="button" class="link-btn" id="field-key" data-field="choose-key">Choose another…</button></p>`
    : `<div class="form-actions"><button type="button" class="${f.sheetUrl ? 'button' : 'link-btn'}" id="field-key" data-field="choose-key">Choose key file…</button></div>`;
  const robot = f.clientEmail
    ? `<p class="field-set">${privacy ? 'Share the sheet with the key’s reader address as Viewer.' : `Share the sheet with <span class="field-robot">${esc(f.clientEmail)}</span> as Viewer.`}
        <button type="button" class="link-btn" id="field-copy" data-field="copy-reader">Copy reader address</button></p>` : '';
  const keyError = f.keyError ? `<p class="form-error" role="status">${esc(f.keyError)}</p>` : '';
  const ready = f.sheetUrl && f.keyName;
  const status = f.busy ? 'Updating…'
    : [f.fetchedAt ? `Updated ${boardTime(f.fetchedAt, now)}` : 'Not updated yet', f.nextAt && ready ? `next ${boardTime(f.nextAt, now)}` : ''].filter(Boolean).join(' · ');
  const lastError = f.error ? `<p class="form-error" role="status">Last update failed${f.errorAt ? ` (${esc(boardTime(f.errorAt, now))})` : ''}: ${esc(f.error)}${!privacy && f.errorDetail ? ` <span class="field-path">${esc(f.errorDetail)}</span>` : ''}</p>` : '';
  return `${link}${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}
    ${key}${robot}${keyError}
    ${ready ? `<div class="form-actions">${refreshBtn('field-refresh')}</div>` : ''}
    <p class="hint" role="status">${esc(status)}${state.note ? ` · ${esc(state.note)}` : ''}</p>${lastError}
    ${fieldColumnsHtml(f, { privacy, draft: state.draft, note: state.checkNote, error: state.checkError })}`;
}

// The roles to save from the step: every column, the draft over what shows.
export function rolesFrom(f, draft = {}) {
  return (f?.summary?.columns ?? []).map((c) => {
    const d = draft[c.index] ?? {};
    const role = d.role ?? c.role;
    const out = { header: c.header, index: c.index, role };
    if (role === 'score') {
      out.low = Number(d.low ?? c.low ?? c.suggested?.low ?? 1);
      out.high = Number(d.high ?? c.high ?? c.suggested?.high ?? 5);
    }
    return out;
  });
}

const FORM_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5h6v3H9zM7.5 5H5.5v15.5h13V5h-2M8.5 11h7M8.5 14.5h7M8.5 18h4"/></svg>';

// The mini window's badge: new answers since the last update, and "old"
// in words when the last update failed (the numbers are then that old).
export function fieldBadge(f, now = Date.now()) {
  if (!f?.enabled || !f.summary) return '';
  const n = f.summary.newSince ?? 0;
  const stale = Boolean(f.error);
  if (!n && !stale) return '';
  const when = f.fetchedAt ? `updated ${age(f.fetchedAt, now)}` : 'not updated yet';
  const words = `Field feedback: ${plural(n, 'new response')}, ${when}${stale ? '; the last update failed' : ''}`;
  return `<span class="badge badge-field${n ? '' : ' quiet'}" title="${esc(words)}">${FORM_ICON}<span aria-hidden="true">${n || ''}${stale ? `${n ? ' ' : ''}old` : ''}</span><span class="visually-hidden">${esc(words)}</span></span>`;
}
