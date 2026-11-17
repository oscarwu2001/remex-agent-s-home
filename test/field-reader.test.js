'use strict';

// Field feedback through the reader script: the link, the request, Google's
// one redirect, the reader's answers, the secret's handling and the cache's
// identity. Every id, secret and answer here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../src/core/fieldsurvey');

const DEPLOY = 'AKfycbDemoDemoDemo0123456789_-abcdefghij';
const OTHER_DEPLOY = 'AKfycbOtherOther9876543210_-zyxwvutsrq';
const EXEC = `https://script.google.com/macros/s/${DEPLOY}/exec`;
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=demo-key-1&lib=demo-lib';
const READER = { deploymentId: DEPLOY, url: EXEC };

// Every error a test sees, to check at the end that none carries the secret
// or the link.
const seen = [];
const caught = (fn) => {
  try {
    fn();
  } catch (err) {
    seen.push(err);
    return err;
  }
  assert.fail('expected an error');
};
const caughtAsync = async (p) => {
  try {
    await p;
  } catch (err) {
    seen.push(err);
    return err;
  }
  assert.fail('expected an error');
};

// ---- the link ------------------------------------------------------------------

test('a reader link gives its deployment id and the link rebuilt from it alone', () => {
  assert.deepEqual(F.parseReaderLink(EXEC), READER);
  assert.deepEqual(F.parseReaderLink(`  ${EXEC}/  `), READER);
  // A query or fragment typed into it is not kept, so a secret pasted there is never saved or sent.
  assert.deepEqual(F.parseReaderLink(`${EXEC}?secret=${SECRET}#x`), READER);
  assert.ok(!F.parseReaderLink(`${EXEC}?secret=${SECRET}`).url.includes(SECRET));
});

