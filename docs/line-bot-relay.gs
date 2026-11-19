/** @OnlyCurrentDoc */
/*
 * Agent's Home LINE relay (version 2)
 *
 * LINE sends your bot's group events here, and Agent's Home on your computer
 * collects them. Each event waits in the Inbox tab of this spreadsheet only
 * until Agent's Home has saved it; then this script deletes it. Anything not
 * collected within KEEP_DAYS is deleted anyway and counted as missed.
 *
 * Secrets, all under Project Settings > Script properties (run makeSecrets
 * once to make the first two):
 *   WEBHOOK_KEY    goes at the end of the webhook link you give LINE:
 *                  <this web app's link>?k=<WEBHOOK_KEY>
 *                  Apps Script cannot read LINE's signature header, so this
 *                  key stands in for it.
 *   READER_SECRET  goes into Agent's Home.
 *   LINE_TOKEN     optional: your channel access token. With it this script
 *                  looks up group and member names at api.line.me (the only
 *                  place it connects to). Without it events carry ids only.
 *
 * Only group and multi-person chat events of the kinds Agent's Home reads
 * are kept; one-to-one chats with the bot are not. Reply tokens are dropped.
 * This script never sends messages.
 *
 * Counts (shown by status, and to the app): MISSED events deleted unread
 * after KEEP_DAYS, REFUSED calls with a wrong key, NOT_JSON calls that were
 * not LINE's JSON, LOST events that could not be kept (the script was busy,
 * or the sheet failed). Calls from outside are counted in the Tally tab,
 * with no lock and no property write, so they cannot hold up LINE's calls
 * or use up the script's property quota; they are added up while the lock
 * is held.
 *
 * To stop: in the LINE Developers console turn off Use webhook (or remove
 * the bot from its groups), so LINE stops sending here. Google Sheets keeps
 * a version history, which can hold past messages: to remove them all,
 * delete this spreadsheet (and empty Drive's trash).
 */
const TAB = 'Inbox';
const TALLY = 'Tally';
const KEEP_DAYS = 14;
const BATCH = 500;
const FOLD = 5000;
const TALLY_MAX = 100000;
const TYPES = ['message', 'unsend', 'memberJoined', 'memberLeft', 'join', 'leave'];
const TALLIED = { refused: 'REFUSED', notJson: 'NOT_JSON', lost: 'LOST' };

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  if (e && e.parameter && e.parameter.k !== undefined) return fromLine_(e, props);
  return toApp_(e, props);
}

function doGet() {
  return reply_({ ok: false, error: 'not allowed' });
}

// LINE's webhook: keep the group events.
function fromLine_(e, props) {
  const key = props.getProperty('WEBHOOK_KEY') || '';
  if (key.length < 32 || !same_(String(e.parameter.k), key)) {
    tally_('refused', 1);
    return reply_({ ok: false, error: 'not allowed' });
  }
  let events = [];
  try {
    events = JSON.parse(e.postData.contents).events || [];
  } catch (err) {
    tally_('notJson', 1); // counted, shown by status() and to the app
    return reply_({ ok: false, error: 'not json' });
  }
  const kept = events.filter((ev) => ev && ev.source && (ev.source.type === 'group' || ev.source.type === 'room') && TYPES.indexOf(ev.type) >= 0);
  const token = kept.length ? props.getProperty('LINE_TOKEN') || '' : '';
  const ready = kept.map((ev) => {
    const copy = Object.assign({}, ev);
    delete copy.replyToken;
    // Names come only from this script's own lookups, never from the caller.
    delete copy._groupName;
    delete copy._senderName;
    delete copy._nameProblem;
    if (token) addNames_(copy, token);
    return copy;
  });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    if (!ready.length) return reply_({ ok: true }); // nothing to keep (LINE's Verify button sends no events)
    tally_('lost', ready.length);
    return reply_({ ok: false, error: 'busy' });
  }
  let pending = ready.length; // events not kept yet
  try {
    const sheet = inbox_();
    tidy_(sheet, props);
    if (!ready.length) return reply_({ ok: true });
    const seen = recentIds_(sheet);
    const now = new Date().toISOString();
    const out = [];
    for (const ev of ready) {
      const id = String(ev.webhookEventId || '');
      if (id && seen.has(id)) continue; // the same event delivered again
      if (id) seen.add(id);
      out.push([0, now, id, JSON.stringify(ev)]);
    }
    pending = out.length;
    if (!out.length) return reply_({ ok: true });
    // The numbers are taken before the rows are written: a write that fails
    // leaves a gap, never a number used twice.
    let seq = Number(props.getProperty('NEXT_SEQ') || '1');
    for (const row of out) row[0] = seq++;
    props.setProperty('NEXT_SEQ', String(seq));
    const start = sheet.getLastRow() + 1;
    const short = start + out.length - 1 - sheet.getMaxRows();
    if (short > 0) sheet.insertRowsAfter(sheet.getMaxRows(), short);
    sheet.getRange(start, 1, out.length, 4).setValues(out);
    pending = 0;
  } catch (err) {
    console.error('Events not kept: ' + err); // shown under Executions
    if (pending) tally_('lost', pending);
    return reply_({ ok: false, error: 'not kept' });
  } finally {
    lock.releaseLock();
  }
  return reply_({ ok: true });
}

