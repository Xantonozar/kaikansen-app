import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type {
  AnimeFranchiseResponse,
  FranchiseAnimeGroup,
  RelatedAnime,
  ThemeSummary,
} from '@kaikansen/contracts';
import {
  FRANCHISE_PAGE_SIZE,
  franchiseFlatThemes,
  franchiseGroupSeasonLine,
  franchiseHasMore,
  franchiseSectionVisible,
  franchiseVisibleGroups,
} from './franchise';

/**
 * Franchise section pins (owner's order, 2026-11-15):
 * - the queue a franchise play claims is the WHOLE franchise in
 *   display order (groups chronological, themes in served
 *   order), so the queue preload chains across seasons;
 * - the section hides when the "franchise" is just the page's
 *   own anime (its themes already list above as Openings /
 *   Endings);
 * - the anime page wires both new sections as the source scans
 *   below pin (no test renders these screens today — the
 *   rowPlayClaims.test.ts precedent).
 */

const anime = (over: Partial<RelatedAnime> = {}): RelatedAnime => ({
  anilistId: 42,
  malId: null,
  kitsuId: null,
  titleRomaji: 'Series Anime',
  titleEnglish: 'Series Anime EN',
  titleNative: null,
  titleAlternative: [],
  season: 'SPRING',
  seasonYear: 2020,
  genres: [],
  coverImageLarge: 'https://example.com/large.jpg',
  coverImageMedium: null,
  bannerImage: null,
  studios: [],
  series: ['Series'],
  totalEpisodes: 12,
  status: 'FINISHED',
  averageScore: 80,
  ...over,
});

const theme = (slug: string): ThemeSummary => ({
  slug,
  songTitle: slug,
  animeTitle: 'Series Anime',
  animeTitleEnglish: null,
  artistName: 'Artist',
  allArtists: ['Artist'],
  type: 'OP',
  sequence: 1,
  animeSeason: 'SPRING',
  animeSeasonYear: 2020,
  animeCoverImage: null,
  animeCoverImageSmall: null,
  avgRating: 9,
  totalRatings: 1,
  totalWatches: 1,
  totalListens: 1,
  duration: 90,
  isPopular: false,
  popularRank: null,
  anilistId: 42,
});

const group = (
  anilistId: number,
  slugs: string[],
): FranchiseAnimeGroup => ({
  anime: anime({ anilistId }),
  themes: slugs.map(theme),
});

const response = (
  groups: FranchiseAnimeGroup[],
): AnimeFranchiseResponse => ({
  groups,
  totalGroups: groups.length,
  totalThemes: groups.reduce((n, g) => n + g.themes.length, 0),
  truncated: false,
});

describe('franchiseFlatThemes', () => {
  it('flattens groups in order, themes in served order', () => {
    const flat = franchiseFlatThemes([
      group(43, ['s0-op1', 's0-ed1']),
      group(42, ['s1-op1']),
      group(44, ['s2-op1', 's2-op2']),
    ]);
    expect(flat.map((t) => t.slug)).toEqual([
      's0-op1',
      's0-ed1',
      's1-op1',
      's2-op1',
      's2-op2',
    ]);
  });

  it('dedupes a slug that appears in two groups', () => {
    const flat = franchiseFlatThemes([
      group(42, ['dup', 'a']),
      group(43, ['dup', 'b']),
    ]);
    expect(flat.map((t) => t.slug)).toEqual(['dup', 'a', 'b']);
  });

  it('answers [] for no groups', () => {
    expect(franchiseFlatThemes([])).toEqual([]);
  });
});

describe('franchiseSectionVisible', () => {
  it('hides for null and for an empty response', () => {
    expect(franchiseSectionVisible(null, 42)).toBe(false);
    expect(franchiseSectionVisible(response([]), 42)).toBe(false);
  });

  it('hides when the only group is the requested anime itself', () => {
    expect(
      franchiseSectionVisible(response([group(42, ['a'])]), 42),
    ).toBe(false);
  });

  it('shows for a multi-group franchise', () => {
    expect(
      franchiseSectionVisible(
        response([group(42, ['a']), group(43, ['b'])]),
        42,
      ),
    ).toBe(true);
  });

  it('shows when the only group is a different anime', () => {
    expect(
      franchiseSectionVisible(response([group(43, ['b'])]), 42),
    ).toBe(true);
  });
});

describe('franchiseGroupSeasonLine', () => {
  it('joins season and year, and omits the line when either is absent', () => {
    expect(franchiseGroupSeasonLine(anime())).toBe('SPRING 2020');
    expect(franchiseGroupSeasonLine(anime({ seasonYear: null }))).toBe('');
    expect(franchiseGroupSeasonLine(anime({ season: null }))).toBe('');
  });
});

/** A group of `count` themes with slugs g<id>-t0..t<count-1>. */
const groupOf = (anilistId: number, count: number): FranchiseAnimeGroup =>
  group(
    anilistId,
    Array.from({ length: count }, (_, i) => `g${anilistId}-t${i}`),
  );

