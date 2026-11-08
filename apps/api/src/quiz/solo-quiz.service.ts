import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  SOLO_QUESTION_COUNT,
  SOLO_TIME_LIMIT_SECONDS,
  type CreateSoloGameRequest,
  type QuizGuessType,
  type QuizLeaderboardEntry,
  type QuizLeaderboardResponse,
  type SoloAnswerResponse,
  type SoloGameState,
  type SoloQuestion,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { resolveAudioUrl } from '../themes/audio-url';
import { QuizAttempt, type QuizAttemptDocument } from './quiz-attempt.schema';
import {
  buildSoloOptions,
  distractorFilterFor,
  getThemeValue,
  secondsRemainingAt,
  soloScoreFor,
  type QuizThemeLike,
} from './quiz-game.utils';

/** The web's library-mode minimum (question route: totalInLibrary < 10). */
const LIBRARY_MIN_THEMES = 10;

/** Idle solo games are dropped after this long (in-process sessions). */
const SESSION_TTL_MS = 30 * 60 * 1000;

const QUIZ_TYPES: QuizGuessType[] = ['anime', 'title', 'artist'];

/** The fields of a theme document the solo quiz reads. */
type ThemeDoc = ThemeCache &
  QuizThemeLike & {
    _id: unknown;
    slug: string;
    videoUrl: string;
    audioUrl: string | null;
    animeCoverImage: string | null;
    animeCoverImageSmall: string | null;
    type: string;
    sequence: number;
    entries: { atEntryId: number }[];
  };

interface SoloSession {
  userId: string;
  quizType: QuizGuessType;
  source: 'random' | 'library';
  /** The library $or pool, resolved once at game creation. */
  poolOr: Record<string, unknown>[] | null;
  usedThemeIds: string[];
  answeredCount: number;
  correctCount: number;
  streak: number;
  totalScore: number;
  current: {
    theme: ThemeDoc;
    options: string[];
    correctValue: string;
    startedAt: Date;
    index: number;
  } | null;
  lastTouchedAt: number;
}

interface SoloModels {
  themes: Model<ThemeCacheDocument>;
  attempts: Model<QuizAttemptDocument>;
  users: Model<UserDocument>;
  watchHistory: Model<WatchHistoryDocument>;
}

/**
 * Solo quiz (Slice S4) — a port of the web's solo game
 * (GET /api/quiz/question + POST /api/quiz/submit +
 * app/quiz/QuizClient.tsx) with ONE deliberate architectural
 * change, flagged here and in the slice report:
 *
 * THE WEB'S TRUST MODEL IS TOTAL CLIENT TRUST. Its question
 * response ships the full theme AND the correct answer; the
 * browser times itself, computes the score with
 * `ceil(secondsRemaining * (1 + streak * 0.1))`, and POSTs the
 * finished attempt { correct, timeTaken, score, streak }, which
 * the server stores verbatim. Anyone can forge a leaderboard
 * score there. This API keeps the web's game rules EXACTLY —
 * 10 questions, 20s timer, the same pool filters, the same
 * option derivation, the same scoring formula, the same
 * QuizAttempt persistence shape — but holds the game server-side:
 * questions never carry the answer, answers are timed by the
 * server clock (the multiplayer route's own measurement), and
 * the persisted attempts are computed, not reported.
 *
 * Game rules as ported:
 * - Pools (question route): themes need a playable videoUrl;
 *   'artist'/'title' questions additionally require the guessed
 *   field to be non-empty/non-'Unknown'. 'random' draws from
 *   isPopular themes; 'library' draws from the union of the
 *   player's WatchHistory themes and their AniList-completed
 *   anime (stored completedMediaIds), and requires at least 10
 *   eligible themes — the web's two 400 messages are verbatim.
 * - Options: the correct value + exactly 3 distractors sampled
 *   from the popular pool (the solo route's derivation, without
 *   the room generator's dedup), shuffled.
 * - Scoring (QuizClient): correct → ceil(secondsRemaining *
 *   (1 + streak * 0.1)) with the streak counted BEFORE the
 *   answer; wrong/skip/timeout → 0 and the streak resets.
 *   timeTaken = 20 − secondsRemaining (20 on skip/timeout).
 * - Every answer persists one QuizAttempt (the web persists per
 *   question, not per game — its leaderboard ranks single
 *   questions). atEntryId is the theme's first entry, as the
 *   web client sends it.
 *
 * Deviations from the web, all flagged:
 * 1. Server-held sessions (above) instead of client trust.
 *    Sessions live in-process (single-instance API); a restart
 *    drops live games. The web's stateless design has no such
 *    failure mode — accepted trade for answer secrecy.
 * 2. Themes are not repeated within a game (the session samples
 *    with the question route's own excludeIds mechanism, which
 *    the web client simply never uses).
 * 3. The library pool does NOT live-refresh the player's
 *    AniList completed list from the AniList GraphQL API when
 *    the stored list is stale (the web refreshes after 6h and
 *    writes completedMediaIds/syncedAt back). That sync stays
 *    web-owned — this API reads the stored list rather than
 *    becoming a second writer of it.
 * 4. Games require auth (the attempts and library pool are
 *    per-user; the web's anonymous attempts — userId null —
 *    remain possible only from the web).
 *
 * Models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503.
 */
