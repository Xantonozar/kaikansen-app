import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerGuard } from '@nestjs/throttler';
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
      .expect({
        status: 'ok',
        service: 'kaikansen-api',
        db: 'not-configured',
      });
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

  it('PATCH /auth/me without a token returns 401', () => {
    return request(app.getHttpServer())
      .patch('/auth/me')
      .send({ displayName: 'Nope' })
      .expect(401);
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
    })
      // Hand-wired controller (no AuthModule): the controller's
      // ThrottlerGuard is stood down — throttling has its own
      // dedicated suite (auth-throttle.e2e-spec.ts).
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

  it('PATCH /auth/me edits the profile (200) and GET /auth/me reflects it', async () => {
    const http = request(app.getHttpServer());
    const edited = await http
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        displayName: 'Edited Name',
        bio: 'Edited bio',
        avatarUrl: 'https://example.com/me.png',
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      username: 'httpuser',
      displayName: 'Edited Name',
      bio: 'Edited bio',
      avatarUrl: 'https://example.com/me.png',
    });
    expect(JSON.stringify(edited.body)).not.toContain('passwordHash');

    const after = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body).toEqual(edited.body);
  });

  it('PATCH /auth/me with an invalid field returns the web’s 400 and changes nothing', async () => {
    const http = request(app.getHttpServer());
    const res = await http
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ displayName: 'Should Not Stick', bio: 'b'.repeat(201) })
      .expect(400);
    expect(res.body.message).toBe(
      'Too big: expected string to have <=200 characters',
    );

    const after = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.displayName).toBe('Edited Name');
  });

  it('PATCH /auth/me with avatarUrl null clears the avatar', async () => {
    const res = await request(app.getHttpServer())
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ avatarUrl: null })
      .expect(200);
    expect(res.body.avatarUrl).toBeNull();
    expect(res.body.displayName).toBe('Edited Name');
  });

  it('PATCH /auth/me stores a picked default-avatar (Cloudinary) URL verbatim', async () => {
    const http = request(app.getHttpServer());
    // One of the 10 hosted defaults the app's picker writes — a
    // plain https image URL on the shared avatarUrl field, so the
    // website renders it as an ordinary image.
    const picked =
      'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-03_ucq9cu.png';
    const res = await http
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ avatarUrl: picked })
      .expect(200);
    expect(res.body.avatarUrl).toBe(picked);
    expect(res.body.displayName).toBe('Edited Name');

    const after = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.avatarUrl).toBe(picked);
  });

  it('PATCH /auth/me toggles isPublic (the Edit Profile switch) and GET /auth/me reflects it', async () => {
    const http = request(app.getHttpServer());
    const off = await http
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isPublic: false })
      .expect(200);
    expect(off.body.isPublic).toBe(false);
    expect(off.body.displayName).toBe('Edited Name');

    const after = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.isPublic).toBe(false);

    const bad = await http
      .patch('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isPublic: 'yes' })
      .expect(400);
    expect(bad.body.message).toBe(
      'Invalid input: expected boolean, received string',
    );
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
