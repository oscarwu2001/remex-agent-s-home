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
