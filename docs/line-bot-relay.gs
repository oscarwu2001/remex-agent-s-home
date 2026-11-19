/** @OnlyCurrentDoc */
/*
 * Agent's Home LINE relay
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
 * Only group and multi-person chat events are kept; one-to-one chats with the
 * bot are not. Reply tokens are dropped. This script never sends messages.
 */
const TAB = 'Inbox';
const KEEP_DAYS = 14;
const BATCH = 500;

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
    bump_(props, 'REFUSED');
    return reply_({ ok: false, error: 'not allowed' });
  }
  let events = [];
  try {
    events = JSON.parse(e.postData.contents).events || [];
  } catch (err) {
    bump_(props, 'NOT_JSON'); // counted, shown by status() and to the app
    return reply_({ ok: false, error: 'not json' });
  }
  const kept = events.filter((ev) => ev && ev.source && (ev.source.type === 'group' || ev.source.type === 'room'));
  if (!kept.length) return reply_({ ok: true }); // LINE's Verify button sends no events
  const token = props.getProperty('LINE_TOKEN') || '';
  const ready = kept.map((ev) => {
    const copy = Object.assign({}, ev);
    delete copy.replyToken;
    if (token) addNames_(copy, token);
    return copy;
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const sheet = inbox_();
    const seen = recentIds_(sheet);
    let seq = Number(props.getProperty('NEXT_SEQ') || '1');
    const now = new Date().toISOString();
    const out = [];
    for (const ev of ready) {
      const id = String(ev.webhookEventId || '');
      if (id && seen.has(id)) continue; // the same event delivered again
      if (id) seen.add(id);
      out.push([seq++, now, id, JSON.stringify(ev)]);
    }
    if (out.length) {
      const start = sheet.getLastRow() + 1;
      const short = start + out.length - 1 - sheet.getMaxRows();
      if (short > 0) sheet.insertRowsAfter(sheet.getMaxRows(), short);
      sheet.getRange(start, 1, out.length, 4).setValues(out);
      props.setProperty('NEXT_SEQ', String(seq));
    }
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
  lock.waitLock(25000);
  try {
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
    if (drop === rows.length && drop > 0) sheet.getRange(2, 1, drop, 4).clearContent();
    else if (drop > 0) sheet.deleteRows(2, drop);
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
      missed: Number(props.getProperty('MISSED') || '0'),
      refused: Number(props.getProperty('REFUSED') || '0'),
      notJson: Number(props.getProperty('NOT_JSON') || '0'),
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
  Logger.log('Saved WEBHOOK_KEY and READER_SECRET under Project Settings > Script properties.');
}

/** Run from the editor to see counts only (no message content). */
function status() {
  const p = PropertiesService.getScriptProperties();
  const n = Math.max(0, inbox_().getLastRow() - 1);
  const ever = Number(p.getProperty('NEXT_SEQ') || '1') - 1;
  Logger.log(
    'Waiting in Inbox: ' + n + '. Kept since the start: ' + ever +
    '. Missed (deleted before collection): ' + (p.getProperty('MISSED') || '0') +
    '. LINE calls refused (wrong key): ' + (p.getProperty('REFUSED') || '0') +
    '. Unreadable LINE calls: ' + (p.getProperty('NOT_JSON') || '0') +
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

function bump_(props, name, by) {
  props.setProperty(name, String(Number(props.getProperty(name) || '0') + (by || 1)));
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
