// Bootstrap intervals over items. The unit of resampling is the item, because
// the 30-odd items are the sample: a run on the same items again would give
// nearly the same numbers, but a different item set would not. The seed is
// fixed so a report written twice from the same scores is byte-identical.

export type Interval = { lo: number; hi: number };

const DRAWS = 10_000;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 95% percentile interval of the mean of `values`, resampling items.
// Returns null for fewer than two items: one number has no spread to bootstrap.
export function bootstrapMeanInterval(values: number[]): Interval | null {
  return pairedBootstrapInterval(values);
}

// Same, for the mean of per-item differences (system A minus system B on the
// same items). Pairing keeps item difficulty out of the interval, so it is much
// tighter than comparing two separate intervals. Values are sorted first so the
// fixed seed gives the same interval whatever order the items arrive in.
export function pairedBootstrapInterval(input: number[]): Interval | null {
  if (input.length < 2) return null;
  const diffs = [...input].sort((a, b) => a - b);
  const random = mulberry32(7);
  const means: number[] = [];
  for (let draw = 0; draw < DRAWS; draw += 1) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i += 1)
      sum += diffs[Math.floor(random() * diffs.length)] as number;
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(0.025 * DRAWS)] as number,
    hi: means[Math.floor(0.975 * DRAWS)] as number,
  };
}

// Per-item differences for the items both systems scored.
export function pairedDifferences(
  a: Record<string, number>,
  b: Record<string, number>
) {
  return Object.entries(a)
    .filter(([id]) => id in b)
    .map(([id, score]) => score - (b[id] as number));
}