@Injectable()
export class SoloQuizService {
  private readonly sessions = new Map<string, SoloSession>();
  private sessionSeq = 0;

  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(QuizAttempt.name)
    private readonly attemptModel?: Model<QuizAttemptDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly watchHistoryModel?: Model<WatchHistoryDocument>,
  ) {}

  private requireModels(): SoloModels {
    if (
      !this.themeModel ||
      !this.attemptModel ||
      !this.userModel ||
      !this.watchHistoryModel
    ) {
      throw new ServiceUnavailableException(
        'Quiz unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      themes: this.themeModel,
      attempts: this.attemptModel,
      users: this.userModel,
      watchHistory: this.watchHistoryModel,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Pool construction — the question route's filters.                 */
  /* ---------------------------------------------------------------- */

  private basePoolFilter(quizType: QuizGuessType): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      videoUrl: { $nin: [null, ''] },
    };
    if (quizType === 'artist') {
      filter.artistName = { $nin: [null, '', 'Unknown'] };
    } else if (quizType === 'title') {
      filter.songTitle = { $nin: [null, '', 'Unknown'] };
    }
    return filter;
  }

  /**
   * The web's library branch: WatchHistory theme ids OR AniList
   * completed media ids, with the ≥10 eligibility gate and the
   * web's exact error messages. Returns the $or clauses for the
   * session's pool.
   */
  private async buildLibraryPool(
    models: SoloModels,
    userId: string,
    quizType: QuizGuessType,
  ): Promise<Record<string, unknown>[]> {
    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const localThemeIds = (await models.watchHistory
      .distinct('themeId', { userId })
      .exec()) as unknown[];
    const anilistMediaIds: number[] = Array.isArray(user.anilist?.completedMediaIds)
      ? user.anilist.completedMediaIds
      : [];

    const orClauses: Record<string, unknown>[] = [];
    if (localThemeIds.length > 0) {
      orClauses.push({ _id: { $in: localThemeIds } });
    }
    if (anilistMediaIds.length > 0) {
      orClauses.push({ anilistId: { $in: anilistMediaIds } });
    }

    if (orClauses.length === 0) {
      throw new BadRequestException(
        'Your library is empty. Add themes or connect AniList to play in Watched mode.',
      );
    }

    const countFilter = {
      ...this.basePoolFilter(quizType),
      $or: orClauses,
    };
    const totalInLibrary = await models.themes
      .countDocuments(countFilter)
      .exec();
    if (totalInLibrary < LIBRARY_MIN_THEMES) {
      throw new BadRequestException(
        `You need at least 10 songs to use this mode. (Current: ${totalInLibrary})`,
      );
    }

    return orClauses;
  }

  /* ---------------------------------------------------------------- */
  /* Question drawing — the question route's sampling.                 */
  /* ---------------------------------------------------------------- */

  private async sampleOne(
    models: SoloModels,
    filter: Record<string, unknown>,
  ): Promise<ThemeDoc | null> {
    const [theme] = (await models.themes
      .aggregate([{ $match: filter }, { $sample: { size: 1 } }])
      .exec()) as ThemeDoc[];
    return theme ?? null;
  }

  private async drawQuestion(
    models: SoloModels,
    session: SoloSession,
  ): Promise<SoloQuestion> {
    const filter = this.basePoolFilter(session.quizType);
    if (session.source === 'random') {
      filter.isPopular = true;
    } else if (session.poolOr) {
      filter.$or = session.poolOr;
    }
    if (session.usedThemeIds.length > 0) {
      filter._id = { $nin: session.usedThemeIds };
    }

    const correctTheme = await this.sampleOne(models, filter);
    if (!correctTheme) {
      throw new NotFoundException('No themes found matching your library');
    }

    // Distractors: always from the popular pool (the web route).
    const distractors = (await models.themes
      .aggregate([
        { $match: distractorFilterFor(correctTheme, session.quizType) },
        { $sample: { size: 3 } },
      ])
      .exec()) as ThemeDoc[];

    const options = buildSoloOptions(correctTheme, session.quizType, distractors);
    const index = session.answeredCount + 1;
    session.current = {
      theme: correctTheme,
      options,
      correctValue: getThemeValue(correctTheme, session.quizType),
      startedAt: new Date(),
      index,
    };
    session.usedThemeIds.push(String(correctTheme._id));

    return {
      index,
      theme: {
        slug: correctTheme.slug,
        videoUrl: correctTheme.videoUrl,
        // Stored audio, else the derived .ogg twin (audio-url.ts):
        // most catalogue themes store no audioUrl, and the quiz's
        // audio candidate would otherwise be missing entirely.
        audioUrl: resolveAudioUrl(correctTheme.audioUrl, correctTheme.videoUrl),
        coverImage:
          correctTheme.animeCoverImage ?? correctTheme.animeCoverImageSmall ?? null,
        type: correctTheme.type,
        sequence: correctTheme.sequence,
      },
      options,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Game lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  private toState(gameId: string, session: SoloSession): SoloGameState {
    return {
      gameId,
      quizType: session.quizType,
      source: session.source,
      totalQuestions: SOLO_QUESTION_COUNT,
      timeLimitSeconds: SOLO_TIME_LIMIT_SECONDS,
      answeredCount: session.answeredCount,
      correctCount: session.correctCount,
      streak: session.streak,
      totalScore: session.totalScore,
      gameOver: session.current === null && session.answeredCount > 0,
      question: null, // filled by callers that hold the drawn question
    };
  }

  async createGame(
    userId: string,
    dto: CreateSoloGameRequest,
  ): Promise<SoloGameState> {
    const models = this.requireModels();
    const quizType = dto?.quizType;
    if (!QUIZ_TYPES.includes(quizType)) {
      throw new BadRequestException('Invalid quiz type');
    }
    const source = dto?.source ?? 'random';
    if (source !== 'random' && source !== 'library') {
      throw new BadRequestException('Invalid quiz source');
    }

    const session: SoloSession = {
      userId,
      quizType,
      source,
      poolOr:
        source === 'library'
          ? await this.buildLibraryPool(models, userId, quizType)
          : null,
      usedThemeIds: [],
      answeredCount: 0,
      correctCount: 0,
      streak: 0,
      totalScore: 0,
      current: null,
      lastTouchedAt: Date.now(),
    };

    const question = await this.drawQuestion(models, session);
    const gameId = `solo-${++this.sessionSeq}-${Date.now().toString(36)}`;
    this.sessions.set(gameId, session);
    this.sweepExpiredSessions();

    return { ...this.toState(gameId, session), question, gameOver: false };
  }

  async getGame(userId: string, gameId: string): Promise<SoloGameState> {
    this.requireModels();
    const session = this.findSession(userId, gameId);
    if (!session.current) {
      return { ...this.toState(gameId, session), gameOver: true };
    }
    // Re-serve the live question WITHOUT its start time changing:
    // the countdown runs from the original draw.
    return {
      ...this.toState(gameId, session),
      gameOver: false,
      question: {
        index: session.current.index,
        theme: {
          slug: session.current.theme.slug,
          videoUrl: session.current.theme.videoUrl,
          audioUrl: resolveAudioUrl(
            session.current.theme.audioUrl,
            session.current.theme.videoUrl,
          ),
          coverImage:
            session.current.theme.animeCoverImage ??
            session.current.theme.animeCoverImageSmall ??
            null,
          type: session.current.theme.type,
          sequence: session.current.theme.sequence,
        },
        options: session.current.options,
      },
    };
  }

  async submitAnswer(
    userId: string,
    gameId: string,
    answer: string | null,
  ): Promise<SoloAnswerResponse> {
    const models = this.requireModels();
    const session = this.findSession(userId, gameId);
    const current = session.current;
    if (!current) {
      throw new BadRequestException('Game already finished');
    }

    const now = new Date();
    const secondsRemaining = secondsRemainingAt(
      current.startedAt,
      SOLO_TIME_LIMIT_SECONDS,
      now,
    );
    // null (skip/timeout) is simply never the correct value — the
    // web encodes it as the '__SKIP__'/'__TIMEOUT__' sentinels and
    // scores it identically: wrong, full time taken.
    const correct = answer !== null && answer === current.correctValue;
    const scoreGained = soloScoreFor(correct, secondsRemaining, session.streak);
    const timeTaken =
      answer === null
        ? SOLO_TIME_LIMIT_SECONDS
        : SOLO_TIME_LIMIT_SECONDS - secondsRemaining;

    session.streak = correct ? session.streak + 1 : 0;
    if (correct) session.correctCount += 1;
    session.totalScore += scoreGained;
    session.answeredCount += 1;
    session.lastTouchedAt = Date.now();

    // Persist the attempt exactly as the web's submit stores it
    // (values computed here instead of reported by the client).
    await models.attempts.create({
      userId,
      themeSlug: current.theme.slug,
      atEntryId: current.theme.entries?.[0]?.atEntryId ?? 0,
      quizType: session.quizType,
      correct,
      timeTaken,
      score: scoreGained,
      streak: session.streak,
    });

    const gameOver = session.answeredCount >= SOLO_QUESTION_COUNT;
    let nextQuestion: SoloQuestion | null = null;
    if (gameOver) {
      session.current = null;
    } else {
      nextQuestion = await this.drawQuestion(models, session);
    }

    return {
      correct,
      correctValue: current.correctValue,
      scoreGained,
      secondsRemaining,
      streak: session.streak,
      totalScore: session.totalScore,
      correctCount: session.correctCount,
      answeredCount: session.answeredCount,
      gameOver,
      reveal: {
        slug: current.theme.slug,
        animeTitle: current.theme.animeTitle ?? 'Unknown Anime',
        animeTitleEnglish: current.theme.animeTitleEnglish ?? null,
        songTitle: current.theme.songTitle ?? 'Unknown Song',
        artistName: current.theme.artistName ?? null,
        coverImage:
          current.theme.animeCoverImage ??
          current.theme.animeCoverImageSmall ??
          null,
      },
      nextQuestion,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Leaderboard — the web's GET /api/quiz/leaderboard.                */
  /* ---------------------------------------------------------------- */

  async leaderboard(type?: string): Promise<QuizLeaderboardResponse> {
    const models = this.requireModels();
    const filter: Record<string, unknown> = {};
    if (type) {
      if (!QUIZ_TYPES.includes(type as QuizGuessType)) {
        throw new BadRequestException('Invalid quiz type');
      }
      filter.quizType = type;
    }

    const docs = (await models.attempts
      .find(filter)
      .sort({ score: -1 })
      .limit(10)
      .lean()
      .exec()) as (QuizAttempt & {
      _id: unknown;
      userId: unknown;
      createdAt?: Date;
    })[];

    // The web populates userId → username/displayName/avatarUrl.
    const userIds = [...new Set(docs.map((d) => String(d.userId)))].filter(
      (id) => id !== 'null',
    );
    const authors = new Map<string, QuizLeaderboardEntry['author']>();
    if (userIds.length > 0) {
      const users = (await models.users
        .find({ _id: { $in: userIds } })
        .lean()
        .exec()) as (Pick<User, 'username' | 'displayName' | 'avatarUrl'> & {
        _id: unknown;
      })[];
      for (const u of users) {
        authors.set(String(u._id), {
          id: String(u._id),
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl ?? null,
        });
      }
    }

    return {
      entries: docs.map((d) => ({
        id: String(d._id),
        themeSlug: d.themeSlug,
        quizType: d.quizType as QuizGuessType,
        correct: d.correct,
        timeTaken: d.timeTaken,
        score: d.score,
        streak: d.streak,
        createdAt:
          d.createdAt instanceof Date
            ? d.createdAt.toISOString()
            : String(d.createdAt ?? ''),
        author: d.userId ? (authors.get(String(d.userId)) ?? null) : null,
      })),
    };
  }

  /* ---------------------------------------------------------------- */

  private findSession(userId: string, gameId: string): SoloSession {
    const session = this.sessions.get(gameId);
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Game not found');
    }
    return session;
  }

  private sweepExpiredSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastTouchedAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }
}
