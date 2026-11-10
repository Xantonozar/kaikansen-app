import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { RankUpdatedEvent } from '@kaikansen/contracts';
import { QuizRoom, type QuizRoomDocument } from './quiz-room.schema';
import { RankHistory, type RankHistoryDocument } from './rank-history.schema';
import { UserRank, type UserRankDocument } from './user-rank.schema';
import {
  getBaseRP,
  getStreakBonus,
  getTierFromRP,
  ladderForRp,
  tierIndex,
} from './quiz-game.utils';
import { RoomBroadcaster } from './room-broadcaster';

/**
 * Rank maintenance — a port of the web's `lib/rank-utils.ts`
 * (`calculateAndApplyRP` + `scheduleRPUpdate`), which runs when a
 * multiplayer game ends and rewrites each player's UserRank +
 * appends a RankHistory row. The website's leaderboard / rank
 * pages read those collections, so a game played on mobile must
 * maintain them with the web's exact arithmetic:
 *
 * - placement by totalScore desc, ties share the better placement;
 * - base RP from the placement table — the OWNER'S table (spec
 *   2026-11-10) replaced the web's here: keyed by mode + actual
 *   player count (duel +10/−10; party-4 +10/+5/−3/−7; party-3
 *   +7/0/−5; party-2 +5/−5) — see getBaseRP in quiz-game.utils;
 * - win-streak bonus for the winner only (2→+5, 3→+10, 4→+15, 5+→+20);
 * - RP is clamped at the player's CURRENT tier floor (never below
 *   it), and the stored floor only moves UP on promotion;
 * - stats: a non-win counts as a loss when baseRP < 0 and as a
 *   draw when baseRP >= 0; season.seasonRP only ever grows
 *   (max(0, rpChange)) — all mirrored verbatim.
 *
 * `scheduleRPUpdate` mirrors the web's fire-and-forget scheduling:
 * a per-room dedupe set and a setTimeout(0) hand-off, so the game
 * end response/event never waits on rank writes. Each player's
 * result is broadcast as `room:rank-updated` (the web sends the
 * same event over Pusher).
 *
 * The web's `invalidateLeaderboardCache()` is a console.log stub
 * on the web itself — there is no cache to invalidate; noted, not
 * ported. The web's cron jobs that snapshot leaderboards and
 * reset seasons are NOT ported (they stay web-side); this service
 * only maintains their inputs (UserRank/RankHistory), untouched
 * in shape.
 */
@Injectable()
export class RankService {
  private readonly pendingRuns = new Set<string>();

  constructor(
    @Optional()
    @InjectModel(QuizRoom.name)
    private readonly roomModel?: Model<QuizRoomDocument>,
    @Optional()
    @InjectModel(UserRank.name)
    private readonly userRankModel?: Model<UserRankDocument>,
    @Optional()
    @InjectModel(RankHistory.name)
    private readonly rankHistoryModel?: Model<RankHistoryDocument>,
    @Optional()
    private readonly broadcaster?: RoomBroadcaster,
  ) {}

  /** The web's getUserRank: find or create the player's rank doc. */
  private async getUserRank(userId: string): Promise<UserRankDocument> {
    const model = this.userRankModel!;
    const existing = await model.findOne({ userId }).exec();
    if (existing) return existing;
    return model.create({ userId });
  }

