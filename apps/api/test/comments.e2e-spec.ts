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
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { Comment } from './../src/comments/comment.schema';
import { CommentsController } from './../src/comments/comments.controller';
import { CommentsService } from './../src/comments/comments.service';
import { Follow } from './../src/social/follow.schema';
import { Notification } from './../src/social/notification.schema';
import { FollowerActivityService } from './../src/social/follower-activity.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots,
 * the guarded post route rejects tokenless requests with 401 (the
 * guard needs no database) and answers 503 to a VALID token (the
 * service has no models). The list read is public — mirroring the
 * web it has no guard — so tokenless it goes straight to the
 * model-less service and answers 503 as well. The token is signed
 * with the API's documented dev fallback secret; the suite clears
 * JWT_* env first so no sibling suite's secrets leak in.
 */
describe('Comments without a database (e2e)', () => {
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

  it('rejects a tokenless post with 401', async () => {
    await request(app.getHttpServer())
      .post('/themes/anime_a-op1-1/comments')
      .send({ content: 'hi' })
      .expect(401);
  });

  it('answers 503 to a valid token when no database is configured', async () => {
    await request(app.getHttpServer())
      .post('/themes/anime_a-op1-1/comments')
      .set('Authorization', `Bearer ${validToken()}`)
      .send({ content: 'hi' })
      .expect(503);
  });

  it('serves the public list tokenless — and it 503s without a database', async () => {
    await request(app.getHttpServer())
      .get('/themes/anime_a-op1-1/comments')
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

const THEME_A = '507f1f77bcf86cd799439011';
const USER_1 = '507f1f77bcf86cd7994390a1';
const USER_2 = '507f1f77bcf86cd7994390b2';

function makeFakeModels() {
  const themes: Record<string, unknown>[] = [
    { _id: THEME_A, slug: 'anime_a-op1-1', songTitle: 'Song A' },
  ];
  const users: Record<string, unknown>[] = [
    {
      _id: USER_1,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
    },
    {
      _id: USER_2,
      username: 'bob',
      displayName: 'Bob B',
      avatarUrl: null,
    },
  ];
  const comments: Record<string, unknown>[] = [];
  // Bob follows Alice — the seed Suite 3's notification fan-out
  // resolves recipients from (Suite 2's service is built without a
  // notifier, so the rows sit unused there).
  const follows: Record<string, unknown>[] = [
    { followerId: USER_2, followeeId: USER_1 },
  ];
  const notifications: Record<string, unknown>[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

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

  const commentModel = {
    docs: comments,
    find: (filter: Record<string, unknown>) =>
      chain(comments.filter((c) => c.themeSlug === filter.themeSlug)),
    countDocuments: (filter: Record<string, unknown>) => ({
      exec: async () =>
        comments.filter((c) => c.themeSlug === filter.themeSlug).length,
    }),
    create: async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79944${String(1000 + ++seq)}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      comments.push(doc);
      return doc;
    },
  };

  const themeModel = {
    docs: themes,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
  };

  const userModel = {
    docs: users,
    find: (filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(
        users.filter((u) => inList.some((id) => String(id) === String(u._id))),
      );
    },
  };

  return {
    commentModel,
    themeModel,
    userModel,
    followModel,
    notificationModel,
  };
}

const E2E_SECRET = ['e2e', 'comments', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'comments', 'refresh', 'secret'].join('-');

/**
 * Suite 2 — the comments controller wired to mocked models, over
 * real HTTP: the post → list flow with authors resolved, the web's
 * validation messages, and the API's theme-existence 404s.
 *
 * Tokens are signed for the fake users' ids, so authorship flows
 * from the token exactly as in production.
 */
describe('Comments flow with mocked models (e2e)', () => {
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
  const asUser1 = () => ({ Authorization: `Bearer ${tokenFor(USER_1)}` });
  const asUser2 = () => ({ Authorization: `Bearer ${tokenFor(USER_2)}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [CommentsController],
      providers: [
        CommentsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        {
          provide: getModelToken(Comment.name),
          useValue: models.commentModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        { provide: getModelToken(User.name), useValue: models.userModel },
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
      .post('/themes/anime_a-op1-1/comments')
      .set('Authorization', `Bearer ${tokenFor(USER_1, 'refresh')}`)
      .send({ content: 'hi' })
      .expect(401);
  });

  it('starts empty and 404s unknown themes on list and post', async () => {
    const http = request(app.getHttpServer());

    const empty = await http.get('/themes/anime_a-op1-1/comments').expect(200);
    expect(empty.body).toEqual({
      comments: [],
      page: 1,
      limit: 50,
      total: 0,
      hasMore: false,
    });

    const list404 = await http.get('/themes/nope/comments').expect(404);
    expect(list404.body.message).toBe('Theme not found: nope');

    const post404 = await http
      .post('/themes/nope/comments')
      .set(asUser1())
      .send({ content: 'hi' })
      .expect(404);
    expect(post404.body.message).toBe('Theme not found: nope');
  });

  it('posts comments and lists them newest first with authors resolved', async () => {
    const http = request(app.getHttpServer());

    const first = await http
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({ content: '  First!  ' })
      .expect(200);
    expect(first.body).toMatchObject({
      content: 'First!', // stored + served trimmed, like the web
      themeSlug: 'anime_a-op1-1',
      author: {
        id: USER_1,
        username: 'alice',
        displayName: 'Alice A',
        avatarUrl: 'https://example.com/alice.png',
      },
    });

    const second = await http
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser2())
      .send({ content: 'Second' })
      .expect(200);
    expect(second.body.author.username).toBe('bob');

    // The stored row carries the web's linkage fields.
    const stored = models.commentModel.docs.find(
      (c) => c._id === first.body.id,
    );
    expect(stored).toMatchObject({
      userId: USER_1,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      content: 'First!',
    });

    const list = await http.get('/themes/anime_a-op1-1/comments').expect(200);
    expect(list.body.comments.map((c: { content: string }) => c.content)).toEqual(
      ['Second', 'First!'],
    );
    expect(list.body.comments[0].author.username).toBe('bob');
    expect(list.body.comments[1].author.username).toBe('alice');
    expect(list.body).toMatchObject({
      page: 1,
      limit: 50,
      total: 2,
      hasMore: false,
    });

    // Paging over the wire (fix batch 2026-11-11): limit=1 walks
    // the same order one at a time, hasMore honest.
    const page1 = await http
      .get('/themes/anime_a-op1-1/comments?limit=1')
      .expect(200);
    expect(page1.body.comments.map((c: { content: string }) => c.content)).toEqual(['Second']);
    expect(page1.body).toMatchObject({ page: 1, limit: 1, total: 2, hasMore: true });
    const page2 = await http
      .get('/themes/anime_a-op1-1/comments?page=2&limit=1')
      .expect(200);
    expect(page2.body.comments.map((c: { content: string }) => c.content)).toEqual(['First!']);
    expect(page2.body).toMatchObject({ page: 2, limit: 1, total: 2, hasMore: false });
  });

  it('rejects blank and over-long content with the web’s 400 messages', async () => {
    const http = request(app.getHttpServer());

    const blank = await http
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({ content: '   ' })
      .expect(400);
    expect(blank.body.message).toBe('Comment content is required');

    const missing = await http
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({})
      .expect(400);
    expect(missing.body.message).toBe('Comment content is required');

    const long = await http
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({ content: 'x'.repeat(1001) })
      .expect(400);
    expect(long.body.message).toBe('Comment is too long (max 1000 chars)');

    // Nothing was written by the rejected posts.
    expect(models.commentModel.docs).toHaveLength(2);
  });
});

/**
 * Suite 3 — the follower-activity fan-out over real HTTP: the same
 * controller/service composition as Suite 2, PLUS the
 * FollowerActivityService wired to fake Follow/Notification
 * models. Bob (USER_2) follows Alice (USER_1) in the seed, so
 * Alice's comments must land in Bob's notifications — and nobody
 * else's.
 */
describe('Comments follower notifications with mocked models (e2e)', () => {
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
  const asUser1 = () => ({ Authorization: `Bearer ${tokenFor(USER_1)}` });
  const asUser2 = () => ({ Authorization: `Bearer ${tokenFor(USER_2)}` });

  const commentRows = () =>
    models.notificationModel.docs.filter((n) => n.type === 'comment');

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [CommentsController],
      providers: [
        CommentsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        FollowerActivityService,
        {
          provide: getModelToken(Comment.name),
          useValue: models.commentModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        { provide: getModelToken(User.name), useValue: models.userModel },
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

  it('notifies the commenter’s followers, with the theme title in meta', async () => {
    const res = await request(app.getHttpServer())
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({ content: 'Great OP!' })
      .expect(200);
    expect(res.body.content).toBe('Great OP!');

    expect(commentRows()).toHaveLength(1);
    expect(commentRows()[0]).toMatchObject({
      recipientId: USER_2,
      actorId: USER_1,
      type: 'comment',
      entityId: THEME_A,
      read: false,
    });
    expect(commentRows()[0].entityMeta).toEqual({
      themeTitle: 'Song A',
    });
    // The actor is never their own recipient.
    expect(
      models.notificationModel.docs.some(
        (n) => n.recipientId === USER_1,
      ),
    ).toBe(false);
  });

  it('does not stack a second unread row for another comment on the same theme', async () => {
    await request(app.getHttpServer())
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser1())
      .send({ content: 'Second thought' })
      .expect(200);
    expect(commentRows()).toHaveLength(1);
  });

  it('writes nothing when the commenter has no followers', async () => {
    const before = models.notificationModel.docs.length;
    await request(app.getHttpServer())
      .post('/themes/anime_a-op1-1/comments')
      .set(asUser2())
      .send({ content: 'Bob here' })
      .expect(200);
    expect(models.notificationModel.docs).toHaveLength(before);
  });

  it('still posts the comment when the notification insert blows up', async () => {
    // Read the outstanding row first, so the fan-out is NOT
    // dedupe-skipped and actually reaches the failing insert.
    commentRows()[0].read = true;
    const original = models.notificationModel.insertMany;
    models.notificationModel.insertMany = jest.fn(
      async (_docs: Record<string, unknown>[]) => {
        throw new Error('db down');
      },
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/themes/anime_a-op1-1/comments')
        .set(asUser1())
        .send({ content: 'Posted anyway' })
        .expect(200);
      expect(res.body.content).toBe('Posted anyway');
    } finally {
      models.notificationModel.insertMany = original;
    }
    // The failed insert wrote nothing (and the comment stands).
    expect(commentRows()).toHaveLength(1);
    expect(models.commentModel.docs.map((c) => c.content)).toContain(
      'Posted anyway',
    );
  });
});
