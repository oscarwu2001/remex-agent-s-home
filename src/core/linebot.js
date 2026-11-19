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
const STORE_VERSION = 1;
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
const sealSecret = fieldSurvey.sealSecret;
const secretFor = (text) => fieldSurvey.secretRecord(text)?.deploymentId ?? null;
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
const COUNTERS = ['missed', 'refused', 'notJson', 'lost'];
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
  if (!COUNTERS.every((k) => isCount(body[k]) || (k === 'lost' && body[k] === undefined))) throw wrongShape('no counts');
  const events = [];
  let last = 0;
  for (const e of body.events) {
    // Without a sequence number in order the cursor cannot move past it.
    if (!e || typeof e !== 'object' || !isSeq(e.seq) || e.seq <= last) throw wrongShape('events out of order');
    last = e.seq;
    if (e.broken === true || !e.event || typeof e.event !== 'object' || Array.isArray(e.event)) events.push({ seq: e.seq, broken: true });
    else events.push({ seq: e.seq, event: e.event });
  }
  return { relay: body.relay, events, more: body.more, counts: Object.fromEntries(COUNTERS.map((k) => [k, body[k] ?? 0])) };
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
// { version, link: the relay deployment the cursor belongs to, relay: its
// id (null until the relay answers, after a secret is saved), cursor: the
// last event saved, counts: { relay, link, missed, refused, notJson, lost }
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
    version: STORE_VERSION, link: null, relay: null, cursor: 0, counts: null, groups: {}, messages: [], seen: {}, unsent: {}, notes: [], nameProblem: null, namedMs: 0,
  };
}
const NOTES = ['missed', 'refused', 'notJson', 'lost', 'broken', 'unusable', 'future', 'ahead', 'restarted'];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const STRINGS = ['kind', 'text', 'who'];
// A store read from its file -> { store, invalid, damaged }. One the app
// cannot read at all is invalid (the caller keeps the file aside and says
// so); entries it cannot read in a store it can are left out and counted
// (damaged), never dropped unsaid.
function readStore(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { store: emptyStore(), invalid: true, damaged: 0 };
  }
  if (!obj(raw) || raw.version !== STORE_VERSION || !isCount(raw.cursor)) return { store: emptyStore(), invalid: true, damaged: 0 };
  let damaged = 0;
  const keepIf = (ok) => {
    if (!ok) damaged += 1;
    return ok;
  };
  const groups = {};
  for (const [id, g] of Object.entries(obj(raw.groups) ?? {})) {
    if (!keepIf(ID.test(id) && obj(g) && (g.kind === 'group' || g.kind === 'room'))) continue;
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
  const counts = c && typeof c.relay === 'string' && RELAY_ID.test(c.relay) && COUNTERS.every((k) => isCount(c[k]))
    ? { relay: c.relay, link: typeof c.link === 'string' ? c.link : null, ...Object.fromEntries(COUNTERS.map((k) => [k, c[k]])) } : null;
  if (raw.counts != null && !counts) damaged += 1;
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter((n) => keepIf(obj(n) && NOTES.includes(n.what) && isCount(n.n) && Number.isFinite(n.at)));
  const np = obj(raw.nameProblem);
  return {
    store: {
      version: STORE_VERSION,
      link: typeof raw.link === 'string' ? raw.link : null,
      relay: typeof raw.relay === 'string' && RELAY_ID.test(raw.relay) ? raw.relay : null,
      cursor: raw.cursor, counts, groups, messages, seen: stamps(raw.seen), unsent: stamps(raw.unsent), notes,
      nameProblem: np && typeof np.code === 'string' && PROBLEM.test(np.code) && Number.isFinite(np.ms) ? { code: np.code, ms: np.ms } : null,
      namedMs: Number(raw.namedMs) || 0,
    },
    invalid: false,
    damaged,
  };
}

