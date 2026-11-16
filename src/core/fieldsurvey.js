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

// Every failure the user should read carries `kind` (for the board and the
// retry rule), a message that says what happened and what to try, and
// sometimes a `detail` that shows only with privacy off (the reader address).
class FieldSurveyError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'FieldSurveyError';
    this.kind = kind;
    if (detail) this.detail = detail;
  }
}

// Failures that may pass by themselves, so the schedule tries again after
// RETRY_MS. Every other refusal waits for the next slot, a new link or key,
// or Refresh now: trying again sooner would only fail again.
const TRANSIENT = new Set(['network', 'busy', 'google', 'answer', 'keyfile']);

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

// The key file could not be read -> why, and whether waiting helps: a file
// that is gone waits for the user; a busy or locked one (a synced drive, a
// virus scan) passes.
function keyFileError(err) {
  if (err?.code === 'ENOENT') return new FieldSurveyError('key', 'The key file is no longer where it was chosen; choose it again in Settings.');
  return new FieldSurveyError('keyfile', `The key file could not be read just now (${err?.code || err?.message}); it tries again in half an hour.`);
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
  if (!meta || !Array.isArray(meta.sheets)) throw new FieldSurveyError('answer', 'Google answered without the sheet’s tabs. Press Refresh now.');
  const tabs = meta.sheets.map((s) => s?.properties).filter((p) => p && typeof p.title === 'string' && Number.isInteger(p.sheetId));
  if (!tabs.length) throw new FieldSurveyError('answer', 'Google answered without the sheet’s tabs. Press Refresh now.');
  if (gid == null) return tabs[0];
  const tab = tabs.find((p) => p.sheetId === gid);
  if (!tab) throw new FieldSurveyError('tab', `The tab in the link (gid ${gid}) is not in this sheet any more. Open the responses tab and copy its link again.`);
  return tab;
}

const API_OFF = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i;
const RATE = /RATE_LIMIT|quota|rateLimitExceeded|userRateLimit/i;
const BUSY = () => new FieldSurveyError('busy', 'Google asked the app to slow down; it tries again in half an hour, or press Refresh now in a while.');
const DOWN = (status) => new FieldSurveyError('google', `Google's service had a problem (${status}); it tries again in half an hour.`);

// Google's refusal -> a sentence with what to try.
function refusal(step, status, body, key) {
  if (status === 429) return BUSY();
  if (status >= 500) return DOWN(status);
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
  if (status === 403 && RATE.test(said)) return BUSY();
  // The address itself is the detail: it shows only with privacy off.
  if (status === 403) {
    return new FieldSurveyError('share', 'Share the sheet with the key’s reader address (copy it in Settings → Field feedback) as Viewer, then press Refresh now.', key.clientEmail);
  }
  if (status === 404) return new FieldSurveyError('missing', 'No sheet was found at this link. Open it in your browser to check it, then paste it again in Settings → Field feedback.');
  if (status === 401) return new FieldSurveyError('token', 'Google did not accept the sign-in for the sheet (401); press Refresh now.');
  if (status === 400 && step === 'values') return new FieldSurveyError('tab', 'Google could not read the responses tab (400). Open the tab and copy its link again.');
  return new FieldSurveyError('google', `Google answered ${status}; press Refresh now, and check the link and the key if it happens again.`);
}

function unreachable(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new FieldSurveyError('network', 'Google did not answer in time; check the internet connection, then press Refresh now.');
  }
  // Requests never follow a redirect (it could lead off the allowed hosts).
  if (/redirect/i.test(String(err?.message))) {
    return new FieldSurveyError('blocked', 'Google redirected the request, which the app does not follow. Press Refresh now in a few minutes.');
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
    // The body arrives after the status: a timeout or a dropped connection
    // here is the network's fault, not an answer that could not be read.
    let raw;
    try {
      raw = await res.text();
    } catch (err) {
      throw unreachable(err);
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined; // a refusal without JSON is still explained by its status below
    }
    if (!res.ok) throw refusal(step, res.status, body, key);
    if (!body || typeof body !== 'object') throw new FieldSurveyError('answer', 'Google’s answer could not be read. Press Refresh now.');
    return body;
  };
  const t = tokenRequest(key, now);
  const token = await ask('token', t.url, t.init);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new FieldSurveyError('answer', 'Google signed in without a token. Press Refresh now.');
  const init = { redirect: 'error', headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } };
  const meta = await ask('sheet', metadataUrl(link.spreadsheetId), init);
  const tab = pickTab(meta, link.gid);
  const vals = await ask('values', valuesUrl(link.spreadsheetId, tab.title), init);
  // Google leaves `values` out when the tab is empty.
  if (vals.values !== undefined && !Array.isArray(vals.values)) throw new FieldSurveyError('answer', 'Google answered without rows. Press Refresh now.');
  const timeZone = typeof meta.properties?.timeZone === 'string' ? meta.properties.timeZone : undefined;
  return { rows: vals.values ?? [], tab: { id: tab.sheetId, title: tab.title }, timeZone };
}

// ---- summarising the table -------------------------------------------------------------
//
// We do not know the form's questions, so each column gets a suggested role
// from its header and its answers. The user confirms or changes the roles
// once, in Settings ("Check the columns"); a confirmed role always wins, and
// a column that appears later is flagged until it is checked too.
//
//   timestamp    when each answer came in
//   score        a whole number on a scale low–high, averaged
//   number       a count or another number (not a score), averaged apart
//   choice       a few answers, repeated: tallied
//   comment      free text, newest first
//   identifying  names, emails, phones, patient or case numbers: counted,
//                never shown, and not kept in the cache
//   ignore       left out (other dates, empty columns, or the user's choice)

