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
  // Whole words of plain letters only, 40 at most, and never a long id or the secret.
  assert.match(thrown.code, /^html [A-Za-z ]{1,40}$/);
  assert.ok(!thrown.code.includes(DEPLOY.slice(0, 12)) && !thrown.code.includes(SECRET.slice(0, 12)), thrown.code);
  // A name, an address or a number in the title is not a word of it.
  const titled = async (t) => (await fail([200, `<html><head><title>${t}</title></head><body>x</body></html>`, { contentType: 'text/html' }])).code;
  const email = await titled('Error for john.smith@example.org');
  assert.equal(email, 'html Error for');
  const cjk = await titled('錯誤 王小明 0912345678');
  assert.equal(cjk, 'html other');
  for (const part of ['john', 'smith', 'example', '王小明', '0912345678']) {
    assert.ok(!email.includes(part) && !cjk.includes(part), `${part} in ${email} / ${cjk}`);
  }
  const signIn = await fail([200, '<html><head><title>Sign in - Google Accounts</title></head><body><form action="https://accounts.google.com/ServiceLogin"></form></body></html>', { contentType: 'text/html' }]);
  assert.equal(signIn.kind, 'access');
  assert.match(signIn.message, /Who has access → Anyone/);
});

const answer = (values, zone) => fakeReader([MOVED, [200, { ok: true, tab: 'T', ...(zone ? { timeZone: zone } : {}), values }]]).send;

test("the reader's raw values stay as the key file's rows have them (numbers and true/false), an empty cell empty, and its time zone is the sheet's", async () => {
  const raw = [['Saved (UTC)', 'Ease (-3..3)', 'Seen', 'Note'], ['2026-11-10T09:00:00.000Z', -2, true, null], ['2026-11-11T09:00:00.000Z', 3, false, 'ok']];
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(raw, 'Asia/Taipei') });
  assert.deepEqual(got.rows, [['Saved (UTC)', 'Ease (-3..3)', 'Seen', 'Note'], ['2026-11-10T09:00:00.000Z', -2, true, ''], ['2026-11-11T09:00:00.000Z', 3, false, 'ok']]);
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

test('a column of long whole numbers is guessed the same through the reader as through the key file', async () => {
  // Eight digits: the key file sends numbers, and so does the reader; neither reads them as phone numbers typed in.
  const rows = [['Saved (UTC)', 'Ref', 'Ease (1-5)'], ['2026-11-10T09:00:00.000Z', 12345678, 4], ['2026-11-11T09:00:00.000Z', 23456789, 5],
    ['2026-11-12T09:00:00.000Z', 34567890, 3]];
  const viaReader = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(rows, 'UTC') });
  const ref = (r) => F.summarise(r, { timeZone: 'UTC' }).columns.find((c) => c.header === 'Ref').suggested;
  assert.deepEqual(ref(viaReader.rows), ref(rows));
  assert.deepEqual(ref(rows), { role: 'identifying', reason: 'numbers', confidence: 'low' });
});

test('a title saying UTC or GMT reads only text dates with no zone as UTC; a date cell is the same moment by either route', async () => {
  const viaReader = async (header, cell) => {
    const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer([[header, 'Ease (1-5)'], [cell, 4]], 'Asia/Taipei') });
    return F.summariseCache(F.afterFetch(null, got, { now: 1, started: 1, link: READER }), []).newest;
  };
  // (a) A date cell showing 2026-11-10 09:00 in an Asia/Taipei sheet: the key file sends its serial day
  // (a wall clock in the sheet's zone), the reader the moment itself. Both are 01:00 UTC, whatever the title.
  const serial = 25_569 + Date.UTC(2026, 10, 10, 9) / 86_400_000;
  const viaKey = F.summarise([['Hub saved (UTC)', 'Ease (1-5)'], [serial, 4]], { timeZone: 'Asia/Taipei' }).newest;
  assert.equal(viaKey, '2026-11-10T01:00:00.000Z');
  assert.equal(await viaReader('Hub saved (UTC)', '2026-11-10T01:00:00.000Z'), viaKey);
  // (b) Text with no zone of its own, under that title: UTC, as the title says.
  assert.equal(await viaReader('Hub saved (UTC)', '2026-11-10 09:00:00'), '2026-11-10T09:00:00.000Z');
  assert.equal(await viaReader('Saved at (GMT)', '2026-11-10 09:00'), '2026-11-10T09:00:00.000Z');
  assert.equal(await viaReader('Timestamp UTC', '2026-11-10 09:00'), '2026-11-10T09:00:00.000Z');
  // (c) Under a title naming no zone, or an offset, the same text is read in the sheet's zone.
  assert.equal(await viaReader('Timestamp', '2026-11-10 09:00:00'), '2026-11-10T01:00:00.000Z');
  assert.equal(await viaReader('Saved at (GMT+8)', '2026-11-10 09:00'), '2026-11-10T01:00:00.000Z');
});

