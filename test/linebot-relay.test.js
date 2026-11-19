'use strict';

// The LINE relay script (docs/line-bot-relay.gs) run in Node against a small
// stand-in for the Apps Script services it uses: what it keeps, what it
// counts and how it answers LINE and the app. Every id, key and message
// here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../src/core/linebot');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'docs', 'line-bot-relay.gs'), 'utf8');
const DAY = 86_400_000;

// ---- a stand-in for Apps Script --------------------------------------------------------------

class Sheet {
  constructor(env, name) {
    this.env = env;
    this.name = name;
    this.cells = [];
    this.maxRows = 1000;
    this.failWrites = 0;
  }
  filled(r) {
    return Boolean(r) && r.some((v) => v !== '' && v != null);
  }
  getLastRow() {
    for (let i = this.cells.length; i > 0; i--) if (this.filled(this.cells[i - 1])) return i;
    return 0;
  }
  getLastColumn() {
    return Math.max(0, ...this.cells.map((r) => r.reduce((n, v, i) => (v !== '' && v != null ? i + 1 : n), 0)));
  }
  getMaxRows() {
    return this.maxRows;
  }
  insertRowsAfter(_after, n) {
    this.maxRows += n;
  }
  deleteRows(first, n) {
    if (n >= this.maxRows) throw new Error('You can’t delete all the rows on the sheet.');
    this.cells.splice(first - 1, n);
    this.maxRows -= n;
  }
  appendRow(values) {
    this.env.hook('append', this);
    const row = this.getLastRow() + 1;
    this.cells[row - 1] = [...values];
    this.maxRows = Math.max(this.maxRows, row);
  }
  getRange(row, col, rows = 1, cols = 1) {
    if (typeof row === 'string') return { setNumberFormat: () => undefined };
    const sheet = this;
    return {
      getValues() {
        sheet.env.hook('read', sheet);
        return Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => sheet.cells[row - 1 + i]?.[col - 1 + j] ?? ''));
      },
      setValues(values) {
        if (sheet.failWrites > 0) {
          sheet.failWrites -= 1;
          throw new Error('Service Spreadsheets failed while accessing document');
        }
        if (row + rows - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        values.forEach((v, i) => {
          const r = (sheet.cells[row - 1 + i] ??= []);
          v.forEach((x, j) => {
            r[col - 1 + j] = x;
          });
        });
      },
      clearContent() {
        for (let i = 0; i < rows; i++) {
          const r = sheet.cells[row - 1 + i];
          if (r) for (let j = 0; j < cols; j++) r[col - 1 + j] = '';
        }
      },
    };
  }
}

function appsScript() {
  const props = new Map();
  const sheets = new Map();
  const env = {
    props,
    sheets,
    propWrites: 0,
    lockBusy: false,
    errors: [],
    hooks: {},
    // A hook runs once (unless it returns false): a second call landing in
    // the middle of the first.
    hook(name, arg) {
      const fn = env.hooks[name];
      if (!fn) return;
      delete env.hooks[name];
      if (fn(arg) === false) env.hooks[name] ??= fn;
    },
  };
  const book = {
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet(name) {
      if (sheets.has(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
      const s = new Sheet(env, name);
      sheets.set(name, s);
      return s;
    },
  };
  const store = {
    getProperty: (k) => (props.has(k) ? props.get(k) : null),
    setProperty(k, v) {
      env.hook('setProperty', k);
      env.propWrites += 1;
      props.set(k, String(v));
    },
  };
  const cache = new Map();
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => store },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => !env.lockBusy,
        waitLock() {
          if (env.lockBusy) throw new Error('Lock timeout: another process was holding the lock for too long.');
        },
        releaseLock: () => undefined,
      }),
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    UrlFetchApp: { fetch: () => assert.fail('the relay looks up names only with a token') },
    Utilities: { getUuid: () => crypto.randomUUID() },
    Logger: { log: () => undefined },
    console: { error: (m) => env.errors.push(String(m)), log: () => undefined },
  });
  vm.runInContext(SCRIPT, context, { filename: 'line-bot-relay.gs' });
  context.makeSecrets();
  env.key = props.get('WEBHOOK_KEY');
  env.secret = props.get('READER_SECRET');
  env.inbox = () => sheets.get('Inbox');
  env.line = (body, k = env.key) =>
    JSON.parse(context.doPost({ parameter: { k }, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  env.app = (upTo = 0, secret = env.secret) =>
    JSON.parse(context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ secret, upTo }) } }).text);
  return env;
}

