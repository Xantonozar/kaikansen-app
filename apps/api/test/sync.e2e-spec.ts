import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { AnimeThemesClient } from './../src/sync/animethemes.client';
import { EnrichmentClient } from './../src/sync/enrichment.client';
import { EnrichmentService } from './../src/sync/enrichment.service';
import { SyncController } from './../src/sync/sync.controller';
import { SyncSecretGuard } from './../src/sync/sync-secret.guard';
import { SyncService, type SyncStatus } from './../src/sync/sync.service';
import { SyncTiming } from './../src/sync/sync.constants';

/**
 * Suite 1 — the real AppModule with NO SYNC_SECRET in the environment:
 * the internal sync endpoints are OFF (503 from the guard) even before
 * any database question arises, while /health keeps answering.
 */
describe('Sync endpoints without SYNC_SECRET (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.SYNC_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /internal/sync/themes returns 503', () => {
    return request(app.getHttpServer())
      .post('/internal/sync/themes')
      .send({})
      .expect(503);
  });

  it('POST /internal/sync/popular returns 503', () => {
    return request(app.getHttpServer())
      .post('/internal/sync/popular')
      .send({})
      .expect(503);
  });

  it('GET /internal/sync/status returns 503', () => {
    return request(app.getHttpServer())
      .get('/internal/sync/status')
      .expect(503);
  });

  it('GET /health still returns 200', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'kaikansen-api' });
  });
});

/* ------------------------------------------------------------------ */

