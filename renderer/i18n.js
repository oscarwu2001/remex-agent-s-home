// Every word the app shows, in each language it speaks: English and
// Traditional Chinese for Taiwan. The words live in one table per language
// (renderer/i18n/en.js and zh-TW.js, keyed alike); this module looks them up,
// fills their {placeholders} and picks a plural form. The renderer imports
// it; the main process and src/core load this same file through
// src/core/i18n.js, so each word is written once for both.
//
// A table entry is a string, or { one, other } for words that change with a
// count (`n`). Entries used with trHtml may hold markup; tr's never do.

import en from './i18n/en.js';
import zhTW from './i18n/zh-TW.js';

// Each language named in its own words, as the Language setting lists them.
export const LANGUAGES = [
  { id: 'en', name: 'English', html: 'en', dates: undefined },
  { id: 'zh-TW', name: '繁體中文', html: 'zh-Hant-TW', dates: 'zh-TW' },
];
export const TABLES = { en, 'zh-TW': zhTW };
export const DEFAULT_LANGUAGE = 'en';

let current = DEFAULT_LANGUAGE;
let tell = () => {};
const told = new Set();

export function setLanguage(id) {
  current = Object.hasOwn(TABLES, id) ? id : DEFAULT_LANGUAGE;
  return current;
}
export const language = () => current;
export const languageInfo = (id = current) => LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0];

// fn(lang, key) hears of each word a table lacks, once per language and key,
// so it can go to the system log (rule 5). The word falls back to English.
export function onMissing(fn) {
  tell = typeof fn === 'function' ? fn : () => {};
}

function missing(lang, key) {
  const k = `${lang}\u0000${key}`;
  if (told.has(k)) return;
  told.add(k);
  try {
    tell(lang, key);
  } catch {
    // The log's own failure must not stop a redraw; the word has already
    // fallen back, and the log keeps its own record of failed writes.
  }
}

function entry(lang, key) {
  const table = Object.hasOwn(TABLES, lang) ? TABLES[lang] : en;
  if (Object.hasOwn(table, key)) return table[key];
  missing(lang, key);
  return lang !== DEFAULT_LANGUAGE && Object.hasOwn(en, key) ? en[key] : undefined;
}

const pick = (value, n) => (typeof value === 'object' && value !== null ? (n === 1 && value.one !== undefined ? value.one : value.other) : value);

function fill(text, params, show) {
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? show(params[name]) : whole));
}

// The words for `key` in `lang`, with params put in place. A key no table
// has shows as itself, so it is seen and said, never silently blank.
export function translate(lang, key, params = {}) {
  const text = pick(entry(lang, key), params.n);
  return typeof text === 'string' ? fill(text, params, String) : key;
}

export const tr = (key, params) => translate(current, key, params);

// ---- what core and the main process say ----------------------------------------
// The main process and src/core say their sentences in English (the log and
// their tests read them so), each built from a `said.*` entry of the English
// table with english() (en() in src/core/i18n.js). The window puts one in
// its own language by finding the entry that built it and filling that
// entry in the window's language with what filled it, each of those put in
// the language the same way when it is a sentence of its own (a host, a
// code or a name stays as it is). So core's answers keep their shape and
// every sentence keeps one source per language.
// A sentence no entry built stays English and is told once, like a missing word.
const SAID = 'said.';
const MOST_SAID = 500;
let patterns = null;
const heard = new Map(); // language and sentence -> the sentence in that language

export const english = (key, params) => translate(DEFAULT_LANGUAGE, key, params);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function saidPatterns() {
  if (patterns) return patterns;
  patterns = [];
  for (const [key, value] of Object.entries(en)) {
    if (!key.startsWith(SAID)) continue;
    const forms = typeof value === 'object' && value !== null ? Object.entries(value) : [['', value]];
    for (const [form, text] of forms) {
      const names = [];
      const source = String(text).split(/(\{\w+\})/).map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        if (!name) return escapeRe(part);
        if (names.includes(name)) return `\\k<${name}>`;
        names.push(name);
        // {n} is a count, so a sentence that starts with one cannot swallow a list before it.
        return name === 'n' ? '(?<n>\\d+)' : `(?<${name}>[\\s\\S]*?)`;
      }).join('');
      const own = String(text).replace(/\{\w+\}/g, '');
      patterns.push({ key, one: form === 'one', re: new RegExp(`^${source}$`), literal: own.length, letters: own.replace(/[^A-Za-z]/g, '').length });
    }
  }
  // The longest wording first, so a sentence is read as the entry that says
  // most of it (test/i18n.test.js checks every entry reads back as itself).
  patterns.sort((a, b) => b.literal - a.literal);
  return patterns;
}

