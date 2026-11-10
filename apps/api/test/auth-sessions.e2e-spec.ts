import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { User } from './../src/auth/user.schema';

/**
 * Refresh-session tracking over real HTTP (audit S1): rotation
 * with reuse detection (a replayed, rotated-out token revokes
 * its whole family) and POST /auth/logout revoking the caller's
 * refresh tokens server-side. The user model is an in-memory
 * fake implementing the $set/$inc update surface the service
 * uses; bcrypt + JWT run for real against test secrets.
 */

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
      update: {
        $set?: Record<string, unknown>;
        $inc?: Record<string, number>;
        $unset?: Record<string, unknown>;
      },
    ) => {
      const doc = users.find((u) => u._id === id) ?? null;
      if (doc && update.$set) {
        Object.assign(doc, update.$set);
      }
      if (doc && update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) {
          doc[key] = (doc[key] as number) + delta;
        }
      }
      if (doc && update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete doc[key];
        }
      }
      return queryOf(doc);
    },
    create: async (data: Record<string, unknown>) => {
      const doc: FakeUser = {
        _id: `session-user-${++seq}`,
        bio: '',
        avatarUrl: null,
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
        tokenVersion: 0,
        ...(data as FakeUser),
      };
      users.push(doc);
      return doc;
    },
  };
}

describe('Refresh sessions + logout with a mocked model (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'session-e2e-access-secret';
    process.env.JWT_REFRESH_SECRET = 'session-e2e-refresh-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [AuthController],
      providers: [
        AuthService,
        AccessTokenGuard,
        { provide: getModelToken(User.name), useValue: makeFakeModel() },
      ],
    })
      // Hand-wired controller (no AuthModule): the throttler guard
      // is stood down — see auth-throttle.e2e-spec.ts.
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

  it('rotation works, then reuse of the retired token revokes the family', async () => {
    const http = request(app.getHttpServer());
    const registered = await http
      .post('/auth/register')
      .send({
        username: 'reusevictim',
        email: 'reuse@example.com',
        password: 'reuse-password',
      })
      .expect(200);
    const first = registered.body.refreshToken as string;

    const rotated = await http
      .post('/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const current = rotated.body.refreshToken as string;
    expect(current).not.toBe(first);

    // Replaying the retired token: rejected…
    await http.post('/auth/refresh').send({ refreshToken: first }).expect(401);
    // …and the family's live token is revoked with it.
    await http
      .post('/auth/refresh')
      .send({ refreshToken: current })
      .expect(401);
  });

  it('POST /auth/logout kills the refresh token server-side', async () => {
    const http = request(app.getHttpServer());
    const loggedIn = await http
      .post('/auth/login')
      .send({ email: 'reuse@example.com', password: 'reuse-password' })
      .expect(200);
    const access = loggedIn.body.accessToken as string;
    const refresh = loggedIn.body.refreshToken as string;

    // The fresh pair rotates fine before logout.
    const rotated = await http
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);

    await http
      .post('/auth/logout')
      .set({ Authorization: `Bearer ${access}` })
      .expect(200)
      .expect({ ok: true });

    // Both the pre-rotation and the rotated refresh tokens are dead.
    await http.post('/auth/refresh').send({ refreshToken: refresh }).expect(401);
    await http
      .post('/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });

  it('POST /auth/logout without a token is 401', async () => {
    await request(app.getHttpServer()).post('/auth/logout').expect(401);
  });
});
