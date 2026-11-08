import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { AnilistHistoryClient } from './../src/users/anilist-history.client';
import { UsersController } from './../src/users/users.controller';
import { UsersService } from './../src/users/users.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots
 * and the per-user history/ratings reads answer 503 (model-less
 * service).
 */
describe('User history/ratings without a database (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 on both reads, in both history modes', async () => {
    const http = request(app.getHttpServer());
    await http.get('/users/alice/history').expect(503);
    await http.get('/users/alice/history?includeMerged=1').expect(503);
    await http.get('/users/alice/ratings').expect(503);
  });
});

/* ------------------------------------------------------------------ */

/** Filter matching — the subset of Mongo semantics the service uses. */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return String(a) === String(b);
  }
  return false;
}

function fieldMatches(docValue: unknown, condition: unknown): boolean {
  if (
    condition !== null &&
    typeof condition === 'object' &&
    !(condition instanceof Date)
  ) {
    const c = condition as Record<string, unknown>;
    if ('$in' in c) {
      return (c.$in as unknown[]).some((v) => valueEquals(docValue, v));
    }
    if ('$ne' in c) {
      return !valueEquals(docValue, c.$ne);
    }
    return valueEquals(docValue, condition);
  }
  return valueEquals(docValue, condition);
}

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return (condition as Record<string, unknown>[]).some((f) =>
        matches(doc, f),
      );
    }
    return fieldMatches(doc[key], condition);
  });
}

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
  q.limit = (n: number) => {
    result = result.slice(0, n);
    return q;
  };
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390b2';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';

const T0 = Date.parse('2026-11-07T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function makeFakeModels() {
  const users: Record<string, unknown>[] = [
    {
      _id: ALICE,
      username: 'alice',
      displayName: 'Alice A',
      email: 'alice@example.com',
      passwordHash: 'never-served',
      anilist: {
        accessToken: 'anilist-secret-token',
        userId: 42,
        username: 'AliceAni',
        completedMediaIds: [],
      },
    },
    { _id: BOB, username: 'bob', displayName: 'Bob B' },
  ];
  const themes: Record<string, unknown>[] = [
    {
      _id: THEME_A,
      slug: 'anime_a-op1-1',
      songTitle: 'Song A',
      animeTitle: 'Anime A',
      animeTitleEnglish: 'Anime A EN',
      artistName: 'Artist A',
      allArtists: ['Artist A'],
      type: 'OP',
      sequence: 1,
      animeSeason: 'SPRING',
      animeSeasonYear: 2026,
      animeCoverImage: 'https://example.com/a.jpg',
      animeCoverImageSmall: 'https://example.com/a-small.jpg',
      anilistId: 21,
      audioUrl: 'a.mp3',
      avgRating: 8.5,
      totalRatings: 10,
      totalWatches: 100,
      totalListens: 40,
      isPopular: false,
      popularRank: null,
    },
    {
      _id: THEME_B,
      slug: 'anime_b-op1-2',
      songTitle: 'Song B',
      animeTitle: 'Anime B',
      animeTitleEnglish: 'Anime B EN',
      artistName: 'Artist B',
      allArtists: ['Artist B'],
      type: 'ED',
      sequence: 1,
      animeSeason: 'SPRING',
      animeSeasonYear: 2026,
      animeCoverImage: 'https://example.com/b.jpg',
      animeCoverImageSmall: 'https://example.com/b-small.jpg',
      anilistId: 22,
      audioUrl: 'b.mp3',
      avgRating: 7.5,
      totalRatings: 5,
      totalWatches: 50,
      totalListens: 20,
      isPopular: false,
      popularRank: null,
    },
  ];
  const ratings: Record<string, unknown>[] = [
    {
      _id: 'r1',
      userId: ALICE,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      score: 9,
      mode: 'watch',
      createdAt: at(100),
      updatedAt: at(100),
    },
    {
      _id: 'r2',
      userId: ALICE,
      themeId: THEME_B,
      themeSlug: 'anime_b-op1-2',
      score: 7,
      mode: 'listen',
      createdAt: at(300),
      updatedAt: at(300),
    },
  ];
  const history: Record<string, unknown>[] = [
    {
      _id: 'h1',
      userId: ALICE,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 11,
      mode: 'watch',
      viewedAt: at(100),
    },
    {
      _id: 'h2',
      userId: ALICE,
      themeId: THEME_B,
      themeSlug: 'anime_b-op1-2',
      atEntryId: null,
      mode: 'listen',
      viewedAt: at(300),
    },
  ];

  return {
    userModel: {
      findOne: (filter: Record<string, unknown>) =>
        queryOf(users.find((u) => matches(u, filter)) ?? null),
    },
    ratingModel: {
      find: (filter: Record<string, unknown>) =>
        chain(ratings.filter((r) => matches(r, filter))),
    },
    historyModel: {
      find: (filter: Record<string, unknown>) =>
        chain(history.filter((h) => matches(h, filter))),
      distinct: (field: string, filter: Record<string, unknown>) =>
        queryOf([
          ...new Set(
            history
              .filter((h) => matches(h, filter))
              .map((h) => h[field] as unknown),
          ),
        ]),
    },
    themeModel: {
      find: (filter: Record<string, unknown>) =>
        chain(themes.filter((t) => matches(t, filter))),
      countDocuments: (filter: Record<string, unknown>) =>
        queryOf(themes.filter((t) => matches(t, filter)).length),
    },
  };
}

