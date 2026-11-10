import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type {
  LadderStanding,
  PlayerRankSummary,
  PlayerRanksResponse,
  RankLeaderboardEntry,
  RankLeaderboardResponse,
  RankTier,
  UserRankProfile,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import { ladderForRp } from '../quiz/quiz-game.utils';
import { ladderStandingFor } from '../quiz/ladder-standing';
import { UserRank, type UserRankDocument } from '../quiz/user-rank.schema';
import {
  LeaderboardSnapshot,
  type LeaderboardSnapshotDocument,
} from './leaderboard-snapshot.schema';

/** The web leaderboard's scope + season (leaderboard route constants). */
const SNAPSHOT_SCOPE = 'global';
const SNAPSHOT_SEASON_ID = 'all-time';

/** The web leaderboard's snapshot freshness window (15 minutes). */
const SNAPSHOT_MAX_AGE_MS = 1000 * 60 * 15;

/** The web leaderboard's cap, both paths (.slice(0, 100) / $limit 100). */
const LEADERBOARD_LIMIT = 100;

/** Cap for the batched player-rank read (rooms hold ≤ 8 players). */
const PLAYER_RANK_LIMIT = 50;

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Lean shapes of the documents as they come back from Mongoose. */
type UserRankDoc = UserRank & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};
type SnapshotDoc = LeaderboardSnapshot & { _id: unknown };
type UserDoc = User & { _id: unknown };

interface RankModels {
  userRanks: Model<UserRankDocument>;
  snapshots: Model<LeaderboardSnapshotDocument>;
  users: Model<UserDocument>;
}

/**
 * Rank reads (Slice S6) — a port of the web's rank READ surface:
 * GET /api/rank/me, GET /api/rank/[userId] (both are the web's
 * `getUserRank`, lib/rank-utils.ts) and GET /api/leaderboard (the
 * RP top-100). The rank WRITE path (RP arithmetic at game end)
 * is S4's RankService and is untouched.
 *
 * ⚠️ THE WEB'S RANK READS WRITE. `getUserRank` is find-or-CREATE:
 * asking for a rank that does not exist yet creates the default
 * UserRank document (rp 0, academy, zeroed stats). Both
 * /rank/me and /rank/:userId inherit that, for ANY userId —
 * including one with no account at all (userId is a plain string
 * on UserRank; the web never checks it against `users`). This is
 * mirrored deliberately (parity + the document is harmless
 * defaults) and flagged here and in the slice report — it is the
 * one place this otherwise read-only slice writes, and it writes
 * exactly what the web writes.
 *
 * The leaderboard, by contrast, is a pure read on both paths:
 * - snapshot: a LeaderboardSnapshot { scope: 'global', seasonId:
 *   'all-time' } whose computedAt is ≤ 15 minutes old and whose
 *   entries are non-empty is served (first 100), in the web's
 *   own snapshot projection — including its quirk of serving the
 *   USERNAME as the displayName (the snapshot entries store no
 *   display name).
 * - live: otherwise the top 100 UserRank rows by RP desc are
 *   joined to `users`; rows whose user account is gone are
 *   dropped (the web's $unwind) AFTER the limit is applied (the
 *   web's $limit precedes the $lookup) — the join here is a
 *   batched find instead of the web's aggregation pipeline, with
 *   identical observable output.
 * The snapshot WRITER (the web's cron route) stays web-side, as
 * S4 already decided for the season-reset cron.
 *
 * There is NO rank-history read on the web — `rankhistories` rows
 * are written at game end and read by nothing — so none is
 * ported here.
 *
 * Deliberate deviations (the established ones): the web serves
 * the raw rank document and its generic 500s; this API projects
 * into the contract shapes and answers its clean codes (503
 * without a database; the web's 400 for a missing userId cannot
 * occur here — the path parameter is always present). /rank/me's
 * auth is this API's Bearer guard (the web uses its session).
 *
 * The models are OPTIONAL like everywhere else in this API:
 * booted without MONGODB_URI, every method answers 503 while
 * /health works (the guarded /rank/me still 401s tokenless first).
 */
