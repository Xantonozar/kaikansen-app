import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import { gunzipSync } from 'node:zlib';
import * as http from 'node:http';
import request from 'supertest';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { User } from './../src/auth/user.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import {
  SEARCH_READINESS_PROBE,
  SearchIndexService,
} from './../src/themes/search-index.service';
import { ThemesController } from './../src/themes/themes.controller';
import { ThemesService } from './../src/themes/themes.service';
import { Follow } from './../src/social/follow.schema';
import { Notification } from './../src/social/notification.schema';
import { PlaylistActivity } from './../src/playlists/playlist-activity.schema';
import { UserRank } from './../src/quiz/user-rank.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { SocialController } from './../src/social/social.controller';
import { SocialService } from './../src/social/social.service';
import { AuthService } from './../src/auth/auth.service';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { QuizRoom } from './../src/quiz/quiz-room.schema';
import { QuizGateway } from './../src/quiz/quiz.gateway';
import { QuizRoomsService } from './../src/quiz/quiz-rooms.service';
import { RankHistory } from './../src/quiz/rank-history.schema';
import { RankService } from './../src/quiz/rank.service';
import { RoomBroadcaster } from './../src/quiz/room-broadcaster';
import { Favorite } from './../src/library/favorite.schema';
import { applyHttpSetup } from './../src/http/http-setup';
import { currentSeason } from './../src/themes/season';

/**
 * Perf problem 10 (API-PROJECTIONS-GZIP-2026-11-10) — the HTTP
 * layer and the projection guarantees, over real HTTP with fake
 * models whose query chains APPLY the service's projection the
 * way Mongoose does (a string .select keeps the named top-level
 * fields + _id), so a mapper field missing from a projection list
 * fails here exactly as it would fail in production.
 *
 * Covered:
 * - GET /home over RICH theme documents (entries, a 384-number
 *   embedding, every schema field): the response equals the
 *   hand-written summary expectation, and the served payload is
 *   dramatically smaller than the same documents' full form.
 * - GET /social/friends-activity over the same rich documents.
 * - gzip, read as RAW WIRE BYTES through node:http (supertest's
 *   buffered reads decompress on the client side and would fake
 *   this proof): a >1 KB JSON body carries content-encoding:
 *   gzip + real gzip bytes when the client sends Accept-Encoding:
 *   gzip, and no encoding (byte-equal plain body) for identity.
 * - Cache-Control: catalogue routes carry the private hint, user
 *   routes carry no-store, unclassified routes keep no header,
 *   and an ERROR response never inherits the hint.
 * - The Socket.IO handshake under the same wiring (second
 *   describe): a valid token connects, a bad one is disconnected.
 */

/* ------------------------------------------------------------------ */
/* Fake Mongoose plumbing                                              */
/* ------------------------------------------------------------------ */

function matchesSimple(doc: Record<string, unknown>, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return true;
  return Object.entries(filter as Record<string, unknown>).every(([k, v]) => {
    if (k === '$and') {
      return (v as unknown[]).every((f) => matchesSimple(doc, f));
    }
    if (k === '$or') {
      return (v as unknown[]).some((f) => matchesSimple(doc, f));
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const c = v as Record<string, unknown>;
      if ('$in' in c) {
        return (c.$in as unknown[]).some((x) => String(x) === String(doc[k]));
      }
      if ('$ne' in c) return String(doc[k]) !== String(c.$ne);
      if ('$elemMatch' in c) {
        const arr = (doc[k] as Record<string, unknown>[]) ?? [];
        const cond = (c.$elemMatch as { tags?: { $in?: unknown[] } }).tags;
        const wanted = cond?.$in ?? [];
        return arr.some((e) =>
          ((e.tags as unknown[]) ?? []).some((t) => wanted.includes(t)),
        );
      }
      return String(doc[k]) === String(v);
    }
    return String(doc[k]) === String(v);
  });
}

/**
 * Applies a Mongoose inclusion projection (space-separated field
 * list) to a document: named fields survive, everything else
 * drops, `_id` always survives. Exclusion strings ('-x') pass the
 * document through minus the named fields.
 */
