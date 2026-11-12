import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HttpAudioProbe, type AudioProbeResult } from './audio-probe';
import { SoloQuizService } from './solo-quiz.service';

/* ------------------------------------------------------------------ */
/* In-memory model stand-ins (repo e2e/unit style): a tiny matcher     */
/* for the operators the quiz queries use, chainable query stubs,      */
/* and a deterministic $sample (first N matches) so the "random"       */
/* theme is the fixture's first match.                                 */
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
        const list = ops.$nin as unknown[];
        if (list.some((v) => v === value || (v == null && value == null))) return false;
        return true;
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
const USER_2 = '507f1f77bcf86cd7994390a2';

function makeTheme(i: number, extra: Record<string, unknown> = {}) {
  return {
    _id: `theme-${i}`,
    slug: `anime-${i}-op1-100${i}`,
    songTitle: `Song ${i}`,
    animeTitle: `Anime ${i}`,
    animeTitleEnglish: `Anime ${i} EN`,
    animeTitleAlternative: [],
    artistName: `Artist ${i}`,
    anilistId: 1000 + i,
    animeCoverImage: `https://img/${i}.jpg`,
    animeCoverImageSmall: `https://img/${i}-s.jpg`,
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 5000 + i }],
    // The catalogue's common case (audioUrl null + AnimeThemes
    // video → the derived .ogg): since the ogg-only ruling
    // (2026-11-12) a theme with no resolvable .ogg is not
    // dealable in solo, so the factory default is a dealable
    // theme; suites studying audio-less themes stage them
    // explicitly (non-derivable video + a stored video link).
    videoUrl: `https://v.animethemes.moe/Anime${i}-OP1.webm`,
    audioUrl: null,
    isPopular: true,
    ...extra,
  };
}

