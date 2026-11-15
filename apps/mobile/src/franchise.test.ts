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
  franchiseFlatThemes,
  franchiseGroupSeasonLine,
  franchiseSectionVisible,
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
