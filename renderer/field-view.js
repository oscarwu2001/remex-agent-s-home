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
//
// The words come from the word tables when drawn, never when this module
// loads; what the main process said is put in the window's language with
// said(), the survey's own words never are.

import { boardTime, boardDay } from './dates.js';
import { tr, trHtml, raw, said } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = (key, params) => esc(tr(key, params));
const dash = () => `<span class="none"><span aria-hidden="true">–</span><span class="visually-hidden">${t('fv.none')}</span></span>`;
const privacySwitch = () => tr('common.quoted', { text: tr('settings.private') });
export const ROLE_WORDS = {
  get timestamp() { return tr('fv.role.timestamp'); },
  get score() { return tr('fv.role.score'); },
  get number() { return tr('fv.role.number'); },
  get choice() { return tr('fv.role.choice'); },
  get comment() { return tr('fv.role.comment'); },
  get identifying() { return tr('fv.role.identifying'); },
  get ignore() { return tr('fv.role.ignore'); },
};

export function age(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 2) return tr('time.justNow');
  if (m < 60) return tr('time.minAgo', { n: m });
  if (m < 48 * 60) return tr('time.hAgo', { n: Math.round(m / 60) });
  return tr('time.daysAgo', { n: Math.round(m / 1440) });
}

// A Needs attention line as the board draws it: the wording for the privacy
// state (a line that asks to turn privacy mode off has one without it), and
// how many times it came up.
export function problemLabel(p, { privacy = true } = {}) {
  const label = said(!privacy && p.labelPrivacyOff ? p.labelPrivacyOff : p.label);
  return p.count > 1 ? `${label} (×${p.count})` : label;
}

// A number below 0 with a true minus sign (“−1.5”), which reads as one.
const signed = (s) => String(s).replace(/^-/, '−');
const mean1 = (v) => (v == null || !Number.isFinite(v) ? null : signed(v.toFixed(1)));
// A scale in words: “1–5”, or “−3 to 3” for one around 0, where a dash
// would read as a second minus.
export const scaleText = (low, high) => (low < 0 ? tr('fv.scaleAround', { low: signed(low), high: signed(high) }) : `${low}–${high}`);
// What an average is out of: “/ 5”, or “on −3 to 3” for a scale around 0.
const outOf = (low, high) => (low < 0 ? tr('fv.onScale', { scale: scaleText(low, high) }) : `/ ${high}`);
// Where an average sits on its scale, 0–100; 0 for a scale with one value.
const along = (q) => (q.mean == null || !(q.high > q.low) ? 0 : Math.max(0, Math.min(100, Math.round(((q.mean - q.low) / (q.high - q.low)) * 100))));
// "Question 3", or "Question" alone when it has no number.
const questionWords = (n) => tr('fv.question', { n: n ?? '' }).trim();

// "Question 3": a column's place among the columns that are not the
// timestamp, the label used while privacy mode hides the wording.
function questionNumbers(s) {
  return new Map((s?.columns ?? []).filter((c) => c.role !== 'timestamp').map((c, k) => [c.index, k + 1]));
}

const refreshBtn = (id, cls = 'button') => `<button type="button" class="${cls}" id="${id}" data-field="refresh">${t('fix.refresh')}</button>`;
const checkLink = (words) => `<button type="button" class="link-btn" id="field-check-link" data-field="check">${esc(words)}</button>`;

// What the section says before there is anything to count.
function setupStep(f) {
  if (f.source === 'reader') {
    if (!f.readerUrl) return tr('fv.step.readerLink');
    if (!f.secretSaved) return tr('fv.step.readerSecret');
    return '';
  }
  if (!f.sheetUrl) return tr('fv.step.sheetLink');
  if (!f.keyName) return tr('fv.step.keyFile');
  return '';
}

// "Columns not checked yet": until the user has confirmed every column, the
// numbers are the app's guesses, and the board says so.
// A timestamp column chosen after the cache dropped its answers: its dates
// come back at the next read.
const waitNote = (s) => (s?.datesWaiting ? `<p class="field-note">${t('fv.datesWait')} <button type="button" class="link-btn" data-field="refresh">${t('fix.refresh')}</button></p>` : '');

// The note gives way to the flag that says the same (columns to choose).
const noteUnlessFlagged = (f) => (f?.flags?.list?.some((x) => x.what === 'choose') ? '' : checkNote(f?.summary));

function checkNote(s) {
  if (!s || s.checked || !s.columns?.length) return '';
  const n = s.newColumns?.length ?? 0;
  const words = n ? tr('fv.newNotChecked', { n }) : tr('fv.notChecked.columns');
  return `<p class="field-note">${esc(words)} <span class="nowrap">· ${checkLink(tr('fv.checkColumns'))}</span></p>`;
}

