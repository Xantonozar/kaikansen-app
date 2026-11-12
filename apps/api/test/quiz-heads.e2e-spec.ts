import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { QuizAttempt } from './../src/quiz/quiz-attempt.schema';
import { QuizController } from './../src/quiz/quiz.controller';
import { SoloQuizService } from './../src/quiz/solo-quiz.service';
import { QuizHeadsModule } from './../src/quiz-heads/quiz-heads.module';
import { QuizHeadCacheService } from './../src/quiz-heads/quiz-heads.service';

/**
 * Phase 2 head cache (2026-11-12) over real HTTP:
 * - Suite 1: GET /quiz-heads/:file through the real module —
 *   fill-then-serve, range shape, failure honesty.
 * - Suite 2: a solo game create (and the playback-start
 *   pre-draw) through the real QuizController warms the dealt
 *   themes' heads with the origin fetch scripted.
 * The origin is never real in either suite: the cache service
 * is constructed by hand with a scripted fetch and a temp dir,
 * mirroring the mocked-models pattern of quiz-solo.e2e.
 */

function streamOf(bytes: Buffer): ReadableStream {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, next)));
      offset = next;
    },
  });
}

interface FetchCall {
  url: string;
  range: string | undefined;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------------------------------------------ */
/* Suite 1 — the endpoint.                                             */
/* ------------------------------------------------------------------ */

describe('Quiz heads endpoint (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  const bytes = Buffer.alloc(300_000, 7);
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    calls.push({ url, range: init?.headers?.Range });
    if (url.endsWith('/Missing-OP1.ogg')) {
      return { status: 404, body: null } as Response;
    }
    return { status: 206, body: streamOf(bytes) } as Response;
  }) as typeof fetch;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-heads-e2e-'));
    const heads = new QuizHeadCacheService({ cacheDir: dir, fetchImpl });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [QuizHeadsModule],
    })
      .overrideProvider(QuizHeadCacheService)
      .useValue(heads)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a miss fills from the origin range and serves the head whole', async () => {
    const res = await request(app.getHttpServer())
      .get('/quiz-heads/AnimeA-OP1.ogg')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('audio/ogg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(bytes.length);
    expect((res.body as Buffer).equals(bytes)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://a.animethemes.moe/AnimeA-OP1.ogg');
    expect(calls[0].range).toBe('bytes=0-1499999');
  });

  it('a hit serves from disk — the origin is not pulled again', async () => {
    await request(app.getHttpServer())
      .get('/quiz-heads/AnimeA-OP1.ogg')
      .expect(200);
    expect(calls).toHaveLength(1);
  });

  it('a Range request answers 206 with the exact slice + Content-Range', async () => {
    const res = await request(app.getHttpServer())
      .get('/quiz-heads/AnimeA-OP1.ogg')
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(206);
    expect(res.headers['content-range']).toBe(
      `bytes 100-199/${bytes.length}`,
    );
    expect(Number(res.headers['content-length'])).toBe(100);
    expect((res.body as Buffer).equals(bytes.subarray(100, 200))).toBe(true);
  });

  it('an impossible range answers 416 with the body size', async () => {
    const res = await request(app.getHttpServer())
      .get('/quiz-heads/AnimeA-OP1.ogg')
      .set('Range', `bytes=${bytes.length + 10}-`)
      .expect(416);
    expect(res.headers['content-range']).toBe(`bytes */${bytes.length}`);
  });

  it('an origin 404 is a 404 here and stores nothing', async () => {
    await request(app.getHttpServer())
      .get('/quiz-heads/Missing-OP1.ogg')
      .expect(404);
    const names = await fsp.readdir(dir);
    expect(names).not.toContain('Missing-OP1.ogg');
  });

  it('names outside the single-segment .ogg space are 400s', async () => {
    await request(app.getHttpServer())
      .get('/quiz-heads/song.mp3')
      .expect(400);
    await request(app.getHttpServer())
      .get('/quiz-heads/two%20words.ogg')
      .expect(400);
  });
});

/* ------------------------------------------------------------------ */
/* Suite 2 — solo create warms the dealt themes.                       */
/* ------------------------------------------------------------------ */

function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, doc);
}

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as Record<string, unknown>[]).some((sub) =>
        matches(doc, sub),
      );
    }
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      if ('$nin' in ops) {
        return !(ops.$nin as unknown[]).some(
          (v) => v === value || (v == null && value == null),
        );
      }
      if ('$ne' in ops) return value !== ops.$ne;
      if ('$in' in ops) {
        return (ops.$in as unknown[]).some(
          (v) => String(v) === String(value),
        );
      }
    }
    return value === cond;
  });
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

