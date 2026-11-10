import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { SearchIndexesController } from './../src/search-indexes/search-indexes.controller';
import { SearchIndexService } from './../src/themes/search-index.service';

/**
 * POST /internal/search-indexes/ensure over real HTTP (the
 * empty-$search trap fix, part 2): the SyncSecretGuard gate
 * (503 when SYNC_SECRET is unset, 401 for a missing/wrong
 * secret) and the ensure response shape with mocked catalogue
 * collections — created vs already-present, with post-pass state
 * reported honestly (a just-created index shows BUILDING, never
 * a faked READY).
 */

/**
 * Suite 1 — the real AppModule with NO SYNC_SECRET: the endpoint
 * is OFF (503 from the guard) while /health keeps answering.
 */
describe('Search-index ensure without SYNC_SECRET (e2e)', () => {
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

  it('POST /internal/search-indexes/ensure returns 503', () => {
    return request(app.getHttpServer())
      .post('/internal/search-indexes/ensure')
      .send({})
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

const SECRET = 'search-indexes-e2e-secret';

type RawDoc = Record<string, unknown>;

/**
 * A fake native collection: `state.existing` holds the index docs
 * Atlas would report; createSearchIndex records the call and adds
 * a BUILDING doc (creation is async on Atlas's side).
 */
function makeFakeModel(initial: RawDoc[]) {
  const state = { existing: [...initial], created: [] as string[] };
  const collection = {
    listSearchIndexes: () => ({
      toArray: async () => state.existing,
    }),
    createSearchIndex: async (spec: { name: string }) => {
      state.created.push(spec.name);
      state.existing = [
        ...state.existing,
        {
          name: spec.name,
          queryable: false,
          statusHistory: [{ status: 'BUILDING', date: new Date() }],
        },
      ];
      return spec.name;
    },
  };
  return { model: { collection }, state };
}

const readyDoc = (name: string): RawDoc => ({
  name,
  queryable: true,
  statusHistory: [{ status: 'READY', date: new Date() }],
});

describe('Search-index ensure with secret + mocked collections (e2e)', () => {
  let app: INestApplication;
  const themes = makeFakeModel([readyDoc('kaikansen_themes_search')]);
  const anime = makeFakeModel([]);
  const artists = makeFakeModel([]);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SearchIndexesController],
      providers: [
        SearchIndexService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'SYNC_SECRET' ? SECRET : undefined,
          },
        },
        { provide: getModelToken(ThemeCache.name), useValue: themes.model },
        { provide: getModelToken(AnimeCache.name), useValue: anime.model },
        { provide: getModelToken(ArtistCache.name), useValue: artists.model },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a missing or wrong sync secret with 401', async () => {
    const http = request(app.getHttpServer());
    await http.post('/internal/search-indexes/ensure').send({}).expect(401);
    await http
      .post('/internal/search-indexes/ensure')
      .set('x-sync-secret', 'wrong')
      .send({})
      .expect(401);
    expect(themes.state.created).toEqual([]);
    expect(anime.state.created).toEqual([]);
  });

  it('ensures all three indexes: existing reported, missing created as BUILDING', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/search-indexes/ensure')
      .set('x-sync-secret', SECRET)
      .send({})
      .expect(200);

    expect(res.body.indexes).toEqual([
      {
        name: 'kaikansen_themes_search',
        model: 'themes',
        collection: 'themecaches',
        exists: true,
        queryable: true,
        status: 'READY',
        ready: true,
        action: 'already-present',
      },
      {
        name: 'kaikansen_anime_search',
        model: 'anime',
        collection: 'animecaches',
        exists: true,
        queryable: false,
        status: 'BUILDING',
        ready: false,
        action: 'created',
      },
      {
        name: 'kaikansen_artists_search',
        model: 'artists',
        collection: 'artistcaches',
        exists: true,
        queryable: false,
        status: 'BUILDING',
        ready: false,
        action: 'created',
      },
    ]);
    expect(themes.state.created).toEqual([]);
    expect(anime.state.created).toEqual(['kaikansen_anime_search']);
    expect(artists.state.created).toEqual(['kaikansen_artists_search']);
  });

  it('a second ensure is idempotent — nothing is created again', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/search-indexes/ensure')
      .set('x-sync-secret', SECRET)
      .send({})
      .expect(200);

    expect(
      (res.body.indexes as Array<{ action: string }>).every(
        (row) => row.action === 'already-present',
      ),
    ).toBe(true);
    expect(anime.state.created).toEqual(['kaikansen_anime_search']);
    expect(artists.state.created).toEqual(['kaikansen_artists_search']);
  });
});
