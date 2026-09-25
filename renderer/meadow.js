// The Meadow: a second screen, away from the hospital, where every agent in
// the user's .claude/agents lives as a small creature. The more tokens an
// agent has used (last 28 days), the bigger it grows. Clicking one shows its
// numbers in the sidebar, where its look can be changed or handed to another
// agent. The numbers are the performance report's, worked out on request.

import { SPECIES, VARIANTS, drawCreature, creatureThumb, defaultCreature, lookOf } from './creatures.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compact = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`);
const pct = (v) => (v === undefined || v === null ? '–' : `${Math.round(v * 100)}%`);
function dur(ms) {
  if (ms === undefined || ms === null) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Made-up numbers for the demo's four staff, so the Meadow has something to show.
function demoStats(names) {
  return names.map((name, i) => {
    const runs = [42, 17, 9, 26][i % 4];
    return {
      name, runs, successRate: [0.93, 0.82, 1, 0.88][i % 4], rerunRate: [0.05, 0.12, 0, 0.08][i % 4],
      medianMs: [48_000, 190_000, 72_000, 64_000][i % 4], medianTokens: [38_000, 120_000, 55_000, 41_000][i % 4],
      totalTokens: [1_900_000, 2_600_000, 480_000, 1_100_000][i % 4], toolErrorRate: [0.02, 0.06, 0.01, 0.03][i % 4],
      verdicts: i % 4 === 0 ? { PASS: 30, FAIL: 8 } : {}, score: [88, 71, 94, 80][i % 4],
      daily: Array.from({ length: 14 }, (_, d) => ({ day: `d${d}`, runs: (d * 7 + i * 3) % 5 })),
    };
  });
}

export function createMeadow({ bridge, prefs, savePrefs, getSnapshot, onEnter, onExit }) {
  let open = false;
  let stats = { names: new Map(), error: '', loading: false, at: 0 };
  let selected;

  const creatureOf = (name) => prefs.creatures?.[name] ?? defaultCreature(name);

  function agents() {
    const snap = getSnapshot();
    return [...new Set((snap.roster ?? []).map((a) => a.name))].sort();
  }

  async function loadStats() {
    const names = agents();
    if (getSnapshot().demo) {
      stats = { names: new Map(demoStats(names).map((a) => [a.name, a])), error: '', loading: false, at: Date.now() };
      return;
    }
    if (!bridge.agentStats) {
      stats = { names: new Map(), error: 'The numbers come from the desktop app; this preview cannot work them out.', loading: false, at: Date.now() };
      return;
    }
    stats = { ...stats, loading: true };
    renderPanel();
    const res = await bridge.agentStats();
    stats = res.ok
      ? { names: new Map(res.agents.map((a) => [a.name, a])), error: '', loading: false, at: Date.now() }
      : { names: new Map(), error: res.error, loading: false, at: Date.now() };
  }

  // Size from tokens used: the busiest agent is about twice the quietest.
  function scales(names) {
    const tokens = names.map((n) => stats.names.get(n)?.totalTokens ?? 0);
    const lo = Math.log10(Math.max(1, Math.min(...tokens) || 1));
    const hi = Math.log10(Math.max(10, ...tokens));
    return new Map(names.map((n, i) => {
      const t = Math.log10(Math.max(1, tokens[i]));
      const k = hi > lo ? (t - lo) / (hi - lo) : 0.5;
      return [n, 0.75 + 0.75 * Math.max(0, Math.min(1, k))];
    }));
  }

  function renderScene() {
    const names = agents();
    const size = scales(names);
    const land = names.filter((n) => creatureOf(n).species !== 'fish');
    const water = names.filter((n) => creatureOf(n).species === 'fish');
    // Land creatures stand in staggered rows on the grass, biggest at the back.
    land.sort((a, b) => (size.get(b) ?? 1) - (size.get(a) ?? 1));
    const spots = [];
    const perRow = 5;
    land.forEach((n, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, land.length - row * perRow);
      spots.push([n, 500 + (col - (inRow - 1) / 2) * 150 + (row % 2) * 40 - 60, 380 + row * 95]);
    });
    // Fish spread across the pond, up to three to a row.
    water.forEach((n, i) => {
      const row = Math.floor(i / 3);
      const inRow = Math.min(3, water.length - row * 3);
      spots.push([n, 770 + ((i % 3) - (inRow - 1) / 2) * 95, 560 + row * 42 - (water.length > 3 ? 18 : 0), 'fish']);
    });
    spots.sort((a, b) => a[2] - b[2]);
    const critters = spots.map(([n, x, y, fish], i) => {
      const c = creatureOf(n);
      const s = size.get(n) ?? 1;
      return `<g class="critter${n === selected ? ' chosen' : ''}${fish ? ' swim' : ''}" data-agent="${esc(n)}" role="button" tabindex="0"
          aria-label="${esc(n)}: ${esc(lookOf(c.species, c.variant).name)} ${esc(SPECIES.find((x) => x.id === c.species)?.name ?? '')}" transform="translate(${x} ${y})">
        <g class="bob" style="animation-delay:${(i * 0.37) % 2}s">${drawCreature(c.species, c.variant, s * (fish ? 0.7 : 1))}</g>
        <text class="critter-name" y="${fish ? 22 : 24}" text-anchor="middle">${esc(n)}</text></g>`;
    }).join('');
    const flowers = [[210, 330], [260, 470], [700, 330], [820, 420], [180, 420], [640, 520], [360, 540]]
      .map(([x, y], i) => `<g transform="translate(${x} ${y})"><circle r="5" fill="${['#f7b8c8', '#fff4b8', '#c9b6f2', '#ffffff'][i % 4]}"/><circle r="2" fill="#f6cf4f"/></g>`).join('');
    const trees = [[140, 300, 1.2], [880, 310, 1], [110, 420, 0.8]]
      .map(([x, y, k]) => `<g transform="translate(${x} ${y}) scale(${k})"><rect x="-4" y="-40" width="8" height="40" rx="3" fill="#caa27c"/><circle cy="-58" r="28" fill="var(--meadow-tree)"/><circle cx="-14" cy="-44" r="16" fill="var(--meadow-tree)"/></g>`).join('');
    $('meadow').innerHTML = `
      <title>The Meadow: your agents as creatures</title>
      <path class="island-side" d="M70,420 Q70,560 500,640 Q930,560 930,420 L930,470 Q900,760 500,800 Q100,760 70,470 Z"/>
      <ellipse class="island-top" cx="500" cy="430" rx="430" ry="200"/>
      <ellipse class="pond" cx="770" cy="560" rx="150" ry="55"/>
      <ellipse class="pond-shine" cx="740" cy="548" rx="60" ry="10"/>
      ${trees}${flowers}${critters}
      ${names.length ? '' : '<text class="meadow-empty" x="500" y="430" text-anchor="middle">No agents in .claude/agents yet</text>'}`;
  }

  function statRow(label, value) {
    return `<div class="usage-row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function renderPanel() {
    const box = $('meadow-body');
    const names = agents();
    if (!selected || !names.includes(selected)) {
      box.innerHTML = `<p class="hint">${names.length
        ? 'Each creature is one of your agents; the more tokens it used in the last 28 days, the bigger it is. Click one to see how it is doing.'
        : 'Agents you add to .claude/agents (or the Office pack in Settings) move in here.'}</p>
        ${stats.loading ? '<p class="hint">Working out the numbers…</p>' : ''}${stats.error ? `<p class="form-error">${esc(stats.error)}</p>` : ''}`;
      return;
    }
    const c = creatureOf(selected);
    const L = lookOf(c.species, c.variant);
    const a = stats.names.get(selected);
    const verdicts = a && Object.keys(a.verdicts ?? {}).length ? Object.entries(a.verdicts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '';
    const bars = a?.daily?.length
      ? (() => {
        const max = Math.max(1, ...a.daily.map((d) => d.runs));
        return `<div class="spark" aria-label="Runs per day">${a.daily.slice(-14).map((d) => `<span style="height:${Math.round((d.runs / max) * 100)}%" title="${esc(d.day)}: ${d.runs} runs"></span>`).join('')}</div>`;
      })()
      : '';
    const numbers = a
      ? `${statRow('Score', a.score === undefined || a.score === null ? `– <span class="muted">(${esc(a.scoreReason ?? 'not enough runs')})</span>` : `${a.score} / 100`)}
         ${statRow('Runs, last 28 days', a.runs)}${statRow('Finished', pct(a.successRate))}${statRow('Called again after a failure', pct(a.rerunRate))}
         ${statRow('Median time', dur(a.medianMs))}${statRow('Tokens used', compact(a.totalTokens ?? 0))}${statRow('Tokens per run (median)', a.medianTokens ? compact(Math.round(a.medianTokens)) : '–')}
         ${statRow('Tool errors', pct(a.toolErrorRate))}${verdicts ? statRow('Verdicts', verdicts) : ''}${bars}`
      : `<p class="hint">${stats.loading ? 'Working out the numbers…' : stats.error ? esc(stats.error) : 'No runs in the last 28 days yet.'}</p>`;
    const others = agents().filter((n) => n !== selected);
    box.innerHTML = `
      <div class="critter-head">${creatureThumb(c.species, c.variant)}
        <div><h3>${esc(selected)}</h3><p class="hint">${esc(L.name)} ${esc(SPECIES.find((x) => x.id === c.species)?.name ?? '')}</p></div></div>
      ${numbers}
      <details class="more-pieces"><summary>Change the look</summary>
        <fieldset class="chips"><legend>Animal</legend><div class="options">${SPECIES.map((sp) => `<label class="chip"><input type="radio" name="critter-species" value="${sp.id}" ${sp.id === c.species ? 'checked' : ''}>${esc(sp.name)}</label>`).join('')}</div></fieldset>
        <div class="pieces critter-looks">${Array.from({ length: VARIANTS }, (_, v) => `<button type="button" class="piece" data-look="${v}" aria-pressed="${v === c.variant}">${creatureThumb(c.species, v)}<span>${esc(lookOf(c.species, v).name)}</span></button>`).join('')}</div>
      </details>
      ${others.length ? `<label class="field" for="critter-swap">Give this creature to another agent
        <select id="critter-swap"><option value="">Choose an agent…</option>${others.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>` : ''}`;
  }

  function setCreature(name, look) {
    prefs.creatures = { ...(prefs.creatures ?? {}), [name]: look };
    savePrefs();
    renderScene();
    renderPanel();
  }

  function select(name) {
    selected = name;
    renderScene();
    renderPanel();
  }

  $('meadow').addEventListener('click', (e) => {
    const c = e.target.closest('[data-agent]');
    select(c ? c.dataset.agent : undefined);
  });
  $('meadow').addEventListener('keydown', (e) => {
    const c = e.target.closest('[data-agent]');
    if (c && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(c.dataset.agent);
      document.querySelector(`#meadow [data-agent="${CSS.escape(c.dataset.agent)}"]`)?.focus();
    }
  });
  $('meadow-body').addEventListener('change', (e) => {
    if (!selected) return;
    const c = creatureOf(selected);
    if (e.target.name === 'critter-species') setCreature(selected, { species: e.target.value, variant: c.variant });
    if (e.target.id === 'critter-swap' && e.target.value) {
      // The two agents trade creatures.
      const other = e.target.value;
      const theirs = creatureOf(other);
      prefs.creatures = { ...(prefs.creatures ?? {}), [other]: c, [selected]: theirs };
      savePrefs();
      selected = other;
      renderScene();
      renderPanel();
    }
    const details = $('meadow-body').querySelector('details');
    if (details && e.target.name === 'critter-species') details.open = true;
  });
  $('meadow-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-look]');
    if (!b || !selected) return;
    setCreature(selected, { species: creatureOf(selected).species, variant: Number(b.dataset.look) });
    const details = $('meadow-body').querySelector('details');
    if (details) details.open = true;
  });

  async function enter() {
    open = true;
    document.body.classList.add('in-meadow');
    $('meadow-panel').hidden = false;
    onEnter?.();
    shown = agents().join('|');
    renderScene();
    renderPanel();
    await loadStats();
    renderScene();
    renderPanel();
    $('meadow-back').focus();
  }

  function exit() {
    open = false;
    document.body.classList.remove('in-meadow');
    $('meadow-panel').hidden = true;
    onExit?.();
  }

  $('cam-meadow').addEventListener('click', enter);
  $('meadow-back').addEventListener('click', exit);
  $('meadow-back-stage').addEventListener('click', exit);

  // Redrawn only when the agents themselves change, not on every snapshot,
  // so the creatures keep still enough to click.
  let shown = '';
  function refresh() {
    if (!open) return;
    const key = agents().join('|');
    if (key === shown) return;
    shown = key;
    loadStats().then(() => {
      renderScene();
      renderPanel();
    });
  }

  return { enter, exit, isOpen: () => open, refresh };
}
