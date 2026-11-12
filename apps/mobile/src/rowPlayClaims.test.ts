import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Row play claims — the counts fix RC1 + the play-disc ruling
 * (owner, 2026-11-12), pinned as source scans in the style of
 * singleSurface.test.ts (no test renders these screens today;
 * the diagnosis §6 pin 1 asks for exactly this coverage).
 *
 * The rulings:
 * - A row play records as what the user actually consumes.
 *   Row/disc claims therefore carry the user's Open-themes-as
 *   mode (default 'listen') — NEVER a hardcoded 'watch'. The
 *   exceptions keep their own truth: history rows claim their
 *   entry's recorded mode, downloads their record's mode, and
 *   the theme detail's own claims stay explicit (not
 *   startQueue calls at all).
 * - A row's PLAY DISC claims the queue and plays in the mini
 *   player; it must NOT navigate. The card's own press opens
 *   the theme detail. (Library's Offline rows are the one
 *   whole-row surface: their tap still claims AND opens the
 *   player route — the player route is playlist/offline-only.)
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

const SURFACES = {
  home: read('../app/(drawer)/(tabs)/index.tsx'),
  library: read('../app/(drawer)/(tabs)/library.tsx'),
  playlist: read('../app/(drawer)/playlist/[id].tsx'),
  anime: read('../app/(drawer)/anime/[id].tsx'),
  artist: read('../app/(drawer)/artist/[slug].tsx'),
  search: read('../app/(drawer)/search.tsx'),
  season: read('../app/(drawer)/season.tsx'),
  favourites: read('../app/(drawer)/favourites.tsx'),
  themeDetail: read('../app/(drawer)/theme/[slug].tsx'),
  userProfile: read('../app/(drawer)/user/[username].tsx'),
  downloads: read('../app/(drawer)/downloads.tsx'),
} as const;

/** The argument span of every startQueue(...) call in a source,
    paren-matched from the call site. */
function startQueueArgs(source: string): string[] {
  const spans: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('startQueue(', from);
    if (start < 0) return spans;
    let depth = 0;
    let i = start + 'startQueue'.length;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

/** A bounded slice starting at `marker` (fails the test when the
    marker is gone — the pin names the shape it protects). */
function sliceFrom(source: string, marker: string, length: number): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

/** A top-level handler's own text: from its `const` to its
    closing at component indent (`  };` / `  );`) — so navigation
    code in a NEIGHBOURING handler never bleeds into the slice. */
function handlerSlice(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = /\n {2}\};|\n {2}\);/.exec(rest);
  return end ? rest.slice(0, end.index + end[0].length) : rest.slice(0, 600);
}

describe('RC1 — no row claim hardcodes the watch bucket', () => {
  it.each(Object.entries(SURFACES))(
    '%s: every startQueue call claims a derived mode, never a literal watch',
    (_name, source) => {
      const calls = startQueueArgs(source);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).not.toContain("'watch'");
      }
    },
  );

  it('the row surfaces claim the Open-themes-as mode', () => {
    for (const name of [
      'home',
      'library',
      'playlist',
      'anime',
      'artist',
      'search',
      'season',
      'favourites',
    ] as const) {
      expect(SURFACES[name]).toContain('getOpenThemesAs()');
    }
    // The detail page claims its Recommended rows in its own
    // openMode (the same setting, read through its hook).
    expect(SURFACES.themeDetail).toContain('openMode');
  });
});

describe('the play-disc ruling — discs claim, cards navigate', () => {
  it('Home popular: the disc claims with the open mode and does not open the detail', () => {
    const card = sliceFrom(SURFACES.home, '<PopularCard', 1600);
    const disc = sliceFrom(card, 'onPlay', 750);
    expect(disc).toContain('startQueue(');
    expect(disc).toContain('getOpenThemesAs()');
    expect(disc).not.toContain('openTheme(');
  });

  it('anime/artist/season: playTheme is claim-only in the open mode', () => {
    for (const name of ['anime', 'artist', 'season'] as const) {
      const fn = handlerSlice(SURFACES[name], 'const playTheme');
      expect(fn).toContain('startQueue(');
      expect(fn).toContain('getOpenThemesAs()');
      expect(fn).not.toContain('openTheme(');
    }
  });

  it('search: playFromList claims and never pushes the detail route', () => {
    const fn = handlerSlice(SURFACES.search, 'const playFromList');
    expect(fn).toContain('getOpenThemesAs()');
    expect(fn).not.toContain('router.push');
  });

  it('favourites: playAt claims and never pushes the detail route', () => {
    const fn = handlerSlice(SURFACES.favourites, 'const playAt');
    expect(fn).toContain('getOpenThemesAs()');
    expect(fn).not.toContain('router.push');
  });

  it('playlist rows: the disc claims in the open mode and never pushes the player route', () => {
    const rows = sliceFrom(SURFACES.playlist, 'playlist.items.map', 4000);
    const disc = sliceFrom(rows, 'onPlay', 700);
    expect(disc).toContain('startQueue(');
    expect(disc).toContain('getOpenThemesAs()');
    expect(disc).not.toContain('router.push');
  });

  it('library: discs go through claimQueue; playWithQueue (claim + navigate) survives only for the Offline whole-row tap', () => {
    expect(SURFACES.library.match(/claimQueue\(/g) ?? []).toHaveLength(3);
    expect(SURFACES.library.match(/playWithQueue\(/g) ?? []).toHaveLength(1);
    // Recent rows keep their entry's own recorded mode.
    expect(SURFACES.library).toContain('claimQueue(items, index, entry.mode)');
  });

  it('theme detail: Recommended rows carry a claim-only onPlay in the page open mode', () => {
    expect(SURFACES.themeDetail).toContain(
      'onPlay={() => playRelated(item.slug)}',
    );
    const fn = handlerSlice(SURFACES.themeDetail, 'const playRelated');
    expect(fn).toContain('startQueue(');
    expect(fn).toContain('openMode');
    expect(fn).not.toContain('router.push');
  });

  it('user profile: history discs claim in the entry mode and never navigate', () => {
    expect(SURFACES.userProfile).toContain(
      'onPlay={() => playHistoryEntry(entry.id, entry.mode)}',
    );
    const fn = handlerSlice(SURFACES.userProfile, 'const playHistoryEntry');
    expect(fn).toContain('startQueue(');
    expect(fn).not.toContain('router.push');
  });
});