// Agent's Home: forget what it has saved (seq up to upTo), send the rest.
function toApp_(e, props) {
  const secret = props.getProperty('READER_SECRET') || '';
  let body = {};
  try {
    body = JSON.parse(e.postData.contents) || {};
  } catch (err) {
    body = {}; // a request that is not JSON is refused just below
  }
  if (secret.length < 32 || !same_(String(body.secret || ''), secret)) return reply_({ ok: false, error: 'not allowed' });
  const upTo = Math.max(0, Math.floor(Number(body.upTo) || 0));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return reply_({ ok: false, error: 'busy' }); // the app asks again soon
  try {
    tidy_(null, props);
    const relay = relayId_(props);
    const next = Number(props.getProperty('NEXT_SEQ') || '1');
    if (upTo >= next) return reply_({ ok: false, error: 'cursor ahead', relay: relay });
    const sheet = inbox_();
    const last = sheet.getLastRow();
    const rows = last > 1 ? sheet.getRange(2, 1, last - 1, 4).getValues() : [];
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    let drop = 0;
    let missed = 0;
    while (drop < rows.length && (Number(rows[drop][0]) <= upTo || new Date(rows[drop][1]).getTime() < cutoff)) {
      if (Number(rows[drop][0]) > upTo) missed++;
      drop++;
    }
    removeTop_(sheet, 2, drop, rows.length);
    if (missed) bump_(props, 'MISSED', missed);
    const rest = rows.slice(drop);
    const events = rest.slice(0, BATCH).map((r) => {
      try {
        return { seq: Number(r[0]), received: String(r[1]), event: JSON.parse(String(r[3])) };
      } catch (err) {
        return { seq: Number(r[0]), received: String(r[1]), broken: true }; // the app counts these
      }
    });
    return reply_({
      ok: true,
      relay: relay,
      events: events,
      more: rest.length > BATCH,
      missed: count_(props, 'MISSED'),
      refused: count_(props, 'REFUSED'),
      notJson: count_(props, 'NOT_JSON'),
      lost: count_(props, 'LOST'),
    });
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor (Run > makeSecrets), then copy the secrets from Project Settings > Script properties. */
function makeSecrets() {
  const p = PropertiesService.getScriptProperties();
  const make = () => Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  p.setProperty('WEBHOOK_KEY', make());
  p.setProperty('READER_SECRET', make());
  relayId_(p);
  inbox_();
  tallySheet_();
  Logger.log('Saved WEBHOOK_KEY and READER_SECRET under Project Settings > Script properties.');
}

/** Run from the editor to see counts only (no message content). */
function status() {
  const p = PropertiesService.getScriptProperties();
  const n = Math.max(0, inbox_().getLastRow() - 1);
  const ever = Number(p.getProperty('NEXT_SEQ') || '1') - 1;
  const waiting = tallySheet_().getLastRow();
  Logger.log(
    'Waiting in Inbox: ' + n + '. Numbered since the start: ' + ever +
    '. Missed (deleted before collection): ' + count_(p, 'MISSED') +
    '. LINE calls refused (wrong key): ' + count_(p, 'REFUSED') +
    '. Unreadable LINE calls: ' + count_(p, 'NOT_JSON') +
    '. Events not kept (busy or a sheet error): ' + count_(p, 'LOST') +
    '. Tally rows not added up yet: ' + waiting +
    '. Names: ' + (p.getProperty('LINE_TOKEN') ? 'token set' : 'no token') + '.'
  );
}

function addNames_(ev, token) {
  const cache = CacheService.getScriptCache();
  const kind = ev.source.type; // 'group' or 'room'
  const id = kind === 'group' ? ev.source.groupId : ev.source.roomId;
  if (!id) return;
  if (kind === 'group') {
    const g = lookup_(cache, 'g:' + id, 'https://api.line.me/v2/bot/group/' + encodeURIComponent(id) + '/summary', token, 'groupName');
    if (g.name) ev._groupName = g.name;
    else if (g.problem) ev._nameProblem = g.problem;
  }
  if (ev.source.userId) {
    const url = 'https://api.line.me/v2/bot/' + kind + '/' + encodeURIComponent(id) + '/member/' + encodeURIComponent(ev.source.userId);
    const m = lookup_(cache, 'm:' + id + ':' + ev.source.userId, url, token, 'displayName');
    if (m.name) ev._senderName = m.name;
    else if (m.problem) ev._nameProblem = m.problem;
  }
}

function lookup_(cache, key, url, token, field) {
  const hit = cache.get(key);
  if (hit) return { name: hit };
  try {
    const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true, followRedirects: false });
    if (r.getResponseCode() !== 200) return { problem: 'HTTP ' + r.getResponseCode() };
    const name = String(JSON.parse(r.getContentText())[field] || '');
    if (name) cache.put(key, name, 21600);
    return { name: name };
  } catch (err) {
    return { problem: 'lookup failed' }; // carried on the event so the app can say names are missing
  }
}

