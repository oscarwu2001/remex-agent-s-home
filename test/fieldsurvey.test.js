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
  assert.equal(share.message, `Share the sheet with ${ROBOT} as Viewer, then press Refresh now.`);
  assert.equal(share.kind, 'share');
  const api = await fail({ meta: [403, { error: { code: 403, message: 'Google Sheets API has not been used in project 0 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }] });
  assert.match(api.message, /Turn on the Google Sheets API/);
  assert.match((await fail({ meta: [404, { error: { code: 404, status: 'NOT_FOUND' } }] })).message, /The sheet link points to nothing — check it/);
  assert.match((await fail({}, { spreadsheetId: SHEET_ID, gid: 999 })).message, /tab in the link \(gid 999\)/);
  assert.match((await fail({ token: [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }] })).message, /Google refused the key/);
  assert.match((await fail({ token: new Error('net::ERR_INTERNET_DISCONNECTED') })).message, /No network/);
  // Electron's words when a request is redirected and redirects are refused.
  const moved = await fail({ meta: new Error("Attempted to redirect, but redirect policy was 'error'") });
  assert.match(moved.message, /sent the request elsewhere/);
  assert.equal(moved.kind, 'blocked');
  const slow = new Error('The operation was aborted due to timeout');
  slow.name = 'TimeoutError';
  assert.match((await fail({ meta: slow })).message, /did not answer in time/);
  assert.match((await fail({ values: [200, 'not json'] })).message, /not JSON/);
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
  assert.deepEqual(s.questions.map((q) => [q.question, q.n, q.mean, q.low, q.high, q.scaleFrom, q.unreadable]), [
    ['How easy was the setup? (1-5)', 5, 18 / 5, 1, 5, 'header', 0],
    ['How clear was the screen?', 4, 16 / 4, 1, 5, 'answers', 1],
  ]);
  assert.deepEqual(s.overall, { mean: 34 / 9, high: 5, rescaled: false, n: 9 });
  assert.deepEqual(s.comments.map((c) => [c.question, c.text, c.at]), [
    ['What should we improve?', 'Quieter fan', iso(2026, 11, 14, 16, 45, 10)],
    ['What should we improve?', 'Faster start-up', iso(2026, 11, 12, 11, 30)],
    ['What should we improve?', 'Bigger buttons on the tracker page', iso(2026, 11, 10, 9, 15, 2)],
  ]);
  assert.equal(s.commentCount, 3);
  assert.deepEqual(s.identifying, ['Email Address', 'Your name']);
  assert.ok(!JSON.stringify(s).includes('@example.com'));
  assert.ok(!JSON.stringify(s).includes('Alex Tester'));
  assert.deepEqual(s.unreadable, { scores: 1, timestamps: 0 });
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
  // Two scales: the overall average is put on 0–10.
  assert.equal(s.overall.rescaled, true);
  assert.equal(s.overall.high, 10);
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
  assert.deepEqual(s.unreadable, { scores: 1, timestamps: 0 });
  assert.equal(F.unreadableText(s), '1 answer could not be read: 1 score that is not a whole number on its scale');
  // An answer outside the scale the question names is unreadable too.
  const off = F.summarise([['Timestamp', 'Ease (1-5)'], ['2026-11-10 09:00', 4], ['2026-11-10 10:00', 9], ['2026-11-10 11:00', 5], ['2026-11-10 12:00', 5], ['2026-11-10 13:00', 3]]);
  assert.deepEqual(off.questions.map((q) => [q.n, q.mean, q.unreadable]), [[4, 17 / 4, 1]]);
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
  assert.deepEqual(s.columns.find((c) => c.header === 'Column D'), { header: 'Column D', kind: 'text', untitled: true });
});

test('a timestamp that is not a date is counted', () => {
  const s = F.summarise([['Timestamp', 'Rating'], ['2026-11-10 09:00', 4], ['yesterday', 5], ['', 3]]);
  assert.equal(s.responses, 3);
  assert.deepEqual(s.unreadable, { scores: 0, timestamps: 2 });
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

test('other columns: choices are tallied, extra dates and numbers are listed as not summarised', () => {
  const rows = [['Timestamp', 'Your role', 'Date of the case', 'Cases per week', 'Reach you at', 'Anything else?']];
  const roles = ['Surgeon', 'Nurse', 'Surgeon', 'Engineer', 'Surgeon', 'Nurse'];
  roles.forEach((r, i) => rows.push([`2026-11-${10 + i} 09:00`, r, `2026-10-${10 + i}`, 12 + i * 10, `p${i}@example.com`, i === 2 ? 'Fine' : '']));
  const s = F.summarise(rows);
  assert.deepEqual(s.choices, [{ question: 'Your role', n: 6, answers: [{ answer: 'Surgeon', count: 3 }, { answer: 'Nurse', count: 2 }, { answer: 'Engineer', count: 1 }] }]);
  assert.deepEqual(s.skipped, [{ question: 'Date of the case', reason: 'dates' }, { question: 'Cases per week', reason: 'numbers' }]);
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
