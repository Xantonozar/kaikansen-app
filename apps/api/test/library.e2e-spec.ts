import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { User } from './../src/auth/user.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { LibraryController } from './../src/library/library.controller';
import { LibraryService } from './../src/library/library.service';
import { AnilistLibraryClient } from './../src/library/anilist-library.client';
import { Favorite } from './../src/library/favorite.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { Follow } from './../src/social/follow.schema';
import { Notification } from './../src/social/notification.schema';
import { FollowerActivityService } from './../src/social/follower-activity.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots, the
 * library routes reject tokenless requests with 401 (the guard needs
 * no database) and answer 503 to a VALID token (the service has no
 * models). The token is signed with the API's documented dev fallback
 * secret; the suite clears JWT_* env first so no sibling suite's test
 * secrets leak into this process.
 */
describe('Library without a database (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const validToken = () =>
    jwt.sign(
      {
        userId: 'ghost-user',
        username: 'ghost',
        email: 'ghost@example.com',
        tokenType: 'access',
      },
      'fallback-secret-change-me',
      { expiresIn: '15m' },
    );

  it('rejects tokenless requests with 401', async () => {
    await request(app.getHttpServer()).get('/library/favorites').expect(401);
    await request(app.getHttpServer()).get('/library/history').expect(401);
    await request(app.getHttpServer()).get('/library/count').expect(401);
    await request(app.getHttpServer())
      .get('/library/anilist-entries')
      .expect(401);
    await request(app.getHttpServer())
      .post('/library/history')
      .send({ slug: 'x', mode: 'watch' })
      .expect(401);
    await request(app.getHttpServer())
      .put('/themes/x/rating')
      .send({ score: 8 })
      .expect(401);
  });

  it('rejects a garbage token with 401', () => {
    return request(app.getHttpServer())
      .get('/library/favorites')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('answers 503 to a valid token when no database is configured', async () => {
    const auth = { Authorization: `Bearer ${validToken()}` };
    await request(app.getHttpServer())
      .get('/library/favorites')
      .set(auth)
      .expect(503);
    await request(app.getHttpServer())
      .post('/library/favorites')
      .set(auth)
      .send({ slug: 'anything' })
      .expect(503);
    await request(app.getHttpServer())
      .post('/library/history')
      .set(auth)
      .send({ slug: 'anything', mode: 'watch' })
      .expect(503);
    await request(app.getHttpServer())
      .get('/library/count')
      .set(auth)
      .expect(503);
    await request(app.getHttpServer())
      .get('/library/anilist-entries')
      .set(auth)
      .expect(503);
    await request(app.getHttpServer())
      .put('/themes/anything/rating')
      .set(auth)
      .send({ score: 8 })
      .expect(503);
  });
});

/* ------------------------------------------------------------------ */

/** Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
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
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

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

function makeFakeModels() {
  const users: Record<string, unknown>[] = [
    {
      _id: 'user-1',
      username: 'one',
      displayName: 'One',
      email: 'one@example.com',
      passwordHash: 'hashed',
      avatarUrl: null,
      bio: '',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: true,
    },
    {
      _id: 'user-2',
      username: 'two',
      displayName: 'Two',
      email: 'two@example.com',
      passwordHash: 'hashed',
      avatarUrl: null,
      bio: '',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: true,
      anilist: {
        accessToken: '<redacted>',
        userId: 42,
        username: 'AniUser',
        syncedAt: new Date(),
        completedMediaIds: [42],
      },
    },
  ];
  const themes: Record<string, unknown>[] = [
    {
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
      entries: [{ atEntryId: 11, duration: 60 }],
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
    },
  ];
  const favorites: Record<string, unknown>[] = [];
  const ratings: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

  const byUserAndTheme =
    (rows: Record<string, unknown>[]) =>
    (filter: Record<string, unknown>) =>
      rows.find(
        (r) =>
          String(r.userId) === String(filter.userId) &&
          String(r.themeId) === String(filter.themeId),
      ) ?? null;

  const userModel = {
    docs: users,
    findOne: (filter: Record<string, unknown>) => {
      let found: Record<string, unknown> | null = null;
      if (filter.$or) {
        const clauses = filter.$or as Record<string, string>[];
        found =
          users.find((u) =>
            clauses.some(
              (c) => u.email === c.email || u.username === c.username,
            ),
          ) ?? null;
      } else if (filter.email) {
        found = users.find((u) => u.email === filter.email) ?? null;
      } else if (filter['anilist.userId']) {
        found =
          users.find(
            (u) =>
              (u.anilist as { userId?: number } | undefined)?.userId ===
              filter['anilist.userId'],
          ) ?? null;
      }
      return queryOf(found);
    },
    findById: (id: string) =>
      queryOf(users.find((u) => u._id === id) ?? null),
    findByIdAndUpdate: (id: unknown, update: Record<string, unknown>) => {
      const doc = users.find((u) => String(u._id) === String(id));
      if (doc) applyUpdate(doc, update);
      return queryOf(doc ?? null);
    },
    create: async (data: Record<string, unknown>) => {
      const doc = { _id: `user-new-${++seq}`, ...data };
      users.push(doc);
      return doc;
    },
  };

  const themeMatches = (
    t: Record<string, unknown>,
    filter: Record<string, unknown>,
  ) => {
    const clauseMatches = (clause: Record<string, unknown>) => {
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
    if (!clauseMatches(filter)) return false;
    if (filter.type && t.type !== filter.type) return false;
    if (filter.audioUrl) {
      const ne = (filter.audioUrl as { $ne: unknown }).$ne;
      if (ne === null && t.audioUrl == null) return false;
    }
    if (filter.$or) {
      const clauses = filter.$or as Record<string, unknown>[];
      if (!clauses.some((c) => clauseMatches(c))) return false;
    }
    return true;
  };

  const themeModel = {
    docs: themes,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => themeMatches(t, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(themes.filter((t) => themeMatches(t, filter)).length),
    findByIdAndUpdate: (id: unknown, update: Record<string, unknown>) => {
      const doc = themes.find((t) => String(t._id) === String(id));
      if (doc) applyUpdate(doc, update);
      return queryOf(doc ?? null);
    },
  };

  const favoriteModel = {
    docs: favorites,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(byUserAndTheme(favorites)(filter)),
    find: (filter: Record<string, unknown>) =>
      chain(favorites.filter((f) => String(f.userId) === String(filter.userId))),
    create: async (data: Record<string, unknown>) => {
      const doc = {
        _id: `fav-${++seq}`,
        createdAt: new Date((clock += 1000)),
        ...data,
      };
      favorites.push(doc);
      return doc;
    },
    findOneAndDelete: (filter: Record<string, unknown>) => {
      const idx = favorites.findIndex(
        (f) =>
          String(f.userId) === String(filter.userId) &&
          String(f.themeId) === String(filter.themeId),
      );
      return queryOf(idx >= 0 ? favorites.splice(idx, 1)[0] : null);
    },
  };

  const ratingModel = {
    docs: ratings,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(byUserAndTheme(ratings)(filter)),
    create: async (data: Record<string, unknown>) => {
      const doc = { _id: `rating-${++seq}`, ...data };
      ratings.push(doc);
      return doc;
    },
    findByIdAndUpdate: (id: unknown, update: Record<string, unknown>) => {
      const doc = ratings.find((r) => String(r._id) === String(id));
      if (doc) applyUpdate(doc, update);
      return queryOf(doc ?? null);
    },
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const doc = byUserAndTheme(ratings)(filter);
      if (doc) applyUpdate(doc, update);
      return queryOf(doc);
    },
    findByIdAndDelete: (id: unknown) => {
      const idx = ratings.findIndex((r) => String(r._id) === String(id));
      return queryOf(idx >= 0 ? ratings.splice(idx, 1)[0] : null);
    },
    aggregate: async (pipeline: Record<string, unknown>[]) => {
      const match = (pipeline[0] as { $match: { themeId: unknown } }).$match;
      const rows = ratings.filter(
        (r) => String(r.themeId) === String(match.themeId),
      );
      if (rows.length === 0) return [];
      const avg =
        rows.reduce((sum, r) => sum + (r.score as number), 0) / rows.length;
      return [{ _id: null, avg, count: rows.length }];
    },
  };

  const historyModel = {
    docs: history,
    create: async (data: Record<string, unknown>) => {
      const doc = {
        _id: `hist-${++seq}`,
        viewedAt: new Date((clock += 60_000)),
        ...data,
      };
      history.push(doc);
      return doc;
    },
    find: (filter: Record<string, unknown>) =>
      chain(history.filter((h) => String(h.userId) === String(filter.userId))),
    distinct: (field: string, filter: Record<string, unknown>) =>
      queryOf([
        ...new Set(
          history
            .filter((h) => String(h.userId) === String(filter.userId))
            .map((h) => h[field]),
        ),
      ]),
  };

  // user-2 follows user-1 — the seed Suite 3's notification
  // fan-out resolves recipients from (Suite 2's service is built
  // without a notifier, so the rows sit unused there).
  const follows: Record<string, unknown>[] = [
    { followerId: 'user-2', followeeId: 'user-1' },
  ];
  const notifications: Record<string, unknown>[] = [];

  const rowMatches = (
    doc: Record<string, unknown>,
    filter: Record<string, unknown>,
  ) =>
    Object.entries(filter).every(([key, condition]) => {
      if (
        condition !== null &&
        typeof condition === 'object' &&
        '$in' in (condition as Record<string, unknown>)
      ) {
        const list = (condition as { $in: unknown[] }).$in;
        return list.some((v) => String(v) === String(doc[key]));
      }
      return String(doc[key]) === String(condition);
    });

  const followModel = {
    docs: follows,
    find: (filter: Record<string, unknown>) =>
      chain(follows.filter((f) => rowMatches(f, filter))),
  };

  const notificationModel = {
    docs: notifications,
    find: (filter: Record<string, unknown>) =>
      chain(notifications.filter((n) => rowMatches(n, filter))),
    insertMany: jest.fn(async (docs: Record<string, unknown>[]) => {
      const inserted = docs.map((d) => ({
        _id: `notif-${++seq}`,
        createdAt: new Date((clock += 1000)),
        updatedAt: new Date(clock),
        ...d,
      }));
      notifications.push(...inserted);
      return inserted;
    }),
  };

  return {
    userModel,
    themeModel,
    favoriteModel,
    ratingModel,
    historyModel,
    followModel,
    notificationModel,
  };
}

const E2E_SECRET = ['e2e', 'library', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'library', 'refresh', 'secret'].join('-');

/**
 * Suite 2 — the library controller (plus AuthController for /auth/me)
 * wired to mocked models, over real HTTP: the full save → list →
 * unsave, record → history, rate → clear flows, the counter side
 * effects visible in the fake stores, and the /auth/me AniList fields.
 */
describe('Library flow with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

  /* The AniList library client, stubbed — no test ever touches
     the live AniList API. fetchLibraryMediaIds fails soft (null),
     which is the service's "serve stored ids" path; the entries
     fetch serves a fixed two-entry library. */
  const anilistEntriesFetch = jest.fn(async () => [
    {
      mediaId: 101,
      status: 'CURRENT',
      title: 'Frieren',
      coverImage: 'https://img/l101.jpg',
      format: 'TV',
      episodes: 28,
      progress: 18,
      score: null,
    },
    {
      mediaId: 102,
      status: 'COMPLETED',
      title: 'Outbreak Company',
      coverImage: null,
      format: 'TV',
      episodes: 12,
      progress: 12,
      score: 8,
    },
  ]);
  const anilistClientStub = {
    fetchLibraryMediaIds: jest.fn(async () => null),
    fetchLibraryEntries: anilistEntriesFetch,
  };

  const tokenFor = (userId: string, tokenType = 'access') =>
    jwt.sign(
      {
        userId,
        username: userId,
        email: `${userId}@example.com`,
        tokenType,
      },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const asUser1 = () => ({
    Authorization: `Bearer ${tokenFor('user-1')}`,
  });

  beforeAll(async () => {
process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [LibraryController, AuthController],
      providers: [
        LibraryService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: AnilistLibraryClient, useValue: anilistClientStub },
        { provide: getModelToken(User.name), useValue: models.userModel },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        {
          provide: getModelToken(Favorite.name),
          useValue: models.favoriteModel,
        },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('rejects a refresh-type token with 401 (type separation)', () => {
    return request(app.getHttpServer())
      .get('/library/favorites')
      .set('Authorization', `Bearer ${tokenFor('user-1', 'refresh')}`)
      .expect(401);
  });

  it('saves, lists, checks and unsaves a favourite (idempotently)', async () => {
    const http = request(app.getHttpServer());
    const slug = 'test_anime-op1-1';

    const added = await http
      .post('/library/favorites')
      .set(asUser1())
      .send({ slug })
      .expect(200);
    expect(added.body).toEqual({ slug, isFavorite: true });

    // Re-save: still one row, same answer.
    await http
      .post('/library/favorites')
      .set(asUser1())
      .send({ slug })
      .expect(200);
    expect(models.favoriteModel.docs).toHaveLength(1);

    const state = await http
      .get(`/library/favorites/${slug}`)
      .set(asUser1())
      .expect(200);
    expect(state.body).toEqual({ slug, isFavorite: true });

    const list = await http
      .get('/library/favorites')
      .set(asUser1())
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.themes[0].slug).toBe(slug);
    expect(JSON.stringify(list.body)).not.toContain('embedding');

    const removed = await http
      .delete(`/library/favorites/${slug}`)
      .set(asUser1())
      .expect(200);
    expect(removed.body).toEqual({ slug, isFavorite: false });

    const after = await http
      .get('/library/favorites')
      .set(asUser1())
      .expect(200);
    expect(after.body.total).toBe(0);
  });

  it('answers 404 with this API’s message for an unknown theme', async () => {
    const res = await request(app.getHttpServer())
      .post('/library/favorites')
      .set(asUser1())
      .send({ slug: 'nope' })
      .expect(404);
    expect(res.body.message).toBe('Theme not found: nope');
  });

  it('records a watch and serves it back in history, counters moved', async () => {
    const http = request(app.getHttpServer());
    const res = await http
      .post('/library/history')
      .set(asUser1())
      .send({ slug: 'test_anime-op1-1', atEntryId: 11, mode: 'watch' })
      .expect(200);
    expect(res.body).toEqual({ recorded: true });

    const theme = models.themeModel.docs[0];
    expect(theme.totalWatches).toBe(11);
    expect(models.userModel.docs[0].totalTime).toBe(60);

    const history = await http
      .get('/library/history')
      .set(asUser1())
      .expect(200);
    expect(history.body.entries).toHaveLength(1);
    expect(history.body.entries[0]).toMatchObject({
      themeSlug: 'test_anime-op1-1',
      atEntryId: 11,
      mode: 'watch',
    });
    expect(history.body.entries[0].theme.slug).toBe('test_anime-op1-1');
  });

  it('GET /library/count unions watched themes with stored AniList ids behind the audio filter', async () => {
    const http = request(app.getHttpServer());
    const asUser2 = () => ({
      Authorization: `Bearer ${tokenFor('user-2')}`,
    });

    // user-1 watched theme-1 in the test above and user-2's stored
    // AniList completed ids name the same theme's anime (anilistId
    // 42) — but the theme has NO audio source yet, so neither side
    // of the union counts it.
    const before1 = await http
      .get('/library/count')
      .set(asUser1())
      .expect(200);
    expect(before1.body).toEqual({ count: 0 });
    const before2 = await http
      .get('/library/count')
      .set(asUser2())
      .expect(200);
    expect(before2.body).toEqual({ count: 0 });

    // Give the theme an audio source: now user-1 counts it via his
    // watch history and user-2 via his stored AniList ids — he has
    // no history rows of his own.
    models.themeModel.docs[0].audioUrl = 'https://example.com/theme.ogg';
    const after1 = await http
      .get('/library/count')
      .set(asUser1())
      .expect(200);
    expect(after1.body).toEqual({ count: 1 });
    const after2 = await http
      .get('/library/count')
      .set(asUser2())
      .expect(200);
    expect(after2.body).toEqual({ count: 1 });
  });

  it('rates, reads back and clears a rating with hook-shaped aggregates', async () => {
    const http = request(app.getHttpServer());
    const slug = 'test_anime-op1-1';

    const set = await http
      .put(`/themes/${slug}/rating`)
      .set(asUser1())
      .send({ score: 9, mode: 'listen' })
      .expect(200);
    expect(set.body).toEqual({
      slug,
      myScore: 9,
      myMode: 'listen',
      avgRating: 9,
      totalRatings: 1,
    });
    expect(models.userModel.docs[0].totalRatings).toBe(1);

    const read = await http
      .get(`/themes/${slug}/rating`)
      .set(asUser1())
      .expect(200);
    expect(read.body).toEqual(set.body);

    const cleared = await http
      .delete(`/themes/${slug}/rating`)
      .set(asUser1())
      .expect(200);
    expect(cleared.body).toEqual({
      slug,
      myScore: null,
      myMode: null,
      avgRating: 0,
      totalRatings: 0,
    });
    expect(models.userModel.docs[0].totalRatings).toBe(0);
    expect(models.themeModel.docs[0].avgRating).toBe(0);
  });

  it('rejects an out-of-range score with the web’s 400 message', async () => {
    const res = await request(app.getHttpServer())
      .put('/themes/test_anime-op1-1/rating')
      .set(asUser1())
      .send({ score: 0 })
      .expect(400);
    expect(res.body.message).toBe('Invalid score');
  });

  it('GET /auth/me exposes the AniList linkage for a linked user, null otherwise', async () => {
    const linked = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenFor('user-2')}`)
      .expect(200);
    expect(linked.body.anilist).toEqual({ userId: 42, username: 'AniUser' });
    // The stored AniList access token and the password hash never leak.
    expect(JSON.stringify(linked.body)).not.toContain('accessToken');
    expect(JSON.stringify(linked.body)).not.toContain('passwordHash');

    const unlinked = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenFor('user-1')}`)
      .expect(200);
    expect(unlinked.body.anilist).toBeNull();
  });

  it('GET /library/anilist-entries answers linked:false for an unlinked caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/library/anilist-entries')
      .set(asUser1())
      .expect(200);
    expect(res.body).toEqual({
      linked: false,
      available: false,
      anilistUser: null,
      watching: [],
      completed: [],
    });
    expect(anilistEntriesFetch).not.toHaveBeenCalled();
  });

  it('GET /library/anilist-entries fetches, groups and caches for a linked caller', async () => {
    const http = request(app.getHttpServer());
    const asUser2 = {
      Authorization: `Bearer ${tokenFor('user-2')}`,
    };

    const first = await http
      .get('/library/anilist-entries')
      .set(asUser2)
      .expect(200);
    expect(first.body.linked).toBe(true);
    expect(first.body.available).toBe(true);
    expect(first.body.anilistUser).toBe('AniUser');
    expect(first.body.watching).toEqual([
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
    expect(first.body.completed).toEqual([
      {
        mediaId: 102,
        title: 'Outbreak Company',
        coverImage: null,
        format: 'TV',
        episodes: 12,
        progress: 12,
        score: 8,
      },
    ]);
    // Fetched with user-2's stored token + AniList user id.
    expect(anilistEntriesFetch).toHaveBeenCalledTimes(1);
    expect(anilistEntriesFetch).toHaveBeenCalledWith(
      expect.any(String),
      42,
    );

    // The second read serves the fresh cache — no second fetch.
    const second = await http
      .get('/library/anilist-entries')
      .set(asUser2)
      .expect(200);
    expect(second.body).toEqual(first.body);
    expect(anilistEntriesFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Suite 3 — the follower-activity fan-out over real HTTP: the
 * library controller wired like Suite 2, PLUS the
 * FollowerActivityService over fake Follow/Notification models.
 * user-2 follows user-1 in the seed, so user-1's ratings and
 * favourites must land in user-2's notifications — and nobody
 * else's.
 */
describe('Library follower notifications with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

  const anilistClientStub = {
    fetchLibraryMediaIds: jest.fn(async () => null),
    fetchLibraryEntries: jest.fn(async () => null),
  };

  const tokenFor = (userId: string, tokenType = 'access') =>
    jwt.sign(
      {
        userId,
        username: userId,
        email: `${userId}@example.com`,
        tokenType,
      },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const asUser1 = () => ({
    Authorization: `Bearer ${tokenFor('user-1')}`,
  });
  const asUser2 = () => ({
    Authorization: `Bearer ${tokenFor('user-2')}`,
  });

  const rowsOf = (type: string) =>
    models.notificationModel.docs.filter((n) => n.type === type);

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [LibraryController],
      providers: [
        LibraryService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: AnilistLibraryClient, useValue: anilistClientStub },
        FollowerActivityService,
        { provide: getModelToken(User.name), useValue: models.userModel },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        {
          provide: getModelToken(Favorite.name),
          useValue: models.favoriteModel,
        },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        {
          provide: getModelToken(Follow.name),
          useValue: models.followModel,
        },
        {
          provide: getModelToken(Notification.name),
          useValue: models.notificationModel,
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('notifies the rater’s followers on rating, with title + score meta', async () => {
    const res = await request(app.getHttpServer())
      .put('/themes/test_anime-op1-1/rating')
      .set(asUser1())
      .send({ score: 9, mode: 'watch' })
      .expect(200);
    expect(res.body.myScore).toBe(9);

    expect(rowsOf('theme_rated')).toHaveLength(1);
    expect(rowsOf('theme_rated')[0]).toMatchObject({
      recipientId: 'user-2',
      actorId: 'user-1',
      type: 'theme_rated',
      entityId: 'theme-1',
      read: false,
    });
    expect(rowsOf('theme_rated')[0].entityMeta).toEqual({
      themeTitle: 'Test Song',
      score: 9,
    });
    // The actor is never their own recipient.
    expect(
      models.notificationModel.docs.some(
        (n) => n.recipientId === 'user-1',
      ),
    ).toBe(false);
  });

  it('dedupes a re-rate while unread, then notifies again once read', async () => {
    const http = request(app.getHttpServer());
    await http
      .put('/themes/test_anime-op1-1/rating')
      .set(asUser1())
      .send({ score: 10, mode: 'watch' })
      .expect(200);
    expect(rowsOf('theme_rated')).toHaveLength(1);

    rowsOf('theme_rated')[0].read = true;
    await http
      .put('/themes/test_anime-op1-1/rating')
      .set(asUser1())
      .send({ score: 8, mode: 'watch' })
      .expect(200);
    expect(rowsOf('theme_rated')).toHaveLength(2);
    expect(rowsOf('theme_rated')[1].entityMeta).toEqual({
      themeTitle: 'Test Song',
      score: 8,
    });
  });

  it('notifies followers on favourite — once, despite idempotent re-saves', async () => {
    const http = request(app.getHttpServer());
    await http
      .post('/library/favorites')
      .set(asUser1())
      .send({ slug: 'test_anime-op1-1' })
      .expect(200);
    expect(rowsOf('theme_favorited')).toHaveLength(1);
    expect(rowsOf('theme_favorited')[0]).toMatchObject({
      recipientId: 'user-2',
      actorId: 'user-1',
      type: 'theme_favorited',
      entityId: 'theme-1',
      read: false,
    });
    expect(rowsOf('theme_favorited')[0].entityMeta).toEqual({
      themeTitle: 'Test Song',
    });

    await http
      .post('/library/favorites')
      .set(asUser1())
      .send({ slug: 'test_anime-op1-1' })
      .expect(200);
    expect(rowsOf('theme_favorited')).toHaveLength(1);
  });

  it('writes nothing when the actor has no followers', async () => {
    const http = request(app.getHttpServer());
    const before = models.notificationModel.docs.length;
    await http
      .put('/themes/test_anime-op1-1/rating')
      .set(asUser2())
      .send({ score: 6, mode: 'watch' })
      .expect(200);
    await http
      .post('/library/favorites')
      .set(asUser2())
      .send({ slug: 'test_anime-op1-1' })
      .expect(200);
    expect(models.notificationModel.docs).toHaveLength(before);
  });

  it('still answers 200 when the notification insert blows up', async () => {
    // Read the outstanding rows first, so the fan-out is NOT
    // dedupe-skipped and actually reaches the failing insert.
    for (const row of rowsOf('theme_rated')) {
      row.read = true;
    }
    const original = models.notificationModel.insertMany;
    models.notificationModel.insertMany = jest.fn(
      async (_docs: Record<string, unknown>[]) => {
        throw new Error('db down');
      },
    );
    try {
      const res = await request(app.getHttpServer())
        .put('/themes/test_anime-op1-1/rating')
        .set(asUser1())
        .send({ score: 7, mode: 'watch' })
        .expect(200);
      expect(res.body.myScore).toBe(7);
    } finally {
      models.notificationModel.insertMany = original;
    }
    // The failed insert added no unread row.
    expect(rowsOf('theme_rated').filter((n) => !n.read)).toHaveLength(0);
  });
});