// The section's body. f: snapshot.field.
export function fieldHtml(f, { privacy = true, now = Date.now() } = {}) {
  if (!f?.enabled) return '';
  const step = f.demo ? '' : setupStep(f);
  if (step) {
    return `<p class="empty">${t('fv.notSetUp', { step })}</p>
      <div class="form-actions"><button type="button" class="link-btn" id="field-goto" data-field="settings">${t('fix.settings')}</button></div>`;
  }
  const s = f.summary;
  if (!s) {
    if (f.busy) return `<p class="empty" role="status">${t('fv.updating')}</p>`;
    const why = f.summaryError ? said(f.summaryError) : f.error ? tr('fv.sheetUnreadable', { why: said(f.error) }) : null;
    if (why) return `<p class="form-error" role="status">${esc(why)}</p><div class="form-actions">${refreshBtn('field-try')}</div>`;
    return `<p class="empty">${t('fv.notUpdated')}</p><div class="form-actions">${refreshBtn('field-try')}</div>`;
  }
  const updated = f.fetchedAt
    ? `<span title="${t('fv.updatedAt', { when: boardTime(f.fetchedAt, now) })}">${t('fv.updatedAt', { when: age(f.fetchedAt, now) })}</span>` : '';
  const line = [
    f.demo ? `<span class="tag">${t('fv.sample')}</span>` : '',
    updated,
    f.busy ? ` · <span role="status">${t('fv.updatingLower')}</span>` : '',
  ].join('');
  const failed = f.error
    ? `<div class="field-failed"><p class="form-error" role="status">${t('fv.lastFailed', { why: said(f.error) })}</p>${refreshBtn('field-try', 'link-btn')}</div>`
    : '';
  const avg = s.overall ? mean1(s.overall.mean) : null;
  // Why the average is a dash: guessed scales or directions, or new scores
  // not checked yet.
  const guesses = (s.scalesGuessed ?? 0) + (s.directionsGuessed ?? 0);
  const unchecked = s.scoresUnchecked ?? 0;
  const dashWhy = s.overall ? ''
    : guesses && unchecked ? tr('fv.dash.both')
      : guesses ? tr('fv.dash.guessed')
        : unchecked ? tr('fv.dash.new') : '';
  const newLabel = f.sinceFetchedAt ? trHtml('fv.newSinceHtml', { day: raw(`<span class="nowrap">${esc(boardDay(f.sinceFetchedAt))}</span>`) }) : t('fv.newSinceUpdate');
  // Each label comes first for screen readers; the number shows above it.
  // A scale around 0 goes in the label ("−1.0 on −3 to 3" is wider than a
  // stat), so every number stays one line and the labels share a baseline.
  const around0 = avg != null && (s.overall.low ?? 0) < 0;
  const avgLabel = around0 ? tr('fv.avgScoreOn', { scale: scaleText(s.overall.low, s.overall.high) }) : tr('fv.avgScore');
  const stats = `<dl class="stats">
      <div class="stat"><dt class="stat-label">${t('fv.responsesLabel')}</dt><dd class="stat-n">${s.responses}</dd></div>
      <div class="stat"${dashWhy ? ` title="${esc(dashWhy)}"` : ''}><dt class="stat-label">${esc(avgLabel)}</dt><dd class="stat-n">${avg != null ? `${avg}${around0 ? '' : `<small> ${outOf(0, s.overall.high)}</small>`}` : dash()}</dd></div>
      <div class="stat"><dt class="stat-label">${newLabel}</dt><dd class="stat-n">${s.newSince != null ? s.newSince : dash()}</dd></div>
    </dl>`;
  const open = s.responses
    ? `<div class="form-actions"><button type="button" class="link-btn" id="field-open" data-field="open" aria-haspopup="dialog">${privacy ? t('fv.openScores') : t('fv.openAll')}</button></div>`
    : '';
  // One problem, one place: while the error line shows, its flag is left out.
  const saidAbove = f.error ? ['share', 'failed'] : [];
  return `<p class="field-line">${line}</p>${failed}${noteUnlessFlagged(f)}${waitNote(s)}${stats}${flagsBlock(f, privacy, 'field-flags-h', saidAbove, now)}${open}`;
}