let n = 0;
const groupEvent = (type, extra = {}) => ({
  type,
  webhookEventId: `EV${++n}`,
  timestamp: Date.now(),
  replyToken: 'reply-token-1',
  source: { type: 'group', groupId: 'Cgroup0001', userId: 'Uuser0001' },
  ...extra,
});
const text = (words, extra) => groupEvent('message', { message: { type: 'text', id: `M${n + 1}`, text: words }, ...extra });

// ---- what is kept ------------------------------------------------------------------------

test('the relay keeps only the group events the app reads, with no reply token and no names sent by the caller', () => {
  const env = appsScript();
  const said = env.line({
    events: [
      text('hello', { _groupName: 'Made up', _senderName: 'Someone else', _nameProblem: 'made up too' }),
      groupEvent('postback', { postback: { data: 'x' } }),
      groupEvent('beacon', { beacon: { hwid: 'b1', type: 'enter' } }),
      { ...text('one to one'), source: { type: 'user', userId: 'Uuser0001' } },
      groupEvent('unsend', { unsend: { messageId: 'M1' } }),
      groupEvent('memberJoined', { joined: { members: [{ type: 'user', userId: 'Uuser0002' }] } }),
      groupEvent('join'),
    ],
  });
  assert.deepEqual(said, { ok: true });
  const reply = env.app(0);
  assert.deepEqual(reply.events.map((e) => e.event.type), ['message', 'unsend', 'memberJoined', 'join']);
  const first = reply.events[0].event;
  for (const field of ['replyToken', '_groupName', '_senderName', '_nameProblem']) assert.ok(!(field in first), field);
  assert.equal(B.relayReply(reply).events.length, 4);
});

test('rows older than 14 days go on LINE’s calls too, counted as missed, with no collection by the app', () => {
  const env = appsScript();
  env.line({ events: [text('first')] });
  env.inbox().cells[1][1] = new Date(Date.now() - 15 * DAY).toISOString();
  // LINE's Verify button: no events, and the old row still goes.
  assert.deepEqual(env.line({ events: [] }), { ok: true });
  assert.equal(env.inbox().getLastRow(), 1);
  assert.equal(env.props.get('MISSED'), '1');
  env.line({ events: [text('second')] });
  env.inbox().cells[1][1] = new Date(Date.now() - 15 * DAY).toISOString();
  env.line({ events: [text('third')] });
  assert.deepEqual(env.inbox().cells.slice(1).filter((r) => r[0] !== '').map((r) => JSON.parse(r[3]).message.text), ['third']);
  const reply = env.app(0);
  assert.equal(reply.missed, 2);
  assert.deepEqual(reply.events.map((e) => e.event.message.text), ['third']);
});

// ---- what is counted -------------------------------------------------------------------------

test('a wrong key or a call that is not JSON is counted with no lock and no property write, even while the app collects', () => {
  const env = appsScript();
  const writes = env.propWrites;
  env.lockBusy = true;
  for (let i = 0; i < 3; i++) assert.deepEqual(env.line({ events: [text('x')] }, 'wrong-key'), { ok: false, error: 'not allowed' });
  assert.deepEqual(env.line('<html>not json</html>'), { ok: false, error: 'not json' });
  assert.equal(env.propWrites, writes, 'no property written for a refused call');
  env.lockBusy = false;
  const reply = env.app(0);
  assert.equal(reply.refused, 3);
  assert.equal(reply.notJson, 1);
});

test('two wrong-key calls at the same moment are both counted', () => {
  const env = appsScript();
  // The second call lands while the first is counting.
  let landed = false;
  const second = () => {
    if (!landed) {
      landed = true;
      env.line({ events: [] }, 'wrong-key');
    }
  };
  env.hooks.append = second;
  env.hooks.setProperty = (k) => (k === 'REFUSED' ? second() : false);
  env.line({ events: [] }, 'wrong-key');
  assert.equal(env.app(0).refused, 2);
});

