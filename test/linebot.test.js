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
  assert.equal(h.store.ownRefused, 1);
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
  assert.ok(said.includes('LINE chats: 2 calls to the relay’s webhook were refused in the last 14 days: a wrong key in LINE’s webhook link, or someone else calling the relay. Check that the webhook link in the LINE Developers console ends in ?k= and the relay’s WEBHOOK_KEY (the relay script’s Project Settings → Script properties); if the key is right and the count keeps rising, someone else has the relay’s link: make a new deployment, put its link in LINE’s webhook (with ?k=) and under Relay link in Settings → Connections → LINE chats, then archive the old deployment'), said.join('\n'));
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
  assert.match(B.botProblems({ on: true, store: B.emptyStore(), storeProblems: [{ what: 'invalid' }], now: NOW })[0].label, /not in a shape the app reads, so nothing is collected or changed\. To start afresh, turn off Collect from my LINE bot and turn it on again/);
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
  assert.equal(res.drop, true);
  assert.deepEqual(res.stuck, []);
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
  const why = B.notCollecting({ on: true, stuck: k.stuck, link: k.settings.link, secretSaved: true, storage: null });
  assert.match(why, /saved data can’t be read yet/);
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
  assert.deepEqual(k.load({ lineOff: true }), { drop: true, stuck: [] });
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
  // The version before this one kept `on` apart and the ticks in the store: the store's stand.
  const r3 = olderVersion({ settingsFile: JSON.stringify({ on: true }), storeSettings: { read: [o.gB], link: EXEC } });
  const k3 = new B.BotKeeper({ file: r3.file, legacyFile: r3.legacyFile, now: () => NOW });
  k3.load();
  assert.deepEqual(onDisk(r3.file).settings, { read: [r3.gB], link: EXEC });
  // Its "off" was the user's: the store left with only the link goes.
  const off = olderVersion({ settingsFile: JSON.stringify({ on: false }), storeSettings: { read: [], link: EXEC }, storeText: false });
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
  const said = B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: NOW }).filter((p) => /settings file/.test(p.label));
  assert.equal(said.length, 1);
  assert.match(said[0].label, /settings file could not be read, so its ticks were rebuilt from the groups it kept messages for, and its relay link from the saved secret or the last collection; check them in Settings → Connections → LINE chats$/);
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
  assert.ok(B.botProblems({ on: true, store: k2.store, storeProblems: k2.problems(), now: NOW }).some((p) => /an old copy of the bot’s saved data \(half-written, or kept aside\) could not be removed/.test(p.label)));
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

test('a copy an earlier version kept aside is said until it goes after 14 days; a listing that fails keeps that, says itself and clears', async () => {
  let clock = NOW;
  const h = await seeded();
  const dir = path.dirname(h.file);
  fs.writeFileSync(path.join(dir, `line-bot-store.unreadable-${NOW}.json`), 'old');
  const state = {};
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, state), now: () => clock });
  k.load();
  assert.equal(k.hasAside(), true);
  assert.match(B.untickNote({ aside: k.hasAside() }), /may still hold this group’s messages\. It is deleted after 14 days at most, or when you turn off Collect from my LINE bot\.$/);
  assert.equal(B.untickNote({ aside: false }), null);
  state.noList = true;
  k.housekeep();
  const said = () => B.botProblems({ on: true, store: k.store, storeProblems: k.problems(), now: clock }).map((p) => p.label).join('\n');
  assert.match(said(), /data folder could not be listed/);
  assert.match(said(), /a copy of the bot’s earlier saved data, kept aside because it could not be read/);
  assert.equal(k.hasAside(), true);
  state.noList = false;
  clock = NOW + 15 * 86_400_000;
  k.housekeep();
  assert.doesNotMatch(said(), /could not be listed|kept aside/);
  assert.equal(k.hasAside(), false);
  assert.deepEqual(fs.readdirSync(dir), ['line-bot-store.json']);
});

