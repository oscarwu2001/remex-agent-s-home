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
  // A Google Workspace link names the domain: the request still goes to the plain link.
  assert.deepEqual(F.parseReaderLink(`https://script.google.com/a/macros/example.org/s/${DEPLOY}/exec`), READER);
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com/a/macros/example.org/s/${DEPLOY}/dev`)).message, /\/dev/);
  assert.match(caught(() => F.parseReaderLink(`https://script.google.com/a/macros/s/${DEPLOY}/exec`)).message, /not a reader web app/);
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
  // No address to go on to: waiting will not bring one, so it waits for the user.
  const none = caught(() => F.readerHop(undefined));
  assert.equal(none.kind, 'reader');
  assert.match(none.message, /Settings → Connections → Field feedback/);
  assert.equal(caught(() => F.readerHop('   ')).kind, 'reader');
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
const OK = [200, { ok: true, tab: 'Demo Reports', timeZone: 'Asia/Taipei', values: ROWS }];
const MOVED = [302, '<html>moved</html>', { location: ECHO, contentType: 'text/html' }];

test('fetching posts the secret, follows the one redirect with a plain GET and reads the rows', async () => {
  const r = fakeReader([MOVED, OK]);
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: r.send });
  assert.deepEqual(got, { rows: ROWS, tab: { id: null, title: 'Demo Reports' }, timeZone: 'Asia/Taipei' });
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
  assert.equal((await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: bare.send }))).kind, 'reader');
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
  // An answer in the wrong shape will not mend itself: the user copies the script again.
  const shape = /not in the shape the app reads.*Copy reader script/;
  const garbled = await fail([200, '{"ok":tru']);
  assert.equal(garbled.kind, 'reader');
  assert.match(garbled.message, shape);
  const empty = await fail([200, { ok: true, tab: 'Demo Reports' }]);
  assert.equal(empty.kind, 'reader');
  assert.match(empty.message, shape);
  assert.match((await fail([200, { ok: true, values: [['a'], 'b'] }])).message, shape);
  assert.match((await fail([200, { ok: true, values: [['a', { b: 1 }]] }])).message, shape);
  assert.match((await fail([200, { ok: true, values: [['a', ['b']]] }])).message, shape);
  assert.equal((await fail([200, []])).kind, 'reader');
  assert.equal((await fail([200, { values: ROWS }])).kind, 'reader');
  assert.equal((await fail([200, { ok: false, error: 'something new' }])).kind, 'reader');
  // getDataRange always has a row: no rows at all is a wrong-shape answer too.
  assert.match((await fail([200, { ok: true, tab: 'T', timeZone: 'UTC', values: [] }])).message, shape);
});

test('an Apps Script error page is told from the sign-in page; its cleaned title goes to the log', async () => {
  const fail = async (last) => caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: fakeReader([MOVED, last]).send }));
  const crashed = await fail([200, '<!DOCTYPE html><html><head><title>Error</title></head><body><div>Script function not found: doPost</div></body></html>', { contentType: 'text/html' }]);
  assert.equal(crashed.kind, 'reader');
  assert.match(crashed.message, /reader script failed.*Executions/);
  assert.doesNotMatch(crashed.message, /Who has access/);
  assert.equal(crashed.code, 'html Error');
  const title = ['TypeError: x &amp;', DEPLOY, '/', SECRET, '&lt;y&gt; and a much longer tail of words here'].join(' ');
  const thrown = await fail([200, `<html><head><title>${title}</title></head><body>TypeError</body></html>`, { contentType: 'text/html' }]);
  assert.equal(thrown.kind, 'reader');
  // Letters, digits, spaces and : . - only, 60 at most, and never a long id or the secret.
  assert.match(thrown.code, /^html [\p{L}\p{N} :.-]{0,60}$/u);
  assert.ok(!thrown.code.includes(DEPLOY.slice(0, 12)) && !thrown.code.includes(SECRET.slice(0, 12)), thrown.code);
  const signIn = await fail([200, '<html><head><title>Sign in - Google Accounts</title></head><body><form action="https://accounts.google.com/ServiceLogin"></form></body></html>', { contentType: 'text/html' }]);
  assert.equal(signIn.kind, 'access');
  assert.match(signIn.message, /Who has access → Anyone/);
});

