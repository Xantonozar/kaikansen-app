import type {
  NetworkUser,
  SearchAnimeResult,
  SearchArtistResult,
  ThemeSummary,
} from '@kaikansen/contracts';

/**
 * Search full-view paging (Option B spec, 2026-11-10): a group's
 * full view lazy-loads at page size 15 with infinite scroll. The
 * server's ordering is stable (Atlas score / popularity, `_id`
 * tiebreak), so pages should never repeat a row — but the merge
 * still dedupes on the group's identity key, so a repeated row
 * (a catalogue sync landing mid-scroll, a retried page) can never
 * render twice or break a FlatList key.
 */
export const SEARCH_PAGE_SIZE = 15;

/** Identity keys per result group: slug / AniList id / slug / username. */
export const searchResultKeys = {
  themes: (t: ThemeSummary): string => t.slug,
  anime: (a: SearchAnimeResult): string => String(a.anilistId),
  artists: (a: SearchArtistResult): string => a.slug,
  users: (u: NetworkUser): string => u.username,
};

/** Appends `incoming` to `existing`, skipping keys already present. */
export function mergeSearchPage<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}
