import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LibraryService } from './library.service';

/**
 * LibraryService unit tests. All five models are in-memory fakes (no
 * live DB); the fake Rating model's aggregate genuinely computes
 * $avg/$sum over its store, so the ported post-save-hook recompute is
 * exercised for real, and the fake Theme/User models apply $inc/$set
 * updates to stored docs so counter end-states can be asserted.
 */

/* Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, jest.Mock> = {};
  q.sort = jest.fn((spec: Record<string, number>) => {
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
  });
  q.skip = jest.fn((n: number) => {
    result = result.slice(n);
    return q;
  });
  q.limit = jest.fn((n: number) => {
    result = result.slice(0, n);
    return q;
  });
  q.lean = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

function makeTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'theme-1',
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
    animeTitleAlternative: [],
    animeSeason: 'FALL',
    animeSeasonYear: 2026,
    animeCoverImage: null,
    animeCoverImageSmall: null,
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    type: 'OP',
    sequence: 1,
    entries: [
      { atEntryId: 11, duration: 60 },
      { atEntryId: 22, duration: 30 },
    ],
    videoUrl: 'https://example.com/theme.webm',
    audioUrl: null,
    mood: [],
    embedding: null,
    avgRating: 0,
    totalRatings: 0,
    totalWatches: 10,
    totalListens: 4,
    duration: 90,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: false,
    popularRank: null,
    featuredAt: null,
    ...overrides,
  };
}

type ThemeDoc = ReturnType<typeof makeTheme>;

function applyUpdate(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(update)) {
    if (key === '$inc') {
      const incs = value as Record<string, number>;
      for (const [field, delta] of Object.entries(incs)) {
        doc[field] = ((doc[field] as number) ?? 0) + delta;
      }
    } else if (key === '$set') {
      Object.assign(doc, value as Record<string, unknown>);
    } else {
      doc[key] = value;
    }
  }
}

function makeModels() {
  const themes: ThemeDoc[] = [makeTheme()];
  const users: Record<string, unknown>[] = [
    {
      _id: 'user-1',
      username: 'one',
      totalRatings: 0,
      totalTime: 0,
    },
    {
      _id: 'user-2',
      username: 'two',
      totalRatings: 0,
      totalTime: 0,
    },
  ];
  const favorites: Record<string, unknown>[] = [];
  const ratings: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  let favSeq = 0;
  let ratingSeq = 0;
  let histSeq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

  const matchClause = (t: ThemeDoc, clause: Record<string, unknown>) => {
    if (clause._id) {
      const inList = (clause._id as { $in: unknown[] }).$in;
      if (inList && !inList.some((id) => String(id) === String(t._id))) {
        return false;
      }
    }
    if (clause.anilistId) {
      const inList = (clause.anilistId as { $in: unknown[] }).$in;
      if (inList && !inList.some((id) => id === t.anilistId)) {
        return false;
      }
    }
    return true;
  };

  const matchThemeFilter = (filter: Record<string, unknown>) => {
    return themes.filter((t) => {
      if (!matchClause(t, filter)) return false;
      if (filter.type && t.type !== filter.type) return false;
      if (filter.audioUrl) {
        // The library count's { audioUrl: { $ne: null } }.
        const ne = (filter.audioUrl as { $ne: unknown }).$ne;
        if (ne === null && t.audioUrl == null) return false;
      }
      if (filter.$or) {
        const clauses = filter.$or as Record<string, unknown>[];
        if (!clauses.some((c) => matchClause(t, c))) return false;
      }
      return true;
    });
  };

  const themeModel = {
    docs: themes,
    findOne: jest.fn((filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
    ),
    find: jest.fn((filter: Record<string, unknown>) =>
      chain(matchThemeFilter(filter) as Record<string, unknown>[]),
    ),
    countDocuments: jest.fn((filter: Record<string, unknown>) =>
      queryOf(matchThemeFilter(filter).length),
    ),
    findByIdAndUpdate: jest.fn(
      (id: unknown, update: Record<string, unknown>) => {
        const doc = themes.find((t) => String(t._id) === String(id));
        if (doc) applyUpdate(doc as Record<string, unknown>, update);
        return queryOf(doc ?? null);
      },
    ),
  };

  const userModel = {
    docs: users,
    findById: jest.fn((id: unknown) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
    ),
    findByIdAndUpdate: jest.fn(
      (id: unknown, update: Record<string, unknown>) => {
        const doc = users.find((u) => String(u._id) === String(id));
        if (doc) applyUpdate(doc, update);
        return queryOf(doc ?? null);
      },
    ),
  };

  const favoriteModel = {
    docs: favorites,
    failNextCreateWithDuplicate: false,
    findOne: jest.fn((filter: Record<string, unknown>) =>
      queryOf(
        favorites.find(
          (f) =>
            String(f.userId) === String(filter.userId) &&
            String(f.themeId) === String(filter.themeId),
        ) ?? null,
      ),
    ),
    find: jest.fn((filter: Record<string, unknown>) =>
      chain(
        favorites.filter((f) => String(f.userId) === String(filter.userId)),
      ),
    ),
    create: jest.fn(async (data: Record<string, unknown>) => {
      if (favoriteModel.failNextCreateWithDuplicate) {
        favoriteModel.failNextCreateWithDuplicate = false;
        throw Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
        });
      }
      const doc = {
        _id: `fav-${++favSeq}`,
        createdAt: new Date((clock += 1000)),
        ...data,
      };
      favorites.push(doc);
      return doc;
    }),
    findOneAndDelete: jest.fn((filter: Record<string, unknown>) => {
      const idx = favorites.findIndex(
        (f) =>
          String(f.userId) === String(filter.userId) &&
          String(f.themeId) === String(filter.themeId),
      );
      const removed = idx >= 0 ? favorites.splice(idx, 1)[0] : null;
      return queryOf(removed);
    }),
  };

  const ratingModel = {
    docs: ratings,
    findOne: jest.fn((filter: Record<string, unknown>) =>
      queryOf(
        ratings.find(
          (r) =>
            String(r.userId) === String(filter.userId) &&
            String(r.themeId) === String(filter.themeId),
        ) ?? null,
      ),
    ),
    create: jest.fn(async (data: Record<string, unknown>) => {
      const doc = { _id: `rating-${++ratingSeq}`, ...data };
      ratings.push(doc);
      return doc;
    }),
    findByIdAndUpdate: jest.fn(
      (id: unknown, update: Record<string, unknown>) => {
        const doc = ratings.find((r) => String(r._id) === String(id));
        if (doc) applyUpdate(doc, update);
        return queryOf(doc ?? null);
      },
    ),
    findOneAndUpdate: jest.fn(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const doc = ratings.find(
          (r) =>
            String(r.userId) === String(filter.userId) &&
            String(r.themeId) === String(filter.themeId),
        );
        if (doc) applyUpdate(doc, update);
        return queryOf(doc ?? null);
      },
    ),
    findByIdAndDelete: jest.fn((id: unknown) => {
      const idx = ratings.findIndex((r) => String(r._id) === String(id));
      const removed = idx >= 0 ? ratings.splice(idx, 1)[0] : null;
      return queryOf(removed);
    }),
    aggregate: jest.fn(async (pipeline: Record<string, unknown>[]) => {
      const match = (pipeline[0] as { $match: { themeId: unknown } }).$match;
      const rows = ratings.filter(
        (r) => String(r.themeId) === String(match.themeId),
      );
      if (rows.length === 0) return [];
      const avg =
        rows.reduce((sum, r) => sum + (r.score as number), 0) / rows.length;
      return [{ _id: null, avg, count: rows.length }];
    }),
  };

  const historyModel = {
    docs: history,
    create: jest.fn(async (data: Record<string, unknown>) => {
      const doc = {
        _id: `hist-${++histSeq}`,
        viewedAt: new Date((clock += 60_000)),
        ...data,
      };
      history.push(doc);
      return doc;
    }),
    find: jest.fn((filter: Record<string, unknown>) =>
      chain(
        history.filter((h) => String(h.userId) === String(filter.userId)),
      ),
    ),
    distinct: jest.fn((field: string, filter: Record<string, unknown>) =>
      queryOf([
        ...new Set(
          history
            .filter((h) => String(h.userId) === String(filter.userId))
            .map((h) => h[field]),
        ),
      ]),
    ),
    exists: jest.fn(async (filter: Record<string, unknown>) =>
      history.some(
        (h) =>
          String(h.userId) === String(filter.userId) &&
          h.themeSlug === filter.themeSlug,
      )
        ? { _id: 'hist-exists' }
        : null,
    ),
  };

  return { themeModel, userModel, favoriteModel, ratingModel, historyModel };
}

function makeService() {
  const models = makeModels();
  const service = new LibraryService(
    models.themeModel as never,
    models.userModel as never,
    models.favoriteModel as never,
    models.ratingModel as never,
    models.historyModel as never,
  );
  return { models, service };
}

describe('LibraryService — no database configured', () => {
  const service = new LibraryService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  it('answers 503 from every method', async () => {
    await expect(service.getFavoriteState('u', 's')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.addFavorite('u', { slug: 's' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.removeFavorite('u', 's')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.listFavorites('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.recordWatch('u', { slug: 's', mode: 'watch' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.listHistory('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getLibraryCount('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.listLibraryThemes('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.checkWatched('u', 's')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getRatingState('u', 's')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.setRating('u', 's', { score: 8 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.clearRating('u', 's')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('LibraryService — favourites', () => {
  it('adds a favourite and reports the state', async () => {
    const { models, service } = makeService();
    const state = await service.addFavorite('user-1', {
      slug: 'test_anime-op1-1',
    });
    expect(state).toEqual({ slug: 'test_anime-op1-1', isFavorite: true });
    expect(models.favoriteModel.docs).toHaveLength(1);
    expect(models.favoriteModel.docs[0]).toMatchObject({
      userId: 'user-1',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
    });
  });

  it('is idempotent: adding twice stores one row and succeeds both times', async () => {
    const { models, service } = makeService();
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    const state = await service.addFavorite('user-1', {
      slug: 'test_anime-op1-1',
    });
    expect(state.isFavorite).toBe(true);
    expect(models.favoriteModel.docs).toHaveLength(1);
    expect(models.favoriteModel.create).toHaveBeenCalledTimes(1);
  });

  it('survives the unique-index race: a duplicate-key create still answers saved', async () => {
    const { models, service } = makeService();
    models.favoriteModel.failNextCreateWithDuplicate = true;
    const state = await service.addFavorite('user-1', {
      slug: 'test_anime-op1-1',
    });
    expect(state).toEqual({ slug: 'test_anime-op1-1', isFavorite: true });
  });

  it('rejects an unknown slug with this API’s 404 and a missing slug with 400', async () => {
    const { service } = makeService();
    await expect(
      service.addFavorite('user-1', { slug: 'nope' }),
    ).rejects.toMatchObject({
      message: 'Theme not found: nope',
    });
    await expect(
      service.addFavorite('user-1', { slug: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.addFavorite('user-1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes a favourite idempotently', async () => {
    const { models, service } = makeService();
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    const first = await service.removeFavorite('user-1', 'test_anime-op1-1');
    expect(first).toEqual({ slug: 'test_anime-op1-1', isFavorite: false });
    expect(models.favoriteModel.docs).toHaveLength(0);
    const second = await service.removeFavorite(
      'user-1',
      'test_anime-op1-1',
    );
    expect(second.isFavorite).toBe(false);
  });

  it('reports favourite state both ways', async () => {
    const { service } = makeService();
    await expect(
      service.getFavoriteState('user-1', 'test_anime-op1-1'),
    ).resolves.toEqual({ slug: 'test_anime-op1-1', isFavorite: false });
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    await expect(
      service.getFavoriteState('user-1', 'test_anime-op1-1'),
    ).resolves.toEqual({ slug: 'test_anime-op1-1', isFavorite: true });
    await expect(
      service.getFavoriteState('user-1', 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists nothing for a user without favourites', async () => {
    const { service } = makeService();
    await expect(service.listFavorites('user-1')).resolves.toEqual({
      themes: [],
      total: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    });
  });

  it('lists favourites in the web query’s order (seasonYear desc, title asc), with type filter + paging', async () => {
    const { models, service } = makeService();
    const t2 = makeTheme({
      _id: 'theme-2',
      slug: 'older-op',
      animeTitle: 'Alpha Anime',
      animeSeasonYear: 2020,
      type: 'OP',
    });
    const t3 = makeTheme({
      _id: 'theme-3',
      slug: 'newer-ed',
      animeTitle: 'Beta Anime',
      animeSeasonYear: 2026,
      type: 'ED',
    });
    models.themeModel.docs.push(t2, t3);
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    await service.addFavorite('user-1', { slug: 'older-op' });
    await service.addFavorite('user-1', { slug: 'newer-ed' });

    // 2026 themes first (Beta before Test on title), then 2020.
    const all = await service.listFavorites('user-1');
    expect(all.total).toBe(3);
    expect(all.themes.map((t) => t.slug)).toEqual([
      'newer-ed',
      'test_anime-op1-1',
      'older-op',
    ]);
    // Summaries only: no embedding / entries leak.
    expect(all.themes[0]).not.toHaveProperty('embedding');
    expect(all.themes[0]).not.toHaveProperty('entries');

    const eds = await service.listFavorites('user-1', 1, 50, 'ED');
    expect(eds.total).toBe(1);
    expect(eds.themes[0].slug).toBe('newer-ed');

    const page1 = await service.listFavorites('user-1', 1, 2);
    expect(page1.themes).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await service.listFavorites('user-1', 2, 2);
    expect(page2.themes).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });
});

describe('LibraryService — watch history', () => {
  it('records a watch: theme totalWatches +1, user totalTime += the played entry’s duration', async () => {
    const { models, service } = makeService();
    const res = await service.recordWatch('user-1', {
      slug: 'test_anime-op1-1',
      atEntryId: 22,
      mode: 'watch',
    });
    expect(res).toEqual({ recorded: true });
    expect(models.historyModel.docs).toHaveLength(1);
    expect(models.historyModel.docs[0]).toMatchObject({
      userId: 'user-1',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
      atEntryId: 22,
      mode: 'watch',
    });
    const theme = models.themeModel.docs[0];
    expect(theme.totalWatches).toBe(11);
    expect(theme.totalListens).toBe(4);
    const user = models.userModel.docs[0];
    expect(user.totalTime).toBe(30); // entry 22's duration, not the first entry's
  });

  it('records a listen: totalListens +1 and the first entry’s duration when atEntryId is absent', async () => {
    const { models, service } = makeService();
    await service.recordWatch('user-1', {
      slug: 'test_anime-op1-1',
      mode: 'listen',
    });
    const theme = models.themeModel.docs[0];
    expect(theme.totalListens).toBe(5);
    expect(theme.totalWatches).toBe(10);
    expect(models.userModel.docs[0].totalTime).toBe(60); // entries[0]
    expect(models.historyModel.docs[0].atEntryId).toBeNull();
  });

  it('falls back to entries[0] for an unknown atEntryId, and to 90s when no entry has a duration', async () => {
    const { models, service } = makeService();
    await service.recordWatch('user-1', {
      slug: 'test_anime-op1-1',
      atEntryId: 999,
      mode: 'watch',
    });
    expect(models.userModel.docs[0].totalTime).toBe(60);

    const bare = makeTheme({
      _id: 'theme-bare',
      slug: 'bare-theme',
      entries: [{ atEntryId: 5 }],
    });
    models.themeModel.docs.push(bare);
    await service.recordWatch('user-1', { slug: 'bare-theme', mode: 'watch' });
    expect(models.userModel.docs[0].totalTime).toBe(60 + 90);
  });

  it('rejects unknown slugs (404), invalid modes and a missing slug (400)', async () => {
    const { service } = makeService();
    await expect(
      service.recordWatch('user-1', { slug: 'nope', mode: 'watch' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.recordWatch('user-1', {
        slug: 'test_anime-op1-1',
        mode: 'bogus' as never,
      }),
    ).rejects.toMatchObject({ message: 'Invalid mode' });
    await expect(
      service.recordWatch('user-1', { mode: 'watch' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never fails the write when a counter update blows up (web hook parity)', async () => {
    const { models, service } = makeService();
    models.userModel.findByIdAndUpdate.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      service.recordWatch('user-1', {
        slug: 'test_anime-op1-1',
        mode: 'watch',
      }),
    ).resolves.toEqual({ recorded: true });
    expect(models.historyModel.docs).toHaveLength(1);
    spy.mockRestore();
  });

  it('lists history newest-first, capped at 50, with theme summaries joined', async () => {
    const { models, service } = makeService();
    for (let i = 0; i < 55; i++) {
      await service.recordWatch('user-1', {
        slug: 'test_anime-op1-1',
        mode: i % 2 ? 'listen' : 'watch',
      });
    }
    const res = await service.listHistory('user-1');
    expect(res.entries).toHaveLength(50);
    expect(res.entries[0].id).toBe('hist-55');
    expect(res.entries[49].id).toBe('hist-6');
    expect(res.entries[0].theme?.slug).toBe('test_anime-op1-1');
    expect(typeof res.entries[0].viewedAt).toBe('string');
    expect(models.historyModel.docs).toHaveLength(55);
  });

  it('joins a null theme when the theme has left the catalogue', async () => {
    const { models, service } = makeService();
    await models.historyModel.create({
      userId: 'user-1',
      themeId: 'ghost-theme',
      themeSlug: 'ghost',
      atEntryId: null,
      mode: 'watch',
    });
    const res = await service.listHistory('user-1');
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].theme).toBeNull();
    expect(res.entries[0].themeSlug).toBe('ghost');
  });
});

describe('LibraryService — library count', () => {
  /** Give a seeded user a stored AniList link with completed ids. */
  function linkAnilist(
    models: ReturnType<typeof makeModels>,
    userId: string,
    completedMediaIds: number[],
  ) {
    const doc = models.userModel.docs.find((u) => u._id === userId);
    if (!doc) throw new Error(`no seeded user ${userId}`);
    doc.anilist = { userId: 900, username: 'Ani', completedMediaIds };
  }

  it('answers 0 without querying the catalogue when neither side is populated (the web’s short-circuit)', async () => {
    const { models, service } = makeService();
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 0,
    });
    expect(models.themeModel.countDocuments).not.toHaveBeenCalled();
  });

  it('counts a locally watched theme that has an audio source', async () => {
    const { models, service } = makeService();
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-a',
        slug: 'a-op1-1',
        anilistId: 100,
        audioUrl: 'https://example.com/a.ogg',
      }),
    );
    models.historyModel.docs.push({
      userId: 'user-1',
      themeId: 'theme-a',
      themeSlug: 'a-op1-1',
      mode: 'watch',
    });
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 1,
    });
  });

  it('excludes a watched theme whose audioUrl is null (the web’s audio filter)', async () => {
    const { models, service } = makeService();
    // The seeded theme-1 has audioUrl: null.
    models.historyModel.docs.push({
      userId: 'user-1',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
      mode: 'listen',
    });
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 0,
    });
    expect(models.themeModel.countDocuments).toHaveBeenCalledWith({
      audioUrl: { $ne: null },
      $or: [{ _id: { $in: ['theme-1'] } }],
    });
  });

  it('counts themes from the stored AniList completed ids, with no local history at all', async () => {
    const { models, service } = makeService();
    linkAnilist(models, 'user-2', [42]);
    // The seeded theme-1 carries anilistId 42 but no audio — not counted.
    await expect(service.getLibraryCount('user-2')).resolves.toEqual({
      count: 0,
    });
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-b',
        slug: 'b-op1-1',
        anilistId: 42,
        audioUrl: 'https://example.com/b.ogg',
      }),
    );
    await expect(service.getLibraryCount('user-2')).resolves.toEqual({
      count: 1,
    });
    expect(models.themeModel.countDocuments).toHaveBeenLastCalledWith({
      audioUrl: { $ne: null },
      $or: [{ anilistId: { $in: [42] } }],
    });
  });

  it('counts a theme matching BOTH sides of the union only once', async () => {
    const { models, service } = makeService();
    linkAnilist(models, 'user-1', [100]);
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-a',
        slug: 'a-op1-1',
        anilistId: 100,
        audioUrl: 'https://example.com/a.ogg',
      }),
    );
    models.historyModel.docs.push({
      userId: 'user-1',
      themeId: 'theme-a',
      themeSlug: 'a-op1-1',
      mode: 'watch',
    });
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 1,
    });
  });

  it('mixes both sources and still applies the audio filter to each', async () => {
    const { models, service } = makeService();
    linkAnilist(models, 'user-1', [777]);
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-a',
        slug: 'a-op1-1',
        anilistId: 100,
        audioUrl: 'https://example.com/a.ogg',
      }),
      makeTheme({
        _id: 'theme-c',
        slug: 'c-op1-1',
        anilistId: 777,
        audioUrl: 'https://example.com/c.ogg',
      }),
    );
    // Watched with audio (theme-a) + watched without audio (theme-1)
    // + AniList-only with audio (theme-c) = 2.
    models.historyModel.docs.push(
      { userId: 'user-1', themeId: 'theme-a', themeSlug: 'a-op1-1', mode: 'watch' },
      { userId: 'user-1', themeId: 'theme-1', themeSlug: 'test_anime-op1-1', mode: 'watch' },
    );
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 2,
    });
  });

  it('ignores other users’ watch history entirely', async () => {
    const { models, service } = makeService();
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-a',
        slug: 'a-op1-1',
        anilistId: 100,
        audioUrl: 'https://example.com/a.ogg',
      }),
    );
    models.historyModel.docs.push({
      userId: 'user-2',
      themeId: 'theme-a',
      themeSlug: 'a-op1-1',
      mode: 'watch',
    });
    await expect(service.getLibraryCount('user-1')).resolves.toEqual({
      count: 0,
    });
    expect(models.themeModel.countDocuments).not.toHaveBeenCalled();
  });

  it('rejects an unknown user with the web’s 404', async () => {
    const { service } = makeService();
    const err = await service
      .getLibraryCount('ghost')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);
    expect((err as NotFoundException).message).toBe('User not found');
  });
});

