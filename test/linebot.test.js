'use strict';

// LINE chats' bot part (src/core/linebot.js): the relay's answers, the
// events as messages, the store and its cursor, over invented groups,
// people and messages. The relay here is a stand-in that keeps the
// relay script's rules (docs/line-bot-relay.gs): it numbers events, forgets
// those up to the cursor it is sent, and says "cursor ahead" when the
// cursor is past what it has numbered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../src/core/linebot');
const L = require('../src/core/linechat');
const F = require('../src/core/fieldsurvey');

const DEPLOY = 'AKfycbRelayRelayRelay0123456789_-abcdefg';
const OTHER_DEPLOY = 'AKfycbOtherRelayRelay9876543210_-zyxwvut';
const EXEC = `https://script.google.com/macros/s/${DEPLOY}/exec`;
const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=demo-key&lib=demo';
const LINK = { deploymentId: DEPLOY, url: EXEC };
const SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const RELAY_A = '11111111-2222-4333-8444-555555555555';
const RELAY_B = '99999999-8888-4777-8666-555555555555';
const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const at = (h, m, day = 19) => new Date(2026, 10, day, h, m).getTime();
const min = 60_000;

// Invented LINE webhook events, as the relay keeps them (no replyToken).
let eventNo = 0;
const source = (group, user) => ({ type: group.startsWith('R') ? 'room' : 'group', ...(group.startsWith('R') ? { roomId: group } : { groupId: group }), ...(user ? { userId: user } : {}) });
const names = ({ groupName, senderName, nameProblem }) => ({
  ...(groupName ? { _groupName: groupName } : {}), ...(senderName ? { _senderName: senderName } : {}), ...(nameProblem ? { _nameProblem: nameProblem } : {}),
});
const message = ({ group = 'Cgroup-demo-1', user = 'Uuser-demo-ken', id, type = 'text', text, ms = at(11, 0), ...rest }) => ({
  type: 'message', mode: 'active', timestamp: ms, webhookEventId: `01DEMO${String(eventNo += 1).padStart(6, '0')}`, deliveryContext: { isRedelivery: false },
  source: source(group, user), message: { id, type, ...(text != null ? { text } : {}) }, ...names(rest),
});
const unsend = ({ group = 'Cgroup-demo-1', user = 'Uuser-demo-ken', id, ms = at(11, 30) }) => ({
  type: 'unsend', mode: 'active', timestamp: ms, webhookEventId: `01DEMO${String(eventNo += 1).padStart(6, '0')}`, source: source(group, user), unsend: { messageId: id },
});
const members = (type, { group = 'Cgroup-demo-1', users = ['Uuser-demo-new'], ms = at(10, 0) } = {}) => ({
  type, timestamp: ms, webhookEventId: `01DEMO${String(eventNo += 1).padStart(6, '0')}`, source: source(group),
  [type === 'memberJoined' ? 'joined' : 'left']: { members: users.map((userId) => ({ type: 'user', userId })) },
});

// The relay stand-in: rows { seq, received, event | broken }.
function fakeRelay({ relay = RELAY_A, secret = SECRET, batch = 500 } = {}) {
  const r = { relay, secret, batch, rows: [], next: 1, missed: 0, refused: 0, notJson: 0, calls: [] };
  r.add = (...events) => {
    for (const e of events) r.rows.push({ seq: r.next++, received: new Date(NOW).toISOString(), ...(e === 'broken' ? { broken: true } : { event: e }) });
  };
  r.answer = (body) => {
    if (body.secret !== r.secret) return { ok: false, error: 'not allowed' };
    const upTo = Math.max(0, Math.floor(Number(body.upTo) || 0));
    if (upTo >= r.next) return { ok: false, error: 'cursor ahead', relay: r.relay };
    r.rows = r.rows.filter((row) => row.seq > upTo);
    const out = r.rows.slice(0, r.batch);
    if (r.busy) return { ok: false, error: 'busy' };
    return { ok: true, relay: r.relay, events: out, more: r.rows.length > r.batch, missed: r.missed, refused: r.refused, notJson: r.notJson, ...(r.lost !== undefined ? { lost: r.lost } : {}) };
  };
  // Google's way: the POST is answered with a redirect, the answer fetched from the echo host.
  let pending = null;
  r.send = async (url, init) => {
    r.calls.push({ url, init });
    if (r.fail) {
      const f = r.fail;
      r.fail = null;
      throw f;
    }
    if (init.method === 'POST') {
      pending = r.answer(JSON.parse(init.body));
      return { status: 302, location: ECHO, contentType: 'text/html', text: async () => '<html>moved</html>' };
    }
    const body = JSON.stringify(pending);
    return { status: 200, location: undefined, contentType: 'application/json', text: async () => body };
  };
  return r;
}

// One collection against the stand-in, writing the store to `disk` (a
// JSON text, as electron/main.js writes it) unless `failWrite` is set.
function harness({ ticked = ['Cgroup-demo-1'], relay = fakeRelay() } = {}) {
  const h = { relay, store: B.emptyStore(), disk: null, writes: 0, failWrite: null, ticked: new Set() };
  h.tick = (raw, on = true) => {
    const id = idOf(raw);
    if (on) h.ticked.add(id);
    else h.ticked.delete(id);
    h.store = B.applyTicks(h.store, h.ticked);
  };
  for (const g of ticked) h.ticked.add(idOf(g));
  h.collect = async (link = LINK, secret = SECRET) => {
    const res = await B.collect({
      store: h.store, link, secret, ticked: () => h.ticked, send: h.relay.send, now: () => NOW,
      write: (s) => {
        if (h.failWrite) throw h.failWrite;
        h.disk = JSON.stringify(s);
        h.writes += 1;
      },
    });
    h.store = res.store;
    return res;
  };
  // The app starting again: the store as read back from its file.
  h.restart = () => {
    h.store = h.disk ? B.readStore(h.disk).store : B.emptyStore();
  };
  h.chats = () => B.botChats(h.store, h.ticked);
  return h;
}
// The group's id as the store knows it, found the way the app finds it:
// from the event the relay delivered.
const idOf = (raw) => B.readEvent(message({ group: raw, id: 'probe', text: 'x' })).group.id;
const keysOf = (chats, opts = { names: ['Mei'], keywords: ['calibration'], since: 0 }) => chats.flatMap((c) => L.relatedToYou(c.messages, opts)).map((h) => h.key);

// ---- events as messages ------------------------------------------------------------------

test('a text event becomes a message in the exports’ shape, and the pipeline finds what concerns the user', async () => {
  const h = harness();
  h.relay.add(message({ id: 'M1', text: '@Mei please check the calibration', ms: at(11, 5), groupName: 'Demo crew', senderName: 'Ken' }));
  const res = await h.collect();
  assert.equal(res.error, undefined);
  const [chat] = h.chats();
  assert.equal(chat.chat, 'Demo crew');
  assert.equal(chat.messages.length, 1);
  const m = chat.messages[0];
  assert.deepEqual({ chat: m.chat, at: m.at, ms: m.ms, sender: m.sender, kind: m.kind, text: m.text }, {
    chat: 'Demo crew', at: '2026-11-19 11:05', ms: at(11, 5), sender: 'Ken', kind: 'text', text: '@Mei please check the calibration',
  });
  assert.match(m.hash, /^[0-9a-f]{16}$/);
  const hits = L.relatedToYou(chat.messages, { names: ['Mei'], keywords: [], since: 0 });
  assert.deepEqual(hits.map((x) => [x.reason, x.chat, x.sender]), [['mention', 'Demo crew', 'Ken']]);
  assert.equal(L.draftTodo(hits[0]).text, 'please check the calibration');
  assert.match(L.promptDraft(hits[0]), /Chat: Demo crew\nFrom: Ken, 2026-11-19 11:05/);
});

