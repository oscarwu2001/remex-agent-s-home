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
function fakeRelay({ relay = RELAY_A, secret = SECRET, batch = 500, version = B.RELAY_VERSION } = {}) {
  const r = { relay, secret, batch, version, rows: [], next: 1, missed: 0, refused: 0, notJson: 0, calls: [] };
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
    return { ok: true, relay: r.relay, events: out, more: r.rows.length > r.batch, missed: r.missed, refused: r.refused, notJson: r.notJson, ...(r.lost !== undefined ? { lost: r.lost } : {}), ...(r.capped !== undefined ? { capped: r.capped } : {}), ...(r.denied !== undefined ? { denied: r.denied } : {}), ...(r.unchecked !== undefined ? { unchecked: r.unchecked } : {}), ...(r.version ? { version: r.version } : {}) };
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

const os = require('os');
// Every folder made here goes when the file's tests are done.
const made = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linebot-'));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// The bot part on, in a folder of its own, as electron/main.js keeps it
// (BotKeeper): `disk` is the store file's text, `writes` counts the stores
// written, and a write fails while `failWrite` is set. The groups in
// `ticked` are ticked before anything comes.
function harness({ ticked = ['Cgroup-demo-1'], relay = fakeRelay() } = {}) {
  const file = path.join(tempDir(), 'line-bot-store.json');
  const h = { relay, file, writes: 0, failWrite: null };
  h.fsys = {
    ...fs,
    renameSync: (from, to) => {
      if (to === file && h.failWrite) throw h.failWrite;
      fs.renameSync(from, to);
      if (to === file) h.writes += 1;
    },
  };
  h.keeper = new B.BotKeeper({ file, fsys: h.fsys, now: () => NOW });
  h.keeper.turnOn();
  const setRead = (read) => assert.ok(h.keeper.apply(B.applyTicks({ ...h.keeper.store, settings: { ...h.keeper.store.settings, read } }, new Set(read))).ok);
  setRead(ticked.map(idOf));
  assert.ok(h.keeper.setLink(LINK.url).ok);
  for (const key of ['store', 'ticked', 'disk']) {
    Object.defineProperty(h, key, {
      get: () => (key === 'store' ? h.keeper.store : key === 'ticked' ? new Set(h.keeper.settings.read) : fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
    });
  }
  h.tick = (raw, on = true) => {
    const id = idOf(raw);
    setRead([...h.keeper.settings.read.filter((x) => x !== id), ...(on ? [id] : [])]);
  };
  // One collection from `link` (saved first as the relay link, as Settings does).
  h.collect = async (link = LINK, secret = SECRET, secretId = null) => {
    if (h.keeper.settings.link !== link.url) assert.ok(h.keeper.apply({ ...h.keeper.store, settings: { ...h.keeper.store.settings, link: link.url } }).ok);
    const res = await h.keeper.collect({ link, secret, secretId, send: h.relay.send, now: () => NOW });
    return { ...res, store: h.keeper.store };
  };
  // The app starting again: the store as read back from its file.
  h.restart = () => {
    h.keeper = new B.BotKeeper({ file, fsys: h.fsys, now: () => NOW });
    h.keeper.load();
  };
  h.chats = () => B.botChats(h.keeper.store);
  h.writes = 0;
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
  assert.deepEqual(B.botProblems({ on: true, store: h.store, now: NOW }).filter((p) => !/stand-ins/.test(p.label)), []);
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
  // Only the count of the app's own refused calls is written (its share of the relay's wrong-secret count).
  assert.equal(h.writes, 1);
  assert.deepEqual(h.store.ownRefused, { [`link:${DEPLOY}`]: 1 });
  assert.deepEqual(h.store.messages, []);
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
  assert.deepEqual(B.relayReply(good), { relay: RELAY_A, events: [], more: false, counts: { missed: 0, refused: 0, denied: 0, notJson: 0, lost: 0, capped: 0, unchecked: 0 }, version: 0 });
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
  assert.ok(said.includes('LINE chats: 2 calls to the relay’s webhook were refused in the last 14 days: a wrong key in LINE’s webhook link, or someone else calling the relay. Check that the webhook link in the LINE Developers console ends in ?k= and the relay’s WEBHOOK_KEY (the relay script’s Project Settings → Script properties); if the key is right and the count keeps rising, someone else has the relay’s link: in the relay script, Deploy → New deployment; put its link followed by ?k= and WEBHOOK_KEY in LINE’s webhook and under Relay link in Settings → Connections → LINE chats, then archive the old deployment'), said.join('\n'));
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
  assert.ok(said.some((l) => /LINE refused the relay’s LINE_TOKEN: names are off/.test(l)), said.join('\n'));
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
  const unread = B.botProblems({ on: true, store: B.emptyStore(), storeProblems: [{ what: 'unreadable', detail: 'EBUSY' }], now: NOW });
  assert.match(unread[0].label, /the bot’s saved data can’t be read just now, so nothing is collected or changed/);
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
  assert.match(B.botProblems({ on: true, store: B.emptyStore(), storeProblems: [{ what: 'invalid' }], now: NOW })[0].label, /not in a shape the app reads, so nothing is collected or changed, and its messages stay in its file until you turn Collect from my LINE bot off\. To start afresh, turn it off and on again/);
});

test('settings: a link is saved rebuilt (an empty one keeps it), only listed groups tick, and off forgets the ticks and the link', async () => {
  const h = harness({ ticked: [] });
  const k = h.keeper;
  assert.deepEqual(k.setLink(`${OTHER_DEPLOY.replace(/^/, 'https://script.google.com/macros/s/')}/exec?q=1`), { ok: true, changed: true, deploymentId: OTHER_DEPLOY });
  assert.equal(k.settings.link, `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec`);
  assert.deepEqual(k.setLink(`${EXEC}?q=1`), { ok: true, changed: true, deploymentId: DEPLOY });
  assert.equal(k.settings.link, EXEC);
  assert.equal(k.setLink(EXEC).changed, false);
  assert.equal(k.setLink('  ').changed, false);
  assert.equal(k.settings.link, EXEC);
  assert.match(k.setLink('https://example.com').error, /not an Apps Script web app/);
  h.relay.add(message({ id: 'S1', text: 'x' }));
  await h.collect();
  const id = idOf('Cgroup-demo-1');
  assert.deepEqual(k.readGroup(id, true), { ok: true });
  assert.deepEqual(k.settings.read, [id]);
  assert.match(k.readGroup('Cgroup-demo-1', true).error, /^That group is no longer listed; close and reopen Settings\.$/);
  assert.deepEqual(onDisk(h.file).settings, { read: [id], link: EXEC });
  k.remove();
  assert.equal(fs.existsSync(h.file), false);
  assert.deepEqual(k.settings, { read: [], link: '' });
  assert.equal(k.on, false);
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
  // The user saves the secret again (a new id): the cursor is not sent until the relay answers.
  await h.collect(LINK, SECRET, 'new-secret-id');
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
  assert.ok(B.botProblems({ on: true, store: back.store, storeProblems: [{ what: 'damaged', count: 2 }], now: NOW }).some((p) => /^LINE chats: 2 of the bot’s saved entries could not be read and were left out/.test(p.label)));
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

const onDisk = (file) => B.readStore(fs.readFileSync(file, 'utf8')).store;
const textsOnDisk = (file) => onDisk(file).messages.map((m) => m.text);


// ---- review round 2: the store is read before it is ever written --------------------------------

test('the saved secret goes with its half-written copies; one that will not go is said', () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-secret.json');
  fs.writeFileSync(file, 'sealed');
  fs.writeFileSync(`${file}.4321.tmp`, 'sealed');
  fs.writeFileSync(path.join(dir, 'line-bot-secret.json.keep'), 'not ours');
  assert.deepEqual(B.removeSecret({ file }), []);
  assert.deepEqual(fs.readdirSync(dir), ['line-bot-secret.json.keep']);
  fs.writeFileSync(`${file}.9.tmp`, 'sealed');
  const fsys = { ...fs, rmSync: () => { throw Object.assign(new Error('in use'), { code: 'EBUSY' }); } };
  assert.deepEqual(B.removeSecret({ file, fsys }).map((s) => s.code), ['EBUSY', 'EBUSY']);
});

// ---- review round 2: counts and words --------------------------------------------------------

const OTHER_LINK = { deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` };
const said = (store, extra = {}) => B.botProblems({ on: true, store, now: NOW, ...extra });

test('count baselines are kept per relay id: going back to a relay seen before says what rose meanwhile', async () => {
  const relayA = fakeRelay();
  relayA.refused = 2;
  const h = harness({ relay: relayA });
  await h.collect();
  assert.deepEqual(said(h.store), []);
  h.relay = fakeRelay({ relay: RELAY_B });
  await h.collect(OTHER_LINK);
  relayA.refused = 5;
  h.relay = relayA;
  await h.collect();
  assert.ok(said(h.store).some((p) => /^LINE chats: 3 calls to the relay’s webhook were refused/.test(p.label)), said(h.store).map((p) => p.label).join('\n'));
});

test('a refused count the relay had to cap is said as “at least”', async () => {
  const h = harness();
  await h.collect();
  h.relay.refused = 100_000;
  h.relay.capped = 1;
  await h.collect();
  assert.match(said(h.store).map((p) => p.label).join('\n'), /at least 100000 calls to the relay’s webhook were refused/);
  // An older relay's answer has no `capped`; one that is not a count is not the relay's.
  assert.equal(B.relayReply({ ok: true, relay: RELAY_A, events: [], more: false, missed: 0, refused: 0, notJson: 0 }).counts.capped, 0);
  assert.throws(() => B.relayReply({ ok: true, relay: RELAY_A, events: [], more: false, missed: 0, refused: 0, notJson: 0, capped: 'yes' }), (e) => e.kind === 'reader');
});

test('stand-in senders: the LINE_TOKEN step only when the relay sends no names at all; else LINE gave no name for some', async () => {
  const none = harness();
  none.relay.add(message({ id: 'S1', text: 'hello there' }));
  await none.collect();
  const noNames = said(none.store, { ticked: none.ticked }).map((p) => p.label).join('\n');
  assert.match(noNames, /the relay sends no names[^\n]*LINE_TOKEN/);
  const some = harness();
  some.relay.add(message({ id: 'S2', text: 'named', groupName: 'Ward', senderName: 'Ken' }), message({ id: 'S3', user: 'Uuser-demo-quiet', text: 'not named' }));
  await some.collect();
  const someNames = said(some.store, { ticked: some.ticked }).map((p) => p.label).join('\n');
  assert.match(someNames, /some senders in your bot’s groups show as stand-ins because LINE gave no name for them, so your own promises there can’t be found and your own messages may show as mentions/);
  assert.doesNotMatch(someNames, /LINE_TOKEN/);
  const view = B.botView({ settings: { on: true, link: '', read: [...some.ticked] }, store: some.store });
  assert.equal(view.named, true);
  assert.equal(view.standIns, true);
});

test('Needs attention offers Settings only where the fix is, and names it in full', () => {
  const notes = ['ahead', 'restarted', 'broken', 'unusable'].map((what) => ({ what, n: 1, at: NOW }));
  const out = said({ ...B.emptyStore(), notes });
  const fixOf = (re) => out.find((p) => re.test(p.label))?.fix ?? null;
  assert.equal(fixOf(/fewer events than the app had collected/), null);
  assert.equal(fixOf(/is a new one/), null);
  assert.equal(fixOf(/could not be read and was left out/), 'line');
  assert.equal(fixOf(/lacked a group/), 'line');
  assert.match(out.find((p) => /lacked a group/.test(p.label)).label, /press Copy relay script in Settings → Connections → LINE chats/);
  const unnamed = harness();
  assert.equal(said({ ...B.emptyStore(), groups: { [idOf('Cgroup-demo-1')]: { kind: 'group', name: null, namedMs: 0, lastMs: NOW, count: 1 } },
    messages: [{ chat: idOf('Cgroup-demo-1'), hash: 'a'.repeat(16), ms: NOW, kind: 'text', text: 'x', who: 'b'.repeat(16) }] }, { ticked: unnamed.ticked })[0].fix ?? null, null);
});

// ---- review round 3: the store holds the bot's own settings ------------------------------------

const gOne = () => idOf('Cgroup-demo-1');
const gTwo = () => idOf('Cgroup-demo-2');

test('a group’s count or times the app cannot read are counted as damaged', () => {
  const g = idOf('Cgroup-demo-1');
  const text = JSON.stringify({ ...B.emptyStore(), groups: { [g]: { kind: 'group', name: null, namedMs: 'x', lastMs: 'y', count: -2 } } });
  const read = B.readStore(text);
  assert.equal(read.damaged, 2);
  assert.equal(read.store.groups[g].count, 0);
});

test('the first answer after an upgrade writes its baseline', () => {
  const counts = { missed: 0, refused: 0, denied: 0, notJson: 0, lost: 0, capped: 0 };
  // A store from before baselines: its last answer's counts only, the same as this answer's.
  const store = { ...B.emptyStore(), relay: RELAY_A, link: DEPLOY, cursor: 3, counts: { relay: RELAY_A, link: DEPLOY, ...counts }, relayVersion: 3 };
  delete store.baselines;
  const step = B.takeReply(store, { relay: RELAY_A, events: [], more: false, counts, version: 3 }, { link: DEPLOY, upTo: 3, now: NOW });
  assert.equal(step.changed, true);
  assert.ok(step.store.baselines[RELAY_A]);
});

test('with a full tally on the relay, lost events are said as “at least” too', async () => {
  const h = harness();
  await h.collect();
  h.relay.lost = 7;
  h.relay.capped = 1;
  await h.collect();
  assert.match(B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label).join('\n'), /at least 7 events from LINE could not be kept/);
});

// ---- review round 4: one file, one owner ----------------------------------------------------------

const gA4 = () => idOf('Cgroup-demo-1');
const gB4 = () => idOf('Cgroup-demo-2');
const OTHER4 = { deploymentId: OTHER_DEPLOY, url: `https://script.google.com/macros/s/${OTHER_DEPLOY}/exec` };
// An fs whose reads of `file` fail while state.locked, and whose renames over it fail while state.noWrite.
const lockedFs = (file, state) => ({
  ...fs,
  readFileSync: (p, ...a) => {
    if (state.locked && p === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fs.readFileSync(p, ...a);
  },
  renameSync: (from, to) => {
    if (state.noWrite && to === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fs.renameSync(from, to);
  },
  readdirSync: (p, ...a) => {
    if (state.noList) throw Object.assign(new Error('too many'), { code: 'EMFILE' });
    return fs.readdirSync(p, ...a);
  },
});
// A store with group A ticked and two messages kept, group B unticked, written as an app of this version would.
async function seeded() {
  const h = harness({ ticked: ['Cgroup-demo-1'] });
  h.relay.add(message({ id: 'K1', text: 'kept one' }), message({ id: 'K2', text: 'kept two' }), message({ group: 'Cgroup-demo-2', id: 'K3', text: 'not kept' }));
  await h.collect();
  assert.deepEqual(textsOnDisk(h.file), ['kept one', 'kept two']);
  return h;
}
const bytes = (file) => fs.readFileSync(file, 'utf8');
// The seeded relay sends two events a call, and runs `fn` as the
// collection's second call goes out: round 1 written, round 2 on its way.
function duringRound2(h, fn) {
  const send = h.relay.send;
  let posts = 0;
  h.relay.batch = 2;
  h.relay.send = async (url, init) => {
    if (init.method === 'POST' && ++posts === 2) fn();
    return send(url, init);
  };
  return h.relay;
}

test('the store file being there is the part being on: off removes it with the ticks and the link', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const k = new B.BotKeeper({ file, now: () => NOW });
  assert.deepEqual(k.load(), { drop: false });
  assert.equal(k.on, false);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(k.turnOn(), { ok: true });
  assert.equal(k.ready, true);
  assert.deepEqual(onDisk(file).settings, { read: [], link: '' });
  assert.ok(k.setLink(EXEC).ok);
  const again = new B.BotKeeper({ file, now: () => NOW });
  again.load();
  assert.equal(again.ready, true);
  assert.equal(again.settings.link, EXEC);
  const res = again.remove();
  assert.deepEqual(res, { ok: true, drop: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(again.on, false);
  assert.deepEqual(again.settings, { read: [], link: '' });
});

test('a tick or an untick made while a collection waits on the relay stands after it, on disk and in memory', async () => {
  for (const what of ['untick A', 'tick B']) {
    const h = await seeded();
    const r = duringRound2(h, () => {
      const done = what === 'untick A' ? h.keeper.readGroup(gA4(), false) : h.keeper.readGroup(gB4(), true);
      assert.deepEqual(done, { ok: true }, what);
    });
    r.add(message({ id: 'L1', text: 'a three' }), message({ group: 'Cgroup-demo-2', id: 'L2', text: 'b two' }), message({ id: 'L3', text: 'a four' }), message({ group: 'Cgroup-demo-2', id: 'L4', text: 'b three' }));
    await h.collect();
    await h.collect();
    const disk = onDisk(h.file);
    const want = what === 'untick A' ? { read: [], texts: [] } : { read: [gA4(), gB4()], texts: ['kept one', 'kept two', 'a three', 'a four', 'b three'] };
    assert.deepEqual(disk.settings.read, want.read, what);
    assert.deepEqual(disk.messages.map((m) => m.text), want.texts, what);
    assert.deepEqual(h.keeper.store, disk, what);
  }
});

test('a new link or a new secret during a collection: every message is kept, and the old cursor never goes out with the new one', async () => {
  for (const action of ['secret', 'link']) {
    const h = await seeded();
    const r = duringRound2(h, () => {
      if (action === 'link') assert.ok(h.keeper.setLink(OTHER4.url).ok);
    });
    for (let i = 1; i <= 4; i += 1) r.add(message({ id: `${action}-a${i}`, text: `a${i}`, ms: at(10, i) }));
    const first = await h.keeper.collect({ link: LINK, secret: SECRET, send: r.send, now: () => NOW });
    assert.equal(onDisk(h.file).cursor, h.store.cursor, action);
    if (action === 'link') assert.equal(first.stale, true);
    const link = action === 'link' ? OTHER4 : LINK;
    const secretId = action === 'secret' ? 'renewed' : null;
    const before = r.calls.length;
    await h.collect(link, SECRET, secretId);
    // The first call after the change sends 0, with how far the app saved from which relay.
    const body = JSON.parse(r.calls[before].init.body);
    assert.equal(body.upTo, 0, action);
    assert.equal(body.relay, RELAY_A, action);
    await h.collect(link, SECRET, secretId);
    assert.deepEqual(textsOnDisk(h.file), ['a1', 'a2', 'a3', 'a4', 'kept one', 'kept two'], action);
    assert.equal(r.rows.length, 0, action);
  }
});

test('the same relay answering a new secret keeps the saved cursor, so its next call lets go of what the app saved', async () => {
  const h = await seeded();
  const cursor = h.store.cursor;
  h.relay.add(message({ id: 'NS1', text: 'after' }));
  // A relay of an older version ignores what the app says it saved and sends everything again.
  await h.collect(LINK, SECRET, 'new-id');
  assert.equal(h.store.secretId, 'new-id');
  assert.ok(h.store.cursor > cursor);
  h.restart();
  const before = h.relay.calls.length;
  await h.collect(LINK, SECRET, 'new-id');
  assert.equal(JSON.parse(h.relay.calls[before].init.body).upTo, h.store.cursor);
  assert.deepEqual(textsOnDisk(h.file), ['kept one', 'kept two', 'after']);
  // After a restart with yet another secret, the cursor is not sent.
  h.restart();
  const next = h.relay.calls.length;
  await h.collect(LINK, SECRET, 'third-id');
  assert.equal(JSON.parse(h.relay.calls[next].init.body).upTo, 0);
});

test('turning the part off during a collection: nothing is written back afterwards', async () => {
  const h = await seeded();
  const dir = path.dirname(h.file);
  const r = duringRound2(h, () => h.keeper.remove());
  for (let i = 1; i <= 4; i += 1) r.add(message({ id: `off-${i}`, text: `t${i}`, ms: at(10, i) }));
  const res = await h.keeper.collect({ link: LINK, secret: SECRET, send: r.send, now: () => NOW });
  assert.equal(res.stale, true);
  assert.equal(fs.existsSync(h.file), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(h.keeper.store.messages, []);
});

test('a store that can’t be read: on but stuck; a link, a tick or a collection changes nothing on disk and says why; it reads again by itself', async () => {
  const h = await seeded();
  const state = { locked: true };
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, state), now: () => NOW });
  const was = bytes(h.file);
  k.load();
  assert.equal(k.on, true);
  assert.equal(k.stuck, true);
  assert.deepEqual(k.settings, { read: [], link: '' });
  assert.deepEqual(k.setLink(EXEC), { ok: false, error: B.UNREAD });
  assert.deepEqual(k.readGroup(gA4(), false), { ok: false, error: B.UNREAD });
  assert.deepEqual(await k.collect({ link: LINK, secret: SECRET, send: h.relay.send, now: () => NOW }), { waiting: true });
  assert.equal(k.turnOn().ok, true);
  assert.equal(bytes(h.file), was);
  // What the user is told: its saved data can't be read yet, never that no link is saved.
  const why = B.notCollecting({ on: true, stuck: k.stuck && k.state, link: k.settings.link, secretSaved: true, storage: null });
  assert.equal(why, 'the bot’s saved data can’t be read just now; close any app using the app’s data folder. The app reads it again within a minute');
  assert.ok(!why.includes('nothing is collected'));
  const said = B.botProblems({ on: true, store: k.store, notCollecting: why, storeProblems: k.problems(), now: NOW }).map((p) => p.label);
  assert.deepEqual(said, ['LINE chats: the bot’s saved data can’t be read just now, so nothing is collected or changed; close any app using the app’s data folder. The app reads it again within a minute']);
  assert.ok(!said.join('\n').includes('no relay link'));
  state.locked = false;
  k.housekeep();
  assert.equal(k.ready, true);
  assert.deepEqual(k.settings, { read: [gA4()], link: EXEC });
  assert.deepEqual(k.problems(), []);
  assert.equal(bytes(h.file), was);
});

test('a store that is not a store (null, [], {}, garbage) is stuck: nothing is written, moved or copied, and off removes it', () => {
  for (const text of ['null', '[]', '{}', '{"version":2}', 'garbage']) {
    const dir = tempDir();
    const file = path.join(dir, 'line-bot-store.json');
    fs.writeFileSync(file, text);
    const k = new B.BotKeeper({ file, now: () => NOW });
    k.load();
    assert.equal(k.state, 'invalid', text);
    k.housekeep();
    assert.equal(k.setLink(EXEC).ok, false, text);
    assert.deepEqual(fs.readdirSync(dir), ['line-bot-store.json'], text);
    assert.equal(bytes(file), text, text);
    assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW })[0].label, /not in a shape the app reads, so nothing is collected or changed/, text);
    k.remove();
    assert.deepEqual(fs.readdirSync(dir), [], text);
  }
});

test('a change that can’t be written is not taken: memory stays what is on disk, the user is told why, and nothing tries it again', async () => {
  const h = await seeded();
  const state = { noWrite: true };
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, state), now: () => NOW });
  k.load();
  const was = bytes(h.file);
  for (const res of [k.readGroup(gA4(), false), k.setLink(OTHER4.url), k.readGroup(gB4(), true)]) {
    assert.equal(res.ok, false);
    assert.match(res.error, /^Not saved: the bot’s file could not be written \(another program has it open\)\. Try again/);
  }
  assert.deepEqual(k.settings, { read: [gA4()], link: EXEC });
  assert.deepEqual(k.store, onDisk(h.file));
  state.noWrite = false;
  k.housekeep();
  assert.equal(bytes(h.file), was);
  assert.deepEqual(k.store.messages.map((m) => m.text), ['kept one', 'kept two']);
});

