import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Model } from 'mongoose';
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