test('a time of day alone (the reader sends it on 1899-12-30) is not a date, so its column is never the timestamp', async () => {
  const rows = [['Start time', 'Visit day', 'Ease (1-5)'],
    ['1899-12-30T01:00:00.000Z', '2026-11-10T09:00:00.000Z', 4], ['1899-12-30T02:30:00.000Z', '2026-11-11T09:00:00.000Z', 5]];
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(rows, 'UTC') });
  const s = F.summarise(got.rows, { timeZone: 'UTC' });
  assert.equal(s.timestampColumn, 'Visit day');
  assert.equal(s.newest, '2026-11-11T09:00:00.000Z');
  // Times alone with nothing else: no timestamp at all, rather than one in 1899.
  const only = F.summarise([['Time', 'Ease (1-5)'], ['1899-12-30T01:00:00.000Z', 4], ['1899-12-30T02:00:00.000Z', 5]], { timeZone: 'UTC' });
  assert.deepEqual([only.timestampColumn, only.newest], [null, null]);
  // Only years before 1900 are not dates: 1899-12-30 is a time of day, 1900 on a date.
  assert.ok(!Number.isFinite(F.dateOf('1899-12-31T23:59:59.000Z')));
  assert.equal(F.dateOf('1900-01-01T00:00:00.000Z'), Date.UTC(1900, 0, 1));
});

test('dates before 1970 sent by the reader are dates, as they always were', async () => {
  const rows = [['Timestamp', 'Installed', 'Ease (1-5)'],
    ...[1961, 1962, 1963, 1964, 1965].map((y, k) => [`2026-11-1${k}T09:00:00.000Z`, `${y}-06-01T00:00:00.000Z`, 4])];
  const got = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(rows, 'UTC') });
  const s = F.summarise(got.rows, { timeZone: 'UTC' });
  assert.deepEqual(s.columns.find((c) => c.header === 'Installed').suggested, { role: 'ignore', reason: 'dates', confidence: 'high' });
  assert.equal(s.timestampColumn, 'Timestamp');
  assert.equal(F.dateOf('1961-06-01T00:00:00.000Z'), Date.UTC(1961, 5, 1));
});

test('a time zone longer than any real one is taken as none, and Needs attention says so', async () => {
  const typed = [['Day', 'Ease (1-5)'], ['2026-11-10 09:00', 4]];
  const long = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(typed, `Asia/${'x'.repeat(60)}`) });
  assert.deepEqual([long.timeZone, long.zoneMissing], [undefined, true]);
  const atCap = await F.fetchReaderRows({ link: READER, secret: SECRET, send: answer(typed, `America/${'Y'.repeat(56)}`) });
  assert.equal(atCap.timeZone.length, 64);
  const kept = F.afterFetch(null, long, { now: 1, started: 1, link: READER });
  const lines = F.fieldProblems({ enabled: true, cache: kept, summary: F.summariseCache(kept, []) }).map((p) => p.label);
  assert.ok(lines.some((l) => /reader did not say the sheet’s time zone/.test(l)), lines.join('\n'));
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
  // A keyring set up later is used only once the app starts again.
  assert.match(F.secretStorage({ available: true, backend: 'basic_text' }), /set up a keyring, then restart Agent’s Home\.$/);
});