test('LINE chats off, read cleanly at start, is the user’s off: the store goes, and the secret with it', async () => {
  const h = await seeded();
  const k = new B.BotKeeper({ file: h.file, now: () => NOW });
  assert.deepEqual(k.load({ lineOff: true }), { drop: true });
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(k.on, false);
});

// The older settings file (line-bot.json) beside a store of the version before (no settings, or settings and `on` apart).
function olderVersion({ settingsFile, storeSettings = false, storeText = true }) {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const legacyFile = path.join(dir, 'line-bot.json');
  const gA = gA4();
  const gB = gB4();
  const store = {
    ...B.emptyStore(), version: 1, link: DEPLOY, relay: RELAY_A, cursor: 3, ...(storeSettings ? { settings: storeSettings } : { settings: undefined }),
    groups: { [gA]: { kind: 'group', name: null, namedMs: 0, lastMs: NOW - 1000, count: 2, members: {} }, [gB]: { kind: 'group', name: null, namedMs: 0, lastMs: NOW - 2000, count: 1, members: {} } },
    messages: storeText ? [
      { chat: gA, hash: 'a'.repeat(16), ms: NOW - 1000, kind: 'text', text: 'in A', who: '' },
      { chat: gB, hash: 'b'.repeat(16), ms: NOW - 2000, kind: 'text', text: 'in B', who: '' },
    ] : [],
  };
  delete store.settings;
  if (storeSettings) store.settings = storeSettings;
  if (storeText !== null) fs.writeFileSync(file, JSON.stringify(store));
  if (settingsFile !== undefined) fs.writeFileSync(legacyFile, settingsFile);
  return { dir, file, legacyFile, gA, gB };
}

