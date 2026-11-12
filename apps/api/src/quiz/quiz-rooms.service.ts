import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import {
  ROUND_COUNTDOWN_SECONDS,
  ROUND_START_READY_BOUND_SECONDS,
  type CreateRoomRequest,
  type PublicRoomListItem,
  type PublicRoomRequest,
  type QuizRoomAck,
  type QuizRoomPlayer,
  type QuizRoomState,
  type QuizRoundAnswer,
  type RematchStartedEvent,
  type RematchVoteEvent,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import { Favorite, type FavoriteDocument } from '../library/favorite.schema';
import { Rating, type RatingDocument } from '../library/rating.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { resolveAudioUrl } from '../themes/audio-url';
import { QuizRoom, type QuizRoomDocument } from './quiz-room.schema';
import {
  buildRoundOptions,
  distractorFilterFor,
  generateRoomCode,
  getCorrectAnswer,
  multiplayerScoreFor,
  shouldAutoLock,
  type QuizThemeLike,
} from './quiz-game.utils';
import { RankService } from './rank.service';
import { RoomBroadcaster } from './room-broadcaster';

/**
 * An expected, web-shaped failure of a room action. The gateway
 * turns it into the ack body ({ success: false, error, …extra }) —
 * the same information the web's REST routes return as HTTP
 * errors, carried over the socket ack instead.
 */
export class RoomActionError extends Error {
  constructor(
    message: string,
    readonly extra?: Partial<QuizRoomAck>,
  ) {
    super(message);
  }
}

/** A theme document as the room engine reads it. */
type RoomThemeDoc = QuizThemeLike & {
  _id: unknown;
  audioUrl?: string | null;
  animeCoverImage?: string | null;
  animeCoverImageSmall?: string | null;
  type?: string | null;
  sequence?: number | null;
  slug?: string;
  entries?: { videoSources?: { url?: string }[] }[];
};

type RoomDoc = QuizRoomDocument;

/** One stored round / answer row on a room document. */
type RoomRound = RoomDoc['rounds'][number];
type RoomAnswer = RoomRound['answers'][number];

interface RoomModels {
  rooms: Model<QuizRoomDocument>;
  themes: Model<ThemeCacheDocument>;
  users: Model<UserDocument>;
  watchHistory: Model<WatchHistoryDocument>;
  ratings: Model<RatingDocument>;
  favorites: Model<FavoriteDocument>;
}

interface LibraryProfile {
  userId: string;
  syncedAnimeIds: Set<number>;
  libraryAnimeIds: Set<number>;
  exactThemeIdsByAnimeId: Map<number, Set<string>>;
}

/** One room's cached library contributions (perf problem 6). */
interface RoomLibraryCache {
  /** Key for the cached profiles; null = nothing cached yet. */
  key: string | null;
  profiles: LibraryProfile[] | null;
  /** Player ids a join has already computed into the cache. */
  joined: Set<string>;
  /** Membership changed since the last match: recompute all. */
  libraryDirty: boolean;
}

/** Cleanup thresholds — lib/quiz-room-cleanup.ts, verbatim. */
const HEARTBEAT_THRESHOLD_MS = 45 * 1000;
const EMPTY_ROOM_THRESHOLD_MS = 60 * 1000;
/** How often the in-process sweeper runs the web's lazy cleanup. */
const SWEEP_INTERVAL_MS = 15 * 1000;

/**
 * Party room cap (owner spec, 2026-11-10): a party seats at
 * most 4 players (the web hard-coded 6 and offered no choice).
 * Requested sizes clamp into 2–4 — a room must hold at least
 * the 2 players a start requires — and an unset size defaults
 * to the cap. Duels never read this: create forces 2 for them.
 */
const PARTY_MAX_PLAYERS_CAP = 4;

function partyMaxPlayers(requested?: number): number {
  const n =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.floor(requested)
      : PARTY_MAX_PLAYERS_CAP;
  return Math.min(PARTY_MAX_PLAYERS_CAP, Math.max(2, n));
}

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function intersectSets<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

/**
 * Multiplayer quiz rooms (Slice S4) — the web's room engine
 * (app/api/quiz/room/* + lib/quiz-room-utils.ts +
 * lib/quiz-room-cleanup.ts) re-expressed over this API's own
 * Socket.IO gateway (see QuizGateway). The web's design is
 * REST actions + Pusher broadcasts over a Mongo room document;
 * this port keeps the document, the state machine and every
 * game rule, and swaps the transport: actions arrive as socket
 * events with acks shaped like the web's REST bodies, broadcasts
 * keep the web's Pusher event names and payload shapes.
 *
 * Game rules as ported (all from the web sources named):
 * - Rooms: type party/duel; poolMode random/watched/common —
 *   plus the owner's 'anilist' pool (spec 2026-11-10): the
 *   union of the themes of every player's AniList-listed anime
 *   (their stored merged Watching+Completed sets), resolved
 *   per round like the common rule reads them;
 *   guessType anime/song/artist; 6-char A–Z0–9 codes, joined
 *   case-insensitively; duel rooms are capped at 2 players
 *   (create forces it), party rooms cap at 4 and default to 4
 *   (owner spec 2026-11-10; the web hard-coded 6); time limit 30s;
 *   public matchmaking creates with roundCount 10 and — for
 *   duels — a null host.
 * - Common-pool eligibility (owner spec, 2026-11-10): a common
 *   game starts only when the players' shared-theme count (the
 *   common candidate set's size) is at least the round count;
 *   waiting-room states carry that count as commonPoolCount.
 * - Per-room library cache (perf problem 6, 2026-11-10): each
 *   player's library contribution is computed once at join and
 *   cached on the room's in-memory state; counts and round
 *   starts derive from the cache — library queries happen on
 *   join/leave/pool-change and at a dirty room's next match,
 *   never per state emit or per round.
 * - Start: party needs ≥2 players, ALL ready; duel needs
 *   exactly 2, both ready. Duels also auto-start the moment the
 *   second player readies (the web's ready route). Only the
 *   host starts a party (a hostless room may be started by
 *   anyone — the web's check only fires when a host exists).
 * - Rounds: themes are sampled per pool mode with used-theme
 *   exclusion; options are the correct value + 3 deduped
 *   distractor values, shuffled. Random/AniList rooms sample
 *   distractors from the popular pool (the web shape); Watched
 *   and Common rooms sample them from the room's own pool
 *   first, topping up from popular only when the pool yields
 *   fewer than 3 distinct values (owner ruling, 2026-11-12).
 *   Round state lives on the room document exactly as the web
 *   stores it, reveal metadata included.
 * - Scoring (answer route): secondsRemaining is measured
 *   SERVER-side from the round's startedAt; the points are the
 *   OWNER'S formula (spec 2026-11-10): correct → secondsRemaining
 *   × (players who haven't answered yet + 1); wrong → 0. (The
 *   web's +secondsRemaining / −secondsRemaining and its party
 *   first-correct bonus are replaced, not ported.)
 * - Pre-round countdown (owner design, 2026-11-10): every round
 *   opens with a ROUND_COUNTDOWN_SECONDS (5) countdown while
 *   the clients preload the round's audio; at 0 the audio and
 *   the answer window start together. The round's startedAt is
 *   stamped that far in the future, so the measurement above
 *   and the server round timer both run from the countdown's
 *   end with no extra bookkeeping — and an answer submitted
 *   during the countdown is refused ('Round has not started
 *   yet'), never scored. The web has no countdown; its clients
 *   start the clip and the clock together at broadcast time
 *   and eat the load latency (the owner's report).
 *   The all-but-one auto-lock (with the duel exception: the
 *   last duelist is only locked once a correct answer exists)
 *   is ported in both its pre-answer and post-answer forms.
 * - Round end: when every player has an answer row, or the
 *   timer expires (unanswered players get autoLocked rows —
 *   the web timer-end route's shape). Game end (last round)
 *   schedules the rank maintenance (RankService).
 * - Play again (owner feature, 2026-11-12; the web has no
 *   rematch): members of an ended room vote via room:rematch;
 *   unanimity among the current members (≥2) restarts the game
 *   in the same room — scores zeroed, rounds/used themes
 *   cleared, fresh questions from the same pool. Votes live in
 *   memory only (no document change); a member leaving the
 *   ended room shrinks the denominator and can complete
 *   unanimity. A rematch is a NEW game for RP: its end
 *   schedules its own award; the finished game's award is
 *   never re-applied.
 * - Presence: players heartbeat (the web: every ~15s); the
 *   sweeper applies the web cleanup verbatim — 45s staleness
 *   drops a player (host reassigns randomly), a room empty for
 *   60s is deleted, an in-progress room emptied by drops is
 *   ended WITHOUT rank updates (the web cleanup's behaviour).
 *
 * Transport-driven deviations, all flagged:
 * 1. THE SERVER OWNS THE ROUND TIMER. The web elects a client
 *    as "timer authority" (timerAuthority token) which POSTs
 *    timer-end at zero — a Pusher-presence pattern with no
 *    Socket.IO need. Here a server timeout ends the round at
 *    the limit. Observable difference: rounds end on time even
 *    if every client stalls (the web's known stall weakness,
 *    AUDIT.md §4 — deliberately not reproduced). Because the
 *    server timer covers it, there are no client timeout /
 *    timer-end events; timerAuthority is still stamped on the
 *    document for shape parity.
 * 2. Host `next` accepts the client's expectedRound and answers
 *    alreadyAdvanced on mismatch, mirroring the web route's
 *    conditional-update guard. (The web keeps pacing fully
 *    host-driven; so is this port — there is no auto-advance.)
 * 3. Room state served to clients withholds the live round's
 *    themeId / correctAnswer / alternateAnswers until the round
 *    ends. The web's join response leaks them (its room doc is
 *    returned raw); the reveal still arrives via room:round-
 *    ended exactly as the web broadcasts it. Deliberate
 *    tightening, same as the solo slice.
 * 4. Media candidates are the RAW source URLs (video, audio,
 *    entry sources). The web rewrites them through its
 *    /api/media/proxy; this API has no media proxy.
 * 5. Quiz invites (QuizInvite send/respond) are NOT ported:
 *    they ride per-user Pusher channels (`private-user-<id>`)
 *    and this slice's gateway is room-scoped. Rooms are joined
 *    by code or public matchmaking, as on the web.
 * 6. The web's `timeout` route never schedules rank updates
 *    when it ends a game (its timer-end/answer routes do).
 *    There is no separate host-timeout action here — the
 *    server timer IS the timer-end path and does schedule
 *    them. Noted for the record.
 *
 * Concurrency: all mutations of one room are serialized through
 * a per-room promise chain — the in-process equivalent of the
 * care the web's next route takes with its conditional update.
 *
 * Models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every action fails with the quiz
 * unavailable ack while /health works.
 */
@Injectable()
export class QuizRoomsService implements OnModuleInit, OnModuleDestroy {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly roundTimers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * Per-room library cache (perf problem 6, spec
   * ROOM-LIBRARY-CACHE-2026-11-10): each player's library
   * contribution (AniList id set + history/rating/favourite
   * theme ids — exactly what computeCommonCandidates reads) is
   * computed ONCE when the player joins the room and cached
   * here, keyed by room id. Common-pool counts and round starts
   * derive from these cached profiles — no library queries per
   * state emit or per round. Entries are recomputed only when
   * a player joins or leaves, or the pool mode changes; a
   * membership change also marks the room libraryDirty, and the
   * next match's round 1 recomputes every contribution of the
   * (changed) line-up before dealing. Cache lives and dies
   * with the room: entries are dropped when a room ends or is
   * deleted. Nothing is persisted — no schema, no Redis.
   */
  private readonly libraryCache = new Map<string, RoomLibraryCache>();

  /** Drops a room's cached library contributions (room death). */
  private dropLibraryCache(roomId: string): void {
    this.libraryCache.delete(roomId);
  }

  /**
   * Play-again votes (owner feature, 2026-11-12): per room, the
   * set of member user ids who voted for a rematch on the ended
   * screen. In-memory like the library cache — votes are
   * ephemeral lobby state, not document state: nothing is
   * written to the shared room document (no schema change), and
   * a server restart simply clears pending votes along with the
   * room timers. Votes are always read PRUNED to the room's
   * current members, so a member leaving the ended room shrinks
   * the denominator (and can complete unanimity for the rest).
   */
  private readonly rematchVotes = new Map<string, Set<string>>();

  /** Drops a room's rematch votes (restart consumed them, or the room died). */
  private dropRematchVotes(roomId: string): void {
    this.rematchVotes.delete(roomId);
  }

  /** The room's rematch voters, in roster order, current members only. */
  private currentRematchVoters(room: RoomDoc): string[] {
    const votes = this.rematchVotes.get(String(room._id));
    if (!votes || votes.size === 0) return [];
    return room.players
      .map((p) => p.userId)
      .filter((userId) => votes.has(userId));
  }

  /**
   * Round-start gates (F4, clock batch 2026-11-12): per room,
   * the CURRENT round's pending start — the members whose
   * clients have not yet reported their round audio ready
   * (`room:round-ready`), the bound timer that force-starts
   * the round when the wait runs out, and the round-started
   * payload pieces the completion broadcast re-sends.
   *
   * In-memory like the rematch votes, for the same reason: the
   * shared room document's schema cannot express "not started"
   * (rounds[].startedAt is a required Date — a field-for-field
   * port of the web's schema), so while the gate is pending the
   * document holds the BASE countdown moment and THIS map is
   * the authoritative started-or-not signal. completeRoundStart
   * re-stamps the document with the real start moment and the
   * gate is dropped; from then on the round is indistinguishable
   * from a pre-F4 round. A server restart loses pending gates
   * with the room timers — the round then simply never starts
   * (its timer was lost too, the pre-existing restart posture
   * for in-flight rounds).
   */
  private readonly roundStartGates = new Map<
    string,
    {
      roundNumber: number;
      awaiting: Set<string>;
      boundTimer: ReturnType<typeof setTimeout> | null;
      payload: {
        videoUrl: string;
        mediaCandidates: string[];
        options: string[];
        timeLimitSeconds: number;
        baseStartAtIso: string;
      };
    }
  >();

  /** Opens a round's start gate (beginRound): everyone currently
   *  in the room is awaited; the bound timer force-starts the
   *  round ROUND_START_READY_BOUND_SECONDS past the base moment. */
  private openRoundStartGate(
    roomId: string,
    roundNumber: number,
    memberIds: string[],
    baseStartAt: Date,
    payload: {
      videoUrl: string;
      mediaCandidates: string[];
      options: string[];
      timeLimitSeconds: number;
    },
  ): void {
    this.dropRoundStartGate(roomId);
    const gate: NonNullable<
      ReturnType<typeof this.roundStartGates.get>
    > = {
      roundNumber,
      awaiting: new Set(memberIds),
      boundTimer: null,
      payload: {
        ...payload,
        baseStartAtIso: baseStartAt.toISOString(),
      },
    };
    const boundAtMs =
      baseStartAt.getTime() + ROUND_START_READY_BOUND_SECONDS * 1000;
    gate.boundTimer = setTimeout(() => {
      void this.forceRoundStartAtBound(roomId, roundNumber).catch(
        () => undefined,
      );
    }, Math.max(0, boundAtMs - Date.now()));
    gate.boundTimer.unref?.();
    this.roundStartGates.set(roomId, gate);
  }

  /** Drops a room's start gate (start completed, round ended, room died). */
  private dropRoundStartGate(roomId: string): void {
    const gate = this.roundStartGates.get(roomId);
    if (!gate) return;
    if (gate.boundTimer) clearTimeout(gate.boundTimer);
    this.roundStartGates.delete(roomId);
  }

  /** Whether a room's given round is still start-pending. */
  private roundStartGatePending(room: RoomDoc, roundNumber: number): boolean {
    const gate = this.roundStartGates.get(String(room._id));
    return !!gate && gate.roundNumber === roundNumber;
  }

  /** Prunes a gate's awaited set to the room's current members. */
  private pruneGateToMembers(
    room: RoomDoc,
    gate: { awaiting: Set<string> },
  ): void {
    const memberIds = new Set(room.players.map((p) => p.userId));
    for (const userId of [...gate.awaiting]) {
      if (!memberIds.has(userId)) gate.awaiting.delete(userId);
    }
  }

  /**
   * Completes a round's start when every current member has
   * reported (shared by the report action and the leave /
   * cleanup paths — a departure can complete the wait for the
   * rest, exactly like the rematch denominator). Callers hold
   * the room lock.
   */
  private async maybeCompleteRoundStart(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<void> {
    if (room.status !== 'in_progress' || room.players.length === 0) {
      return;
    }
    const gate = this.roundStartGates.get(String(room._id));
    if (!gate || gate.roundNumber !== room.currentRound) return;
    this.pruneGateToMembers(room, gate);
    if (gate.awaiting.size > 0) return;
    await this.completeRoundStart(models, room);
  }

  /**
   * The start itself: stamp the round's authoritative
   * startedAt NOW, persist, re-broadcast room:round-started in
   * its started shape, and re-arm the round timer for the
   * answer window alone (beginRound's arming spanned countdown
   * + bound + window). From here the round's length and scoring
   * are exactly the pre-F4 behaviour — everything derives from
   * startedAt as it always did. Callers hold the room lock.
   */
  private async completeRoundStart(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<void> {
    const roomId = String(room._id);
    const gate = this.roundStartGates.get(roomId);
    if (!gate) return;
    const round = room.rounds[room.currentRound - 1];
    this.dropRoundStartGate(roomId);
    if (!round || round.endedAt) return;
    round.startedAt = new Date();
    await room.save();

    this.emit(room, 'room:round-started', {
      round: gate.roundNumber,
      theme: {
        videoUrl: gate.payload.videoUrl,
        mediaCandidates: gate.payload.mediaCandidates,
        options: gate.payload.options,
      },
      startedAt: round.startedAt.toISOString(),
      startPending: false,
      baseStartAt: gate.payload.baseStartAtIso,
      timeLimitSeconds: gate.payload.timeLimitSeconds,
      countdownSeconds: ROUND_COUNTDOWN_SECONDS,
    });
    this.armRoundTimer(roomId, gate.payload.timeLimitSeconds);
  }

  /** The bound firing: the round starts with whoever reported;
   *  non-reporters play catch-up (their answers flow normally
   *  once the window is open — only their audio is late). */
  private async forceRoundStartAtBound(
    roomId: string,
    roundNumber: number,
  ): Promise<void> {
    const models = this.requireModels();
    await this.withRoomLock(roomId, async () => {
      const gate = this.roundStartGates.get(roomId);
      if (!gate || gate.roundNumber !== roundNumber) return;
      const room = (await models.rooms
        .findById(roomId)
        .exec()) as RoomDoc | null;
      if (!room || room.status !== 'in_progress') {
        this.dropRoundStartGate(roomId);
        return;
      }
      if (room.players.length === 0) {
        this.dropRoundStartGate(roomId);
        return;
      }
      if (room.currentRound !== roundNumber) {
        this.dropRoundStartGate(roomId);
        return;
      }
      await this.completeRoundStart(models, room);
    });
  }

  /**
   * room:round-ready — a client's per-round audio report (F4):
   * its round audio is genuinely playing, or its chain failed.
   * When every CURRENT member has reported, the round starts
   * (completeRoundStart). Reports are idempotent; a report for
   * a round that already started, a stale round number, or from
   * a game not in progress is accepted as a no-op — a slow
   * client's late report must never disturb a live round.
   */
  async reportRoundReady(
    userId: string,
    roomId: string,
    roundNumber: number,
    state: 'playing' | 'failed',
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    if (typeof roundNumber !== 'number') {
      throw new RoomActionError('Missing roundNumber');
    }
    if (state !== 'playing' && state !== 'failed') {
      throw new RoomActionError('Invalid round-ready state');
    }
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      this.requirePlayer(room, userId);
      if (room.status === 'in_progress' && roundNumber === room.currentRound) {
        const gate = this.roundStartGates.get(String(room._id));
        if (gate && gate.roundNumber === roundNumber) {
          gate.awaiting.delete(userId);
          await this.maybeCompleteRoundStart(models, room);
        }
      }
      return { success: true };
    });
  }

  /**
   * Discards cached contributions after a membership change and
   * marks the room dirty: the next match must recompute every
   * contribution of the new line-up before round 1 (owner
   * clarification 2026-11-10 ~18:14). While the room is waiting
   * the next state read recomputes lazily; the dirty flag is
   * consumed by beginRound(1).
   */
  private markLibraryDirty(roomId: string): void {
    const cache = this.libraryCache.get(roomId);
    if (cache) {
      cache.profiles = null;
      cache.libraryDirty = true;
    }
  }

  constructor(
    @Optional()
    @InjectModel(QuizRoom.name)
    private readonly roomModel?: Model<QuizRoomDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly watchHistoryModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
    @Optional()
    @InjectModel(Favorite.name)
    private readonly favoriteModel?: Model<FavoriteDocument>,
    @Optional()
    private readonly rankService?: RankService,
    @Optional()
    private readonly broadcaster?: RoomBroadcaster,
  ) {}

  onModuleInit() {
    if (!this.roomModel) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const timer of this.roundTimers.values()) clearTimeout(timer);
    this.roundTimers.clear();
  }

  private requireModels(): RoomModels {
    if (
      !this.roomModel ||
      !this.themeModel ||
      !this.userModel ||
      !this.watchHistoryModel ||
      !this.ratingModel ||
      !this.favoriteModel
    ) {
      throw new RoomActionError(
        'Quiz unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      rooms: this.roomModel,
      themes: this.themeModel,
      users: this.userModel,
      watchHistory: this.watchHistoryModel,
      ratings: this.ratingModel,
      favorites: this.favoriteModel,
    };
  }

  /** Serialize mutations per room (see the class docblock). */
  private withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      roomId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private emit(room: RoomDoc, event: string, payload: unknown) {
    this.broadcaster?.emitToRoom(String(room._id), event, payload);
  }

  /* ---------------------------------------------------------------- */
  /* Projections                                                       */
  /* ---------------------------------------------------------------- */

  private toPlayer(player: QuizRoom['players'][number]): QuizRoomPlayer {
    return {
      userId: player.userId,
      username: player.username,
      avatar: player.avatar ?? null,
      totalScore: player.totalScore,
      ready: player.ready,
      joinedAt: iso(player.joinedAt),
      lastSeenAt: iso(player.lastSeenAt),
    };
  }

  /** The full answer row — live rounds in state, and the round-ended event's payload. */
  private toRoundAnswer(a: RoomAnswer): QuizRoundAnswer {
    return {
      userId: a.userId,
      submittedAnswer: a.submittedAnswer,
      correct: a.correct,
      answeredAt: iso(a.answeredAt),
      secondsRemaining: a.secondsRemaining,
      baseScore: a.baseScore,
      bonusScore: a.bonusScore,
      totalScoreGained: a.totalScoreGained,
      autoLocked: a.autoLocked,
    };
  }

  /**
   * The reveal summary of an answer — ENDED rounds in room state
   * (perf problem 15, B6): exactly the fields the clients read for
   * a finished round (the reveal list renders userId /
   * submittedAnswer / correct / totalScoreGained / autoLocked;
   * standings rebuild from the players' totals, never from past
   * answers). The per-answer scoring internals (answeredAt,
   * secondsRemaining, baseScore, bonusScore) are dropped so the
   * state payload stops growing with every round played; they
   * remain on the live round's rows and in the round-ended event.
   */
  private toRoundAnswerSummary(a: RoomAnswer): QuizRoundAnswer {
    return {
      userId: a.userId,
      submittedAnswer: a.submittedAnswer,
      correct: a.correct,
      totalScoreGained: a.totalScoreGained,
      autoLocked: a.autoLocked,
    };
  }

  /**
   * Room state for clients — the live round's answers stay hidden
   * (no answer material leaks) and stay FULL; ended rounds carry
   * only their reveal summary per answer (B6, see above). Round
   * -level reveal fields (themeId / correctAnswer / theme) are
   * attached once a round has ended, as before.
   */
  toRoomState(room: RoomDoc): QuizRoomState {
    const state: QuizRoomState = {
      roomId: String(room._id),
      roomCode: room.roomCode,
      roomType: room.roomType as QuizRoomState['roomType'],
      hostId: room.hostId ? String(room.hostId) : null,
      settings: {
        poolMode: room.settings.poolMode as QuizRoomState['settings']['poolMode'],
        guessType:
          room.settings.guessType as QuizRoomState['settings']['guessType'],
        roundCount: room.settings.roundCount,
        maxPlayers: room.settings.maxPlayers,
        timeLimitSeconds: room.settings.timeLimitSeconds,
      },
      status: room.status as QuizRoomState['status'],
      matchmaking: room.matchmaking as QuizRoomState['matchmaking'],
      currentRound: room.currentRound,
      players: room.players.map((p) => this.toPlayer(p)),
      rounds: room.rounds.map((round) => {
        const ended = round.endedAt != null;
        // F4 (2026-11-12): while the live round's start gate is
        // pending, the document's startedAt holds only the BASE
        // countdown moment — serve the pending shape (null
        // startedAt + startPending + baseStartAt) so a joining
        // or resyncing client waits for the authoritative stamp
        // like everyone else. Ended rounds and started rounds
        // serve their stamp exactly as before.
        const startPending =
          !ended &&
          room.status === 'in_progress' &&
          round.roundNumber === room.currentRound &&
          this.roundStartGatePending(room, round.roundNumber);
        return {
          roundNumber: round.roundNumber,
          options: round.options,
          startedAt: startPending ? null : iso(round.startedAt),
          ...(startPending
            ? { startPending: true, baseStartAt: iso(round.startedAt) }
            : {}),
          endedAt: ended ? iso(round.endedAt) : null,
          answers: round.answers.map((a) =>
            ended ? this.toRoundAnswerSummary(a) : this.toRoundAnswer(a),
          ),
          firstCorrectUserId: round.firstCorrectUserId ?? null,
          ...(ended
            ? {
                themeId: round.themeId,
                correctAnswer: round.correctAnswer,
                theme: {
                  animeTitle: round.animeTitle,
                  animeTitleEnglish: round.animeTitleEnglish,
                  coverImage: round.coverImage,
                  malId: round.malId,
                  themeType: round.themeType,
                  themeSequence: round.themeSequence,
                  songTitle: round.songTitle,
                  artistName: round.artistName,
                },
              }
            : {}),
        };
      }),
    };
    // Play-again votes ride ended states only (see the field's
    // contract): the current members who voted, so every client
    // can show "n/m want to play again" and its own voted state.
    if (room.status === 'ended') {
      const voters = this.currentRematchVoters(room);
      if (voters.length > 0) {
        state.rematchVotedUserIds = voters;
      }
    }
    return state;
  }

  /* ---------------------------------------------------------------- */
  /* Theme selection — lib/quiz-room-utils.ts ports.                   */
  /* ---------------------------------------------------------------- */

  private guessTypeRequirements(guessType: string): Record<string, unknown> {
    if (guessType === 'artist') {
      return { artistName: { $nin: [null, '', 'Unknown'] } };
    }
    if (guessType === 'song') {
      return { songTitle: { $nin: [null, '', 'Unknown'] } };
    }
    return {};
  }

  /**
   * The web's buildRoomPlayerLibraryProfiles, per player:
   * one player's library contribution — the AniList-listed
   * anime ids (the stored merged Watching+Completed set) union
   * the in-app data (history / ratings / favourites), resolved
   * to anime ids plus the exact per-anime theme ids.
   *
   * Failure tolerance (perf problem 6): a failed computation
   * yields an EMPTY contribution — today's behaviour for a
   * player with no AniList and no history — never a failed
   * join or a failed round start.
   */
  private async computePlayerProfile(
    models: RoomModels,
    user: (User & { _id: unknown }) | undefined,
    userId: string,
  ): Promise<LibraryProfile> {
    try {
      const syncedAnimeIds = new Set<number>(
        (user?.anilist?.completedMediaIds ?? []).filter(
          (id): id is number => typeof id === 'number',
        ),
      );

      const [historyIds, ratedIds, favIds] = await Promise.all([
        models.watchHistory.distinct('themeId', { userId }).exec(),
        models.ratings.distinct('themeId', { userId }).exec(),
        models.favorites.distinct('themeId', { userId }).exec(),
      ]);
      const localThemeIds = Array.from(
        new Set(
          [...historyIds, ...ratedIds, ...favIds].map((id) => String(id)),
        ),
      );
      const localThemes =
        localThemeIds.length > 0
          ? ((await models.themes
              .find({ _id: { $in: localThemeIds } })
              .select('_id anilistId')
              .lean()
              .exec()) as { _id: unknown; anilistId: number | null }[])
          : [];

      const libraryAnimeIds = new Set<number>(syncedAnimeIds);
      const exactThemeIdsByAnimeId = new Map<number, Set<string>>();
      for (const theme of localThemes) {
        if (!theme.anilistId) continue;
        libraryAnimeIds.add(theme.anilistId);
        const exactIds =
          exactThemeIdsByAnimeId.get(theme.anilistId) ?? new Set<string>();
        exactIds.add(String(theme._id));
        exactThemeIdsByAnimeId.set(theme.anilistId, exactIds);
      }

      return { userId, syncedAnimeIds, libraryAnimeIds, exactThemeIdsByAnimeId };
    } catch {
      return {
        userId,
        syncedAnimeIds: new Set(),
        libraryAnimeIds: new Set(),
        exactThemeIdsByAnimeId: new Map(),
      };
    }
  }

  /** The web's buildRoomPlayerLibraryProfiles (whole roster). */
  private async buildLibraryProfiles(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<LibraryProfile[]> {
    const playerUserIds = room.players.map((p) => p.userId);
    const users = (await models.users
      .find({ _id: { $in: playerUserIds } })
      .select('anilist.completedMediaIds')
      .lean()
      .exec()) as (User & { _id: unknown })[];
    const userById = new Map(users.map((u) => [String(u._id), u]));

    return Promise.all(
      playerUserIds.map((userId) =>
        this.computePlayerProfile(models, userById.get(userId), userId),
      ),
    );
  }

  /**
   * Library profiles for a room state emit / round start,
   * served from the per-room cache (perf problem 6). A read
   * recomputes ONLY when the roster or pool mode changed
   * since the last computation — the state emits and round
   * starts themselves issue zero library queries.
   *
   * `forMatchStart` marks the round-1 read of a new match:
   * the owner's next-match rule (2026-11-10 ~18:14) — when
   * membership changed since the last match (libraryDirty),
   * the match must NOT deal from contributions computed for
   * the old line-up, so round 1 recomputes the whole (changed)
   * line-up before the eligibility gate reads the count.
   * Waiting-room reads keep serving the cache: the count line
   * is allowed to be one membership behind, the match is not.
   */
  private async cachedLibraryProfiles(
    models: RoomModels,
    room: RoomDoc,
    forMatchStart = false,
  ): Promise<LibraryProfile[]> {
    const roomId = String(room._id);
    let cache = this.libraryCache.get(roomId);
    if (!cache) {
      cache = { key: null, profiles: null, joined: new Set(), libraryDirty: false };
      this.libraryCache.set(roomId, cache);
    }
    const key = `${room.settings.poolMode}|${room.players
      .map((p) => p.userId)
      .join(',')}`;
    const fresh =
      cache.profiles &&
      cache.key === key &&
      !(cache.libraryDirty && forMatchStart);
    if (fresh) {
      return cache.profiles as LibraryProfile[];
    }
    const profiles = await this.buildLibraryProfiles(models, room);
    cache.key = key;
    cache.profiles = profiles;
    cache.libraryDirty = false;
    for (const p of room.players) cache.joined.add(p.userId);
    return profiles;
  }

  /**
   * Join-time computation (perf problem 6): when a player
   * joins a common/AniList-pool room, their contribution is
   * computed ONCE, immediately — not deferred to the next
   * emit. Cheap-guarded: joins into rooms whose pool never
   * reads libraries, repeat joins, and players already
   * computed into this room's cache are no-ops.
   */
  private async notePlayerJoined(
    models: RoomModels,
    room: RoomDoc,
    userId: string,
  ): Promise<void> {
    if (
      room.settings.poolMode !== 'common' &&
      room.settings.poolMode !== 'anilist'
    ) {
      return;
    }
    const roomId = String(room._id);
    let cache = this.libraryCache.get(roomId);
    if (!cache) {
      cache = { key: null, profiles: null, joined: new Set(), libraryDirty: false };
      this.libraryCache.set(roomId, cache);
    }
    if (cache.joined.has(userId)) return;
    const users = (await models.users
      .find({ _id: { $in: [userId] } })
      .select('anilist.completedMediaIds')
      .lean()
      .exec()) as (User & { _id: unknown })[];
    await this.computePlayerProfile(models, users[0], userId);
    cache.joined.add(userId);
    // The roster changed: derived sets recompute on next read.
    cache.profiles = null;
    cache.key = null;
  }

  /**
   * The web's selectCommonModeThemeCandidate, as a SET: intersect
   * every player's library at the ANIME level, then at the
   * exact-theme level (a player's synced anime contributes all
   * its themes; a locally-known anime contributes only its known
   * themes). Each player's library is the union of their AniList
   * data (the stored merged Watching+Completed id set) and their
   * in-app data (history / ratings / favourites) — see
   * buildLibraryProfiles. The round picker takes one candidate;
   * the owner's common-pool eligibility count (spec 2026-11-10)
   * is this set's size, so both read the same computation.
   */
  private computeCommonCandidates(
    profiles: LibraryProfile[],
    animeThemes: RoomThemeDoc[],
  ): RoomThemeDoc[] {
    const groupedThemes = new Map<number, RoomThemeDoc[]>();
    for (const theme of animeThemes) {
      if (!theme.anilistId || !theme.videoUrl) continue;
      const existing = groupedThemes.get(theme.anilistId) ?? [];
      existing.push(theme);
      groupedThemes.set(theme.anilistId, existing);
    }
    if (groupedThemes.size === 0 || profiles.length === 0) return [];

    let sharedAnimeIds = new Set(profiles[0].libraryAnimeIds);
    for (const profile of profiles.slice(1)) {
      sharedAnimeIds = intersectSets(sharedAnimeIds, profile.libraryAnimeIds);
    }

    const sharedValidThemes: RoomThemeDoc[] = [];
    for (const animeId of sharedAnimeIds) {
      const themesForAnime = groupedThemes.get(animeId) ?? [];
      if (themesForAnime.length === 0) continue;
      const allThemeIdsForAnime = new Set(
        themesForAnime.map((t) => String(t._id)),
      );

      let sharedThemeIds: Set<string> | null = null;
      for (const profile of profiles) {
        const localThemeIds =
          profile.exactThemeIdsByAnimeId.get(animeId) ?? new Set<string>();
        const eligibleThemeIds =
          localThemeIds.size > 0
            ? localThemeIds
            : profile.syncedAnimeIds.has(animeId)
              ? allThemeIdsForAnime
              : new Set<string>();
        sharedThemeIds = sharedThemeIds
          ? intersectSets(sharedThemeIds, eligibleThemeIds)
          : new Set(eligibleThemeIds);
      }

      for (const theme of themesForAnime) {
        if (sharedThemeIds?.has(String(theme._id))) {
          sharedValidThemes.push(theme);
        }
      }
    }

    return sharedValidThemes;
  }

  /**
   * Every theme the room's players currently share under the
   * common rule (optionally minus already-used themes): the
   * web's selectThemeForCommonMode query feeding
   * computeCommonCandidates.
   */
  private async commonCandidates(
    models: RoomModels,
    room: RoomDoc,
    excludedThemeIds: string[] = [],
    forMatchStart = false,
  ): Promise<RoomThemeDoc[]> {
    const profiles = await this.cachedLibraryProfiles(
      models,
      room,
      forMatchStart,
    );
    const sharedAnimeIds =
      profiles.length > 0
        ? Array.from(profiles[0].libraryAnimeIds).filter((animeId) =>
            profiles.every((p) => p.libraryAnimeIds.has(animeId)),
          )
        : [];
    if (sharedAnimeIds.length === 0) return [];

    const filter: Record<string, unknown> = {
      anilistId: { $in: sharedAnimeIds },
      videoUrl: { $nin: [null, ''] },
      ...this.guessTypeRequirements(room.settings.guessType),
    };
    if (excludedThemeIds.length > 0) {
      filter._id = { $nin: excludedThemeIds };
    }

    const animeThemes = (await models.themes
      .find(filter)
      .select(
        '_id anilistId animeTitle animeTitleEnglish animeTitleAlternative animeCoverImage animeCoverImageSmall artistName songTitle slug type sequence videoUrl audioUrl entries',
      )
      .lean()
      .exec()) as RoomThemeDoc[];

    return this.computeCommonCandidates(profiles, animeThemes);
  }

  /**
   * The shared-theme count behind common-pool eligibility
   * (owner spec, 2026-11-10): how many themes ALL current
   * players share. A player with neither AniList lists nor
   * in-app data has an empty library, so the count is 0.
   */
  private async countCommonPoolThemes(
    models: RoomModels,
    room: RoomDoc,
    forMatchStart = false,
  ): Promise<number> {
    return (await this.commonCandidates(models, room, [], forMatchStart))
      .length;
  }

  /**
   * Room state for a WAITING room, with commonPoolCount attached
   * when the pool is 'common' (the waiting room shows the count
   * and blocks its own Start while it is below the round count;
   * the server re-checks at start regardless). Non-waiting or
   * non-common states pass through untouched.
   */
  private async stateWithCommonCount(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<QuizRoomState> {
    const state = this.toRoomState(room);
    if (room.status === 'waiting' && room.settings.poolMode === 'common') {
      state.commonPoolCount = await this.countCommonPoolThemes(models, room);
    }
    return state;
  }

  /** The web's selectThemeForCommonMode (returns null → generic fallback). */
  private async selectCommonTheme(
    models: RoomModels,
    room: RoomDoc,
    excludedThemeIds: string[],
    forMatchStart = false,
  ): Promise<RoomThemeDoc | null> {
    const candidates = await this.commonCandidates(
      models,
      room,
      excludedThemeIds,
      forMatchStart,
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** The web's getDynamicThemeFilter. */
  private async dynamicThemeFilter(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<Record<string, unknown>> {
    const baseFilter: Record<string, unknown> = {
      videoUrl: { $nin: [null, ''] },
      ...this.guessTypeRequirements(room.settings.guessType),
    };

    if (room.settings.poolMode === 'random') {
      return baseFilter;
    }

    // Common, Watched or AniList mode — all read the players' docs.
    const playerUserIds = room.players.map((p) => p.userId);

    if (room.settings.poolMode === 'anilist') {
      // Owner pool (spec 2026-11-10): the union over players of
      // the themes of their AniList-listed anime (the stored
      // merged Watching+Completed set). Perf problem 6: the
      // per-player AniList sets are the cached join-time
      // contributions, not re-read per round. dynamicThemeFilter
      // only runs at round starts, so a dirty room recomputes
      // here too (the next-match rule).
      const profiles = await this.cachedLibraryProfiles(models, room, true);
      const mediaIds = Array.from(
        new Set(profiles.flatMap((p) => Array.from(p.syncedAnimeIds))),
      );
      const anilistThemes =
        mediaIds.length > 0
          ? ((await models.themes
              .find({ anilistId: { $in: mediaIds } })
              .select('_id')
              .lean()
              .exec()) as { _id: unknown }[])
          : [];
      // An empty pool forces a no-match so the caller's fallback
      // kicks in — the web's empty-pool behaviour, as below.
      return {
        ...baseFilter,
        _id: { $in: anilistThemes.map((t) => String(t._id)) },
      };
    }

    const users = (await models.users
      .find({ _id: { $in: playerUserIds } })
      .select('anilist.completedMediaIds')
      .lean()
      .exec()) as (User & { _id: unknown })[];

    let targetThemeIds: string[] = [];
    const isCommon = room.settings.poolMode === 'common';

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const syncedAnilistIds = u.anilist?.completedMediaIds ?? [];

      const [historyIds, ratedIds, favIds] = await Promise.all([
        models.watchHistory.distinct('themeId', { userId: u._id }).exec(),
        models.ratings.distinct('themeId', { userId: u._id }).exec(),
        models.favorites.distinct('themeId', { userId: u._id }).exec(),
      ]);
      const localThemeIds = Array.from(
        new Set(
          [...historyIds, ...ratedIds, ...favIds].map((id) => String(id)),
        ),
      );

      const syncedThemes =
        syncedAnilistIds.length > 0
          ? ((await models.themes
              .find({ anilistId: { $in: syncedAnilistIds } })
              .select('_id')
              .lean()
              .exec()) as { _id: unknown }[])
          : [];
      const syncedThemeIds = syncedThemes.map((t) => String(t._id));

      const playerThemeIds = Array.from(
        new Set([...localThemeIds, ...syncedThemeIds]),
      );

      if (i === 0) {
        targetThemeIds = playerThemeIds;
      } else if (isCommon) {
        targetThemeIds = targetThemeIds.filter((id) =>
          playerThemeIds.includes(id),
        );
      } else {
        targetThemeIds = Array.from(new Set([...targetThemeIds, ...playerThemeIds]));
      }
    }

    // An empty pool forces a no-match so the caller's fallback
    // kicks in — the web's behaviour, verbatim.
    return { ...baseFilter, _id: { $in: targetThemeIds } };
  }

  /** The web's selectThemeForRoom. */
  private async selectThemeForRoom(
    models: RoomModels,
    room: RoomDoc,
    excludedThemeIds: string[],
    forMatchStart = false,
  ): Promise<RoomThemeDoc | null> {
    if (room.settings.poolMode === 'common') {
      const commonTheme = await this.selectCommonTheme(
        models,
        room,
        excludedThemeIds,
        forMatchStart,
      );
      if (commonTheme) return commonTheme;
      // The web falls through to the generic filter selection.
    }

    const themeFilter = await this.dynamicThemeFilter(models, room);
    const existingIn = themeFilter._id as { $in?: unknown[] } | undefined;
    if (existingIn && Array.isArray(existingIn.$in)) {
      themeFilter._id = {
        $in: existingIn.$in,
        ...(excludedThemeIds.length > 0 ? { $nin: excludedThemeIds } : {}),
      };
    } else if (excludedThemeIds.length > 0) {
      themeFilter._id = { $nin: excludedThemeIds };
    }

    const [theme] = (await models.themes
      .aggregate([{ $match: themeFilter }, { $sample: { size: 1 } }])
      .exec()) as RoomThemeDoc[];
    return theme ?? null;
  }

  /** The web start/next fallback: any theme with a playable video. */
  private async sampleFallbackTheme(
    models: RoomModels,
  ): Promise<RoomThemeDoc | null> {
    const [theme] = (await models.themes
      .aggregate([
        { $match: { videoUrl: { $nin: [null, ''] } } },
        { $sample: { size: 1 } },
      ])
      .exec()) as RoomThemeDoc[];
    return theme ?? null;
  }

  /** The popular-pool distractor sample — generateRoundOptions' original query. */
  private async samplePopularDistractorCandidates(
    models: RoomModels,
    correctTheme: RoomThemeDoc,
    guessType: string,
  ): Promise<RoomThemeDoc[]> {
    return (await models.themes
      .aggregate([
        { $match: distractorFilterFor(correctTheme, guessType) },
        { $sample: { size: 10 } },
        {
          $project: {
            animeTitle: 1,
            animeTitleEnglish: 1,
            animeTitleAlternative: 1,
            songTitle: 1,
            artistName: 1,
          },
        },
      ])
      .exec()) as RoomThemeDoc[];
  }

  /**
   * Distractor candidates from the room's OWN pool (owner
   * ruling, 2026-11-12 — the solo personal-pool rule extended
   * to rooms): for Watched, Common and AniList rooms the wrong
   * options come from the same pool the correct themes are
   * dealt from, so a player can't spot the answer by
   * familiarity. The pool is represented exactly as the
   * correct-theme sampler represents it:
   * - common: the shared-candidate SET (commonCandidates) minus
   *   the correct theme;
   * - watched / anilist: the dynamic filter's `_id: { $in: … }`
   *   set (the watched union, resp. the AniList-listed themes
   *   resolved from the players' synced media ids), merged with
   *   the distractor clauses (correct theme excluded, per-type
   *   value exclusions) — minus `isPopular`, which pool
   *   membership replaces.
   * Distractors are names only: no audio/probe requirements,
   * and themes dealt in earlier rounds are not excluded (their
   * names may reappear, as in solo).
   */
  private async poolDistractorCandidates(
    models: RoomModels,
    room: RoomDoc,
    correctTheme: RoomThemeDoc,
  ): Promise<RoomThemeDoc[]> {
    if (room.settings.poolMode === 'common') {
      return this.commonCandidates(models, room, [String(correctTheme._id)]);
    }
    // Watched / AniList: rebuild the sampler's filter and merge
    // the distractor constraints into it.
    const poolFilter = await this.dynamicThemeFilter(models, room);
    const distractorFilter = distractorFilterFor(
      correctTheme,
      room.settings.guessType,
    );
    delete distractorFilter.isPopular;
    const poolId = poolFilter._id as { $in?: unknown[] } | undefined;
    const correctId = distractorFilter._id as { $ne?: unknown };
    const merged: Record<string, unknown> = {
      ...poolFilter,
      ...distractorFilter,
      _id: {
        ...(poolId && Array.isArray(poolId.$in) ? { $in: poolId.$in } : {}),
        ...(correctId && '$ne' in correctId ? { $ne: correctId.$ne } : {}),
      },
    };
    return (await models.themes
      .aggregate([
        { $match: merged },
        { $sample: { size: 10 } },
        {
          $project: {
            animeTitle: 1,
            animeTitleEnglish: 1,
            animeTitleAlternative: 1,
            songTitle: 1,
            artistName: 1,
          },
        },
      ])
      .exec()) as RoomThemeDoc[];
  }

  /**
   * generateRoundOptions with its query. Random rooms keep the
   * web shape: distractors sampled from the popular pool.
   * Watched / Common / AniList rooms sample from the room's own
   * pool first (see poolDistractorCandidates) and top up from
   * the popular pool only when the pool yields fewer than 3
   * distinct distractor values — buildRoundOptions' value
   * dedup decides, pool candidates first so pool values win
   * the slots.
   */
  private async generateOptions(
    models: RoomModels,
    room: RoomDoc,
    correctTheme: RoomThemeDoc,
  ): Promise<string[]> {
    const guessType = room.settings.guessType;
    const poolMode = room.settings.poolMode;
    if (
      poolMode === 'watched' ||
      poolMode === 'common' ||
      poolMode === 'anilist'
    ) {
      const poolCandidates = await this.poolDistractorCandidates(
        models,
        room,
        correctTheme,
      );
      if (poolCandidates.length > 0) {
        const options = buildRoundOptions(
          correctTheme,
          guessType,
          poolCandidates,
        );
        if (options.length >= 4) return options;
        const popularCandidates = await this.samplePopularDistractorCandidates(
          models,
          correctTheme,
          guessType,
        );
        return buildRoundOptions(correctTheme, guessType, [
          ...poolCandidates,
          ...popularCandidates,
        ]);
      }
      // The pool yielded nothing at all — today's behaviour:
      // the popular sample below.
    }
    const distractors = await this.samplePopularDistractorCandidates(
      models,
      correctTheme,
      guessType,
    );
    return buildRoundOptions(correctTheme, guessType, distractors);
  }

  /* ---------------------------------------------------------------- */
  /* Lookups                                                           */
  /* ---------------------------------------------------------------- */

  private async loadRoom(
    models: RoomModels,
    roomId: string,
  ): Promise<RoomDoc> {
    const room = (await models.rooms
      .findById(roomId)
      .exec()) as RoomDoc | null;
    if (!room) {
      throw new RoomActionError('Room not found');
    }
    return room;
  }

  private async loadRoomByCode(
    models: RoomModels,
    roomCode: string,
  ): Promise<RoomDoc> {
    const room = (await models.rooms
      .findOne({ roomCode: roomCode.toUpperCase() })
      .exec()) as RoomDoc | null;
    if (!room) {
      throw new RoomActionError('Room not found');
    }
    return room;
  }

  private async loadUser(models: RoomModels, userId: string) {
    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new RoomActionError('User not found');
    }
    return user;
  }

  private requirePlayer(room: RoomDoc, userId: string) {
    const player = room.players.find((p) => p.userId === userId);
    if (!player) {
      throw new RoomActionError('Player not in room');
    }
    return player;
  }

  /** The web create/public routes' watched-pool snapshot. */
  private async buildWatchedPoolAnimeIds(
    models: RoomModels,
    userId: string,
    emptyHistoryError: string,
  ): Promise<string[]> {
    const history = (await models.watchHistory
      .find({ userId })
      .select('themeId')
      .lean()
      .exec()) as { themeId: unknown }[];
    if (history.length === 0) {
      throw new RoomActionError(emptyHistoryError);
    }
    const themes = (await models.themes
      .find({
        _id: { $in: history.map((h) => h.themeId) as Types.ObjectId[] },
      })
      .select('anilistId')
      .lean()
      .exec()) as { anilistId: number | null }[];
    return themes
      .filter((t) => t.anilistId)
      .map((t) => String(t.anilistId));
  }

  private async uniqueRoomCode(models: RoomModels): Promise<string> {
    let code = generateRoomCode();
    while (await models.rooms.findOne({ roomCode: code }).exec()) {
      code = generateRoomCode();
    }
    return code;
  }

  /* ---------------------------------------------------------------- */
  /* Room creation / joining                                           */
  /* ---------------------------------------------------------------- */

  /** room:create — the web's POST /api/quiz/room/create. */
  async createRoom(
    userId: string,
    dto: CreateRoomRequest,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (
      !dto?.roomType ||
      !dto?.poolMode ||
      !dto?.guessType ||
      !dto?.roundCount ||
      !dto?.matchmaking
    ) {
      throw new RoomActionError('Missing required fields');
    }

    // Lazy cleanup of empty rooms (the web create route does this).
    await this.sweepEmptyRooms(models);

    const watchedPoolAnimeIds =
      dto.poolMode === 'watched'
        ? await this.buildWatchedPoolAnimeIds(
            models,
            userId,
            'No watched history found',
          )
        : [];

    const user = await this.loadUser(models, userId);
    const roomCode = await this.uniqueRoomCode(models);

    const room = (await models.rooms.create({
      roomCode,
      roomType: dto.roomType,
      hostId: userId,
      settings: {
        poolMode: dto.poolMode,
        watchedPoolAnimeIds,
        guessType: dto.guessType,
        roundCount: dto.roundCount,
        maxPlayers:
          dto.roomType === 'duel' ? 2 : partyMaxPlayers(dto.maxPlayers),
        timeLimitSeconds: 30,
      },
      status: 'waiting',
      matchmaking: dto.matchmaking,
      players: [
        {
          userId,
          username: user.username,
          avatar: user.avatarUrl ?? null,
          totalScore: 0,
          ready: false,
          joinedAt: new Date(),
          lastSeenAt: new Date(),
        },
      ],
    })) as RoomDoc;

    return {
      success: true,
      roomId: String(room._id),
      roomCode: room.roomCode,
      room: await this.stateWithCommonCount(models, room),
    };
  }

  /** room:join — the web's POST /api/quiz/room/join (by room code). */
  async joinByCode(userId: string, roomCode: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomCode) {
      throw new RoomActionError('Missing room code');
    }
    const found = await this.loadRoomByCode(models, roomCode);
    return this.withRoomLock(String(found._id), async () => {
      // The web join runs the room cleanup first; it can close
      // the room under us.
      const cleaned = await this.cleanupRoom(models, found);
      if (!cleaned) {
        throw new RoomActionError('Room has been closed due to inactivity');
      }
      const room = cleaned;

      // The roster BEFORE the cleanup above — it may have
      // dropped stale players (perf problem 6).
      const rosterBeforeCleanup = found.players.length;

      if (room.status !== 'waiting') {
        throw new RoomActionError('Room is no longer waiting for players');
      }
      if (room.players.length >= room.settings.maxPlayers) {
        throw new RoomActionError('Room is full');
      }

      const alreadyIn = room.players.some((p) => p.userId === userId);
      if (!alreadyIn) {
        const user = await this.loadUser(models, userId);
        room.players.push({
          userId,
          username: user.username,
          avatar: user.avatarUrl ?? null,
          totalScore: 0,
          ready: false,
          joinedAt: new Date(),
          lastSeenAt: new Date(),
        } as RoomDoc['players'][number]);
        // Perf problem 6: a join always changes the roster the
        // next match plays with (and the cleanup just above may
        // have dropped stale players too): derived sets
        // recompute on next read, and the room is dirty for the
        // next match.
        void rosterBeforeCleanup;
        this.markLibraryDirty(String(room._id));
        // If the room was empty (host gone), the joiner hosts.
        if (room.players.length === 1) {
          room.hostId = userId as unknown as RoomDoc['hostId'];
        }
        await room.save();
        // Perf problem 6: the joiner's library contribution is
        // computed once, at join.
        await this.notePlayerJoined(models, room, userId);

        this.emit(room, 'room:player-joined', {
          userId,
          username: user.username,
          avatar: user.avatarUrl ?? null,
          playerCount: room.players.length,
          players: room.players.map((p) => this.toPlayer(p)),
        });
      }

      return {
        success: true,
        roomId: String(room._id),
        roomCode: room.roomCode,
        room: await this.stateWithCommonCount(models, room),
      };
    });
  }

  /** room:public — the web's POST /api/quiz/room/public matchmaking. */
  async publicMatchmaking(
    userId: string,
    dto: PublicRoomRequest,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!dto?.roomType || !dto?.poolMode || !dto?.guessType) {
      throw new RoomActionError('Missing required fields');
    }

    await this.sweepEmptyRooms(models);
    const user = await this.loadUser(models, userId);

    const existing = (await models.rooms
      .findOne({
        status: 'waiting',
        matchmaking: 'public',
        roomType: dto.roomType,
        'settings.poolMode': dto.poolMode,
        'settings.guessType': dto.guessType,
        $expr: { $lt: [{ $size: '$players' }, '$settings.maxPlayers'] },
      })
      .exec()) as RoomDoc | null;

    if (existing) {
      return this.withRoomLock(String(existing._id), async () => {
        const room = (await models.rooms
          .findById(existing._id)
          .exec()) as RoomDoc;
        const alreadyIn = room.players.some((p) => p.userId === userId);
        if (!alreadyIn) {
          // Perf problem 6: a join changes the roster the next
          // match plays with — dirty the library cache.
          this.markLibraryDirty(String(room._id));
          room.players.push({
            userId,
            username: user.username,
            avatar: user.avatarUrl ?? null,
            totalScore: 0,
            ready: false,
            joinedAt: new Date(),
            lastSeenAt: new Date(),
          } as RoomDoc['players'][number]);
          if (room.players.length === 1) {
            room.hostId = userId as unknown as RoomDoc['hostId'];
          }
          await room.save();
          // Perf problem 6: the joiner's library contribution
          // is computed once, at join.
          await this.notePlayerJoined(models, room, userId);

          this.emit(room, 'room:player-joined', {
            userId,
            username: user.username,
            avatar: user.avatarUrl ?? null,
            playerCount: room.players.length,
            players: room.players.map((p) => this.toPlayer(p)),
          });
        }
        return {
          success: true,
          roomId: String(room._id),
          roomCode: room.roomCode,
          room: await this.stateWithCommonCount(models, room),
        };
      });
    }

    const watchedPoolAnimeIds =
      dto.poolMode === 'watched'
        ? await this.buildWatchedPoolAnimeIds(
            models,
            userId,
            'No watched history found',
          )
        : [];
    const roomCode = await this.uniqueRoomCode(models);

    const room = (await models.rooms.create({
      roomCode,
      roomType: dto.roomType,
      // Public duels are hostless on the web; party rooms are hosted.
      hostId: dto.roomType === 'party' ? userId : null,
      settings: {
        poolMode: dto.poolMode,
        watchedPoolAnimeIds,
        guessType: dto.guessType,
        roundCount: 10, // Default for public (the web's constant).
        maxPlayers:
          dto.roomType === 'duel' ? 2 : partyMaxPlayers(dto.maxPlayers),
        timeLimitSeconds: 30,
      },
      status: 'waiting',
      matchmaking: 'public',
      players: [
        {
          userId,
          username: user.username,
          avatar: user.avatarUrl ?? null,
          totalScore: 0,
          ready: false,
          joinedAt: new Date(),
          lastSeenAt: new Date(),
        },
      ],
    })) as RoomDoc;

    return {
      success: true,
      roomId: String(room._id),
      roomCode: room.roomCode,
      room: await this.stateWithCommonCount(models, room),
    };
  }

  /**
   * room:list-public — the lobby's public-rooms discovery list
   * (Slice 5). This API's own addition: the web has no room list
   * (its public flow is the join-or-create matchmaking above), but
   * the app's lobby design draws the open rooms, so they are served
   * from the same room documents. Read-only; waiting public rooms
   * only, joinable rooms first (the design renders full rooms last
   * with a disabled "Full" state rather than hiding them), newest
   * first within each group, capped at 20.
   */
  async listPublicRooms(): Promise<QuizRoomAck> {
    const models = this.requireModels();
    const docs = (await models.rooms
      .find({ matchmaking: 'public', status: 'waiting' })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean()
      .exec()) as unknown as RoomDoc[];
    const items: PublicRoomListItem[] = docs.map((room) => {
      const maxPlayers = room.settings?.maxPlayers ?? 0;
      const playerCount = room.players?.length ?? 0;
      // The host's display data rides their own player row; public
      // duels are hostless (hostId null) and fall back to the first
      // player's row.
      const hostRow =
        room.players?.find(
          (p) => room.hostId && String(p.userId) === String(room.hostId),
        ) ?? room.players?.[0];
      return {
        roomId: String(room._id),
        roomCode: room.roomCode,
        roomType: room.roomType as PublicRoomListItem['roomType'],
        guessType:
          room.settings?.guessType as PublicRoomListItem['guessType'],
        roundCount: room.settings?.roundCount ?? 0,
        playerCount,
        maxPlayers,
        isFull: maxPlayers > 0 && playerCount >= maxPlayers,
        hostUsername: hostRow?.username ?? 'Unknown',
        hostAvatar: hostRow?.avatar ?? null,
      };
    });
    items.sort((a, b) => Number(a.isFull) - Number(b.isFull));
    return { success: true, rooms: items.slice(0, 20) };
  }

  /** room:subscribe — attach to a room the player already belongs to. */
  async getRoomStateForMember(
    userId: string,
    roomId: string,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    const room = await this.loadRoom(models, roomId);
    this.requirePlayer(room, userId);
    return { success: true, room: await this.stateWithCommonCount(models, room) };
  }

  /* ---------------------------------------------------------------- */
  /* Lobby actions                                                     */
  /* ---------------------------------------------------------------- */

  /** room:leave — the web's POST /api/quiz/room/leave. */
  async leaveRoom(userId: string, roomId: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      const index = room.players.findIndex((p) => p.userId === userId);
      if (index === -1) {
        return { success: true };
      }
      const leaving = room.players[index];
      room.players.splice(index, 1);
      // Perf problem 6: a leave changes the roster the next
      // match plays with — dirty the library cache.
      this.markLibraryDirty(roomId);

      if (room.hostId && String(room.hostId) === userId) {
        if (room.players.length > 0) {
          const randomIndex = Math.floor(Math.random() * room.players.length);
          room.hostId = room.players[randomIndex].userId as unknown as RoomDoc['hostId'];
        } else if (room.status !== 'waiting') {
          room.status = 'ended';
          this.disarmRoundTimer(roomId);
          // Room death = cache death (perf problem 6).
          this.dropLibraryCache(roomId);
        }
      }
      if (room.players.length === 0) {
        this.dropRematchVotes(roomId);
        this.dropRoundStartGate(roomId);
      }
      await room.save();

      this.emit(room, 'room:player-left', {
        userId,
        username: leaving.username,
        newHostId: room.hostId ? String(room.hostId) : null,
        roomStatus: room.status,
      });

      // F4 (2026-11-12): leaving mid-countdown shrinks the
      // start gate's denominator the same way — the leaver
      // stops being awaited, and if every remaining member has
      // reported, the round starts for the rest.
      if (room.status === 'in_progress') {
        await this.maybeCompleteRoundStart(models, room);
      }

      // Play-again (2026-11-12): leaving an ENDED room shrinks
      // the rematch denominator — the leaver's own vote is
      // pruned with them, and if every remaining member has
      // voted, the restart fires for the rest.
      if (room.status === 'ended' && room.players.length > 0) {
        await this.maybeRestartRematch(models, room);
      }

      return {
        success: true,
        room: await this.stateWithCommonCount(models, room),
      };
    });
  }

  /**
   * room:rematch — play-again vote (owner feature, 2026-11-12).
   * A member of an ENDED room opts in to another match in the
   * same room. Voting is idempotent (a repeat vote changes
   * nothing and broadcasts nothing). Each new vote broadcasts
   * room:rematch-vote with the pruned count; when the vote
   * completes unanimity among the CURRENT members (and at
   * least 2 remain — a match is never restarted for a lone
   * player), the game restarts at once: see restartRematch.
   */
  async voteRematch(userId: string, roomId: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      this.requirePlayer(room, userId);
      if (room.status !== 'ended') {
        throw new RoomActionError(
          'Play again is only available after the game ends',
        );
      }

      let votes = this.rematchVotes.get(roomId);
      if (!votes) {
        votes = new Set<string>();
        this.rematchVotes.set(roomId, votes);
      }
      const isNewVote = !votes.has(userId);
      votes.add(userId);

      if (await this.maybeRestartRematch(models, room)) {
        return {
          success: true,
          gameRestarted: true,
          room: this.toRoomState(room),
        };
      }

      if (isNewVote) {
        const votedUserIds = this.currentRematchVoters(room);
        this.emit(room, 'room:rematch-vote', {
          userId,
          votes: votedUserIds.length,
          total: room.players.length,
          votedUserIds,
        } satisfies RematchVoteEvent);
      }
      return { success: true, room: this.toRoomState(room) };
    });
  }

  /**
   * Restarts the room's game when every current member has
   * voted to play again. Returns whether a restart happened.
   * Shared by the vote action and the leave path (a departure
   * can complete unanimity for those who remain).
   */
  private async maybeRestartRematch(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<boolean> {
    if (room.status !== 'ended') return false;
    if (room.players.length < 2) return false;
    const voters = this.currentRematchVoters(room);
    if (voters.length < room.players.length) return false;
    await this.restartRematch(models, room);
    return true;
  }

  /**
   * The rematch itself: same room, code, players, settings and
   * source pool — scores zeroed, rounds and the used-theme set
   * cleared (a small pool must be able to deal a full second
   * game), and round 1 dealt by the existing sampler through
   * the usual beginRound funnel (common-pool eligibility and
   * the library-cache next-match rule included). The finished
   * game's RP was already scheduled when it ended and is NOT
   * touched here; the rematch is a NEW game, and its own end
   * schedules its own award in finishRound as usual.
   */
  private async restartRematch(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<void> {
    this.dropRematchVotes(String(room._id));
    for (const player of room.players) {
      player.totalScore = 0;
    }
    room.rounds = [] as unknown as RoomDoc['rounds'];
    room.usedThemeIds = [];
    room.currentRound = 0;

    await this.beginRound(models, room, 1);

    this.emit(room, 'room:rematch-started', {
      room: this.toRoomState(room),
    } satisfies RematchStartedEvent);
  }

  /** room:ready — the web's POST /api/quiz/room/ready (toggle). */
  async toggleReady(userId: string, roomId: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing room id');
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      if (room.status !== 'waiting') {
        throw new RoomActionError('Game already started');
      }
      const player = this.requirePlayer(room, userId);
      player.ready = !player.ready;
      player.lastSeenAt = new Date();
      await room.save();

      this.emit(room, 'room:player-ready', {
        userId,
        ready: player.ready,
        players: room.players.map((p) => this.toPlayer(p)),
      });

      // Duel auto-start: both players ready → round 1 begins
      // (the web's ready route starts the game inline).
      if (
        room.roomType === 'duel' &&
        room.players.length === 2 &&
        room.players.every((p) => p.ready)
      ) {
        await this.beginRound(models, room, 1);
        return { success: true, gameStarted: true, room: this.toRoomState(room) };
      }

      return {
        success: true,
        room: await this.stateWithCommonCount(models, room),
      };
    });
  }

  /** room:update-settings — the web's room settings routes (host-only). */
  async updateSettings(
    userId: string,
    roomId: string,
    settings: Partial<CreateRoomRequest> & Record<string, unknown>,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId || !settings) {
      throw new RoomActionError('Missing required fields');
    }
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      if (room.hostId && String(room.hostId) !== userId) {
        throw new RoomActionError('Only the host can update settings');
      }
      if (room.status !== 'waiting') {
        throw new RoomActionError('Cannot update settings after game has started');
      }

      const next = { ...settings } as Record<string, unknown>;
      // Pool-mode changes resync the watched snapshot (the web's
      // update-settings route); leaving watched mode clears it.
      if (next.poolMode === 'watched') {
        next.watchedPoolAnimeIds = await this.buildWatchedPoolAnimeIds(
          models,
          userId,
          'You have no watched themes in your library!',
        );
      } else if (next.poolMode) {
        next.watchedPoolAnimeIds = [];
      }

      const current = room.settings as unknown as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...current, ...next };
      // Numeric coercion (the web's settings route).
      merged.roundCount =
        Number(next.roundCount) || (current.roundCount as number);
      merged.timeLimitSeconds =
        Number(next.timeLimitSeconds) || (current.timeLimitSeconds as number);
      // Party sizes clamp to the owner's cap (spec 2026-11-10);
      // duels stay pinned at 2 whatever the payload carries.
      merged.maxPlayers =
        room.roomType === 'duel'
          ? 2
          : partyMaxPlayers(
              Number(next.maxPlayers) || (current.maxPlayers as number),
            );
      room.settings = merged as unknown as RoomDoc['settings'];
      await room.save();

      const state = await this.stateWithCommonCount(models, room);
      this.emit(room, 'room:settings-updated', {
        settings: state.settings,
        // The fresh shared-theme count rides along for
        // common-pool rooms (undefined for other pools).
        commonPoolCount: state.commonPoolCount,
      });
      return {
        success: true,
        settings: state.settings,
        commonPoolCount: state.commonPoolCount,
      };
    });
  }

  /** room:heartbeat — the web's POST /api/quiz/room/heartbeat. */
  async heartbeat(userId: string, roomId: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    const result = (await models.rooms
      .updateOne(
        { _id: roomId, 'players.userId': userId },
        { $set: { 'players.$.lastSeenAt': new Date() } },
      )
      .exec()) as { matchedCount?: number };
    if (!result.matchedCount) {
      throw new RoomActionError('Room closed');
    }
    return { success: true, heartbeatAccepted: true } as QuizRoomAck;
  }

  /* ---------------------------------------------------------------- */
  /* Game flow                                                         */
  /* ---------------------------------------------------------------- */

  /** room:start — the web's POST /api/quiz/room/start (host, party/duel). */
  async startGame(userId: string, roomId: string): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      if (room.hostId && String(room.hostId) !== userId) {
        throw new RoomActionError('Only the host can start the room');
      }
      if (room.status !== 'waiting') {
        throw new RoomActionError('Room is already in progress or ended');
      }
      if (room.roomType === 'duel') {
        if (room.players.length !== 2) {
          throw new RoomActionError('You need exactly 2 players to start a Duel.');
        }
        if (!room.players.every((p) => p.ready)) {
          throw new RoomActionError('Both players must be ready!');
        }
      } else {
        if (room.players.length < 2) {
          throw new RoomActionError('At least 2 players are required to start.');
        }
        if (!room.players.every((p) => p.ready)) {
          throw new RoomActionError(
            'All players must be ready to enable autoplay.',
          );
        }
      }

      await this.beginRound(models, room, 1);
      return { success: true, room: this.toRoomState(room) };
    });
  }

  /** room:next — the web's POST /api/quiz/room/next (host-driven pacing). */
  async nextRound(
    userId: string,
    roomId: string,
    expectedRound?: number,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      if (room.hostId && String(room.hostId) !== userId) {
        throw new RoomActionError('Only the host can start the next round');
      }
      if (room.status !== 'in_progress') {
        throw new RoomActionError('Room is not in progress');
      }
      // The web's conditional-update guard: a duplicate next for
      // the same round is a no-op success, never a double advance.
      if (
        typeof expectedRound === 'number' &&
        expectedRound !== room.currentRound
      ) {
        return {
          success: true,
          alreadyAdvanced: true,
          currentRound: room.currentRound,
        };
      }
      if (room.currentRound >= room.settings.roundCount) {
        throw new RoomActionError('Max rounds reached');
      }

      await this.beginRound(models, room, room.currentRound + 1);
      return { success: true, room: this.toRoomState(room) };
    });
  }

  /** Builds, persists and broadcasts a round (web start/next/ready core). */
  private async beginRound(
    models: RoomModels,
    room: RoomDoc,
    roundNumber: number,
  ): Promise<void> {
    // Common-pool eligibility (owner spec, 2026-11-10): a
    // common game may only START when the players share at
    // least as many themes as the game has rounds — otherwise
    // the pool runs dry mid-game and the generic fallback
    // below would silently deal off-pool themes. Enforced
    // here, at the single funnel every round-1 path uses
    // (host start and the duel ready auto-start alike).
    if (roundNumber === 1 && room.settings.poolMode === 'common') {
      const sharedCount = await this.countCommonPoolThemes(
        models,
        room,
        true,
      );
      if (sharedCount < room.settings.roundCount) {
        throw new RoomActionError(
          `Not enough common themes: you share ${sharedCount} theme${sharedCount === 1 ? '' : 's'} but this game needs ${room.settings.roundCount} rounds. Add more shared anime or pick fewer rounds.`,
        );
      }
    }

    let theme = await this.selectThemeForRoom(
      models,
      room,
      room.usedThemeIds ?? [],
      roundNumber === 1,
    );
    if (!theme) {
      // Fallback if no themes found for the pool (the web routes).
      theme = await this.sampleFallbackTheme(models);
    }
    if (!theme) {
      throw new RoomActionError('No theme available');
    }

    const correctAnswer = getCorrectAnswer(theme, room.settings.guessType);
    const options = await this.generateOptions(models, room, theme);

    // The answer window opens when the pre-round countdown ends
    // (owner design, 2026-11-10): startedAt is stamped
    // ROUND_COUNTDOWN_SECONDS ahead, and every consumer — the
    // scoring measurement, the server round timer, the clients'
    // countdown + ring — derives from that one timestamp.
    // F4 (2026-11-12): that stamp is now the round's BASE
    // moment only. The authoritative startedAt is stamped by
    // completeRoundStart when every current member has
    // reported its audio ready (bounded past the base) — until
    // then the start gate (roundStartGates) is the started-or-
    // not authority and submitAnswer refuses. The document
    // keeps the base Date meanwhile (its schema requires one).
    const startedAt = new Date(
      Date.now() + ROUND_COUNTDOWN_SECONDS * 1000,
    );

    const round = {
      roundNumber,
      themeId: String(theme._id),
      videoUrl: theme.videoUrl ?? '',
      correctAnswer,
      alternateAnswers: [
        theme.animeTitle,
        theme.animeTitleEnglish,
        ...(theme.animeTitleAlternative ?? []),
      ].filter((v): v is string => typeof v === 'string' && v.length > 0),
      options,
      startedAt,
      endedAt: null,
      animeTitle: theme.animeTitle ?? null,
      animeTitleEnglish: theme.animeTitleEnglish ?? null,
      coverImage: theme.animeCoverImage ?? theme.animeCoverImageSmall ?? null,
      malId: theme.anilistId ?? null,
      themeType: theme.type ?? null,
      themeSequence: theme.sequence ?? null,
      songTitle: theme.songTitle ?? null,
      artistName: theme.artistName ?? null,
      answers: [],
      firstCorrectUserId: null,
    };

    room.status = 'in_progress';
    room.currentRound = roundNumber;
    room.rounds.push(round as unknown as RoomDoc['rounds'][number]);
    room.usedThemeIds.push(String(theme._id));
    // Stamped for document parity; the server owns the timer here.
    room.timerAuthority = Date.now().toString();
    await room.save();

    const mediaCandidates = this.buildMediaCandidates(theme);
    const timeLimitSeconds = room.settings.timeLimitSeconds || 30;
    // F4: open the start gate over the CURRENT roster and
    // broadcast the round in its start-PENDING shape: clients
    // preload + hold their audio at baseStartAt (the base
    // countdown moment — the value they used to treat as the
    // start) and report room:round-ready as their audio
    // decides; the completion broadcast (completeRoundStart)
    // carries the authoritative startedAt. The gate keeps the
    // payload pieces that broadcast needs.
    this.openRoundStartGate(
      String(room._id),
      roundNumber,
      room.players.map((p) => p.userId),
      startedAt,
      {
        // The round's own video URL — NOT mediaCandidates[0]: the
        // candidate list is in playback order (audio first, see
        // buildMediaCandidates), so its head is the .ogg, while
        // this field must stay the video it names.
        videoUrl: round.videoUrl,
        mediaCandidates,
        options,
        timeLimitSeconds,
      },
    );
    this.emit(room, 'room:round-started', {
      round: roundNumber,
      theme: {
        videoUrl: round.videoUrl,
        mediaCandidates,
        options,
      },
      startedAt: null,
      startPending: true,
      baseStartAt: round.startedAt.toISOString(),
      timeLimitSeconds,
      countdownSeconds: ROUND_COUNTDOWN_SECONDS,
    });

    // The server timer covers the countdown, the start gate's
    // bound, PLUS the window — the latest moment the round can
    // possibly end (completeRoundStart re-arms it tighter once
    // the real start is stamped): the round ends
    // timeLimitSeconds after its startedAt, not after the
    // broadcast.
    this.armRoundTimer(
      String(room._id),
      ROUND_COUNTDOWN_SECONDS +
        ROUND_START_READY_BOUND_SECONDS +
        timeLimitSeconds,
    );
  }

  /**
   * Raw-URL media candidates (the web proxies these; see class
   * docs), in the quiz's playback order (owner doctrine,
   * 2026-11-10): the resolved audio FIRST — the derived .ogg twin
   * whenever the theme's video link derives (audio-url.ts) — then
   * the theme's video file itself, retained as the audio-only last
   * resort (played behind no surface), then the entries' own video
   * sources. Clients try the list in order and may only report a
   * round unplayable after the last candidate fails.
   */
  private buildMediaCandidates(theme: RoomThemeDoc): string[] {
    const direct = [
      resolveAudioUrl(theme.audioUrl, theme.videoUrl),
      theme.videoUrl,
      ...(Array.isArray(theme.entries)
        ? theme.entries.flatMap((entry) =>
            Array.isArray(entry?.videoSources)
              ? entry.videoSources.map((s) => s?.url)
              : [],
          )
        : []),
    ].filter((url): url is string => typeof url === 'string' && url.length > 0);
    return [...new Set(direct)];
  }

  /* ---------------------------------------------------------------- */
  /* Answers + round end — app/api/quiz/room/answer + timer-end.       */
  /* ---------------------------------------------------------------- */

  /** room:answer — the web's POST /api/quiz/room/answer. */
  async submitAnswer(
    userId: string,
    roomId: string,
    roundNumber: number,
    submittedAnswer: string,
  ): Promise<QuizRoomAck> {
    const models = this.requireModels();
    if (!roomId) throw new RoomActionError('Missing roomId');
    if (typeof roundNumber !== 'number') {
      throw new RoomActionError('Missing roundNumber');
    }
    return this.withRoomLock(roomId, async () => {
      const room = await this.loadRoom(models, roomId);
      // Membership gate (Bug 1, multi-user matrix 2026-11-09):
      // room:answer previously never consulted room.players, so
      // anyone who learned a live roomId could answer, get scored,
      // end the round and lock real players out. Refuse before any
      // state inspection or mutation, same as every other action.
      this.requirePlayer(room, userId);
      if (room.status !== 'in_progress') {
        throw new RoomActionError('Room not in progress');
      }
      if (roundNumber !== room.currentRound) {
        throw new RoomActionError(
          `round_mismatch: expected ${room.currentRound}, got ${roundNumber}`,
          { currentRound: room.currentRound },
        );
      }
      const round = room.rounds[room.currentRound - 1];
      if (!round || round.endedAt) {
        throw new RoomActionError('Round already ended');
      }
      // F4 start gate (2026-11-12): while the gate is pending
      // the round has NOT started — the document's startedAt is
      // only the base countdown moment and no scoring window
      // runs, however far past the base the clock has run. The
      // refusal matches the countdown refusal below.
      const pendingGate = this.roundStartGates.get(String(room._id));
      if (pendingGate && pendingGate.roundNumber === roundNumber) {
        throw new RoomActionError('Round has not started yet');
      }
      // Pre-round countdown (owner, 2026-11-10): the answer
      // window has not opened yet — the attempt is refused
      // outright, never recorded, never auto-locked. Clients
      // can't submit through the UI during the countdown; this
      // is the enforcement behind it.
      if (new Date(round.startedAt).getTime() > Date.now()) {
        throw new RoomActionError('Round has not started yet');
      }
      if (round.answers.some((a) => a.userId === userId)) {
        throw new RoomActionError('Already answered');
      }

      const playerCount = room.players.length;
      const timeLimitSeconds = room.settings.timeLimitSeconds || 30;
      const isDuel = room.roomType === 'duel';
      const hasCorrectAnswer = round.answers.some((a) => a.correct);

      // ─── AUTO-LOCKOUT (BEFORE processing) — the web route: if
      // all-but-one have answered, this attempt arrives too late.
      if (
        shouldAutoLock({
          answeredCount: round.answers.length,
          playerCount,
          roomType: room.roomType,
          hasCorrectAnswer,
        })
      ) {
        round.answers.push({
          userId,
          submittedAnswer: '',
          correct: false,
          answeredAt: new Date(),
          secondsRemaining: 0,
          baseScore: 0,
          bonusScore: 0,
          totalScoreGained: 0,
          autoLocked: true,
        } as RoomDoc['rounds'][number]['answers'][number]);
        await room.save();

        this.emit(room, 'room:player-answered', {
          round: room.currentRound,
          userId,
          submittedAnswer: '',
          correct: false,
          totalScoreGained: 0,
          autoLocked: true,
          answeredCount: round.answers.length,
          totalPlayers: playerCount,
        });
        await this.finishRound(models, room);
        return { success: true, autoLocked: true };
      }

      // ─── Server-side timing + strict-equality validation.
      const elapsedSeconds = Math.floor(
        (Date.now() - new Date(round.startedAt).getTime()) / 1000,
      );
      const secondsRemaining = Math.max(0, timeLimitSeconds - elapsedSeconds);
      const isCorrect = submittedAnswer === round.correctAnswer;
      const { baseScore, bonusScore, totalScoreGained } = multiplayerScoreFor({
        correct: isCorrect,
        secondsRemaining,
        playerCount,
        answeredCount: round.answers.length,
      });
      if (isCorrect && round.firstCorrectUserId == null) {
        round.firstCorrectUserId = userId;
      }

      round.answers.push({
        userId,
        submittedAnswer,
        correct: isCorrect,
        answeredAt: new Date(),
        secondsRemaining,
        baseScore,
        bonusScore,
        totalScoreGained,
        autoLocked: false,
      } as RoomDoc['rounds'][number]['answers'][number]);

      const player = room.players.find((p) => p.userId === userId);
      if (player) {
        player.totalScore += totalScoreGained;
        player.lastSeenAt = new Date();
      }

      // ─── POST-ANSWER AUTO-LOCK of the last remaining player.
      let autoLockedPlayerId: string | null = null;
      const newHasCorrect = round.answers.some((a) => a.correct);
      if (
        shouldAutoLock({
          answeredCount: round.answers.length,
          playerCount,
          roomType: room.roomType,
          hasCorrectAnswer: newHasCorrect,
        })
      ) {
        const answeredIds = round.answers.map((a) => a.userId);
        const lastPlayer = room.players.find(
          (p) => !answeredIds.includes(p.userId),
        );
        if (lastPlayer) {
          autoLockedPlayerId = lastPlayer.userId;
          round.answers.push({
            userId: lastPlayer.userId,
            submittedAnswer: '',
            correct: false,
            answeredAt: new Date(),
            secondsRemaining: 0,
            baseScore: 0,
            bonusScore: 0,
            totalScoreGained: 0,
            autoLocked: true,
          } as RoomDoc['rounds'][number]['answers'][number]);
        }
      }

      await room.save();

      if (autoLockedPlayerId) {
        this.emit(room, 'room:player-answered', {
          round: room.currentRound,
          userId: autoLockedPlayerId,
          submittedAnswer: '',
          correct: false,
          totalScoreGained: 0,
          autoLocked: true,
          answeredCount: round.answers.length,
          totalPlayers: playerCount,
        });
      }
      this.emit(room, 'room:player-answered', {
        round: room.currentRound,
        userId,
        submittedAnswer,
        correct: isCorrect,
        totalScoreGained,
        bonusScore,
        autoLocked: false,
        answeredCount: round.answers.length,
        totalPlayers: playerCount,
      });

      if (round.answers.length >= playerCount) {
        await this.finishRound(models, room);
      }

      return {
        success: true,
        correct: isCorrect,
        baseScore,
        bonusScore,
        totalScoreGained,
        secondsRemaining,
      };
    });
  }

  /**
   * Ends the current round: stamps endedAt, ends the game on the
   * last round, broadcasts room:round-ended (the web payload) and
   * schedules rank maintenance on game end. Assumes the caller
   * already saved any pending answer rows; saves the room itself.
   */
  private async finishRound(models: RoomModels, room: RoomDoc): Promise<void> {
    const round = room.rounds[room.currentRound - 1];
    if (!round || round.endedAt) return;

    round.endedAt = new Date();
    if (room.currentRound >= room.settings.roundCount) {
      room.status = 'ended';
    }
    this.disarmRoundTimer(String(room._id));
    // A round that ends (timer expiry included) takes any
    // still-pending start gate with it (F4).
    this.dropRoundStartGate(String(room._id));
    await room.save();

    if (room.status === 'ended') {
      this.rankService?.scheduleRPUpdate(String(room._id));
      // Room death = cache death (perf problem 6).
      this.dropLibraryCache(String(room._id));
    }

    this.emit(room, 'room:round-ended', {
      round: room.currentRound,
      // The event is the live reveal: its answers keep the FULL
      // row shape (B6 trims only ended rounds inside room STATE;
      // this payload is built from the stored round directly so
      // it stays byte-identical to the pre-trim event).
      answers: round.answers.map((a) => this.toRoundAnswer(a)),
      correctAnswer: round.correctAnswer,
      gameOver: room.status === 'ended',
      players: room.players.map((p) => this.toPlayer(p)),
      theme: {
        animeTitle: round.animeTitle,
        animeTitleEnglish: round.animeTitleEnglish,
        coverImage: round.coverImage,
        malId: round.malId,
        themeType: round.themeType,
        themeSequence: round.themeSequence,
        songTitle: round.songTitle,
        artistName: round.artistName,
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Server round timer (the timer-end route's job, server-owned).     */
  /* ---------------------------------------------------------------- */

  private armRoundTimer(roomId: string, timeLimitSeconds: number) {
    this.disarmRoundTimer(roomId);
    const timer = setTimeout(() => {
      void this.endRoundByTimer(roomId).catch(() => undefined);
    }, timeLimitSeconds * 1000);
    timer.unref?.();
    this.roundTimers.set(roomId, timer);
  }

  private disarmRoundTimer(roomId: string) {
    const timer = this.roundTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.roundTimers.delete(roomId);
    }
  }

  /**
   * The web's timer-end semantics: everyone who hasn't answered
   * gets a zeroed autoLocked row, then the round ends.
   */
  private async endRoundByTimer(roomId: string): Promise<void> {
    const models = this.requireModels();
    await this.withRoomLock(roomId, async () => {
      const room = (await models.rooms
        .findById(roomId)
        .exec()) as RoomDoc | null;
      if (!room || room.status !== 'in_progress') return;
      const round = room.rounds[room.currentRound - 1];
      if (!round || round.endedAt) return;

      const answeredIds = round.answers.map((a) => a.userId);
      for (const player of room.players) {
        if (!answeredIds.includes(player.userId)) {
          round.answers.push({
            userId: player.userId,
            submittedAnswer: '',
            correct: false,
            answeredAt: new Date(),
            secondsRemaining: 0,
            baseScore: 0,
            bonusScore: 0,
            totalScoreGained: 0,
            autoLocked: true,
          } as RoomDoc['rounds'][number]['answers'][number]);
        }
      }
      await this.finishRound(models, room);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Cleanup — lib/quiz-room-cleanup.ts ports.                         */
  /* ---------------------------------------------------------------- */

  /**
   * The web's cleanupRoom: drop heartbeat-stale players (45s),
   * reassign a dropped host randomly, end an in-progress room
   * that emptied (no rank update — the web cleanup's behaviour),
   * track emptySince and delete rooms empty for 60s. Returns the
   * room, or null when it was deleted.
   */
  private async cleanupRoom(
    models: RoomModels,
    room: RoomDoc,
  ): Promise<RoomDoc | null> {
    const now = new Date();
    let changed = false;
    const disconnectedPlayerIds: string[] = [];

    const activePlayers = room.players.filter((player) => {
      const lastSeen = new Date(player.lastSeenAt).getTime();
      if (now.getTime() - lastSeen > HEARTBEAT_THRESHOLD_MS) {
        disconnectedPlayerIds.push(player.userId);
        changed = true;
        return false;
      }
      return true;
    });

    if (changed) {
      room.players = activePlayers as RoomDoc['players'];
      // Perf problem 6: cleanup dropped players — the roster
      // changed, so dirty the library cache for the next match.
      this.markLibraryDirty(String(room._id));

      const currentHostId = room.hostId ? String(room.hostId) : null;
      if (currentHostId && disconnectedPlayerIds.includes(currentHostId)) {
        if (room.players.length > 0) {
          const randomIndex = Math.floor(Math.random() * room.players.length);
          room.hostId = room.players[randomIndex].userId as unknown as RoomDoc['hostId'];
        } else if (room.status !== 'waiting') {
          room.status = 'ended';
          this.disarmRoundTimer(String(room._id));
          // Room death = cache death (perf problem 6).
          this.dropLibraryCache(String(room._id));
        }
      }

      for (const userId of disconnectedPlayerIds) {
        this.emit(room, 'room:player-left', {
          userId,
          newHostId: room.hostId ? String(room.hostId) : null,
          roomStatus: room.status,
          reason: 'disconnect',
        });
      }

      // F4 (2026-11-12): heartbeat-dropped players stop being
      // awaited by the round-start gate — if every remaining
      // member already reported, the round starts for them.
      if (disconnectedPlayerIds.length > 0) {
        await this.maybeCompleteRoundStart(models, room);
      }
    }

    if (room.players.length === 0) {
      if (!room.emptySince) {
        room.emptySince = now;
        changed = true;
      } else if (
        now.getTime() - new Date(room.emptySince).getTime() >
        EMPTY_ROOM_THRESHOLD_MS
      ) {
        await models.rooms.findByIdAndDelete(room._id).exec();
        this.disarmRoundTimer(String(room._id));
        // Room death = cache death (perf problem 6).
        this.dropLibraryCache(String(room._id));
        this.dropRematchVotes(String(room._id));
        this.dropRoundStartGate(String(room._id));
        this.emit(room, 'room:closed', { reason: 'inactivity' });
        return null;
      }
    } else if (room.emptySince) {
      room.emptySince = null;
      changed = true;
    }

    if (changed) {
      await room.save();
    }
    return room;
  }

  /** The web's cleanupAllEmptyRooms (lazy, from create/public). */
  private async sweepEmptyRooms(models: RoomModels): Promise<void> {
    const now = new Date();
    const emptyRooms = (await models.rooms
      .find({ $or: [{ players: { $size: 0 } }, { players: { $exists: false } }] })
      .exec()) as RoomDoc[];
    for (const room of emptyRooms) {
      if (!room.emptySince) {
        room.emptySince = now;
        await room.save();
      } else if (
        now.getTime() - new Date(room.emptySince).getTime() >
        EMPTY_ROOM_THRESHOLD_MS
      ) {
        await models.rooms.findByIdAndDelete(room._id).exec();
        // Room death = cache death (perf problem 6).
        this.dropLibraryCache(String(room._id));
        this.dropRematchVotes(String(room._id));
        this.dropRoundStartGate(String(room._id));
        this.emit(room, 'room:closed', { reason: 'inactivity' });
      }
    }
  }

  /**
   * The periodic sweeper: the web runs cleanup lazily (on join,
   * on create, randomly on heartbeats); a Socket.IO server can
   * afford the honest version — every 15s, apply cleanupRoom to
   * every non-ended room. Ended rooms are left to the web
   * schema's 24h TTL index.
   */
  private async sweep(): Promise<void> {
    const models = this.requireModels();
    const rooms = (await models.rooms
      .find({ status: { $ne: 'ended' } })
      .exec()) as RoomDoc[];
    for (const room of rooms) {
      await this.withRoomLock(String(room._id), async () => {
        const fresh = (await models.rooms
          .findById(room._id)
          .exec()) as RoomDoc | null;
        if (fresh && fresh.status !== 'ended') {
          await this.cleanupRoom(models, fresh);
        }
      });
    }
  }
}
