import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

/**
 * Boots the real AppModule with NO MONGODB_URI in the environment (the test
 * environment never sets one): the app must come up, /health must answer,
 * and the theme read path must answer 503 rather than crash.
 */
describe('Themes without a database (e2e)', () => {
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

  it('GET /home returns 503', () => {
    return request(app.getHttpServer())
      .get('/home')
      .expect(503)
      .expect((res) => {
        expect(res.body.statusCode).toBe(503);
      });
  });

  it('GET /themes/:slug returns 503', () => {
    return request(app.getHttpServer()).get('/themes/anything').expect(503);
  });

  it('GET /search returns 503', () => {
    return request(app.getHttpServer()).get('/search?q=test').expect(503);
  });

  it('GET /season returns 503', () => {
    return request(app.getHttpServer())
      .get('/season?season=SPRING&year=2026')
      .expect(503);
  });
});