@Injectable()
export class RankReadService {
  constructor(
    @Optional()
    @InjectModel(UserRank.name)
    private readonly userRankModel?: Model<UserRankDocument>,
    @Optional()
    @InjectModel(LeaderboardSnapshot.name)
    private readonly snapshotModel?: Model<LeaderboardSnapshotDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
  ) {}

  private requireModels(): RankModels {
    if (!this.userRankModel || !this.snapshotModel || !this.userModel) {
      throw new ServiceUnavailableException(
        'Rank unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      userRanks: this.userRankModel,
      snapshots: this.snapshotModel,
      users: this.userModel,
    };
  }

  private toProfile(doc: UserRankDoc): UserRankProfile {
    const rp = doc.rp ?? 0;
    const peakRP = doc.stats?.peakRP ?? 0;
    return {
      id: String(doc._id),
      userId: doc.userId,
      rp,
      tier: (doc.tier ?? 'academy') as RankTier,
      division: doc.division ?? null,
      tierFloor: doc.tierFloor ?? 0,
      // The app's 24-rank ladder, derived from RP at read time
      // (additive — the stored document is never touched; the
      // peak standing rides along on the same object).
      ladder: {
        ...ladderStandingFor(rp),
        peakRank: ladderForRp(peakRP).rank,
      } satisfies LadderStanding,
      currentWinStreak: doc.currentWinStreak ?? 0,
      longestWinStreak: doc.longestWinStreak ?? 0,
      stats: {
        totalGames: doc.stats?.totalGames ?? 0,
        wins: doc.stats?.wins ?? 0,
        losses: doc.stats?.losses ?? 0,
        draws: doc.stats?.draws ?? 0,
        winRate: doc.stats?.winRate ?? 0,
        peakRP,
        peakTier: (doc.stats?.peakTier ?? 'academy') as RankTier,
        peakLadderRank: ladderForRp(peakRP).rank,
      },
      season: {
        seasonId: doc.season?.seasonId ?? 'all-time',
        seasonRP: doc.season?.seasonRP ?? 0,
        seasonWins: doc.season?.seasonWins ?? 0,
        seasonLosses: doc.season?.seasonLosses ?? 0,
        seasonPlacement: doc.season?.seasonPlacement ?? null,
      },
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
    };
  }

  /**
   * GET /rank/me and GET /rank/:userId — the web's getUserRank:
   * find the rank document, CREATING the defaults when none
   * exists (see the class comment — this read can write, exactly
   * like the web's).
   */
  async getRank(userId: string): Promise<UserRankProfile> {
    const models = this.requireModels();
    const existing = (await models.userRanks
      .findOne({ userId: String(userId) })
      .exec()) as UserRankDoc | null;
    if (existing) {
      return this.toProfile(existing);
    }
    const created = (await models.userRanks.create({
      userId: String(userId),
    })) as unknown as UserRankDoc;
    return this.toProfile(created);
  }

  /**
   * GET /rank/players?ids=… — an APP-ONLY read (no web twin): the
   * quiz room roster (§6.24) draws each waiting player with their
   * tier + RP, and the room state itself carries neither. This is
   * the batched, READ-ONLY counterpart of getRank: it never
   * creates a rank document — a player without one reports the
   * same defaults getUserRank would materialise (academy, 0 RP),
   * the treatment the Network rows' tier enrichment already uses.
   * Ids are deduped, order-preserved, and capped (a room holds at
   * most 8 players; the cap only guards abuse).
   */
  async getPlayerRanks(ids: string[]): Promise<PlayerRanksResponse> {
    const models = this.requireModels();
    const unique = [...new Set(ids.map((id) => String(id)).filter(Boolean))]
      .slice(0, PLAYER_RANK_LIMIT);
    if (unique.length === 0) return { players: [] };
    const docs = (await models.userRanks
      .find({ userId: { $in: unique } })
      .lean()
      .exec()) as UserRankDoc[];
    const byId = new Map(
      docs.map((d) => [
        String(d.userId),
        {
          userId: String(d.userId),
          tier: (d.tier ?? 'academy') as RankTier,
          rp: d.rp ?? 0,
          ladder: ladderStandingFor(d.rp ?? 0),
        } satisfies PlayerRankSummary,
      ]),
    );
    return {
      players: unique.map(
        (id) =>
          byId.get(id) ?? {
            userId: id,
            tier: 'academy',
            rp: 0,
            ladder: ladderStandingFor(0),
          },
      ),
    };
  }

  /**
   * GET /rank/leaderboard — the web's /api/leaderboard: fresh
   * snapshot when one exists, live top-100 otherwise (see the
   * class comment). Public, like the web's.
   */
  async getLeaderboard(): Promise<RankLeaderboardResponse> {
    const models = this.requireModels();

    const snapshot = (await models.snapshots
      .findOne({ scope: SNAPSHOT_SCOPE, seasonId: SNAPSHOT_SEASON_ID })
      .lean()
      .exec()) as SnapshotDoc | null;

    const now = Date.now();
    const snapshotFresh = snapshot?.computedAt
      ? now - new Date(snapshot.computedAt).getTime() <= SNAPSHOT_MAX_AGE_MS
      : false;

    if (
      snapshotFresh &&
      Array.isArray(snapshot?.entries) &&
      snapshot.entries.length > 0
    ) {
      const leaderboard: RankLeaderboardEntry[] = snapshot.entries
        .slice(0, LEADERBOARD_LIMIT)
        // Bug 3 (multi-user matrix 2026-11-09): the snapshot is a
        // shared-DB document written by the web's cron — a null or
        // malformed entry must never 500 the endpoint for every
        // caller. Unrenderable entries are skipped, the same
        // treatment the live path gives gone users.
        .filter(
          (entry) =>
            entry != null &&
            typeof entry === 'object' &&
            typeof entry.userId === 'string' &&
            typeof entry.username === 'string',
        )
        .map((entry) => ({
          userId: entry.userId,
          rp: entry.rp,
          tier: entry.tier as RankTier,
          division: entry.division ?? null,
          ladder: ladderStandingFor(entry.rp ?? 0),
          username: entry.username,
          // The web's snapshot map serves the username as the
          // displayName. Mirrored quirk.
          displayName: entry.username,
          avatarUrl: entry.avatar ?? null,
          wins: entry.wins,
          winRate: entry.winRate,
        }));
      return {
        leaderboard,
        meta: { source: 'snapshot', computedAt: iso(snapshot.computedAt) },
      };
    }

    // Live path: top 100 by RP (limit BEFORE the user join, like
    // the web's pipeline), rows with a gone user dropped.
    const rankDocs = (await models.userRanks
      .find({})
      .sort({ rp: -1 })
      .limit(LEADERBOARD_LIMIT)
      .lean()
      .exec()) as UserRankDoc[];

    const uniqueIds = [...new Set(rankDocs.map((r) => String(r.userId)))];
    // Bug 3: UserRank.userId is a plain String on the shared
    // schema, and a legacy row can carry a value that is not an
    // ObjectId string. Mongoose casts the WHOLE $in against
    // users._id, so one such row threw a CastError and 500ed the
    // leaderboard for everyone. A non-ObjectId userId can never
    // join a user (users._id is an ObjectId), so exclude those ids
    // from the join — the row then drops exactly like a gone user.
    const joinableIds = uniqueIds.filter((id) =>
      Types.ObjectId.isValid(id),
    );
    const userDocs =
      joinableIds.length === 0
        ? []
        : ((await models.users
            .find({ _id: { $in: joinableIds } })
            .lean()
            .exec()) as UserDoc[]);
    const usersById = new Map(userDocs.map((u) => [String(u._id), u]));

    const leaderboard: RankLeaderboardEntry[] = [];
    for (const rank of rankDocs) {
      const user = usersById.get(String(rank.userId));
      if (!user) continue; // the web's $unwind drop
      leaderboard.push({
        userId: rank.userId,
        rp: rank.rp ?? 0,
        tier: (rank.tier ?? 'academy') as RankTier,
        division: rank.division ?? null,
        ladder: ladderStandingFor(rank.rp ?? 0),
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl ?? null,
        wins: rank.stats?.wins ?? 0,
        winRate: rank.stats?.winRate ?? 0,
      });
    }

    return { leaderboard, meta: { source: 'live', computedAt: null } };
  }
}
