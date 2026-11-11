import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

/**
 * GET /app/version (release readiness, 2026-11-11) — the update
 * prompt's source of truth. No auth, no database: the payload is
 * public release metadata served from env config, so a model-less
 * boot answers with the defaults.
 */
describe('App version (e2e)', () => {
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

  it('GET /app/version returns the default release payload', () => {
    return request(app.getHttpServer())
      .get('/app/version')
      .expect(200)
      .expect({
        latestVersion: '1.0.2',
        latestVersionCode: 4,
        apkUrl:
          'https://github.com/Xantonozar/kaikansen-app/releases/download/apk-latest/kaikansen.apk',
        notes: [],
        minSupportedVersionCode: 1,
      });
  });
});