test('each LINE message type maps onto an export kind; only text keeps its words', async () => {
  const h = harness();
  h.relay.add(
    message({ id: 'K1', type: 'image' }), message({ id: 'K2', type: 'video' }), message({ id: 'K3', type: 'audio' }),
    message({ id: 'K4', type: 'file' }), message({ id: 'K5', type: 'location' }), message({ id: 'K6', type: 'sticker' }),
    message({ id: 'K7', type: 'somethingNew' }),
    members('memberJoined', { users: ['Uuser-demo-new'] }), members('memberLeft', { users: ['Uuser-demo-old'] }),
  );
  await h.collect();
  const [chat] = h.chats();
  assert.deepEqual(chat.messages.map((m) => m.kind).sort(), ['audio', 'file', 'joined', 'left', 'location', 'other', 'photo', 'sticker', 'video']);
  for (const m of chat.messages) {
    assert.equal(m.text, '');
    assert.equal(typeof m.actor, 'string');
  }
});

test('a group is known by its id across renames: its items keep their keys, and it shows its latest name', async () => {
  const h = harness();
  h.relay.add(message({ id: 'R1', text: 'Mei can you look', groupName: 'Old name', senderName: 'Ken', ms: at(9, 0) }));
  await h.collect();
  const before = keysOf(h.chats());
  h.relay.add(message({ id: 'R2', text: 'thanks', groupName: 'New name', senderName: 'Ken', ms: at(9, 30) }));
  await h.collect();
  assert.deepEqual(h.chats().map((c) => c.chat), ['New name']);
  assert.deepEqual(keysOf(h.chats()), before);
  // An older event carrying the old name does not win back.
  h.relay.add(message({ id: 'R0', text: 'earlier', groupName: 'Old name', ms: at(8, 0) }));
  await h.collect();
  assert.deepEqual(h.chats().map((c) => c.chat), ['New name']);
});

test('without names from the relay, a group and a sender get stable stand-ins, never their LINE ids', async () => {
  const h = harness({ ticked: ['Cgroup-demo-9'] });
  h.relay.add(message({ group: 'Cgroup-demo-9', user: 'Uuser-demo-ana', id: 'S1', text: 'Mei, the report?' }), message({ group: 'Cgroup-demo-9', user: 'Uuser-demo-ana', id: 'S2', text: 'again' }));
  await h.collect();
  const [chat] = h.chats();
  assert.match(chat.chat, /^Group [0-9a-f]{4}$/);
  assert.match(chat.messages[0].sender, /^Member [0-9a-f]{4}$/);
  assert.equal(chat.messages[0].sender, chat.messages[1].sender);
  const all = JSON.stringify([h.store, h.chats(), B.botGroups(h.store, h.ticked)]);
  assert.ok(!all.includes('Cgroup-demo-9'));
  assert.ok(!all.includes('Uuser-demo-ana'));
  // The same stand-ins after a restart.
  h.restart();
  assert.equal(h.chats()[0].chat, chat.chat);
  assert.equal(h.chats()[0].messages[0].sender, chat.messages[0].sender);
  // A multi-person chat (a room) is a "Chat".
  const r = harness({ ticked: ['Rroom-demo-1'] });
  r.relay.add(message({ group: 'Rroom-demo-1', id: 'S3', text: 'hi' }));
  await r.collect();
  assert.match(r.chats()[0].chat, /^Chat [0-9a-f]{4}$/);
});

test('item keys stay the same across a restart and a second delivery, so marks keep working', async () => {
  const h = harness();
  h.relay.add(message({ id: 'D1', text: 'Mei please sign', groupName: 'Demo crew', senderName: 'Ken' }));
  await h.collect();
  const keys = keysOf(h.chats());
  assert.equal(keys.length, 1);
  h.restart();
  assert.deepEqual(keysOf(h.chats()), keys);
  // A dismissal saved under the key hides the item after the restart.
  const marks = L.changeSettings({ enabled: true }, { mark: { key: keys[0], what: 'dismissed' } }).settings.marks;
  assert.ok(marks[keysOf(h.chats())[0]]);
});

// ---- unsend and duplicates ------------------------------------------------------------------

test('an unsend removes that message from what is kept and shown', async () => {
  const h = harness();
  h.relay.add(message({ id: 'U1', text: 'Mei do X', ms: at(11, 0) }), message({ id: 'U2', text: 'Mei do Y', ms: at(11, 1) }));
  await h.collect();
  assert.equal(h.chats()[0].messages.length, 2);
  h.relay.add(unsend({ id: 'U1' }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['Mei do Y']);
  assert.ok(!h.disk.includes('Mei do X'));
});

test('an unsend of a message the app never kept removes nothing, and that message is not kept if it comes later', async () => {
  const h = harness();
  h.relay.add(message({ id: 'V1', text: 'kept' }), unsend({ id: 'V-unknown' }));
  const res = await h.collect();
  assert.equal(res.error, undefined);
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['kept']);
  assert.deepEqual(B.botProblems({ on: true, store: h.store, now: NOW }), []);
  h.relay.add(message({ id: 'V-unknown', text: 'unsent before it came' }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['kept']);
});

test('the same event delivered twice is kept once', async () => {
  const h = harness();
  const ev = message({ id: 'W1', text: 'once', groupName: 'Demo crew' });
  h.relay.add(ev, ev);
  await h.collect();
  assert.equal(h.chats()[0].messages.length, 1);
  assert.equal(B.botGroups(h.store, h.ticked)[0].count, 1);
});

// ---- the relay's rules ------------------------------------------------------------------------

test('a wrong secret is refused: nothing is taken or written, the cursor stays, and the message names READER_SECRET', async () => {
  const h = harness({ relay: fakeRelay({ secret: 'a'.repeat(64) }) });
  h.relay.add(message({ id: 'X1', text: 'hello' }));
  const res = await h.collect();
  assert.equal(res.error.kind, 'secret');
  assert.match(res.error.message, /refused the secret.*READER_SECRET.*Settings → Connections → LINE chats/);
  assert.equal(h.writes, 0);
  assert.equal(h.store.cursor, 0);
  assert.ok(!B.TRANSIENT.has(res.error.kind));
  // In Settings it names the Secret field, open or behind Replace secret.
  assert.match(B.inSettings(res.error.message, { secretOpen: true }), /then save it under Secret\.$/);
  assert.match(B.inSettings(res.error.message, { secretOpen: false }), /then press Replace secret and save the new one\.$/);
});

test('the request posts only the secret and the cursor, to the relay link, and follows the one redirect with a plain GET', async () => {
  const h = harness();
  h.relay.add(message({ id: 'Y1', text: 'a' }));
  await h.collect();
  const [post, get] = h.relay.calls;
  assert.equal(post.url, EXEC);
  assert.deepEqual(JSON.parse(post.init.body), { secret: SECRET, upTo: 0 });
  assert.equal(get.url, ECHO);
  assert.equal(get.init.method, 'GET');
  assert.ok(!JSON.stringify(get).includes(SECRET));
  h.relay.add(message({ id: 'Y2', text: 'b' }));
  await h.collect();
  assert.deepEqual(JSON.parse(h.relay.calls[2].init.body), { secret: SECRET, upTo: 1 });
});

test('the cursor moves only after the messages it covers are written: a failed write gets the same events again, kept once', async () => {
  const h = harness();
  h.relay.add(message({ id: 'Z1', text: 'Mei first' }), message({ id: 'Z2', text: 'Mei second' }));
  h.failWrite = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const failed = await h.collect();
  assert.equal(failed.error.kind, 'store');
  assert.ok(B.TRANSIENT.has('store'));
  assert.match(failed.error.message, /could not be saved/);
  assert.equal(failed.error.code, 'store ENOSPC');
  assert.equal(h.store.cursor, 0);
  assert.equal(h.chats()[0]?.messages.length ?? 0, 0);
  // The relay still holds them (nothing past cursor 0 was let go).
  assert.equal(h.relay.rows.length, 2);
  h.failWrite = null;
  const ok = await h.collect();
  assert.equal(ok.error, undefined);
  assert.equal(h.store.cursor, 2);
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['Mei first', 'Mei second']);
  // The next call lets the relay forget them; they stay kept once.
  await h.collect();
  assert.equal(h.relay.rows.length, 0);
  assert.equal(h.chats()[0].messages.length, 2);
});

