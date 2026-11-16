'use strict';

// Field feedback: every sheet, key, answer and email here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const F = require('../src/core/fieldsurvey');

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-demo';
const ROBOT = 'survey-reader@demo-project.iam.gserviceaccount.com';
const { privateKey: PEM, publicKey: PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyJson = (extra = {}) => JSON.stringify({
  type: 'service_account', project_id: 'demo-project', private_key_id: 'kid-demo-1', private_key: PEM,
  client_email: ROBOT, client_id: '000', token_uri: 'https://oauth2.googleapis.com/token', ...extra,
});
const local = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s);
const iso = (...a) => local(...a).toISOString();

// ---- the hosts -------------------------------------------------------------

test('only Google sign-in and Sheets are allowed, over https', () => {
  assert.deepEqual([...F.HOSTS].sort(), ['oauth2.googleapis.com', 'sheets.googleapis.com']);
  for (const url of [F.TOKEN_URL, F.metadataUrl(SHEET_ID), F.valuesUrl(SHEET_ID, 'Form Responses 1')]) {
    assert.equal(F.checkUrl(url), url);
  }
});

test('a request anywhere else is refused before it is made', () => {
  assert.throws(() => F.checkUrl('https://example.com/token'), /refused/);
  assert.throws(() => F.checkUrl('http://sheets.googleapis.com/v4/spreadsheets/x'), /refused/);
  assert.throws(() => F.checkUrl('https://sheets.googleapis.com:8443/v4/spreadsheets/x'), /refused/);
  assert.throws(() => F.checkUrl('https://someone@sheets.googleapis.com/v4/'), /refused/);
  assert.throws(() => F.checkUrl('not a url'), /refused/);
});

test('no other file in src, electron or renderer names a Google host', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const dir of ['src', 'electron', 'renderer']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html|css)$/.test(e.name) && /googleapis/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(path.join(root, dir));
  }
  assert.deepEqual(hits.map((h) => h.replace(/\\/g, '/')), ['src/core/fieldsurvey.js']);
});

// ---- the sheet link ------------------------------------------------------------