test('anything but a reader web app /exec link is refused, naming the shape expected', () => {
  const shape = /https:\/\/script\.google\.com\/macros\/s\/…\/exec/;
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com/macros/s/${DEPLOY}/dev`)).message, /test link \(it ends in \/dev\).*ends in \/exec/);
  assert.match(caught(() => F.parseReaderLink(`https://example.com/macros/s/${DEPLOY}/exec`)).message, shape);
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com.example.com/macros/s/${DEPLOY}/exec`)).message, shape);
  assert.match(caught(() => F.parseReaderLink(`https://docs.google.com/spreadsheets/d/${DEPLOY}/edit`)).message, /not an Apps Script web app/);
  assert.match(caught(() => F.parseReaderLink(`http://script.google.com/macros/s/${DEPLOY}/exec`)).message, /not an Apps Script web app/);
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com:8443/macros/s/${DEPLOY}/exec`)).message, /not an Apps Script web app/);
  assert.match(caught(() => F.parseReaderLink(`https://someone@script.google.com/macros/s/${DEPLOY}/exec`)).message, /not an Apps Script web app/);
  assert.match(caught(() => F.parseReaderLink('https://script.google.com/macros/s//exec')).message, shape);
  assert.match(caught(() => F.parseReaderLink('https://script.google.com/macros/s/exec')).message, shape);
  assert.match(caught(() => F.parseReaderLink('https://script.google.com/macros/s/short/exec')).message, /cut short/);
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com/home/projects/${DEPLOY}/edit`)).message, /script editor’s link/);
  assert.match(caught(() => F.parseReaderLink('not a link')).message, shape);
  assert.match(caught(() => F.parseReaderLink('')).message, /^No reader link yet/);
});

// ---- the request -----------------------------------------------------------------

test('the request posts only the secret, in the body, to the rebuilt link', () => {
  const req = F.readerRequest(READER, SECRET);
  assert.equal(req.url, EXEC);
  assert.equal(req.init.method, 'POST');
  assert.deepEqual(JSON.parse(req.init.body), { secret: SECRET });
  assert.match(req.init.headers['content-type'], /^text\/plain/);
  assert.ok(!req.url.includes(SECRET));
});

// ---- the redirect ----------------------------------------------------------------

test('the one hop is to script.googleusercontent.com over https, nowhere else', () => {
  assert.equal(F.readerHop(ECHO), ECHO);
  const other = caught(() => F.readerHop('https://example.com/macros/echo?user_content_key=x'));
  assert.equal(other.kind, 'blocked');
  assert.match(other.message, /example\.com.*only from script\.googleusercontent\.com/);
  const plain = caught(() => F.readerHop('http://script.googleusercontent.com/macros/echo?user_content_key=x'));
  assert.equal(plain.kind, 'blocked');
  assert.match(plain.message, /without https/);
  assert.equal(caught(() => F.readerHop('https://script.googleusercontent.com:444/macros/echo')).kind, 'blocked');
  assert.equal(caught(() => F.readerHop('https://x@script.googleusercontent.com/macros/echo')).kind, 'blocked');
  const none = caught(() => F.readerHop(undefined));
  assert.equal(none.kind, 'answer'); // Google's odd answer: tried again in half an hour
  assert.equal(caught(() => F.readerHop('   ')).kind, 'answer');
  assert.equal(caught(() => F.readerHop('/macros/echo?x=1')).kind, 'blocked');
  // Not open to Anyone: Google sends the call to its sign-in.
  const signIn = caught(() => F.readerHop('https://accounts.google.com/ServiceLogin?continue=x'));
  assert.equal(signIn.kind, 'access');
  assert.match(signIn.message, /Who has access → Anyone/);
});

// A stand-in for Electron's net.request: answers by host, records each call.
function fakeReader(answers) {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, init });
    const a = answers[calls.length - 1];
    if (a instanceof Error) throw a;
    const [status, body = '', { location, contentType = 'application/json; charset=utf-8' } = {}] = a;
    return { status, location, contentType, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { send, calls };
}
const ROWS = [['Saved (UTC)', 'Ease (1-5)'], ['2026-11-10T09:00:00.000Z', '4']];
const OK = [200, { ok: true, tab: 'Demo Reports', values: ROWS }];
const MOVED = [302, '<html>moved</html>', { location: ECHO, contentType: 'text/html' }];

test('fetching posts the secret, follows the one redirect with a plain GET and reads the rows', async () => {
  const r = fakeReader([MOVED, OK]);
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: r.send });
  assert.deepEqual(got, { rows: ROWS, tab: { id: null, title: 'Demo Reports' }, timeZone: undefined });
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].url, EXEC);
  assert.equal(r.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { secret: SECRET });
  assert.equal(r.calls[1].url, ECHO);
  assert.equal(r.calls[1].init.method, 'GET');
  // The secret goes to the reader only: not to the echo host, not in any address.
  assert.ok(!JSON.stringify(r.calls[1]).includes(SECRET));
  for (const c of r.calls) assert.ok(!c.url.includes(SECRET));
  // The rows come out as the key file's do: the rest of the pipeline is the same.
  const s = F.summariseCache(F.afterFetch(null, got, { now: 1, started: 1, link: READER }), []);
  assert.equal(s.responses, 1);
  assert.equal(s.timestampColumn, 'Saved (UTC)');
  assert.deepEqual(s.questions.map((q) => [q.question, q.mean, q.low, q.high]), [['Ease (1-5)', 4, 1, 5]]);
});

test('a second redirect, or one off the echo host, is refused before it is followed', async () => {
  const twice = fakeReader([MOVED, [302, '', { location: ECHO }]]);
  const second = await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: twice.send }));
  assert.equal(second.kind, 'blocked');
  assert.match(second.message, /a second time/);
  assert.equal(twice.calls.length, 2);
  const away = fakeReader([[302, '', { location: 'https://example.com/steal' }], OK]);
  assert.equal((await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: away.send }))).kind, 'blocked');
  assert.equal(away.calls.length, 1); // never asked
  const bare = fakeReader([[302, '', {}], OK]);
  assert.equal((await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: bare.send }))).kind, 'answer');
  assert.equal(bare.calls.length, 1);
  // A link that is not the reader's is refused before anything is sent.
  const stray = fakeReader([OK]);
  assert.equal((await caughtAsync(F.fetchReaderRows({ link: { deploymentId: DEPLOY, url: 'https://example.com/exec' }, secret: SECRET, send: stray.send }))).kind, 'blocked');
  assert.equal(stray.calls.length, 0);
});

// ---- the answers -----------------------------------------------------------------

test("the reader's refusals and Google's pages become sentences that name the next step", async () => {
  const fail = async (last) => caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: fakeReader([MOVED, last]).send }));
  const wrong = await fail([200, { ok: false, error: 'not allowed' }]);
  assert.equal(wrong.kind, 'secret');
  assert.match(wrong.message, /does not match.*READER_SECRET.*Project Settings → Script properties/);
  const tab = await fail([200, { ok: false, error: 'tab not found' }]);
  assert.equal(tab.kind, 'tab');
  assert.match(tab.message, /check that TAB at the top of the reader script/);
  // Not open to Anyone: Google's sign-in page, as HTML.
  const page = '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head><body></body></html>';
  const html = await fail([200, page, { contentType: 'text/html; charset=utf-8' }]);
  assert.equal(html.kind, 'access');
  assert.match(html.message, /Deploy → Manage deployments → Edit → Who has access → Anyone/);
  assert.equal((await fail([200, page, { contentType: 'application/octet-stream' }])).kind, 'access');
  const garbled = await fail([200, '{"ok":tru']);
  assert.equal(garbled.kind, 'answer');
  assert.match(garbled.message, /could not be read/);
  const empty = await fail([200, { ok: true, tab: 'Demo Reports' }]);
  assert.equal(empty.kind, 'answer');
  assert.match(empty.message, /without rows/);
  assert.match((await fail([200, { ok: true, values: [['a'], 'b'] }])).message, /without rows/);
  assert.match((await fail([200, { ok: true, values: [['a', { b: 1 }]] }])).message, /without rows/);
  assert.equal((await fail([200, []])).kind, 'answer');
  assert.equal((await fail([200, { values: ROWS }])).kind, 'answer');
  assert.equal((await fail([200, { ok: false, error: 'something new' }])).kind, 'reader');
  // An empty tab is no rows, not an error.
  assert.deepEqual((await F.fetchReaderRows({ link: READER, secret: SECRET, send: fakeReader([MOVED, [200, { ok: true, tab: 'T', values: [] }]]).send })).rows, []);
});

test('network trouble and a busy or failing Google are passing troubles; a missing or closed reader waits for the user', async () => {
  const fail = async (answers) => caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: fakeReader(answers).send }));
  const offline = await fail([new Error('net::ERR_INTERNET_DISCONNECTED')]);
  assert.equal(offline.kind, 'network');
  assert.equal(offline.code, 'net::ERR_INTERNET_DISCONNECTED');
  const slow = new Error('The operation was aborted due to timeout');
  slow.name = 'TimeoutError';
  assert.match((await fail([MOVED, slow])).message, /did not answer in time/);
  const down = await fail([MOVED, [503, 'Service Unavailable', { contentType: 'text/html' }]]);
  assert.equal(down.kind, 'google');
  assert.match(down.message, /tries again in half an hour/);
  assert.equal((await fail([[429, '']])).kind, 'busy');
  assert.equal((await fail([[404, '<html></html>', { contentType: 'text/html' }]])).kind, 'missing');
  assert.equal((await fail([[403, '']])).kind, 'access');
  // An error that names an address keeps it out of the log's code too.
  const named = await fail([new Error(`connect failed for ${EXEC}`)]);
  assert.ok(!named.code.includes(DEPLOY));
  // The schedule retries the passing ones in half an hour and leaves the rest to the user.
  const now = Date.UTC(2026, 10, 16, 9);
  const tried = now - 10 * 60_000;
  const plan = (err) => F.planFetch({
    now, settings: { enabled: true, source: 'reader', readerUrl: EXEC, secretSaved: true },
    cache: { fetchedAt: null, lastAttemptAt: tried, lastError: { kind: err.kind, message: err.message } },
  });
  for (const err of [offline, down]) assert.equal(plan(err).wakeAt, tried + F.RETRY_MS);
  for (const err of [await fail([MOVED, [200, { ok: false, error: 'not allowed' }]]), await fail([[403, '']])]) {
    assert.notEqual(plan(err).wakeAt, tried + F.RETRY_MS);
  }
});

// ---- the secret --------------------------------------------------------------------

test('the secret is saved only where the system can protect it, never as plain text', () => {
  const off = F.checkSecret(SECRET, { available: false });
  assert.equal(off.secret, undefined);
  assert.match(off.error, /never keeps it as plain text/);
  // Linux with no keyring: Electron's "basic_text" is no protection.
  assert.match(F.checkSecret(SECRET, { available: true, backend: 'basic_text' }).error, /plain text/);
  assert.deepEqual(F.checkSecret(`  ${SECRET}\n`, { available: true }), { secret: SECRET });
  assert.deepEqual(F.checkSecret(SECRET, { available: true, backend: 'gnome_libsecret' }), { secret: SECRET });
  const short = F.checkSecret('tooshort', { available: true });
  assert.match(short.error, /32 characters or more.*READER_SECRET/);
  assert.ok(!short.error.includes('tooshort'));
  assert.match(F.checkSecret(`${SECRET.slice(0, 20)} ${SECRET.slice(20)}`, { available: true }).error, /no spaces/);
  assert.match(F.checkSecret('', { available: true }).error, /^No secret yet/);
  assert.match(F.checkSecret(undefined, { available: true }).error, /^No secret yet/);
});

test('a saved secret that is gone or locked waits for the user; one busy just now is tried again', () => {
  const gone = F.secretFileError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
  const busy = F.secretFileError(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
  const locked = F.secretLocked();
  seen.push(gone, busy, locked);
  assert.deepEqual([gone.kind, busy.kind, locked.kind], ['setup', 'secretfile', 'secret']);
  assert.match(locked.message, /Save the secret again/);
  const plan = (err) => F.planFetch({
    now: Date.UTC(2026, 10, 16, 9), settings: { enabled: true, source: 'reader', readerUrl: EXEC, secretSaved: true },
    cache: { fetchedAt: null, lastAttemptAt: Date.UTC(2026, 10, 16, 8, 50), lastError: { kind: err.kind, message: err.message } },
  });
  assert.equal(plan(busy).wakeAt, Date.UTC(2026, 10, 16, 8, 50) + F.RETRY_MS);
  assert.notEqual(plan(locked).wakeAt, Date.UTC(2026, 10, 16, 8, 50) + F.RETRY_MS);
});

// ---- settings and the cache's identity -----------------------------------------------

const SHEET = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-demo/edit#gid=777';
const KEY_LINK = F.parseSheetLink(SHEET);
const got = (rows) => ({ rows, tab: { id: null, title: 'Demo Reports' }, timeZone: undefined });

test('the source: saved settings from before the reader are the key file’s; a fresh set-up starts on the reader', () => {
  assert.equal(F.sourceOf({ enabled: true, sheetUrl: SHEET, keyPath: 'k.json' }), 'key');
  assert.equal(F.sourceOf({ enabled: true, sheetUrl: '', keyPath: '' }), 'reader');
  assert.equal(F.sourceOf(null), 'reader');
  assert.equal(F.sourceOf({ source: 'key' }), 'key');
  assert.equal(F.sourceOf({ source: 'reader', sheetUrl: SHEET }), 'reader');
  assert.deepEqual(F.sourceLink({ source: 'reader', readerUrl: EXEC, sheetUrl: SHEET }), READER);
  assert.deepEqual(F.sourceLink({ source: 'key', readerUrl: EXEC, sheetUrl: SHEET }), KEY_LINK);
  assert.throws(() => F.sourceLink({ source: 'reader' }), /No reader link yet/);
});

test('the reader reads when on, with a link and a saved secret', () => {
  const plan = (settings) => F.planFetch({ now: Date.UTC(2026, 10, 16, 9), settings, cache: null });
  const reader = { enabled: true, source: 'reader', readerUrl: EXEC, secretSaved: true };
  assert.deepEqual(plan(reader), { fetch: true, wakeAt: null });
  assert.equal(plan({ ...reader, secretSaved: false }).fetch, false);
  assert.equal(plan({ ...reader, readerUrl: '' }).fetch, false);
  assert.equal(plan({ ...reader, enabled: false }).fetch, false);
  // The key file's settings do not stand in for the reader's, or the other way round.
  assert.equal(plan({ ...reader, readerUrl: '', sheetUrl: SHEET, keyPath: 'k.json' }).fetch, false);
  assert.equal(plan({ enabled: true, source: 'key', readerUrl: EXEC, secretSaved: true }).fetch, false);
});

test('Settings: the reader link is checked and saved rebuilt; a new source or reader starts afresh', () => {
  const cur = { enabled: true, sheetUrl: '', keyPath: '', columns: [] };
  const set = F.changeSettings(cur, { source: 'reader', readerUrl: `${EXEC}?x=1` });
  assert.deepEqual(set, { settings: { ...cur, source: 'reader', readerUrl: EXEC }, sheetChanged: true });
  const bad = F.changeSettings(set.settings, { readerUrl: EXEC.replace('/exec', '/dev') });
  assert.match(bad.error, /\/dev/);
  assert.equal(bad.settings, undefined);
  assert.match(F.changeSettings(cur, { source: 'cloud' }).error, /Choose how to connect/);
  // Empty keeps the saved link (privacy mode leaves the field blank); the same link is no change.
  const checked = { ...set.settings, columns: [{ header: 'Q', index: 1, role: 'comment' }] };
  assert.deepEqual(F.changeSettings(checked, { readerUrl: '  ' }), { settings: checked, sheetChanged: false });
  assert.deepEqual(F.changeSettings(checked, { readerUrl: EXEC }), { settings: checked, sheetChanged: false });
  // Another reader, or the other source, is another sheet: its columns are checked afresh.
  const other = F.changeSettings(checked, { readerUrl: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` });
  assert.deepEqual([other.sheetChanged, other.settings.columns], [true, []]);
  const toKey = F.changeSettings({ ...checked, sheetUrl: SHEET, keyPath: 'k.json' }, { source: 'key' });
  assert.deepEqual([toKey.sheetChanged, toKey.settings.columns, toKey.settings.readerUrl], [true, [], EXEC]);
  // A key file's settings switched to the reader: the sheet's columns go too.
  const keyed = { enabled: true, sheetUrl: SHEET, keyPath: 'k.json', columns: [{ header: 'Q', index: 1, role: 'comment' }] };
  const toReader = F.changeSettings(keyed, { source: 'reader' });
  assert.deepEqual([toReader.sheetChanged, toReader.settings.columns], [true, []]);
});