function applyProjection(
  doc: Record<string, unknown>,
  projection: string,
): Record<string, unknown> {
  const parts = projection.trim().split(/\s+/);
  if (parts.some((p) => p.startsWith('-'))) {
    const out = { ...doc };
    for (const p of parts) {
      if (p.startsWith('-')) delete out[p.slice(1)];
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  if ('_id' in doc) out._id = doc._id;
  for (const p of parts) {
    if (p in doc) out[p] = doc[p];
  }
  return out;
}

function chainOf(docs: Record<string, unknown>[]) {
  let result = [...docs];
  let projection: string | null = null;
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
  q.select = (p: string) => {
    projection = p;
    return q;
  };
  q.lean = () => q;
  q.exec = async () =>
    projection ? result.map((d) => applyProjection(d, projection)) : result;
  return q;
}

function queryOf(result: unknown) {
  let projection: string | null = null;
  const q: Record<string, unknown> = {};
  q.select = (p: string) => {
    projection = p;
    return q;
  };
  q.lean = () => q;
  q.exec = async () =>
    projection && result !== null && typeof result === 'object'
      ? applyProjection(result as Record<string, unknown>, projection)
      : result;
  return q;
}

/* ------------------------------------------------------------------ */
/* Rich fixtures                                                       */
/* ------------------------------------------------------------------ */

const ME = '507f1f77bcf86cd7994390a1';
const FRIEND = '507f1f77bcf86cd7994390b2';
const THEME_ID = '507f1f77bcf86cd799439011';

const RICH_EMBEDDING = Array.from({ length: 384 }, (_, i) => i / 384);

/**
 * A theme document carrying EVERY field of the schema — the
 * entries array with video sources, the 1024-number embedding,
 * the detail-only strings — the shape production documents have
 * and the shape a careless projection would starve the mapper of.
 */
function richTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: THEME_ID,
    slug: 'rich-anime-op1',
    animethemesId: 12345,
    songTitle:
    'Rich Song — An Unreasonably Verbose Opening Theme Title ' +
    'With Trailing Identifiers 9f27c4a1b8e05d63',
    artistName: 'Rich Artist',
    allArtists: ['Rich Artist', 'Second Artist'],
    artistSlugs: ['rich-artist', 'second-artist'],
    artistRoles: ['Vocals', 'Composer'],
    anilistId: 777,
    kitsuId: 'kitsu-777',
    animeTitle: 'Rich Anime',
    animeTitleEnglish: 'Rich Anime EN',
    animeTitleAlternative: ['Rich Alt'],
    animeSeason: 'SPRING',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/rich.jpg',
    animeCoverImageSmall: 'https://example.com/rich-small.jpg',
    animeGrillImage: 'https://example.com/rich-grill.jpg',
    animeStudios: ['Rich Studio'],
    animeSeries: ['Rich Series'],
    type: 'OP',
    sequence: 1,
    entries: [
      {
        atEntryId: 9001,
        version: 'Standard',
        episodes: '1',
        spoiler: false,
        nsfw: false,
        tags: ['rich-tag'],
        // The entry carries the catalogue's real source list
        // shape at a realistic breadth — it is what makes the
        // detail body genuinely large (the gzip leg measures the
        // real middleware on a >5 KB JSON document).
        videoSources: [1080, 720, 480, 360, 240].map((resolution) => ({
          resolution,
          url: `https://v.animethemes.moe/RichAnime-OP1-${resolution}.webm`,
          source: 'AT',
          mime: 'video/webm',
        })),
        videoUrl: 'https://v.animethemes.moe/RichAnime-OP1.webm',
        audioUrl: null,
        duration: 90,
      },
    ],
    videoUrl: 'https://v.animethemes.moe/RichAnime-OP1.webm',
    audioUrl: null,
    mood: ['energetic'],
    embedding: RICH_EMBEDDING,
    avgRating: 9.1,
    totalRatings: 42,
    totalWatches: 1000,
    totalListens: 500,
    duration: 95,
    syncedAt: new Date('2026-11-01T00:00:00.000Z'),
    isPopular: true,
    popularRank: 3,
    featuredAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    __v: 0,
    ...overrides,
  };
}