test("the reader's raw values become the strings the key file's rows use, and its time zone is the sheet's", async () => {
  const raw = [['Saved (UTC)', 'Ease (-3..3)', 'Seen', 'Note'], ['2026-11-10T09:00:00.000Z', -2, true, null], ['2026-11-11T09:00:00.000Z', 3, false, 'ok']];
  const answer = (values, zone) => fakeReader([MOVED, [200, { ok: true, tab: 'T', ...(zone ? { timeZone: zone } : {}), values }]]).send;
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(raw, 'Asia/Taipei') });
  assert.deepEqual(got.rows, [['Saved (UTC)', 'Ease (-3..3)', 'Seen', 'Note'], ['2026-11-10T09:00:00.000Z', '-2', 'TRUE', ''], ['2026-11-11T09:00:00.000Z', '3', 'FALSE', 'ok']]);
  assert.equal(got.timeZone, 'Asia/Taipei');
  assert.equal(got.zoneMissing, undefined);
  // The zone reaches the summary as the key file's does: a text date is read in it.
  const typed = [['Day', 'Ease (1-5)'], ['2026-11-10 09:00', 4]];
  const viaZone = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(typed, 'Asia/Taipei') });
  const s = F.summariseCache(F.afterFetch(null, viaZone, { now: 1, started: 1, link: READER }), []);
  assert.equal(s.newest, '2026-11-10T01:00:00.000Z'); // 09:00 in Taipei
  assert.equal(s.timeZone, 'Asia/Taipei');
  // An older reader names no zone: read in this computer's, and said under Needs attention.
  const older = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(typed) });
  assert.deepEqual([older.timeZone, older.zoneMissing], [undefined, true]);
  const kept = JSON.parse(JSON.stringify(F.afterFetch(null, older, { now: 1, started: 1, link: READER })));
  assert.equal(F.validCache(kept, READER).cache.zoneMissing, true);
  const summary = F.summariseCache(kept, []);
  assert.equal(summary.timeZone, 'local');
  const lines = F.fieldProblems({ enabled: true, cache: kept, summary }).map((p) => p.label);
  assert.ok(lines.some((l) => /reader did not say the sheet’s time zone.*this computer’s time zone/.test(l)), lines.join('\n'));
  assert.match(F.validCache({ ...kept, zoneMissing: 'yes' }, READER).problem, /could not be read/);
});

test('an answer over 20 MB is refused while it is read, as one the app does not read', async () => {
  assert.equal(F.READER_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(F.tooLarge(F.READER_MAX_BYTES), false);
  assert.equal(F.tooLarge(F.READER_MAX_BYTES + 1), true);
  const big = Object.assign(new Error('The answer is over the limit'), { name: 'TooLargeError' });
  const send = async () => ({ status: 200, contentType: 'application/json', text: async () => { throw big; } });
  const err = await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send }));
  assert.equal(err.kind, 'reader');
  assert.match(err.message, /larger than 20 MB/);
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
  // Another refusal (400, 405…) will not pass by itself: it waits for the user.
  for (const status of [400, 405, 410]) {
    const other = await fail([[status, '']]);
    assert.equal(other.kind, 'reader', String(status));
    assert.match(other.message, /Settings → Connections → Field feedback/);
  }
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
  const waiting = [
    await fail([MOVED, [200, { ok: false, error: 'not allowed' }]]), await fail([[403, '']]), await fail([[405, '']]),
    await fail([[302, '', {}]]), await fail([MOVED, [200, '{"ok":tru']]),
  ];
  for (const err of waiting) {
    assert.notEqual(plan(err).wakeAt, tried + F.RETRY_MS);
  }
});

// ---- the secret --------------------------------------------------------------------