test('migration: an older settings file’s ticks and link move into the store, which is then the only one; the older file goes', () => {
  const o = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [gA4()] }) });
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW });
  k.load();
  assert.equal(k.ready, true);
  const disk = onDisk(o.file);
  assert.equal(disk.version, 2);
  assert.deepEqual(disk.settings, { read: [o.gA], link: EXEC });
  assert.deepEqual(disk.messages.map((m) => m.text), ['in A']);
  assert.equal(disk.cursor, 3);
  assert.equal(fs.existsSync(o.legacyFile), false);
  assert.deepEqual(k.problems(), []);
  // Its "off" was the user's: the store left with only the link goes.
  const off = olderVersion({ settingsFile: JSON.stringify({ on: false, link: EXEC, read: [] }), storeText: false });
  const kOff = new B.BotKeeper({ file: off.file, legacyFile: off.legacyFile, now: () => NOW });
  assert.equal(kOff.load().drop, true);
  assert.deepEqual(fs.readdirSync(off.dir), []);
  // No store, an older file saying on: on, with its ticks and link.
  const fresh = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [] }), storeText: null });
  const kFresh = new B.BotKeeper({ file: fresh.file, legacyFile: fresh.legacyFile, now: () => NOW });
  kFresh.load();
  assert.deepEqual(onDisk(fresh.file).settings, { read: [], link: EXEC });
  // A store of this version: an older file left behind is ignored and removed.
  fs.writeFileSync(fresh.legacyFile, JSON.stringify({ on: false }));
  const kAgain = new B.BotKeeper({ file: fresh.file, legacyFile: fresh.legacyFile, now: () => NOW });
  assert.equal(kAgain.load().drop, false);
  assert.equal(kAgain.ready, true);
  assert.equal(fs.existsSync(fresh.legacyFile), false);
});

