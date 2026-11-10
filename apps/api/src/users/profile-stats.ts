import type { Model, Types } from 'mongoose';
import type { ProfileStats } from '@kaikansen/contracts';
import type { RatingDocument } from '../library/rating.schema';
import type { WatchHistoryDocument } from '../library/watch-history.schema';
import type { FollowDocument } from '../social/follow.schema';
import type {
  ThemeCache,
  ThemeCacheDocument,
} from '../themes/theme-cache.schema';

/** The read models the aggregates are computed from. */
export interface ProfileStatsModels {
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
  follows: Model<FollowDocument>;
}

/** The user fields the aggregates read (id only — counts are live). */
export interface ProfileStatsUser {
  _id: Types.ObjectId | string;
}

/**
 * The stored profile-stats fields (perf problem 4 — owner-ordered
 * 2026-11-10): the three aggregates below live ON the user record,
 * maintained on the write paths by ProfileStatsMaintenance, so the
 * profile serves read them in one small read instead of counting
 * at view time. Followers/following are deliberately NOT part of
 * this set — they are counted live from the follows collection
 * (audit S3) and stay live.
 *
 * - statsListenedThemes — the DISTINCT-theme count (themesListened).
 * - statsListenedSeconds — the summed played seconds
 *   (totalListenedSeconds); also the value CountersService keeps
 *   the legacy `totalTime` counter equal to (same source of
 *   truth, two stored copies reconciled by the recount).
 * - statsRatingSum / statsRatingCount — the mean's parts: the
 *   mean itself is recomputed at serve time from sum/count
 *   (never the rounded mean alone, so rounding cannot drift).
 *
 * A document that predates these fields (never written by a
 * maintained path, never backfilled) has NO statsRatingCount —
 * `undefined`/`null` is the "not maintained" state the serve path
 * detects (readStoredProfileStats returns null and the caller
 * falls back to computeProfileStats). A maintained user always
 * carries a count, even 0.
 */
export interface ProfileStatsStoredFields {
  statsListenedThemes?: number | null;
  statsListenedSeconds?: number | null;
  statsRatingSum?: number | null;
  statsRatingCount?: number | null;
}

type RatingDoc = { score: number };
type HistoryDoc = { themeId: unknown; atEntryId: number | null };
type ThemeDoc = ThemeCache & { _id: unknown };

/** A theme's entries slice the duration resolution reads. */
export interface PlayDurationTheme {
  entries?: { atEntryId: number; duration?: number | null }[] | null;
}

/**
 * The ONE played-entry duration resolution, shared by every
 * consumer so the definitions can never drift:
 * - computeProfileStats (the recompute / source of truth),
 * - LibraryService.applyWatchCounters (the stored totalTime
 *   increment on the history write path),
 * - ProfileStatsMaintenance (the stored-stats increment on the
 *   same path).
 *
 * The rule (the web's WatchHistory post-save hook): the entry
 * whose atEntryId matches the row's, else the theme's first
 * entry, else 90 seconds when no entry resolves a duration.
 * `theme` null/undefined means the theme is gone from the
 * catalogue: the play contributes 0 seconds (it still counts
 * toward the distinct-theme total — that part is the callers').
 */
export function resolvePlaySeconds(
  theme: PlayDurationTheme | null | undefined,
  atEntryId: number | null,
): number {
  if (!theme) return 0;
  const entry =
    theme.entries?.find((e) => e.atEntryId === atEntryId) ??
    theme.entries?.[0];
  return Number(entry?.duration) || 90;
}

/**
 * The stored-fields serve reader (perf problem 4): assembles a
 * ProfileStats from the user document's stored stats plus the
 * LIVE followers/following counts, or returns null when the
 * document is not maintained (statsRatingCount absent) — the
 * caller's cue to fall back to computeProfileStats for this
 * serve rather than show zeros. It does NOT backfill: repairing
 * a stale or absent stored set is CountersService's job
 * (POST /internal/users/recount-counters), never a side effect
 * of a profile view.
 */