test('the secret is saved only where the system can protect it, never as plain text', () => {
  const ready = { available: true, readerUrl: EXEC };
  const off = F.checkSecret(SECRET, { ...ready, available: false });
  assert.equal(off.secret, undefined);
  assert.match(off.error, /never keeps it as plain text/);
  // Linux with no keyring: Electron's "basic_text" is no protection.
  assert.match(F.checkSecret(SECRET, { ...ready, backend: 'basic_text' }).error, /plain text/);
  assert.deepEqual(F.checkSecret(`  ${SECRET}\n`, ready), { secret: SECRET, deploymentId: DEPLOY });
  assert.deepEqual(F.checkSecret(SECRET, { ...ready, backend: 'gnome_libsecret' }), { secret: SECRET, deploymentId: DEPLOY });
  const short = F.checkSecret('tooshort', ready);
  assert.match(short.error, /32 characters or more.*READER_SECRET/);
  assert.ok(!short.error.includes('tooshort'));
  assert.match(F.checkSecret(`${SECRET.slice(0, 20)} ${SECRET.slice(20)}`, ready).error, /no spaces/);
  assert.match(F.checkSecret('', ready).error, /^No secret yet/);
  assert.match(F.checkSecret(undefined, ready).error, /^No secret yet/);
  // Replacing a saved one: empty is not "no secret yet".
  assert.match(F.checkSecret('', { ...ready, saved: true }).error, /^Paste the new secret, or press Cancel to keep the saved one/);
  // The secret belongs to a reader: none saved, none taken.
  assert.match(F.checkSecret(SECRET, { available: true, readerUrl: '' }).error, /Save the reader link first/);
  // What Settings is told before anything is typed.
  assert.equal(F.secretStorage({ available: true }), null);
  assert.match(F.secretStorage({ available: false }), /no protected storage/);
  assert.match(F.secretStorage({ available: true, backend: 'basic_text' }), /no protected storage/);
});

test('the saved secret belongs to one reader: another reader link drops it and asks again', () => {
  const sealed = Buffer.from([1, 2, 3, 250]);
  const text = F.sealSecret(DEPLOY, sealed);
  assert.ok(!text.includes(SECRET));
  assert.deepEqual(F.openSecret(text, DEPLOY), sealed);
  assert.equal(F.secretFor(text), DEPLOY);
  const other = caught(() => F.openSecret(text, OTHER_DEPLOY));
  assert.equal(other.kind, 'setup');
  assert.match(other.message, /another reader link.*Save this reader’s secret/);
  const broken = caught(() => F.openSecret('{"version":1}', DEPLOY));
  assert.equal(broken.kind, 'secret');
  assert.equal(caught(() => F.openSecret('not json', DEPLOY)).kind, 'secret');
  assert.equal(F.secretFor('not json'), null);
  // A new link for another reader makes the saved secret stale; the same reader, the key file, or no link does not.
  const reader = (url) => ({ enabled: true, source: 'reader', readerUrl: url });
  assert.equal(F.secretStale(DEPLOY, reader(`https://script.google.com/macros/s/${OTHER_DEPLOY}/exec`)), true);
  assert.equal(F.secretStale(DEPLOY, reader(EXEC)), false);
  assert.equal(F.secretStale(DEPLOY, { ...reader(`https://script.google.com/macros/s/${OTHER_DEPLOY}/exec`), source: 'key', sheetUrl: 'x' }), false);
  assert.equal(F.secretStale(null, reader(EXEC)), false);
});

