'use strict';

// LINE chats' bot part: messages from the user's LINE groups that arrive by
// themselves. A personal LINE account has no API, so the user made a LINE
// Official Account bot and invited it to their groups; LINE posts each
// group event to a small Apps Script relay of theirs (docs/line-bot-relay.gs),
// which keeps it in a Google Sheet only until the app has collected it. The
// app posts the relay's secret and its cursor (the last event it has saved)
// and gets the events after it; on that call the relay forgets what the
// cursor covers. The app never sends anything to LINE.
//
// This module turns the relay's answer into messages of the shape the
// exports give (linechat.js), so what concerns the user, to-do drafts, Send
// to agent and marks work on them unchanged; keeps them in a store (pure
// functions over a plain object, written by electron/main.js to the app
// data folder); and says what needs attention. The call goes through field
// feedback's web-app transport (fieldsurvey.js callWebApp): the same one
// hop, hosts, size cap and page handling, in the relay's own words.
//
// Raw LINE ids never leave this module: a group is known by a hash of its
// id (stable across renames), a sender by a hash of theirs, a message by a
// hash of its message id, so keys and marks stay the same across restarts
// and deliveries. Only ticked groups keep messages and senders' names; a
// group not ticked keeps its name, when it was last seen and a count.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fieldSurvey = require('./fieldsurvey');
const { WINDOW_DAYS } = require('./linechat');

const COLLECT_MS = 5 * 60_000;
// After a failure only the user can mend (a wrong secret, a closed or
// deleted relay), the app asks again hourly, so a fix made on the relay's
// side is picked up, and at once on Refresh now or a new link or secret.
const WAIT_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const KEEP_MS = WINDOW_DAYS * DAY_MS;
// Calls in one collection at most (the relay sends 500 events a call); the
// rest comes at the next, which is then due at once.
const ROUNDS = 20;
// 2: the store holds the part's settings, and its file being there is the part being on.
const STORE_VERSION = 2;
const NAME_MAX = 100;
// How far ahead of this computer's clock an event may be dated.
const FUTURE_MS = 60 * 60_000;
const ID = /^[0-9a-f]{16}$/;
const RELAY_ID = /^[0-9A-Za-z-]{8,64}$/;

class LineBotError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LineBotError';
    this.kind = kind;
    if (detail) this.detail = detail;
  }
}
const fail = (kind, message, code) => Object.assign(new LineBotError(kind, message), { code });

// Failures that may pass by themselves: asked again at the next collection.
// Every other waits for the user (WAIT_MS).
const TRANSIENT = new Set(['network', 'busy', 'google', 'store', 'secretfile']);

// ---- words ----------------------------------------------------------------------------

const SETTINGS = 'Settings → Connections → LINE chats';
const RELAY_HELP = 'In the relay script, Deploy → Manage deployments and copy the Web app link; it ends in /exec';
const SECRET_HELP = 'Copy READER_SECRET from the relay script’s Project Settings → Script properties';
const ANYONE = 'In the relay script, Deploy → Manage deployments → Edit → Who has access → Anyone, then press Refresh now.';
const NEW_VERSION = 'deploy it again as a new version (Deploy → Manage deployments → Edit → Version: New version)';
const RELINK = `Copy the Web app link again (Deploy → Manage deployments) and paste it in ${SETTINGS}, then press Refresh now.`;
const AGAIN = 'The app tries again in 5 minutes, or press Refresh now.';

const RELAY_WORDS = {
  blocked: (host) => `A request to ${host} was refused: LINE chats talks only to your relay.`,
  shape: `The relay’s answer is not in the shape the app reads. In ${SETTINGS}, press Copy relay script, paste it over the old one in the relay’s Apps Script and ${NEW_VERSION}.`,
  noLocation: `Google passed the relay’s call on without saying where to. ${RELINK}`,
  hopUnreadable: `The relay’s answer was sent to an address that could not be read, which the app does not follow. Press Refresh now; if it happens again, ${NEW_VERSION}.`,
  hopSignIn: `Google asked for a sign-in instead of letting the relay answer. ${ANYONE}`,
  hopElsewhere: (where, echo) => `The relay’s answer was sent to ${where}, which the app does not follow: it takes the answer only from ${echo} over https.`,
  timeout: `The relay did not answer in time; check the internet connection. ${AGAIN}`,
  offline: `No network: the relay could not be reached; check the internet connection or proxy. ${AGAIN}`,
  secondRedirect: `Google redirected the relay’s answer a second time, which the app does not follow. Press Refresh now; if it happens again, ${NEW_VERSION}.`,
  tooLarge: `The relay’s answer is larger than 20 MB, more than the app reads. In ${SETTINGS}, press Copy relay script, paste it over the old one and ${NEW_VERSION}.`,
  busy: `Google asked the app to slow down. ${AGAIN}`,
  down: `Google’s Apps Script service had a problem. ${AGAIN}`,
  denied: `Google did not let the relay answer. ${ANYONE}`,
  missing: `No relay answers at this link: its deployment may have been archived or deleted. In the relay script, Deploy → Manage deployments, copy the Web app link and paste it in ${SETTINGS}.`,
  refused: `Google refused the relay’s call. ${RELINK}`,
  signInPage: `Google showed its sign-in page instead of the relay’s answer. ${ANYONE}`,
  scriptFailed: `The relay script failed instead of answering. Open it (the relay sheet’s Extensions → Apps Script), look under Executions for what went wrong, then press Copy relay script in ${SETTINGS}, paste it over the old one and ${NEW_VERSION}.`,
};
const RELAY_VOICE = { Error: LineBotError, words: RELAY_WORDS };
const wrongShape = (code) => fail('reader', RELAY_WORDS.shape, code);

// A message as Settings shows it, beside the controls: where the board says
// "in Settings → Connections → LINE chats", Settings names the control in
// view there. shown: { secretOpen, linkOpen, noStorage }, as in field
// feedback (fieldsurvey.js inSettings).
const NO_STORE_YET = 'once this computer can keep it (see the note under Collect from my LINE bot)';
const secretWords = (v, open, folded, none) => (v.noStorage ? none : v.secretOpen ? open : folded);
const IN_SETTINGS = [
  [`In ${SETTINGS}, press Copy relay script,`, () => 'Press Copy relay script,'],
  [`press Copy relay script in ${SETTINGS},`, () => 'press Copy relay script,'],
  [` and paste it in ${SETTINGS}`, (v) => (v.linkOpen ? ' and paste it under Relay link' : ', press Change link and paste it')],
  [`then save it in ${SETTINGS}`, (v) => secretWords(v, 'then save it under Secret', 'then press Replace secret and save the new one', `then save it ${NO_STORE_YET}`)],
  [`Save the secret again in ${SETTINGS}`, (v) => secretWords(v, 'Save the secret again under Secret', 'Press Replace secret and save it again', `Save the secret again ${NO_STORE_YET}`)],
  [`Save this relay’s secret in ${SETTINGS}`, (v) => secretWords(v, 'Save this relay’s secret under Secret', 'Press Replace secret and save this relay’s secret', `Save this relay’s secret ${NO_STORE_YET}`)],
  [`Save it in ${SETTINGS}`, (v) => secretWords(v, 'Save it under Secret', 'Press Replace secret and save it', `Save it ${NO_STORE_YET}`)],
  // Whatever else names the path names a control in view already ("under Relay link").
  [` in ${SETTINGS}`, () => ''],
];
function inSettings(message, { secretOpen = true, linkOpen = true, noStorage = false } = {}) {
  const shown = { secretOpen: secretOpen && !noStorage, linkOpen, noStorage };
  let m = message == null ? '' : String(message);
  for (const [board, here] of IN_SETTINGS) m = m.split(board).join(here(shown));
  return m;
}
// Every way Settings can draw a message, keyed as field feedback's are:
// the Secret field open ('1'), folded ('0') or not drawn ('n'), then the
// link field open ('1') or folded ('0'). null for no message.
function settingsWords(message) {
  if (message == null) return null;
  const out = {};
  for (const s of ['0', '1', 'n']) {
    for (const l of ['0', '1']) out[`${s}${l}`] = inSettings(message, { secretOpen: s === '1', noStorage: s === 'n', linkOpen: l === '1' });
  }
  return out;
}

// ---- the link and the secret ----------------------------------------------------------

// The relay's web app link -> { deploymentId, url } (rebuilt from its id
// alone). Throws RangeError with what to do.
const parseRelayLink = (text) => fieldSurvey.parseWebAppLink(text, { noun: 'relay', script: 'relay script', help: RELAY_HELP });

