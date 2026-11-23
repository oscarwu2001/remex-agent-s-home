'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemLog } = require('../src/core/syslog');

const load = () => import('../renderer/i18n.js');

test('every word has an entry in both languages, with the same placeholders and plural forms', async () => {
  const { TABLES, placeholders } = await load();
  const en = TABLES.en;
  const zh = TABLES['zh-TW'];
  assert.deepEqual(Object.keys(zh).filter((k) => !(k in en)), [], 'keys only Chinese has');
  assert.deepEqual(Object.keys(en).filter((k) => !(k in zh)), [], 'keys only English has');
  for (const key of Object.keys(en)) {
    assert.deepEqual([...placeholders(zh[key])].sort(), [...placeholders(en[key])].sort(), `placeholders of ${key}`);
    for (const value of [en[key], zh[key]]) {
      if (typeof value === 'object') assert.equal(typeof value.other, 'string', `${key} has an "other" form`);
      else assert.equal(typeof value, 'string', `${key} is words`);
    }
  }
});

test('a word is put together from its entry: placeholders filled, the plural form chosen by n', async () => {
  const { translate } = await load();
  assert.equal(translate('en', 'overview.sessions', { n: 1 }), '1 session');
  assert.equal(translate('en', 'overview.sessions', { n: 3 }), '3 sessions');
  assert.equal(translate('zh-TW', 'overview.sessions', { n: 3 }), '3 個工作階段');
  assert.equal(translate('en', 'wait.tip', { project: 'p', what: 'Your turn', for: '5 min' }), 'p: Your turn, for 5 min');
  assert.equal(translate('en', 'clock.weatherIn', {}), 'Weather in {place}', 'a value not given stays marked');
});

test('a word missing from a table falls back to English and is told once, with no crash', async () => {
  const i18n = await load();
  const told = [];
  i18n.onMissing((lang, key) => told.push(`${lang}:${key}`));
  const key = 'test.onlyEnglish';
  i18n.TABLES.en[key] = 'Only in English';
  try {
    i18n.setLanguage('zh-TW');
    assert.equal(i18n.tr(key), 'Only in English');
    assert.equal(i18n.tr(key), 'Only in English');
    assert.deepEqual(told, ['zh-TW:test.onlyEnglish']);
    assert.equal(i18n.tr('test.nowhere'), 'test.nowhere', 'a key no table has shows as itself');
    assert.deepEqual(told, ['zh-TW:test.onlyEnglish', 'zh-TW:test.nowhere']);
    i18n.onMissing(() => { throw new Error('log gone'); });
    assert.equal(i18n.tr('test.nowhere.either'), 'test.nowhere.either', 'a failing log does not break the look-up');
  } finally {
    delete i18n.TABLES.en[key];
    i18n.onMissing(null);
    i18n.setLanguage('en');
  }
});

test('a word missing from a table is one line in the system log, however often it is asked for', () => {
  const { missingWordsLog } = require('../src/core/i18n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-i18n-'));
  const log = new SystemLog(dir);
  const tell = missingWordsLog(log);
  assert.equal(tell('zh-TW', 'mini.now'), true);
  assert.equal(tell('zh-TW', 'mini.now'), false);
  assert.equal(tell('zh-TW', 'mini.tabs'), true);
  const lines = log.tail('errors');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /missing-words\s+lang=zh-TW key=mini\.now$/);
});

test('markup sentences escape what is put in, unless it is markup of the app\'s own', async () => {
  const { trHtml, raw, setLanguage } = await load();
  setLanguage('en');
  assert.equal(trHtml('clash.html', { n: 2, project: '<b>x</b>' }).includes('&lt;b&gt;x&lt;/b&gt;'), true);
  assert.equal(trHtml('clash.html', { n: 2, project: raw('<em>x</em>') }).includes('<em>x</em>'), true);
});