test('while the relay says there is more, the app asks again, saving before each ask', async () => {
  const h = harness({ relay: fakeRelay({ batch: 2 }) });
  for (let i = 0; i < 5; i += 1) h.relay.add(message({ id: `P${i}`, text: `n${i}`, ms: at(10, i) }));
  const cursors = [];
  const res = await B.collect({
    store: h.store, link: LINK, secret: SECRET, ticked: () => h.ticked, send: h.relay.send, now: () => NOW,
    write: (s) => {
      // Each write comes before the call that lets the relay forget what it covers.
      assert.ok(h.relay.rows.some((r) => r.seq === s.cursor));
      cursors.push(s.cursor);
    },
  });
  assert.deepEqual(cursors, [2, 4, 5]);
  assert.equal(res.store.messages.length, 5);
  assert.equal(res.more, undefined);
});

test('cursor ahead: the app starts at 0 in the same collection, keeps each event once, and says so', async () => {
  const h = harness();
  h.relay.add(message({ id: 'A1', text: 'one' }), message({ id: 'A2', text: 'two' }));
  await h.collect();
  assert.equal(h.store.cursor, 2);
  // The relay's count set back by hand (its NEXT_SEQ) while it still holds
  // both events: the cursor is past its count.
  h.relay.next = 2;
  const res = await h.collect();
  assert.equal(res.error, undefined);
  const sent = h.relay.calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(c.init.body).upTo);
  assert.deepEqual(sent, [0, 2, 0]);
  assert.equal(h.store.cursor, 2);
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['one', 'two']);
  assert.equal(B.botGroups(h.store, h.ticked)[0].count, 2);
  const said = B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label);
  assert.ok(said.some((l) => /fewer events than the app had collected.*started counting afresh/.test(l)), said.join('\n'));
  // Told in the relay's answer without a relay id, it is not the relay's answer.
  assert.throws(() => B.relayReply({ ok: false, error: 'cursor ahead' }), (e) => e.kind === 'reader' && /not in the shape/.test(e.message));
});

test('a new relay id at the same link: its events are taken, and the app warns that some may be missing', async () => {
  const h = harness();
  h.relay.add(message({ id: 'B1', text: 'old relay' }), message({ id: 'B2', text: 'old relay 2' }));
  await h.collect();
  const next = fakeRelay({ relay: RELAY_B });
  for (let i = 0; i < 4; i += 1) next.add(message({ id: `BN${i}`, text: `new ${i}`, ms: at(11, 10 + i) }));
  h.relay = next;
  const res = await h.collect();
  assert.equal(res.error, undefined);
  assert.equal(h.store.relay, RELAY_B);
  assert.equal(h.store.cursor, 4);
  // The cursor sent (2) let the new relay forget its first two.
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['old relay', 'old relay 2', 'new 2', 'new 3']);
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /new one \(its id changed\).*may be missing/.test(p.label)));
});

