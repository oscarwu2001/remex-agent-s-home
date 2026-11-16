'use strict';

// Field feedback: the answers to a Google Form, read from the Google Sheet
// they land in, so the board can show how the field survey is going. Off
// until the user turns it on in Settings and gives a sheet link and the JSON
// key of their own service account, which they have shared the sheet with.
//
// This module names the only hosts the feature may reach, builds and signs
// the requests (Node's own crypto, no packages), turns Google's answers into
// plain sentences and summarises the table; electron/main.js does the
// fetching. Nothing from the user's sessions is ever sent: only the signed
// token request, the sheet's id and the name of its tab.

const crypto = require('crypto');

const TOKEN_HOST = 'oauth2.googleapis.com';
const SHEETS_HOST = 'sheets.googleapis.com';
const HOSTS = new Set([TOKEN_HOST, SHEETS_HOST]);
const TOKEN_URL = `https://${TOKEN_HOST}/token`;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// Every failure the user should read carries `kind` (for the board) and a
// message that says what happened and what to try.
class FieldSurveyError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'FieldSurveyError';
    this.kind = kind;
  }
}

// ---- the sheet link -------------------------------------------------------------

const LINK_HELP = 'Paste the link from the sheet’s address bar; it starts with https://docs.google.com/spreadsheets/d/';

// "https://docs.google.com/spreadsheets/d/<id>/edit?gid=N#gid=N" ->
// { spreadsheetId, gid }. gid is null when the link names no tab (the first
// tab is read then).
function parseSheetLink(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new RangeError(`No sheet link yet. ${LINK_HELP}`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new RangeError(`That is not a link. ${LINK_HELP}`);
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') throw new RangeError(`That link is not a Google Sheet. ${LINK_HELP}`);
  if (/^\/forms\//.test(u.pathname)) {
    throw new RangeError('That is the form’s link. Open the form’s Responses tab, choose “View in Sheets” and copy that sheet’s link.');
  }
  const m = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([^/]+)/.exec(u.pathname);
  if (!m) throw new RangeError(`That link is not a Google Sheet. ${LINK_HELP}`);
  if (m[1] === 'e') throw new RangeError('That is a “published to the web” link. Open the sheet itself and copy the link from the address bar.');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(m[1])) throw new RangeError(`The sheet id in that link looks cut short. ${LINK_HELP}`);
  // The tab being looked at is after the #; a gid in the query may be stale.
  const fromHash = /(?:^#|&)gid=([^&]*)/.exec(u.hash)?.[1];
  const gid = fromHash ?? u.searchParams.get('gid');
  if (gid != null && !/^\d+$/.test(gid)) throw new RangeError('The tab number in that link (gid) is not a number. Open the responses tab and copy the link again.');
  return { spreadsheetId: m[1], gid: gid == null ? null : Number(gid) };
}

// ---- the key ------------------------------------------------------------------------

// The service account key file's text -> { clientEmail, keyId, privateKey }.
// privateKey is a KeyObject, which prints as nothing, so a stray log line
// cannot leak it.
function readKey(text) {
  let k;
  try {
    k = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new TypeError('The key file is not JSON. In Google Cloud, create a key for the service account as JSON and choose that file.');
  }
  if (!k || typeof k !== 'object') throw new TypeError('The key file is not JSON. In Google Cloud, create a key for the service account as JSON and choose that file.');
  if (k.type !== 'service_account') throw new TypeError('The key file is not a service account key (its "type" is not "service_account").');
  if (typeof k.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k.client_email)) {
    throw new TypeError('The key file has no service account email (client_email).');
  }
  if (k.token_uri !== TOKEN_URL) {
    throw new TypeError(`The key file signs in somewhere other than Google (its token_uri is not ${TOKEN_URL}), so it is not used.`);
  }
  if (typeof k.private_key !== 'string' || !k.private_key.includes('PRIVATE KEY')) throw new TypeError('The key file has no private key.');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(k.private_key);
  } catch {
    throw new TypeError('The key file’s private key cannot be read. Create a new key in Google Cloud and choose it.');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new TypeError('The key file’s private key is not an RSA key, which Google’s service accounts use.');
  return { clientEmail: k.client_email, keyId: typeof k.private_key_id === 'string' ? k.private_key_id : undefined, privateKey };
}

