'use strict';

// LINE chats (src/core/linechat.js): the "Save chat" export parsed, merged
// and searched for what concerns the user. Every line here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/core/linechat');

const exp = (...lines) => lines.join('\n');
const pick = (m) => ({ at: m.at, sender: m.sender, kind: m.kind, text: m.text });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-line-'));

// ---- the export format --------------------------------------------------------

test('a zh-TW export: header, saved line, date line and 24-hour, 上午 and 下午 times', () => {
  const r = L.parseExport(exp(
    '[LINE] 與測試小組的聊天記錄',
    '儲存日期：2026/11/16 12:00',
    '',
    '2026/11/16（一）',
    '09:05\t小明\t早安',
    '上午 10:05\t小華\t今天開會嗎',
    '下午 1:30\t小明\t好',
    '下午12:10\t小華\t午餐',
    '上午12:01\t小華\t半夜',
  ));
  assert.equal(r.chat, '測試小組');
  assert.equal(r.chatFrom, 'header');
  assert.equal(r.savedAt, '2026-11-16 12:00');
  assert.equal(r.unread, 0);
  assert.deepEqual(r.messages.map(pick), [
    { at: '2026-11-16 09:05', sender: '小明', kind: 'text', text: '早安' },
    { at: '2026-11-16 10:05', sender: '小華', kind: 'text', text: '今天開會嗎' },
    { at: '2026-11-16 13:30', sender: '小明', kind: 'text', text: '好' },
    { at: '2026-11-16 12:10', sender: '小華', kind: 'text', text: '午餐' },
    { at: '2026-11-16 00:01', sender: '小華', kind: 'text', text: '半夜' },
  ]);
});

test('the other zh-TW header, "X的聊天", names the chat too', () => {
  assert.equal(L.parseExport(exp('[LINE] 研發群的聊天', '2026/11/16（一）', '09:00\tA\tx')).chat, '研發群');
});

test('an English export: header, "Saved on", weekday-first date and 12-hour times', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with Team Alpha',
    'Saved on: 11/16/2026, 12:00',
    '',
    'Mon, 11/16/2026',
    '9:15 AM\tKen\tMorning',
    '12:05 PM\tAna\tLunch?',
    '12:30 AM\tKen\tLate',
    '1:00 PM\tAna\tBack',
  ));
  assert.equal(r.chat, 'Team Alpha');
  assert.equal(r.savedAt, '2026-11-16 12:00');
  assert.equal(r.unread, 0);
  assert.deepEqual(r.messages.map((m) => m.at), ['2026-11-16 09:15', '2026-11-16 12:05', '2026-11-16 00:30', '2026-11-16 13:00']);
});

test('with no header the file name [LINE] X.txt names the chat', () => {
  const r = L.parseExport(exp('2026/11/16（一）', '09:00\tKen\tHi'), { fileName: '[LINE] Team Beta.txt' });
  assert.equal(r.chat, 'Team Beta');
  assert.equal(r.chatFrom, 'file');
  assert.equal(r.messages.length, 1);
});

test('every known date line sets the day', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with D',
    '2026/11/16(週一)', '08:00\tA\tone',
    '2026.11.17 星期二', '08:00\tA\ttwo',
    'Wed, 11/18/2026', '08:00\tA\tthree',
    '2026.11.19 Thursday', '08:00\tA\tfour',
    '2026/11/20（五）', '08:00\tA\tfive',
  ));
  assert.equal(r.unread, 0);
  assert.deepEqual(r.messages.map((m) => m.at), ['2026-11-16 08:00', '2026-11-17 08:00', '2026-11-18 08:00', '2026-11-19 08:00', '2026-11-20 08:00']);
});

test('a quoted multi-line message is one message, with "" read as a quote', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with Q',
    '2026/11/16（一）',
    '10:00\tKen\t"First line',
    'second line with ""quotes""',
    'last line"',
    '10:01\tAna\t"one line, quoted"',
    '10:02\tAna\t"hi" she said',
  ));
  assert.equal(r.unread, 0);
  assert.deepEqual(r.messages.map((m) => m.text), [
    'First line\nsecond line with "quotes"\nlast line',
    'one line, quoted',
    '"hi" she said',
  ]);
});

