import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { User } from './../src/auth/user.schema';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots,
 * /health answers, and every auth endpoint that needs the database
 * answers 503 instead of crashing. (GET /auth/me without a token is
 * rejected by the guard with 401 — the guard needs no database.)
 */
describe('Auth without a database (e2e)', () => {
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
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'kaikansen-api' });
  });

  it('POST /auth/register returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ username: 'x', email: 'x@example.com', password: 'pw' })
      .expect(503);
  });

  it('POST /auth/login returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'x@example.com', password: 'pw' })
      .expect(503);
  });

  it('POST /auth/refresh returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'anything' })
      .expect(503);
  });

  it('GET /auth/me without a token returns 401', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });
});

/* ------------------------------------------------------------------ */

/** Chainable Mongoose-query stand-in over an in-memory user list. */
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
      } else if (filter.email) {
        found = users.find((u) => u.email === filter.email) ?? null;
      }
      return queryOf(found);
    },
    findById: (id: string) =>
      queryOf(users.find((u) => u._id === id) ?? null),
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
      users.push(doc);
      return doc;
    },
  };
}

/**
 * Suite 2 — the auth controller wired to a MOCKED user model, over
 * real HTTP: the full register → login → me → refresh-rotation flow,
 * plus the web-consistent error statuses.
 */
describe('Auth flow with a mocked model (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [AuthController],
      providers: [
        AuthService,
        AccessTokenGuard,
        { provide: getModelToken(User.name), useValue: makeFakeModel() },
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

  let accessToken = '';
  let refreshToken = '';

  it('registers (200) with tokens + profile and no passwordHash anywhere', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'httpuser',
        email: 'http@example.com',
        password: 'http-fake-password',
      })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({
      username: 'httpuser',
      email: 'http@example.com',
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects the duplicate registration with 409 User already exists', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'httpuser',
        email: 'http@example.com',
        password: 'http-fake-password',
      })
      .expect(409)
      .expect((res) => {
        expect(res.body.message).toBe('User already exists');
      });
  });

  it('logs in (200) and keeps the session pair', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'http@example.com', password: 'http-fake-password' })
      .expect(200);
    accessToken = res.body.accessToken as string;
    refreshToken = res.body.refreshToken as string;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
  });

  it('rejects a wrong password with 401 Invalid credentials', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'http@example.com', password: 'nope-fake' })
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid credentials');
      });
  });

  it('GET /auth/me with the access token returns the profile (200)', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({
      username: 'httpuser',
      email: 'http@example.com',
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('GET /auth/me without a token returns 401', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('GET /auth/me with the REFRESH token returns 401 (type separation)', () => {
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${refreshToken}`)
      .expect(401);
  });

  it('POST /auth/refresh rotates the pair (200, new refresh token)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it('POST /auth/refresh with a garbage token returns 401', () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-token' })
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid refresh token');
      });
  });
});
