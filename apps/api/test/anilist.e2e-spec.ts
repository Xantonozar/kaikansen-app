import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { User } from './../src/auth/user.schema';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the AniList
 * endpoints answer 503 like the rest of auth (the link route's guard
 * still rejects tokenless calls with 401 first — it needs no DB).
 */
describe('AniList without a database (e2e)', () => {
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

  it('GET /health still returns 200', () => {
    return request(app.getHttpServer()).get('/health').expect(200);
  });

  it('GET /auth/anilist/url returns 503', () => {
    return request(app.getHttpServer()).get('/auth/anilist/url').expect(503);
  });

  it('POST /auth/anilist/callback returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/anilist/callback')
      .send({ code: 'any' })
      .expect(503);
  });

  it('GET /auth/anilist/callback returns 503 (no redirect)', () => {
    return request(app.getHttpServer())
      .get('/auth/anilist/callback?code=any')
      .expect(503);
  });

  it('POST /auth/anilist/link without a token returns 401', () => {
    return request(app.getHttpServer())
      .post('/auth/anilist/link')
      .send({ code: 'any' })
      .expect(401);
  });

  it('POST /auth/anilist/link with a token returns 503 (no DB)', () => {
    // No env is set in this suite, so AuthService uses its documented
    // dev fallback access secret (mirrors the web's fallbacks).
    const token = jwt.sign(
      {
        userId: 'ghost',
        username: 'ghost',
        email: 'ghost@example.com',
        tokenType: 'access',
      },
      'fallback-secret-change-me',
      { expiresIn: '15m' },
    );
    return request(app.getHttpServer())
      .post('/auth/anilist/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'any' })
      .expect(503);
  });
});

/* ------------------------------------------------------------------ */

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

interface FakeUser extends Record<string, unknown> {
  _id: string;
  email: string;
  username: string;
  anilist?: { userId?: number };
  save?: () => Promise<unknown>;
}

function makeFakeModel() {
  const users: FakeUser[] = [];
  let seq = 0;
  return {
    users,
    findOne: (filter: Record<string, unknown>) => {
      let found: FakeUser | null = null;
      if (filter.$or) {
        const clauses = filter.$or as Record<string, string>[];
        found =
          users.find((u) =>
            clauses.some(
              (c) => u.email === c.email || u.username === c.username,
            ),
          ) ?? null;
      } else if (filter['anilist.userId'] !== undefined) {
        found =
          users.find((u) => u.anilist?.userId === filter['anilist.userId']) ??
          null;
      } else if (filter.username) {
        found = users.find((u) => u.username === filter.username) ?? null;
      } else if (filter.email) {
        found = users.find((u) => u.email === filter.email) ?? null;
      }
      return queryOf(found);
    },
    findById: (id: string) =>
      queryOf(users.find((u) => u._id === id) ?? null),
    findByIdAndUpdate: (
      id: string,
      update: { $set: Record<string, unknown> },
    ) => {
      const doc = users.find((u) => u._id === id) ?? null;
      if (doc && update.$set) {
        Object.assign(doc, update.$set);
      }
      return queryOf(doc);
    },
    create: async (data: Record<string, unknown>) => {
      const doc: FakeUser = {
        _id: `http-user-${++seq}`,
        bio: '',
        avatarUrl: null,
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
        ...(data as FakeUser),
      };
      doc.save = async () => doc;
      users.push(doc);
      return doc;
    },
  };
}

const fakeAnilistClient = {
  exchangeCode: async (_config: unknown, code: string) =>
    code === 'bad-code'
      ? { error: 'invalid_grant', message: 'The authorization code is invalid' }
      : { accessToken: 'anilist-access-token-1' },
  fetchViewer: async () => ({
    id: 42,
    name: 'Test User!',
    avatar: { large: 'https://img.example/avatar-large.png' },
  }),
};

/**
 * Suite 2 — controller + mocked AniList client + mocked user model:
 * the full url → callback (create) → callback (login) → link →
 * link-conflict flow over real HTTP.
 */
