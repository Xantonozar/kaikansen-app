import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LibraryService } from './library.service';
import { ProfileStatsMaintenance } from '../users/profile-stats-maintenance';
import { computeProfileStats } from '../users/profile-stats';

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
    // The profile-stats maintenance's marker-filtered update
    // (perf problem 4): a doc without statsRatingCount never
    // matches; returns the PRE-update doc like Mongoose.
    findOneAndUpdate: jest.fn(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const requiresMarker = Boolean(
          (filter as { statsRatingCount?: unknown }).statsRatingCount,
        );
        const doc = users.find(
          (u) =>
            String(u._id) === String(filter._id) &&
            (!requiresMarker || u.statsRatingCount !== undefined),
        );
        const before = doc ? { ...doc } : null;
        if (doc) applyUpdate(doc, update);
        return queryOf(before);
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
    // The profile-stats maintenance's rating recompute reads a
    // user's rows through find (perf problem 4).
    find: jest.fn((filter: Record<string, unknown>) =>
      queryOf(
        ratings.filter((r) => String(r.userId) === String(filter.userId)),
      ),
    ),
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
    // The profile-stats maintenance's distinct-theme lookup
    // (perf problem 4): rows for (userId, themeId).
    countDocuments: jest.fn((filter: Record<string, unknown>) =>
      queryOf(
        history.filter(
          (h) =>
            String(h.userId) === String(filter.userId) &&
            String(h.themeId) === String(filter.themeId),
        ).length,
      ),
    ),
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

/**
 * The service WITH the profile-stats maintenance wired (perf
 * problem 4) — the LibraryModule composition. The maintenance
 * runs over the same fake stores, so the stored end-states are
 * asserted for real.
 */
function makeServiceWithStats() {
  const models = makeModels();
  const maintenance = new ProfileStatsMaintenance(
    models.userModel as never,
    models.historyModel as never,
    models.ratingModel as never,
  );
  const service = new LibraryService(
    models.themeModel as never,
    models.userModel as never,
    models.favoriteModel as never,
    models.ratingModel as never,
    models.historyModel as never,
    undefined,
    undefined,
    maintenance as never,
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
  /** Give a seeded user a stored AniList link with stored library ids. */
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
/* Perf problem 4 — the stored profile stats ride the write paths.    */
/* The core proof is EQUALITY: after each write sequence the user     */
/* record's stored stats* equal computeProfileStats over the same     */
/* rows. The fake user docs start MAINTAINED (the recount-backfill    */
/* state); the unmaintained case is covered in the maintenance's      */
/* own spec.                                                          */
/* ------------------------------------------------------------------ */

describe('LibraryService — stored profile stats (perf problem 4)', () => {
  /** Stamp the fake world's user-1 into the maintained state. */
  function markMaintained(models: ReturnType<typeof makeModels>) {
    Object.assign(models.userModel.docs[0], {
      statsListenedThemes: 0,
      statsListenedSeconds: 0,
      statsRatingSum: 0,
      statsRatingCount: 0,
    });
  }

  async function expectStatsEqualComputed(
    models: ReturnType<typeof makeModels>,
  ) {
    const computed = await computeProfileStats(
      {
        ratings: models.ratingModel as never,
        history: models.historyModel as never,
        themes: models.themeModel as never,
        follows: { countDocuments: () => queryOf(0) } as never,
      },
      { _id: 'user-1' },
    );
    const user = models.userModel.docs[0];
    expect(user.statsListenedThemes).toBe(computed.themesListened);
    expect(user.statsListenedSeconds).toBe(computed.totalListenedSeconds);
    // The legacy totalTime counter and the stored seconds are the
    // same definition — both write paths must agree.
    expect(user.totalTime).toBe(computed.totalListenedSeconds);
    const rows = models.ratingModel.docs.filter(
      (r) => r.userId === 'user-1',
    );
    expect(user.statsRatingCount).toBe(rows.length);
    expect(user.statsRatingSum).toBe(
      rows.reduce((sum, r) => sum + (r.score as number), 0),
    );
  }

  it('maintains the stored stats across listen + rate + update + clear', async () => {
    const { models, service } = makeServiceWithStats();
    markMaintained(models);

    await service.recordWatch('user-1', {
      slug: 'test_anime-op1-1',
      atEntryId: 22,
      mode: 'watch',
    }); // 30s, first play of theme-1
    await service.recordWatch('user-1', {
      slug: 'test_anime-op1-1',
      atEntryId: 11,
      mode: 'listen',
    }); // 60s, replay — distinct stays 1
    await expectStatsEqualComputed(models);
    expect(models.userModel.docs[0].statsListenedThemes).toBe(1);
    expect(models.userModel.docs[0].statsListenedSeconds).toBe(90);

    await service.setRating('user-1', 'test_anime-op1-1', { score: 8 });
    await expectStatsEqualComputed(models);
    await service.setRating('user-1', 'test_anime-op1-1', { score: 10 });
    await expectStatsEqualComputed(models);
    expect(models.userModel.docs[0].statsRatingSum).toBe(10);
    expect(models.userModel.docs[0].statsRatingCount).toBe(1);

    await service.clearRating('user-1', 'test_anime-op1-1');
    await expectStatsEqualComputed(models);
    expect(models.userModel.docs[0].statsRatingCount).toBe(0);
  });

  it('a stats-store failure never fails the listen or the rating', async () => {
    const { models, service } = makeServiceWithStats();
    markMaintained(models);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Break ONLY the maintenance's marker-filtered user update.
    models.userModel.findOneAndUpdate.mockImplementation(() => {
      throw new Error('stats store down');
    });
    await expect(
      service.recordWatch('user-1', {
        slug: 'test_anime-op1-1',
        mode: 'watch',
      }),
    ).resolves.toEqual({ recorded: true });
    await expect(
      service.setRating('user-1', 'test_anime-op1-1', { score: 8 }),
    ).resolves.toMatchObject({ myScore: 8 });
    await expect(
      service.clearRating('user-1', 'test_anime-op1-1'),
    ).resolves.toMatchObject({ myScore: null });
    // The underlying writes themselves landed — only the stored
    // stats lag (the recount backstop repairs them).
    expect(models.historyModel.docs).toHaveLength(1);
    expect(models.ratingModel.docs).toHaveLength(0);
    spy.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* Slice S8 — library themes (web themes/library) + history check      */
/* ------------------------------------------------------------------ */

function makeServiceWithClient(client?: {
  fetchLibraryMediaIds?: jest.Mock;
  fetchLibraryEntries?: jest.Mock;
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

describe('LibraryService — follower activity notifications', () => {
  /** A service whose notifier is a recording stub. */
  function makeNotifyingService() {
    const models = makeModels();
    const notifyFollowers = jest.fn(async () => {});
    const service = new LibraryService(
      models.themeModel as never,
      models.userModel as never,
      models.favoriteModel as never,
      models.ratingModel as never,
      models.historyModel as never,
      undefined,
      { notifyFollowers } as never,
    );
    return { models, service, notifyFollowers };
  }

  it('fans a new rating out to the rater’s followers with title + score', async () => {
    const { service, notifyFollowers } = makeNotifyingService();
    await service.setRating('user-1', 'test_anime-op1-1', {
      score: 9,
      mode: 'watch',
    });
    expect(notifyFollowers).toHaveBeenCalledTimes(1);
    expect(notifyFollowers).toHaveBeenCalledWith({
      actorId: 'user-1',
      type: 'theme_rated',
      entityId: 'theme-1',
      entityMeta: { themeTitle: 'Test Song', score: 9 },
    });
  });

  it('fans a rating UPDATE out too (the unread dedupe is the notifier’s job)', async () => {
    const { service, notifyFollowers } = makeNotifyingService();
    await service.setRating('user-1', 'test_anime-op1-1', {
      score: 9,
      mode: 'watch',
    });
    await service.setRating('user-1', 'test_anime-op1-1', {
      score: 10,
      mode: 'watch',
    });
    expect(notifyFollowers).toHaveBeenCalledTimes(2);
    expect(notifyFollowers).toHaveBeenLastCalledWith({
      actorId: 'user-1',
      type: 'theme_rated',
      entityId: 'theme-1',
      entityMeta: { themeTitle: 'Test Song', score: 10 },
    });
  });

  it('fans a favourite out only when the save actually creates the row', async () => {
    const { service, notifyFollowers } = makeNotifyingService();
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    expect(notifyFollowers).toHaveBeenCalledTimes(1);
    expect(notifyFollowers).toHaveBeenCalledWith({
      actorId: 'user-1',
      type: 'theme_favorited',
      entityId: 'theme-1',
      entityMeta: { themeTitle: 'Test Song' },
    });

    // Idempotent re-save: no second row, no second fan-out.
    await service.addFavorite('user-1', { slug: 'test_anime-op1-1' });
    expect(notifyFollowers).toHaveBeenCalledTimes(1);
  });

  it('does not fan out when the favourite create loses the unique-index race', async () => {
    const { models, service, notifyFollowers } = makeNotifyingService();
    models.favoriteModel.failNextCreateWithDuplicate = true;
    const state = await service.addFavorite('user-1', {
      slug: 'test_anime-op1-1',
    });
    expect(state.isFavorite).toBe(true);
    // The racing request owns the fan-out; this one stays silent.
    expect(notifyFollowers).not.toHaveBeenCalled();
  });
});

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
      fetchLibraryMediaIds: fetchIds,
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
      fetchLibraryMediaIds: fetchIds,
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

  it('defers the first sync when there is no stored cache: serves what exists, the refresh lands the ids for the next read (B7)', async () => {
    const fetchIds = jest.fn(async () => [42]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
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

    // First open: NO awaited fetch — with nothing stored and no
    // history, the answer is the honest empty early return (no
    // AniList meta, no fabricated rows), even though AniList has
    // ids for this user.
    const res = await service.listLibraryThemes('user-3');
    expect(res).toEqual({ themes: [], total: 0, page: 1, limit: 50 });
    expect(fetchIds).toHaveBeenCalledWith('token-3', 42);

    // The deferred refresh persists the fetched ids behind the
    // response.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({ 'anilist.completedMediaIds': [42] }),
    );

    // The next read serves the synced set fresh, with no further
    // fetch. (The fake model's applyUpdate cannot resolve the
    // dotted 'anilist.*' paths, so apply the persisted state the
    // assertion above verified, as Mongoose would.)
    const user3 = models.userModel.docs.find((u) => u._id === 'user-3') as {
      anilist: { completedMediaIds: number[]; syncedAt: Date };
    };
    user3.anilist.completedMediaIds = [42];
    user3.anilist.syncedAt = new Date();
    const res2 = await service.listLibraryThemes('user-3');
    expect(res2.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res2.anilistSyncDeferred).toBe(false);
    expect(res2.anilistDataStale).toBe(false);
    expect(fetchIds).toHaveBeenCalledTimes(1);
  });

  it('first sync WITH a watched history serves the history at once, flagged deferred+stale (B7)', async () => {
    const fetchIds = jest.fn(async () => [42]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
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
    models.historyModel.docs.push(
      { userId: 'user-3', themeId: 'theme-1', themeSlug: 'test_anime-op1-1' },
    );

    const res = await service.listLibraryThemes('user-3');
    // The history side answers immediately; the AniList side is
    // still empty (its ids land with the background refresh).
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.anilistSyncDeferred).toBe(true);
    // No syncedAt was stored, so the AniList state reads as stale.
    expect(res.anilistDataStale).toBe(true);
    expect(fetchIds).toHaveBeenCalledWith('token-3', 42);
  });

  it('unions in a CURRENT (watching) id from the widened fetch — and /library/count agrees on the same stored set', async () => {
    // The widened client returns completed (42) + watching (44) ids
    // merged; 44 exists only on the user's CURRENT list.
    const fetchIds = jest.fn(async () => [42, 44]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
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
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-watching',
        slug: 'watching_anime-op1-9',
        animeTitle: 'Watching Anime',
        animeSeasonYear: 2027,
        anilistId: 44,
        audioUrl: 'https://example.com/watching.ogg',
      }),
    );

    // First open: the widened fetch is deferred (B7) — nothing
    // stored yet, so the answer is the honest empty page while
    // the refresh fires behind it.
    const first = await service.listLibraryThemes('user-3');
    expect(first).toEqual({ themes: [], total: 0, page: 1, limit: 50 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchIds).toHaveBeenCalledWith('token-3', 42);
    // The combined set is what lands in the stored field.
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({ 'anilist.completedMediaIds': [42, 44] }),
    );

    // The count reads the SAME stored set. (The fake model's
    // applyUpdate cannot resolve the dotted 'anilist.*' path the
    // service writes through Mongoose, so apply the persisted
    // state the assertion above verified, as Mongoose would.)
    const user3 = models.userModel.docs.find((u) => u._id === 'user-3') as
      | { anilist?: { completedMediaIds?: number[]; syncedAt?: Date } }
      | undefined;
    if (!user3?.anilist) throw new Error('user-3 lost its AniList link');
    user3.anilist.completedMediaIds = [42, 44];
    user3.anilist.syncedAt = new Date();

    // With the synced set stored fresh, the union read serves
    // both the completed theme (42) and the watching theme (44);
    // 2027 sorts before 2026.
    const res = await service.listLibraryThemes('user-3');
    expect(res.total).toBe(2);
    expect(res.themes.map((t) => t.slug)).toEqual([
      'watching_anime-op1-9',
      'test_anime-op1-1',
    ]);
    expect(fetchIds).toHaveBeenCalledTimes(1);
    // Only the watching theme has an audio source (theme-1's
    // audioUrl is null), so the two endpoints agree on the id set
    // and differ only by the count's audio filter.
    await expect(service.getLibraryCount('user-3')).resolves.toEqual({
      count: 1,
    });
    expect(models.themeModel.countDocuments).toHaveBeenLastCalledWith({
      audioUrl: { $ne: null },
      $or: [{ anilistId: { $in: [42, 44] } }],
    });
  });

  it('self-heals a stale COMPLETED-only cache to the widened set via the deferred refresh', async () => {
    const fetchIds = jest.fn(async () => [42, 44]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
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
        syncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // stale
        // Yesterday's cache: completed ids only.
        completedMediaIds: [42],
      },
    });

    const res = await service.listLibraryThemes('user-3');
    // The stale cache is served as-is for THIS response…
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.anilistSyncDeferred).toBe(true);

    // …and the background refresh replaces it with the widened
    // completed+watching set — no migration, no manual write.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({
        'anilist.completedMediaIds': [42, 44],
        'anilist.syncedAt': expect.any(Date),
      }),
    );
  });

  it('falls back to the early return when the first-sync fetch fails (null)', async () => {
    const fetchIds = jest.fn(async () => null);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
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

  it('source=anilist serves ONLY the AniList side — a history-only theme is excluded', async () => {
    const { models, service } = makeServiceWithClient();
    models.userModel.docs.push({
      _id: 'user-3',
      username: 'three',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-3',
        userId: 42,
        username: 'AniThree',
        syncedAt: new Date(), // fresh — the stored set is served as-is
        completedMediaIds: [42], // theme-1's anilistId
      },
    });
    // A theme the caller has WATCHED whose anime is not on their
    // AniList lists (anilistId 777 is outside the stored set).
    models.themeModel.docs.push(
      makeTheme({
        _id: 'theme-hist',
        slug: 'hist_only-op1-5',
        animeTitle: 'History Only',
        animeSeasonYear: 2028,
        anilistId: 777,
      }),
    );
    models.historyModel.docs.push(
      { userId: 'user-3', themeId: 'theme-hist', themeSlug: 'hist_only-op1-5' },
      { userId: 'user-3', themeId: 'theme-1', themeSlug: 'test_anime-op1-1' },
    );

    // The default union serves both sides (2028 sorts first).
    const union = await service.listLibraryThemes('user-3');
    expect(union.total).toBe(2);
    expect(union.themes.map((t) => t.slug)).toEqual([
      'hist_only-op1-5',
      'test_anime-op1-1',
    ]);

    // The AniList source drops the history clause entirely: the
    // AniList-list theme stays, the history-only theme is gone,
    // and the summary carries the real anilistId grouping key.
    const res = await service.listLibraryThemes(
      'user-3',
      1,
      50,
      undefined,
      'anilist',
    );
    expect(res.total).toBe(1);
    expect(res.themes.map((t) => t.slug)).toEqual(['test_anime-op1-1']);
    expect(res.themes[0].anilistId).toBe(42);
    expect(res.anilistUser).toBe('AniThree');
  });

  it('source=anilist answers the early return for an unlinked caller, history notwithstanding', async () => {
    const { models, service } = makeServiceWithClient();
    models.historyModel.docs.push(
      { userId: 'user-1', themeId: 'theme-1', themeSlug: 'test_anime-op1-1' },
    );

    // Sanity: the default union serves the watched theme…
    const union = await service.listLibraryThemes('user-1');
    expect(union.total).toBe(1);

    // …but an unlinked caller has no AniList side to serve — the
    // endpoint's early-return shape: no AniList meta, but the
    // group-pagination meta is present (zeros) for that source.
    const res = await service.listLibraryThemes(
      'user-1',
      1,
      50,
      undefined,
      'anilist',
    );
    expect(res).toEqual({
      themes: [],
      total: 0,
      totalThemes: 0,
      totalGroups: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    });
    expect(res).not.toHaveProperty('anilistUser');
    expect(res).not.toHaveProperty('anilistSyncDeferred');
    expect(res).not.toHaveProperty('anilistDataStale');
  });

  it('source=anilist pages by anime GROUP: whole groups per page, exact totals, hasMore flips on the last page', async () => {
    const { models, service } = makeServiceWithClient();
    models.userModel.docs.push({
      _id: 'user-9',
      username: 'nine',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-9',
        userId: 99,
        username: 'AniNine',
        syncedAt: new Date(), // fresh — the stored ids serve as-is
        completedMediaIds: [101, 102, 103],
      },
    });
    // Three groups in served order (year desc, then title asc):
    // Alpha (101, 2026, OP+OP+ED), Beta (102, 2026, OP+ED),
    // Gamma (103, 2024, OP). Six themes in total.
    models.themeModel.docs.push(
      makeTheme({
        _id: 'g1-op1',
        slug: 'alpha-op1',
        animeTitle: 'Alpha Anime',
        animeSeasonYear: 2026,
        anilistId: 101,
        type: 'OP',
        sequence: 1,
      }),
      makeTheme({
        _id: 'g1-op2',
        slug: 'alpha-op2',
        animeTitle: 'Alpha Anime',
        animeSeasonYear: 2026,
        anilistId: 101,
        type: 'OP',
        sequence: 2,
      }),
      makeTheme({
        _id: 'g1-ed1',
        slug: 'alpha-ed1',
        animeTitle: 'Alpha Anime',
        animeSeasonYear: 2026,
        anilistId: 101,
        type: 'ED',
        sequence: 1,
      }),
      makeTheme({
        _id: 'g2-op1',
        slug: 'beta-op1',
        animeTitle: 'Beta Anime',
        animeSeasonYear: 2026,
        anilistId: 102,
        type: 'OP',
        sequence: 1,
      }),
      makeTheme({
        _id: 'g2-ed1',
        slug: 'beta-ed1',
        animeTitle: 'Beta Anime',
        animeSeasonYear: 2026,
        anilistId: 102,
        type: 'ED',
        sequence: 1,
      }),
      makeTheme({
        _id: 'g3-op1',
        slug: 'gamma-op1',
        animeTitle: 'Gamma Anime',
        animeSeasonYear: 2024,
        anilistId: 103,
        type: 'OP',
        sequence: 1,
      }),
    );

    // Page 1 at two groups a page: Alpha + Beta, whole — the ED
    // that theme-paging would have stranded on page 2 rides along.
    const page1 = await service.listLibraryThemes(
      'user-9',
      1,
      2,
      undefined,
      'anilist',
    );
    expect(page1.total).toBe(6);
    expect(page1.totalThemes).toBe(6);
    expect(page1.totalGroups).toBe(3);
    expect(page1.limit).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(new Set(page1.themes.map((t) => t.anilistId))).toEqual(
      new Set([101, 102]),
    );
    expect(page1.themes).toHaveLength(5);

    // Page 2: Gamma alone, and hasMore flips off.
    const page2 = await service.listLibraryThemes(
      'user-9',
      2,
      2,
      undefined,
      'anilist',
    );
    expect(page2.themes.map((t) => t.slug)).toEqual(['gamma-op1']);
    expect(page2.hasMore).toBe(false);
    expect(page2.totalGroups).toBe(3);
    expect(page2.totalThemes).toBe(6);

    // Past the end: an empty page, totals still exact.
    const page3 = await service.listLibraryThemes(
      'user-9',
      3,
      2,
      undefined,
      'anilist',
    );
    expect(page3.themes).toEqual([]);
    expect(page3.hasMore).toBe(false);
    expect(page3.totalThemes).toBe(6);

    // No limit: the group default (10) applies — all three groups
    // land on page 1.
    const defaulted = await service.listLibraryThemes(
      'user-9',
      1,
      undefined,
      undefined,
      'anilist',
    );
    expect(defaulted.limit).toBe(10);
    expect(defaulted.themes).toHaveLength(6);
    expect(defaulted.hasMore).toBe(false);

    // An over-cap limit clamps to 50 groups.
    const capped = await service.listLibraryThemes(
      'user-9',
      1,
      500,
      undefined,
      'anilist',
    );
    expect(capped.limit).toBe(50);

    // The type filter regroups over the filtered set: OP-only
    // groups still never split (Alpha keeps both its OPs), and
    // the totals count OPs alone.
    const ops1 = await service.listLibraryThemes(
      'user-9',
      1,
      1,
      'OP',
      'anilist',
    );
    expect(ops1.totalThemes).toBe(4);
    expect(ops1.totalGroups).toBe(3);
    expect(ops1.themes.map((t) => t.slug)).toEqual([
      'alpha-op1',
      'alpha-op2',
    ]);
    expect(ops1.hasMore).toBe(true);
  });

  /**
   * B7 helper: counts the projected totals passes in the AniList
   * segment — the only read there that projects `anilistId`.
   */
  function countTotalsPasses(models: ReturnType<typeof makeModels>) {
    const counter = { passes: 0 };
    const originalFind = models.themeModel.find;
    models.themeModel.find = jest.fn(
      (filter: Record<string, unknown>) => {
        const q = originalFind(filter) as unknown as {
          select: (projection: string) => unknown;
        };
        const baseSelect = q.select.bind(q);
        q.select = (projection: string) => {
          if (projection === 'anilistId') counter.passes += 1;
          return baseSelect(projection);
        };
        return q;
      },
    ) as never;
    return counter;
  }

  const flushDeferred = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('caches the AniList group totals across pages per (user, type), expiring after ~60s — page contents stay live (B7)', async () => {
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: null,
    });
    models.userModel.docs.push({
      _id: 'user-9',
      username: 'nine',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-9',
        userId: 42,
        username: 'AniNine',
        completedMediaIds: [101, 102, 103],
        syncedAt: new Date(),
      },
    });
    models.themeModel.docs.push(
      makeTheme({ _id: 'lib-a1', slug: 'alpha-op', animeTitle: 'Alpha', anilistId: 101, type: 'OP' }),
      makeTheme({ _id: 'lib-a2', slug: 'alpha-ed', animeTitle: 'Alpha', anilistId: 101, type: 'ED' }),
      makeTheme({ _id: 'lib-b1', slug: 'beta-op', animeTitle: 'Beta', anilistId: 102, type: 'OP' }),
      makeTheme({ _id: 'lib-b2', slug: 'beta-ed', animeTitle: 'Beta', anilistId: 102, type: 'ED' }),
      makeTheme({ _id: 'lib-g1', slug: 'gamma-op', animeTitle: 'Gamma', anilistId: 103, type: 'OP' }),
      makeTheme({ _id: 'lib-g2', slug: 'gamma-ed', animeTitle: 'Gamma', anilistId: 103, type: 'ED' }),
    );
    const totals = countTotalsPasses(models);

    const page1 = await service.listLibraryThemes('user-9', 1, 2, undefined, 'anilist');
    expect(page1.totalGroups).toBe(3);
    expect(page1.total).toBe(6);
    expect(totals.passes).toBe(1);

    // Page 2: the totals come from the cache (no second pass),
    // while the page CONTENTS still come from the live query.
    const page2 = await service.listLibraryThemes('user-9', 2, 2, undefined, 'anilist');
    expect(page2.totalGroups).toBe(3);
    expect(page2.total).toBe(6);
    expect(page2.themes.map((t) => t.slug)).toEqual(['gamma-op', 'gamma-ed']);
    expect(totals.passes).toBe(1);

    // A type filter is a different cache key: its totals pass runs.
    const ops = await service.listLibraryThemes('user-9', 1, undefined, 'OP', 'anilist');
    expect(ops.total).toBe(3);
    expect(totals.passes).toBe(2);

    // After the TTL the totals are recomputed.
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      const base = Date.now();
      nowSpy.mockImplementation(() => base + 61_000);
      const again = await service.listLibraryThemes('user-9', 1, 2, undefined, 'anilist');
      expect(again.totalGroups).toBe(3);
      expect(totals.passes).toBe(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('invalidates the cached group totals when a sync lands a NEW id set (B7)', async () => {
    const fetchIds = jest.fn(async () => [101, 102, 103, 104]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-10',
      username: 'ten',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-10',
        userId: 42,
        username: 'AniTen',
        completedMediaIds: [101, 102, 103],
        syncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      },
    });
    models.themeModel.docs.push(
      makeTheme({ _id: 'lib-a1', slug: 'alpha-op', animeTitle: 'Alpha', anilistId: 101, type: 'OP' }),
      makeTheme({ _id: 'lib-b1', slug: 'beta-op', animeTitle: 'Beta', anilistId: 102, type: 'OP' }),
      makeTheme({ _id: 'lib-g1', slug: 'gamma-op', animeTitle: 'Gamma', anilistId: 103, type: 'OP' }),
      makeTheme({ _id: 'lib-d1', slug: 'delta-op', animeTitle: 'Delta', anilistId: 104, type: 'OP', animeSeasonYear: 2027 }),
    );
    const totals = countTotalsPasses(models);

    // Stale stored ids are served (3 groups), the totals are
    // cached, and the refresh fires behind the response.
    const res1 = await service.listLibraryThemes('user-10', 1, undefined, undefined, 'anilist');
    expect(res1.totalGroups).toBe(3);
    expect(res1.anilistSyncDeferred).toBe(true);
    expect(totals.passes).toBe(1);
    await flushDeferred();
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-10',
      expect.objectContaining({ 'anilist.completedMediaIds': [101, 102, 103, 104] }),
    );

    // The next read (persisted state applied, as Mongoose would)
    // recomputes the totals over the new set — 4 groups — instead
    // of serving the cached 3.
    const user10 = models.userModel.docs.find((u) => u._id === 'user-10') as {
      anilist: { completedMediaIds: number[]; syncedAt: Date };
    };
    user10.anilist.completedMediaIds = [101, 102, 103, 104];
    user10.anilist.syncedAt = new Date();
    const res2 = await service.listLibraryThemes('user-10', 1, undefined, undefined, 'anilist');
    expect(res2.totalGroups).toBe(4);
    expect(res2.total).toBe(4);
    expect(totals.passes).toBe(2);
  });

  it('drops the cached totals on a SAME-set sync too — the id fingerprint alone would have kept them (B7)', async () => {
    const fetchIds = jest.fn(async () => [101, 102, 103]);
    const { models, service } = makeServiceWithClient({
      fetchLibraryMediaIds: fetchIds,
    });
    models.userModel.docs.push({
      _id: 'user-11',
      username: 'eleven',
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'token-11',
        userId: 42,
        username: 'AniEleven',
        completedMediaIds: [101, 102, 103],
        syncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      },
    });
    models.themeModel.docs.push(
      makeTheme({ _id: 'lib-a1', slug: 'alpha-op', animeTitle: 'Alpha', anilistId: 101, type: 'OP' }),
      makeTheme({ _id: 'lib-b1', slug: 'beta-op', animeTitle: 'Beta', anilistId: 102, type: 'OP' }),
      makeTheme({ _id: 'lib-g1', slug: 'gamma-op', animeTitle: 'Gamma', anilistId: 103, type: 'OP' }),
    );
    const totals = countTotalsPasses(models);

    const res1 = await service.listLibraryThemes('user-11', 1, undefined, undefined, 'anilist');
    expect(res1.totalGroups).toBe(3);
    expect(totals.passes).toBe(1);
    await flushDeferred();
    expect(models.userModel.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-11',
      expect.objectContaining({ 'anilist.completedMediaIds': [101, 102, 103] }),
    );

    // Same ids, fresh syncedAt: within the TTL and with an
    // identical fingerprint, only the sync's explicit invalidation
    // explains a recomputation.
    const user11 = models.userModel.docs.find((u) => u._id === 'user-11') as {
      anilist: { syncedAt: Date };
    };
    user11.anilist.syncedAt = new Date();
    const res2 = await service.listLibraryThemes('user-11', 1, undefined, undefined, 'anilist');
    expect(res2.totalGroups).toBe(3);
    expect(totals.passes).toBe(2);
  });

  it('an unrecognised source value keeps the default union (byte-compatible)', async () => {
    const { models, service } = makeServiceWithClient();
    models.historyModel.docs.push(
      { userId: 'user-1', themeId: 'theme-1', themeSlug: 'test_anime-op1-1' },
    );
    const res = await service.listLibraryThemes(
      'user-1',
      1,
      50,
      undefined,
      'history',
    );
    expect(res.total).toBe(1);
    expect(res.themes[0].slug).toBe('test_anime-op1-1');
  });
});