test('another relay link starts the cursor at 0, so nothing is let go on a relay the app has not heard from', async () => {
  const h = harness();
  h.relay.add(message({ id: 'C1', text: 'kept' }), message({ id: 'C2', text: 'kept too' }));
  await h.collect();
  assert.equal(B.cursorFor(h.store, DEPLOY), 2);
  assert.equal(B.cursorFor(h.store, OTHER_DEPLOY), 0);
  await h.collect({ deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` });
  assert.equal(JSON.parse(h.relay.calls[h.relay.calls.length - 2].init.body).upTo, 0);
  assert.equal(h.store.link, OTHER_DEPLOY);
  assert.equal(h.chats()[0].messages.length, 2);
});

test('broken rows are counted and left out; the cursor moves past them', async () => {
  const h = harness();
  h.relay.add('broken', message({ id: 'E1', text: 'fine' }), 'broken');
  const res = await h.collect();
  assert.equal(res.error, undefined);
  assert.equal(h.store.cursor, 3);
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['fine']);
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /^LINE chats: 2 events on the relay could not be read and were left out in the last 14 days; if it keeps happening, press Copy relay script/.test(p.label)));
});

test('events missing what the app needs are counted and left out', async () => {
  const h = harness();
  const ok = message({ id: 'F1', text: 'fine' });
  const noGroup = { ...message({ id: 'F2', text: 'x' }), source: { type: 'user', userId: 'Uuser-demo-ken' } };
  const noTime = { ...message({ id: 'F3', text: 'x' }), timestamp: undefined };
  const noId = { ...message({ id: 'F4', text: 'x' }), message: { type: 'text', text: 'no id' } };
  const noText = message({ id: 'F5' });
  const noMembers = { ...members('memberJoined'), joined: {} };
  const noUnsendId = { ...unsend({ id: 'F1' }), unsend: {} };
  h.relay.add(ok, noGroup, noTime, noId, noText, noMembers, noUnsendId);
  const res = await h.collect();
  assert.equal(res.error, undefined);
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['fine']);
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /^LINE chats: 6 events from the relay lacked a group, a time or a message/.test(p.label)));
});

test('an answer not in the relay’s shape is refused whole: nothing is taken and the cursor stays', () => {
  const good = { ok: true, relay: RELAY_A, events: [], more: false, missed: 0, refused: 0, notJson: 0 };
  const shape = (body) => assert.throws(() => B.relayReply(body), (e) => e.kind === 'reader' && /not in the shape the app reads.*Copy relay script/.test(e.message));
  assert.deepEqual(B.relayReply(good), { relay: RELAY_A, events: [], more: false, counts: { missed: 0, refused: 0, notJson: 0, lost: 0 } });
  shape({ ...good, ok: undefined });
  shape({ ...good, relay: undefined });
  shape({ ...good, events: 'none' });
  shape({ ...good, more: 'no' });
  shape({ ...good, missed: -1 });
  shape({ ...good, events: [{ seq: 2, event: {} }, { seq: 1, event: {} }] });
  shape({ ...good, events: [{ seq: 'one', event: {} }] });
  assert.throws(() => B.relayReply({ ok: false, error: 'something new' }), (e) => e.kind === 'reader' && /reason the app does not know/.test(e.message));
});

// ---- the transport ------------------------------------------------------------------------

test('the relay goes through field feedback’s transport: one hop to the echo host only, and its failures in the relay’s words', async () => {
  const run = async (answers) => {
    const calls = [];
    const send = async (url, init) => {
      calls.push(url);
      const a = answers[calls.length - 1];
      if (a instanceof Error) throw a;
      const [status, body = '', o = {}] = a;
      return { status, location: o.location, contentType: o.contentType ?? 'application/json', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    };
    const res = await B.collect({ store: B.emptyStore(), link: LINK, secret: SECRET, ticked: () => new Set(), send, write: () => {}, now: () => NOW });
    return { ...res, calls };
  };
  const away = await run([[302, '', { location: 'https://example.com/steal' }]]);
  assert.equal(away.error.kind, 'blocked');
  assert.match(away.error.message, /relay’s answer was sent to example\.com.*only from script\.googleusercontent\.com/);
  assert.equal(away.calls.length, 1);
  const signIn = await run([[302, '', { location: 'https://accounts.google.com/ServiceLogin' }]]);
  assert.equal(signIn.error.kind, 'access');
  assert.match(signIn.error.message, /In the relay script, Deploy → Manage deployments → Edit → Who has access → Anyone/);
  const gone = await run([[404, '']]);
  assert.equal(gone.error.kind, 'missing');
  assert.match(gone.error.message, /No relay answers at this link/);
  const slow = await run([Object.assign(new Error(`timed out ${EXEC}`), { name: 'TimeoutError' })]);
  assert.equal(slow.error.kind, 'network');
  assert.ok(B.TRANSIENT.has('network'));
  assert.match(slow.error.message, /tries again in 5 minutes/);
  const off = await run([new Error(`connect failed to ${EXEC} with ${SECRET}`)]);
  assert.equal(off.error.kind, 'network');
  // Neither the secret nor the link reaches the log's code.
  assert.ok(!off.error.code.includes(SECRET));
  assert.ok(!off.error.code.includes(DEPLOY));
  const page = await run([[302, '', { location: ECHO }], [200, '<html><title>Error</title></html>', { contentType: 'text/html' }]]);
  assert.equal(page.error.kind, 'reader');
  assert.match(page.error.message, /relay script failed.*Executions/);
  // A link anywhere else is refused before anything is sent.
  const stray = await B.collect({ store: B.emptyStore(), link: { deploymentId: DEPLOY, url: 'https://example.com/exec' }, secret: SECRET, ticked: () => new Set(), send: async () => assert.fail('sent'), write: () => {}, now: () => NOW });
  assert.equal(stray.error.kind, 'blocked');
  assert.match(stray.error.message, /talks only to your relay/);
});

test('the relay link is the web app’s /exec link, rebuilt from its id; other links are refused with what to copy', () => {
  assert.deepEqual(B.parseRelayLink(`${EXEC}?x=1#y`), LINK);
  assert.throws(() => B.parseRelayLink(''), /^RangeError: No relay link yet\. In the relay script, Deploy → Manage deployments/);
  assert.throws(() => B.parseRelayLink(EXEC.replace('/exec', '/dev')), /test link.*In the relay script/);
  assert.throws(() => B.parseRelayLink('https://example.com/macros/s/x/exec'), /not an Apps Script web app/);
});

// ---- the secret --------------------------------------------------------------------------

test('the secret is kept only where the system protects it, belongs to its relay link, and is never repeated back', () => {
  const ready = { available: true, link: EXEC };
  assert.deepEqual(B.checkSecret(` ${SECRET}\n`, ready), { secret: SECRET, deploymentId: DEPLOY });
  assert.match(B.checkSecret(SECRET, { ...ready, available: false }).error, /never keeps it as plain text/);
  assert.match(B.checkSecret(SECRET, { ...ready, backend: 'basic_text' }).error, /no protected storage/);
  assert.match(B.checkSecret(SECRET, { available: true, link: '' }).error, /Save the relay link first/);
  const short = B.checkSecret('tooshort', ready);
  assert.match(short.error, /32 characters or more.*READER_SECRET/);
  assert.ok(!short.error.includes('tooshort'));
  assert.match(B.checkSecret('', { ...ready, saved: true }).error, /press Cancel to keep the saved one/);
  assert.equal(B.secretStorage({ available: true }), null);
  // The file: sealed, with the relay it belongs to; another relay's is not sent.
  const file = B.sealSecret(DEPLOY, Buffer.from('sealed-bytes'));
  assert.equal(B.secretFor(file), DEPLOY);
  assert.equal(B.openSecret(file, DEPLOY).toString(), 'sealed-bytes');
  assert.throws(() => B.openSecret(file, OTHER_DEPLOY), (e) => e.kind === 'setup' && /another relay link/.test(e.message));
  assert.throws(() => B.openSecret('not json', DEPLOY), (e) => e.kind === 'secret');
  assert.equal(B.secretFileError({ code: 'ENOENT' }).kind, 'setup');
  assert.equal(B.secretFileError({ code: 'EBUSY' }).kind, 'secretfile');
  assert.ok(B.TRANSIENT.has('secretfile'));
  assert.equal(B.secretLocked().kind, 'secret');
});

test('the secret never appears in the store, the chats, the snapshot, the problems or an error', async () => {
  const h = harness({ relay: fakeRelay() });
  h.relay.add(message({ id: 'G1', text: 'Mei hi', groupName: 'Demo crew', senderName: 'Ken' }), 'broken');
  h.relay.refused = 3;
  await h.collect();
  h.relay.refused = 5;
  h.relay.fail = new Error(`socket closed while sending ${SECRET}`);
  const res = await h.collect();
  const view = B.botView({ settings: { on: true, link: EXEC, read: [...h.ticked] }, store: h.store, secretSaved: true, error: { ...res.error, message: res.error.message, at: NOW } });
  const everything = JSON.stringify([h.disk, h.store, h.chats(), view, B.botProblems({ on: true, store: h.store, error: res.error, now: NOW }), res.error.message, res.error.code]);
  assert.ok(!everything.includes(SECRET));
  assert.equal(view.secretSaved, true);
  assert.ok(!('secret' in view));
});

// ---- ticks ------------------------------------------------------------------------------

test('a group not ticked keeps only its name, last-seen time and a count: never its text or senders', async () => {
  const h = harness({ ticked: [] });
  h.relay.add(message({ group: 'Cgroup-demo-2', id: 'T1', text: 'private words', groupName: 'Family', senderName: 'Grandma', ms: at(10, 0) }),
    message({ group: 'Cgroup-demo-2', id: 'T2', text: 'more private words', ms: at(10, 5) }));
  await h.collect();
  assert.ok(!h.disk.includes('private words'));
  assert.ok(!h.disk.includes('Grandma'));
  assert.deepEqual(h.chats(), []);
  const [g] = B.botGroups(h.store, h.ticked);
  assert.deepEqual({ name: g.name, read: g.read, count: g.count, lastMs: g.lastMs, messages: g.messages }, { name: 'Family', read: false, count: 2, lastMs: at(10, 5), messages: undefined });
  // Ticked: its messages are kept from then on.
  h.tick('Cgroup-demo-2');
  h.relay.add(message({ group: 'Cgroup-demo-2', id: 'T3', text: 'now kept', senderName: 'Grandma', ms: at(10, 10) }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => [m.sender, m.text]), [['Grandma', 'now kept']]);
  // Unticked again: its kept text and senders go, and the next write has none.
  h.tick('Cgroup-demo-2', false);
  assert.deepEqual(h.chats(), []);
  h.relay.add(message({ group: 'Cgroup-demo-1', id: 'T4', text: 'another group' }));
  await h.collect();
  assert.ok(!h.disk.includes('now kept'));
  assert.ok(!h.disk.includes('Grandma'));
});

test('messages older than 14 days are not kept', async () => {
  const h = harness();
  h.relay.add(message({ id: 'O1', text: 'old', ms: NOW - 15 * 86_400_000 }), message({ id: 'O2', text: 'recent', ms: NOW - 13 * 86_400_000 }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['recent']);
});

// ---- Needs attention ---------------------------------------------------------------------

test('the relay’s counters: a rise since the last answer is said with its next step; what came before the first is not', async () => {
  const h = harness();
  h.relay.refused = 4; // set-up attempts before the app first collected
  h.relay.missed = 1;
  await h.collect();
  assert.deepEqual(B.botProblems({ on: true, store: h.store, now: NOW }), []);
  h.relay.refused = 6;
  h.relay.missed = 4;
  h.relay.notJson = 1;
  await h.collect();
  const said = B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label);
  assert.ok(said.includes('LINE chats: 2 calls to the relay’s webhook were refused in the last 14 days: a wrong key in LINE’s webhook link, or someone else calling the relay. Check that the webhook link in the LINE Developers console ends in ?k= and the relay’s WEBHOOK_KEY (the relay script’s Project Settings → Script properties)'), said.join('\n'));
  assert.ok(said.some((l) => /^LINE chats: 3 events waited on the relay over 14 days and were deleted before the app collected them .*: keep Collect from my LINE bot on and open the app at least every 14 days$/.test(l)), said.join('\n'));
  assert.ok(said.some((l) => /^LINE chats: 1 call to the relay’s webhook could not be read/.test(l)));
  // Two weeks on, they are no longer said.
  assert.deepEqual(B.botProblems({ on: true, store: h.store, now: NOW + 15 * 86_400_000 }), []);
});

test('a name lookup the relay could not make is said: a refused token means names are off; a later name clears it', async () => {
  const h = harness();
  h.relay.add(message({ id: 'N1', text: 'a', nameProblem: 'HTTP 401', ms: at(10, 0) }));
  await h.collect();
  const said = B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label);
  assert.ok(said.some((l) => /LINE refused the relay’s LINE_TOKEN, so names are off/.test(l)), said.join('\n'));
  h.relay.add(message({ id: 'N2', text: 'b', groupName: 'Demo crew', senderName: 'Ken', ms: at(10, 5) }));
  await h.collect();
  assert.deepEqual(B.botProblems({ on: true, store: h.store, now: NOW }), []);
  // A code the app does not know is not repeated as it came.
  h.relay.add(message({ id: 'N3', text: 'c', nameProblem: 'weird <b>code</b>', ms: at(10, 10) }));
  await h.collect();
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /name lookups failed/.test(p.label)));
  assert.equal(h.store.nameProblem.code, 'other');
});

