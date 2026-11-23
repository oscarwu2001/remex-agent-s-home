'use strict';

// The word tables and their look-up, for the main process and src/core: the
// renderer's own module (renderer/i18n.js), so every word has one source in
// each language. It is an ES module; Node 22.12 and later (Electron 38 runs
// 22.22) load one with require(). Core's sentences take their language from
// the caller (`lang`), never from Electron.

const i18n = require('../../renderer/i18n.js');

// The system log's one line per word a table lacks, whichever window or
// module asked and however often (rule 5: said, never silent; once, so a
// redraw cannot fill the log), and one line when it stops at `limit`. A key
// is a table's key or a sentence's mark (sentenceMark), never its words.
// Returns whether it wrote.
function missingWordsLog(syslog, limit = 200) {
  const seen = new Set();
  let full = false;
  return (lang, key) => {
    const k = `${lang}|${key}`;
    if (seen.has(k)) return false;
    if (seen.size >= limit) {
      if (!full) syslog.write('errors', 'missing-words-cap', { limit });
      full = true;
      return false;
    }
    seen.add(k);
    syslog.write('errors', 'missing-words', { lang: String(lang).slice(0, 12), key: String(key).slice(0, 120) });
    return true;
  };
}

module.exports = {
  LANGUAGES: i18n.LANGUAGES,
  TABLES: i18n.TABLES,
  DEFAULT_LANGUAGE: i18n.DEFAULT_LANGUAGE,
  translate: i18n.translate,
  en: i18n.english,
  sayIn: i18n.sayIn,
  unsay: i18n.unsay,
  sentenceMark: i18n.sentenceMark,
  trFor: i18n.trFor,
  trHtmlIn: i18n.trHtmlIn,
  raw: i18n.raw,
  escapeHtml: i18n.escapeHtml,
  languageInfo: i18n.languageInfo,
  systemLanguage: i18n.systemLanguage,
  resolveLanguage: i18n.resolveLanguage,
  placeholders: i18n.placeholders,
  onMissing: i18n.onMissing,
  missingWordsLog,
};