test('a quote that never closes costs its one line, and the lines after it still read', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with Q',
    '2026/11/16（一）',
    '10:00\tKen\t"never closed',
    '10:01\tAna\tnext message',
    '10:02\tKen\tand another',
  ));
  assert.equal(r.unread, 1);
  assert.deepEqual(r.messages.map((m) => m.text), ['next message', 'and another']);
});

test('system and media lines are typed, never kept as text', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with S',
    '2026/11/16（一）',
    '10:00\tKen\t[Sticker]',
    '10:01\t小明\t[貼圖]',
    '10:02\tKen\t[Photo]',
    '10:03\t小明\t[照片]',
    '10:04\tKen\t[File]',
    '10:05\t小明\t[檔案]',
    '10:06\tKen\t[Video]',
    '10:07\t小明\t[影片]',
    '10:08\tAna joined the group.',
    '10:09\t\t小華已加入群組',
    '10:10\tAna left the group.',
    '10:11\t小華已退出群組',
    '10:12\tKen\tKen unsent a message.',
    '10:13\t小明已收回訊息',
  ));
  assert.equal(r.unread, 0);
  assert.deepEqual(r.messages.map((m) => m.kind), [
    'sticker', 'sticker', 'photo', 'photo', 'file', 'file', 'video', 'video', 'joined', 'joined', 'left', 'left', 'unsent', 'unsent',
  ]);
  assert.ok(r.messages.every((m) => m.text === ''));
});

test('UTF-8 with a BOM and UTF-16LE with a BOM read the same as plain UTF-8', () => {
  const text = exp('[LINE] 與測試小組的聊天記錄', '2026/11/16（一）', '09:05\t小明\t早安 @Mei');
  const plain = L.parseExport(Buffer.from(text, 'utf8'));
  const bom = L.parseExport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  const wide = L.parseExport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le')]));
  assert.equal(plain.chat, '測試小組');
  for (const r of [bom, wide]) {
    assert.equal(r.chat, plain.chat);
    assert.deepEqual(r.messages.map(pick), plain.messages.map(pick));
    assert.equal(r.unread, 0);
  }
  assert.equal(L.decodeExport(Buffer.from([0xff, 0xfe, 0x41, 0])).encoding, 'utf16le');
});

test('bytes in an encoding the app does not know are refused with kind "encoding", not guessed', () => {
  for (const buf of [Buffer.from([0xfe, 0xff, 0, 0x41]), Buffer.from([0x41, 0xff, 0xfe, 0x80, 0x0a])]) {
    assert.throws(() => L.parseExport(buf), (err) => err instanceof L.LineChatError && err.kind === 'encoding');
  }
});

test('lines in an unknown format are counted, and their words are kept nowhere', () => {
  const r = L.parseExport(exp(
    '[LINE] Chat history with U',
    '09:00\tKen\tbefore any date',
    '2026/11/16（一）',
    'zebra crossing without a time',
    '25:99\tKen\tbad clock',
    '10:00\tKen\tfine',
    '10:01\tsomething nobody knows',
    '[LINE] header late in the file',
  ));
  assert.equal(r.unread, 5);
  assert.deepEqual(r.messages.map((m) => m.text), ['fine']);
  const out = JSON.stringify(r);
  for (const words of ['before any date', 'zebra', 'bad clock', 'nobody knows', 'late in the file']) assert.ok(!out.includes(words), words);
});

test('an empty export says so', () => {
  assert.equal(L.parseExport(Buffer.alloc(0), { fileName: '[LINE] X.txt' }).empty, true);
  assert.equal(L.parseExport('\n  \n', { fileName: '[LINE] X.txt' }).empty, true);
  assert.equal(L.parseExport(exp('[LINE] Chat history with X', '2026/11/16（一）', '10:00\tA\tb')).empty, false);
});

test('readHeader names the chat from the first lines only', () => {
  const h = L.readHeader(Buffer.from(exp('[LINE] Chat history with Team Alpha', 'Saved on: 11/16/2026, 12:00', '', 'Mon, 11/16/2026', '10:00\tKen\tsecret words')), { fileName: 'a.txt' });
  assert.deepEqual(h, { chat: 'Team Alpha', chatFrom: 'header', savedAt: '2026-11-16 12:00' });
  assert.ok(!JSON.stringify(h).includes('secret'));
});

