/** @OnlyCurrentDoc */
/*
 * Agent's Home LINE relay (version 3)
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
 * KEEP_DAYS that the app never saved (their numbers wait in the Gone tab
 * until the app's next call says how far it saved; until they are counted
 * the app is sent nothing past them), REFUSED calls with a
 * wrong key or none, DENIED calls with a wrong secret (someone other than
 * the app), NOT_JSON calls with the key that were not LINE's JSON, LOST
 * events that could not be kept (the script was busy, or the sheet
 * failed), UNCHECKED events that came while WEBHOOK_KEY could not be read
 * (at most UNCHECKED_MAX a call; some may not be LINE's), and CAPPED, how
 * often counts came so fast that they could not all be kept (then the
 * counts are at least what they say). Calls are
 * counted in the Tally tab, with no lock and, for the kinds anyone can
 * cause, no property read or write; when the sheet itself fails, LINE's own
 * counts wait as a few TALLY_ properties. The app's calls add them up, each
 * row once.
 *
 * The app sends its secret and the number of the last event it saved
 * (upTo). After a new secret or link it sends 0 instead, with this relay's
 * id and how far it saved: this script takes that as upTo only when the id
 * is its own, so nothing the app saved is sent again or counted as missed.
 *
 * A flood of calls can still delay or drop LINE's events: Apps Script runs
 * at most 30 calls of a script at once. If that happens, make a new
 * deployment (Deploy > New deployment), put its link in LINE's webhook (with
 * ?k=) and in Agent's Home's Relay link, then archive the old deployment
 * (Deploy > Manage deployments > Archive): an old deployment answers until
 * it is archived.
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
const GONE = 'Gone';
const VERSION = 3;
const SPARE_MAX = 50; // TALLY_ properties waiting at most (then one TALLY_OVER_ marker at a time)
const UNCHECKED_MAX = 100; // events counted from one call whose key could not be checked
const KEY_CACHE_S = 600;
const TYPES = ['message', 'unsend', 'memberJoined', 'memberLeft', 'join', 'leave'];
// Tally rows -> the counts they add to. 'unchecked': LINE-looking events
// that came when the key could not be read at all.
const TALLIED = { refused: 'REFUSED', denied: 'DENIED', notJson: 'NOT_JSON', lost: 'LOST', unchecked: 'UNCHECKED', capped: 'CAPPED' };
// Kinds anyone can cause: capped in the Tally tab, and never written to a
// property. 'unchecked' and 'capped' come only while the key cannot be
// read, so they may wait in the bounded spare like LINE's own counts.
const OUTSIDE = { refused: true, denied: true, unchecked: true, capped: true };
const NO_SPARE = { refused: true, denied: true };

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
    const n = eventsIn_(e);
    tally_('unchecked', Math.min(UNCHECKED_MAX, n));
    if (n > UNCHECKED_MAX) tally_('capped', 1); // this call's count is a floor
    return reply_({ ok: false, error: 'settings' });
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
      ageOut_(sheet);
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
    return reply_({ ok: false, error: 'settings' }); // the app says to look at Executions
  }
  if (secret.length < 32 || !same_(body.secret, secret)) {
    tally_('denied', 1);
    return reply_({ ok: false, error: 'not allowed' });
  }
  let upTo = Math.max(0, Math.floor(Number(body.upTo) || 0));
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
    // How far the app saved, said beside a cursor of 0: this relay's own, so it stands.
    const saved = Math.floor(Number(body.saved) || 0);
    if (body.relay === relay && saved > upTo && saved < next) upTo = saved;
    if (upTo >= next) return reply_({ ok: false, error: 'cursor ahead', relay: relay });
    const sheet = inbox_();
    // Saved by the app: what is up to upTo.
    const last = sheet.getLastRow();
    let rows = last > 1 ? sheet.getRange(2, 1, last - 1, 4).getValues() : [];
    let drop = 0;
    while (drop < rows.length && Number(rows[drop][0]) <= upTo) drop++;
    removeTop_(sheet, 2, drop, rows.length);
    rows = rows.slice(drop);
    // Then rows past KEEP_DAYS, and the count of those the app never saved.
    let failedStep = ''; // which step of ageOut_ failed: 'read' (the Inbox), 'record' (to Gone) or 'removal' (from the Inbox)
    try {
      ageOut_(sheet);
    } catch (err) {
      failedStep = (err && err.step) || 'record';
      console.error('Old rows not removed (' + failedStep + '): ' + err); // tried again at the next call
    }
    try {
      countGone_(props, upTo);
    } catch (err) {
      // Their numbers wait in the Gone tab. Nothing newer is sent until they
      // are counted: past them, the app's cursor would hide them.
      console.error('Missed events not counted yet: ' + err);
      return reply_({ ok: false, error: 'not counted', step: 'count' });
    }
    // A row past KEEP_DAYS is never sent. One whose number is counted
    // (GONE_TO) waits only for its removal; one not counted yet (ageOut_
    // moves BATCH at a time, or failed) holds back every newer row, since
    // past it the app's cursor would hide it: the app asks again (more) and
    // each call moves the next batch, or, after a failure, it is told so.
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const counted = count_(props, 'GONE_TO');
    let old = 0;
    while (old < rows.length && new Date(rows[old][1]).getTime() < cutoff) old++;
    const waiting = rows.slice(0, old).some((r) => Number(r[0]) > counted);
    if (waiting && failedStep) return reply_({ ok: false, error: 'not counted', step: failedStep });
    const rest = waiting ? [] : rows.slice(old);
    const events = rest.slice(0, BATCH).map((r) => {
      try {
        return { seq: Number(r[0]), received: String(r[1]), event: JSON.parse(String(r[3])) };
      } catch (err) {
        return { seq: Number(r[0]), received: String(r[1]), broken: true }; // the app counts these
      }
    });
    const all = props.getProperties();
    const count = (name) => Number(all[name] || '0');
    return reply_({
      ok: true,
      version: VERSION,
      relay: relay,
      events: events,
      more: waiting || rest.length > BATCH,
      missed: count('MISSED'),
      refused: count('REFUSED'),
      denied: count('DENIED'),
      notJson: count('NOT_JSON'),
      lost: count('LOST'),
      capped: count('CAPPED'),
      unchecked: count('UNCHECKED'),
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
  sheetNamed_(GONE);
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
    '. Calls with a wrong secret: ' + count('DENIED') + (count('CAPPED') ? ' or more' : '') +
    '. Unreadable LINE calls: ' + count('NOT_JSON') +
    '. Events not kept (busy or a sheet error): ' + count('LOST') +
    '. Events while the webhook key could not be read: ' + count('UNCHECKED') + (count('CAPPED') ? ' or more' : '') +
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
  return sheetNamed_(TALLY);
}

function sheetNamed_(name) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(name);
  if (sheet) return sheet;
  try {
    return book.insertSheet(name);
  } catch (err) {
    return book.getSheetByName(name); // made by another call just now
  }
}

// One row per count, appended without the lock: an append is whole on its
// own, so no count is lost, and nothing waits for LINE's calls. Past
// TALLY_MAX rows waiting (a flood) no more of the kinds anyone can cause are
// added, so the spreadsheet cannot fill up; a 'capped' row marks it once.
// When the sheet fails, LINE's own counts wait as TALLY_<what>_<id>
// properties (unique names: no count is lost to another call), at most
// SPARE_MAX, then one TALLY_OVER_<id> marker at a time (its own name, so
// each is counted once); calls with a wrong key, none or a wrong secret
// never touch the properties.
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
  if (NO_SPARE[what]) return;
  try {
    const p = PropertiesService.getScriptProperties();
    const waiting = p.getKeys().filter((k) => k.indexOf('TALLY_') === 0);
    if (waiting.length >= SPARE_MAX) {
      if (!waiting.some((k) => k.indexOf('TALLY_OVER_') === 0)) p.setProperty('TALLY_OVER_' + Utilities.getUuid(), '1'); // counted as capped
      return;
    }
    p.setProperty('TALLY_' + what + '_' + Utilities.getUuid(), String(n));
  } catch (err) {
    console.error('Not counted (' + what + ' ' + n + '): ' + err);
  }
}

// With the lock held, on the app's calls: the counts that wait (TALLY_
// properties, then the first FOLD Tally rows) added up, each once. The rows
// are marked with this fold's id and the counts written together with it,
// before anything is removed: a fold that fails part-way leaves rows marked
// with the last written id (counted: removed next time, not counted again)
// or with another (not counted: counted next time). The properties work
// the same way through FOLD_SPARE. Rows appended meanwhile come after them
// and wait for the next call.
function fold_(props) {
  const all = props.getProperties();
  const lastId = all.FOLD_ID || '';
  let counted = [];
  try {
    counted = JSON.parse(all.FOLD_SPARE || '[]');
  } catch (err) {
    counted = []; // not this script's: the TALLY_ properties are taken as not counted yet
  }
  const spare = Object.keys(all).filter((k) => k.indexOf('TALLY_') === 0);
  for (const k of spare) if (counted.indexOf(k) >= 0) props.deleteProperty(k);
  const fresh = spare.filter((k) => counted.indexOf(k) < 0).slice(0, SPARE_MAX + 1);
  let sheet = null;
  let total = 0;
  let rows = [];
  try {
    sheet = tallySheet_();
    total = sheet.getLastRow();
    if (total) rows = sheet.getRange(1, 1, Math.min(FOLD, total), 4).getValues();
  } catch (err) {
    console.error('Tally tab not read: ' + err); // its rows wait for the next call
    rows = [];
  }
  let done = 0;
  while (lastId && done < rows.length && String(rows[done][3]) === lastId) done++;
  if (done) {
    removeTop_(sheet, 1, done, total);
    total -= done;
    rows = rows.slice(done);
  }
  if (!rows.length && !fresh.length) return;
  const id = Utilities.getUuid();
  if (rows.length) sheet.getRange(1, 4, rows.length, 1).setValues(rows.map(() => [id]));
  const sums = {};
  const add = (what, n) => {
    const name = TALLIED[what];
    if (name) sums[name] = (sums[name] || 0) + (Number(n) || 0);
  };
  for (const k of fresh) {
    if (k.indexOf('TALLY_OVER_') === 0) add('capped', 1);
    else add(k.split('_')[1], all[k]);
  }
  for (const r of rows) add(String(r[0]), r[1]);
  const write = { FOLD_ID: id, FOLD_SPARE: JSON.stringify(fresh) };
  for (const name in sums) write[name] = String(Number(all[name] || '0') + sums[name]);
  props.setProperties(write);
  for (const k of fresh) props.deleteProperty(k);
  if (rows.length) removeTop_(sheet, 1, rows.length, total);
}

// With the lock held, on LINE's calls and the app's: Inbox rows older than
// KEEP_DAYS go, so they do not wait for the app. Their numbers go to the
// Gone tab first (if that fails, the rows wait); the app's next call counts
// those it never saved (countGone_). -> how many went.
function ageOut_(sheet) {
  let last;
  let rows;
  try {
    last = sheet.getLastRow();
    if (last < 2) return 0;
    rows = sheet.getRange(2, 1, Math.min(BATCH, last - 1), 2).getValues();
  } catch (err) {
    throw Object.assign(err, { step: 'read' });
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let drop = 0;
  while (drop < rows.length && new Date(rows[drop][1]).getTime() < cutoff) drop++;
  if (!drop) return 0;
  try {
    appendRows_(sheetNamed_(GONE), rows.slice(0, drop).map((r) => [r[0]]));
  } catch (err) {
    throw Object.assign(err, { step: 'record' });
  }
  try {
    removeTop_(sheet, 2, drop, last - 1);
  } catch (err) {
    throw Object.assign(err, { step: 'removal' });
  }
  return drop;
}

// With the lock held, on the app's calls: the numbers in the Gone tab the
// app never saved (above upTo) are missed. The count and how far it went
// (GONE_TO) are written together before the tab is cleared, so a number is
// counted once even if clearing fails, and not lost if writing does.
function countGone_(props, upTo) {
  const sheet = sheetNamed_(GONE);
  const n = sheet.getLastRow();
  if (!n) return;
  const seqs = sheet.getRange(1, 1, n, 1).getValues().map((r) => Number(r[0])).filter((x) => x > 0);
  const done = Number(props.getProperty('GONE_TO') || '0');
  const missed = seqs.filter((x, i) => x > upTo && x > done && seqs.indexOf(x) === i).length;
  const top = seqs.reduce((a, x) => Math.max(a, x), done);
  props.setProperties({ MISSED: String(count_(props, 'MISSED') + missed), GONE_TO: String(top) });
  removeTop_(sheet, 1, n, n);
}

// Rows written under the last one, the sheet made longer first if need be.
function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  const short = start + rows.length - 1 - sheet.getMaxRows();
  if (short > 0) sheet.insertRowsAfter(sheet.getMaxRows(), short);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
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
