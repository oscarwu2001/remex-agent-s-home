// How a Meadow creature grows up, Pokémon style: every agent starts as an
// egg, hatches once it has used enough tokens (you pick one of three
// starters), grows as it keeps working, and evolves twice. Each evolution
// starts small again. Rarity (R, SR, SSR) is earned by doing good work
// and, once earned, kept.
//
// Tokens are counted per agent per day (from the performance numbers) and
// the days are kept in the preferences, so the total keeps growing after
// old days leave the window the numbers are worked out over.

export const HATCH_AT = 100_000;
// Stage n grows from SPAN[n][0] to SPAN[n][1] tokens; at the top it can evolve.
export const SPAN = [null, [HATCH_AT, 1_000_000], [1_000_000, 5_000_000], [5_000_000, 20_000_000]];
export const STAGES = 3;
export const RARITIES = ['R', 'SR', 'SSR'];

// Merge newly read days into the ledger. A day read again keeps the larger
// count: a day still in progress grows, and a day read twice is not added twice.
export function mergeLedger(ledger = {}, tokensByDay = {}) {
  const out = {};
  for (const [name, days] of Object.entries(ledger)) out[name] = { ...days };
  for (const [name, days] of Object.entries(tokensByDay)) {
    const mine = (out[name] ??= {});
    for (const [day, n] of Object.entries(days)) {
      const v = Math.max(0, Number(n) || 0);
      if (v > (mine[day] ?? 0)) mine[day] = v;
    }
  }
  return out;
}

export function lifetimeTokens(ledger, name) {
  return Object.values(ledger?.[name] ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
}

const clamp = (v) => Math.max(0, Math.min(1, v));

// Where a creature is in its life. `entry` is what the preferences keep for
// it ({ species, variant, stage, rarity }), or nothing while it is an egg.
export function lifeOf(tokens, entry) {
  if (!entry?.species) {
    return { stage: 0, progress: clamp(tokens / HATCH_AT), ready: tokens >= HATCH_AT, next: HATCH_AT };
  }
  const stage = Math.max(1, Math.min(STAGES, entry.stage || 1));
  const [from, to] = SPAN[stage];
  const progress = clamp(Math.log(Math.max(tokens, from) / from) / Math.log(to / from));
  return { stage, progress, ready: stage < STAGES && tokens >= to, next: to };
}

// Size on the island: an egg swells a little as it nears hatching; a
// creature grows through its stage and starts small again after evolving.
const STAGE_SIZE = [0.8, 0.8, 1.0, 1.25];
export function sizeOf(life) {
  if (life.stage === 0) return STAGE_SIZE[0] + 0.2 * life.progress;
  return STAGE_SIZE[life.stage] * (0.8 + 0.45 * life.progress);
}

// Rarity from the performance numbers of the last 28 days.
export function rarityFrom(stats) {
  if (!stats || stats.score === undefined || stats.score === null) return 'R';
  if (stats.score >= 90 && stats.runs >= 10) return 'SSR';
  if (stats.score >= 80 && stats.runs >= 5) return 'SR';
  return 'R';
}

export function bestRarity(a = 'R', b = 'R') {
  return RARITIES[Math.max(RARITIES.indexOf(a), RARITIES.indexOf(b), 0)];
}

function hashOf(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// The three starters an agent's egg offers: always the same three for that
// agent, all different.
export function starterChoices(name, speciesIds) {
  const pool = [...speciesIds];
  const out = [];
  let h = hashOf(name);
  while (out.length < 3 && pool.length) {
    out.push(pool.splice(h % pool.length, 1)[0]);
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
  }
  return out;
}

// Fully grown dragons and birds take to the air.
export function flies(species, stage) {
  return stage === STAGES && (species === 'dragon' || species === 'bird');
}

// ---- time in the app: points and mystery eggs ------------------------------------
//
// Every 15 minutes the app is open earns a point. Points buy mystery eggs,
// which hold a creature of a random kind, look and rarity. A mystery
// creature belongs to no agent: it grows with time in the app instead of
// tokens, one 15-minute tick counting as TOKENS_PER_TICK.

export const POINT_MINUTES = 15;
export const MYSTERY_PRICE = 8;
export const WELCOME_POINTS = 8; // enough for a first mystery egg
export const TOKENS_PER_TICK = 25_000; // so a mystery egg hatches after an hour
export const MAX_WILD = 12;
export const ODDS = [['SSR', 0.05], ['SR', 0.2], ['R', 0.75]];
const MAX_STEP_MS = 2 * 60_000; // a longer gap is sleep or a closed lid, not use

// Add the time since the last tick. `play` = { points, minutes, last }.
export function earn(play, now) {
  const p = { points: WELCOME_POINTS, minutes: 0, ...play };
  if (!Number.isFinite(p.last) || now < p.last) return { ...p, last: now };
  const add = Math.min(now - p.last, MAX_STEP_MS) / 60_000;
  const minutes = p.minutes + add;
  const points = p.points + Math.floor(minutes / POINT_MINUTES) - Math.floor(p.minutes / POINT_MINUTES);
  return { points, minutes, last: now };
}

// Growth of a mystery creature bought when the app had run `born` minutes.
export function wildTokens(play, born) {
  return Math.max(0, ((play?.minutes ?? 0) - born) / POINT_MINUTES) * TOKENS_PER_TICK;
}

// What hatches from a mystery egg. `rand` returns numbers in [0, 1).
export function rollMystery(speciesIds, variants, rand = Math.random) {
  const r = rand();
  let acc = 0;
  let rarity = 'R';
  for (const [name, p] of ODDS) {
    acc += p;
    if (r < acc) {
      rarity = name;
      break;
    }
  }
  return {
    species: speciesIds[Math.floor(rand() * speciesIds.length) % speciesIds.length],
    variant: Math.floor(rand() * variants) % variants,
    rarity,
  };
}

// ---- the index ------------------------------------------------------------------
//
// Every form (kind and stage) you have raised, with the best rarity and the
// looks seen. `dex` maps 'kind:stage' to { rarity, looks: [variant, ...] }.
export function noteInDex(dex = {}, { species, stage, variant, rarity }) {
  const key = `${species}:${stage}`;
  const had = dex[key];
  const looks = new Set(had?.looks ?? []);
  const before = looks.size;
  looks.add(variant);
  const best = bestRarity(had?.rarity, rarity);
  if (had && looks.size === before && best === had.rarity) return dex; // nothing new
  return { ...dex, [key]: { rarity: best, looks: [...looks].sort((a, b) => a - b) } };
}