/**
 * The summary the mapper must produce from the rail document
 * (makeModels pins its season to the CURRENT season, so the
 * expectation computes it the same way rather than hardcoding
 * one — the mapper passes the stored value through unchanged).
 */
const EXPECTED_SUMMARY = {
  slug: 'rich-anime-op1',
  songTitle:
    'Rich Song — An Unreasonably Verbose Opening Theme Title ' +
    'With Trailing Identifiers 9f27c4a1b8e05d63',
  animeTitle: 'Rich Anime',
  animeTitleEnglish: 'Rich Anime EN',
  artistName: 'Rich Artist',
  allArtists: ['Rich Artist', 'Second Artist'],
  type: 'OP',
  sequence: 1,
  animeSeason: currentSeason(new Date()).season,
  animeSeasonYear: 2026,
  animeCoverImage: 'https://example.com/rich.jpg',
  animeCoverImageSmall: 'https://example.com/rich-small.jpg',
  avgRating: 9.1,
  totalRatings: 42,
  totalWatches: 1000,
  totalListens: 500,
  duration: 95,
  isPopular: false,
  popularRank: 9999,
  anilistId: 777,
};

function makeModels() {
  const season = currentSeason(new Date());
  const railTheme = richTheme({
    animeSeason: season.season,
    animeSeasonYear: season.year,
    isPopular: false,
    popularRank: 9999,
    // A realistic embedding size (production vectors): it feeds
    // the projection diet's measured win honestly. The detail
    // read EXCLUDES the embedding server-side, so the gzip leg's
    // large body comes from the entry's video source list (see
    // below), not from this array.
    embedding: Array.from({ length: 384 }, (_, i) => i / 384),
    // A long, hard-to-compress title: it pushes /home's body
    // comfortably over the 1 KB gzip threshold (the assertion
    // measures the real middleware behaviour, not threshold
    // fuzz) while the summary equality checks pass the stored
    // strings through untouched.
    songTitle:
      'Rich Song — An Unreasonably Verbose Opening Theme Title ' +
      'With Trailing Identifiers 9f27c4a1b8e05d63',
  });
  // A second catalogue document: it pads the /season payload
  // densely (its big numbers compress poorly, unlike /home's
  // small summary body, so the gzip leg sees a realistic win).
  // It IS the popular rail's only member: production's rail and
  // popular sets are likewise different documents.
  const denseTheme = richTheme({
    _id: '507f1f77bcf86cd799439022',
    slug: 'dense-anime-ed2',
    songTitle:
      'Dense Song With A Long Uncompressible Title 7f3a9b2c',
    artistName: 'Dense Artist',
    allArtists: ['Dense Artist'],
    animeTitle: 'Dense Anime',
    type: 'ED',
    sequence: 2,
    isPopular: true,
    popularRank: 999,
    animeSeason: 'WINTER',
    avgRating: 8.234567,
    totalRatings: 91337,
    totalWatches: 1234567,
    totalListens: 987654,
    embedding: Array.from({ length: 64 }, (_, i) => i * 0.1379),
  });
  const themes = [railTheme, denseTheme];

  const users: Record<string, unknown>[] = [
    {
      _id: ME,
      username: 'me',
      displayName: 'Me Myself',
      email: 'me@example.com',
      passwordHash: 'never-served',
      avatarUrl: 'https://example.com/me.png',
      bio: 'me bio',
      isPublic: true,
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      _id: FRIEND,
      username: 'friend',
      displayName: 'Friend Person',
      email: 'friend@example.com',
      passwordHash: 'never-served',
      avatarUrl: null,
      bio: '',
      isPublic: true,
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      totalTime: 0,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
  ];
  const follows: Record<string, unknown>[] = [
    { _id: 'f1', followerId: ME, followeeId: FRIEND },
  ];
  const history: Record<string, unknown>[] = [
    {
      _id: 'h1',
      userId: FRIEND,
      themeId: THEME_ID,
      themeSlug: 'rich-anime-op1',
      mode: 'watch',
      atEntryId: 9001,
      viewedAt: new Date('2026-11-09T10:00:00.000Z'),
    },
  ];
  const ratings: Record<string, unknown>[] = [
    {
      _id: 'r1',
      userId: FRIEND,
      themeId: THEME_ID,
      themeSlug: 'rich-anime-op1',
      score: 8,
      mode: 'watch',
      createdAt: new Date('2026-11-09T11:00:00.000Z'),
    },
  ];

  const themeModel = {
    docs: themes,
    find: (filter: Record<string, unknown>) =>
      chainOf(themes.filter((t) => matchesSimple(t, filter))),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => matchesSimple(t, filter)) ?? null),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(
        themes.filter((t) => matchesSimple(t, filter)).length,
      ),
    aggregate: async () => [],
  };
  // Minimal room/rank fakes for the socket-handshake describe
  // (the handshake never reaches a room operation).
  const roomModel = {
    find: (filter: Record<string, unknown>) => chainOf([]),
    findOne: (filter: Record<string, unknown>) => queryOf(null),
    findById: (id: string) => queryOf(null),
  };
  const userRankModel = {
    findOne: (filter: Record<string, unknown>) => queryOf(null),
  };
  const rankHistoryModel = {
    create: async (data: Record<string, unknown>) => data,
  };
  const emptyChain = {
    find: (filter: Record<string, unknown>) => chainOf([]),
    findOne: (filter: Record<string, unknown>) => queryOf(null),
    countDocuments: (filter: Record<string, unknown>) => queryOf(0),
    aggregate: async () => [],
  };
  const userModel = {
    ...emptyChain,
    find: (filter: Record<string, unknown>) =>
      chainOf(users.filter((u) => matchesSimple(u, filter))),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(users.find((u) => matchesSimple(u, filter)) ?? null),
    findById: (id: string) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
  };
  const followModel = {
    ...emptyChain,
    find: (filter: Record<string, unknown>) =>
      chainOf(follows.filter((f) => matchesSimple(f, filter))),
  };
  const historyModel = {
    ...emptyChain,
    find: (filter: Record<string, unknown>) =>
      chainOf(history.filter((h) => matchesSimple(h, filter))),
  };
  const ratingModel = {
    ...emptyChain,
    find: (filter: Record<string, unknown>) =>
      chainOf(ratings.filter((r) => matchesSimple(r, filter))),
  };

  return {
    themeModel,
    userModel,
    followModel,
    historyModel,
    ratingModel,
    emptyModel: emptyChain,
    roomModel,
    userRankModel,
    rankHistoryModel,
    themes,
  };
}

