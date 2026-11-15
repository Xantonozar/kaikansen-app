import type {
  AnimeFranchiseResponse,
  FranchiseAnimeGroup,
  RelatedAnime,
  ThemeSummary,
} from '@kaikansen/contracts';

/**
 * Franchise helpers (owner's order, 2026-11-15) — the pure side
 * of the anime page's Franchise section (GET
 * /anime/:id/franchise): flattening the grouped response into
 * the ONE queue a franchise play claims, and deciding whether
 * the section exists at all. Kept pure (the playback-context /
 * searchPaging pattern) so the queue order is unit-pinned
 * without rendering the screen.
 */

/**
 * The franchise's themes as ONE flat list, in display order:
 * groups in the response's chronological order, each group's
 * themes in its served order (the API orders OP before ED,
 * then sequence). Deduped by slug defensively — a theme whose
 * anime somehow landed in two groups must not enter the queue
 * twice.
 */
export function franchiseFlatThemes(
  groups: readonly FranchiseAnimeGroup[],
): ThemeSummary[] {
  const seen = new Set<string>();
  const flat: ThemeSummary[] = [];
  for (const group of groups) {
    for (const item of group.themes) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      flat.push(item);
    }
  }
  return flat;
}

/**
 * Whether the Franchise section renders for an anime page: the
 * response exists AND it actually widens beyond the page's own
 * themes. A single group that IS the requested anime adds
 * nothing — the page's Openings/Endings sections already list
 * exactly those themes — so the section hides; a single group
 * for a DIFFERENT anime (the requested one has no themes of
 * its own but its franchise does) still shows.
 */
export function franchiseSectionVisible(
  franchise: AnimeFranchiseResponse | null,
  animeId: number,
): boolean {
  if (!franchise || franchise.groups.length === 0) return false;
  if (franchise.groups.length === 1) {
    return franchise.groups[0].anime.anilistId !== animeId;
  }
  return true;
}

/**
 * Progressive reveal (owner's follow-up, 2026-11-15): the
 * franchise DATA still arrives in the one small request (so a
 * franchise play can claim the whole list instantly) — what is
 * paged is only the RENDERING. The section mounts at most
 * FRANCHISE_PAGE_SIZE theme rows at first and reveals the next
 * batch as the user scrolls toward the bottom, so a 100+-theme
 * franchise never mounts all its rows at once.
 */
export const FRANCHISE_PAGE_SIZE = 20;

/** One group's visible slice: the FULL group (its header still
 *  shows the group's real theme count) plus the themes the
 *  current budget lets it contribute. */
export interface FranchiseVisibleGroup {
  group: FranchiseAnimeGroup;
  themes: ThemeSummary[];
}

/**
 * Walk the groups in display order spending a theme budget of
 * `visibleCount`: each group contributes at most its remaining
 * budget of themes, in served order. A group MAY split across
 * the boundary — its header renders once and, because the
 * reveal is cumulative (the budget only ever grows), a later
 * batch simply lengthens the same group's slice. Groups that
 * would contribute 0 themes are skipped, and the walk stops
 * once the budget is spent.
 */
export function franchiseVisibleGroups(
  groups: readonly FranchiseAnimeGroup[],
  visibleCount: number,
): FranchiseVisibleGroup[] {
  let budget = Math.max(0, visibleCount);
  const visible: FranchiseVisibleGroup[] = [];
  for (const group of groups) {
    if (budget <= 0) break;
    const take = Math.min(group.themes.length, budget);
    if (take === 0) continue;
    visible.push({ group, themes: group.themes.slice(0, take) });
    budget -= take;
  }
  return visible;
}

/** Whether unrevealed themes remain beyond `visibleCount`. */
export function franchiseHasMore(
  groups: readonly FranchiseAnimeGroup[],
  visibleCount: number,
): boolean {
  const total = groups.reduce((n, g) => n + g.themes.length, 0);
  return total > visibleCount;
}

/**
 * The group header's season line — "SPRING 2020" from real
 * payload fields only, season and year together or nothing
 * (the anime page's meta-line rule: a part renders only from a
 * field that exists).
 */
export function franchiseGroupSeasonLine(anime: RelatedAnime): string {
  return anime.season && anime.seasonYear
    ? `${anime.season} ${anime.seasonYear}`
    : '';
}