const b64 = (s) => Buffer.from(s).toString('base64url');

// The signed request for an hour's read-only access to Sheets (RS256).
function jwtAssertion(key, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(key.keyId ? { kid: key.keyId } : {}) };
  const claims = { iss: key.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${body}.${crypto.sign('sha256', Buffer.from(body), key.privateKey).toString('base64url')}`;
}

// No request follows a redirect: an answer from elsewhere is an error.
function tokenRequest(key, nowMs) {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtAssertion(key, nowMs) }).toString();
  return {
    url: TOKEN_URL,
    init: { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body },
  };
}

// ---- the sheet requests --------------------------------------------------------------

// The sheet's tabs (to find the one the link names) and its time zone (the
// form's timestamps are in it).
function metadataUrl(spreadsheetId) {
  const u = new URL(`https://${SHEETS_HOST}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
  u.searchParams.set('fields', 'properties.timeZone,sheets.properties(sheetId,title)');
  return u.toString();
}

// The whole tab. Numbers come as numbers and dates as serial days, so
// nothing depends on how the sheet formats them.
function valuesUrl(spreadsheetId, title) {
  const range = `'${String(title).replace(/'/g, "''")}'`;
  const u = new URL(`https://${SHEETS_HOST}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  u.searchParams.set('majorDimension', 'ROWS');
  u.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  u.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  return u.toString();
}

// Throws unless the URL is https on one of HOSTS, on the default port, with
// no user name: the one gate every request passes.
function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new FieldSurveyError('blocked', 'A request to an address that could not be read was refused.');
  }
  if (u.protocol !== 'https:' || !HOSTS.has(u.host) || u.username || u.password) {
    throw new FieldSurveyError('blocked', `A request to ${u.host || 'an unknown host'} was refused: field feedback talks only to Google's sign-in and Sheets services.`);
  }
  return url;
}

// The tab the link names, or the first tab when it names none.
function pickTab(meta, gid) {
  if (!meta || !Array.isArray(meta.sheets)) throw new FieldSurveyError('answer', 'Google answered without the sheet’s tabs; try Refresh now.');
  const tabs = meta.sheets.map((s) => s?.properties).filter((p) => p && typeof p.title === 'string' && Number.isInteger(p.sheetId));
  if (!tabs.length) throw new FieldSurveyError('answer', 'Google answered without the sheet’s tabs; try Refresh now.');
  if (gid == null) return tabs[0];
  const tab = tabs.find((p) => p.sheetId === gid);
  if (!tab) throw new FieldSurveyError('tab', `The tab in the link (gid ${gid}) is not in this sheet any more. Open the responses tab and copy its link again.`);
  return tab;
}

const API_OFF = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i;

// Google's refusal -> a sentence with what to try.
function refusal(step, status, body, key) {
  if (step === 'token') {
    const code = typeof body?.error === 'string' ? body.error : '';
    if (code === 'invalid_grant') {
      return new FieldSurveyError('token', 'Google refused the key (invalid_grant): it may have been deleted in Google Cloud, or this computer’s clock is off. Set the clock, or create a new key and choose it.');
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
      return new FieldSurveyError('token', 'Google refused the key: its service account may be disabled or deleted. Check it in Google Cloud.');
    }
    return new FieldSurveyError('token', `Google refused to sign in with the key (${status}). Check the key in Google Cloud, then press Refresh now.`);
  }
  const err = body && typeof body.error === 'object' ? body.error : {};
  const said = [err.message, err.status, ...(Array.isArray(err.details) ? err.details.map((d) => d?.reason) : [])].filter((x) => typeof x === 'string').join(' ');
  if (status === 403 && API_OFF.test(said)) {
    return new FieldSurveyError('api', 'Turn on the Google Sheets API for the key’s Cloud project (APIs & Services → Library → Google Sheets API → Enable), then press Refresh now.');
  }
  if (status === 403) return new FieldSurveyError('share', `Share the sheet with ${key.clientEmail} as Viewer, then press Refresh now.`);
  if (status === 404) return new FieldSurveyError('missing', 'The sheet link points to nothing — check it.');
  if (status === 401) return new FieldSurveyError('token', 'Google did not accept the sign-in for the sheet (401); press Refresh now.');
  if (status === 400 && step === 'values') return new FieldSurveyError('tab', 'Google could not read the responses tab (400). Open the tab and copy its link again.');
  if (status === 429) return new FieldSurveyError('busy', 'Google asked the app to slow down (429); it tries again later.');
  if (status >= 500) return new FieldSurveyError('google', `Google's service had a problem (${status}); it tries again later.`);
  return new FieldSurveyError('google', `Google answered ${status}; press Refresh now, and check the link and the key if it happens again.`);
}