// The detail sheet's body.
export function fieldSheetHtml(f, { privacy = true, now = Date.now() } = {}) {
  const s = f?.summary;
  if (!s) return `<p class="empty">${t('fv.nothingYet')}</p>`;
  const qNo = questionNumbers(s);
  const label = (q) => esc(privacy ? questionWords(qNo.get(q.index)) : q.question);
  const range = s.newest
    ? tr('fv.range', { from: boardDay(Date.parse(s.oldest)), to: boardTime(Date.parse(s.newest), now) })
    : tr('fv.noDates');
  const head = `<p class="field-line">${f.demo ? `<span class="tag">${t('fv.sample')}</span>` : ''}${[
    tr('fv.responses', { n: s.responses }),
    s.responses ? range : tr('fv.noneYet'),
    f.fetchedAt ? tr('fv.updatedLower', { when: age(f.fetchedAt, now) }) : '',
    !privacy && f.tab ? tr('fv.tab', { tab: f.tab }) : '',
  ].filter(Boolean).map(esc).join(' · ')}</p>`;
  const hint = privacy ? `<p class="hint">${trHtml('fv.privacyHintHtml', { toggle: privacySwitch() })}</p>` : '';

  const questions = s.questions.length
    ? `<ol class="field-qs">${s.questions.map((q) => {
      const m = mean1(q.mean);
      // Higher is worse: tagged, and its bar shows what it counts as
      // (low + high - average), so every bar means how good.
      const counts = q.worse && q.mean != null ? q.low + q.high - q.mean : null;
      const ofScale = q.low < 0 ? outOf(q.low, q.high) : tr('fv.ofHigh', { high: q.high });
      const tags = [
        q.notChecked ? `<span class="field-guess">${t('fv.notCheckedTag')}</span>${t('fv.notInAverage')}` : q.guessed ? `<span class="field-guess">${t('fv.scaleGuessedTag')}</span>${t('fv.notInAverage')}` : '',
        q.notChecked ? '' : q.directionGuessed ? `<span class="field-guess">${t('fv.directionGuessedTag')}</span>${t('fv.notInAverage')}` : q.worse ? `${t('fv.higherWorse')}${counts != null ? t('fv.countsInAverage', { value: mean1(counts) }) : ''}` : '',
        q.unreadable ? t('fv.notReadable', { n: q.unreadable }) : '',
      ].filter(Boolean).map((x) => ` · ${x}`).join('');
      return `<li class="field-q">
        <p class="field-q-top"><span class="field-q-name">${label(q)}${q.worse ? ` <span class="tag">${t('fv.higherWorseTag')}</span>` : ''}</span>
          <span class="field-q-n">${m != null ? `${m}<small> ${outOf(q.low, q.high)}</small>` : dash()}</span></p>
        <div class="meter" role="img" aria-label="${esc(m != null ? `${m} ${ofScale}${counts != null ? tr('fv.countsAs', { value: mean1(counts) }) : ''}` : tr('fv.noAnswers'))}"><span style="width:${along(counts != null ? { ...q, mean: counts } : q)}%"></span></div>
        <p class="muted">${t('fv.answersOnScale', { n: q.n, scale: scaleText(q.low, q.high) })}${tags}</p>
      </li>`;
    }).join('')}</ol>`
    : `<p class="empty">${t('fv.noScoredQuestion')}</p>`;

  const numbers = s.numbers?.length
    ? `<h3 class="field-h">${t('fv.numbersHead')}</h3><ol class="field-qs">${s.numbers.map((q) => `<li class="field-q">
        <p class="field-q-top"><span class="field-q-name">${label(q)}</span><span class="field-q-n">${mean1(q.mean) ?? dash()}</span></p>
        <p class="muted">${t('fv.averageOf', { n: q.n })}${q.unreadable ? ` · ${t('fv.notReadable', { n: q.unreadable })}` : ''}</p></li>`).join('')}</ol>`
    : '';

  let comments;
  if (!s.commentCount) comments = `<p class="empty">${t('fv.noComments')}</p>`;
  else if (privacy) comments = `<p class="hint">${t('fv.commentsHidden', { n: s.commentCount })}</p>`;
  else {
    comments = `<ol class="field-comments">${s.comments.map((c) => `<li class="field-comment">
        <p class="field-comment-text">${esc(c.text)}</p>
        <p class="muted">${esc(c.question)}${c.at ? ` · ${esc(boardTime(Date.parse(c.at), now))}` : ''}</p></li>`).join('')}</ol>
      ${s.commentCount > s.comments.length ? `<p class="hint">${t('fv.newestOf', { shown: s.comments.length, total: s.commentCount })}</p>` : ''}`;
  }

  let choices = '';
  if (s.choices?.length) {
    choices = `<h3 class="field-h">${t('fv.choicesHead')}</h3>${privacy ? `<p class="hint">${t('fv.choicesHidden', { n: s.choices.length })}</p>`
      : s.choices.map((c) => `<p class="field-choice"><span class="field-q-name">${esc(c.question)}</span>
          <span class="muted">${c.answers.map((a) => `${esc(a.answer)} ${a.count}`).join(' · ')}</span></p>`).join('')}`;
  }

  const left = [];
  if (s.identifying?.length) left.push(t('fv.identifyingHidden', { n: s.identifying.length }));
  if (s.skipped?.length) {
    const why = { 'no answers': 'fv.skip.noAnswers', dates: 'fv.skip.dates', 'times of day': 'fv.skip.times', ignored: 'fv.skip.ignored', json: 'fv.skip.json', 'record id': 'fv.skip.recordId' };
    left.push(privacy ? t('fv.otherNotSummarised', { n: s.skipped.length })
      : t('fv.notSummarised', { list: s.skipped.map((k) => tr('fv.skippedItem', { question: k.question, why: why[k.reason] ? tr(why[k.reason]) : k.reason })).join(tr('common.listSep')) }));
  }
  const unread = (s.unreadable?.scores ?? 0) + (s.unreadable?.numbers ?? 0) + (s.unreadable?.timestamps ?? 0);
  if (unread) left.push(t('fv.unreadLeftOut', { n: unread }));
  const doubt = s.doubtful?.length ?? 0;
  if (doubt) left.push(t('fv.doubtHidden', { n: doubt }));

  return `${head}${hint}${flagsBlock(f, privacy, 'field-h', [], now)}${noteUnlessFlagged(f)}${waitNote(s)}
    <h3 class="field-h">${t('fv.averageHead')}</h3>${questions}
    ${numbers}
    <h3 class="field-h">${t('fv.commentsHead')}</h3>${comments}
    ${choices}
    ${left.length ? `<h3 class="field-h">${t('fv.notShownHead')}</h3>${left.map((x) => `<p class="hint">${x}</p>`).join('')}` : ''}`;
}

// Each row of "Check the columns" as it stands: the role and scale shown
// (the user's draft over what the app has) and whether the user still has
// to choose. A low-confidence guess (c.needsChoice) is never preselected,
// and a scale is preselected only when the user confirmed it or the
// question states it; anything else waits for the user, and Save with it.
// The direction (worse) too: the saved one stays; a row the user turns into
// a score, or whose title speaks of pain or difficulty (c.askDirection), is
// asked; only the app's own sure score starts on "Higher is better".
export function stepRows(f, draft = {}) {
  return (f?.summary?.columns ?? []).map((c) => {
    const d = draft[c.index] ?? {};
    // A saved role stays chosen while only its direction is asked.
    const role = d.role || (c.needsChoice && !c.confirmed ? '' : c.role);
    const sure = c.role === 'score' && (c.scaleFrom === 'confirmed' || c.scaleFrom === 'header');
    const low = role === 'score' ? (d.low ?? (sure ? c.low : null)) : null;
    const high = role === 'score' ? (d.high ?? (sure ? c.high : null)) : null;
    // Higher is worse: the user's choice, else the saved one; null while asked.
    const saved = c.confirmed && c.role === 'score' && !c.askDirection;
    let worse = null;
    if (role === 'score') {
      if (d.worse !== undefined) worse = d.worse;
      else if (saved) worse = c.worse === true;
      else if (d.role !== 'score' && !c.askDirection) worse = c.worse === true;
    }
    const missing = !role || (role === 'score' && (low == null || high == null || worse == null));
    return { c, role, low, high, worse, missing, touched: Object.keys(d).length > 0 };
  });
}

// The draft after one select changed. Going back to an empty choice drops
// that part, so it is missing again rather than saved as 0.
export function draftWith(draft, col, part, value) {
  const row = { ...draft[col] };
  if (value === '' || value == null) delete row[part];
  else row[part] = part === 'role' ? value : part === 'worse' ? value === 'worse' || value === true : Number(value);
  return { ...draft, [col]: row };
}

// The app's guess for a row the user has to choose, in words.
function guessWords(c) {
  const g = c.suggested ?? {};
  const words = ROLE_WORDS[g.role] ?? g.role ?? '';
  return g.role === 'score' && g.low != null ? `${tr('fv.guessScore', { words, scale: scaleText(g.low, g.high) })}${g.worse ? tr('fv.commaHigherWorse') : ''}` : words;
}

