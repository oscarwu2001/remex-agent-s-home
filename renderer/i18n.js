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
export const trFor = (lang) => (key, params) => translate(lang, key, params);

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Markup to put into a trHtml sentence as it is (a button, a <code>).
const RAW = Symbol('raw');
export const raw = (markup) => ({ [RAW]: String(markup) });

// A sentence whose table entry holds markup: params are escaped, unless raw().
export function trHtml(key, params = {}) {
  const text = pick(entry(current, key), params.n);
  if (typeof text !== 'string') return escapeHtml(key);
  return fill(text, params, (v) => (v && typeof v === 'object' && RAW in v ? v[RAW] : escapeHtml(v)));
}

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