test('the reader script that ships asks only for its own sheet, sends its values and zone, and refuses a short secret', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'docs', 'field-feedback-reader.gs'), 'utf8').split(/\r?\n/);
  // Alone on the first line, or Apps Script asks for every spreadsheet the user has.
  assert.equal(lines[0], '/** @OnlyCurrentDoc */');
  const code = lines.filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /\.getValues\(\)/);
  assert.doesNotMatch(code, /getDisplayValues/);
  assert.match(code, /\.getSpreadsheetTimeZone\(\)/);
  assert.match(code, /secret\.length < 32\b/);
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

test('at start: the old secret file goes, off keeps no secret, and a carried cache is written in the old one’s place', () => {
  const rows = [['Saved (UTC)', 'Ease (1-5)'], ['2026-11-10T09:00:00.000Z', 4]];
  const good = JSON.parse(JSON.stringify(F.afterFetch(null, got(rows), { now: 1000, started: 900, link: KEY_LINK })));
  const plan = (o) => F.startPlan({ enabled: true, secretSaved: false, found: true, checked: F.validCache(good, KEY_LINK), ...o });
  // The earlier build's secret file, tied to no reader, is never read: it goes every start. The secret in use stays.
  assert.deepEqual(plan({}).remove, ['field-reader-secret.bin']);
  assert.ok(!plan({}).remove.includes('field-reader-secret.json'));
  assert.deepEqual([plan({}).dropSecret, plan({ secretSaved: true }).dropSecret, plan({ enabled: false, secretSaved: true }).dropSecret], [false, false, true]);
  // This sheet's cache is kept; a version 4 one, carried, is written over the old file at once (its rows leave the disk).
  assert.equal(plan({}).cache, 'keep');
  assert.equal(plan({ checked: F.validCache({ ...good, version: 4 }, KEY_LINK) }).cache, 'write');
  // Off, another sheet's, or not readable: dropped; none there: nothing to do.
  assert.equal(plan({ enabled: false }).cache, 'drop');
  const another = F.parseSheetLink('https://docs.google.com/spreadsheets/d/1AnotherInventedSheet0123456789abcdefgh/edit#gid=777');
  assert.equal(plan({ checked: F.validCache(good, another) }).cache, 'drop');
  assert.equal(plan({ checked: F.validCache({ ...good, rows: 'x' }, KEY_LINK) }).cache, 'drop');
  assert.equal(plan({ found: false, checked: F.validCache(null, KEY_LINK) }).cache, 'none');
});

