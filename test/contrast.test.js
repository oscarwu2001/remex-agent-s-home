'use strict';

// Every text pair in renderer/tokens.css, in every colourway, day and night,
// measures 4.5:1 or better (WCAG AA for body text).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'tokens.css'), 'utf8');

function blocks() {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const vars = Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((v) => [v[1], v[2]]));
    if (vars.ink) out.push({ name: m[1].trim().replace(/\s+/g, ' '), vars });
  }
  return out;
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [text, background]
const PAIRS = [
  ['ink', 'panel'], ['ink-muted', 'panel'], ['ink-muted', 'panel-raised'], ['ink-muted', 'panel-sunk'],
  ['accent', 'panel'], ['accent', 'panel-raised'], ['accent', 'accent-soft'], ['ink', 'accent-soft'], ['ink-muted', 'accent-soft'],
  ['warn', 'panel'], ['warn', 'warn-soft'], ['ink', 'warn-soft'], ['on-accent', 'accent'],
];

test('the tokens hold six colourways (three by day, three by night)', () => {
  assert.equal(blocks().length, 6);
});

test('every text pair in every colourway is 4.5:1 or better', () => {
  const failures = [];
  for (const { name, vars } of blocks()) {
    const v = { 'on-accent': '#ffffff', ...vars };
    if (name.includes('night') && !vars['on-accent']) v['on-accent'] = '#1d1838';
    for (const [fg, bg] of PAIRS) {
      if (!v[fg] || !v[bg]) { failures.push(`${name}: ${fg} or ${bg} missing`); continue; }
      const r = ratio(v[fg], v[bg]);
      if (r < 4.5) failures.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
});
