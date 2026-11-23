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