// Whether the secret can be kept here: null, or why not. Never as plain text.
function secretStorage({ available = false, backend } = {}) {
  if (fieldSurvey.canProtect({ available, backend })) return null;
  return 'This computer has no protected storage for the relay’s secret (on Linux, a keyring such as GNOME Keyring or KWallet), and the app never keeps it as plain text. Set up a keyring, then restart Agent’s Home.';
}

// The secret as typed, checked before it is saved -> { secret, deploymentId }
// or { error }. It belongs to the saved relay link (link), so that comes
// first. No message repeats what was typed.
function checkSecret(text, { available = false, backend, saved = false, link } = {}) {
  const storage = secretStorage({ available, backend });
  if (storage) return { error: `Not saved: ${storage.charAt(0).toLowerCase()}${storage.slice(1)}` };
  let parsed;
  try {
    parsed = parseRelayLink(link);
  } catch {
    return { error: 'Save the relay link first: the secret belongs to that relay.' };
  }
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { error: saved ? 'Paste the new secret, or press Cancel to keep the saved one.' : `No secret yet. ${SECRET_HELP}.` };
  if (!/^[\x21-\x7e]{32,512}$/.test(s)) return { error: `That is not the relay’s secret: it is 32 characters or more, with no spaces. ${SECRET_HELP}.` };
  return { secret: s, deploymentId: parsed.deploymentId };
}

// The secret's file is field feedback's kind (fieldsurvey.sealSecret): the
// sealed secret with the relay deployment it belongs to.
// LINE's adds an id of its own: a store that has not used this secret
// forgets its relay id before the secret goes out (BotKeeper.collect).
const sealSecret = (deploymentId, sealed) => `${JSON.stringify({ ...JSON.parse(fieldSurvey.sealSecret(deploymentId, sealed)), id: crypto.randomUUID() })}\n`;
const secretFor = (text) => fieldSurvey.secretRecord(text)?.deploymentId ?? null;
const secretIdOf = (text) => {
  const id = fieldSurvey.secretRecord(text)?.id;
  return typeof id === 'string' && id ? id : null;
};
// -> the sealed secret for this relay. Throws LineBotError.
function openSecret(text, deploymentId) {
  const r = fieldSurvey.secretRecord(text);
  if (!r) throw fail('secret', `The saved secret could not be read. Save the secret again in ${SETTINGS}.`, 'secret file not readable');
  if (r.deploymentId !== deploymentId) throw fail('setup', `The saved secret was for another relay link. Save this relay’s secret in ${SETTINGS}.`, 'secret for another relay');
  return Buffer.from(r.sealed, 'base64');
}
function secretFileError(err) {
  if (err?.code === 'ENOENT') return fail('setup', `No relay secret is saved. Save it in ${SETTINGS}.`, 'secret file missing');
  if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    return fail('secret', `This computer will not let the app open the saved secret’s file. Save the secret again in ${SETTINGS}.`, `secret file ${err.code}`);
  }
  return fail('secretfile', `The saved secret could not be read just now. ${AGAIN}`, `secret file ${err?.code || 'unreadable'}`);
}
const secretLocked = () => fail('secret', `The saved secret cannot be unlocked on this computer any more (its sign-in or keyring changed). Save the secret again in ${SETTINGS}.`, 'secret not decrypted');

// ---- the relay's answer ----------------------------------------------------------------

// The relay's counters, all cumulative. lost came with the relay's second
// version; an answer without it (the first version) counts as 0.
const COUNTERS = ['missed', 'refused', 'denied', 'notJson', 'lost', 'capped', 'unchecked'];
// Counters an older relay does not send: read as 0.
const LATER = new Set(['denied', 'lost', 'capped', 'unchecked']);
// The relay version this app ships (docs/line-bot-relay.gs); an older one is said once.
const RELAY_VERSION = 3;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isSeq = (n) => Number.isSafeInteger(n) && n > 0;

// The relay's JSON -> { relay, events, more, counts } or { ahead: true,
// relay } (its count is behind the cursor). events: [{ seq, event } |
// { seq, broken: true }], in order. Throws LineBotError: a refused secret,
// a busy relay (it passes), or an answer not in the relay's shape (nothing
// is taken from it, and the cursor stays).
function relayReply(body) {
  if (body.ok === false) {
    if (body.error === 'not allowed') {
      throw fail('secret', `The relay refused the secret: it does not match the relay’s. ${SECRET_HELP}, then save it in ${SETTINGS}.`, 'not allowed');
    }
    if (body.error === 'busy') throw fail('busy', `The relay was busy keeping new messages. ${AGAIN}`, 'relay busy');
    if (body.error === 'settings') throw fail('google', `The relay could not read its Script properties; see its Executions in Apps Script. ${AGAIN}`, 'relay settings');
    if (body.error === 'not counted') {
      throw fail('google', `The relay could not record the events it deleted after ${WINDOW_DAYS} days just now, so it held back newer ones (nothing is lost); if it keeps happening, the relay’s Executions in Apps Script show why. ${AGAIN}`, 'relay not counted');
    }
    if (body.error === 'cursor ahead') {
      if (typeof body.relay !== 'string' || !RELAY_ID.test(body.relay)) throw wrongShape('cursor ahead without relay');
      return { ahead: true, relay: body.relay };
    }
    throw fail('reader', `The relay said no for a reason the app does not know. In ${SETTINGS}, press Copy relay script, paste it over the old one and ${NEW_VERSION}.`,
      `error ${String(body.error).replace(/\bhttps?:\/\/\S+/gi, '<address>').replace(/[^\w <>.-]/g, '').slice(0, 60)}`);
  }
  if (body.ok !== true) throw wrongShape('no ok');
  if (typeof body.relay !== 'string' || !RELAY_ID.test(body.relay)) throw wrongShape('no relay');
  if (!Array.isArray(body.events)) throw wrongShape('no events');
  if (typeof body.more !== 'boolean') throw wrongShape('no more');
  if (!COUNTERS.every((k) => isCount(body[k]) || (LATER.has(k) && body[k] === undefined))) throw wrongShape('no counts');
  if (body.version !== undefined && !isCount(body.version)) throw wrongShape('version');
  const events = [];
  let last = 0;
  for (const e of body.events) {
    // Without a sequence number in order the cursor cannot move past it.
    if (!e || typeof e !== 'object' || !isSeq(e.seq) || e.seq <= last) throw wrongShape('events out of order');
    last = e.seq;
    if (e.broken === true || !e.event || typeof e.event !== 'object' || Array.isArray(e.event)) events.push({ seq: e.seq, broken: true });
    else events.push({ seq: e.seq, event: e.event });
  }
  return { relay: body.relay, events, more: body.more, counts: Object.fromEntries(COUNTERS.map((k) => [k, body[k] ?? 0])), version: body.version ?? 0 };
}

// ---- events -> messages --------------------------------------------------------------

const hash = (...parts) => crypto.createHash('sha1').update(['line-bot', ...parts].join('\u0000')).digest('hex').slice(0, 16);
const pad = (n) => String(n).padStart(2, '0');
// The exports' 'YYYY-MM-DD HH:MM', in this computer's time (LINE's are local).
function wall(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const nameOf = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NAME_MAX) : null);
// LINE's message types -> the exports' kinds; a type with none of its own
// keeps its own name (audio, location) or 'other', and no text. Looked up
// as the table's own names only ("constructor" is a type like any other).
const KINDS = { text: 'text', image: 'photo', video: 'video', file: 'file', sticker: 'sticker', audio: 'audio', location: 'location' };
const kindOf = (type) => (typeof type === 'string' && Object.hasOwn(KINDS, type) ? KINDS[type] : 'other');
const PROBLEM = /^[A-Za-z0-9 ]{1,40}$/;
// An unsend is about one message in one group: its mark names both.
const unsentKey = (groupId, messageHash) => hash('unsent', groupId, messageHash);