function unreachable(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new FieldSurveyError('network', 'Google did not answer in time; check the internet connection, then press Refresh now.');
  }
  // Requests never follow a redirect (it could lead off the allowed hosts).
  if (/redirect/i.test(String(err?.message))) {
    return new FieldSurveyError('blocked', 'Google sent the request elsewhere, and the app only talks to Google’s sign-in and Sheets services; press Refresh now later.');
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(String(err?.message));
  if (net) return new FieldSurveyError('network', `No network: Google could not be reached (${net[1]}); check the internet connection or proxy.`);
  return new FieldSurveyError('network', `No network: Google could not be reached (${String(err?.message ?? err).slice(0, 120)}).`);
}

// Signs in, finds the tab and reads it. `fetch(url, init)` is the caller's
// (Electron's net.fetch in the app); every URL passes checkUrl first.
// -> { rows, tab: { id, title }, timeZone }. Throws FieldSurveyError.
async function fetchRows({ link, key, fetch, now = Date.now() }) {
  const ask = async (step, url, init) => {
    checkUrl(url);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err instanceof FieldSurveyError) throw err;
      throw unreachable(err);
    }
    let body;
    let text = '';
    try {
      text = await res.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined; // a refusal without JSON is still explained by its status below
    }
    if (!res.ok) throw refusal(step, res.status, body, key);
    if (!body || typeof body !== 'object') throw new FieldSurveyError('answer', 'Google answered with something that is not JSON; try Refresh now.');
    return body;
  };
  const t = tokenRequest(key, now);
  const token = await ask('token', t.url, t.init);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new FieldSurveyError('token', 'Google signed in without a token; try Refresh now.');
  const init = { redirect: 'error', headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } };
  const meta = await ask('sheet', metadataUrl(link.spreadsheetId), init);
  const tab = pickTab(meta, link.gid);
  const vals = await ask('values', valuesUrl(link.spreadsheetId, tab.title), init);
  // Google leaves `values` out when the tab is empty.
  if (vals.values !== undefined && !Array.isArray(vals.values)) throw new FieldSurveyError('answer', 'Google answered without rows; try Refresh now.');
  const timeZone = typeof meta.properties?.timeZone === 'string' ? meta.properties.timeZone : undefined;
  return { rows: vals.values ?? [], tab: { id: tab.sheetId, title: tab.title }, timeZone };
}

// ---- summarising the table -------------------------------------------------------------
//
// We do not know the form's questions, so each column is classified by its
// header and its answers: the timestamp; identifying columns (names, emails,
// phones), which are counted and never shown; score questions (whole numbers
// on a small scale); multiple choice (a few answers, repeated), which are
// tallied; free text, which become comments; and the rest (other dates and
// numbers, empty columns), listed as not summarised.

const STRONG_TIME = /^(time ?stamp|submitted( at)?|submission time|時間戳記|时间戳记|提交時間|提交时间|填答時間)$/i;
const WEAK_TIME = /^(date|time|date ?time|日期|時間|时间)$/i;
const ID_HEADER = /\b(e-?mail|name|phone|mobile|telephone|tel|contact|address|username|employee id|id number)\b|電子郵件|電子信箱|电子邮件|郵件|邮件|信箱|姓名|名字|名稱|名称|電話|电话|手機|手机|聯絡|联络|聯繫|联系|地址|身分證|身份证|工號|員工編號/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{8,}$/;
const SCALE = /(\d+)\s*(?:-|–|—|~|～|to|至|到)\s*(\d+)/i;
const SERIAL_MIN = 25_569; // 1970-01-01 in spreadsheet days
const SERIAL_MAX = 73_051; // 2100-01-01
const MS_DAY = 86_400_000;
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const text = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const columnName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// The offset of a time zone from UTC at a moment, in ms.
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