test('a failed collection is said with its next step and a link to Settings; nothing is said while the bot part is off', () => {
  const error = { kind: 'secret', message: 'The relay refused the secret. Save it in Settings → Connections → LINE chats.' };
  const [p] = B.botProblems({ on: true, store: B.emptyStore(), error, now: NOW });
  assert.equal(p.fix, 'line');
  assert.match(p.label, /^LINE chats: the bot’s messages could not be collected\. The relay refused the secret/);
  assert.deepEqual(B.botProblems({ on: false, store: B.emptyStore(), error, now: NOW }), []);
  const unread = B.botProblems({ on: true, store: B.emptyStore(), storeProblem: { what: 'unreadable', detail: 'EBUSY' }, now: NOW });
  assert.match(unread[0].label, /saved messages could not be read/);
});

// ---- the store, settings and timing -----------------------------------------------------------

test('a store the app cannot read starts afresh at cursor 0 and says so; a good one reads back as written', async () => {
  assert.deepEqual(B.readStore('{not json'), { store: B.emptyStore(), invalid: true, damaged: 0 });
  assert.equal(B.readStore(JSON.stringify({ version: 99 })).invalid, true);
  const h = harness();
  h.relay.add(message({ id: 'Q1', text: 'kept', groupName: 'Demo crew', senderName: 'Ken' }));
  await h.collect();
  const back = B.readStore(h.disk);
  assert.equal(back.invalid, false);
  assert.deepEqual(back.store, JSON.parse(h.disk));
  assert.match(B.botProblems({ on: true, store: B.emptyStore(), storeProblem: { what: 'invalid' }, now: NOW })[0].label, /kept the old file aside; messages kept before may be lost/);
});

test('settings: off forgets the ticks, a link is saved rebuilt (an empty one keeps it), and only known group ids tick', () => {
  const id = idOf('Cgroup-demo-1');
  let s = B.changeSettings(undefined, { on: true }).settings;
  assert.deepEqual(s, { on: true, link: '', read: [] });
  const linked = B.changeSettings(s, { link: `${EXEC}?q=1` });
  assert.equal(linked.linkChanged, true);
  assert.equal(linked.settings.link, EXEC);
  s = linked.settings;
  assert.equal(B.changeSettings(s, { link: EXEC }).linkChanged, false);
  assert.equal(B.changeSettings(s, { link: '  ' }).settings.link, EXEC);
  assert.match(B.changeSettings(s, { link: 'https://example.com' }).error, /not an Apps Script web app/);
  s = B.changeSettings(s, { tick: { id, on: true } }).settings;
  assert.deepEqual(s.read, [id]);
  assert.match(B.changeSettings(s, { tick: { id: 'Cgroup-demo-1', on: true } }).error, /^That group is no longer listed; close and reopen Settings\.$/);
  assert.deepEqual(B.changeSettings(s, { on: false }).settings, { on: false, link: EXEC, read: [] });
});

test('when to collect: every 5 minutes, at once while more waits, and hourly after a failure only the user can mend', () => {
  assert.equal(B.nextCollect({ ready: false }), null);
  assert.equal(B.nextCollect({ ready: true }), 0);
  assert.equal(B.nextCollect({ ready: true, lastTryAt: NOW }), NOW + 5 * min);
  assert.equal(B.nextCollect({ ready: true, lastTryAt: NOW, error: { kind: 'network' } }), NOW + 5 * min);
  assert.equal(B.nextCollect({ ready: true, lastTryAt: NOW, error: { kind: 'secret' } }), NOW + 60 * min);
  assert.equal(B.nextCollect({ ready: true, lastTryAt: NOW, more: true }), NOW);
});

