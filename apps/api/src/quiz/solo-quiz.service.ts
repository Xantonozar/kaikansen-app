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
  SOLO_SPARE_COUNT,
  SOLO_TIME_LIMIT_SECONDS,
  type CreateSoloGameRequest,
  type QuizGuessType,
  type QuizLeaderboardEntry,
  type QuizLeaderboardResponse,
  type QuizSource,
  type SoloAnswerResponse,
  type SoloGameState,
  type SoloPlaybackStartedResponse,
  type SoloQuestion,
  type SoloReplaceResponse,
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
import {
  NOOP_QUIZ_HEAD_WARMER,
  QuizHeadCacheService,
  type QuizHeadWarmer,
} from '../quiz-heads/quiz-heads.service';
import {
  HttpAudioProbe,
  UNKNOWN_AUDIO_PROBE,
  type AudioProbe,
  type AudioProbeResult,
} from './audio-probe';
import { QuizAttempt, type QuizAttemptDocument } from './quiz-attempt.schema';
import { RankService } from './rank.service';
import {
  buildSoloOptions,
  distractorFilterFor,
  distinctDistractorValues,
  effectiveQuestionStart,
  getThemeValue,
  secondsRemainingAt,
  shuffle,
  soloScoreFor,
  type QuizThemeLike,
} from './quiz-game.utils';

/**
 * The named pools' minimum (the web question route's library
 * gate: totalInLibrary < 10 refuses the game). Both owner pools
 * keep the same ≥10 eligibility rule.
 */
const POOL_MIN_THEMES = 10;

/** Idle solo games are dropped after this long (in-process sessions). */
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Verified dealing (total solution part 7, 2026-11-11): the
 * wall-clock budget for ALL probing inside ONE question draw,
 * and how many definite-404 candidates a single draw may reject
 * before it deals the next one unverified. The budget is a hard
 * cap, not a target: probes pass only their remaining share of
 * it as their timeout, and once it is spent the draw proceeds
 * unverified — game flow never hangs on verification.
 */
const VERIFY_BUDGET_MS = 1000;
const VERIFY_MAX_REDRAWS = 3;

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

/**
 * One fully drawn question that is not live yet: the theme,
 * its shuffled options, and the withheld correct value. Held
 * by the session as the pre-drawn NEXT question (part 5) until
 * it is committed as current — its measurement stamps are only
 * taken at commit time, never at draw time.
 */
interface DrawnQuestion {
  theme: ThemeDoc;
  options: string[];
  correctValue: string;
}

