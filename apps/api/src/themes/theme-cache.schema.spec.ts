import { ThemeCacheSchema } from './theme-cache.schema';

/**
 * Perf problem 15 (B8) — the season compound index declaration.
 *
 * ThemesService.getSeasonThemes filters
 * { animeSeason, animeSeasonYear } (plus an optional type) and
 * sorts { sequence: 1, avgRating: -1 } (that service-side shape is
 * pinned in themes.service.spec.ts). The schema declares the
 * matching compound index in the web schema's post-factory style
 * so the read can be served filter+sort from one index once the
 * index is created on the cluster.
 *
 * The declaration is documentation/intent ONLY: the schema sets
 * autoIndex: false and this backend never syncs indexes on the
 * shared production collection, so nothing here asserts (or
 * wants) a live index — only that the declared key spec matches
 * the query it exists for, in key ORDER (a compound index's
 * prefix order is its semantics).
 */
describe('ThemeCache schema — season compound index (perf problem 15, B8)', () => {
  const SEASON_INDEX_ENTRIES: [string, number][] = [
    ['animeSeason', 1],
    ['animeSeasonYear', 1],
    ['sequence', 1],
    ['avgRating', -1],
  ];

  const declared = ThemeCacheSchema.indexes().map(([keys]) =>
    Object.entries(keys as Record<string, number>),
  );

  it('declares { animeSeason: 1, animeSeasonYear: 1, sequence: 1, avgRating: -1 } in key order', () => {
    expect(declared).toContainEqual(SEASON_INDEX_ENTRIES);
  });

  it('the declared prefix is the season filter and the tail is the season sort', () => {
    const seasonIndex = declared.find((entries) =>
      entries.every(
        ([key, dir], i) =>
          SEASON_INDEX_ENTRIES[i]?.[0] === key &&
          SEASON_INDEX_ENTRIES[i]?.[1] === dir,
      ),
    );
    expect(seasonIndex).toBeDefined();
    // Filter keys first (getSeasonThemes' equality filter)…
    expect(seasonIndex!.slice(0, 2).map(([key]) => key)).toEqual([
      'animeSeason',
      'animeSeasonYear',
    ]);
    // …then the sort keys, in the service's sort order and
    // directions: sequence asc, avgRating desc.
    expect(seasonIndex!.slice(2)).toEqual([
      ['sequence', 1],
      ['avgRating', -1],
    ]);
  });
});