test('a settings change drops the secret only when off or for another reader, and says so only when it is really gone', () => {
  // Off keeps no secret; another reader's link drops the old reader's; the same reader keeps it.
  assert.equal(F.secretGoes({ turnedOff: true, sheetChanged: false, stale: false }), true);
  assert.equal(F.secretGoes({ turnedOff: false, sheetChanged: true, stale: true }), true);
  assert.equal(F.secretGoes({ turnedOff: false, sheetChanged: true, stale: false }), false);
  assert.equal(F.secretGoes({ turnedOff: false, sheetChanged: false, stale: true }), false);
  // The note comes from the state after: removed, it is said; still there (Needs attention says why), or not tried, it is not.
  const note = (o) => F.secretNote({ turnedOff: false, stale: true, dropped: true, savedAfter: false, ...o });
  assert.match(note({}), /^The saved secret was the old reader’s, so it was removed: save this reader’s secret\.$/);
  assert.equal(note({ savedAfter: true }), null);
  assert.equal(note({ dropped: false }), null);
  assert.equal(note({ stale: false }), null);
  assert.equal(note({ turnedOff: true }), null);
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
const readerField = (extra = {}) => ({ enabled: true, source: 'reader', readerUrl: '', secretSaved: false, sheetUrl: '', keyName: '', secretStorage: null, checkedColumns: 0, ...extra });
const NO_STORE = F.secretStorage({ available: false });

test('Settings: how to connect, the set-up step, then the reader link and the secret, each with its own Save', async () => {
  const { fieldSettingsHtml } = await view();
  const html = fieldSettingsHtml(readerField(), { privacy: true });
  assert.match(html, /<fieldset class="field field-source"><legend>How to connect<\/legend>/);
  // Each radio has its id, so a redraw keeps focus on it (paint finds it again).
  assert.match(html, /<input type="radio" name="field-source" id="field-source-reader" value="reader" checked> Apps Script reader \(link and secret\)/);
  assert.match(html, /<input type="radio" name="field-source" id="field-source-key" value="key"> Google key file/);
  // What switching costs is said when it is asked, not always.
  assert.doesNotMatch(html, /Switching starts afresh|field-source-hint/);
  // The steps, numbered: Google's own labels, where the link and the secret go, and no README (not in the app).
  const steps = html.match(/<ol class="field-steps">([\s\S]*?)<\/ol>/)[1].match(/<li>[\s\S]*?<\/li>/g);
  assert.equal(steps.length, 4);
  assert.match(steps[0], /Copy reader script.*Extensions → Apps Script.*set TAB at the top to your answers’ tab/);
  assert.match(steps[1], /run makeSecret once/i);
  assert.match(steps[2], /\(Execute as: Me; Who has access: Anyone\).*copy the Web app link into Reader link/);
  assert.match(steps[3], /copy READER_SECRET from Project Settings → Script properties into Secret/i);
  // Before anything is saved, each Save sits beside its field.
  assert.match(html, /<div class="add-row"><input id="field-reader-link"[^>]*>\s*<button class="button" type="submit">Save link<\/button><\/div>/);
  assert.doesNotMatch(html, /README/);
  assert.match(html, /data-field="copy-script">Copy reader script</);
  assert.match(html, /<label class="field-entry-label" for="field-reader-link">Reader link<\/label>/);
  assert.match(html, /<label class="field-entry-label" for="field-secret">Secret<\/label>/);
  assert.match(html, /<input id="field-secret" type="password" autocomplete="new-password"/);
  assert.match(html, /<button class="button" type="submit">Save link<\/button>/);
  // One filled button at a time: the secret's Save is plain until a link is saved.
  assert.match(html, /<button class="link-btn" type="submit">Save secret<\/button>/);
  assert.match(html, /Kept encrypted with this computer’s own protection/);
  assert.doesNotMatch(html, /Choose key file|field-link-form|Copy reader address/);
  assert.doesNotMatch(html, /field-refresh/); // nothing to read yet
  assert.doesNotMatch(html, /Cancel/); // nothing saved to go back to
});

test('a saved secret shows only that it is saved, with Replace secret; the link shows only with privacy off', async () => {
  const { fieldSettingsHtml } = await view();
  const set = readerField({ readerUrl: EXEC, secretSaved: true });
  const shared = fieldSettingsHtml(set, { privacy: true });
  assert.match(shared, /Secret saved\.<\/span>\s*<button[^>]*id="field-secret-replace"[^>]*>Replace secret<\/button>/);
  assert.doesNotMatch(shared, /type="password"/);
  assert.match(shared, /A reader link is saved\./);
  assert.ok(!shared.includes(DEPLOY));
  assert.match(shared, /<button type="button" class="button" id="field-refresh"/);
  assert.ok(fieldSettingsHtml(set, { privacy: false }).includes(EXEC));
});

test('Replace and Change link open with Cancel; Refresh now steps back while a field is open', async () => {
  const { fieldSettingsHtml } = await view();
  const set = readerField({ readerUrl: EXEC, secretSaved: true });
  const again = fieldSettingsHtml(set, { privacy: true, state: { secretEditing: true, readerEditing: true } });
  assert.match(again, /<input id="field-secret" type="password"[^>]*>/);
  assert.doesNotMatch(again.match(/<input id="field-secret"[^>]*>/)[0], /value=/);
  assert.match(again, /<input id="field-reader-link"[^>]*value=""/);
  // Over a saved value, Save and Cancel get their own row under the field; each Cancel says what it cancels.
  assert.match(again, /<div class="add-row"><input id="field-reader-link"[^>]*><\/div>\s*<div class="form-actions field-entry-actions"><button class="button" type="submit">Save link<\/button>\s*<button type="button" class="link-btn" data-field="cancel-reader" aria-label="Cancel link change">Cancel<\/button><\/div>/);
  assert.match(again, /<div class="add-row"><input id="field-secret"[^>]*><\/div>\s*<div class="form-actions field-entry-actions"><button class="link-btn" type="submit">Save secret<\/button>\s*<button type="button" class="link-btn" data-field="cancel-secret" aria-label="Cancel secret change">Cancel<\/button><\/div>/);
  assert.match(again, /<button type="button" class="link-btn" id="field-refresh"/);
  // Cancel is the way back to the saved link: no hint about leaving the field empty, with privacy on or off.
  assert.doesNotMatch(again, /Leave it empty/);
  assert.doesNotMatch(fieldSettingsHtml(set, { privacy: false, state: { readerEditing: true } }), /Leave it empty/);
  const keyAgain = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit', keyName: '' }, { privacy: true, state: { editing: true } });
  assert.match(keyAgain, /data-field="cancel-link"/);
  assert.doesNotMatch(keyAgain, /Leave it empty/);
  // Every field's form leaves checking to the app, whose own error says what is wrong.
  for (const id of ['field-reader-link', 'field-secret']) assert.match(again, new RegExp(`<form class="field-entry" id="${id}-form" novalidate>`));
  assert.match(keyAgain, /<form class="field-entry" id="field-link-form" novalidate>/);
});

test('a refused link or secret marks its own field invalid, names why, and keeps the link as typed', async () => {
  const { fieldSettingsHtml } = await view();
  const typed = EXEC.replace('/exec', '/dev');
  const html = fieldSettingsHtml(readerField(), { privacy: true, state: { readerError: 'That is the test link (it ends in /dev).', readerDraft: typed, secretError: 'Not saved: no protected storage.' } });
  assert.match(html, /<input id="field-reader-link"[^>]*aria-invalid="true" aria-describedby="field-reader-link-err"/);
  assert.ok(html.includes(`value="${typed}"`));
  assert.match(html, /<p class="form-error" id="field-reader-link-err" role="alert">That is the test link/);
  assert.match(html, /<input id="field-secret"[^>]*aria-invalid="true" aria-describedby="field-secret-err field-secret-hint"/);
  assert.match(html, /id="field-secret-err" role="alert">Not saved: no protected storage\./);
  // Without an error, no field is marked.
  assert.doesNotMatch(fieldSettingsHtml(readerField(), { privacy: true }), /aria-invalid/);
});

test('a refused link kept as typed is dropped when privacy mode turns on or Settings closes', async () => {
  const { fieldSettingsHtml, dropFieldDrafts } = await view();
  const typed = EXEC.replace('/exec', '/dev');
  const sheet = 'https://docs.google.com/spreadsheets/d/typed-not-saved/edit';
  const state = { readerDraft: typed, readerError: 'That is the test link (it ends in /dev).', linkDraft: sheet, linkError: 'Not saved.', readerEditing: true, secretError: 'Not saved.', note: 'n' };
  assert.equal(dropFieldDrafts(state), state);
  // The links typed go with the refusals about them; what is open stays open, and the rest stays.
  assert.deepEqual(state, { readerDraft: null, readerError: '', linkDraft: null, linkError: '', readerEditing: true, secretError: 'Not saved.', note: 'n' });
  const html = fieldSettingsHtml(readerField({ readerUrl: EXEC, secretSaved: true }), { privacy: true, state });
  assert.ok(!html.includes(typed) && !html.includes(DEPLOY), 'no link typed or saved shows');
  assert.match(html, /<input id="field-reader-link"[^>]*value=""/);
  const keyHtml = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '' }, { privacy: true, state: dropFieldDrafts({ linkDraft: sheet, linkError: 'x' }) });
  assert.ok(!keyHtml.includes('typed-not-saved'));
});

