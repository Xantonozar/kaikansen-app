import type { RankTier } from '@kaikansen/contracts';

/**
 * Rank ladder display helpers — the thresholds are the web's
 * (kaisen-src lib/rank-utils TIERS, mirrored by the API's rank
 * module): Academy 0 / Genin 400 / Chunin 800 / Jonin 1400 /
 * ANBU 2200 / Kage 3200. Presentation only: the API's rank reads
 * already serve `tier` and `division`; nothing here recomputes
 * standing, it just phrases progress toward the next tier the way
 * the Lavender Dusk quiz hub / leaderboard mocks draw it.
 */
export const RANK_TIER_MIN: { tier: RankTier; min: number }[] = [
  { tier: 'academy', min: 0 },
  { tier: 'genin', min: 400 },
  { tier: 'chunin', min: 800 },
  { tier: 'jonin', min: 1400 },
  { tier: 'anbu', min: 2200 },
  { tier: 'kage', min: 3200 },
];

const TIER_LABEL: Record<RankTier, string> = {
  academy: 'Academy',
  genin: 'Genin',
  chunin: 'Chunin',
  jonin: 'Jonin',
  anbu: 'ANBU',
  kage: 'Kage',
};

/** "Chunin" — the tier's display name. */
export function tierLabel(tier: RankTier): string {
  return TIER_LABEL[tier];
}

/**
 * The division's roman numeral, exactly as the web phrases it
 * (`'I'.repeat(4 - division)` — division 1 → III, 3 → I), or null
 * for the division-less tiers (Academy, Kage).
 */
export function divisionRoman(division: number | null): string | null {
  if (division === null || division < 1 || division > 3) return null;
  return 'I'.repeat(4 - division);
}

/** "Tier II" chip text, or null when the tier has no divisions. */
export function divisionChip(division: number | null): string | null {
  const roman = divisionRoman(division);
  return roman ? `Tier ${roman}` : null;
}

/** Sub-line under a leaderboard name: "Jonin" / "Chunin · II". */
export function tierLine(tier: RankTier, division: number | null): string {
  const roman = divisionRoman(division);
  return roman ? `${tierLabel(tier)} · ${roman}` : tierLabel(tier);
}

export interface TierProgress {
  /** The next tier up, or null at Kage (the top of the ladder). */
  nextTier: RankTier | null;
  /** RP still needed to reach `nextTier` (0 at the top). */
  toNext: number;
  /** 0–1 progress through the current tier (1 at the top). */
  fraction: number;
}

/** Progress through the tier the given RP sits in. */
export function tierProgress(rp: number, tier: RankTier): TierProgress {
  const idx = RANK_TIER_MIN.findIndex((t) => t.tier === tier);
  const cur = RANK_TIER_MIN[idx] ?? RANK_TIER_MIN[0];
  const next = RANK_TIER_MIN[idx + 1] ?? null;
  if (!next) return { nextTier: null, toNext: 0, fraction: 1 };
  const span = next.min - cur.min;
  const done = Math.min(Math.max(rp - cur.min, 0), span);
  return {
    nextTier: next.tier,
    toNext: next.min - rp,
    fraction: span > 0 ? done / span : 1,
  };
}

/** "1,270 RP" — grouped RP figure, as drawn on the rank surfaces. */
export function formatRp(rp: number): string {
  return `${rp.toLocaleString('en-US')} RP`;
}