describe('LibraryService.getAnilistEntries', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    mediaId: 101,
    status: 'CURRENT',
    title: 'Frieren',
    coverImage: 'https://img/l101.jpg',
    format: 'TV',
    episodes: 28,
    progress: 18,
    score: null as number | null,
    ...overrides,
  });

  const linkedUser = (overrides: Record<string, unknown> = {}) => ({
    _id: 'user-3',
    username: 'three',
    totalRatings: 0,
    totalTime: 0,
    anilist: {
      accessToken: 'token-3',
      userId: 42,
      username: 'AniThree',
      completedMediaIds: [42],
    },
    ...overrides,
  });

  it('404s when the caller’s document is gone', async () => {
    const { service } = makeServiceWithClient();
    const error = await service
      .getAnilistEntries('ghost-user')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('answers linked:false (and never fetches) for an unlinked caller', async () => {
    const fetchEntries = jest.fn(async () => []);
    const { service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });

    const res = await service.getAnilistEntries('user-1');
    expect(res).toEqual({
      linked: false,
      available: false,
      anilistUser: null,
      watching: [],
      completed: [],
    });
    expect(fetchEntries).not.toHaveBeenCalled();
  });

  it('serves a FRESH stored cache grouped by status, without fetching', async () => {
    const fetchEntries = jest.fn(async () => []);
    const { models, service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });
    models.userModel.docs.push(
      linkedUser({
        anilistEntriesCache: {
          syncedAt: new Date(), // fresh — inside the 6h window
          entries: [
            entry(),
            entry({
              mediaId: 102,
              status: 'COMPLETED',
              title: 'Outbreak Company',
              episodes: 12,
              progress: 12,
              score: 8,
            }),
          ],
        },
      }),
    );

    const res = await service.getAnilistEntries('user-3');
    expect(fetchEntries).not.toHaveBeenCalled();
    expect(res.linked).toBe(true);
    expect(res.available).toBe(true);
    expect(res.anilistUser).toBe('AniThree');
    expect(res).not.toHaveProperty('anilistSyncDeferred');
    expect(res.watching).toEqual([
      {
        mediaId: 101,
        title: 'Frieren',
        coverImage: 'https://img/l101.jpg',
        format: 'TV',
        episodes: 28,
        progress: 18,
        score: null,
      },
    ]);
    expect(res.completed).toEqual([
      {
        mediaId: 102,
        title: 'Outbreak Company',
        coverImage: 'https://img/l101.jpg',
        format: 'TV',
        episodes: 12,
        progress: 12,
        score: 8,
      },
    ]);
  });

  it('fetches and PERSISTS on first sync (no cache), then serves the fetch', async () => {
    const fetched = [
      entry(),
      entry({ mediaId: 102, status: 'COMPLETED', progress: 28, score: 9 }),
    ];
    const fetchEntries = jest.fn(async () => fetched);
    const { models, service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });
    models.userModel.docs.push(linkedUser());

    const res = await service.getAnilistEntries('user-3');
    expect(fetchEntries).toHaveBeenCalledWith('token-3', 42);
    expect(res.available).toBe(true);
    expect(res.watching).toHaveLength(1);
    expect(res.completed).toHaveLength(1);
    // The cache landed on the user document for next time.
    const stored = models.userModel.docs.find((u) => u._id === 'user-3') as {
      anilistEntriesCache?: { entries: unknown[]; syncedAt: Date };
    };
    expect(stored.anilistEntriesCache?.entries).toEqual(fetched);
    expect(stored.anilistEntriesCache?.syncedAt).toBeInstanceOf(Date);
  });

  it('degrades silently (available:false) when the first-sync fetch fails', async () => {
    const fetchEntries = jest.fn(async () => null);
    const { models, service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });
    models.userModel.docs.push(linkedUser());

    const res = await service.getAnilistEntries('user-3');
    expect(res).toEqual({
      linked: true,
      available: false,
      anilistUser: 'AniThree',
      watching: [],
      completed: [],
    });
  });

  it('degrades silently when AniList answers with a genuinely empty library', async () => {
    const fetchEntries = jest.fn(async () => []);
    const { models, service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });
    models.userModel.docs.push(linkedUser());

    const res = await service.getAnilistEntries('user-3');
    expect(res.available).toBe(false);
    expect(res.linked).toBe(true);
    // An empty result is not persisted (the ids dance's rule).
    const stored = models.userModel.docs.find((u) => u._id === 'user-3') as {
      anilistEntriesCache?: unknown;
    };
    expect(stored.anilistEntriesCache).toBeUndefined();
  });

  it('serves a STALE cache flagged deferred+stale and refreshes in the background', async () => {
    const fresh = [entry({ mediaId: 103, title: 'Fresh Show' })];
    const fetchEntries = jest.fn(async () => fresh);
    const { models, service } = makeServiceWithClient({
      fetchLibraryEntries: fetchEntries,
    });
    models.userModel.docs.push(
      linkedUser({
        anilistEntriesCache: {
          syncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h old
          entries: [entry()],
        },
      }),
    );

    const res = await service.getAnilistEntries('user-3');
    // The STALE cache is what gets served…
    expect(res.available).toBe(true);
    expect(res.watching.map((e) => e.mediaId)).toEqual([101]);
    expect(res.anilistSyncDeferred).toBe(true);
    expect(res.anilistDataStale).toBe(true);
    // …and the background refresh was fired with the stored token.
    expect(fetchEntries).toHaveBeenCalledWith('token-3', 42);
    // Let the fire-and-forget refresh land, then the cache is fresh.
    await new Promise((resolve) => setImmediate(resolve));
    const stored = models.userModel.docs.find((u) => u._id === 'user-3') as {
      anilistEntriesCache?: { entries: { mediaId: number }[] };
    };
    expect(stored.anilistEntriesCache?.entries.map((e) => e.mediaId)).toEqual([
      103,
    ]);
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