function makeFakeModels() {
  // 14 popular themes — enough for a full 10-question game.
  const themes: Record<string, unknown>[] = Array.from({ length: 14 }, (_, i) =>
    makeTheme(i + 1),
  );
  const attempts: Record<string, unknown>[] = [];
  let attemptSeq = 0;
  const users: Record<string, unknown>[] = [
    { _id: USER_1, username: 'alice', displayName: 'Alice', avatarUrl: null, anilist: { completedMediaIds: [] } },
    { _id: USER_2, username: 'bob', displayName: 'Bob', avatarUrl: 'https://img/bob.png', anilist: { completedMediaIds: [] } },
  ];
  const history: Record<string, unknown>[] = [];

  const themeModel = {
    docs: themes,
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
      const doc = {
        _id: `attempt-${++attemptSeq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      attempts.push(doc);
      return doc;
    },
    find: (filter: Record<string, unknown>) =>
      chain(attempts.filter((a) => matches(a, filter))),
  };

  const userModel = {
    docs: users,
    findById: (id: string) => queryOf(users.find((u) => String(u._id) === id) ?? null),
    find: (filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(users.filter((u) => inList.some((id) => String(id) === String(u._id))));
    },
  };

  const watchHistoryModel = {
    docs: history,
    distinct: (_field: string, filter: Record<string, unknown>) =>
      queryOf([
        ...new Set(
          history
            .filter((h) => String(h.userId) === String(filter.userId))
            .map((h) => h.themeId),
        ),
      ]),
  };

  return { themeModel, attemptModel, userModel, watchHistoryModel, themes, attempts, users, history };
}

function makeService() {
  const models = makeFakeModels();
  const service = new SoloQuizService(
    models.themeModel as never,
    models.attemptModel as never,
    models.userModel as never,
    models.watchHistoryModel as never,
  );
  return { service, models };
}

describe('SoloQuizService — game flow', () => {
  it('creates a game whose question carries options but NO answer leak', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });

    expect(state.totalQuestions).toBe(10);
    expect(state.timeLimitSeconds).toBe(20);
    expect(state.gameOver).toBe(false);
    expect(state.question?.index).toBe(1);
    expect(state.question?.options).toHaveLength(4);
    expect(state.question?.options).toContain('Anime 1 EN');
    // The playable projection has exactly the safe fields.
    expect(Object.keys(state.question!.theme).sort()).toEqual(
      ['audioUrl', 'coverImage', 'sequence', 'slug', 'type', 'videoUrl'].sort(),
    );
    // No answer material anywhere in the payload.
    const wire = JSON.stringify(state);
    expect(wire).not.toContain('correctValue');
    expect(wire).not.toContain('Song 1');
    expect(wire).not.toContain('Artist 1');
  });

  it('serves the derived .ogg as question audio when the theme stores none', async () => {
    const { service, models } = makeService();
    // The catalogue's common case: audioUrl null, AnimeThemes video.
    models.themes.forEach((t, idx) => {
      t.audioUrl = null;
      t.videoUrl = `https://v.animethemes.moe/Anime${idx + 1}-OP1.webm`;
    });

    const state = await service.createGame(USER_1, { quizType: 'anime' });

    expect(state.question?.theme.videoUrl).toBe(
      'https://v.animethemes.moe/Anime1-OP1.webm',
    );
    expect(state.question?.theme.audioUrl).toBe(
      'https://a.animethemes.moe/Anime1-OP1.ogg',
    );

    // The re-served question (GET state) derives the same way.
    const again = await service.getGame(USER_1, state.gameId);
    expect(again.question?.theme.audioUrl).toBe(
      'https://a.animethemes.moe/Anime1-OP1.ogg',
    );
  });

  it('serves no audioUrl when the stored value is a video link and nothing derives (owner doctrine, 2026-11-10)', async () => {
    const { service, models } = makeService();
    // Stage the audio-less catalogue corner explicitly (the
    // factory default is the derivable common case): stored
    // https://audio/<i>.webm — a video LINK — with a
    // non-AnimeThemes video URL, so nothing derives and the
    // stored value is not audio: it must NOT be served as the
    // question's audio. (This expectation previously enshrined the
    // old "stored always wins" rule; the client's audio-only last
    // resort is the question's videoUrl, which stays intact.)
    models.themes.forEach((t, idx) => {
      t.videoUrl = `https://video/${idx + 1}.webm`;
      t.audioUrl = `https://audio/${idx + 1}.webm`;
    });
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // Under the ogg-only rule (2026-11-12) every such theme is
    // redrawn; with the whole pool audio-less the redraw cap
    // deals the 4th candidate through the fill-don't-fail
    // hatch — and its projection STILL serves no audioUrl.
    expect(state.question?.theme.slug).toBe('anime-4-op1-1004');
    expect(state.question?.theme.audioUrl).toBeNull();
    expect(state.question?.theme.videoUrl).toBeTruthy();
  });

  it('scores a correct answer with the web formula and persists the attempt', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });

    const res = await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');
    expect(res.correct).toBe(true);
    expect(res.correctValue).toBe('Anime 1 EN');
    expect(res.secondsRemaining).toBe(20); // answered instantly
    expect(res.scoreGained).toBe(20); // ceil(20 * (1 + 0 * 0.1))
    expect(res.streak).toBe(1);
    expect(res.totalScore).toBe(20);
    expect(res.nextQuestion?.index).toBe(2);
    expect(res.reveal.songTitle).toBe('Song 1');

    expect(models.attempts).toHaveLength(1);
    expect(models.attempts[0]).toMatchObject({
      userId: USER_1,
      themeSlug: 'anime-1-op1-1001',
      atEntryId: 5001,
      quizType: 'anime',
      correct: true,
      timeTaken: 0,
      score: 20,
      streak: 1,
    });
  });

  it('applies the streak multiplier from the streak BEFORE the answer', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');
    const res = await service.submitAnswer(USER_1, state.gameId, 'Anime 2 EN');
    expect(res.scoreGained).toBe(22); // ceil(20 * (1 + 1 * 0.1))
    expect(res.totalScore).toBe(42);
    expect(res.streak).toBe(2);
  });

  it('wrong answers are penalised −half the would-be score and reset the streak; skips stay 0 and take the full 20s', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');

    // Q2 answered instantly with a streak of 1: a correct answer
    // would have earned ceil(20 * 1.1) = 22, so the wrong tap
    // costs −ceil(22 / 2) = −11 (owner ruling, 2026-11-12).
    const wrong = await service.submitAnswer(USER_1, state.gameId, 'Anime 3 EN');
    expect(wrong.correct).toBe(false);
    expect(wrong.scoreGained).toBe(-11);
    expect(wrong.totalScore).toBe(9); // 20 − 11
    expect(wrong.streak).toBe(0);
    expect(models.attempts[1]).toMatchObject({ correct: false, score: -11, streak: 0 });

    const skipped = await service.submitAnswer(USER_1, state.gameId, null);
    expect(skipped.correct).toBe(false);
    expect(skipped.scoreGained).toBe(0); // no submission → no penalty
    expect(models.attempts[2]).toMatchObject({ correct: false, timeTaken: 20, score: 0 });
  });

  it('a wrong first answer takes the game total below zero (no floor)', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });

    const wrong = await service.submitAnswer(USER_1, state.gameId, 'Anime 2 EN');
    expect(wrong.correct).toBe(false);
    expect(wrong.scoreGained).toBe(-10); // −half of 20 at no streak
    expect(wrong.totalScore).toBe(-10);
    expect(models.attempts[0]).toMatchObject({ correct: false, score: -10 });
  });

  it('ends after exactly 10 questions and refuses an 11th answer', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'title' });
    let last = null;
    for (let i = 1; i <= 10; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, `Song ${i}`);
    }
    expect(last!.gameOver).toBe(true);
    expect(last!.nextQuestion).toBeNull();
    expect(last!.answeredCount).toBe(10);
    expect(last!.correctCount).toBe(10);

    const finalState = await service.getGame(USER_1, state.gameId);
    expect(finalState.gameOver).toBe(true);
    expect(finalState.question).toBeNull();

    await expect(
      service.submitAnswer(USER_1, state.gameId, 'Song 1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('never serves another player’s game', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    await expect(service.getGame(USER_2, state.gameId)).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.submitAnswer(USER_2, state.gameId, 'Anime 1 EN'),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects invalid quiz types and sources', async () => {
    const { service } = makeService();
    await expect(
      service.createGame(USER_1, { quizType: 'bogus' as never }),
    ).rejects.toThrow('Invalid quiz type');
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'bogus' as never }),
    ).rejects.toThrow('Invalid quiz source');
  });

  it('answers 503-style when booted without models', async () => {
    const service = new SoloQuizService();
    await expect(
      service.createGame(USER_1, { quizType: 'anime' }),
    ).rejects.toThrow('Quiz unavailable');
  });
});