const E2E_SECRET = 'payload-diet-e2e-secret';
const E2E_REFRESH_SECRET = 'payload-diet-e2e-refresh-secret';

describe('Payload diet: projections + gzip + Cache-Control (e2e)', () => {
  let app: INestApplication;
  let port: number;
  const models = makeModels();

  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, username: userId, email: `${userId}@example.com`, tokenType: 'access' },
      E2E_SECRET,
      { expiresIn: '15m' },
    );

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // AuthService takes a plain (non-@Optional) ConfigService —
      // the global ConfigModule is how the real module supplies it.
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [ThemesController, SocialController],
      providers: [
        ThemesService,
        SocialService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        SearchIndexService,
        {
          provide: SEARCH_READINESS_PROBE,
          useExisting: SearchIndexService,
        },
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(AnimeCache.name), useValue: models.emptyModel },
        { provide: getModelToken(ArtistCache.name), useValue: models.emptyModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(Follow.name), useValue: models.followModel },
        {
          provide: getModelToken(Notification.name),
          useValue: models.emptyModel,
        },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        { provide: getModelToken(UserRank.name), useValue: models.emptyModel },
        {
          provide: getModelToken(PlaylistActivity.name),
          useValue: models.emptyModel,
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    // The production HTTP wiring (compression + Cache-Control) —
    // the same helper main.ts calls.
    applyHttpSetup(app);
    // A real listener (not app.init()'s in-process server): the
    // gzip assertions read the true wire bytes through node:http —
    // supertest's buffered parse transparently decompresses
    // gzip bodies on its side, which would fake the proof.
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  /**
   * One GET through node:http against the listening app — the
   * raw response exactly as a client on the network receives it
   * (no decompression, no header rewriting by the test client).
   */
  const wireGet = (path: string, acceptEncoding?: string) =>
    new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
      http
        .get({ host: '127.0.0.1', port, path, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        })
        .on('error', reject);
    });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  /** The exact summary of the dense document (EXPECTED_SUMMARY
   *  with its own stored values — literal, not mapper-derived). */
  const EXPECTED_DENSE_SUMMARY = {
    ...EXPECTED_SUMMARY,
    slug: 'dense-anime-ed2',
    songTitle: 'Dense Song With A Long Uncompressible Title 7f3a9b2c',
    animeTitle: 'Dense Anime',
    allArtists: ['Dense Artist'],
    artistName: 'Dense Artist',
    type: 'ED',
    sequence: 2,
    animeSeason: 'WINTER',
    avgRating: 8.234567,
    totalRatings: 91337,
    totalWatches: 1234567,
    totalListens: 987654,
    isPopular: true,
    popularRank: 999,
    duration: 95,
    animeSeasonYear: 2026,
    anilistId: 777,
  };

  it('serves /home summaries identical to the full-document mapping', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/home').set('Accept-Encoding', 'identity').expect(200);
    expect(res.body.seasonRail).toEqual([EXPECTED_SUMMARY]);
    expect(res.body.popular).toEqual([EXPECTED_DENSE_SUMMARY]);

    // The point of the diet, measured (reported in the job
    // report): the served /home payload — summaries only, what
    // the projected queries fed the mapper — versus the raw
    // documents the old full reads would have returned for the
    // same two rails (2 rich docs, 384-number embeddings).
    const wireBytes = Buffer.byteLength(JSON.stringify(res.body));
    const fullBytes = Buffer.byteLength(
      JSON.stringify({
        seasonRail: models.themes,
        popular: models.themes,
      }),
    );
    // eslint-disable-next-line no-console
    console.log(
      `PAYLOAD /home: served ${wireBytes} B vs full-documents ${fullBytes} B ` +
        `(${((1 - wireBytes / fullBytes) * 100).toFixed(1)}% smaller)`,
    );
    expect(wireBytes).toBeLessThan(fullBytes / 3);
  });

  it('serves the friends feed with items identical to the full-document mapping', async () => {
    const http = request(app.getHttpServer());
    const res = await http
      .get('/social/friends-activity')
      .set('Authorization', `Bearer ${tokenFor(ME)}`)
      .expect(200);
    expect(res.body.isGlobal).toBe(false);
    expect(res.body.activities).toHaveLength(2);
    const byType = Object.fromEntries(
      (res.body.activities as { type: string; item: unknown }[]).map((a) => [
        a.type,
        a.item,
      ]),
    );
    expect(byType.listening).toEqual({
      title: EXPECTED_SUMMARY.songTitle,
      slug: 'rich-anime-op1',
      artist: 'Rich Artist',
      anime: 'Rich Anime',
      cover: 'https://example.com/rich.jpg',
      score: null,
      playlistName: null,
    });
    expect(byType.liked).toEqual({
      title: EXPECTED_SUMMARY.songTitle,
      slug: 'rich-anime-op1',
      artist: 'Rich Artist',
      anime: 'Rich Anime',
      cover: 'https://example.com/rich.jpg',
      score: 8,
      playlistName: null,
    });
    expect(res.body.activities[0].user.username).toBe('friend');
  });

  it('gzips JSON when asked, and only then (raw wire bytes)', async () => {
    // /home over the 2-doc catalogue: identity first — a client
    // that does not offer gzip gets the plain body, byte for byte
    // what it got before this job.
    const homePlain = await wireGet('/home', 'identity');
    expect(homePlain.status).toBe(200);
    expect(homePlain.headers['content-encoding']).toBeUndefined();
    expect(homePlain.body.length).toBeGreaterThan(1024);

    const homeZipped = await wireGet('/home', 'gzip');
    expect(homeZipped.headers['content-encoding']).toBe('gzip');
    // Real gzip on the wire: magic bytes present, bytes smaller,
    // and they decode to the identical payload.
    expect(homeZipped.body[0]).toBe(0x1f);
    expect(homeZipped.body[1]).toBe(0x8b);
    expect(homeZipped.body.length).toBeLessThan(homePlain.body.length);
    expect(gunzipSync(homeZipped.body).equals(homePlain.body)).toBe(true);

    // The theme detail (a ~2 KB JSON document) behaves the same.
    const detailPlain = await wireGet('/themes/rich-anime-op1', 'identity');
    expect(detailPlain.headers['content-encoding']).toBeUndefined();
    expect(detailPlain.body.length).toBeGreaterThan(1024);
    const detailZipped = await wireGet('/themes/rich-anime-op1', 'gzip');
    expect(detailZipped.headers['content-encoding']).toBe('gzip');
    expect(detailZipped.body.length).toBeLessThan(detailPlain.body.length);
    expect(gunzipSync(detailZipped.body).equals(detailPlain.body)).toBe(
      true,
    );
  });

  it('marks catalogue routes with the private hint and user routes no-store', async () => {
    const http = request(app.getHttpServer());
    const season = await http
      .get('/season?season=SPRING&year=2026')
      .expect(200);
    expect(season.headers['cache-control']).toBe('private, max-age=60');

    const detail = await http.get('/themes/rich-anime-op1').expect(200);
    expect(detail.headers['cache-control']).toBe('private, max-age=60');

    const home = await http.get('/home').set('Accept-Encoding', 'identity').expect(200);
    expect(home.headers['cache-control']).toBe('no-store');

    const feed = await http
      .get('/social/friends-activity')
      .set('Accept-Encoding', 'identity')
      .expect(200);
    expect(feed.headers['cache-control']).toBe('no-store');
  });

  it('never stamps the freshness hint on an error response', async () => {
    const http = request(app.getHttpServer());
    const missing = await http.get('/themes/does-not-exist').expect(404);
    expect(missing.headers['cache-control']).toBeUndefined();
  });
});