/** Chainable Mongoose-query stand-in (same pattern as the unit specs). */
function queryOf(result: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: Record<string, any> = {};
  q.sort = jest.fn(() => q);
  q.skip = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

/** Minimal in-memory ThemeCache model: upserts + popular find/reset. */
function makeThemeModel() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs: Record<string, any>[] = [];
  let seq = 0;
  return {
    docs,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateOne: (filter: any, update: any, options?: any) => {
      const idx = docs.findIndex(
        (d) => d.animethemesId === filter.animethemesId,
      );
      let upsertedCount = 0;
      if (idx === -1 && options?.upsert) {
        docs.push({ _id: `t-${++seq}`, ...update.$set });
        upsertedCount = 1;
      } else if (idx >= 0) {
        Object.assign(docs[idx], update.$set);
      }
      return queryOf({ acknowledged: true, upsertedCount });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    find: (filter: any) => {
      if (filter.$text) return queryOf([]);
      if (filter.$or) {
        const rx = filter.$or[0].animeTitle.$regex as RegExp;
        return queryOf(
          docs.filter(
            (d) =>
              rx.test(d.animeTitle ?? '') ||
              rx.test(d.animeTitleEnglish ?? '') ||
              (d.animeTitleAlternative ?? []).some((t: string) => rx.test(t)),
          ),
        );
      }
      return queryOf(docs);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany: (_filter: any, update: any) => {
      for (const d of docs) Object.assign(d, update);
      return queryOf({ modifiedCount: docs.length });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByIdAndUpdate: (id: any, update: any) => {
      const doc = docs.find((d) => d._id === id);
      if (doc) Object.assign(doc, update);
      return queryOf(doc ?? null);
    },
  };
}

function makeUpsertModel() {
  return {
    calls: 0,
    updateOne: () => queryOf({ acknowledged: true, upsertedCount: 1 }),
  };
}

const SECRET = 'e2e-sync-secret';

/**
 * Suite 2 — the sync controller wired to mocked models + mocked
 * external clients, over real HTTP: the secret gate (401s), a full
 * themes job driven to completion through the status endpoint, and the
 * popular job's match-first abort (the fake catalogue is far below the
 * 100-match floor, so the job must fail WITHOUT touching flags).
 */
describe('Sync endpoints with secret + mocked world (e2e)', () => {
  let app: INestApplication;
  let themeModel: ReturnType<typeof makeThemeModel>;

  beforeAll(async () => {
    process.env.SYNC_SECRET = SECRET;
    themeModel = makeThemeModel();

    const timing = new SyncTiming();
    timing.atDelayMs = 0;
    timing.anilistDelayMs = 0;
    timing.kitsuDelayMs = 0;
    timing.pageRetryDelayMs = 0;

    const atAnime = {
      id: 42,
      slug: 'test_anime',
      name: 'Test Anime',
      season: 'fall',
      year: 2026,
      malId: 123,
      images: [],
      studios: [],
      series: [],
      animethemes: [
        {
          id: 101,
          type: 'OP',
          sequence: 1,
          song: { title: 'Song One', artists: [] },
          animethemeentries: [
            {
              id: 1,
              version: 1,
              videos: [{ resolution: 720, link: 'https://cdn/1.webm' }],
            },
          ],
        },
      ],
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [SyncController],
      providers: [
        SyncService,
        SyncSecretGuard,
        EnrichmentService,
        { provide: SyncTiming, useValue: timing },
        {
          provide: AnimeThemesClient,
          useValue: {
            fetchAnimePage: jest.fn(async (page: number) =>
              page === 1 ? { anime: [atAnime] } : { anime: [] },
            ),
          },
        },
        {
          provide: EnrichmentClient,
          useValue: {
            fetchAniListByMalId: jest.fn(async () => ({
              id: 777,
              idMal: 123,
              title: { romaji: 'Test Anime', english: 'Test Anime EN', native: 'テスト' },
              synonyms: [],
              season: 'FALL',
              seasonYear: 2026,
              genres: [],
              episodes: 12,
              status: 'RELEASING',
              averageScore: 80,
              coverImage: { large: 'l', medium: 'm' },
              bannerImage: 'b',
              studios: { nodes: [] },
            })),
            fetchAniListByTitle: jest.fn(async () => null),
            fetchKitsuByTitle: jest.fn(async () => null),
          },
        },
        { provide: getModelToken(ThemeCache.name), useValue: themeModel },
        { provide: getModelToken(AnimeCache.name), useValue: makeUpsertModel() },
        { provide: getModelToken(ArtistCache.name), useValue: makeUpsertModel() },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SYNC_SECRET;
  });

  async function pollStatus(): Promise<SyncStatus> {
    const res = await request(app.getHttpServer())
      .get('/internal/sync/status')
      .set('x-sync-secret', SECRET)
      .expect(200);
    return res.body as SyncStatus;
  }

  async function waitForJobEnd(): Promise<SyncStatus> {
    for (let i = 0; i < 100; i++) {
      const status = await pollStatus();
      if (status.state !== 'running') return status;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not finish in time');
  }

  it('rejects requests without the secret (401) and with a wrong one (401)', async () => {
    await request(app.getHttpServer())
      .get('/internal/sync/status')
      .expect(401);
    await request(app.getHttpServer())
      .get('/internal/sync/status')
      .set('x-sync-secret', 'nope')
      .expect(401);
    await request(app.getHttpServer())
      .post('/internal/sync/themes')
      .send({})
      .expect(401);
  });

  it('status starts idle with the documented shape', async () => {
    const status = await pollStatus();
    expect(status).toEqual({
      state: 'idle',
      kind: null,
      year: null,
      pagesProcessed: 0,
      themesProcessed: 0,
      themesInserted: 0,
      errors: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    });
  });

  it('runs a themes job to completion (202 → status completed, theme written)', async () => {
    const started = await request(app.getHttpServer())
      .post('/internal/sync/themes')
      .set('x-sync-secret', SECRET)
      .send({ year: 2026 })
      .expect(202);
    expect(started.body.state).toBe('running');
    expect(started.body.kind).toBe('themes');
    expect(started.body.year).toBe(2026);

    const status = await waitForJobEnd();
    expect(status.state).toBe('completed');
    expect(status.pagesProcessed).toBe(1);
    expect(status.themesProcessed).toBe(1);
    expect(status.themesInserted).toBe(1);
    expect(themeModel.docs).toHaveLength(1);
    expect(themeModel.docs[0].slug).toBe('test_anime-op1-101');
    expect(themeModel.docs[0].anilistId).toBe(777);
  });

  it('defaults the year to the current year when omitted', async () => {
    const started = await request(app.getHttpServer())
      .post('/internal/sync/themes')
      .set('x-sync-secret', SECRET)
      .send({})
      .expect(202);
    expect(started.body.year).toBe(new Date().getFullYear());
    await waitForJobEnd();
  });

  it('rejects a non-integer year with 400', async () => {
    await request(app.getHttpServer())
      .post('/internal/sync/themes')
      .set('x-sync-secret', SECRET)
      .send({ year: 'abc' })
      .expect(400);
  });

  it('popular job aborts below the match floor without touching flags', async () => {
    await request(app.getHttpServer())
      .post('/internal/sync/popular')
      .set('x-sync-secret', SECRET)
      .send({})
      .expect(202);

    const status = await waitForJobEnd();
    expect(status.state).toBe('failed');
    expect(status.kind).toBe('popular');
    expect(status.lastError).toContain('match floor');
    // The one synced theme was never flagged or reset.
    expect(themeModel.docs[0].isPopular).toBeUndefined();
  });
});