describe('SoloQuizService — playback-start timing (owner fix, 2026-11-10)', () => {
  /** Reach the live session to rewind its draw stamp. */
  function currentOf(service: SoloQuizService, gameId: string) {
    const sessions = (
      service as unknown as {
        sessions: Map<
          string,
          { current: { startedAt: Date; playbackStartedAt: Date | null } | null }
        >;
      }
    ).sessions;
    return sessions.get(gameId)!.current!;
  }

  it('measures the answer from playback start, not the draw', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // The question was drawn 2s ago; the audio only started now —
    // those 2s of load must not eat the player's window.
    currentOf(service, state.gameId).startedAt = new Date(Date.now() - 2000);

    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(Date.parse(signal.playbackStartedAt)).toBeGreaterThan(Date.now() - 1000);

    const res = await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');
    expect(res.correct).toBe(true);
    expect(res.secondsRemaining).toBe(20); // full window at playback start
    expect(res.scoreGained).toBe(20);
    expect(models.attempts[0]).toMatchObject({ timeTaken: 0, score: 20 });
  });

  it('caps the credited load at 5s, however slow the signal', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // Drawn 12s ago, playback starts now: only 5s is credited,
    // so the measurement effectively began 7s ago.
    currentOf(service, state.gameId).startedAt = new Date(Date.now() - 12_000);

    await service.markPlaybackStarted(USER_1, state.gameId);
    const res = await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');
    expect(res.secondsRemaining).toBe(13); // 20 − (12 − 5)
    expect(res.scoreGained).toBe(13);
    expect(models.attempts[0]).toMatchObject({ timeTaken: 7, score: 13 });
  });

  it('without a signal the measurement stays at the draw (legacy)', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    currentOf(service, state.gameId).startedAt = new Date(Date.now() - 10_000);

    const res = await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');
    expect(res.secondsRemaining).toBe(10);
    expect(res.scoreGained).toBe(10);
  });

  it('the first signal wins — repeats return the original stamp', async () => {
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const first = await service.markPlaybackStarted(USER_1, state.gameId);
    const second = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(second.playbackStartedAt).toBe(first.playbackStartedAt);
    expect(currentOf(service, state.gameId).playbackStartedAt?.toISOString()).toBe(
      first.playbackStartedAt,
    );
  });

  it('refuses the signal for unknown and finished games', async () => {
    const { service } = makeService();
    await expect(
      service.markPlaybackStarted(USER_1, 'solo-nope'),
    ).rejects.toThrow(NotFoundException);

    const state = await service.createGame(USER_1, { quizType: 'title' });
    for (let i = 1; i <= 10; i++) {
      await service.submitAnswer(USER_1, state.gameId, `Song ${i}`);
    }
    await expect(
      service.markPlaybackStarted(USER_1, state.gameId),
    ).rejects.toThrow('Game already finished');
  });
});

describe('SoloQuizService — listened pool (owner picker, spec 2026-11-10)', () => {
  it('rejects an empty listening history with a clear message', async () => {
    const { service } = makeService();
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'listened' }),
    ).rejects.toThrow(
      'Your listening history is empty. Play some themes first, or pick another pool.',
    );
  });

  it('rejects a thin listened pool with the counted message', async () => {
    const { service, models } = makeService();
    for (const t of models.themes.slice(0, 3)) {
      models.history.push({ userId: USER_1, themeId: t._id });
    }
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'listened' }),
    ).rejects.toThrow(
      'You need at least 10 listened songs to use this pool. (Current: 3)',
    );
  });

  it('draws listened questions from the player’s history themes', async () => {
    const { service, models } = makeService();
    for (const t of models.themes.slice(0, 12)) {
      models.history.push({ userId: USER_1, themeId: t._id });
    }
    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'listened',
    });
    expect(state.source).toBe('listened');
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
  });
});

describe('SoloQuizService — anilist pool (owner picker, spec 2026-11-10)', () => {
  /** USER_1's stored AniList id set (the merged Watching+Completed). */
  function setAnilistIds(models: ReturnType<typeof makeFakeModels>, ids: number[]) {
    const user = models.users.find((u) => u._id === USER_1)!;
    (user.anilist as { completedMediaIds: number[] }).completedMediaIds = ids;
  }

  it('rejects a user with no AniList anime with a clear message', async () => {
    const { service } = makeService();
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'anilist' }),
    ).rejects.toThrow(
      'No AniList anime found. Connect AniList and sync your lists, or pick another pool.',
    );
  });

  it('rejects a thin anilist pool with the counted message', async () => {
    const { service, models } = makeService();
    setAnilistIds(models, [1001]); // one anime → its single theme
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'anilist' }),
    ).rejects.toThrow(
      'You need at least 10 songs from your AniList anime to use this pool. (Current: 1)',
    );
  });

  it('draws anilist questions from the listed anime’s themes (no history needed)', async () => {
    const { service, models } = makeService();
    setAnilistIds(models, Array.from({ length: 12 }, (_, i) => 1001 + i));
    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'anilist',
    });
    expect(state.source).toBe('anilist');
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
  });

  it('the pools are separate: a big history does not rescue a thin anilist pool', async () => {
    const { service, models } = makeService();
    for (const t of models.themes.slice(0, 12)) {
      models.history.push({ userId: USER_1, themeId: t._id });
    }
    setAnilistIds(models, [1013, 1014]); // only 2 themes on the lists
    await expect(
      service.createGame(USER_1, { quizType: 'anime', source: 'anilist' }),
    ).rejects.toThrow('(Current: 2)');
    // …while the listened pool plays fine off the same account.
    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'listened',
    });
    expect(state.source).toBe('listened');
  });
});