test('a saved secret that is gone, locked or not the app’s to read waits for the user; one busy just now is tried again', () => {
  const gone = F.secretFileError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
  const busy = F.secretFileError(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
  const denied = F.secretFileError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
  const forbidden = F.secretFileError(Object.assign(new Error('EPERM: not permitted'), { code: 'EPERM' }));
  const locked = F.secretLocked();
  seen.push(gone, busy, denied, forbidden, locked);
  assert.deepEqual([gone.kind, busy.kind, denied.kind, forbidden.kind, locked.kind], ['setup', 'secretfile', 'secret', 'secret', 'secret']);
  assert.match(denied.message, /Save the secret again/);
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

test('the reader’s tab is part of what was read: a new TAB starts "new since" afresh', () => {
  const rows = [['Saved (UTC)', 'Ease (1-5)'], ['2026-11-10T09:00:00.000Z', '4']];
  const more = [...rows, ['2026-11-12T09:00:00.000Z', '5']];
  const onA = F.afterFetch(null, { ...got(rows), tab: { id: null, title: 'Answers A' } }, { now: 1000, started: 900, link: READER });
  // The same tab again with something new: "new since" moves.
  const sameTab = F.afterFetch(onA, { ...got(more), tab: { id: null, title: 'Answers A' } }, { now: 2000, started: 1900, link: READER });
  assert.deepEqual([sameTab.since, sameTab.sinceFetchedAt], ['2026-11-10T09:00:00.000Z', 1000]);
  // Another tab: nothing carried over.
  const onB = F.afterFetch(onA, { ...got(more), tab: { id: null, title: 'Answers B' } }, { now: 2000, started: 1900, link: READER });
  assert.deepEqual([onB.since, onB.sinceFetchedAt, onB.tab.title], [null, null, 'Answers B']);
});

test('a read is asked for (a new secret, or a read that found its settings changed) is made at once', () => {
  const now = Date.UTC(2026, 10, 16, 9);
  const settings = { enabled: true, source: 'reader', readerUrl: EXEC, secretSaved: true };
  // Read after this morning's slot: nothing due until Wednesday…
  const fresh = { fetchedAt: now - 5 * 60_000, lastAttemptAt: now - 5 * 60_000, lastError: null };
  assert.equal(F.planFetch({ now, settings, cache: fresh }).fetch, false);
  // …unless a read was asked for.
  assert.deepEqual(F.planFetch({ now, settings, cache: fresh, asked: true }), { fetch: true, wakeAt: null });
  // Not while one runs, nor when off or not set up.
  assert.equal(F.planFetch({ now, settings, cache: fresh, asked: true, busy: true }).fetch, false);
  assert.equal(F.planFetch({ now, settings: { ...settings, enabled: false }, cache: fresh, asked: true }).fetch, false);
  assert.equal(F.planFetch({ now, settings: { ...settings, secretSaved: false }, cache: fresh, asked: true }).fetch, false);
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

// ---- Settings and the board (renderer/field-view.js) -----------------------------------------

const view = () => import('../renderer/field-view.js');
const readerField = (extra = {}) => ({ enabled: true, source: 'reader', readerUrl: '', secretSaved: false, sheetUrl: '', keyName: '', ...extra });

test('Settings: how to connect, then the reader link and the secret, each with its own Save', async () => {
  const { fieldSettingsHtml } = await view();
  const html = fieldSettingsHtml(readerField(), { privacy: true });
  assert.match(html, /<legend>How to connect<\/legend>/);
  assert.match(html, /<input type="radio" name="field-source" value="reader" checked> Apps Script reader \(link and secret\)/);
  assert.match(html, /<input type="radio" name="field-source" value="key"> Google key file/);
  assert.match(html, /data-field="copy-script">Copy reader script</);
  assert.match(html, /<label class="field-entry-label" for="field-reader-link">Reader link<\/label>/);
  assert.match(html, /<label class="field-entry-label" for="field-secret">Secret<\/label>/);
  assert.match(html, /<input id="field-secret" type="password"/);
  // Nothing of the key file's route shows.
  assert.doesNotMatch(html, /Choose key file|field-link-form|Copy reader address/);
  // One filled button at a time: the secret's Save is plain until a link is saved.
  assert.match(html.split('field-secret-form')[1], /<button class="link-btn" type="submit">Save/);
  assert.doesNotMatch(html, /field-refresh/); // nothing to read yet
});

test('a saved secret shows only that it is saved, with Replace; the link shows only with privacy off', async () => {
  const { fieldSettingsHtml } = await view();
  const set = readerField({ readerUrl: EXEC, secretSaved: true });
  const shared = fieldSettingsHtml(set, { privacy: true });
  assert.match(shared, /Secret saved\.<\/span>\s*<button[^>]*data-field="replace-secret">Replace<\/button>/);
  assert.doesNotMatch(shared, /type="password"/);
  assert.match(shared, /A reader link is saved\./);
  assert.ok(!shared.includes(DEPLOY));
  assert.match(shared, /id="field-refresh"/);
  assert.ok(fieldSettingsHtml(set, { privacy: false }).includes(EXEC));
  // Replace opens an empty secret field; Change link opens the link, empty with privacy on.
  const again = fieldSettingsHtml(set, { privacy: true, state: { secretEditing: true, readerEditing: true } });
  assert.match(again, /<input id="field-secret" type="password"[^>]*>/);
  assert.doesNotMatch(again.match(/<input id="field-secret"[^>]*>/)[0], /value=/);
  assert.match(again, /<input id="field-reader-link"[^>]*value=""/);
  assert.match(again, /Leave it empty to keep the saved link/);
});

test('a refused link or secret marks its own field invalid and names why', async () => {
  const { fieldSettingsHtml } = await view();
  const html = fieldSettingsHtml(readerField(), { privacy: true, state: { readerError: 'That is the test link (it ends in /dev).', secretError: 'Not saved: no protected storage.' } });
  assert.match(html, /<input id="field-reader-link"[^>]*aria-invalid="true" aria-describedby="field-reader-link-err"/);
  assert.match(html, /<p class="form-error" id="field-reader-link-err" role="alert">That is the test link/);
  assert.match(html, /<input id="field-secret"[^>]*aria-invalid="true" aria-describedby="field-secret-err field-secret-hint"/);
  assert.match(html, /id="field-secret-err" role="alert">Not saved: no protected storage\./);
  // Without an error, no field is marked.
  assert.doesNotMatch(fieldSettingsHtml(readerField(), { privacy: true }), /aria-invalid/);
});

test('the key file route shows as before, with the choice above it', async () => {
  const { fieldSettingsHtml } = await view();
  const html = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '' }, { privacy: true });
  assert.match(html, /value="key" checked> Google key file/);
  assert.match(html, /id="field-link-form"/);
  assert.match(html, /Choose key file…/);
  assert.doesNotMatch(html, /field-reader-link|field-secret|Copy reader script/);
});

test('the board asks for the reader link, then the secret, before anything else', async () => {
  const { fieldHtml } = await view();
  assert.match(fieldHtml(readerField(), { privacy: true }), /First paste the reader script’s web app link/);
  assert.match(fieldHtml(readerField({ readerUrl: EXEC }), { privacy: true }), /Now save the reader’s secret/);
  assert.match(fieldHtml(readerField({ readerUrl: EXEC, secretSaved: true }), { privacy: true }), /Not updated yet/);
});

test('a scale around 0 reads "on −3 to 3" on the board, its meter from its low end, and its flags in the same words', async () => {
  const { fieldHtml, fieldSheetHtml, flagText, fieldColumnsHtml } = await view();
  const rows = [['Hub saved (UTC)', 'Comfort (-3..3)'], ['2026-11-10T09:00:00.000Z', '-3'], ['2026-11-11T09:00:00.000Z', '2'], ['2026-11-12T09:00:00.000Z', '-2']];
  const s = F.summarise(rows);
  const f = readerField({ readerUrl: EXEC, secretSaved: true, summary: s, fetchedAt: Date.UTC(2026, 10, 12) });
  // The mean is -1: a sixth of the way from -3 to 3 is 33%.
  assert.match(fieldHtml(f, { privacy: true }), />−1\.0<small> on −3 to 3<\/small>/);
  const sheet = fieldSheetHtml(f, { privacy: true });
  assert.match(sheet, /aria-label="−1\.0 on −3 to 3"><span style="width:33%">/);
  assert.match(sheet, /3 answers on a −3 to 3 scale/);
  assert.equal(flagText({ kind: 'low', no: 1, count: 2, mark: -2, low: -3, high: 3 }), '2 low scores on Question 1 in the last 7 days (−2 or less on −3 to 3)');
  assert.equal(flagText({ kind: 'falling', no: 1, recentN: 4, recentMean: -1, earlierMean: 2, low: -3, high: 3 }), 'Question 1 average down to −1.0 on −3 to 3 in the last 7 days (was 2.0)');
  // A scale from 1 reads as before.
  assert.equal(flagText({ kind: 'low', no: 1, count: 1, mark: 2, low: 1, high: 5 }), '1 low score on Question 1 in the last 7 days (2 or less on 1–5)');
  // Check the columns offers the low end below 0, with its value, and the stated one chosen.
  const step = fieldColumnsHtml(f, { privacy: false });
  const row = step.split('<li').find((x) => x.includes('Comfort'));
  assert.match(row, /<option value="-3" selected>−3<\/option>/);
  assert.match(row, /<option selected>3<\/option>/);
  assert.match(fieldColumnsHtml(f, { privacy: true }), /Score, −3 to 3/);
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