// One relay event -> { group: { id, kind, name }, ms, names: { who: name },
// nameProblem, records, unsend } or { unusable: why }. A record: { hash,
// ms, kind, text, who } (who: the sender's hash, '' when LINE gave none),
// with actorWho or actorBot for who joined or left. unsend: the unsent
// message's hash.
function readEvent(ev) {
  const src = ev.source;
  const raw = src?.type === 'group' ? src.groupId : src?.type === 'room' ? src.roomId : null;
  if (typeof raw !== 'string' || !raw) return { unusable: 'no group' };
  if (!Number.isSafeInteger(ev.timestamp) || ev.timestamp <= 0) return { unusable: 'no time' };
  const id = hash('chat', src.type, raw);
  const ms = ev.timestamp;
  const who = typeof src.userId === 'string' && src.userId ? hash('member', id, src.userId) : '';
  const names = {};
  const sender = nameOf(ev._senderName);
  if (who && sender) names[who] = sender;
  const problem = typeof ev._nameProblem === 'string' && ev._nameProblem ? (PROBLEM.test(ev._nameProblem) ? ev._nameProblem : 'other') : null;
  const base = { group: { id, kind: src.type, name: nameOf(ev._groupName) }, ms, names, nameProblem: problem, records: [] };
  const eventKey = typeof ev.webhookEventId === 'string' && ev.webhookEventId ? ev.webhookEventId : `${ev.type}|${ms}|${id}`;
  if (ev.type === 'message') {
    const m = ev.message;
    if (!m || typeof m.id !== 'string' || !m.id) return { unusable: 'no message id' };
    const kind = kindOf(m.type);
    if (kind === 'text' && (typeof m.text !== 'string' || !m.text.trim())) return { unusable: 'no text' };
    return { ...base, records: [{ hash: hash('message', m.id), ms, kind, text: kind === 'text' ? m.text : '', who }] };
  }
  if (ev.type === 'unsend') {
    const mid = ev.unsend?.messageId;
    if (typeof mid !== 'string' || !mid) return { unusable: 'no message id' };
    return { ...base, unsend: hash('message', mid) };
  }
  if (ev.type === 'memberJoined' || ev.type === 'memberLeft') {
    const list = (ev.type === 'memberJoined' ? ev.joined : ev.left)?.members;
    if (!Array.isArray(list) || !list.length) return { unusable: 'no members' };
    const kind = ev.type === 'memberJoined' ? 'joined' : 'left';
    return {
      ...base,
      records: list.map((mem, i) => ({
        hash: hash('event', eventKey, i), ms, kind, text: '', who: '', actorWho: typeof mem?.userId === 'string' && mem.userId ? hash('member', id, mem.userId) : '',
      })),
    };
  }
  if (ev.type === 'join' || ev.type === 'leave') {
    return { ...base, records: [{ hash: hash('event', eventKey), ms, kind: ev.type === 'join' ? 'joined' : 'left', text: '', who: '', actorBot: true }] };
  }
  // Another event type from a group (a postback, a beacon): it holds no
  // message, so it only tells that the group is there.
  return base;
}

// ---- the store ------------------------------------------------------------------------
//
// { version, settings: { read: the ticked groups, link: the relay link }
// (the user's), link: the relay deployment the cursor was last used at,
// relay: the id of the relay the cursor belongs to (null until one
// answers), cursor: the last event saved, secretId: the saved secret's id
// it was saved with, counts: { relay, link, missed, refused, ... }
// the relay's counters as last seen (kept through a new secret or link: only
// another relay id starts them afresh), groups: { id: { kind, name,
// namedMs, lastMs, count, members? } }, messages: [{ chat: id, hash, ms,
// kind, text, who, actorWho?, actorBot? }] (ticked groups only), seen:
// { hash: ms } (every event taken in, so one delivered again is taken
// once), unsent: { unsentKey: ms }, notes: [{ what, n, at }] (what went
// wrong, for Needs attention), nameProblem: { code, ms }, namedMs }.
// count: the messages and events delivered for the group.

function emptyStore() {
  return {
    version: STORE_VERSION, settings: { read: [], link: '' }, link: null, relay: null, cursor: 0, secretId: null, counts: null, baselines: {}, groups: {}, messages: [], seen: {},
    unsent: {}, notes: [], nameProblem: null, namedMs: 0, relayVersion: null, ownRefused: null,
  };
}
const NOTES = [...COUNTERS, 'broken', 'unusable', 'future', 'ahead', 'restarted'];
// The relays whose counts are remembered (the last answer of each), newest kept.
const BASELINES = 8;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const STRINGS = ['kind', 'text', 'who'];
// A store read from its file -> { store, invalid, damaged, version }. One
// the app cannot read at all is invalid (the part is stuck and says so);
// entries it cannot read in a store it can are left out and counted
// (damaged), never dropped unsaid. A version 1 store (67909b5's, before it
// held the settings) has none, and a version 2 one whose settings cannot be
// read is counted damaged: settings null, for load() to rebuild.
function readStore(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { store: emptyStore(), invalid: true, damaged: 0 };
  }
  if (!obj(raw) || ![1, STORE_VERSION].includes(raw.version) || !isCount(raw.cursor)) return { store: emptyStore(), invalid: true, damaged: 0 };
  let damaged = 0;
  const keepIf = (ok) => {
    if (!ok) damaged += 1;
    return ok;
  };
  const groups = {};
  for (const [id, g] of Object.entries(obj(raw.groups) ?? {})) {
    if (!keepIf(ID.test(id) && obj(g) && (g.kind === 'group' || g.kind === 'room'))) continue;
    // A count or a time it cannot read: the group is kept, the value starts afresh, and it is counted.
    keepIf(g.count === undefined || isCount(g.count));
    keepIf(['lastMs', 'namedMs'].every((k) => g[k] === undefined || Number.isFinite(g[k])));
    const members = {};
    for (const [w, n] of Object.entries(obj(g.members) ?? {})) if (keepIf(ID.test(w) && nameOf(n))) members[w] = nameOf(n);
    groups[id] = {
      kind: g.kind, name: nameOf(g.name), namedMs: Number(g.namedMs) || 0, lastMs: Number(g.lastMs) || 0, count: isCount(g.count) ? g.count : 0, ...(obj(g.members) ? { members } : {}),
    };
  }
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).filter((m) => keepIf(obj(m) && Object.hasOwn(groups, m.chat) && ID.test(m.hash) && Number.isFinite(m.ms)
    && STRINGS.every((k) => typeof m[k] === 'string')));
  const stamps = (v) => Object.fromEntries(Object.entries(obj(v) ?? {}).filter(([k, ms]) => keepIf(ID.test(k) && Number.isFinite(ms))));
  const c = obj(raw.counts);
  const counted = (b) => COUNTERS.every((k) => isCount(b[k]) || (LATER.has(k) && b[k] === undefined));
  const counters = (b) => Object.fromEntries(COUNTERS.map((k) => [k, b[k] ?? 0]));
  const counts = c && typeof c.relay === 'string' && RELAY_ID.test(c.relay) && counted(c)
    ? { relay: c.relay, link: typeof c.link === 'string' ? c.link : null, ...counters(c) } : null;
  if (raw.counts != null && !counts) damaged += 1;
  const baselines = Object.fromEntries(Object.entries(obj(raw.baselines) ?? {}).filter(([id, b]) => keepIf(RELAY_ID.test(id) && obj(b) && counted(b) && Number.isFinite(b.at)))
    .map(([id, b]) => [id, { ...counters(b), at: b.at }]));
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter((n) => keepIf(obj(n) && NOTES.includes(n.what) && isCount(n.n) && Number.isFinite(n.at)));
  const np = obj(raw.nameProblem);
  const st = obj(raw.settings);
  let settings = null;
  if (raw.version === STORE_VERSION) {
    if (st && Array.isArray(st.read) && typeof st.link === 'string') {
      settings = settingsOf(st);
      // A tick that is not a group id names no group kept here: left out, and counted.
      damaged += new Set(st.read).size - settings.read.length;
    } else damaged += 1;
  }
  return {
    store: {
      version: STORE_VERSION,
      link: typeof raw.link === 'string' ? raw.link : null,
      relay: typeof raw.relay === 'string' && RELAY_ID.test(raw.relay) ? raw.relay : null,
      cursor: raw.cursor, counts, baselines, groups, messages, seen: stamps(raw.seen), unsent: stamps(raw.unsent), notes,
      nameProblem: np && typeof np.code === 'string' && PROBLEM.test(np.code) && Number.isFinite(np.ms) ? { code: np.code, ms: np.ms } : null,
      namedMs: Number(raw.namedMs) || 0,
      settings,
      secretId: typeof raw.secretId === 'string' && raw.secretId ? raw.secretId : null,
      relayVersion: isCount(raw.relayVersion) ? raw.relayVersion : null,
      ownRefused: obj(raw.ownRefused) && typeof raw.ownRefused.link === 'string' && isCount(raw.ownRefused.n) ? { link: raw.ownRefused.link, n: raw.ownRefused.n } : null,
    },
    invalid: false,
    damaged,
    version: raw.version,
  };
}

// The cursor to send: the saved one only for the link and the secret it
// was last used with, and a relay the app has heard from; else 0, which
// removes nothing (a new secret or link may be a relay set up afresh).
const cursorFor = (store, deploymentId, secretId = null) => (store.relay && store.link === deploymentId && store.secretId === secretId ? store.cursor : 0);
// What the app has saved, said beside a cursor of 0: a relay (version 3)
// whose own id it is takes it as the cursor, so what the app saved is
// neither sent again nor counted as missed; any other ignores it.
const claimFor = (store) => (store.relay ? { relay: store.relay, saved: store.cursor } : {});

