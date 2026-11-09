import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Model } from 'mongoose';
import type { AnimeCacheDocument } from '../sync/anime-cache.schema';
import type { ArtistCacheDocument } from '../sync/artist-cache.schema';
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

  it('caps the season rail query at 20 but the popular rail query at 50', async () => {
    const limits: number[] = [];
    const chainFor = (docs: unknown[]) => {
      const chain: Record<string, unknown> = {};
      chain.sort = () => chain;
      chain.limit = (n: number) => {
        limits.push(n);
        return chain;
      };
      chain.lean = () => chain;
      chain.exec = async () => docs;
      return chain;
    };
    const find = jest.fn((filter: Record<string, unknown>) => {
      if ('animeSeason' in filter) {
        return chainFor([makeDoc({ slug: 'rail-theme', isPopular: false })]);
      }
      if ('isPopular' in filter) {
        return chainFor([makeDoc({ slug: 'popular-theme', popularRank: 7 })]);
      }
      throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
    });
    const service = serviceWith({ find });

    const home = await service.getHome(new Date(2026, 10, 7));

    expect(limits).toEqual([20, 50]);
    expect(home.seasonRail).toHaveLength(1);
    expect(home.popular).toHaveLength(1);
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

describe('ThemesService.getSeasonThemes', () => {
  it('serves the season in the contract shape, querying the web seasonal filter', async () => {
    const doc = makeDoc({ slug: 'spring-theme', animeSeason: 'SPRING' });
    const find = jest.fn(() => queryOf([doc]));
    const service = serviceWith({ find });

    const res = await service.getSeasonThemes('spring', '2026');

    expect(find).toHaveBeenCalledWith({
      animeSeason: 'SPRING',
      animeSeasonYear: 2026,
    });
    expect(res).toMatchObject({ season: 'SPRING', year: 2026, page: 1 });
    expect(res.themes).toHaveLength(1);
    expect(res.themes[0].slug).toBe('spring-theme');
    expect(res.themes[0]).not.toHaveProperty('entries');
    // One partial page: no more pages behind it.
    expect(res.hasMore).toBe(false);
  });

  it('sorts sequence asc then avgRating desc, pages by 20, and reports hasMore on a full page', async () => {
    const sorts: Record<string, number>[] = [];
    const skips: number[] = [];
    const docs = Array.from({ length: 20 }, (_, i) =>
      makeDoc({ slug: `t-${i}` }),
    );
    const chain: Record<string, unknown> = {};
    chain.sort = (spec: Record<string, number>) => {
      sorts.push(spec);
      return chain;
    };
    chain.skip = (n: number) => {
      skips.push(n);
      return chain;
    };
    chain.limit = () => chain;
    chain.lean = () => chain;
    chain.exec = async () => docs;
    const find = jest.fn(() => chain);
    const service = serviceWith({ find });

    const res = await service.getSeasonThemes('FALL', '2026', undefined, '2');

    expect(sorts).toEqual([{ sequence: 1, avgRating: -1 }]);
    expect(skips).toEqual([20]);
    expect(res.page).toBe(2);
    expect(res.hasMore).toBe(true);
  });

  it('applies the OP/ED type filter only for a real type (the web’s rule)', async () => {
    const find = jest.fn(() => queryOf([]));
    const service = serviceWith({ find });

    await service.getSeasonThemes('SUMMER', '2026', 'ed');
    expect(find).toHaveBeenCalledWith({
      animeSeason: 'SUMMER',
      animeSeasonYear: 2026,
      type: 'ED',
    });

    find.mockClear();
    await service.getSeasonThemes('SUMMER', '2026', 'banana');
    expect(find).toHaveBeenCalledWith({
      animeSeason: 'SUMMER',
      animeSeasonYear: 2026,
    });
  });

  it('answers 400 when season or year is missing or not a season (the web’s ‘Season and year required’)', async () => {
    const service = serviceWith({ find: jest.fn(() => queryOf([])) });
    await expect(
      service.getSeasonThemes(undefined, '2026'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getSeasonThemes('SPRING', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getSeasonThemes('RAINY', '2026'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getSeasonThemes('SPRING', 'not-a-year'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 503 without a database', async () => {
    const service = new ThemesService(undefined);
    await expect(
      service.getSeasonThemes('SPRING', '2026'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
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

  it('fills a null audioUrl with the derived .ogg twin (theme + entry)', async () => {
    const entry = {
      atEntryId: 11,
      version: 'v1',
      episodes: null,
      spoiler: false,
      nsfw: false,
      tags: [],
      videoSources: [
        {
          resolution: 720,
          url: 'https://v.animethemes.moe/TestAnime-OP1.webm',
          source: null,
          mime: 'video/webm',
        },
      ],
      videoUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
      audioUrl: null,
      duration: 90,
    };
    const findOne = jest.fn(() =>
      queryOf(
        makeDoc({
          videoUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
          audioUrl: null,
          entries: [entry],
        }),
      ),
    );
    const service = serviceWith({ findOne });

    const detail = await service.getThemeBySlug('test_anime-op1-1');

    expect(detail.audioUrl).toBe(
      'https://a.animethemes.moe/TestAnime-OP1.ogg',
    );
    expect(detail.entries[0].audioUrl).toBe(
      'https://a.animethemes.moe/TestAnime-OP1.ogg',
    );
  });

  it('never overwrites a stored audioUrl with the derivation', async () => {
    const entry = {
      atEntryId: 11,
      version: 'v1',
      episodes: null,
      spoiler: false,
      nsfw: false,
      tags: [],
      videoSources: [],
      videoUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
      audioUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
      duration: 90,
    };
    const findOne = jest.fn(() =>
      queryOf(
        makeDoc({
          videoUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
          audioUrl: 'https://v.animethemes.moe/TestAnime-OP1.webm',
          entries: [entry],
        }),
      ),
    );
    const service = serviceWith({ findOne });

    const detail = await service.getThemeBySlug('test_anime-op1-1');

    expect(detail.audioUrl).toBe(
      'https://v.animethemes.moe/TestAnime-OP1.webm',
    );
    expect(detail.entries[0].audioUrl).toBe(
      'https://v.animethemes.moe/TestAnime-OP1.webm',
    );
  });

  it('leaves audioUrl null when the video is not on the AnimeThemes host', async () => {
    const findOne = jest.fn(() =>
      queryOf(makeDoc({ audioUrl: null })),
    );
    const service = serviceWith({ findOne });

    const detail = await service.getThemeBySlug('test_anime-op1-1');

    // makeDoc's videoUrl is example.com — outside the derivation rule.
    expect(detail.audioUrl).toBeNull();
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

    // Web order and page size, plus the Bug 6 `_id` tiebreaker;
    // the count runs on the same effective filter.
    expect(stage2Queries[0].sort).toHaveBeenCalledWith({
      totalWatches: -1,
      avgRating: -1,
      _id: 1,
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

  it('Bug 6: pages partition cleanly on a tie-heavy dataset (unique sort tiebreaker)', async () => {
    // 45 themes ALL tied at 0 watches / 0 rating — the production
    // shape for broad queries — stored in reverse _id order so
    // physical order disagrees with the tiebreaker order.
    const docs = Array.from({ length: 45 }, (_, i) => {
      const n = 44 - i;
      return makeDoc({
        _id: `tie-${String(n).padStart(2, '0')}`,
        slug: `tie-theme-${n}`,
        animeTitle: 'The Tie Anime',
        totalWatches: 0,
        avgRating: 0,
      });
    });

    // A faithful query stand-in: actually applies the sort spec,
    // skip and limit the service asks for, like Mongo would.
    const applyingQuery = (rows: Record<string, unknown>[]) => {
      let result = [...rows];
      const q: Record<string, unknown> = {};
      q.sort = (spec: Record<string, number>) => {
        const keys = Object.entries(spec);
        result.sort((a, b) => {
          for (const [key, dir] of keys) {
            const av = a[key] as never;
            const bv = b[key] as never;
            if (av < bv) return -dir;
            if (av > bv) return dir;
          }
          return 0;
        });
        return q;
      };
      q.skip = (n: number) => {
        result = result.slice(n);
        return q;
      };
      q.limit = (n: number) => {
        result = result.slice(0, n);
        return q;
      };
      q.select = () => q;
      q.lean = () => q;
      q.exec = async () => result;
      return q;
    };

    let findCalls = 0;
    const find = jest.fn(() => {
      findCalls += 1;
      // Call 1 of each search is stage-1 narrowing: no candidates,
      // so stage 2 runs over the whole dataset.
      return findCalls % 2 === 1 ? queryOf([]) : applyingQuery(docs);
    });
    const countDocuments = jest.fn(() => queryOf(docs.length));
    const service = serviceWith({ find, countDocuments });

    const page1 = await service.search('the', 1);
    const page2 = await service.search('the', 2);

    expect(page1.results).toHaveLength(20);
    expect(page2.results).toHaveLength(20);
    const slugs1 = new Set(page1.results.map((r) => r.slug));
    const overlap = page2.results.filter((r) => slugs1.has(r.slug));
    expect(overlap).toEqual([]);
    expect(
      new Set([...slugs1, ...page2.results.map((r) => r.slug)]).size,
    ).toBe(40);
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
      anime: [],
      artists: [],
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
/* Grouped search — the web's ALL-view anime + artist groups           */
/* ------------------------------------------------------------------ */

/**
 * Three-model stand-in for grouped-search tests. The theme model's
 * `find` dispatches by filter shape: the two group count projections
 * (an `anilistId` / `artistSlugs` key), the stage-1 prefix query
 * ($or whose first value is a ^-anchored RegExp), and stage 2
 * (anything else). Every call's query object is recorded.
 */
function groupedSearchModels(opts: {
  candidates?: unknown[];
  results?: unknown[];
  total?: number;
  animeDocs?: unknown[];
  artistDocs?: unknown[];
  animeThemeDocs?: unknown[];
  artistThemeDocs?: unknown[];
}) {
  const themeQueries: ReturnType<typeof queryOf>[] = [];
  const themeFind = jest.fn((filter: Record<string, unknown>) => {
    let docs: unknown[] = opts.results ?? [];
    if (filter && 'anilistId' in filter) docs = opts.animeThemeDocs ?? [];
    else if (filter && 'artistSlugs' in filter) {
      docs = opts.artistThemeDocs ?? [];
    } else {
      const orClauses = filter?.$or as Record<string, RegExp>[] | undefined;
      const firstValue = orClauses?.[0]
        ? Object.values(orClauses[0])[0]
        : undefined;
      if (firstValue instanceof RegExp && firstValue.source.startsWith('^')) {
        docs = opts.candidates ?? [];
      }
    }
    const q = queryOf(docs);
    themeQueries.push(q);
    return q;
  });
  const animeQueries: ReturnType<typeof queryOf>[] = [];
  const animeFind = jest.fn((_filter: Record<string, unknown>) => {
    const q = queryOf(opts.animeDocs ?? []);
    animeQueries.push(q);
    return q;
  });
  const artistQueries: ReturnType<typeof queryOf>[] = [];
  const artistFind = jest.fn((_filter: Record<string, unknown>) => {
    const q = queryOf(opts.artistDocs ?? []);
    artistQueries.push(q);
    return q;
  });
  const service = new ThemesService(
    {
      find: themeFind,
      countDocuments: jest.fn(() => queryOf(opts.total ?? 0)),
    } as unknown as Model<ThemeCacheDocument>,
    { find: animeFind } as unknown as Model<AnimeCacheDocument>,
    { find: artistFind } as unknown as Model<ArtistCacheDocument>,
  );
  return { service, themeFind, themeQueries, animeFind, animeQueries, artistFind, artistQueries };
}

describe('ThemesService.search — anime/artist groups', () => {
  it('serves both groups, projected, with theme counts from the theme collection', async () => {
    const { service, animeFind, animeQueries, artistFind, artistQueries } =
      groupedSearchModels({
        results: [makeDoc({ slug: 'song-hit' })],
        total: 1,
        animeDocs: [
          makeAnimeDoc({ anilistId: 42, titleRomaji: 'Test Anime', seasonYear: 2026 }),
          makeAnimeDoc({
            _id: 'anime-2',
            anilistId: 77,
            titleRomaji: 'Test Anime 2',
            titleEnglish: null,
            coverImageLarge: null,
            seasonYear: null,
          }),
          // No AniList id: the row could not navigate anywhere.
          makeAnimeDoc({ _id: 'anime-3', anilistId: null, titleRomaji: 'Unopenable' }),
        ],
        animeThemeDocs: [{ anilistId: 42 }, { anilistId: 42 }, { anilistId: 77 }],
        artistDocs: [
          {
            slug: 'test_artist',
            name: 'Test Artist',
            aliases: [],
            imageUrl: 'https://example.com/artist.jpg',
            totalThemes: 1,
          },
          {
            slug: 'other_artist',
            name: 'Other Artist',
            aliases: [],
            imageUrl: null,
            totalThemes: 9,
          },
        ],
        artistThemeDocs: [
          { artistSlugs: ['test_artist'] },
          { artistSlugs: ['test_artist', 'other_artist'] },
        ],
      });

    const res = await service.search('test');

    // The themes slice is untouched by the groups.
    expect(res.results.map((r) => r.slug)).toEqual(['song-hit']);

    // Anime filter: the web's three fields, one word → a bare $or.
    const animeFilter = animeFind.mock.calls[0][0] as {
      $or: Record<string, RegExp>[];
    };
    expect(animeFilter.$or.map((c) => Object.keys(c)[0])).toEqual([
      'titleRomaji',
      'titleEnglish',
      'synonyms',
    ]);
    expect(animeFilter.$or[0].titleRomaji.source).toBe('test');
    expect(animeQueries[0].limit).toHaveBeenCalledWith(5);

    expect(res.anime).toEqual([
      {
        anilistId: 42,
        titleRomaji: 'Test Anime',
        titleEnglish: 'Series Anime EN',
        coverImageLarge: 'https://example.com/large.jpg',
        seasonYear: 2026,
        themeCount: 2,
      },
      {
        anilistId: 77,
        titleRomaji: 'Test Anime 2',
        titleEnglish: null,
        coverImageLarge: null,
        seasonYear: null,
        themeCount: 1,
      },
    ]);

    // Artist filter: the web's two fields.
    const artistFilter = artistFind.mock.calls[0][0] as {
      $or: Record<string, RegExp>[];
    };
    expect(artistFilter.$or.map((c) => Object.keys(c)[0])).toEqual([
      'name',
      'aliases',
    ]);
    expect(artistQueries[0].limit).toHaveBeenCalledWith(5);

    // test_artist: counter says 1 but 2 themes carry the slug → 2.
    // other_artist: counter 9 stands above the counted 1 → 9.
    expect(res.artists).toEqual([
      {
        slug: 'test_artist',
        name: 'Test Artist',
        imageUrl: 'https://example.com/artist.jpg',
        totalThemes: 2,
      },
      {
        slug: 'other_artist',
        name: 'Other Artist',
        imageUrl: null,
        totalThemes: 9,
      },
    ]);
  });

  it('every word must match in the groups ($and across words)', async () => {
    const { service, animeFind, artistFind } = groupedSearchModels({});

    await service.search('test anime');

    const animeFilter = animeFind.mock.calls[0][0] as {
      $and: { $or: Record<string, RegExp>[] }[];
    };
    expect(animeFilter.$and).toHaveLength(2);
    expect(animeFilter.$and[1].$or[0].titleRomaji.source).toBe('anime');
    const artistFilter = artistFind.mock.calls[0][0] as {
      $and: { $or: Record<string, RegExp>[] }[];
    };
    expect(artistFilter.$and).toHaveLength(2);
    expect(artistFilter.$and[0].$or.map((c) => Object.keys(c)[0])).toEqual([
      'name',
      'aliases',
    ]);
  });

  it('an OP/ED modifier empties the groups and never queries the caches (web parity)', async () => {
    const { service, animeFind, artistFind } = groupedSearchModels({
      results: [makeDoc({ slug: 'op9-hit' })],
      total: 1,
    });

    const res = await service.search('op 9 test');

    expect(res.anime).toEqual([]);
    expect(res.artists).toEqual([]);
    expect(animeFind).not.toHaveBeenCalled();
    expect(artistFind).not.toHaveBeenCalled();
  });

  it('the groups are page-1 only', async () => {
    const { service, animeFind, artistFind } = groupedSearchModels({
      candidates: [makeDoc({ _id: 'cand-a' })],
      results: [makeDoc({ slug: 'page-2-hit' })],
      total: 21,
    });

    const res = await service.search('test', 2);

    expect(res.anime).toEqual([]);
    expect(res.artists).toEqual([]);
    expect(animeFind).not.toHaveBeenCalled();
    expect(artistFind).not.toHaveBeenCalled();
  });

  it('a service without cache models serves themes with empty groups', async () => {
    const { model } = searchModel({
      results: [makeDoc({ slug: 'themes-only-hit' })],
      total: 1,
    });
    const service = serviceWith(model);

    const res = await service.search('test');

    expect(res.results.map((r) => r.slug)).toEqual(['themes-only-hit']);
    expect(res.anime).toEqual([]);
    expect(res.artists).toEqual([]);
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

  it('parses the id the web way: parseInt (42x reads as 42)', async () => {
    const findOne = jest.fn(() => queryOf(makeAnimeDoc({ series: [] })));
    const service = serviceWithAnime({ findOne });

    await service.getRelatedAnime('42x');
    expect(findOne).toHaveBeenCalledWith({ anilistId: 42 });
  });

  it('Bug 4: a non-numeric id answers 404 without querying (NaN CastErrors through Mongoose)', async () => {
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWithAnime({ findOne });

    const error = await service
      .getRelatedAnime('not-a-number')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Anime not found',
    });
    expect(findOne).not.toHaveBeenCalled();
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

describe('ThemesService.getAnimeDetail', () => {
  function serviceWithBoth(themeModel: unknown, animeModel: unknown) {
    return new ThemesService(
      themeModel as Model<ThemeCacheDocument>,
      animeModel as Model<AnimeCacheDocument>,
    );
  }

  it('404s when neither the cache nor any theme exists', async () => {
    const service = serviceWithBoth(
      { find: jest.fn(() => queryOf([])) },
      { findOne: jest.fn(() => queryOf(null)) },
    );
    const error = await service.getAnimeDetail('999').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Anime not found',
    });
  });

  it('Bug 4: a non-numeric id answers 404 without querying either model', async () => {
    const find = jest.fn(() => queryOf([]));
    const findOne = jest.fn(() => queryOf(null));
    const service = serviceWithBoth({ find }, { findOne });
    const error = await service.getAnimeDetail('abc').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Anime not found',
    });
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('serves the projected cache header plus the mapped themes', async () => {
    const service = serviceWithBoth(
      { find: jest.fn(() => queryOf([makeDoc(), makeDoc({ slug: 'test_anime-ed1-1', type: 'ED' })])) },
      { findOne: jest.fn(() => queryOf(makeAnimeDoc())) },
    );
    const res = await service.getAnimeDetail('42');
    expect(res.anime).toMatchObject({
      anilistId: 42,
      titleRomaji: 'Series Anime',
      season: 'SPRING',
    });
    expect(res.themes).toHaveLength(2);
    expect(res.themes[0]).toMatchObject({ slug: 'test_anime-op1-1' });
  });

  it('synthesizes the header from the first theme when uncached (web parity)', async () => {
    const service = serviceWithBoth(
      { find: jest.fn(() => queryOf([makeDoc()])) },
      { findOne: jest.fn(() => queryOf(null)) },
    );
    const res = await service.getAnimeDetail('42');
    expect(res.anime).toMatchObject({
      anilistId: 42,
      titleRomaji: 'Test Anime',
      titleEnglish: 'Test Anime EN',
      season: 'FALL',
      seasonYear: 2026,
      coverImageLarge: 'https://example.com/cover.jpg',
      studios: ['Studio Test'],
      series: ['Test Anime'],
      genres: [],
      averageScore: null,
    });
    expect(res.themes).toHaveLength(1);
  });
});

describe('ThemesService.getArtistDetail', () => {
  function serviceWithArtist(themeModel: unknown, artistModel: unknown) {
    return new ThemesService(
      themeModel as Model<ThemeCacheDocument>,
      undefined,
      artistModel as never,
    );
  }

  it('404s when neither the cache nor any theme exists', async () => {
    const service = serviceWithArtist(
      { find: jest.fn(() => queryOf([])) },
      { findOne: jest.fn(() => queryOf(null)) },
    );
    const error = await service
      .getArtistDetail('nobody')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Artist not found',
    });
  });

  it('serves the cache header plus the mapped themes', async () => {
    const service = serviceWithArtist(
      { find: jest.fn(() => queryOf([makeDoc()])) },
      {
        findOne: jest.fn(() =>
          queryOf({
            slug: 'test_artist',
            name: 'Test Artist',
            aliases: ['TA'],
            imageUrl: 'https://example.com/artist.jpg',
            totalThemes: 7,
          }),
        ),
      },
    );
    const res = await service.getArtistDetail('test_artist');
    expect(res.artist).toEqual({
      slug: 'test_artist',
      name: 'Test Artist',
      aliases: ['TA'],
      imageUrl: 'https://example.com/artist.jpg',
      totalThemes: 7,
    });
    expect(res.themes).toHaveLength(1);
  });

  it('never reports a cache counter lower than the returned theme count', async () => {
    const service = serviceWithArtist(
      { find: jest.fn(() => queryOf([makeDoc(), makeDoc({ slug: 'test_anime-ed1-1', type: 'ED' })])) },
      {
        findOne: jest.fn(() =>
          queryOf({
            slug: 'test_artist',
            name: 'Test Artist',
            aliases: [],
            imageUrl: null,
            totalThemes: 0,
          }),
        ),
      },
    );
    const res = await service.getArtistDetail('test_artist');
    expect(res.artist.totalThemes).toBe(2);
    expect(res.themes).toHaveLength(2);
  });

  it('synthesizes the header from the first theme at the slug index (web parity)', async () => {
    const service = serviceWithArtist(
      {
        find: jest.fn(() =>
          queryOf([
            makeDoc({
              allArtists: ['Other Artist', 'Test Artist'],
              artistSlugs: ['other_artist', 'test_artist'],
              artistName: 'Other Artist',
            }),
          ]),
        ),
      },
      { findOne: jest.fn(() => queryOf(null)) },
    );
    const res = await service.getArtistDetail('test_artist');
    expect(res.artist).toEqual({
      slug: 'test_artist',
      name: 'Test Artist',
      aliases: [],
      imageUrl: null,
      totalThemes: 1,
    });
  });
});
