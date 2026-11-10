import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { User, type UserDocument } from '../auth/user.schema';
import { Rating, type RatingDocument } from '../library/rating.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  resolvePlaySeconds,
  type PlayDurationTheme,
} from './profile-stats';

/**
 * The stored profile-stats write-path maintenance (perf problem
 * 4 — owner-ordered 2026-11-10): keeps the four `stats*` fields
 * on the user record in step with the history and rating writes,
 * so the profile serves (GET /auth/me, GET /users/:username)
 * read them from the user document instead of counting at view
 * time. Definitions are computeProfileStats' — identical by
 * construction:
 *
 * - a play adds resolvePlaySeconds(theme, atEntryId) to
 *   statsListenedSeconds (the shared helper — the same rule the
 *   legacy totalTime counter uses), and +1 to
 *   statsListenedThemes ONLY when the user has no prior history
 *   row for that themeId (one indexed lookup on the write path);
 * - a rating create adds (score, +1) to (statsRatingSum,
 *   statsRatingCount), an update adjusts the sum by the score
 *   delta, a delete subtracts both.
 *
 * Two invariants shape the implementation:
 *
 * 1. NEVER FABRICATE ON TOP OF ABSENCE. The stored fields only
 *    exist once a user is backfilled (CountersService recount) or
 *    first maintained. An $inc against a document that lacks the
 *    fields would mint values from 0 that are NOT the user's
 *    totals (a user with 40 plays and no stored seconds would
 *    land on just this play's seconds) — worse than no stored
 *    values at all, because the serve path trusts maintained
 *    documents. Every update therefore carries the
 *    `statsRatingCount: { $exists: true }` marker filter: a
 *    not-yet-maintained document is left exactly as it is, and
 *    its serves keep falling back to computeProfileStats until
 *    the recount backfills it.
 *
 * 2. FAILURE-TOLERANT, like the counter writes it sits beside
 *    (LibraryService.applyWatchCounters' web-hook parity): a
 *    maintenance failure is logged and swallowed — it never
 *    fails the user's listen/rate action. Drift it leaves behind
 *    is the recount backstop's job.
 *
 * The models are OPTIONAL like everywhere else in this API: the
 * LibraryService instances other modules and specs construct
 * without a database simply skip maintenance (their writes 503
 * before reaching it anyway).
 */
@Injectable()
export class ProfileStatsMaintenance {
  constructor(
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
  ) {}

  /**
   * The pure core of applyWatchDelta, split out so the equality
   * story is unit-testable without a store: given the user's
   * CURRENT stored fields (null when the document is not
   * maintained), the play's theme (null when it left the
   * catalogue) and whether this is the user's first play of the
   * theme, returns the next stored values — or null when the
   * document is not maintained (nothing may be written; the
   * serve-path fallback covers it until the backfill).
   */
  static nextAfterPlay(
    stored: {
      statsListenedThemes?: number | null;
      statsListenedSeconds?: number | null;
      statsRatingCount?: number | null;
    } | null,
    theme: PlayDurationTheme | null,
    atEntryId: number | null,
    isFirstPlayOfTheme: boolean,
  ): { statsListenedThemes: number; statsListenedSeconds: number } | null {
    if (!stored || stored.statsRatingCount == null) {
      return null;
    }
    return {
      statsListenedThemes:
        (stored.statsListenedThemes ?? 0) + (isFirstPlayOfTheme ? 1 : 0),
      statsListenedSeconds:
        (stored.statsListenedSeconds ?? 0) +
        resolvePlaySeconds(theme, atEntryId),
    };
  }

  /**
   * After a history row for (userId, theme) was recorded: bump
   * the stored seconds by the play's resolved duration, and the
   * distinct-theme count when this is the user's first row for
   * the theme. The row was just created, so "first" reads as
   * exactly one row for (userId, themeId) — one countDocuments
   * over the indexed pair. Called from
   * LibraryService.applyWatchCounters, inside its failure-
   * tolerant try/catch; the swallow here is belt-and-braces so
   * the method is safe to call from anywhere.
   */
  async applyWatchDelta(input: {
    userId: string;
    /** The theme document the write path resolved (null when the
     * theme has left the catalogue — the play still counts as a
     * listened theme but resolves 0 seconds, like the recompute). */
    theme: (PlayDurationTheme & { _id: unknown }) | null;
    atEntryId: number | null;
  }): Promise<void> {
    if (!this.userModel || !this.historyModel) return;
    try {
      const rowsForTheme = await this.historyModel
        .countDocuments({
          userId: input.userId,
          themeId: input.theme?._id,
        })
        .exec();
      await this.userModel
        .findOneAndUpdate(
          { _id: input.userId, statsRatingCount: { $exists: true } },
          {
            $inc: {
              statsListenedSeconds: resolvePlaySeconds(
                input.theme,
                input.atEntryId,
              ),
              ...(rowsForTheme <= 1 ? { statsListenedThemes: 1 } : {}),
            },
          },
        )
        .exec();
    } catch (err) {
      console.error('[ProfileStats] watch maintenance failed:', err);
    }
  }

  /**
   * After a rating write settled: RECOMPUTE the user's
   * (sum, count) from the ratings collection and $set them —
   * deliberately not an incremental $inc. The rating write path
   * has a create-race branch (a lost unique-index race becomes an
   * update), and an incremental delta computed from the caller's
   * branch knowledge can double-count exactly there; a recompute
   * over the user's own ratings (a small per-user set) is true by
   * construction for create, update, race and delete alike.
   *
   * The marker filter applies, with one deliberate twist: a
   * NOT-yet-maintained document is initialised from this same
   * recompute (the filterless second write) — but only when the
   * user's history side is provably empty too (zero history rows
   * AND totalTime 0), because only then are the true stats
   * (0 themes, 0 seconds, this recompute) known exactly. A user
   * with plays but no backfill is never initialised from a
   * rating alone — their themes/seconds would be fabricated
   * zeros; the recount backfills them instead.
   */
  async refreshRatingStats(userId: string): Promise<void> {
    if (!this.userModel || !this.ratingModel || !this.historyModel) return;
    try {
      const ratingDocs = (await this.ratingModel
        .find({ userId })
        .lean()
        .exec()) as { score: number }[];
      const truth = {
        statsRatingSum: ratingDocs.reduce((sum, r) => sum + r.score, 0),
        statsRatingCount: ratingDocs.length,
      };
      const maintained = await this.userModel
        .findOneAndUpdate(
          { _id: userId, statsRatingCount: { $exists: true } },
          { $set: truth },
        )
        .exec();
      if (maintained) return;

      const user = (await this.userModel.findById(userId).lean().exec()) as {
        totalTime?: number | null;
      } | null;
      if (!user) return;
      const historyRows = await this.historyModel
        .countDocuments({ userId })
        .exec();
      if (historyRows === 0 && (user.totalTime ?? 0) === 0) {
        await this.userModel
          .findByIdAndUpdate(userId, {
            $set: { statsListenedThemes: 0, statsListenedSeconds: 0, ...truth },
          })
          .exec();
      }
    } catch (err) {
      console.error('[ProfileStats] rating maintenance failed:', err);
    }
  }
}
