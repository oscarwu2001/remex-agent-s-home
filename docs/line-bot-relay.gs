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
 * This script keeps them in its cache for KEY_CACHE_S seconds, so a flood of
 * calls with a wrong key or none reads the script's properties at most once
 * in that time. Keys made by makeSecrets take effect at once; one you edit
 * by hand under Script properties takes up to KEY_CACHE_S seconds (or run
 * makeSecrets again for new keys).
 *
 * Only group and multi-person chat events of the kinds Agent's Home reads
 * are kept; one-to-one chats with the bot are not. Reply tokens are dropped,
 * and so are names a caller sends. This script never sends messages.
 *
 * Counts (shown by status, and to the app): MISSED events deleted after
 * KEEP_DAYS before the app was sent them, REFUSED calls with a wrong key or
 * none, NOT_JSON calls with the key that were not LINE's JSON, LOST events
 * that could not be kept (the script was busy, or the sheet failed), and
 * CAPPED, how often refused calls came so fast that the Tally tab was full
 * (then the refused count is at least what it says). Calls are counted in
 * the Tally tab, with no lock and, for refused ones, no property read or
 * write; when the sheet itself fails, LINE's own counts wait as TALLY_
 * properties. The app's calls add them up.
 *
 * A flood of calls can still delay or drop LINE's events: Apps Script runs
 * at most 30 calls of a script at once. If that happens, make a new
 * deployment (Deploy > New deployment) and give its link to LINE's webhook
 * (with ?k=) and to Agent's Home's Relay link; the old link then stops.
 *
 * To stop: in the LINE Developers console turn off Use webhook (or remove
 * the bot from its groups), so LINE stops sending here. Google Sheets keeps
 * a version history, which can hold past messages: to remove them all,
 * delete this spreadsheet, then empty Drive's trash.
 */
const TAB = 'Inbox';
const TALLY = 'Tally';
const KEEP_DAYS = 14;
const BATCH = 500;
const FOLD = 5000;
const TALLY_MAX = 100000;
const KEY_CACHE_S = 600;
const TYPES = ['message', 'unsend', 'memberJoined', 'memberLeft', 'join', 'leave'];
// Tally rows -> the counts they add to. 'unchecked': LINE-looking events
// that came when the key could not be read at all.
const TALLIED = { refused: 'REFUSED', notJson: 'NOT_JSON', lost: 'LOST', unchecked: 'LOST', capped: 'CAPPED' };
// Kinds anyone can cause: capped, and never written to a property.
const OUTSIDE = { refused: true, unchecked: true };

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
  let key;
  try {
    key = secret_('WEBHOOK_KEY', props);
  } catch (err) {
    console.error('Webhook key not read: ' + err); // shown under Executions
    tally_('unchecked', eventsIn_(e));
    return reply_({ ok: false, error: 'busy' });
  }
  if (key.length < 32 || !same_(String(e.parameter.k), key)) {
    tally_('refused', 1);
    return reply_({ ok: false, error: 'not allowed' });
  }
  let events = null;
  try {
    events = JSON.parse(e.postData.contents).events;
  } catch (err) {
    events = null; // counted just below, with any body whose events are not a list
  }
  if (!Array.isArray(events)) {
    tally_('notJson', 1);
    return reply_({ ok: false, error: 'not json' });
  }
  const kept = events.filter((ev) => ev && ev.source && (ev.source.type === 'group' || ev.source.type === 'room') && TYPES.indexOf(ev.type) >= 0);
  let token = '';
  let nameless = false;
  if (kept.length) {
    try {
      token = secret_('LINE_TOKEN', props);
    } catch (err) {
      console.error('LINE_TOKEN not read: ' + err);
      nameless = true;
    }
  }
  const ready = kept.map((ev) => {
    const copy = Object.assign({}, ev);
    delete copy.replyToken;
    // Names come only from this script's own lookups, never from the caller.
    delete copy._groupName;
    delete copy._senderName;
    delete copy._nameProblem;
    if (nameless) copy._nameProblem = 'lookup failed';
    else if (token) {
      try {
        addNames_(copy, token);
      } catch (err) {
        copy._nameProblem = 'lookup failed'; // the app says names are missing
      }
    }
    return copy;
  });
  let lock = null;
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) lock = null;
  } catch (err) {
    console.error('Lock not taken: ' + err);
    lock = null;
  }
  if (!lock) {
    if (!ready.length) return reply_({ ok: true }); // nothing to keep (LINE's Verify button sends no events)
    tally_('lost', ready.length);
    return reply_({ ok: false, error: 'busy' });
  }
  let pending = ready.length; // events not kept yet
  try {
    const sheet = inbox_();
    try {
      ageOut_(sheet, props);
    } catch (err) {
      console.error('Old rows not removed: ' + err); // tried again at the next call
    }
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
    console.error('Events not kept: ' + err);
    tally_('lost', pending);
    return reply_({ ok: false, error: 'not kept' });
  } finally {
    lock.releaseLock();
  }
  return reply_({ ok: true });
}