describe('LibraryService — ratings', () => {
  it('creates a rating: aggregate written to the theme, user totalRatings +1', async () => {
    const { models, service } = makeService();
    const state = await service.setRating('user-1', 'test_anime-op1-1', {
      score: 8,
    });
    expect(state).toEqual({
      slug: 'test_anime-op1-1',
      myScore: 8,
      myMode: 'watch', // defaulted on create
      avgRating: 8,
      totalRatings: 1,
    });
    expect(models.ratingModel.docs).toHaveLength(1);
    expect(models.ratingModel.docs[0]).toMatchObject({
      userId: 'user-1',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
      score: 8,
      mode: 'watch',
    });
    const theme = models.themeModel.docs[0];
    expect(theme.avgRating).toBe(8);
    expect(theme.totalRatings).toBe(1);
    expect(models.userModel.docs[0].totalRatings).toBe(1);
  });

  it('recomputes the aggregate across users and rounds to 2dp like the hook', async () => {
    const { models, service } = makeService();
    await service.setRating('user-1', 'test_anime-op1-1', { score: 10 });
    await service.setRating('user-2', 'test_anime-op1-1', { score: 9 });
    const third = await service.setRating('user-1', 'test_anime-op1-1', {
      score: 9,
    });
    // (9 + 9) / 2 — user-1 updated, not double-counted.
    expect(third.avgRating).toBe(9);
    expect(third.totalRatings).toBe(2);

    const { service: service2, models: models2 } = makeService();
    await service2.setRating('user-1', 'test_anime-op1-1', { score: 10 });
    await service2.setRating('user-2', 'test_anime-op1-1', { score: 9 });
    await models2.ratingModel.create({
      userId: 'user-3',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
      score: 9,
      mode: 'watch',
    });
    // A fresh write re-aggregates over all three rows: 28/3 = 9.33.
    const state = await service2.setRating('user-2', 'test_anime-op1-1', {
      score: 9,
    });
    expect(state.avgRating).toBe(9.33);
    expect(state.totalRatings).toBe(3);
    expect(models2.themeModel.docs[0].avgRating).toBe(9.33);
    expect(models.themeModel.docs[0].totalRatings).toBe(2);
  });

  it('updating a rating does NOT increment the user’s totalRatings again', async () => {
    const { models, service } = makeService();
    await service.setRating('user-1', 'test_anime-op1-1', { score: 5 });
    await service.setRating('user-1', 'test_anime-op1-1', { score: 7 });
    expect(models.userModel.docs[0].totalRatings).toBe(1);
    expect(models.ratingModel.docs).toHaveLength(1);
    expect(models.ratingModel.docs[0].score).toBe(7);
  });

  it('keeps the stored mode on a modeless update; stores an explicit mode', async () => {
    const { models, service } = makeService();
    await service.setRating('user-1', 'test_anime-op1-1', {
      score: 6,
      mode: 'listen',
    });
    const state = await service.setRating('user-1', 'test_anime-op1-1', {
      score: 9,
    });
    expect(state.myMode).toBe('listen');
    expect(models.ratingModel.docs[0].mode).toBe('listen');
  });

  it('validates score and mode with the web’s messages', async () => {
    const { service } = makeService();
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', { score: 0 }),
    ).rejects.toMatchObject({ message: 'Invalid score' });
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', { score: 11 }),
    ).rejects.toMatchObject({ message: 'Invalid score' });
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', {
        score: 'high' as never,
      }),
    ).rejects.toMatchObject({ message: 'Invalid score' });
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', {
        score: 8,
        mode: 'bogus' as never,
      }),
    ).rejects.toMatchObject({ message: 'Invalid mode' });
    await expect(
      service.setRating('user-1', 'nope', { score: 8 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Fractional scores pass, exactly as on the web.
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', { score: 7.5 }),
    ).resolves.toMatchObject({ myScore: 7.5 });
  });

  it('reports rating state for unrated and rated themes', async () => {
    const { service } = makeService();
    await expect(
      service.getRatingState('user-1', 'test_anime-op1-1'),
    ).resolves.toEqual({
      slug: 'test_anime-op1-1',
      myScore: null,
      myMode: null,
      avgRating: 0,
      totalRatings: 0,
    });
    await service.setRating('user-1', 'test_anime-op1-1', {
      score: 9,
      mode: 'listen',
    });
    await expect(
      service.getRatingState('user-1', 'test_anime-op1-1'),
    ).resolves.toMatchObject({ myScore: 9, myMode: 'listen', totalRatings: 1 });
    await expect(
      service.getRatingState('user-2', 'test_anime-op1-1'),
    ).resolves.toMatchObject({ myScore: null, totalRatings: 1 });
  });

  it('clears a rating: aggregate recomputed over the rest, user totalRatings -1', async () => {
    const { models, service } = makeService();
    await service.setRating('user-1', 'test_anime-op1-1', { score: 6 });
    await service.setRating('user-2', 'test_anime-op1-1', { score: 10 });
    const state = await service.clearRating('user-1', 'test_anime-op1-1');
    expect(state).toEqual({
      slug: 'test_anime-op1-1',
      myScore: null,
      myMode: null,
      avgRating: 10,
      totalRatings: 1,
    });
    expect(models.ratingModel.docs).toHaveLength(1);
    expect(models.userModel.docs[0].totalRatings).toBe(0);
    expect(models.userModel.docs[1].totalRatings).toBe(1);
    expect(models.themeModel.docs[0].avgRating).toBe(10);
  });

  it('clearing the last rating zeroes the aggregate; clearing when unrated is a no-op', async () => {
    const { models, service } = makeService();
    await service.setRating('user-1', 'test_anime-op1-1', { score: 4 });
    const cleared = await service.clearRating('user-1', 'test_anime-op1-1');
    expect(cleared).toMatchObject({ avgRating: 0, totalRatings: 0 });
    expect(models.themeModel.docs[0].avgRating).toBe(0);
    expect(models.themeModel.docs[0].totalRatings).toBe(0);

    const again = await service.clearRating('user-1', 'test_anime-op1-1');
    expect(again.myScore).toBeNull();
    expect(models.userModel.docs[0].totalRatings).toBe(0); // not decremented twice
    await expect(service.clearRating('user-1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Slice S8 — library themes (web themes/library) + history check      */
/* ------------------------------------------------------------------ */

function makeServiceWithClient(client?: {
  fetchCompletedMediaIds: jest.Mock;
}) {
  const models = makeModels();
  const service = new LibraryService(
    models.themeModel as never,
    models.userModel as never,
    models.favoriteModel as never,
    models.ratingModel as never,
    models.historyModel as never,
    client as never,
  );
  return { models, service };
}

describe('LibraryService.listLibraryThemes', () => {
  it('404s when the caller’s document is gone (the web’s 404)', async () => {
    const { service } = makeServiceWithClient();
    const error = await service
      .listLibraryThemes('ghost-user')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      message: 'User not found',
    });
  });

  it('serves the watched themes in the web order, paged, with neutral AniList meta', async () => {
    const { models, service } = makeServiceWithClient();
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-2',
        slug: 'newer_anime-op1-2',
        animeTitle: 'Newer Anime',
        animeSeasonYear: 2027,
      }),
      makeTheme({
        _id: 'theme-3',
        slug: 'older_anime-ed1-3',
        animeTitle: 'Older Anime',
        animeSeasonYear: 2025,
        type: 'ED',
      }),
    );
    models.historyModel.docs.push(
      { userId: 'user-1', themeId: 'theme-3', themeSlug: 'older_anime-ed1-3' },
      { userId: 'user-1', themeId: 'theme-1', themeSlug: 'test_anime-op1-1' },
      { userId: 'user-1', themeId: 'theme-2', themeSlug: 'newer_anime-op1-2' },
      // Another user's row must not leak in.
      { userId: 'user-2', themeId: 'theme-2', themeSlug: 'newer_anime-op1-2' },
    );

    const page1 = await service.listLibraryThemes('user-1', 1, 2);
    expect(page1.total).toBe(3);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);
    // animeSeasonYear desc is the web's primary sort.
    expect(page1.themes.map((t) => t.slug)).toEqual([
      'newer_anime-op1-2',
      'test_anime-op1-1',
    ]);
    // No AniList linkage: the meta fields are present and neutral.
    expect(page1.anilistUser).toBeNull();
    expect(page1.anilistSyncDeferred).toBe(false);
    expect(page1.anilistDataStale).toBe(false);

    const page2 = await service.listLibraryThemes('user-1', 2, 2);
    expect(page2.themes.map((t) => t.slug)).toEqual(['older_anime-ed1-3']);

    const eds = await service.listLibraryThemes('user-1', 1, 50, 'ED');
    expect(eds.total).toBe(1);
    expect(eds.themes[0].slug).toBe('older_anime-ed1-3');
  });

  it('answers the web’s early return — no AniList meta at all — when both sides are empty', async () => {
    const { service } = makeServiceWithClient();
    const res = await service.listLibraryThemes('user-1');
    expect(res).toEqual({ themes: [], total: 0, page: 1, limit: 50 });
    expect(res).not.toHaveProperty('anilistUser');
    expect(res).not.toHaveProperty('anilistSyncDeferred');
    expect(res).not.toHaveProperty('anilistDataStale');
  });

  it('unions in a FRESH stored AniList cache without fetching', async () => {
    const fetchIds = jest.fn(async () => [999]);
    const { models, service } = makeServiceWithClient({
      fetchCompletedMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-3',
      username: 'three',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-3',
        userId: 42,
        username: 'AniThree',
        syncedAt: new Date(), // fresh — inside the 6h window
        completedMediaIds: [42], // theme-1's anilistId
      },
    });

    const res = await service.listLibraryThemes('user-3');
    expect(fetchIds).not.toHaveBeenCalled();
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.anilistUser).toBe('AniThree');
    expect(res.anilistSyncDeferred).toBe(false);
    expect(res.anilistDataStale).toBe(false);
  });

  it('serves a STALE cache, flags it deferred+stale, and refreshes in the background', async () => {
    const fetchIds = jest.fn(async () => [43]);
    const { models, service } = makeServiceWithClient({
      fetchCompletedMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-3',
      username: 'three',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-3',
        userId: 42,
        username: 'AniThree',
        syncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h old
        completedMediaIds: [42],
      },
    });

    const res = await service.listLibraryThemes('user-3');
    // Stored ids served (theme-1 via anilistId 42), flags set.
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.anilistSyncDeferred).toBe(true);
    expect(res.anilistDataStale).toBe(true);

    // The deferred refresh lands on the user document.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchIds).toHaveBeenCalledWith('token-3', 42);
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({
        'anilist.completedMediaIds': [43],
        'anilist.syncedAt': expect.any(Date),
      }),
    );
  });

  it('does the awaited first sync when there is no stored cache, and persists it', async () => {
    const fetchIds = jest.fn(async () => [42]);
    const { models, service } = makeServiceWithClient({
      fetchCompletedMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-3',
      username: 'three',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-3',
        userId: 42,
        username: 'AniThree',
        completedMediaIds: [],
      },
    });

    const res = await service.listLibraryThemes('user-3');
    expect(fetchIds).toHaveBeenCalledWith('token-3', 42);
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.anilistSyncDeferred).toBe(false);
    // No syncedAt was stored, so the pre-fetch state read as stale.
    expect(res.anilistDataStale).toBe(true);
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({ 'anilist.completedMediaIds': [42] }),
    );
  });

  it('falls back to the early return when the first-sync fetch fails (null)', async () => {
    const fetchIds = jest.fn(async () => null);
    const { models, service } = makeServiceWithClient({
      fetchCompletedMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-3',
      username: 'three',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-3',
        userId: 42,
        username: 'AniThree',
        completedMediaIds: [],
      },
    });

    const res = await service.listLibraryThemes('user-3');
    expect(res).toEqual({ themes: [], total: 0, page: 1, limit: 50 });
  });
});

