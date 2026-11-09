import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { User } from './../src/auth/user.schema';
import { Playlist } from './../src/playlists/playlist.schema';
import { PlaylistsController } from './../src/playlists/playlists.controller';
import { PlaylistsService } from './../src/playlists/playlists.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the app boots,
 * the guarded playlist routes reject tokenless requests with 401
 * (the guard needs no database) and answer 503 to a VALID token
 * (the service has no models). The single-playlist read is public —
 * mirroring the web it has no guard — so tokenless it goes straight
 * to the model-less service and answers 503 as well. The token is
 * signed with the API's documented dev fallback secret; the suite
 * clears JWT_* env first so no sibling suite's secrets leak in.
 */
describe('Playlists without a database (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const validToken = () =>
    jwt.sign(
      {
        userId: 'ghost-user',
        username: 'ghost',
        email: 'ghost@example.com',
        tokenType: 'access',
      },
      'fallback-secret-change-me',
      { expiresIn: '15m' },
    );

  it('rejects tokenless writes with 401', async () => {
    const http = request(app.getHttpServer());
    await http.post('/playlists').send({ name: 'x' }).expect(401);
    await http.get('/playlists').expect(401);
    await http
      .patch('/playlists/507f1f77bcf86cd799439011')
      .send({ name: 'x' })
      .expect(401);
    await http.delete('/playlists/507f1f77bcf86cd799439011').expect(401);
    await http
      .post('/playlists/507f1f77bcf86cd799439011/items')
      .send({ slug: 'x' })
      .expect(401);
    await http
      .delete('/playlists/507f1f77bcf86cd799439011/items/x')
      .expect(401);
  });

  it('answers 503 to a valid token when no database is configured', async () => {
    const auth = { Authorization: `Bearer ${validToken()}` };
    const http = request(app.getHttpServer());
    await http.get('/playlists').set(auth).expect(503);
    await http.post('/playlists').set(auth).send({ name: 'x' }).expect(503);
    await http
      .post('/playlists/507f1f77bcf86cd799439011/items')
      .set(auth)
      .send({ slug: 'x' })
      .expect(503);
  });

  it('serves the public read tokenless — and it 503s without a database', async () => {
    await request(app.getHttpServer())
      .get('/playlists/507f1f77bcf86cd799439011')
      .expect(503);
  });
});

/* ------------------------------------------------------------------ */

/** Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = (spec: Record<string, number>) => {
    const keys = Object.entries(spec);
    result.sort((a, b) => {
      for (const [key, dir] of keys) {
        const av = a[key] as never;
        const bv = b[key] as never;
        if (av < bv) return -dir;
        if (av > bv) return dir;
      }
      return 0;
    });
    return q;
  };
  q.skip = (n: number) => {
    result = result.slice(n);
    return q;
  };
  q.limit = (n: number) => {
    result = result.slice(0, n);
    return q;
  };
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const SEEDED_PLAYLIST = '507f1f77bcf86cd7994390aa';

function makeTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: THEME_A,
    slug: 'anime_a-op1-1',
    animethemesId: 1,
    songTitle: 'Song A',
    animeTitle: 'Anime A',
    animeTitleEnglish: 'Anime A EN',
    artistName: 'Artist A',
    allArtists: ['Artist A'],
    artistSlugs: ['artist_a'],
    artistRoles: ['performer'],
    anilistId: 42,
    kitsuId: null,
    animeTitleAlternative: [],
    animeSeason: 'FALL',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/a.jpg',
    animeCoverImageSmall: 'https://example.com/a-small.jpg',
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 11, duration: 60 }],
    videoUrl: 'https://example.com/a.webm',
    audioUrl: null,
    mood: [],
    embedding: null,
    avgRating: 0,
    totalRatings: 0,
    totalWatches: 10,
    totalListens: 4,
    duration: 90,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: false,
    popularRank: null,
    featuredAt: null,
    ...overrides,
  };
}

function makeFakeModels() {
  const themes: Record<string, unknown>[] = [
    makeTheme(),
    makeTheme({
      _id: THEME_B,
      slug: 'anime_b-ed1-2',
      songTitle: 'Song B',
      animeTitle: 'Anime B',
      type: 'ED',
      animeCoverImage: 'https://example.com/b.jpg',
    }),
  ];
  const playlists: Record<string, unknown>[] = [
    {
      _id: SEEDED_PLAYLIST,
      userId: 'user-2',
      name: 'Secret Mix',
      description: 'not public, still readable by id — the web quirk',
      themes: [THEME_B, THEME_A],
      isPublic: false,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
  ];
  let seq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

  const byIdAndUser = (filter: Record<string, unknown>) =>
    playlists.find(
      (p) =>
        String(p._id) === String(filter._id) &&
        String(p.userId) === String(filter.userId),
    ) ?? null;

  const playlistModel = {
    docs: playlists,
    create: async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79943${String(1000 + ++seq)}`,
        createdAt: now,
        updatedAt: now,
        ...data,
        themes: [...((data.themes as unknown[]) ?? [])],
      };
      playlists.push(doc);
      return doc;
    },
    find: (filter: Record<string, unknown>) =>
      chain(
        playlists.filter((p) => String(p.userId) === String(filter.userId)),
      ),
    findOne: (filter: Record<string, unknown>) => queryOf(byIdAndUser(filter)),
    findById: (id: unknown) =>
      queryOf(playlists.find((p) => String(p._id) === String(id)) ?? null),
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const doc = byIdAndUser(filter);
      if (doc) {
        for (const [key, value] of Object.entries(update)) {
          if (key === '$set') {
            Object.assign(doc, value as Record<string, unknown>);
          } else if (key === '$push') {
            const pushes = value as Record<string, unknown>;
            for (const [field, v] of Object.entries(pushes)) {
              (doc[field] as unknown[]).push(v);
            }
          } else if (key === '$pull') {
            const pulls = value as Record<string, unknown>;
            for (const [field, v] of Object.entries(pulls)) {
              doc[field] = (doc[field] as unknown[]).filter(
                (x) => String(x) !== String(v),
              );
            }
          }
        }
        doc.updatedAt = new Date((clock += 1000));
      }
      return queryOf(doc);
    },
    deleteOne: (filter: Record<string, unknown>) => ({
      exec: async () => {
        const idx = playlists.findIndex(
          (p) =>
            String(p._id) === String(filter._id) &&
            String(p.userId) === String(filter.userId),
        );
        if (idx < 0) return { acknowledged: true, deletedCount: 0 };
        playlists.splice(idx, 1);
        return { acknowledged: true, deletedCount: 1 };
      },
    }),
  };

  const themeModel = {
    docs: themes,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
    find: (filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(
        themes.filter((t) => inList.some((id) => String(id) === String(t._id))),
      );
    },
  };

  const users: Record<string, unknown>[] = [
    { _id: 'user-1', username: 'userone', displayName: 'User One' },
    { _id: 'user-2', username: 'usertwo', displayName: 'User Two' },
  ];
  const userModel = {
    docs: users,
    findById: (id: unknown) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
  };

  return { playlistModel, themeModel, userModel };
}

const E2E_SECRET = ['e2e', 'playlists', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'playlists', 'refresh', 'secret'].join('-');

/**
 * Suite 2 — the playlists controller wired to mocked models, over
 * real HTTP: the full create → add → read → edit → remove → delete
 * flow, owner-only enforcement, the duplicate no-op, and the web's
 * public-read visibility quirk.
 */