/**
 * Suite 2 — the users controller wired to mocked models (and a
 * stubbed AniList history client), over real HTTP: the public
 * ratings + history reads, the merged history's owner gate, and
 * 404s.
 */
describe('User history/ratings with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  const E2E_SECRET = 's6-users-e2e-secret';

  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, username: userId, email: `${userId}@example.com`, tokenType: 'access' },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const asAlice = () => ({ Authorization: `Bearer ${tokenFor(ALICE)}` });

  const anilistHistoryStub = {
    fetchCompletedEntries: async () => [
      {
        updatedAt: Math.floor(at(400).getTime() / 1000),
        media: {
          id: 99,
          title: { romaji: 'Remote Show', english: 'Remote Show' },
          coverImage: { large: 'https://example.com/remote-99.jpg' },
          episodes: 24,
        },
      },
    ],
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = 's6-users-e2e-refresh-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [UsersController],
      providers: [
        UsersService,
        AuthService,
        AnilistClient,
        { provide: AnilistHistoryClient, useValue: anilistHistoryStub },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
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

  it('serves ratings newest first with themes joined — and no private fields', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/users/alice/ratings').expect(200);
    expect(res.body.ratings.map((r: { id: string }) => r.id)).toEqual([
      'r2',
      'r1',
    ]);
    expect(res.body.ratings[0]).toMatchObject({
      themeSlug: 'anime_b-op1-2',
      score: 7,
      mode: 'listen',
      theme: { slug: 'anime_b-op1-2' },
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('anilist-secret-token');
    expect(raw).not.toContain('passwordHash');
  });

  it('404s unknown usernames on both reads', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/users/nobody/ratings').expect(404);
    expect(res.body.message).toBe('User not found');
    await http.get('/users/nobody/history').expect(404);
  });

  it('serves the default history with the web’s meta, case-insensitive username', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/users/ALICE/history').expect(200);
    expect(res.body.meta).toEqual({
      total: 2,
      localCount: 2,
      remoteCount: 0,
      merged: false,
    });
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual([
      'h2',
      'h1',
    ]);
    expect(res.body.entries[0].theme.slug).toBe('anime_b-op1-2');
  });

  it('merged mode for an anonymous caller stays local-only', async () => {
    const http = request(app.getHttpServer());
    const res = await http
      .get('/users/alice/history?includeMerged=1')
      .expect(200);
    expect(res.body.meta).toMatchObject({
      merged: true,
      localCount: 2,
      remoteCount: 0,
      anilistConnected: true,
      anilistIncluded: false,
      anilistError: null,
      libraryTotal: 2,
    });
    expect(
      res.body.entries.every(
        (e: { source: string }) => e.source === 'Local',
      ),
    ).toBe(true);
  });

  it('merged mode for the owner merges the AniList completed list in', async () => {
    const http = request(app.getHttpServer());
    const res = await http
      .get('/users/alice/history?includeMerged=1')
      .set(asAlice())
      .expect(200);
    expect(res.body.meta).toMatchObject({
      merged: true,
      localCount: 2,
      remoteCount: 1,
      anilistIncluded: true,
      anilistError: null,
    });
    expect(res.body.entries.map((e: { id: unknown }) => e.id)).toEqual([
      99,
      THEME_B,
      THEME_A,
    ]);
    expect(res.body.entries[0]).toMatchObject({
      source: 'AniList',
      title: 'Remote Show',
      episodeCount: 24,
    });
  });
});
