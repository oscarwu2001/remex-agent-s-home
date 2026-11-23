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
// its own language by finding the entries that built it and filling them in
// the window's language with what filled them, each part put in the language
// the same way when it is a sentence of its own (a host, a code or a name
// stays as it is). So core's answers keep their shape and every sentence
// keeps one source per language.
// A sentence can often be split more than one way ("Project list: {what}"
// around "{name} could not be read ({why})", a comma inside a part): every
// split is tried, and the one whose entries explain the most of the
// sentence wins. A sentence no entry built stays English and is told once,
// like a missing word, by a short hash: the log never holds its text.
const SAID = 'said.';
const MOST_SAID = 500;
let patterns = null;
let countRe = null;
const heard = new Map(); // language and sentence -> the sentence in that language
const readings = new Map(); // sentence -> how it was built, or null

export const english = (key, params) => translate(DEFAULT_LANGUAGE, key, params);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function saidPatterns() {
  if (patterns) return patterns;
  patterns = [];
  for (const [key, value] of Object.entries(en)) {
    if (!key.startsWith(SAID)) continue;
    const forms = typeof value === 'object' && value !== null ? Object.entries(value) : [['', value]];
    for (const [form, text] of forms) {
      const parts = String(text).split(/\{(\w+)\}/);
      const lits = parts.filter((_, i) => i % 2 === 0);
      const own = lits.join('');
      patterns.push({ key, one: form === 'one', lits, names: parts.filter((_, i) => i % 2 === 1), literal: own.length, letters: own.replace(/[^A-Za-z]/g, '').length });
    }
  }
  // The longest wording first, so of two readings that explain as much the
  // one that says most in its own words wins (test/i18n.test.js checks every
  // entry reads back as itself).
  patterns.sort((a, b) => b.literal - a.literal);
  // {n} is a count: digits only. {count} is how a count reads: digits, or
  // "at least 3" / "up to 3" when the relay's tally was capped.
  countRe = new RegExp(`^(?:\\d+|${['said.lb.atLeast', 'said.lb.upTo'].map((k) => escapeRe(en[k]).replace('\\{n\\}', '\\d+')).join('|')})$`);
  return patterns;
}

const fits = (name, value, got) => (Object.hasOwn(got, name) ? got[name] === value
  : name === 'n' ? /^\d+$/.test(value) : name === 'count' ? countRe.test(value) : true);

// Every way `text` fills pattern `p`: its literals in order, a part between each two.
function* splits(p, text) {
  const { lits, names } = p;
  const last = lits[lits.length - 1];
  if (!names.length) {
    if (text === lits[0]) yield {};
    return;
  }
  if (!text.startsWith(lits[0]) || !text.endsWith(last) || text.length < lits[0].length + last.length) return;
  const end = text.length - last.length;
  function* from(i, pos, got) {
    const next = lits[i + 1];
    const ats = [];
    if (i === names.length - 1) ats.push(end);
    else for (let at = text.indexOf(next, pos); at !== -1 && at + next.length <= end; at = text.indexOf(next, at + 1)) ats.push(at);
    for (const at of ats) {
      const value = text.slice(pos, at);
      if (at < pos || !fits(names[i], value, got)) continue;
      const now = { ...got, [names[i]]: value };
      if (i === names.length - 1) yield now;
      else yield* from(i + 1, at + next.length, now);
    }
  }
  yield* from(0, lits[0].length, {});
}

// How `text` was built: { score, node } where score counts the letters the
// entries explain, or null. A whole sentence is never read as an entry with
// fewer than four letters of its own ("{words} ({where})"); inside one, such
// an entry is read only when each of its parts is itself a sentence the
// tables built, so text a person or a program wrote keeps its brackets.
// A sentence a caller began lower-case ("not saved: …") is read too.
const OWN_LETTERS = 4;
function read(text, inside, depth) {
  const memo = `${inside ? 1 : 0}${depth}\u0000${text}`;
  if (readings.has(memo)) return readings.get(memo);
  let best = null;
  if (depth < 6) {
    for (const t of text && /^[a-z]/.test(text) ? [text, text[0].toUpperCase() + text.slice(1)] : [text]) {
      for (const p of saidPatterns()) {
        if (!inside && p.letters < OWN_LETTERS) continue;
        for (const got of splits(p, t)) {
          let score = p.letters;
          const params = {};
          let whole = true;
          for (const [name, value] of Object.entries(got)) {
            const r = part(value, depth + 1);
            if (!r.read && p.letters < OWN_LETTERS) whole = false;
            score += r.score;
            params[name] = { ...r.node, raw: value };
          }
          if (!whole) continue;
          if (p.one && !params.n) params.n = { num: 1, raw: '1' };
          if (!best || score > best.score) best = { score, node: { key: p.key, params } };
        }
      }
    }
  }
  if (readings.size >= 4 * MOST_SAID) readings.clear();
  readings.set(memo, best);
  return best;
}

// A part inside a sentence: a count, a sentence or a list of sentences the
// tables built (", " between them), or kept as it is.
function part(value, depth) {
  if (value === '') return { read: true, score: 0, node: { text: '' } };
  if (/^\d+$/.test(value)) return { read: true, score: 0, node: { num: Number(value) } };
  let best = read(value, true, depth);
  const items = value.split(', ');
  if (items.length > 1) {
    const each = items.map((item) => read(item, true, depth + 1));
    const score = each.reduce((a, r) => (r && a !== null ? a + r.score : null), 0);
    if (score !== null && (!best || score > best.score)) best = { score, node: { list: each.map((r) => r.node) } };
  }
  return best ? { read: true, ...best } : { read: false, score: 0, node: { text: value } };
}

function render(lang, node) {
  if ('num' in node) return node.num;
  if ('text' in node) return node.text;
  if (node.list) return node.list.map((n) => render(lang, n)).join(translate(lang, 'common.listSep'));
  const params = {};
  for (const [name, child] of Object.entries(node.params)) params[name] = render(lang, child);
  return translate(lang, node.key, params);
}

// A short, fixed-length name for a sentence the tables did not build, so the
// log can count it without holding its words (a git or file error can name
// a path or a command).
export function sentenceMark(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `said#${h.toString(16).padStart(8, '0')}`;
}

// Parts left as they came that read like a sentence (three words or more):
// an English sentence no entry built, told like a missing word.
function tellUnread(lang, node) {
  if (node.text !== undefined) {
    if ((node.text.match(/[A-Za-z]{2,}/g) ?? []).length >= 3) missing(lang, sentenceMark(node.text));
    return;
  }
  for (const child of node.list ?? Object.values(node.params ?? {})) tellUnread(lang, child);
}

// The entry an English sentence was built from: { key, params } (each part
// as it came) or null.
export function unsay(text, { inside = false } = {}) {
  const r = read(String(text), inside, 0);
  if (!r || !r.node.key) return null;
  return { key: r.node.key, params: Object.fromEntries(Object.entries(r.node.params).map(([name, child]) => [name, child.raw])) };
}

// A sentence from core or the main process in `lang`.
export function sayIn(lang, text) {
  if (text == null || text === '' || lang === DEFAULT_LANGUAGE) return text;
  const s = String(text);
  const k = `${lang}|${s}`;
  if (heard.has(k)) return heard.get(k);
  const r = read(s, false, 0);
  let out = s;
  if (r) {
    out = render(lang, r.node);
    tellUnread(lang, r.node);
  } else missing(lang, sentenceMark(s));
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
