import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuthController } from './../src/auth/auth.controller';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { MailerService } from './../src/auth/mailer.service';
import { User } from './../src/auth/user.schema';

/**
 * Password reset (e2e) — a new capability (the web has none).
 *
 * Suite 1: the real AppModule with NO MONGODB_URI — the reset
 * endpoints answer 503 like every other auth endpoint.
 * Suite 2: the auth controller over a mocked user model + a fake
 * mailer (no real email): the full forgot → reset flow over HTTP.
 */

describe('Password reset without a database (e2e)', () => {
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

  it('POST /auth/forgot-password returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'x@example.com' })
      .expect(503);
  });

  it('POST /auth/reset-password returns 503', () => {
    return request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email: 'x@example.com', code: '123456', newPassword: 'pw' })
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
        $unset?: Record<string, unknown>;
      },
    ) => {
      const doc = users.find((u) => u._id === id) ?? null;
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset)) {
            delete doc[key];
          }
        }
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

function makeFakeMailer() {
  const sent: { email: string; code: string }[] = [];
  return {
    sent,
    sendPasswordResetCode: async (
      email: string,
      code: string,
    ): Promise<boolean> => {
      sent.push({ email, code });
      return true;
    },
  };
}

describe('Password reset flow with a mocked model (e2e)', () => {
  // Real bcrypt cost-12 hashing runs through this whole flow (see
  // the unit spec's note) — allow for it under load.
  jest.setTimeout(30_000);

  let app: INestApplication;
  const model = makeFakeModel();
  const mailer = makeFakeMailer();

  const EMAIL = 'forgetful@example.com';
  const OLD_PASSWORD = 'old-password-fake';
  const NEW_PASSWORD = 'new-password-fake';
  let preResetRefreshToken = '';

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-password-reset-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-password-reset-refresh-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [AuthController],
      providers: [
        AuthService,
        AccessTokenGuard,
        { provide: getModelToken(User.name), useValue: model },
        { provide: MailerService, useValue: mailer },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username: 'forgetful', email: EMAIL, password: OLD_PASSWORD })
      .expect(200);
    preResetRefreshToken = registered.body.refreshToken as string;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('forgot-password for an unknown email: generic 200, nothing sent', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'ghost@example.com' })
      .expect(200)
      .expect({ ok: true });
    expect(mailer.sent).toHaveLength(0);
  });

  it('forgot-password for an AniList-only account: generic 200, nothing sent', async () => {
    await model.create({
      username: 'anilistonly',
      displayName: 'AniList Only',
      email: 'anilist_777@kaikansen.io',
      passwordHash: 'OAUTH_USER_NO_PASSWORD',
    });
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'anilist_777@kaikansen.io' })
      .expect(200)
      .expect({ ok: true });
    expect(mailer.sent).toHaveLength(0);
  });

  it('forgot-password for a real account: generic 200, one code emailed', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: EMAIL })
      .expect(200)
      .expect({ ok: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].email).toBe(EMAIL);
    expect(mailer.sent[0].code).toMatch(/^\d{6}$/);
  });

  it('reset-password with a wrong code: generic 400', async () => {
    const issued = mailer.sent[0].code;
    const wrong = issued === '000000' ? '000001' : '000000';
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email: EMAIL, code: wrong, newPassword: NEW_PASSWORD })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid or expired reset code');
      });
  });

  it('reset-password with the emailed code: 200, password changed', async () => {
    const code = mailer.sent[0].code;
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email: EMAIL, code, newPassword: NEW_PASSWORD })
      .expect(200)
      .expect({ reset: true });
  });

  it('the pre-reset refresh token is revoked (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: preResetRefreshToken })
      .expect(401);
  });

  it('old password no longer logs in; the new one does', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: EMAIL, password: NEW_PASSWORD })
      .expect(200);
  });

  it('an expired code is rejected with the generic 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: EMAIL })
      .expect(200);
    const code = mailer.sent[mailer.sent.length - 1].code;
    const doc = model.users.find((u) => u.email === EMAIL) as FakeUser;
    const pending = doc.passwordReset as { expiresAt: Date };
    doc.passwordReset = { ...pending, expiresAt: new Date(Date.now() - 1000) };
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email: EMAIL, code, newPassword: 'another-fake' })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid or expired reset code');
      });
  });

  it('five wrong codes burn the code — even the right one then fails', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: EMAIL })
      .expect(200);
    const code = mailer.sent[mailer.sent.length - 1].code;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ email: EMAIL, code: wrong, newPassword: 'another-fake' })
        .expect(400);
    }
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email: EMAIL, code, newPassword: 'another-fake' })
      .expect(400);
  });
});
