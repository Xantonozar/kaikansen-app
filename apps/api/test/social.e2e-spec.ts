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
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { Follow } from './../src/social/follow.schema';
import { Notification } from './../src/social/notification.schema';
import { SocialController } from './../src/social/social.controller';
import { SocialService } from './../src/social/social.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots,
 * public social reads answer 503 (model-less service), the guarded
 * writes reject tokenless requests with 401 first (the guard needs
 * no database) and answer 503 to a VALID token.
 */
describe('Social without a database (e2e)', () => {
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

  it('answers 503 on the public reads', async () => {
    const http = request(app.getHttpServer());
    await http.get('/users/alice').expect(503);
    await http.get('/users/alice/network').expect(503);
    await http.get('/users/alice/follow').expect(503);
    await http.get('/social/friends-activity').expect(503);
    await http.get('/social/users/search?q=ali').expect(503);
  });

  it('rejects tokenless guarded calls with 401, then 503s with a token', async () => {
    const http = request(app.getHttpServer());
    await http.post('/users/bob/follow').expect(401);
    await http.delete('/users/bob/follow').expect(401);
    await http.get('/notifications').expect(401);
    await http
      .post('/users/bob/follow')
      .set('Authorization', `Bearer ${validToken()}`)
      .expect(503);
    await http
      .get('/notifications')
      .set('Authorization', `Bearer ${validToken()}`)
      .expect(503);
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
    if ('$regex' in c) {
      const re = new RegExp(String(c.$regex), String(c.$options ?? ''));
      return re.test(String(docValue ?? ''));
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
    if (key === '$and') {
      return (condition as Record<string, unknown>[]).every((f) =>
        matches(doc, f),
      );
    }
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

const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390b2';
const CAROL = '507f1f77bcf86cd7994390c3';
const THEME_A = '507f1f77bcf86cd799439011';

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
      avatarUrl: 'https://example.com/alice.png',
      bio: 'Alice bio',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: true,
      anilist: { accessToken: 'anilist-secret-token', userId: 42, username: 'AliceAni' },
      createdAt: at(0),
      updatedAt: at(0),
    },
    {
      _id: BOB,
      username: 'bob',
      displayName: 'Bob B',
      email: 'bob@example.com',
      passwordHash: 'never-served',
      avatarUrl: null,
      bio: '',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: true,
      createdAt: at(0),
      updatedAt: at(0),
    },
    {
      _id: CAROL,
      username: 'carol',
      displayName: 'Carol C',
      email: 'carol@example.com',
      passwordHash: 'never-served',
      avatarUrl: null,
      bio: 'Carol bio',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      isPublic: false,
      createdAt: at(0),
      updatedAt: at(0),
    },
  ];
  const follows: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const ratings: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
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
      avgRating: 8.5,
      totalRatings: 10,
      totalWatches: 100,
      totalListens: 40,
      isPopular: false,
      popularRank: null,
    },
  ];
  let seq = 0;
  let clock = T0;

  const userModel = {
    docs: users,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(users.find((u) => matches(u, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(users.filter((u) => matches(u, filter)).length),
    findByIdAndUpdate: (
      id: unknown,
      update: { $inc?: Record<string, number> },
    ) => {
      const doc = users.find((u) => valueEquals(u._id, id));
      if (doc && update.$inc) {
        for (const [field, delta] of Object.entries(update.$inc)) {
          doc[field] = ((doc[field] as number) ?? 0) + delta;
        }
      }
      return queryOf(doc ?? null);
    },
  };

  const followModel = {
    docs: follows,
    find: (filter: Record<string, unknown>) =>
      chain(follows.filter((f) => matches(f, filter))),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(follows.find((f) => matches(f, filter)) ?? null),
    findOneAndDelete: (filter: Record<string, unknown>) => ({
      exec: async () => {
        const idx = follows.findIndex((f) => matches(f, filter));
        if (idx === -1) return null;
        return follows.splice(idx, 1)[0];
      },
    }),
    create: async (data: Record<string, unknown>) => {
      const dup = follows.some(
        (f) =>
          valueEquals(f.followerId, data.followerId) &&
          valueEquals(f.followeeId, data.followeeId),
      );
      if (dup) throw { code: 11000 };
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79944${String(2000 + ++seq)}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      follows.push(doc);
      return doc;
    },
  };

  const notificationModel = {
    docs: notifications,
    find: (filter: Record<string, unknown>) =>
      chain(notifications.filter((n) => matches(n, filter))),
    create: async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79944${String(3000 + ++seq)}`,
        entityId: null,
        entityMeta: null,
        read: false,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      notifications.push(doc);
      return doc;
    },
    updateMany: (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => ({
      exec: async () => {
        let modifiedCount = 0;
        for (const doc of notifications) {
          if (matches(doc, filter)) {
            Object.assign(doc, update.$set);
            modifiedCount++;
          }
        }
        return { modifiedCount };
      },
    }),
  };

  const ratingModel = {
    docs: ratings,
    find: (filter: Record<string, unknown>) =>
      chain(ratings.filter((r) => matches(r, filter))),
  };

  const historyModel = {
    docs: history,
    find: (filter: Record<string, unknown>) =>
      chain(history.filter((h) => matches(h, filter))),
  };

  const themeModel = {
    docs: themes,
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => matches(t, filter))),
  };

  return {
    userModel,
    followModel,
    notificationModel,
    ratingModel,
    historyModel,
    themeModel,
  };
}

const E2E_SECRET = 'social-e2e-access-secret';
const E2E_REFRESH_SECRET = 'social-e2e-refresh-secret';

/**
 * Suite 2 — the social controller wired to mocked models, over
 * real HTTP: the full follow → counters → notification →
 * mark-read → unfollow cycle, the privacy-gated profile activity,
 * the friends feed, and user search.
 */
describe('Social flow with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

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
  const asAlice = () => ({ Authorization: `Bearer ${tokenFor(ALICE)}` });
  const asBob = () => ({ Authorization: `Bearer ${tokenFor(BOB)}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [SocialController],
      providers: [
        SocialService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(Follow.name), useValue: models.followModel },
        {
          provide: getModelToken(Notification.name),
          useValue: models.notificationModel,
        },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
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

  it('serves profiles in the web projection — no private fields', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/users/alice').expect(200);
    expect(res.body).toEqual({
      id: ALICE,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
      bio: 'Alice bio',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      createdAt: at(0).toISOString(),
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('anilist-secret-token');

    await http.get('/users/ALICE').expect(200);
    const missing = await http.get('/users/nobody').expect(404);
    expect(missing.body.message).toBe('User not found');

    const stats = await http.get('/users/bob/stats').expect(200);
    expect(stats.body).toEqual({
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      totalRatings: 0,
    });

    const network = await http.get('/users/bob/network').expect(200);
    expect(network.body).toEqual({ followers: [], following: [] });
  });

  it('runs the follow cycle: counters, notification, idempotency, unfollow', async () => {
    const http = request(app.getHttpServer());

    await http.post('/users/bob/follow').expect(401);
    await http
      .post('/users/bob/follow')
      .set('Authorization', `Bearer ${tokenFor(ALICE, 'refresh')}`)
      .expect(401);

    const self = await http
      .post('/users/alice/follow')
      .set(asAlice())
      .expect(400);
    expect(self.body.message).toBe('Cannot follow yourself');
    await http.post('/users/nobody/follow').set(asAlice()).expect(404);

    const followed = await http
      .post('/users/bob/follow')
      .set(asAlice())
      .expect(200);
    expect(followed.body).toEqual({ username: 'bob', isFollowing: true });

    // Counters moved on the stored docs (visible through the API).
    const bob = await http.get('/users/bob').expect(200);
    expect(bob.body.totalFollowers).toBe(1);
    const alice = await http.get('/users/alice').expect(200);
    expect(alice.body.totalFollowing).toBe(1);

    // Network list shows the follower, populated.
    const network = await http.get('/users/bob/network').expect(200);
    expect(network.body.followers).toEqual([
      {
        id: ALICE,
        username: 'alice',
        displayName: 'Alice A',
        avatarUrl: 'https://example.com/alice.png',
        bio: 'Alice bio',
      },
    ]);

    // Follow state: signed-in true, anonymous false (and no 404 games).
    const state = await http
      .get('/users/bob/follow')
      .set(asAlice())
      .expect(200);
    expect(state.body).toEqual({ username: 'bob', isFollowing: true });
    const anon = await http.get('/users/bob/follow').expect(200);
    expect(anon.body).toEqual({ username: 'bob', isFollowing: false });
    const anonMissing = await http.get('/users/nobody/follow').expect(200);
    expect(anonMissing.body.isFollowing).toBe(false);
    await http.get('/users/nobody/follow').set(asAlice()).expect(404);

    // Duplicate follow: nothing moves twice.
    await http.post('/users/bob/follow').set(asAlice()).expect(200);
    const bobAfter = await http.get('/users/bob').expect(200);
    expect(bobAfter.body.totalFollowers).toBe(1);

    // Bob received exactly one follow notification; mark it read.
    const inbox = await http.get('/notifications').set(asBob()).expect(200);
    expect(inbox.body.notifications).toHaveLength(1);
    expect(inbox.body.notifications[0]).toMatchObject({
      type: 'follow',
      read: false,
      actor: { username: 'alice' },
    });
    const notifId = inbox.body.notifications[0].id;
    await http
      .post('/notifications/mark-read')
      .set(asBob())
      .send({ notificationIds: [notifId] })
      .expect(200);
    const inbox2 = await http.get('/notifications').set(asBob()).expect(200);
    expect(inbox2.body.notifications[0].read).toBe(true);

    // Unfollow: counters back down; the notification survives.
    const un = await http
      .delete('/users/bob/follow')
      .set(asAlice())
      .expect(200);
    expect(un.body).toEqual({ username: 'bob', isFollowing: false });
    const bobFinal = await http.get('/users/bob').expect(200);
    expect(bobFinal.body.totalFollowers).toBe(0);
    const inbox3 = await http.get('/notifications').set(asBob()).expect(200);
    expect(inbox3.body.notifications).toHaveLength(1);

    // Unfollow again: still a success no-op.
    await http.delete('/users/bob/follow').set(asAlice()).expect(200);
    const bobNoop = await http.get('/users/bob').expect(200);
    expect(bobNoop.body.totalFollowers).toBe(0);
  });

  it('gates profile activity and composes the friends feed', async () => {
    const http = request(app.getHttpServer());
    // Seed Bob activity + Alice → Bob follow directly into the fakes.
    models.historyModel.docs.push({
      _id: '507f1f77bcf86cd799439501',
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(500),
    });
    models.ratingModel.docs.push({
      _id: '507f1f77bcf86cd799439502',
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      score: 9,
      mode: 'watch',
      createdAt: at(400),
    });
    await http.post('/users/bob/follow').set(asAlice()).expect(200);

    // Bob's own activity: visible to Bob…
    const own = await http
      .get('/users/bob/activity')
      .set(asBob())
      .expect(200);
    expect(own.body.activity.map((a: { activityType: string }) => a.activityType)).toEqual(['watch', 'rating']);
    // …hidden from Alice (Bob does not follow her)…
    const hidden = await http
      .get('/users/bob/activity')
      .set(asAlice())
      .expect(200);
    expect(hidden.body).toEqual({ activity: [] });
    // …and from anonymous callers.
    const anonAct = await http.get('/users/bob/activity').expect(200);
    expect(anonAct.body).toEqual({ activity: [] });

    // Alice's feed: Bob's watch + rating, newest first.
    const feed = await http
      .get('/social/friends-activity')
      .set(asAlice())
      .expect(200);
    expect(feed.body.isGlobal).toBe(false);
    expect(
      feed.body.activities.map((a: { type: string }) => a.type),
    ).toEqual(['listening', 'liked']);
    expect(feed.body.activities[0].item).toEqual({
      title: 'Song A',
      slug: 'anime_a-op1-1',
    });
    const anonFeed = await http.get('/social/friends-activity').expect(200);
    expect(anonFeed.body).toEqual({ activities: [], isGlobal: false });
  });

  it('searches users with the web rules', async () => {
    const http = request(app.getHttpServer());
    const found = await http
      .get('/social/users/search?q=ali')
      .expect(200);
    expect(found.body.users.map((u: { username: string }) => u.username)).toEqual(['alice']);
    expect(found.body.total).toBe(1);

    const short = await http.get('/social/users/search?q=a').expect(400);
    expect(short.body.message).toBe(
      'Query too short — minimum 2 characters',
    );

    // Private accounts are not discoverable.
    const priv = await http
      .get('/social/users/search?q=carol')
      .expect(200);
    expect(priv.body.users).toEqual([]);
    expect(priv.body.total).toBe(0);
  });
});