test('a sheet link gives the sheet id and the tab (gid)', () => {
  assert.deepEqual(F.parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1234567#gid=1234567`),
    { spreadsheetId: SHEET_ID, gid: 1234567 });
  assert.deepEqual(F.parseSheetLink(`  https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0  `), { spreadsheetId: SHEET_ID, gid: 0 });
  assert.deepEqual(F.parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`), { spreadsheetId: SHEET_ID, gid: null });
  assert.deepEqual(F.parseSheetLink(`https://docs.google.com/spreadsheets/u/1/d/${SHEET_ID}/edit#gid=42`), { spreadsheetId: SHEET_ID, gid: 42 });
  // The tab being looked at (after #) wins over a stale one in the query.
  assert.deepEqual(F.parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1#gid=2`), { spreadsheetId: SHEET_ID, gid: 2 });
});

test('anything that is not a Google Sheet link is refused with what to do', () => {
  assert.throws(() => F.parseSheetLink(''), /No sheet link/);
  assert.throws(() => F.parseSheetLink('not a link'), /docs\.google\.com\/spreadsheets\/d\//);
  assert.throws(() => F.parseSheetLink(`https://example.com/spreadsheets/d/${SHEET_ID}/edit`), /not a Google Sheet/);
  assert.throws(() => F.parseSheetLink(`http://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`), /not a Google Sheet/);
  assert.throws(() => F.parseSheetLink(`https://docs.google.com/forms/d/${SHEET_ID}/viewform`), /form/i);
  assert.throws(() => F.parseSheetLink('https://docs.google.com/spreadsheets/d/e/2PACX-1vDemoDemoDemoDemoDemo/pubhtml'), /published/);
  assert.throws(() => F.parseSheetLink('https://docs.google.com/spreadsheets/d/short/edit'), /cut short/);
  assert.throws(() => F.parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=abc`), /gid/);
});

// ---- the key ----------------------------------------------------------------------

test('a service account key is read; its private key never prints', () => {
  const key = F.readKey(keyJson());
  assert.equal(key.clientEmail, ROBOT);
  assert.equal(key.keyId, 'kid-demo-1');
  assert.ok(!JSON.stringify(key).includes('PRIVATE KEY'));
  assert.ok(!require('util').inspect(key).includes('PRIVATE KEY'));
});

test('a key that signs in anywhere but Google is refused', () => {
  assert.throws(() => F.readKey(keyJson({ token_uri: 'https://login.example.com/token' })), /token_uri/);
  assert.throws(() => F.readKey(keyJson({ token_uri: 'http://oauth2.googleapis.com/token' })), /token_uri/);
  assert.throws(() => F.readKey(keyJson({ token_uri: undefined })), /token_uri/);
});

test('other broken keys say what is wrong', () => {
  assert.throws(() => F.readKey('{not json'), /not JSON/);
  assert.throws(() => F.readKey(keyJson({ type: 'authorized_user' })), /service account/);
  assert.throws(() => F.readKey(keyJson({ client_email: undefined })), /client_email/);
  assert.throws(() => F.readKey(keyJson({ private_key: 'nothing here' })), /private key/);
  assert.throws(() => F.readKey(keyJson({ private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' })), /private key cannot be read/);
});

test('the token request is a signed RS256 JWT for read-only Sheets, valid one hour', () => {
  const now = Date.UTC(2026, 10, 16, 0, 0, 0);
  const jwt = F.jwtAssertion(F.readKey(keyJson()), now);
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'kid-demo-1' });
  assert.deepEqual(claims, {
    iss: ROBOT, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token',
    iat: now / 1000, exp: now / 1000 + 3600,
  });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), PUB, Buffer.from(s, 'base64url')), true);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), other, Buffer.from(s, 'base64url')), false);

  const req = F.tokenRequest(F.readKey(keyJson()), now);
  assert.equal(req.url, 'https://oauth2.googleapis.com/token');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.redirect, 'error');
  const form = new URLSearchParams(req.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion').split('.').length, 3);
});

test('the sheet requests carry only the sheet id and the tab name', () => {
  const meta = new URL(F.metadataUrl(SHEET_ID));
  assert.equal(meta.host, 'sheets.googleapis.com');
  assert.equal(meta.pathname, `/v4/spreadsheets/${SHEET_ID}`);
  assert.equal(meta.searchParams.get('fields'), 'properties.timeZone,sheets.properties(sheetId,title)');
  const vals = new URL(F.valuesUrl(SHEET_ID, "Bob's answers"));
  assert.equal(decodeURIComponent(vals.pathname), `/v4/spreadsheets/${SHEET_ID}/values/'Bob''s answers'`);
  assert.equal(vals.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  assert.equal(vals.searchParams.get('dateTimeRenderOption'), 'SERIAL_NUMBER');
});

// ---- fetching, with a stand-in for the network --------------------------------------

function fakeGoogle(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const step = u.host === 'oauth2.googleapis.com' ? 'token' : u.pathname.includes('/values/') ? 'values' : 'meta';
    const a = answers[step];
    if (a instanceof Error) throw a;
    const [status, body] = a;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}
const OK_TOKEN = [200, { access_token: 'ya29.demo-token', token_type: 'Bearer', expires_in: 3599 }];
const OK_META = [200, { properties: { timeZone: 'Asia/Taipei' }, sheets: [{ properties: { sheetId: 0, title: 'Notes' } }, { properties: { sheetId: 777, title: 'Form Responses 1' } }] }];
const link = { spreadsheetId: SHEET_ID, gid: 777 };

test('fetching signs in, finds the tab by its gid and reads its rows', async () => {
  const g = fakeGoogle({ token: OK_TOKEN, meta: OK_META, values: [200, { range: "'Form Responses 1'!A1:Z3", values: [['Timestamp', 'Rating'], [46336.5, 4]] }] });
  const got = await F.fetchRows({ link, key: F.readKey(keyJson()), fetch: g.fetch, now: Date.UTC(2026, 10, 16) });
  assert.deepEqual(got, { rows: [['Timestamp', 'Rating'], [46336.5, 4]], tab: { id: 777, title: 'Form Responses 1' }, timeZone: 'Asia/Taipei' });
  assert.equal(g.calls.length, 3);
  for (const c of g.calls) {
    assert.ok(F.HOSTS.has(new URL(c.url).host));
    assert.equal(c.init.redirect, 'error');
  }
  assert.equal(g.calls[1].init.headers.authorization, 'Bearer ya29.demo-token');
  assert.match(decodeURIComponent(g.calls[2].url), /values\/'Form Responses 1'/);
});

test('a sheet with no rows at all comes back as no rows', async () => {
  const g = fakeGoogle({ token: OK_TOKEN, meta: OK_META, values: [200, { range: "'Form Responses 1'!A1:Z1000" }] });
  const got = await F.fetchRows({ link, key: F.readKey(keyJson()), fetch: g.fetch });
  assert.deepEqual(got.rows, []);
});

test("Google's refusals become plain sentences with what to try", async () => {
  const key = F.readKey(keyJson());
  const fail = async (answers, l = link) => {
    try {
      await F.fetchRows({ link: l, key, fetch: fakeGoogle({ token: OK_TOKEN, meta: OK_META, ...answers }).fetch });
    } catch (err) {
      assert.ok(err instanceof F.FieldSurveyError, err.message);
      return err;
    }
    assert.fail('expected a refusal');
  };
  const share = await fail({ meta: [403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }] });
  // The reader address is the detail, shown only with privacy off.
  assert.equal(share.message, 'Share the sheet with the key’s reader address (copy it in Settings → Field feedback) as Viewer, then press Refresh now.');
  assert.equal(share.detail, ROBOT);
  assert.equal(share.kind, 'share');
  const api = await fail({ meta: [403, { error: { code: 403, message: 'Google Sheets API has not been used in project 0 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }] });
  assert.match(api.message, /Turn on the Google Sheets API/);
  assert.match((await fail({ meta: [404, { error: { code: 404, status: 'NOT_FOUND' } }] })).message, /^No sheet was found at this link\. Open it in your browser/);
  assert.match((await fail({}, { spreadsheetId: SHEET_ID, gid: 999 })).message, /tab in the link \(gid 999\)/);
  assert.match((await fail({ token: [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }] })).message, /Google refused the key/);
  assert.match((await fail({ token: new Error('net::ERR_INTERNET_DISCONNECTED') })).message, /No network/);
  // Electron's words when a request is redirected and redirects are refused.
  const moved = await fail({ meta: new Error("Attempted to redirect, but redirect policy was 'error'") });
  assert.match(moved.message, /^Google redirected the request, which the app does not follow/);
  assert.equal(moved.kind, 'blocked');
  const slow = new Error('The operation was aborted due to timeout');
  slow.name = 'TimeoutError';
  assert.match((await fail({ meta: slow })).message, /did not answer in time/);
  assert.match((await fail({ values: [200, 'not json'] })).message, /^Google’s answer could not be read\. Press Refresh now\./);
  assert.match((await fail({ values: [200, { values: 'x' }] })).message, /without rows/);
  assert.match((await fail({ token: [200, { token_type: 'Bearer' }] })).message, /without a token/);
  assert.match((await fail({ values: [503, {}] })).message, /\(503\).*tries again/);
});

// ---- summarising ------------------------------------------------------------------------

const ENGLISH = [
  ['Timestamp', 'Email Address', 'Your name', 'How easy was the setup? (1-5)', 'How clear was the screen?', 'What should we improve?'],
  ['11/10/2026 9:15:02', 'a.tester@example.com', 'Alex Tester', 4, 5, 'Bigger buttons on the tracker page'],
  ['11/11/2026 10:00:00', 'b.sample@example.com', 'Bea Sample', 5, 4, ''],
  ['11/12/2026 11:30:00', 'c.demo@example.com', 'Cy Demo', '3', 'N/A', 'Faster start-up'],
  ['11/13/2026 8:05:00', 'd.made@example.com', 'Dee Made', 4, 3],
  ['11/14/2026 16:45:10', 'e.invent@example.com', 'Eli Invent', 2, 4, 'Quieter fan'],
];

test('an English form: responses, dates, scores, comments; names and emails never become comments', () => {
  const s = F.summarise(ENGLISH, { since: local(2026, 11, 12) });
  assert.equal(s.responses, 5);
  assert.equal(s.newest, iso(2026, 11, 14, 16, 45, 10));
  assert.equal(s.oldest, iso(2026, 11, 10, 9, 15, 2));
  assert.equal(s.newSince, 3);
  assert.equal(s.timestampColumn, 'Timestamp');
  assert.deepEqual(s.questions.map((q) => [q.question, q.n, q.mean, q.low, q.high, q.scaleFrom, q.guessed, q.unreadable]), [
    ['How easy was the setup? (1-5)', 5, 18 / 5, 1, 5, 'header', false, 0],
    ['How clear was the screen?', 4, 16 / 4, 1, 5, 'answers', true, 1],
  ]);
  // Only the stated scale counts in the headline: 4, 5, 3, 4, 2.
  assert.deepEqual(s.overall, { mean: 18 / 5, high: 5, rescaled: false, n: 5 });
  assert.equal(s.scalesGuessed, 1);
  assert.equal(s.checked, false);
  assert.deepEqual(s.comments.map((c) => [c.question, c.text, c.at]), [
    ['What should we improve?', 'Quieter fan', iso(2026, 11, 14, 16, 45, 10)],
    ['What should we improve?', 'Faster start-up', iso(2026, 11, 12, 11, 30)],
    ['What should we improve?', 'Bigger buttons on the tracker page', iso(2026, 11, 10, 9, 15, 2)],
  ]);
  assert.equal(s.commentCount, 3);
  assert.deepEqual(s.identifying, ['Email Address', 'Your name']);
  assert.ok(!JSON.stringify(s).includes('@example.com'));
  assert.ok(!JSON.stringify(s).includes('Alex Tester'));
  assert.deepEqual(s.unreadable, { scores: 1, numbers: 0, timestamps: 0 });
});

test('a Traditional Chinese form, with 上午/下午 times', () => {
  const rows = [
    ['時間戳記', '電子郵件地址', '姓名', '整體滿意度', '導航準確度 (1-10)', '其他建議'],
    ['2026/11/9 上午 9:05:00', 'tester1@example.com', '王小明', 4, 8, '希望開機更快'],
    ['2026/11/11 下午 2:30:15', 'tester2@example.com', '陳大文', 5, 9, ''],
    ['2026/11/13 下午 12:10:00', 'tester3@example.com', '林美玲', 3, 7, '螢幕字太小'],
  ];
  const s = F.summarise(rows, { since: local(2026, 11, 10) });
  assert.equal(s.responses, 3);
  assert.equal(s.oldest, iso(2026, 11, 9, 9, 5));
  assert.equal(s.newest, iso(2026, 11, 13, 12, 10));
  assert.equal(s.newSince, 2);
  assert.deepEqual(s.questions.map((q) => [q.question, q.n, q.mean, q.low, q.high]), [
    ['整體滿意度', 3, 4, 1, 5],
    ['導航準確度 (1-10)', 3, 8, 1, 10],
  ]);
  // The first scale is only a guess: the headline is the stated 1–10 one.
  assert.deepEqual(s.overall, { mean: 8, high: 10, rescaled: false, n: 3 });
  assert.deepEqual(s.comments.map((c) => c.text), ['螢幕字太小', '希望開機更快']);
  assert.deepEqual(s.identifying, ['電子郵件地址', '姓名']);
  assert.ok(!JSON.stringify(s).includes('王小明'));
});

test('the overall average on 0–10 is each answer moved onto that scale', () => {
  const s = F.summarise([['Timestamp', 'Ease (1-5)', 'Accuracy (0-10)'], ['2026-11-10 09:00', 5, 0], ['2026-11-11 09:00', 1, 10]]);
  // 5 on 1–5 is 10, 1 is 0; 0 and 10 on 0–10 stay: (10 + 0 + 0 + 10) / 4.
  assert.deepEqual(s.overall, { mean: 5, high: 10, rescaled: true, n: 4 });
});

test('a sheet with only its header row has zero responses, not an error', () => {
  const s = F.summarise([['Timestamp', 'Rating', 'Comments']], { since: local(2026, 11, 1) });
  assert.equal(s.responses, 0);
  assert.equal(s.newest, null);
  assert.equal(s.newSince, 0);
  assert.deepEqual(s.questions, []);
  assert.deepEqual(s.comments, []);
  assert.equal(s.overall, null);
  assert.deepEqual(F.summarise([]), { ...F.summarise([]), responses: 0, empty: true });
});

test('a word in a score column is counted as unreadable, not averaged and not dropped quietly', () => {
  const rows = [['Timestamp', 'Rating'], ['2026-11-10 09:00', '4'], ['2026-11-10 10:00', 'five'], ['2026-11-10 11:00', 5], ['2026-11-10 12:00', 3], ['2026-11-10 13:00', 4]];
  const s = F.summarise(rows);
  assert.deepEqual(s.questions.map((q) => [q.n, q.mean, q.unreadable]), [[4, 4, 1]]);
  assert.deepEqual(s.unreadable, { scores: 1, numbers: 0, timestamps: 0 });
  assert.equal(F.unreadableText(s), '1 answer could not be read: 1 score that is not a whole number on its scale');
  // An answer outside the scale the question names is unreadable too.
  const off = F.summarise([['Timestamp', 'Ease (1-5)'], ['2026-11-10 09:00', 4], ['2026-11-10 10:00', 9], ['2026-11-10 11:00', 5], ['2026-11-10 12:00', 5], ['2026-11-10 13:00', 3]]);
  assert.deepEqual(off.questions.map((q) => [q.n, q.mean, q.unreadable]), [[4, 17 / 4, 1]]);
});

test('a small form with one "n/a" keeps its score question; numbers never become comments', () => {
  const rows = [
    ['Timestamp', 'How easy was the setup? (1-5)', 'Anything to improve?'],
    ['2026-11-10 09:00', 4, 'Bigger buttons'],
    ['2026-11-11 09:00', 5, ''],
    ['2026-11-12 09:00', 'n/a', 'Faster start-up'],
  ];
  const s = F.summarise(rows);
  assert.deepEqual(s.questions.map((q) => [q.question, q.n, q.mean, q.unreadable]), [['How easy was the setup? (1-5)', 2, 4.5, 1]]);
  assert.deepEqual(s.comments.map((c) => c.text), ['Faster start-up', 'Bigger buttons']);
  // Mostly words: free text, even with a number among them.
  const words = F.summarise([['Timestamp', 'Notes'], ['2026-11-10 09:00', 'fine'], ['2026-11-11 09:00', 4], ['2026-11-12 09:00', 'works well']]);
  assert.deepEqual(words.questions, []);
  assert.equal(words.commentCount, 3);
});

test('ragged rows: short rows are blanks, extra cells become a column of their own', () => {
  const rows = [
    ['Timestamp', 'Rating', 'Comments'],
    ['2026-11-10 09:00', 4],
    ['2026-11-11 09:00', 5, 'Works well', 'a note past the last question'],
    [],
    ['2026-11-12 09:00'],
  ];
  const s = F.summarise(rows);
  assert.equal(s.responses, 3);
  assert.equal(s.blankRows, 1);
  assert.deepEqual(s.questions.map((q) => [q.question, q.n, q.mean]), [['Rating', 2, 4.5]]);
  // One answer's comments keep the form's order.
  assert.deepEqual(s.comments.map((c) => [c.question, c.text]), [['Comments', 'Works well'], ['Column D', 'a note past the last question']]);
  const d = s.columns.find((c) => c.header === 'Column D');
  assert.deepEqual([d.role, d.untitled, d.confirmed], ['comment', true, false]);
});

test('a timestamp that is not a date is counted', () => {
  const s = F.summarise([['Timestamp', 'Rating'], ['2026-11-10 09:00', 4], ['yesterday', 5], ['', 3]]);
  assert.equal(s.responses, 3);
  assert.deepEqual(s.unreadable, { scores: 0, numbers: 0, timestamps: 2 });
  assert.match(F.unreadableText(s), /2 answers could not be read: 2 rows without a readable date/);
});

test('timestamps from the API are serial days, read in the sheet\'s time zone', () => {
  // Days since 1899-12-30, as spreadsheets count them.
  const serial = Date.UTC(2026, 10, 12, 12, 0, 0) / 86_400_000 + 25_569;
  const rows = [['Timestamp', 'Rating'], [serial, 4]];
  assert.equal(F.summarise(rows, { timeZone: 'UTC' }).newest, '2026-11-12T12:00:00.000Z');
  assert.equal(F.summarise(rows, { timeZone: 'Asia/Taipei' }).newest, '2026-11-12T04:00:00.000Z');
  assert.equal(F.summarise(rows).newest, iso(2026, 11, 12, 12));
  // A zone the computer does not know: the computer's own, and said so.
  const odd = F.summarise(rows, { timeZone: 'Mars/Olympus' });
  assert.equal(odd.newest, iso(2026, 11, 12, 12));
  assert.equal(odd.timeZone, 'local');
});

test('day-first dates are recognised from a day above 12', () => {
  const s = F.summarise([['Timestamp', 'Rating'], ['14/11/2026 09:00:00', 4], ['03/11/2026 10:00:00', 5]]);
  assert.equal(s.newest, iso(2026, 11, 14, 9));
  assert.equal(s.oldest, iso(2026, 11, 3, 10));
});

test('with no timestamp header, the first column of dates is the timestamp', () => {
  const s = F.summarise([['When', 'Rating'], ['2026-11-10 09:00', 4], ['2026-11-12 09:00', 2]]);
  assert.equal(s.timestampColumn, 'When');
  assert.equal(s.newest, iso(2026, 11, 12, 9));
});

test('other columns: choices are tallied, numbers averaged apart, extra dates not summarised', () => {
  const rows = [['Timestamp', 'Your role', 'Date of the case', 'Cases per week', 'Reach you at', 'Anything else?']];
  const roles = ['Surgeon', 'Nurse', 'Surgeon', 'Engineer', 'Surgeon', 'Nurse'];
  roles.forEach((r, i) => rows.push([`2026-11-${10 + i} 09:00`, r, `2026-10-${10 + i}`, 12 + i * 10, `p${i}@example.com`, i === 2 ? 'Fine' : '']));
  const s = F.summarise(rows);
  assert.deepEqual(s.choices, [{ question: 'Your role', n: 6, answers: [{ answer: 'Surgeon', count: 3 }, { answer: 'Nurse', count: 2 }, { answer: 'Engineer', count: 1 }] }]);
  assert.deepEqual(s.skipped, [{ question: 'Date of the case', reason: 'dates' }]);
  // 12, 22, 32, 42, 52, 62: a number, never in the headline.
  assert.deepEqual(s.numbers.map((q) => [q.question, q.n, q.mean]), [['Cases per week', 6, 37]]);
  assert.equal(s.overall, null);
  // Found by its answers, not its header.
  assert.deepEqual(s.identifying, ['Reach you at']);
  assert.deepEqual(s.comments.map((c) => c.text), ['Fine']);
  assert.deepEqual(s.questions, []);
});

test('a column with no answers yet is listed, not guessed', () => {
  const s = F.summarise([['Timestamp', 'Rating', 'New question'], ['2026-11-10 09:00', 4]]);
  assert.deepEqual(s.skipped, [{ question: 'New question', reason: 'no answers' }]);
});

test('comments are cut to the newest few, and the total is kept', () => {
  const rows = [['Timestamp', 'Comments']];
  for (let i = 1; i <= 12; i += 1) rows.push([`2026-11-${String(i).padStart(2, '0')} 09:00`, `note ${i}`]);
  const s = F.summarise(rows, { comments: 3 });
  assert.deepEqual(s.comments.map((c) => c.text), ['note 12', 'note 11', 'note 10']);
  assert.equal(s.commentCount, 12);
});

test('a very long sheet is summarised, not a stack overflow', () => {
  const rows = [['Timestamp', 'Rating']];
  for (let i = 0; i < 300_000; i += 1) rows.push([i === 7 ? '2026-11-12 09:00' : '2026-11-10 09:00', i % 2 ? 4 : 5]);
  const s = F.summarise(rows);
  assert.equal(s.responses, 300_000);
  assert.equal(s.newest, iso(2026, 11, 12, 9));
  assert.deepEqual(s.questions.map((q) => [q.n, q.mean, q.high]), [[300_000, 4.5, 5]]);
});

// ---- suggestions that need care ------------------------------------------------------------

const roleOf = (s, header) => s.columns.find((c) => c.header === header)?.role;
const form = (headers, values) => [['Timestamp', ...headers], ...values.map((v, i) => [`2026-11-${String(10 + i).padStart(2, '0')} 09:00`, ...v])];

test('a word like "name" or "address" inside a question does not hide the column', () => {
  const s = F.summarise(form(
    ['Did the device address the problem?', 'Name one thing you liked', 'Do you use the mobile app?', 'Was contact support helpful?', 'Device name'],
    [['Yes', 'The quick start', 'Yes', 'Yes', 'Remex'], ['No', 'Small holder', 'No', 'No', 'Remex']],
  ));
  assert.deepEqual(s.identifying, []);
  // Short labels still are.
  const t = F.summarise(form(['Name', 'Email address (optional)', '電話', 'Your name:'], [['Ann', 'a@example.com', '0912', 'Bo'], ['Cy', '', '', 'Di']]));
  assert.deepEqual(t.identifying, ['Name', 'Email address (optional)', '電話', 'Your name:']);
});

test('patient and case identifiers are identifying, in English and Chinese', () => {
  const rows = [['Timestamp', 'Patient ID', 'Case number', 'MRN', '病歷號碼', '個案編號', 'Medical record no.', 'Rating (1-5)']];
  for (let i = 0; i < 6; i += 1) rows.push([46330 + i, `PT-00${i}9`, i + 1, `A${1234567 + i}`, `X${98765 + i}`, `K-${i}`, `MR${i}`, 3 + (i % 3)]);
  const s = F.summarise(rows, { timeZone: 'UTC' });
  // "Case number" holds 1…6, small whole numbers, and is still not a score.
  assert.deepEqual(s.identifying, ['Patient ID', 'Case number', 'MRN', '病歷號碼', '個案編號', 'Medical record no.']);
  assert.deepEqual(s.questions.map((q) => q.question), ['Rating (1-5)']);
  assert.ok(!JSON.stringify(s.comments).includes('PT-'));
  // A score about the patient is a score.
  const p = F.summarise(form(['Patient satisfaction (1-5)', '患者疼痛程度'], [[4, 3], [5, 2], [3, 4]]));
  assert.deepEqual(p.questions.map((q) => q.question), ['Patient satisfaction (1-5)', '患者疼痛程度']);
});

test('names under headers no list knows are found by their shape', () => {
  const people = ['Ann Lee', 'Bo Chan', 'Cy Wu', 'Di Ho', 'Ed Ng', 'Fa Li'];
  const s = F.summarise(form(['Who filled this in?', '名前', 'Respondent', 'Rating (1-5)'], people.map((n, i) => [n, ['王小明', '陳大文', '林美玲', '張家豪', '李志明', '黃淑芬'][i], n, 4])));
  assert.deepEqual(s.identifying, ['Who filled this in?', '名前', 'Respondent']);
  // Title Case scale answers ("Very Easy") are a choice, like sentence case;
  // short comments are comments.
  const c = F.summarise(form(['How was it?', 'Comments', 'Overall'], [['Very Easy', 'Works well', 'Very easy'], ['Very Easy', '很好', 'Very easy'], ['Quite Easy', 'Faster start-up', 'Quite easy'], ['Very Easy', '太慢了', 'Very easy'], ['Quite Easy', 'Quieter fan', 'Quite easy']]));
  assert.deepEqual([roleOf(c, 'How was it?'), col(c, 'How was it?').suggested.confidence], ['choice', 'high']);
  assert.equal(roleOf(c, 'Overall'), 'choice');
  assert.equal(roleOf(c, 'Comments'), 'comment');
});

test('a count question is a number, never a score', () => {
  const s = F.summarise(form(['How many times did you restart it?', 'Number of screws used', '重啟幾次', 'Rating'], [[0, 2, 1, 4], [2, 3, 0, 5], [1, 2, 0, 4], [3, 4, 2, 3], [0, 2, 1, 4]]));
  assert.deepEqual(s.numbers.map((q) => [q.question, q.n, q.mean]), [
    ['How many times did you restart it?', 5, 6 / 5], ['Number of screws used', 5, 13 / 5], ['重啟幾次', 5, 4 / 5],
  ]);
  assert.deepEqual(s.questions.map((q) => q.question), ['Rating']);
  // A 0 with no scale in the question: counts, not a 0–5 score.
  const z = F.summarise(form(['Problems seen'], [[0], [2], [1], [3]]));
  assert.equal(roleOf(z, 'Problems seen'), 'number');
  // A 0 with a stated scale is a score.
  const nps = F.summarise(form(['How likely are you to recommend it? (0-10)'], [[0], [9], [10]]));
  assert.deepEqual(nps.questions.map((q) => [q.low, q.high, q.scaleFrom]), [[0, 10, 'header']]);
});

test('mostly "No" with one longer answer is free text, not a choice', () => {
  const s = F.summarise(form(['Anything else?'], [['No'], ['No'], ['No'], ['The holder slips when wet'], ['No'], ['No']]));
  assert.equal(roleOf(s, 'Anything else?'), 'comment');
  assert.equal(s.commentCount, 6);
});

test('the last scale in a question is its scale', () => {
  const s = F.summarise(form(['How easy was it in the first 1-2 weeks? (1-5)'], [[4], [5], [3]]));
  assert.deepEqual(s.questions.map((q) => [q.low, q.high, q.scaleFrom]), [[1, 5, 'header']]);
});

// ---- the user's own column roles --------------------------------------------------------------

test('confirmed roles win over the suggestions, and a guessed scale stays out of the headline until confirmed', () => {
  const rows = form(['Score A', 'Score B (1-5)', 'Notes'], [[4, 5, 'ok then'], [5, 4, 'fine'], [3, 4, 'slow']]);
  const guess = F.summarise(rows);
  assert.deepEqual(guess.questions.map((q) => [q.question, q.scaleFrom]), [['Score A', 'answers'], ['Score B (1-5)', 'header']]);
  assert.deepEqual(guess.overall, { mean: 13 / 3, high: 5, rescaled: false, n: 3 });
  assert.equal(guess.checked, false);
  const roles = [
    { header: 'Timestamp', index: 0, role: 'timestamp' },
    { header: 'Score A', index: 1, role: 'score', low: 1, high: 10 },
    { header: 'Score B (1-5)', index: 2, role: 'ignore' },
    { header: 'Notes', index: 3, role: 'identifying' },
  ];
  const s = F.summarise(rows, { roles });
  assert.equal(s.checked, true);
  assert.deepEqual(s.questions.map((q) => [q.question, q.low, q.high, q.scaleFrom, q.guessed]), [['Score A', 1, 10, 'confirmed', false]]);
  assert.deepEqual(s.overall, { mean: 4, high: 10, rescaled: false, n: 3 });
  assert.deepEqual(s.skipped, [{ question: 'Score B (1-5)', reason: 'ignored' }]);
  assert.deepEqual(s.identifying, ['Notes']);
  assert.equal(s.commentCount, 0);
  // Moved one place along by a new first question: the roles follow the headers.
  const moved = form(['Added later', 'Score A', 'Score B (1-5)', 'Notes'], [['x', 4, 5, 'ok then']]);
  const m = F.summarise(moved, { roles });
  assert.equal(roleOf(m, 'Notes'), 'identifying');
  assert.deepEqual(m.newColumns, ['Added later']);
  assert.equal(m.checked, false);
});

test('a column that appears after the check is flagged under Needs attention', () => {
  const roles = [{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Rating (1-5)', index: 1, role: 'score', low: 1, high: 5 }];
  const s = F.summarise(form(['Rating (1-5)', 'New question'], [[4, 'yes']]), { roles });
  assert.deepEqual(s.columns.map((c) => [c.header, c.confirmed, c.isNew]), [['Timestamp', true, false], ['Rating (1-5)', true, false], ['New question', false, true]]);
  assert.deepEqual(F.fieldProblems({ enabled: true, summary: s }).map((p) => p.label),
    ['Field feedback: a new column in the sheet, not checked yet (Settings → Field feedback → Check the columns)']);
  // Never checked: nothing is "new", the board says the columns are not checked yet.
  assert.deepEqual(F.summarise(form(['Rating (1-5)'], [[4]])).newColumns, []);
});

test('roles from Settings are checked before they are saved', () => {
  assert.deepEqual(F.checkRoles([{ header: 'Q', index: 1, role: 'score', low: '1', high: '5', extra: 'x' }]), [{ header: 'Q', index: 1, role: 'score', low: 1, high: 5 }]);
  assert.throws(() => F.checkRoles([{ header: 'Q', index: 1, role: 'score', low: 2, high: 5 }]), /starts at 0 or 1/);
  assert.throws(() => F.checkRoles([{ header: 'Q', index: 1, role: 'admin' }]), /could not be read/);
  assert.throws(() => F.checkRoles('x'), /could not be read/);
});

// ---- what is kept, and when to read again ----------------------------------------------------

const LINK = { spreadsheetId: SHEET_ID, gid: 777 };
const SETTINGS = { enabled: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=777`, keyPath: 'key.json' };
const got = (rows) => ({ rows, tab: { id: 777, title: 'Form Responses 1' }, timeZone: 'UTC' });
const R1 = [['Timestamp', 'Email address', 'Rating (1-5)'], ['2026-11-10T09:00:00Z', 'a@example.com', 4], ['2026-11-11T09:00:00Z', 'b@example.com', 5]];
const R2 = [...R1, ['2026-11-13T09:00:00Z', 'c@example.com', 3]];

test('the cache never keeps an identifying answer, and still counts every response', () => {
  const c = F.afterFetch(null, got(R1), { now: 1000, started: 900, link: LINK });
  assert.ok(!JSON.stringify(c).includes('@example.com'));
  assert.deepEqual(c.rows[0], R1[0]);
  assert.deepEqual(c.redacted, [1]);
  const s = F.summariseCache(c, []);
  assert.equal(s.responses, 2);
  assert.deepEqual(s.identifying, ['Email address']);
  // Marked identifying later: dropped from the cache too.
  const n = F.afterFetch(null, got([['Timestamp', 'Notes'], ['2026-11-10T09:00:00Z', 'call Ann']]), { now: 1, started: 1, link: LINK });
  assert.ok(n.rows[1].includes('call Ann'));
  const re = F.reroleCache(n, [{ header: 'Notes', index: 1, role: 'identifying' }]);
  assert.ok(!JSON.stringify(re.rows).includes('Ann'));
});

test('first read, the same again, then new answers: "new since" moves only when something came in', () => {
  const first = F.afterFetch(null, got(R1), { now: 1000, started: 900, link: LINK });
  assert.deepEqual([first.since, first.sinceFetchedAt], [null, null]);
  const same = F.afterFetch(first, got(R1), { now: 2000, started: 1900, link: LINK });
  assert.deepEqual([same.since, same.sinceFetchedAt, same.fetchedAt], [null, null, 2000]);
  const more = F.afterFetch(same, got(R2), { now: 3000, started: 2900, link: LINK });
  assert.deepEqual([more.since, more.sinceFetchedAt], ['2026-11-11T09:00:00.000Z', 2000]);
  assert.equal(F.summariseCache(more, []).newSince, 1);
  const again = F.afterFetch(more, got(R2), { now: 4000, started: 3900, link: LINK });
  assert.deepEqual([again.since, again.sinceFetchedAt], ['2026-11-11T09:00:00.000Z', 2000]);
  // Another sheet: starts afresh.
  const other = F.afterFetch(again, got(R2), { now: 5000, started: 4900, link: { spreadsheetId: 'B'.repeat(30), gid: 0 } });
  assert.deepEqual([other.since, other.spreadsheetId], [null, 'B'.repeat(30)]);
});

test('a failed read keeps the last good rows, and the next good read clears the error', () => {
  const good = F.afterFetch(null, got(R1), { now: 1000, started: 900, link: LINK });
  const failed = F.afterFailure(good, new F.FieldSurveyError('share', 'Share the sheet…', ROBOT), { now: 2000, started: 1900, link: LINK });
  assert.deepEqual(failed.rows, good.rows);
  assert.equal(failed.fetchedAt, 1000);
  assert.deepEqual(failed.lastError, { at: 2000, kind: 'share', message: 'Share the sheet…', detail: ROBOT });
  const bug = F.afterFailure(null, new TypeError('x is undefined'), { now: 3000, started: 2900, link: LINK });
  assert.deepEqual([bug.rows, bug.lastError.kind], [null, 'bug']);
  assert.match(bug.lastError.message, /see the system log/);
  const back = F.afterFetch(failed, got(R2), { now: 4000, started: 3900, link: LINK });
  assert.equal(back.lastError, null);
});

test('when to read: due slots, a short wait after a passing failure, none after a refusal', () => {
  const mon9 = local(2026, 11, 16, 9).getTime();
  const plan = (cache, now = mon9, settings = SETTINGS) => F.planFetch({ now, settings, cache });
  // Never read: now. Off or not set up: never.
  assert.deepEqual(plan(null), { fetch: true, wakeAt: null });
  assert.deepEqual(plan(null, mon9, { ...SETTINGS, enabled: false }), { fetch: false, wakeAt: null });
  assert.deepEqual(plan(null, mon9, { ...SETTINGS, keyPath: '' }), { fetch: false, wakeAt: null });
  // Read after this morning's slot: wait for Wednesday 08:00.
  const fresh = { fetchedAt: local(2026, 11, 16, 8, 1).getTime() };
  assert.deepEqual(plan(fresh), { fetch: false, wakeAt: local(2026, 11, 18, 8).getTime() });
  // No network at 08:50: again 30 minutes after the try.
  const offline = { fetchedAt: local(2026, 11, 13, 8).getTime(), lastAttemptAt: mon9 - 10 * 60_000, lastError: { kind: 'network', message: 'x' } };
  assert.deepEqual(plan(offline), { fetch: false, wakeAt: mon9 + 20 * 60_000 });
  assert.deepEqual(plan(offline, mon9 + 20 * 60_000), { fetch: true, wakeAt: null });
  // Not shared (403): not again until Wednesday's slot, however long it waits.
  const refused = { ...offline, lastError: { kind: 'share', message: 'x' } };
  assert.deepEqual(plan(refused), { fetch: false, wakeAt: local(2026, 11, 18, 8).getTime() });
  assert.equal(plan(refused, local(2026, 11, 17, 23).getTime()).fetch, false);
  assert.equal(plan(refused, local(2026, 11, 18, 8).getTime()).fetch, true);
  // A new key clears the try (the main process sets lastAttemptAt to null).
  assert.equal(plan({ ...refused, lastAttemptAt: null }).fetch, true);
});

test('a saved cache is used only when it is whole and this sheet\'s', () => {
  const good = F.afterFetch(null, got(R1), { now: 1000, started: 900, link: LINK });
  assert.equal(F.validCache(JSON.parse(JSON.stringify(good)), LINK).cache.fetchedAt, 1000);
  assert.deepEqual(F.validCache(null, LINK), { cache: null, problem: null });
  assert.match(F.validCache(good, { spreadsheetId: 'B'.repeat(30), gid: 777 }).problem, /another sheet/);
  assert.match(F.validCache(good, { spreadsheetId: SHEET_ID, gid: 0 }).problem, /another sheet/);
  assert.match(F.validCache({ ...good, lastError: 'no network' }, LINK).problem, /could not be read/);
  assert.match(F.validCache({ ...good, rows: 'x' }, LINK).problem, /could not be read/);
  assert.match(F.validCache([], LINK).problem, /could not be read/);
  // The first version kept names and emails: set aside, quietly, to be read again.
  assert.deepEqual(F.validCache({ rows: [], fetchedAt: 1 }, LINK), { cache: null, problem: null });
  // Versions 2 and 3 kept the answers of guessed or ignored columns: set aside too.
  for (const version of [2, 3]) assert.deepEqual(F.validCache({ ...good, version }, LINK), { cache: null, problem: null });
  assert.match(F.validCache({ ...good, hiddenAs: 'x' }, LINK).problem, /could not be read/);
});

test('Settings changes: an empty link keeps the saved one; a bad link or roles are refused', () => {
  const now = { enabled: true, sheetUrl: SETTINGS.sheetUrl, keyPath: 'k.json', columns: [] };
  assert.deepEqual(F.changeSettings(now, { sheetUrl: '   ' }), { settings: now, sheetChanged: false });
  assert.match(F.changeSettings(now, { sheetUrl: 'https://example.com/x' }).error, /not a Google Sheet/);
  const other = `https://docs.google.com/spreadsheets/d/${'B'.repeat(30)}/edit`;
  assert.deepEqual(F.changeSettings(now, { sheetUrl: other }), { settings: { ...now, sheetUrl: other }, sheetChanged: true });
  assert.deepEqual(F.changeSettings(now, { enabled: false }).settings.enabled, false);
  assert.match(F.changeSettings(now, { columns: [{ header: 'Q', index: 0, role: 'nope' }] }).error, /could not be read/);
  // Another sheet is another form: its columns are checked afresh.
  const checked = { ...now, columns: [{ header: 'Q', index: 1, role: 'comment' }] };
  assert.deepEqual(F.changeSettings(checked, { sheetUrl: other }).settings.columns, []);
  // Turned off, nothing is kept: the checked columns go too.
  assert.deepEqual(F.changeSettings(checked, { enabled: false }).settings.columns, []);
});

test('an unknown time zone and day-or-month dates are said under Needs attention', () => {
  const s = F.summarise([['Timestamp', 'Rating'], ['03/04/2026 09:00', 4], ['05/06/2026 09:00', 5]], { timeZone: 'Mars/Olympus' });
  assert.equal(s.ambiguousDates, 2);
  assert.equal(s.timeZoneUnknown, 'Mars/Olympus');
  const labels = F.fieldProblems({ enabled: true, summary: s }).map((p) => p.label);
  assert.ok(labels.some((l) => /time zone \(Mars\/Olympus\) is not known/.test(l)), labels.join('\n'));
  assert.ok(labels.some((l) => /2 typed dates could be day\/month or month\/day/.test(l)), labels.join('\n'));
  // A day above 12 settles it.
  assert.equal(F.summarise([['Timestamp', 'Rating'], ['03/04/2026 09:00', 4], ['25/06/2026 09:00', 5]]).ambiguousDates, 0);
  assert.deepEqual(F.fieldProblems({ enabled: false, summary: s }), []);
});

test('the share refusal names the reader address only as a detail', () => {
  const c = F.afterFailure(null, new F.FieldSurveyError('share', 'Share the sheet with the key’s reader address (shown in Settings) as Viewer, then press Refresh now.', ROBOT), { now: 1, started: 1, link: LINK });
  const [p] = F.fieldProblems({ enabled: true, cache: c });
  assert.ok(!p.label.includes(ROBOT));
  assert.equal(p.detail, ROBOT);
});

test("Google's busy and down answers at sign-in, a quota 403 and a body that times out are passing troubles", async () => {
  const key = F.readKey(keyJson());
  const res = (status, body, textThrows) => ({
    ok: status < 300, status,
    text: async () => {
      if (textThrows) {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  });
  const run = async (plan) => {
    let i = 0;
    try {
      await F.fetchRows({ link: LINK, key, fetch: async () => plan[i++] });
    } catch (e) {
      return e;
    }
    return assert.fail('expected a failure');
  };
  const tok = res(200, { access_token: 't' });
  const meta = res(200, { sheets: [{ properties: { sheetId: 777, title: 'R' } }] });
  assert.equal((await run([res(503, '<html>Service Unavailable</html>')])).kind, 'google');
  assert.equal((await run([res(429, { error: 'rate_limit_exceeded' })])).kind, 'busy');
  const slow = await run([tok, meta, res(200, null, true)]);
  assert.deepEqual([slow.kind, /did not answer in time/.test(slow.message)], ['network', true]);
  assert.equal((await run([tok, res(403, { error: { message: 'Quota exceeded for quota metric', status: 'PERMISSION_DENIED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } })])).kind, 'busy');
});

// ---- how sure a suggestion is ------------------------------------------------------------------

const col = (s, header) => s.columns.find((c) => c.header === header);

test('a guessed scale is a low-confidence suggestion that needs the user\'s choice; a stated one does not', () => {
  const s = F.summarise(form(['How satisfied are you overall?', 'Ease (1-5)'], [[6], [7], [5]].map((v) => [...v, 4])));
  assert.deepEqual([col(s, 'How satisfied are you overall?').suggested.confidence, col(s, 'How satisfied are you overall?').needsChoice], ['low', true]);
  assert.deepEqual([col(s, 'Ease (1-5)').suggested.confidence, col(s, 'Ease (1-5)').needsChoice], ['high', false]);
  assert.equal(col(s, 'Timestamp').suggested.confidence, 'high');
  assert.equal(s.needsChoice, 1);
  // Saving every column but the unchosen one leaves it missing: Save is refused.
  const roles = s.columns.filter((c) => !c.needsChoice).map((c) => ({ header: c.header, index: c.index, role: c.role, ...(c.role === 'score' ? { low: c.low, high: c.high } : {}) }));
  assert.deepEqual(F.checkSubmission(s, roles), { missing: 1 });
  // Once chosen, all are there, and only then is the scale confirmed.
  const chosen = [...roles, { header: 'How satisfied are you overall?', index: 1, role: 'score', low: 1, high: 10 }];
  assert.deepEqual(F.checkSubmission(s, chosen), { missing: 0 });
  const after = F.summarise(form(['How satisfied are you overall?', 'Ease (1-5)'], [[6], [7], [5]].map((v) => [...v, 4])), { roles: F.checkRoles(chosen) });
  assert.equal(after.needsChoice, 0);
  assert.deepEqual(after.questions.map((q) => [q.scaleFrom, q.high]), [['confirmed', 10], ['confirmed', 5]]);
});

// An unsure identifying guess: off the board, needs a choice, and nothing
// of it in the cache, before or after a restart.
const unsureHidden = (rows, h, roles = []) => {
  const s = F.summarise(rows, { roles });
  assert.deepEqual([roleOf(s, h), col(s, h).suggested.confidence, col(s, h).needsChoice, s.commentCount, s.choices.length], ['identifying', 'low', true, 0, 0], h);
  const c = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK, roles });
  const k = col(s, h).index;
  assert.ok(c.redacted.includes(k), h);
  assert.ok(rows.slice(1).every((r) => r[k] == null || !JSON.stringify(c.rows).includes(JSON.stringify(r[k]))), `${h}: an answer is in the cache`);
  assert.equal(col(F.summariseCache(c, roles), h).needsChoice, true, `${h}: read back from the cache`);
};

test('short answers shaped like names: Title Case phrases are an unsure guess, most Chinese comments are comments', () => {
  const zh = F.summarise(form(['使用心得'], [['方便'], ['高效'], ['周到'], ['很好'], ['方便快速']]));
  // Three of five start with a common family name, under the 70% a guess needs.
  assert.deepEqual([roleOf(zh, '使用心得'), col(zh, '使用心得').suggested.confidence, zh.commentCount], ['comment', 'high', 5]);
  unsureHidden(form(['What did you like most?'], [['Tracking Accuracy'], ['Screen Size'], ['Quick Setup'], ['Fast Boot'], ['the holder']]), 'What did you like most?');
  unsureHidden(form(['Best part'], [['Tracking Accuracy'], ['Screen Size'], ['Quick Setup'], ['Fast Boot'], ['Helpful Support']]), 'Best part');
  // With scale words in two of five ("Easy Setup", "Good Support"), under the 70% a guess needs: comments.
  const some = F.summarise(form(['Best part'], [['Tracking Accuracy'], ['Screen Size'], ['Easy Setup'], ['Fast Boot'], ['Good Support']]));
  assert.deepEqual([roleOf(some, 'Best part'), col(some, 'Best part').suggested.confidence, some.commentCount], ['comment', 'high', 5]);
});

test('names found by their shape are an unsure guess under any title, repeated or not; person titles are sure', () => {
  const names = [['Ann Lee'], ['Bo Chan'], ['Cy Wu'], ['Di Ho'], ['Ed Ng']];
  for (const h of ['Who filled this in?', 'Notes', 'Nombre']) unsureHidden(form([h], names), h);
  // Ten answers from three coordinators: names that repeat are still names, not a choice.
  const en = ['Ann Lee', 'Bo Chan', 'Cy Wu', 'Ann Lee', 'Bo Chan', 'Ann Lee', 'Cy Wu', 'Ann Lee', 'Bo Chan', 'Ann Lee'].map((n) => [n]);
  const tw = ['王小明', '陳美玲', '林志豪', '王小明', '陳美玲', '王小明', '林志豪', '王小明', '陳美玲', '王小明'].map((n) => [n]);
  const cn = ['王小明', '陈美玲', '林志豪', '王小明', '陈美玲', '王小明', '林志豪', '王小明', '陈美玲', '王小明'].map((n) => [n]);
  unsureHidden(form(['Site coordinator'], en), 'Site coordinator');
  unsureHidden(form(['窗口'], tw), '窗口');
  unsureHidden(form(['对接人'], cn), '对接人');
  // Contact people and those in charge, by title: sure, and kept out of the cache.
  for (const [h, vals] of [['聯絡人', tw], ['負責人', tw], ['联系人', cn], ['负责人', cn], ['Contact person', en]]) {
    const s = F.summarise(form([h], vals));
    assert.deepEqual([roleOf(s, h), s.choices.length], ['identifying', 0], h);
    const c = F.afterFetch(null, got(form([h], vals)), { now: 1, started: 1, link: LINK });
    assert.deepEqual(c.redacted, [1], h);
    assert.ok(!JSON.stringify(c.rows).includes(vals[0][0]), h);
  }
  for (const h of ['聯絡人', '負責人', '联系人', '负责人']) assert.equal(col(F.summarise(form([h], tw)), h).suggested.confidence, 'high', h);
  const zh = F.summarise(form(['填寫人'], [['王小明'], ['陳大文'], ['林美玲']]));
  assert.deepEqual([roleOf(zh, '填寫人'), col(zh, '填寫人').suggested.confidence], ['identifying', 'high']);
  // Clear labels and email-shaped answers are sure.
  const sure = F.summarise(form(['Email address', 'Reach you at', 'Patient ID', '病歷號碼'], [['a@example.com', 'b@example.com', 'P-1', 'X1']]));
  assert.deepEqual(sure.columns.slice(1).map((c) => [c.role, c.suggested.confidence]), [['identifying', 'high'], ['identifying', 'high'], ['identifying', 'high'], ['identifying', 'high']]);
});

test('phone numbers the sheet stored as numbers are not averaged: an unsure guess, or sure under a contact title', () => {
  const phones = [[912345678], [933222111], [987654321], [955000111]];
  unsureHidden(form(['How can we reach you?'], phones), 'How can we reach you?');
  assert.deepEqual(F.summarise(form(['How can we reach you?'], phones)).numbers, []);
  // The same few people answering again: still phone numbers.
  unsureHidden(form(['How can we reach you?'], [...phones, ...phones, [912345678]]), 'How can we reach you?');
  for (const h of ['聯繫方式', '联系方式']) {
    const t = F.summarise(form([h], phones));
    assert.deepEqual([roleOf(t, h), col(t, h).suggested.confidence], ['identifying', 'high'], h);
  }
  // Small numbers that repeat are still numbers.
  assert.equal(roleOf(F.summarise(form(['Minutes to set up'], [[12], [15], [12], [20], [9]])), 'Minutes to set up'), 'number');
});

test('a column wrongly guessed identifying and then chosen a comment gets its answers back at the next read', () => {
  const rows = [['Timestamp', 'Patient positioning issues', 'Email address', 'Patient comfort (1-5)'],
    ['2026-11-10T09:00:00Z', 'Arm board slipped', 'a@example.com', 4], ['2026-11-11T09:00:00Z', 'Had to re-drape', 'b@example.com', 5]];
  const s = F.summarise(rows);
  assert.deepEqual([roleOf(s, 'Patient positioning issues'), col(s, 'Patient positioning issues').suggested.confidence], ['identifying', 'low']);
  assert.equal(roleOf(s, 'Patient comfort (1-5)'), 'score');
  assert.equal(s.commentCount, 0);
  // Unsure or not, an identifying guess keeps nothing on disk, and still asks after a restart.
  const c = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK });
  assert.deepEqual(c.redacted, [1, 2]);
  assert.ok(!JSON.stringify(c.rows).includes('Arm board slipped'));
  assert.ok(!JSON.stringify(c.rows).includes('@example.com'));
  assert.deepEqual(F.summariseCache(c, []).columns.map((k) => k.needsChoice), [false, true, false, false]);
  // Chosen as a comment: nothing to show until the next read, and the row says so.
  const asComment = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Patient positioning issues', index: 1, role: 'comment' },
    { header: 'Email address', index: 2, role: 'identifying' }, { header: 'Patient comfort (1-5)', index: 3, role: 'score', low: 1, high: 5 }]);
  const now = F.summariseCache(F.reroleCache(c, asComment), asComment);
  assert.deepEqual([col(now, 'Patient positioning issues').hidden, col(now, 'Patient positioning issues').needsChoice, now.commentCount], [true, false, 0]);
  const next = F.afterFetch(F.reroleCache(c, asComment), got(rows), { now: 2, started: 2, link: LINK, roles: asComment });
  assert.deepEqual(next.redacted, [2]);
  assert.equal(F.summariseCache(next, asComment).commentCount, 2);
});

test('a checked column whose answers turn into emails is kept off the board, out of the cache and flagged', () => {
  const R = (role, extra = {}) => F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Anything else?', index: 1, role, ...extra }]);
  const rows = form(['Anything else?'], [['Bigger font'], ['Quieter fan'], ['a.b@example.org'], ['c.d@example.org'], ['e.f@example.org']]);
  for (const roles of [R('comment'), R('choice'), R('score', { low: 1, high: 5 }), R('number')]) {
    const role = roles[1].role;
    const s = F.summarise(rows, { roles });
    assert.deepEqual([col(s, 'Anything else?').role, col(s, 'Anything else?').doubt], [role, true], role);
    assert.deepEqual([s.commentCount, s.choices.length, s.questions.length, s.numbers.length, s.doubtful], [0, 0, 0, 0, ['Anything else?']], role);
    const lines = F.fieldProblems({ enabled: true, summary: s }).map((p) => p.label);
    assert.ok(lines.includes('Field feedback: 1 column you checked now looks like emails or phone numbers; its answers are hidden and not stored (Settings → Field feedback → Check the columns)'), `${role}: ${lines.join('\n')}`);
    // Saved like that, the reply says it stays hidden.
    assert.equal(F.columnsReply(s), 'Kept hidden: its answers look like emails or phone numbers; choose Identifying or Ignore.');
    const c = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK, roles });
    assert.deepEqual(c.redacted, [1], role);
    assert.ok(!JSON.stringify(c.rows).includes('@example.org'), role);
    const again = F.summariseCache(F.reroleCache(c, roles), roles);
    assert.deepEqual([col(again, 'Anything else?').doubt, again.doubtful], [true, ['Anything else?']], role);
  }
  // Chosen identifying or ignore: nothing left to flag, and nothing kept.
  for (const roles of [R('identifying'), R('ignore')]) {
    const s = F.summarise(rows, { roles });
    assert.deepEqual([s.doubtful, F.columnsReply(s)], [[], 'Columns saved.'], roles[1].role);
    const c = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK, roles });
    assert.ok(!JSON.stringify(c.rows).includes('@example.org'), roles[1].role);
  }
  // Before the emails came, nothing to say.
  const before = F.summarise(form(['Anything else?'], [['Bigger font'], ['Quieter fan']]), { roles: R('comment') });
  assert.deepEqual([col(before, 'Anything else?').doubt ?? false, before.commentCount], [false, 2]);
});

test('an ignored column keeps no answers in the cache, and reads the same after a restart', () => {
  const rows = form(['Anything else?', 'Visit date'], [['Bigger font', '2026-11-02'], ['Quieter fan', '2026-11-05'], ['Fine', '2026-11-09'], ['Ok', '2026-11-12'], ['Good', '2026-11-13']]);
  const s = F.summarise(rows);
  assert.deepEqual([roleOf(s, 'Visit date'), col(s, 'Visit date').suggested.reason], ['ignore', 'dates']);
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Anything else?', index: 1, role: 'ignore' }, { header: 'Visit date', index: 2, role: 'ignore' }]);
  // Only suggested: the date column's answers go; read back, it is still an ignored date column.
  const c = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK });
  assert.deepEqual(c.redacted, [2]);
  assert.ok(!JSON.stringify(c.rows).includes('2026-11-05'));
  const back = F.summariseCache(c, []);
  assert.deepEqual([roleOf(back, 'Visit date'), col(back, 'Visit date').suggested.reason, col(back, 'Visit date').needsChoice], ['ignore', 'dates', false]);
  // Chosen ignore: the comments go too.
  const ig = F.reroleCache(c, roles);
  assert.deepEqual(ig.redacted, [1, 2]);
  assert.ok(!JSON.stringify(ig.rows).includes('Quieter fan'));
  // A cache whose notes on hidden columns do not read is set aside.
  assert.match(F.validCache({ ...c, hiddenAs: [{ index: 'x', role: 'ignore', confidence: 'high' }] }, LINK).problem, /could not be read/);
  assert.match(F.validCache({ ...c, hiddenAs: [{ index: 2, role: 'nope', confidence: 'high' }] }, LINK).problem, /could not be read/);
});

test('columns waiting for a choice are a Needs attention line, privacy mode or not', () => {
  const s = F.summarise(form(['How satisfied are you overall?', 'Who filled this in?'], [[6, 'Ann Lee'], [7, 'Bo Chan'], [5, 'Cy Wu']]));
  assert.equal(s.needsChoice, 2);
  const lines = F.fieldProblems({ enabled: true, summary: s }).map((p) => p.label);
  assert.ok(lines.includes('Field feedback: 2 columns need a choice (Settings → Field feedback → Check the columns, with privacy mode off)'), lines.join('\n'));
});

test('a link to the same sheet that names no tab keeps the saved tab, and says so', () => {
  const id = 'B'.repeat(30);
  const cur = { enabled: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`, keyPath: 'k', columns: [] };
  const res = F.changeSettings(cur, { sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing` });
  assert.deepEqual([res.sheetChanged, res.settings.sheetUrl, res.note], [false, cur.sheetUrl, 'Same sheet: kept the tab you had.']);
  assert.equal(F.changeSettings(cur, { sheetUrl: cur.sheetUrl }).note, undefined);
});

test('repeated titles keep their roles in order when a column is added before them, and are flagged', () => {
  const roles = F.checkRoles([{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Rate it', index: 1, role: 'score', low: 1, high: 5 }, { header: 'Rate it', index: 2, role: 'score', low: 1, high: 10 }]);
  const moved = [['Timestamp', 'Site', 'Rate it', 'Rate it'], ['2026-11-10 09:00', 'x', 4, 9], ['2026-11-11 09:00', 'x', 5, 8]];
  const s = F.summarise(moved, { roles });
  assert.deepEqual(s.questions.map((q) => [q.index, q.high, q.unreadable]), [[2, 5, 0], [3, 10, 0]]);
  assert.deepEqual(s.columns.map((c) => Boolean(c.repeated)), [false, false, true, true]);
  assert.deepEqual(s.newColumns, ['Site']);
});

test('the same sheet pasted again keeps its checked columns; turning off keeps no columns', () => {
  const id = 'A'.repeat(30);
  const cur = { enabled: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, keyPath: 'k', columns: [{ header: 'Timestamp', index: 0, role: 'timestamp' }] };
  const again = F.changeSettings(cur, { sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing#gid=0` });
  assert.deepEqual([again.sheetChanged, again.settings.columns.length], [false, 1]);
  // No tab named: the saved one, which names it, stays.
  const plain = F.changeSettings(cur, { sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing` });
  assert.deepEqual([plain.sheetChanged, plain.settings.sheetUrl], [false, cur.sheetUrl]);
  const otherTab = F.changeSettings(cur, { sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=5` });
  assert.deepEqual([otherTab.sheetChanged, otherTab.settings.columns.length], [true, 0]);
  const off = F.changeSettings(cur, { enabled: false });
  assert.deepEqual([off.settings.enabled, off.settings.columns], [false, []]);
});

test('a key file that is busy is a passing trouble; one that is gone waits for the user', () => {
  const gone = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
  assert.equal(F.keyFileError(gone).kind, 'key');
  assert.match(F.keyFileError(gone).message, /no longer where it was chosen/);
  assert.equal(F.keyFileError(busy).kind, 'keyfile');
  const mon0805 = local(2026, 11, 16, 8, 5).getTime();
  const cache = (kind) => ({ fetchedAt: local(2026, 11, 13, 9).getTime(), lastAttemptAt: mon0805, lastError: { kind, message: 'x' } });
  assert.equal(F.planFetch({ now: local(2026, 11, 16, 10).getTime(), settings: SETTINGS, cache: cache('keyfile') }).fetch, true);
  assert.equal(F.planFetch({ now: local(2026, 11, 16, 10).getTime(), settings: SETTINGS, cache: cache('key') }).fetch, false);
});

test('a cache kept while the saved link does not read is set aside without blaming another sheet', () => {
  const failed = F.afterFailure(null, new F.FieldSurveyError('setup', 'bad link'), { now: 1, started: 1, link: null });
  assert.deepEqual(F.validCache(JSON.parse(JSON.stringify(failed)), null), { cache: null, problem: null });
});

// ---- the schedule: Monday, Wednesday and Friday at 08:00 ---------------------------------

test('Sunday waits for Monday 08:00', () => {
  const r = F.nextRun(local(2026, 11, 15, 10), local(2026, 11, 13, 8, 1));
  assert.equal(r.due, false);
  assert.equal(r.next.getTime(), local(2026, 11, 16, 8).getTime());
});

test('Monday at 08:00 is due; the next slot is Wednesday', () => {
  assert.equal(F.nextRun(local(2026, 11, 16, 7, 59), local(2026, 11, 13, 8, 1)).due, false);
  const r = F.nextRun(local(2026, 11, 16, 8), local(2026, 11, 13, 8, 1));
  assert.equal(r.due, true);
  assert.equal(r.next.getTime(), local(2026, 11, 18, 8).getTime());
});

test('Friday after 08:00, already fetched: next is Monday', () => {
  const r = F.nextRun(local(2026, 11, 20, 9, 30), local(2026, 11, 20, 8, 2));
  assert.equal(r.due, false);
  assert.equal(r.next.getTime(), local(2026, 11, 23, 8).getTime());
});

test('the app was off over a slot: catch up as soon as it starts', () => {
  const r = F.nextRun(local(2026, 11, 19, 10), local(2026, 11, 16, 9));
  assert.equal(r.due, true);
  assert.equal(r.lastSlot.getTime(), local(2026, 11, 18, 8).getTime());
  assert.equal(r.next.getTime(), local(2026, 11, 20, 8).getTime());
  assert.equal(F.nextRun(local(2026, 11, 19, 10), null).due, true);
});

test('saving the columns is refused while any column of the sheet has no choice', () => {
  const s = F.summarise(form(['How satisfied are you overall?', 'Ease (1-5)'], [[6, 4], [7, 5], [5, 3]]));
  const cur = { enabled: true, sheetUrl: 'u', keyPath: 'k', columns: [] };
  const sure = [{ header: 'Timestamp', index: 0, role: 'timestamp' }, { header: 'Ease (1-5)', index: 2, role: 'score', low: 1, high: 5 }];
  const refused = F.changeSettings(cur, { columns: sure }, { summary: s });
  assert.match(refused.error, /^Not saved: 1 column still needs a choice/);
  assert.equal(refused.settings, undefined);
  const all = [...sure, { header: 'How satisfied are you overall?', index: 1, role: 'score', low: 1, high: 7 }];
  assert.equal(F.changeSettings(cur, { columns: all }, { summary: s }).settings.columns.length, 3);
  // Nothing read yet: there is nothing to check the columns against.
  assert.match(F.changeSettings(cur, { columns: all }, { summary: null }).error, /not been read/);
  assert.match(F.changeSettings(cur, { columns: [null] }, { summary: s }).error, /could not be read/);
});

test('Title Case scale and frequency answers are choices; names, repeated or not, stay hidden; job and model words stay a guess', () => {
  const six = (list) => list.map((v) => [v]);
  const agree = F.summarise(form(['The setup was quick'], six(['Strongly Agree', 'Agree', 'Strongly Agree', 'Neutral', 'Agree', 'Strongly Agree'])));
  assert.deepEqual([roleOf(agree, 'The setup was quick'), col(agree, 'The setup was quick').suggested.confidence], ['choice', 'high']);
  const happy = F.summarise(form(['Overall'], six(['Very Satisfied', 'Satisfied', 'Very Satisfied', 'Very Satisfied', 'Satisfied', 'Not Satisfied', 'Very Satisfied', 'Satisfied'])));
  assert.equal(roleOf(happy, 'Overall'), 'choice');
  const often = F.summarise(form(['How often?'], six(['Always', 'Usually Not', 'Sometimes', 'Rarely Ever', 'Usually Not', 'Always'])));
  assert.notEqual(roleOf(often, 'How often?'), 'identifying');
  const zh = F.summarise(form(['整體'], six(['非常滿意', '滿意', '非常滿意', '普通', '滿意', '非常滿意'])));
  assert.equal(roleOf(zh, '整體'), 'choice');
  // Names that repeat, with titles and initials, in English and Chinese.
  const people = F.summarise(form(['Who?'], six(['Ann Lee', 'Dr Lee', 'J. Smith', '王小明', 'Ann Lee', 'Dr Lee', 'J. Smith', '王小明', 'Ann Lee', 'Dr Lee'])));
  assert.deepEqual([roleOf(people, 'Who?'), col(people, 'Who?').suggested.confidence, col(people, 'Who?').needsChoice], ['identifying', 'low', true]);
  // No narrow rule tells these from names: an unsure guess, with the prompt.
  for (const [h, vals] of [['Device', ['Model A', 'Model B', 'Model A', 'Model A', 'Model B']], ['Your role', ['Scrub Nurse', 'Circulating Nurse', 'Scrub Nurse', 'Scrub Nurse', 'Circulating Nurse']]]) {
    const g = F.summarise(form([h], six(vals)));
    assert.deepEqual([roleOf(g, h), col(g, h).suggested.confidence, col(g, h).needsChoice], ['identifying', 'low', true], h);
  }
});

test('a timestamp column whose answers the cache does not keep waits for the next read, without unreadable dates', () => {
  const rows = form(['Visit date', 'Rate it (1-5)'], [['2026-11-02', 4], ['2026-11-05', 5], ['2026-11-09', 3], ['2026-11-12', 4]]).map((r) => [r[1], r[2], r[0]]);
  rows[0] = ['Visit date', 'Rate it (1-5)', 'Submitted at'];
  const cache = F.afterFetch(null, got(rows), { now: 1, started: 1, link: LINK });
  assert.deepEqual(cache.redacted, [0]); // the date column, suggested ignore, keeps no answers
  // The user then chooses it as the timestamp.
  const roles = F.checkRoles([{ header: 'Visit date', index: 0, role: 'timestamp' }, { header: 'Rate it (1-5)', index: 1, role: 'score', low: 1, high: 5 },
    { header: 'Submitted at', index: 2, role: 'ignore' }]);
  const s = F.summariseCache(F.reroleCache(cache, roles), roles);
  assert.deepEqual([s.timestampColumn, s.datesWaiting, s.unreadable.timestamps, s.newest, s.responses], ['Visit date', true, 0, null, 4]);
  assert.ok(!F.fieldProblems({ enabled: true, summary: s }).some((p) => /without a readable date/.test(p.label)));
  // The next read brings the dates back.
  const next = F.afterFetch(F.reroleCache(cache, roles), got(rows), { now: 2, started: 2, link: LINK, roles });
  const t = F.summariseCache(next, roles);
  assert.deepEqual([t.datesWaiting ?? false, t.unreadable.timestamps, t.newest != null], [false, 0, true]);
});

// ---- flags ------------------------------------------------------------------------------------

// Rows answered on 1–15 November at 09:00 local time, with the last read's newest answer on the 10th.
const flagForm = (headers, values) => [['Timestamp', ...headers], ...values.map((v, i) => [`2026-11-${String(1 + i).padStart(2, '0')} 09:00`, ...v])];
const SINCE = new Date(2026, 10, 10, 12, 0).toISOString();

test('the low mark: the bottom two points of 1–5, the bottom quarter (rounded up) of longer scales', () => {
  assert.deepEqual([[1, 5], [1, 7], [0, 10], [1, 10]].map(([l, h]) => F.lowMark(l, h)), [2, 2, 2, 3]);
});

test('low scores since the last update are counted per question, by its low mark', () => {
  const old = Array.from({ length: 10 }, () => [4, 9]);
  const fresh = [[1, 3], [2, 4], [3, 2], [5, 10]];
  const s = F.summarise(flagForm(['Ease (1-5)', 'Clarity (1-10)'], [...old, ...fresh]), { since: SINCE });
  const flags = F.fieldFlags({ summary: s });
  assert.deepEqual(flags.filter((f) => f.kind === 'low').map((f) => [f.no, f.count, f.mark]), [[1, 2, 2], [2, 2, 3]]);
  // Both fell well below their earlier 4 and 9.
  assert.deepEqual(flags.filter((f) => f.kind === 'falling').map((f) => f.no), [1, 2]);
});

test('a falling average is flagged at exactly a tenth of the scale, and not with only two new answers', () => {
  const old = [[4], [4], [4], [4], [4], [4], [4], [4], [4], [4]];
  // New answers average 3.6: 0.4 below 4.0 on a 1–5 scale, exactly 10% of its range.
  const s = F.summarise(flagForm(['Ease (1-5)'], [...old, [4], [4], [4], [3], [3]]), { since: SINCE });
  const falling = F.fieldFlags({ summary: s }).filter((f) => f.kind === 'falling');
  assert.deepEqual(falling.map((f) => [f.no, f.newN, Number(f.newMean.toFixed(2)), Number(f.oldMean.toFixed(2))]), [[1, 5, 3.6, 4]]);
  // Just under the line: 3.8 is only 0.2 lower.
  const mild = F.summarise(flagForm(['Ease (1-5)'], [...old, [4], [4], [4], [4], [3]]), { since: SINCE });
  assert.deepEqual(F.fieldFlags({ summary: mild }).filter((f) => f.kind === 'falling'), []);
  // Two new answers, far lower: too few to call a trend.
  const two = F.summarise(flagForm(['Ease (1-5)'], [...old, [1], [1]]), { since: SINCE });
  assert.deepEqual(F.fieldFlags({ summary: two }).filter((f) => f.kind === 'falling'), []);
});

test('new comments are counted; a guessed scale raises no score flags', () => {
  const rows = flagForm(['How satisfied are you overall?', 'Anything else?'], [...Array.from({ length: 10 }, (_, k) => [6, `Earlier note number ${k} about the set-up`]), [1, 'The start-up was far too slow'], [1, 'The holder came loose twice'], [1, 'It crashed during the case']]);
  const flags = F.fieldFlags({ summary: F.summarise(rows, { since: SINCE }) });
  assert.deepEqual(flags.filter((f) => f.kind === 'comments').map((f) => f.count), [3]);
  assert.deepEqual(flags.filter((f) => f.kind === 'low' || f.kind === 'falling'), []);
});

test('setup problems are flags too, each with its fix', () => {
  const s = F.summarise(form(['How satisfied are you overall?'], [[6], [7], [5]]));
  const share = { kind: 'share', message: 'Share the sheet…' };
  assert.deepEqual(F.fieldFlags({ summary: s, lastError: share }).map((f) => [f.kind, f.what, f.fix]), [['setup', 'choose', 'check'], ['setup', 'share', 'settings']]);
  assert.deepEqual(F.fieldFlags({ summary: null, lastError: { kind: 'network', message: 'x' } }).map((f) => [f.what, f.fix]), [['failed', 'refresh']]);
  assert.deepEqual(F.fieldFlags({ summary: null, keyError: 'The key file…' }).map((f) => [f.what, f.fix]), [['key', 'settings']]);
});

test('an empty or never-read cache, or a read with nothing new, raises no flags and does not throw', () => {
  assert.deepEqual(F.fieldFlags(), []);
  assert.deepEqual(F.fieldFlags({ summary: F.summariseCache(null, []) }), []);
  assert.deepEqual(F.fieldFlags({ summary: F.summarise([]) }), []);
  assert.deepEqual(F.fieldFlags({ summary: F.summarise([['Timestamp', 'Ease (1-5)']]) }), []);
  // Every answer is from before the last read: nothing new, nothing to flag.
  const rows = flagForm(['Ease (1-5)'], [[1], [1], [2], [1], [1]]);
  const quiet = F.summarise(rows, { since: new Date(2026, 10, 30).toISOString() });
  assert.deepEqual(F.fieldFlags({ summary: quiet }), []);
  // The first read: no "since" at all.
  assert.deepEqual(F.fieldFlags({ summary: F.summarise(rows) }), []);
});
