import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { AnilistLibraryClient } from './../src/library/anilist-library.client';
import { Favorite } from './../src/library/favorite.schema';
import { HistoryCheckController } from './../src/library/history-check.controller';
import { LibraryController } from './../src/library/library.controller';
import { LibraryService } from './../src/library/library.service';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { StatsController } from './../src/stats/stats.controller';
import { StatsService } from './../src/stats/stats.service';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { ThemesController } from './../src/themes/themes.controller';
import { ThemesService } from './../src/themes/themes.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the residual
 * read routes answer this API's no-database codes — public routes
 * 503, guarded routes 401 tokenless / 503 with a valid token, and
 * the optional-auth history check 503 (its service checks models
 * before the session, like every optional-auth read here). The
 * token is signed with the API's documented dev fallback secret;
 * the suite clears JWT_* env first so no sibling suite's test
 * secrets leak into this process.
 */
describe('Residual reads without a database (e2e)', () => {
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

  it('public reads answer 503', async () => {
    const http = request(app.getHttpServer());
    await http.get('/themes/anything/similar').expect(503);
    await http.get('/anime/42/related').expect(503);
    await http.get('/stats/live').expect(503);
    await http.get('/library/history/check').expect(503);
    await http.get('/library/history/check?slug=x').expect(503);
  });

  it('guarded reads answer 401 tokenless, 503 with a valid token', async () => {
    const http = request(app.getHttpServer());
    await http.get('/library/themes').expect(401);
    await http.get('/stats/top-artists').expect(401);

    const auth = { Authorization: `Bearer ${validToken()}` };
    await http.get('/library/themes').set(auth).expect(503);
    await http.get('/stats/top-artists').set(auth).expect(503);
  });
});

/* ------------------------------------------------------------------ */

type Doc = Record<string, unknown>;

/** Mongo-flavoured matcher for the filters this suite's routes build. */
function clauseMatches(doc: Doc, clause: Doc): boolean {
  for (const [key, cond] of Object.entries(clause)) {
    if (key === '$or') {
      if (!(cond as Doc[]).some((c) => clauseMatches(doc, c))) return false;
      continue;
    }
    if (key === '$and') {
      if (!(cond as Doc[]).every((c) => clauseMatches(doc, c))) return false;
      continue;
    }
    const val = doc[key];
    const isOps =
      cond !== null &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !(cond instanceof RegExp);
    if (isOps) {
      const ops = cond as Doc;
      if ('$in' in ops) {
        const list = ops.$in as unknown[];
        const hit = Array.isArray(val)
          ? val.some((v) => list.some((x) => String(x) === String(v)))
          : list.some((x) => String(x) === String(val));
        if (!hit) return false;
      } else if ('$ne' in ops) {
        const ne = ops.$ne;
        if (ne === null) {
          if (val == null) return false;
        } else if (Array.isArray(val)) {
          if (val.some((v) => String(v) === String(ne))) return false;
        } else if (String(val) === String(ne)) {
          return false;
        }
      } else if ('$gt' in ops) {
        if (!((val as Date) > (ops.$gt as Date))) return false;
      } else if ('$elemMatch' in ops) {
        const arr = val as Doc[] | undefined;
        if (!arr || !arr.some((el) => clauseMatches(el, ops.$elemMatch as Doc)))
          return false;
      } else {
        return false;
      }
    } else {
      if (Array.isArray(val)) {
        if (!val.some((v) => String(v) === String(cond))) return false;
      } else if (String(val) !== String(cond) && val !== cond) {
        return false;
      }
    }
  }
  return true;
}

/** Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Doc[]) {
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

function makeTheme(overrides: Doc = {}): Doc {
  return {
    _id: 'theme-x',
    slug: 'theme_x-op1-1',
    animethemesId: 1,
    songTitle: 'Song',
    animeTitle: 'Anime',
    animeTitleEnglish: null,
    artistName: 'Artist',
    allArtists: ['Artist'],
    artistSlugs: [],
    artistRoles: [],
    anilistId: null,
    kitsuId: null,
    animeTitleAlternative: [],
    animeSeason: 'FALL',
    animeSeasonYear: 2024,
    animeCoverImage: null,
    animeCoverImageSmall: null,
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 1, tags: [] }],
    videoUrl: 'https://example.com/v.webm',
    audioUrl: null,
    mood: [],
    embedding: null,
    avgRating: 0,
    totalRatings: 0,
    totalWatches: 0,
    totalListens: 0,
    duration: 90,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: false,
    popularRank: null,
    featuredAt: null,
    ...overrides,
  };
}

function makeFakeModels() {
  const now = Date.now();
  const users: Doc[] = [
    {
      _id: 'user-1',
      username: 'one',
      displayName: 'One',
      email: 'one@example.com',
      avatarUrl: 'https://img/1.png',
      totalRatings: 0,
      totalTime: 0,
    },
    {
      _id: 'user-2',
      username: 'two',
      displayName: 'Two',
      email: 'two@example.com',
      avatarUrl: null,
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'tok-2',
        userId: 42,
        username: 'AniTwo',
        syncedAt: new Date(now),
        completedMediaIds: [42],
      },
    },
    {
      _id: 'user-3',
      username: 'three',
      displayName: 'Three',
      email: 'three@example.com',
      avatarUrl: null,
      totalRatings: 0,
      totalTime: 0,
      anilist: {
        accessToken: 'tok-3',
        userId: 7,
        username: 'AniThree',
        completedMediaIds: [],
      },
    },
  ];

  const themes: Doc[] = [
    makeTheme({
      _id: 't-src',
      slug: 'source-op',
      songTitle: 'Source Song',
      animeTitle: 'Source Anime',
      artistName: 'Shared Artist',
      artistSlugs: ['shared_artist'],
      anilistId: 100,
      animeSeasonYear: 2024,
      mood: ['epic'],
      entries: [{ atEntryId: 1, tags: ['NC'] }],
      totalRatings: 50,
      avgRating: 8.0,
    }),
    makeTheme({
      _id: 't-same-anime',
      slug: 'same-anime-ed',
      songTitle: 'Same Anime Song',
      animeTitle: 'Source Anime',
      artistName: 'Other',
      artistSlugs: [],
      anilistId: 100,
      type: 'ED',
      animeSeasonYear: 2025,
      totalRatings: 90,
      avgRating: 7.5,
    }),
    makeTheme({
      _id: 't-same-artist',
      slug: 'other-anime-op',
      songTitle: 'Other Anime Song',
      animeTitle: 'Other Anime',
      artistName: 'Shared Artist',
      artistSlugs: ['shared_artist'],
      anilistId: 200,
      animeSeasonYear: 2024,
      totalRatings: 90,
      avgRating: 9.0,
    }),
    makeTheme({
      _id: 't-mood',
      slug: 'mood-op',
      songTitle: 'Mood Song',
      animeTitle: 'Third Anime',
      artistName: 'Third Artist',
      anilistId: 300,
      mood: ['epic'],
      totalRatings: 10,
      avgRating: 6.0,
    }),
    makeTheme({
      _id: 't-unrelated',
      slug: 'unrelated-op',
      songTitle: 'Far Song',
      animeTitle: 'Far Anime',
      artistName: 'Far Artist',
      anilistId: 400,
      mood: ['calm'],
      entries: [{ atEntryId: 1, tags: ['Lyrics'] }],
      totalRatings: 99,
      avgRating: 9.9,
    }),
    makeTheme({
      _id: 't-anilist',
      slug: 'anilist-op',
      songTitle: 'Completed Song',
      animeTitle: 'Completed Anime',
      artistName: 'Completed Artist',
      anilistId: 42,
      animeSeasonYear: 2023,
    }),
    makeTheme({
      _id: 't-derived',
      slug: 'derived-op',
      songTitle: 'Derived Song',
      animeTitle: 'Derived Anime',
      artistName: 'Derived Artist',
      videoUrl: 'https://v.animethemes.moe/DerivedAnime-OP1.webm',
      audioUrl: null,
      entries: [
        {
          atEntryId: 9,
          version: 'v1',
          episodes: null,
          spoiler: false,
          nsfw: false,
          tags: [],
          videoSources: [],
          videoUrl: 'https://v.animethemes.moe/DerivedAnime-OP1.webm',
          audioUrl: null,
          duration: 90,
        },
      ],
    }),
  ];

  const anime: Doc[] = [
    { _id: 'a1', anilistId: 42, titleRomaji: 'Saga S1', series: ['Saga'], seasonYear: 2020 },
    { _id: 'a2', anilistId: 43, titleRomaji: 'Saga S0', series: ['Saga'], seasonYear: 2018 },
    { _id: 'a3', anilistId: 44, titleRomaji: 'Saga S2', series: ['Saga', 'Other'], seasonYear: 2022 },
    { _id: 'a4', anilistId: 45, titleRomaji: 'Different', series: ['Different'], seasonYear: 2019 },
    { _id: 'a5', anilistId: 46, titleRomaji: 'Standalone', series: [], seasonYear: 2021 },
  ].map((a) => ({
    malId: null,
    kitsuId: null,
    titleEnglish: null,
    titleNative: null,
    titleAlternative: [],
    season: 'SPRING',
    genres: [],
    coverImageLarge: null,
    coverImageMedium: null,
    bannerImage: null,
    studios: [],
    totalEpisodes: null,
    status: null,
    averageScore: null,
    ...a,
  }));

  const history: Doc[] = [];
  const play = (userId: string, theme: Doc, times: number, viewedAt: Date) => {
    for (let i = 0; i < times; i++) {
      history.push({
        _id: `hist-${history.length + 1}`,
        userId,
        themeId: theme._id,
        themeSlug: theme.slug,
        atEntryId: 1,
        mode: 'watch',
        viewedAt,
      });
    }
  };
  const bySlug = (slug: string) => themes.find((t) => t.slug === slug) as Doc;
  play('user-1', bySlug('source-op'), 2, new Date(now - 60_000));
  play('user-1', bySlug('other-anime-op'), 3, new Date(now - 120_000));
  play('user-1', bySlug('same-anime-ed'), 1, new Date(now - 180_000));
  // user-2's only play is hours old: not a "live" listener.
  play('user-2', bySlug('anilist-op'), 1, new Date(now - 3 * 60 * 60_000));

  const artists: Doc[] = [
    { _id: 'artist-1', slug: 'shared_artist', name: 'Shared Artist', imageUrl: 'https://img/shared.png' },
  ];

  const setNested = (doc: Doc, path: string, value: unknown) => {
    const parts = path.split('.');
    let cursor = doc;
    for (const part of parts.slice(0, -1)) {
      cursor = (cursor[part] ??= {}) as Doc;
    }
    cursor[parts[parts.length - 1]] = value;
  };

  const userModel = {
    docs: users,
    findById: (id: unknown) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
    findByIdAndUpdate: (id: unknown, update: Doc) => {
      const doc = users.find((u) => String(u._id) === String(id));
      if (doc) {
        for (const [key, value] of Object.entries(update)) {
          if (key.includes('.')) setNested(doc, key, value);
          else doc[key] = value;
        }
      }
      return queryOf(doc ?? null);
    },
    find: (filter: Doc) => chain(users.filter((u) => clauseMatches(u, filter))),
    countDocuments: () => queryOf(users.length),
  };

  const themeModel = {
    docs: themes,
    findOne: (filter: Doc) =>
      queryOf(themes.find((t) => clauseMatches(t, filter)) ?? null),
    find: (filter: Doc) => chain(themes.filter((t) => clauseMatches(t, filter))),
    countDocuments: (filter: Doc) =>
      queryOf(themes.filter((t) => clauseMatches(t, filter)).length),
  };

  const animeModel = {
    docs: anime,
    findOne: (filter: Doc) =>
      queryOf(anime.find((a) => clauseMatches(a, filter)) ?? null),
    find: (filter: Doc) => chain(anime.filter((a) => clauseMatches(a, filter))),
  };

  const historyModel = {
    docs: history,
    find: (filter: Doc) =>
      chain(history.filter((h) => clauseMatches(h, filter))),
    exists: async (filter: Doc) =>
      history.some((h) => clauseMatches(h, filter)) ? { _id: 'x' } : null,
    distinct: (field: string, filter: Doc) =>
      queryOf([
        ...new Set(
          history.filter((h) => clauseMatches(h, filter)).map((h) => h[field]),
        ),
      ]),
    aggregate: async (pipeline: Doc[]) => {
      const match = (pipeline[0] as { $match: Doc }).$match;
      const rows = history.filter((h) => clauseMatches(h, match));
      const counts = new Map<unknown, number>();
      for (const r of rows) {
        counts.set(r.themeId, (counts.get(r.themeId) ?? 0) + 1);
      }
      const grouped = [...counts.entries()].map(([_id, count]) => ({
        _id,
        count,
      }));
      grouped.sort((a, b) => b.count - a.count);
      const limit = (pipeline[3] as { $limit: number }).$limit;
      return grouped.slice(0, limit);
    },
  };

  const artistModel = {
    docs: artists,
    find: (filter: Doc) =>
      queryOf(artists.filter((a) => clauseMatches(a, filter))),
  };

  return { userModel, themeModel, animeModel, historyModel, artistModel };
}

const E2E_SECRET = ['e2e', 'residual', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'residual', 'refresh', 'secret'].join('-');

/**
 * Suite 2 — the residual controllers wired to mocked models, over
 * real HTTP: similar/related shapes + ordering + 404s, the library
 * themes union with its AniList cache states, the history check's
 * optional-auth contract, and both stats reads.
 */