// Agent's Home: forget what it has saved (seq up to upTo), send the rest.
function toApp_(e, props) {
  let body = null;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = null; // refused just below
  }
  // Not the app's call (LINE's body at a link without ?k=, or anything else): counted, with no property read.
  if (!body || typeof body !== 'object' || typeof body.secret !== 'string') {
    tally_('refused', 1);
    return reply_({ ok: false, error: 'not allowed' });
  }
  let secret;
  try {
    secret = secret_('READER_SECRET', props);
  } catch (err) {
    console.error('Reader secret not read: ' + err);
    return reply_({ ok: false, error: 'busy' }); // the app asks again soon
  }
  if (secret.length < 32 || !same_(body.secret, secret)) return reply_({ ok: false, error: 'not allowed' });
  const upTo = Math.max(0, Math.floor(Number(body.upTo) || 0));
  let lock = null;
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) lock = null;
  } catch (err) {
    console.error('Lock not taken: ' + err);
    lock = null;
  }
  if (!lock) return reply_({ ok: false, error: 'busy' }); // the app asks again soon
  try {
    try {
      fold_(props);
    } catch (err) {
      console.error('Counts not added up: ' + err); // they wait for the next call
    }
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
      if (Number(rows[drop][0]) > upTo) missed++; // the app asks from before it: not saved
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
    if (events.length) props.setProperty('HANDED', String(events[events.length - 1].seq));
    const all = props.getProperties();
    const count = (name) => Number(all[name] || '0');
    return reply_({
      ok: true,
      relay: relay,
      events: events,
      more: rest.length > BATCH,
      missed: count('MISSED'),
      refused: count('REFUSED'),
      notJson: count('NOT_JSON'),
      lost: count('LOST'),
      capped: count('CAPPED'),
    });
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor (Run > makeSecrets), then copy the secrets from Project Settings > Script properties. */
function makeSecrets() {
  const p = PropertiesService.getScriptProperties();
  const make = () => Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const keys = { WEBHOOK_KEY: make(), READER_SECRET: make() };
  for (const name in keys) p.setProperty(name, keys[name]);
  // In use at once, not only when the cached ones run out.
  const cache = cache_();
  if (cache) for (const name in keys) cache.put(name, keys[name], KEY_CACHE_S);
  relayId_(p);
  inbox_();
  tallySheet_();
  Logger.log('Saved WEBHOOK_KEY and READER_SECRET under Project Settings > Script properties.');
}

/** Run from the editor to see counts only (no message content). */
function status() {
  const p = PropertiesService.getScriptProperties();
  const all = p.getProperties();
  const count = (name) => Number(all[name] || '0');
  const n = Math.max(0, inbox_().getLastRow() - 1);
  const waiting = tallySheet_().getLastRow() + Object.keys(all).filter((k) => k.indexOf('TALLY_') === 0).length;
  Logger.log(
    'Waiting in Inbox: ' + n + '. Numbered since the start: ' + (count('NEXT_SEQ') - 1) +
    '. Missed (deleted before collection): ' + count('MISSED') +
    '. Calls refused (wrong key or none): ' + count('REFUSED') + (count('CAPPED') ? ' or more' : '') +
    '. Unreadable LINE calls: ' + count('NOT_JSON') +
    '. Events not kept (busy or a sheet error): ' + count('LOST') +
    '. Counts not added up yet: ' + waiting +
    '. Names: ' + (all.LINE_TOKEN ? 'token set' : 'no token') + '.'
  );
}

// A key, a secret or the token: from the script's cache, else from its
// properties (then cached for KEY_CACHE_S). '-' stands for none in the cache.
function secret_(name, props) {
  const cache = cache_();
  if (cache) {
    try {
      const hit = cache.get(name);
      if (hit !== null && hit !== undefined) return hit === '-' ? '' : hit;
    } catch (err) {
      console.error('Cache not read: ' + err); // the property is read instead
    }
  }
  const value = props.getProperty(name) || '';
  if (cache) {
    try {
      cache.put(name, value || '-', KEY_CACHE_S);
    } catch (err) {
      console.error('Cache not written: ' + err); // read from the properties again next time
    }
  }
  return value;
}

function cache_() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    console.error('Cache not available: ' + err);
    return null;
  }
}

