import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    videoUrl: `https://video/${i}.webm`,
    audioUrl: `https://audio/${i}.webm`,
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
    const { service } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    // Factory themes store https://audio/<i>.webm — a video LINK —
    // with a non-AnimeThemes video URL, so nothing derives and the
    // stored value is not audio: it must NOT be served as the
    // question's audio. (This expectation previously enshrined the
    // old "stored always wins" rule; the client's audio-only last
    // resort is the question's videoUrl, which stays intact.)
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

  it('wrong answers score 0 and reset the streak; skips take the full 20s', async () => {
    const { service, models } = makeService();
    const state = await service.createGame(USER_1, { quizType: 'anime' });
    await service.submitAnswer(USER_1, state.gameId, 'Anime 1 EN');

    const wrong = await service.submitAnswer(USER_1, state.gameId, 'Anime 3 EN');
    expect(wrong.correct).toBe(false);
    expect(wrong.scoreGained).toBe(0);
    expect(wrong.streak).toBe(0);

    const skipped = await service.submitAnswer(USER_1, state.gameId, null);
    expect(skipped.correct).toBe(false);
    expect(models.attempts[2]).toMatchObject({ correct: false, timeTaken: 20, score: 0 });
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