test('a count tallied while the counts are added up waits for the next call, and is not lost', () => {
  const env = appsScript();
  env.line({ events: [] }, 'wrong-key');
  env.line({ events: [] }, 'wrong-key');
  env.hooks.read = (sheet) => (sheet.name === 'Tally' ? env.line({ events: [] }, 'wrong-key') : false);
  assert.equal(env.app(0).refused, 2);
  assert.equal(env.app(0).refused, 3);
});

test('LINE’s call while the app holds the lock answers busy, and its events are counted as lost', () => {
  const env = appsScript();
  env.lockBusy = true;
  assert.deepEqual(env.line({ events: [text('a'), text('b')] }), { ok: false, error: 'busy' });
  env.lockBusy = false;
  const reply = env.app(0);
  assert.equal(reply.lost, 2);
  assert.deepEqual(reply.events, []);
  assert.equal(B.relayReply(reply).counts.lost, 2);
});

test('the app’s call while LINE’s holds the lock answers busy, which the app treats as passing', () => {
  const env = appsScript();
  env.line({ events: [text('a')] });
  env.lockBusy = true;
  const reply = env.app(0);
  assert.deepEqual(reply, { ok: false, error: 'busy' });
  assert.throws(() => B.relayReply(reply), (err) => err instanceof B.LineBotError && B.TRANSIENT.has(err.kind));
  env.lockBusy = false;
  assert.equal(env.app(0).events.length, 1);
});

test('events the sheet fails to keep are counted as lost, and their numbers are never used again', () => {
  const env = appsScript();
  env.inbox().failWrites = 1;
  assert.deepEqual(env.line({ events: [text('a'), text('b')] }), { ok: false, error: 'not kept' });
  assert.equal(env.errors.length, 1);
  env.line({ events: [text('c')] });
  const reply = env.app(0);
  assert.equal(reply.lost, 2);
  assert.deepEqual(reply.events.map((e) => [e.seq, e.event.message.text]), [[3, 'c']]);
});

test('counts that cannot be added up just now never stop events being kept or collected', () => {
  const env = appsScript();
  env.line({ events: [] }, 'wrong-key');
  const failing = (sheet) => {
    if (sheet.name === 'Tally') throw new Error('Service Spreadsheets failed while accessing document');
    return false;
  };
  env.hooks.read = failing;
  assert.deepEqual(env.line({ events: [text('a')] }), { ok: true });
  env.hooks.read = failing;
  const reply = env.app(0);
  assert.deepEqual(reply.events.map((e) => e.event.message.text), ['a']);
  assert.equal(reply.refused, 0);
  assert.equal(env.app(reply.events[0].seq).refused, 1);
});

// ---- the reply -------------------------------------------------------------------------------

test('the reply keeps the shape the app has always read, with lost added; a reply without lost is still read', () => {
  const env = appsScript();
  env.line({ events: [text('a')] });
  const reply = env.app(0);
  assert.deepEqual(Object.keys(reply).sort(), ['events', 'lost', 'missed', 'more', 'notJson', 'ok', 'refused', 'relay']);
  const { lost, ...v1 } = reply;
  assert.equal(lost, 0);
  assert.equal(B.relayReply(v1).counts.lost, 0);
  // Collected: the app's next call lets the relay forget it.
  assert.deepEqual(env.app(reply.events[0].seq).events, []);
  assert.equal(env.inbox().getLastRow(), 1);
});

test('a flood of wrong-key calls stops adding Tally rows at the cap, and LINE’s events are still kept', () => {
  const env = appsScript();
  env.line({ events: [] }, 'wrong-key');
  const tally = env.sheets.get('Tally');
  for (let i = tally.getLastRow(); i < 100_000; i++) tally.cells[i] = ['refused', 1, 'then'];
  env.line({ events: [] }, 'wrong-key');
  assert.equal(tally.getLastRow(), 100_000);
  // LINE's own events lost meanwhile are still counted.
  env.lockBusy = true;
  assert.deepEqual(env.line({ events: [text('lost')] }), { ok: false, error: 'busy' });
  env.lockBusy = false;
  assert.deepEqual(env.line({ events: [text('a')] }), { ok: true });
  for (let i = 0; i < 25 && env.sheets.get('Tally').getLastRow(); i++) env.line({ events: [] });
  const reply = env.app(0);
  assert.equal(reply.events.length, 1);
  assert.equal(reply.lost, 1);
  assert.equal(reply.refused, 100_000);
});