function rowTags(r) {
  const { c } = r;
  return [
    r.missing ? tr('fv.tag.needsChoice') : r.touched ? tr('fv.tag.changed') : '',
    r.missing && c.needsChoice && !c.confirmed && c.suggested?.role === 'score' && c.suggested.scaleFrom === 'answers' ? tr('fv.tag.scaleGuessed') : '',
    c.askDirection && (r.role === 'score' ? r.worse == null : r.missing && c.suggested?.role === 'score') ? tr('fv.tag.directionGuessed') : '',
    c.isNew ? tr('fv.tag.new') : '',
    c.repeated ? tr('fv.tag.repeated') : '',
    c.hidden && !c.doubt && r.role && r.role !== 'identifying' && r.role !== 'ignore' ? tr('fv.tag.answersLater') : '',
    c.doubt ? tr('fv.tag.doubt') : '',
  ].filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join('');
}

// "Higher is better" or "Higher is worse", with "Choose direction…" until one is.
const directionOpts = (worse) => `${worse == null ? `<option value="" selected>${t('fv.chooseDirection')}</option>` : ''}<option value="better"${worse === false ? ' selected' : ''}>${t('fv.higherBetterTag')}</option><option value="worse"${worse === true ? ' selected' : ''}>${t('fv.higherWorseTag')}</option>`;
const directionWords = (r) => (r.role !== 'score' ? '' : r.worse == null ? tr('fv.commaNoDirection') : r.worse ? tr('fv.commaHigherWorse') : tr('fv.commaHigherBetter'));
// A value below 0 carries its own value, as its words have a true minus;
// a chosen value not in the list (saved, or stated by the question) is
// added, so what shows is what is saved.
const scaleOpts = (values, chosen) => {
  const list = chosen == null || values.includes(chosen) ? values : [...values, chosen].sort((a, b) => a - b);
  return `${chosen == null ? `<option value="" selected>${t('fv.choose')}</option>` : ''}${list.map((v) => `<option${v < 0 ? ` value="${v}"` : ''}${v === chosen ? ' selected' : ''}>${signed(v)}</option>`).join('')}`;
};
const LOWS = [-5, -4, -3, -2, -1, 0, 1];
// From 2, or from 1 for a scale that starts below 0 (−1 to 1).
const highsFor = (low) => [...(low != null && low < 0 ? [1] : []), 2, 3, 4, 5, 6, 7, 8, 9, 10];

// "Check the columns": one row per column. With privacy off each row has
// its role to choose (and a score its scale); Save is refused until every
// row has one. With privacy on the step only reads: the choices name the
// survey's own columns, so they are made with the wording in view.
// draft: { [index]: { role, low, high, worse } } while the user changes them.
export function fieldColumnsHtml(f, { privacy = true, draft = {}, note = '', error = '' } = {}) {
  // The reply to the last Save, whatever is drawn with it.
  const reply = `${error ? `<p class="form-error" role="alert">${esc(said(error))}</p>` : ''}${note ? `<p class="hint" role="status">${esc(said(note))}</p>` : ''}`;
  const s = f?.summary;
  if (!s?.columns?.length) return reply;
  const qNo = questionNumbers(s);
  const rows = stepRows(f, draft);
  const missing = rows.filter((r) => r.missing).length;
  const nameOf = (c) => (privacy ? (c.role === 'timestamp' ? tr('fv.timestamp') : questionWords(qNo.get(c.index))) : c.header);
  // A saved score asked again only for its direction: the guess is that.
  const guess = (r) => (r.missing && r.c.needsChoice && r.c.suggested ? `<p class="muted">${t('fv.guess', { what: r.c.confirmed ? tr('fv.higherWorse') : guessWords(r.c) })}</p>` : '');
  const left = missing ? tr('fv.stillNeed', { n: missing }) : '';
  const head = `<h5 id="field-check-h" tabindex="-1">${t('fv.checkColumns')}</h5>`;

  if (privacy) {
    const items = rows.map((r) => {
      const what = r.role ? `${ROLE_WORDS[r.role] ?? r.role}${r.role === 'score' && r.low != null && r.high != null ? tr('fv.commaScale', { scale: scaleText(r.low, r.high) }) : ''}${directionWords(r)}` : tr('fv.notChosen');
      return `<li class="field-col">
        <p class="field-col-name"><span>${esc(nameOf(r.c))}</span>${rowTags(r)}</p>
        <p class="field-col-what">${esc(what)}</p>${guess(r)}</li>`;
    }).join('');
    return `<section class="field-check-step" aria-labelledby="field-check-h">${head}
    <p class="hint">${t('fv.guessed')}${left ? ` ${esc(left)}` : ''}</p>
    <p class="hint">${trHtml('fv.privacyCheckHtml', { toggle: privacySwitch() })}
      <button type="button" class="link-btn" id="field-goto-switch" data-field="privacy-switch">${t('fv.gotoSwitch')}</button></p>
    <ol class="field-cols">${items}</ol>${reply}
  </section>`;
  }

  const items = rows.map((r) => {
    const { c } = r;
    const name = nameOf(c);
    const opts = (r.role ? '' : `<option value="" selected>${t('fv.choose')}</option>`)
      + Object.keys(ROLE_WORDS).map((v) => `<option value="${v}"${v === r.role ? ' selected' : ''}>${esc(ROLE_WORDS[v])}</option>`).join('');
    const scale = r.role === 'score' ? `<span class="field-scale">
        <label>${t('fv.from')} <select id="fc-low-${c.index}" data-col="${c.index}" data-part="low" aria-label="${t('fv.ariaFrom', { name })}">${scaleOpts(LOWS, r.low)}</select></label>
        <label>${t('fv.to')} <select id="fc-high-${c.index}" data-col="${c.index}" data-part="high" aria-label="${t('fv.ariaTo', { name })}">${scaleOpts(highsFor(r.low), r.high)}</select></label></span>
        <select id="fc-worse-${c.index}" data-col="${c.index}" data-part="worse" aria-label="${t('fv.ariaWorse', { name })}">${directionOpts(r.worse)}</select>` : '';
    return `<li class="field-col${r.missing ? ' needs-choice' : ''}">
      <p class="field-col-name"><span>${esc(name)}</span>${rowTags(r)}</p>
      <div class="field-col-role"><label class="visually-hidden" for="fc-role-${c.index}">${t('fv.whatIs', { name })}</label>
        <select id="fc-role-${c.index}" data-col="${c.index}" data-part="role">${opts}</select>${scale}</div>
      ${guess(r)}${c.answers === 0 && !c.hidden ? `<p class="muted">${t('fv.noAnswersYet')}</p>` : ''}</li>`;
  }).join('');
  return `<section class="field-check-step" aria-labelledby="field-check-h">${head}
    <p class="hint">${t('fv.guessedChange')}</p>
    <form id="field-check-form"><ol class="field-cols">${items}</ol>
      <div class="form-actions"><button class="button" type="submit" id="field-check-save"${missing ? ' disabled aria-describedby="field-check-left"' : ''}>${t('fv.saveColumns')}</button>
        <p class="hint" id="field-check-left" role="status">${esc(left)}</p></div></form>
    ${reply}
  </section>`;
}