// Unticking drops a group's kept messages and senders' names; its name,
// last-seen time and count stay.
function applyTicks(store, ticked) {
  const groups = {};
  let changed = false;
  for (const [id, g] of Object.entries(store.groups)) {
    if (!ticked.has(id) && g.members) {
      const { members, ...rest } = g;
      groups[id] = rest;
      changed = true;
    } else groups[id] = g;
  }
  const messages = store.messages.filter((m) => ticked.has(m.chat));
  if (messages.length !== store.messages.length) changed = true;
  return changed ? { ...store, groups, messages } : store;
}

function prune(store, now) {
  const cut = now - KEEP_MS;
  const keep = (map) => Object.fromEntries(Object.entries(map).filter(([, ms]) => ms >= cut - DAY_MS));
  return {
    ...store,
    messages: store.messages.filter((m) => m.ms >= cut),
    seen: keep(store.seen),
    unsent: keep(store.unsent),
    notes: store.notes.filter((n) => n.at >= cut),
  };
}

// One answer of the relay taken into the store -> { store, changed, again }.
// link: the deployment id asked; upTo: the cursor sent; secretId: the
// secret's id. The groups ticked are the store's own (settings.read), as
// they are now. The cursor moves to the last event of the answer; the
// caller saves the store before it asks again, since that ask lets the
// relay forget them. again: ask again now (more events wait, or the count
// was reset).
function takeReply(store, reply, { link, upTo = 0, secretId = null, now }) {
  const ticked = new Set(store.settings?.read ?? []);
  const next = {
    ...store, groups: Object.fromEntries(Object.entries(store.groups).map(([id, g]) => [id, { ...g, ...(g.members ? { members: { ...g.members } } : {}) }])),
    messages: [...store.messages], seen: { ...store.seen }, unsent: { ...store.unsent }, notes: [...store.notes],
  };
  const marks = (s) => JSON.stringify([s.link, s.relay, s.cursor, s.secretId, s.counts, s.baselines, s.relayVersion, s.ownRefused]);
  const before = marks(store);
  let noted = false;
  const note = (what, n = 1) => {
    if (n <= 0) return;
    next.notes.push({ what, n, at: now });
    noted = true;
  };
  // The link and the secret the cursor is now used with (cursorFor).
  Object.assign(next, { link, secretId });
  if (reply.ahead) {
    // The relay holds fewer events than the cursor says (it was reset or
    // replaced): start at 0. Asking with 0 removes nothing on the relay,
    // and what comes again is taken once (seen).
    note('ahead');
    Object.assign(next, { relay: reply.relay, cursor: 0 });
    return { store: prune(next, now), changed: true, again: true };
  }
  // The relay the cursor belongs to answered (after a new secret or link,
  // say): the cursor saved stands, whatever was sent.
  const last0 = next.relay === reply.relay ? Math.max(upTo, next.cursor) : upTo;
  // Another relay at the link it last answered at: its events are numbered
  // afresh, and the cursor sent may have removed some of them before they came.
  if (next.counts && next.counts.relay !== reply.relay && next.counts.link === link) note('restarted');
  next.relay = reply.relay;
  // The relay's counters only grow: a rise since its last answer is what
  // happened in between, said whatever the app did meanwhile, and after
  // answers from other relays too (each relay id keeps its own). A relay
  // never heard from: its counts are where it starts.
  const base = next.baselines?.[reply.relay] ?? (next.counts?.relay === reply.relay ? next.counts : null);
  // The app's own calls refused since its last answer raised the wrong-secret count: not someone else's.
  // Only the app's own calls at this link: another relay's count is its own.
  const own = next.ownRefused?.link === link ? next.ownRefused.n : 0;
  if (base) for (const k of COUNTERS) note(k, reply.counts[k] - (base[k] ?? 0) - (k === 'denied' ? own : 0));
  next.ownRefused = null;
  next.relayVersion = reply.version ?? 0;
  next.counts = { relay: reply.relay, link, ...reply.counts };
  const known = Object.entries({ ...(next.baselines ?? {}), [reply.relay]: { ...reply.counts, at: now } }).sort((a, b) => b[1].at - a[1].at).slice(0, BASELINES);
  next.baselines = Object.fromEntries(known);
  let broken = 0;
  let unusable = 0;
  let future = 0;
  let last = last0;
  for (const e of reply.events) {
    last = Math.max(last, e.seq);
    if (e.broken) {
      broken += 1;
      continue;
    }
    const r = readEvent(e.event);
    if (r.unusable) {
      unusable += 1;
      continue;
    }
    // LINE dates its events itself: one from the future is not LINE's, or
    // this computer's clock is behind. Left out, so it cannot sit on top.
    if (r.ms > now + FUTURE_MS) {
      future += 1;
      continue;
    }
    const keep = ticked.has(r.group.id);
    const g = next.groups[r.group.id] ?? { kind: r.group.kind, name: null, namedMs: 0, lastMs: 0, count: 0 };
    next.groups[r.group.id] = g;
    if (r.group.name && r.ms >= g.namedMs) Object.assign(g, { name: r.group.name, namedMs: r.ms });
    g.lastMs = Math.max(g.lastMs, r.ms);
    if (keep) g.members = { ...(g.members ?? {}), ...r.names };
    // Any name the relay sent counts as names being on, even beside a lookup that failed.
    if (r.group.name || Object.keys(r.names).length) next.namedMs = Math.max(next.namedMs, r.ms);
    if (r.nameProblem) {
      if (r.ms >= (next.nameProblem?.ms ?? 0)) next.nameProblem = { code: r.nameProblem, ms: r.ms };
    } else if ((r.group.name || Object.keys(r.names).length) && next.nameProblem && r.ms > next.nameProblem.ms) next.nameProblem = null;
    if (r.unsend) {
      const key = unsentKey(r.group.id, r.unsend);
      next.unsent[key] = next.unsent[key] ?? r.ms;
      next.messages = next.messages.filter((m) => !(m.chat === r.group.id && m.hash === r.unsend));
      continue;
    }
    for (const rec of r.records) {
      // Delivered before, or unsent before it came.
      if (next.seen[rec.hash] != null || next.unsent[unsentKey(r.group.id, rec.hash)] != null) continue;
      next.seen[rec.hash] = rec.ms;
      g.count += 1;
      if (keep) next.messages.push({ chat: r.group.id, ...rec });
    }
  }
  note('broken', broken);
  note('unusable', unusable);
  note('future', future);
  next.cursor = last;
  next.messages.sort((a, b) => a.ms - b.ms);
  const pruned = prune(applyTicks(next, ticked), now);
  // Text past KEEP_MS (or of a group unticked meanwhile) leaves the disk too, even from a quiet relay.
  const dropped = pruned.messages.length !== next.messages.length || pruned.notes.length !== next.notes.length
    || Object.keys(pruned.seen).length !== Object.keys(next.seen).length || Object.keys(pruned.unsent).length !== Object.keys(next.unsent).length;
  const changed = reply.events.length > 0 || noted || dropped || before !== marks(pruned);
  return { store: pruned, changed, again: reply.more };
}

// ---- one collection --------------------------------------------------------------------

// The error's log code without the secret or the link in it.
function scrub(err, secret, link) {
  if (err instanceof LineBotError && typeof err.code === 'string') {
    let code = err.code;
    for (const s of [secret, link?.url, link?.deploymentId]) if (s) code = code.split(s).join('<hidden>');
    err.code = code;
  }
  return err;
}
const storeError = (err) => fail('store', `The messages collected could not be saved. ${AGAIN} If it keeps failing, the system log has the reason.`, `store ${err?.code || 'error'}`);

// Asks the relay for what follows the cursor until it has no more (at most
// ROUNDS calls), saving the store (write) after each answer and before the
// next call lets the relay forget it. Each answer is merged into the store
// as it is when the answer comes (current(): the ticks and link of then;
// null when the part was turned off or its link changed meanwhile, which
// stops it: stale), never into the copy the call was made from. A write
// that fails leaves the store and the cursor as they were: the next
// collection gets the same events again. send: the transport's (Electron's
// net.request in the app); now() the clock. -> { store (as last written),
// more?, error?, stale? }. A bug throws.
async function collect({ store, current = null, link, secret, secretId = null, send, write, now = () => Date.now() }) {
  let saved = store;
  const at = current ?? (() => saved);
  let resets = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const asked = at();
    if (!asked) return { store: saved, stale: true };
    const upTo = cursorFor(asked, link.deploymentId, secretId);
    let reply;
    try {
      const body = await fieldSurvey.callWebApp({ request: fieldSurvey.webAppRequest(link, { secret, upTo, ...(upTo ? {} : claimFor(asked)) }), send, voice: RELAY_VOICE });
      reply = relayReply(body);
    } catch (err) {
      if (!(err instanceof LineBotError)) throw err;
      return { store: saved, error: scrub(err, secret, link) };
    }
    if (reply.ahead) {
      resets += 1;
      // Asked with 0 the relay cannot be ahead; if it says so, it is not the relay's answer.
      if (resets > 1) return { store: saved, error: wrongShape('cursor ahead of 0') };
    }
    const base = at();
    if (!base) return { store: saved, stale: true };
    const step = takeReply(base, reply, { link: link.deploymentId, upTo, secretId, now: now() });
    if (step.changed) {
      try {
        write(step.store);
      } catch (err) {
        return { store: base, error: storeError(err) };
      }
    }
    saved = step.store;
    if (!step.again) return { store: saved };
  }
  return { store: saved, more: true };
}