test('migration with an older settings file that can’t be read: nothing is deleted, the link is rebuilt and the ticks rebuilt from what was kept, and it says so', () => {
  const o = olderVersion({ settingsFile: '{"on": tr' });
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW });
  assert.equal(k.load({ secretFor: OTHER_DEPLOY }).drop, false);
  const disk = onDisk(o.file);
  // Both groups kept text, so both were ticked; the link is the store's own relay's.
  assert.deepEqual(disk.settings, { read: [o.gA, o.gB], link: EXEC });
  assert.deepEqual(disk.messages.map((m) => m.text).sort(), ['in A', 'in B']);
  assert.equal(fs.existsSync(o.legacyFile), false);
  const said = B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).filter((p) => /rebuilt/.test(p.label));
  assert.equal(said.length, 1);
  assert.match(said[0].label, /after the update, the bot’s ticks and relay link from before were not found, so they were rebuilt from the groups it kept messages for and from the saved secret or the last collection; check them in Settings → Connections → LINE chats$/);
  assert.equal(said[0].fix, 'line');
  // No store, but a secret saved: the part was on; its link comes from the secret.
  const s = olderVersion({ settingsFile: 'not json', storeText: null });
  const ks = new B.BotKeeper({ file: s.file, legacyFile: s.legacyFile, now: () => NOW });
  ks.load({ secretFor: OTHER_DEPLOY });
  assert.equal(ks.ready, true);
  assert.equal(ks.settings.link, OTHER4.url);
  // Neither: off, and nothing else is touched.
  const n = olderVersion({ settingsFile: 'not json', storeText: null });
  const kn = new B.BotKeeper({ file: n.file, legacyFile: n.legacyFile, now: () => NOW });
  kn.load();
  assert.equal(kn.on, false);
  assert.deepEqual(fs.readdirSync(n.dir), []);
});

test('migration waits while the store is busy, and while it can’t be written: the older file is kept until the store holds what it had', () => {
  const o = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [gA4()] }) });
  const state = { locked: true, noWrite: false };
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, fsys: lockedFs(o.file, state), now: () => NOW });
  const was = bytes(o.file);
  k.load();
  assert.equal(k.state, 'unreadable');
  assert.equal(bytes(o.file), was);
  assert.ok(fs.existsSync(o.legacyFile));
  Object.assign(state, { locked: false, noWrite: true });
  k.housekeep();
  assert.equal(k.state, 'unwritten');
  assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW })[0].label, /could not be brought up to this version of the app, so nothing is collected or changed/);
  assert.equal(bytes(o.file), was);
  assert.ok(fs.existsSync(o.legacyFile));
  state.noWrite = false;
  k.housekeep();
  assert.equal(k.ready, true);
  assert.deepEqual(onDisk(o.file).settings, { read: [o.gA], link: EXEC });
  assert.equal(fs.existsSync(o.legacyFile), false);
});

test('a save is flushed to disk before it takes the store’s place; a failed one leaves no half-written copy', async () => {
  const h = await seeded();
  const calls = [];
  const spy = {
    ...fs,
    fsyncSync: (fd) => { calls.push('fsync'); return fs.fsyncSync(fd); },
    renameSync: (a, b) => { calls.push('rename'); return fs.renameSync(a, b); },
  };
  const k = new B.BotKeeper({ file: h.file, fsys: spy, now: () => NOW });
  k.load();
  calls.length = 0;
  assert.ok(k.readGroup(gB4(), true).ok);
  assert.deepEqual(calls, ['fsync', 'rename']);
  const failing = { ...fs, fsyncSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
  const k2 = new B.BotKeeper({ file: h.file, fsys: failing, now: () => NOW });
  k2.load();
  assert.equal(k2.readGroup(gB4(), false).ok, false);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['line-bot-store.json']);
});

test('half-written copies left by an earlier run are removed at start and at off; one that cannot be removed is said', async () => {
  const h = await seeded();
  const dir = path.dirname(h.file);
  fs.writeFileSync(path.join(dir, 'line-bot-store.json.123.tmp'), 'half');
  const k = new B.BotKeeper({ file: h.file, now: () => NOW });
  k.load();
  assert.deepEqual(fs.readdirSync(dir), ['line-bot-store.json']);
  fs.writeFileSync(path.join(dir, 'line-bot-store.json.456.tmp'), 'half');
  const stuck = { ...fs, rmSync: (p, o) => { if (String(p).endsWith('.tmp')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  const k2 = new B.BotKeeper({ file: h.file, fsys: stuck, now: () => NOW });
  k2.load();
  assert.ok(B.botProblems({ on: true, store: k2.store, storeProblems: k2.problems(), now: NOW }).some((p) => /a half-written copy of the bot’s saved data could not be deleted; close any app using the app’s data folder\. The app tries again within a minute$/.test(p.label)));
  new B.BotKeeper({ file: h.file, now: () => NOW }).remove();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('text past 14 days leaves the disk and memory at load and every half minute; a removal that keeps failing is said, and tried again', async () => {
  let clock = NOW;
  const h = await seeded();
  const state = { noWrite: false };
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, state), now: () => clock });
  k.load();
  clock = NOW + 15 * 86_400_000;
  state.noWrite = true;
  k.housekeep();
  assert.deepEqual(k.problems(), []);
  assert.equal(k.store.messages.length, 2);
  k.housekeep();
  assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: clock }).map((p) => p.label).join('\n'), /messages older than 14 days could not be removed from the bot’s file just now/);
  state.noWrite = false;
  k.housekeep();
  assert.deepEqual(k.store.messages, []);
  assert.deepEqual(onDisk(h.file).messages, []);
  assert.deepEqual(k.problems(), []);
  // At load too.
  const h2 = await seeded();
  const k2 = new B.BotKeeper({ file: h2.file, now: () => clock });
  k2.load();
  assert.deepEqual(onDisk(h2.file).messages, []);
});

test('a folder listing that fails keeps what was found before and says itself; the next one clears it', async () => {
  const h = await seeded();
  const dir = path.dirname(h.file);
  const state = {};
  const stuckRm = (p) => String(p).endsWith('.tmp');
  const fsys = { ...lockedFs(h.file, state), rmSync: (p, o) => { if (state.noRm && stuckRm(p)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  fs.writeFileSync(path.join(dir, 'line-bot-store.json.77.tmp'), 'half');
  state.noRm = true;
  const k = new B.BotKeeper({ file: h.file, fsys, now: () => NOW });
  k.load();
  const said = () => B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n');
  assert.match(said(), /half-written copy of the bot’s saved data could not be deleted/);
  state.noList = true;
  k.housekeep();
  assert.match(said(), /data folder could not be listed/);
  assert.match(said(), /half-written copy of the bot’s saved data could not be deleted/);
  Object.assign(state, { noList: false, noRm: false });
  k.housekeep();
  assert.doesNotMatch(said(), /could not be listed|could not be deleted/);
  assert.deepEqual(fs.readdirSync(dir), ['line-bot-store.json']);
});
test('off with a folder that cannot be listed says what it could not remove', async () => {
  const h = await seeded();
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, { noList: true }), now: () => NOW });
  k.load();
  const res = k.remove();
  assert.deepEqual(res, { ok: true, drop: true });
  assert.equal(fs.existsSync(h.file), false);
  const label = B.botProblems({ on: false, store: k.store, storeProblems: k.problems(), now: NOW })[0].label;
  assert.ok(label.endsWith(`could not be listed, so half-written copies of the bot’s saved data or secret may be left there; close any app using the app’s data folder and delete any line-bot-store.json.*.tmp and line-bot-secret.json.*.tmp files from ${B.dataDir()}`), label);
});