// A wall-clock time in the sheet's zone (or the computer's) -> ms, or NaN
// when the parts are not a real date (31 February).
function wallClock(y, mo, d, h, mi, s, timeZone) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1) return NaN;
  if (!timeZone) return new Date(y, mo - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

const DATE_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T]+(上午|下午|[AaPp]\.?[Mm]\.?)?\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(上午|下午|[AaPp]\.?[Mm]\.?)?)?$/;
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// One cell -> ms, or NaN. `dayFirst`: dd/mm/yyyy (decided per column).
function dateOf(v, { timeZone, dayFirst = false } = {}) {
  if (typeof v === 'number') {
    if (v < SERIAL_MIN || v > SERIAL_MAX) return NaN;
    const u = new Date(Math.round((v - SERIAL_MIN) * MS_DAY));
    return wallClock(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(), timeZone);
  }
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (ZONED_ISO.test(t)) return Date.parse(t);
  const m = DATE_RE.exec(t);
  if (!m) return NaN;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number);
  let ymd;
  if (m[1].length === 4) ymd = [a, b, c];
  else if (m[3].length === 4) ymd = dayFirst ? [c, b, a] : [c, a, b];
  else return NaN;
  const [y, mo, d] = ymd;
  let h = Number(m[5] ?? 0);
  const half = m[4] ?? m[8];
  if (half) {
    if (h < 1 || h > 12) return NaN;
    const pm = half === '下午' || /^p/i.test(half);
    h = (h % 12) + (pm ? 12 : 0);
  }
  return wallClock(y, mo, d, h, Number(m[6] ?? 0), Number(m[7] ?? 0), timeZone);
}

// dd/mm/yyyy when any date in the column starts with a day above 12.
function dayFirstColumn(values) {
  return values.some((v) => {
    const m = typeof v === 'string' ? DATE_RE.exec(v.trim()) : null;
    return m && m[3].length === 4 && Number(m[1]) > 12;
  });
}

const intOf = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  return NaN;
};
const numberOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
const share = (values, ok) => (values.length ? values.filter(ok).length / values.length : 0);

// The scale a score question names in its header ("(1-5)", "1~10"), or the
// one its answers fit: 0 or 1 up to 5, 7 or 10.
function scaleOf(header, ints) {
  const m = SCALE.exec(header);
  if (m) {
    const [low, high] = [Number(m[1]), Number(m[2])];
    if ((low === 0 || low === 1) && high > low && high <= 10) return { low, high, scaleFrom: 'header' };
  }
  const max = ints.reduce((a, b) => Math.max(a, b), 0);
  return { low: ints.includes(0) ? 0 : 1, high: [5, 7, 10].find((h) => h >= max) ?? 10, scaleFrom: 'answers' };
}

// An email address, or a phone number (eight digits or more, not a date).
function looksPersonal(v) {
  const s = text(v);
  if (EMAIL.test(s)) return true;
  return typeof v === 'string' && PHONE.test(s) && (s.match(/\d/g) ?? []).length >= 8 && !Number.isFinite(dateOf(s));
}

function classify(header, values, untitled) {
  if (!values.length) return { kind: 'skipped', reason: 'no answers' };
  if (!untitled && ID_HEADER.test(header)) return { kind: 'identifying' };
  if (share(values, looksPersonal) >= 0.5) return { kind: 'identifying' };
  const ints = values.map(intOf);
  if (share(ints, (n) => Number.isInteger(n) && n >= 0 && n <= 10) >= 0.8) {
    return { kind: 'score', ...scaleOf(header, ints.filter((n) => Number.isInteger(n) && n >= 0 && n <= 10)) };
  }
  const dayFirst = dayFirstColumn(values);
  if (share(values, (v) => Number.isFinite(dateOf(v, { dayFirst }))) >= 0.8) return { kind: 'skipped', reason: 'dates' };
  if (share(values, (v) => Number.isFinite(numberOf(v))) >= 0.8) return { kind: 'skipped', reason: 'numbers' };
  const answers = values.map(text);
  const distinct = new Set(answers);
  if (answers.length >= 5 && distinct.size <= 6 && distinct.size <= answers.length / 2 && answers.every((a) => a.length <= 60)) return { kind: 'choice' };
  return { kind: 'text' };
}