// How many group events a body holds, when the key could not be checked.
function eventsIn_(e) {
  try {
    const events = JSON.parse(e.postData.contents).events;
    return Array.isArray(events) ? events.filter((ev) => ev && ev.source && (ev.source.type === 'group' || ev.source.type === 'room')).length : 0;
  } catch (err) {
    return 0; // not LINE's: nothing of LINE's lost
  }
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
  try {
    const hit = cache.get(key);
    if (hit) return { name: hit };
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
// TALLY_MAX rows waiting (a flood) no more of the kinds anyone can cause are
// added, so the spreadsheet cannot fill up; a 'capped' row marks it once.
// When the sheet fails, LINE's own counts wait as TALLY_<what>_<id>
// properties (unique names: no count is lost to another call); the kinds
// anyone can cause never touch the properties.
function tally_(what, n) {
  if (!n) return;
  try {
    const sheet = tallySheet_();
    const last = sheet.getLastRow();
    if (OUTSIDE[what] && last >= TALLY_MAX) {
      if (sheet.getRange(last, 1).getValue() !== 'capped') sheet.appendRow(['capped', 1, new Date().toISOString()]);
      return;
    }
    sheet.appendRow([what, n, new Date().toISOString()]);
    return;
  } catch (err) {
    console.error('Not counted in the Tally tab (' + what + ' ' + n + '): ' + err); // shown under Executions
  }
  if (OUTSIDE[what]) return;
  try {
    PropertiesService.getScriptProperties().setProperty('TALLY_' + what + '_' + Utilities.getUuid(), String(n));
  } catch (err) {
    console.error('Not counted (' + what + ' ' + n + '): ' + err);
  }
}

// With the lock held, on the app's calls: the counts that wait (TALLY_
// properties, then the first FOLD Tally rows) added up and removed. Rows
// appended meanwhile come after them and wait for the next call.
function fold_(props) {
  const sums = {};
  const add = (what, n) => {
    const name = TALLIED[what];
    if (name) sums[name] = (sums[name] || 0) + (Number(n) || 0);
  };
  const all = props.getProperties();
  const spare = Object.keys(all).filter((k) => k.indexOf('TALLY_') === 0);
  for (const k of spare) add(k.split('_')[1], all[k]);
  let sheet = null;
  let total = 0;
  let rows = [];
  try {
    sheet = tallySheet_();
    total = sheet.getLastRow();
    if (total) rows = sheet.getRange(1, 1, Math.min(FOLD, total), 2).getValues();
  } catch (err) {
    console.error('Tally tab not read: ' + err); // its rows wait for the next call
    rows = [];
  }
  for (const r of rows) add(String(r[0]), r[1]);
  for (const name in sums) bump_(props, name, sums[name]);
  for (const k of spare) props.deleteProperty(k);
  if (rows.length) removeTop_(sheet, 1, rows.length, total);
}

// With the lock held, on LINE's calls too: Inbox rows older than KEEP_DAYS
// go, so they do not wait for the app. Those the app was never sent count as
// missed; those it was sent (seq up to HANDED) do not: it saves what it is
// sent before its next call, and asks again within minutes when it could
// not, so a row it was sent and did not save is only missed if it was also
// away for KEEP_DAYS just then.
function ageOut_(sheet, props) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const rows = sheet.getRange(2, 1, Math.min(BATCH, last - 1), 2).getValues();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let drop = 0;
  while (drop < rows.length && new Date(rows[drop][1]).getTime() < cutoff) drop++;
  if (!drop) return;
  const handed = Number(props.getProperty('HANDED') || '0');
  let missed = 0;
  for (let i = 0; i < drop; i++) if (Number(rows[i][0]) > handed) missed++;
  removeTop_(sheet, 2, drop, last - 1);
  if (missed) bump_(props, 'MISSED', missed);
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