describe('LibraryService.checkWatched', () => {
  it('answers watched:false for anonymous callers — even without a slug (web order)', async () => {
    const { service } = makeServiceWithClient();
    await expect(service.checkWatched(null, 'any-slug')).resolves.toEqual({
      watched: false,
    });
    await expect(service.checkWatched(null, undefined)).resolves.toEqual({
      watched: false,
    });
  });

  it('answers the web’s 400 when a signed-in caller sends no slug', async () => {
    const { service } = makeServiceWithClient();
    const error = await service
      .checkWatched('user-1', undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: 'Slug required',
    });
  });

  it('reports existence against the caller’s own history rows', async () => {
    const { models, service } = makeServiceWithClient();
    models.historyModel.docs.push({
      userId: 'user-1',
      themeId: 'theme-1',
      themeSlug: 'test_anime-op1-1',
    });

    await expect(
      service.checkWatched('user-1', 'test_anime-op1-1'),
    ).resolves.toEqual({ watched: true });
    await expect(
      service.checkWatched('user-1', 'other-theme'),
    ).resolves.toEqual({ watched: false });
    // Another user's row does not count.
    await expect(
      service.checkWatched('user-2', 'test_anime-op1-1'),
    ).resolves.toEqual({ watched: false });
    expect(models.historyModel.exists).toHaveBeenCalledWith({
      userId: 'user-1',
      themeSlug: 'test_anime-op1-1',
    });
  });
});