// The cursor to send: the saved one only for the relay link it was saved
// for and a relay the app has heard from; else 0, which removes nothing.
const cursorFor = (store, deploymentId) => (store.link === deploymentId && store.relay ? store.cursor : 0);
// A new secret may belong to a relay set up afresh at the same link: until
// it answers, the cursor is not sent. Its counts stay (counts.relay).
const forgetRelay = (store) => ({ ...store, relay: null });

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
// link: the deployment id asked; upTo: the cursor sent; ticked: the groups
// whose messages are kept. The cursor moves to the last event of the
// answer; the caller saves the store before it asks again, since that ask
// lets the relay forget them. again: ask again now (more events wait, or
// the count was reset).
function takeReply(store, reply, { link, upTo = 0, ticked = new Set(), now }) {
  const next = {
    ...store, groups: Object.fromEntries(Object.entries(store.groups).map(([id, g]) => [id, { ...g, ...(g.members ? { members: { ...g.members } } : {}) }])),
    messages: [...store.messages], seen: { ...store.seen }, unsent: { ...store.unsent }, notes: [...store.notes],
  };
  const before = JSON.stringify([store.link, store.relay, store.cursor, store.counts]);
  let noted = false;
  const note = (what, n = 1) => {
    if (n <= 0) return;
    next.notes.push({ what, n, at: now });
    noted = true;
  };
  // Another link: the cursor was another relay's to send.
  if (next.link !== link) Object.assign(next, { link, relay: null, cursor: 0 });
  if (reply.ahead) {
    // The relay holds fewer events than the cursor says (it was reset or
    // replaced): start at 0. Asking with 0 removes nothing on the relay,
    // and what comes again is taken once (seen).
    note('ahead');
    Object.assign(next, { relay: reply.relay, cursor: 0 });
    return { store: prune(next, now), changed: true, again: true };
  }
  // Another relay at the link it last answered at: its events are numbered
  // afresh, and the cursor sent may have removed some of them before they came.
  if (next.counts && next.counts.relay !== reply.relay && next.counts.link === link) note('restarted');
  next.relay = reply.relay;
  // The relay's counters only grow: a rise since its last answer is what
  // happened in between, said whatever the app did meanwhile. Another
  // relay's counts are where it starts.
  if (next.counts?.relay === reply.relay) for (const k of COUNTERS) note(k, reply.counts[k] - next.counts[k]);
  next.counts = { relay: reply.relay, link, ...reply.counts };
  let broken = 0;
  let unusable = 0;
  let future = 0;
  let last = upTo;
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
    if (r.nameProblem) {
      if (r.ms >= (next.nameProblem?.ms ?? 0)) next.nameProblem = { code: r.nameProblem, ms: r.ms };
    } else if (r.group.name || Object.keys(r.names).length) {
      next.namedMs = Math.max(next.namedMs, r.ms);
      if (next.nameProblem && r.ms > next.nameProblem.ms) next.nameProblem = null;
    }
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
  const changed = reply.events.length > 0 || noted || dropped || before !== JSON.stringify([pruned.link, pruned.relay, pruned.cursor, pruned.counts]);
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
// next call lets the relay forget it. A write that fails leaves the cursor
// where it was saved: the next collection gets the same events again.
// send: the transport's (Electron's net.request in the app); ticked() the
// groups ticked now; now() the clock. -> { store (as last saved), more?,
// error? }. A bug throws.
async function collect({ store, link, secret, ticked, send, write, now = () => Date.now() }) {
  let saved = store;
  let resets = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const upTo = cursorFor(saved, link.deploymentId);
    let reply;
    try {
      const body = await fieldSurvey.callWebApp({ request: fieldSurvey.webAppRequest(link, { secret, upTo }), send, voice: RELAY_VOICE });
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
    const step = takeReply(saved, reply, { link: link.deploymentId, upTo, ticked: ticked(), now: now() });
    if (step.changed) {
      try {
        write(step.store);
      } catch (err) {
        return { store: saved, error: storeError(err) };
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

// Why the bot part, switched on, cannot collect: words with the next step,
// or null when it can.
function notCollecting({ on, link, secretSaved, storage }) {
  if (!on) return null;
  if (storage) return 'this computer can’t keep the relay’s secret; set up a keyring (on Linux, GNOME Keyring or KWallet), then restart Agent’s Home';
  if (!link) return `no relay link is saved; paste the relay’s Web app link under Relay link in ${SETTINGS}`;
  if (!secretSaved) return `no secret is saved; paste READER_SECRET under Secret in ${SETTINGS}`;
  return null;
}

// ---- settings ------------------------------------------------------------------------
//
// { on, link: the relay link rebuilt, read: ticked group ids }, in its own
// file. The file is the app's own and only written through here, so a
// value of the wrong kind is dropped.

function normalise(s) {
  return {
    on: s?.on === true,
    link: typeof s?.link === 'string' ? s.link : '',
    read: [...new Set((Array.isArray(s?.read) ? s.read : []).filter((x) => typeof x === 'string' && ID.test(x)))],
  };
}
// One change from Settings -> { settings, linkChanged } or { error }.
// Turning the bot part off forgets the ticks (the main process removes the
// secret and the store). A link is saved rebuilt from its id; an empty one
// keeps the saved link.
function changeSettings(current, change = {}) {
  const next = normalise(current);
  let linkChanged = false;
  if ('on' in change) {
    next.on = change.on === true;
    if (!next.on) next.read = [];
  }
  if ('link' in change) {
    const typed = String(change.link ?? '').trim();
    if (typed || !next.link) {
      let parsed;
      try {
        parsed = parseRelayLink(typed);
      } catch (err) {
        return { error: err.message };
      }
      if (parsed.url !== next.link) {
        next.link = parsed.url;
        linkChanged = true;
      }
    }
  }
  if ('tick' in change) {
    const id = change.tick?.id;
    if (typeof id !== 'string' || !ID.test(id)) return { error: 'That group is no longer listed; close and reopen Settings.' };
    next.read = next.read.filter((x) => x !== id);
    if (change.tick.on === true) next.read.push(id);
  }
  return { settings: next, linkChanged };
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
function botChats(store, ticked) {
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
function botGroups(store, ticked) {
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
// error: the last collection's failure, with `at`; storage: why no secret
// can be kept here, or null; notCollecting: why it is on and not
// collecting (notCollecting()), or null.
function botView({ settings, store, secretSaved = false, storage = null, error = null, collectedAt = null, busy = false, nextAt = null, notCollecting: why = null }) {
  const ticked = new Set(settings.read);
  return {
    on: settings.on,
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
    // Whether the relay has sent any names (it does only with LINE_TOKEN).
    named: store.namedMs > 0,
    standIns: standInCount(store, ticked) > 0,
    windowDays: WINDOW_DAYS,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const were = (n) => (n === 1 ? 'was' : 'were');
const NAME_WORDS = (code) => {
  if (/^HTTP 40[13]$/.test(code)) {
    return 'LINE refused the relay’s LINE_TOKEN, so names are off and groups and senders show as stand-ins: issue a new channel access token in the LINE Developers console and put it in the relay’s Script properties as LINE_TOKEN, or remove LINE_TOKEN to go without names';
  }
  if (code === 'HTTP 429') return 'LINE asked the relay to slow down its name lookups, so some names show as stand-ins; they come back by themselves';
  if (code === 'HTTP 404') return 'LINE did not find some names the relay looked up (a member who left, for one), so they show as stand-ins';
  return 'the relay’s name lookups failed, so some names show as stand-ins; the relay’s Executions in Apps Script show why';
};
// A trouble with the store's files, in words (BotKeeper's problems()).
function storeWords(sp, add) {
  if (sp.what === 'unreadable') add('the bot’s saved messages could not be read, so collecting waits; close any app using the app’s data folder. The app tries again within a minute', sp.detail ?? '');
  if (sp.what === 'invalid') {
    add('the bot’s saved messages were not in a shape the app reads, so it started a new store and kept the old file aside; messages kept before may be lost. Turning the bot part off removes the old file', sp.detail ?? '');
  }
  if (sp.what === 'damaged') add(`${sp.count} of the bot’s saved entries could not be read and were left out; the rest are kept`, sp.detail ?? '');
  if (sp.what === 'leftover') add('a half-written copy of the bot’s saved messages could not be removed; close any app using the app’s data folder and remove it from there', sp.detail ?? '');
  if (sp.what === 'stuck') {
    add('the bot’s saved messages are not in a shape the app reads and could not be moved aside, so collecting waits and the file is left as it is; close any app using the app’s data folder. The app tries again within a minute', sp.detail ?? '');
  }
  if (sp.what === 'pending') {
    add(`an untick or a new secret could not be written to the app’s file yet (${sp.code ?? 'error'}), so the file still holds what it removes; close any app using the app’s data folder. The app tries again within a minute`, sp.detail ?? '');
  }
}
const AGAIN_SCRIPT = 'if it keeps happening, press Copy relay script in Settings, paste it over the relay’s script and deploy it as a new version';

// What goes under Needs attention, as counts and next steps; no group or
// sender name, message or link. error: the last collection's failure
// ({ message, kind }); notCollecting: why it is on and not collecting;
// storeProblems: [{ what: 'unreadable' | 'stuck' | 'invalid' | 'damaged' | 'pending' |
// 'leftover', detail, count }] (the store's files, as BotKeeper found
// them; storeProblem: one of them); ticked: the ticked groups. fix 'line':
// a link to Settings.
function botProblems({ on, store, error = null, notCollecting: why = null, storeProblem = null, storeProblems = storeProblem ? [storeProblem] : [], ticked = new Set(), now }) {
  if (!on) return [];
  const out = [];
  const add = (label, detail = '', fix = null) => out.push({ label: `LINE chats: ${label}`, detail, ...(fix ? { fix } : {}) });
  if (why) add(`your LINE bot is on but not collecting: ${why}`, '', 'line');
  else if (error) add(`the bot’s messages could not be collected. ${error.message}`, '', 'line');
  for (const sp of storeProblems) storeWords(sp, add);
  const sum = (what) => (store?.notes ?? []).filter((n) => n.what === what && n.at >= now - KEEP_MS).reduce((a, n) => a + n.n, 0);
  const days = `in the last ${WINDOW_DAYS} days`;
  const refused = sum('refused');
  if (refused) {
    add(`${plural(refused, 'call')} to the relay’s webhook ${were(refused)} refused ${days}: a wrong key in LINE’s webhook link, or someone else calling the relay. Check that the webhook link in the LINE Developers console ends in ?k= and the relay’s WEBHOOK_KEY (the relay script’s Project Settings → Script properties)`);
  }
  const missed = sum('missed');
  if (missed) add(`${plural(missed, 'event')} waited on the relay over ${WINDOW_DAYS} days and ${were(missed)} deleted before the app collected ${missed === 1 ? 'it' : 'them'} ${days}: keep Collect from my LINE bot on and open the app at least every ${WINDOW_DAYS} days`);
  const lost = sum('lost');
  if (lost) add(`${plural(lost, 'event')} from LINE could not be kept by the relay (it was busy, or its sheet failed) ${days}, so ${lost === 1 ? 'it is' : 'they are'} gone; if it keeps happening, the relay’s Executions in Apps Script show why`);
  const notJson = sum('notJson');
  if (notJson) add(`${plural(notJson, 'call')} to the relay’s webhook could not be read ${days}; if this goes on, check that only LINE has the webhook link`);
  const broken = sum('broken');
  if (broken) add(`${plural(broken, 'event')} on the relay could not be read and ${were(broken)} left out ${days}; ${AGAIN_SCRIPT}`);
  const unusable = sum('unusable');
  if (unusable) add(`${plural(unusable, 'event')} from the relay lacked a group, a time or a message and ${were(unusable)} left out ${days}; ${AGAIN_SCRIPT}`);
  const future = sum('future');
  if (future) add(`${plural(future, 'event')} from the relay ${were(future)} dated in the future and ${were(future)} left out ${days}; check this computer’s date and time`);
  if (sum('ahead')) add('the relay held fewer events than the app had collected (it was reset or replaced), so the app started counting afresh; what is still on the relay comes in again and is kept once', '', 'line');
  if (sum('restarted')) add('the relay at this link is a new one (its id changed), so messages the old one still held may be missing', '', 'line');
  if (store?.nameProblem) add(NAME_WORDS(store.nameProblem.code));
  if (store && standInCount(store, ticked) > 0) {
    add('senders in your bot’s groups show as stand-ins, because the relay sends no names, so your own promises there can’t be found and your own messages may show as mentions; put the channel access token in the relay’s Script properties as LINE_TOKEN to turn names on', '', 'line');
  }
  return out;
}

// ---- the store on disk --------------------------------------------------------------------
//
// The bot's store as the main process keeps it. Nothing is written before
// the file has been read in this run (or found missing): a store that is
// busy, or not in a shape the app reads and could not be moved aside, is
// never written over, and every change waits for the next good read (a
// new secret too: it is applied then). After a good read the copy in
// memory is the one last written: every change goes through save(), a
// collection's rounds included, so an older copy is never written over a
// newer one and nothing the relay was let forget is only in memory. The one
// exception is a removal (an untick, a forgotten relay id) whose write
// failed: memory has less than the disk until retry() writes it, and
// Needs attention says so meanwhile. A write is whole: a temp file,
// flushed to disk, then renamed; a temp file holds message text, so none
// stays behind unsaid. bump() marks the settings as changed under a
// collection (a new link or secret, off): that collection writes nothing
// more and its result is dropped. A store that cannot be read is moved
// aside, never written over, said until the part is turned off, and
// removed after KEEP_MS.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
class BotKeeper {
  constructor({ file, fsys = fs, now = () => Date.now() }) {
    this.file = file;
    this.fsys = fsys;
    this.now = now;
    this.dir = path.dirname(file);
    this.base = path.basename(file);
    this.stem = this.base.replace(/\.json$/i, '');
    this.store = emptyStore();
    this.loaded = false; // the file was read (or found missing) in this run: only then is it written
    this.forget = false; // a new secret saved before the file could be read: applied at the next good read
    this.generation = 0;
    this.dirty = false;
    this.found = []; // { what, detail, count } from reading and writing, for botProblems
  }

  names(re) {
    try {
      return this.fsys.readdirSync(this.dir).filter((n) => re.test(n));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      this.note({ what: 'unreadable', detail: `${this.dir} (${err.code || 'error'})` });
      return [];
    }
  }
  temps() {
    return this.names(new RegExp(`^${escapeRe(this.base)}\\.[\\w-]+\\.tmp$`));
  }
  asides() {
    return this.names(new RegExp(`^${escapeRe(this.stem)}\\.unreadable(?:-\\d+)?\\.json$`));
  }
  note(problem) {
    this.found = [...this.found.filter((p) => p.what !== problem.what), problem];
  }
  forgetNote(what) {
    this.found = this.found.filter((p) => p.what !== what);
  }
  // Removes the named files in the folder -> [{ name, code }] that would not go.
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
  leftover(stuck) {
    if (stuck.length) this.note({ what: 'leftover', detail: stuck.map((s) => `${path.join(this.dir, s.name)} (${s.code})`).join(', ') });
  }
  // A copy kept aside goes after KEEP_MS (its time is in its name; else the file's own).
  sweepAsides() {
    const cut = this.now() - KEEP_MS;
    const old = this.asides().filter((n) => {
      const stamp = Number(/-(\d+)\.json$/i.exec(n)?.[1]);
      if (Number.isFinite(stamp) && stamp > 0) return stamp < cut;
      try {
        return this.fsys.statSync(path.join(this.dir, n)).mtimeMs < cut;
      } catch {
        return false; // gone meanwhile, or not to be looked at: the next sweep tries again
      }
    });
    this.leftover(this.removeAll(old));
  }
  hasAside() {
    return this.asides().length > 0;
  }

  // Reads the store (at start, when the part can collect again, and again
  // while it could not be read). ticked: the groups ticked now (one that is
  // not loses its kept text, on disk too), or null when the ticks are not
  // known (the settings file was lost): then nothing is unticked. Text past
  // KEEP_MS goes too. -> whether it was read.
  load(ticked) {
    this.found = [];
    this.leftover(this.removeAll(this.temps()));
    this.sweepAsides();
    let text = null;
    try {
      text = this.fsys.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Busy or not the app's to open: kept as it is and read again before anything is written.
        this.loaded = false;
        this.store = emptyStore();
        this.note({ what: 'unreadable', detail: `${this.file} (${err.code || 'error'})` });
        return false;
      }
    }
    let store = emptyStore();
    if (text != null) {
      const read = readStore(text);
      if (read.invalid) {
        try {
          this.fsys.renameSync(this.file, path.join(this.dir, `${this.stem}.unreadable-${this.now()}.json`));
        } catch (err) {
          this.loaded = false;
          this.store = emptyStore();
          this.note({ what: 'stuck', detail: `${this.file} (${err.code || 'error'})` });
          return false;
        }
      } else {
        store = read.store;
        if (read.damaged) this.note({ what: 'damaged', count: read.damaged, detail: this.file });
      }
    }
    const aside = this.asides();
    if (aside.length) this.note({ what: 'invalid', detail: aside.map((n) => path.join(this.dir, n)).join(', ') });
    this.loaded = true;
    this.store = store;
    this.dirty = false;
    let next = prune(ticked ? applyTicks(store, ticked) : store, this.now());
    if (this.forget) next = forgetRelay(next);
    this.forget = false;
    this.change(next);
    return true;
  }

  problems() {
    return [...this.found];
  }

  save(store) {
    if (!this.loaded) throw Object.assign(new Error('The bot’s store has not been read in this run, so it is not written'), { code: 'unread' });
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
      this.leftover(this.removeAll([path.basename(tmp)]));
      throw err;
    }
    this.store = store;
    this.dirty = false;
    this.forgetNote('pending');
  }

  // A removal that must reach the disk: memory has it at once; a failed
  // write is said, tried again (retry) and finished at the next load. Before
  // a good read nothing is written: the next load applies it.
  change(next) {
    if (!this.loaded) return { saved: false, code: 'unread' };
    if (!this.dirty && (next === this.store || same(next, this.store))) {
      this.store = next;
      return { saved: true };
    }
    try {
      this.save(next);
      return { saved: true };
    } catch (err) {
      this.store = next;
      this.dirty = true;
      this.note({ what: 'pending', detail: `${this.file} (${err.code || 'error'})`, code: err.code || 'error' });
      return { saved: false, code: err.code || 'error' };
    }
  }
  untick(ticked) {
    if (!this.loaded) return { saved: false, code: 'unread' };
    return this.change(applyTicks(this.store, ticked));
  }
  forgetRelay() {
    this.bump();
    if (!this.loaded) {
      this.forget = true;
      return { saved: false, code: 'unread' };
    }
    return this.change(forgetRelay(this.store));
  }
  // Every 30 seconds while the part is on: a store not read yet is read, a
  // failed removal written, copies kept aside too long removed.
  retry(ticked) {
    if (!this.loaded) {
      this.load(ticked);
      return { saved: this.loaded, ...(this.loaded ? {} : { code: 'unread' }) };
    }
    this.sweepAsides();
    return this.dirty ? this.change(this.store) : { saved: true };
  }
  bump() {
    this.generation += 1;
  }

  // One collection (collect()) on the store as last written, read first if
  // it has not been. -> { error?, more?, waiting? (the store cannot be read
  // yet), stale? (the settings changed under it: dropped, and it wrote
  // nothing after the change) }.
  async collect({ link, secret, ticked, send, now = this.now }) {
    if (!this.loaded && !this.load(ticked())) return { waiting: true };
    const generation = this.generation;
    const res = await collect({
      store: this.store, link, secret, ticked, send, now,
      write: (store) => {
        if (generation !== this.generation) throw Object.assign(new Error('The bot part changed while collecting'), { code: 'stale' });
        this.save(store);
      },
    });
    if (generation !== this.generation) return { stale: true };
    return { ...(res.error ? { error: res.error } : {}), ...(res.more ? { more: true } : {}) };
  }

  // Off: the store, its half-written copies and any copy kept aside go. ->
  // [{ name, code }] of those that would not ('.' for the folder itself,
  // when it could not be listed to find them).
  remove() {
    this.bump();
    let listing = null;
    let names = [];
    try {
      names = this.fsys.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') listing = { name: '.', code: err.code || 'error' };
    }
    const temp = new RegExp(`^${escapeRe(this.base)}\\.[\\w-]+\\.tmp$`);
    const aside = new RegExp(`^${escapeRe(this.stem)}\\.unreadable(?:-\\d+)?\\.json$`);
    const stuck = this.removeAll([this.base, ...names.filter((n) => temp.test(n) || aside.test(n))]);
    this.store = emptyStore();
    this.dirty = false;
    this.forget = false;
    this.found = [];
    this.loaded = !stuck.some((s) => s.name === this.base);
    this.leftover(stuck.filter((s) => s.name !== this.base));
    return listing ? [...stuck, listing] : stuck;
  }
}

// The groups a store kept text or senders for: they were ticked when it
// was written. Ticks lost with the settings file come back from here.
const keptGroups = (store) => Object.keys(store.groups).filter((id) => store.groups[id].members || store.messages.some((m) => m.chat === id));

// What Settings says after an untick: saved, whether its write went
// through; aside, whether a copy kept aside still holds earlier messages.
function untickNote({ saved, aside }) {
  const words = [
    saved ? '' : 'Unticked. Its kept messages are hidden; the app could not remove them from its file just now and tries again within a minute.',
    aside ? `${saved ? 'Unticked. ' : ''}A copy of earlier saved messages, kept aside because it could not be read, still holds them until the bot part is turned off (at most ${WINDOW_DAYS} days).` : '',
  ].filter(Boolean);
  return words.length ? words.join(' ') : null;
}

// Removes the relay's saved secret and any half-written copy of it ->
// [{ name, code }] of those that would not go.
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

// At start, from how the two settings files read ('ok', 'missing' or
// 'unreadable'): drop (the secret and the store go) only for an "off" read
// cleanly from a file, never for a file that could not be read; collect
// only when both say on.
function startPlan({ lineRead, lineEnabled, botRead, botOn }) {
  const readable = lineRead !== 'unreadable' && botRead !== 'unreadable';
  const cleanOff = (lineRead === 'ok' && !lineEnabled) || (botRead === 'ok' && !botOn);
  return { drop: readable && cleanOff, collect: lineRead === 'ok' && botRead === 'ok' && Boolean(lineEnabled) && Boolean(botOn) };
}

module.exports = {
  COLLECT_MS, WAIT_MS, KEEP_MS, ROUNDS, TRANSIENT, LineBotError, RELAY_VOICE,
  parseRelayLink, secretStorage, checkSecret, sealSecret, secretFor, openSecret, secretFileError, secretLocked,
  relayReply, readEvent, emptyStore, readStore, cursorFor, forgetRelay, applyTicks, takeReply, collect, nextCollect, notCollecting,
  changeSettings, botChats, botGroups, botView, botProblems, inSettings, settingsWords, wall, BotKeeper, startPlan, keptGroups, untickNote, removeSecret,
};