// "How to connect": the reader script (its link and secret) or a Google key
// file, with ids so a redraw keeps focus on the one chosen. Switching starts
// afresh, so with checked columns it asks first, and says then what goes
// (pending: the one picked, shown chosen while asking); each button names
// the way it leads to. Without protected storage for a secret the reader
// cannot be chosen, and the choice says why.
function sourceChoice(f, source, state) {
  const shown = state.pendingSource ?? source;
  const noStore = f.secretStorage ? String(f.secretStorage) : '';
  const option = (value, words) => {
    const off = value === 'reader' && noStore && source !== 'reader';
    return `<label class="check" for="field-source-${value}"><input type="radio" name="field-source" id="field-source-${value}" value="${value}"${shown === value ? ' checked' : ''}${off ? ' disabled' : ''}> ${esc(words)}</label>`;
  };
  const pending = state.pendingSource && state.pendingSource !== source ? state.pendingSource : null;
  const ask = pending
    ? `<div class="field-confirm" role="group" aria-labelledby="field-source-ask">
        <p class="field-confirm-text" id="field-source-ask" role="status">${t('fv.switchAsk')}</p>
        <div class="form-actions"><button type="button" class="button" id="field-source-switch" data-field="switch-source">${t(pending === 'key' ? 'fv.switchToKey' : 'fv.switchToReader')}</button>
          <button type="button" class="link-btn" id="field-source-keep" data-field="keep-source">${t(source === 'reader' ? 'fv.keepReader' : 'fv.keepKey')}</button></div></div>`
    : '';
  return `<fieldset class="field field-source"${noStore ? ' aria-describedby="field-source-storage"' : ''}><legend>${t('fv.howToConnect')}</legend>
      ${option('reader', tr('fv.sourceReader'))}
      ${option('key', tr('fv.sourceKey'))}${noStore ? `
      <p class="hint" id="field-source-storage">${esc(said(noStore))}</p>` : ''}</fieldset>${state.sourceError ? `
    <p class="form-error" id="field-source-err" role="alert">${esc(said(state.sourceError))}</p>` : ''}${ask}`;
}

// One labelled field with its Save (button: its words), its error tied to it
// (aria-invalid, aria-describedby) after a Save it refused. Opened over a
// saved value, it has Cancel (cancel: its action; cancelLabel: what it
// cancels, for screen readers). Save, and Cancel when offered, go on their
// own row under the field when there is a Cancel, and always for a link
// (ownRow), so a link field is full width in every state and its whole
// example shows.
function entryForm({ id, label, input, value = null, error, hint = '', button = tr('lv.save'), filled = true, cancel = '', cancelLabel = '', ownRow = false }) {
  const err = error ? `<p class="form-error" id="${id}-err" role="alert">${esc(said(error))}</p>` : '';
  const hintP = hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : '';
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ');
  const field = `<input id="${id}" ${input}${value != null ? ` value="${esc(value)}"` : ''}${error ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}>`;
  const save = `<button class="${filled ? 'button' : 'link-btn'}" type="submit">${esc(button)}</button>`;
  const cancelBtn = cancel ? `
        <button type="button" class="link-btn" data-field="${cancel}" aria-label="${esc(cancelLabel || tr('common.cancel'))}">${t('common.cancel')}</button>` : '';
  const row = cancel || ownRow
    ? `<div class="add-row">${field}</div>
      <div class="form-actions field-entry-actions">${save}${cancelBtn}</div>`
    : `<div class="add-row">${field}
        ${save}</div>`;
  return `<form class="field-entry" id="${id}-form" novalidate>
      <label class="field-entry-label" for="${id}">${esc(label)}</label>
      ${row}${err}${hintP}</form>`;
}

// A link typed but refused is kept as typed for the next try, but not past
// privacy mode turning on or Settings closing: it may hold a sheet's id.
// The refusals about it go with it. Changes state in place and returns it.
export function dropFieldDrafts(state) {
  return Object.assign(state, { linkDraft: null, linkError: '', readerDraft: null, readerError: '' });
}

// A saved link's field: what it starts with (the refused draft, else the
// saved link with privacy off, else empty). Opened over a saved link it
// has Cancel, the way back to it; saving it empty keeps it too, unsaid.
const linkValue = (saved, draft, privacy) => (draft != null ? draft : privacy ? '' : saved);