// When to collect next (ms), or null when the bot part cannot: on, a link
// and a secret saved. A failure only the user can mend waits WAIT_MS; a
// collection cut at ROUNDS goes on at once.
function nextCollect({ ready, lastTryAt = null, error = null, more = false }) {
  if (!ready) return null;
  if (lastTryAt == null || more) return lastTryAt ?? 0;
  return lastTryAt + (error && !TRANSIENT.has(error.kind) ? WAIT_MS : COLLECT_MS);
}

// Why Collect from my LINE bot, on, cannot collect: words with the next
// step, or null when it can. stuck: the store's state when it is stuck
// (BotKeeper.state), or false.
const STUCK_WHY = {
  unreadable: 'the bot’s saved data can’t be read just now; close any app using the app’s data folder. The app reads it again within a minute',
  invalid: 'the bot’s saved data is not in a shape the app reads. To start afresh, turn Collect from my LINE bot off and on again; that deletes its saved messages, relay link and secret',
  unwritten: 'the bot’s saved data was read but could not be brought up to this version of the app; close any app using the app’s data folder. The app tries again within a minute',
  unremoved: 'it was turned off, but its saved data could not be removed; close any app using the app’s data folder. The app tries again within a minute',
};
function notCollecting({ on, stuck = false, link, secretSaved, storage }) {
  if (!on) return null;
  if (stuck) return STUCK_WHY[stuck] ?? STUCK_WHY.unreadable;
  if (storage) return 'this computer can’t keep the relay’s secret; set up a keyring (on Linux, GNOME Keyring or KWallet), then restart Agent’s Home';
  if (!link) return `no relay link is saved; paste the relay’s Web app link under Relay link in ${SETTINGS}`;
  if (!secretSaved) return `no secret is saved; paste READER_SECRET under Secret in ${SETTINGS}`;
  return null;
}

// ---- settings ------------------------------------------------------------------------

// { read: ticked group ids, link: the relay link rebuilt }, as the store
// keeps them; a value of the wrong kind is dropped.
function settingsOf(s) {
  return {
    read: [...new Set((Array.isArray(s?.read) ? s.read : []).filter((x) => typeof x === 'string' && ID.test(x)))],
    link: typeof s?.link === 'string' ? s.link : '',
  };
}

// ---- what the board and Needs attention see ----------------------------------------------

// Stand-ins: the start of each one's hash, four characters or as many more
// as it takes to tell it from the others shown with it.
function shortIds(ids) {
  const out = new Map();
  for (const id of ids) {
    let n = 4;
    while (n < id.length && ids.some((o) => o !== id && o.slice(0, n) === id.slice(0, n))) n += 1;
    out.set(id, id.slice(0, n));
  }
  return out;
}
function groupNames(store) {
  const ids = Object.keys(store.groups);
  const short = shortIds(ids.filter((id) => !store.groups[id].name));
  return new Map(ids.map((id) => {
    const g = store.groups[id];
    return [id, g.name ?? `${g.kind === 'room' ? 'Chat' : 'Group'} ${short.get(id)}`];
  }));
}
function memberNames(store, id) {
  const g = store.groups[id];
  const whos = new Set(Object.keys(g.members ?? {}));
  for (const m of store.messages) {
    if (m.chat !== id) continue;
    if (m.who) whos.add(m.who);
    if (m.actorWho) whos.add(m.actorWho);
  }
  const unnamed = [...whos].filter((w) => !g.members?.[w]);
  const short = shortIds(unnamed);
  return (who) => (!who ? 'A member' : g.members?.[who] ?? `Member ${short.get(who) ?? who.slice(0, 4)}`);
}

// The ticked groups as chats for the pipeline, in mergeChats' shape: each
// message as the exports give it, with chatKey (the group, not its name)
// naming its items so a rename keeps their marks.
function botChats(store, ticked = new Set(store.settings?.read ?? [])) {
  const names = groupNames(store);
  const out = [];
  for (const id of Object.keys(store.groups)) {
    if (!ticked.has(id)) continue;
    const chat = names.get(id);
    const chatKey = `bot:${id}`;
    const member = memberNames(store, id);
    const messages = store.messages.filter((m) => m.chat === id).map((m) => {
      const msg = { chat, chatKey, at: wall(m.ms), ms: m.ms, sender: m.who ? member(m.who) : '', kind: m.kind, text: m.text, hash: m.hash };
      if (m.kind !== 'text') msg.actor = m.actorBot ? 'Your bot' : m.actorWho ? member(m.actorWho) : msg.sender || 'A member';
      return msg;
    });
    out.push({ chat, chatKey, id, bot: true, messages, unread: 0, olderOnly: 0, newestMs: messages.length ? messages[messages.length - 1].ms : null });
  }
  return out.sort((a, b) => a.chat.localeCompare(b.chat));
}

// The groups for Settings: id, shown name (a stand-in when the relay sends
// none), whether it is ticked, and counts and times only.
function botGroups(store, ticked = new Set(store.settings?.read ?? [])) {
  const names = groupNames(store);
  return Object.entries(store.groups).map(([id, g]) => ({
    id, name: names.get(id), named: Boolean(g.name), kind: g.kind, read: ticked.has(id), lastMs: g.lastMs, count: g.count,
    ...(ticked.has(id) ? { messages: store.messages.filter((m) => m.chat === id).length } : {}),
  })).sort((a, b) => b.lastMs - a.lastMs || a.name.localeCompare(b.name));
}

// Kept text messages, in ticked groups, whose sender shows as a stand-in:
// while there are any, the user's own words cannot be told from others'.
function standInCount(store, ticked) {
  return store.messages.filter((m) => ticked.has(m.chat) && m.kind === 'text' && !store.groups[m.chat]?.members?.[m.who]).length;
}

