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
 * Stored profile stats (perf problem 4), over real HTTP with
 * mocked models — the serve-side counterpart of
 * profile-stats.e2e-spec.ts (which covers the pre-backfill
 * FALLBACK over the same fixture shape):
 *
 * - a MAINTAINED user (stored stats* on the document) is served
 *   from the record: the aggregates come from the stored fields
 *   even when the rating/history read models THROW — the serve
 *   never counts at view time;
 * - an UNMAINTAINED user (no statsRatingCount) falls back to
 *   computeProfileStats and is served the same true numbers —
 *   and the fallback does NOT backfill (the document is left
 *   untouched; repair is the recount's job);
 * - with the stored values seeded from the same fixture rows the
 *   fallback computes over, both users serve IDENTICAL stats —
 *   stored and computed agree.
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

const MAINTAINED = '507f1f77bcf86cd7994390a1';
const UNMAINTAINED = '507f1f77bcf86cd7994390b2';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';

function makeFakeModels() {
  // Both users own the SAME rows (ratings 10 + 7; plays A@1, A@1,
  // B@5) so the computed truth is identical for both: mean 8.5,
  // 2 distinct themes, 3600 + 3600 + 1800 seconds. MAINTAINED
  // carries exactly those values stored; UNMAINTAINED carries
  // none of the stats fields.
  const baseUser = {
    displayName: 'Same Rows',
    email: 'same@example.com',
    passwordHash: 'bcrypt-hash-never-served',
    avatarUrl: null,
    bio: '',
    totalRatings: 2,
    totalFollowers: 0,
    totalFollowing: 0,
    totalTime: 9000,
    isPublic: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const users: Record<string, unknown>[] = [
    {
      ...baseUser,
      _id: MAINTAINED,
      username: 'maintained',
      statsListenedThemes: 2,
      statsListenedSeconds: 9000,
      statsRatingSum: 17,
      statsRatingCount: 2,
    },
    { ...baseUser, _id: UNMAINTAINED, username: 'unmaintained' },
  ];
  const ratings: Record<string, unknown>[] = [
    { userId: MAINTAINED, themeId: THEME_A, themeSlug: 'a', score: 10, mode: 'listen' },
    { userId: MAINTAINED, themeId: THEME_B, themeSlug: 'b', score: 7, mode: 'watch' },
    { userId: UNMAINTAINED, themeId: THEME_A, themeSlug: 'a', score: 10, mode: 'listen' },
    { userId: UNMAINTAINED, themeId: THEME_B, themeSlug: 'b', score: 7, mode: 'watch' },
  ];
  const history: Record<string, unknown>[] = [
    { userId: MAINTAINED, themeId: THEME_A, themeSlug: 'a', atEntryId: 1, mode: 'listen' },
    { userId: MAINTAINED, themeId: THEME_A, themeSlug: 'a', atEntryId: 1, mode: 'listen' },
    { userId: MAINTAINED, themeId: THEME_B, themeSlug: 'b', atEntryId: 5, mode: 'watch' },
    { userId: UNMAINTAINED, themeId: THEME_A, themeSlug: 'a', atEntryId: 1, mode: 'listen' },
    { userId: UNMAINTAINED, themeId: THEME_A, themeSlug: 'a', atEntryId: 1, mode: 'listen' },
    { userId: UNMAINTAINED, themeId: THEME_B, themeSlug: 'b', atEntryId: 5, mode: 'watch' },
  ];
  const themes: Record<string, unknown>[] = [
    { _id: THEME_A, slug: 'a', entries: [{ atEntryId: 1, duration: 3600 }] },
    { _id: THEME_B, slug: 'b', entries: [{ atEntryId: 5, duration: 1800 }] },
  ];
  const follows: Record<string, unknown>[] = [
    { followerId: UNMAINTAINED, followeeId: MAINTAINED },
    { followerId: MAINTAINED, followeeId: UNMAINTAINED },
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

const E2E_SECRET = 'profile-stats-stored-e2e-secret';
const E2E_REFRESH_SECRET = 'profile-stats-stored-e2e-refresh';

const EXPECTED_STATS = {
  meanRating: 8.5,
  themesListened: 2,
  totalListenedSeconds: 9000,
  followersCount: 1,
  followingCount: 1,
};

describe('Stored profile stats serves (e2e)', () => {
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

  it('serves a maintained user from the stored fields — identical to the computed truth', async () => {
    const http = request(app.getHttpServer());
    const pub = await http.get('/users/maintained').expect(200);
    expect(pub.body.stats).toEqual(EXPECTED_STATS);
    const me = await http
      .get('/auth/me')
      .set({ Authorization: `Bearer ${tokenFor(MAINTAINED)}` })
      .expect(200);
    expect(me.body.stats).toEqual(EXPECTED_STATS);
  });

  it('serves an unmaintained user via the fallback — same numbers, no silent backfill', async () => {
    const http = request(app.getHttpServer());
    const pub = await http.get('/users/unmaintained').expect(200);
    expect(pub.body.stats).toEqual(EXPECTED_STATS);
    const me = await http
      .get('/auth/me')
      .set({ Authorization: `Bearer ${tokenFor(UNMAINTAINED)}` })
      .expect(200);
    expect(me.body.stats).toEqual(EXPECTED_STATS);
    // The serve did NOT write the stored fields back: backfill
    // is the recount's job, never a profile view's side effect.
    const doc = models.userModel.docs.find(
      (u) => u.username === 'unmaintained',
    );
    expect(doc?.statsRatingCount).toBeUndefined();
    expect(doc?.statsListenedThemes).toBeUndefined();
  });

  it('never counts at view time for a maintained user — the aggregate reads may be down', async () => {
    const http = request(app.getHttpServer());
    const boom = () => {
      throw new Error('aggregate store down');
    };
    const ratingsFind = models.ratingModel.find;
    const historyFind = models.historyModel.find;
    const themesFind = models.themeModel.find;
    models.ratingModel.find = boom as never;
    models.historyModel.find = boom as never;
    models.themeModel.find = boom as never;
    try {
      const pub = await http.get('/users/maintained').expect(200);
      expect(pub.body.stats).toEqual(EXPECTED_STATS);
      const me = await http
        .get('/auth/me')
        .set({ Authorization: `Bearer ${tokenFor(MAINTAINED)}` })
        .expect(200);
      expect(me.body.stats).toEqual(EXPECTED_STATS);
    } finally {
      models.ratingModel.find = ratingsFind;
      models.historyModel.find = historyFind;
      models.themeModel.find = themesFind;
    }
  });
});