// The reader route: the set-up step and Copy reader script, its web app
// link, its secret. The secret never comes back from the main process:
// once saved, only "Secret saved" and Replace secret. -> { html, open: a
// field's Save is the filled button, shown: which fields are open, and
// noStorage when no Secret field can be drawn at all }.
function readerSettings(f, { privacy, state }) {
  const script = `<ol class="field-steps">
      <li>${t('fv.readerStep1')}</li>
      <li>${t('fv.readerStep2')}</li>
      <li>${t('fv.readerStep3')}</li>
      <li>${t('fv.readerStep4')}</li>
    </ol>
    <div class="form-actions"><button type="button" class="link-btn" id="field-copy-script" data-field="copy-script">${t('fv.copyScript')}</button></div>${state.scriptNote ? `
    <p class="hint" role="status">${esc(said(state.scriptNote))}</p>` : ''}${state.scriptError ? `
    <p class="form-error" role="alert">${esc(said(state.scriptError))}</p>` : ''}`;
  const linkOpen = !f.readerUrl || state.readerEditing;
  const typed = linkValue(f.readerUrl, state.readerDraft, privacy);
  const link = linkOpen
    ? entryForm({
      id: 'field-reader-link', label: tr('fv.readerLink'), error: state.readerError, value: typed, button: tr('lv.saveLink'),
      input: `type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${t('lv.endsInExec')}"`, cancel: f.readerUrl ? 'cancel-reader' : '',
      cancelLabel: tr('lv.cancelLink'), ownRow: true,
    })
    : `<p class="field-set"><span>${privacy ? t('fv.readerSaved') : `${t('fv.readerLabel')} <span class="field-path">${esc(f.readerUrl)}</span>`}</span>
        <button type="button" class="link-btn" id="field-reader-change" data-field="change-reader">${t('lv.changeLink')}</button></p>`;
  const secretOpen = !f.secretSaved || state.secretEditing;
  let secret;
  // No protected storage: no Secret field and no Replace secret (it would
  // open onto nothing), only one line on what is so; the reason is said
  // once, under How to connect.
  if (f.secretStorage && f.secretSaved) secret = `<p class="field-set"><span>${t('fv.secretNoOpen')}</span></p>`;
  else if (f.secretStorage) secret = `<p class="field-set"><span>${t('fv.secretNoKeep')}</span></p>`;
  else if (secretOpen) {
    // The second field's Save is plain until the link is saved: one filled button at a time.
    secret = entryForm({
      id: 'field-secret', label: tr('lv.secret'), error: state.secretError, button: tr('lv.saveSecret'), filled: Boolean(f.readerUrl) && !linkOpen,
      input: 'type="password" autocomplete="new-password" spellcheck="false" placeholder="READER_SECRET"', cancel: f.secretSaved ? 'cancel-secret' : '',
      cancelLabel: tr('lv.cancelSecret'), ownRow: true,
      hint: state.secretNote ? esc(said(state.secretNote)) : t('lv.secretKept'),
    });
  } else {
    secret = `<p class="field-set"><span>${t('lv.secretSaved')}</span>
        <button type="button" class="link-btn" id="field-secret-replace" data-field="replace-secret">${t('lv.replaceSecret')}</button></p>`;
  }
  return { html: `${script}${link}${secret}`, open: linkOpen || (secretOpen && !f.secretStorage), shown: { secretOpen: secretOpen && !f.secretStorage, linkOpen, noStorage: Boolean(f.secretStorage) } };
}

// A message from the main process as Settings shows it: errorHere and
// keyErrorHere name the control in view there, where the board's name the
// Settings path. They hold one wording per way the Secret and link fields
// can be drawn, open ('1') or folded behind Replace secret and Change link
// ('0'), and for the secret not drawn at all without protected storage
// ('n'), secret first (fieldsurvey.js settingsWords); this picks the one
// drawn. A snapshot without them shows the message as it is. After "Last
// update failed:" it reads on in lower case, a name excepted.
const inView = (words, message, { secretOpen, linkOpen, noStorage = false }) => (words && typeof words === 'object' && words[`${noStorage ? 'n' : secretOpen ? 1 : 0}${linkOpen ? 1 : 0}`]) || message;
const NAMES = /^(?:Google|Apps Script|READER_SECRET|TAB|Windows|LINE)\b/;
const readOn = (m) => (NAMES.test(m) ? m : `${m.charAt(0).toLowerCase()}${m.slice(1)}`);