function findTimestamp(headers, columns, timeZone) {
  const parses = (i) => {
    const dayFirst = dayFirstColumn(columns[i]);
    return columns[i].length > 0 && share(columns[i], (v) => Number.isFinite(dateOf(v, { timeZone, dayFirst }))) >= 0.8;
  };
  let i = headers.findIndex((h) => STRONG_TIME.test(h));
  if (i >= 0) return i;
  i = headers.findIndex((h, k) => WEAK_TIME.test(h) && parses(k));
  if (i >= 0) return i;
  return headers.findIndex((h, k) => !ID_HEADER.test(h) && parses(k));
}

function usableZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return undefined; // an unknown zone: the computer's own is used, and the summary says 'local'
  }
}

const toMs = (v) => (v == null ? null : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
const isoOf = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

// rows: the tab, row 0 the headers. since: count answers after this time.
// comments: how many of the newest to keep. timeZone: the sheet's.
function summarise(rows, { since = null, comments: keep = 8, timeZone } = {}) {
  const zone = usableZone(timeZone);
  const out = {
    responses: 0, blankRows: 0, timestampColumn: null, timeZone: zone ?? 'local',
    newest: null, oldest: null, since: isoOf(toMs(since)), newSince: null,
    questions: [], overall: null, comments: [], commentCount: 0, choices: [],
    identifying: [], skipped: [], columns: [], unreadable: { scores: 0, timestamps: 0 },
  };
  if (!Array.isArray(rows) || !rows.length) return { ...out, empty: true };
  const head = Array.isArray(rows[0]) ? rows[0] : [];
  // Not Math.max(...rows): a long sheet would overflow the call stack.
  const width = rows.reduce((w, r, k) => (k && Array.isArray(r) ? Math.max(w, r.length) : w), head.length);
  const headers = Array.from({ length: width }, (_, i) => text(head[i]) || `Column ${columnName(i)}`);
  const untitled = Array.from({ length: width }, (_, i) => !text(head[i]));
  const data = [];
  for (const r of rows.slice(1)) {
    const cells = Array.from({ length: width }, (_, i) => (Array.isArray(r) ? r[i] : undefined));
    if (cells.every(isEmpty)) out.blankRows += 1;
    else data.push(cells);
  }
  out.responses = data.length;
  const columns = headers.map((_, i) => data.map((r) => r[i]).filter((v) => !isEmpty(v)));

  // When each answer came in.
  const tsCol = findTimestamp(headers, columns, zone);
  const times = data.map(() => null);
  if (tsCol >= 0) {
    out.timestampColumn = headers[tsCol];
    const dayFirst = dayFirstColumn(columns[tsCol]);
    data.forEach((r, k) => {
      const ms = dateOf(r[tsCol], { timeZone: zone, dayFirst });
      if (Number.isFinite(ms)) times[k] = ms;
      else out.unreadable.timestamps += 1;
    });
    const known = times.filter((t) => t != null);
    if (known.length) {
      out.newest = isoOf(known.reduce((a, b) => Math.max(a, b)));
      out.oldest = isoOf(known.reduce((a, b) => Math.min(a, b)));
    }
    const after = toMs(since);
    if (after != null && Number.isFinite(after)) out.newSince = known.filter((t) => t > after).length;
  }

  const allComments = [];
  const overall = [];
  headers.forEach((header, i) => {
    if (i === tsCol) {
      out.columns.push({ header, kind: 'timestamp', ...(untitled[i] ? { untitled: true } : {}) });
      return;
    }
    const c = classify(header, columns[i], untitled[i]);
    out.columns.push({ header, kind: c.kind, ...(c.reason ? { reason: c.reason } : {}), ...(untitled[i] ? { untitled: true } : {}) });
    if (c.kind === 'identifying') out.identifying.push(header);
    else if (c.kind === 'skipped') out.skipped.push({ question: header, reason: c.reason });
    else if (c.kind === 'score') {
      const ok = columns[i].map(intOf).filter((n) => Number.isInteger(n) && n >= c.low && n <= c.high);
      const unreadable = columns[i].length - ok.length;
      out.unreadable.scores += unreadable;
      out.questions.push({
        question: header, n: ok.length, mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
        low: c.low, high: c.high, scaleFrom: c.scaleFrom, unreadable,
      });
      for (const v of ok) overall.push({ v, low: c.low, high: c.high });
    } else if (c.kind === 'choice') {
      const counts = new Map();
      for (const a of columns[i].map(text)) counts.set(a, (counts.get(a) ?? 0) + 1);
      const answers = [...counts].map(([answer, count]) => ({ answer, count })).sort((a, b) => b.count - a.count);
      out.choices.push({ question: header, n: columns[i].length, answers });
    } else {
      data.forEach((r, k) => {
        if (!isEmpty(r[i])) allComments.push({ question: header, text: text(r[i]).slice(0, 1000), ms: times[k], row: k, col: i });
      });
    }
  });

  // One scale for all: a plain average. Several: each answer put on 0–10.
  if (overall.length) {
    const same = overall.every((o) => o.low === overall[0].low && o.high === overall[0].high);
    const vals = same ? overall.map((o) => o.v) : overall.map((o) => ((o.v - o.low) / (o.high - o.low)) * 10);
    out.overall = { mean: vals.reduce((a, b) => a + b, 0) / vals.length, high: same ? overall[0].high : 10, rescaled: !same, n: vals.length };
  }

  // Newest first; with no date, later rows are newer (forms add at the end).
  allComments.sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || b.row - a.row || a.col - b.col);
  out.commentCount = allComments.length;
  out.comments = allComments.slice(0, keep).map((c) => ({ question: c.question, text: c.text, at: isoOf(c.ms) }));
  return out;
}