// The entry an English sentence was built from: { key, params } or null.
// A sentence a caller began lower-case ("Not saved: this computer...") is
// read as its entry too. A whole sentence is never read as an entry with
// fewer than four letters of its own ("{words} ({where})"): those are only
// the parts inside another (inside: true).
const OWN_LETTERS = 4;
export function unsay(text, { inside = false } = {}) {
  const s = String(text);
  for (const t of s && /^[a-z]/.test(s) ? [s, s[0].toUpperCase() + s.slice(1)] : [s]) {
    for (const p of saidPatterns()) {
      if (!inside && p.letters < OWN_LETTERS) continue;
      const m = p.re.exec(t);
      if (!m) continue;
      const params = { ...m.groups };
      if (p.one && params.n === undefined) params.n = '1';
      return { key: p.key, params };
    }
  }
  return null;
}

// A list of sentences (", " between them) is put in the language item by
// item when every item is one; anything else inside a sentence stays as it is.
function sayList(lang, text, depth) {
  const items = text.split(', ');
  if (items.length < 2 || !items.every((item) => unsay(item, { inside: true }))) return text;
  return items.map((item) => sayInner(lang, item, depth + 1)).join(translate(lang, 'common.listSep'));
}

function sayInner(lang, text, depth) {
  if (/^\d+$/.test(text)) return Number(text);
  const found = depth < 6 && text ? unsay(text, { inside: depth > 0 }) : null;
  if (!found) return depth < 6 && text ? sayList(lang, text, depth) : text;
  const params = {};
  for (const [name, value] of Object.entries(found.params)) params[name] = sayInner(lang, value, depth + 1);
  return translate(lang, found.key, params);
}

// A sentence from core or the main process in `lang`.
export function sayIn(lang, text) {
  if (text == null || text === '' || lang === DEFAULT_LANGUAGE) return text;
  const s = String(text);
  const k = `${lang}|${s}`;
  if (heard.has(k)) return heard.get(k);
  let out = s;
  if (unsay(s)) out = sayInner(lang, s, 0);
  else missing(lang, `said: ${s.slice(0, 60)}`);
  if (heard.size >= MOST_SAID) heard.clear();
  heard.set(k, out);
  return out;
}
export const said = (text) => sayIn(current, text);
// Whether the tables have words for `key`, for words that may come from elsewhere.
export const hasWords = (key) => Object.hasOwn(en, key);

// About how wide a line of text draws, for SVG labels sized before they
// render: `latin` px for each other character, `wide` for each Chinese one.
const WIDE = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
export const textWidth = (text, latin, wide) => [...String(text)].reduce((w, c) => w + (WIDE.test(c) ? wide : latin), 0);
export const trFor = (lang) => (key, params) => translate(lang, key, params);

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Markup to put into a trHtml sentence as it is (a button, a <code>).
const RAW = Symbol('raw');
export const raw = (markup) => ({ [RAW]: String(markup) });

// A sentence whose table entry holds markup: params are escaped, unless raw().
export function trHtmlIn(lang, key, params = {}) {
  const text = pick(entry(lang, key), params.n);
  if (typeof text !== 'string') return escapeHtml(key);
  return fill(text, params, (v) => (v && typeof v === 'object' && RAW in v ? v[RAW] : escapeHtml(v)));
}
export const trHtml = (key, params) => trHtmlIn(current, key, params);

// Both windows' fixed words: data-i18n="key" sets an element's text (with
// data-i18n-n as its count), data-i18n-html its markup, data-i18n-title
// (aria-label, placeholder) that attribute; <html lang> follows the language.
const ATTRS = ['title', 'aria-label', 'placeholder'];
export function localise(root = document) {
  if (root.documentElement) root.documentElement.lang = languageInfo().html;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = tr(el.dataset.i18n, el.dataset.i18nN === undefined ? {} : { n: Number(el.dataset.i18nN) });
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = trHtml(el.dataset.i18nHtml);
  for (const attr of ATTRS) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, tr(el.getAttribute(`data-i18n-${attr}`)));
  }
}

// Windows' own language (or the browser's): Traditional Chinese for
// Taiwan, Hong Kong and any zh-Hant, English for everything else. Only the
// first, the display language, counts.
export function systemLanguage(list = []) {
  const first = String((Array.isArray(list) ? list[0] : list) ?? '').replace(/_/g, '-').toLowerCase();
  return /^zh-(tw|hk|hant)(-|$)/.test(first) ? 'zh-TW' : 'en';
}

// The language to show: the one the user picked, else Windows'. A saved
// choice that cannot be read (the settings unreadable, or a language this
// version does not know) falls back to Windows' language and says so.
export function resolveLanguage({ saved, unreadable = false, system = [] } = {}) {
  if (!unreadable && saved === undefined) return { id: systemLanguage(system), from: 'system' };
  if (!unreadable && typeof saved === 'string' && Object.hasOwn(TABLES, saved)) return { id: saved, from: 'saved' };
  return { id: systemLanguage(system), from: 'system', unreadable: true };
}

// The dates' own locale: the computer's for English (as before), Taiwan's for Chinese.
export const dateLocale = () => languageInfo().dates;

// Every {placeholder} an entry names, across its plural forms.
export function placeholders(value) {
  const forms = typeof value === 'object' && value !== null ? Object.values(value) : [value];
  return new Set(forms.flatMap((f) => [...String(f).matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
}
