import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * AniList auto-love guard + Saved → Favourites rename pin
 * (owner order, 2026-11-15), as source scans in the style of
 * rowPlayClaims.test.ts (no test renders these screens today).
 *
 * The bug: the Library's AniList load paths called
 * syncFavoriteSlugs(anilistThemes). That helper merges every
 * theme it is given into the favorites membership set, so
 * merely LOADING the AniList segment marked every AniList
 * theme as favourited (hearts filled) without the user
 * choosing any of them — "love what I choose" only.
 *
 * The rule pinned here:
 * - NO AniList load path in library.tsx (the first-page
 *   silent swap, loadAnilistFirstPage, loadAnilistNextPage)
 *   may call syncFavoriteSlugs.
 * - The legitimate favorites paths MUST keep their calls:
 *   loadAll's favorites fetch, the favorites silent swap and
 *   loadMoreFavorites in library.tsx, and every call in
 *   favourites.tsx (all three there serve real favorites
 *   pages).
 * - The Library segment keeps its internal 'saved' key but
 *   is labelled 'Favourites' (the rename is UI-only).
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

const LIBRARY = read('../app/(drawer)/(tabs)/library.tsx');
const FAVOURITES_SCREEN = read('../app/(drawer)/favourites.tsx');

/** The source between two markers (fails when either marker
    is gone — the pin names the shape it protects). */
function sliceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function countCalls(source: string): number {
  return source.match(/syncFavoriteSlugs\(/g)?.length ?? 0;
}

describe('AniList auto-love — AniList load paths never sync favourites', () => {
  it('the AniList first-page silent swap does not call syncFavoriteSlugs', () => {
    const swap = sliceBetween(
      LIBRARY,
      'Silent swap for the AniList first page',
      'const loadAnilistFirstPage',
    );
    expect(swap).toContain('setAnilistThemes(fresh.themes)');
    expect(swap).not.toContain('syncFavoriteSlugs');
  });

  it('loadAnilistFirstPage does not call syncFavoriteSlugs', () => {
    const fn = sliceBetween(
      LIBRARY,
      'const loadAnilistFirstPage',
      'const loadAnilistNextPage',
    );
    expect(fn).toContain('fetchAnilistThemesPage(');
    expect(fn).not.toContain('syncFavoriteSlugs');
  });

  it('loadAnilistNextPage does not call syncFavoriteSlugs', () => {
    const fn = sliceBetween(
      LIBRARY,
      'const loadAnilistNextPage',
      'A filter change re-pages',
    );
    expect(fn).toContain('fetchAnilistThemesPage(');
    expect(fn).not.toContain('syncFavoriteSlugs');
  });
});

describe('the legitimate favorites paths keep their sync', () => {
  it('loadAll syncs the favorites fetch', () => {
    const fn = sliceBetween(
      LIBRARY,
      'const loadAll',
      'Silent swaps (perf problem 5)',
    );
    expect(fn).toContain('syncFavoriteSlugs(res.themes)');
  });

  it('the favorites silent swap syncs its page', () => {
    const swap = sliceBetween(
      LIBRARY,
      'const offFav = subscribeCache',
      'const offHistory',
    );
    expect(swap).toContain('syncFavoriteSlugs(fresh.themes)');
  });

  it('loadMoreFavorites syncs the appended page', () => {
    const fn = sliceBetween(
      LIBRARY,
      'const loadMoreFavorites',
      'const patchPlaylist',
    );
    expect(fn).toContain('syncFavoriteSlugs(res.themes)');
  });

  it('library.tsx carries exactly the three legitimate calls', () => {
    expect(countCalls(LIBRARY)).toBe(3);
  });

  it('favourites.tsx keeps all three of its calls', () => {
    expect(countCalls(FAVOURITES_SCREEN)).toBe(3);
  });
});

describe('Saved → Favourites rename (UI labels only)', () => {
  it("the Library segment keeps key 'saved' and is labelled 'Favourites'", () => {
    expect(LIBRARY).toContain("{ key: 'saved', label: 'Favourites' }");
    expect(LIBRARY).not.toContain("label: 'Saved'");
  });
});