describe('Playlists flow with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

  const tokenFor = (userId: string, tokenType = 'access') =>
    jwt.sign(
      {
        userId,
        username: userId,
        email: `${userId}@example.com`,
        tokenType,
      },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const asUser1 = () => ({ Authorization: `Bearer ${tokenFor('user-1')}` });
  const asUser2 = () => ({ Authorization: `Bearer ${tokenFor('user-2')}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [PlaylistsController],
      providers: [
        PlaylistsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        {
          provide: getModelToken(Playlist.name),
          useValue: models.playlistModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        {
          provide: getModelToken(User.name),
          useValue: models.userModel,
        },
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

  it('rejects a refresh-type token with 401 (type separation)', () => {
    return request(app.getHttpServer())
      .get('/playlists')
      .set('Authorization', `Bearer ${tokenFor('user-1', 'refresh')}`)
      .expect(401);
  });

  it('creates, lists and reads back a playlist with the web defaults', async () => {
    const http = request(app.getHttpServer());

    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Road Trip' })
      .expect(200);
    expect(created.body).toMatchObject({
      name: 'Road Trip',
      description: '',
      isPublic: true,
      themeCount: 0,
      items: [],
      userId: 'user-1',
      coverImage: null,
    });
    const id = created.body.id as string;

    const mine = await http.get('/playlists').set(asUser1()).expect(200);
    expect(mine.body.playlists.map((p: { id: string }) => p.id)).toEqual([id]);

    // Another user's list does not contain it (theirs has the seeded one).
    const theirs = await http.get('/playlists').set(asUser2()).expect(200);
    expect(
      theirs.body.playlists.map((p: { id: string }) => p.id),
    ).toEqual([SEEDED_PLAYLIST]);

    const read = await http.get(`/playlists/${id}`).expect(200);
    expect(read.body.name).toBe('Road Trip');
  });

  it("serves the owner's public identity on the detail (the design's by-line)", async () => {
    const http = request(app.getHttpServer());

    // The seeded playlist belongs to user-2 — the public read
    // carries THEIR display name + username, tokenless.
    const seeded = await http.get(`/playlists/${SEEDED_PLAYLIST}`).expect(200);
    expect(seeded.body.ownerDisplayName).toBe('User Two');
    expect(seeded.body.ownerUsername).toBe('usertwo');

    // And a fresh create answers with the creator's identity.
    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Signed' })
      .expect(200);
    expect(created.body.ownerDisplayName).toBe('User One');
    expect(created.body.ownerUsername).toBe('userone');
  });

  it('rejects a create without a name, with the web’s 400 message', async () => {
    const res = await request(app.getHttpServer())
      .post('/playlists')
      .set(asUser1())
      .send({ description: 'nameless' })
      .expect(400);
    expect(res.body.message).toBe('Name is required');
  });

  it('adds items by slug in order; a duplicate add is a success no-op', async () => {
    const http = request(app.getHttpServer());
    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Order Matters' })
      .expect(200);
    const id = created.body.id as string;

    await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'anime_b-ed1-2' })
      .expect(200);
    const two = await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'anime_a-op1-1' })
      .expect(200);
    expect(two.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      'anime_b-ed1-2',
      'anime_a-op1-1',
    ]);
    expect(two.body.themeCount).toBe(2);
    expect(two.body.coverImage).toBe('https://example.com/b.jpg');
    // Summary additions: mosaic covers in stored order + the
    // summed known durations (both seeds carry 90s).
    expect(two.body.coverImages).toEqual([
      'https://example.com/b.jpg',
      'https://example.com/a.jpg',
    ]);
    expect(two.body.totalDurationSeconds).toBe(180);
    expect(JSON.stringify(two.body)).not.toContain('embedding');

    const mine = await http.get('/playlists').set(asUser1()).expect(200);
    const listed = mine.body.playlists.find(
      (p: { id: string }) => p.id === id,
    );
    expect(listed.coverImages).toEqual([
      'https://example.com/b.jpg',
      'https://example.com/a.jpg',
    ]);
    expect(listed.totalDurationSeconds).toBe(180);

    const dup = await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'anime_b-ed1-2' })
      .expect(200);
    expect(dup.body.themeCount).toBe(2);
    const stored = models.playlistModel.docs.find((p) => p._id === id);
    expect(stored?.themes).toHaveLength(2);
  });

  it('answers 404 for an unknown theme slug on add and remove', async () => {
    const http = request(app.getHttpServer());
    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Validation' })
      .expect(200);
    const id = created.body.id as string;

    const add = await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'nope' })
      .expect(404);
    expect(add.body.message).toBe('Theme not found: nope');

    const remove = await http
      .delete(`/playlists/${id}/items/nope`)
      .set(asUser1())
      .expect(404);
    expect(remove.body.message).toBe('Theme not found: nope');
  });

  it('enforces owner-only writes with the web’s folded 404', async () => {
    const http = request(app.getHttpServer());
    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Mine Only' })
      .expect(200);
    const id = created.body.id as string;

    const attempts = [
      () =>
        http
          .patch(`/playlists/${id}`)
          .set(asUser2())
          .send({ name: 'Hijacked' })
          .expect(404),
      () =>
        http
          .post(`/playlists/${id}/items`)
          .set(asUser2())
          .send({ slug: 'anime_a-op1-1' })
          .expect(404),
      () =>
        http
          .delete(`/playlists/${id}/items/anime_a-op1-1`)
          .set(asUser2())
          .expect(404),
      () => http.delete(`/playlists/${id}`).set(asUser2()).expect(404),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.body.message).toBe('Playlist not found or access denied');
    }

    const read = await http.get(`/playlists/${id}`).expect(200);
    expect(read.body.name).toBe('Mine Only');
    expect(read.body.themeCount).toBe(0);
  });

  it('reads a PRIVATE playlist publicly by id, items in stored order (web quirk)', async () => {
    // No Authorization header at all — the web route is unauthenticated.
    const read = await request(app.getHttpServer())
      .get(`/playlists/${SEEDED_PLAYLIST}`)
      .expect(200);
    expect(read.body.name).toBe('Secret Mix');
    expect(read.body.isPublic).toBe(false);
    expect(read.body.userId).toBe('user-2');
    expect(read.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      'anime_b-ed1-2',
      'anime_a-op1-1',
    ]);

    const missing = await request(app.getHttpServer())
      .get('/playlists/507f1f77bcf86cd799439777')
      .expect(404);
    expect(missing.body.message).toBe('Playlist not found');

    const malformed = await request(app.getHttpServer())
      .get('/playlists/not-an-id')
      .expect(404);
    expect(malformed.body.message).toBe('Playlist not found');
  });

  it('edits metadata, removes an item and deletes the playlist (owner)', async () => {
    const http = request(app.getHttpServer());
    const created = await http
      .post('/playlists')
      .set(asUser1())
      .send({ name: 'Lifecycle', description: 'before' })
      .expect(200);
    const id = created.body.id as string;
    await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'anime_a-op1-1' })
      .expect(200);
    await http
      .post(`/playlists/${id}/items`)
      .set(asUser1())
      .send({ slug: 'anime_b-ed1-2' })
      .expect(200);

    const edited = await http
      .patch(`/playlists/${id}`)
      .set(asUser1())
      .send({ name: 'Lifecycle II', isPublic: false })
      .expect(200);
    expect(edited.body.name).toBe('Lifecycle II');
    expect(edited.body.description).toBe('before');
    expect(edited.body.isPublic).toBe(false);
    expect(edited.body.themeCount).toBe(2);

    const removed = await http
      .delete(`/playlists/${id}/items/anime_a-op1-1`)
      .set(asUser1())
      .expect(200);
    expect(removed.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      'anime_b-ed1-2',
    ]);
    expect(removed.body.themeCount).toBe(1);

    // Removing again is a no-op success (the web's filter semantics).
    const noop = await http
      .delete(`/playlists/${id}/items/anime_a-op1-1`)
      .set(asUser1())
      .expect(200);
    expect(noop.body.themeCount).toBe(1);

    const deleted = await http
      .delete(`/playlists/${id}`)
      .set(asUser1())
      .expect(200);
    expect(deleted.body).toEqual({ id, deleted: true });

    await http.get(`/playlists/${id}`).expect(404);
    const mine = await http.get('/playlists').set(asUser1()).expect(200);
    expect(
      mine.body.playlists.some((p: { id: string }) => p.id === id),
    ).toBe(false);
  });
});