test('with no protected storage, How to connect says so: the reader cannot be chosen, and no secret is promised', async () => {
  const { fieldSettingsHtml } = await view();
  const onKey = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '', secretStorage: NO_STORE }, { privacy: true });
  assert.match(onKey, /<input type="radio" name="field-source" id="field-source-reader" value="reader" disabled>/);
  assert.match(onKey, /id="field-source-storage">This computer has no protected storage/);
  assert.match(onKey, /<fieldset class="field field-source" aria-describedby="field-source-storage">/);
  // A keyring set up later counts once the app starts again, and the hint says so.
  assert.match(onKey, /set up a keyring, then restart Agent’s Home\./);
  const onReader = fieldSettingsHtml(readerField({ readerUrl: EXEC, secretStorage: NO_STORE }), { privacy: true });
  assert.doesNotMatch(onReader, /type="password"|Kept encrypted/);
  assert.match(onReader, /no protected storage/);
});

test('switching with checked columns asks first, in place; the reply to each button sits by it', async () => {
  const { fieldSettingsHtml } = await view();
  const asking = fieldSettingsHtml(readerField({ checkedColumns: 4 }), { privacy: true, state: { pendingSource: 'key' } });
  assert.match(asking, /id="field-source-key" value="key" checked>/);
  assert.match(asking, /Switching starts afresh: the checked columns and kept answers go\./);
  // Each button names the way it leads to.
  assert.match(asking, /data-field="switch-source">Switch to key file</);
  assert.match(asking, /data-field="keep-source">Keep the reader</);
  const back = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '', checkedColumns: 4 }, { privacy: true, state: { pendingSource: 'reader' } });
  assert.match(back, /data-field="switch-source">Switch to reader</);
  assert.match(back, /data-field="keep-source">Keep the key file</);
  // While it asks, Switch is the one filled button: Refresh now steps back, on either way.
  const ready = fieldSettingsHtml(readerField({ readerUrl: EXEC, secretSaved: true, checkedColumns: 4 }), { privacy: true, state: { pendingSource: 'key' } });
  assert.match(ready, /<button type="button" class="link-btn" id="field-refresh"/);
  const keyReady = { enabled: true, source: 'key', sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit', keyName: 'k.json', checkedColumns: 4 };
  assert.match(fieldSettingsHtml(keyReady, { privacy: true, state: { pendingSource: 'reader' } }), /<button type="button" class="link-btn" id="field-refresh"/);
  assert.match(fieldSettingsHtml(keyReady, { privacy: true }), /<button type="button" class="button" id="field-refresh"/);
  assert.doesNotMatch(fieldSettingsHtml(readerField(), { privacy: true }), /switch-source|Switching starts afresh/);
  // The source's refusal under its choice; Copy reader script's reply under its button.
  const replies = fieldSettingsHtml(readerField(), { privacy: true, state: { sourceError: 'Not saved.', scriptNote: 'Reader script copied.' } });
  assert.match(replies, /<\/fieldset>\s*<p class="form-error" id="field-source-err" role="alert">Not saved\.<\/p>/);
  assert.match(replies, /data-field="copy-script">Copy reader script<\/button><\/div>\s*<p class="hint" role="status">Reader script copied\.<\/p>/);
});