// The bot part as the snapshot carries it to the window: never the secret
// (only whether one is saved), the link only for privacy mode to hide.
// settings: { on, link, read }; stuck: its store can't be read yet;
// error: the last collection's failure, with `at`; storage: why no secret
// can be kept here, or null; notCollecting: why it is on and not
// collecting (notCollecting()), or null.
function botView({ settings, store, stuck = false, secretSaved = false, storage = null, error = null, collectedAt = null, busy = false, nextAt = null, notCollecting: why = null }) {
  const ticked = new Set(settings.read);
  return {
    on: settings.on,
    stuck,
    link: settings.link,
    secretSaved,
    secretStorage: storage,
    groups: botGroups(store, ticked),
    collectedAt,
    busy,
    nextAt,
    error: error ? { message: error.message, kind: error.kind, at: error.at ?? null } : null,
    errorHere: settingsWords(error?.message ?? null),
    notCollecting: why,
    notCollectingHere: why ? inSettings(why) : null,
    // Whether the relay has sent any names (it does only with LINE_TOKEN),
    // or tried to (a lookup that failed): names are on either way.
    named: store.namedMs > 0,
    nameProblem: Boolean(store.nameProblem),
    standIns: standInCount(store, ticked) > 0,
    // LINE refused the relay's token: the stand-ins are that, not a missing token.
    tokenRefused: TOKEN_REFUSED.test(store.nameProblem?.code ?? ''),
    // The relay's last answer came from a version before this app's.
    relayOld: store.relayVersion != null && store.relayVersion < RELAY_VERSION,
    windowDays: WINDOW_DAYS,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const were = (n) => (n === 1 ? 'was' : 'were');
const TOKEN_REFUSED = /^HTTP 40[13]$/;
const SWITCH = 'Collect from my LINE bot';
const MISSING_WORDS = 'so your own promises there can’t be found and your own messages may show as mentions';
// The relay's name lookups failing, in one row; standIns: senders kept show as stand-ins now.
const NAME_WORDS = (code, standIns) => {
  if (TOKEN_REFUSED.test(code)) {
    return `LINE refused the relay’s LINE_TOKEN: names are off and groups and senders show as stand-ins, ${MISSING_WORDS}. To fix it, issue a new channel access token in the LINE Developers console and put it in the relay’s Script properties as LINE_TOKEN, or remove LINE_TOKEN to go without names`;
  }
  const why = code === 'HTTP 429' ? 'LINE asked the relay to slow down its name lookups'
    : code === 'HTTP 404' ? 'LINE did not find some names the relay looked up (a member who left, for one)'
      : 'the relay’s name lookups failed';
  const next = code === 'HTTP 429' ? 'they come back by themselves' : code === 'HTTP 404' ? 'nothing to do' : 'the relay’s Executions in Apps Script show why';
  return `${why}, so some senders show as stand-ins${standIns ? `, ${MISSING_WORDS}` : ''}; ${next}`;
};
// Why a file could not be written or removed, in words ('not saved' says it
// in Settings; the code goes to the detail and the system log).
const writeWhy = (code) => (['EBUSY', 'EPERM', 'EACCES'].includes(code) ? 'another program has it open'
  : code === 'ENOSPC' ? 'the disk is full' : 'the system log has the reason');
const CLOSE = 'close any app using the app’s data folder';
// A trouble with the store's files, in words (BotKeeper's problems()); on:
// whether the part is on, so the app tries again by itself.
const STORE_WORDS = {
  unreadable: () => `the bot’s saved data can’t be read just now, so nothing is collected or changed; ${CLOSE}. The app reads it again within a minute`,
  invalid: () => `the bot’s saved data is not in a shape the app reads, so nothing is collected or changed, and its messages stay in its file until you turn ${SWITCH} off. To start afresh, turn it off and on again in ${SETTINGS}; that deletes its saved messages, relay link and secret`,
  unwritten: () => `the bot’s saved data was read but could not be brought up to this version of the app, so nothing is collected or changed; ${CLOSE}. The app tries again within a minute`,
  unremoved: () => `${SWITCH} was turned off, but its saved data could not be removed, so nothing is collected; ${CLOSE}. The app tries again within a minute`,
  damaged: (sp) => `${sp.count} of the bot’s saved entries could not be read and were left out; the rest are kept`,
  rebuilt: (sp) => `${sp.why === 'damaged' ? 'the bot’s ticks and relay link could not be read' : 'after the update, the bot’s ticks and relay link from before were not found'}, so they were rebuilt from the groups it kept messages for and from the saved secret or the last collection; check them in ${SETTINGS}`,
  unlisted: (sp, on) => (on ? `the app’s data folder could not be listed, so half-written copies of the bot’s saved data may be left there; collecting goes on. The app tries again within a minute`
    : `the app’s data folder could not be listed, so half-written copies of the bot’s saved data may be left there; ${CLOSE} and delete any line-bot-store files from there`),
  leftover: (sp, on) => (on ? `a half-written copy of the bot’s saved data could not be removed; ${CLOSE}. The app tries again within a minute`
    : `a half-written copy of the bot’s saved data could not be removed; ${CLOSE} and delete it from there`),
  prune: () => `messages older than ${WINDOW_DAYS} days could not be removed from the bot’s file just now; ${CLOSE}. The app tries again every half minute`,
};
const STUCK = new Set(['unreadable', 'invalid', 'unwritten', 'unremoved']);
const AGAIN_SCRIPT = `if it keeps happening, press Copy relay script in ${SETTINGS}, paste it over the relay’s script and deploy it as a new version`;
const NEW_DEPLOYMENT = `Deploy → New deployment; put its link followed by ?k= and WEBHOOK_KEY in LINE’s webhook and under Relay link in ${SETTINGS}, then archive the old deployment`;

// What goes under Needs attention, as counts and next steps; no group or
// sender name, message or link. on: the part is on; error: the last
// collection's failure ({ message, kind }); notCollecting: why it is on and
// not collecting; storeProblems: BotKeeper's problems() ([{ what, detail,
// count }]), said whatever the switch says; ticked: the ticked groups (the
// store's own by default). fix 'line': a link to Settings. One row per cause.
function botProblems({ on, store, error = null, notCollecting: why = null, storeProblems = [], ticked = new Set(store?.settings?.read ?? []), now }) {
  const out = [];
  const add = (label, detail = '', fix = null) => out.push({ label: `LINE chats: ${label}`, detail, ...(fix ? { fix } : {}) });
  for (const sp of storeProblems) if (STORE_WORDS[sp.what]) add(STORE_WORDS[sp.what](sp, on), sp.detail ?? '', ['invalid', 'rebuilt'].includes(sp.what) ? 'line' : null);
  if (!on) return out;
  const stuck = storeProblems.some((sp) => STUCK.has(sp.what));
  // A store that can't be read says so itself, with what to do.
  const first = why && !stuck ? `your LINE bot is on but not collecting: ${why}` : error && !stuck ? `the bot’s messages could not be collected. ${error.message}` : '';
  if (first) out.unshift({ label: `LINE chats: ${first}`, detail: '', fix: 'line' });
  const sum = (what) => (store?.notes ?? []).filter((n) => n.what === what && n.at >= now - KEEP_MS).reduce((a, n) => a + n.n, 0);
  const days = `in the last ${WINDOW_DAYS} days`;
  // A full tally on the relay: these counts are floors.
  const capped = sum('capped') > 0;
  const atLeast = capped ? 'at least ' : '';
  const refused = sum('refused');
  if (refused) {
    add(`${atLeast}${plural(refused, 'call')} to the relay’s webhook ${were(refused)} refused ${days}: a wrong key in LINE’s webhook link, or someone else calling the relay. Check that the webhook link in the LINE Developers console ends in ?k= and the relay’s WEBHOOK_KEY (the relay script’s Project Settings → Script properties); if the key is right and the count keeps rising, someone else has the relay’s link: ${NEW_DEPLOYMENT}`, '', 'line');
  }
  const denied = sum('denied');
  if (denied) add(`${atLeast}${plural(denied, 'call')} to the relay had a wrong secret ${days}: someone other than this app. If it goes on, ${NEW_DEPLOYMENT}`, '', 'line');
  const unchecked = sum('unchecked');
  if (unchecked) {
    add(`${capped ? 'more than' : 'up to'} ${plural(unchecked, 'event')} that reached the relay while it could not read its WEBHOOK_KEY ${were(unchecked)} not kept (some may not be LINE’s) ${days}, so messages may be missing; the relay’s Executions in Apps Script show why`);
  }
  const missed = sum('missed');
  if (missed) add(`${plural(missed, 'event')} waited on the relay over ${WINDOW_DAYS} days and ${were(missed)} deleted before the app collected ${missed === 1 ? 'it' : 'them'} ${days}: keep ${SWITCH} on and open the app at least every ${WINDOW_DAYS} days`);
  const lost = sum('lost');
  if (lost) add(`${atLeast}${plural(lost, 'event')} from LINE could not be kept by the relay (it was busy, or its sheet failed) ${days}, so ${lost === 1 ? 'it is' : 'they are'} gone; if it keeps happening, the relay’s Executions in Apps Script show why`);
  const notJson = sum('notJson');
  if (notJson) add(`${plural(notJson, 'call')} to the relay’s webhook could not be read ${days}; if this goes on, check that only LINE has the webhook link`);
  const broken = sum('broken');
  if (broken) add(`${plural(broken, 'event')} on the relay could not be read and ${were(broken)} left out ${days}; ${AGAIN_SCRIPT}`, '', 'line');
  const unusable = sum('unusable');
  if (unusable) add(`${plural(unusable, 'event')} from the relay lacked a group, a time or a message and ${were(unusable)} left out ${days}; ${AGAIN_SCRIPT}`, '', 'line');
  const future = sum('future');
  if (future) add(`${plural(future, 'event')} from the relay ${were(future)} dated in the future and ${were(future)} left out ${days}; check this computer’s date and time`);
  if (sum('ahead')) add('the relay held fewer events than the app had collected (it was reset or replaced), so the app started counting afresh; what is still on the relay comes in again and is kept once');
  if (sum('restarted')) add('the relay at this link is a new one (its id changed), so messages the old one still held may be missing');
  if (store?.relayVersion != null && store.relayVersion < RELAY_VERSION) {
    add(`your relay is an older version; to update it, press Copy relay script in ${SETTINGS}, paste it over the relay’s script, then Deploy → Manage deployments → Edit → Version: New version → Deploy. The link stays the same`, '', 'line');
  }
  // Stand-ins: one row, the lookups' failure when there is one. The fix is
  // in the relay's Script properties, or with LINE: no Settings link.
  const standIns = Boolean(store) && standInCount(store, ticked) > 0;
  if (store?.nameProblem) add(NAME_WORDS(store.nameProblem.code, standIns));
  else if (standIns) {
    add(store.namedMs > 0
      ? `some senders in your bot’s groups show as stand-ins because LINE gave no name for them, ${MISSING_WORDS}`
      : `senders in your bot’s groups show as stand-ins, because the relay sends no names, ${MISSING_WORDS}; put the channel access token in the relay’s Script properties as LINE_TOKEN to turn names on`);
  }
  return out;
}

// ---- the store on disk --------------------------------------------------------------------
//
// BotKeeper is the one owner of the bot part's data: one file holds its
// ticks, its relay link, the cursor, the relay id, the count baselines and
// the kept messages, and that file being there is the part being on. Every
// change goes through it, one at a time, applied to the store as it is then
// (a collection's answer merged into the store of that moment, not the one
// the call was made from) and written whole (a temp file, flushed, then
// renamed) before it is taken: a change that cannot be written is not
// taken, so memory is always what is on disk, and the user is told "not
// saved" and tries again. The user's off is taken only once the file is
// gone. Only pruning (text past KEEP_MS) is tried again by itself, every
// half minute. A store that cannot be read, or is not a store, leaves the
// part on but stuck: nothing is collected, written or deleted until it
// reads, except by the user's own off. The only older files are 67909b5's:
// line-bot.json (the settings) beside a version 1 store.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What prune() would drop, or null when it drops nothing.
function pruned(store, now) {
  const next = prune(store, now);
  const fewer = next.messages.length !== store.messages.length || next.notes.length !== store.notes.length
    || Object.keys(next.seen).length !== Object.keys(store.seen).length || Object.keys(next.unsent).length !== Object.keys(store.unsent).length;
  return fewer ? next : null;
}
// The groups a store kept text or senders for: they were ticked when it was written.
const keptGroups = (store) => Object.keys(store.groups).filter((id) => store.groups[id].members || store.messages.some((m) => m.chat === id));
// The relay link rebuilt from a deployment id, or '' when it is not one.
function linkOf(deploymentId) {
  if (!deploymentId) return '';
  try {
    return fieldSurvey.webAppLink(deploymentId).url;
  } catch {
    return ''; // not a deployment id: the link is asked for in Settings, and the rebuilt row says to check it
  }
}
const UNREAD = 'The bot’s saved data can’t be read yet, so nothing was changed; see Needs attention.';
const notSaved = (err) => `Not saved: the bot’s file could not be written (${writeWhy(err?.code)}). Try again; if it keeps failing, ${CLOSE}.`;
const notOff = (err) => `Not turned off: the bot’s file could not be removed (${writeWhy(err?.code)}). Close any app using the app’s data folder and try again.`;
const PRUNE_SAY = 2; // failed prunes in a row before it is said

class BotKeeper {
  // file: the store; legacyFile: 67909b5's settings file (line-bot.json),
  // read to move its ticks and link into the store, then removed.
  constructor({ file, legacyFile = null, fsys = fs, now = () => Date.now() }) {
    this.file = file;
    this.legacyFile = legacyFile;
    this.fsys = fsys;
    this.now = now;
    this.dir = path.dirname(file);
    this.base = path.basename(file);
    this.stem = this.base.replace(/\.json$/i, '');
    this.temp = new RegExp(`^${escapeRe(this.base)}\\.[\\w-]+\\.tmp$`);
    this.state = 'off'; // 'off' (no store), 'on', or stuck: 'unreadable', 'invalid', 'unwritten', 'unremoved'
    this.store = emptyStore();
    this.legacy = undefined; // the older settings file as read: null (none), or { on, read, link } or { unreadable }
    this.epoch = 0; // turned off or on: a collection from before merges nothing
    this.pruneFails = 0;
    this.found = []; // { what, detail, count } for botProblems
  }

  get on() {
    return this.state !== 'off';
  }
  get ready() {
    return this.state === 'on';
  }
  get stuck() {
    return STUCK.has(this.state);
  }
  // The user's ticks and link; none while the store is not read.
  get settings() {
    return this.ready ? this.store.settings : emptyStore().settings;
  }
  problems() {
    return [...this.found];
  }
  note(problem) {
    this.found = [...this.found.filter((p) => p.what !== problem.what), problem];
  }
  forget(...whats) {
    this.found = this.found.filter((p) => !whats.includes(p.what));
  }

  // A whole-file write: a temp file, flushed, then renamed over the store.
  // Throws; a half-written copy that would not go is said.
  write(store) {
    const f = this.fsys;
    const tmp = path.join(this.dir, `${this.base}.${process.pid}.tmp`);
    try {
      f.mkdirSync(this.dir, { recursive: true });
      const fd = f.openSync(tmp, 'w', 0o600);
      try {
        f.writeFileSync(fd, `${JSON.stringify(store)}\n`);
        f.fsyncSync(fd);
      } finally {
        f.closeSync(fd);
      }
      f.renameSync(tmp, this.file);
    } catch (err) {
      const stuck = this.removeAll([path.basename(tmp)]);
      if (stuck.length) this.note({ what: 'leftover', detail: this.where(stuck) });
      throw err;
    }
  }
  // A change, taken only once it is on disk -> { ok } or { ok: false, error, code }.
  apply(next) {
    if (!this.ready) return { ok: false, error: UNREAD };
    try {
      this.write(next);
    } catch (err) {
      return { ok: false, error: notSaved(err), code: err.code || 'error' };
    }
    this.store = next;
    return { ok: true };
  }

  removeAll(list) {
    const stuck = [];
    for (const name of list) {
      try {
        this.fsys.rmSync(path.join(this.dir, name), { force: true });
      } catch (err) {
        stuck.push({ name, code: err.code || 'error' });
      }
    }
    return stuck;
  }
  where(stuck) {
    return stuck.map((s) => `${path.join(this.dir, s.name)} (${s.code})`).join(', ');
  }
  // Half-written copies removed (at load, every half minute while on, and
  // at off), and what would not go said. A listing that fails is said as
  // that and changes nothing else (what was found before stands); the next
  // one clears it. extra: other names to remove.
  tidy(extra = []) {
    let names;
    try {
      names = this.fsys.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.note({ what: 'unlisted', detail: `${this.dir} (${err.code || 'error'})` });
        return;
      }
      names = [];
    }
    this.forget('unlisted');
    const stuck = this.removeAll([...names.filter((n) => this.temp.test(n)), ...extra.filter((n) => names.includes(n))]);
    if (stuck.length) this.note({ what: 'leftover', detail: this.where(stuck) });
    else this.forget('leftover');
  }

  // The older settings file: null when there is none; { busy: code } when
  // it is there but can't be read just now (read again later, never taken
  // as lost); { unreadable: true } when it is not settings.
  readLegacy() {
    if (!this.legacyFile) return null;
    let text;
    try {
      text = this.fsys.readFileSync(this.legacyFile, 'utf8');
    } catch (err) {
      return err.code === 'ENOENT' ? null : { busy: err.code || 'error' };
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { unreadable: true };
    }
    return obj(raw) ? { on: raw.on === true, ...settingsOf(raw) } : { unreadable: true };
  }
  // Moved into the store, or ignored beside a store of this version: the older file goes.
  dropLegacy() {
    this.legacy = null;
    if (!this.legacyFile) return;
    try {
      this.fsys.rmSync(this.legacyFile, { force: true });
    } catch {
      // A store of this version ignores it, at every start; the user's off removes it, or is not taken.
    }
  }
  become(state, problem) {
    this.state = state;
    this.store = emptyStore();
    this.forget(...STUCK);
    if (problem) this.note(problem);
  }

  // Reads the store: at start, and every half minute while it is stuck.
  // lineOff: LINE chats is off, as read cleanly from its own settings file
  // (the user's off, which a failed removal left undone). secretFor: the
  // saved secret's relay deployment, for a link the older settings file
  // took with it. -> { drop } (the user's off taken: the caller removes the
  // secret too).
  load({ lineOff = false, secretFor = null } = {}) {
    let text = null;
    let error = null;
    try {
      text = this.fsys.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') error = err;
    }
    const read = text == null ? null : readStore(text);
    // The older file counts only beside 67909b5's store (version 1) or none.
    if (this.legacy === undefined && read?.version !== STORE_VERSION) this.legacy = this.readLegacy();
    const old = read?.version === STORE_VERSION ? null : this.legacy;
    if (lineOff || old?.on === false) return this.offAtLoad();
    if (error) {
      this.become('unreadable', { what: 'unreadable', detail: `${this.file} (${error.code || 'error'})` });
      return { drop: false };
    }
    if (read?.invalid) {
      this.become('invalid', { what: 'invalid', detail: this.file });
      return { drop: false };
    }
    if (old?.busy) {
      this.legacy = undefined; // read again next time
      this.become('unreadable', { what: 'unreadable', detail: `${this.legacyFile} (${old.busy})` });
      return { drop: false };
    }
    let store = read?.store ?? null;
    let rebuilt = null;
    if (store && !store.settings) {
      const known = read.version !== STORE_VERSION && old && !old.unreadable;
      store = { ...store, settings: known ? { read: old.read, link: old.link } : { read: keptGroups(store), link: linkOf(store.link ?? secretFor) } };
      if (!known) rebuilt = read.version === STORE_VERSION ? 'damaged' : 'update';
    } else if (!store && old?.on) store = { ...emptyStore(), settings: { read: old.read, link: old.link } };
    else if (!store && old?.unreadable && secretFor) {
      // A secret is kept only while the part is on: it was on.
      store = { ...emptyStore(), settings: { read: [], link: linkOf(secretFor) } };
      rebuilt = 'update';
    }
    if (!store) {
      this.become('off');
      this.dropLegacy();
      this.tidy();
      return { drop: false };
    }
    // 67909b5's store, a new one or settings rebuilt: written in this
    // version's shape (unticked groups' text dropped) before it is used.
    const upgrade = read?.version !== STORE_VERSION || rebuilt;
    const next = upgrade ? applyTicks({ ...store, version: STORE_VERSION }, new Set(store.settings.read)) : store;
    if (upgrade) {
      try {
        this.write(next);
      } catch (err) {
        this.become('unwritten', { what: 'unwritten', detail: `${this.file} (${err.code || 'error'})` });
        return { drop: false };
      }
    }
    this.state = 'on';
    this.store = next;
    this.forget(...STUCK, 'damaged');
    if (read?.damaged) this.note({ what: 'damaged', count: read.damaged, detail: this.file });
    if (rebuilt) this.note({ what: 'rebuilt', why: rebuilt, detail: '' });
    this.dropLegacy();
    this.tidy();
    this.prune();
    return { drop: false };
  }
  // The user's off read from a file at start: taken once the store is gone.
  offAtLoad() {
    const res = this.remove();
    if (res.ok) return { drop: true };
    this.become('unremoved', { what: 'unremoved', detail: `${this.file} (${res.code})` });
    return { drop: false };
  }

  // Text past KEEP_MS removed, on disk first: a write that fails is tried
  // again every half minute and said once it keeps failing.
  prune() {
    const next = pruned(this.store, this.now());
    if (!next) return;
    try {
      this.write(next);
      this.store = next;
      this.pruneFails = 0;
      this.forget('prune');
    } catch (err) {
      this.pruneFails += 1;
      if (this.pruneFails >= PRUNE_SAY) this.note({ what: 'prune', detail: `${this.file} (${err.code || 'error'})` });
    }
  }
  // Every half minute while the part is on: a stuck store is read again (an
  // off from a file tried again), one that reads is pruned and its folder
  // tidied. -> as load().
  housekeep({ secretFor = null, lineOff = false } = {}) {
    if (this.stuck) return this.load({ secretFor, lineOff });
    if (!this.ready) return { drop: false };
    this.tidy();
    this.prune();
    return { drop: false };
  }

  // ---- the user's changes: each taken only once written ----

  // On: a store with nothing in it yet. Already on (stuck too): nothing to do.
  turnOn() {
    if (this.on) return { ok: true };
    const store = emptyStore();
    try {
      this.write(store);
    } catch (err) {
      return { ok: false, error: notSaved(err), code: err.code || 'error' };
    }
    this.state = 'on';
    this.store = store;
    this.epoch += 1;
    this.pruneFails = 0;
    return { ok: true };
  }
  // The relay link as typed -> { ok, changed, deploymentId } or { ok: false,
  // error }. An empty one keeps the saved link.
  setLink(text) {
    if (!this.ready) return { ok: false, error: UNREAD };
    const typed = String(text ?? '').trim();
    if (!typed && this.store.settings.link) return { ok: true, changed: false };
    let parsed;
    try {
      parsed = parseRelayLink(typed);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (parsed.url === this.store.settings.link) return { ok: true, changed: false, deploymentId: parsed.deploymentId };
    const done = this.apply({ ...this.store, settings: { ...this.store.settings, link: parsed.url } });
    if (done.ok) this.forget('rebuilt'); // the user has set it
    return done.ok ? { ok: true, changed: true, deploymentId: parsed.deploymentId } : done;
  }
  // A group ticked or not. Unticking drops its kept messages and senders
  // with the tick, in the same write.
  readGroup(id, on) {
    if (!this.ready) return { ok: false, error: UNREAD };
    if (typeof id !== 'string' || !Object.hasOwn(this.store.groups, id)) return { ok: false, error: 'That group is no longer listed; close and reopen Settings.' };
    const read = this.store.settings.read.filter((x) => x !== id);
    if (on) read.push(id);
    const done = this.apply(applyTicks({ ...this.store, settings: { ...this.store.settings, read } }, new Set(read)));
    if (done.ok) this.forget('rebuilt'); // the user has set them
    return done;
  }

  // One collection (collect()) from this relay link with this secret
  // (secretId: its file's own id, secretIdOf): each answer merged into the
  // store as it is then, and written before the next call. -> { error?,
  // more?, waiting? (the store can't be read yet), stale? (turned off or
  // on, or another link saved, meanwhile: stopped) }.
  async collect({ link, secret, secretId = null, send, now = this.now }) {
    if (!this.ready) return { waiting: true };
    const epoch = this.epoch;
    const current = () => {
      if (!this.ready || this.epoch !== epoch) return null;
      try {
        return parseRelayLink(this.store.settings.link).deploymentId === link.deploymentId ? this.store : null;
      } catch {
        return null; // no link now: stopped
      }
    };
    const res = await collect({
      store: this.store, current, link, secret, secretId, send, now,
      write: (store) => {
        this.write(store);
        this.store = store;
      },
    });
    if (res.stale) return { stale: true };
    // The app's own call refused: the relay at this link counted it as a
    // wrong secret, so that much of its next rise is not someone else's.
    if (res.error?.kind === 'secret' && current()) {
      const n = this.store.ownRefused?.link === link.deploymentId ? this.store.ownRefused.n : 0;
      this.apply({ ...this.store, ownRefused: { link: link.deploymentId, n: n + 1 } }); // not written: the next rise is said whole, an overcount at worst
    }
    return { ...(res.error ? { error: res.error } : {}), ...(res.more ? { more: true } : {}) };
  }

  // The user's off (Collect from my LINE bot's, or LINE chats'): taken only
  // once nothing that would bring the part back is left (the older settings
  // file, then the store); else nothing changes -> { ok: false, error,
  // code }. Then half-written copies (and 911dc0f's untick file) go; one
  // that would not go is said. -> { ok: true, drop: true }.
  remove() {
    for (const file of [this.legacyFile, this.file]) {
      if (!file) continue;
      try {
        this.fsys.rmSync(file, { force: true });
      } catch (err) {
        return { ok: false, drop: false, error: notOff(err), code: err.code || 'error' };
      }
    }
    this.legacy = null;
    this.epoch += 1;
    this.pruneFails = 0;
    this.found = [];
    this.become('off');
    this.tidy([`${this.stem}.untick.json`]);
    return { ok: true, drop: true };
  }
}

// Removes the relay's saved secret and any half-written copy of it ->
// [{ name, code }] of those that would not go ('.': the folder could not be listed).
function removeSecret({ file, fsys = fs }) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const temp = new RegExp(`^${escapeRe(base)}\\.[\\w-]+\\.tmp$`);
  let names = [];
  let listing = null;
  try {
    names = fsys.readdirSync(dir).filter((n) => temp.test(n));
  } catch (err) {
    if (err.code !== 'ENOENT') listing = { name: '.', code: err.code || 'error' };
  }
  const stuck = [];
  for (const name of [base, ...names]) {
    try {
      fsys.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      stuck.push({ name, code: err.code || 'error' });
    }
  }
  return listing ? [...stuck, listing] : stuck;
}

module.exports = {
  COLLECT_MS, WAIT_MS, KEEP_MS, ROUNDS, TRANSIENT, LineBotError, RELAY_VOICE,
  parseRelayLink, secretStorage, checkSecret, sealSecret, secretFor, openSecret, secretFileError, secretLocked,
  relayReply, readEvent, emptyStore, readStore, cursorFor, applyTicks, takeReply, collect, nextCollect, notCollecting,
  botChats, botGroups, botView, botProblems, inSettings, settingsWords, wall, BotKeeper, keptGroups, removeSecret,
  secretIdOf, RELAY_VERSION, UNREAD,
};
