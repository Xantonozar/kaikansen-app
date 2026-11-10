import type { ProfileStats } from '@kaikansen/contracts';

/**
 * Profile listening-stats formatting — the ONE language both
 * profile surfaces speak (the own Profile and the public user
 * profile), factored out of the own Profile rebuild (2026-11-10)
 * so the two screens can never drift:
 *
 * - Counts (followers / following / themes): grouped en-US
 *   ("1,234").
 * - Mean rating: the mean of the scores the user GAVE, one
 *   decimal ("8.1"); "—" when they have given none (the API's
 *   null).
 * - Hours listened: totalListenedSeconds / 3600 — one decimal
 *   under 100 hours ("73.5"), rounded and grouped at/above 100
 *   ("1,205").
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatMeanRating(stats: ProfileStats): string {
  return stats.meanRating !== null ? stats.meanRating.toFixed(1) : '—';
}

export function formatThemesListened(stats: ProfileStats): string {
  return formatCount(stats.themesListened);
}

export function formatHoursListened(stats: ProfileStats): string {
  const hours = stats.totalListenedSeconds / 3600;
  return hours >= 100
    ? formatCount(Math.round(hours))
    : String(Math.round(hours * 10) / 10);
}