test('Windows\' language picks the first run\'s: zh-TW, zh-Hant and zh-HK are Chinese, everything else English', async () => {
  const { systemLanguage } = await load();
  for (const tag of ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh-Hant-HK', 'zh_TW', 'ZH-tw']) assert.equal(systemLanguage([tag, 'en-US']), 'zh-TW', tag);
  for (const tag of ['en-US', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh', 'ja-JP', 'zh-TWX', '']) assert.equal(systemLanguage([tag, 'zh-TW']), 'en', tag || '(empty)');
  assert.equal(systemLanguage([]), 'en');
  assert.equal(systemLanguage(undefined), 'en');
});

test('the saved language wins; none saved follows Windows; one that cannot be read follows Windows and says so', async () => {
  const { resolveLanguage, translate } = await load();
  assert.deepEqual(resolveLanguage({ saved: 'en', system: ['zh-TW'] }), { id: 'en', from: 'saved' });
  assert.deepEqual(resolveLanguage({ saved: 'zh-TW', system: ['en-US'] }), { id: 'zh-TW', from: 'saved' });
  assert.deepEqual(resolveLanguage({ system: ['zh-Hant-TW'] }), { id: 'zh-TW', from: 'system' });
  assert.deepEqual(resolveLanguage({ saved: 'fr', system: ['zh-HK'] }), { id: 'zh-TW', from: 'system', unreadable: true });
  assert.deepEqual(resolveLanguage({ saved: null, system: ['en-GB'] }), { id: 'en', from: 'system', unreadable: true });
  assert.deepEqual(resolveLanguage({ unreadable: true, saved: 'en', system: ['zh-TW'] }), { id: 'zh-TW', from: 'system', unreadable: true });
  // What is said, in the language it fell back to.
  assert.match(translate('zh-TW', 'language.unreadable'), /Windows/);
  assert.match(translate('en', 'language.unreadable'), /could not be read/);
});

test('main and src/core read the same tables as the renderer', async () => {
  const core = require('../src/core/i18n');
  const { TABLES } = await load();
  assert.equal(core.translate('zh-TW', 'settings.title'), TABLES['zh-TW']['settings.title']);
  assert.deepEqual(core.LANGUAGES.map((l) => [l.id, l.name]), [['en', 'English'], ['zh-TW', '繁體中文']]);
});

test('rooms, departments and gardens are named by id; names the user wrote stay as written', async () => {
  const { setLanguage } = await load();
  const { placeWords, gardenWords } = await import('../renderer/places.js');
  const { roomsWith, gardensWith, validateLayout } = require('../src/core/rooms');
  const layout = validateLayout({
    departments: [{ kind: 'spine', cell: [3, 1] }, { kind: 'custom', name: 'Hand Surgery', cell: [-1, 1] }, { kind: 'neuro', name: 'Brain team', cell: [1, 3] }],
    gardens: [{ cell: [3, 2] }, { cell: [-1, 2], name: 'Rose court' }],
  });
  const rooms = Object.fromEntries(roomsWith(layout).map((r) => [r.name, r]));
  const gardens = gardensWith(layout);
  setLanguage('zh-TW');
  try {
    assert.deepEqual(placeWords(rooms["Nurses' Station"]), { name: '護理站', purpose: '你的 Claude Code 主要工作階段' });
    assert.deepEqual(placeWords(rooms['Spine Surgery']), { name: '脊椎外科', purpose: '導航脊椎固定' });
    assert.deepEqual(placeWords(rooms['Hand Surgery']), { name: 'Hand Surgery', purpose: '你的科別' });
    assert.deepEqual(placeWords(rooms['Brain team']), { name: 'Brain team', purpose: '顱內導航' });
    assert.deepEqual(gardens.map(gardenWords), ['花園', '樹林', '花園 1', 'Rose court']);
  } finally {
    setLanguage('en');
  }
  assert.deepEqual(placeWords(rooms['Spine Surgery']), { name: 'Spine Surgery', purpose: 'Navigated spinal fixation' });
  assert.deepEqual(gardens.map(gardenWords), ['Garden', 'Grove', 'Garden 1', 'Rose court']);
});

test('a tool call is said in the window\'s language; one from an older copy, with no key, as it came', async () => {
  const { setLanguage } = await load();
  const { statusText } = await import('../renderer/status.js');
  const { describeTool } = require('../src/core/activity');
  setLanguage('zh-TW');
  try {
    assert.equal(statusText({ status: 'working', activity: describeTool('Read', { file_path: 'a/b.txt' }) }), '正在讀取檔案');
    assert.equal(statusText({ status: 'delegating', activity: describeTool('Agent', { subagent_type: 'reviewer' }) }), '交給 reviewer');
    assert.equal(statusText({ status: 'working', activity: { label: 'Reading a file' } }), 'Reading a file');
  } finally {
    setLanguage('en');
  }
  assert.equal(statusText({ status: 'delegating', activity: describeTool('Agent', { subagent_type: 'reviewer' }) }), 'With reviewer');
  assert.equal(describeTool('mcp__', {}).label, 'Using a connector');
});

test('a sign is sized for its words: Chinese characters take a whole em', async () => {
  const { textWidth } = await load();
  assert.equal(textWidth('Radiology', 11.5, 20), 9 * 11.5);
  assert.equal(textWidth('放射科', 11.5, 20), 60);
  assert.equal(textWidth('CMF 科', 10, 20), 4 * 10 + 20);
});

test('every sentence core says reads back as the entry that built it, filled as it was', async () => {
  const { TABLES, unsay, placeholders } = await load();
  const said = Object.entries(TABLES.en).filter(([key]) => key.startsWith('said.'));
  assert.ok(said.length > 100, 'core\'s sentences are in the table');
  const fillers = ['said.main.upToDate', 'said.fs.columnsSaved', 'said.projects.notDate', 'said.projects.giveName'].map((k) => TABLES.en[k]);
  for (const [key, value] of said) {
    for (const [form, text] of typeof value === 'object' ? Object.entries(value) : [['', value]]) {
      assert.doesNotMatch(text, /\}\{/, `${key}: two placeholders side by side cannot be told apart`);
      const names = [...placeholders(text)];
      // An entry with fewer than four letters of its own holds sentences the tables built; any other, any words.
      const own = text.replace(/\{\w+\}/g, '').replace(/[^A-Za-z]/g, '').length;
      const params = Object.fromEntries(names.map((name, i) => [name, name === 'n' ? (form === 'one' ? 1 : 7) : name === 'count' ? 'at least 7'
        : own < 4 ? fillers[i] : `‹${i} with words›`]));
      const filled = text.replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
      const found = unsay(filled, { inside: true });
      assert.equal(found?.key, key, `${key}${form ? ` (${form})` : ''} reads back as itself`);
      for (const name of names) assert.equal(String(found.params[name]), String(params[name]), `${key}: {${name}}`);
    }
  }
});

test('a sentence from core is put in the window\'s language, with the sentences inside it', async () => {
  const { sayIn } = await load();
  const core = require('../src/core/i18n');
  const ignored = core.en('said.main.layoutIgnored', { reason: core.en('said.main.notJson') });
  assert.equal(ignored, 'layout.json ignored: it is not valid JSON; showing the core hospital', 'English as before');
  assert.equal(sayIn('en', ignored), ignored);
  assert.equal(sayIn('zh-TW', ignored), '未採用 layout.json：它不是有效的 JSON；先顯示基本醫院');
  const one = core.en('said.main.promptsNotRemoved', { n: 1, again: core.en('said.main.pruneAgain') });
  assert.equal(one, 'LINE chats: 1 saved prompt could not be removed; close any app using the app\'s line-prompts folder, and the app tries again within the hour');
  assert.match(sayIn('zh-TW', one), /^LINE 聊天：有 1 份已存提示無法移除；.*App 會在一小時內再試$/);
  const code = core.en('said.main.layoutNotSaved', { code: 'EBUSY' });
  assert.equal(sayIn('zh-TW', code), '無法儲存配置（EBUSY）', 'a code stays as it is');
});

test('a core sentence Chinese lacks, and one no entry built, stay English and are told once', async () => {
  const i18n = await load();
  const core = require('../src/core/i18n');
  const told = [];
  i18n.onMissing((lang, key) => told.push(`${lang}:${key}`));
  const zh = i18n.TABLES['zh-TW'];
  const kept = zh['said.main.upToDate'];
  delete zh['said.main.upToDate'];
  try {
    const text = core.en('said.main.upToDate');
    assert.equal(i18n.sayIn('zh-TW', text), 'Already up to date.');
    assert.equal(i18n.sayIn('zh-TW', `${text} `), 'Already up to date. ', 'and nothing else is read into it');
    const inside = core.en('said.main.updateFailed', { why: text });
    assert.equal(i18n.sayIn('zh-TW', inside), '更新沒有完成：Already up to date.', 'the sentence around it is still Chinese');
    assert.deepEqual(told.filter((t) => t.endsWith('said.main.upToDate')), ['zh-TW:said.main.upToDate'], 'told once');
    assert.equal(i18n.sayIn('zh-TW', 'Words from somewhere else'), 'Words from somewhere else');
    assert.equal(i18n.sayIn('zh-TW', 'Words from somewhere else'), 'Words from somewhere else');
    assert.deepEqual(told.filter((t) => t.includes(i18n.sentenceMark('Words from somewhere else'))), [`zh-TW:${i18n.sentenceMark('Words from somewhere else')}`], 'told once, by a mark');
    assert.ok(told.every((t) => !t.includes('somewhere')), 'the log never holds the sentence');
  } finally {
    zh['said.main.upToDate'] = kept;
    i18n.onMissing(null);
  }
});

test('a list of sentences inside one is put in the language item by item; a list with anything else stays as it is', async () => {
  const { sayIn } = await load();
  const core = require('../src/core/i18n');
  const parts = [core.en('said.fs.unread.scores', { n: 2 }), core.en('said.fs.unread.numbers', { n: 1 })];
  const text = core.en('said.fs.unread.total', { n: 3, parts: parts.join(', ') });
  assert.equal(text, '3 answers could not be read: 2 scores that are not a whole number on its scale, 1 answer that is not a number', 'English as before');
  assert.equal(sayIn('zh-TW', text), '有 3 個答案無法讀取：2 個不是量表上整數的分數、1 個不是數字的答案');
  const mixed = core.en('said.fs.unread.total', { n: 3, parts: `${parts[0]}, a name of the user's` });
  assert.equal(sayIn('zh-TW', mixed), `有 3 個答案無法讀取：${parts[0]}, a name of the user's`);
});

test('a whole sentence is never read as a part with fewer than four letters of its own, so one no entry built is told', async () => {
  const i18n = await load();
  const told = [];
  i18n.onMissing((lang, key) => told.push(key));
  try {
    assert.equal(i18n.unsay('Words from elsewhere (and a reason)'), null, 'not "{words} ({where})"');
    assert.equal(i18n.unsay('Words from elsewhere (and a reason)', { inside: true }), null, 'nor inside one, when its parts are not sentences the tables built');
    assert.equal(i18n.sayIn('zh-TW', 'Words from elsewhere (and a reason)'), 'Words from elsewhere (and a reason)');
    assert.deepEqual(told, [i18n.sentenceMark('Words from elsewhere (and a reason)')]);
  } finally {
    i18n.onMissing(null);
  }
});
