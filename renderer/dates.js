// The board's one way to write a moment, shared by every list that shows
// one: "08:01" today, else the day and the time ("Mon, 16 Nov, 08:01"): in
// the computer's own language with English words, in Taiwan's with Chinese.

import { tr, dateLocale } from './i18n.js';

export function boardDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

// The clock's time: as the computer writes it in English, 24-hour in
// Chinese, where the part of the day beside it already says morning or night.
export function clockTime(date) {
  if (dateLocale()) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function boardTime(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? t : tr('date.dayTime', { day: boardDay(d), time: t });
}