test('names arriving beside a failed lookup still count as names; a refused token is one row, with what it means', async () => {
  const h = harness();
  h.relay.add(message({ id: 'NP1', text: 'hi', groupName: 'Ward', nameProblem: 'HTTP 403' }), message({ id: 'NP2', user: 'Uuser-demo-quiet', text: 'stand-in' }));
  await h.collect();
  const view = B.botView({ settings: { on: true, link: '', read: [...h.ticked] }, store: h.store });
  assert.equal(view.named, true);
  assert.equal(view.nameProblem, true);
  assert.equal(view.tokenRefused, true);
  const said = B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label);
  const token = said.filter((l) => /LINE_TOKEN|stand-ins/.test(l));
  assert.equal(token.length, 1, said.join('\n'));
  assert.match(token[0], /LINE refused the relay’s LINE_TOKEN: names are off and groups and senders show as stand-ins, so your own promises there can’t be found and your own messages may show as mentions\. To fix it, issue a new channel access token/);
  // A lookup that failed with names on: "some senders", never the LINE_TOKEN step.
  const g = harness();
  g.relay.add(message({ id: 'NQ1', user: 'Uuser-demo-quiet', text: 'x', nameProblem: 'lookup failed' }));
  await g.collect();
  assert.equal(B.botView({ settings: { on: true, link: '', read: [...g.ticked] }, store: g.store }).nameProblem, true);
  const words = B.botProblems({ on: true, store: g.store, now: NOW }).map((p) => p.label).join('\n');
  assert.match(words, /the relay’s name lookups failed, so some senders show as stand-ins and your own promises there can’t be found \(your own messages may show as mentions\); the relay’s Executions/);
  assert.equal(words.split('stand-ins').length, 2, 'one row for the lookups and the stand-ins');
  assert.doesNotMatch(words, /put the channel access token/);
});

test('calls with a wrong secret are someone else’s, less the app’s own refused calls', async () => {
  const h = harness();
  await h.collect();
  h.relay.denied = 3;
  await h.collect();
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label).includes('LINE chats: 3 calls to the relay had a wrong secret in the last 14 days: someone other than this app. If it goes on, in the relay script, Deploy → New deployment; put its link followed by ?k= and WEBHOOK_KEY in LINE’s webhook and under Relay link in Settings → Connections → LINE chats, then archive the old deployment'));
  // The app's own secret is refused twice (each call raises the count), then saved again; someone else made 3 more.
  const k = harness();
  await k.collect();
  k.relay.secret = 'another';
  assert.equal((await k.collect()).error.kind, 'secret');
  assert.equal((await k.collect()).error.kind, 'secret');
  assert.deepEqual(k.store.ownRefused, { [RELAY_A]: 2 });
  k.relay.denied = 5;
  k.relay.secret = SECRET;
  await k.collect();
  assert.match(B.botProblems({ on: true, store: k.store, now: NOW }).map((p) => p.label).join('\n'), /^LINE chats: 3 calls to the relay had a wrong secret/m);
  assert.deepEqual(k.store.ownRefused, {});
});

test('events while the relay could not read its key are said as “up to”, or “at least” when the tally is full', async () => {
  const h = harness();
  await h.collect();
  h.relay.unchecked = 40;
  await h.collect();
  const said = () => B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label).join('\n');
  assert.match(said(), /LINE chats: up to 40 events that reached the relay while it could not read its WEBHOOK_KEY were not kept \(some may not be LINE’s\) in the last 14 days, so messages may be missing; the relay’s Executions in Apps Script show why/);
  h.relay.unchecked = 140;
  h.relay.capped = 1;
  await h.collect();
  assert.match(said(), /LINE chats: at least 140 events that reached the relay while it could not read its WEBHOOK_KEY were not kept/);
});

test('an older relay is said once, with how to update it; settings it could not read are said as its Script properties', async () => {
  const h = harness({ relay: fakeRelay({ version: 0 }) });
  await h.collect();
  const old = B.botProblems({ on: true, store: h.store, now: NOW }).filter((p) => /older version/.test(p.label));
  assert.equal(old.length, 1);
  assert.match(old[0].label, /Copy relay script in Settings → Connections → LINE chats, paste it over the relay’s script, then Deploy → Manage deployments → Edit → Version: New version/);
  assert.equal(old[0].fix, 'line');
  assert.equal(B.botView({ settings: { on: true, link: '', read: [] }, store: h.store }).relayOld, true);
  assert.throws(() => B.relayReply({ ok: false, error: 'settings' }), (e) => /The relay could not read its Script properties; see its Executions in Apps Script/.test(e.message) && B.TRANSIENT.has(e.kind));
  assert.throws(() => B.relayReply({ ok: false, error: 'not counted' }), (e) => /could not count its events older than 14 days just now, so it is holding back newer ones until it can \(they are not lost\)/.test(e.message) && B.TRANSIENT.has(e.kind));
});

test('the words name the switch the user sees, never “the bot part”', async () => {
  const h = await seeded();
  const all = Object.keys({ unreadable: 1, invalid: 1, unwritten: 1, unremoved: 1, damaged: 1, rebuilt: 1, unlisted: 1, leftover: 1, prune: 1 }).map((what) => ({ what, count: 1, detail: '' }));
  const words = [
    ...B.botProblems({ on: true, store: h.store, storeProblems: all, now: NOW }).map((p) => p.label),
    ...['unreadable', 'invalid', 'unwritten', 'unremoved'].map((stuck) => B.notCollecting({ on: true, stuck })),
    B.UNREAD,
  ].join('\n');
  assert.doesNotMatch(words, /bot part/i);
  assert.match(words, /turn Collect from my LINE bot off/);
});

test('migration with no older settings file: a store from before rebuilds its ticks and link and says so; the store’s troubles are said even while off', () => {
  const o = olderVersion({});
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW });
  k.load();
  assert.deepEqual(onDisk(o.file).settings, { read: [o.gA, o.gB], link: EXEC });
  assert.ok(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).some((p) => /after the update, the bot’s ticks and relay link from before were not found, so they were rebuilt/.test(p.label)));
  const off = B.botProblems({ on: false, store: B.emptyStore(), storeProblems: [{ what: 'leftover', detail: 'x' }], now: NOW });
  assert.equal(off.length, 1);
  assert.ok(off[0].label.endsWith(`could not be deleted; close any app using the app’s data folder and delete line-bot-store.json.*.tmp from ${B.dataDir()}`), off[0].label);
});

// ---- review round 5 ------------------------------------------------------------------------

// An fs where removing `held` fails while state.held.
const holdingFs = (held, state) => ({
  ...fs,
  rmSync: (p, o) => {
    if (state.held && path.resolve(String(p)) === path.resolve(held)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fs.rmSync(p, o);
  },
});
const NOT_OFF = (name) => `Not turned off: the bot’s file ${name} could not be removed (another program has it open). Close any app using the app’s data folder and try again.`;

test('off is taken only once the store is gone: a store held open leaves the part, its file and memory as they were', async () => {
  const h = await seeded();
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  k.load();
  const was = bytes(h.file);
  const before = k.store;
  assert.deepEqual(k.remove(), { ok: false, drop: false, error: NOT_OFF('line-bot-store.json'), code: 'line-bot-store.json EBUSY' });
  assert.equal(k.ready, true);
  assert.equal(k.store, before);
  assert.equal(bytes(h.file), was);
  state.held = false;
  assert.deepEqual(k.remove(), { ok: true, drop: true });
  // Nothing brings it back: no half-minute read, no restart.
  k.housekeep();
  assert.equal(k.on, false);
  const again = new B.BotKeeper({ file: h.file, legacyFile: path.join(path.dirname(h.file), 'line-bot.json'), now: () => NOW });
  again.load();
  assert.equal(again.on, false);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), []);
});