describe('AniList flow with mocked client + model (e2e)', () => {
  let app: INestApplication;
  const model = makeFakeModel();

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
    process.env.ANILIST_CLIENT_ID = 'e2e-client-id';
    process.env.ANILIST_CLIENT_SECRET = 'e2e-client-secret';
    process.env.ANILIST_REDIRECT_URI = 'https://example.com/oauth/callback';
    process.env.ANILIST_POST_LOGIN_REDIRECT =
      'https://preview.example/auth/complete';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [AuthController],
      providers: [
        AuthService,
        AccessTokenGuard,
        { provide: AnilistClient, useValue: fakeAnilistClient },
        { provide: getModelToken(User.name), useValue: model },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    delete process.env.ANILIST_CLIENT_ID;
    delete process.env.ANILIST_CLIENT_SECRET;
    delete process.env.ANILIST_REDIRECT_URI;
    delete process.env.ANILIST_POST_LOGIN_REDIRECT;
  });

  let anilistUserToken = '';

  it('GET /auth/anilist/url returns the authorize URL (200)', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/url')
      .expect(200);
    expect(res.body.url).toContain(
      'https://anilist.co/api/v2/oauth/authorize?',
    );
    expect(res.body.url).toContain('client_id=e2e-client-id');
    expect(res.body.url).toContain('response_type=code');
  });

  it('POST /auth/anilist/callback creates the user (200, tokens + profile)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/anilist/callback')
      .send({ code: 'good-code' })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({
      username: 'testuser',
      email: 'anilist_42@kaikansen.io',
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('anilist-access-token-1');
    anilistUserToken = res.body.accessToken as string;
  });

  it('POST /auth/anilist/callback again logs the SAME user in (no duplicate)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/anilist/callback')
      .send({ code: 'good-code' })
      .expect(200);
    expect(model.users).toHaveLength(1);
    expect(res.body.user.email).toBe('anilist_42@kaikansen.io');
  });

  it('POST /auth/anilist/callback with a rejected code returns 502 + AniList’s message', () => {
    return request(app.getHttpServer())
      .post('/auth/anilist/callback')
      .send({ code: 'bad-code' })
      .expect(502)
      .expect((res) => {
        expect(res.body.message).toBe('The authorization code is invalid');
      });
  });

  it('POST /auth/anilist/link without a token returns 401', () => {
    return request(app.getHttpServer())
      .post('/auth/anilist/link')
      .send({ code: 'good-code' })
      .expect(401);
  });

  it('POST /auth/anilist/link re-links the caller’s own AniList (200)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/anilist/link')
      .set('Authorization', `Bearer ${anilistUserToken}`)
      .send({ code: 'good-code' })
      .expect(200);
    expect(res.body).toEqual({
      linked: true,
      anilist: { userId: 42, username: 'Test User!' },
    });
  });

  it('POST /auth/anilist/link from a DIFFERENT user returns 409', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'seconduser',
        email: 'second@example.com',
        password: 'fake-password-2',
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/anilist/link')
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({ code: 'good-code' })
      .expect(409)
      .expect((res) => {
        expect(res.body.message).toContain('already linked');
      });
  });

  it('GET /auth/anilist/callback 302s to the post-login destination with fragment tokens', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/callback?code=good-code')
      .expect(302);
    const location = res.headers.location as string;
    expect(location.startsWith('https://preview.example/auth/complete#')).toBe(
      true,
    );
    expect(location).toContain('accessToken=');
    expect(location).toContain('refreshToken=');
    expect(location).toContain(`userId=${model.users[0]._id}`);
    expect(location).not.toContain('error=');
    expect(model.users).toHaveLength(2); // still no duplicate AniList user
  });

  it('GET /auth/anilist/callback with a rejected code 302s with #error=exchange_failed', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/callback?code=bad-code')
      .expect(302);
    expect(res.headers.location).toBe(
      'https://preview.example/auth/complete#error=exchange_failed',
    );
  });

  it('GET /auth/anilist/callback without a code 302s with #error=auth_failed', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/callback')
      .expect(302);
    expect(res.headers.location).toBe(
      'https://preview.example/auth/complete#error=auth_failed',
    );
  });

  it('GET /auth/anilist/url?state=link forwards the state', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/url?state=link')
      .expect(200);
    expect(res.body.url).toContain('&state=link');
  });

  it('GET /auth/anilist/callback?state=link bounces the raw code — no login, no session fragment', async () => {
    const before = model.users.length;
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/callback?code=good-code&state=link')
      .expect(302);
    expect(res.headers.location).toBe(
      'https://preview.example/auth/complete#code=good-code&state=link',
    );
    expect(res.headers.location).not.toContain('accessToken');
    expect(model.users).toHaveLength(before);
  });

  it('GET /auth/anilist/callback?state=login runs the exchange (fragment tokens)', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/anilist/callback?code=good-code&state=login')
      .expect(302);
    expect(res.headers.location).toContain('#accessToken=');
    expect(res.headers.location).toContain('userId=');
  });
});
