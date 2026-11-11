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
import { User } from './../src/auth/user.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { QuizAttempt } from './../src/quiz/quiz-attempt.schema';
import { QuizController } from './../src/quiz/quiz.controller';
import { SoloQuizService } from './../src/quiz/solo-quiz.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: game calls
 * reject tokenless requests with 401 (the guard needs no DB) and
 * answer 503 with a valid token; the public leaderboard 503s as
 * well. Mirrors the other slices' no-DB suite.
 */
describe('Solo quiz without a database (e2e)', () => {
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

  it('rejects tokenless game creation with 401', async () => {
    await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .send({ quizType: 'anime' })
      .expect(401);
  });

  it('answers 503 to a valid token when no database is configured', async () => {
    await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set('Authorization', `Bearer ${validToken()}`)
      .send({ quizType: 'anime' })
      .expect(503);
  });

  it('leaderboard is public but 503s without a database', async () => {
    await request(app.getHttpServer()).get('/quiz/leaderboard').expect(503);
  });
});

/* ------------------------------------------------------------------ */
/* Suite 2 — mocked models over real HTTP.                             */
/* ------------------------------------------------------------------ */

function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, doc);
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as Record<string, unknown>[]).some((sub) => matches(doc, sub));
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
        return (ops.$in as unknown[]).some((v) => String(v) === String(value));
      }
    }
    return value === cond;
  });
}

function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = (spec: Record<string, number>) => {
    const [key, dir] = Object.entries(spec)[0];
    result.sort((a, b) => {
      const av = a[key] as never;
      const bv = b[key] as never;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
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

const USER_1 = '507f1f77bcf86cd7994390a1';

function makeFakeModels() {
  const themes: Record<string, unknown>[] = Array.from({ length: 12 }, (_, i) => ({
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
    videoUrl: `https://video/${i + 1}.webm`,
    audioUrl: null,
    isPopular: true,
  }));
  const attempts: Record<string, unknown>[] = [];
  let seq = 0;
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
          result = result.filter((t) => matches(t, step.$match as Record<string, unknown>));
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
    docs: attempts,
    create: async (data: Record<string, unknown>) => {
      const doc = { _id: `attempt-${++seq}`, createdAt: new Date(), ...data };
      attempts.push(doc);
      return doc;
    },
    find: (filter: Record<string, unknown>) =>
      chain(attempts.filter((a) => matches(a, filter))),
  };
  const userModel = {
    findById: (id: string) => queryOf(users.find((u) => String(u._id) === id) ?? null),
    find: (filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(users.filter((u) => inList.some((id) => String(id) === String(u._id))));
    },
  };
  const watchHistoryModel = { distinct: () => queryOf([]) };

  return { themeModel, attemptModel, userModel, watchHistoryModel, attempts, themes };
}

const E2E_SECRET = ['e2e', 'quiz', 'access', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'quiz', 'refresh', 'secret'].join('-');

describe('Solo quiz flow with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  // Derivable AnimeThemes catalogue (the factory fixtures'
  // video URLs do not derive): since the ogg-only ruling
  // (2026-11-12) a solo game can only be dealt themes with a
  // resolvable .ogg, so the full-loop suite plays on dealable
  // themes; the audio-less pool shape is pinned by the
  // ogg-only suite at the end of this file.
  models.themes.forEach((t, i) => {
    t.videoUrl = `https://v.animethemes.moe/Anime${i + 1}-OP1.webm`;
    t.audioUrl = null;
  });

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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [QuizController],
      providers: [
        SoloQuizService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(QuizAttempt.name), useValue: models.attemptModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(WatchHistory.name), useValue: models.watchHistoryModel },
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

  it('plays a full loop: create → answer → leaderboard shows the attempt', async () => {
    const http = request(app.getHttpServer());

    const created = await http
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime' })
      .expect(201);
    expect(created.body.question.options).toContain('Anime 1 EN');
    expect(JSON.stringify(created.body)).not.toContain('correctValue');
    const gameId = created.body.gameId as string;

    // The playback-start signal (owner timing fix, 2026-11-10):
    // the client reports the audio actually started; the answer
    // window is measured from there, not the draw.
    const signalled = await http
      .post(`/quiz/solo/games/${gameId}/playback-started`)
      .set(auth())
      .expect(200);
    expect(typeof signalled.body.playbackStartedAt).toBe('string');
    // Part 5's field carries the next question's derived .ogg
    // (these fixtures are derivable — see the suite header).
    // The null reveal for an audio-less pool is pinned by the
    // ogg-only suite below and the unit suite.
    expect(signalled.body.nextAudioUrl).toBe(
      'https://a.animethemes.moe/Anime2-OP1.ogg',
    );

    const answered = await http
      .post(`/quiz/solo/games/${gameId}/answers`)
      .set(auth())
      .send({ answer: 'Anime 1 EN' })
      .expect(200);
    expect(answered.body).toMatchObject({
      correct: true,
      correctValue: 'Anime 1 EN',
      scoreGained: 20,
      totalScore: 20,
      gameOver: false,
    });
    expect(answered.body.nextQuestion.index).toBe(2);

    const board = await http.get('/quiz/leaderboard').expect(200);
    expect(board.body.entries).toHaveLength(1);
    expect(board.body.entries[0]).toMatchObject({
      themeSlug: 'anime-1-op1',
      score: 20,
      author: { username: 'alice' },
    });
  });

  it('rejects an invalid quiz type with the service’s 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'bogus' })
      .expect(400);
    expect(res.body.message).toBe('Invalid quiz type');
  });

  it('owner pools (spec 2026-11-10): empty listened / anilist pools 400 honestly; the retired library source is invalid', async () => {
    const listened = await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime', source: 'listened' })
      .expect(400);
    expect(listened.body.message).toBe(
      'Your listening history is empty. Play some themes first, or pick another pool.',
    );

    const anilist = await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime', source: 'anilist' })
      .expect(400);
    expect(anilist.body.message).toBe(
      'No AniList anime found. Connect AniList and sync your lists, or pick another pool.',
    );

    const legacy = await request(app.getHttpServer())
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime', source: 'library' })
      .expect(400);
    expect(legacy.body.message).toBe('Invalid quiz source');
  });

  it('404s unknown games', async () => {
    await request(app.getHttpServer())
      .get('/quiz/solo/games/nope')
      .set(auth())
      .expect(404);
    await request(app.getHttpServer())
      .post('/quiz/solo/games/nope/playback-started')
      .set(auth())
      .expect(404);
  });
});