test('in Settings a relay message names the control in view; the board keeps the Settings path', () => {
  const missing = 'No relay answers at this link: its deployment may have been archived or deleted. In the relay script, Deploy → Manage deployments, copy the Web app link and paste it in Settings → Connections → LINE chats.';
  const w = B.settingsWords(missing);
  assert.match(w['11'], /and paste it under Relay link\.$/);
  assert.match(w['10'], /, press Change link and paste it\.$/);
  assert.equal(B.settingsWords(null), null);
  assert.match(B.inSettings('No relay secret is saved. Save it in Settings → Connections → LINE chats.', { noStorage: true }), /once this computer can keep it/);
  // With no protected storage, the note under the bot's switch says why; it is named, not pointed at.
  assert.match(B.inSettings('No relay secret is saved. Save it in Settings → Connections → LINE chats.', { noStorage: true }), /\(see the note under Collect from my LINE bot\)\.$/);
});

// ---- the relay script ----------------------------------------------------------------------

test('the relay script that ships asks only for its own sheet, drops reply tokens, refuses a short secret and never sends to LINE', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'line-bot-relay.gs'), 'utf8');
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '/** @OnlyCurrentDoc */');
  const code = lines.filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /delete copy\.replyToken/);
  assert.match(code, /secret\.length < 32\b/);
  assert.match(code, /key\.length < 32\b/);
  // Its only calls to LINE look up names; nothing is pushed or replied.
  assert.doesNotMatch(code, /\/message\/(?:push|reply|multicast|broadcast|narrowcast)/);
  assert.doesNotMatch(code, /method:\s*['"]post['"]/i);
  // The app's hosts are named in fieldsurvey.js alone; the relay is a doc.
  assert.equal(typeof F.callWebApp, 'function');
});

// ---- review round 1 ---------------------------------------------------------------------------