const USER_1 = '507f1f77bcf86cd7994390a1';
const E2E_SECRET = ['e2e', 'heads', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'heads', 'refresh', 'secret'].join('-');

function makeFakeModels() {
  const themes: Record<string, unknown>[] = Array.from(
    { length: 12 },
    (_, i) => ({
      _id: `theme-${i + 1}`,
      slug: `anime-${i + 1}-op1`,
      songTitle: `Song ${i + 1}`,
      animeTitle: `Anime ${i + 1}`,
      animeTitleEnglish: `Anime ${i + 1} EN`,
      animeTitleAlternative: [],
      artistName: `Artist ${i + 1}`,
      anilistId: 2000 + i,
      animeCoverImage: null,
      animeCoverImageSmall: null,
      type: 'OP',
      sequence: 1,
      entries: [{ atEntryId: 9000 + i }],
      videoUrl: `https://v.animethemes.moe/Anime${i + 1}-OP1.webm`,
      audioUrl: null,
      isPopular: true,
    }),
  );
  const users: Record<string, unknown>[] = [
    {
      _id: USER_1,
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      anilist: { completedMediaIds: [] },
    },
  ];
  const themeModel = {
    aggregate: (pipeline: Record<string, unknown>[]) => {
      let result = [...themes];
      for (const step of pipeline) {
        if (step.$match) {
          result = result.filter((t) =>
            matches(t, step.$match as Record<string, unknown>),
          );
        }
        if (step.$sample) {
          result = result.slice(0, (step.$sample as { size: number }).size);
        }
      }
      return queryOf(result);
    },
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(themes.filter((t) => matches(t, filter)).length),
  };
  const attemptModel = {
    create: async (data: Record<string, unknown>) => ({ _id: 'a1', ...data }),
    find: () => queryOf([]),
  };
  const userModel = {
    findById: (id: string) =>
      queryOf(users.find((u) => String(u._id) === id) ?? null),
    find: () => queryOf([]),
  };
  const watchHistoryModel = { distinct: () => queryOf([]) };
  return { themeModel, attemptModel, userModel, watchHistoryModel };
}

describe('Solo create warms dealt heads (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  const models = makeFakeModels();
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    calls.push({ url, range: init?.headers?.Range });
    return { status: 206, body: streamOf(Buffer.alloc(4000, 4)) } as Response;
  }) as typeof fetch;

  const token = () =>
    jwt.sign(
      {
        userId: USER_1,
        username: 'alice',
        email: 'alice@example.com',
        tokenType: 'access',
      },
      E2E_SECRET,
      { expiresIn: '15m' },
    );
  const auth = () => ({ Authorization: `Bearer ${token()}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-heads-warm-'));
    const heads = new QuizHeadCacheService({ cacheDir: dir, fetchImpl });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [QuizController],
      providers: [
        SoloQuizService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: QuizHeadCacheService, useValue: heads },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
        {
          provide: getModelToken(QuizAttempt.name),
          useValue: models.attemptModel,
        },
        { provide: getModelToken(User.name), useValue: models.userModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.watchHistoryModel,
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
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('creating a game warms Q1’s head from the origin, fire-and-forget', async () => {
    const created = await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime' })
      .expect(201);
    expect(created.body.question.theme.audioUrl).toBe(
      'https://a.animethemes.moe/Anime1-OP1.ogg',
    );

    // The create answered without waiting for the pull; the
    // warm lands just behind it.
    await waitFor(() =>
      calls.some((c) => c.url === 'https://a.animethemes.moe/Anime1-OP1.ogg'),
    );
    const warmCall = calls.find(
      (c) => c.url === 'https://a.animethemes.moe/Anime1-OP1.ogg',
    );
    expect(warmCall!.range).toBe('bytes=0-1499999');
    // …and the pulled bytes land on disk under the file name.
    const landedStart = Date.now();
    for (;;) {
      const names = await fsp.readdir(dir);
      if (names.includes('Anime1-OP1.ogg')) break;
      if (Date.now() - landedStart > 5000) {
        throw new Error('warmed head did not land on disk');
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // The playback-start signal pre-draws Q2 — its head warms too.
    const gameId = created.body.gameId as string;
    await request(app.getHttpServer())
      .post(`/quiz/solo/games/${gameId}/playback-started`)
      .set(auth())
      .expect(200);
    await waitFor(() =>
      calls.some((c) => c.url === 'https://a.animethemes.moe/Anime2-OP1.ogg'),
    );
  });
});