test('off with a folder that cannot be listed says what it could not remove', async () => {
  const h = await seeded();
  const k = new B.BotKeeper({ file: h.file, fsys: lockedFs(h.file, { noList: true }), now: () => NOW });
  k.load();
  const res = k.remove();
  assert.deepEqual(res.stuck, [{ name: '.', code: 'EMFILE' }]);
  assert.equal(fs.existsSync(h.file), false);
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
  assert.match(token[0], /LINE refused the relay’s LINE_TOKEN, so names are off and groups and senders show as stand-ins; until then your own promises there can’t be found and your own messages may show as mentions\. Issue a new channel access token/);
  // A lookup that failed with names on: "some senders", never the LINE_TOKEN step.
  const g = harness();
  g.relay.add(message({ id: 'NQ1', user: 'Uuser-demo-quiet', text: 'x', nameProblem: 'lookup failed' }));
  await g.collect();
  assert.equal(B.botView({ settings: { on: true, link: '', read: [...g.ticked] }, store: g.store }).nameProblem, true);
  const words = B.botProblems({ on: true, store: g.store, now: NOW }).map((p) => p.label).join('\n');
  assert.match(words, /some senders in your bot’s groups show as stand-ins because LINE gave no name for them/);
  assert.doesNotMatch(words, /put the channel access token/);
});

test('calls with a wrong secret are someone else’s, less the app’s own refused calls', async () => {
  const h = harness();
  await h.collect();
  h.relay.denied = 3;
  await h.collect();
  assert.ok(B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label).includes('LINE chats: 3 calls to the relay had a wrong secret in the last 14 days: someone other than this app. If it goes on, make a new deployment, put its link in LINE’s webhook (with ?k=) and under Relay link in Settings → Connections → LINE chats, then archive the old deployment'));
  // The app's own secret is refused twice (each call raises the count), then saved again; someone else made 3 more.
  const k = harness();
  await k.collect();
  k.relay.secret = 'another';
  assert.equal((await k.collect()).error.kind, 'secret');
  assert.equal((await k.collect()).error.kind, 'secret');
  assert.equal(k.store.ownRefused, 2);
  k.relay.denied = 5;
  k.relay.secret = SECRET;
  await k.collect();
  assert.match(B.botProblems({ on: true, store: k.store, now: NOW }).map((p) => p.label).join('\n'), /^LINE chats: 3 calls to the relay had a wrong secret/m);
  assert.equal(k.store.ownRefused, 0);
});

test('events while the relay could not read its key are said as “up to”, or “at least” when the tally is full', async () => {
  const h = harness();
  await h.collect();
  h.relay.unchecked = 40;
  await h.collect();
  const said = () => B.botProblems({ on: true, store: h.store, now: NOW }).map((p) => p.label).join('\n');
  assert.match(said(), /LINE chats: up to 40 events may have arrived while the relay could not read its key \(some may not be LINE’s\) in the last 14 days; the relay’s Executions in Apps Script show why/);
  h.relay.unchecked = 140;
  h.relay.capped = 1;
  await h.collect();
  assert.match(said(), /LINE chats: at least 140 events may have arrived while the relay could not read its key/);
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
  assert.throws(() => B.relayReply({ ok: false, error: 'not counted' }), (e) => /could not count the events it deleted after 14 days just now, so it sent none/.test(e.message) && B.TRANSIENT.has(e.kind));
});

test('the words name the switch the user sees, never “the bot part”', async () => {
  const h = await seeded();
  const all = Object.keys({ unreadable: 1, invalid: 1, unwritten: 1, damaged: 1, rebuilt: 1, unlisted: 1, leftover: 1, aside: 1, prune: 1 }).map((what) => ({ what, count: 1, detail: '' }));
  const words = [
    ...B.botProblems({ on: true, store: h.store, storeProblems: all, now: NOW }).map((p) => p.label),
    B.untickNote({ aside: true }),
    B.notCollecting({ on: true, stuck: true }),
    B.UNREAD,
  ].join('\n');
  assert.doesNotMatch(words, /bot part/i);
  assert.match(words, /turn off Collect from my LINE bot/);
});