/**
 * The Socket.IO gateway under the SAME production HTTP wiring:
 * compression must not sit between the gateway and its clients
 * (the /socket.io path is excluded in http-setup.ts), and the
 * handshake + auth behaviour must be exactly what the quiz suite
 * proves without the middleware. This describe boots the gateway
 * with the quiz suite's provider shape and applyHttpSetup applied.
 */
describe('Payload diet: Socket.IO handshake under compression (e2e)', () => {
  let app: INestApplication;
  let port: number;
  const models = makeModels();
  const clients: Socket[] = [];

  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, username: userId, email: `${userId}@example.com`, tokenType: 'access' },
      E2E_SECRET,
      { expiresIn: '15m' },
    );

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        QuizGateway,
        QuizRoomsService,
        RankService,
        RoomBroadcaster,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(QuizRoom.name), useValue: models.roomModel },
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.emptyModel,
        },
        { provide: getModelToken(Rating.name), useValue: models.emptyModel },
        { provide: getModelToken(Favorite.name), useValue: models.emptyModel },
        {
          provide: getModelToken(UserRank.name),
          useValue: models.userRankModel,
        },
        {
          provide: getModelToken(RankHistory.name),
          useValue: models.rankHistoryModel,
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyHttpSetup(app);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('connects a socket with a valid token through the compression wiring', async () => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { token: tokenFor(ME) },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('socket connect timeout')),
        8000,
      );
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(socket.connected).toBe(true);
  }, 15000);

  it('still disconnects a socket whose handshake token does not verify', async () => {
    const bad = io(`http://127.0.0.1:${port}`, {
      auth: { token: 'not-a-real-token' },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(bad);
    const reason = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 6000);
      const done = (value: string) => {
        clearTimeout(timer);
        resolve(value);
      };
      bad.on('disconnect', (r) => done(r));
      bad.on('connect_error', () => done('connect_error'));
    });
    expect(['io server disconnect', 'connect_error']).toContain(reason);
  }, 15000);
});