describe('franchiseVisibleGroups / franchiseHasMore (progressive reveal)', () => {
  it('pins the page size at 20', () => {
    expect(FRANCHISE_PAGE_SIZE).toBe(20);
  });

  it('splits the first group when the budget is smaller than it', () => {
    const g = groupOf(42, 30);
    const visible = franchiseVisibleGroups([g], 20);
    expect(visible).toHaveLength(1);
    // The entry carries the FULL group (header count stays real)…
    expect(visible[0].group).toBe(g);
    expect(visible[0].group.themes).toHaveLength(30);
    // …and only the budgeted slice of its rows, in served order.
    expect(visible[0].themes.map((t) => t.slug)).toEqual(
      g.themes.slice(0, 20).map((t) => t.slug),
    );
    expect(franchiseHasMore([g], 20)).toBe(true);
  });

  it('grows the same group’s slice as the budget grows (cumulative)', () => {
    const g = groupOf(42, 30);
    const visible = franchiseVisibleGroups([g], 25);
    expect(visible).toHaveLength(1);
    expect(visible[0].themes).toHaveLength(25);
    expect(visible[0].themes[24].slug).toBe('g42-t24');
  });

  it('spends the budget across groups in order', () => {
    const groups = [groupOf(42, 10), groupOf(43, 15), groupOf(44, 10)];
    const visible = franchiseVisibleGroups(groups, 20);
    expect(visible.map((v) => v.group.anime.anilistId)).toEqual([42, 43]);
    expect(visible.map((v) => v.themes.length)).toEqual([10, 10]);
    expect(franchiseHasMore(groups, 20)).toBe(true);
  });

  it('stops exactly at a group boundary — the next group contributes 0 and is skipped', () => {
    const groups = [groupOf(42, 10), groupOf(43, 15)];
    const visible = franchiseVisibleGroups(groups, 10);
    expect(visible.map((v) => v.group.anime.anilistId)).toEqual([42]);
    expect(visible[0].themes).toHaveLength(10);
    expect(franchiseHasMore(groups, 10)).toBe(true);
  });

  it('returns every group in full when the budget reaches the total', () => {
    const groups = [groupOf(42, 10), groupOf(43, 15)];
    const atTotal = franchiseVisibleGroups(groups, 25);
    expect(atTotal.map((v) => v.themes.length)).toEqual([10, 15]);
    expect(franchiseHasMore(groups, 25)).toBe(false);
    const beyond = franchiseVisibleGroups(groups, 40);
    expect(beyond.map((v) => v.themes.length)).toEqual([10, 15]);
    expect(franchiseHasMore(groups, 40)).toBe(false);
  });

  it('skips empty groups without spending budget on them', () => {
    const groups = [groupOf(42, 0), groupOf(43, 3), groupOf(44, 0)];
    const visible = franchiseVisibleGroups(groups, 20);
    expect(visible.map((v) => v.group.anime.anilistId)).toEqual([43]);
    expect(visible[0].themes).toHaveLength(3);
  });

  it('answers empty / no-more for no groups and a zero budget', () => {
    expect(franchiseVisibleGroups([], 20)).toEqual([]);
    expect(franchiseHasMore([], 20)).toBe(false);
    expect(franchiseVisibleGroups([groupOf(42, 5)], 0)).toEqual([]);
    expect(franchiseHasMore([groupOf(42, 5)], 0)).toBe(true);
    expect(franchiseHasMore([groupOf(42, 5)], 5)).toBe(false);
  });
});

describe('anime page wiring (source scan)', () => {
  const source = readFileSync(
    join(__dirname, '../app/(drawer)/anime/[id].tsx'),
    'utf8',
  );
  const api = readFileSync(join(__dirname, 'api.ts'), 'utf8');

  it('fetches related + franchise through src/api', () => {
    expect(source).toContain('fetchRelatedAnime(animeId)');
    expect(source).toContain('fetchAnimeFranchise(animeId)');
    expect(api).toContain('`/anime/${id}/related`');
    expect(api).toContain('`/anime/${id}/franchise`');
  });

  it('renders both sections under their headings', () => {
    expect(source).toContain('Related Series');
    expect(source).toContain('Franchise');
  });

  it('related cards open the tapped anime’s page', () => {
    expect(source).toContain('router.push(`/anime/${item.anilistId}`)');
  });

  it('franchise rendering is progressive: sliced groups, scroll trigger, skeletons', () => {
    expect(source).toContain('franchiseVisibleGroups(');
    expect(source).toContain('franchiseHasMore(');
    expect(source).toContain('FRANCHISE_PAGE_SIZE');
    expect(source).toContain('onScroll={onPageScroll}');
    expect(source).toContain('franchisePending');
    expect(source).toContain('franchiseLoadingMore');
  });

  it('franchise plays claim the whole flat franchise in the open-themes-as mode', () => {
    const start = source.indexOf('const playFranchiseTheme');
    expect(start).toBeGreaterThan(-1);
    const span = source.slice(start, start + 700);
    expect(span).toContain('franchiseFlatThemes(franchise.groups)');
    expect(span).toContain('queueItemsFromSummaries(flat)');
    expect(span).toContain('getOpenThemesAs()');
    expect(span).toContain('startQueue(');
  });
});