describe('Solo quiz earlier reveal with derivable audio (e2e, part 5)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  // Derivable AnimeThemes catalogue: the served audio is the
  // derived .ogg twin of each video link — the shape the live
  // catalogue actually has (the other suites' fixtures cannot
  // derive, which is exactly why their reveal is null).
  models.themes.forEach((t, i) => {
    t.videoUrl = `https://v.animethemes.moe/Anime${i + 1}-OP1.webm`;
    t.audioUrl = null;
  });

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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [QuizController],
      providers: [
        SoloQuizService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(QuizAttempt.name), useValue: models.attemptModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(WatchHistory.name), useValue: models.watchHistoryModel },
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

  it('the signal reveals the next .ogg; the answer serves that very question; the last question reveals null', async () => {
    const http = request(app.getHttpServer());

    const created = await http
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime' })
      .expect(201);
    const gameId = created.body.gameId as string;
    expect(created.body.question.theme.slug).toBe('anime-1-op1');

    const signalled = await http
      .post(`/quiz/solo/games/${gameId}/playback-started`)
      .set(auth())
      .expect(200);
    expect(typeof signalled.body.playbackStartedAt).toBe('string');
    expect(signalled.body.nextAudioUrl).toBe(
      'https://a.animethemes.moe/Anime2-OP1.ogg',
    );
    // The reveal is audio only — no options/theme data leaks.
    expect(signalled.body.nextQuestion).toBeUndefined();
    expect(signalled.body.options).toBeUndefined();

    const answered = await http
      .post(`/quiz/solo/games/${gameId}/answers`)
      .set(auth())
      .send({ answer: null })
      .expect(200);
    expect(answered.body.nextQuestion.theme.slug).toBe('anime-2-op1');
    expect(answered.body.nextQuestion.theme.audioUrl).toBe(
      'https://a.animethemes.moe/Anime2-OP1.ogg',
    );

    // Play out to the last question (answers 2..9 serve Q3..Q10).
    for (let i = 0; i < 8; i++) {
      await http
        .post(`/quiz/solo/games/${gameId}/answers`)
        .set(auth())
        .send({ answer: null })
        .expect(200);
    }
    const lastSignal = await http
      .post(`/quiz/solo/games/${gameId}/playback-started`)
      .set(auth())
      .expect(200);
    expect(lastSignal.body.nextAudioUrl).toBeNull();

    const final = await http
      .post(`/quiz/solo/games/${gameId}/answers`)
      .set(auth())
      .send({ answer: null })
      .expect(200);
    expect(final.body.gameOver).toBe(true);
  });
});

describe('Solo quiz ogg-only pool (e2e, owner ruling 2026-11-12)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  // The factory fixtures UNCONVERTED: video URLs that do not
  // derive and no stored audio — every theme in this pool has
  // NO resolvable .ogg, so every draw runs the redraw machinery
  // and deals only through the fill-don't-fail cap hatch.

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
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [QuizController],
      providers: [
        SoloQuizService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(QuizAttempt.name), useValue: models.attemptModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(WatchHistory.name), useValue: models.watchHistoryModel },
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

  it('audio-less themes are redrawn; the cap deals the 4th, and the pre-draw honours the rule too', async () => {
    const http = request(app.getHttpServer());

    const created = await http
      .post('/quiz/solo/games')
      .set(auth())
      .send({ quizType: 'anime' })
      .expect(201);
    const gameId = created.body.gameId as string;
    // Themes 1–3 were sampled and rejected as audio-less; the
    // redraw cap deals theme 4 (fill, don't fail) — with no
    // audioUrl, exactly like a probed-404 candidate past cap.
    expect(created.body.question.theme.slug).toBe('anime-4-op1');
    expect(created.body.question.theme.audioUrl).toBeNull();

    // The playback-started pre-draw runs the same sampler:
    // themes 5–7 rejected, theme 8 pre-drawn — so the reveal
    // is null (theme 8 has no .ogg to reveal)…
    const signalled = await http
      .post(`/quiz/solo/games/${gameId}/playback-started`)
      .set(auth())
      .expect(200);
    expect(signalled.body.nextAudioUrl).toBeNull();

    // …and the answer promotes that very pre-drawn question.
    const answered = await http
      .post(`/quiz/solo/games/${gameId}/answers`)
      .set(auth())
      .send({ answer: null })
      .expect(200);
    expect(answered.body.nextQuestion.theme.slug).toBe('anime-8-op1');
    expect(answered.body.nextQuestion.theme.audioUrl).toBeNull();
  });
});