describe('SoloQuizService — verified dealing (part 7, 2026-11-11)', () => {
  const oggOf = (i: number) => `https://a.animethemes.moe/Anime${i}-OP1.ogg`;

  /** The fake catalogue, converted to derivable AnimeThemes
      themes (audioUrl null → the served audio is the derived
      .ogg the probe verifies). */
  function makeProbedService(
    script: (url: string) => AudioProbeResult,
    themeCount?: number,
  ) {
    const models = makeFakeModels();
    if (themeCount !== undefined) models.themes.splice(themeCount);
    models.themes.forEach((t, idx) => {
      t.audioUrl = null;
      t.videoUrl = `https://v.animethemes.moe/Anime${idx + 1}-OP1.webm`;
    });
    const calls: { url: string; timeoutMs: number }[] = [];
    const probe = {
      probe: async (url: string, timeoutMs: number) => {
        calls.push({ url, timeoutMs });
        return script(url);
      },
    };
    const service = new SoloQuizService(
      models.themeModel as never,
      models.attemptModel as never,
      models.userModel as never,
      models.watchHistoryModel as never,
      probe as never,
    );
    return { service, models, calls };
  }

  it('deals a verified song without a redraw (one probe, bounded timeout)', async () => {
    const { service, calls } = makeProbedService(() => 'ok');
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
    expect(state.question?.theme.audioUrl).toBe(oggOf(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(oggOf(1));
    expect(calls[0].timeoutMs).toBeGreaterThan(0);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(1000);
  });

  it('a definite 404 redraws the question from the same pool', async () => {
    const { service, calls } = makeProbedService((url) =>
      url === oggOf(1) ? 'missing' : 'ok',
    );
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    expect(state.question?.theme.slug).toBe('anime-2-op1-1002');
    expect(state.question?.theme.audioUrl).toBe(oggOf(2));
    expect(calls.map((c) => c.url)).toEqual([oggOf(1), oggOf(2)]);
  });

  it('a phantom rejected once is never re-dealt within the game', async () => {
    const { service } = makeProbedService((url) =>
      url === oggOf(1) ? 'missing' : 'ok',
    );
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const dealtSlugs: string[] = [];
    let last = null;
    for (let i = 0; i < 10; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, null);
      dealtSlugs.push(last.reveal.slug);
    }
    expect(last!.gameOver).toBe(true);
    expect(dealtSlugs).toHaveLength(10);
    expect(dealtSlugs).not.toContain('anime-1-op1-1001');
    expect(new Set(dealtSlugs).size).toBe(10);
  });

  it('doubt (timeout / network / 5xx) keeps the song', async () => {
    const { service } = makeProbedService(() => 'unknown');
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
  });

  it('an all-404 pool still deals — unverified after the redraw cap', async () => {
    const { service, calls } = makeProbedService(() => 'missing');
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // 1 initial probe + 3 capped redraws, then the 4th candidate
    // is dealt as-is rather than looping (or failing) forever.
    expect(calls).toHaveLength(4);
    expect(state.question?.theme.slug).toBe('anime-4-op1-1004');
  });

  it('a drained pool fills the last slot with the rejected song, unverified', async () => {
    // Exactly 10 themes; only the last one's .ogg is a phantom.
    const { service, calls } = makeProbedService(
      (url) => (url === oggOf(10) ? 'missing' : 'ok'),
      10,
    );
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, null);
    }
    // Q10: theme 10 probes missing, the redraw finds the pool
    // empty, and the rejected song is dealt rather than the
    // game dying one question short.
    expect(last!.nextQuestion?.theme.slug).toBe('anime-10-op1-10010');
    expect(
      calls.filter((c) => c.url === oggOf(10)),
    ).toHaveLength(1);
  });

  it('once the ~1s budget is spent, no further probe fires', async () => {
    let now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { service, calls } = makeProbedService((url) => {
        if (url === oggOf(1)) {
          // The first probe eats the whole budget (a slow edge).
          now += 2000;
          return 'missing';
        }
        return 'ok';
      });
      const state = await service.createGame(USER_1, { quizType: 'anime' });
      // Theme 2 was dealt WITHOUT being probed — the budget was
      // gone, so its verdict defaulted to "keep".
      expect(state.question?.theme.slug).toBe('anime-2-op1-1002');
      expect(calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('the shared probe cache means a second game re-probes nothing', async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = jest.fn(async () => {
      fetches += 1;
      return { status: 206, body: { cancel: async () => undefined } };
    }) as never;
    try {
      const models = makeFakeModels();
      models.themes.forEach((t, idx) => {
        t.audioUrl = null;
        t.videoUrl = `https://v.animethemes.moe/Anime${idx + 1}-OP1.webm`;
      });
      const service = new SoloQuizService(
        models.themeModel as never,
        models.attemptModel as never,
        models.userModel as never,
        models.watchHistoryModel as never,
        new HttpAudioProbe(),
      );
      await service.createGame(USER_1, { quizType: 'anime' });
      expect(fetches).toBe(1); // Q1's song verified once
      await service.createGame(USER_1, { quizType: 'anime' });
      expect(fetches).toBe(1); // same first draw — served by the cache
    } finally {
      globalThis.fetch = original;
    }
  });

  it('without an injected probe nothing is probed (no network, old behaviour)', async () => {
    const { service, models } = makeService();
    models.themes.forEach((t, idx) => {
      t.audioUrl = null;
      t.videoUrl = `https://v.animethemes.moe/Anime${idx + 1}-OP1.webm`;
    });
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
    expect(state.question?.theme.audioUrl).toBe(oggOf(1));
  });
});

describe('SoloQuizService — ogg-only pool (owner ruling, 2026-11-12)', () => {
  const oggOf = (i: number) => `https://a.animethemes.moe/Anime${i}-OP1.ogg`;

  /** The derivable factory catalogue with the named themes
      (1-based) staged audio-less: non-derivable video URL +
      a stored video link in the audio slot, so
      resolveAudioUrl returns null for exactly those. The fake
      $sample is deterministic (first match), so the draw order
      is the fixture order. */
  function makeMixedService(nullIndexes: number[]) {
    const { service, models } = makeService();
    models.themes.forEach((t, idx) => {
      if (nullIndexes.includes(idx + 1)) {
        t.videoUrl = `https://video/${idx + 1}.webm`;
        t.audioUrl = `https://audio/${idx + 1}.webm`;
      }
    });
    return { service, models };
  }

  it('a null-audio theme is redrawn and excluded for the rest of the game', async () => {
    const { service } = makeMixedService([1]);
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // Theme 1 is sampled first, rejected as audio-less, and
    // the question is dealt from the same pool: theme 2.
    expect(state.question?.theme.slug).toBe('anime-2-op1-1002');
    expect(state.question?.theme.audioUrl).toBe(oggOf(2));

    const dealtSlugs: string[] = [];
    let last = null;
    for (let i = 0; i < 10; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, null);
      dealtSlugs.push(last.reveal.slug);
    }
    expect(last!.gameOver).toBe(true);
    expect(dealtSlugs).not.toContain('anime-1-op1-1001');
    expect(new Set(dealtSlugs).size).toBe(10);
  });

  it('no question projection in a full game ever serves a null-audio theme', async () => {
    const { service } = makeMixedService([1, 5]);
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const projections = [state.question!];
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, null);
      projections.push(last.nextQuestion!);
    }
    expect(projections).toHaveLength(10);
    for (const q of projections) {
      expect(q.theme.slug).not.toBe('anime-1-op1-1001');
      expect(q.theme.slug).not.toBe('anime-5-op1-1005');
      expect(q.theme.audioUrl).toMatch(
        /^https:\/\/a\.animethemes\.moe\/.+\.ogg$/,
      );
    }
  });

  it('redraw cap spent on null-audio candidates deals the next one, exactly like all-404', async () => {
    const { service } = makeMixedService([1, 2, 3, 4, 5]);
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // 1 initial rejection + 3 capped redraws, then the 4th
    // rejected candidate (theme 4) is dealt through the hatch
    // rather than looping (or failing) forever.
    expect(state.question?.theme.slug).toBe('anime-4-op1-1004');
    expect(state.question?.theme.audioUrl).toBeNull();
  });

  it('a drained pool fills the last slot with the rejected null-audio song', async () => {
    // Exactly 10 themes; only the last one is audio-less.
    const models = makeFakeModels();
    models.themes.splice(10);
    models.themes.forEach((t, idx) => {
      if (idx + 1 === 10) {
        t.videoUrl = 'https://video/10.webm';
        t.audioUrl = 'https://audio/10.webm';
      }
    });
    const service = new SoloQuizService(
      models.themeModel as never,
      models.attemptModel as never,
      models.userModel as never,
      models.watchHistoryModel as never,
    );
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await service.submitAnswer(USER_1, state.gameId, null);
    }
    // Q10: theme 10 is rejected as audio-less, the redraw
    // finds the pool drained, and the rejected song is dealt
    // rather than the game dying one question short.
    expect(last!.nextQuestion?.theme.slug).toBe('anime-10-op1-10010');
    expect(last!.nextQuestion?.theme.audioUrl).toBeNull();
  });

  it('the playback-started pre-draw honours the rule — the promotion serves the redrawn question', async () => {
    const { service } = makeMixedService([2]);
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    expect(state.question?.theme.slug).toBe('anime-1-op1-1001');
    // The pre-draw samples theme 2 first: audio-less, so it is
    // rejected and theme 3 is drawn — the reveal carries theme
    // 3's .ogg, NOT null (theme 2 has no audio to reveal).
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(signal.nextAudioUrl).toBe(oggOf(3));
    // …and the answer promotes that very question.
    const res = await service.submitAnswer(USER_1, state.gameId, null);
    expect(res.nextQuestion?.theme.slug).toBe('anime-3-op1-1003');
    expect(res.nextQuestion?.theme.audioUrl).toBe(oggOf(3));
  });
});

