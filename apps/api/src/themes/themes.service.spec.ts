import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Model } from 'mongoose';
import type { AnimeCacheDocument } from '../sync/anime-cache.schema';
import type { ThemeCacheDocument } from './theme-cache.schema';
import { ThemesService } from './themes.service';

/* Chainable Mongoose-query stand-in: every builder returns the same object. */
function queryOf(result: unknown) {
  const q: Record<string, jest.Mock> = {};
  q.sort = jest.fn(() => q);
  q.skip = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    slug: 'test_anime-op1-1',
    animethemesId: 1,
    songTitle: 'Test Song',
    animeTitle: 'Test Anime',
    animeTitleEnglish: 'Test Anime EN',
    artistName: 'Test Artist',
    allArtists: ['Test Artist'],
    artistSlugs: ['test_artist'],
    artistRoles: ['performer'],
    anilistId: 42,
    kitsuId: null,
    animeTitleAlternative: ['Alt Title'],
    animeSeason: 'FALL',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/cover.jpg',
    animeCoverImageSmall: 'https://example.com/cover-small.jpg',
    animeGrillImage: 'https://example.com/grill.jpg',
    animeStudios: ['Studio Test'],
    animeSeries: ['Test Anime'],
    type: 'OP',
    sequence: 1,
    entries: [],
    videoUrl: 'https://example.com/theme.webm',
    audioUrl: 'https://example.com/theme.webm',
    mood: ['epic'],
    embedding: [0.1, 0.2],
    avgRating: 9,
    totalRatings: 3,
    totalWatches: 10,
    totalListens: 4,
    duration: 90,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: true,
    popularRank: 1,
    featuredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function serviceWith(model: unknown): ThemesService {
  return new ThemesService(model as Model<ThemeCacheDocument>);
}

describe('ThemesService — no database configured', () => {
  const service = new ThemesService(undefined);

  it('getHome answers 503', async () => {
    await expect(service.getHome()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getHome()).rejects.toMatchObject({
      response: { statusCode: 503 },
    });
  });

  it('getThemeBySlug answers 503', async () => {
    await expect(service.getThemeBySlug('x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('search answers 503', async () => {
    await expect(service.search('test')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('getSimilarThemes answers 503', async () => {
    await expect(service.getSimilarThemes('x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('getRelatedAnime answers 503', async () => {
    await expect(service.getRelatedAnime('42')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ThemesService.getHome', () => {
  it('returns the season rail and popular list in the contract shape', async () => {
    const railDoc = makeDoc({ slug: 'rail-theme', isPopular: false });
    const popularDoc = makeDoc({ slug: 'popular-theme', popularRank: 7 });
    const find = jest.fn((filter: Record<string, unknown>) => {
      if ('animeSeason' in filter) return queryOf([railDoc]);
      if ('isPopular' in filter) return queryOf([popularDoc]);
      throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
    });
    const service = serviceWith({ find });

    // 2026-11-07 → FALL 2026
    const home = await service.getHome(new Date(2026, 10, 7));

    expect(home.season).toEqual({ season: 'FALL', year: 2026 });
    expect(find).toHaveBeenCalledWith({
      animeSeason: 'FALL',
      animeSeasonYear: 2026,
    });
    expect(find).toHaveBeenCalledWith({ isPopular: true });
    expect(home.seasonRail).toHaveLength(1);
    expect(home.seasonRail[0]).toMatchObject({
      slug: 'rail-theme',
      songTitle: 'Test Song',
      type: 'OP',
    });
    // Summaries are projections: no detail-only fields leak in.
    expect(home.seasonRail[0]).not.toHaveProperty('entries');
    expect(home.seasonRail[0]).not.toHaveProperty('embedding');
    expect(home.popular).toHaveLength(1);
    expect(home.popular[0].slug).toBe('popular-theme');
    // Current season has data: no fallback queries are issued.
    const railQueries = find.mock.calls.filter(
      ([filter]) => 'animeSeason' in filter,
    );
    expect(railQueries).toHaveLength(1);
  });

  /**
   * A find mock serving a catalogue described by a season map:
   * keys are "SEASON YEAR", values the docs that season holds.
   * The popular rail always serves one doc.
   */
  function serviceWithSeasons(catalogue: Record<string, unknown[]>) {
    const find = jest.fn((filter: Record<string, unknown>) => {
      if ('animeSeason' in filter) {
        return queryOf(
          catalogue[`${filter.animeSeason} ${filter.animeSeasonYear}`] ?? [],
        );
      }
      if ('isPopular' in filter) {
        return queryOf([makeDoc({ slug: 'popular-theme', popularRank: 7 })]);
      }
      throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
    });
    return { service: serviceWith({ find }), find };
  }

  it('falls back to the previous season, under its true label, when the current season is empty', async () => {
    const summerDoc = makeDoc({
      slug: 'summer-theme',
      animeSeason: 'SUMMER',
      isPopular: false,
    });
    const { service } = serviceWithSeasons({ 'SUMMER 2026': [summerDoc] });

    // 2026-11-07 → FALL 2026, which the catalogue does not hold yet.
    const home = await service.getHome(new Date(2026, 10, 7));

    expect(home.season).toEqual({ season: 'SUMMER', year: 2026 });
    expect(home.seasonRail).toHaveLength(1);
    expect(home.seasonRail[0].slug).toBe('summer-theme');
    // The popular rail is untouched by the fallback.
    expect(home.popular).toHaveLength(1);
    expect(home.popular[0].slug).toBe('popular-theme');
  });

  it('skips multiple empty seasons to the latest one with data', async () => {
    const winterDoc = makeDoc({
      slug: 'winter-theme',
      animeSeason: 'WINTER',
      isPopular: false,
    });
    const { service, find } = serviceWithSeasons({
      'WINTER 2026': [winterDoc],
    });

    const home = await service.getHome(new Date(2026, 10, 7));

    expect(home.season).toEqual({ season: 'WINTER', year: 2026 });
    expect(home.seasonRail[0].slug).toBe('winter-theme');
    // FALL, SUMMER, SPRING were each probed (and empty) before WINTER.
    const probed = find.mock.calls
      .filter(([filter]) => 'animeSeason' in filter)
      .map(
        ([filter]) => `${filter.animeSeason} ${filter.animeSeasonYear}`,
      );
    expect(probed).toEqual([
      'FALL 2026',
      'SUMMER 2026',
      'SPRING 2026',
      'WINTER 2026',
    ]);
  });

  it('crosses the year boundary when walking back (WINTER 2026 → FALL 2025)', async () => {
    const fallDoc = makeDoc({
      slug: 'last-fall-theme',
      animeSeason: 'FALL',
      animeSeasonYear: 2025,
      isPopular: false,
    });
    const { service } = serviceWithSeasons({ 'FALL 2025': [fallDoc] });

    // Mid-January 2026 → current season is WINTER 2026, still empty.
    const home = await service.getHome(new Date(2026, 0, 15));

    expect(home.season).toEqual({ season: 'FALL', year: 2025 });
    expect(home.seasonRail[0].slug).toBe('last-fall-theme');
  });

  it('keeps the empty rail under the current season label when no season has data', async () => {
    const { service, find } = serviceWithSeasons({});

    const home = await service.getHome(new Date(2026, 10, 7));

    expect(home.season).toEqual({ season: 'FALL', year: 2026 });
    expect(home.seasonRail).toEqual([]);
    expect(home.popular).toHaveLength(1);
    // The walk is bounded: current season + 8 steps back, no more.
    const railQueries = find.mock.calls.filter(
      ([filter]) => 'animeSeason' in filter,
    );
    expect(railQueries).toHaveLength(9);
  });
});

describe('ThemesService.getThemeBySlug', () => {
  it('returns the full detail, minus embedding/__v', async () => {
    const findOne = jest.fn(() => queryOf(makeDoc()));
    const service = serviceWith({ findOne });

    const detail = await service.getThemeBySlug('test_anime-op1-1');

    expect(findOne).toHaveBeenCalledWith({ slug: 'test_anime-op1-1' });
    expect(detail).toMatchObject({
      id: '507f1f77bcf86cd799439011',
      slug: 'test_anime-op1-1',
      animethemesId: 1,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(detail).not.toHaveProperty('embedding');
    expect(detail).not.toHaveProperty('__v');
  });

  it('404s with the contracts error shape for an unknown slug', async () => {
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWith({ findOne });

    const error = await service
      .getThemeBySlug('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('nope'),
    });
  });
});

/**
 * Model stand-in for search tests. Dispatches `find` by filter shape:
 * a top-level `$or` whose first clause is a `^`-anchored RegExp is the
 * stage-1 prefix query; anything else is the stage-2 full-regex query.
 */
function searchModel(opts: {
  candidates?: unknown[];
  results?: unknown[];
  total?: number;
}) {
  const stage1Queries: ReturnType<typeof queryOf>[] = [];
  const stage2Queries: ReturnType<typeof queryOf>[] = [];
  const find = jest.fn((filter: Record<string, unknown>) => {
    const orClauses = filter.$or as Record<string, RegExp>[] | undefined;
    const firstValue = orClauses?.[0]
      ? Object.values(orClauses[0])[0]
      : undefined;
    const isPrefixStage =
      firstValue instanceof RegExp && firstValue.source.startsWith('^');
    const q = queryOf(
      isPrefixStage ? (opts.candidates ?? []) : (opts.results ?? []),
    );
    (isPrefixStage ? stage1Queries : stage2Queries).push(q);
    return q;
  });
  const countDocuments = jest.fn(() => queryOf(opts.total ?? 0));
  return {
    model: { find, countDocuments },
    find,
    countDocuments,
    stage1Queries,
    stage2Queries,
  };
}

describe('ThemesService.search', () => {
  it('stage 1 prefix-narrows candidates; stage 2 regexes within their ids', async () => {
    const { model, find, countDocuments, stage1Queries, stage2Queries } =
      searchModel({
        candidates: [makeDoc({ _id: 'cand-a' }), makeDoc({ _id: 'cand-b' })],
        results: [makeDoc({ slug: 'narrowed-hit' })],
        total: 1,
      });
    const service = serviceWith(model);

    const res = await service.search('test');

    expect(find).toHaveBeenCalledTimes(2);

    // Stage 1: prefix regex on the first word over the web's three fields.
    const prefixFilter = find.mock.calls[0][0] as {
      $or: Record<string, RegExp>[];
    };
    expect(prefixFilter.$or.map((c) => Object.keys(c)[0])).toEqual([
      'animeTitle',
      'songTitle',
      'artistName',
    ]);
    expect(prefixFilter.$or[0].animeTitle).toBeInstanceOf(RegExp);
    expect(prefixFilter.$or[0].animeTitle.source).toBe('^test');
    expect(prefixFilter.$or[0].animeTitle.flags).toContain('i');
    expect(stage1Queries[0].select).toHaveBeenCalledWith('_id');
    expect(stage1Queries[0].limit).toHaveBeenCalledWith(400);

    // Stage 2: $and of the candidate ids and the full word filter.
    const stage2Filter = find.mock.calls[1][0] as {
      $and: [{ _id: { $in: unknown[] } }, { $or: Record<string, RegExp>[] }];
    };
    expect(stage2Filter.$and[0]).toEqual({
      _id: { $in: ['cand-a', 'cand-b'] },
    });
    const wordClause = stage2Filter.$and[1];
    expect(wordClause.$or.map((c) => Object.keys(c)[0])).toEqual([
      'animeTitle',
      'songTitle',
      'artistName',
    ]);
    expect(wordClause.$or[0].animeTitle.source).toBe('test');

    // Web order and page size; the count runs on the same effective filter.
    expect(stage2Queries[0].sort).toHaveBeenCalledWith({
      totalWatches: -1,
      avgRating: -1,
    });
    expect(stage2Queries[0].skip).toHaveBeenCalledWith(0);
    expect(stage2Queries[0].limit).toHaveBeenCalledWith(20);
    expect(countDocuments).toHaveBeenCalledWith(find.mock.calls[1][0]);

    expect(res).toMatchObject({
      query: 'test',
      searchType: 'regex',
      page: 1,
      total: 1,
      hasMore: false,
      themeTypeFilter: null,
      themeSeqFilter: null,
    });
    expect(res.results.map((r) => r.slug)).toEqual(['narrowed-hit']);
  });

  it('stage 2 runs unrestricted when stage 1 finds no candidates', async () => {
    const { model, find } = searchModel({
      candidates: [],
      results: [makeDoc({ slug: 'full-scan-hit' })],
      total: 1,
    });
    const service = serviceWith(model);

    const res = await service.search('test');

    expect(find).toHaveBeenCalledTimes(2);
    const stage2Filter = find.mock.calls[1][0] as Record<string, unknown>;
    expect(stage2Filter).not.toHaveProperty('$and');
    expect(stage2Filter).not.toHaveProperty('_id');
    expect(Object.keys(stage2Filter)).toEqual(['$or']);
    expect(res.results.map((r) => r.slug)).toEqual(['full-scan-hit']);
  });

  it('stage 2: every word must match ($and across words), regex escaped', async () => {
    const { model, find } = searchModel({
      candidates: [],
      results: [],
      total: 0,
    });
    const service = serviceWith(model);

    await service.search('test a.b');

    const stage2Filter = find.mock.calls[1][0] as {
      $and: { $or: Record<string, RegExp>[] }[];
    };
    expect(stage2Filter.$and).toHaveLength(2);
    expect(stage2Filter.$and[0].$or[0].animeTitle.source).toBe('test');
    // The '.' from the raw query is escaped, not a regex wildcard.
    expect(stage2Filter.$and[1].$or[0].animeTitle.source).toBe('a\\.b');
  });

  it('OP/ED tokens become type/sequence filters and skip stage 1', async () => {
    const { model, find, stage2Queries } = searchModel({
      results: [makeDoc({ slug: 'op9-hit' })],
      total: 1,
    });
    const service = serviceWith(model);

    const res = await service.search('op 9 test');

    // No prefix-narrowing call when a theme modifier is used.
    expect(find).toHaveBeenCalledTimes(1);
    const filter = find.mock.calls[0][0] as Record<string, unknown> & {
      $or: Record<string, RegExp>[];
    };
    expect(filter.type).toBe('OP');
    expect(filter.sequence).toBe(9);
    expect(filter.$or.map((c) => Object.keys(c)[0])).toEqual([
      'animeTitle',
      'songTitle',
      'artistName',
    ]);
    // The web widens the page to 50 when a modifier is used.
    expect(stage2Queries[0].limit).toHaveBeenCalledWith(50);
    expect(res.themeTypeFilter).toBe('OP');
    expect(res.themeSeqFilter).toBe(9);
    expect(res.results.map((r) => r.slug)).toEqual(['op9-hit']);
  });

  it('inline modifier "ed12" works with no words left to search', async () => {
    const { model, find } = searchModel({ results: [], total: 0 });
    const service = serviceWith(model);

    const res = await service.search('ed12');

    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({ type: 'ED', sequence: 12 });
    expect(res.themeTypeFilter).toBe('ED');
    expect(res.themeSeqFilter).toBe(12);
  });

  it('paginates like the web SONGS view; hasMore derives from the total', async () => {
    const { model, stage2Queries } = searchModel({
      candidates: [makeDoc({ _id: 'cand-a' })],
      results: [makeDoc({ slug: 'page-2-hit' })],
      total: 21,
    });
    const service = serviceWith(model);

    const res = await service.search('test', 2);

    expect(stage2Queries[0].skip).toHaveBeenCalledWith(20);
    expect(stage2Queries[0].limit).toHaveBeenCalledWith(20);
    expect(res.page).toBe(2);
    expect(res.total).toBe(21);
    // skip (20) + page results (1) is not < total (21): no further page.
    expect(res.hasMore).toBe(false);
  });

  it('empty query short-circuits without touching the model', async () => {
    const find = jest.fn(() => queryOf([]));
    const countDocuments = jest.fn(() => queryOf(0));
    const service = serviceWith({ find, countDocuments });

    await expect(service.search('   ')).resolves.toEqual({
      query: '',
      results: [],
      searchType: 'regex',
      page: 1,
      total: 0,
      hasMore: false,
      themeTypeFilter: null,
      themeSeqFilter: null,
    });
    expect(find).not.toHaveBeenCalled();
    expect(countDocuments).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Slice S8 — similar themes + related anime                           */
/* ------------------------------------------------------------------ */

describe('ThemesService.getSimilarThemes', () => {
  it('404s for an unknown slug', async () => {
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWith({ findOne });

    const error = await service
      .getSimilarThemes('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Theme not found: nope',
    });
  });

  it('queries the web’s $or (anime / artist / mood / first-entry tags), web order, cap 20', async () => {
    const source = makeDoc({
      slug: 'source-theme',
      animeTitle: 'Source Anime',
      artistName: 'Source Artist',
      mood: ['epic', 'calm'],
      entries: [{ tags: ['NC', 'BD'] }, { tags: ['Lyrics'] }],
    });
    const hit = makeDoc({ slug: 'similar-hit' });
    const findOne = jest.fn(() => queryOf(source));
    const findQuery = queryOf([hit]);
    const find = jest.fn((_filter: Record<string, unknown>) => findQuery);
    const service = serviceWith({ findOne, find });

    const res = await service.getSimilarThemes('source-theme');

    expect(find).toHaveBeenCalledTimes(1);
    const filter = find.mock.calls[0][0] as {
      $and: [Record<string, unknown>, { $or: Record<string, unknown>[] }];
    };
    // Excludes itself, then the web's four-way $or.
    expect(filter.$and[0]).toEqual({ slug: { $ne: 'source-theme' } });
    expect(filter.$and[1].$or).toEqual([
      { animeTitle: 'Source Anime' },
      { artistName: 'Source Artist' },
      { mood: { $in: ['epic', 'calm'] } },
      // Tags come from the FIRST entry only (the web's entries[0]).
      { entries: { $elemMatch: { tags: { $in: ['NC', 'BD'] } } } },
    ]);
    // Web order + cap.
    expect(findQuery.sort).toHaveBeenCalledWith({
      totalRatings: -1,
      avgRating: -1,
    });
    expect(findQuery.limit).toHaveBeenCalledWith(20);

    // Projected summaries: no detail-only fields leak in.
    expect(res.themes.map((t) => t.slug)).toEqual(['similar-hit']);
    expect(res.themes[0]).not.toHaveProperty('entries');
    expect(res.themes[0]).not.toHaveProperty('embedding');
  });

  it('an entry-less theme queries with an empty tag list (web quirk)', async () => {
    const source = makeDoc({ slug: 'bare-theme', entries: [], mood: [] });
    const findOne = jest.fn(() => queryOf(source));
    const find = jest.fn((_filter: Record<string, unknown>) => queryOf([]));
    const service = serviceWith({ findOne, find });

    await service.getSimilarThemes('bare-theme');

    const filter = find.mock.calls[0][0] as {
      $and: [unknown, { $or: Record<string, unknown>[] }];
    };
    expect(filter.$and[1].$or[2]).toEqual({ mood: { $in: [] } });
    expect(filter.$and[1].$or[3]).toEqual({
      entries: { $elemMatch: { tags: { $in: [] } } },
    });
  });
});

function makeAnimeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'anime-1',
    anilistId: 42,
    malId: 4001,
    kitsuId: null,
    titleRomaji: 'Series Anime',
    titleEnglish: 'Series Anime EN',
    titleNative: null,
    titleAlternative: [],
    synonyms: [],
    season: 'SPRING',
    seasonYear: 2020,
    genres: ['Action'],
    coverImageLarge: 'https://example.com/large.jpg',
    coverImageMedium: 'https://example.com/medium.jpg',
    bannerImage: null,
    atCoverImage: null,
    atGrillImage: null,
    studios: ['Studio Test'],
    series: ['Series'],
    totalEpisodes: 12,
    status: 'FINISHED',
    averageScore: 80,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function serviceWithAnime(animeModel: unknown): ThemesService {
  return new ThemesService(
    undefined,
    animeModel as Model<AnimeCacheDocument>,
  );
}

describe('ThemesService.getRelatedAnime', () => {
  it('404s with the web’s message for an unknown id', async () => {
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWithAnime({ findOne });

    const error = await service
      .getRelatedAnime('999')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Anime not found',
    });
    expect(findOne).toHaveBeenCalledWith({ anilistId: 999 });
  });

  it('parses the id the web way: parseInt (a non-numeric id matches nothing)', async () => {
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWithAnime({ findOne });

    await service.getRelatedAnime('not-a-number').catch(() => undefined);
    expect(findOne).toHaveBeenCalledWith({ anilistId: NaN });
  });

  it('answers an empty list when the anime has no series recorded', async () => {
    const findOne = jest.fn(() => queryOf(makeAnimeDoc({ series: [] })));
    const find = jest.fn(() => queryOf([]));
    const service = serviceWithAnime({ findOne, find });

    await expect(service.getRelatedAnime('42')).resolves.toEqual({
      related: [],
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('finds the other series members, chronological, cap 10, projected', async () => {
    const findOne = jest.fn(() => queryOf(makeAnimeDoc()));
    const findQuery = queryOf([
      makeAnimeDoc({
        _id: 'anime-2',
        anilistId: 43,
        titleRomaji: 'Series Anime S2',
        seasonYear: 2022,
      }),
    ]);
    const find = jest.fn((_filter: Record<string, unknown>) => findQuery);
    const service = serviceWithAnime({ findOne, find });

    const res = await service.getRelatedAnime('42');

    const filter = find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toEqual({
      $and: [
        { anilistId: { $ne: 42 } },
        { series: { $in: ['Series'] } },
      ],
    });
    expect(findQuery.sort).toHaveBeenCalledWith({ seasonYear: 1 });
    expect(findQuery.limit).toHaveBeenCalledWith(10);

    expect(res.related).toHaveLength(1);
    expect(res.related[0]).toMatchObject({
      anilistId: 43,
      titleRomaji: 'Series Anime S2',
      season: 'SPRING',
      seasonYear: 2022,
      series: ['Series'],
    });
    // Projection: bookkeeping fields stay server-side.
    expect(res.related[0]).not.toHaveProperty('syncedAt');
    expect(res.related[0]).not.toHaveProperty('synonyms');
    expect(res.related[0]).not.toHaveProperty('atCoverImage');
  });
});