// ---- re-exports ------------------------------------------------------------------

test('re-exports of one chat merge: each message once, the newest file wins, repeats in one minute stay', () => {
  const older = L.parseExport(exp('[LINE] Chat history with M', 'Saved on: 11/15/2026, 18:00', '2026/11/15（日）',
    '17:00\tKen\tok', '17:00\tKen\tok', '17:05\tAna\tsee you'), { fileName: 'old.txt' });
  const newer = L.parseExport(exp('[LINE] Chat history with M', 'Saved on: 11/16/2026, 12:00', '2026/11/15（日）',
    '17:00\tKen\tok', '17:00\tKen\tok', '17:05\tAna\tsee you', '2026/11/16（一）', '09:00\tKen\tnew one'), { fileName: 'new.txt' });
  const other = L.parseExport(exp('[LINE] Chat history with N', '2026/11/16（一）', '09:00\tKen\tnew one'), { fileName: 'n.txt' });
  const chats = L.mergeChats([{ ...newer, file: 'new.txt', mtimeMs: 1 }, { ...older, file: 'old.txt', mtimeMs: 2 }, { ...other, file: 'n.txt', mtimeMs: 3 }]);
  const m = chats.find((c) => c.chat === 'M');
  assert.deepEqual(m.messages.map((x) => `${x.at} ${x.sender} ${x.text}`), [
    '2026-11-15 17:00 Ken ok', '2026-11-15 17:00 Ken ok', '2026-11-15 17:05 Ana see you', '2026-11-16 09:00 Ken new one',
  ]);
  assert.equal(new Set(m.messages.map((x) => x.hash)).size, 4);
  // Newest by its saved line, not by the file's time.
  assert.equal(m.file, 'new.txt');
  assert.deepEqual(m.files, ['new.txt', 'old.txt']);
  assert.equal(chats.find((c) => c.chat === 'N').messages[0].chat, 'N');
});

test('one message gives one hash in every export of it', () => {
  const a = L.parseExport(exp('[LINE] Chat history with M', '2026/11/16（一）', '09:00\tKen\thello'));
  const b = L.parseExport(exp('[LINE] Chat history with M', '2026/11/15（日）', '08:00\tAna\tearlier', '2026/11/16（一）', '09:00\tKen\thello'));
  assert.equal(a.messages[0].hash, b.messages[1].hash);
  assert.notEqual(a.messages[0].hash, b.messages[0].hash);
});

// ---- what concerns the user ----------------------------------------------------------

const chatOf = (...lines) => L.mergeChats([{ ...L.parseExport(exp('[LINE] Chat history with Team', '2026/11/16（一）', ...lines)), file: 't.txt', mtimeMs: 1 }])[0].messages;

test('relatedToYou finds an @mention, a plain mention, a keyword and the user’s own commitment', () => {
  const msgs = chatOf(
    '09:00\tKen\t@Mei can you check the build?',
    '09:01\tAna\tMei, the slides please',
    '09:02\tAna\tThe calibration report is late',
    '09:03\tMei\tI’ll send it tonight',
    '09:04\t梅\t這個我來處理',
    '09:05\tKen\tlunch anyone?',
  );
  const hits = L.relatedToYou(msgs, { names: ['Mei', '梅'], keywords: ['Calibration'], since: 0 });
  assert.deepEqual(hits.map((h) => [h.text, h.reason]), [
    ['這個我來處理', 'commitment'],
    ['I’ll send it tonight', 'commitment'],
    ['The calibration report is late', 'keyword'],
    ['Mei, the slides please', 'mention'],
    ['@Mei can you check the build?', 'mention'],
  ]);
  assert.equal(hits[0].chat, 'Team');
  assert.equal(hits[2].matched, 'Calibration');
});