describe('Residual reads with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  const anilistLibraryStub = {
    fetchLibraryMediaIds: jest.fn(async () => [200] as number[] | null),
  };

  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, username: userId, email: `${userId}@example.com`, tokenType: 'access' },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const asUser = (userId: string) => ({
    Authorization: `Bearer ${tokenFor(userId)}`,
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [
        ThemesController,
        LibraryController,
        HistoryCheckController,
        StatsController,
      ],
      providers: [
        ThemesService,
        LibraryService,
        StatsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: AnilistLibraryClient, useValue: anilistLibraryStub },
        { provide: getModelToken(User.name), useValue: models.userModel },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        {
          provide: getModelToken(AnimeCache.name),
          useValue: models.animeModel,
        },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        {
          provide: getModelToken(ArtistCache.name),
          useValue: models.artistModel,
        },
        { provide: getModelToken(Favorite.name), useValue: {} },
        { provide: getModelToken(Rating.name), useValue: {} },
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

  it('GET /themes/:slug — a null audioUrl is served as the derived .ogg twin', async () => {
    const res = await request(app.getHttpServer())
      .get('/themes/derived-op')
      .expect(200);
    expect(res.body.audioUrl).toBe(
      'https://a.animethemes.moe/DerivedAnime-OP1.ogg',
    );
    expect(res.body.entries[0].audioUrl).toBe(
      'https://a.animethemes.moe/DerivedAnime-OP1.ogg',
    );
    // The stored video side is untouched by the derivation.
    expect(res.body.videoUrl).toBe(
      'https://v.animethemes.moe/DerivedAnime-OP1.webm',
    );
  });

  it('GET /themes/:slug/similar — matches anime/artist/mood, web order, self excluded', async () => {
    const res = await request(app.getHttpServer())
      .get('/themes/source-op/similar')
      .expect(200);
    // totalRatings desc, avgRating desc on ties: same-artist (90, 9.0),
    // same-anime (90, 7.5), mood (10) — the 99-rated unrelated theme
    // matches nothing and the source itself is excluded.
    expect(res.body.themes.map((t: Doc) => t.slug)).toEqual([
      'other-anime-op',
      'same-anime-ed',
      'mood-op',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('embedding');
  });

  it('GET /themes/:slug/similar — 404 for an unknown slug', async () => {
    const res = await request(app.getHttpServer())
      .get('/themes/nope/similar')
      .expect(404);
    expect(res.body.message).toBe('Theme not found: nope');
  });

  it('GET /anime/:id/related — series members, chronological, projected', async () => {
    const res = await request(app.getHttpServer())
      .get('/anime/42/related')
      .expect(200);
    expect(res.body.related.map((a: Doc) => a.anilistId)).toEqual([43, 44]);
    expect(res.body.related[0]).toMatchObject({
      titleRomaji: 'Saga S0',
      seasonYear: 2018,
      series: ['Saga'],
    });
    expect(res.body.related[0]).not.toHaveProperty('syncedAt');
  });

  it('GET /anime/:id/related — empty list for a series-less anime, 404 for an unknown id', async () => {
    const http = request(app.getHttpServer());
    const empty = await http.get('/anime/46/related').expect(200);
    expect(empty.body).toEqual({ related: [] });
    const missing = await http.get('/anime/999/related').expect(404);
    expect(missing.body.message).toBe('Anime not found');
  });

  it('GET /library/themes — the caller’s watched themes, web order + meta', async () => {
    const res = await request(app.getHttpServer())
      .get('/library/themes')
      .set(asUser('user-1'))
      .expect(200);
    expect(res.body.total).toBe(3);
    // animeSeasonYear desc, animeTitle asc: 2025 ED, then the two
    // 2024 themes alphabetically.
    expect(res.body.themes.map((t: Doc) => t.slug)).toEqual([
      'same-anime-ed',
      'other-anime-op',
      'source-op',
    ]);
    expect(res.body.anilistUser).toBeNull();
    expect(res.body.anilistSyncDeferred).toBe(false);
    expect(res.body.anilistDataStale).toBe(false);
  });

  it('GET /library/themes — a fresh stored AniList cache unions in without a fetch', async () => {
    const res = await request(app.getHttpServer())
      .get('/library/themes')
      .set(asUser('user-2'))
      .expect(200);
    // user-2's one watched theme IS the anilistId-42 theme: the
    // union counts it once.
    expect(res.body.total).toBe(1);
    expect(res.body.themes.map((t: Doc) => t.slug)).toEqual(['anilist-op']);
    expect(res.body.anilistUser).toBe('AniTwo');
    expect(res.body.anilistSyncDeferred).toBe(false);
    expect(res.body.anilistDataStale).toBe(false);
    expect(anilistLibraryStub.fetchLibraryMediaIds).not.toHaveBeenCalled();
  });

  it('GET /library/themes — first sync fetches, persists, and serves the fetched ids', async () => {
    const res = await request(app.getHttpServer())
      .get('/library/themes')
      .set(asUser('user-3'))
      .expect(200);
    // The stub's [200] is other-anime-op's anilistId.
    expect(res.body.themes.map((t: Doc) => t.slug)).toEqual(['other-anime-op']);
    expect(res.body.anilistUser).toBe('AniThree');
    expect(anilistLibraryStub.fetchLibraryMediaIds).toHaveBeenCalledWith(
      'tok-3',
      7,
    );
    const user3 = models.userModel.docs.find((u) => u._id === 'user-3') as Doc;
    expect((user3.anilist as Doc).completedMediaIds).toEqual([200]);
    expect((user3.anilist as Doc).syncedAt).toBeInstanceOf(Date);
  });

  it('GET /library/count — reads the same persisted AniList set the themes sync stored', async () => {
    // Runs after the first-sync test above: user-3's stored set is
    // the fetched [200]. other-anime-op (anilistId 200) has no
    // audio source, so the count's audio filter excludes it — the
    // two endpoints agree on the id set and differ only by that
    // filter, exactly as on the themes side.
    const res = await request(app.getHttpServer())
      .get('/library/count')
      .set(asUser('user-3'))
      .expect(200);
    expect(res.body).toEqual({ count: 0 });
  });

  it('GET /library/history/check — the web’s optional-auth contract', async () => {
    const http = request(app.getHttpServer());

    // Anonymous: watched:false, never a 401 — even without a slug.
    const anon = await http.get('/library/history/check?slug=source-op').expect(200);
    expect(anon.body).toEqual({ watched: false });
    const anonNoSlug = await http.get('/library/history/check').expect(200);
    expect(anonNoSlug.body).toEqual({ watched: false });
    // A garbage token is anonymous too.
    const garbage = await http
      .get('/library/history/check?slug=source-op')
      .set('Authorization', 'Bearer not-a-token')
      .expect(200);
    expect(garbage.body).toEqual({ watched: false });

    // Signed in: real membership, per user.
    const watched = await http
      .get('/library/history/check?slug=source-op')
      .set(asUser('user-1'))
      .expect(200);
    expect(watched.body).toEqual({ watched: true });
    const notWatched = await http
      .get('/library/history/check?slug=anilist-op')
      .set(asUser('user-1'))
      .expect(200);
    expect(notWatched.body).toEqual({ watched: false });

    // Signed in without a slug: the web's 400.
    const noSlug = await http
      .get('/library/history/check')
      .set(asUser('user-1'))
      .expect(400);
    expect(noSlug.body.message).toBe('Slug required');
  });

  it('GET /stats/live — totals, recent listeners, their avatars', async () => {
    const res = await request(app.getHttpServer()).get('/stats/live').expect(200);
    expect(res.body.activeUsers).toBe(3);
    // Only user-1 listened inside the window (+ the web's 0–4 noise).
    expect(res.body.listeningNow).toBeGreaterThanOrEqual(1);
    expect(res.body.listeningNow).toBeLessThanOrEqual(5);
    expect(res.body.listeningAvatars).toEqual(['https://img/1.png']);
  });

  it('GET /stats/top-artists — auth-gated, plays folded per artist, images joined', async () => {
    const http = request(app.getHttpServer());
    await http.get('/stats/top-artists').expect(401);

    const res = await http
      .get('/stats/top-artists')
      .set(asUser('user-1'))
      .expect(200);
    expect(res.body.artists).toEqual([
      {
        name: 'Shared Artist',
        plays: 5,
        slug: 'shared_artist',
        image: 'https://img/shared.png',
      },
      { name: 'Other', plays: 1, slug: '', image: null },
    ]);
  });
});