describe('SoloQuizService — earlier reveal (part 5, 2026-11-11)', () => {
  const oggOf = (i: number) => `https://a.animethemes.moe/Anime${i}-OP1.ogg`;

  /** Derivable AnimeThemes catalogue, no probe injected (the
      no-op probe keeps every song; verification is part 7's
      concern, not this suite's). */
  function makeRevealService() {
    const models = makeFakeModels();
    models.themes.forEach((t, idx) => {
      t.audioUrl = null;
      t.videoUrl = `https://v.animethemes.moe/Anime${idx + 1}-OP1.webm`;
    });
    const service = new SoloQuizService(
      models.themeModel as never,
      models.attemptModel as never,
      models.userModel as never,
      models.watchHistoryModel as never,
    );
    return { service, models };
  }

  function sessionOf(service: SoloQuizService, gameId: string) {
    const sessions = (
      service as unknown as {
        sessions: Map<
          string,
          {
            current: {
              theme: { slug: string };
              startedAt: Date;
              playbackStartedAt: Date | null;
            } | null;
            next: { theme: { slug: string } } | null;
          }
        >;
      }
    ).sessions;
    return sessions.get(gameId)!;
  }

  it('the playback-start signal returns the NEXT question’s audio URL', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(typeof signal.playbackStartedAt).toBe('string');
    expect(signal.nextAudioUrl).toBe(oggOf(2));
    // Audio only: the response carries no options or theme data.
    expect(Object.keys(signal).sort()).toEqual(
      ['nextAudioUrl', 'playbackStartedAt'].sort(),
    );
  });

  it('a repeated signal returns the same stamp and the same next audio', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const first = await service.markPlaybackStarted(USER_1, state.gameId);
    const second = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(second.playbackStartedAt).toBe(first.playbackStartedAt);
    expect(second.nextAudioUrl).toBe(first.nextAudioUrl);
    // The next question was drawn once, not per signal.
    expect(sessionOf(service, state.gameId).next?.theme.slug).toBe(
      'anime-2-op1-1002',
    );
  });

  it('the revealed question is the one the answer serves next', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    const res = await service.submitAnswer(USER_1, state.gameId, null);
    expect(res.nextQuestion?.theme.slug).toBe('anime-2-op1-1002');
    expect(res.nextQuestion?.theme.audioUrl).toBe(signal.nextAudioUrl);
    expect(sessionOf(service, state.gameId).next).toBeNull();
  });

  it('the pre-drawn question is measured from its promotion, not its draw', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    const signalledAt = Date.parse(signal.playbackStartedAt);
    // Time passes while Q1 plays; Q2 was already drawn (that is
    // the point of the reveal) — but its clock must not start
    // until the answer promotes it.
    await new Promise((r) => setTimeout(r, 1100));
    await service.submitAnswer(USER_1, state.gameId, null);
    const current = sessionOf(service, state.gameId).current!;
    expect(current.theme.slug).toBe('anime-2-op1-1002');
    expect(current.startedAt.getTime()).toBeGreaterThan(signalledAt + 1000);
    expect(current.playbackStartedAt).toBeNull();
  });

  it('a fully signalled game still deals 10 distinct questions', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const dealt: string[] = [];
    let last = null;
    for (let i = 0; i < 10; i++) {
      await service.markPlaybackStarted(USER_1, state.gameId);
      last = await service.submitAnswer(USER_1, state.gameId, null);
      dealt.push(last.reveal.slug);
    }
    expect(last!.gameOver).toBe(true);
    expect(new Set(dealt).size).toBe(10);
  });

  it('on the last question the signal reveals nothing (null)', async () => {
    const { service } = makeRevealService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    for (let i = 0; i < 9; i++) {
      await service.submitAnswer(USER_1, state.gameId, null);
    }
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(signal.nextAudioUrl).toBeNull();
  });

  it('a theme with no resolvable audio reveals null, not a video link', async () => {
    const { service, models } = makeService();
    // Stage the audio-less corner explicitly (factory default
    // is the derivable common case): stored "audio" is a video
    // link and nothing derives. Under the ogg-only rule
    // (2026-11-12) Q1 deals through the redraw-cap hatch and
    // the pre-draw honours the rule too — the dealt next
    // question still has NO audio to reveal, and the reveal
    // must not invent a candidate from its video link.
    models.themes.forEach((t, idx) => {
      t.videoUrl = `https://video/${idx + 1}.webm`;
      t.audioUrl = `https://audio/${idx + 1}.webm`;
    });
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    const signal = await service.markPlaybackStarted(USER_1, state.gameId);
    expect(signal.nextAudioUrl).toBeNull();
  });
});