interface SoloSession {
  userId: string;
  quizType: QuizGuessType;
  source: QuizSource;
  /** The named pool's $or clauses, resolved once at game creation. */
  poolOr: Record<string, unknown>[] | null;
  usedThemeIds: string[];
  /**
   * The pre-drawn next question (part 5): drawn when the live
   * question's playback-start signal arrives, so its audio can
   * be revealed — and preloaded — during the current question.
   * Promoted to `current` by the next answer. Null when not
   * drawn yet (the answer then draws on the spot, as before).
   */
  next: DrawnQuestion | null;
  /**
   * Failed-playback replacements left (owner order, 2026-11-16):
   * the game holds SOLO_SPARE_COUNT spares; replaceFailedQuestion
   * spends one to swap a live question whose theme could not be
   * played at all. The spare theme is drawn from the game's own
   * pool AT REPLACEMENT TIME (the same verified sampler as any
   * draw), so an unused spare never disturbs the game's order.
   */
  sparesRemaining: number;
  /**
   * Solo RP (owner order, 2026-11-16): the rank application for
   * this finished game, applied exactly once at game over. Null
   * until then — and stays null when the rank write was
   * unavailable, in which case the answer reports rpChange null.
   */
  soloRp: { rpChange: number; rpAfter: number } | null;
  answeredCount: number;
  correctCount: number;
  streak: number;
  totalScore: number;
  current: {
    theme: ThemeDoc;
    options: string[];
    correctValue: string;
    startedAt: Date;
    /**
     * When the client reported the question's audio actually
     * starting (or known-unplayable) — the answer window opens at
     * startedAt + the credited load (see markPlaybackStarted).
     * Null until signalled; the measurement then falls back to
     * the draw time, as before this change.
     */
    playbackStartedAt: Date | null;
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
 *   isPopular themes. The two NAMED pools are the owner's Solo
 *   Run picker (spec 2026-11-10), splitting what the web's
 *   single 'library' source unioned: 'anilist' draws from the
 *   themes of the anime on the player's AniList Watching +
 *   Completed lists (the stored merged completedMediaIds — the
 *   same set the Library AniList segment serves), and 'listened'
 *   draws from the player's in-app listening history
 *   (WatchHistory). Both keep the web library branch's ≥10
 *   eligible-themes gate, with pool-specific empty/thin
 *   messages.
 * - Options: the correct value + exactly 3 distractors sampled
 *   from the popular pool (the solo route's derivation, without
 *   the room generator's dedup), shuffled.
 * - Scoring (QuizClient): correct → ceil(secondsRemaining *
 *   (1 + streak * 0.1)) with the streak counted BEFORE the
 *   answer; the streak resets on any non-correct answer.
 *   timeTaken = 20 − secondsRemaining (20 on skip/timeout).
 *   NEGATIVE MARKING (owner ruling, 2026-11-12 — supersedes
 *   the web's and the frozen 2026-11-10 'wrong = 0'): a wrong
 *   SUBMITTED answer scores −half of what a correct answer
 *   would have earned at that moment, rounded up; skip/timeout
 *   (no submission) still scores 0. The persisted attempt and
 *   the session total take the negative value — totals may go
 *   below zero, no floor.
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
 * 3. The AniList pool does NOT live-refresh the player's
 *    AniList lists from the AniList GraphQL API when the stored
 *    list is stale (the web refreshes after 6h and writes
 *    completedMediaIds/syncedAt back). That sync stays
 *    web-owned — this API reads the stored list rather than
 *    becoming a second writer of it.
 * 4. Games require auth (the attempts and the named pools are
 *    per-user; the web's anonymous attempts — userId null —
 *    remain possible only from the web).
 * 5. The answer window opens at PLAYBACK start, not at the draw
 *    (owner report, 2026-11-10: the async audio load was eating
 *    the player's 20s on both the client's ring and this
 *    measurement). The client signals the moment via
 *    markPlaybackStarted; the stamp is taken on this server's
 *    clock and the credited load is capped
 *    (SOLO_LOAD_CREDIT_CAP_MS), so the change removes load
 *    latency from the measurement without handing the client a
 *    number to forge. No signal → measured from the draw, as
 *    before. The web measures in the browser entirely, so it
 *    has no equivalent either way.
 * 6. Verified dealing (total solution part 7, 2026-11-11): a
 *    dealt question's derived .ogg is range-probed before it is
 *    served; a definite 404 redraws the question from the same
 *    pool, while any doubt (timeout, network, budget spent)
 *    keeps the song. The web serves whatever it samples; the
 *    ~3% of themes whose AnimeThemes audio twin does not exist
 *    (the derived address 404s) otherwise burn the client's
 *    first candidate and dump it onto a 40–60 MB video fallback.
 *    The probe verdicts are cached in memory only (audio-probe
 *    .ts) — nothing is written to the shared database.
 * 7. Earlier reveal (total solution part 5, 2026-11-11): the
 *    next question is pre-drawn at the live question's
 *    playback-start signal and its audio URL rides the signal's
 *    response, so the client preloads during the current
 *    question instead of only the feedback pause. The web has
 *    no server-held game, hence no equivalent. The pre-drawn
 *    question is measured from its promotion (the answer), not
 *    its draw — preload time is never answer time.
 * 8. Ogg-only pool (owner ruling, 2026-11-12): solo deals
 *    ONLY themes with a resolvable .ogg. A theme whose audio
 *    does not resolve at all takes the definite-missing path
 *    in sampleVerifiedCandidate exactly like a probed 404
 *    (point 6) — excluded, redrawn under the same cap, dealt
 *    only via the fill-don't-fail hatch. This supersedes part
 *    7's "unresolvable audio deals as before": such themes
 *    otherwise reach the client with nothing but a video file
 *    to play, which is also the habitat of the video-leg
 *    clock bug fixed on the client the same day. Every solo
 *    draw funnels through the one sampler (creation, the
 *    answer-time draw, and the point-7 pre-draw the answer
 *    promotes), so the rule holds for the whole game. Rooms
 *    dealing is deliberately NOT changed (its sampler keeps
 *    the web's shape; the same widening there is a separate
 *    owner decision).
 *
 * 9. Phase 2 head warming (2026-11-12): dealt themes are
 *    warmed into the API's own head cache (quiz-heads) at the
 *    deal points, so the client's quiz slices and first player
 *    candidate can be served by the API instead of the Europe
 *    origin. Purely a serving optimisation: no response field
 *    changes (the client derives the head URL by rule), no
 *    database writes, and a cold or lost cache degrades to
 *    exactly the pre-phase-2 origin chain.
 * 10. Spare themes + solo RP (owner orders, 2026-11-16 — no web
 *    equivalent; the web has no server-held game to hang either
 *    on): (a) each game holds SOLO_SPARE_COUNT replacements —
 *    when the client's whole candidate chain for the live
 *    question fails, it calls replaceFailedQuestion and the
 *    question is swapped for a fresh draw from the same pool,
 *    same slot, no attempt recorded; (b) a finished solo game
 *    grants RP through RankService.applySoloRP, tiered by
 *    correct count (soloRpForCorrectCount) — this supersedes
 *    the owner's own 2026-11-09 solo-no-RP ruling.
 *
 * Models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503.
 */
@Injectable()
export class SoloQuizService {
  private readonly sessions = new Map<string, SoloSession>();
  private sessionSeq = 0;
  /**
   * Games with a spare-theme swap currently in flight (audit
   * round 2, 2026-11-16). A swap draws from the database, so two
   * calls racing for the same game could both draw and both
   * spend a spare for one visible swap. The first call claims
   * the game here synchronously (before its first await); a
   * second call is refused and its caller re-reads the game
   * state instead — the app already resyncs that way. A legit
   * follow-up swap is sequential by construction (it fires only
   * after the previous replacement is live and has failed), so
   * the lock never blocks real play.
   */
  private readonly swapsInFlight = new Set<string>();
  /**
   * The verified-dealing probe (part 7). Optional in DI: the
   * module registers the real HTTP probe; anywhere the service
   * is constructed without one (model-less boots, unit tests)
   * the no-op probe keeps every song, which is exactly the
   * pre-part-7 behaviour and never touches the network.
   */
  private readonly audioProbe: AudioProbe;

  /**
   * The phase 2 head warmer (2026-11-12). Optional in DI like
   * the probe: the module registers the real cache; anywhere
   * the service is constructed without one (model-less boots,
   * unit tests) the no-op warmer keeps behaviour identical to
   * before phase 2 — and never touches the network or disk.
   */
  private readonly headWarmer: QuizHeadWarmer;

  /**
   * The rank maintenance (solo RP, 2026-11-16). Optional in DI
   * like the probe and the warmer: the module registers it;
   * anywhere the service is constructed without one, solo games
   * simply grant no RP (the answer reports rpChange null) —
   * game flow never depends on the rank write.
   */
  private readonly rankService?: RankService;

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
    @Optional()
    httpAudioProbe?: HttpAudioProbe,
    @Optional()
    headCache?: QuizHeadCacheService,
    @Optional()
    rankService?: RankService,
  ) {
    this.audioProbe = httpAudioProbe ?? UNKNOWN_AUDIO_PROBE;
    this.headWarmer = headCache ?? NOOP_QUIZ_HEAD_WARMER;
    this.rankService = rankService;
  }

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
   * One named pool of the owner's Solo Run picker (spec
   * 2026-11-10), resolved to the $or clauses the draw samples
   * from:
   * - 'listened': the themes in the player's in-app listening
   *   history (WatchHistory theme ids);
   * - 'anilist': the themes of the anime on the player's
   *   AniList Watching + Completed lists — the stored
   *   completedMediaIds, which in this API hold the merged
   *   CURRENT + COMPLETED set (the same union the Library
   *   AniList segment serves).
   * Both keep the web library branch's ≥10 eligibility gate:
   * an empty pool and a thin pool each refuse with a clear,
   * pool-specific message — the game never silently falls back
   * to another pool.
   */
  private async buildNamedPool(
    models: SoloModels,
    userId: string,
    quizType: QuizGuessType,
    source: 'anilist' | 'listened',
  ): Promise<Record<string, unknown>[]> {
    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    let orClauses: Record<string, unknown>[] = [];
    if (source === 'listened') {
      const listenedThemeIds = (await models.watchHistory
        .distinct('themeId', { userId })
        .exec()) as unknown[];
      if (listenedThemeIds.length > 0) {
        orClauses = [{ _id: { $in: listenedThemeIds } }];
      }
    } else {
      const anilistMediaIds: number[] = Array.isArray(
        user.anilist?.completedMediaIds,
      )
        ? user.anilist.completedMediaIds
        : [];
      if (anilistMediaIds.length > 0) {
        orClauses = [{ anilistId: { $in: anilistMediaIds } }];
      }
    }

    if (orClauses.length === 0) {
      throw new BadRequestException(
        source === 'listened'
          ? 'Your listening history is empty. Play some themes first, or pick another pool.'
          : 'No AniList anime found. Connect AniList and sync your lists, or pick another pool.',
      );
    }

    const countFilter = {
      ...this.basePoolFilter(quizType),
      $or: orClauses,
    };
    const totalInPool = await models.themes.countDocuments(countFilter).exec();
    if (totalInPool < POOL_MIN_THEMES) {
      throw new BadRequestException(
        source === 'listened'
          ? `You need at least 10 listened songs to use this pool. (Current: ${totalInPool})`
          : `You need at least 10 songs from your AniList anime to use this pool. (Current: ${totalInPool})`,
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

  /** The draw's pool filter, rebuilt per sampling attempt so
      the exclusion set (used + rejected themes) is always the
      session's current one. */
  private poolFilter(session: SoloSession): Record<string, unknown> {
    const filter = this.basePoolFilter(session.quizType);
    if (session.source === 'random') {
      filter.isPopular = true;
    } else if (session.poolOr) {
      filter.$or = session.poolOr;
    }
    if (session.usedThemeIds.length > 0) {
      filter._id = { $nin: session.usedThemeIds };
    }
    return filter;
  }

  /**
   * One verification verdict for a resolved audio URL, bounded
   * by the draw's remaining budget: once the budget is spent
   * the answer is 'unknown' (the song is kept) WITHOUT a probe
   * firing — verification can never make a draw hang. A probe
   * that misbehaves (throws despite its contract) is doubt too.
   */
  private async verifyAudio(
    audioUrl: string,
    deadline: number,
  ): Promise<AudioProbeResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'unknown';
    try {
      return await this.audioProbe.probe(audioUrl, remaining);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Sample the question's correct theme, with verified dealing
   * (part 7): resolve the candidate's audio and probe the
   * derived .ogg BEFORE the question is built. A definite 404
   * excludes the theme from the rest of this game and redraws
   * from the same pool; doubt of any kind keeps the song.
   * Redraws are capped and the whole verification shares one
   * ~1s budget (verifyAudio), after which the draw deals
   * unverified — and if a redraw finds the pool drained, the
   * last rejected candidate is dealt unverified rather than
   * failing the game (fill, don't fail).
   *
   * Ogg-only pool (owner ruling, 2026-11-12 — supersedes part
   * 7's "deals as before" for unresolvable audio): solo quiz
   * deals ONLY themes with a resolvable .ogg. A theme whose
   * audio does not resolve at all (non-derivable video link,
   * no genuine stored audio) has nothing to probe and nothing
   * to play but its video file — it takes the definite-missing
   * path below exactly like a probed 404: excluded from the
   * rest of the game, redrawn under the same cap and budget,
   * and dealt only through the same fill-don't-fail hatch
   * (cap spent / pool drained). No-.ogg themes don't count.
   */
  private async sampleVerifiedCandidate(
    models: SoloModels,
    session: SoloSession,
  ): Promise<ThemeDoc> {
    const deadline = Date.now() + VERIFY_BUDGET_MS;
    let lastRejected: ThemeDoc | null = null;
    let redraws = 0;
    for (;;) {
      const sampled = await this.sampleOne(models, this.poolFilter(session));
      if (!sampled) {
        if (lastRejected) return lastRejected;
        throw new NotFoundException('No themes found matching your pool');
      }
      // Excluded from later draws either way: the dealt theme
      // is this question; a rejected phantom must never be
      // re-dealt within the game.
      session.usedThemeIds.push(String(sampled._id));
      const audioUrl = resolveAudioUrl(sampled.audioUrl, sampled.videoUrl);
      const verdict: AudioProbeResult = audioUrl
        ? await this.verifyAudio(audioUrl, deadline)
        : 'missing';
      if (verdict === 'missing' && redraws < VERIFY_MAX_REDRAWS) {
        redraws += 1;
        lastRejected = sampled;
        continue;
      }
      return sampled;
    }
  }

  /**
   * Build a drawn question around a sampled theme: the
   * distractors and the withheld answer. No session state
   * changes here.
   *
   * Random games keep the web route verbatim: distractors are
   * sampled from the popular pool (exactly 3, no value dedup —
   * buildSoloOptions' mirrored quirk). Named-pool games
   * (anilist / listened) draw their options from the SAME pool
   * as the correct theme (owner ruling, 2026-11-12 — design
   * QUIZ-PERSONAL-OPTIONS): a surplus of pool candidates is
   * sampled and their values selected room-style (distinct,
   * correct value excluded), because a personal pool is
   * concentrated — the same anime/artist repeats across themes
   * and duplicate option buttons would be common, not
   * theoretical (decision D2). When the pool yields fewer than
   * 3 distinct values the remainder is quietly filled from the
   * popular pool under the existing rules (decision D1 — the
   * game never refuses after passing the ≥10 gate). Earlier
   * questions' themes are NOT excluded from the distractor
   * sample (decision D3): only their names appear, never their
   * audio, and small pools need the material. Distractors are
   * strings on the wire, so the ogg-only rule does not apply
   * to them — a pool theme that can never be dealt as a
   * question still supplies its name as a wrong option.
   */
  private async buildDrawn(
    models: SoloModels,
    session: SoloSession,
    correctTheme: ThemeDoc,
  ): Promise<DrawnQuestion> {
    const correctValue = getThemeValue(correctTheme, session.quizType);

    if (session.source === 'random' || !session.poolOr) {
      const distractors = (await models.themes
        .aggregate([
          { $match: distractorFilterFor(correctTheme, session.quizType) },
          { $sample: { size: 3 } },
        ])
        .exec()) as ThemeDoc[];
      return {
        theme: correctTheme,
        options: buildSoloOptions(correctTheme, session.quizType, distractors),
        correctValue,
      };
    }

    const sampleCandidates = async (
      filter: Record<string, unknown>,
    ): Promise<ThemeDoc[]> =>
      (await models.themes
        .aggregate([{ $match: filter }, { $sample: { size: 10 } }])
        .exec()) as ThemeDoc[];

    const personalCandidates = await sampleCandidates(
      distractorFilterFor(correctTheme, session.quizType, {
        popularOnly: false,
        poolOr: session.poolOr,
      }),
    );
    const distractorValues = distinctDistractorValues(
      correctTheme,
      session.quizType,
      personalCandidates,
    );
    if (distractorValues.length < 3) {
      const popularCandidates = await sampleCandidates(
        distractorFilterFor(correctTheme, session.quizType),
      );
      distractorValues.push(
        ...distinctDistractorValues(
          correctTheme,
          session.quizType,
          popularCandidates,
          distractorValues,
          3 - distractorValues.length,
        ),
      );
    }
    return {
      theme: correctTheme,
      options: shuffle([correctValue, ...distractorValues]),
      correctValue,
    };
  }

  /** The wire projection of a drawn question (the playable,
      answer-free shape every serve of a question uses). */
  private questionProjection(
    drawn: DrawnQuestion,
    index: number,
  ): SoloQuestion {
    const theme = drawn.theme;
    return {
      index,
      theme: {
        slug: theme.slug,
        videoUrl: theme.videoUrl,
        // The resolved audio (audio-url.ts, owner doctrine
        // 2026-11-10): the derived .ogg twin whenever the theme's
        // video link derives — a stored audioUrl is only a fallback
        // and a stored video link is never served as audio. The
        // client falls back to the videoUrl (audio-only) when this
        // is null or fails.
        audioUrl: resolveAudioUrl(theme.audioUrl, theme.videoUrl),
        coverImage:
          theme.animeCoverImage ?? theme.animeCoverImageSmall ?? null,
        type: theme.type,
        sequence: theme.sequence,
      },
      options: drawn.options,
    };
  }

  /**
   * Make a drawn question the live one: the measurement stamps
   * (draw time, playback signal) are taken HERE — at commit —
   * so a question pre-drawn early (part 5) is still measured
   * from the moment it is actually served, never from its
   * pre-draw.
   */
  private commitDrawn(
    session: SoloSession,
    drawn: DrawnQuestion,
  ): SoloQuestion {
    const index = session.answeredCount + 1;
    session.current = {
      theme: drawn.theme,
      options: drawn.options,
      correctValue: drawn.correctValue,
      startedAt: new Date(),
      playbackStartedAt: null,
      index,
    };
    this.warmHeadFor(drawn.theme);
    return this.questionProjection(drawn, index);
  }

  /**
   * Phase 2 warming (2026-11-12): a theme is warmed the
   * moment this service DEALS it — at commit (game creation,
   * answer-time draws, promotions) and at the part-5 pre-draw
   * (ensureNextDrawn) — so by the time the client asks, the
   * song's head is on the API's disk or on its way. Questions
   * in this service are dealt lazily (creation deals Q1; the
   * rest are dealt at the playback-start pre-draw or the
   * answer), so the deal points are where "every dealt theme"
   * is warmed — there is no earlier moment a theme is known.
   * The warmer's contract is fire-and-forget; the guard here
   * is belt-and-braces so even a misbehaving warmer can never
   * fail or delay a draw.
   */
  private warmHeadFor(theme: ThemeDoc): void {
    try {
      this.headWarmer.warm(resolveAudioUrl(theme.audioUrl, theme.videoUrl));
    } catch {
      // A lost warm is a lost optimisation, never an error.
    }
  }

  private async drawQuestion(
    models: SoloModels,
    session: SoloSession,
  ): Promise<SoloQuestion> {
    const correctTheme = await this.sampleVerifiedCandidate(models, session);
    const drawn = await this.buildDrawn(models, session, correctTheme);
    return this.commitDrawn(session, drawn);
  }

  /**
   * The session's pre-drawn next question (part 5), drawn on
   * first need: the playback-start signal draws it so its audio
   * can be revealed during the current question. Returns null
   * when the live question is the last one — there is no next.
   * The drawn theme is already excluded from later draws (the
   * sampler records every sampled id), and the question is
   * only MEASURED when the answer promotes it (commitDrawn).
   */
  private async ensureNextDrawn(
    models: SoloModels,
    session: SoloSession,
  ): Promise<DrawnQuestion | null> {
    if (session.next) return session.next;
    if (!session.current) return null;
    if (session.current.index >= SOLO_QUESTION_COUNT) return null;
    const correctTheme = await this.sampleVerifiedCandidate(models, session);
    session.next = await this.buildDrawn(models, session, correctTheme);
    this.warmHeadFor(session.next.theme);
    return session.next;
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
      sparesRemaining: session.sparesRemaining,
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
    if (source !== 'random' && source !== 'anilist' && source !== 'listened') {
      throw new BadRequestException('Invalid quiz source');
    }

    const session: SoloSession = {
      userId,
      quizType,
      source,
      poolOr:
        source === 'random'
          ? null
          : await this.buildNamedPool(models, userId, quizType, source),
      usedThemeIds: [],
      next: null,
      sparesRemaining: SOLO_SPARE_COUNT,
      soloRp: null,
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
    // Re-serve the live question WITHOUT its stamps changing:
    // the measurement keeps running from the original draw and
    // the recorded playback start, exactly as first served.
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

  /**
   * POST /quiz/solo/games/:gameId/playback-started — the client
   * signals that the live question's media wait has ended: the
   * audio actually started playing, or every candidate failed
   * (the question is answerable either way; what ends is the
   * load eating the clock — owner report, 2026-11-10).
   *
   * The stamp is the SERVER's clock at signal time — the client
   * reports no number, so there is nothing to forge but the
   * timing of the call itself, and the credited load is capped
   * (SOLO_LOAD_CREDIT_CAP_MS in quiz-game.utils) so even that
   * buys at most a few seconds. Idempotent per question: the
   * first signal wins, repeats return the original stamp.
   *
   * Stale-signal guard (audit, 2026-11-16): the signal races the
   * spare-theme swap by design — both fire when a theme proves
   * unplayable — and the signal may land AFTER the replacement
   * was committed into the same slot (same index, NEW theme).
   * When the caller names the question it signalled for (index
   * and/or theme slug) and that is no longer the live question,
   * the stamp is skipped (the replacement has not started
   * playing; stamping it would hand it load credit it never
   * spent). The pre-draw below still runs — it is identity-
   * agnostic and just as useful. Callers that omit both fields
   * keep the old behaviour.
   */
  async markPlaybackStarted(
    userId: string,
    gameId: string,
    index?: number,
    slug?: string,
  ): Promise<SoloPlaybackStartedResponse> {
    const models = this.requireModels();
    const session = this.findSession(userId, gameId);
    const current = session.current;
    if (!current) {
      throw new BadRequestException('Game already finished');
    }
    const stale =
      (index != null && index !== current.index) ||
      (slug != null && slug !== current.theme.slug);
    if (!stale && !current.playbackStartedAt) {
      current.playbackStartedAt = new Date();
      session.lastTouchedAt = Date.now();
    }
    /* Earlier reveal (part 5): the signal also pre-draws the
       NEXT question and returns its resolved audio URL, so the
       client can preload that song during the whole current
       question instead of only the feedback pause. Audio only —
       no options or theme metadata cross the wire here. The
       pre-draw is an optimisation riding on a timing signal: a
       failure to draw must never fail the signal itself, so it
       is best-effort — the answer call will draw (and surface
       any real problem) exactly as before. */
    let nextAudioUrl: string | null = null;
    try {
      const next = await this.ensureNextDrawn(models, session);
      if (next) {
        nextAudioUrl = resolveAudioUrl(next.theme.audioUrl, next.theme.videoUrl);
      }
    } catch {
      nextAudioUrl = null;
    }
    return {
      /* A stale signal leaves the live question unstamped; the
         client ignores this field, so fall back to the draw time
         rather than dereferencing null. */
      playbackStartedAt: (
        current.playbackStartedAt ?? current.startedAt
      ).toISOString(),
      nextAudioUrl,
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
    // Measured from the moment the audio actually started (the
    // draw + the credited load), not from the draw alone — the
    // load no longer eats the player's window (owner, 2026-11-10).
    const secondsRemaining = secondsRemainingAt(
      effectiveQuestionStart(current.startedAt, current.playbackStartedAt),
      SOLO_TIME_LIMIT_SECONDS,
      now,
    );
    // null (skip/timeout) is never the correct value — the
    // web encodes it as the '__SKIP__'/'__TIMEOUT__' sentinels.
    // Scoring (owner ruling, 2026-11-12): a submitted wrong
    // answer is penalised (−half the would-be correct score);
    // a null scores 0 — no submission, no penalty — and takes
    // the full 20s as before.
    const correct = answer !== null && answer === current.correctValue;
    const scoreGained = soloScoreFor(
      correct,
      secondsRemaining,
      session.streak,
      answer !== null,
    );
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
      session.next = null;
      // Solo RP (owner order, 2026-11-16): the finished game
      // grants its tiered award exactly once. The rank write
      // rides the answer (not a background job) so the response
      // can report the ACTUAL change — but a rank failure must
      // never fail the answer itself: the game is over and the
      // attempt is persisted either way, so a throw degrades to
      // rpChange null, loudly logged.
      if (!session.soloRp && this.rankService) {
        try {
          const applied = await this.rankService.applySoloRP(
            userId,
            session.correctCount,
          );
          if (applied) {
            session.soloRp = {
              rpChange: applied.rpChange,
              rpAfter: applied.rpAfter,
            };
          }
        } catch (err) {
          console.error(
            `[solo-quiz] solo RP application failed for game ${gameId}:`,
            err,
          );
        }
      }
    } else if (session.next) {
      // Promote the pre-drawn question (part 5): committing it
      // stamps its measurement from NOW — the pre-draw bought
      // preload time, never answer time.
      const drawn = session.next;
      session.next = null;
      nextQuestion = this.commitDrawn(session, drawn);
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
      sparesRemaining: session.sparesRemaining,
      // Solo RP rides ONLY the game-over answer (see contracts).
      ...(gameOver
        ? {
            rpChange: session.soloRp?.rpChange ?? null,
            rpAfter: session.soloRp?.rpAfter ?? null,
          }
        : {}),
    };
  }

  /**
   * POST /quiz/solo/games/:gameId/replace-failed — the live
   * question's theme could not be played AT ALL (owner order,
   * 2026-11-16): swap it for a spare. The replacement is a
   * fresh verified draw from the game's own pool, committed
   * into the SAME slot — commitDrawn derives the index from
   * answeredCount, which has not moved, so the slot number is
   * unchanged — and the failed theme stays in usedThemeIds,
   * never re-dealt. No attempt is recorded for the failed
   * question and score/streak are untouched: as far as the
   * game is concerned it never happened. The pre-drawn next
   * question is kept (it was drawn against the same exclusion
   * set and is still the question after this slot).
   *
   * The spare is spent only once a replacement is actually in
   * hand: a draw that finds the pool drained surfaces its own
   * error with the budget intact, and the client falls back to
   * the pre-spare behaviour (answerable without audio).
   *
   * Double-spend guards (audit round 2, 2026-11-16):
   * - Idempotency: when the caller names the failed theme's
   *   slug and the live question no longer carries it, this
   *   call is a replay of a swap that already landed — the live
   *   question is returned as-is and NO spare is spent.
   * - Concurrency: a swap already in flight for this game
   *   refuses a second one (see swapsInFlight). The refused
   *   caller's resync (re-read the game) adopts the landed
   *   replacement once it commits.
   */
  async replaceFailedQuestion(
    userId: string,
    gameId: string,
    slug?: string,
  ): Promise<SoloReplaceResponse> {
    const models = this.requireModels();
    const session = this.findSession(userId, gameId);
    if (!session.current) {
      throw new BadRequestException('Game already finished');
    }
    if (slug != null && slug !== session.current.theme.slug) {
      // Replay of a landed swap: serve the live question, spend
      // nothing. (Checked before the budget: a replay must
      // succeed even when the spares are now spent.)
      const current = session.current;
      return {
        question: this.questionProjection(
          {
            theme: current.theme,
            options: current.options,
            correctValue: current.correctValue,
          },
          current.index,
        ),
        sparesRemaining: session.sparesRemaining,
      };
    }
    if (session.sparesRemaining <= 0) {
      throw new BadRequestException('No spare themes left for this game');
    }
    if (this.swapsInFlight.has(gameId)) {
      throw new BadRequestException(
        'A replacement is already in progress for this game',
      );
    }
    this.swapsInFlight.add(gameId);
    try {
      const correctTheme = await this.sampleVerifiedCandidate(models, session);
      const drawn = await this.buildDrawn(models, session, correctTheme);
      session.sparesRemaining -= 1;
      session.lastTouchedAt = Date.now();
      const question = this.commitDrawn(session, drawn);
      return { question, sparesRemaining: session.sparesRemaining };
    } finally {
      this.swapsInFlight.delete(gameId);
    }
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