test('in Settings a failed update names the button or field in view, and reads on after its colon; the board keeps the Settings path', async () => {
  const { fieldSettingsHtml, fieldHtml } = await view();
  const err = 'The reader refused the secret: it does not match the reader’s. Copy READER_SECRET from the reader script’s Project Settings → Script properties, then save it in Settings → Connections → Field feedback.';
  const f = readerField({ readerUrl: EXEC, secretSaved: true, error: err, errorHere: F.settingsWords(err), errorAt: Date.UTC(2026, 10, 17, 9) });
  // The secret is saved, its field folded: Replace secret is what shows.
  const html = fieldSettingsHtml(f, { privacy: true });
  assert.match(html, /Last update failed \([^)]*\): the reader refused the secret: .*, then press Replace secret and save the new one\.<\/p>/);
  assert.doesNotMatch(html, /\bbelow\b|Settings → Connections/);
  // Replace secret pressed: the Secret field shows, and the message names it.
  assert.match(fieldSettingsHtml(f, { privacy: true, state: { secretEditing: true } }), /, then save it under Secret\.<\/p>/);
  assert.match(fieldHtml(f, { privacy: true }), /then save it in Settings → Connections → Field feedback\./);
  // A link the reader is not at: Change link while folded, Reader link once open.
  const gone404 = 'No reader answers at this link: its deployment may have been archived or deleted. In the reader script, Deploy → Manage deployments, copy the Web app link and paste it in Settings → Connections → Field feedback.';
  const g = readerField({ readerUrl: EXEC, secretSaved: true, error: gone404, errorHere: F.settingsWords(gone404) });
  assert.match(fieldSettingsHtml(g, { privacy: true }), /copy the Web app link, press Change link and paste it\.<\/p>/);
  assert.match(fieldSettingsHtml(g, { privacy: true, state: { readerEditing: true } }), /copy the Web app link and paste it under Reader link\.<\/p>/);
  // The key file's own trouble too: its key chosen, Choose another… shows.
  const gone = F.keyFileError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })).message;
  const key = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit', keyName: 'k.json', keyError: gone, keyErrorHere: F.settingsWords(gone, { keyChosen: true }) }, { privacy: true });
  assert.match(key, /choose it again with Choose another…<\/p>/);
  assert.doesNotMatch(key, /\bbelow\b|Settings → Connections/);
  // An older snapshot without the Settings wording shows the message as it is.
  assert.match(fieldSettingsHtml(readerField({ readerUrl: EXEC, secretSaved: true, error: err }), { privacy: true }), /then save it in Settings → Connections → Field feedback\./);
  // A name keeps its capital.
  const google = fieldSettingsHtml(readerField({ readerUrl: EXEC, secretSaved: true, error: 'Google did not let the reader answer.' }), { privacy: true });
  assert.match(google, /Last update failed: Google did not let the reader answer\./);
});