test('a leftover line-bot.json held at off stops the off; once it goes, a restart does not bring the part back', async () => {
  const h = await seeded();
  const legacyFile = path.join(path.dirname(h.file), 'line-bot.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ on: true, link: EXEC, read: [] }));
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, legacyFile, fsys: holdingFs(legacyFile, state), now: () => NOW });
  k.load(); // a store of this version ignores it, and could not remove it
  assert.equal(k.ready, true);
  assert.ok(fs.existsSync(legacyFile));
  assert.deepEqual(k.remove(), { ok: false, drop: false, error: NOT_OFF('line-bot.json'), code: 'line-bot.json EBUSY' });
  assert.ok(fs.existsSync(h.file));
  assert.equal(k.ready, true);
  state.held = false;
  assert.equal(k.remove().ok, true);
  const restarted = new B.BotKeeper({ file: h.file, legacyFile, now: () => NOW });
  restarted.load();
  assert.equal(restarted.on, false);
  assert.equal(fs.existsSync(h.file), false);
});

test('an off read from a file at start that cannot be taken leaves the part stuck as it is, and is taken once it can', async () => {
  const h = await seeded();
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  assert.deepEqual(k.load({ lineOff: true }), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(k.state, 'unremoved');
  assert.ok(fs.existsSync(h.file));
  assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW })[0].label, /turning the bot off is not finished: its kept messages, relay link and secret are still on this computer because another program has its file open/);
  state.held = false;
  assert.deepEqual(k.housekeep({ lineOff: true }), { drop: true });
  assert.equal(k.on, false);
});

test('a store whose settings can’t be read keeps every kept message: its ticks and link are rebuilt, written and said', async () => {
  for (const settings of ['broken', { read: 'none', link: EXEC }, null]) {
    const h = await seeded();
    const raw = JSON.parse(bytes(h.file));
    raw.settings = settings;
    fs.writeFileSync(h.file, JSON.stringify(raw));
    const k = new B.BotKeeper({ file: h.file, now: () => NOW });
    k.load({ secretFor: OTHER_DEPLOY });
    assert.equal(k.ready, true);
    assert.deepEqual(onDisk(h.file).settings, { read: [gA4()], link: EXEC }, JSON.stringify(settings));
    assert.deepEqual(textsOnDisk(h.file), ['kept one', 'kept two']);
    const said = B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n');
    assert.match(said, /the bot’s ticks and relay link could not be read, so they were rebuilt/);
    assert.match(said, /1 of the bot’s saved entries could not be read/);
    // The user's next tick settles them: the row goes.
    assert.ok(k.readGroup(gA4(), true).ok);
    assert.doesNotMatch(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n'), /rebuilt/);
  }
  // Ticks that are not group ids are left out and counted; the rest stand.
  const h = await seeded();
  const raw = JSON.parse(bytes(h.file));
  raw.settings.read.push('not-a-group', 42);
  const back = B.readStore(JSON.stringify(raw));
  assert.deepEqual(back.store.settings.read, [gA4()]);
  assert.equal(back.damaged, 2);
});

test('a line-bot.json that is busy is waited for, never taken as lost: nothing is rebuilt or removed until it reads', () => {
  for (const code of ['EBUSY', 'EPERM']) {
    const o = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [gA4()] }) });
    const state = { busy: true };
    const fsys = { ...fs, readFileSync: (p, ...a) => { if (state.busy && p === o.legacyFile) throw Object.assign(new Error('busy'), { code }); return fs.readFileSync(p, ...a); } };
    const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, fsys, now: () => NOW });
    const was = bytes(o.file);
    k.load();
    assert.equal(k.state, 'unreadable', code);
    assert.equal(bytes(o.file), was, code);
    assert.ok(fs.existsSync(o.legacyFile), code);
    assert.ok(!k.problems().some((p) => p.what === 'rebuilt'), code);
    state.busy = false;
    k.housekeep();
    assert.equal(k.ready, true, code);
    assert.deepEqual(onDisk(o.file).settings, { read: [o.gA], link: EXEC }, code);
    assert.equal(fs.existsSync(o.legacyFile), false, code);
  }
});

test('a 14-day cleanup that can’t be written at start leaves the part working; it is tried every half minute and said only once it keeps failing', async () => {
  let clock = NOW;
  const h = await seeded();
  clock = NOW + 15 * 86_400_000;
  const state = { noWrite: true };
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, state), now: () => clock });
  k.load();
  assert.equal(k.ready, true);
  assert.deepEqual(k.problems(), []);
  k.housekeep();
  assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: clock }).map((p) => p.label).join('\n'), /messages older than 14 days could not be removed from the bot’s file just now/);
  state.noWrite = false;
  k.housekeep();
  assert.deepEqual(onDisk(h.file).messages, []);
  assert.deepEqual(k.problems(), []);
});

test('a collection still waiting on the relay across off, on and the same link merges nothing into the new store', async () => {
  const h = await seeded();
  const r = duringRound2(h, () => {
    assert.equal(h.keeper.remove().ok, true);
    assert.equal(h.keeper.turnOn().ok, true);
    assert.equal(h.keeper.setLink(EXEC).ok, true);
  });
  for (let i = 1; i <= 4; i += 1) r.add(message({ id: `S5-${i}`, text: `t${i}` }));
  const res = await h.keeper.collect({ link: LINK, secret: SECRET, send: r.send, now: () => NOW });
  assert.equal(res.stale, true);
  assert.deepEqual(onDisk(h.file).messages, []);
  assert.equal(onDisk(h.file).cursor, 0);
  assert.deepEqual(h.keeper.store, onDisk(h.file));
});

test('the app’s own refused calls are subtracted only from the relay at the link they went to', () => {
  const reply = (relay, denied) => B.relayReply({ ok: true, version: 3, relay, events: [], more: false, missed: 0, refused: 0, denied, notJson: 0, lost: 0, capped: 0 });
  const take = (s, r, link) => B.takeReply(s, r, { link, upTo: 0, now: NOW }).store;
  const sum = (s) => s.notes.filter((n) => n.what === 'denied').reduce((a, n) => a + n.n, 0);
  let s = take(take(B.emptyStore(), reply(RELAY_B, 0), OTHER_DEPLOY), reply(RELAY_A, 0), DEPLOY);
  s = { ...s, ownRefused: { [RELAY_A]: 3 } };
  s = take(s, reply(RELAY_B, 3), OTHER_DEPLOY);
  assert.equal(sum(s), 3);
  s = { ...s, ownRefused: { [RELAY_A]: 1 } };
  s = take(s, reply(RELAY_A, 1), DEPLOY);
  assert.equal(sum(s), 3);
});

test('a failed turn-on says why and carries the code for the system log', () => {
  const dir = tempDir();
  const file = path.join(dir, 'line-bot-store.json');
  const k = new B.BotKeeper({ file, fsys: lockedFs(file, { noWrite: true }), now: () => NOW });
  k.load();
  const res = k.turnOn();
  assert.deepEqual(res, { ok: false, error: 'Not saved: the bot’s file could not be written (another program has it open). Try again; if it keeps failing, close any app using the app’s data folder.', code: 'EBUSY' });
  assert.equal(k.on, false);
});

// ---- review round 6 ------------------------------------------------------------------------

test('LINE chats off is written first: a failed write changes nothing; a held store leaves the off not finished, tried again whatever the switches show', async () => {
  const h = await seeded();
  const was = bytes(h.file);
  const k = new B.BotKeeper({ file: h.file, now: () => NOW });
  k.load();
  assert.throws(() => k.offWithLine(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }), /disk full/);
  assert.equal(k.ready, true);
  assert.equal(bytes(h.file), was);
  const state = { held: true };
  const k2 = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  k2.load();
  let wrote = false;
  assert.deepEqual(k2.offWithLine(() => { wrote = true; }), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(wrote, true);
  assert.equal(k2.state, 'unremoved');
  assert.equal(bytes(h.file), was);
  assert.equal(B.botProblems({ on: true, store: k2.store, storeProblems: k2.problems(), now: NOW })[0].label, 'LINE chats: turning the bot off is not finished: its kept messages, relay link and secret are still on this computer because another program has its file open. Close any app using the app’s data folder; the app finishes within a minute of the file being freed');
  assert.equal(B.notCollecting({ on: true, stuck: k2.state }), 'turning the bot off is not finished, because the bot’s saved data could not be removed; close any app using the app’s data folder. The app tries again within a minute');
  assert.deepEqual(k2.housekeep(), { drop: false, code: 'line-bot-store.json EBUSY' });
  state.held = false;
  assert.deepEqual(k2.housekeep(), { drop: true });
  assert.equal(k2.on, false);
  assert.equal(fs.existsSync(h.file), false);
});