export function readStoredProfileStats(
  user: ProfileStatsStoredFields,
  followersCount: number,
  followingCount: number,
): ProfileStats | null {
  if (user.statsRatingCount == null) {
    return null;
  }
  const ratingCount = user.statsRatingCount;
  const ratingSum = user.statsRatingSum ?? 0;
  return {
    meanRating:
      ratingCount > 0
        ? Math.round((ratingSum / ratingCount) * 10) / 10
        : null,
    themesListened: user.statsListenedThemes ?? 0,
    totalListenedSeconds: user.statsListenedSeconds ?? 0,
    followersCount,
    followingCount,
  };
}

/**
 * The profile listening stats (owner-ordered for the Profile
 * design), computed identically for the own profile
 * (GET /auth/me) and the public profile (GET /users/:username) —
 * ONE routine so the two surfaces can never drift.
 *
 * Definitions (locked with the design):
 * - meanRating: the mean of the scores in the ratings the user
 *   GAVE (the `ratings` rows with their userId), rounded to
 *   1 decimal; null when they have rated nothing.
 * - themesListened: the number of DISTINCT themeIds across the
 *   user's `watchhistories` rows (repeat plays of one theme
 *   count once).
 * - totalListenedSeconds: the sum over EVERY history play of the
 *   played entry's catalogue duration, resolved by
 *   resolvePlaySeconds — the same rule the history write path
 *   uses for the stored totalTime counter. A play whose theme
 *   no longer exists in the catalogue contributes 0 — it still
 *   counts toward themesListened.
 * - followersCount / followingCount: counted LIVE from the
 *   follows collection — the source of truth (audit S3). The
 *   user document's stored counters are maintained by the
 *   follow write path, but any missed or double-applied $inc
 *   drifts them permanently, and the profile would then lie;
 *   counting here makes the served numbers true by
 *   construction. The stored counters themselves are repaired
 *   by CountersService (POST /internal/users/recount-counters).
 *
 * This routine is the SOURCE OF TRUTH for the three stored
 * stats (perf problem 4): the profile serves now read the user
 * record's stored fields (readStoredProfileStats) and only fall
 * back here for documents the write paths have never maintained;
 * the recount backstop recomputes from here. The definitions are
 * identical by construction — the stored values are maintained
 * with these same helpers (resolvePlaySeconds) and the equality
 * is test-proven over write sequences.
 *
 * Aggregates ONLY: no history or rating row ever leaves through
 * this routine. The reads load the user's own rating scores and
 * history (themeId, atEntryId) pairs — both are per-user sets,
 * and the theme join is batched over the distinct ids.
 */
export async function computeProfileStats(
  models: ProfileStatsModels,
  user: ProfileStatsUser,
): Promise<ProfileStats> {
  const [ratingDocs, historyDocs, followersCount, followingCount] =
    await Promise.all([
      models.ratings.find({ userId: user._id }).lean().exec() as Promise<
        RatingDoc[]
      >,
      models.history.find({ userId: user._id }).lean().exec() as Promise<
        HistoryDoc[]
      >,
      models.follows.countDocuments({ followeeId: user._id }).exec(),
      models.follows.countDocuments({ followerId: user._id }).exec(),
    ]);

  const meanRating =
    ratingDocs.length > 0
      ? Math.round(
          (ratingDocs.reduce((sum, r) => sum + r.score, 0) /
            ratingDocs.length) *
            10,
        ) / 10
      : null;

  const distinctThemeIds = [
    ...new Set(historyDocs.map((h) => String(h.themeId))),
  ];

  let totalListenedSeconds = 0;
  if (distinctThemeIds.length > 0) {
    const themeDocs = (await models.themes
      .find({ _id: { $in: distinctThemeIds } })
      .lean()
      .exec()) as ThemeDoc[];
    const byId = new Map(themeDocs.map((t) => [String(t._id), t]));
    for (const row of historyDocs) {
      // A gone theme resolves to 0 seconds via the shared rule
      // (the play still counts as a listened theme, above).
      totalListenedSeconds += resolvePlaySeconds(
        byId.get(String(row.themeId)),
        row.atEntryId,
      );
    }
  }

  return {
    meanRating,
    themesListened: distinctThemeIds.length,
    totalListenedSeconds,
    followersCount,
    followingCount,
  };
}