  /** The web's calculateAndApplyRP, arithmetic for arithmetic. */
  async calculateAndApplyRP(roomId: string): Promise<void> {
    if (!this.roomModel || !this.userRankModel || !this.rankHistoryModel) {
      return;
    }
    const room = await this.roomModel.findById(roomId).exec();
    if (!room) return;
    if (room.roomType !== 'party' && room.roomType !== 'duel') return;

    // Sort players by final score descending
    const ranked = [...room.players].sort(
      (a, b) => b.totalScore - a.totalScore,
    );

    const results: (RankUpdatedEvent & { placement: number })[] = [];

    for (let i = 0; i < ranked.length; i++) {
      const player = ranked[i];
      let placement = i + 1;
      const totalPlayers = ranked.length;

      // Handle ties for placement
      if (i > 0 && player.totalScore === ranked[i - 1].totalScore) {
        placement = results[i - 1].placement;
      }

      const userRank = await this.getUserRank(player.userId);
      const rpBefore = userRank.rp;
      const tierBefore = userRank.tier;

      const baseRP = getBaseRP(
        placement,
        totalPlayers,
        room.roomType as 'party' | 'duel',
      );

      const isWin = placement === 1;
      const newStreak = isWin ? userRank.currentWinStreak + 1 : 0;
      const streakBonus = isWin ? getStreakBonus(newStreak) : 0;

      const rpChange = baseRP + streakBonus;

      const rpAfterRaw = rpBefore + rpChange;
      const rpAfter = Math.max(userRank.tierFloor, rpAfterRaw);

      const {
        tier: newTier,
        division: newDivision,
        newFloor,
      } = getTierFromRP(rpAfter);
      const promoted = tierIndex(newTier) > tierIndex(tierBefore);
      const demoted = tierIndex(newTier) < tierIndex(tierBefore);

      userRank.rp = rpAfter;
      userRank.tier = newTier;
      userRank.division = newDivision;
      userRank.tierFloor = promoted ? newFloor : userRank.tierFloor;
      userRank.currentWinStreak = newStreak;
      userRank.longestWinStreak = Math.max(userRank.longestWinStreak, newStreak);
      userRank.stats.totalGames += 1;
      if (isWin) userRank.stats.wins += 1;
      if (!isWin && baseRP < 0) userRank.stats.losses += 1;
      if (!isWin && baseRP >= 0) userRank.stats.draws += 1;
      userRank.stats.winRate = userRank.stats.wins / userRank.stats.totalGames;
      userRank.stats.peakRP = Math.max(userRank.stats.peakRP, rpAfter);
      if (tierIndex(newTier) > tierIndex(userRank.stats.peakTier)) {
        userRank.stats.peakTier = newTier;
      }
      userRank.season.seasonRP += Math.max(0, rpChange);
      if (isWin) userRank.season.seasonWins += 1;
      else if (baseRP < 0) userRank.season.seasonLosses += 1;

      await userRank.save();

      const actualRpChange = rpAfter - rpBefore;

      await this.rankHistoryModel.create({
        userId: player.userId,
        roomId,
        roomType: room.roomType,
        playedAt: new Date(),
        placement,
        totalPlayers,
        rpBefore,
        rpAfter,
        rpChange: actualRpChange,
        streakBonus,
        winStreakAtTime: newStreak,
        tierBefore,
        tierAfter: newTier,
        promoted,
        demoted,
      });

      // The room:rank-updated event is app-only (the web's twin
      // rides its own Pusher channel), so its tier fields carry
      // the 24-rank LADDER slugs and its promoted/demoted compare
      // ladder indices (owner spec 2026-11-10). The results list
      // and the stored rank-history row above keep the legacy
      // 6-tier values — nothing written changes.
      const ladderBefore = ladderForRp(rpBefore);
      const ladderAfter = ladderForRp(rpAfter);
      const ladderPromoted = ladderAfter.index > ladderBefore.index;
      const ladderDemoted = ladderAfter.index < ladderBefore.index;

      results.push({
        userId: player.userId,
        rpBefore,
        rpAfter,
        rpChange: actualRpChange,
        streakBonus,
        tierBefore: ladderBefore.rank,
        tierAfter: ladderAfter.rank,
        promoted: ladderPromoted,
        demoted: ladderDemoted,
        newStreak,
        placement,
      });

      this.broadcaster?.emitToRoom(roomId, 'room:rank-updated', {
        userId: player.userId,
        rpBefore,
        rpAfter,
        rpChange: actualRpChange,
        streakBonus,
        tierBefore: ladderBefore.rank,
        tierAfter: ladderAfter.rank,
        promoted: ladderPromoted,
        demoted: ladderDemoted,
        newStreak,
      } satisfies RankUpdatedEvent);
    }
  }

  /** The web's scheduleRPUpdate: deduped, deferred, fire-and-forget. */
  scheduleRPUpdate(roomId: string): void {
    if (this.pendingRuns.has(roomId)) return;
    this.pendingRuns.add(roomId);

    setTimeout(() => {
      void (async () => {
        try {
          await this.calculateAndApplyRP(roomId);
        } catch (error) {
          console.error('Failed to calculate RP in background:', error);
        } finally {
          this.pendingRuns.delete(roomId);
        }
      })();
    }, 0);
  }
}