test('kept text means ticked: a damaged tick never costs a group its messages, and the mismatch is written and said', async () => {
  for (const damage of ['one character', 'a number']) {
    const h = await seeded();
    const raw = JSON.parse(bytes(h.file));
    const gA = gA4();
    raw.settings.read = damage === 'one character' ? [`${gA.slice(0, -1)}${gA.endsWith('0') ? '1' : '0'}`] : [42];
    fs.writeFileSync(h.file, JSON.stringify(raw));
    const k = new B.BotKeeper({ file: h.file, now: () => NOW });
    k.load();
    assert.deepEqual(onDisk(h.file).settings.read, [gA], damage);
    assert.equal(onDisk(h.file).rebuilt, 'ticks', damage);
    h.keeper = k;
    h.relay.add(message({ id: `T6-${damage}`, text: 'after' }));
    await h.collect();
    assert.deepEqual(textsOnDisk(h.file), ['kept one', 'kept two', 'after'], damage);
    assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n'), /the bot’s ticks did not match the messages it kept, so they were rebuilt from the groups it kept messages for/, damage);
  }
});

test('the rebuilt notice is kept in the store until the user changes a tick or the link, across restarts; with no link it asks for one', () => {
  const o = olderVersion({});
  const raw = JSON.parse(bytes(o.file));
  raw.link = null;
  fs.writeFileSync(o.file, JSON.stringify(raw));
  new B.BotKeeper({ file: o.file, now: () => NOW }).load();
  const k = new B.BotKeeper({ file: o.file, now: () => NOW });
  k.load();
  const said = () => B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n');
  assert.match(said(), /after the update, the bot’s ticks and relay link from before were not found, so the ticks were rebuilt from the groups it kept messages for; check the ticks and paste the relay link in Settings → Connections → LINE chats$/m);
  assert.ok(k.setLink(EXEC).ok);
  assert.doesNotMatch(said(), /rebuilt/);
  const again = new B.BotKeeper({ file: o.file, now: () => NOW });
  again.load();
  assert.equal(again.store.rebuilt, null);
});

test('an older file saying off goes after the store, so a store held at that off cannot come back at a restart', () => {
  const o = olderVersion({ settingsFile: JSON.stringify({ on: false, link: EXEC, read: [] }) });
  const state = { held: true };
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, fsys: holdingFs(o.file, state), now: () => NOW });
  assert.deepEqual(k.load(), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(k.state, 'unremoved');
  assert.ok(fs.existsSync(o.legacyFile));
  const restarted = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW });
  assert.deepEqual(restarted.load(), { drop: true });
  assert.deepEqual(fs.readdirSync(o.dir), []);
});

test('the app’s own refused calls stay counted for their relay while another link answers', () => {
  const reply = (relay, denied) => B.relayReply({ ok: true, version: 3, relay, events: [], more: false, missed: 0, refused: 0, denied, notJson: 0, lost: 0, capped: 0 });
  const take = (s, r, link) => B.takeReply(s, r, { link, upTo: 0, now: NOW }).store;
  const sum = (s) => s.notes.filter((n) => n.what === 'denied').reduce((a, n) => a + n.n, 0);
  let s = take(take(B.emptyStore(), reply(RELAY_A, 0), DEPLOY), reply(RELAY_B, 0), OTHER_DEPLOY);
  s = { ...s, ownRefused: { [RELAY_A]: 2 } };
  s = take(s, reply(RELAY_B, 0), OTHER_DEPLOY);
  assert.deepEqual(s.ownRefused, { [RELAY_A]: 2 });
  s = take(s, reply(RELAY_A, 2), DEPLOY);
  assert.equal(sum(s), 0);
  assert.deepEqual(s.ownRefused, {});
});

test('a line-bot.json that can’t be removed is said when it happens, with where to delete it', async () => {
  const h = await seeded();
  const legacyFile = path.join(path.dirname(h.file), 'line-bot.json');
  fs.writeFileSync(legacyFile, '{}');
  const k = new B.BotKeeper({ file: h.file, legacyFile, fsys: holdingFs(legacyFile, { held: true }), now: () => NOW });
  k.load();
  assert.match(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).map((p) => p.label).join('\n'), /the bot’s settings file from before the update \(line-bot\.json\) could not be removed; close any app using the app’s data folder and delete it from /);
  assert.ok(B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).some((p) => p.label.endsWith(`delete it from ${B.dataDir()}`)));
  assert.match(k.remove().error, /^Not turned off: the bot’s file line-bot\.json could not be removed \(another program has it open\)/);
  const odd = { ...fs, rmSync: () => { throw Object.assign(new Error('odd'), { code: 'EIO' }); } };
  const k2 = new B.BotKeeper({ file: h.file, fsys: odd, now: () => NOW });
  k2.load();
  assert.equal(k2.remove().error, 'Not turned off: the bot’s file line-bot-store.json could not be removed; the system log has the reason. Try again.');
});

// ---- review round 7 ------------------------------------------------------------------------

test('LINE chats off with the bot’s store held: the off is not finished, says why, and is finished once the store is freed', async () => {
  const h = await seeded();
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  k.load();
  assert.deepEqual(k.offWithLine(() => {}), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(k.unfinished, 'held');
  const shown = B.botView({ settings: { on: k.on, link: k.settings.link, read: k.settings.read }, store: k.store, stuck: k.stuck, unfinished: k.unfinished });
  assert.equal(shown.unfinished, 'held');
  assert.ok(fs.existsSync(h.file));
  state.held = false;
  assert.deepEqual(k.housekeep(), { drop: true });
  assert.equal(k.unfinished, null);
  // Another cause than a held file: said as that.
  const h2 = await seeded();
  const odd = { ...fs, rmSync: (p, o) => { if (path.resolve(String(p)) === path.resolve(h2.file)) throw Object.assign(new Error('odd'), { code: 'EIO' }); return fs.rmSync(p, o); } };
  const k2 = new B.BotKeeper({ file: h2.file, fsys: odd, now: () => NOW });
  k2.load();
  assert.deepEqual(k2.offWithLine(() => {}), { drop: false, code: 'line-bot-store.json EIO' });
  assert.equal(k2.unfinished, 'failed');
});

test('a taken off names what would not go: a half-written copy of the store or of the secret, the secret, or a folder it could not list', async () => {
  const SECRET_FILE = 'line-bot-secret.json';
  // The store's half-written copy is held.
  const h = await seeded();
  const copy = path.join(path.dirname(h.file), 'line-bot-store.json.999.tmp');
  fs.writeFileSync(copy, 'half');
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(copy, { held: true }), now: () => NOW });
  k.load();
  assert.deepEqual(k.remove(), { ok: true, drop: true });
  const secretFile = path.join(path.dirname(h.file), SECRET_FILE);
  fs.writeFileSync(secretFile, 'sealed');
  assert.deepEqual(B.offLeft({ storeProblems: k.problems(), secretStuck: B.removeSecret({ file: secretFile }), secretBase: SECRET_FILE }), ['storeCopy']);
  // The secret's half-written copy is held.
  const dir = tempDir();
  const sf = path.join(dir, SECRET_FILE);
  fs.writeFileSync(sf, 'sealed');
  fs.writeFileSync(`${sf}.999.tmp`, 'sealed copy');
  const copyStuck = B.removeSecret({ file: sf, fsys: holdingFs(`${sf}.999.tmp`, { held: true }) });
  assert.deepEqual(B.offLeft({ secretStuck: copyStuck, secretBase: SECRET_FILE }), ['secretCopy']);
  assert.equal(B.secretLeftWords(copyStuck, SECRET_FILE), `LINE chats: a half-written copy of the bot’s secret could not be deleted; close any app using the app’s data folder and delete line-bot-secret.json.*.tmp from ${B.dataDir()}`);
  // The secret itself is held: the row says what to delete and where, with privacy on.
  fs.writeFileSync(sf, 'sealed');
  const secretStuck = B.removeSecret({ file: sf, fsys: holdingFs(sf, { held: true }) });
  assert.deepEqual(B.offLeft({ secretStuck, secretBase: SECRET_FILE }), ['secret']);
  assert.equal(B.secretLeftWords(secretStuck, SECRET_FILE), `LINE chats: the bot’s secret could not be deleted; close any app using the app’s data folder and delete line-bot-secret.json (and any line-bot-secret.json.*.tmp) from ${B.dataDir()}`);
  // A folder that could not be listed: copies may be left.
  assert.deepEqual(B.offLeft({ storeProblems: [{ what: 'unlisted' }], secretStuck: [{ name: '.', code: 'EMFILE' }], secretBase: SECRET_FILE }), ['unlisted']);
  assert.deepEqual(B.offLeft({ storeProblems: [], secretStuck: [], secretBase: SECRET_FILE }), []);
});