const ROLES = ['timestamp', 'score', 'number', 'choice', 'comment', 'identifying', 'ignore'];
const STRONG_TIME = /^(time ?stamp|submitted( at)?|submission time|時間戳記|时间戳记|提交時間|提交时间|填答時間)$/i;
const WEAK_TIME = /^(date|time|date ?time|日期|時間|时间)$/i;

// Identifying by the header only when the header is a short label ("Name",
// "Email address", "Patient ID", "電話"), never by a word inside a question
// ("Did the device address the problem?", "Name one thing you liked").
const PERSON = "(?:your|my|full|first|last|given|family|sur|respondent'?s?|user|contact|patient'?s?|surgeon'?s?|doctor'?s?|physician'?s?|nurse'?s?|staff|reporter'?s?|interviewer'?s?)";
const ID_LABEL = new RegExp(`^(?:${PERSON} )?(?:name|e-?mail(?: address)?|phone(?: number| no)?|mobile(?: number| phone| no)?|cell ?phone|telephone(?: number)?|tel|contact(?: details| info| number)?|address|user ?name|line id|employee (?:id|number|no)|id number)$`, 'i');
const PERSON_ROLE = /^(?:surgeon|doctor|physician|nurse|respondent|reporter|interviewer|filled in by|submitted by)$/i;
const CASE_ID = /\b(?:patients?|mrn|case (?:id|no|number|#)|chart (?:id|no|number|#)|medical records?)\b|\b(?:case|chart) ?#/i;
const ID_CJK_DATA = /姓名|名字|名前|氏名|電子郵件|电子邮件|電郵|电邮|信箱|郵件地址|邮件地址|電話|电话|手機號碼|手机号码|手機|手机|聯絡方式|聯絡電話|聯繫方式|联系方式|联系电话|地址|身分證|身份证|工號|工号|員工編號|员工编号/;
const ID_CJK_ROLE = /^(?:醫師|医师|醫生|医生|護理師|护理师|填寫人|填写人|填表人|填答者|受訪者|受访者|聯絡人|联络人|聯繫人|联系人|負責人|负责人)(?:姓名)?$/;
const ID_CJK_CASE = /病歷|病历|病人|病患|患者|個案|个案|病例/;
// A header naming a number of its own ("Patient ID", "病歷號碼"): its answers
// identify even when they are small whole numbers.
const ID_WORD = /\b(?:id|no|number|mrn)\b|#|號|号|編號|编号/i;
const COUNT_HEADER = /\bhow many\b|\bnumber of\b|\btimes\b|次數|次数|幾次|几次|多少次|多少個|多少个/i;
const RANGE = /(\d+)\s*(?:-|–|—|~|～|to|至|到)\s*(\d+)/gi;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{8,}$/;
// A whole number of eight digits or more: a phone number the sheet stored
// as a number (its leading 0 or + dropped), or an ID number.
const LONG_NUMBER = /^\+?\d{8,}$/;
const NAME_WORD = /^(?:\p{Lu}[\p{Ll}'’-]+|\p{Lu}\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)$/u;
// Common family names, for telling a two-to-four character Chinese name
// from a short comment ("王小明" from "很好").
const SURNAMES = '陳陈林黃黄張张李王吳吴劉刘蔡楊杨許许鄭郑謝谢郭洪曾邱廖賴赖周徐蘇苏葉叶莊庄呂吕江何蕭萧羅罗高潘簡简朱鍾钟彭游詹胡施沈余趙赵盧卢梁顏颜柯孫孙魏翁戴范宋方鄧邓杜傅侯曹溫温薛丁馬马蔣蒋唐卓藍蓝馮冯姚石董紀纪歐欧程連连古汪湯汤姜田康鄒邹白涂尤巫韓韩龔龚嚴严袁黎金阮陸陆倪夏童邵';
const SERIAL_MIN = 25_569; // 1970-01-01 in spreadsheet days
const SERIAL_MAX = 73_051; // 2100-01-01
const MS_DAY = 86_400_000;
const HIDDEN = '[hidden]'; // stands in, in the cache, for an identifying answer
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
const onScale = (n) => Number.isInteger(n) && n >= 0 && n <= 10;

// The header without notes in brackets or punctuation: "Email (optional)"
// -> "Email".
const headerLabel = (header) => header.replace(/[(（【[][^)）】\]]*[)）】\]]/g, ' ').replace(/[?？:：*.,，、!！。]/g, ' ').replace(/\s+/g, ' ').trim();

// 'label': a short label that is surely personal ("Email address", "Patient
// ID", "電話"); 'word': a title with a patient or case word alone ("Patient
// positioning issues"), which may be a question about patients; else null.
function idByHeader(header) {
  const label = headerLabel(header);
  if (!label) return null;
  if (ID_LABEL.test(label) || PERSON_ROLE.test(label) || ID_CJK_ROLE.test(label)) return 'label';
  if (ID_CJK_DATA.test(label) && label.length <= 10) return 'label';
  const caseWord = (CASE_ID.test(label) && label.split(' ').length <= 4) || (ID_CJK_CASE.test(label) && label.length <= 10);
  if (caseWord) return ID_WORD.test(label) ? 'label' : 'word';
  return null;
}

// An email address, or a phone number (eight digits or more, not a date).
function looksPersonal(v) {
  const s = text(v);
  if (EMAIL.test(s)) return true;
  return typeof v === 'string' && PHONE.test(s) && (s.match(/\d/g) ?? []).length >= 8 && !Number.isFinite(dateOf(s));
}

// Words of a rating or frequency scale: "Very Easy" or "Strongly Agree" has
// a name's shape but is an answer on a scale. (Job, room and product words
// are left out on purpose: "Scrub Nurse" or "Model A" stay an unsure guess.)
const SCALE_WORDS = new Set(['very', 'quite', 'somewhat', 'strongly', 'slightly', 'extremely', 'fairly', 'not', 'agree', 'disagree', 'neutral',
  'satisfied', 'dissatisfied', 'easy', 'difficult', 'hard', 'likely', 'unlikely', 'excellent', 'good', 'fair', 'poor', 'always', 'never', 'often',
  'sometimes', 'rarely', 'usually']);
const SCALE_HAN = /非常|很|有點|有点|普通|同意|不同意|滿意|满意|容易|困難|困难/;

// "Ann Lee", "Dr Alpha", "王小明": a person's name, by its shape. "Easy
// Setup" has the same shape, so a column of them is only ever a guess.
function looksLikeName(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (SCALE_HAN.test(s)) return false;
  if (/^\p{Script=Han}{2,3}$/u.test(s)) return SURNAMES.includes(s[0]);
  const words = s.split(/\s+/);
  if (words.some((w) => SCALE_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return false;
  return words.length >= 2 && words.length <= 3 && words.every((w) => NAME_WORD.test(w));
}

// The scale a header states ("(1-5)", "1~10"); with several ranges in it
// ("in the first 1-2 weeks? (1-5)") the last one that can be a scale.
function statedScale(header) {
  let found = null;
  for (const m of header.matchAll(RANGE)) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    if ((low === 0 || low === 1) && high > low && high <= 10) found = { low, high };
  }
  return found;
}

// The scale the answers fit: 1 up to 5, 7 or 10. Only ever a guess, and
// shown as one.
function guessedScale(ints) {
  const max = ints.reduce((a, b) => Math.max(a, b), 0);
  return { low: ints.includes(0) ? 0 : 1, high: [5, 7, 10].find((h) => h >= max) ?? 10 };
}

// The suggested role of one column, from its header and its answers, and
// how sure it is. 'high' only for a clear label ("Email address", "Patient
// ID", "電話") or answers that read as emails or phone numbers. 'low': a
// guessed scale, a 0 with no scale, a patient or case word in a longer
// title, and answers shaped like personal data with no label to say so
// (names, long whole numbers). The user chooses each low one before the
// columns save; an identifying guess, sure or not, keeps its answers off
// the board and out of the cache, and a wrong one, once changed, costs one
// update: the answers come back at the next read.
const HIGH = 'high';
const LOW = 'low';
function suggest(header, values, untitled) {
  if (!values.length) return { role: 'ignore', reason: 'no answers', confidence: HIGH };
  const ints = values.map(intOf);
  // A score: 80% whole numbers on a small scale; or, on a small form where
  // one "n/a" weighs a lot, at least half, the rest short placeholders.
  const scored = share(ints, onScale);
  const scoreLike = scored >= 0.8 || (scored >= 0.5 && values.every((v, k) => onScale(ints[k]) || text(v).length <= 20));
  const byHeader = untitled ? null : idByHeader(header);
  // "Patient satisfaction (1-5)" is a score about a patient, not who it was.
  if (byHeader && !(scoreLike && !ID_WORD.test(headerLabel(header)))) return { role: 'identifying', reason: 'header', confidence: byHeader === 'label' ? HIGH : LOW };
  if (share(values, looksPersonal) >= 0.5) return { role: 'identifying', reason: 'answers', confidence: HIGH };
  const answers = values.map(text);
  const counts = new Map();
  for (const a of answers) counts.set(a, (counts.get(a) ?? 0) + 1);
  // Names and long numbers, repeated or not (the same few coordinators
  // answer again and again): before the choice and number rules.
  if (share(values, looksLikeName) >= 0.7) return { role: 'identifying', reason: 'names', confidence: LOW };
  if (share(answers, (a) => LONG_NUMBER.test(a)) >= 0.7) return { role: 'identifying', reason: 'numbers', confidence: LOW };
  if (scoreLike) {
    const stated = statedScale(header);
    // "How many times…" with 0, 2, 1, 3: counts, not a scale.
    if (COUNT_HEADER.test(header)) return { role: 'number', reason: 'count', confidence: HIGH };
    if (!stated && ints.includes(0)) return { role: 'number', reason: 'count', confidence: LOW };
    if (stated) return { role: 'score', ...stated, scaleFrom: 'header', confidence: HIGH };
    return { role: 'score', ...guessedScale(ints.filter(onScale)), scaleFrom: 'answers', confidence: LOW };
  }
  const dayFirst = dayFirstColumn(values);
  if (share(values, (v) => Number.isFinite(dateOf(v, { dayFirst }))) >= 0.8) return { role: 'ignore', reason: 'dates', confidence: HIGH };
  if (share(values, (v) => Number.isFinite(numberOf(v))) >= 0.8) return { role: 'number', confidence: HIGH };
  // A few answers, repeated, are a choice; but one answer of more than a few
  // words, given once, makes it free text ("No", "No", "The holder slips").
  const wordy = answers.some((a) => counts.get(a) === 1 && (a.split(/\s+/).length > 3 || a.length > 20));
  if (answers.length >= 5 && counts.size <= 6 && counts.size <= answers.length / 2 && answers.every((a) => a.length <= 60) && !wordy) return { role: 'choice', confidence: HIGH };
  return { role: 'comment', confidence: HIGH };
}

// The confirmed role of each column, by its header: a column the form moved
// keeps its role and a new one has none. Columns that share a title are
// matched in their order among themselves, so one added before them does
// not swap their roles.
function matchRoles(headers, roles) {
  const list = Array.isArray(roles) ? roles : [];
  const pick = headers.map(() => null);
  const byTitle = new Map();
  list.forEach((r) => {
    if (!byTitle.has(r.header)) byTitle.set(r.header, []);
    byTitle.get(r.header).push(r);
  });
  for (const saved of byTitle.values()) saved.sort((a, b) => a.index - b.index);
  const seen = new Map();
  headers.forEach((h, i) => {
    const k = seen.get(h) ?? 0;
    seen.set(h, k + 1);
    pick[i] = byTitle.get(h)?.[k] ?? null;
  });
  return pick;
}

// Roles from Settings, checked before they are saved.
function checkRoles(list) {
  const bad = () => new TypeError('The column roles could not be read; open Check the columns again.');
  if (!Array.isArray(list) || list.length > 1000) throw bad();
  return list.map((r) => {
    if (!r || typeof r.header !== 'string' || r.header.length > 5000 || !Number.isInteger(r.index) || r.index < 0 || !ROLES.includes(r.role)) throw bad();
    const out = { header: r.header, index: r.index, role: r.role };
    if (r.role === 'score') {
      const low = Number(r.low);
      const high = Number(r.high);
      if (!((low === 0 || low === 1) && Number.isInteger(high) && high > low && high <= 10)) {
        throw new RangeError('A score’s scale starts at 0 or 1 and ends above it, at 10 at most.');
      }
      Object.assign(out, { low, high });
    }
    return out;
  });
}

// The roles from Settings against the columns shown: how many columns have
// none (a low-confidence row the user has not chosen yet). Save is refused
// while any is missing.
function checkSubmission(summary, roles) {
  const given = new Set((Array.isArray(roles) ? roles : []).filter(Boolean).map((r) => `${r.index}\u0000${r.header}`));
  return { missing: (summary?.columns ?? []).filter((c) => !given.has(`${c.index}\u0000${c.header}`)).length };
}

function findTimestamp(headers, columns, timeZone, candidate) {
  const parses = (i) => {
    const dayFirst = dayFirstColumn(columns[i]);
    return columns[i].length > 0 && share(columns[i], (v) => Number.isFinite(dateOf(v, { timeZone, dayFirst }))) >= 0.8;
  };
  let i = headers.findIndex((h, k) => candidate(k) && STRONG_TIME.test(h));
  if (i >= 0) return i;
  i = headers.findIndex((h, k) => candidate(k) && WEAK_TIME.test(h) && parses(k));
  if (i >= 0) return i;
  return headers.findIndex((h, k) => candidate(k) && !idByHeader(h) && parses(k));
}

// Typed dates such as 03/04/2026 that could be either way round: the column
// shows no day above 12 in either place, so month first was assumed.
function ambiguousDates(values) {
  const parts = values.map((v) => (typeof v === 'string' ? DATE_RE.exec(v.trim()) : null)).filter((m) => m && m[3].length === 4);
  if (parts.some((m) => Number(m[1]) > 12 || Number(m[2]) > 12)) return 0;
  return parts.filter((m) => m[1] !== m[2]).length;
}

function usableZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return undefined; // an unknown zone: the computer's own is used, and the summary names it (timeZoneUnknown)
  }
}

const toMs = (v) => (v == null ? null : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
const isoOf = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

// rows: the tab, row 0 the headers. since: count answers after this time.
// comments: how many of the newest to keep. timeZone: the sheet's. roles:
// the user's confirmed column roles. redacted: columns whose answers the
// cache does not keep; hiddenAs: what the app suggested for each of them
// when they were read (an unsure guess still asks, a checked column whose
// answers read as emails stays flagged, an ignored date column stays one).
// Roles whose answers, or numbers made of them, the board shows.
const SHOWN = new Set(['comment', 'choice', 'score', 'number']);

function summarise(rows, { since = null, comments: keep = 8, timeZone, roles = [], redacted = [], hiddenAs = [] } = {}) {
  const zone = usableZone(timeZone);
  const out = {
    responses: 0, blankRows: 0, timestampColumn: null, timeZone: zone ?? 'local',
    timeZoneUnknown: timeZone && !zone ? String(timeZone).slice(0, 60) : null,
    newest: null, oldest: null, since: isoOf(toMs(since)), newSince: null,
    checked: false, needsChoice: 0, newColumns: [], columns: [],
    questions: [], numbers: [], overall: null, scalesGuessed: 0, comments: [], commentCount: 0, choices: [],
    identifying: [], doubtful: [], skipped: [], unreadable: { scores: 0, numbers: 0, timestamps: 0 }, ambiguousDates: 0,
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
  const hidden = new Set(redacted);
  const was = new Map(hiddenAs.map((h) => [h.index, h]));
  // A hidden column's answers are not here to look at.
  const columns = headers.map((_, i) => (hidden.has(i) ? [] : data.map((r) => r[i]).filter((v) => !isEmpty(v))));
  const saved = matchRoles(headers, roles);
  const suggested = headers.map((h, i) => {
    if (!hidden.has(i)) return suggest(h, columns[i], untitled[i]);
    const w = was.get(i);
    if (!w) return { role: 'identifying', reason: 'hidden', confidence: HIGH };
    return { role: w.role, confidence: w.confidence, ...(w.reason ? { reason: w.reason } : {}), ...(w.role === 'score' ? { low: w.low, high: w.high, scaleFrom: w.scaleFrom } : {}) };
  });
  const titles = new Map();
  for (const h of headers) titles.set(h, (titles.get(h) ?? 0) + 1);

  // When each answer came in: the column the user named, or the one found.
  let tsCol = saved.findIndex((r) => r?.role === 'timestamp');
  const found = findTimestamp(headers, columns, zone, (k) => !hidden.has(k) && (!saved[k] || saved[k].role === 'timestamp') && suggested[k].reason !== 'header');
  if (found >= 0) suggested[found] = { role: 'timestamp', confidence: HIGH };
  if (tsCol < 0 && found >= 0 && !saved[found]) tsCol = found;
  const times = data.map(() => null);
  if (tsCol >= 0 && hidden.has(tsCol)) {
    // Chosen as the timestamp after the cache dropped its answers: the dates
    // come back at the next read; until then they are waiting, not unreadable.
    out.timestampColumn = headers[tsCol];
    out.datesWaiting = true;
  } else if (tsCol >= 0) {
    out.timestampColumn = headers[tsCol];
    const dayFirst = dayFirstColumn(columns[tsCol]);
    data.forEach((r, k) => {
      const ms = dateOf(r[tsCol], { timeZone: zone, dayFirst });
      if (Number.isFinite(ms)) times[k] = ms;
      else out.unreadable.timestamps += 1;
    });
    if (!dayFirst) out.ambiguousDates = ambiguousDates(columns[tsCol]);
    const known = times.filter((t) => t != null);
    if (known.length) {
      out.newest = isoOf(known.reduce((a, b) => Math.max(a, b)));
      out.oldest = isoOf(known.reduce((a, b) => Math.min(a, b)));
    }
    const after = toMs(since);
    if (after != null && Number.isFinite(after)) out.newSince = known.filter((t) => t > after).length;
  }

  // Answers after the last read that brought something new, and those
  // before it: the flags compare the two. Only with a known cut and dates.
  const cut = toMs(since);
  const splitAt = cut != null && Number.isFinite(cut) && tsCol >= 0 && !out.datesWaiting ? cut : null;
  const splitOf = (i, low, high) => {
    if (splitAt == null) return null;
    const fresh = [];
    const earlier = [];
    data.forEach((r, k) => {
      const n = intOf(r[i]);
      if (times[k] == null || !Number.isInteger(n) || n < low || n > high) return;
      (times[k] > splitAt ? fresh : earlier).push(n);
    });
    const mark = lowMark(low, high);
    return {
      mark, newN: fresh.length, newLow: fresh.filter((n) => n <= mark).length, newMean: fresh.length ? mean(fresh) : null,
      oldN: earlier.length, oldMean: earlier.length ? mean(earlier) : null,
    };
  };

  const allComments = [];
  const scored = [];
  headers.forEach((header, i) => {
    const sug = suggested[i];
    const conf = saved[i];
    let role = conf ? conf.role : sug.role;
    if (role === 'timestamp' && i !== tsCol) role = 'ignore'; // one timestamp only
    const col = {
      index: i, header, role, confirmed: Boolean(conf), isNew: roles.length > 0 && !conf, suggested: sug, answers: columns[i].length,
      // Not sure enough to save as it stands: the user chooses.
      needsChoice: !conf && sug.confidence === LOW,
      // Checked as answers to show, but they now read as emails or phone
      // numbers: kept off the board, and flagged, until checked again.
      ...(conf && SHOWN.has(role) && sug.role === 'identifying' && sug.reason === 'answers' ? { doubt: true } : {}),
      ...(untitled[i] ? { untitled: true } : {}), ...(hidden.has(i) ? { hidden: true } : {}), ...(titles.get(header) > 1 ? { repeated: true } : {}),
    };
    if (role === 'score') {
      const scale = conf?.role === 'score' ? { low: conf.low, high: conf.high, scaleFrom: 'confirmed' }
        : sug.role === 'score' ? { low: sug.low, high: sug.high, scaleFrom: sug.scaleFrom }
          : { ...(statedScale(header) ?? guessedScale(columns[i].map(intOf).filter(onScale))), scaleFrom: statedScale(header) ? 'header' : 'answers' };
      Object.assign(col, scale);
    }
    out.columns.push(col);
    if (col.isNew) out.newColumns.push(header);
    if (role === 'identifying') out.identifying.push(header);
    else if (col.doubt) out.doubtful.push(header);
    else if (role === 'ignore') out.skipped.push({ question: header, reason: conf ? 'ignored' : (sug.reason ?? 'ignored') });
    else if (role === 'score') {
      const ok = columns[i].map(intOf).filter((n) => Number.isInteger(n) && n >= col.low && n <= col.high);
      const unreadable = columns[i].length - ok.length;
      out.unreadable.scores += unreadable;
      out.questions.push({
        question: header, index: i, n: ok.length, mean: ok.length ? mean(ok) : null,
        low: col.low, high: col.high, scaleFrom: col.scaleFrom, guessed: col.scaleFrom === 'answers', unreadable,
        ...(splitAt != null ? { split: splitOf(i, col.low, col.high) } : {}),
      });
      // Only scales the user confirmed or the question states count in the
      // headline average; a guessed scale could make 3 of 5 out of 3 of 10.
      if (col.scaleFrom === 'answers') out.scalesGuessed += 1;
      else for (const v of ok) scored.push({ v, low: col.low, high: col.high });
    } else if (role === 'number') {
      const ok = columns[i].map(numberOf).filter(Number.isFinite);
      out.unreadable.numbers += columns[i].length - ok.length;
      out.numbers.push({ question: header, index: i, n: ok.length, mean: ok.length ? mean(ok) : null, unreadable: columns[i].length - ok.length });
    } else if (role === 'choice') {
      const counts = new Map();
      for (const a of columns[i].map(text)) counts.set(a, (counts.get(a) ?? 0) + 1);
      const answers = [...counts].map(([answer, count]) => ({ answer, count })).sort((a, b) => b.count - a.count);
      out.choices.push({ question: header, n: columns[i].length, answers });
    } else if (role === 'comment') {
      data.forEach((r, k) => {
        if (!hidden.has(i) && !isEmpty(r[i])) allComments.push({ question: header, text: text(r[i]).slice(0, 1000), ms: times[k], row: k, col: i });
      });
    }
  });
  out.checked = headers.length > 0 && saved.every(Boolean);
  out.needsChoice = out.columns.filter((c) => c.needsChoice).length;
  // "Question 3": a column's place among those that are not the timestamp,
  // the name used while privacy mode hides the wording.
  let no = 0;
  const numbers = new Map();
  for (const c of out.columns) if (c.role !== 'timestamp') numbers.set(c.index, (no += 1));
  for (const c of out.columns) if (numbers.has(c.index)) c.no = numbers.get(c.index);
  for (const q of [...out.questions, ...out.numbers]) q.no = numbers.get(q.index);

  // One scale for all: a plain average. Several: each answer put on 0–10.
  if (scored.length) {
    const same = scored.every((o) => o.low === scored[0].low && o.high === scored[0].high);
    const vals = same ? scored.map((o) => o.v) : scored.map((o) => ((o.v - o.low) / (o.high - o.low)) * 10);
    out.overall = { mean: mean(vals), high: same ? scored[0].high : 10, rescaled: !same, n: vals.length };
  }

  // Newest first; with no date, later rows are newer (forms add at the end).
  allComments.sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || b.row - a.row || a.col - b.col);
  out.commentCount = allComments.length;
  out.newComments = splitAt != null ? allComments.filter((c) => c.ms != null && c.ms > splitAt).length : null;
  out.comments = allComments.slice(0, keep).map((c) => ({ question: c.question, text: c.text, at: isoOf(c.ms) }));
  return out;
}

// The unreadable answers in one sentence, or null. No headers or answers in
// it, so it is safe under "Needs attention" with privacy on.
function unreadableText(summary) {
  const { scores = 0, numbers = 0, timestamps = 0 } = summary?.unreadable ?? {};
  const total = scores + numbers + timestamps;
  if (!total) return null;
  const parts = [];
  if (scores) parts.push(`${scores} ${scores === 1 ? 'score that is' : 'scores that are'} not a whole number on its scale`);
  if (numbers) parts.push(`${numbers} ${numbers === 1 ? 'answer that is' : 'answers that are'} not a number`);
  if (timestamps) parts.push(`${timestamps} ${timestamps === 1 ? 'row' : 'rows'} without a readable date`);
  return `${total} ${total === 1 ? 'answer' : 'answers'} could not be read: ${parts.join(', ')}`;
}

// The rows with the answers of identifying columns replaced: the cache keeps
// that there was an answer (so a response is still counted), never what it
// was. The header row stays.
function redactRows(rows, indices) {
  const hide = new Set(indices);
  if (!hide.size) return rows;
  return rows.map((r, k) => (k === 0 || !Array.isArray(r) ? r : r.map((v, i) => (hide.has(i) && !isEmpty(v) ? HIDDEN : v))));
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

// ---- what to fetch, and what to keep ---------------------------------------------------
//
// The main process keeps only the timers, the files, net.fetch and the IPC;
// the decisions are here, where they are tested.

const RETRY_MS = 30 * 60_000;
// 4: ignored columns keep no answers either, and hidden columns keep what
// was suggested for them (3 kept an ignored column's answers; 2 a guess's).
const CACHE_VERSION = 4;

const sameSheet = (cache, link) => Boolean(cache && link && cache.spreadsheetId === link.spreadsheetId && (cache.gid ?? null) === (link.gid ?? null));

// settings: { enabled, sheetUrl, keyPath }. -> { fetch, wakeAt }: fetch now,
// or look again at wakeAt (null: nothing to wait for).
function planFetch({ now, settings, cache, busy = false }) {
  if (!settings?.enabled || !settings.sheetUrl || !settings.keyPath || busy) return { fetch: false, wakeAt: null };
  const { due, next, lastSlot } = nextRun(now, cache?.fetchedAt ?? null);
  const nextMs = next.getTime();
  if (!due) return { fetch: false, wakeAt: nextMs };
  const err = cache?.lastError;
  const tried = cache?.lastAttemptAt;
  if (!err || tried == null) return { fetch: true, wakeAt: null };
  if (TRANSIENT.has(err.kind)) {
    const retryAt = tried + RETRY_MS;
    return toMs(now) >= retryAt ? { fetch: true, wakeAt: null } : { fetch: false, wakeAt: Math.min(retryAt, nextMs) };
  }
  // A refusal waiting will not fix (not shared, no such sheet, a bad key):
  // once per slot, or sooner when the user changes the link or the key, or
  // presses Refresh now.
  return tried < lastSlot.getTime() ? { fetch: true, wakeAt: null } : { fetch: false, wakeAt: nextMs };
}

// A good read -> the cache to keep. Identifying columns' answers are not
// kept. "New since" counts answers after the newest one of the last read
// that brought something new, so pressing Refresh twice does not reset it.
// The columns whose answers the cache drops: every identifying one (sure,
// confirmed or only guessed), every ignored one with answers, and a checked
// one whose answers now read as emails or phones. With them, what the app
// suggested for each, so it reads the same after a restart.
const toRedact = (summary) => summary.columns
  .filter((c) => c.role === 'identifying' || c.doubt || (c.role === 'ignore' && (c.answers > 0 || c.hidden))).map((c) => c.index);
const hiddenAsIn = (summary, hide) => hide.filter((i) => summary.columns[i]).map((i) => {
  const { role, reason, confidence, low, high, scaleFrom } = summary.columns[i].suggested;
  return { index: i, role, confidence, ...(reason ? { reason } : {}), ...(role === 'score' ? { low, high, scaleFrom } : {}) };
});

function afterFetch(prev, got, { now, started, link, roles = [] }) {
  const first = summarise(got.rows, { timeZone: got.timeZone, roles });
  const hide = toRedact(first);
  const same = sameSheet(prev, link) && Array.isArray(prev.rows);
  const before = same ? prev.newest ?? null : null;
  const changed = same && first.newest !== before;
  return {
    version: CACHE_VERSION, spreadsheetId: link.spreadsheetId, gid: link.gid ?? null,
    tab: got.tab ?? null, timeZone: got.timeZone ?? null,
    rows: redactRows(got.rows, hide), redacted: hide, hiddenAs: hiddenAsIn(first, hide),
    fetchedAt: now, lastAttemptAt: started, lastError: null, newest: first.newest,
    since: changed ? before : same ? prev.since ?? null : null,
    sinceFetchedAt: changed ? prev.fetchedAt : same ? prev.sinceFetchedAt ?? null : null,
  };
}

// A failed read -> the cache to keep: the last good rows stay (they are
// still this sheet's), with the error beside them.
function afterFailure(prev, err, { now, started, link }) {
  const known = err instanceof FieldSurveyError;
  const lastError = {
    at: now, kind: known ? err.kind : 'bug',
    message: known ? err.message : 'Something went wrong while reading the sheet; see the system log.',
    ...(known && err.detail ? { detail: err.detail } : {}),
  };
  const base = sameSheet(prev, link) ? prev
    : { version: CACHE_VERSION, spreadsheetId: link?.spreadsheetId ?? null, gid: link?.gid ?? null, rows: null, redacted: [], hiddenAs: [], fetchedAt: null };
  return { ...base, lastAttemptAt: started, lastError };
}

// After the user changes the roles: a column now identifying loses its
// answers from the cache too. A column chosen otherwise stays without them
// until the next read brings them back.
function reroleCache(cache, roles) {
  if (!cache?.rows) return cache;
  const s = summarise(cache.rows, { timeZone: cache.timeZone ?? undefined, roles, redacted: cache.redacted ?? [], hiddenAs: cache.hiddenAs ?? [] });
  const hide = [...new Set([...(cache.redacted ?? []), ...toRedact(s)])].sort((a, b) => a - b);
  return { ...cache, rows: redactRows(cache.rows, hide), redacted: hide, hiddenAs: hiddenAsIn(s, hide) };
}

function summariseCache(cache, roles) {
  if (!cache?.rows) return null;
  return summarise(cache.rows, { since: cache.since ?? null, timeZone: cache.timeZone ?? undefined, roles, redacted: cache.redacted ?? [], hiddenAs: cache.hiddenAs ?? [] });
}

// The cache file as read -> { cache, problem }. A cache that is not this
// sheet's, or not in the shape written, is set aside (the caller deletes it)
// and the sheet read again; an older format is set aside without a word,
// since the next read rebuilds it the same.
function validCache(raw, link) {
  if (raw == null) return { cache: null, problem: null };
  const bad = { cache: null, problem: 'The saved field feedback could not be read; the sheet is read again.' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad;
  if (raw.version !== CACHE_VERSION) return { cache: null, problem: null };
  const num = (v) => v == null || Number.isFinite(v);
  const str = (v) => v == null || typeof v === 'string';
  const e = raw.lastError;
  const ok = (raw.rows === null || (Array.isArray(raw.rows) && raw.rows.every(Array.isArray)))
    && num(raw.fetchedAt) && num(raw.lastAttemptAt) && num(raw.sinceFetchedAt)
    && str(raw.newest) && str(raw.since) && str(raw.timeZone) && str(raw.spreadsheetId)
    && (raw.gid == null || Number.isInteger(raw.gid))
    && Array.isArray(raw.redacted) && raw.redacted.every((i) => Number.isInteger(i) && i >= 0)
    && (raw.hiddenAs == null || (Array.isArray(raw.hiddenAs) && raw.hiddenAs.every((h) => h && Number.isInteger(h.index) && h.index >= 0
      && ROLES.includes(h.role) && (h.confidence === HIGH || h.confidence === LOW) && str(h.reason)
      && (h.role !== 'score' || (Number.isInteger(h.low) && Number.isInteger(h.high) && typeof h.scaleFrom === 'string')))))
    && (e == null || (typeof e === 'object' && typeof e.kind === 'string' && typeof e.message === 'string' && num(e.at) && str(e.detail)))
    && (raw.tab == null || (typeof raw.tab === 'object' && typeof raw.tab.title === 'string'))
    && !(raw.rows && raw.fetchedAt == null);
  if (!ok) return bad;
  // No usable link: nothing to compare with, and the next read says what is
  // wrong with the link; the cache is set aside without a word of its own.
  if (!link) return { cache: null, problem: null };
  if (!sameSheet(raw, link)) return { cache: null, problem: 'The saved field feedback was for another sheet; it was set aside and this sheet is read again.' };
  return { cache: raw, problem: null };
}

// A change from Settings -> { settings, sheetChanged } or { error }. An
// empty link keeps the saved one: Save with the field left blank (as it is
// when privacy mode hides the saved link) must not wipe the link and the
// answers read. Columns are saved only all at once, against the sheet as
// last read (summary): one the user has not chosen refuses the save, so a
// guess is never stored as the user's choice.
function changeSettings(current, change, { summary = null } = {}) {
  const next = { enabled: current?.enabled === true, sheetUrl: current?.sheetUrl ?? '', keyPath: current?.keyPath ?? '', columns: current?.columns ?? [] };
  let note;
  if (change && 'enabled' in change) next.enabled = change.enabled === true;
  if (change && 'sheetUrl' in change) {
    const url = String(change.sheetUrl ?? '').trim();
    if (url) {
      let link;
      try {
        link = parseSheetLink(url);
      } catch (err) {
        return { error: err.message };
      }
      let saved = null;
      try {
        saved = next.sheetUrl ? parseSheetLink(next.sheetUrl) : null;
      } catch {
        saved = null; // a saved link that no longer reads is simply replaced
      }
      // The same sheet and tab (a sharing link of it, or one naming no tab):
      // the saved link, which names the tab, stays, and so do the columns.
      const same = saved && saved.spreadsheetId === link.spreadsheetId && (link.gid == null || link.gid === saved.gid);
      if (!same) next.sheetUrl = url;
      else if (link.gid == null && saved.gid != null) note = 'Same sheet: kept the tab you had.';
    }
  }
  if (change && 'columns' in change) {
    try {
      next.columns = checkRoles(change.columns);
    } catch (err) {
      return { error: err.message };
    }
    if (!summary?.columns?.length) return { error: 'Not saved: the sheet has not been read yet, so there are no columns to check.' };
    const { missing } = checkSubmission(summary, next.columns);
    if (missing) return { error: `Not saved: ${missing} ${missing === 1 ? 'column still needs' : 'columns still need'} a choice.` };
  }
  const sheetChanged = next.sheetUrl !== (current?.sheetUrl ?? '');
  // Another sheet is another form: its columns are checked afresh. Turned
  // off, nothing is kept, the question titles in the roles included.
  if ((sheetChanged || (current?.enabled && !next.enabled)) && !(change && 'columns' in change)) next.columns = [];
  return { settings: next, sheetChanged, ...(note ? { note } : {}) };
}

// ---- flags ------------------------------------------------------------------------------------
//
// What needs a look since the last update, from the summary: low scores,
// a falling average, new comments, and the set-up problems Needs attention
// lists too. Each flag is data (counts, means, the question's index, number
// and title); the board words it, and names the question only by its
// number while privacy mode is on.

// The highest answer that counts as low: the bottom quarter of the scale,
// rounded up (the bottom two points of 1–5, 1–7 and 0–10; three of 1–10).
function lowMark(low, high) {
  return low + Math.ceil((high - low + 1) / 4) - 1;
}

// A drop of at least a tenth of the scale, over at least three new answers.
const FALL_SHARE = 0.1;
const FALL_MIN_NEW = 3;

function fieldFlags({ summary = null, lastError = null, keyError = null } = {}) {
  const out = [];
  const s = summary && !summary.empty ? summary : null;
  // Guessed scales are left out, as they are of the average: a low mark on
  // the wrong scale would flag the wrong answers.
  for (const q of s?.questions ?? []) {
    const t = q.split;
    if (q.guessed || !t) continue;
    const who = { index: q.index, no: q.no, question: q.question, low: q.low, high: q.high };
    if (t.newLow > 0) out.push({ kind: 'low', ...who, count: t.newLow, mark: t.mark });
    if (t.newN >= FALL_MIN_NEW && t.oldN > 0 && t.oldMean - t.newMean >= FALL_SHARE * (q.high - q.low) - 1e-9) {
      out.push({ kind: 'falling', ...who, newN: t.newN, newMean: t.newMean, oldMean: t.oldMean });
    }
  }
  if (s?.newComments > 0) out.push({ kind: 'comments', count: s.newComments });
  if (s?.needsChoice > 0) out.push({ kind: 'setup', what: 'choose', count: s.needsChoice, fix: 'check' });
  if (s?.doubtful?.length) out.push({ kind: 'setup', what: 'doubt', count: s.doubtful.length, fix: 'check' });
  if (lastError) {
    const share = lastError.kind === 'share';
    out.push({ kind: 'setup', what: share ? 'share' : 'failed', fix: share || !TRANSIENT.has(lastError.kind) ? 'settings' : 'refresh' });
  }
  if (keyError && keyError !== lastError?.message) out.push({ kind: 'setup', what: 'key', fix: 'settings' });
  return out;
}

// The reply to a columns save: a checked column whose answers read as
// emails or phones stays hidden unless chosen Identifying or Ignore.
function columnsReply(summary) {
  const n = summary?.doubtful?.length ?? 0;
  if (!n) return 'Columns saved.';
  return n === 1 ? 'Kept hidden: its answers look like emails or phone numbers; choose Identifying or Ignore.'
    : `Kept hidden: ${n} columns’ answers look like emails or phone numbers; choose Identifying or Ignore for them.`;
}

// Everything that needs the user's attention, as { label, detail }: the
// label is safe on a shared screen, the detail shows only with privacy off.
function fieldProblems({ enabled, cache, summary, summaryError, keyError }) {
  if (!enabled) return [];
  const out = [];
  const add = (label, detail = '') => out.push({ label: `Field feedback: ${label}`, detail });
  const err = cache?.lastError;
  if (err) add(err.message, err.detail ?? '');
  if (keyError && keyError !== err?.message) add(keyError);
  if (summaryError) add(summaryError);
  if (summary) {
    const unread = unreadableText(summary);
    if (unread) add(unread);
    const n = summary.newColumns?.length ?? 0;
    if (n) add(`${n === 1 ? 'a new column' : `${n} new columns`} in the sheet, not checked yet (Settings → Field feedback → Check the columns)`);
    // Privacy mode keeps the step read-only, so this is the reminder.
    const unsure = summary.needsChoice ?? 0;
    if (unsure) add(`${unsure === 1 ? '1 column needs' : `${unsure} columns need`} a choice (Settings → Field feedback → Check the columns, with privacy mode off)`);
    const doubt = summary.doubtful?.length ?? 0;
    if (doubt) add(`${doubt === 1 ? '1 column you checked now looks' : `${doubt} columns you checked now look`} like emails or phone numbers; ${doubt === 1 ? 'its answers are' : 'their answers are'} hidden and not stored (Settings → Field feedback → Check the columns)`);
    if (summary.timeZoneUnknown) add(`the sheet’s time zone (${summary.timeZoneUnknown}) is not known on this computer, so its times are read in this computer’s time zone`);
    const a = summary.ambiguousDates ?? 0;
    if (a) add(`${a} typed ${a === 1 ? 'date' : 'dates'} could be day/month or month/day; ${a === 1 ? 'it was' : 'they were'} read as month/day`);
  }
  return out;
}

module.exports = {
  HOSTS, TOKEN_URL, SCOPE, ROLES, RETRY_MS, CACHE_VERSION, FieldSurveyError,
  parseSheetLink, readKey, jwtAssertion, tokenRequest, metadataUrl, valuesUrl, checkUrl, pickTab, fetchRows,
  summarise, unreadableText, checkRoles, checkSubmission, columnsReply, lowMark, fieldFlags, keyFileError, redactRows, nextRun, dateOf,
  planFetch, afterFetch, afterFailure, reroleCache, summariseCache, validCache, changeSettings, fieldProblems,
};
