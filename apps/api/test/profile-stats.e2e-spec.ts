import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { Follow } from './../src/social/follow.schema';
import { Notification } from './../src/social/notification.schema';
import { SocialController } from './../src/social/social.controller';
import { SocialService } from './../src/social/social.service';

/**
 * Profile listening stats (owner-ordered for the Profile design),
 * over real HTTP with mocked models: GET /users/:username and
 * GET /auth/me must serve the SAME aggregates — the mean of the
 * ratings the user gave, the distinct-theme count, and the summed
 * played-entry durations — and the public profile must expose
 * aggregates ONLY (no email, no hash, no AniList token, no
 * history/rating rows).
 *
 * Perf problem 4: the seeds below predate the stored stats, so
 * these serves exercise the FALLBACK (computeProfileStats over
 * the rows). The stored path — and the proof that stored and
 * fallback agree — lives in profile-stats-stored.e2e-spec.ts.
 */

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

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (
      condition !== null &&
      typeof condition === 'object' &&
      '$in' in (condition as Record<string, unknown>)
    ) {
      return ((condition as { $in: unknown[] }).$in ?? []).some((v) =>
        valueEquals(doc[key], v),
      );
    }
    return valueEquals(doc[key], condition);
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

const STATSY = '507f1f77bcf86cd7994390a1';
const EMPTY = '507f1f77bcf86cd7994390b2';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';

function makeFakeModels() {
  const users: Record<string, unknown>[] = [
    {
      _id: STATSY,
      username: 'statsy',
      displayName: 'Statsy S',
      email: 'statsy@example.com',
      passwordHash: 'bcrypt-hash-never-served',
      avatarUrl: null,
      bio: 'stats bio',
      totalRatings: 2,
      // DRIFTED on purpose (audit S3): the follows rows below are
      // the truth (3 followers / 5 following); the served stats
      // must come from them, never from these stored values.
      totalFollowers: 99,
      totalFollowing: 98,
      totalTime: 0,
      isPublic: true,
      anilist: {
        accessToken: 'anilist-secret-token',
        userId: 9,
        username: 'StatsyAni',
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      _id: EMPTY,
      username: 'empty',
      displayName: 'Empty E',
      email: 'empty@example.com',
      passwordHash: 'bcrypt-hash-never-served',
      avatarUrl: null,
      bio: '',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];
  const ratings: Record<string, unknown>[] = [
    { userId: STATSY, themeId: THEME_A, themeSlug: 'secret-slug-a', score: 10, mode: 'listen' },
    { userId: STATSY, themeId: THEME_B, themeSlug: 'secret-slug-b', score: 7, mode: 'watch' },
  ];
  const history: Record<string, unknown>[] = [
    { userId: STATSY, themeId: THEME_A, themeSlug: 'secret-slug-a', atEntryId: 1, mode: 'listen' },
    { userId: STATSY, themeId: THEME_A, themeSlug: 'secret-slug-a', atEntryId: 1, mode: 'listen' },
    { userId: STATSY, themeId: THEME_B, themeSlug: 'secret-slug-b', atEntryId: 5, mode: 'watch' },
  ];
  const themes: Record<string, unknown>[] = [
    { _id: THEME_A, slug: 'secret-slug-a', entries: [{ atEntryId: 1, duration: 3600 }] },
    { _id: THEME_B, slug: 'secret-slug-b', entries: [{ atEntryId: 5, duration: 1800 }] },
  ];
  // The follow truth: STATSY has 3 followers / 5 following;
  // EMPTY sits on both sides of one follow (with STATSY), so
  // its counts are 1 / 1 — everything else about it is empty.
  const follows: Record<string, unknown>[] = [
    { followerId: EMPTY, followeeId: STATSY },
    { followerId: '507f1f77bcf86cd7994390f1', followeeId: STATSY },
    { followerId: '507f1f77bcf86cd7994390f2', followeeId: STATSY },
    { followerId: STATSY, followeeId: EMPTY },
    { followerId: STATSY, followeeId: '507f1f77bcf86cd7994390f1' },
    { followerId: STATSY, followeeId: '507f1f77bcf86cd7994390f2' },
    { followerId: STATSY, followeeId: '507f1f77bcf86cd7994390f3' },
    { followerId: STATSY, followeeId: '507f1f77bcf86cd7994390f4' },
  ];

  const findModel = (docs: Record<string, unknown>[]) => ({
    docs,
    find: (filter: Record<string, unknown>) =>
      chain(docs.filter((d) => matches(d, filter))),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(docs.find((d) => matches(d, filter)) ?? null),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter)).length),
  });

  const userModel = {
    docs: users,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(users.find((u) => matches(u, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
    findById: (id: unknown) =>
      queryOf(users.find((u) => valueEquals(u._id, id)) ?? null),
  };

  return {
    userModel,
    ratingModel: findModel(ratings),
    historyModel: findModel(history),
    themeModel: findModel(themes),
    followModel: findModel(follows),
    notificationModel: findModel([]),
  };
}

const E2E_SECRET = 'profile-stats-e2e-access-secret';
const E2E_REFRESH_SECRET = 'profile-stats-e2e-refresh-secret';

const EXPECTED_STATSY_STATS = {
  meanRating: 8.5, // (10 + 7) / 2
  themesListened: 2, // A and B — A played twice counts once
  totalListenedSeconds: 3600 + 3600 + 1800,
  followersCount: 3,
  followingCount: 5,
};

describe('Profile stats with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

  const tokenFor = (userId: string) =>
    jwt.sign(
      {
        userId,
        username: userId,
        email: `${userId}@example.com`,
        tokenType: 'access',
      },
      E2E_SECRET,
      { expiresIn: '15m' },
    );

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [AuthController, SocialController],
      providers: [
        AuthService,
        SocialService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        { provide: getModelToken(Follow.name), useValue: models.followModel },
        {
          provide: getModelToken(Notification.name),
          useValue: models.notificationModel,
        },
      ],
    })
      // Hand-wired controllers (no AuthModule): the auth
      // controller's ThrottlerGuard is stood down — throttling has
      // its own dedicated suite (auth-throttle.e2e-spec.ts).
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('serves the exact aggregates on the public profile — and nothing private', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/statsy')
      .expect(200);
    expect(res.body.stats).toEqual(EXPECTED_STATSY_STATS);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('statsy@example.com');
    expect(raw).not.toContain('bcrypt-hash-never-served');
    expect(raw).not.toContain('anilist-secret-token');
    expect(raw).not.toContain('StatsyAni');
    // Aggregates only — no history/rating row content rides along.
    expect(raw).not.toContain('secret-slug');
  });

  it('serves the same aggregates on GET /auth/me', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${tokenFor(STATSY)}` })
      .expect(200);
    expect(res.body.stats).toEqual(EXPECTED_STATSY_STATS);
  });

  it('answers the zero state for a user with no ratings or history', async () => {
    const http = request(app.getHttpServer());
    const pub = await http.get('/users/empty').expect(200);
    expect(pub.body.stats).toEqual({
      meanRating: null,
      themesListened: 0,
      totalListenedSeconds: 0,
      // Not zero: EMPTY follows STATSY and is followed by her —
      // the counts come from the follows rows, as they should.
      followersCount: 1,
      followingCount: 1,
    });
    const me = await http
      .get('/auth/me')
      .set({ Authorization: `Bearer ${tokenFor(EMPTY)}` })
      .expect(200);
    expect(me.body.stats).toEqual(pub.body.stats);
  });
});