test('the key file route shows as before, its sheet link labelled like the reader’s fields', async () => {
  const { fieldSettingsHtml } = await view();
  const html = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '' }, { privacy: true });
  assert.match(html, /value="key" checked> Google key file/);
  assert.match(html, /<form class="field-entry" id="field-link-form" novalidate>\s*<label class="field-entry-label" for="field-link">Sheet link<\/label>/);
  assert.match(html, /<button class="button" type="submit">Save link<\/button>/);
  assert.match(html, /Choose key file…/);
  // An example of the link it wants.
  assert.match(html, /<input id="field-link"[^>]*placeholder="https:\/\/docs\.google\.com\/spreadsheets\/d\/…"/);
  assert.doesNotMatch(html, /field-reader-link|field-secret|Copy reader script/);
  // While the link is open again over a saved one, its Save is the one filled button: Choose key file… steps back.
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/x/edit';
  const relink = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: SHEET_URL, keyName: '' }, { privacy: true, state: { editing: true } });
  assert.match(relink, /<button type="button" class="link-btn" id="field-key" data-field="choose-key">Choose key file…<\/button>/);
  assert.match(relink, /data-field="cancel-link" aria-label="Cancel link change">Cancel</);
  assert.match(fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: SHEET_URL, keyName: '' }, { privacy: true }), /class="button" id="field-key" data-field="choose-key">Choose key file…/);
  const refused = fieldSettingsHtml({ enabled: true, source: 'key', sheetUrl: '', keyName: '' }, { privacy: true, state: { linkError: 'That link is not a Google Sheet.', linkDraft: 'https://example.com/x' } });
  assert.match(refused, /<input id="field-link"[^>]*value="https:\/\/example\.com\/x"[^>]*aria-invalid="true" aria-describedby="field-link-err"/);
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
  // The scale goes in the label ("−1.0 on −3 to 3" is wider than the stat), so every number is one line and the labels share a baseline.
  const board = fieldHtml(f, { privacy: true });
  assert.match(board, /<dt class="stat-label">Average score, −3 to 3<\/dt><dd class="stat-n">−1\.0<\/dd>/);
  assert.doesNotMatch(board, /stat-scale/);
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

