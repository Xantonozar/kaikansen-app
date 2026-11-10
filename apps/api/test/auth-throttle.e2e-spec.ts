import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { AuthModule } from './../src/auth/auth.module';

/**
 * Auth rate limiting (audit C1) — the REAL AuthModule booted
 * model-less: every handler answers 503 (no database), so a 429
 * can only come from the ThrottlerGuard. Each scenario boots a
 * fresh app instance because the throttler's storage is in-memory
 * per instance — the buckets proven here cannot leak into other
 * suites.
 */
async function bootAuth(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule.register(false)],
  }).compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe('Auth throttling — login per-IP bucket (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuth();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 up to 20 logins a minute per IP, then 429', async () => {
    const http = request(app.getHttpServer());
    // A distinct email per attempt keeps the per-account bucket
    // out of the way — this scenario isolates the IP bucket.
    for (let i = 0; i < 20; i++) {
      await http
        .post('/auth/login')
        .send({ email: `ip-probe-${i}@example.com`, password: 'pw' })
        .expect(503);
    }
    await http
      .post('/auth/login')
      .send({ email: 'ip-probe-over@example.com', password: 'pw' })
      .expect(429);
  });
});

describe('Auth throttling — login per-account bucket (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuth();
  });

  afterAll(async () => {
    await app.close();
  });

  it('caps attempts against ONE account at 10 per 15 minutes', async () => {
    const http = request(app.getHttpServer());
    for (let i = 0; i < 10; i++) {
      await http
        .post('/auth/login')
        .send({ email: 'victim@example.com', password: 'pw' })
        .expect(503);
    }
    await http
      .post('/auth/login')
      .send({ email: 'victim@example.com', password: 'pw' })
      .expect(429);
    // A different account is NOT throttled (and the per-IP login
    // bucket, 20/min, is not yet spent) — the cap follows the
    // targeted email, not the caller.
    await http
      .post('/auth/login')
      .send({ email: 'someone-else@example.com', password: 'pw' })
      .expect(503);
  });
});

describe('Auth throttling — forgot-password issuance (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuth();
  });

  afterAll(async () => {
    await app.close();
  });

  it('caps code issuance at 5 per hour per email address', async () => {
    const http = request(app.getHttpServer());
    for (let i = 0; i < 5; i++) {
      await http
        .post('/auth/forgot-password')
        .send({ email: 'bombed@example.com' })
        .expect(503);
    }
    await http
      .post('/auth/forgot-password')
      .send({ email: 'bombed@example.com' })
      .expect(429);
    // Another address still issues (per-IP issuance cap is 10/h).
    await http
      .post('/auth/forgot-password')
      .send({ email: 'unrelated@example.com' })
      .expect(503);
  });
});