// Settings → Connections → Field feedback, below the switch. state: { editing, error, note, draft, checkNote, checkError,
// linkError, linkDraft, readerEditing, readerError, readerDraft, secretEditing, secretError, secretNote,
// scriptNote, scriptError, sourceError, pendingSource }.
export function fieldSettingsHtml(f, { privacy = true, online = true, state = {}, now = Date.now() } = {}) {
  if (f?.demo) {
    return `<p class="hint">${t('fv.demo')}</p>
      ${fieldColumnsHtml(f, { privacy, draft: state.draft, note: state.checkNote, error: state.checkError })}`;
  }
  if (!online) return `<p class="hint">${t('fv.preview')}</p>`;
  if (!f?.enabled) return '';
  const source = f.source === 'reader' ? 'reader' : 'key';
  // Switching is being asked: its Switch is the one filled action.
  const asking = Boolean(state.pendingSource && state.pendingSource !== source);
  // open: a field is open (or switching is asked), so its button is the one
  // filled action and Refresh now steps back.
  // shown: which of the Secret and link fields are open as drawn.
  const common = (ready, fieldOpen, shown) => {
    const open = fieldOpen || asking;
    const status = f.busy ? tr('fv.updating')
      : [f.fetchedAt ? tr('fv.updatedAt', { when: boardTime(f.fetchedAt, now) }) : tr('fv.notUpdatedYet'), f.nextAt && ready ? tr('lv.nextAt', { when: boardTime(f.nextAt, now) }) : ''].filter(Boolean).join(' · ');
    const why = f.error ? readOn(said(inView(f.errorHere, f.error, shown))) : '';
    const lastError = f.error ? `<p class="form-error" role="status">${f.errorAt ? t('fv.lastUpdateFailedAt', { when: boardTime(f.errorAt, now), why }) : t('fv.lastUpdateFailed', { why })}${!privacy && f.errorDetail ? ` <span class="field-path">${esc(f.errorDetail)}</span>` : ''}</p>` : '';
    return `${ready ? `<div class="form-actions">${refreshBtn('field-refresh', open ? 'link-btn' : 'button')}</div>` : ''}
    <p class="hint field-status" role="status">${esc(status)}${state.note ? ` · ${esc(said(state.note))}` : ''}</p>${lastError}
    ${fieldColumnsHtml(f, { privacy, draft: state.draft, note: state.checkNote, error: state.checkError })}`;
  };
  if (source === 'reader') {
    const reader = readerSettings(f, { privacy, state });
    return `${sourceChoice(f, source, state)}${reader.html}${state.error ? `<p class="form-error" role="alert">${esc(said(state.error))}</p>` : ''}
    ${common(Boolean(f.readerUrl && f.secretSaved && !f.secretStorage), reader.open, reader.shown)}`;
  }
  const showLink = !f.sheetUrl || state.editing;
  const typed = linkValue(f.sheetUrl, state.linkDraft, privacy);
  const link = showLink
    ? entryForm({
      id: 'field-link', label: tr('fv.sheetLink'), error: state.linkError, value: typed, button: tr('lv.saveLink'),
      input: 'type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…"', cancel: f.sheetUrl ? 'cancel-link' : '',
      cancelLabel: tr('lv.cancelLink'), ownRow: true,
    })
    : `<p class="field-set"><span>${privacy ? t('fv.sheetSaved') : `${t('fv.sheetLabel')} <span class="field-path">${esc(f.sheetUrl)}</span>`}</span>
        <button type="button" class="link-btn" id="field-change" data-field="change-link">${t('lv.changeLink')}</button></p>`;
  // One filled button at a time: Save while the link is open, then the key.
  const key = f.keyName
    ? `<p class="field-set"><span>${privacy ? t('fv.keyChosen') : `${t('fv.keyLabel')} <span class="field-path">${esc(f.keyName)}</span>`}</span>
        <button type="button" class="link-btn" id="field-key" data-field="choose-key">${t('said.fs.chooseAnother')}</button></p>`
    : `<div class="form-actions"><button type="button" class="${f.sheetUrl && !showLink ? 'button' : 'link-btn'}" id="field-key" data-field="choose-key">${t('said.fs.chooseKeyFile')}</button></div>`;
  const robot = f.clientEmail
    ? `<p class="field-set"><span>${privacy ? t('fv.shareWithKey') : trHtml('fv.shareWithHtml', { email: raw(`<span class="field-robot">${esc(f.clientEmail)}</span>`) })}</span>
        <button type="button" class="link-btn" id="field-copy" data-field="copy-reader">${t('fv.copyAddress')}</button></p>` : '';
  const shown = { secretOpen: true, linkOpen: showLink };
  const keyError = f.keyError ? `<p class="form-error" role="status">${esc(said(inView(f.keyErrorHere, f.keyError, shown)))}</p>` : '';
  // Older snapshots name no source: no choice to show.
  return `${f.source ? sourceChoice(f, source, state) : ''}${link}${state.error ? `<p class="form-error" role="alert">${esc(said(state.error))}</p>` : ''}
    ${key}${robot}${keyError}
    ${common(Boolean(f.sheetUrl && f.keyName), showLink, shown)}`;
}

// The roles to save from the step: every row the user has a choice for,
// and how many still have none (the app refuses to save while any do).
export function rolesFrom(f, draft = {}) {
  const rows = stepRows(f, draft);
  const roles = rows.filter((r) => !r.missing).map(({ c, role, low, high, worse }) => ({
    header: c.header, index: c.index, role, ...(role === 'score' ? { low, high, worse } : {}),
  }));
  return { roles, missing: rows.length - roles.length };
}

// ---- flags -------------------------------------------------------------------------------------
//
// What needs a look in the last 7 days (src/core/fieldsurvey.js fieldFlags
// works them out; here they are only worded). One glyph per kind, so a
// flag never rests on colour alone; with privacy on a question is only
// ever "Question N".

const FLAG_GLYPHS = {
  low: '<path d="M12 4v10.5M7.5 10 12 14.5 16.5 10M6 19h12"/>', // down to the floor
  falling: '<path d="M4 7.5l5.5 5.5 3.5-3.5 6.5 6.5M20 11.5V16h-4.5"/>', // a line going down
  rising: '<path d="M4 16.5l5.5-5.5 3.5 3.5 6.5-6.5M20 12.5V8h-4.5"/>', // a line going up (higher is worse)
  comments: '<path d="M5 5.5h14v10h-8.5L6 19v-3.5H5z"/>', // a speech bubble
  setup: '<path d="M12 4.5 20.5 19h-17zM12 10v4M12 16.5v.5"/>', // a warning sign
};
const flagGlyph = (kind) => `<svg class="ico flag-glyph flag-${kind}" viewBox="0 0 24 24" aria-hidden="true">${FLAG_GLYPHS[kind] ?? FLAG_GLYPHS.setup}</svg>`;
// What a flag or a Needs attention line links to (app.js fieldAction).
// A fix link's words, in the window's language.
export const FIXES = {
  get check() { return tr('fix.check'); },
  get settings() { return tr('fix.settings'); },
  get refresh() { return tr('fix.refresh'); },
};
const SETUP_WORDS = {
  // saved: the columns were saved before (the column is new, or asked again);
  // more: new columns besides, that need no choice but are not checked yet.
  choose: (n, saved, more = 0) => tr(!saved ? 'fv.flag.choose' : !more ? 'fv.flag.chooseSaved' : more === 1 ? 'fv.flag.chooseSavedMore1' : 'fv.flag.chooseSavedMore', { n, more }),
  undated: (n) => tr('fv.flag.undated', { n }),
  doubt: (n) => tr('fv.flag.doubt', { n }),
  share: () => tr('fv.flag.share'),
  failed: () => tr('fv.flag.failed'),
  key: () => tr('fv.flag.key'),
};