test('in Settings a reader message names the control in view (the field when open, Replace secret or Change link when folded); the board keeps the path', async () => {
  const fail = async (last) => (await caughtAsync(F.fetchReaderRows({ link: READER, secret: SECRET, send: fakeReader([MOVED, last]).send }))).message;
  // [message, with its field open, with it folded behind its button]
  const cases = [
    [await fail([200, { ok: false, error: 'not allowed' }]), /, then save it under Secret\.$/, /, then press Replace secret and save the new one\.$/],
    [await fail([404, '']), /copy the Web app link and paste it under Reader link\.$/, /copy the Web app link, press Change link and paste it\.$/],
    [await fail([400, '']), /\(Deploy → Manage deployments\) and paste it under Reader link, then press Refresh now\.$/,
      /\(Deploy → Manage deployments\), press Change link and paste it, then press Refresh now\.$/],
    [F.secretFileError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })).message, /^No reader secret is saved\. Save it under Secret\.$/, /^No reader secret is saved\. Press Replace secret and save it\.$/],
    [F.secretFileError(Object.assign(new Error('EACCES'), { code: 'EACCES' })).message, /Save the secret again under Secret\.$/, /Press Replace secret and save it again\.$/],
    [F.secretLocked().message, /Save the secret again under Secret\.$/, /Press Replace secret and save it again\.$/],
    [caught(() => F.openSecret(F.sealSecret(OTHER_DEPLOY, 'c2VhbGVk'), DEPLOY)).message, /^The saved secret was for another reader link\. Save this reader’s secret under Secret\.$/,
      /^The saved secret was for another reader link\. Press Replace secret and save this reader’s secret\.$/],
    // Copy reader script is always in view.
    [await fail([200, { ok: false, error: 'something new' }]), /does not know\. Press Copy reader script, paste it over the old one and deploy it again/, null],
    [await fail([200, 'not json at all']), /^The reader’s answer is not in the shape the app reads\. Press Copy reader script, paste it over the old one/, null],
    [await fail([200, '<html><head><title>Error</title></head></html>', { contentType: 'text/html' }]), /then press Copy reader script, paste it over the old one/, null],
  ];
  for (const [board, open, folded] of cases) {
    assert.match(board, /Settings → Connections → Field feedback/, board);
    const words = F.settingsWords(board);
    assert.deepEqual(Object.keys(words).sort(), ['00', '01', '10', '11']);
    assert.match(words['11'], open);
    assert.match(F.inSettings(board), open);
    // Folded: the secret's messages under the key's first digit, the link's under its second.
    const shut = /secret/i.test(board) && !/Web app link/.test(board) ? words['01'] : words['10'];
    assert.match(shut, folded ?? open);
    for (const w of Object.values(words)) {
      // The app's own Settings path is gone (Apps Script's "Project Settings → Script properties" is not the app's).
      assert.doesNotMatch(w, /(?<!Project )Settings →|\bbelow\b/);
    }
  }
  assert.equal(F.settingsWords(null), null);
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
    // As Settings shows it, it names a control there, never the Settings path.
    assert.doesNotMatch(F.inSettings(err.message), /Settings → Connections/, err.message);
    if (err.code) assert.ok(!err.message.includes(err.code), `the code "${err.code}" in: ${err.message}`);
  }
});
