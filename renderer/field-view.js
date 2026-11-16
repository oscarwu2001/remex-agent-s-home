// Field feedback: the field survey's answers, from the Google Sheet the
// main process reads (src/core/fieldsurvey.js). The board shows a summary
// line and three numbers; a sheet over the board shows each question's
// average and the newest comments. With privacy mode on (the default) only
// counts, scores and dates show: question wording, comments and chosen
// answers are the survey's own words, so they show only with privacy off,
// like Task descriptions. Names, emails and phone numbers never reach here.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DASH = '<span class="none"><span aria-hidden="true">–</span><span class="visually-hidden">none</span></span>';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "Mon 16 Nov, 08:01", or "08:01" today.
export function dayTime(ms, now = Date.now()) {
  const d = new Date(ms);
  if (ms == null || Number.isNaN(d.getTime())) return '';
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? `today ${t}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
}
const dayOnly = (ms) => (ms == null ? '' : new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));

export function age(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const mean1 = (v) => (v == null || !Number.isFinite(v) ? null : v.toFixed(1));

// What the section says before there is anything to count.
function setupStep(f) {
  if (!f.sheetUrl) return 'First paste the sheet’s link in Settings → Field feedback.';
  if (!f.keyName) return 'Now choose the service account’s key file in Settings → Field feedback.';
  return '';
}

// The section's body. f: snapshot.field. privacy: hide the survey's words.
export function fieldHtml(f, { now = Date.now() } = {}) {
  if (!f?.enabled) return '';
  const step = f.demo ? '' : setupStep(f);
  const settingsBtn = '<button type="button" class="link-btn small" id="field-goto" data-field="settings">Open Settings</button>';
  if (step) return `<p class="empty">Not set up yet. ${esc(step)}</p><div class="form-actions">${settingsBtn}</div>`;
  const s = f.summary;
  if (!s) {
    if (f.busy) return '<p class="empty" role="status">Reading the sheet…</p>';
    if (f.error) {
      return `<p class="form-error" role="alert">The sheet could not be read. ${esc(f.error)}</p>
        <div class="form-actions"><button type="button" class="button" id="field-try" data-field="refresh">Try again</button>${settingsBtn}</div>`;
    }
    return `<p class="empty">Waiting for the first read of the sheet.</p><button type="button" class="button" id="field-try" data-field="refresh">Read it now</button>`;
  }
  const line = [
    f.demo ? '<span class="tag">Sample</span>' : '',
    f.fetchedAt ? `Updated ${esc(dayTime(f.fetchedAt, now))} · ${esc(age(f.fetchedAt, now))}` : '',
    f.busy ? ' · <span role="status">refreshing…</span>' : '',
  ].join('');
  const failed = f.error
    ? `<p class="form-error field-warn" role="alert">The last update failed: ${esc(f.error)}</p>`
    : '';
  const avg = s.overall ? mean1(s.overall.mean) : null;
  const newLabel = f.sinceFetchedAt ? `New since ${esc(dayOnly(f.sinceFetchedAt))}` : 'New since last update';
  // Each label comes first for screen readers; the number shows above it.
  const stats = `<dl class="stats">
      <div class="stat"><dt class="stat-label">Responses</dt><dd class="stat-n">${s.responses}</dd></div>
      <div class="stat"><dt class="stat-label">Average score</dt><dd class="stat-n">${avg != null ? `${avg}<small> / ${s.overall.high}</small>` : DASH}</dd></div>
      <div class="stat"><dt class="stat-label">${newLabel}</dt><dd class="stat-n">${s.newSince != null ? s.newSince : DASH}</dd></div>
    </dl>`;
  return `<p class="field-line">${line}</p>${failed}${stats}
    <div class="form-actions"><button type="button" class="link-btn" id="field-open" data-field="open" aria-haspopup="dialog">See each question and the comments</button></div>`;
}

// The detail sheet's body.
export function fieldSheetHtml(f, { privacy = true, now = Date.now() } = {}) {
  const s = f?.summary;
  if (!s) return '<p class="empty">Nothing has been read from the sheet yet.</p>';
  const words = (text, fallback) => esc(privacy ? fallback : text);
  const range = s.newest
    ? `Answers from ${esc(dayOnly(Date.parse(s.oldest)))} to ${esc(dayTime(Date.parse(s.newest), now))}`
    : 'No answer has a date';
  const head = `<p class="field-line">${f.demo ? '<span class="tag">Sample</span>' : ''}${plural(s.responses, 'response')} · ${s.responses ? range : 'none yet'}${f.fetchedAt ? ` · read ${esc(age(f.fetchedAt, now))}` : ''}${!privacy && f.tab ? ` · tab “${esc(f.tab)}”` : ''}</p>`;

  const questions = s.questions.length
    ? `<ol class="field-qs">${s.questions.map((q, i) => {
      const m = mean1(q.mean);
      const pct = q.mean == null ? 0 : Math.round(((q.mean - q.low) / (q.high - q.low)) * 100);
      return `<li class="field-q">
        <p class="field-q-top"><span class="field-q-name">${words(q.question, `Question ${i + 1}`)}</span>
          <span class="field-q-n">${m != null ? `${m}<small> / ${q.high}</small>` : DASH}</span></p>
        <div class="meter" role="img" aria-label="${m != null ? `${m} of ${q.high}` : 'no answers'}"><span style="width:${pct}%"></span></div>
        <p class="muted">${plural(q.n, 'answer')} on a ${q.low}–${q.high} scale${q.unreadable ? ` · ${plural(q.unreadable, 'answer')} not readable` : ''}</p>
      </li>`;
    }).join('')}</ol>`
    : '<p class="empty">No question with scores was found yet.</p>';

  const hiddenNote = (what) => `<p class="hint">${what} Turn off “Hide file names and commands” (Settings → On screen) to read them.</p>`;
  let comments;
  if (!s.commentCount) comments = '<p class="empty">No comments yet.</p>';
  else if (privacy) comments = hiddenNote(`${plural(s.commentCount, 'comment')}, hidden.`);
  else {
    comments = `<ol class="field-comments">${s.comments.map((c) => `<li class="field-comment">
        <p class="field-comment-text">${esc(c.text)}</p>
        <p class="muted">${esc(c.question)}${c.at ? ` · ${esc(dayTime(Date.parse(c.at), now))}` : ''}</p></li>`).join('')}</ol>
      ${s.commentCount > s.comments.length ? `<p class="hint">The newest ${s.comments.length} of ${s.commentCount}. The rest are in the sheet.</p>` : ''}`;
  }

  let choices = '';
  if (s.choices?.length) {
    choices = `<h3 class="field-h">Chosen answers</h3>${privacy ? hiddenNote(`${plural(s.choices.length, 'multiple-choice question')}, hidden.`)
      : s.choices.map((c) => `<p class="field-choice"><span class="field-q-name">${esc(c.question)}</span>
          <span class="muted">${c.answers.map((a) => `${esc(a.answer)} ${a.count}`).join(' · ')}</span></p>`).join('')}`;
  }

  const left = [];
  if (s.identifying?.length) left.push(`${plural(s.identifying.length, 'column')} with names, emails or phone numbers ${s.identifying.length === 1 ? 'is' : 'are'} never shown.`);
  if (s.skipped?.length) {
    const why = { 'no answers': 'no answers yet', dates: 'dates', numbers: 'numbers that are not scores' };
    left.push(privacy ? `${plural(s.skipped.length, 'other column')} not summarised.`
      : `Not summarised: ${s.skipped.map((k) => `${esc(k.question)} (${esc(why[k.reason] ?? k.reason)})`).join(', ')}.`);
  }
  const unread = (s.unreadable?.scores ?? 0) + (s.unreadable?.timestamps ?? 0);
  if (unread) left.push(`${plural(unread, 'answer')} could not be read and ${unread === 1 ? 'is' : 'are'} left out (see Needs attention).`);

  return `${head}
    <h3 class="field-h">Average per question</h3>${questions}
    <h3 class="field-h">Newest comments</h3>${comments}
    ${choices}
    ${left.length ? `<h3 class="field-h">Not shown</h3>${left.map((t) => `<p class="hint">${t}</p>`).join('')}` : ''}`;
}

// Settings → Field feedback, below the switch. state: { editing, error, note }.
export function fieldSettingsHtml(f, { privacy = true, online = true, state = {}, now = Date.now() } = {}) {
  if (f?.demo) return '<p class="hint">The demo shows made-up sample feedback. Turn off “Demo patients” to set up your own sheet.</p>';
  if (!online) return '<p class="hint">The desktop app can read the sheet; this preview cannot.</p>';
  if (!f?.enabled) return '';
  const showLink = !f.sheetUrl || state.editing;
  const link = showLink
    ? `<form class="add-row" id="field-link-form">
        <label class="visually-hidden" for="field-link">Sheet link</label>
        <input id="field-link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…" value="${privacy ? '' : esc(f.sheetUrl)}">
        <button class="button" type="submit">Save</button></form>`
    : `<p class="field-set">${privacy ? 'A sheet link is saved.' : `Sheet: <span class="field-path">${esc(f.sheetUrl)}</span>`}
        <button type="button" class="link-btn" id="field-change" data-field="change-link">Change link</button></p>`;
  const key = f.keyName
    ? `<p class="field-set">${privacy ? 'A key file is chosen.' : `Key file: <span class="field-path">${esc(f.keyName)}</span>`}
        <button type="button" class="link-btn" id="field-key" data-field="choose-key">Choose another…</button></p>`
    : '<div class="form-actions"><button type="button" class="button" id="field-key" data-field="choose-key">Choose key file…</button></div>';
  const robot = f.clientEmail
    ? `<p class="hint">Share the sheet with <strong class="field-robot">${esc(f.clientEmail)}</strong> as Viewer.</p>` : '';
  const keyError = f.keyError ? `<p class="form-error" role="alert">${esc(f.keyError)}</p>` : '';
  const status = f.busy ? 'Reading the sheet…'
    : [f.fetchedAt ? `Last updated ${dayTime(f.fetchedAt, now)}` : 'Not read yet', f.nextAt && f.sheetUrl && f.keyName ? `next ${dayTime(f.nextAt, now)}` : ''].filter(Boolean).join(' · ');
  const lastError = f.error ? `<p class="form-error" role="alert">Last error${f.errorAt ? ` (${esc(dayTime(f.errorAt, now))})` : ''}: ${esc(f.error)}</p>` : '';
  return `${link}${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}
    ${key}${robot}${keyError}
    <div class="form-actions"><button type="button" class="button" id="field-refresh" data-field="refresh" ${f.sheetUrl && f.keyName ? '' : 'disabled'}>Refresh now</button></div>
    <p class="hint" role="status">${esc(status)}${state.note ? ` · ${esc(state.note)}` : ''}</p>${lastError}`;
}

// The mini window's line: new answers since the last update, if any.
export function fieldMiniText(f) {
  const n = f?.enabled ? f.summary?.newSince : null;
  return n ? `${plural(n, 'new field response')}` : '';
}
