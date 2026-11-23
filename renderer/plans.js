// The Claude plans the user can pick in Settings, the two limit windows, and
// the learned estimate: how much of the picked plan's limit is used, from
// the token totals at the limit hits recorded under that plan
// (src/core/limits.js keeps them). Pure, no words: the main process, the
// board, the mini window and the tests share it.
//
// Tokens are the `total` measure throughout (input, output, cache reads and
// cache writes), the number the board shows first and the user's own
// warning level counts.

// 'none' is "Not set", the default: no plan means no estimate.
export const PLANS = ['none', 'pro', 'max5', 'max20', 'team', 'enterprise', 'api'];
export const isPlan = (id) => PLANS.includes(id);

export const WINDOW_MS = { '5h': 5 * 3_600_000, week: 7 * 24 * 3_600_000 };
export const WINDOWS = Object.keys(WINDOW_MS);

// An estimate needs this many hits for the same plan and window.
export const HITS_NEEDED = 2;
// The level is learned from the latest few hits, so a plan whose limits
// change catches up.
export const HITS_USED = 5;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// For each window: { hits } while there are fewer than HITS_NEEDED, else
// { hits, basis, level, used, pct, over }: `basis` is how many hits the
// level comes from, and `over` is true past the learned level, where `pct`
// is not to be shown. Null when no plan is picked.
// usage: the summary's { last5h, week } totals.
export function estimate(hits, plan, usage) {
  if (!isPlan(plan) || plan === 'none') return null;
  const used = { '5h': usage?.last5h?.total, week: usage?.week?.total };
  const out = {};
  for (const w of WINDOWS) {
    const mine = (hits ?? []).filter((h) => h.plan === plan && h.window === w && Number.isFinite(h.tokens) && h.tokens > 0)
      .sort((a, b) => a.at - b.at);
    if (mine.length < HITS_NEEDED || !Number.isFinite(used[w])) {
      out[w] = { hits: mine.length };
      continue;
    }
    const level = median(mine.slice(-HITS_USED).map((h) => h.tokens));
    out[w] = { hits: mine.length, basis: Math.min(mine.length, HITS_USED), level, used: used[w], pct: Math.round((used[w] / level) * 100), over: used[w] > level };
  }
  return out;
}