test('a rise in the relay’s counts is said even when the secret was saved again in between; only a new relay id starts afresh', async () => {
  const h = harness();
  h.relay.add(message({ id: 'H1', text: 'first' }));
  await h.collect();
  // The app could not collect for a while; the relay aged events out (missed 0 -> 3).
  h.relay.missed = 3;
  h.relay.lost = 2;
  // The user saves the secret again: the cursor is not trusted until the relay answers.
  h.store = B.forgetRelay(h.store);
  await h.collect();
  const said = B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label);
  assert.ok(said.some((l) => /^LINE chats: 3 events waited on the relay over 14 days/.test(l)), said.join('\n'));
  assert.ok(said.some((l) => /^LINE chats: 2 events from LINE could not be kept by the relay/.test(l)), said.join('\n'));
  // Another link to the same relay keeps the count too.
  h.relay.missed = 5;
  await h.collect({ deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` });
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /^LINE chats: 5 events waited/.test(p.label)));
  // A new relay id: its counts are where it starts.
  const fresh = harness();
  fresh.relay.missed = 9;
  await fresh.collect();
  assert.deepEqual(B.botProblems({ on: true, store: fresh.store, now: NOW }), []);
});

test('an older relay’s answer without `lost` is read as before; a busy relay is a passing trouble', async () => {
  const good = { ok: true, relay: RELAY_A, events: [], more: false, missed: 0, refused: 0, notJson: 0 };
  assert.equal(B.relayReply(good).counts.lost, 0);
  assert.throws(() => B.relayReply({ ...good, lost: -1 }), (e) => e.kind === 'reader');
  const h = harness();
  h.relay.busy = true;
  const res = await h.collect();
  assert.equal(res.error.kind, 'busy');
  assert.ok(B.TRANSIENT.has('busy'));
  assert.match(res.error.message, /relay was busy.*tries again in 5 minutes/);
});

test('a message type that is a name on every object is still just "other"; it reads back after a restart', async () => {
  const h = harness();
  h.relay.add(message({ id: 'J1', type: 'constructor' }), message({ id: 'J2', type: 'toString' }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => m.kind), ['other', 'other']);
  h.restart();
  assert.equal(h.chats()[0].messages.length, 2);
});

test('an unsend removes the message only in its own group', async () => {
  const h = harness({ ticked: ['Cgroup-demo-1', 'Cgroup-demo-2'] });
  h.relay.add(message({ group: 'Cgroup-demo-1', id: 'K1', text: 'stays' }), unsend({ group: 'Cgroup-demo-2', id: 'K1' }));
  await h.collect();
  assert.deepEqual(h.chats().flatMap((c) => c.messages.map((m) => m.text)), ['stays']);
  // And its later arrival in its own group is not kept.
  h.relay.add(message({ group: 'Cgroup-demo-2', id: 'K1', text: 'unsent first' }));
  await h.collect();
  assert.deepEqual(h.chats().flatMap((c) => c.messages.map((m) => m.text)), ['stays']);
});

test('an event dated in the future is left out and counted, with the clock to check', async () => {
  const h = harness();
  h.relay.add(message({ id: 'L1', text: 'from the future', ms: NOW + 3 * 3_600_000 }), message({ id: 'L2', text: 'now' }));
  await h.collect();
  assert.deepEqual(h.chats()[0].messages.map((m) => m.text), ['now']);
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).some((p) => /^LINE chats: 1 event from the relay was dated in the future and was left out .*check this computer’s date and time/.test(p.label)));
});

test('stand-ins never collide: two members, or two groups, whose ids hash alike get longer labels', async () => {
  // Find two invented user ids, and two group ids, whose hashes share their first four characters.
  const first = (map, key, value) => {
    const k = key.slice(0, 4);
    if (map.has(k) && map.get(k) !== value) return map.get(k);
    map.set(k, value);
    return null;
  };
  const gid = idOf('Cgroup-demo-1');
  const seenU = new Map();
  let pair = null;
  for (let i = 0; !pair; i += 1) {
    const user = `Uuser-demo-${i}`;
    const who = B.readEvent(message({ id: 'p', text: 'x', user })).records[0].who;
    const other = first(seenU, who, user);
    if (other) pair = [other, user];
  }
  const h = harness();
  h.relay.add(message({ id: 'N1', text: 'a', user: pair[0] }), message({ id: 'N2', text: 'b', user: pair[1] }));
  await h.collect();
  const [x, y] = h.chats()[0].messages.map((m) => m.sender);
  assert.notEqual(x, y);
  assert.match(x, /^Member [0-9a-f]{5,}$/);
  assert.ok(gid);
  const seenG = new Map();
  let groups = null;
  for (let i = 0; !groups; i += 1) {
    const raw = `Cgroup-demo-g${i}`;
    const other = first(seenG, idOf(raw), raw);
    if (other) groups = [other, raw];
  }
  const g = harness({ ticked: groups });
  g.relay.add(message({ group: groups[0], id: 'N3', text: 'a' }), message({ group: groups[1], id: 'N4', text: 'b' }));
  await g.collect();
  const names = B.botGroups(g.store, g.ticked).map((x) => x.name);
  assert.equal(new Set(names).size, 2, names.join(', '));
  assert.deepEqual(g.chats().map((c) => c.chat).sort(), [...names].sort());
});

test('a store with some damaged entries keeps the rest and counts what it left out', async () => {
  const h = harness();
  h.relay.add(message({ id: 'Q1', text: 'kept' }), message({ id: 'Q2', text: 'also kept' }));
  await h.collect();
  const raw = JSON.parse(h.disk);
  raw.messages[1].kind = 42;
  raw.groups.nothex = { kind: 'group' };
  const back = B.readStore(JSON.stringify(raw));
  assert.equal(back.invalid, false);
  assert.equal(back.damaged, 2);
  assert.equal(back.store.messages.length, 1);
  assert.ok(B.botProblems({ on: true, store: back.store, storeProblem: { what: 'damaged', count: 2 }, now: NOW }).some((p) => /^LINE chats: 2 of the bot’s saved entries could not be read and were left out/.test(p.label)));
});

test('while senders are stand-ins, the user is told their own promises cannot be found and their messages may show as mentions', async () => {
  const h = harness();
  h.relay.add(message({ id: 'S1', text: 'Mei will check' }));
  await h.collect();
  const view = B.botView({ settings: { on: true, link: EXEC, read: [...h.ticked] }, store: h.store, secretSaved: true });
  assert.equal(view.standIns, true);
  const said = B.botProblems({ on: true, store: h.store, ticked: h.ticked, now: NOW }).map((p) => p.label);
  assert.ok(said.some((l) => /senders in your bot’s groups show as stand-ins.*your own promises there can’t be found.*your own messages may show as mentions.*LINE_TOKEN/.test(l)), said.join('\n'));
  // With names from the relay, nothing to say.
  const n = harness();
  n.relay.add(message({ id: 'S2', text: 'hi', senderName: 'Ken', groupName: 'Demo crew' }));
  await n.collect();
  assert.equal(B.botView({ settings: { on: true, link: EXEC, read: [...n.ticked] }, store: n.store, secretSaved: true }).standIns, false);
  assert.deepEqual(B.botProblems({ on: true, store: n.store, ticked: n.ticked, now: NOW }), []);
});

test('the bot part on but not collecting says why and what to do, in Needs attention and in the view', () => {
  const cases = [
    [{ link: '', secretSaved: false, storage: null }, /no relay link is saved.*Relay link/],
    [{ link: EXEC, secretSaved: false, storage: null }, /no secret is saved.*Secret/],
    [{ link: EXEC, secretSaved: false, storage: 'no protection' }, /this computer can’t keep the relay’s secret.*keyring/],
  ];
  for (const [state, words] of cases) {
    const reason = B.notCollecting({ on: true, ...state });
    assert.ok(reason, JSON.stringify(state));
    const said = B.botProblems({ on: true, store: B.emptyStore(), notCollecting: reason, now: NOW }).map((p) => p.label);
    assert.ok(said.some((l) => /^LINE chats: your LINE bot is on but not collecting: /.test(l) && words.test(l)), said.join('\n'));
    const view = B.botView({ settings: { on: true, link: state.link, read: [] }, store: B.emptyStore(), secretSaved: state.secretSaved, storage: state.storage, notCollecting: reason });
    assert.match(view.notCollecting, words);
    // In Settings it names the field, not the path to Settings.
    assert.ok(!view.notCollectingHere.includes('Settings → Connections'), view.notCollectingHere);
    assert.match(view.notCollectingHere, words);
  }
  assert.equal(B.notCollecting({ on: true, link: EXEC, secretSaved: true, storage: null }), null);
  assert.equal(B.notCollecting({ on: false, link: '', secretSaved: false, storage: null }), null);
});

test('asked with 0 the relay cannot be ahead; a collection stops at ROUNDS calls and says more waits', async () => {
  // A relay that answers "cursor ahead" even to 0 is not the relay's answer.
  const stuck = fakeRelay();
  stuck.answer = () => ({ ok: false, error: 'cursor ahead', relay: RELAY_A });
  const h = harness({ relay: stuck });
  const res = await h.collect();
  assert.equal(res.error.kind, 'reader');
  assert.match(res.error.message, /not in the shape the app reads/);
  // ROUNDS calls of one event each, more waiting: the rest at the next collection, at once.
  const many = harness({ relay: fakeRelay({ batch: 1 }) });
  for (let i = 0; i < B.ROUNDS + 3; i += 1) many.relay.add(message({ id: `R${i}`, text: `n${i}`, ms: at(9, 0) + i * 1000 }));
  const cut = await many.collect();
  assert.equal(cut.more, true);
  assert.equal(many.store.cursor, B.ROUNDS);
  assert.equal(B.nextCollect({ ready: true, lastTryAt: NOW, more: cut.more }), NOW);
});

test('the relay’s own words for an answer too large and a second redirect', async () => {
  const run = async (answers) => {
    let i = 0;
    const send = async () => {
      const a = answers[i++];
      return { status: a[0], location: a[1], contentType: 'application/json', text: async () => { if (a[2]) throw a[2]; return '{}'; } };
    };
    return (await B.collect({ store: B.emptyStore(), link: LINK, secret: SECRET, ticked: () => new Set(), send, write: () => {}, now: () => NOW })).error;
  };
  const big = await run([[302, ECHO], [200, undefined, Object.assign(new Error('big'), { name: 'TooLargeError' })]]);
  assert.equal(big.kind, 'reader');
  assert.match(big.message, /^The relay’s answer is larger than 20 MB.*Copy relay script/);
  const twice = await run([[302, ECHO], [302, ECHO]]);
  assert.equal(twice.kind, 'blocked');
  assert.match(twice.message, /^Google redirected the relay’s answer a second time/);
});

// ---- the store on disk (BotKeeper) -----------------------------------------------------------

const os = require('os');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linebot-'));
const onDisk = (file) => B.readStore(fs.readFileSync(file, 'utf8')).store;
const textsOnDisk = (file) => onDisk(file).messages.map((m) => m.text);

// A relay whose second POST runs `during` first: the moment after round 1 is written.
function relayWithHook(during) {
  const r = fakeRelay({ batch: 2 });
  const send = r.send;
  let posts = 0;
  r.send = async (url, init) => {
    if (init.method === 'POST' && ++posts === 2) during();
    if (init.method === 'GET' && r.failNextGet) {
      r.failNextGet = false;
      throw new Error('socket hang up');
    }
    return send(url, init);
  };
  return r;
}

test('kept messages are never lost to an older copy: a new secret, a new link or an untick after round 1 keeps every message on disk', async () => {
  const gA = idOf('Cgroup-demo-1');
  const gB = idOf('Cgroup-demo-2');
  for (const action of ['secret', 'link', 'untick', 'untick, then round 2 lost on the way back']) {
    const dir = tempDir();
    const file = path.join(dir, 'line-bot-store.json');
    const keeper = new B.BotKeeper({ file });
    let ticked = new Set([gA, gB]);
    keeper.load(ticked);
    const r = relayWithHook(() => {
      if (action === 'secret') keeper.forgetRelay();
      if (action === 'link') keeper.bump();
      if (action.startsWith('untick')) {
        ticked = new Set([gA]);
        keeper.untick(ticked);
      }
      if (action.includes('lost')) r.failNextGet = true;
    });
    r.add(message({ group: 'Cgroup-demo-2', id: `${action}-b`, text: 'in B', ms: at(9, 0) }));
    for (let i = 1; i <= 4; i += 1) r.add(message({ id: `${action}-a${i}`, text: `a${i}`, ms: at(10, i) }));
    const first = await keeper.collect({ link: LINK, secret: SECRET, ticked: () => ticked, send: r.send, now: () => NOW });
    // Round 1 is on disk, whatever happened after it.
    assert.equal(onDisk(file).cursor, keeper.store.cursor, action);
    assert.ok(first.stale || !first.error || (action.includes('lost') && first.error.kind === 'network'), action);
    const second = await keeper.collect({ link: action === 'link' ? { deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` } : LINK, secret: SECRET, ticked: () => ticked, send: r.send, now: () => NOW });
    assert.equal(second.error, undefined, action);
    await keeper.collect({ link: action === 'link' ? { deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` } : LINK, secret: SECRET, ticked: () => ticked, send: r.send, now: () => NOW });
    const want = action.startsWith('untick') ? ['a1', 'a2', 'a3', 'a4'] : ['in B', 'a1', 'a2', 'a3', 'a4'];
    assert.deepEqual(textsOnDisk(file), want, action);
    assert.deepEqual(keeper.store.messages.map((m) => m.text), want, action);
    assert.equal(onDisk(file).cursor, keeper.store.cursor, action);
    // The relay let go of everything, and nothing it let go of is missing.
    assert.equal(r.rows.length, 0, action);
  }
});

test('turning the part off during a collection: nothing is written back afterwards', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const keeper = new B.BotKeeper({ file });
  const ticked = new Set([idOf('Cgroup-demo-1')]);
  keeper.load(ticked);
  const r = relayWithHook(() => keeper.remove());
  for (let i = 1; i <= 4; i += 1) r.add(message({ id: `off-${i}`, text: `t${i}`, ms: at(10, i) }));
  const res = await keeper.collect({ link: LINK, secret: SECRET, ticked: () => ticked, send: r.send, now: () => NOW });
  assert.equal(res.stale, true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(keeper.store.messages, []);
});

test('at start only a cleanly read "off" removes the secret and the store; settings that cannot be read keep both', () => {
  // Read cleanly, off: what was kept goes.
  assert.equal(B.startPlan({ lineRead: 'ok', lineEnabled: false, botRead: 'ok', botOn: true }).drop, true);
  assert.equal(B.startPlan({ lineRead: 'ok', lineEnabled: true, botRead: 'ok', botOn: false }).drop, true);
  // On: kept, and collecting may start.
  assert.deepEqual(B.startPlan({ lineRead: 'ok', lineEnabled: true, botRead: 'ok', botOn: true }), { drop: false, collect: true });
  // Not read (busy, not allowed, cut short): kept, and nothing is collected.
  for (const bad of [{ lineRead: 'unreadable' }, { botRead: 'unreadable' }]) {
    const plan = B.startPlan({ lineRead: 'ok', lineEnabled: false, botRead: 'ok', botOn: false, ...bad });
    assert.deepEqual(plan, { drop: false, collect: false }, JSON.stringify(bad));
  }
  // No settings file yet is not the user's "off" either.
  assert.equal(B.startPlan({ lineRead: 'missing', lineEnabled: false, botRead: 'missing', botOn: false }).drop, false);
});

test('a store that still holds an unticked group’s text loses it when loaded, on disk too; a failed untick write is finished after a restart', () => {
  const gA = idOf('Cgroup-demo-1');
  const gB = idOf('Cgroup-demo-2');
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const first = new B.BotKeeper({ file });
  first.load(new Set([gA, gB]));
  let store = B.takeReply(first.store, { relay: RELAY_A, events: [
    { seq: 1, event: message({ group: 'Cgroup-demo-1', id: 'U1', text: 'A text' }) },
    { seq: 2, event: message({ group: 'Cgroup-demo-2', id: 'U2', text: 'B private', senderName: 'Grandma' }) },
  ], more: false, counts: { missed: 0, refused: 0, notJson: 0, lost: 0 } }, { link: DEPLOY, upTo: 0, ticked: new Set([gA, gB]), now: NOW }).store;
  first.save(store);
  // Untick B, and the write fails.
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  const keeper = new B.BotKeeper({ file, fsys: failing });
  keeper.load(new Set([gA, gB]));
  const said = keeper.untick(new Set([gA]));
  assert.equal(said.saved, false);
  assert.match(fs.readFileSync(file, 'utf8'), /B private/);
  // Restart with B unticked: the load takes it out, on disk.
  const again = new B.BotKeeper({ file });
  again.load(new Set([gA]));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('B private'));
  assert.ok(!text.includes('Grandma'));
  assert.deepEqual(textsOnDisk(file), ['A text']);
  store = null;
});

test('a store the app cannot read is kept aside, said to be possibly lost, and still said after a restart until the part is turned off', () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  fs.writeFileSync(file, '{"version":1,"cursor":');
  const keeper = new B.BotKeeper({ file });
  keeper.load(new Set());
  const aside = fs.readdirSync(dir).filter((n) => /^line-bot-store\.unreadable/.test(n));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"version":1,"cursor":');
  assert.equal(fs.existsSync(file), false);
  const [p] = keeper.problems();
  assert.equal(p.what, 'invalid');
  assert.match(B.botProblems({ on: true, store: keeper.store, storeProblems: keeper.problems(), now: NOW })[0].label, /kept the old file aside; messages kept before may be lost/);
  // A new store is written beside it; the copy is never written over.
  keeper.save(B.emptyStore());
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"version":1,"cursor":');
  const restarted = new B.BotKeeper({ file });
  restarted.load(new Set());
  assert.equal(restarted.problems()[0]?.what, 'invalid');
  restarted.remove();
  assert.deepEqual(fs.readdirSync(dir), []);
  const after = new B.BotKeeper({ file });
  after.load(new Set());
  assert.deepEqual(after.problems(), []);
});

test('a save is flushed to disk before it takes the store’s place; a failed one leaves no half-written copy', () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const calls = [];
  const spy = {
    ...fs,
    fsyncSync: (fd) => { calls.push('fsync'); return fs.fsyncSync(fd); },
    renameSync: (a, b) => { calls.push('rename'); return fs.renameSync(a, b); },
  };
  const keeper = new B.BotKeeper({ file, fsys: spy });
  keeper.load(new Set());
  keeper.save(B.emptyStore());
  assert.deepEqual(calls, ['fsync', 'rename']);
  // A rename that fails: the temp copy (which holds message text) is removed.
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } };
  const k2 = new B.BotKeeper({ file, fsys: failing });
  k2.load(new Set());
  assert.throws(() => k2.save({ ...B.emptyStore(), cursor: 9 }), /denied/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(onDisk(file).cursor, 0);
});

test('half-written copies left by an earlier run are removed at start and when the part is turned off; one that cannot be removed is said', () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  fs.writeFileSync(`${file}.1234.tmp`, 'secret words');
  const keeper = new B.BotKeeper({ file });
  keeper.load(new Set());
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(`${file}.5678.tmp`, 'secret words');
  const stuck = { ...fs, rmSync: (p, o) => { if (String(p).endsWith('.tmp')) throw Object.assign(new Error('in use'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  const k2 = new B.BotKeeper({ file, fsys: stuck });
  k2.load(new Set());
  const left = k2.problems().find((p) => p.what === 'leftover');
  assert.ok(left);
  assert.match(left.detail, /line-bot-store\.json\.5678\.tmp \(EBUSY\)/);
  assert.match(B.botProblems({ on: true, store: k2.store, storeProblems: k2.problems(), now: NOW }).map((p) => p.label).join('\n'), /half-written copy .* could not be removed/);
  // Off: removed, with what could not be said.
  const k3 = new B.BotKeeper({ file });
  k3.load(new Set());
  k3.save(B.emptyStore());
  fs.writeFileSync(`${file}.9.tmp`, 'secret words');
  assert.deepEqual(k3.remove(), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});
