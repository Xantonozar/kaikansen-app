import type { Season } from '@kaikansen/contracts';

/**
 * The current anime season for a date.
 *
 * Season boundaries (Gate 5 brief): WINTER = Dec–Feb, SPRING = Mar–May,
 * SUMMER = Jun–Aug, FALL = Sep–Nov. December belongs to the FOLLOWING year's
 * WINTER — the AniList season-year convention the catalogue data itself
 * follows (a December premiere is stored as WINTER of the next year).
 *
 * Note: the web app hard-codes its home season (HomeClient queries a literal
 * season/year); this computed version is the new backend's behaviour.
 */
export function currentSeason(date: Date = new Date()): {
  season: Season;
  year: number;
} {
  const month = date.getMonth(); // 0 = Jan … 11 = Dec
  const year = date.getFullYear();
  if (month === 11) return { season: 'WINTER', year: year + 1 };
  if (month <= 1) return { season: 'WINTER', year };
  if (month <= 4) return { season: 'SPRING', year };
  if (month <= 7) return { season: 'SUMMER', year };
  return { season: 'FALL', year };
}

/** Seasons in chronological order within one season-year. */
export const SEASON_ORDER: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

/**
 * The season immediately before the given one, chronologically:
 * FALL 2026 → SUMMER 2026 → SPRING 2026 → WINTER 2026 → FALL 2025 …
 * (WINTER of year Y spans Dec Y−1 – Feb Y, so its predecessor is
 * FALL of Y−1 — the same year convention as `currentSeason`.)
 */
export function previousSeason(current: {
  season: Season;
  year: number;
}): { season: Season; year: number } {
  const index = SEASON_ORDER.indexOf(current.season);
  if (index > 0) {
    return { season: SEASON_ORDER[index - 1], year: current.year };
  }
  return { season: 'FALL', year: current.year - 1 };
}