test('relatedToYou finds nothing in messages that do not concern the user', () => {
  const msgs = chatOf(
    '09:00\tKen\tMeiling will join later',
    '09:01\tMei\tsee you all',
    '09:02\tKen\tI will be late',
    '09:03\tAna\t[Sticker]',
    '09:04\tAna\t@Ken please review',
  );
  assert.deepEqual(L.relatedToYou(msgs, { names: ['Mei'], keywords: ['budget'], since: 0 }), []);
  // No names given: nobody's message is the user's, nothing mentions them.
  assert.deepEqual(L.relatedToYou(chatOf('09:00\tKen\t@Mei hi'), { names: [], keywords: [], since: 0 }), []);
});

test('relatedToYou leaves out messages before "since"', () => {
  const msgs = chatOf('09:00\tKen\t@Mei early', '11:00\tKen\t@Mei late');
  const since = new Date(2026, 10, 16, 10, 0).getTime();
  assert.deepEqual(L.relatedToYou(msgs, { names: ['Mei'], keywords: [], since }).map((h) => h.text), ['@Mei late']);
});

test('draftTodo gives a short to-do and where it came from', () => {
  const [hit] = L.relatedToYou(chatOf(`09:00\tKen\t"@Mei  please check\nthe ${'very '.repeat(40)}long build log"`), { names: ['Mei'], keywords: [], since: 0 });
  const d = L.draftTodo(hit);
  assert.ok(d.text.startsWith('please check the very'), d.text);
  assert.ok(d.text.length <= 120);
  assert.ok(d.text.endsWith('…'));
  assert.deepEqual(d.source, { chat: 'Team', at: '2026-11-16 09:00', sender: 'Ken' });
  const [bare] = L.relatedToYou(chatOf('09:00\tKen\t@Mei'), { names: ['Mei'], keywords: [], since: 0 });
  assert.equal(L.draftTodo(bare).text, 'Reply to Ken in Team');
});

// ---- the folder and its problems ------------------------------------------------------

test('scanFolder lists every export by its header and reads only the ticked chats', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '[LINE] Team Alpha.txt'), exp('[LINE] Chat history with Team Alpha', '2026/11/16（一）', '10:00\tKen\talpha words'));
  fs.writeFileSync(path.join(dir, 'b.txt'), exp('[LINE] Chat history with Team Beta', '2026/11/16（一）', '10:00\tKen\tbeta words'));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'not an export');
  const scan = L.scanFolder(dir, { read: new Set(['Team Beta']) });
  assert.equal(scan.error, null);
  const byChat = Object.fromEntries(scan.files.map((f) => [f.chat, f]));
  assert.deepEqual(Object.keys(byChat).sort(), ['Team Alpha', 'Team Beta']);
  assert.equal(byChat['Team Alpha'].read, false);
  assert.equal(byChat['Team Alpha'].messages, undefined);
  assert.equal(byChat['Team Beta'].messages[0].text, 'beta words');
});

test('scanFolder reads an unticked export only as far as its header', () => {
  const dir = tmpDir();
  const big = exp('[LINE] Chat history with Big', '2026/11/16（一）', ...Array.from({ length: 4000 }, (_, i) => `10:00\tKen\tline ${i}`));
  fs.writeFileSync(path.join(dir, 'big.txt'), big);
  let bytes = 0;
  const fsys = { ...fs, readSync: (...a) => { const n = fs.readSync(...a); bytes += n; return n; }, readFileSync: () => { throw new Error('the whole file was read'); } };
  const scan = L.scanFolder(dir, { read: new Set(), fsys });
  assert.equal(scan.files[0].chat, 'Big');
  assert.ok(bytes <= 8192, `read ${bytes} bytes`);
});

