// The board's one way to write a moment, shared by every list that shows
// one: "08:01" today, else the day in the computer's own language and the
// time ("Mon, 16 Nov, 08:01").

export function boardDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function boardTime(value, now = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? t : `${boardDay(d)}, ${t}`;
}