// The unreadable answers in one sentence, or null. No headers or answers in
// it, so it is safe under "Needs attention" with privacy on.
function unreadableText(summary) {
  const { scores = 0, timestamps = 0 } = summary?.unreadable ?? {};
  const total = scores + timestamps;
  if (!total) return null;
  const parts = [];
  if (scores) parts.push(`${scores} ${scores === 1 ? 'score that is' : 'scores that are'} not a whole number on its scale`);
  if (timestamps) parts.push(`${timestamps} ${timestamps === 1 ? 'row' : 'rows'} without a readable date`);
  return `${total} ${total === 1 ? 'answer' : 'answers'} could not be read: ${parts.join(', ')}`;
}

// ---- the schedule ------------------------------------------------------------------------
//
// Monday, Wednesday and Friday at 08:00, the computer's time. `due`: the last
// good fetch is older than the latest slot (or there is none), so fetch now;
// this is also how a computer that was off over a slot catches up.

const SLOT_DAYS = new Set([1, 3, 5]);
const SLOT_HOUR = 8;

function nextRun(now, lastOk) {
  const t = new Date(toMs(now));
  const slot = (offset) => new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset, SLOT_HOUR, 0, 0, 0);
  let lastSlot;
  for (let k = 0; k >= -7 && !lastSlot; k -= 1) {
    const s = slot(k);
    if (SLOT_DAYS.has(s.getDay()) && s <= t) lastSlot = s;
  }
  let next;
  for (let k = 0; k <= 7 && !next; k += 1) {
    const s = slot(k);
    if (SLOT_DAYS.has(s.getDay()) && s > t) next = s;
  }
  const ok = toMs(lastOk);
  return { due: ok == null || !Number.isFinite(ok) || ok < lastSlot.getTime(), lastSlot, next };
}

module.exports = {
  HOSTS, TOKEN_URL, SCOPE, FieldSurveyError,
  parseSheetLink, readKey, jwtAssertion, tokenRequest, metadataUrl, valuesUrl, checkUrl, pickTab, fetchRows,
  summarise, unreadableText, nextRun, dateOf,
};