test('a missing folder, an unreadable export, an empty one, a bad encoding and unknown lines all reach Needs attention, as counts', () => {
  const missing = L.scanFolder(path.join(tmpDir(), 'gone'), { read: new Set() });
  const p1 = L.lineProblems({ enabled: true, folder: 'x', scan: missing });
  assert.equal(p1.length, 1);
  assert.match(p1[0].label, /^LINE chats: the exports folder is missing/);
  assert.equal(p1[0].fix, 'line');

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '[LINE] Locked Chat.txt'), exp('[LINE] Chat history with Locked Chat', '2026/11/16（一）', '10:00\tKen\thi'));
  fs.writeFileSync(path.join(dir, '[LINE] Empty Chat.txt'), '');
  fs.writeFileSync(path.join(dir, '[LINE] Odd Bytes.txt'), Buffer.from([0x41, 0xff, 0xfe, 0x80, 0x0a]));
  fs.writeFileSync(path.join(dir, '[LINE] Odd Lines.txt'), exp('[LINE] Chat history with Odd Lines', '2026/11/16（一）', 'Kenji says hello', 'Kenji says bye', '10:00\tKen\tfine'));
  const fsys = { ...fs, openSync: (f, ...a) => { if (f.includes('Locked')) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return fs.openSync(f, ...a); } };
  const scan = L.scanFolder(dir, { read: new Set(['Odd Lines', 'Locked Chat', 'Empty Chat', 'Odd Bytes']), fsys });
  const labels = L.lineProblems({ enabled: true, folder: dir, scan }).map((p) => p.label);
  assert.deepEqual(labels, [
    'LINE chats: 1 export could not be read (EBUSY)',
    'LINE chats: 1 export is in an encoding the app cannot read; save it again from LINE',
    'LINE chats: 1 export is empty',
    'LINE chats: 2 lines in the chats you read are not in a format the app knows, so they were left out',
  ]);
  // Labels are safe on a shared screen: no chat names, no words from a chat.
  for (const l of labels) assert.doesNotMatch(l, /Locked|Empty Chat|Odd|Kenji/);
  assert.deepEqual(L.lineProblems({ enabled: false, folder: dir, scan }), []);
});

// ---- settings -------------------------------------------------------------------

test('settings: names and keywords split on either comma, ticks by chat, marks by hash', () => {
  let s = L.changeSettings(undefined, { enabled: true }).settings;
  s = L.changeSettings(s, { folder: 'D:\\exports' }).settings;
  s = L.changeSettings(s, { names: 'Mei, 梅，  , Mei', keywords: 'calibration、budget' }).settings;
  s = L.changeSettings(s, { tick: { chat: 'Team', on: true } }).settings;
  s = L.changeSettings(s, { mark: { hash: 'abc123', what: 'dismissed' } }, { now: 5 }).settings;
  assert.deepEqual(s, {
    enabled: true, folder: 'D:\\exports', names: ['Mei', '梅'], keywords: ['calibration', 'budget'], read: ['Team'],
    marks: { abc123: { what: 'dismissed', at: 5 } },
  });
  assert.match(L.changeSettings(s, { mark: { hash: 'abc123', what: 'eaten' } }).error, /added or dismissed/);
});

test('turning LINE chats off forgets the chats, the ticks and the added and dismissed items', () => {
  const on = { enabled: true, folder: 'D:\\exports', names: ['Mei'], keywords: ['x'], read: ['Team'], marks: { a: { what: 'added', at: 1 } } };
  const off = L.changeSettings(on, { enabled: false }).settings;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.read, []);
  assert.deepEqual(off.marks, {});
  // Another folder starts with nothing ticked.
  assert.deepEqual(L.changeSettings(on, { folder: 'E:\\other' }).settings.read, []);
  assert.deepEqual(L.changeSettings(on, { folder: 'D:\\exports' }).settings.read, ['Team']);
});

// ---- add to project --------------------------------------------------------------

test('addTodo writes through the project list: re-read, whole file, unknown fields kept', () => {
  const file = path.join(tmpDir(), 'projects.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, owner: 'kept', projects: [{ id: 'p1', name: 'Alpha', mood: 'kept too', todos: [{ id: 't0', text: 'old', done: false, colour: 'kept' }] }] }));
  L.addTodo(file, { project: 'p1', text: 'Check the build log' });
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.owner, 'kept');
  assert.equal(back.projects[0].mood, 'kept too');
  assert.equal(back.projects[0].todos[0].colour, 'kept');
  assert.equal(back.projects[0].todos[1].text, 'Check the build log');
  assert.equal(back.projects[0].todos[1].by, 'you');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['projects.json']);
});

test('addTodo refuses to touch a project list it cannot parse', () => {
  const file = path.join(tmpDir(), 'projects.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => L.addTodo(file, { project: 'p1', text: 'x' }), /cannot be changed: the project list is not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});