describe('SoloQuizService — personal-pool options (owner ruling, 2026-11-12)', () => {
  /* Fixtures: personal themes carry 'Mine …' values and are NOT
     popular; popular sentinels carry 'Popular …' values and are
     never in a personal pool. The fake $sample takes the first N
     matches in array order, so option composition is exact. */
  function personalTheme(id: string, n: number, extra: Record<string, unknown> = {}) {
    return {
      _id: id,
      slug: `${id}-slug`,
      songTitle: `Mine Song ${n}`,
      animeTitle: `Mine Anime ${n}`,
      animeTitleEnglish: `Mine Anime ${n} EN`,
      animeTitleAlternative: [],
      artistName: `Mine Artist ${n}`,
      anilistId: 5000 + n,
      animeCoverImage: null,
      animeCoverImageSmall: null,
      type: 'OP',
      sequence: 1,
      entries: [{ atEntryId: 7000 + n }],
      videoUrl: `https://v.animethemes.moe/Mine${n}-OP1.webm`,
      audioUrl: null,
      isPopular: false,
      ...extra,
    };
  }

  function popularTheme(id: string, n: number, extra: Record<string, unknown> = {}) {
    return {
      ...personalTheme(id, n, extra),
      songTitle: `Popular Song ${n}`,
      animeTitle: `Popular Anime ${n}`,
      animeTitleEnglish: `Popular Anime ${n} EN`,
      artistName: `Popular Artist ${n}`,
      anilistId: 9000 + n,
      videoUrl: `https://v.animethemes.moe/Popular${n}-OP1.webm`,
      isPopular: true,
    };
  }

  const valueOf = (t: Record<string, unknown>, quizType: string): string =>
    quizType === 'anime'
      ? (t.animeTitleEnglish as string)
      : quizType === 'title'
        ? (t.songTitle as string)
        : (t.artistName as string);

  /** Plays a full game (skipping every question) and returns
      each served question's options with its correct value. */
  async function playGame(
    service: SoloQuizService,
    gameId: string,
    firstOptions: string[],
  ): Promise<{ options: string[]; correctValue: string }[]> {
    const seen: { options: string[]; correctValue: string }[] = [];
    let options = firstOptions;
    for (let i = 0; i < 10; i++) {
      const res = await service.submitAnswer(USER_1, gameId, null);
      seen.push({ options, correctValue: res.correctValue });
      if (res.gameOver) break;
      options = res.nextQuestion!.options;
    }
    return seen;
  }

  function seedCatalogue(
    models: ReturnType<typeof makeFakeModels>,
    docs: Record<string, unknown>[],
  ) {
    models.themeModel.docs.splice(0, models.themeModel.docs.length, ...docs);
  }

  function seedPool(
    models: ReturnType<typeof makeFakeModels>,
    source: 'anilist' | 'listened',
    personal: Record<string, unknown>[],
  ) {
    if (source === 'listened') {
      for (const t of personal) {
        models.history.push({ userId: USER_1, themeId: t._id });
      }
    } else {
      const user = models.users.find((u) => u._id === USER_1)!;
      (user.anilist as { completedMediaIds: number[] }).completedMediaIds =
        personal.map((t) => t.anilistId as number);
    }
  }

  it.each([
    ['anilist', 'anime'],
    ['anilist', 'title'],
    ['anilist', 'artist'],
    ['listened', 'anime'],
    ['listened', 'title'],
    ['listened', 'artist'],
  ] as const)(
    'pin 1 — %s × %s: every option comes from the personal pool when it can supply 3',
    async (source, quizType) => {
      const { service, models } = makeService();
      const popular = Array.from({ length: 6 }, (_, i) =>
        popularTheme(`pop-${i + 1}`, i + 1),
      );
      const personal = Array.from({ length: 12 }, (_, i) =>
        personalTheme(`mine-${i + 1}`, i + 1),
      );
      // Sentinels first: any accidental popular draw is visible.
      seedCatalogue(models, [...popular, ...personal]);
      seedPool(models, source, personal);

      const personalValues = new Set(personal.map((t) => valueOf(t, quizType)));
      const popularValues = new Set(popular.map((t) => valueOf(t, quizType)));

      const state = await service.createGame(USER_1, { quizType, source });
      const seen = await playGame(service, state.gameId, state.question!.options);
      expect(seen).toHaveLength(10);
      for (const q of seen) {
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options).size).toBe(4); // D2: no duplicates
        expect(q.options).toContain(q.correctValue);
        for (const option of q.options) {
          expect(popularValues.has(option)).toBe(false);
          expect(personalValues.has(option)).toBe(true);
        }
      }
    },
  );

  it('pin 2 — random games still draw every distractor from the popular pool', async () => {
    const { service, models } = makeService();
    const hidden = Array.from({ length: 4 }, (_, i) =>
      personalTheme(`hidden-${i + 1}`, i + 1),
    );
    const popular = Array.from({ length: 12 }, (_, i) =>
      popularTheme(`pop-${i + 1}`, i + 1),
    );
    // Non-popular themes first: both draws must skip them.
    seedCatalogue(models, [...hidden, ...popular]);

    const state = await service.createGame(USER_1, { quizType: 'anime' });
    let options = state.question!.options;
    for (let i = 0; i < 3; i++) {
      expect(options).toHaveLength(4);
      for (const option of options) {
        expect(option.startsWith('Popular Anime')).toBe(true);
        expect(option.startsWith('Mine Anime')).toBe(false);
      }
      const res = await service.submitAnswer(USER_1, state.gameId, null);
      options = res.nextQuestion!.options;
    }
  });

  it('pin 3 — small pool: 2 personal values + exactly 1 popular fill, 4 distinct', async () => {
    const { service, models } = makeService();
    const mk = (id: string, anime: string, n: number) => ({
      ...personalTheme(id, n),
      animeTitle: anime,
      animeTitleEnglish: `${anime} EN`,
    });
    const personal = [
      mk('pa-1', 'Pool A', 1),
      mk('pa-2', 'Pool A', 2),
      mk('pa-3', 'Pool A', 3),
      mk('pa-4', 'Pool A', 4),
      mk('pb-1', 'Pool B', 5),
      mk('pb-2', 'Pool B', 6),
      mk('pb-3', 'Pool B', 7),
      mk('pc-1', 'Pool C', 8),
      mk('pc-2', 'Pool C', 9),
      mk('pc-3', 'Pool C', 10),
    ];
    const popular = Array.from({ length: 5 }, (_, i) =>
      popularTheme(`pop-${i + 1}`, i + 1),
    );
    seedCatalogue(models, [...personal, ...popular]);
    seedPool(models, 'listened', personal);

    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'listened',
    });
    // Q1's correct theme is Pool A's first theme; the pool can
    // only offer Pool B + Pool C as wrong anime — the third
    // distractor is the popular fill (D1), never a duplicate.
    expect(new Set(state.question!.options).size).toBe(4);
    expect([...state.question!.options].sort()).toEqual(
      ['Pool A EN', 'Pool B EN', 'Pool C EN', 'Popular Anime 1 EN'].sort(),
    );

    const seen = await playGame(service, state.gameId, state.question!.options);
    expect(seen).toHaveLength(10);
    for (const q of seen) {
      expect(new Set(q.options).size).toBe(4);
    }
  });

  it('pin 4 — zero-yield pool (one anime, anime type): all 3 distractors are the popular fill and the game completes', async () => {
    const { service, models } = makeService();
    const personal = Array.from({ length: 10 }, (_, i) => ({
      ...personalTheme(`solo-${i + 1}`, i + 1),
      animeTitle: 'Solo Anime',
      animeTitleEnglish: 'Solo Anime EN',
      anilistId: 6001,
    }));
    const popular = Array.from({ length: 5 }, (_, i) =>
      popularTheme(`pop-${i + 1}`, i + 1),
    );
    seedCatalogue(models, [...personal, ...popular]);
    seedPool(models, 'anilist', personal);

    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'anilist',
    });
    expect([...state.question!.options].sort()).toEqual(
      [
        'Solo Anime EN',
        'Popular Anime 1 EN',
        'Popular Anime 2 EN',
        'Popular Anime 3 EN',
      ].sort(),
    );

    const seen = await playGame(service, state.gameId, state.question!.options);
    expect(seen).toHaveLength(10); // D1: the game never refuses
    for (const q of seen) {
      expect(q.correctValue).toBe('Solo Anime EN');
      expect(
        q.options.filter((o) => o.startsWith('Popular Anime')),
      ).toHaveLength(3);
    }
  });

  it('pin 5 — dedup: a pool of 2 artists yields 4 distinct options for artist games', async () => {
    const { service, models } = makeService();
    const personal = Array.from({ length: 10 }, (_, i) => ({
      ...personalTheme(`art-${i + 1}`, i + 1),
      artistName: i < 4 ? 'Pool Artist A' : 'Pool Artist B',
    }));
    const popular = Array.from({ length: 5 }, (_, i) =>
      popularTheme(`pop-${i + 1}`, i + 1),
    );
    seedCatalogue(models, [...personal, ...popular]);
    seedPool(models, 'listened', personal);

    const state = await service.createGame(USER_1, {
      quizType: 'artist',
      source: 'listened',
    });
    // Q1's correct artist is A; the pool's only other artist is
    // B (six themes of it) — without dedup the options would be
    // B, B, B. Instead: B once + two popular fills.
    expect([...state.question!.options].sort()).toEqual(
      ['Pool Artist A', 'Pool Artist B', 'Popular Artist 1', 'Popular Artist 2'].sort(),
    );
  });

  it('pin 6 — earlier questions’ themes may reappear as later distractor values (D3)', async () => {
    const { service, models } = makeService();
    const personal = Array.from({ length: 12 }, (_, i) =>
      personalTheme(`mine-${i + 1}`, i + 1),
    );
    seedCatalogue(models, personal);
    seedPool(models, 'listened', personal);

    const state = await service.createGame(USER_1, {
      quizType: 'title',
      source: 'listened',
    });
    const first = await service.submitAnswer(USER_1, state.gameId, null);
    expect(first.correctValue).toBe('Mine Song 1');
    // Question 2's correct theme is mine-2; mine-1 is NOT
    // excluded from its distractor sample, so Q1's song title
    // shows up as a wrong option.
    expect(first.nextQuestion!.options).toContain('Mine Song 1');
    const second = await service.submitAnswer(USER_1, state.gameId, null);
    expect(second.correctValue).toBe('Mine Song 2');
  });

  it('pin 7 — no-.ogg pool themes still supply their values as distractors', async () => {
    const { service, models } = makeService();
    const noOgg = (id: string, n: number) => ({
      ...personalTheme(id, n),
      animeTitle: `NoOgg Anime ${n}`,
      animeTitleEnglish: `NoOgg Anime ${n} EN`,
      // Non-derivable video + a stored video link as "audio":
      // nothing resolves, so this theme can never be dealt as
      // a question under the ogg-only rule.
      videoUrl: `https://video/noogg${n}.webm`,
      audioUrl: `https://audio/noogg${n}.webm`,
    });
    const dealable = Array.from({ length: 10 }, (_, i) =>
      personalTheme(`mine-${i + 1}`, i + 1),
    );
    const personal = [
      dealable[0],
      noOgg('noogg-1', 1),
      noOgg('noogg-2', 2),
      ...dealable.slice(1),
    ];
    seedCatalogue(models, personal);
    seedPool(models, 'listened', personal);

    const state = await service.createGame(USER_1, {
      quizType: 'anime',
      source: 'listened',
    });
    expect(state.question!.options).toContain('NoOgg Anime 1 EN');
    expect(state.question!.options).toContain('NoOgg Anime 2 EN');

    // The full game still completes on the 10 dealable themes.
    const seen = await playGame(service, state.gameId, state.question!.options);
    expect(seen).toHaveLength(10);
  });
});

describe('SoloQuizService — leaderboard (web route)', () => {
  it('returns the top 10 by score with authors populated', async () => {
    const { service, models } = makeService();
    for (let i = 0; i < 12; i++) {
      models.attempts.push({
        _id: `seed-${i}`,
        userId: i % 3 === 0 ? null : USER_1,
        themeSlug: 'anime-1-op1-1001',
        atEntryId: 5001,
        quizType: 'anime',
        correct: true,
        timeTaken: 1,
        score: 100 - i,
        streak: 1,
        createdAt: new Date(),
      });
    }
    const board = await service.leaderboard();
    expect(board.entries).toHaveLength(10);
    expect(board.entries[0].score).toBe(100);
    expect(board.entries[0].author).toBeNull(); // anonymous web attempt
    expect(board.entries[1].author?.username).toBe('alice');
    expect(board.entries.map((e) => e.score)).toEqual(
      [...board.entries.map((e) => e.score)].sort((a, b) => b - a),
    );
  });
});