// One flag in words. days: the window's length.
// saved: the columns were saved at least once.
export function flagText(flag, { privacy = true, days = 7, saved = false, more = 0 } = {}) {
  const name = privacy || !flag.question ? questionWords(flag.no) : tr('common.quoted', { text: flag.question });
  const when = tr('fv.lastDays', { days });
  if (flag.kind === 'low') {
    return tr(flag.worse ? 'fv.flag.high' : 'fv.flag.low', { n: flag.count, name, when, mark: signed(flag.mark), scale: scaleText(flag.low, flag.high) });
  }
  if (flag.kind === 'falling') {
    const scale = flag.low < 0 ? outOf(flag.low, flag.high) : tr('fv.ofHigh', { high: flag.high });
    return tr(flag.worse ? 'fv.flag.up' : 'fv.flag.down', { name, recent: mean1(flag.recentMean), scale, when, earlier: mean1(flag.earlierMean) });
  }
  if (flag.kind === 'comments') return tr('fv.flag.comments', { n: flag.count, when });
  return (SETUP_WORDS[flag.what] ?? (() => tr('fv.flag.other')))(flag.count ?? 0, saved, more);
}

// Why the window could not be compared, in words.
const WHY_WORDS = {
  unread: () => t('fv.why.unread'),
  empty: () => t('fv.why.empty'),
  waiting: () => t('fv.why.waiting'),
  quiet: (info, days) => (info.newest ? t('fv.why.quietNewest', { days, day: boardDay(Date.parse(info.newest)) }) : t('fv.why.quiet', { days })),
  'no-dates': () => t('fv.why.noDates'),
};
// A reason's own fix, on a line of its own like a flag's.
const WHY_FIX = { 'no-dates': 'check' };

// f.flags: { why, earlier, list } from the main process. "Nothing to flag"
// only when the window was compared; otherwise why it was not, with any
// set-up flags below. Nothing at all when no flags were worked out (an
// older snapshot).
// said: set-up flags another line of the section already says.
export function flagsHtml(f, { privacy = true, said: already = [], now = Date.now() } = {}) {
  const info = f?.flags;
  if (!info || !Array.isArray(info.list)) return '';
  const list = info.list.filter((x) => !already.includes(x.what));
  const days = f.summary?.window?.days ?? 7;
  const fixOf = (why) => (WHY_FIX[why] ? `<p class="field-fix"><button type="button" class="link-btn" data-field="${WHY_FIX[why]}">${FIXES[WHY_FIX[why]]}</button></p>` : '');
  const why = info.why ? `<p class="field-calm">${(WHY_WORDS[info.why] ?? WHY_WORDS.unread)(info, days)}</p>${fixOf(info.why)}` : '';
  const scored = (f.summary?.questions ?? []).some((q) => q.confirmed && !q.guessed && !q.directionGuessed);
  const saved = f.summary?.saved === true;
  // The note above the numbers gives way to the choose flag, so the flag
  // counts the other new columns too.
  const more = saved ? (f.summary?.columns ?? []).filter((c) => c.isNew && !c.needsChoice).length : 0;
  const noEarlier = !info.why && !info.earlier && scored ? `<p class="field-calm">${t('fv.noEarlier', { days })}</p>` : '';
  // After a failed update the answers are older than they look.
  const calm = f.error && f.fetchedAt ? tr('fv.calmAt', { when: age(f.fetchedAt, now) }) : tr('fv.calm');
  // Scores never checked are not compared (the note above the numbers says
  // so): with none checked, there is nothing to call calm.
  if (!list.length) return why || (info.unchecked > 0 && !scored ? '' : `<p class="field-calm">${esc(calm)}</p>${noEarlier}`);
  const items = list.map((x) => {
    const fix = x.fix && FIXES[x.fix] ? `<button type="button" class="link-btn" data-field="${x.fix}">${FIXES[x.fix]}</button>` : '';
    const glyph = x.kind === 'falling' && x.worse ? 'rising' : x.kind;
    return `<li class="field-flag">${flagGlyph(glyph)}<span class="field-flag-text">${esc(flagText(x, { privacy, days, saved, more }))}</span>${fix}</li>`;
  }).join('');
  return `${why}<ul class="field-flags">${items}</ul>${noEarlier}`;
}
// The block with its heading, when it has anything to say. While dates are
// waiting the note above says so, so the block shows only for set-up flags.
const flagsBlock = (f, privacy, cls, already = [], now = Date.now()) => {
  const info = f?.flags;
  if (!info || !Array.isArray(info.list)) return '';
  const body = info.why === 'waiting'
    ? flagsHtml({ ...f, flags: { ...info, why: null, earlier: true, list: info.list.filter((x) => !already.includes(x.what)) } }, { privacy, now })
    : flagsHtml(f, { privacy, said: already, now });
  return body ? `<h3 class="${cls}">${t('fv.flagsHead')}</h3>${body}` : '';
};

const FORM_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5h6v3H9zM7.5 5H5.5v15.5h13V5h-2M8.5 11h7M8.5 14.5h7M8.5 18h4"/></svg>';

// The mini window's badge: new answers since the last update, and "old"
// in words when the last update failed (the numbers are then that old).
export function fieldBadge(f, now = Date.now()) {
  if (!f?.enabled || !f.summary) return '';
  const n = f.summary.newSince ?? 0;
  const stale = Boolean(f.error);
  if (!n && !stale) return '';
  const when = f.fetchedAt ? tr('fieldBadge.updated', { age: age(f.fetchedAt, now) }) : tr('fieldBadge.notYet');
  const words = `${tr('fieldBadge.words', { n, when })}${stale ? tr('fieldBadge.failed') : ''}`;
  return `<span class="badge badge-field${n ? '' : ' quiet'}" title="${esc(words)}">${FORM_ICON}<span aria-hidden="true">${n || ''}${stale ? `${n ? ' ' : ''}${esc(tr('fieldBadge.old'))}` : ''}</span><span class="visually-hidden">${esc(words)}</span></span>`;
}