test('the cache is not reused across a switch of source or reader', () => {
  const rows = [['Saved (UTC)', 'Ease (1-5)'], ['2026-11-10T09:00:00.000Z', '4']];
  const fromReader = F.afterFetch(null, got(rows), { now: 1000, started: 900, link: READER });
  assert.equal(fromReader.deploymentId, DEPLOY);
  assert.equal(fromReader.spreadsheetId, null);
  const saved = JSON.parse(JSON.stringify(fromReader));
  assert.equal(F.validCache(saved, READER).cache.fetchedAt, 1000);
  assert.match(F.validCache(saved, KEY_LINK).problem, /another sheet or reader/);
  assert.match(F.validCache(saved, { deploymentId: OTHER_DEPLOY, url: 'x' }).problem, /another sheet or reader/);
  assert.equal(F.validCache(saved, KEY_LINK).cache, null);
  // The key file's cache is not the reader's either.
  const fromKey = F.afterFetch(null, { ...got(rows), tab: { id: 777, title: 'Form Responses 1' } }, { now: 1000, started: 900, link: KEY_LINK });
  assert.equal(fromKey.deploymentId, undefined);
  assert.equal(F.validCache(JSON.parse(JSON.stringify(fromKey)), READER).cache, null);
  assert.equal(F.validCache(JSON.parse(JSON.stringify(fromKey)), KEY_LINK).cache.fetchedAt, 1000);
  assert.match(F.validCache({ ...saved, deploymentId: 7 }, READER).problem, /could not be read/);
  // "New since" starts afresh with the other source, and a failure keeps no other source's rows.
  const later = F.afterFetch(fromKey, got([...rows, ['2026-11-12T09:00:00.000Z', '5']]), { now: 2000, started: 1900, link: READER });
  assert.deepEqual([later.since, later.sinceFetchedAt], [null, null]);
  const failed = F.afterFailure(fromKey, new F.FieldSurveyError('secret', 'x'), { now: 2000, started: 1900, link: READER });
  assert.deepEqual([failed.rows, failed.deploymentId], [null, DEPLOY]);
  const kept = F.afterFailure(fromReader, new F.FieldSurveyError('network', 'x'), { now: 2000, started: 1900, link: READER });
  assert.deepEqual(kept.rows, fromReader.rows);
});

// ---- the hosts -------------------------------------------------------------------------

test('no other file in src, electron or renderer names the reader’s hosts', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const dir of ['src', 'electron', 'renderer']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html|css)$/.test(e.name) && /script\.google(usercontent)?\.com/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(path.join(root, dir));
  }
  assert.deepEqual(hits.map((h) => h.replace(/\\/g, '/')), ['src/core/fieldsurvey.js']);
});

// Last: every error the tests above saw.
test('no error message, detail or log code carries the secret or the link, and messages carry no raw codes', () => {
  assert.ok(seen.length >= 30, `only ${seen.length} errors seen`);
  for (const err of seen) {
    for (const part of [err.message, err.detail, err.code]) {
      if (part == null) continue;
      assert.ok(!String(part).includes(SECRET), `the secret in: ${part}`);
      assert.ok(!String(part).includes(DEPLOY), `the link in: ${part}`);
    }
    assert.doesNotMatch(err.message, /\b(?:http \d{3}|\d{3}\)|not allowed|tab not found|net::)/, err.message);
    if (err.code) assert.ok(!err.message.includes(err.code), `the code "${err.code}" in: ${err.message}`);
  }
});