test('LINE chats can’t be turned on while the bot’s off is not finished, so a restart still finishes it once the store is freed', async () => {
  const h = await seeded();
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  k.load();
  k.offWithLine(() => {});
  assert.deepEqual(k.lineOn(), { ok: false, error: 'LINE chats can’t be turned on until turning the bot off is finished (see below).', code: 'line-bot-store.json EBUSY' });
  assert.equal(k.unfinished, 'held');
  assert.ok(fs.existsSync(h.file));
  // A restart with LINE chats still off (its file was never turned on) tries the off again.
  const restarted = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  assert.deepEqual(restarted.load({ lineOff: true }), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(restarted.ready, false);
  state.held = false;
  const freed = new B.BotKeeper({ file: h.file, now: () => NOW });
  assert.deepEqual(freed.load({ lineOff: true }), { drop: true });
  assert.equal(fs.existsSync(h.file), false);
  // Pressed once the file is freed: the off finishes then, and LINE chats may go on.
  assert.deepEqual(k.lineOn(), { ok: true, drop: true });
  assert.deepEqual(k.lineOn(), { ok: true });
});

test('ticks moved from 67909b5 for groups its store had not seen are kept as groups with nothing kept yet, and stay ticked at the next start', () => {
  const gC = idOf('Cgroup-demo-9');
  const o = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [gA4(), gC] }) });
  new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW }).load();
  assert.deepEqual(onDisk(o.file).settings.read, [o.gA, gC]);
  assert.deepEqual(onDisk(o.file).groups[gC], { kind: 'group', name: null, namedMs: 0, lastMs: 0, count: 0 });
  const again = new B.BotKeeper({ file: o.file, now: () => NOW });
  again.load();
  assert.deepEqual(again.settings.read, [o.gA, gC]);
  assert.equal(again.store.rebuilt, null);
  const noStore = olderVersion({ settingsFile: JSON.stringify({ on: true, link: EXEC, read: [gC] }), storeText: null });
  new B.BotKeeper({ file: noStore.file, legacyFile: noStore.legacyFile, now: () => NOW }).load();
  const later = new B.BotKeeper({ file: noStore.file, now: () => NOW });
  later.load();
  assert.deepEqual(later.settings.read, [gC]);
});

test('the app’s own refused calls follow the relay last seen at the link, so the same relay at a new link is not blamed for them', async () => {
  const k = harness();
  await k.collect();
  k.relay.secret = 'another';
  await k.collect();
  await k.collect();
  assert.deepEqual(k.store.ownRefused, { [RELAY_A]: 2 });
  const reply = B.relayReply({ ok: true, version: 3, relay: RELAY_A, events: [], more: false, missed: 0, refused: 0, denied: 2, notJson: 0, lost: 0, capped: 0 });
  const s = B.takeReply(k.store, reply, { link: OTHER_DEPLOY, upTo: 0, now: NOW }).store;
  assert.equal(s.notes.filter((n) => n.what === 'denied').length, 0);
  assert.deepEqual(s.ownRefused, {});
});

test('an older settings file that is not settings, with no store, is said as it is removed', () => {
  const o = olderVersion({ settingsFile: '{"on": true, "read": [', storeText: null });
  const k = new B.BotKeeper({ file: o.file, legacyFile: o.legacyFile, now: () => NOW });
  assert.deepEqual(k.load(), { drop: false });
  assert.equal(k.on, false);
  assert.equal(fs.existsSync(o.legacyFile), false);
  const said = B.botProblems({ on: false, store: k.store, storeProblems: k.problems(), now: NOW });
  assert.deepEqual(said.map((p) => p.label), ['LINE chats: the bot’s settings file from before the update (line-bot.json) could not be read, so its ticks and relay link were not kept and Collect from my LINE bot is off; to use the bot, turn it on in Settings → Connections → LINE chats and paste the relay link and secret']);
  assert.equal(said[0].fix, 'line');
  assert.ok(k.turnOn().ok);
  assert.deepEqual(k.problems(), []);
});

test('an own-refused count or a rebuilt notice the app can’t read is counted as damaged', () => {
  const base = { ...B.emptyStore(), cursor: 0 };
  assert.equal(B.readStore(JSON.stringify({ ...base, ownRefused: 'x' })).damaged, 1);
  assert.equal(B.readStore(JSON.stringify({ ...base, ownRefused: { [RELAY_A]: -1, [RELAY_B]: 2 } })).damaged, 1);
  assert.deepEqual(B.readStore(JSON.stringify({ ...base, ownRefused: { [RELAY_A]: -1, [RELAY_B]: 2 } })).store.ownRefused, { [RELAY_B]: 2 });
  assert.equal(B.readStore(JSON.stringify({ ...base, rebuilt: 'bogus' })).damaged, 1);
  assert.equal(B.readStore(JSON.stringify({ ...base, rebuilt: 'ticks', ownRefused: { [`link:${DEPLOY}`]: 1 } })).damaged, 0);
});

test('the data folder is named for the platform, and Needs attention says an unfinished off by its cause, as Settings does', () => {
  assert.equal(B.dataDir('win32'), '%APPDATA%\\Agents Home');
  assert.equal(B.dataDir('darwin'), '~/Library/Application Support/Agents Home');
  assert.equal(B.dataDir('linux'), '~/.config/Agents Home');
  const said = (why) => B.botProblems({ on: true, store: B.emptyStore(), storeProblems: [{ what: 'unremoved', detail: '', why }], now: NOW })[0].label;
  assert.equal(said('held'), 'LINE chats: turning the bot off is not finished: its kept messages, relay link and secret are still on this computer because another program has its file open. Close any app using the app’s data folder; the app finishes within a minute of the file being freed');
  assert.equal(said('failed'), 'LINE chats: turning the bot off is not finished: its kept messages, relay link and secret are still on this computer because its file could not be removed (the system log has the reason). The app tries again within a minute');
});

// ---- review round 8 ------------------------------------------------------------------------

test('an unfinished off survives a restart whatever LINE chats’ settings say: its own record keeps it pending until it is finished', async () => {
  const h = await seeded();
  const offFile = path.join(path.dirname(h.file), 'line-bot-store-off.json');
  const state = { held: true };
  const k = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  k.load();
  assert.deepEqual(k.offWithLine(() => {}), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.ok(fs.existsSync(offFile), 'recorded before the removal starts');
  // Closed; at the next start LINE chats' settings can't be read, so nothing says LINE chats is off.
  const restarted = new B.BotKeeper({ file: h.file, fsys: holdingFs(h.file, state), now: () => NOW });
  assert.deepEqual(restarted.load({ lineOff: false }), { drop: false, code: 'line-bot-store.json EBUSY' });
  assert.equal(restarted.ready, false, 'the store is not loaded');
  assert.equal(restarted.unfinished, 'held');
  assert.deepEqual(restarted.store.messages, []);
  assert.deepEqual(restarted.lineOn(), { ok: false, error: 'LINE chats can’t be turned on until turning the bot off is finished (see below).', code: 'line-bot-store.json EBUSY' });
  assert.deepEqual(restarted.turnOn(), { ok: false, error: 'Collect from my LINE bot can’t be turned on until turning the bot off is finished (see below).' });
  assert.ok(fs.existsSync(h.file));
  // Freed: the half-minute retry finishes it, and the record goes last.
  state.held = false;
  assert.deepEqual(restarted.housekeep(), { drop: true });
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(fs.existsSync(offFile), false);
  const later = new B.BotKeeper({ file: h.file, now: () => NOW });
  assert.deepEqual(later.load({ lineOff: false }), { drop: false });
  assert.equal(later.on, false);
});

test('an off whose record can’t be written is not started: the store stays as it was, and the reply says so', async () => {
  const h = await seeded();
  const offFile = path.join(path.dirname(h.file), 'line-bot-store-off.json');
  const was = bytes(h.file);
  const noRecord = { ...fs, openSync: (p, ...a) => { if (path.resolve(String(p)) === path.resolve(offFile)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.openSync(p, ...a); } };
  const k = new B.BotKeeper({ file: h.file, fsys: noRecord, now: () => NOW });
  k.load();
  let wrote = false;
  assert.deepEqual(k.offWithLine(() => { wrote = true; }), { drop: false, notStarted: true, code: 'line-bot-store-off.json EACCES' });
  assert.equal(wrote, true);
  assert.equal(k.ready, true);
  assert.equal(k.unfinished, null);
  assert.equal(bytes(h.file), was);
  assert.equal(fs.existsSync(offFile), false);
});

test('an own-refused count kept by 5aa5c18 under the bare deployment id is read as that link’s, not as damage', () => {
  const read = B.readStore(JSON.stringify({ ...B.emptyStore(), cursor: 0, ownRefused: { [DEPLOY]: 2, [RELAY_A]: 1 } }));
  assert.equal(read.damaged, 0);
  assert.deepEqual(read.store.ownRefused, { [`link:${DEPLOY}`]: 2, [RELAY_A]: 1 });
});