function inbox_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(TAB);
  if (!sheet) {
    sheet = book.insertSheet(TAB);
    sheet.getRange('B:D').setNumberFormat('@'); // keep times and ids as text
    sheet.getRange(1, 1, 1, 4).setValues([['seq', 'received', 'event id', 'event']]);
  }
  return sheet;
}

// No header: a row written by a call that made the tab at the same moment
// as another is never written over.
function tallySheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(TALLY);
  if (sheet) return sheet;
  try {
    return book.insertSheet(TALLY);
  } catch (err) {
    return book.getSheetByName(TALLY); // made by another call just now
  }
}

// One row per count, appended without the lock: an append is whole on its
// own, so no count is lost, and nothing waits for LINE's calls. Past
// TALLY_MAX rows waiting (a flood of wrong-key calls) no more refused ones
// are added, so the spreadsheet cannot fill up: the count has risen enough
// to be said. LINE's own (notJson, lost) are always added.
function tally_(what, n) {
  try {
    const sheet = tallySheet_();
    if (what === 'refused' && sheet.getLastRow() >= TALLY_MAX) return;
    sheet.appendRow([what, n, new Date().toISOString()]);
  } catch (err) {
    console.error('Not counted (' + what + ' ' + n + '): ' + err); // shown under Executions
  }
}

// With the lock held: the counts brought up to date, and (with the Inbox)
// rows past KEEP_DAYS removed. A failure here never stops events being kept
// or collected; it is logged and tried again at the next call.
function tidy_(inbox, props) {
  try {
    fold_(props);
  } catch (err) {
    console.error('Counts not added up: ' + err);
  }
  if (!inbox) return;
  try {
    ageOut_(inbox, props);
  } catch (err) {
    console.error('Old rows not removed: ' + err);
  }
}

// The first Tally rows (at most FOLD at a time) added to the counts, then
// removed. Rows appended meanwhile come after them and wait for the next.
function fold_(props) {
  const sheet = tallySheet_();
  const total = sheet.getLastRow();
  if (!total) return;
  const rows = sheet.getRange(1, 1, Math.min(FOLD, total), 2).getValues();
  const sums = {};
  for (const r of rows) {
    const name = TALLIED[String(r[0])];
    if (name) sums[name] = (sums[name] || 0) + (Number(r[1]) || 0);
  }
  for (const name in sums) bump_(props, name, sums[name]);
  removeTop_(sheet, 1, rows.length, total);
}

// Inbox rows older than KEEP_DAYS go, counted as missed, on LINE's calls
// too, so they do not wait for the app to collect.
function ageOut_(sheet, props) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const times = sheet.getRange(2, 2, Math.min(BATCH, last - 1), 1).getValues();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let drop = 0;
  while (drop < times.length && new Date(times[drop][0]).getTime() < cutoff) drop++;
  if (!drop) return;
  removeTop_(sheet, 2, drop, last - 1);
  bump_(props, 'MISSED', drop);
}

// Removes the first `drop` of the `total` rows from row `first` on. A sheet
// keeps at least one row, so when all go they are cleared instead.
function removeTop_(sheet, first, drop, total) {
  if (!drop) return;
  if (drop === total) sheet.getRange(first, 1, drop, sheet.getLastColumn()).clearContent();
  else sheet.deleteRows(first, drop);
}

function recentIds_(sheet) {
  const last = sheet.getLastRow();
  const n = Math.min(500, Math.max(0, last - 1));
  if (!n) return new Set();
  return new Set(sheet.getRange(last - n + 1, 3, n, 1).getValues().map((r) => String(r[0])).filter(Boolean));
}

function relayId_(props) {
  let id = props.getProperty('RELAY_ID');
  if (!id) {
    id = Utilities.getUuid();
    props.setProperty('RELAY_ID', id);
  }
  return id;
}

function count_(props, name) {
  return Number(props.getProperty(name) || '0');
}

// Only with the lock held.
function bump_(props, name, by) {
  props.setProperty(name, String(count_(props, name) + (by || 1)));
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function reply_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
